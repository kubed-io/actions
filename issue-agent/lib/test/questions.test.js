const test = require('node:test');
const assert = require('node:assert/strict');
const questions = require('../questions');
const notes = require('../notes');
const fake = require('./fake');

const LIST = [{ text: 'Should the tab survive a restart?', from: 15 }, { text: 'Rename `flows.py`?' }];
const RENDERED = '- Should the tab survive a restart? (#15)\n- Rename `flows.py`?';
const PR_BODY = 'Closes #12\n\nThe family\'s work.';

// the parent #12, its body, and the family's pull request to main when open
function family({ body = 'Flows.', pr = null } = {}) {
  const github = fake.github({
    'issues.get': { number: 12, body },
    'issues.update': {},
    'pulls.list': pr ? [pr] : [],
    'pulls.update': {},
  });
  const go = async (env) => {
    const core = fake.core();
    await questions.run({ github, context: fake.context(), core, env: { NUMBER: '12', DEFAULT: 'main', ...env } });
    return core;
  };
  const wrote = (name) => github.calls.filter((c) => c.name === name).map((c) => c.params.body);
  return { github, go, wrote };
}

test('the list renders one line each, naming the sub-issue it came from', () => {
  assert.equal(questions.render(LIST), RENDERED);
  assert.equal(questions.render([{ text: '  ' }, { text: 'x <!-- y -->', from: 'z' }]), '- x &lt;!-- y --&gt;');
  assert.equal(questions.render([]), '');
});

test("a parent turn's list is kept on the parent, collapsed, and on the open family PR as its section", async () => {
  const f = family({ pr: { number: 30, body: PR_BODY } });
  await f.go({ OUTPUT: JSON.stringify({ open_questions: LIST }) });
  const [parent] = f.wrote('issues.update');
  assert.ok(parent.startsWith('Flows.\n\n<!-- issue-agent-block:open-questions -->'));
  assert.match(parent, /<summary>❓ Open questions · 2<\/summary>/);
  assert.equal(notes.unwrap(notes.readBlock(parent, 'open-questions')), RENDERED);
  const [body] = f.wrote('pulls.update');
  assert.equal(body, `${PR_BODY}\n\n<!-- issue-agent-block:open-questions -->\n## Open questions\n\n${RENDERED}\n<!-- /issue-agent-block:open-questions -->\n`);
  assert.deepEqual(f.github.calls.find((c) => c.name === 'pulls.list').params,
    { owner: 'kubed-io', repo: 'selenium-flow', head: 'kubed-io:issue-12', base: 'main', state: 'open', per_page: 1 });
});

test('with no family PR open the list is only kept on the parent', async () => {
  const f = family();
  await f.go({ OUTPUT: JSON.stringify({ open_questions: LIST }) });
  assert.deepEqual([f.wrote('issues.update').length, f.wrote('pulls.update').length], [1, 0]);
});

test('when the family PR opens, its section comes from the list kept on the parent', async () => {
  const kept = questions.keep('Flows.', questions.onParent(RENDERED, 2));
  const f = family({ body: kept, pr: { number: 30, body: PR_BODY } });
  await f.go({ OUTPUT: '' });
  assert.deepEqual(f.wrote('issues.update'), []);
  assert.match(f.wrote('pulls.update')[0], /## Open questions\n\n- Should the tab survive a restart\? \(#15\)/);
});

test('a later turn with a changed list rewrites the section in place; the same list writes nothing', async () => {
  const pr = { number: 30, body: questions.keep(PR_BODY, questions.onPR(RENDERED)) };
  const kept = questions.keep('Flows.', questions.onParent(RENDERED, 2));
  const same = family({ body: kept, pr });
  await same.go({ OUTPUT: JSON.stringify({ open_questions: LIST }) });
  assert.deepEqual([same.wrote('issues.update'), same.wrote('pulls.update')], [[], []]);

  const changed = family({ body: kept, pr });
  await changed.go({ OUTPUT: JSON.stringify({ open_questions: [LIST[1]] }) });
  const [body] = changed.wrote('pulls.update');
  assert.equal(body.split('## Open questions').length, 2);
  assert.ok(!body.includes('restart'));
  assert.ok(body.startsWith(PR_BODY));
});

test('an empty list takes the section off; a turn without the field keeps what is there', async () => {
  const pr = { number: 30, body: questions.keep(PR_BODY, questions.onPR(RENDERED)) };
  const kept = questions.keep('Flows.', questions.onParent(RENDERED, 2));
  const empty = family({ body: kept, pr });
  await empty.go({ OUTPUT: JSON.stringify({ open_questions: [] }) });
  assert.deepEqual([empty.wrote('issues.update'), empty.wrote('pulls.update')], [['Flows.'], [PR_BODY]]);

  const without = family({ body: kept, pr });
  await without.go({ OUTPUT: JSON.stringify({ reply: 'x' }) });
  assert.deepEqual([without.wrote('issues.update'), without.wrote('pulls.update')], [[], []]);
});
