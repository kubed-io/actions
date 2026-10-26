const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const commit = require('../commit');
const fake = require('./fake');

// a checkout on disk: `files` are what the working tree holds
function setup({ files = {}, env = {} } = {}) {
  for (const k of ['MESSAGE', 'FILES', 'BRANCH', 'ALLOW_EMPTY', 'GITHUB_HEAD_REF', 'GITHUB_REF_NAME']) delete process.env[k];
  Object.assign(process.env, { MESSAGE: 'docs: recordings', ...env });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-commit-'));
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }
  return root;
}

function git(root, status, over = {}) {
  return fake.exec({ 'rev-parse --show-toplevel': `${root}\n`, 'rev-parse --abbrev-ref': 'issue-5\n', status: status.join('\0') + (status.length ? '\0' : ''), ...over });
}

function routes(heads = { 'heads/issue-5': 'head' }) {
  return {
    'git.getRef': ({ ref }) => (heads[ref] ? { object: { sha: heads[ref] } } : fake.notFound()),
    'graphql:createCommitOnBranch': { createCommitOnBranch: { commit: { oid: 'c0ffee', url: 'https://github.com/kubed-io/actions/commit/c0ffee' } } },
  };
}

const input = (github) => github.calls.find((c) => c.name === 'graphql:createCommitOnBranch').params.input;
const decode = (a) => ({ path: a.path, text: Buffer.from(a.contents, 'base64').toString() });

test('status is parsed: untracked, modified, deleted, renamed', () => {
  const out = [' D del.txt', ' M mod.txt', 'R  new.txt', 'old.txt', 'MM both.txt', 'A  added.txt', '?? deep/x/y.txt', '!! ignored.log', ''].join('\0');
  assert.deepEqual(commit.parseStatus(out), [
    { xy: ' D', path: 'del.txt' },
    { xy: ' M', path: 'mod.txt' },
    { xy: 'R ', path: 'new.txt', from: 'old.txt' },
    { xy: 'MM', path: 'both.txt' },
    { xy: 'A ', path: 'added.txt' },
    { xy: '??', path: 'deep/x/y.txt' },
  ]);
});

test('an unresolved conflict fails', () => {
  assert.throws(() => commit.parseStatus('UU x.txt\0'), /x.txt has an unresolved merge conflict/);
});

test('every change is committed: additions with contents, deletions, a rename as both', async () => {
  const root = setup({ files: { 'mod.txt': 'm2\n', 'new.txt': 'renamed\n', 'deep/x/y.txt': 'y\n' } });
  const exec = git(root, [' D del.txt', ' M mod.txt', 'R  new.txt', 'old.txt', '?? deep/x/y.txt']);
  const github = fake.github(routes());
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core, exec });
  const sent = input(github);
  assert.deepEqual(sent.branch, { repositoryNameWithOwner: 'kubed-io/actions', branchName: 'issue-5' });
  assert.deepEqual(sent.message, { headline: 'docs: recordings' });
  assert.equal(sent.expectedHeadOid, 'head');
  assert.deepEqual(sent.fileChanges.additions.map(decode), [
    { path: 'deep/x/y.txt', text: 'y\n' },
    { path: 'mod.txt', text: 'm2\n' },
    { path: 'new.txt', text: 'renamed\n' },
  ]);
  assert.deepEqual(sent.fileChanges.deletions, [{ path: 'del.txt' }, { path: 'old.txt' }]);
  assert.deepEqual(core.outputs, {
    sha: 'c0ffee',
    url: 'https://github.com/kubed-io/actions/commit/c0ffee',
    files: JSON.stringify(['deep/x/y.txt', 'del.txt', 'mod.txt', 'new.txt', 'old.txt']),
    committed: 'true',
  });
});

test('afterwards the checkout fetches the branch and resets HEAD and the index to it', async () => {
  const root = setup({ files: { 'mod.txt': 'm2\n' } });
  const exec = git(root, [' M mod.txt']);
  await commit.run({ github: fake.github(routes()), context: fake.context(), core: fake.core(), exec });
  const after = exec.calls.slice(-2);
  assert.deepEqual(after, [['git', 'fetch', '--no-tags', 'origin', 'issue-5'], ['git', 'reset', '--mixed', 'FETCH_HEAD']]);
});

test('the fetch authenticates through git env config, never on the command line, and masks it', () => {
  const core = fake.core();
  const env = commit.authEnv(core, 'tok', 'https://github.com');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
  assert.deepEqual(core.secrets, [env.GIT_CONFIG_VALUE_0]);
  assert.deepEqual(commit.authEnv(core, ''), {});
});

