const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const commit = require('../commit');
const state = require('../state');
const fake = require('./fake');

const SPEC = { slug: 'recordings', path: 'docs/superpowers/specs/2026-10-08-recordings-design.md', round: 2, run: '5', artifact: '7', artifact_url: 'A', summary_url: 'S', approved: false };

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-'));
  fs.writeFileSync(path.join(dir, '2026-10-08-recordings-design.md'), '# Recordings\n');
  Object.assign(process.env, { NUMBER: '12', DOCUMENT: 'spec', BRANCH: 'issue-{number}-{slug}', MESSAGE: '{document}: {title} (#{number})', PULL_REQUEST: 'draft', DOWNLOAD_DIR: dir, GITHUB_SERVER_URL: 'https://github.com', MODE: 'commit', ...over });
}

function routes(body, heads) {
  return {
    'issues.get': () => ({ number: 12, title: 'Recordings', node_id: 'I_12', body: body.value }),
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
