const test = require('node:test');
const assert = require('node:assert/strict');
const land = require('../land');
const fake = require('./fake');

const message = (OUTPUT) => {
  const core = fake.core();
  land.message({ core, env: { OUTPUT } });
  return core.outputs;
};

test('the commit message is the output\'s; the turn that finishes marks it done', () => {
  assert.deepEqual(message('{"commit_message":"Task 3: the cascade"}'), { message: 'Task 3: the cascade', done: 'false' });
  assert.deepEqual(message('{"commit_message":"Task 8: docs","done":true}'), { message: 'Task 8: docs\n\nAgent: done', done: 'true' });
});

test('no commit message, or no output at all, commits nothing; done still counts', () => {
  assert.deepEqual(message('{"done":true}'), { message: '', done: 'true' });
  for (const out of ['', '{}', 'not json', 'null']) assert.deepEqual(message(out), { message: '', done: 'false' });
});

function noted(env) {
  const github = fake.github({ 'issues.getComment': { body: 'Did task 3.' }, 'issues.updateComment': {} });
  return land.note({ github, context: fake.context(), env: { COMMENT_ID: '5', RUN_URL: 'https://run/1', ...env } })
    .then(() => github.calls.find((c) => c.name === 'issues.updateComment')?.params);
}

test('a failed commit is called out under the reply, with the run', async () => {
  const p = await noted({ FAILED: 'true', IGNORED: '' });
  assert.equal(p.comment_id, 5);
  assert.match(p.body, /^Did task 3\.\n\n> \[!CAUTION\]\n> \*\*This run's commit failed, so nothing above is on the branch\.\*\* See \[the run\]\(https:\/\/run\/1\)\.$/);
});

test('files left out are named under the reply', async () => {
  const p = await noted({ FAILED: 'false', IGNORED: '[".github/workflows/pr.yml"]' });
  assert.match(p.body, /> \*\*Not committed:\*\* `\.github\/workflows\/pr\.yml`\./);
});

test('nothing failed and nothing left out leaves the reply alone', async () => {
  assert.equal(await noted({ FAILED: 'false', IGNORED: '[]' }), undefined);
});

test('a draft is marked ready; a PR already out of draft is left as it is', async () => {
  for (const [draft, marks] of [[true, 1], [false, 0]]) {
    const github = fake.github({ 'pulls.get': { number: 7, draft, node_id: 'PR_7' }, graphql: {} });
    await land.ready({ github, context: fake.context(), core: fake.core(), env: { NUMBER: '7' } });
    const m = github.calls.filter((c) => c.name === 'graphql');
    assert.equal(m.length, marks);
    if (marks) assert.deepEqual(m[0].params, { id: 'PR_7' });
  }
});
