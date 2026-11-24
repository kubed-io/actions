const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pr = require('../update');
const fake = require('../../../git/lib/test/fake');

const WIKI = 'https://github.com/kubed-io/x.wiki.git';
// a `git diff-tree -r -z` row
const diff = (was, mode, sha, status, p) => `:${was} ${mode} ${'0'.repeat(7)} ${sha} ${status}\0${p}\0`;
const POINTER = diff('160000', '160000', 'wikihead', 'M', 'docs');

// a stage line of `git ls-files -u -z`
const stage = (mode, sha, n, p) => `${mode} ${sha} ${n}\t${p}`;
const DOCS = [stage('160000', 'ba5e', 1, 'docs'), stage('160000', 'a11ce', 2, 'docs'), stage('160000', 'b0b', 3, 'docs')];
const LOG = [stage('100644', 'c1', 1, 'CHANGELOG.md'), stage('100644', 'c2', 2, 'CHANGELOG.md'), stage('100644', 'c3', 3, 'CHANGELOG.md')];
const OTHER = [stage('100644', 'e1', 1, 'src/x.py'), stage('100644', 'e2', 2, 'src/x.py'), stage('100644', 'e3', 3, 'src/x.py')];

// git answered from `routes`: the start of a command line → stdout, or [code, stdout, stderr]
function git(routes) {
  const calls = [];
  return {
    calls,
    getExecOutput: async (cmd, args) => {
      const line = args.slice(2).join(' ');
      calls.push(line);
      const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => line.startsWith(k));
      let got = key === undefined ? '' : routes[key];
      if (typeof got === 'function') got = got(line);
      const [exitCode, stdout, stderr] = Array.isArray(got) ? got : [0, got, ''];
      return { exitCode, stdout, stderr: stderr || '' };
    },
  };
}

// a conflicted merge: the checkout's head is behind, and `ls-files -u` lists `conflicts`
function conflicted(conflicts, over = {}) {
  return {
    'merge-base --is-ancestor refs/remotes/origin/main': [1, ''],
    '-c user.name=pr-update -c user.email=pr-update@users.noreply.github.com -c merge.conflictStyle=merge merge': [1, 'CONFLICT (content)'],
    'rev-parse refs/remotes/origin/': 'head5\n',
    'rev-parse FETCH_HEAD': 'wikihead\n',
    'ls-files -u -z': `${conflicts.join('\0')}\0`,
    config: (line) => {
      if (line.includes('--get-regexp')) return 'submodule.docs.path docs\n';
      if (line.endsWith('submodule.docs.url')) return `${WIKI}\n`;
      return [1, ''];
    },
    'merge-base --is-ancestor': [0, ''],
    'rev-parse refs/remotes/origin/main': 'base5\n',
    'rev-parse head5^{tree}': 'htree\n',
    'write-tree': 'tree5\n',
    'diff-tree': POINTER,
    'rev-parse --verify --quiet refs/remotes/origin/main:': 'onbase\n',
    ...over,
  };
}

// open PRs by base, for a run that follows family branches
const byBase = (lists) => ({ base }) => lists[base] || [];

const PR5 = { number: 5, head: { ref: 'issue-5', sha: 'head5', repo: { full_name: 'kubed-io/x' } } };

function setup({ prs = [PR5], behind = 1, updateBranch = {}, routes = {}, files = {}, api = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-update-'));
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(root, f), text);
  const github = fake.github({
    // a list for main, none on any other base; or by base, as a function
    'pulls.list': typeof prs === 'function' ? prs : ({ base }) => (base === 'main' ? prs : []),
    'repos.compareCommitsWithBasehead': { behind_by: behind },
    'pulls.updateBranch': updateBranch,
    'git.createBlob': { sha: 'sent' },
    'git.createTree': { sha: 'tree5' },
    'git.createCommit': { sha: 'merge5' },
    'git.updateRef': {},
    ...api,
  });
  github.paginate = async (fn, params) => (await fn(params)).data;
  const exec = git(routes);
  const go = (over = {}) => pr.update({ github, core: fake.core(), exec, owner: 'kubed-io', repo: 'x', base: 'main', root, env: {}, ...over });
  return { root, github, exec, go };
}

const refused = () => Object.assign(new Error('merge conflict between base and head'), { status: 422 });
const called = (t, name) => t.github.calls.filter((c) => c.name === name);
const ran = (t, start) => t.exec.calls.filter((c) => c.startsWith(start));

