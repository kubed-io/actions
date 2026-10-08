const test = require('node:test');
const assert = require('node:assert/strict');
const threads = require('../threads');
const fake = require('./fake');

test('each thread gets its reply, and a resolve when asked', async () => {
  const github = fake.github({ 'graphql:addPullRequestReviewThreadReply': {}, 'graphql:resolveReviewThread': {}, 'pulls.get': { draft: false, node_id: 'PR' } });
  Object.assign(process.env, { NUMBER: '40', PUSHED: 'true', STRUCTURED: JSON.stringify({ threads: [{ id: 'T1', reply: 'Fixed in abc.', resolve: true }, { id: 'T2', reply: 'Declined: …', resolve: false }], ready: false }) });
  await threads.run({ github, context: fake.context(), core: fake.core() });
  assert.deepEqual(github.calls.map((c) => [c.name, c.params.thread]), [
    ['graphql:addPullRequestReviewThreadReply', 'T1'],
    ['graphql:resolveReviewThread', 'T1'],
    ['graphql:addPullRequestReviewThreadReply', 'T2'],
  ]);
});

test('ready marks a draft ready only when this run pushed nothing', async () => {
  const github = fake.github({ 'pulls.get': { draft: true, node_id: 'PR' }, 'graphql:markPullRequestReadyForReview': {} });
  Object.assign(process.env, { PUSHED: 'false', STRUCTURED: JSON.stringify({ threads: [], ready: true }) });
  await threads.run({ github, context: fake.context(), core: fake.core() });
  assert.ok(github.calls.some((c) => c.params?.id === 'PR'));
  const again = fake.github({ 'pulls.get': { draft: true, node_id: 'PR' } });
  process.env.PUSHED = 'true';
  await threads.run({ github: again, context: fake.context(), core: fake.core() });
  assert.ok(!again.calls.some((c) => c.name.startsWith('graphql')));
});
