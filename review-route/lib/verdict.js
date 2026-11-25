// The review agent's verdict as the `Agent review` status on the head it reviewed: only
// `looks good` passes. Set as the reviewer (github-actions[bot]), since review-route
// reads only its statuses back. A `family` review (a sub-issue's PR into `issue-<P>`) also
// hands its verdict to n8n, which merges a pass into the family's branch (spec 2026-11-24
// R-SM4): this makes the body, and issue-agent/handback sends it. The last allowed review
// asking for changes hands back `needs a human` (R-SM28): no review follows, so the parent
// must hear of it. A review that ends without a verdict (the agent failed, or gave no output)
// tells n8n it errored, on any PR, naming the run n8n retried when this was its retry: n8n
// retries the first error on a head and hands the second back (R-SM35, R-SM36).

function outputOf(output) {
  try { return JSON.parse(output || '{}') || {}; } catch { return {}; }
}

// the `verdict` callback body; review-route's carried pass sends the same
function verdictBody({ repo, number, sha, verdict, summary, reviewId, runId }) {
  return {
    type: 'verdict', repo, number: Number(number) || 0, sha, verdict,
    summary: typeof summary === 'string' ? summary.trim() : '',
    review_id: Number(reviewId) || 0, run_id: Number(runId) || 0,
  };
}

// the `review-error` callback body: the PR, the head, this run, and the errored run n8n's retry
// was for (0 when this was no retry)
function reviewErrorBody({ repo, number, sha, runId, retryOf }) {
  const of = Number(retryOf);
  return {
    type: 'review-error', repo, number: Number(number) || 0, sha,
    run_id: Number(runId) || 0, retry_of: Number.isSafeInteger(of) && of > 0 ? of : 0,
  };
}

function statusOf(verdict, last) {
  if (verdict === 'looks good') return ['success', 'looks good'];
  if (verdict === 'changes requested' && last) return ['failure', 'changes requested, last review: over to a human'];
  if (verdict) return ['failure', verdict];
  return ['error', 'the review did not finish'];
}

async function run({ github, context, core, env = process.env }) {
  const { NUMBER, SHA, LAST, OUTPUT, REVIEW_ID, COMMENT_ID, CHECK, TARGET, RETRY_OF } = env;
  const base = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}`;
  const pr = `${base}/pull/${NUMBER}`;
  const target_url = REVIEW_ID ? `${pr}#pullrequestreview-${REVIEW_ID}`
    : COMMENT_ID ? `${pr}#issuecomment-${COMMENT_ID}` : `${base}/actions/runs/${context.runId}`;
  const output = outputOf(OUTPUT);
  const verdict = output.verdict || '';
  const [state, description] = statusOf(verdict, LAST === 'true');
  await github.rest.repos.createCommitStatus({ ...context.repo, sha: SHA, state, description, target_url, context: CHECK });
  core.setOutput('verdict', verdict);
  const stalled = verdict === 'changes requested' && LAST === 'true';
  const summary = typeof output.summary === 'string' ? output.summary.trim() : '';
  const repo = `${context.repo.owner}/${context.repo.repo}`;
  const handback = !verdict ? reviewErrorBody({ repo, number: NUMBER, sha: SHA, runId: context.runId, retryOf: RETRY_OF })
    : TARGET === 'family' ? verdictBody({
      repo, number: NUMBER, sha: SHA,
      verdict: stalled ? 'needs a human' : verdict,
      summary: stalled && !summary ? description : summary, reviewId: REVIEW_ID, runId: context.runId,
    }) : null;
  core.setOutput('handback', handback ? JSON.stringify(handback) : '');
  core.info(`${SHA}: ${state}, ${description}`);
}

module.exports = { run, statusOf, verdictBody, reviewErrorBody };
