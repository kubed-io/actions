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
  MAX_REVIEWS: '5', MAX_FIXES: '5', PREFIX: 'issue-', LABELS: 'plan approved', ARTIFACT: 'checks-report', APP: '235398881',
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

// the checks run's own last job points at itself: `agent-review`, `reason: checks`, sent
// as github-actions[bot] while that job is still running
const CHECKS = { id: 3, event: 'pull_request', status: 'in_progress', conclusion: null, head_sha: B, html_url: 'https://run/3', triggering_actor: { id: DRK } };
const job = (name, conclusion, status = 'completed') => ({ name, status, conclusion });
const GREEN = [job('PR Tasks', 'success'), job('Test / Unit Tests', 'success'), job('Bench', 'skipped'), job('Checks', null, 'in_progress')];
const RED = [job('PR Tasks', 'success'), job('Test / Unit Tests', 'failure'), job('Checks', null, 'in_progress')];
// a PR whose head is the last of `commits`, its checks run's last job pointing at itself as
// the run ends `conclusion`: green jobs, red ones, or the run cancelled
// a commit is its sha, or { sha, message, date, merge } for a round's start (R-SM39) or a merge
function setup({ commits: list = [A, B], statuses = {}, conclusion = 'success', run = {}, artifacts = 1, pr = {}, routes = {}, payload, eventName = 'repository_dispatch' } = {}) {
  const commits = list.map((c) => (typeof c === 'string' ? { sha: c } : c));
  const head = commits.at(-1).sha;
  const checksRun = { ...CHECKS, head_sha: head, ...(conclusion === 'cancelled' ? { status: 'completed', conclusion } : {}), ...run };
  const github = fake.github({
    'pulls.get': {
      state: 'open', draft: false, labels: [{ name: 'plan approved' }],
      head: { sha: head, ref: 'issue-6', repo: { full_name: 'kubed-io/selenium-flow' } }, base: { ref: 'main' },
      ...pr,
    },
    'actions.listWorkflowRunArtifacts': { artifacts: Array(artifacts).fill({}) },
    'repos.listCommitStatusesForRef': (p) => statuses[p.ref] || [],
    'pulls.listCommits': commits.map(({ sha, message = 'a change', date, merge }) => ({ sha, parents: merge ? [{}, {}] : [{}], commit: { message, committer: { date } } })),
    'repos.compareCommitsWithBasehead': (p) => diff(`@@ -1 +1 @@\n+${p.basehead.endsWith(head) ? 'now' : 'then'}`),
    'repos.createCommitStatus': {},
    'repos.createDispatchEvent': {},
    'issues.listEventsForTimeline': [],
    'actions.getWorkflowRun': checksRun,
    'actions.listJobsForWorkflowRun': conclusion === 'failure' ? RED : GREEN,
    ...routes,
  });
  const context = fake.context({
    eventName, serverUrl: 'https://github.com', runId: 5,
    payload: payload || {
      action: 'agent-review',
      client_payload: { pull_request: 7, reason: 'checks', run_id: 3, sha: head, failed: conclusion === 'failure' ? 1 : 0 },
      sender: { id: BOT },
    },
  });
  const core = fake.core();
  const go = () => route.run({ github, context, core, env: ENV });
  const posted = () => github.calls.filter((c) => c.name === 'repos.createCommitStatus').map((c) => `${c.params.state}: ${c.params.description}`);
  const dispatched = () => github.calls.filter((c) => c.name === 'repos.createDispatchEvent').map((c) => c.params.client_payload);
  return { github, core, go, posted, dispatched };
}

// `n` commits the review agent judged, each with `status`, then the head
const CHANGES = () => mine('failure', 'changes requested');
const RED_STATUS = () => mine('failure', 'checks failed (fix 1 of 5)', 'https://run/1');
function reviewed(n, status = CHANGES, from = 0) {
  const commits = Array.from({ length: n + 1 }, (_, i) => (from + i + 1).toString(16).padStart(40, '0'));
  return { commits, statuses: Object.fromEntries(commits.slice(0, n).map((c) => [c, [status()]])) };
}

test('green checks on a new head start a review', async () => {
  const t = setup();
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (1 of 5)']);
  assert.deepEqual(t.core.outputs, { number: '7', sha: B, last: 'false', target: 'default', handback: '' });
});

