// The review agent's verdict as the `Agent review` status on the head it reviewed: only
// `looks good` passes. Set as the reviewer (github-actions[bot]), since review-route
// reads only its statuses back.

function verdictOf(output) {
  try { return JSON.parse(output || '{}').verdict || ''; } catch { return ''; }
}

function statusOf(verdict, last) {
  if (verdict === 'looks good') return ['success', 'looks good'];
  if (verdict === 'changes requested' && last) return ['failure', 'changes requested, last review: over to a human'];
  if (verdict) return ['failure', verdict];
  return ['error', 'the review did not finish'];
}

async function run({ github, context, core, env = process.env }) {
  const { NUMBER, SHA, LAST, OUTPUT, REVIEW_ID, COMMENT_ID, CHECK } = env;
  const base = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}`;
  const pr = `${base}/pull/${NUMBER}`;
  const target_url = REVIEW_ID ? `${pr}#pullrequestreview-${REVIEW_ID}`
    : COMMENT_ID ? `${pr}#issuecomment-${COMMENT_ID}` : `${base}/actions/runs/${context.runId}`;
  const verdict = verdictOf(OUTPUT);
  const [state, description] = statusOf(verdict, LAST === 'true');
  await github.rest.repos.createCommitStatus({ ...context.repo, sha: SHA, state, description, target_url, context: CHECK });
  core.setOutput('verdict', verdict);
  core.info(`${SHA}: ${state}, ${description}`);
}

module.exports = { run, statusOf };
