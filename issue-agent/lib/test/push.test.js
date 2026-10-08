const test = require('node:test');
const assert = require('node:assert/strict');
const push = require('../push');
const fake = require('./fake');

const env = (over) => Object.assign(process.env, { PUSH_TOKEN: 'tok', HEAD: 'issue-12-rec', NUMBER: '40', REQUEST_REVIEW: '', GITHUB_SERVER_URL: 'https://github.com', ...over });

test('a checkout ahead of the head is pushed, with the token masked', async () => {
  env({});
  const exec = fake.exec('2');
  const core = fake.core();
  await push.run({ github: fake.github(), context: fake.context(), core, exec });
  assert.deepEqual(exec.calls.at(-1), ['git', 'push', 'https://x-access-token:tok@github.com/kubed-io/selenium-flow.git', 'HEAD:refs/heads/issue-12-rec']);
  assert.equal(core.outputs.pushed, 'true');
  assert.deepEqual(core.secrets, ['tok']);
});

test('nothing ahead is no push', async () => {
  env({});
  const exec = fake.exec('0');
  const core = fake.core();
  await push.run({ github: fake.github(), context: fake.context(), core, exec });
  assert.ok(!exec.calls.some((c) => c[1] === 'push'));
  assert.equal(core.outputs.pushed, 'false');
});

test('request_review copilot asks for Copilot after a push, and a refusal only warns', async () => {
  env({ REQUEST_REVIEW: 'copilot' });
  const github = fake.github({ 'pulls.requestReviewers': new Error('not allowed') });
  const core = fake.core();
  await push.run({ github, context: fake.context(), core, exec: fake.exec('1') });
  assert.deepEqual(github.calls[0].params.reviewers, ['copilot-pull-request-reviewer[bot]']);
  assert.ok(core.notices[0].includes('not allowed'));
});