test('target is family for base issue-12', async () => {
  const t = setup({ pr: { base: { ref: 'issue-12' } } });
  await t.go();
  assert.deepEqual([t.core.outputs.number, t.core.outputs.target], ['7', 'family']);
});

test('target is default for base main', async () => {
  // a family's own PR (head issue-12, base main) is reviewed as any other
  const t = setup({ pr: { head: { sha: B, ref: 'issue-12', repo: { full_name: 'kubed-io/selenium-flow' } }, base: { ref: 'main' } } });
  await t.go();
  assert.deepEqual([t.core.outputs.number, t.core.outputs.target], ['7', 'default']);
  // only the prefix and a number is a family's branch
  for (const ref of ['issue-foo', 'issue-', 'issue-12a']) {
    const other = setup({ pr: { base: { ref } } });
    await other.go();
    assert.deepEqual([other.core.outputs.number, other.core.outputs.target], ['7', 'default'], ref);
  }
});

test('asked about a PR the agents did not build, it passes straight away', async () => {
  const t = setup({
    pr: { labels: [] }, payload: { action: 'agent-review', client_payload: { pull_request: 7 }, sender: { id: DRK } },
  });
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
  assert.deepEqual(t.posted(), ['failure: checks failed (fix 1 of 5)']);
  assert.deepEqual(t.dispatched(), [{ pull_request: 7, reason: 'ci', run_id: 3 }]);
  assert.equal(t.core.outputs.number, '');
});

test('an untrusted actor starts nothing', async () => {
  const t = setup({ run: { triggering_actor: { id: 1 } } });
  await t.go();
  assert.deepEqual(t.posted(), []);
});

test('merging the base in keeps the last verdict', async () => {
  const t = setup({
    commits: [A, { sha: B, merge: true }],
    statuses: { [A]: [mine('success', 'looks good')] },
    routes: { 'repos.compareCommitsWithBasehead': diff('@@ -9 +9 @@\n+same') },
  });
  await t.go();
  assert.deepEqual(t.posted(), ['success: no changes since aaaaaaa: looks good']);
  assert.equal(t.core.outputs.number, '');
});

test("a branch update that only moves the docs pointer keeps the last verdict", async () => {
  const code = { status: 'modified', filename: 'AGENTS.md', patch: '@@ -9 +9 @@\n+same' };
  const docs = (sha) => ({ status: 'modified', filename: 'docs', patch: `@@ -1 +1 @@\n-Subproject commit ${'1'.repeat(40)}\n+Subproject commit ${sha.repeat(40)}` });
  const t = setup({
    commits: [A, { sha: B, merge: true }],
    statuses: { [A]: [mine('success', 'looks good')] },
    routes: { 'repos.compareCommitsWithBasehead': (p) => ({ files: [code, docs(p.basehead.endsWith(A) ? 'a' : 'b')] }) },
  });
  await t.go();
  assert.deepEqual(t.posted(), ['success: no changes since aaaaaaa: looks good']);
});

test("a commit of the PR's own that moves only the docs pointer is reviewed", async () => {
  // a spec fix lives in the wiki: the PR's diff changes only by the pointer (selenium-flow #211)
  const code = { status: 'modified', filename: 'AGENTS.md', patch: '@@ -9 +9 @@\n+same' };
  const docs = (sha) => ({ status: 'modified', filename: 'docs', patch: `@@ -1 +1 @@\n-Subproject commit ${'1'.repeat(40)}\n+Subproject commit ${sha.repeat(40)}` });
  const t = setup({
    statuses: { [A]: [CHANGES()] },
    routes: { 'repos.compareCommitsWithBasehead': (p) => ({ files: [code, docs(p.basehead.endsWith(A) ? 'a' : 'b')] }) },
  });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (2 of 5)']);
});

