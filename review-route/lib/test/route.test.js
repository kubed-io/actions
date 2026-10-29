const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../route');
const fake = require('../../../issue-agent/lib/test/fake');

const DRK = 4399427;
const BOT = 41898282;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const REVIEW = 'https://github.com/kubed-io/selenium-flow/pull/7#pullrequestreview-99';
const ENV = {
  CHECK: 'Agent review', REVIEWER: String(BOT), TRUSTED: `${DRK},${BOT},235398881`, OWNER: String(DRK),
  MAX_REVIEWS: '3', MAX_FIXES: '3', PREFIX: 'issue-', LABELS: 'plan approved', ARTIFACT: 'checks-report',
};

const mine = (state, description, target_url = REVIEW) => ({ context: 'Agent review', creator: { id: BOT }, state, description, target_url });
const diff = (patch) => ({ files: [{ status: 'modified', filename: 'AGENTS.md', patch }] });
const SUGGESTION = '  the browser (ruling 14 of the spec).';
const suggestionComment = {
  path: 'AGENTS.md',
  body: `Optional: name the spec.\n\n\`\`\`suggestion\n${SUGGESTION}\n\`\`\``,
};
const applied = (over = {}) => ({
  committer: { login: 'web-flow' },
  parents: [{}],
  commit: {
    message: `Update AGENTS.md\n\nCo-authored-by: github-actions[bot] <${BOT}+github-actions[bot]@users.noreply.github.com>`,
    verification: { verified: true },
  },
  files: [{ filename: 'AGENTS.md', status: 'modified', patch: `@@ -1,3 +1,3 @@\n-  the browser (ruling 14).\n+${SUGGESTION}` }],
  ...over,
});

// a PR whose head is the last of `commits`, after a checks run on it ended `conclusion`
function setup({ commits = [A, B], statuses = {}, conclusion = 'success', artifacts = 1, pr = {}, routes = {}, payload, eventName = 'workflow_run' } = {}) {
  const head = commits.at(-1);
  const github = fake.github({
    'pulls.get': {
      state: 'open', draft: false, labels: [{ name: 'plan approved' }],
      head: { sha: head, ref: 'issue-6', repo: { full_name: 'kubed-io/selenium-flow' } }, base: { ref: 'main' },
      ...pr,
    },
    'actions.listWorkflowRunArtifacts': { artifacts: Array(artifacts).fill({}) },
    'repos.listCommitStatusesForRef': (p) => statuses[p.ref] || [],
    'pulls.listCommits': commits.map((sha) => ({ sha })),
    'repos.compareCommitsWithBasehead': (p) => diff(`@@ -1 +1 @@\n+${p.basehead.endsWith(head) ? 'now' : 'then'}`),
    'repos.createCommitStatus': {},
    'repos.createDispatchEvent': {},
    'issues.listEventsForTimeline': [],
    ...routes,
  });
  const context = fake.context({
    eventName, serverUrl: 'https://github.com', runId: 5,
    payload: payload || {
      workflow_run: {
        id: 3, conclusion, head_sha: head, html_url: 'https://run/3',
        pull_requests: [{ number: 7 }], triggering_actor: { id: DRK },
      },
    },
  });
  const core = fake.core();
  const go = () => route.run({ github, context, core, env: ENV });
  const posted = () => github.calls.filter((c) => c.name === 'repos.createCommitStatus').map((c) => `${c.params.state}: ${c.params.description}`);
  const dispatched = () => github.calls.filter((c) => c.name === 'repos.createDispatchEvent').map((c) => c.params.client_payload);
  return { github, core, go, posted, dispatched };
}

test('green checks on a new head start a review', async () => {
  const t = setup();
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (1 of 3)']);
  assert.deepEqual(t.core.outputs, { number: '7', sha: B, last: 'false' });
});

test('a PR the agents did not build passes straight away', async () => {
  const t = setup({ pr: { labels: [] } });
  await t.go();
  assert.deepEqual(t.posted(), ['success: not built by the agents']);
  assert.equal(t.core.outputs.number, '');
});

