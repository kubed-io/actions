// Decides what an event on a work item (an issue) is for the agents: a spec turn, the
// hand-off to a plan, or nothing.
//
// On a Feature or Bug issue with `agent`, the owner's comment or their `agent` label is a
// turn; on a Feature, their `spec` label too, until `spec approved`, and their `spec
// approved` is the hand-off. A Feature's turns are the spec agent's; a Bug's are the debug
// agent's, which reports and never writes, and its `spec approved` hands the report off to
// a fix. Anything else is nothing.
//
// A sub-issue is part of its family's conversation: the turn takes the family's session and
// queue (its top issue's number, `family`), and a sub-issue's first turn opens with the
// sub-issue prompt (a Bug's, with debug-report).
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
// It answers n8n's `agent-issue` dispatch: a label added or a comment made on an issue. The
// issue is read live; the payload is a pointer, so the comment's author and the labeler are
// read back from GitHub.

const { lastLabeledBy } = require('../../issue-agent/lib/gate');
const { familyOf } = require('../../issue-agent/lib/family');
const { isAgent } = require('../../issue-agent/lib/state');

// the issue types the flow takes, and the agent each one gets
const ROLES = { Feature: 'spec', Bug: 'debug' };
const TURNS = ['agent', 'spec'];
const APPROVED = 'spec approved';
const NEEDS_PLAN = 'needs plan';

const MAKE = 'Make the Sub-issue';

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

// The stage an event is for, and why when it is nothing
function stageOf({ comment, label, labels, type, isPR, byOwner, byApp }) {
  const none = (why) => ({ stage: 'none', why });
  const has = (name) => labels.includes(name);
  if (isPR) return none('a pull request, not a work item');
  if (label && !has(label)) return none(`${label} is no longer on it`);
  if (!comment && label !== APPROVED && !TURNS.includes(label)) return none(`the ${label} label wakes nothing`);
  if (!byOwner) return none(byApp ? "the App's own" : 'not the owner');
  if (!has('agent')) return none('not opted in');
  if (!ROLES[type]) return none(`${type ? `a ${type}` : 'no type'}, not a Feature or Bug`);
  if (type === 'Bug' && label === 'spec') return none('a Bug has no spec');
  if (label === APPROVED) return { stage: 'handoff' };
  if (has(APPROVED)) return none(`after ${APPROVED}: the change carries on`);
  return { stage: 'spec' };
}

// The event, from the dispatch's pointer
function eventOf(context) {
  const e = context.payload;
  const p = context.eventName === 'repository_dispatch' && e.action === 'agent-issue' ? e.client_payload || {} : {};
  return { event: p.event, action: p.action, number: Number(p.number) || 0, label: p.label || '', actor: String(p.actor), commentId: Number(p.comment_id) || 0 };
}

async function run({ github, context, core, getOctokit, env = process.env }) {
  const cfg = settings(env);
  const ev = eventOf(context);
  core.setOutput('stage', 'none');
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
  const { stage, why } = stageOf({
    comment, label, labels, type,
    isPR: !!issue.pull_request,
    byOwner: actor === cfg.owner,
    byApp: actor === cfg.app,
  });
  core.setOutput('stage', stage);
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
  // what `spec approved` opens: a sub-issue's change into its family's branch, a parent's
  // change once its sub-issues are closed, or a change of its own
  let change = 'own';
  if (stage === 'handoff') {
    if (family !== number) change = 'sub';
    else if (issue.sub_issues_summary?.total) {
      const { data: subs } = await github.request('GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', { ...context.repo, issue_number: number, per_page: 100 });
      const open = (subs || []).filter((i) => i.state === 'open' && (i.labels || []).some((l) => (l.name || l) === 'agent'));
      if (open.length) {
        core.setOutput('stage', 'none');
        return core.info(`#${number}: none (sub-issues still open: ${open.map((i) => `#${i.number}`).join(', ')})`);
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
