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

function scene(comments, routes = {}, env = {}, head = 'abc123') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ reply: 'Looks close.', notes: 'n', review: { comments } }));
  fs.writeFileSync(path.join(dir, 'diff.json'), JSON.stringify(LINES));
  Object.assign(process.env, {
    NUMBER: '81', STRUCTURED_FILE: path.join(dir, 's.json'), DIFF_FILE: path.join(dir, 'diff.json'), HEAD_SHA: 'abc123',
    COMMENT_ID: '555', PROMPT: '', REPLY: 'Looks close.', HEADER: '', SESSION_KEY: 'review-81', THROUGH: 't', THROUGH_ID: '9',
    RUN_URL: 'https://run', BLOB: '', SESSION_ID: '', LIVE: '', ...env,
  });
  const github = fake.github({ 'pulls.createReview': { id: 77 }, 'issues.deleteComment': {}, ...routes });
  const core = fake.core();
  const exec = fake.exec(head);
  return { github, core, exec, done: review.run({ github, context: fake.context({ runId: 7 }), core, exec }) };
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

test('live: the review deletes the placeholder where n8n moved it, and its seen marker covers what was handed over', async () => {
  const owner = { login: 'kferrone', id: 4399427, type: 'User' };
  const app = { login: 'kubed-io[bot]', id: 235398881, type: 'Bot' };
  const inbox = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'inbox.jsonl');
  const text = `${JSON.stringify({ kind: 'message', comment_kind: 'comment', comment_id: 11 })}\n`;
  fs.writeFileSync(inbox, text);
  fs.writeFileSync(`${inbox}.cursor`, String(text.length));
  const { github, done } = scene([{ path: 'a.py', line: 12, body: 'Name this.' }], {
    'issues.listComments': [
      { id: 11, user: owner, created_at: '2026-10-29T10:05:00Z', body: 'and the tests?' },
      { id: 60, user: app, created_at: '2026-10-29T10:06:00Z', body: `${state.TAG}\n${state.placeholderMarker(7)}\nWorking on it…` },
    ],
    'pulls.listReviews': [],
    'pulls.listReviewComments': [],
  }, { LIVE: 'true', IS_PR: 'true', THROUGH: '2026-10-29T10:00:00Z', TRUSTED_IDS: '4399427', TRUSTED_BOTS: '', CLAUDE_CHANNEL_INBOX: inbox });
  await done;
  assert.equal(github.calls.find((c) => c.name === 'issues.deleteComment').params.comment_id, 60);
  const body = github.calls.find((c) => c.name === 'pulls.createReview').params.body;
  assert.deepEqual(state.readSeen(body), { key: 'review-81', through: '2026-10-29T10:05:00Z', id: '11' });
});

test('live with no placeholder left: the review deletes nothing', async () => {
  const { github, core, done } = scene([{ path: 'a.py', line: 12, body: 'x' }], { 'issues.listComments': [] }, { LIVE: 'true', IS_PR: 'true', CLAUDE_CHANNEL_INBOX: '/nowhere/inbox.jsonl' });
  await done;
  assert.ok(!github.calls.some((c) => c.name === 'issues.deleteComment'));
  assert.equal(core.outputs.posted, 'true');
});

test('the checkout still at the head Gather read: the review is on it, nothing is compared', async () => {
  const { github, core, exec, done } = scene([{ path: 'a.py', line: 12, body: 'x' }]);
  await done;
  assert.deepEqual(exec.calls, [['git', 'rev-parse', 'HEAD']]);
  assert.ok(!github.calls.some((c) => c.name === 'repos.compareCommitsWithBasehead' || c.name === 'pulls.get'));
  assert.equal(github.calls.find((c) => c.name === 'pulls.createReview').params.commit_id, 'abc123');
  assert.equal(core.outputs.reviewed_sha, 'abc123');
});

// the push brought in mid-turn: a.py's hunk now starts at 30
const MOVED = {
  'pulls.get': { base: { ref: 'main' }, head: { sha: 'def456' } },
  'repos.compareCommitsWithBasehead': { files: [{ filename: 'a.py', status: 'modified', patch: '@@ -28,2 +30,3 @@\n ctx\n+new\n ctx2' }] },
};

test('the checkout moved during the turn: the review is on the commit it ended on, its lines from that commit\'s diff', async () => {
  const { github, core, done } = scene([
    { path: 'a.py', line: 31, body: 'On the new line.' },
    { path: 'a.py', line: 12, body: 'Off the diff now.' },
  ], MOVED, {}, 'def456');
  await done;
  assert.equal(github.calls.find((c) => c.name === 'repos.compareCommitsWithBasehead').params.basehead, 'main...def456');
  const call = github.calls.find((c) => c.name === 'pulls.createReview').params;
  assert.equal(call.commit_id, 'def456');
  assert.deepEqual(call.comments.map((c) => c.line), [31]);
  assert.ok(call.body.includes('- **`a.py:12`**: Off the diff now.'));
  assert.equal(core.outputs.reviewed_sha, 'def456');
});

test('moved with no line comments: the reply goes as a comment, and the commit it judged is still the new one', async () => {
  const { github, core, done } = scene([], MOVED, {}, 'def456');
  await done;
  assert.ok(!github.calls.some((c) => c.name === 'pulls.createReview' || c.name === 'repos.compareCommitsWithBasehead'));
  assert.equal(core.outputs.reviewed_sha, 'def456');
});

test('moved, and its diff cannot be read: every comment goes in the body of a review on the new commit', async () => {
  const { github, core, done } = scene([{ path: 'a.py', line: 31, body: 'x' }], { ...MOVED, 'repos.compareCommitsWithBasehead': () => fake.notFound() }, {}, 'def456');
  await done;
  const call = github.calls.find((c) => c.name === 'pulls.createReview').params;
  assert.equal(call.commit_id, 'def456');
  assert.deepEqual(call.comments, []);
  assert.ok(core.notices.some((m) => /def456/.test(m)));
});
