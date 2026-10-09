const test = require('node:test');
const assert = require('node:assert/strict');
const threads = require('../threads');
const fake = require('./fake');
const fs = require('fs');
const os = require('os');
const path = require('path');

function structured(value) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'threads-')), 'issue-agent-structured.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test('each thread gets its reply, and a resolve when asked', async () => {
  const github = fake.github({ 'graphql:addPullRequestReviewThreadReply': {}, 'graphql:resolveReviewThread': {}, 'pulls.get': { draft: false, node_id: 'PR' } });
  Object.assign(process.env, { MODE: '', NUMBER: '40', PUSHED: 'true', STRUCTURED_FILE: structured({ threads: [{ id: 'T1', reply: 'Fixed in abc.', resolve: true }, { id: 'T2', reply: 'Declined: …', resolve: false }], ready: false }) });
  await threads.run({ github, context: fake.context(), core: fake.core() });
  assert.deepEqual(github.calls.map((c) => [c.name, c.params.thread]), [
    ['graphql:addPullRequestReviewThreadReply', 'T1'],
    ['graphql:resolveReviewThread', 'T1'],
    ['graphql:addPullRequestReviewThreadReply', 'T2'],
  ]);
});

test('ready marks a draft ready only when this run pushed nothing', async () => {
  const github = fake.github({ 'pulls.get': { draft: true, node_id: 'PR' }, 'graphql:markPullRequestReadyForReview': {} });
  Object.assign(process.env, { MODE: 'ready', PUSHED: 'false', STRUCTURED_FILE: structured({ threads: [], ready: true }) });
  await threads.run({ github, context: fake.context(), core: fake.core() });
  assert.ok(github.calls.some((c) => c.params?.id === 'PR'));
  const again = fake.github({ 'pulls.get': { draft: true, node_id: 'PR' } });
  process.env.PUSHED = 'true';
  await threads.run({ github: again, context: fake.context(), core: fake.core() });
  assert.ok(!again.calls.some((c) => c.name.startsWith('graphql')));
});

test('the thread step never marks ready, and the ready step answers no thread', async () => {
  const replies = fake.github({ 'graphql:addPullRequestReviewThreadReply': {}, 'pulls.get': { draft: true, node_id: 'PR' } });
  Object.assign(process.env, { MODE: '', PUSHED: 'false', STRUCTURED_FILE: structured({ threads: [{ id: 'T1', reply: 'ok', resolve: false }], ready: true }) });
  await threads.run({ github: replies, context: fake.context(), core: fake.core() });
  assert.ok(!replies.calls.some((c) => c.params?.id === 'PR'));
  const ready = fake.github({ 'pulls.get': { draft: true, node_id: 'PR' }, 'graphql:markPullRequestReadyForReview': {} });
  process.env.MODE = 'ready';
  await threads.run({ github: ready, context: fake.context(), core: fake.core() });
  assert.ok(!ready.calls.some((c) => c.params?.thread));
  assert.ok(ready.calls.some((c) => c.params?.id === 'PR'));
});