test('a merge after a commit of the PR\'s own still gets a review', async () => {
  const t = setup({
    commits: [A, 'c'.repeat(40), { sha: B, merge: true }],
    statuses: { [A]: [CHANGES()] },
    routes: { 'repos.compareCommitsWithBasehead': diff('@@ -9 +9 @@\n+same') },
  });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (2 of 5)']);
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

test('a carried pass on a family PR asks to POST its verdict', async () => {
  const COMMENT = 'https://github.com/kubed-io/selenium-flow/pull/7#issuecomment-44';
  const said = '**Verdict: looks good**\n\n<!-- review-summary -->\nThe tab is kept.\nNext: the window.\n<!-- /review-summary -->\n\nAll good.';
  const same = { 'repos.compareCommitsWithBasehead': diff('@@ -9 +9 @@\n+same'), 'issues.getComment': { body: said } };
  const t = setup({ commits: [A, { sha: B, merge: true }], pr: { base: { ref: 'issue-12' } }, statuses: { [A]: [mine('success', 'looks good', COMMENT)] }, routes: same });
  await t.go();
  assert.deepEqual(t.posted(), ['success: no changes since aaaaaaa: looks good']);
  assert.equal(t.core.outputs.number, '');
  assert.deepEqual(JSON.parse(t.core.outputs.handback), {
    type: 'verdict', repo: 'kubed-io/selenium-flow', number: 7, sha: B, verdict: 'looks good',
    summary: 'The tab is kept.\nNext: the window.', review_id: 0, run_id: 5,
  });
  assert.equal(t.github.calls.find((c) => c.name === 'issues.getComment').params.comment_id, 44);

  // the suggestions path too, its summary read from the review; unrecoverable, it is empty
  for (const [review, summary] of [[{ body: said }, 'The tab is kept.\nNext: the window.'], [fake.notFound(), '']]) {
    const s = setup({
      pr: { base: { ref: 'issue-12' } }, statuses: { [A]: [mine('success', 'looks good')] },
      routes: { 'pulls.listCommentsForReview': [suggestionComment], 'repos.getCommit': applied(), 'pulls.getReview': review },
    });
    await s.go();
    assert.deepEqual(s.posted(), ['success: suggestions applied since aaaaaaa: looks good']);
    const body = JSON.parse(s.core.outputs.handback);
    assert.deepEqual([body.sha, body.summary, body.review_id], [B, summary, 99]);
  }

  // a carried failure, and any carried verdict on a default PR, ask nothing
  for (const over of [
    { pr: { base: { ref: 'issue-12' } }, statuses: { [A]: [mine('failure', 'changes requested', COMMENT)] } },
    { statuses: { [A]: [mine('success', 'looks good', COMMENT)] } },
  ]) {
    const n = setup({ ...over, routes: same });
    await n.go();
    assert.equal(n.posted().length, 1);
    assert.equal(n.core.outputs.handback, '');
  }
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
  assert.deepEqual(t.posted(), ['pending: reviewing (1 of 5)']);
});

test('only a commit GitHub made from the page counts, not a pushed one with the trailer', async () => {
  for (const over of [{ committer: { login: 'kferrone' } }, { parents: [{}, {}] }]) {
    const t = setup({
      statuses: { [A]: [mine('success', 'looks good')] },
      routes: { 'pulls.listCommentsForReview': [suggestionComment], 'repos.getCommit': applied(over) },
    });
    await t.go();
    assert.deepEqual(t.posted(), ['pending: reviewing (1 of 5)']);
  }
});

test('suggestions applied after changes requested still get a review', async () => {
  const t = setup({
    statuses: { [A]: [mine('failure', 'changes requested')] },
    routes: { 'pulls.listCommentsForReview': [suggestionComment], 'repos.getCommit': applied() },
  });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (2 of 5)']);
  assert.ok(!t.github.calls.some((c) => c.name === 'repos.getCommit'));
});

test('a suggestion block in a longer fence, with code fences inside, is read whole', async () => {
  const github = fake.github({
    'pulls.listCommentsForReview': [{ path: 'a.md', body: 'Use this:\n\n````suggestion\n```js\nx()\n```\n````' }],
  });
  const byPath = await route.suggested(github, { owner: 'o', repo: 'r' }, 7, 1);
  assert.deepEqual([...byPath.get('a.md')], ['```js', 'x()', '```']);
});

test('a pass ends the run the cap counts: five reviews, the last a pass, are not a stall', async () => {
  const { commits, statuses } = reviewed(5);
  statuses[commits[4]] = [mine('success', 'looks good')];
  const t = setup({ commits, statuses, routes: { 'pulls.listCommentsForReview': [] } });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (1 of 5)']);
});

test('the cap counts the reviews after the latest pass', async () => {
  const { commits, statuses } = reviewed(7);
  statuses[commits[1]] = [mine('success', 'looks good')];
  const t = setup({ commits, statuses });
  await t.go();
  assert.deepEqual(t.posted(), ['failure: needs a human: 5 reviews without a pass']);
});

test('reviews stop at the cap, but the owner may always ask again', async () => {
  const { commits, statuses } = reviewed(5);
  const capped = setup({ commits, statuses });
  await capped.go();
  assert.deepEqual(capped.posted(), ['failure: needs a human: 5 reviews without a pass']);

  const asked = setup({
    commits, statuses, eventName: 'repository_dispatch',
    payload: { action: 'agent-review', client_payload: { pull_request: 7 }, sender: { id: DRK } },
  });
  await asked.go();
  assert.deepEqual(asked.posted(), ['pending: reviewing (6 of 5)']);
  assert.equal(asked.core.outputs.last, 'false');
});

test('only an agent-review dispatch is routed: a native event is nothing', async () => {
  for (const [eventName, payload] of [
    ['workflow_run', { workflow_run: { id: 3, conclusion: 'success', head_sha: B, pull_requests: [{ number: 7 }], triggering_actor: { id: DRK } } }],
    ['pull_request_target', { action: 'synchronize', pull_request: { number: 7 }, sender: { id: DRK } }],
    ['repository_dispatch', { action: 'agent-code', client_payload: { pull_request: 7 }, sender: { id: DRK } }],
  ]) {
    const t = setup({ eventName, payload });
    await t.go();
    assert.deepEqual(t.posted(), []);
    assert.deepEqual(t.github.calls, []);
  }
});

test('the owner asking Copilot for a review holds nothing back: the review agent reviews', async () => {
  const asked = { 'issues.listEventsForTimeline': [{ event: 'review_requested', actor: { id: DRK }, requested_reviewer: { login: 'Copilot' } }] };
  const t = setup({ routes: asked });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (1 of 5)']);
  assert.equal(t.core.outputs.number, '7');
});

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
  assert.deepEqual(t.posted(), ['pending: reviewing (1 of 5)']);
  assert.deepEqual(t.core.outputs, { number: '7', sha: B, last: 'false', target: 'default', handback: '' });
  for (const name of ['actions.getWorkflowRun', 'actions.listWorkflowRunArtifacts', 'actions.listJobsForWorkflowRun']) {
    assert.equal(t.github.calls.find((c) => c.name === name).params.run_id, 3, name);
  }
});

