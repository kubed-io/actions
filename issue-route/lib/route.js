// Decides what an event on a work item (an issue) is for the agents: a spec turn, the
// hand-off to a plan, or nothing.
//
// On an issue with `enhancement` and `agent`, the owner's comment, or their `agent` or
// `spec` label, is a spec turn, until `spec approved`. The owner's `spec approved` on an
// opted-in issue is the hand-off. Anything else is nothing.
//
// It answers the native events (`issues` labeled, `issue_comment` created) and n8n's
// `agent-issue` dispatch, the same for the same situation. The issue is read live; a
// dispatch's payload is a pointer, so the comment's author and the labeler are read back
// from GitHub.

const { lastLabeledBy } = require('../../issue-agent/lib/gate');

const OPT_IN = ['enhancement', 'agent'];
const TURNS = ['agent', 'spec'];
const APPROVED = 'spec approved';

function settings(env) {
  return { owner: env.OWNER_ID, app: env.APP_ID, prompts: env.PROMPTS };
}

// The stage an event is for, and why when it is nothing
function stageOf({ comment, label, labels, isPR, byOwner, byApp }) {
  const none = (why) => ({ stage: 'none', why });
  const has = (name) => labels.includes(name);
  if (isPR) return none('a pull request, not a work item');
  if (label && !has(label)) return none(`${label} is no longer on it`);
  if (!comment && label !== APPROVED && !TURNS.includes(label)) return none(`the ${label} label wakes nothing`);
  if (!byOwner) return none(byApp ? "the App's own" : 'not the owner');
  if (!has('agent')) return none('not opted in');
  if (label === APPROVED) return { stage: 'handoff' };
  if (!has('enhancement')) return none('not an enhancement');
  if (has(APPROVED)) return none(`after ${APPROVED}: the change carries on`);
  return { stage: 'spec' };
}

// The event, natively or from the dispatch's pointer
function eventOf(context) {
  const e = context.payload;
  if (context.eventName === 'repository_dispatch') {
    const p = e.action === 'agent-issue' ? e.client_payload || {} : {};
    return { dispatched: true, event: p.event, action: p.action, number: Number(p.number) || 0, label: p.label || '', actor: String(p.actor), commentId: Number(p.comment_id) || 0 };
  }
  return { dispatched: false, event: context.eventName, action: e.action, number: e.issue?.number || 0, label: e.label?.name || '', actor: String(e.sender?.id) };
}

async function run({ github, context, core, env = process.env }) {
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
  if (ev.dispatched && comment) {
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
  } else if (ev.dispatched) {
    // the last to add the label, unless it came off again
    const events = await github.paginate(github.rest.issues.listEvents, { ...context.repo, issue_number: number, per_page: 100 });
    actor = String(lastLabeledBy(events, label)?.id ?? 'unknown');
  }

  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const { stage, why } = stageOf({
    comment, label, labels,
    isPR: !!issue.pull_request,
    byOwner: actor === cfg.owner,
    byApp: actor === cfg.app,
  });
  core.setOutput('stage', stage);
  core.setOutput('number', String(number));
  core.setOutput('label', label);
  core.setOutput('title', issue.title || '');
  // the `spec` label gives the agent a branch, and files that are committed
  core.setOutput('writes', String(labels.includes('spec')));
  // the `spec` label's turn is a kb prompt; a comment is answered in its own words
  core.setOutput('prompt', label === 'spec' ? `${cfg.prompts}spec-draft` : '');
  // a label takes the issue over; a comment waits its turn
  core.setOutput('takeover', String(labelled));
  core.info(`#${number}: ${stage}${why ? ` (${why})` : ''}`);
}

module.exports = { run, stageOf };
