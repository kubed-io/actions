const test = require('node:test');
const assert = require('node:assert/strict');
const verdict = require('../verdict');
const fake = require('../../../issue-agent/lib/test/fake');

const ENV = { CHECK: 'Agent review', NUMBER: '7', SHA: 'abc', LAST: 'false', OUTPUT: '', REVIEW_ID: '', COMMENT_ID: '' };

async function set(over) {
  const github = fake.github({ 'repos.createCommitStatus': {} });
  const core = fake.core();
  await verdict.run({ github, context: fake.context({ serverUrl: 'https://github.com', runId: 5 }), core, env: { ...ENV, ...over } });
  const { state, description, target_url, sha, context } = github.calls[0].params;
  return { state, description, target_url, sha, context, verdict: core.outputs.verdict };
}

test('looks good passes, on the head, linked to the review', async () => {
  assert.deepEqual(await set({ OUTPUT: '{"verdict":"looks good"}', REVIEW_ID: '99' }), {
    state: 'success', description: 'looks good', sha: 'abc', context: 'Agent review',
    target_url: 'https://github.com/kubed-io/selenium-flow/pull/7#pullrequestreview-99', verdict: 'looks good',
  });
});

test('changes requested fails, and says so when it was the last review', async () => {
  assert.equal((await set({ OUTPUT: '{"verdict":"changes requested"}' })).description, 'changes requested');
  const last = await set({ OUTPUT: '{"verdict":"changes requested"}', LAST: 'true', COMMENT_ID: '5' });
  assert.equal(last.state, 'failure');
  assert.match(last.description, /^changes requested, last review/);
  assert.equal(last.target_url, 'https://github.com/kubed-io/selenium-flow/pull/7#issuecomment-5');
});

test('needs a human fails as itself', async () => {
  assert.deepEqual((await set({ OUTPUT: '{"verdict":"needs a human"}' })).description, 'needs a human');
});

test('no verdict, or output that is not JSON, is an error linked to the run', async () => {
  for (const OUTPUT of ['', '{}', 'not json']) {
    const s = await set({ OUTPUT });
    assert.deepEqual([s.state, s.description, s.target_url, s.verdict],
      ['error', 'the review did not finish', 'https://github.com/kubed-io/selenium-flow/actions/runs/5', '']);
  }
});
