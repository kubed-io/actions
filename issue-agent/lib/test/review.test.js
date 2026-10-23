const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const review = require('../review');
const state = require('../state');
const fake = require('./fake');

const LINES = { 'a.py': [10, 11, 12, 13, 20] };

test('a suggestion is fenced, with a fence longer than any backticks inside it', () => {
  assert.equal(review.commentBody({ body: 'Rename it.', suggestion: 'x = 1' }), 'Rename it.\n\n```suggestion\nx = 1\n```');
  const body = review.commentBody({ body: 'Fix the doc.', suggestion: 'see ```bash\nls\n```' });
  assert.ok(body.includes('````suggestion\n'));
  assert.ok(body.endsWith('\n````'));
  assert.equal(review.commentBody({ body: ' Just a note. ' }), 'Just a note.');
});

test('a comment sits on the diff only when every line of its range is a new-side line of one hunk', () => {
  assert.equal(review.onDiff({ path: 'a.py', line: 12 }, LINES), true);
  assert.equal(review.onDiff({ path: 'a.py', line: 13, start_line: 10 }, LINES), true);
  assert.equal(review.onDiff({ path: 'a.py', line: 20, start_line: 13 }, LINES), false);
  assert.equal(review.onDiff({ path: 'a.py', line: 15 }, LINES), false);
  assert.equal(review.onDiff({ path: 'b.py', line: 1 }, LINES), false);
  assert.equal(review.onDiff({ path: 'a.py', line: 10, start_line: 12 }, LINES), false);
});

test('a range goes to GitHub with start_line on the RIGHT; one line without it', () => {
  assert.deepEqual(review.toGithub({ path: 'a.py', line: 13, start_line: 10, body: 'b' }), { path: 'a.py', line: 13, side: 'RIGHT', body: 'b', start_line: 10, start_side: 'RIGHT' });
  assert.deepEqual(review.toGithub({ path: 'a.py', line: 12, body: 'b' }), { path: 'a.py', line: 12, side: 'RIGHT', body: 'b' });
});

function scene(comments, routes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ reply: 'Looks close.', notes: 'n', review: { comments } }));
  fs.writeFileSync(path.join(dir, 'diff.json'), JSON.stringify(LINES));
  Object.assign(process.env, {
    NUMBER: '81', STRUCTURED_FILE: path.join(dir, 's.json'), DIFF_FILE: path.join(dir, 'diff.json'), HEAD_SHA: 'abc123',
    COMMENT_ID: '555', PROMPT: '', REPLY: 'Looks close.', HEADER: '', SESSION_KEY: 'review-81', THROUGH: 't', THROUGH_ID: '9',
    RUN_URL: 'https://run', BLOB: '', SESSION_ID: '',
  });
  const github = fake.github({ 'pulls.createReview': { id: 77 }, 'issues.deleteComment': {}, ...routes });
  const core = fake.core();
  return { github, core, done: review.run({ github, context: fake.context(), core }) };
}

test('the reply is one COMMENT review on the commit read; off-diff comments go in its body; the placeholder goes', async () => {
  const { github, core, done } = scene([
    { path: 'a.py', line: 12, body: 'Name this.', suggestion: 'total = 0' },
    { path: 'a.py', line: 15, body: 'Unchanged line.' },
  ]);
  await done;
  const call = github.calls.find((c) => c.name === 'pulls.createReview').params;
  assert.equal(call.event, 'COMMENT');
  assert.equal(call.commit_id, 'abc123');
  assert.equal(call.comments.length, 1);
  assert.ok(call.comments[0].body.includes('```suggestion\ntotal = 0\n```'));
  assert.ok(call.body.startsWith(`${state.TAG}\nLooks close.\n\n**Outside the diff**`));
  assert.ok(call.body.includes('- **`a.py:15`**: Unchanged line.'));
  assert.deepEqual(state.readSeen(call.body), { key: 'review-81', through: 't', id: '9' });
  assert.equal(github.calls.find((c) => c.name === 'issues.deleteComment').params.comment_id, 555);
  assert.equal(core.outputs.posted, 'true');
  assert.equal(core.outputs.review_id, '77');
});

test('a review GitHub refuses goes again with every comment in its body', async () => {
  let first = true;
  const { github, core, done } = scene([{ path: 'a.py', line: 12, body: 'Name this.' }], {
    'pulls.createReview': (p) => {
      if (first) { first = false; return new Error('Unprocessable'); }
      return { id: 78, comments: p.comments };
    },
  });
  await done;
  const calls = github.calls.filter((c) => c.name === 'pulls.createReview');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params.comments, []);
  assert.ok(calls[1].params.body.includes('- **`a.py:12`**: Name this.'));
  assert.equal(core.outputs.posted, 'true');
});

test('refused twice, nothing is posted here and the placeholder stays for the reply step', async () => {
  const { github, core, done } = scene([{ path: 'a.py', line: 12, body: 'x' }], { 'pulls.createReview': new Error('no') });
  await done;
  assert.ok(!github.calls.some((c) => c.name === 'issues.deleteComment'));
  assert.equal(core.outputs.posted, 'false');
});

test('no comments, no review: the reply goes as a comment', async () => {
  const { github, core, done } = scene([]);
  await done;
  assert.ok(!github.calls.some((c) => c.name === 'pulls.createReview'));
  assert.equal(core.outputs.posted, 'false');
});
