const test = require('node:test');
const assert = require('node:assert/strict');
const trusted = require('../trusted');
const fake = require('./fake');

const user = (login, id) => ({ __typename: 'User', login, databaseId: id });
const bot = { __typename: 'Bot', login: 'kubed-app', databaseId: 99 };

test('a Bot or a trusted id wrote it last; anyone else, or nobody, did not', () => {
  assert.equal(trusted.wroteLast(bot, ['1']), true);
  assert.equal(trusted.wroteLast(user('kelly', 1), ['1']), true);
  assert.equal(trusted.wroteLast(user('stranger', 2), ['1']), false);
  assert.equal(trusted.wroteLast(null, ['1']), false);
});

test('lastEdit reads the body and its editor in one query, the author when never edited', async () => {
  const github = fake.github({ 'graphql:issueOrPullRequest': { repository: { issueOrPullRequest: { body: 'b', author: user('a', 2), editor: null } } } });
  assert.deepEqual(await trusted.lastEdit(github, { owner: 'o', repo: 'r', number: 1 }), { body: 'b', editor: user('a', 2) });
});
