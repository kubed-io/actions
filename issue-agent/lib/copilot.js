// Copilot as a reviewer. The owner's own request opts a change in; after that the flow asks
// for each new head itself, on the App's token or GITHUB_TOKEN (both start a review since
// 2026-11). Its review wakes nothing directly: GitHub holds every run Copilot triggers, so
// n8n relays the review.
//
// `run` below is the older in-band wait (issue-agent/review), still used by repos not yet
// on the relay.

// one bot, a different login per API
function isCopilot(user) {
  return !!user && (user.login === 'Copilot' || /^copilot-pull-request-reviewer(\[bot\])?$/.test(user.login));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reviewOf(github, { owner, repo, number, sha }) {
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
  return reviews.filter((r) => isCopilot(r.user) && r.commit_id === sha).pop() || null;
}

// Copilot never shows in requested_reviewers; only the timeline says it was asked. A
// request answered by a later review no longer counts.
async function isAsked(github, { owner, repo, number }) {
  const events = await github.paginate(github.rest.issues.listEventsForTimeline, { owner, repo, issue_number: number, per_page: 100 });
  let asked = false;
  for (const e of events) {
    if (e.event === 'review_requested' && isCopilot(e.requested_reviewer)) asked = true;
    if (e.event === 'reviewed' && isCopilot(e.user)) asked = false;
  }
  return asked;
}

async function waitForReview(github, { owner, repo, number, sha, timeoutMs, intervalMs, wait }) {
  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    const review = await reviewOf(github, { owner, repo, number, sha });
    if (review) return review;
    await wait(intervalMs);
  }
  return null;
}

// the held relay runs Copilot's reviews leave behind, which nobody will ever approve
async function clearHeldRuns(github, { owner, repo, branch, core }) {
  try {
    const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, { owner, repo, branch, status: 'action_required', per_page: 100 });
    for (const r of runs.filter((x) => isCopilot(x.triggering_actor))) {
      await github.rest.actions.deleteWorkflowRun({ owner, repo, run_id: r.id });
    }
  } catch (e) {
    core.warning(`could not clear Copilot's held runs: ${e.message}`);
  }
}

const REVIEWER = 'copilot-pull-request-reviewer[bot]';

// the review a cancelled or failed run leaves: no verdict
const failedReview = (review) => /^Copilot encountered an error/.test(review?.body || '');

const timeline = (github, { owner, repo, number }) => github.paginate(github.rest.issues.listEventsForTimeline,
  { owner, repo, issue_number: number, per_page: 100 });

// The owner's own request is the opt-in; the flow's requests for each head are not
function optedIn(events, ownerId) {
  return events.some((e) => e.event === 'review_requested' && isCopilot(e.requested_reviewer)
    && String(e.actor?.id) === String(ownerId));
}

// Copilot was asked to review a head: a request since its commit
function askedSince(events, date) {
  const t = Date.parse(date);
  return events.some((e) => e.event === 'review_requested' && isCopilot(e.requested_reviewer)
    && Date.parse(e.created_at) >= t);
}

// Copilot's reviews of one commit, oldest first
async function reviewsOf(github, { owner, repo, number, sha }) {
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
  return reviews.filter((r) => isCopilot(r.user) && r.commit_id === sha);
}

const ask = (github, { owner, repo, number }) => github.rest.pulls.requestReviewers(
  { owner, repo, pull_number: number, reviewers: [REVIEWER] });

// folded away as outdated: the review stays, out of the way
const hide = (github, nodeId) => github.graphql(
  'mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { clientMutationId } }',
  { id: nodeId });

// the line comments a review left
async function reviewComments(github, { owner, repo, number, reviewId }) {
  const comments = await github.paginate(github.rest.pulls.listCommentsForReview, { owner, repo, pull_number: number, review_id: reviewId, per_page: 100 });
  return comments.length;
}

// issue-agent/review: waits for Copilot's review of the head, once it is asked, and says
// whether it left anything for the code agent to answer
async function run({ github, context, core, wait = sleep }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const number = Number(env.NUMBER);
  core.setOutput('respond', 'false');
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (pr.draft) {
    core.notice('a draft: Copilot waits for ready for review');
    return;
  }
  const sha = pr.head.sha;
  let review = await reviewOf(github, { owner, repo, number, sha });
  if (!review) {
    if (!(await isAsked(github, { owner, repo, number }))) {
      core.notice(`Copilot is not asked to review ${sha.slice(0, 7)}: request its review to start a round`);
      return;
    }
    core.info(`Copilot is asked to review ${sha.slice(0, 7)}; waiting`);
    const timeoutMs = Number(env.TIMEOUT_MINUTES || 15) * 60000;
    review = await waitForReview(github, { owner, repo, number, sha, timeoutMs, intervalMs: 20000, wait });
  }
  await clearHeldRuns(github, { owner, repo, branch: pr.head.ref, core });
  if (!review) {
    core.warning(`Copilot did not review ${sha.slice(0, 7)} in time`);
    return;
  }
  const comments = await reviewComments(github, { owner, repo, number, reviewId: review.id });
  core.setOutput('review_url', review.html_url || '');
  core.setOutput('comments', String(comments));
  core.setOutput('respond', String(comments > 0));
  core.notice(`Copilot reviewed ${sha.slice(0, 7)}: ${comments} comment(s)`);
}

module.exports = {
  isCopilot, isAsked, reviewComments, run,
  failedReview, timeline, optedIn, askedSince, reviewsOf, ask, hide,
};
