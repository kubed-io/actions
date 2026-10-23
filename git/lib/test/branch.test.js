const test = require('node:test');
const assert = require('node:assert/strict');
const branch = require('../branch');
const fake = require('./fake');

function setup(over = {}) {
  for (const k of ['BRANCH', 'BASE', 'ISSUE']) delete process.env[k];
  Object.assign(process.env, { BRANCH: 'issue-5', ...over });
}

function routes(heads) {
  return {
    'git.getRef': ({ ref }) => (heads[ref] ? { object: { sha: heads[ref] } } : fake.notFound()),
    'repos.get': { default_branch: 'main', node_id: 'R_1' },
    'issues.get': { number: 5, node_id: 'I_5' },
    'git.createRef': {},
    'graphql:createLinkedBranch': {},
  };
}

test('an existing branch is found, not created', async () => {
  setup();
  const github = fake.github(routes({ 'heads/issue-5': 'head', 'heads/main': 'base' }));
  const core = fake.core();
  await branch.run({ github, context: fake.context(), core });
  assert.deepEqual(core.outputs, { sha: 'head', created: 'false' });
  assert.ok(!github.calls.some((c) => c.name === 'git.createRef' || c.name.startsWith('graphql')));
});

test('a new branch starts at the default branch', async () => {
  setup();
  const github = fake.github(routes({ 'heads/main': 'base' }));
  const core = fake.core();
  await branch.run({ github, context: fake.context(), core });
  const ref = github.calls.find((c) => c.name === 'git.createRef').params;
  assert.deepEqual(ref, { owner: 'kubed-io', repo: 'actions', ref: 'refs/heads/issue-5', sha: 'base' });
  assert.deepEqual(core.outputs, { sha: 'base', created: 'true' });
});

test('a new branch starts at base when given', async () => {
  setup({ BASE: 'v2' });
  const github = fake.github(routes({ 'heads/main': 'base', 'heads/v2': 'v2sha' }));
  const core = fake.core();
  await branch.run({ github, context: fake.context(), core });
  assert.equal(github.calls.find((c) => c.name === 'git.createRef').params.sha, 'v2sha');
});

test('with an issue the branch is created linked to it', async () => {
  setup({ ISSUE: '5' });
  const github = fake.github(routes({ 'heads/main': 'base' }));
  const core = fake.core();
  await branch.run({ github, context: fake.context(), core });
  const linked = github.calls.find((c) => c.name === 'graphql:createLinkedBranch').params;
  assert.deepEqual(linked, { issue: 'I_5', repo: 'R_1', oid: 'base', name: 'issue-5' });
  assert.equal(github.calls.find((c) => c.name === 'issues.get').params.issue_number, 5);
  assert.ok(!github.calls.some((c) => c.name === 'git.createRef'));
  assert.deepEqual(core.outputs, { sha: 'base', created: 'true' });
});

test('a missing base fails', async () => {
  setup({ BASE: 'nope' });
  const github = fake.github(routes({ 'heads/main': 'base' }));
  await assert.rejects(branch.run({ github, context: fake.context(), core: fake.core() }), /base branch nope does not exist/);
});
