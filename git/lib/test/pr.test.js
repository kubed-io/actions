const test = require('node:test');
const assert = require('node:assert/strict');
const pr = require('../pr');
const fake = require('./fake');

function setup(over = {}) {
  for (const k of ['BRANCH', 'BASE', 'TITLE', 'BODY', 'DRAFT', 'LABELS']) delete process.env[k];
  Object.assign(process.env, { BRANCH: 'issue-5', TITLE: 'Recordings', DRAFT: 'true', ...over });
}

function routes(open = []) {
  return {
    'repos.get': { default_branch: 'main' },
    'pulls.list': open,
    'pulls.create': { number: 40, html_url: 'https://github.com/kubed-io/actions/pull/40' },
    'issues.addLabels': {},
  };
}

test('an open PR for the branch is found and left alone', async () => {
  setup();
  const github = fake.github(routes([{ number: 7, html_url: 'https://github.com/kubed-io/actions/pull/7' }]));
  const core = fake.core();
  await pr.run({ github, context: fake.context(), core });
  const list = github.calls.find((c) => c.name === 'pulls.list').params;
  assert.deepEqual(list, { owner: 'kubed-io', repo: 'actions', head: 'kubed-io:issue-5', base: 'main', state: 'open' });
  assert.ok(!github.calls.some((c) => c.name === 'pulls.create' || c.name === 'issues.addLabels' || c.name === 'pulls.update'));
  assert.deepEqual(core.outputs, { number: '7', url: 'https://github.com/kubed-io/actions/pull/7', created: 'false' });
});

test('a new PR is a draft against the default branch, with its labels', async () => {
  setup({ BODY: 'Closes #5', LABELS: 'enhancement, agent' });
  const github = fake.github(routes());
  const core = fake.core();
  await pr.run({ github, context: fake.context(), core });
  const created = github.calls.find((c) => c.name === 'pulls.create').params;
  assert.deepEqual(created, { owner: 'kubed-io', repo: 'actions', title: 'Recordings', head: 'issue-5', base: 'main', body: 'Closes #5', draft: true });
  const labels = github.calls.find((c) => c.name === 'issues.addLabels').params;
  assert.deepEqual(labels, { owner: 'kubed-io', repo: 'actions', issue_number: 40, labels: ['enhancement', 'agent'] });
  assert.deepEqual(core.outputs, { number: '40', url: 'https://github.com/kubed-io/actions/pull/40', created: 'true' });
});

test('draft false, a given base, no labels', async () => {
  setup({ DRAFT: 'false', BASE: 'v2' });
  const github = fake.github(routes());
  await pr.run({ github, context: fake.context(), core: fake.core() });
  const created = github.calls.find((c) => c.name === 'pulls.create').params;
  assert.equal(created.draft, false);
  assert.equal(created.base, 'v2');
  assert.equal(created.body, '');
  assert.ok(!github.calls.some((c) => c.name === 'repos.get' || c.name === 'issues.addLabels'));
});

test('GitHub refusing a branch with no commits surfaces as is', async () => {
  setup();
  const r = routes();
  r['pulls.create'] = Object.assign(new Error('Validation Failed: No commits between main and issue-5'), { status: 422 });
  const github = fake.github(r);
  await assert.rejects(pr.run({ github, context: fake.context(), core: fake.core() }), /No commits between main and issue-5/);
});
