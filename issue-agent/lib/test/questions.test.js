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

// R-SM30: the family PR also lists the parent's agent sub-issues still open, refreshed on each
// open_pr (the hand-off's `sub_issues`); a turn's open questions leave that list alone
const SUBS = JSON.stringify([{ number: 15, title: 'Flows keep the tab' }, { number: 16, title: 'A <!-- b --> c' }]);

test('the hand-off lists the open sub-issues on the family PR, with the open questions, in one write', async () => {
  const kept = questions.keep('Flows.', questions.onParent(RENDERED, 2));
  const f = family({ body: kept, pr: { number: 30, body: PR_BODY } });
  await f.go({ OUTPUT: '', SUB_ISSUES: SUBS });
  const writes = f.wrote('pulls.update');
  assert.equal(writes.length, 1);
  assert.match(writes[0], /## Open questions\n\n- Should the tab survive/);
  assert.equal(notes.unwrap(notes.readBlock(writes[0], 'open-sub-issues')), '## Open sub-issues\n\n- #15 Flows keep the tab\n- #16 A &lt;!-- b --&gt; c');
});

test('no open sub-issue takes the list off; without sub_issues it stays as it is', async () => {
  const listed = questions.keep(PR_BODY, questions.onPR(RENDERED));
  const pr = { number: 30, body: questions.keep(listed, questions.onSubs(questions.renderSubs(JSON.parse(SUBS))), questions.SUBS) };
  const kept = questions.keep('Flows.', questions.onParent(RENDERED, 2));
  const none = family({ body: kept, pr });
  await none.go({ OUTPUT: '', SUB_ISSUES: '[]' });
  assert.equal(none.wrote('pulls.update')[0].trimEnd(), listed.trimEnd());
  const turn = family({ body: kept, pr });
  await turn.go({ OUTPUT: JSON.stringify({ open_questions: [] }) });
  assert.match(turn.wrote('pulls.update')[0], /## Open sub-issues/);
  const bad = family({ body: kept, pr });
  await bad.go({ OUTPUT: '', SUB_ISSUES: 'not json' });
  assert.deepEqual(bad.wrote('pulls.update'), []);
});