test('the checks dispatch, red: the code agent gets the checks run, not a review', async () => {
  const t = pointed({ jobs: RED, failed: 1 });
  await t.go();
  assert.deepEqual(t.posted(), ['failure: checks failed (fix 1 of 5)']);
  assert.equal(t.github.calls.find((c) => c.name === 'repos.createCommitStatus').params.target_url, 'https://run/3');
  assert.deepEqual(t.dispatched(), [{ pull_request: 7, reason: 'ci', run_id: 3 }]);
  assert.equal(t.core.outputs.number, '');
  assert.deepEqual(t.core.notices, []);
});

test('the checks dispatch trusts the jobs over the count it carries', async () => {
  const t = pointed({ jobs: RED, failed: 0 });
  await t.go();
  assert.deepEqual(t.posted(), ['failure: checks failed (fix 1 of 5)']);
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
  assert.deepEqual(again.posted(), ['pending: reviewing (1 of 5)']);
  assert.ok(!again.github.calls.some((c) => c.name.startsWith('actions.')));
});

test('the checks dispatch, green after red on the same head (a re-run), brings the review', async () => {
  const t = pointed({ statuses: { [B]: [mine('failure', 'checks failed (fix 1 of 5)', 'https://run/2')] } });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (1 of 5)']);
});

// a sub-issue's PR stalled at a cap hands back to the parent (spec 2026-11-24 R-SM28)
const FAMILY_PR = { base: { ref: 'issue-12' } };