test('a multi-line message is a headline and a body', async () => {
  const root = setup({ files: { 'a.txt': 'a' }, env: { MESSAGE: 'feat: a\n\nWhy it is.\n' } });
  const github = fake.github(routes());
  await commit.run({ github, context: fake.context(), core: fake.core(), exec: git(root, ['?? a.txt']) });
  assert.deepEqual(input(github).message, { headline: 'feat: a', body: 'Why it is.' });
});

test('files selects by path and glob; the rest stays uncommitted', async () => {
  const root = setup({
    files: { 'docs/specs/a.md': 'a', 'docs/plans/b.md': 'b', 'src/x.js': 'x', 'README.md': 'r' },
    env: { FILES: 'README.md\ndocs/**/*.md\n' },
  });
  const exec = git(root, ['?? docs/specs/a.md', '?? docs/plans/b.md', ' M src/x.js', ' M README.md', ' D docs/old.txt']);
  const github = fake.github(routes());
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core, exec });
  assert.deepEqual(input(github).fileChanges.additions.map((a) => a.path), ['README.md', 'docs/plans/b.md', 'docs/specs/a.md']);
  assert.equal(input(github).fileChanges.deletions, undefined);
  assert.deepEqual(JSON.parse(core.outputs.files), ['README.md', 'docs/plans/b.md', 'docs/specs/a.md']);
});

test('a directory in files selects everything under it; * stays in one directory', async () => {
  const root = setup({ files: { 'docs/a.md': 'a', 'docs/deep/b.md': 'b', 'top.md': 't' }, env: { FILES: 'docs\n*.md' } });
  const github = fake.github(routes());
  await commit.run({ github, context: fake.context(), core: fake.core(), exec: git(root, ['?? docs/a.md', '?? docs/deep/b.md', '?? top.md']) });
  assert.deepEqual(input(github).fileChanges.additions.map((a) => a.path), ['docs/a.md', 'docs/deep/b.md', 'top.md']);
});

test('nothing selected commits nothing and calls no API', async () => {
  const root = setup({ files: { 'src/x.js': 'x' }, env: { FILES: 'docs/**' } });
  const exec = git(root, [' M src/x.js']);
  const github = fake.github(routes());
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core, exec });
  assert.equal(github.calls.length, 0);
  assert.ok(!exec.calls.some((c) => c[1] === 'fetch' || c[1] === 'reset'));
  assert.deepEqual(core.outputs, { sha: '', url: '', files: '[]', committed: 'false' });
});

test('a clean tree commits nothing', async () => {
  const root = setup();
  const github = fake.github(routes());
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core, exec: git(root, []) });
  assert.equal(github.calls.length, 0);
  assert.equal(core.outputs.committed, 'false');
});

test('allow_empty with nothing commits empty additions', async () => {
  const root = setup({ env: { ALLOW_EMPTY: 'true' } });
  const github = fake.github(routes());
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core, exec: git(root, []) });
  assert.deepEqual(input(github).fileChanges, { additions: [] });
  assert.equal(core.outputs.committed, 'true');
  assert.equal(core.outputs.files, '[]');
});

test('a moved head is retried once on the new head', async () => {
  const root = setup({ files: { 'a.txt': 'a' } });
  const heads = { 'heads/issue-5': 'old' };
  let tries = 0;
  const r = routes(heads);
  r['graphql:createCommitOnBranch'] = () => {
    tries += 1;
    if (tries === 1) { heads['heads/issue-5'] = 'moved'; return new Error('Expected branch to point to "old"'); }
    return { createCommitOnBranch: { commit: { oid: 'c0ffee', url: 'u' } } };
  };
  const github = fake.github(r);
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core, exec: git(root, ['?? a.txt']) });
  const sent = github.calls.filter((c) => c.name === 'graphql:createCommitOnBranch').map((c) => c.params.input.expectedHeadOid);
  assert.deepEqual(sent, ['old', 'moved']);
  assert.match(core.notices.join('\n'), /failed once/);
  assert.equal(core.outputs.sha, 'c0ffee');
});

test('a second failure fails', async () => {
  const root = setup({ files: { 'a.txt': 'a' } });
  const r = routes();
  r['graphql:createCommitOnBranch'] = () => new Error('nope');
  await assert.rejects(commit.run({ github: fake.github(r), context: fake.context(), core: fake.core(), exec: git(root, ['?? a.txt']) }), /nope/);
});

test('a branch GitHub does not have fails, naming git/branch', async () => {
  const root = setup({ files: { 'a.txt': 'a' } });
  const github = fake.github(routes({}));
  await assert.rejects(commit.run({ github, context: fake.context(), core: fake.core(), exec: git(root, ['?? a.txt']) }), /branch issue-5 does not exist; git\/branch makes it/);
});

