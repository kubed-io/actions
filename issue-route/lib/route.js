// Decides what an event on a work item (an issue) is for the agents: a spec turn, the
// hand-off to a plan, or nothing.
//
// On a Feature or Bug issue with `agent`, the owner's comment or their `agent` label is a
// turn; on a Feature, their `spec` label too, until `spec approved`, and their `spec
// approved` is the hand-off. A Feature's turns are the spec agent's; a Bug's are the debug
// agent's, which reports and never writes, and its `spec approved` hands the report off to
// a fix. Anything else is nothing.
//
// A sub-issue is part of its family: the turn takes the family's queue (its top issue's
// number, `family`) and thinks in a session of its own, issue-<family>/<number>, which starts
// as a fork of the family's issue-<family> (spec 2026-11-24 R-SM12, R-SM13). A sub-issue's
// first turn opens with the sub-issue prompt (a Bug's, with debug-report).
//
// `spec approved` on a sub-issue opens its change into the family's branch, issue-<family>;
// on a parent, the family's change from issue-<family> to the default branch, which starts at
// review, whether or not its `agent` sub-issues are still open (spec 2026-11-03 R-B3, R-B8;
// 2026-11-24 R-SM30, R-SM33). The parent asks for that change itself with `open_pr`, n8n's
// `family-pr` wake-up, and both list the `agent` sub-issues still open (`open_sub_issues`).
//
// A Bug's change skips the plan unless the issue has `needs plan`, which the debug agent adds
// for a nasty one and Dr K may add or take off (spec 2026-10-28 R-G15, R-G16).
//
// A label takes the family over (cancels its running turn), except while a sub-issue is being
// filed in it: the make job's name carries its family, so the router finds it among the
// workflow's runs (GITHUB_WORKFLOW_REF, the caller's) with an App token that may read
// actions (ACTIONS_TOKEN), and the label then queues like a comment (spec 2026-11-12 R-L3).
// Without that token the label takes over, as before.
//
// The parent acts for Dr K inside its family: the App's `spec approved` on an `agent` sub-issue
// hands off as his does, and nowhere else (spec 2026-11-24 R-SM20).
//
// It answers n8n's `agent-issue` dispatch: a label added or a comment made on an issue. The
// issue is read live; the payload is a pointer, so the comment's author and the labeler are
// read back from GitHub. n8n's family wake-ups come as the same dispatch, named by the
// payload's `family_event` (spec 2026-11-03 R-E2), so a caller lists no new type:
// `sub-issue-closed` and `sub-issue-reported` are the parent's turns, `parent-message` and
// `sub-issue-start` (a filed sub-issue's first turn, R-SM25) the sub-issue's, `sub-issue-file`
// the make-sub-issue turn on the parent's `file` action (stage `file`), `family-pr` the hand-off
// of the family's change on the parent's `open_pr` (stage `handoff`). Their pointers are
// read back the same way. Without `family_event`, the dispatch is a label or a comment, as it
// always was. A sub-issue's first turn opens with the sub-issue prompt however it was woken.
//
// An upstream epic's downstream issues (spec 2026-11-24 upstream releases, R-UR6 to R-UR13) carry
// the epic's marker (issue-agent/lib/upstream.js), and their turns are `kin` `downstream`, with the
// epic as `upstream`. n8n wakes them with `upstream-start` (the first rc opened the issue) and
// `upstream-message` (the epic's message, or a later rc's note, the App's comment on the issue),
// and the epic with `downstream-reported` (a downstream turn's report, which n8n posted on it). The
// App's `spec approved` on a marked issue hands off its change, as Dr K's does (R-UR11). A parent's
// hand-off carries its one `release:*` label (`release_label`, R-UR1) for the family's change.

const { lastLabeledBy } = require('../../issue-agent/lib/gate');
const { parentOf, familyOf } = require('../../issue-agent/lib/family');
const { isAgent } = require('../../issue-agent/lib/state');
const { markerOf, noteOf, sameRef } = require('../../issue-agent/lib/upstream');