test('a cancelled run, or one that ran no checks, does nothing', async () => {
  for (const t of [setup({ conclusion: 'cancelled' }), setup({ artifacts: 0 })]) {
    await t.go();
    assert.deepEqual(t.posted(), []);
    assert.equal(t.core.outputs.number, '');
  }
});

test('red checks send the code agent the run, not a review', async () => {
  const t = setup({ conclusion: 'failure' });
  await t.go();
  assert.deepEqual(t.posted(), ['failure: checks failed (fix 1 of 3)']);
  assert.deepEqual(t.dispatched(), [{ pull_request: 7, reason: 'ci', run_id: 3 }]);
  assert.equal(t.core.outputs.number, '');
});

test('an untrusted actor starts nothing', async () => {
  const t = setup({ payload: { workflow_run: { id: 3, conclusion: 'success', head_sha: B, pull_requests: [{ number: 7 }], triggering_actor: { id: 1 } } } });
  await t.go();
  assert.deepEqual(t.posted(), []);
});

test('merging the base in keeps the last verdict', async () => {
  const t = setup({
    statuses: { [A]: [mine('success', 'looks good')] },
    routes: { 'repos.compareCommitsWithBasehead': diff('@@ -9 +9 @@\n+same') },
  });
  await t.go();
  assert.deepEqual(t.posted(), ['success: no changes since aaaaaaa: looks good']);
  assert.equal(t.core.outputs.number, '');
});

test("applying a passing review's own suggestion keeps the pass", async () => {
  const t = setup({
    statuses: { [A]: [mine('success', 'looks good')] },
    routes: { 'pulls.listCommentsForReview': [suggestionComment], 'repos.getCommit': applied() },
  });
  await t.go();
  assert.deepEqual(t.posted(), ['success: suggestions applied since aaaaaaa: looks good']);
  assert.equal(t.core.outputs.number, '');
  const asked = t.github.calls.find((c) => c.name === 'pulls.listCommentsForReview');
  assert.equal(asked.params.review_id, 99);
});

test('a second suggestion after a carried pass carries it again, verdict and all', async () => {
  const t = setup({
    commits: [A, B, C],
    statuses: { [A]: [mine('success', 'looks good')], [B]: [mine('success', 'suggestions applied since aaaaaaa: looks good')] },
    routes: { 'pulls.listCommentsForReview': [suggestionComment], 'repos.getCommit': applied() },
  });
  await t.go();
  assert.deepEqual(t.posted(), ['success: suggestions applied since bbbbbbb: looks good']);
});

test('a suggestion commit that adds anything else is reviewed', async () => {
  const extra = applied();
  extra.files[0].patch += '\n+and a line nobody suggested';
  const t = setup({
    statuses: { [A]: [mine('success', 'looks good')] },
    routes: { 'pulls.listCommentsForReview': [suggestionComment], 'repos.getCommit': extra },
  });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (2 of 3)']);
});

test('only a commit GitHub made from the page counts, not a pushed one with the trailer', async () => {
  for (const over of [{ committer: { login: 'kferrone' } }, { parents: [{}, {}] }]) {
    const t = setup({
      statuses: { [A]: [mine('success', 'looks good')] },
      routes: { 'pulls.listCommentsForReview': [suggestionComment], 'repos.getCommit': applied(over) },
    });
    await t.go();
    assert.deepEqual(t.posted(), ['pending: reviewing (2 of 3)']);
  }
});

test('suggestions applied after changes requested still get a review', async () => {
  const t = setup({
    statuses: { [A]: [mine('failure', 'changes requested')] },
    routes: { 'pulls.listCommentsForReview': [suggestionComment], 'repos.getCommit': applied() },
  });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (2 of 3)']);
  assert.ok(!t.github.calls.some((c) => c.name === 'repos.getCommit'));
});

