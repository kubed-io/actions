// Decides what an event on an agent-built PR (head `issue-*`) is for the agents: a plan
// turn, a code turn, or nothing, and the words the turn starts with.
//
// Before `plan approved`: the owner's comments and reviews are plan turns. After it: the
// owner's comments and reviews, the label, an `agent-code` dispatch, and a push to the
// draft by the agent or the owner are code turns; a push whose commit says `Agent: done` is
// not. Anything else is nothing. A review by Copilot is review-route's to read, at any
// stage: `copilot`.
//
// It answers two dispatches. `agent-route` is n8n's relay of a review, a push, a comment or
// the approval label, and routes like the event it carries; its payload is a pointer, so
// who reviewed, commented or labelled is read back from GitHub. `agent-code` is the agents'
// own: failed checks, a review asking for changes, a Bug's fix.

const { lastLabeledBy } = require('../../issue-agent/lib/gate');

const FINISHED = /^Agent: done$/m;

function settings(env) {
  return {
    owner: env.OWNER_ID,
    app: env.APP_ID,
    copilot: env.COPILOT_ID,
    prefix: env.PREFIX,
    label: env.LABEL,
    prompts: env.PROMPTS,
  };
}

// The stage an event is for, from who caused it and what it was
function stageOf({ dispatched, approved, pushed, review, byOwner, byApp, byCopilot, draft, finished }) {
  if (dispatched) return approved ? 'code' : 'none';
  // Copilot's verdict, or its cancelled review of a draft to hide, is review-route's
  if (review && byCopilot) return 'copilot';
  if (!approved) return byOwner && !pushed ? 'plan' : 'none';
  // a review wakes the code agent when it is the owner's: the agent's own thread replies
  // arrive as reviews too, by the App, and must not wake it again
  if (review) return byOwner ? 'code' : 'none';
  // a comment, the label: the owner's, read back from GitHub
  if (!pushed) return byOwner ? 'code' : 'none';
  return draft && (byOwner || byApp) && !finished ? 'code' : 'none';
}

// What a turn with no words of its own starts with: a kb prompt, sent as a slash command,
// so the methodology's own text drives the turn
function promptOf({ dispatched, reason, labelled, pushed }, prefix) {
  const turn = (name) => `${prefix}${name}`;
  // copilot: Copilot's review, read by review-route, with comments to answer; fix: a
  // Bug's change with no plan, started by its hand-off, built from the approved report
  const reasons = { review: turn('review-came-in'), copilot: turn('review-came-in'), ci: turn('checks-failed'), fix: turn('fix-approved') };
  if (dispatched) return reasons[reason] || `Woken by ${reason || 'a dispatch'}: see what needs doing.`;
  if (labelled) return turn('plan-approved');
  if (pushed) return turn('next-task');
  return '';
}

async function run({ github, context, core, env = process.env }) {
  const cfg = settings(env);
  const e = context.payload;
  const viaRoute = context.eventName === 'repository_dispatch' && e.action === 'agent-route';
  const dispatched = context.eventName === 'repository_dispatch' && e.action === 'agent-code';
  core.setOutput('stage', 'none');
  if (!viaRoute && !dispatched) return core.info(`${context.eventName}: only n8n's relay and an agent-code dispatch are turns`);
  const number = Number(e.client_payload?.pull_request) || 0;
  if (!number) return core.info('no pull request');
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  const ours = pr.head.repo?.full_name === `${context.repo.owner}/${context.repo.repo}`;
  if (pr.state !== 'open' || !ours || !pr.head.ref.startsWith(cfg.prefix)) return core.info(`#${number} is not the agents'`);

  const carried = viaRoute ? e.client_payload?.event : '';
  const via = e.client_payload?.action;
  const pushed = carried === 'pull_request' && via === 'synchronize';
  const review = carried === 'pull_request_review' && via === 'submitted';
  const commented = carried === 'issue_comment' && via === 'created';
  const labelled = carried === 'pull_request' && via === 'labeled' && e.client_payload?.label === cfg.label;
  // the relay carries only these: a push, a submitted review, a new comment, the approval label
  if (viaRoute && !pushed && !review && !commented && !labelled) return core.info('agent-route: unknown event');
  let actor = String(viaRoute ? e.client_payload?.actor : e.sender?.id);
  if (review) {
    // the payload is a pointer: who reviewed, and of what, is read back from GitHub
    const reviewId = Number(e.client_payload?.review_id) || 0;
    let got = null;
    if (reviewId) {
      try {
        ({ data: got } = await github.rest.pulls.getReview({ ...context.repo, pull_number: number, review_id: reviewId }));
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    if (!got || String(got.user?.id) !== actor) actor = 'unknown';
  }
  if (commented) {
    const commentId = Number(e.client_payload?.comment_id) || 0;
    let got = null;
    if (commentId) {
      try {
        ({ data: got } = await github.rest.issues.getComment({ ...context.repo, comment_id: commentId }));
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    const here = got?.issue_url?.endsWith(`/issues/${number}`);
    if (!got || !here || String(got.user?.id) !== actor) actor = 'unknown';
  }
  const approved = pr.labels.some((l) => l.name === cfg.label);
  if (labelled) {
    // gone again: nothing to approve
    if (!approved) return core.info(`agent-route: ${cfg.label} is no longer on #${number}`);
    const events = await github.paginate(github.rest.issues.listEvents, { ...context.repo, issue_number: number, per_page: 100 });
    actor = String(lastLabeledBy(events, cfg.label)?.id ?? 'unknown');
  }
  // the run that finished the plan said so on its commit: its push wakes nothing
  const { data: head } = await github.rest.repos.getCommit({ ...context.repo, ref: pr.head.sha });
  const facts = {
    dispatched, pushed, labelled,
    approved,
    review,
    byOwner: actor === cfg.owner,
    byApp: actor === cfg.app,
    byCopilot: actor === cfg.copilot,
    draft: pr.draft,
    finished: FINISHED.test(head.commit.message),
    reason: e.client_payload?.reason,
  };
  const stage = stageOf(facts);
  core.setOutput('stage', stage);
  core.setOutput('number', String(number));
  core.setOutput('head', pr.head.ref);
  core.setOutput('prompt', promptOf(facts, cfg.prompts));
  // a dispatched event (checks failed, a review) is the point of its run: its prompt is
  // the whole turn, and anything unread is the next one. A slash command only works at
  // the start of a turn, so it cannot follow the thread's messages
  core.setOutput('prompt_when', dispatched ? 'always' : 'quiet');
  // the review review-route reads
  core.setOutput('review_id', stage === 'copilot' ? String(e.client_payload?.review_id || '') : '');
  // the checks run whose report the code job downloads
  const runId = dispatched && facts.reason === 'ci' ? Number(e.client_payload?.run_id) || 0 : 0;
  core.setOutput('run_id', runId ? String(runId) : '');
  // the approval label takes the PR over; anything else waits its turn
  core.setOutput('takeover', String(labelled));
  // the dispatch's reason
  core.setOutput('reason', dispatched ? String(facts.reason || '') : '');
  core.info(`#${number}: ${stage}`);
}

module.exports = { run, stageOf, promptOf };