// the issue types the flow takes, and the agent each one gets
const ROLES = { Feature: 'spec', Bug: 'debug' };
const TURNS = ['agent', 'spec'];
const APPROVED = 'spec approved';
const NEEDS_PLAN = 'needs plan';

const MAKE = 'Make the Sub-issue';

// n8n's family wake-ups (`family_event`), and the kb prompt each turn starts with
const FAMILY = {
  'sub-issue-closed': 'sub-issue-closed',
  'sub-issue-reported': 'sub-issue-reported',
  'parent-message': 'parent-message',
  'sub-issue-file': 'make-sub-issue',
  'sub-issue-start': 'sub-issue',
  // no turn: the hand-off opens or refreshes the family's change (R-SM30)
  'family-pr': '',
  // a downstream issue's, for its upstream epic (R-UR6, R-UR8), and the epic's on a report (R-UR9)
  'upstream-start': 'upstream-release',
  'upstream-message': 'upstream-message',
  'downstream-reported': 'downstream-reported',
};
const DOWNSTREAM = ['upstream-start', 'upstream-message'];
const RELEASE = /^release:(patch|minor|major)$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[1-9]\d*$/;

const labelsOf = (i) => (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name));

// the issue's one release label, for the family's change; none, or two, is empty (R-UR1)
const releaseLabelOf = (labels) => {
  const found = labels.filter((l) => RELEASE.test(l));
  return found.length === 1 ? found[0] : '';
};

// the parent's `agent` sub-issues still open, for the family change's body (R-SM30)
const openSubIssues = (subs) => JSON.stringify((subs || [])
  .filter((i) => i.state === 'open' && labelsOf(i).includes('agent'))
  .map((i) => ({ number: i.number, title: i.title || '' })));

// the prompt a sub-issue's first turn opens with: a Bug's is debug-report
const openingOf = (type) => (type === 'Bug' ? 'debug-report' : 'sub-issue');

// a sub-issue's first turn: nothing the agent wrote on it yet (the App's own answer)
async function firstTurn(github, context, cfg, number) {
  const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: number, per_page: 100 });
  return !comments.some((c) => c.user?.type === 'Bot' && String(c.user?.id) === cfg.app && isAgent(c.body));
}

function settings(env) {
  return { owner: env.OWNER_ID, app: env.APP_ID, prompts: env.PROMPTS, workflowRef: env.GITHUB_WORKFLOW_REF || '', actionsToken: env.ACTIONS_TOKEN || '' };
}

// The family's make job, if one is in flight in another of this workflow's runs: a run waiting
// on the family's queue is `queued`, a running one `in_progress`. A called workflow's job is
// named `<caller job> / <name>`.
async function makingIn({ actions: github, context, family, workflowRef }) {
  const name = `${MAKE} · #${family}`;
  const file = (workflowRef.split('@')[0].match(/[^/]+\.ya?ml$/) || [])[0];
  const runs = [];
  for (const status of ['in_progress', 'queued']) {
    const params = { ...context.repo, status, per_page: 100 };
    const { data } = file
      ? await github.rest.actions.listWorkflowRuns({ ...params, workflow_id: file })
      : await github.rest.actions.listWorkflowRunsForRepo(params);
    runs.push(...(data.workflow_runs || []).filter((r) => r.id !== context.runId));
  }
  for (const r of runs) {
    const { data } = await github.rest.actions.listJobsForWorkflowRun({ ...context.repo, run_id: r.id, filter: 'latest', per_page: 100 });
    const job = (data.jobs || []).find((j) => j.status !== 'completed' && (j.name === name || j.name?.endsWith(` / ${name}`)));
    if (job) return job;
  }
  return null;
}

