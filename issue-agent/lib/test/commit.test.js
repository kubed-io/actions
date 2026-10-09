const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const commit = require('../commit');
const state = require('../state');
const fake = require('./fake');

const SPEC = { slug: 'recordings', path: 'docs/superpowers/specs/2026-10-08-recordings-design.md', round: 2, run: '5', artifact: '7',
  artifact_url: 'https://github.com/kubed-io/selenium-flow/actions/runs/5/artifacts/7',
  summary_url: 'https://github.com/kubed-io/selenium-flow/actions/runs/5#summary-9', approved: false };
const BOT = { __typename: 'Bot', login: 'app', databaseId: 9 };

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-'));
  fs.writeFileSync(path.join(dir, '2026-10-08-recordings-design.md'), '# Recordings\n');
  Object.assign(process.env, { NUMBER: '12', DOCUMENT: 'spec', BRANCH: 'issue-{number}-{slug}', MESSAGE: '{document}: {title} (#{number})', PULL_REQUEST: 'draft', DOWNLOAD_DIR: dir, GITHUB_SERVER_URL: 'https://github.com', MODE: 'commit', TRUSTED_IDS: '1', ...over });
}

function routes(body, heads) {
  return {
    'issues.get': () => ({ number: 12, title: 'Recordings', node_id: 'I_12', body: body.value }),
    'graphql:issueOrPullRequest': { repository: { issueOrPullRequest: { author: { __typename: 'User', login: 'stranger', databaseId: 2 }, editor: BOT } } },
    'repos.get': { default_branch: 'main', node_id: 'R_1' },
    'git.getRef': ({ ref }) => (heads[ref] ? { object: { sha: heads[ref] } } : fake.notFound()),
    'graphql:createLinkedBranch': (v) => { heads[`heads/${v.name}`] = v.oid; return {}; },
    'graphql:createCommitOnBranch': { createCommitOnBranch: { commit: { oid: 'c0ffee', url: 'https://github.com/c' } } },
    'pulls.create': { number: 40 },
    'issues.update': (p) => { body.value = p.body; return {}; },
    'issues.createComment': {},
  };
}

test('approving a spec: linked branch, signed commit, draft PR naming the spec, state approved', async () => {
  setup();
  const body = { value: state.writeSection('Record it.', 'spec', SPEC, []) };
  const github = fake.github(routes(body, { 'heads/main': 'base' }));
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core });
  const linked = github.calls.find((c) => c.params?.name === 'issue-12-recordings');
  assert.deepEqual(linked.params, { issue: 'I_12', repo: 'R_1', oid: 'base', name: 'issue-12-recordings' });
  const input = github.calls.find((c) => c.params?.input).params.input;
  assert.equal(input.message.headline, 'spec: Recordings (#12)');
  assert.equal(input.expectedHeadOid, 'base');
  assert.equal(Buffer.from(input.fileChanges.additions[0].contents, 'base64').toString(), '# Recordings\n');
  const pr = github.calls.find((c) => c.name === 'pulls.create').params;
  assert.equal(pr.body, 'Spec: [docs/superpowers/specs/2026-10-08-recordings-design.md](https://github.com/kubed-io/selenium-flow/blob/issue-12-recordings/docs/superpowers/specs/2026-10-08-recordings-design.md)\n\nCloses #12\n');
  assert.equal(pr.draft, true);
  assert.equal(state.readState(body.value, 'spec').approved, true);
  assert.equal(core.outputs.pull_request, '40');
});

test('an existing branch is never overwritten', async () => {
  setup();
  const body = { value: state.writeSection('', 'spec', SPEC, []) };
  const github = fake.github(routes(body, { 'heads/main': 'base', 'heads/issue-12-recordings': 'old' }));
  await assert.rejects(commit.run({ github, context: fake.context(), core: fake.core() }), /already exists/);
});

test('approving a plan commits to the PR head, opens nothing', async () => {
  setup({ NUMBER: '40', DOCUMENT: 'plan', PULL_REQUEST: 'none' });
  fs.writeFileSync(path.join(process.env.DOWNLOAD_DIR, 'plan.md'), '# Plan\n');
  const body = { value: state.writeSection('Spec: x', 'plan', { ...SPEC, path: 'docs/superpowers/plans/plan.md' }, []) };
  const r = routes(body, { 'heads/issue-12-recordings': 'head' });
  r['issues.get'] = () => ({ number: 40, title: 'Recordings', body: body.value, pull_request: {} });
  r['pulls.get'] = { head: { ref: 'issue-12-recordings', repo: { full_name: 'kubed-io/selenium-flow' } } };
  const github = fake.github(r);
  await commit.run({ github, context: fake.context(), core: fake.core() });
  assert.ok(!github.calls.some((c) => c.name === 'pulls.create'));
  assert.equal(github.calls.find((c) => c.params?.input).params.input.branch.branchName, 'issue-12-recordings');
});

test('a state path outside docs/ is refused before any write', async () => {
  setup();
  const body = { value: state.writeSection('', 'spec', { ...SPEC, path: '.github/workflows/x.yml' }, []) };
  const github = fake.github(routes(body, { 'heads/main': 'base' }));
  await assert.rejects(commit.run({ github, context: fake.context(), core: fake.core() }), /not written by the agent/);
  assert.ok(!github.calls.some((c) => c.name === 'graphql:createLinkedBranch'));
});

