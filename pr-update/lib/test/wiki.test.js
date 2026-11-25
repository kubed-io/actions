// The wiki merge against real repositories: a bare wiki with master and a branch per PR, a
// bare origin whose branches point `docs` at them, and the job's checkout. Only GitHub's API is
// a stand-in. A passage both sides changed is merged with conflict markers onto the PR's own
// wiki branch and handed to its agent; nothing else in the wiki moves (quick-mcp #41).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const pr = require('../update');
const fake = require('../../../git/lib/test/fake');

// no global or system config: no signing, no conflict style, no hooks of the host's
const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
};
const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' }).trim();
const exec = {
  getExecOutput: async (cmd, args, { env } = {}) => {
    const r = spawnSync(cmd, args, { env: env || ENV, encoding: 'utf8' });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
  },
};

const DESIGN = ['# Design', '', '## Scope', '', 'The flow delivers material.', '', '## Order', '', 'Steps run in order.', '', '## Open', '', 'Nothing yet.', ''];
const edit = (lines, from, to) => lines.map((l) => (l === from ? to : l)).join('\n');

// a commit in a work tree: `files` written and committed, nothing else (the code's `docs` is a
// gitlink with no checkout, which `add -A` would delete)
function commit(dir, files, message) {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  sh(dir, 'add', '--', ...Object.keys(files));
  sh(dir, 'commit', '-q', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD');
}

// the wiki's master; the base's wiki branch (issue-16) and the PR's (issue-21), each one commit
// on master; origin's main, issue-16 and issue-21 pointing `docs` at each; the checkout on issue-16
function repos({ base, mine, code = {} }) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-update-wiki-'));
  const wiki = path.join(top, 'wiki.git');
  const origin = path.join(top, 'origin.git');
  sh(top, 'init', '-q', '--bare', '-b', 'master', wiki);
  sh(top, 'init', '-q', '--bare', '-b', 'main', origin);

  const w = path.join(top, 'wiki');
  sh(top, 'init', '-q', '-b', 'master', w);
  const w0 = commit(w, { 'design.md': DESIGN.join('\n'), 'home.md': '# Home\n' }, 'the design');
  sh(w, 'checkout', '-q', '-b', 'issue-16');
  const w1 = commit(w, base, "the base's edit");
  sh(w, 'checkout', '-q', '-b', 'issue-21', w0);
  const w2 = commit(w, mine, "the PR's edit");
  sh(w, 'push', '-q', wiki, 'master', 'issue-16', 'issue-21');

  const c = path.join(top, 'code');
  sh(top, 'init', '-q', '-b', 'main', c);
  fs.writeFileSync(path.join(c, '.gitmodules'), `[submodule "docs"]\n\tpath = docs\n\turl = ${wiki}\n`);
  fs.writeFileSync(path.join(c, 'README.md'), '# x\n');
  sh(c, 'add', '.gitmodules', 'README.md');
  const pin = (sha) => sh(c, 'update-index', '--add', '--cacheinfo', `160000,${sha},docs`);
  pin(w0);
  sh(c, 'commit', '-q', '-m', 'main');
  sh(c, 'checkout', '-q', '-b', 'issue-16');
  pin(w1);
  commit(c, { 'src/base.txt': 'base\n', ...(code.base || {}) }, 'issue-16 moves the pin');
  sh(c, 'checkout', '-q', '-b', 'issue-21', 'main');
  pin(w2);
  const head = commit(c, { 'src/mine.txt': 'mine\n', ...(code.mine || {}) }, 'issue-21 moves the pin');
  sh(c, 'push', '-q', origin, 'main', 'issue-16', 'issue-21');

  const checkout = path.join(top, 'checkout');
  sh(top, 'clone', '-q', '-b', 'issue-16', origin, checkout);
  return { wiki, checkout, w0, w1, w2, head };
}

// GitHub: PR #41 (issue-21 into issue-16), which update-branch refuses; the tree it builds is the
// checkout's index, as GitHub's would be from the blobs sent
function api(r, over = {}) {
  const PR41 = { number: 41, head: { ref: 'issue-21', sha: r.head, repo: { full_name: 'kubed-io/x' } } };
  const github = fake.github({
    'pulls.list': ({ base }) => (base === 'issue-16' ? [PR41] : []),
    'repos.compareCommitsWithBasehead': { behind_by: 1, files: [] },
    'pulls.updateBranch': Object.assign(new Error('merge conflict between base and head'), { status: 422 }),
    'git.createBlob': { sha: 'sent' },
    'git.createTree': () => ({ sha: sh(r.checkout, 'write-tree') }),
    'git.createCommit': { sha: 'merge41' },
    'git.updateRef': {},
    'repos.createDispatchEvent': {},
    ...over,
  });
  github.paginate = async (fn, params) => (await fn(params)).data;
  return github;
}

