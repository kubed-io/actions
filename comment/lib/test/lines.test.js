const test = require('node:test');
const assert = require('node:assert/strict');
const lines = require('../lines');

test('a suggestion is fenced, with a fence longer than any backticks inside it', () => {
  assert.equal(lines.commentBody({ body: 'Rename it.', suggestion: 'x = 1' }), 'Rename it.\n\n```suggestion\nx = 1\n```');
  const body = lines.commentBody({ body: 'Fix the doc.', suggestion: 'see ```bash\nls\n```' });
  assert.ok(body.includes('````suggestion\n'));
  assert.ok(body.endsWith('\n````'));
  assert.equal(lines.commentBody({ body: ' Just a note. ' }), 'Just a note.');
});

test('a range goes to GitHub with start_line on the RIGHT; one line without it', () => {
  assert.deepEqual(lines.toGithub({ path: 'a.py', line: 13, start_line: 10, body: 'b' }), { path: 'a.py', line: 13, side: 'RIGHT', body: 'b', start_line: 10, start_side: 'RIGHT' });
  assert.deepEqual(lines.toGithub({ path: 'a.py', line: 12, body: 'b' }), { path: 'a.py', line: 12, side: 'RIGHT', body: 'b' });
});

test('comments not under a review are listed by where they are', () => {
  assert.equal(lines.listed([]), '');
  assert.equal(lines.listed([{ path: 'a.py', line: 15, body: 'Off it.' }, { path: 'b.py', start_line: 2, line: 4, body: 'A range.' }]),
    '**Outside the diff**\n\n- **`a.py:15`**: Off it.\n- **`b.py:2-4`**: A range.');
});
