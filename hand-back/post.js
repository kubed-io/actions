// The job's last step: tells the repository which pull request and head this run was for.

const api = process.env.GITHUB_API_URL || 'https://api.github.com';
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.INPUT_TOKEN;
const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, { method, headers, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

(async () => {
  const run = await call('GET', `/repos/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`);
  const pull = run.pull_requests?.[0]?.number || 0;
  const payload = { pull_request: pull, sha: run.head_sha, run_id: run.id, event: run.event };
  await call('POST', `/repos/${repo}/dispatches`, { event_type: process.env.INPUT_EVENT_TYPE || 'copilot-review', client_payload: payload });
  console.log(`sent ${process.env.INPUT_EVENT_TYPE || 'copilot-review'}: ${JSON.stringify(payload)}`);
})().catch((e) => {
  // a hand-back that fails must not fail Copilot's run
  console.log(`::warning::the hand-back failed: ${e.message}`);
});
