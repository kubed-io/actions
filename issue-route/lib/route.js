// Decides what an event on a work item (an issue) is for the agents: a spec turn, the
// hand-off to a plan, or nothing.
//
// On a Feature or Bug issue with `agent`, the owner's comment or their `agent` label is a
// turn; on a Feature, their `spec` label too, until `spec approved`, and their `spec
// approved` is the hand-off. A Feature's turns are the spec agent's; a Bug's are the debug
// agent's, which reports and never writes. Anything else is nothing.
//
// A sub-issue is part of its family's conversation: the turn takes the family's session and
// queue (its top issue's number, `family`), and a sub-issue's first turn opens with the
// sub-issue prompt (a Bug's, with debug-report).
//
// `spec approved` on a sub-issue opens its change into the family's branch, issue-<family>;
// on a parent whose `agent` sub-issues are all closed, the parent's change, which starts
// at review (spec 2026-11-03 R-B3, R-B8).
//
// It answers the native events (`issues` labeled, `issue_comment` created) and n8n's
// `agent-issue` dispatch, the same for the same situation. The issue is read live; a
// dispatch's payload is a pointer, so the comment's author and the labeler are read back
// from GitHub.

const { lastLabeledBy } = require('../../issue-agent/lib/gate');
const { familyOf } = require('../../issue-agent/lib/family');
const { isAgent } = require('../../issue-agent/lib/state');

// the issue types the flow takes, and the agent each one gets
const ROLES = { Feature: 'spec', Bug: 'debug' };
const TURNS = ['agent', 'spec'];
const APPROVED = 'spec approved';

function settings(env) {
  return { owner: env.OWNER_ID, app: env.APP_ID, prompts: env.PROMPTS };
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
  if (type === 'Bug' && (label === APPROVED || label === 'spec')) return none(`a Bug has no ${label === 'spec' ? 'spec' : 'hand-off'}`);
  if (label === APPROVED) return { stage: 'handoff' };
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
  // a label takes the issue over; a comment waits its turn
  core.setOutput('takeover', String(labelled));
  core.info(`#${number}: ${stage}${why ? ` (${why})` : ''}${family !== number ? `, family #${family}${first ? ', first turn' : ''}` : ''}`);
}

module.exports = { run, stageOf };
