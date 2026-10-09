const test = require('node:test');
const assert = require('node:assert/strict');
const copilot = require('../copilot');
const fake = require('./fake');

const COPILOT = { login: 'copilot-pull-request-reviewer[bot]', id: 175728472, type: 'Bot' };
const pr = (over = {}) => ({ draft: false, head: { sha: 'abc1234' }, requested_reviewers: [], ...over });
const ask = (routes) => {
  const github = fake.github({ 'pulls.requestReviewers': {}, 'pulls.listReviews': [], ...routes });
  return copilot.askCopilot({ github, context: fake.context(), core: fake.core(), number: 5 }).then((asked) => ({ asked, github }));
};

test('Copilot is one bot under three logins', () => {
  for (const login of ['Copilot', 'copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]']) assert.ok(copilot.isCopilot({ login }));
  assert.ok(!copilot.isCopilot({ login: 'dependabot[bot]' }));
  assert.ok(!copilot.isCopilot(null));
});

test('a draft never asks Copilot', async () => {
  const { asked, github } = await ask({ 'pulls.get': pr({ draft: true }) });
  assert.equal(asked, false);
  assert.ok(!github.calls.some((c) => c.name === 'pulls.requestReviewers'));
});

test('out of draft, a head Copilot has not seen is reviewed once', async () => {
  const { asked, github } = await ask({ 'pulls.get': pr(), 'pulls.listReviews': [{ user: COPILOT, commit_id: 'old0000' }] });
  assert.equal(asked, true);
  assert.deepEqual(github.calls.find((c) => c.name === 'pulls.requestReviewers').params.reviewers, ['copilot-pull-request-reviewer[bot]']);
});

test('a head Copilot already reviewed, or is already asked about, is left alone', async () => {
  assert.equal((await ask({ 'pulls.get': pr(), 'pulls.listReviews': [{ user: COPILOT, commit_id: 'abc1234' }] })).asked, false);
  assert.equal((await ask({ 'pulls.get': pr({ requested_reviewers: [COPILOT] }) })).asked, false);
});

test('a refused request only warns', async () => {
  const { asked } = await ask({ 'pulls.get': pr(), 'pulls.requestReviewers': new Error('not allowed') });
  assert.equal(asked, false);
});