test('a commit that fails once is retried on the new head, with a warning', async () => {
  setup();
  const body = { value: state.writeSection('Record it.', 'spec', SPEC, []) };
  const heads = { 'heads/main': 'base' };
  const r = routes(body, heads);
  let failed = false;
  r['graphql:createCommitOnBranch'] = () => {
    if (!failed) { failed = true; return new Error('ref moved'); }
    return { createCommitOnBranch: { commit: { oid: 'c0ffee', url: 'https://github.com/c' } } };
  };
  const github = fake.github(r);
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core });
  assert.equal(core.outputs.commit_url, 'https://github.com/c');
  assert.ok(core.notices.some((m) => /retrying on the new head/.test(m)));
  // one read to check the branch is new, then one per commit attempt
  const reads = github.calls.filter((c) => c.name === 'git.getRef' && c.params.ref === 'heads/issue-12-recordings');
  assert.equal(reads.length, 3);
  assert.equal(github.calls.filter((c) => c.name === 'graphql:createCommitOnBranch').length, 2);
});

test('a state the issue author edited last is refused before any write', async () => {
  setup();
  const body = { value: state.writeSection('', 'spec', SPEC, []) };
  const r = routes(body, { 'heads/main': 'base' });
  r['graphql:issueOrPullRequest'] = { repository: { issueOrPullRequest: { author: { __typename: 'User', login: 'stranger', databaseId: 2 }, editor: { __typename: 'User', login: 'stranger', databaseId: 2 } } } };
  const github = fake.github(r);
  await assert.rejects(commit.run({ github, context: fake.context(), core: fake.core() }), /round on #12 was not written by the agent; ask for a fresh round/);
  assert.ok(!github.calls.some((c) => /createLinkedBranch|createCommitOnBranch/.test(c.name)));
});

test('read mode refuses an untrusted state too', async () => {
  setup({ MODE: 'read' });
  const body = { value: state.writeSection('', 'spec', SPEC, []) };
  const r = routes(body, {});
  r['graphql:issueOrPullRequest'] = { repository: { issueOrPullRequest: { author: { __typename: 'User', login: 'stranger', databaseId: 2 }, editor: null } } };
  await assert.rejects(commit.run({ github: fake.github(r), context: fake.context(), core: fake.core() }), /not written by the agent/);
});

test('a state edited by a trusted id is committed', async () => {
  setup({ MODE: 'read' });
  const body = { value: state.writeSection('', 'spec', SPEC, []) };
  const r = routes(body, {});
  r['graphql:issueOrPullRequest'] = { repository: { issueOrPullRequest: { author: { __typename: 'User', login: 'kelly', databaseId: 1 }, editor: null } } };
  const core = fake.core();
  await commit.run({ github: fake.github(r), context: fake.context(), core });
  assert.equal(core.outputs.artifact, '7');
});

test('failure mode comments on the thread that the approval did not commit', async () => {
  setup({ MODE: 'failure', RUN_URL: 'https://github.com/kubed-io/selenium-flow/actions/runs/9' });
  const github = fake.github({ 'issues.createComment': {} });
  await commit.run({ github, context: fake.context(), core: fake.core() });
  const call = github.calls.find((c) => c.name === 'issues.createComment');
  assert.equal(call.params.issue_number, 12);
  assert.equal(call.params.body, `${state.TAG}\n⚠️ I couldn't commit the approved spec. [See the run](https://github.com/kubed-io/selenium-flow/actions/runs/9) for why; a fresh round and a new approval label will retry.`);
});

test('an issue with no round says so', async () => {
  setup();
  const body = { value: 'Record it.' };
  await assert.rejects(commit.run({ github: fake.github(routes(body, { 'heads/main': 'base' })), context: fake.context(), core: fake.core() }), /#12 has no spec round to commit/);
});

test('the draft PR gets the hand-off labels', async () => {
  setup({ PULL_REQUEST_LABELS: 'enhancement, agent' });
  const body = { value: state.writeSection('Record it.', 'spec', SPEC, []) };
  const r = routes(body, { 'heads/main': 'base' });
  r['issues.addLabels'] = {};
  const github = fake.github(r);
  await commit.run({ github, context: fake.context(), core: fake.core() });
  const add = github.calls.find((c) => c.name === 'issues.addLabels');
  assert.equal(add.params.issue_number, 40);
  assert.deepEqual(add.params.labels, ['enhancement', 'agent']);
});

test('approving what is already approved commits nothing and reports the commit', async () => {
  setup({ NUMBER: '40', DOCUMENT: 'plan', PULL_REQUEST: 'none' });
  const done = { ...SPEC, path: 'docs/superpowers/plans/plan.md', approved: true, branch: 'issue-12-recordings', commit: 'c0ffee1' };
  const body = { value: state.writeSection('Spec: x', 'plan', done, []) };
  const r = routes(body, {});
  r['issues.get'] = () => ({ number: 40, title: 'Recordings', body: body.value, pull_request: {} });
  const github = fake.github(r);
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core });
  assert.ok(!github.calls.some((c) => c.params?.input || c.name === 'pulls.create' || c.name === 'issues.createComment'));
  assert.equal(core.outputs.commit_url, 'https://github.com/kubed-io/selenium-flow/commit/c0ffee1');
  assert.equal(core.outputs.branch, 'issue-12-recordings');
});
