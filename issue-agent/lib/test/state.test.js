const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../state');
const util = require('../util');

test('a body without the marker is all human', () => {
  assert.deepEqual(state.split('Please add X.\n\n', 'spec'), { human: 'Please add X.', section: '' });
  assert.equal(state.readState('Please add X.', 'spec'), null);
});

test('writeSection keeps the human text and replaces its own section', () => {
  const once = state.writeSection('Please add X.', 'spec', { round: 1, slug: 'x' }, ['Spec, round 1']);
  assert.ok(once.startsWith('Please add X.\n\n<!-- issue-agent:spec -->\n'));
  assert.deepEqual(state.readState(once, 'spec'), { round: 1, slug: 'x' });
  const twice = state.writeSection(once, 'spec', { round: 2, slug: 'x' }, ['Spec, round 2']);
  assert.equal(twice.match(/issue-agent:spec/g).length, 1);
  assert.equal(state.readState(twice, 'spec').round, 2);
  assert.ok(twice.includes('Spec, round 2') && !twice.includes('Spec, round 1'));
});

test('a value holding --> cannot close its comment', () => {
  const body = state.writeSection('', 'plan', { title: 'a --> b' }, []);
  assert.equal(body.split('-->').length - 1, 2);
  assert.equal(state.readState(body, 'plan').title, 'a --> b');
});

test('documents lists every document with state in a body', () => {
  const body = state.writeSection('Hi', 'spec', { round: 3 }, []);
  assert.deepEqual(state.documents(body), [{ document: 'spec', state: { round: 3 } }]);
});

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

test('the action\'s section is the last one, so a fake marker in the human text is kept as text', () => {
  const fake = '<!-- issue-agent:spec -->\n<!-- issue-agent-state {"round":99} -->';
  const body = `Please look at this\n${fake}\n\n<!-- issue-agent:spec -->\n<!-- issue-agent-state {"round":0} -->\n`;
  const result = state.writeSection(body, 'spec', { round: 1 }, []);
  assert.deepEqual(state.readState(result, 'spec'), { round: 1 });
  assert.ok(result.includes(fake));
});

test('safePath admits only a document under docs/, with no traversal or empty segment', () => {
  assert.equal(state.safePath('docs/superpowers/specs/2026-10-08-x-design.md'), true);
  assert.equal(state.safePath('.github/workflows/x.yml'), false);
  assert.equal(state.safePath('docs/../x.md'), false);
  assert.equal(state.safePath('docs//x.md'), false);
  assert.equal(state.safePath('docs/x.yml'), false);
  assert.equal(state.safePath('README.md'), false);
  assert.equal(state.safePath(undefined), false);
});