// a gitlink in the index and in HEAD's tree, and the commit its submodule is checked out at
function linked(root, { index = 'abc', head = 'abc', at = '' } = {}) {
  return {
    '--literal-pathspecs ls-files': index ? `160000 ${index} 0\twiki\0` : '',
    '--literal-pathspecs ls-tree': head ? `160000 commit ${head}\twiki\0` : '',
    [`-C ${path.join(root, 'wiki')} rev-parse HEAD`]: at ? `${at}\n` : '',
  };
}

function treeRoutes(heads = { 'heads/issue-5': 'head' }) {
  let blobs = 0;
  return {
    ...routes(heads),
    'git.getCommit': ({ commit_sha: sha }) => ({ sha, tree: { sha: `tree-of-${sha}` } }),
    'git.createBlob': () => { blobs += 1; return { sha: `blob${blobs}` }; },
    'git.createTree': () => ({ sha: 'newtree' }),
    'git.createCommit': () => ({ sha: 'beef', html_url: 'https://github.com/kubed-io/actions/commit/beef' }),
    'git.updateRef': ({ sha }) => ({ object: { sha } }),
  };
}

const call = (github, name) => github.calls.find((c) => c.name === name)?.params;

test('a submodule with changes but no new commit, swept up, is left out with a warning; the rest is committed', async () => {
  const root = setup({ files: { 'a.txt': 'a' } });
  fs.mkdirSync(path.join(root, 'wiki'));
  const exec = git(root, [' M wiki', '?? a.txt'], { ...linked(root, { at: 'abc' }), '--literal-pathspecs ls-files': ['160000 abc 0\twiki', '100644 def 0\ta.txt', ''].join('\0') });
  const github = fake.github(routes());
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core, exec });
  assert.equal(core.outputs.files, '["a.txt"]');
  assert.ok(core.notices.some((m) => /left out, as submodule changes .*commit inside the submodule first.*: wiki/.test(m)));
  assert.ok(call(github, 'graphql:createCommitOnBranch'), 'no gitlink moved: the signed GraphQL commit as before');
});

test('a submodule at a new commit moves its pointer in the same commit as the files, through the Git Data API', async () => {
  const root = setup({ files: { 'a.txt': 'a\n', 'run.sh': '#!/bin/sh\n' } });
  fs.chmodSync(path.join(root, 'run.sh'), 0o755);
  fs.mkdirSync(path.join(root, 'wiki'));
  const exec = git(root, [' M wiki', '?? a.txt', '?? run.sh', ' D gone.txt'], linked(root, { at: 'f00d' }));
  const github = fake.github(treeRoutes());
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core, exec });
  assert.ok(!call(github, 'graphql:createCommitOnBranch'));
  const tree = call(github, 'git.createTree');
  assert.equal(tree.base_tree, 'tree-of-head');
  assert.deepEqual(tree.tree, [
    { path: 'a.txt', mode: '100644', type: 'blob', sha: 'blob1' },
    { path: 'gone.txt', mode: '100644', type: 'blob', sha: null },
    { path: 'run.sh', mode: '100755', type: 'blob', sha: 'blob2' },
    { path: 'wiki', mode: '160000', type: 'commit', sha: 'f00d' },
  ]);
  assert.equal(call(github, 'git.createBlob').encoding, 'base64');
  const made = call(github, 'git.createCommit');
  assert.deepEqual(made.parents, ['head']);
  assert.equal(made.message, 'docs: recordings');
  assert.ok(!('author' in made) && !('committer' in made), 'no author or committer: GitHub signs it as the App');
  assert.deepEqual(call(github, 'git.updateRef'), { owner: 'kubed-io', repo: 'actions', ref: 'heads/issue-5', sha: 'beef', force: false });
  assert.equal(core.outputs.sha, 'beef');
  assert.equal(core.outputs.files, '["a.txt","gone.txt","run.sh","wiki"]');
});

test('a gitlink named in files moves alone: one commit, only the pointer', async () => {
  const root = setup({ files: { 'a.txt': 'a' } });
  fs.mkdirSync(path.join(root, 'wiki'));
  process.env.FILES = 'wiki';
  const exec = git(root, [' M wiki', '?? a.txt'], linked(root, { at: 'f00d' }));
  const github = fake.github(treeRoutes());
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core, exec });
  assert.deepEqual(call(github, 'git.createTree').tree, [{ path: 'wiki', mode: '160000', type: 'commit', sha: 'f00d' }]);
  assert.equal(core.outputs.files, '["wiki"]');
});