// The stage an event is for, and why when it is nothing. `parented`: the issue has a parent,
// read only for the App's `spec approved`; `parent`: it has sub-issues. The App's counts on a
// leaf sub-issue only, never on a parent at any depth, and on an issue that carries an upstream
// epic's marker (`marked`, R-UR11), if it is no parent
function stageOf({ comment, label, labels, type, isPR, byOwner, byApp, parented = false, parent = false, marked = false }) {
  const none = (why) => ({ stage: 'none', why });
  const has = (name) => labels.includes(name);
  if (isPR) return none('a pull request, not a work item');
  if (label && !has(label)) return none(`${label} is no longer on it`);
  if (!comment && label !== APPROVED && !TURNS.includes(label)) return none(`the ${label} label wakes nothing`);
  const forDrK = byApp && label === APPROVED;
  if (!byOwner && !forDrK) return none(byApp ? "the App's own" : 'not the owner');
  if (forDrK && (parent || (!parented && !marked))) return none(parent ? `the App's ${APPROVED} on a parent: only Dr K's opens the family's change` : `the App's ${APPROVED} on a top-level issue`);
  if (!has('agent')) return none('not opted in');
  if (!ROLES[type]) return none(`${type ? `a ${type}` : 'no type'}, not a Feature or Bug`);
  if (type === 'Bug' && label === 'spec') return none('a Bug has no spec');
  if (label === APPROVED) return { stage: 'handoff' };
  if (has(APPROVED)) return none(`after ${APPROVED}: the change carries on`);
  return { stage: 'spec' };
}

// one line of the prompt
const line = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// The event, from the dispatch's pointer
function eventOf(context) {
  const e = context.payload;
  const p = context.eventName === 'repository_dispatch' && e.action === 'agent-issue' ? e.client_payload || {} : {};
  // an empty key is no wake-up: the dispatch is a label or a comment, as ever
  if (p.family_event != null && p.family_event !== '') {
    // an unknown one is nothing, never read as a label or a comment
    if (!(p.family_event in FAMILY)) return { event: 'family', action: String(p.family_event) };
    return { kind: p.family_event, number: Number(p.number) || 0, parent: Number(p.parent) || 0, commentId: Number(p.comment_id) || 0, type: line(p.type), title: line(p.title), ask: line(p.ask), upstream: line(p.upstream), repo: line(p.repo) };
  }
  return { event: p.event, action: p.action, number: Number(p.number) || 0, label: p.label || '', actor: String(p.actor), commentId: Number(p.comment_id) || 0 };
}

// the session a turn thinks in: a sub-issue's own, forked from its family's; any other issue's
// is issue-<number> (spec 2026-11-24 R-SM12, R-SM13). An issue alone that carries an upstream
// epic's marker is `downstream`, and the epic is its `upstream` (R-UR9); a sub-issue or a parent
// stays one, whatever its body says
function sessionOf(core, { number, family, parent, upstream = '' }) {
  const sub = family !== number;
  const kin = sub ? 'sub-issue' : parent ? 'parent' : upstream ? 'downstream' : 'alone';
  core.setOutput('session', sub ? `issue-${family}/${number}` : `issue-${number}`);
  core.setOutput('fork_from', sub ? `issue-${family}` : '');
  core.setOutput('kin', kin);
  core.setOutput('upstream', kin === 'downstream' ? upstream : '');
}

