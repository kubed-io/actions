const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const parts = require('../parts');

const tmp = () => parts.dirOf({ RUNNER_TEMP: fs.mkdtempSync(path.join(os.tmpdir(), 'parts-')) }, 12);

test('a thread\'s directory is under the runner\'s temp, by number', () => {
  assert.equal(parts.dirOf({ RUNNER_TEMP: '/t' }, '12'), path.join('/t', 'issue-comment', '12'));
});

test('parts are numbered by arrival and read back in that order, trimmed, empty ones left out', () => {
  const dir = tmp();
  parts.open(dir, { comment_id: 5 });
  for (let i = 1; i <= 10; i += 1) parts.addPart(dir, i === 10 ? 'Land!' : 'issue-agent', i === 3 ? '  \n' : `\npart ${i}\n`);
  const names = fs.readdirSync(path.join(dir, 'parts')).sort();
  assert.equal(names[0], '01-issue-agent.md');
  assert.equal(names[9], '10-land.md');
  assert.deepEqual(parts.partsOf(dir), ['part 1', 'part 2', 'part 4', 'part 5', 'part 6', 'part 7', 'part 8', 'part 9', 'part 10']);
});

test('open starts the thread over: a second comment/start keeps nothing of the first', () => {
  const dir = tmp();
  parts.open(dir, { comment_id: 1 });
  parts.addPart(dir, 'a', 'old');
  parts.addSeen(dir, { key: 'k', through: 't1', id: '1' });
  parts.finalize(dir, 1);
  parts.open(dir, { comment_id: 2 });
  assert.deepEqual(parts.partsOf(dir), []);
  assert.deepEqual(parts.seenOf(dir), []);
  assert.equal(parts.isFinal(dir), false);
  assert.equal(parts.commentOf(dir).comment_id, 2);
});

test('one seen entry per session, in answer order; a later turn moves its own, never back', () => {
  const dir = tmp();
  parts.addSeen(dir, { key: 'plan', through: '2026-11-03T10:00:00Z', id: '1' }, 'a1');
  parts.addSeen(dir, { key: 'code', through: '2026-11-03T10:05:00Z', id: '2' }, 'a2');
  parts.addSeen(dir, { key: 'plan', through: '2026-11-03T10:07:00Z', id: '3' }, 'a3');
  parts.addSeen(dir, { key: 'code', through: '2026-11-03T09:00:00Z', id: '0' }, 'a4');
  parts.addSeen(dir, { key: 'none', through: '' });
  assert.deepEqual(parts.seenOf(dir), [
    { key: 'code', through: '2026-11-03T10:05:00Z', id: '2', answered: 'a2' },
    { key: 'plan', through: '2026-11-03T10:07:00Z', id: '3', answered: 'a3' },
  ]);
});

test('a missing directory reads as nothing', () => {
  const dir = tmp();
  assert.deepEqual(parts.partsOf(dir), []);
  assert.deepEqual(parts.seenOf(dir), []);
  assert.equal(parts.commentOf(dir), null);
  assert.equal(parts.isFinal(dir), false);
});
