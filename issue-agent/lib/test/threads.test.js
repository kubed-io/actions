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

test('a thread reply carries the action\'s tag, so the next run knows it for its own', async () => {
  const { TAG } = require('../state');
  const github = fake.github({ 'graphql:addPullRequestReviewThreadReply': {}, 'pulls.get': { draft: false, node_id: 'PR' } });
  Object.assign(process.env, { MODE: '', NUMBER: '40', PUSHED: 'true', STRUCTURED_FILE: structured({ threads: [{ id: 'T1', reply: 'Fixed in abc.', resolve: false }], ready: false }) });
  await threads.run({ github, context: fake.context(), core: fake.core() });
  const body = github.calls.find((c) => c.name === 'graphql:addPullRequestReviewThreadReply').params.body;
  assert.ok(body.startsWith('Fixed in abc.'));
  assert.ok(body.includes(TAG));
});