// A family wake-up from n8n: the parent's turn on a sub-issue's close or report, the
// sub-issue's on the parent's message or its filing, the make-sub-issue turn on the parent's
// `file`. The sender is the App (the job's `if`); the pointer is read back: the issue, its
// family, the sub-issue it names, and the comment the turn answers, which must be the App's,
// there. A sub-issue's turn names its parent, which must be its family's top issue.
async function familyTurn({ github, context, core, cfg, ev }) {
  const { kind } = ev;
  const none = (why) => {
    core.setOutput('stage', 'none');
    core.setOutput('why', why);
    return core.info(`${kind}: none (${why})`);
  };
  if (DOWNSTREAM.includes(kind)) return downstreamTurn({ github, context, core, cfg, ev, none });
  // the parent's turns name the sub-issue as `number`; the message and the start are the
  // sub-issue's own
  const onSub = kind === 'parent-message' || kind === 'sub-issue-start';
  const number = onSub ? ev.number : ev.parent;
  const names = kind === 'sub-issue-closed' || kind === 'sub-issue-reported';
  const about = names ? ev.number : 0;
  // the epic's turn on a downstream issue's report names an issue in another repo, never read
  const reported = kind === 'downstream-reported';
  const answers = kind === 'sub-issue-reported' || kind === 'parent-message' || reported;
  const familyPr = kind === 'family-pr';
  if (!number || (names && !about) || (onSub && !ev.parent)) return none('no issue');
  if (reported && (!REPO.test(ev.repo) || !ev.number)) return none('no downstream issue');
  if (answers && !ev.commentId) return none('no comment');

  const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number });
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const type = issue.type?.name || '';
  if (issue.pull_request) return none('a pull request, not a work item');
  // a parent is opted in by its sub-issues (R-SM29): a family wake-up on a parent without
  // `agent` is admitted when the sub-issue it names carries `agent` (the file turn names none:
  // then any sub-issue of the parent that does). Its own turns, and Dr K's, need the label.
  let named = null;
  let viaSub = false;
  // the parent's sub-issues: the family change lists them, and the file turn may be opted in by them
  const listSubs = async () => (await github.request('GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', { ...context.repo, issue_number: number, per_page: 100 })).data || [];
  const subs = familyPr ? await listSubs() : null;
  if (!labels.includes('agent')) {
    if (names) {
      ({ data: named } = await github.rest.issues.get({ ...context.repo, issue_number: about }));
      viaSub = labelsOf(named).includes('agent');
    } else if (kind === 'sub-issue-file' || familyPr || reported) {
      viaSub = (subs || (await listSubs())).some((i) => labelsOf(i).includes('agent'));
    }
    if (!viaSub) return none('not opted in');
  }
  if (!ROLES[type]) return none(`${type ? `a ${type}` : 'no type'}, not a Feature or Bug`);
  if (kind === 'sub-issue-start' && issue.state !== 'open') return none(`#${number} is closed`);
  // a closed epic no longer hears its downstream (R-UR21)
  if (reported && issue.state !== 'open') return none(`#${number} is closed`);
  // a message past the spec is dropped: the change's own PR carries on (a limitation, for now).
  // A parent's family turns go on: `spec approved` there is Dr K asking for the family's change
  // (R-SM32)
  if (onSub && labels.includes(APPROVED)) return none(`PAST-SPEC: #${number} has ${APPROVED}; its change carries on`);
  const family = await familyOf(github, context.repo, number);
  if (onSub && family === number) return none('not a sub-issue');
  if (onSub && family !== ev.parent) return none(`#${number} is not #${ev.parent}'s sub-issue`);
  if (!onSub && family !== number) return none(`#${number} is a sub-issue of #${family}, not a family's top issue`);
  if (about && (about === number || (await familyOf(github, context.repo, about)) !== number)) return none(`#${about} is not #${number}'s sub-issue`);
  if (familyPr && !subs.length) return none(`#${number} has no sub-issues`);
  if (kind === 'sub-issue-closed') {
    const closed = named || (await github.rest.issues.get({ ...context.repo, issue_number: about })).data;
    if (closed.state !== 'closed') return none(`#${about} is still open`);
  }
  if (answers) {
    let got = null;
    try {
      ({ data: got } = await github.rest.issues.getComment({ ...context.repo, comment_id: ev.commentId }));
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    if (!got) return none(`comment ${ev.commentId} is gone`);
    if (!got.issue_url?.endsWith(`/issues/${number}`)) return none(`comment ${ev.commentId} is not on #${number}`);
    if (String(got.user?.id) !== cfg.app) return none(`comment ${ev.commentId} is not the App's`);
    if (reported) {
      const note = noteOf(got.body);
      if (note?.kind !== 'report') return none(`comment ${ev.commentId} is no downstream report`);
      if (note.repo.toLowerCase() !== ev.repo.toLowerCase() || note.number !== ev.number) return none(`comment ${ev.commentId} is not the report of ${ev.repo}#${ev.number}`);
    }
  }
  if (familyPr) return familyChange({ core, issue, number, viaSub, subs });
  // a sub-issue's first turn opens with the sub-issue prompt, however it was woken (R-SM25)
  const first = onSub && (kind === 'sub-issue-start' || (await firstTurn(github, context, cfg, number)));
  let prompt = `${cfg.prompts}${first ? openingOf(type) : FAMILY[kind]}`;
  if (kind === 'sub-issue-file') {
    if (!ROLES[ev.type]) return none(`a ${ev.type || 'missing'} type: a sub-issue is a Feature or Bug`);
    if (!ev.title) return none('no title');
    prompt = `${prompt} ${ev.type}: ${ev.title}${ev.ask ? `\nAsk: ${ev.ask}` : ''}`;
    core.setOutput('item_type', ev.type);
  }

  // admitted through its sub-issue, the parent carries no label for the gate to check
  core.setOutput('opt_in_label', viaSub ? 'none' : 'agent');
  core.setOutput('stage', kind === 'sub-issue-file' ? 'file' : 'spec');
  core.setOutput('number', String(number));
  core.setOutput('family', String(family));
  core.setOutput('change', 'own');
  core.setOutput('plan', String(type !== 'Bug' || labels.includes(NEEDS_PLAN)));
  core.setOutput('label', '');
  core.setOutput('title', issue.title || '');
  core.setOutput('role', ROLES[type]);
  core.setOutput('writes', String(type === 'Feature' && labels.includes('spec')));
  core.setOutput('prompt', prompt);
  // the report, the message or the merge is the turn's subject: the prompt leads into the
  // thread's unseen posts; the make turn's is the whole turn, as on a tick
  core.setOutput('prompt_when', kind === 'sub-issue-file' ? 'always' : 'lead');
  // a machine's turn waits its turn in the family's queue
  core.setOutput('takeover', 'false');
  // the epic runs its downstream as a parent runs its family: its turn ends in actions
  sessionOf(core, { number, family, parent: reported || !!issue.sub_issues_summary?.total });
  core.info(`#${number}: ${kind}${about ? ` of #${about}` : ''}${reported ? ` of ${ev.repo}#${ev.number}` : ''}${family !== number ? `, family #${family}${first ? ', first turn' : ''}` : ''}`);
}

// A downstream issue's turn for its upstream epic (R-UR6, R-UR8): `upstream-start`, the first
// rc's, and `upstream-message`, the epic's message or a later rc's note. The issue is open, an
// `agent` Feature, top-level, before `spec approved`, and carries the marker of the epic the
// payload names, on an issue by the App or Dr K. The message is the App's comment on it, opening
// with n8n's note for that epic. A fresh session, never a fork (Decided 7)
async function downstreamTurn({ github, context, core, cfg, ev, none }) {
  const { kind, number } = ev;
  if (!number || !REF.test(ev.upstream)) return none('no issue');
  if (kind === 'upstream-message' && !ev.commentId) return none('no comment');
  const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number });
  const labels = labelsOf(issue);
  const type = issue.type?.name || '';
  if (issue.pull_request) return none('a pull request, not a work item');
  if (issue.state !== 'open') return none(`#${number} is closed`);
  if (!labels.includes('agent')) return none('not opted in');
  if (type !== 'Feature') return none(`${type ? `a ${type}` : 'no type'}, not a Feature`);
  const marker = markerOf(issue, cfg);
  if (!marker) return none(`#${number} has no upstream marker by the App or Dr K`);
  if (!sameRef(marker.ref, ev.upstream)) return none(`#${number} is marked for ${marker.ref}, not ${ev.upstream}`);
  if (labels.includes(APPROVED)) return none(`PAST-SPEC: #${number} has ${APPROVED}; its change carries on`);
  if (kind === 'upstream-message') {
    let got = null;
    try {
      ({ data: got } = await github.rest.issues.getComment({ ...context.repo, comment_id: ev.commentId }));
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    if (!got) return none(`comment ${ev.commentId} is gone`);
    if (!got.issue_url?.endsWith(`/issues/${number}`)) return none(`comment ${ev.commentId} is not on #${number}`);
    if (String(got.user?.id) !== cfg.app) return none(`comment ${ev.commentId} is not the App's`);
    const note = noteOf(got.body);
    if (!['message', 'release'].includes(note?.kind) || !sameRef(note.upstream, marker.ref)) return none(`comment ${ev.commentId} is no note of ${marker.ref}`);
  }
  const family = await familyOf(github, context.repo, number);
  if (family !== number) return none(`#${number} is a sub-issue of #${family}`);

  core.setOutput('opt_in_label', 'agent');
  core.setOutput('stage', 'spec');
  core.setOutput('number', String(number));
  core.setOutput('family', String(number));
  core.setOutput('change', 'own');
  core.setOutput('plan', 'true');
  core.setOutput('label', '');
  core.setOutput('title', issue.title || '');
  core.setOutput('role', ROLES[type]);
  core.setOutput('writes', String(labels.includes('spec')));
  core.setOutput('prompt', `${cfg.prompts}${FAMILY[kind]}`);
  core.setOutput('prompt_when', 'lead');
  core.setOutput('takeover', 'false');
  sessionOf(core, { number, family: number, parent: !!issue.sub_issues_summary?.total, upstream: marker.ref });
  core.info(`#${number}: ${kind} of ${marker.ref}`);
}

