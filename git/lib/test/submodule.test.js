const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const submodule = require('../submodule');
const fake = require('./fake');

const REJECTED = (why) => ` ! [rejected]        HEAD -> master (${why})\nerror: failed to push some refs to 'https://github.com/kubed-io/x.wiki.git'\n`;

// a checkout with a wiki changed inside it; `pushes` are what each push answers, in turn
function setup(pushes) {
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
      if (line.startsWith('push')) {
        const [exitCode, stderr] = pushes.shift() || [0, ''];
        return { exitCode, stdout: '', stderr };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const waits = [];
  const go = () => submodule.push({
    github: fake.github({ 'users.getByUsername': { id: 235398881 } }), core: fake.core(), exec, root,
    subs: ['wiki'], message: 'docs: x', author: 'kubed-io', auth: {}, wait: async (ms) => waits.push(ms),
  });
  return { exec, waits, go };
}

// each try: fetch, rebase, push
const tries = (calls) => calls.filter((c) => /^(fetch|rebase|push)/.test(c)).map((c) => c.split(' ')[0]);

test('a push refused because the wiki moved again is fetched, rebased and pushed again, a second or few later', async () => {
  for (const why of ['fetch first', 'non-fast-forward']) {
    const t = setup([[1, REJECTED(why)]]);
    assert.deepEqual(await t.go(), ['wiki']);
    assert.deepEqual(tries(t.exec.calls), ['fetch', 'rebase', 'push', 'fetch', 'rebase', 'push']);
    assert.equal(t.waits.length, 1);
    assert.ok(t.waits[0] >= 1000 && t.waits[0] <= 3000);
  }
});

test('three refusals fail it, as one would before, for the caller to keep', async () => {
  const t = setup([[1, REJECTED('fetch first')], [1, REJECTED('fetch first')], [1, REJECTED('non-fast-forward')], [0, '']]);
  await assert.rejects(t.go(), /wiki: the push to master failed after 3 tries: .*non-fast-forward/);
  assert.equal(tries(t.exec.calls).filter((c) => c === 'push').length, 3);
  assert.equal(t.waits.length, 2);
});

test('any other failed push is not tried again', async () => {
  const t = setup([[128, "remote: Permission to kubed-io/x.wiki.git denied to kubed-io[bot].\nfatal: unable to access 'https://github.com/kubed-io/x.wiki.git/': The requested URL returned error: 403\n"], [0, '']]);
  await assert.rejects(t.go(), /wiki: the push to master failed: remote: Permission [\s\S]* 403/);
  assert.deepEqual(tries(t.exec.calls), ['fetch', 'rebase', 'push']);
  assert.deepEqual(t.waits, []);
});

test('a push that lands first time waits for nothing', async () => {
  const t = setup([]);
  assert.deepEqual(await t.go(), ['wiki']);
  assert.deepEqual(tries(t.exec.calls), ['fetch', 'rebase', 'push']);
  assert.deepEqual(t.waits, []);
});
