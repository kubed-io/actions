// Copilot reviews a pull request once it is out of draft. Its review cannot wake anything
// by itself: GitHub holds every run Copilot triggers for a maintainer's approval, and no
// setting lifts that. So the job that asks for the review waits for it, in-band, and the
// code agent answers it next.

const COPILOT = 'copilot-pull-request-reviewer[bot]';

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

// The REST call succeeds whether or not the token may ask Copilot (GITHUB_TOKEN may not),
// so the timeline is the proof.
async function askCopilot({ github, context, core, number, wait = sleep }) {
  const { owner, repo } = context.repo;
  const at = { owner, repo, number };
  if (await isAsked(github, at)) return true;
  await github.rest.pulls.requestReviewers({ owner, repo, pull_number: number, reviewers: [COPILOT] });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await isAsked(github, at)) return true;
    await wait(3000);
  }
  core.warning('the request for Copilot did not stick: this token cannot ask Copilot to review');
  return false;
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

// issue-agent/review: asks Copilot about the head, waits for its review, and says whether
// it left anything for the code agent to answer
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
    if (!(await askCopilot({ github, context, core, number, wait }))) throw new Error(`Copilot could not be asked to review ${sha.slice(0, 7)}`);
    core.info(`asked Copilot to review ${sha.slice(0, 7)}; waiting`);
    const timeoutMs = Number(env.TIMEOUT_MINUTES || 15) * 60000;
    review = await waitForReview(github, { owner, repo, number, sha, timeoutMs, intervalMs: 20000, wait });
  }
  await clearHeldRuns(github, { owner, repo, branch: pr.head.ref, core });
  if (!review) {
    core.warning(`Copilot did not review ${sha.slice(0, 7)} in time`);
    return;
  }
  const comments = await github.paginate(github.rest.pulls.listCommentsForReview, { owner, repo, pull_number: number, review_id: review.id, per_page: 100 });
  core.setOutput('review_url', review.html_url || '');
  core.setOutput('comments', String(comments.length));
  core.setOutput('respond', String(comments.length > 0));
  core.notice(`Copilot reviewed ${sha.slice(0, 7)}: ${comments.length} comment(s)`);
}

module.exports = { isCopilot, isAsked, askCopilot, run };