// The family's change on the parent's `open_pr` (R-SM30): the hand-off opens it from
// issue-<family> to the default branch, ready, or refreshes the one open. No turn, and no
// takeover: it queues in the family's group behind the turn that asked for it
function familyChange({ core, issue, number, viaSub, subs }) {
  const labels = labelsOf(issue);
  const type = issue.type?.name || '';
  core.setOutput('opt_in_label', viaSub ? 'none' : 'agent');
  core.setOutput('stage', 'handoff');
  core.setOutput('number', String(number));
  core.setOutput('family', String(number));
  core.setOutput('change', 'parent');
  core.setOutput('plan', String(type !== 'Bug' || labels.includes(NEEDS_PLAN)));
  core.setOutput('label', '');
  core.setOutput('title', issue.title || '');
  core.setOutput('role', ROLES[type]);
  core.setOutput('writes', String(type === 'Feature' && labels.includes('spec')));
  core.setOutput('prompt', '');
  core.setOutput('prompt_when', 'quiet');
  core.setOutput('takeover', 'false');
  core.setOutput('open_sub_issues', openSubIssues(subs));
  core.setOutput('release_label', releaseLabelOf(labels));
  sessionOf(core, { number, family: number, parent: true });
  core.info(`#${number}: family-pr, the family's change`);
}

