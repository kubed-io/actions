const test = require('node:test');
const assert = require('node:assert/strict');
const trusted = require('../trusted');
const state = require('../state');
const fake = require('./fake');

const OK = {
  slug: 'recordings', path: 'docs/superpowers/specs/2026-10-08-recordings-design.md', round: 2, run: '5', artifact: '7',
  artifact_url: 'https://github.com/kubed-io/selenium-flow/actions/runs/5/artifacts/7',
  summary_url: 'https://github.com/kubed-io/selenium-flow/actions/runs/5#summary-9', approved: false,
};
const body = state.writeSection('Record it.', 'spec', OK, []);
const user = (login, id) => ({ __typename: 'User', login, databaseId: id });
const bot = { __typename: 'Bot', login: 'kubed-app', databaseId: 99 };

function ask(actors, over = {}) {
  const github = fake.github({ 'graphql:issueOrPullRequest': { repository: { issueOrPullRequest: actors } } });
  return trusted.bodyState(github, { owner: 'kubed-io', repo: 'selenium-flow', number: 12, document: 'spec', body, ids: ['1'], server: 'https://github.com', ...over });
}

test('a state last edited by a Bot is used', async () => {
  assert.deepEqual(await ask({ author: user('kelly', 1), editor: bot }), OK);
});

test('a state last edited by a trusted id is used', async () => {
  assert.deepEqual(await ask({ author: user('kelly', 1), editor: user('kelly', 1) }), OK);
});

test('with no editor the author counts', async () => {
  assert.deepEqual(await ask({ author: bot, editor: null }), OK);
  assert.equal(await ask({ author: user('stranger', 2), editor: null }), null);
});

test('a state the issue author, an untrusted user, edited last is ignored', async () => {
  assert.equal(await ask({ author: user('stranger', 2), editor: user('stranger', 2) }), null);
});

test('a trusted state that is invalid is ignored', async () => {
  const forged = state.writeSection('x', 'spec', { ...OK, slug: 'Bad Slug' }, []);
  assert.equal(await ask({ author: bot, editor: bot }, { body: forged }), null);
});

test('the body comes from the same query as its editor', async () => {
  const planted = state.writeSection('Hi', 'spec', { stale: true }, []);
  const real = state.writeSection('Hi', 'spec', OK, []);
  const github = fake.github({ 'graphql:issueOrPullRequest': { repository: { issueOrPullRequest: { body: real, author: { __typename: 'User', login: 'kelly', databaseId: 1 }, editor: { __typename: 'Bot', login: 'github-actions', databaseId: 41898282 } } } } });
  assert.deepEqual(await trusted.bodyState(github, { owner: 'kubed-io', repo: 'selenium-flow', number: 12, document: 'spec', body: planted, ids: ['1'], server: 'https://github.com' }), OK);
});