test("a family PR at the review cap hands n8n a needs-a-human verdict; a default PR's hands nothing", async () => {
  const { commits, statuses } = reviewed(5);
  const capped = setup({ commits, statuses, pr: FAMILY_PR });
  await capped.go();
  assert.deepEqual(capped.posted(), ['failure: needs a human: 5 reviews without a pass']);
  assert.deepEqual(JSON.parse(capped.core.outputs.handback), {
    type: 'verdict', repo: 'kubed-io/selenium-flow', number: 7, sha: commits.at(-1), verdict: 'needs a human',
    summary: 'needs a human: 5 reviews without a pass', review_id: 0, run_id: 5,
  });
  const other = setup({ commits, statuses });
  await other.go();
  assert.equal(other.core.outputs.handback, '');
});

test("a family PR at the fix cap hands n8n a needs-a-human verdict; under it, nothing", async () => {
  const { commits, statuses } = reviewed(5, RED_STATUS);
  const capped = setup({ commits, statuses, conclusion: 'failure', pr: FAMILY_PR });
  await capped.go();
  assert.deepEqual(capped.posted(), ['failure: needs a human: checks failed on 6 commits']);
  const body = JSON.parse(capped.core.outputs.handback);
  assert.deepEqual([body.type, body.sha, body.verdict, body.summary, body.review_id], ['verdict', commits.at(-1), 'needs a human', 'needs a human: checks failed on 6 commits', 0]);
  const under = setup({ conclusion: 'failure', pr: FAMILY_PR });
  await under.go();
  assert.equal(under.core.outputs.handback, '');
  const other = setup({ commits, statuses, conclusion: 'failure' });
  await other.go();
  assert.equal(other.core.outputs.handback, '');
});

test("n8n's retry of an errored review reviews the same head again; the error is no review (R-SM35)", async () => {
  const errored = { context: 'Agent review', creator: { id: BOT }, state: 'error', description: 'the review did not finish', target_url: 'https://run/41' };
  const statuses = { [A]: [mine('failure', 'changes requested')], [B]: [errored] };
  const t = setup({
    statuses, pr: { base: { ref: 'issue-12' } },
    payload: { action: 'agent-review', client_payload: { pull_request: 7, reason: 'review-error', run_id: 41, sha: B }, sender: { id: 235398881 } },
  });
  await t.go();
  // the errored head is not counted: one review so far, this is the second
  assert.deepEqual(t.posted(), ['pending: reviewing (2 of 5)']);
  assert.deepEqual(t.core.outputs, { number: '7', sha: B, last: 'false', target: 'family', handback: '' });
  // the checks pointer for that head does not review it again on its own
  const pointer = setup({ statuses });
  await pointer.go();
  assert.deepEqual([pointer.posted(), pointer.core.outputs.number], [[], '']);
});

// the caps count one round: since the latest sub-issue merge or parent message (R-SM39)
const APP = 235398881;
const minute = (m) => new Date(Date.UTC(2026, 10, 25, 9, m)).toISOString();
const MERGED = 'Merge pull request #31 from kubed-io/issue-30\n\nissue-30: the window';
const UPDATED = "Merge branch 'issue-12' into issue-30";
const message = (m, user = APP) => ({ user: { id: user }, created_at: minute(m), body: '<!-- parent-message {"parent":12} -->\nKeep the tab.' });
// commits two minutes apart, oldest first: `before` judged ones, the round's start (a merge
// commit, or a parent message posted after the last of them), `after` judged ones, the head
function round({ before, after, start = 'merge', status = CHANGES, merge = MERGED, by = APP }) {
  const commits = [];
  const statuses = {};
  const comments = [];
  const add = (judged, msg) => {
    const sha = (commits.length + 1).toString(16).padStart(40, '0');
    commits.push({ sha, date: minute(commits.length * 2), ...(msg ? { message: msg } : {}) });
    if (judged) statuses[sha] = [status()];
  };
  for (let i = 0; i < before; i++) add(true);
  if (start === 'merge') add(false, merge);
  else comments.push(message(commits.length * 2 - 1, by));
  for (let i = 0; i < after; i++) add(true);
  add(false);
  return { commits, statuses, routes: { 'issues.listComments': comments } };
}

