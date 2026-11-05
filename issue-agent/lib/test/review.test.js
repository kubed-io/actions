const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const review = require('../review');
const parts = require('../../../comment/lib/parts');
const fake = require('./fake');

const LINES = { 'a.py': [10, 11, 12, 13, 20] };

test('a comment sits on the diff only when every line of its range is a new-side line of one hunk', () => {
  assert.equal(review.onDiff({ path: 'a.py', line: 12 }, LINES), true);
  assert.equal(review.onDiff({ path: 'a.py', line: 13, start_line: 10 }, LINES), true);
  assert.equal(review.onDiff({ path: 'a.py', line: 20, start_line: 13 }, LINES), false);
  assert.equal(review.onDiff({ path: 'a.py', line: 15 }, LINES), false);
  assert.equal(review.onDiff({ path: 'b.py', line: 1 }, LINES), false);
  assert.equal(review.onDiff({ path: 'a.py', line: 10, start_line: 12 }, LINES), false);
});

// the line comments go to comment/end, split by the diff: nothing is posted here
function scene(comments, routes = {}, head = 'abc123') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ reply: 'Looks close.', notes: 'n', review: { comments } }));
  fs.writeFileSync(path.join(dir, 'diff.json'), JSON.stringify(LINES));
  const env = {
    RUNNER_TEMP: dir, NUMBER: '81', STRUCTURED_FILE: path.join(dir, 's.json'), DIFF_FILE: path.join(dir, 'diff.json'), HEAD_SHA: 'abc123',
  };
  const github = fake.github(routes);
  const core = fake.core();
  const exec = fake.exec(head);
  const done = review.run({ github, context: fake.context({ runId: 7 }), core, exec, env });
  const handed = () => parts.linesOf(parts.dirOf(env, 81));
  return { github, core, exec, done, handed };
}

const posted = (github) => github.calls.filter((c) => !c.name.startsWith('repos.compare') && c.name !== 'pulls.get');

test('on the commit read: comments on the diff and off it go to comment/end, and nothing is posted here', async () => {
  const { github, core, exec, handed, done } = scene([
    { path: 'a.py', line: 12, body: 'Name this.', suggestion: 'total = 0' },
    { path: 'a.py', line: 15, body: 'Unchanged line.' },
  ]);
  await done;
  assert.deepEqual(handed(), {
    commit_id: 'abc123',
    inline: [{ path: 'a.py', line: 12, body: 'Name this.', suggestion: 'total = 0' }],
    outside: [{ path: 'a.py', line: 15, body: 'Unchanged line.' }],
  });
  assert.deepEqual(posted(github), []);
  assert.deepEqual(exec.calls, [['git', 'rev-parse', 'HEAD']]);
  assert.equal(core.outputs.reviewed_sha, 'abc123');
});

test('no line comments: nothing handed on', async () => {
  const { handed, done } = scene([{ path: 'a.py', line: 12, body: '  ' }]);
  await done;
  assert.equal(handed(), null);
});

// the push brought in mid-turn: a.py's hunk now starts at 30
const MOVED = {
  'pulls.get': { base: { ref: 'main' }, head: { sha: 'def456' } },
  'repos.compareCommitsWithBasehead': { files: [{ filename: 'a.py', status: 'modified', patch: '@@ -28,2 +30,3 @@\n ctx\n+new\n ctx2' }] },
};

test("the checkout moved during the turn: the comments are on the commit it ended on, placed by that commit's diff", async () => {
  const { github, core, handed, done } = scene([
    { path: 'a.py', line: 31, body: 'On the new line.' },
    { path: 'a.py', line: 12, body: 'Off the diff now.' },
  ], MOVED, 'def456');
  await done;
  assert.equal(github.calls.find((c) => c.name === 'repos.compareCommitsWithBasehead').params.basehead, 'main...def456');
  const got = handed();
  assert.equal(got.commit_id, 'def456');
  assert.deepEqual(got.inline.map((c) => c.line), [31]);
  assert.deepEqual(got.outside.map((c) => c.line), [12]);
  assert.equal(core.outputs.reviewed_sha, 'def456');
});

test('moved, and its diff cannot be read: every comment is off the diff', async () => {
  const { core, handed, done } = scene([{ path: 'a.py', line: 31, body: 'x' }], { ...MOVED, 'repos.compareCommitsWithBasehead': () => fake.notFound() }, 'def456');
  await done;
  assert.deepEqual(handed().inline, []);
  assert.equal(handed().outside.length, 1);
  assert.ok(core.notices.some((m) => /def456/.test(m)));
});