test('a PR whose head already has the base is current, and nothing is asked of it', async () => {
  const t = setup({ behind: 0 });
  assert.deepEqual(await t.go(), [{ number: 5, branch: 'issue-5', result: 'current' }]);
  assert.equal(called(t, 'repos.compareCommitsWithBasehead')[0].params.basehead, 'main...head5');
  assert.deepEqual(called(t, 'pulls.updateBranch'), []);
  assert.deepEqual(ran(t, 'fetch'), []);
});

test("GitHub's update-branch, from the head it was at, is the update when it takes", async () => {
  const t = setup();
  assert.deepEqual(await t.go(), [{ number: 5, branch: 'issue-5', result: 'updated' }]);
  assert.deepEqual(called(t, 'pulls.updateBranch')[0].params, { owner: 'kubed-io', repo: 'x', pull_number: 5, expected_head_sha: 'head5' });
  assert.deepEqual(ran(t, 'fetch'), []);
});

test("a docs pointer conflict moves the pointer to the wiki's head, which holds both sides", async () => {
  const t = setup({ updateBranch: refused(), routes: conflicted(DOCS) });
  assert.deepEqual(await t.go(), [{ number: 5, branch: 'issue-5', result: 'merged & resolved: pointer' }]);
  assert.ok(ran(t, `fetch --no-tags --quiet ${WIKI} HEAD`).length);
  assert.deepEqual(ran(t, 'merge-base --is-ancestor').slice(1), ['merge-base --is-ancestor a11ce wikihead', 'merge-base --is-ancestor b0b wikihead']);
  assert.deepEqual(ran(t, 'update-index'), ['update-index --cacheinfo 160000,wikihead,docs']);
  // the commit is GitHub's, so it is signed: nothing is committed or pushed from the checkout
  assert.deepEqual([...ran(t, 'commit'), ...ran(t, 'push')], []);
  assert.deepEqual(called(t, 'git.createTree')[0].params, { owner: 'kubed-io', repo: 'x', base_tree: 'htree',
    tree: [{ path: 'docs', mode: '160000', type: 'commit', sha: 'wikihead' }] });
  assert.deepEqual(called(t, 'git.createCommit')[0].params, { owner: 'kubed-io', repo: 'x',
    message: "Merge main into issue-5: the docs pointer at the wiki's head", tree: 'tree5', parents: ['head5', 'base5'] });
  assert.deepEqual(called(t, 'git.updateRef')[0].params, { owner: 'kubed-io', repo: 'x', ref: 'heads/issue-5', sha: 'merge5', force: false });
  assert.deepEqual(called(t, 'git.createBlob'), []);
});

test("a blob the base has is named, not sent; one only the merge made is sent; a deleted path goes", async () => {
  const rows = POINTER + diff('100644', '100644', 'onbase', 'M', 'src/base.py') + diff('100644', '100644', 'merged', 'M', 'src/both.py')
    + diff('100644', '000000', '0000000', 'D', 'old.txt');
  const t = setup({ updateBranch: refused(), routes: conflicted(DOCS, { 'diff-tree': rows }), files: {} });
  fs.mkdirSync(path.join(t.root, 'src'));
  fs.writeFileSync(path.join(t.root, 'src', 'both.py'), 'merged\n');
  assert.deepEqual(await t.go(), [{ number: 5, branch: 'issue-5', result: 'merged & resolved: pointer' }]);
  assert.deepEqual(called(t, 'git.createBlob').map((c) => c.params.content), [Buffer.from('merged\n').toString('base64')]);
  assert.deepEqual(called(t, 'git.createTree')[0].params.tree, [
    { path: 'docs', mode: '160000', type: 'commit', sha: 'wikihead' },
    { path: 'src/base.py', mode: '100644', type: 'blob', sha: 'onbase' },
    { path: 'src/both.py', mode: '100644', type: 'blob', sha: 'sent' },
    { path: 'old.txt', mode: '100644', type: 'blob', sha: null },
  ]);
});

test("a tree GitHub builds differently from the merge's is the PR's failure, and no commit is made", async () => {
  const t = setup({ updateBranch: refused(), routes: conflicted(DOCS), api: { 'git.createTree': { sha: 'other' } } });
  assert.deepEqual(await t.go(), [{ number: 5, branch: 'issue-5', result: "failed: the tree GitHub built (other) is not the merge's (tree5)" }]);
  assert.deepEqual(called(t, 'git.createCommit'), []);
});

