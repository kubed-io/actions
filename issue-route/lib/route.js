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
// on a parent whose `agent` sub-issues are all closed, the parent's change, which starts
// at review (spec 2026-11-03 R-B3, R-B8).
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
// `sub-issue-closed` and `sub-issue-reported` are the parent's turns, `parent-message` the
// sub-issue's, `sub-issue-file` the make-sub-issue turn on the parent's `file` action (stage
// `file`). Their pointers are read back the same way. Without `family_event`, the dispatch is
// a label or a comment, as it always was.

const { lastLabeledBy } = require('../../issue-agent/lib/gate');
const { parentOf, familyOf } = require('../../issue-agent/lib/family');
const { isAgent } = require('../../issue-agent/lib/state');

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
};

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
// read only for the App's `spec approved`; `parent`: it has sub-issues
function stageOf({ comment, label, labels, type, isPR, byOwner, byApp, parented = false, parent = false }) {
  const none = (why) => ({ stage: 'none', why });
  const has = (name) => labels.includes(name);
  if (isPR) return none('a pull request, not a work item');
  if (label && !has(label)) return none(`${label} is no longer on it`);
  if (!comment && label !== APPROVED && !TURNS.includes(label)) return none(`the ${label} label wakes nothing`);
  const forDrK = byApp && label === APPROVED;
  if (!byOwner && !forDrK) return none(byApp ? "the App's own" : 'not the owner');
  if (forDrK && !parented) return none(parent ? `the App's ${APPROVED} on a parent: only Dr K's opens the family's change` : `the App's ${APPROVED} on a top-level issue`);
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
  if (p.family_event !== undefined) {
    // an unknown one is nothing, never read as a label or a comment
    if (!FAMILY[p.family_event]) return { event: 'family', action: String(p.family_event) };
    return { kind: p.family_event, number: Number(p.number) || 0, parent: Number(p.parent) || 0, commentId: Number(p.comment_id) || 0, type: line(p.type), title: line(p.title), ask: line(p.ask) };
  }
  return { event: p.event, action: p.action, number: Number(p.number) || 0, label: p.label || '', actor: String(p.actor), commentId: Number(p.comment_id) || 0 };
}

// the session a turn thinks in: a sub-issue's own, forked from its family's; any other issue's
// is issue-<number> (spec 2026-11-24 R-SM12, R-SM13)
function sessionOf(core, { number, family, parent }) {
  const sub = family !== number;
  core.setOutput('session', sub ? `issue-${family}/${number}` : `issue-${number}`);
  core.setOutput('fork_from', sub ? `issue-${family}` : '');
  core.setOutput('kin', sub ? 'sub-issue' : parent ? 'parent' : 'alone');
}

// A family wake-up from n8n: the parent's turn on a sub-issue's close or report, the
// sub-issue's on the parent's message, the make-sub-issue turn on the parent's `file`. The
// sender is the App (the job's `if`); the pointer is read back: the issue, its family, the
// sub-issue it names, and the comment the turn answers, which must be the App's, there.
async function familyTurn({ github, context, core, cfg, ev }) {
  const { kind } = ev;
  const none = (why) => {
    core.setOutput('stage', 'none');
    core.setOutput('why', why);
    return core.info(`${kind}: none (${why})`);
  };
  // the parent's turns name the sub-issue as `number`; the message is the sub-issue's own
  const number = kind === 'parent-message' ? ev.number : ev.parent;
  const names = kind === 'sub-issue-closed' || kind === 'sub-issue-reported';
  const about = names ? ev.number : 0;
  const answers = kind === 'sub-issue-reported' || kind === 'parent-message';
  if (!number || (names && !about)) return none('no issue');
  if (answers && !ev.commentId) return none('no comment');

  const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number });
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const type = issue.type?.name || '';
  if (issue.pull_request) return none('a pull request, not a work item');
  if (!labels.includes('agent')) return none('not opted in');
  if (!ROLES[type]) return none(`${type ? `a ${type}` : 'no type'}, not a Feature or Bug`);
  // a message past the spec is dropped: the change's own PR carries on (a limitation, for now)
  if (labels.includes(APPROVED)) return none(`PAST-SPEC: #${number} has ${APPROVED}; its change carries on`);
  const family = await familyOf(github, context.repo, number);
  if (kind === 'parent-message' && family === number) return none('not a sub-issue');
  if (kind !== 'parent-message' && family !== number) return none(`#${number} is a sub-issue of #${family}, not a family's top issue`);
  if (about && (about === number || (await familyOf(github, context.repo, about)) !== number)) return none(`#${about} is not #${number}'s sub-issue`);
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
  }
  let prompt = `${cfg.prompts}${FAMILY[kind]}`;
  if (kind === 'sub-issue-file') {
    if (!ROLES[ev.type]) return none(`a ${ev.type || 'missing'} type: a sub-issue is a Feature or Bug`);
    if (!ev.title) return none('no title');
    prompt = `${prompt} ${ev.type}: ${ev.title}${ev.ask ? `\nAsk: ${ev.ask}` : ''}`;
    core.setOutput('item_type', ev.type);
  }

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
  sessionOf(core, { number, family, parent: !!issue.sub_issues_summary?.total });
  core.info(`#${number}: ${kind}${about ? ` of #${about}` : ''}${family !== number ? `, family #${family}` : ''}`);
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
  // the App's `spec approved` counts on a sub-issue only, so its parent is read for it alone
  const parented = label === APPROVED && actor === cfg.app && !issue.pull_request
    ? (await parentOf(github, context.repo, number)) > 0
    : false;
  const { stage, why } = stageOf({
    comment, label, labels, type, parented,
    isPR: !!issue.pull_request,
    byOwner: actor === cfg.owner,
    byApp: actor === cfg.app,
    parent: !!issue.sub_issues_summary?.total,
  });
  core.setOutput('stage', stage);
  if (why) core.setOutput('why', why);
  core.setOutput('number', String(number));
  // a turn's family, and whether this is a sub-issue's first: nothing the agent wrote on it yet
  let family = number;
  let first = false;
  if (stage !== 'none') {
    family = await familyOf(github, context.repo, number);
    if (family !== number) {
      const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: number, per_page: 100 });
      first = !comments.some((c) => c.user?.type === 'Bot' && String(c.user?.id) === cfg.app && isAgent(c.body));
    }
  }
  core.setOutput('family', String(family));
  sessionOf(core, { number, family, parent: !!issue.sub_issues_summary?.total });
  // what `spec approved` opens: a sub-issue's change into its family's branch, a parent's
  // change once its sub-issues are closed, or a change of its own
  let change = 'own';
  if (stage === 'handoff') {
    if (family !== number) change = 'sub';
    else if (issue.sub_issues_summary?.total) {
      const { data: subs } = await github.request('GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', { ...context.repo, issue_number: number, per_page: 100 });
      const open = (subs || []).filter((i) => i.state === 'open' && (i.labels || []).some((l) => (l.name || l) === 'agent'));
      if (open.length) {
        const still = `sub-issues still open: ${open.map((i) => `#${i.number}`).join(', ')}`;
        core.setOutput('stage', 'none');
        core.setOutput('why', still);
        return core.info(`#${number}: none (${still})`);
      }
      change = 'parent';
    }
  }
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
  const opening = type === 'Bug' ? 'debug-report' : 'sub-issue';
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