test('a sub-issue merge starts a round: the reviews before it do not count', async () => {
  const t = setup({ ...round({ before: 3, after: 1 }), pr: FAMILY_PR });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (2 of 5)']);
  assert.deepEqual([t.core.outputs.number, t.core.outputs.last, t.core.outputs.target], ['7', 'false', 'family']);
  // the PR's comments are read once
  assert.equal(t.github.calls.filter((c) => c.name === 'issues.listComments').length, 1);

  // a branch update's merge commit is no round's start
  const updated = setup({ ...round({ before: 3, after: 1, merge: UPDATED }), pr: FAMILY_PR });
  await updated.go();
  assert.deepEqual(updated.posted(), ['pending: reviewing (5 of 5)']);
  assert.equal(updated.core.outputs.last, 'true');
});

test("a parent message starts a round: only commits after it count; someone else's copy is none", async () => {
  const t = setup({ ...round({ before: 3, after: 1, start: 'message' }), pr: FAMILY_PR });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (2 of 5)']);

  const other = setup({ ...round({ before: 3, after: 1, start: 'message', by: DRK }), pr: FAMILY_PR });
  await other.go();
  assert.deepEqual(other.posted(), ['pending: reviewing (5 of 5)']);
});

test('with a merge and a parent message, the newer one starts the round', async () => {
  // merge, a review, the message, a review: one counts
  const merged = round({ before: 2, after: 1 });
  merged.routes['issues.listComments'] = [message(7)];
  merged.statuses[merged.commits.at(-1).sha] = [CHANGES()];
  merged.commits.push({ sha: 'e'.repeat(40), date: minute(10) });
  const t = setup({ ...merged, pr: FAMILY_PR });
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (2 of 5)']);

  // the message, a review, merge, a review: one counts
  const said = round({ before: 2, after: 1, start: 'message' });
  said.commits.splice(-1, 0, { sha: 'd'.repeat(40), date: minute(5), message: MERGED });
  said.commits.push({ sha: 'e'.repeat(40), date: minute(10) });
  said.statuses[said.commits.at(-2).sha] = [CHANGES()];
  const s = setup({ ...said, pr: FAMILY_PR });
  await s.go();
  assert.deepEqual(s.posted(), ['pending: reviewing (2 of 5)']);
});

test('five reviews in one round reach the cap, and the parent hears of it', async () => {
  const t = setup({ ...round({ before: 2, after: 5 }), pr: FAMILY_PR });
  await t.go();
  assert.deepEqual(t.posted(), ['failure: needs a human: 5 reviews without a pass']);
  assert.equal(JSON.parse(t.core.outputs.handback).verdict, 'needs a human');
  assert.equal(t.core.outputs.number, '');
});

test('fixes count one round too', async () => {
  const t = setup({ ...round({ before: 3, after: 1, start: 'message', status: RED_STATUS }), conclusion: 'failure', pr: FAMILY_PR });
  await t.go();
  assert.deepEqual(t.posted(), ['failure: checks failed (fix 2 of 5)']);
  assert.deepEqual(t.dispatched(), [{ pull_request: 7, reason: 'ci', run_id: 3 }]);

  const capped = setup({ ...round({ before: 2, after: 5, status: RED_STATUS }), conclusion: 'failure', pr: FAMILY_PR });
  await capped.go();
  assert.deepEqual(capped.posted(), ['failure: needs a human: checks failed on 6 commits']);
  assert.deepEqual(capped.dispatched(), []);
});

test('a PR without a merge or a message counts all its reviews, up to five', async () => {
  const t = setup(reviewed(4));
  await t.go();
  assert.deepEqual(t.posted(), ['pending: reviewing (5 of 5)']);
  assert.equal(t.core.outputs.last, 'true');
});

test('a verdict from before the round is still carried', async () => {
  const r = round({ before: 1, after: 0, start: 'message', status: () => mine('success', 'looks good') });
  r.commits.at(-1).merge = true;
  const t = setup({ ...r, routes: { ...r.routes, 'repos.compareCommitsWithBasehead': diff('@@ -9 +9 @@\n+same') } });
  await t.go();
  assert.deepEqual(t.posted(), ['success: no changes since 0000000: looks good']);
});