// the wiki's head holds only the PR's side: the base's is on its own wiki branch now
const NOT_HELD = { 'merge-base --is-ancestor b0b': [1, ''] };
const COMMIT_TREE = '-c user.name=pr-update -c user.email=pr-update@users.noreply.github.com commit-tree';

test("a pointer side the wiki's head does not hold is merged with the other on the PR's own wiki branch, and pointed at", async () => {
  const t = setup({ updateBranch: refused(), routes: conflicted(DOCS, { ...NOT_HELD, 'merge-tree': 'mtree\n', [COMMIT_TREE]: 'wikimerge\n' }) });
  assert.deepEqual(await t.go(), [{ number: 5, branch: 'issue-5', result: 'merged & resolved: pointer' }]);
  assert.deepEqual(ran(t, `fetch --no-tags --quiet ${WIKI} a11ce`), [`fetch --no-tags --quiet ${WIKI} a11ce b0b`]);
  // the PR's side (stage 2) wins a file both changed
  assert.deepEqual(ran(t, 'merge-tree'), ['merge-tree --write-tree -X ours a11ce b0b']);
  assert.deepEqual(ran(t, COMMIT_TREE), [`${COMMIT_TREE} mtree -p a11ce -p b0b -m Merge the base's wiki into issue-5`]);
  // to the PR's own wiki branch, never forced, never to master
  assert.deepEqual(ran(t, 'push'), [`push --quiet ${WIKI} wikimerge:refs/heads/issue-5`]);
  assert.deepEqual(ran(t, 'update-index'), ['update-index --cacheinfo 160000,wikimerge,docs']);
  assert.equal(called(t, 'git.createCommit')[0].params.message, "Merge main into issue-5: the docs pointer at a merge of both sides' wiki");
});

test("a wiki merge whose push is refused (the PR's wiki branch moved) is left for the PR's agent", async () => {
  const t = setup({ updateBranch: refused(), routes: conflicted(DOCS, { ...NOT_HELD, 'merge-tree': 'mtree\n', [COMMIT_TREE]: 'wikimerge\n',
    push: [1, '', ' ! [rejected] wikimerge -> issue-5 (non-fast-forward)'] }) });
  assert.deepEqual(await t.go(), [{ number: 5, branch: 'issue-5', result: 'needs its agent: docs (dispatched)' }]);
  assert.deepEqual(ran(t, 'update-index'), []);
  assert.deepEqual(called(t, 'git.createCommit'), []);
});

test("a pointer the wiki's head does not hold and that will not merge is left for the PR's agent, and nothing is pushed", async () => {
  const t = setup({ updateBranch: refused(), routes: conflicted(DOCS, { ...NOT_HELD, 'merge-tree': [1, 'mtree\n'] }) });
  assert.deepEqual(await t.go(), [{ number: 5, branch: 'issue-5', result: 'needs its agent: docs (dispatched)' }]);
  assert.deepEqual(called(t, 'repos.createDispatchEvent').map((c) => c.params), [{ owner: 'kubed-io', repo: 'x', event_type: 'agent-code',
    client_payload: { pull_request: 5, reason: 'conflict', base: 'main', paths: 'docs' } }]);
  assert.deepEqual(ran(t, 'update-index'), []);
  assert.deepEqual(ran(t, 'merge --abort'), ['merge --abort']);
  assert.deepEqual(called(t, 'git.createCommit'), []);
});

const CHANGELOG = [
  '# Changelog', '', '## [Unreleased]', '', '### Added', '',
  '<<<<<<< HEAD', '- the PR’s entry', '- shared entry', '=======', '- main’s entry', '- shared entry', '>>>>>>> refs/remotes/origin/main',
  '', '### Fixed', '',
  '<<<<<<< HEAD', '- the PR’s fix', '||||||| merged common ancestors', '- old fix', '=======', '- main’s fix', '>>>>>>> refs/remotes/origin/main',
  '', '## [1.0.0]', '', '- untouched', '',
].join('\n');