test('a suggestion block in a longer fence, with code fences inside, is read whole', async () => {
  const github = fake.github({
    'pulls.listCommentsForReview': [{ path: 'a.md', body: 'Use this:\n\n````suggestion\n```js\nx()\n```\n````' }],
  });
  const byPath = await route.suggested(github, { owner: 'o', repo: 'r' }, 7, 1);
  assert.deepEqual([...byPath.get('a.md')], ['```js', 'x()', '```']);
});

test('reviews stop at the cap, but the owner may always ask again', async () => {
  const statuses = { [A]: [mine('failure', 'changes requested')], [B]: [mine('failure', 'changes requested')], [C]: [mine('failure', 'changes requested')] };
  const D = 'd'.repeat(40);
  const capped = setup({ commits: [A, B, C, D], statuses });
  await capped.go();
  assert.deepEqual(capped.posted(), ['failure: needs a human: 3 reviews without a pass']);

  const asked = setup({
    commits: [A, B, C, D], statuses, eventName: 'repository_dispatch',
    payload: { action: 'agent-review', client_payload: { pull_request: 7 }, sender: { id: DRK } },
  });
  await asked.go();
  assert.deepEqual(asked.posted(), ['pending: reviewing (4 of 3)']);
  assert.equal(asked.core.outputs.last, 'false');
});

test('a push (pull_request_target) is routed without a checks run', async () => {
  const t = setup({
    eventName: 'pull_request_target',
    payload: { action: 'synchronize', pull_request: { number: 7 }, sender: { id: DRK } },
  });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (1 of 3)']);
  assert.ok(!t.github.calls.some((c) => c.name === 'actions.listWorkflowRunArtifacts'));
});

const askedCopilot = { 'issues.listEventsForTimeline': [{ event: 'review_requested', requested_reviewer: { login: 'Copilot', type: 'Bot' } }] };

test('a PR Copilot was asked to review is Copilot\'s: no review agent, the check passes', async () => {
  const t = setup({ routes: askedCopilot });
  await t.go();
  assert.deepEqual(t.posted(), ['success: Copilot reviews this PR']);
  assert.equal(t.core.outputs.number, '');
});

test('with Copilot asked, red checks still go to the code agent', async () => {
  const t = setup({ conclusion: 'failure', routes: askedCopilot });
  await t.go();
  assert.deepEqual(t.posted(), ['failure: checks failed (fix 1 of 3)']);
  assert.equal(t.dispatched().length, 1);
});

test("the owner's dispatch asks for the review agent even when Copilot was asked", async () => {
  const t = setup({
    routes: askedCopilot, eventName: 'repository_dispatch',
    payload: { action: 'agent-review', client_payload: { pull_request: 7 }, sender: { id: DRK } },
  });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (1 of 3)']);
});

test('a request for someone else, or none, leaves the review to the review agent', async () => {
  const t = setup({ routes: { 'issues.listEventsForTimeline': [{ event: 'review_requested', requested_reviewer: { login: 'kferrone' } }] } });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (1 of 3)']);
});

// the checks run's own last job points at itself: `agent-review`, `reason: checks`, sent
// as github-actions[bot] while that job is still running
const CHECKS = { id: 3, event: 'pull_request', status: 'in_progress', conclusion: null, head_sha: B, html_url: 'https://run/3', triggering_actor: { id: DRK } };
const job = (name, conclusion, status = 'completed') => ({ name, status, conclusion });
const GREEN = [job('PR Tasks', 'success'), job('Test / Unit Tests', 'success'), job('Bench', 'skipped'), job('Checks', null, 'in_progress')];
const RED = [job('PR Tasks', 'success'), job('Test / Unit Tests', 'failure'), job('Checks', null, 'in_progress')];
function pointed({ run = {}, jobs = GREEN, failed = 0, sha = B, ...over } = {}) {
  return setup({
    eventName: 'repository_dispatch',
    payload: { action: 'agent-review', client_payload: { pull_request: 7, reason: 'checks', run_id: 3, sha, failed }, sender: { id: BOT } },
    ...over,
    routes: { 'actions.getWorkflowRun': { ...CHECKS, ...run }, 'actions.listJobsForWorkflowRun': jobs, ...over.routes },
  });
}

