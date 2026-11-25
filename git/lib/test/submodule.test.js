const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const submodule = require('../submodule');
const fake = require('./fake');

const REJECTED = (why) => ` ! [rejected]        HEAD -> master (${why})\nerror: failed to push some refs to 'https://github.com/kubed-io/x.wiki.git'\n`;

// a checkout with a wiki changed inside it; `pushes` are what each push answers, in turn
// `missing`: the refs a fetch finds nothing at; `startOf` names the commit a new wiki branch starts from;
// `diverged`: the fetched head is not in HEAD's history (the real merges are submodule.repos.test.js's)
function setup(pushes, { target, defaultBranch, fetchFails = false, missing = [], flaky = false, startOf, diverged = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-submodule-'));
  fs.mkdirSync(path.join(root, 'wiki'));
  fs.writeFileSync(path.join(root, 'wiki/.git'), 'gitdir: x');
  const calls = [];
  const exec = {
    calls,
    getExecOutput: async (cmd, args) => {
      const line = args.slice(2).join(' ');
      calls.push(line);
      if (line.startsWith('status')) return { exitCode: 0, stdout: ' M Home.md\n', stderr: '' };
      if (line.startsWith('fetch') && flaky) return { exitCode: 128, stdout: '', stderr: "fatal: unable to access 'https://github.com/kubed-io/x.wiki.git/': Could not resolve host: github.com\n" };
      if (line.startsWith('fetch') && (fetchFails || missing.includes(line.split(' ').pop()))) return { exitCode: 128, stdout: '', stderr: "fatal: couldn't find remote ref issue-137\n" };
      if (line === 'rev-parse HEAD') return { exitCode: 0, stdout: 'c0ffee\n', stderr: '' };
      if (line.startsWith('merge-base --is-ancestor') && diverged) return { exitCode: 1, stdout: '', stderr: '' };
      if (line.startsWith('push')) {
        const [exitCode, stderr] = pushes.shift() || [0, ''];
        return { exitCode, stdout: '', stderr };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const waits = [];
  const go = () => submodule.push({
    github: fake.github({ 'users.getByUsername': { id: 235398881 } }), exec, root,
    subs: ['wiki'], message: 'docs: x', author: 'kubed-io', auth: {}, target, defaultBranch, startOf, wait: async (ms) => waits.push(ms), core: t.core,
  });
  const t = { exec, waits, go, core: fake.core() };
  return t;
}

// each try: fetch, a fast-forward or a merge, push
const MOVES = /^(fetch|merge|cherry-pick|rebase|push)/;
const tries = (calls) => calls.filter((c) => MOVES.test(c)).map((c) => c.split(' ')[0]);

test('a push refused because the wiki moved again is fetched, merged and pushed again, a second or few later', async () => {
  for (const why of ['fetch first', 'non-fast-forward']) {
    const t = setup([[1, REJECTED(why)]], { diverged: true });
    assert.deepEqual(await t.go(), ['wiki']);
    assert.deepEqual(tries(t.exec.calls), ['fetch', 'merge-base', 'merge', 'push', 'fetch', 'merge-base', 'merge', 'push']);
    assert.ok(t.exec.calls.includes('merge --no-edit FETCH_HEAD'), 'a merge with no -X: nothing picks a side');
    assert.equal(t.waits.length, 1);
    assert.ok(t.waits[0] >= 1000 && t.waits[0] <= 3000);
  }
});

test('three refusals fail it, as one would before, for the caller to keep', async () => {
  const t = setup([[1, REJECTED('fetch first')], [1, REJECTED('fetch first')], [1, REJECTED('non-fast-forward')], [0, '']]);
  await assert.rejects(t.go(), /wiki: the push to master failed after 3 tries: .*non-fast-forward/);
  assert.equal(tries(t.exec.calls).filter((c) => c === 'push').length, 3);
  assert.equal(t.waits.length, 2);
  // the commit undone, its changes left uncommitted for keep_to
  assert.deepEqual(t.exec.calls.filter((c) => c.startsWith('reset')), ['reset -q --hard c0ffee', 'reset -q c0ffee']);
});

test('any other failed push is not tried again', async () => {
  const t = setup([[128, "remote: Permission to kubed-io/x.wiki.git denied to kubed-io[bot].\nfatal: unable to access 'https://github.com/kubed-io/x.wiki.git/': The requested URL returned error: 403\n"], [0, '']]);
  await assert.rejects(t.go(), /wiki: the push to master failed: remote: Permission [\s\S]* 403/);
  assert.deepEqual(tries(t.exec.calls), ['fetch', 'merge-base', 'push']);
  assert.deepEqual(t.waits, []);
});

test('a push that lands first time waits for nothing: a remote head HEAD already holds is a fast-forward', async () => {
  const t = setup([]);
  assert.deepEqual(await t.go(), ['wiki']);
  assert.deepEqual(tries(t.exec.calls), ['fetch', 'merge-base', 'push']);
  assert.deepEqual(t.waits, []);
});

// where each push went
const pushedTo = (calls) => calls.filter((c) => c.startsWith('push')).map((c) => c.split(' ').pop());

test("a branch's wiki commit goes to the wiki branch of the same name, never to master", async () => {
  const t = setup([], { target: 'issue-137', defaultBranch: 'main' });
  assert.deepEqual(await t.go(), ['wiki']);
  assert.deepEqual(pushedTo(t.exec.calls), ['HEAD:refs/heads/issue-137']);
  assert.ok(t.exec.calls.some((c) => c === 'fetch --no-tags origin issue-137'));
  assert.ok(t.exec.calls.some((c) => c === 'checkout -B issue-137'));
});

test("the default branch's wiki commit goes to the wiki's master, as before", async () => {
  const t = setup([], { target: 'main', defaultBranch: 'main' });
  await t.go();
  assert.deepEqual(pushedTo(t.exec.calls), ['HEAD:refs/heads/master']);
});

test("a branch's first wiki commit starts its wiki branch from the pin: nothing to catch up with", async () => {
  const t = setup([], { target: 'issue-137', defaultBranch: 'main', fetchFails: true });
  assert.deepEqual(await t.go(), ['wiki']);
  assert.deepEqual(tries(t.exec.calls), ['fetch', 'push']);
  assert.deepEqual(pushedTo(t.exec.calls), ['HEAD:refs/heads/issue-137']);
});

// a sub-issue's wiki branch starts where its family's code branch points the wiki, not where
// the checkout does (quick-mcp #31: issue-28's started at master, without issue-16's pin)
test("a branch's first wiki commit starts from the base's pin: this commit alone, cherry-picked onto it", async () => {
  const asked = [];
  const t = setup([], { target: 'issue-28', defaultBranch: 'main', missing: ['issue-28'], diverged: true, startOf: async (sub) => { asked.push(sub); return 'fam75e4'; } });
  assert.deepEqual(await t.go(), ['wiki']);
  assert.deepEqual(asked, ['wiki']);
  const moves = t.exec.calls.filter((c) => MOVES.test(c) || c.startsWith('checkout -q'));
  assert.deepEqual(moves, [
    'fetch --no-tags origin issue-28', 'fetch --no-tags origin fam75e4', 'merge-base --is-ancestor FETCH_HEAD HEAD',
    'checkout -q -B issue-28 FETCH_HEAD', 'cherry-pick --keep-redundant-commits c0ffee', 'push origin HEAD:refs/heads/issue-28',
  ]);
});

test("a base's pin the checkout's pin already holds needs nothing: this commit stays where it is", async () => {
  const t = setup([], { target: 'issue-28', defaultBranch: 'main', missing: ['issue-28'], startOf: async () => 'fam75e4' });
  assert.deepEqual(await t.go(), ['wiki']);
  assert.deepEqual(tries(t.exec.calls), ['fetch', 'fetch', 'merge-base', 'push']);
});

test('a wiki branch that already exists is left alone: merged, never moved to the base\'s pin', async () => {
  const asked = [];
  const t = setup([], { target: 'issue-28', defaultBranch: 'main', diverged: true, startOf: async (sub) => { asked.push(sub); return 'fam75e4'; } });
  await t.go();
  assert.deepEqual(asked, []);
  assert.deepEqual(tries(t.exec.calls), ['fetch', 'merge-base', 'merge', 'push']);
});

test("a base with no pin starts the wiki branch from the checkout's pin, as before", async () => {
  const t = setup([], { target: 'issue-28', defaultBranch: 'main', missing: ['issue-28'], startOf: async () => '' });
  await t.go();
  assert.deepEqual(tries(t.exec.calls), ['fetch', 'push']);
});

test("a base pin that cannot be fetched starts from the checkout's pin, and says so", async () => {
  const t = setup([], { target: 'issue-28', defaultBranch: 'main', missing: ['issue-28', 'fam75e4'], startOf: async () => 'fam75e4' });
  assert.deepEqual(await t.go(), ['wiki']);
  assert.deepEqual(tries(t.exec.calls), ['fetch', 'fetch', 'push']);
  assert.ok(t.core.notices.some((m) => /wiki: issue-28 starts from the checkout's pin: fam75e4 could not be fetched/.test(m)));
});

test('a fetch that failed for any other reason is no missing branch: nothing starts it from the base\'s pin', async () => {
  const asked = [];
  const t = setup([], { target: 'issue-28', defaultBranch: 'main', flaky: true, startOf: async (sub) => { asked.push(sub); return 'fam75e4'; } });
  await t.go();
  assert.deepEqual(asked, []);
  assert.ok(!t.exec.calls.some((c) => /^(merge|cherry-pick|checkout -q)/.test(c)));
});