test("the changelog's conflict hunks keep the base's lines, then the PR's; the rest of the file is untouched", async () => {
  const t = setup({ updateBranch: refused(), routes: conflicted([...DOCS, ...LOG], { 'diff-tree': POINTER + diff('100644', '100644', 'u1', 'M', 'CHANGELOG.md') }), files: { 'CHANGELOG.md': CHANGELOG } });
  assert.deepEqual(await t.go(), [{ number: 5, branch: 'issue-5', result: 'merged & resolved: pointer, changelog' }]);
  assert.equal(fs.readFileSync(path.join(t.root, 'CHANGELOG.md'), 'utf8'), [
    '# Changelog', '', '## [Unreleased]', '', '### Added', '',
    '- main’s entry', '- shared entry', '- the PR’s entry',
    '', '### Fixed', '',
    '- main’s fix', '- the PR’s fix',
    '', '## [1.0.0]', '', '- untouched', '',
  ].join('\n'));
  assert.deepEqual(ran(t, 'add'), ['add -- CHANGELOG.md']);
  assert.match(called(t, 'git.createCommit')[0].params.message, /: the docs pointer at the wiki's head; CHANGELOG\.md's entries from both$/);
  // the union is the merge's own blob: sent, as the file the checkout holds
  assert.equal(Buffer.from(called(t, 'git.createBlob')[0].params.content, 'base64').toString(), fs.readFileSync(path.join(t.root, 'CHANGELOG.md'), 'utf8'));
});

test('a hunk cut off, or no hunk at all, is no union', () => {
  assert.equal(pr.unionHunks('a\n<<<<<<< HEAD\nb\n=======\nc\n'), null);
  assert.equal(pr.unionHunks('a\nb\n'), null);
});

test("any other conflict aborts the merge: the PR's agent's, named, even beside a pointer that would resolve", async () => {
  const t = setup({ updateBranch: refused(), routes: conflicted([...DOCS, ...OTHER]) });
  assert.deepEqual(await t.go(), [{ number: 5, branch: 'issue-5', result: 'needs its agent: src/x.py (dispatched)' }]);
  assert.equal(called(t, 'repos.createDispatchEvent')[0].params.client_payload.paths, 'src/x.py');
  assert.deepEqual(ran(t, 'merge --abort'), ['merge --abort']);
  assert.deepEqual(called(t, 'git.createCommit'), []);
});

test("a conflict on a PR that is not an agent's (another head prefix) is only its row: nothing is dispatched", async () => {
  const human = { ...PR5, head: { ...PR5.head, ref: 'fix-typo' } };
  const t = setup({ prs: [human], updateBranch: refused(), routes: conflicted(OTHER) });
  assert.deepEqual(await t.go(), [{ number: 5, branch: 'fix-typo', result: 'needs its agent: src/x.py' }]);
  assert.deepEqual(called(t, 'repos.createDispatchEvent'), []);
});

test('a branch the agent committed to meanwhile is not a fast-forward: it is moved, for the next merge', async () => {
  const notFF = Object.assign(new Error('Update is not a fast forward'), { status: 422 });
  const t = setup({ updateBranch: refused(), routes: conflicted(DOCS), api: { 'git.updateRef': notFF } });
  assert.deepEqual(await t.go(), [{ number: 5, branch: 'issue-5', result: 'moved during the update; next merge retries' }]);
  assert.equal(called(t, 'git.updateRef')[0].params.force, false);
});

test("one PR's failure is its row; the others are still updated, and a fork's PR is not touched", async () => {
  const fork = { number: 7, head: { ref: 'main', sha: 'f', repo: { full_name: 'someone/x' } } };
  const six = { number: 6, head: { ref: 'issue-6', sha: 'head6', repo: { full_name: 'kubed-io/x' } } };
  const t = setup({ prs: [PR5, fork, six], updateBranch: ({ pull_number: n }) => (n === 5 ? Object.assign(new Error('Server Error'), { status: 500 }) : {}) });
  assert.deepEqual(await t.go(), [
    { number: 5, branch: 'issue-5', result: 'failed: Server Error' },
    { number: 6, branch: 'issue-6', result: 'updated' },
  ]);
});

test('the base is fetched whole once in a shallow checkout, and the checkout is put back where it was', async () => {
  const six = { number: 6, head: { ref: 'issue-6', sha: 'head6', repo: { full_name: 'kubed-io/x' } } };
  const t = setup({ prs: [PR5, six], updateBranch: refused(), routes: conflicted(DOCS, { 'rev-parse --is-shallow-repository': 'true\n', 'symbolic-ref': 'main\n' }) });
  await t.go();
  const fetches = ran(t, 'fetch --no-tags --quiet');
  assert.match(fetches[0], /^fetch --no-tags --quiet --unshallow origin \+refs\/heads\/main:refs\/remotes\/origin\/main \+refs\/heads\/issue-5:/);
  assert.equal(fetches.filter((f) => f.includes('--unshallow')).length, 1);
  assert.equal(fetches.filter((f) => f.includes(WIKI)).length, 1);
  assert.equal(t.exec.calls.at(-1), '-c advice.detachedHead=false checkout --quiet --force main');
});