test('a gitlink named in files with no new commit in it is refused, before anything is sent', async () => {
  const root = setup();
  fs.mkdirSync(path.join(root, 'wiki'));
  process.env.FILES = 'wiki';
  const exec = git(root, [' M wiki'], linked(root, { at: 'abc' }));
  const github = fake.github(treeRoutes());
  await assert.rejects(commit.run({ github, context: fake.context(), core: fake.core(), exec }), /wiki has no new commit to point at: commit inside the submodule first/);
  assert.equal(github.calls.length, 0);
});

test('a pointer staged without the submodule checked out is the index\'s commit', async () => {
  const root = setup();
  const exec = git(root, ['M  wiki'], linked(root, { index: 'f00d', at: '' }));
  const github = fake.github(treeRoutes());
  await commit.run({ github, context: fake.context(), core: fake.core(), exec });
  assert.deepEqual(call(github, 'git.createTree').tree, [{ path: 'wiki', mode: '160000', type: 'commit', sha: 'f00d' }]);
});

test('a moved head is retried once on the new head, with the same blobs', async () => {
  const root = setup({ files: { 'a.txt': 'a' } });
  fs.mkdirSync(path.join(root, 'wiki'));
  let refs = 0;
  const r = treeRoutes();
  r['git.getRef'] = () => ({ object: { sha: refs++ === 0 ? 'head' : 'head2' } });
  let updates = 0;
  r['git.updateRef'] = ({ sha }) => (updates++ === 0 ? Object.assign(new Error('Update is not a fast forward'), { status: 422 }) : { object: { sha } });
  const github = fake.github(r);
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core, exec: git(root, [' M wiki', '?? a.txt'], linked(root, { at: 'f00d' })) });
  const commits = github.calls.filter((c) => c.name === 'git.createCommit').map((c) => c.params.parents);
  assert.deepEqual(commits, [['head'], ['head2']]);
  assert.equal(github.calls.filter((c) => c.name === 'git.createBlob').length, 1);
  assert.ok(core.notices.some((m) => /retrying on the new head/.test(m)));
});

test('a deleted gitlink, swept up, is left out too: nothing else, nothing committed', async () => {
  const root = setup();
  const exec = git(root, ['D  wiki'], { '--literal-pathspecs ls-tree': '160000 commit abc\twiki\0' });
  const core = fake.core();
  await commit.run({ github: fake.github(routes()), context: fake.context(), core, exec });
  assert.equal(core.outputs.committed, 'false');
});

test('a path inside a submodule: left out when swept up, refused when files reaches into it', async () => {
  const root = setup({ files: { '.gitmodules': '[submodule "docs"]\n\tpath = docs\n\turl = ../x.wiki\n', 'docs/a.md': 'a' } });
  const core = fake.core();
  await commit.run({ github: fake.github(routes()), context: fake.context(), core, exec: git(root, ['?? docs/a.md']) });
  assert.equal(core.outputs.committed, 'false');
  process.env.FILES = 'docs/*.md';
  await assert.rejects(commit.run({ github: fake.github(routes()), context: fake.context(), core: fake.core(), exec: git(root, []) }), /docs\/\*\.md is a submodule or inside one/);
});

test('an untracked nested repository is left out when swept up', async () => {
  const root = setup();
  fs.mkdirSync(path.join(root, 'vendor'));
  const core = fake.core();
  await commit.run({ github: fake.github(routes()), context: fake.context(), core, exec: git(root, ['?? vendor/']) });
  assert.ok(core.notices.some((m) => /vendor\//.test(m)));
  assert.equal(core.outputs.committed, 'false');
});

test('a path added then deleted is not committed', async () => {
  const root = setup();
  const github = fake.github(routes());
  const core = fake.core();
  await commit.run({ github, context: fake.context(), core, exec: git(root, ['AD gone.txt']) });
  assert.equal(core.outputs.committed, 'false');
});

test('a detached checkout commits to the head ref', async () => {
  const root = setup({ files: { 'a.txt': 'a' }, env: { GITHUB_HEAD_REF: 'issue-5', GITHUB_REF_NAME: '40/merge' } });
  const github = fake.github(routes());
  await commit.run({ github, context: fake.context(), core: fake.core(), exec: git(root, ['?? a.txt'], { 'rev-parse --abbrev-ref': 'HEAD\n' }) });
  assert.equal(input(github).branch.branchName, 'issue-5');
});

test('branch given wins over the checkout', async () => {
  const root = setup({ files: { 'a.txt': 'a' }, env: { BRANCH: 'other' } });
  const github = fake.github(routes({ 'heads/other': 'o' }));
  const exec = git(root, ['?? a.txt']);
  await commit.run({ github, context: fake.context(), core: fake.core(), exec });
  assert.equal(input(github).branch.branchName, 'other');
  assert.ok(!exec.calls.some((c) => c.includes('--abbrev-ref')));
});