test('the checks dispatch, green: the run read back starts a review', async () => {
  const t = pointed();
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (1 of 3)']);
  assert.deepEqual(t.core.outputs, { number: '7', sha: B, last: 'false' });
  for (const name of ['actions.getWorkflowRun', 'actions.listWorkflowRunArtifacts', 'actions.listJobsForWorkflowRun']) {
    assert.equal(t.github.calls.find((c) => c.name === name).params.run_id, 3, name);
  }
});

test('the checks dispatch, red: the code agent gets the checks run, not a review', async () => {
  const t = pointed({ jobs: RED, failed: 1 });
  await t.go();
  assert.deepEqual(t.posted(), ['failure: checks failed (fix 1 of 3)']);
  assert.equal(t.github.calls.find((c) => c.name === 'repos.createCommitStatus').params.target_url, 'https://run/3');
  assert.deepEqual(t.dispatched(), [{ pull_request: 7, reason: 'ci', run_id: 3 }]);
  assert.equal(t.core.outputs.number, '');
  assert.deepEqual(t.core.notices, []);
});

test('the checks dispatch trusts the jobs over the count it carries', async () => {
  const t = pointed({ jobs: RED, failed: 0 });
  await t.go();
  assert.deepEqual(t.posted(), ['failure: checks failed (fix 1 of 3)']);
  assert.equal(t.dispatched().length, 1);
  assert.equal(t.core.notices.length, 1);
});

test('the checks dispatch for a run on another commit, or an old head, does nothing', async () => {
  for (const t of [
    pointed({ sha: A }),
    pointed({ run: { head_sha: A }, sha: A }),
    pointed({ pr: { head: { sha: C, ref: 'issue-6', repo: { full_name: 'kubed-io/selenium-flow' } } } }),
  ]) {
    await t.go();
    assert.deepEqual(t.posted(), []);
    assert.deepEqual(t.dispatched(), []);
    assert.equal(t.core.outputs.number, '');
  }
});

test('the checks dispatch for a cancelled run, a push run, or one without the report does nothing', async () => {
  for (const t of [
    pointed({ run: { status: 'completed', conclusion: 'cancelled' } }),
    pointed({ run: { event: 'push' } }),
    pointed({ artifacts: 0 }),
  ]) {
    await t.go();
    assert.deepEqual(t.posted(), []);
    assert.equal(t.core.outputs.number, '');
  }
});

test('the checks dispatch answers to the run\'s triggering actor, not its sender', async () => {
  const t = pointed({ run: { triggering_actor: { id: 1 } } });
  await t.go();
  assert.deepEqual(t.posted(), []);
  assert.equal(t.core.outputs.number, '');
});

test('the checks dispatch for a PR the agents did not build sets no status', async () => {
  const t = pointed({ pr: { labels: [] } });
  await t.go();
  assert.deepEqual(t.posted(), []);
  assert.equal(t.core.outputs.number, '');
});

test('the checks dispatch judges a head once, as a finished run does; asking again reviews it', async () => {
  const statuses = { [B]: [mine('failure', 'changes requested')] };
  const t = pointed({ statuses });
  await t.go();
  assert.deepEqual(t.posted(), []);

  const again = setup({
    statuses, eventName: 'repository_dispatch',
    payload: { action: 'agent-review', client_payload: { pull_request: 7 }, sender: { id: DRK } },
  });
  await again.go();
  assert.deepEqual(again.posted(), ['pending: reviewing (1 of 3)']);
  assert.ok(!again.github.calls.some((c) => c.name.startsWith('actions.')));
});

test('the checks dispatch, green after red on the same head (a re-run), brings the review', async () => {
  const t = pointed({ statuses: { [B]: [mine('failure', 'checks failed (fix 1 of 3)', 'https://run/2')] } });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (1 of 3)']);
});

test('the checks dispatch leaves a PR Copilot was asked to review to Copilot', async () => {
  const t = pointed({ routes: askedCopilot });
  await t.go();
  assert.deepEqual(t.posted(), ['success: Copilot reviews this PR']);
});
