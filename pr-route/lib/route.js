// Decides what an event on an agent-built PR (head `issue-*`) is for the agents: a plan
// turn, a code turn, or nothing, and the words the turn starts with.
//
// Before `plan approved`: the owner's comments and reviews are plan turns. After it: the
// owner's comments and reviews, the label, a review by Copilot, an `agent-code` dispatch,
// and a push to the draft by the agent or the owner are code turns; a push whose commit
// says `Agent: done` is not. Anything else is nothing.

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
  if (!approved) return byOwner && !pushed ? 'plan' : 'none';
  // a review wakes the code agent when it is the owner's or Copilot's: the agent's own
  // thread replies arrive as reviews too, by the App, and must not wake it again
  if (review) return byOwner || byCopilot ? 'code' : 'none';
  // a comment, the label: the owner's, by the job's gate
  if (!pushed) return 'code';
  return draft && (byOwner || byApp) && !finished ? 'code' : 'none';
}

// What a turn with no words of its own starts with: a kb prompt, sent as a slash command,
// so the methodology's own text drives the turn
function promptOf({ dispatched, reason, labelled, pushed }, prefix) {
  const turn = (name) => `${prefix}${name}`;
  // copilot: Copilot's hand-back, sent as its review run ends; a review to answer
  const reasons = { review: turn('review-came-in'), copilot: turn('review-came-in'), ci: turn('checks-failed') };
  if (dispatched) return reasons[reason] || `Woken by ${reason || 'a dispatch'}: see what needs doing.`;
  if (labelled) return turn('plan-approved');
  if (pushed) return turn('next-task');
  return '';
}

async function run({ github, context, core, env = process.env }) {
  const cfg = settings(env);
  const e = context.payload;
  const checksRun = e.workflow_run;
  const dispatched = context.eventName === 'repository_dispatch';
  const number = checksRun ? (checksRun.pull_requests?.[0]?.number || 0)
    : Number(dispatched ? e.client_payload?.pull_request : (e.issue?.number || e.pull_request?.number)) || 0;
  core.setOutput('stage', 'none');
  if (!number) return core.info('no pull request');
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  const ours = pr.head.repo?.full_name === `${context.repo.owner}/${context.repo.repo}`;
  if (pr.state !== 'open' || !ours || !pr.head.ref.startsWith(cfg.prefix)) return core.info(`#${number} is not the agents'`);

  const actor = String((checksRun ? checksRun.triggering_actor : e.sender)?.id);
  const pushed = checksRun?.event === 'pull_request';
  const labelled = context.eventName === 'pull_request_target';
  // the run that finished the plan said so on its commit: its push wakes nothing
  const { data: head } = await github.rest.repos.getCommit({ ...context.repo, ref: pr.head.sha });
  const facts = {
    dispatched, pushed, labelled,
    approved: pr.labels.some((l) => l.name === cfg.label),
    review: checksRun?.event === 'pull_request_review',
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
  // the checks run whose report the code job downloads
  const runId = dispatched && facts.reason === 'ci' ? Number(e.client_payload?.run_id) || 0 : 0;
  core.setOutput('run_id', runId ? String(runId) : '');
  // the approval label takes the PR over; anything else waits its turn
  core.setOutput('takeover', String(labelled));
  // the dispatch's reason: `copilot` asks the route job to wait for Copilot's review first
  core.setOutput('reason', dispatched ? String(facts.reason || '') : '');
  core.info(`#${number}: ${stage}`);
}

module.exports = { run, stageOf, promptOf };