const go = (r, github, env = ENV) => pr.update({ github, core: fake.core(), exec, owner: 'kubed-io', repo: 'x', base: 'issue-16', root: r.checkout, env });
// a run at another time: its clock is not the merge's
const at = (secs) => ({ ...ENV, GIT_AUTHOR_DATE: `@${secs} +0000`, GIT_COMMITTER_DATE: `@${secs} +0000` });
const called = (github, name) => github.calls.filter((c) => c.name === name);
const refs = (wiki) => sh(wiki, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n');
const ref = (wiki, name) => sh(wiki, 'rev-parse', `refs/heads/${name}`);
const show = (wiki, rev, f) => sh(wiki, 'show', `${rev}:${f}`);
const pointer = (github) => called(github, 'git.createTree')[0].params.tree.find((e) => e.path === 'docs');

test("changes to different passages merge cleanly onto the PR's wiki branch, and its agent is not woken", async () => {
  const r = repos({
    base: { 'design.md': edit(DESIGN, 'The flow delivers material.', 'The flow delivers material and bundles.') },
    mine: { 'design.md': edit(DESIGN, 'Nothing yet.', 'Whether a bundle is signed.') },
  });
  const github = api(r);
  assert.deepEqual(await go(r, github), [{ number: 41, branch: 'issue-21', result: 'merged & resolved: pointer' }]);
  const merged = ref(r.wiki, 'issue-21');
  assert.equal(sh(r.wiki, 'rev-parse', `${merged}^1`, `${merged}^2`), `${r.w2}\n${r.w1}`);
  const text = show(r.wiki, merged, 'design.md');
  assert.match(text, /The flow delivers material and bundles\./);
  assert.match(text, /Whether a bundle is signed\./);
  assert.doesNotMatch(text, /^(<{7}|={7}|>{7})/m);
  assert.equal(pointer(github).sha, merged);
  assert.deepEqual(called(github, 'repos.createDispatchEvent'), []);
});

test("a passage both sides changed is merged with conflict markers onto the PR's wiki branch, and its agent is told the file", async () => {
  const r = repos({
    base: { 'design.md': edit(edit(DESIGN, 'The flow delivers material.', 'The flow delivers material and bundles.').split('\n'), 'Steps run in order.', 'Steps run in order, retried once.') },
    mine: { 'design.md': edit(DESIGN, 'The flow delivers material.', 'The flow delivers material to plugins.'), 'home.md': '# Home\n\nSee the design.\n' },
  });
  const github = api(r);
  assert.deepEqual(await go(r, github), [{ number: 41, branch: 'issue-21', result: 'merged & resolved: pointer (wiki conflicts: docs/design.md) (dispatched)' }]);

  const merged = ref(r.wiki, 'issue-21');
  assert.equal(sh(r.wiki, 'rev-parse', `${merged}^1`, `${merged}^2`), `${r.w2}\n${r.w1}`);
  // both sides of the passage, plainly, each labelled with its wiki branch; the base's other
  // edit and the PR's other file merged as usual
  const text = show(r.wiki, merged, 'design.md');
  assert.match(text, /^<{7} wiki\/issue-21\nThe flow delivers material to plugins\.\n={7}\nThe flow delivers material and bundles\.\n>{7} wiki\/issue-16$/m);
  assert.match(text, /^Steps run in order, retried once\.$/m);
  assert.equal(show(r.wiki, merged, 'home.md'), '# Home\n\nSee the design.');

  // the code merge completes, the pointer at that commit
  assert.equal(pointer(github).sha, merged);
  assert.match(called(github, 'git.createCommit')[0].params.message, /^Merge issue-16 into issue-21: the docs pointer at a merge of both sides' wiki, conflicted in docs\/design\.md$/);
  assert.equal(called(github, 'git.updateRef')[0].params.ref, 'heads/issue-21');
  assert.deepEqual(called(github, 'repos.createDispatchEvent').map((c) => c.params), [{ owner: 'kubed-io', repo: 'x', event_type: 'agent-code',
    client_payload: { pull_request: 41, reason: 'conflict', base: 'issue-16', paths: 'docs/design.md', wiki: 'docs/design.md' } }]);
  // the labels were the run's own refs, gone afterwards
  assert.equal(sh(r.checkout, 'for-each-ref', 'refs/wiki/'), '');
});

test("the wiki's master and the base's wiki branch are untouched: only the PR's wiki branch moves", async () => {
  const r = repos({
    base: { 'design.md': edit(DESIGN, 'Nothing yet.', 'Bundles are signed.') },
    mine: { 'design.md': edit(DESIGN, 'Nothing yet.', 'Bundles are not signed.') },
  });
  const before = refs(r.wiki);
  await go(r, api(r));
  const after = refs(r.wiki);
  assert.deepEqual(after.filter((l) => !l.startsWith('refs/heads/issue-21 ')), before.filter((l) => !l.startsWith('refs/heads/issue-21 ')));
  assert.equal(ref(r.wiki, 'master'), r.w0);
  assert.equal(ref(r.wiki, 'issue-16'), r.w1);
  assert.notEqual(ref(r.wiki, 'issue-21'), r.w2);
});

test('a wiki conflict beside a code conflict pushes nothing: the merge is aborted and both go to the agent', async () => {
  const r = repos({
    base: { 'design.md': edit(DESIGN, 'Nothing yet.', 'Bundles are signed.') },
    mine: { 'design.md': edit(DESIGN, 'Nothing yet.', 'Bundles are not signed.') },
    code: { base: { 'src/shared.txt': 'base\n' }, mine: { 'src/shared.txt': 'mine\n' } },
  });
  const github = api(r);
  assert.deepEqual(await go(r, github), [{ number: 41, branch: 'issue-21', result: 'needs its agent: docs, src/shared.txt (dispatched)' }]);
  assert.equal(ref(r.wiki, 'issue-21'), r.w2);
  assert.deepEqual(called(github, 'git.createCommit'), []);
  assert.equal(called(github, 'repos.createDispatchEvent')[0].params.client_payload.paths, 'docs, src/shared.txt');
});

test("a conflict that is not text (a file one side deleted) is no marker merge: the pointer is the agent's, as before", async () => {
  const r = repos({
    base: { 'home.md': '# Home\n\nNew.\n' },
    mine: { 'design.md': edit(DESIGN, 'Nothing yet.', 'Gone soon.') },
  });
  // the PR's side deletes home.md, which the base changed
  const w = path.join(path.dirname(r.wiki), 'wiki');
  sh(w, 'checkout', '-q', 'issue-21');
  sh(w, 'rm', '-q', 'home.md');
  sh(w, 'commit', '-q', '-m', 'drop home');
  sh(w, 'push', '-q', r.wiki, 'issue-21');
  const w2 = sh(w, 'rev-parse', 'HEAD');
  const c = path.join(path.dirname(r.wiki), 'code');
  sh(c, 'checkout', '-q', 'issue-21');
  sh(c, 'update-index', '--cacheinfo', `160000,${w2},docs`);
  sh(c, 'commit', '-q', '-m', 'pin');
  sh(c, 'push', '-q', path.join(path.dirname(r.wiki), 'origin.git'), 'issue-21');
  r.head = sh(c, 'rev-parse', 'HEAD');
  const github = api(r);
  assert.deepEqual(await go(r, github), [{ number: 41, branch: 'issue-21', result: 'needs its agent: docs (dispatched)' }]);
  assert.equal(ref(r.wiki, 'issue-21'), w2);
});

test('a run whose code branch moved under it is retried by the next: the same wiki merge, so its push is no change', async () => {
  const r = repos({
    base: { 'design.md': edit(DESIGN, 'Nothing yet.', 'Bundles are signed.') },
    mine: { 'design.md': edit(DESIGN, 'Nothing yet.', 'Bundles are not signed.') },
  });
  const moved = api(r, { 'git.updateRef': Object.assign(new Error('Update is not a fast forward'), { status: 422 }) });
  assert.deepEqual(await go(r, moved, at(1900000000)), [{ number: 41, branch: 'issue-21', result: 'moved during the update; next merge retries' }]);
  const first = ref(r.wiki, 'issue-21');
  assert.notEqual(first, r.w2);
  const github = api(r);
  assert.deepEqual(await go(r, github, at(1900000600)), [{ number: 41, branch: 'issue-21', result: 'merged & resolved: pointer (wiki conflicts: docs/design.md) (dispatched)' }]);
  assert.equal(ref(r.wiki, 'issue-21'), first);
  assert.equal(pointer(github).sha, first);
});