test('the summary is a table of every PR and what became of it', () => {
  assert.equal(pr.table('main', [{ number: 5, branch: 'issue-5', result: 'needs its agent: a|b' }]),
    '### Open PRs on `main`\n\n| PR | Branch | Result |\n|---|---|---|\n| #5 | `issue-5` | needs its agent: a\\|b |\n');
});

test('no token is a setup error: the job fails', async () => {
  delete process.env.TOKEN;
  await assert.rejects(pr.run({ github: fake.github(), context: fake.context(), core: fake.core(), exec: git({}) }), /no token/);
});

test("git authenticates with the App's token only: a header the checkout persisted is dropped first", () => {
  const env = pr.authEnv(fake.core(), 't0ken');
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_KEY_1);
  assert.equal(env.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${Buffer.from('x-access-token:t0ken').toString('base64')}`);
});

// a family's branch that changed a workflow: the App's token has no `workflows`, so no
// update-branch and no merge here can take it (quick-mcp #32 waited for a hand merge)
const PR15 = { number: 32, head: { ref: 'issue-15', sha: 'head15', repo: { full_name: 'kubed-io/x' } } };
const lintChanged = ({ basehead }) => (basehead === 'head15...issue-12'
  ? { ahead_by: 1, files: [{ filename: 'src/x.py', sha: 'b1' }, { filename: '.github/workflows/lint.yml', sha: 'ee31' }] }
  : { behind_by: 1 });

test('a base that changed a workflow is left for a person: the PR is told once, and nothing is tried', async () => {
  const t = setup({ prs: byBase({ 'issue-12': [PR15] }), api: { 'repos.compareCommitsWithBasehead': lintChanged, 'issues.listComments': [], 'issues.createComment': {} } });
  assert.deepEqual(await t.go({ base: 'issue-12' }), [{ number: 32, branch: 'issue-15', result: 'needs a person: .github/workflows/lint.yml (asked)' }]);
  assert.deepEqual(called(t, 'pulls.updateBranch'), []);
  assert.deepEqual(t.exec.calls.filter((c) => !c.startsWith('symbolic-ref') && !c.startsWith('rev-parse')), []);
  assert.deepEqual(called(t, 'repos.createDispatchEvent'), []);
  const [asked] = called(t, 'issues.createComment');
  assert.equal(asked.params.issue_number, 32);
  assert.match(asked.params.body, /^<!-- pr-update: workflows issue-12 \.github\/workflows\/lint\.yml@ee31 -->\n/);
  assert.match(asked.params.body, /A person must merge `issue-12` into `issue-15`.*`\.github\/workflows\/lint\.yml`/);
});

test('a PR already told about that workflow change is not told again', async () => {
  const told = [{ body: '<!-- pr-update: workflows issue-12 .github/workflows/lint.yml@ee31 -->\nA person must merge' }];
  const t = setup({ prs: byBase({ 'issue-12': [PR15] }), api: { 'repos.compareCommitsWithBasehead': lintChanged, 'issues.listComments': told, 'issues.createComment': {} } });
  assert.deepEqual(await t.go({ base: 'issue-12' }), [{ number: 32, branch: 'issue-15', result: 'needs a person: .github/workflows/lint.yml (asked before)' }]);
  assert.deepEqual(called(t, 'issues.createComment'), []);
  assert.deepEqual(called(t, 'pulls.updateBranch'), []);
});

test("a workflow change on the base of a PR that is not an agent's is only its row", async () => {
  const mine = { ...PR15, head: { ...PR15.head, ref: 'feat/x' } };
  const t = setup({ prs: byBase({ 'issue-12': [mine] }), api: { 'repos.compareCommitsWithBasehead': lintChanged, 'issues.createComment': {} } });
  assert.deepEqual(await t.go({ base: 'issue-12' }), [{ number: 32, branch: 'feat/x', result: 'needs a person: .github/workflows/lint.yml' }]);
  assert.deepEqual(called(t, 'issues.createComment'), []);
});

test('a base whose changes are not workflows is updated as before', async () => {
  const t = setup({ prs: byBase({ 'issue-12': [PR15] }), api: { 'repos.compareCommitsWithBasehead': ({ basehead }) => (basehead.startsWith('head15...') ? { ahead_by: 1, files: [{ filename: 'src/x.py', sha: 'b1' }] } : { behind_by: 1 }) } });
  assert.deepEqual(await t.go({ base: 'issue-12' }), [{ number: 32, branch: 'issue-15', result: 'updated' }]);
});

// main's update moves a family's branch (its PR to main): the sub-issue PRs into it follow
const FAMILY = { number: 16, head: { ref: 'issue-16', sha: 'head16', repo: { full_name: 'kubed-io/x' } } };
const SUB = { number: 31, head: { ref: 'issue-28', sha: 'head28', repo: { full_name: 'kubed-io/x' } } };

test("a family's branch that main's update moved brings its sub-issue PRs up to date, in rows of their own", async () => {
  const t = setup({ prs: byBase({ main: [FAMILY], 'issue-16': [SUB] }) });
  assert.deepEqual(await t.go(), [
    { number: 16, branch: 'issue-16', result: 'updated' },
    { number: 31, branch: 'issue-28', result: 'updated', base: 'issue-16' },
  ]);
  assert.deepEqual(called(t, 'pulls.list').map((c) => c.params.base), ['main', 'issue-16', 'issue-28']);
  assert.deepEqual(called(t, 'pulls.updateBranch').map((c) => c.params.pull_number), [16, 31]);
});

test('a family branch that did not move, or a head that is no family branch, is not followed', async () => {
  const other = { number: 7, head: { ref: 'feat/x', sha: 'h7', repo: { full_name: 'kubed-io/x' } } };
  const t = setup({ prs: byBase({ main: [FAMILY, other], 'issue-16': [SUB], 'feat/x': [SUB] }), behind: 0 });
  await t.go();
  assert.deepEqual(called(t, 'pulls.list').map((c) => c.params.base), ['main']);
  const u = setup({ prs: byBase({ main: [other], 'feat/x': [SUB] }) });
  await u.go();
  assert.deepEqual(called(u, 'pulls.list').map((c) => c.params.base), ['main']);
});

test('a cycle of bases is followed once each: no base is updated twice in a run', async () => {
  const back = { number: 40, head: { ref: 'issue-16', sha: 'head16', repo: { full_name: 'kubed-io/x' } } };
  const into = { number: 41, head: { ref: 'issue-28', sha: 'head28', repo: { full_name: 'kubed-io/x' } } };
  const t = setup({ prs: byBase({ main: [FAMILY], 'issue-16': [into], 'issue-28': [back] }) });
  const rows = await t.go();
  assert.deepEqual(called(t, 'pulls.list').map((c) => c.params.base), ['main', 'issue-16', 'issue-28']);
  assert.deepEqual(rows.map((r) => `${r.base || 'main'}#${r.number}`), ['main#16', 'issue-16#41', 'issue-28#40']);
});