async function run({ github, context, core, getOctokit, env = process.env }) {
  const cfg = settings(env);
  const ev = eventOf(context);
  core.setOutput('stage', 'none');
  if (ev.kind) return familyTurn({ github, context, core, cfg, ev });
  const comment = ev.event === 'issue_comment' && ev.action === 'created';
  const labelled = ev.event === 'issues' && ev.action === 'labeled' && !!ev.label;
  if (!comment && !labelled) return core.info(`${ev.event}.${ev.action}: not a turn`);
  if (!ev.number) return core.info('no issue');
  const { number } = ev;
  const label = labelled ? ev.label : '';

  const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number });
  let actor = ev.actor;
  if (comment) {
    let got = null;
    if (ev.commentId) {
      try {
        ({ data: got } = await github.rest.issues.getComment({ ...context.repo, comment_id: ev.commentId }));
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    const here = got?.issue_url?.endsWith(`/issues/${number}`);
    if (!got || !here || String(got.user?.id) !== actor) actor = 'unknown';
  } else {
    // the last to add the label, unless it came off again
    const events = await github.paginate(github.rest.issues.listEvents, { ...context.repo, issue_number: number, per_page: 100 });
    actor = String(lastLabeledBy(events, label)?.id ?? 'unknown');
  }

  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const type = issue.type?.name || '';
  // an upstream epic's downstream issue, from the issue already read (R-UR7)
  const marker = issue.pull_request ? null : markerOf(issue, cfg);
  // the App's `spec approved` counts on a sub-issue only, so its parent is read for it alone; on
  // a marked issue it counts too (R-UR11)
  const parented = label === APPROVED && actor === cfg.app && !issue.pull_request && !marker
    ? (await parentOf(github, context.repo, number)) > 0
    : false;
  const { stage, why } = stageOf({
    comment, label, labels, type, parented,
    isPR: !!issue.pull_request,
    byOwner: actor === cfg.owner,
    byApp: actor === cfg.app,
    parent: !!issue.sub_issues_summary?.total,
    marked: !!marker,
  });
  core.setOutput('stage', stage);
  if (why) core.setOutput('why', why);
  core.setOutput('number', String(number));
  // a turn's family, and whether this is a sub-issue's first: nothing the agent wrote on it yet
  let family = number;
  let first = false;
  if (stage !== 'none') {
    family = await familyOf(github, context.repo, number);
    if (family !== number) first = await firstTurn(github, context, cfg, number);
  }
  core.setOutput('family', String(family));
  sessionOf(core, { number, family, parent: !!issue.sub_issues_summary?.total, upstream: marker?.ref || '' });
  // what `spec approved` opens: a sub-issue's change into its family's branch, a parent's
  // change, its sub-issues open or closed (Dr K's `family-pr`, R-SM33), or a change of its own
  let change = 'own';
  if (stage === 'handoff') {
    if (family !== number) change = 'sub';
    else if (issue.sub_issues_summary?.total) {
      const { data: subs } = await github.request('GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', { ...context.repo, issue_number: number, per_page: 100 });
      core.setOutput('open_sub_issues', openSubIssues(subs));
      core.setOutput('release_label', releaseLabelOf(labels));
      change = 'parent';
    }
  }
  core.setOutput('opt_in_label', 'agent');
  core.setOutput('change', change);
  // whether the change starts with a plan turn: a Bug's only when it needs one
  core.setOutput('plan', String(type !== 'Bug' || labels.includes(NEEDS_PLAN)));
  core.setOutput('label', label);
  core.setOutput('title', issue.title || '');
  core.setOutput('role', ROLES[type] || '');
  // the `spec` label gives a Feature's agent a branch, and files that are committed
  core.setOutput('writes', String(type === 'Feature' && labels.includes('spec')));
  // a label's turn is a kb prompt: the `spec` label's spec-draft, and a Bug's first, on
  // `agent`, debug-report, which leads the opening post; a sub-issue's first turn leads with
  // sub-issue; a comment is answered in its own words
  const opening = openingOf(type);
  const prompt = label === 'spec' ? 'spec-draft'
    : first ? opening
      : type === 'Bug' && label === 'agent' ? 'debug-report' : '';
  core.setOutput('prompt', prompt ? `${cfg.prompts}${prompt}` : '');
  core.setOutput('prompt_when', ['debug-report', 'sub-issue'].includes(prompt) ? 'lead' : 'quiet');
  // a label takes the issue over; a comment waits its turn, and so does a label while the
  // family's sub-issue is being filed. A failed look leaves the label's takeover
  let takeover = labelled;
  if (labelled && stage === 'spec' && !cfg.actionsToken) {
    core.notice(`#${number}: no actions_token, so no look for a make job in family #${family}; ${label} takes over`);
  } else if (labelled && stage === 'spec') {
    try {
      const actions = getOctokit(cfg.actionsToken);
      const job = await makingIn({ actions, context, family, workflowRef: cfg.workflowRef });
      if (job) {
        takeover = false;
        core.notice(`#${number}: ${label} queues behind ${job.name} (${job.html_url || `job ${job.id}`}), which takeover would cancel`);
      }
    } catch (err) {
      core.warning(`#${number}: could not look for a make job in family #${family} (${err.status || ''} ${err.message}); ${label} takes over`);
    }
  }
  core.setOutput('takeover', String(takeover));
  core.info(`#${number}: ${stage}${why ? ` (${why})` : ''}${family !== number ? `, family #${family}${first ? ', first turn' : ''}` : ''}`);
}

module.exports = { run, stageOf };
