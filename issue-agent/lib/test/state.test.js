const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../state');
const util = require('../util');

test('seen markers round-trip, and the tag marks the action\'s comments', () => {
  const seen = { key: 'issue-12', through: '2026-10-08T14:02:00Z', id: '7' };
  assert.deepEqual(state.readSeen(`${state.TAG}\nhi\n${state.seenMarker(seen)}`), seen);
  assert.ok(state.isAgent(`${state.TAG}\nhi`));
  assert.ok(!state.isAgent('hi'));
});

test('list and fill', () => {
  assert.deepEqual(util.list(' a, b ,,c '), ['a', 'b', 'c']);
  assert.deepEqual(util.list(''), []);
  assert.equal(util.fill('issue-{number}-{slug}', { number: 12, slug: 'rec' }), 'issue-12-rec');
  assert.equal(util.fill('{missing}', {}), '{missing}');
});

test('a value holding --> cannot close its seen marker', () => {
  const marker = state.seenMarker({ key: 'a-->b', through: 't', id: '1' });
  assert.equal(marker.indexOf('-->'), marker.length - 3);
  assert.deepEqual(state.readSeen(marker), { key: 'a-->b', through: 't', id: '1' });
});

test('an unclosed seen marker before a real one does not swallow it', () => {
  const real = state.seenMarker({ key: 'k', through: 't', id: '1' });
  assert.deepEqual(state.readSeen(`<!-- issue-agent-seen {\nsome text\n${real}`), { key: 'k', through: 't', id: '1' });
});

test('a marker whose JSON is invalid reads as null, never throws', () => {
  assert.equal(state.readSeen('<!-- issue-agent-seen {nope} -->'), null);
});