test("a workflow change on a followed family branch is a person's merge there too, asked once", async () => {
  const api = {
    'repos.compareCommitsWithBasehead': ({ basehead }) => (basehead === 'head28...issue-16'
      ? { ahead_by: 1, files: [{ filename: '.github/workflows/lint.yml', sha: 'ee31' }] } : { behind_by: 1, files: [] }),
    'issues.listComments': [], 'issues.createComment': {},
  };
  const t = setup({ prs: byBase({ main: [FAMILY], 'issue-16': [SUB] }), api });
  assert.deepEqual(await t.go(), [
    { number: 16, branch: 'issue-16', result: 'updated' },
    { number: 31, branch: 'issue-28', result: 'needs a person: .github/workflows/lint.yml (asked)', base: 'issue-16' },
  ]);
  assert.deepEqual(called(t, 'issues.createComment').map((c) => c.params.issue_number), [31]);
  assert.deepEqual(called(t, 'pulls.updateBranch').map((c) => c.params.pull_number), [16]);
});

test('the summary has a table for each base a run updated', () => {
  const md = pr.summaryOf('main', [{ number: 16, branch: 'issue-16', result: 'updated' }, { number: 31, branch: 'issue-28', result: 'updated', base: 'issue-16' }]);
  assert.match(md, /### Open PRs on `main`[\s\S]*\| #16 \| `issue-16` \| updated \|[\s\S]*### Open PRs on `issue-16`[\s\S]*\| #31 \| `issue-28` \| updated \|/);
});
