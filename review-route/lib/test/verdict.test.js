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
  return { state, description, target_url, sha, context, verdict: core.outputs.verdict, handback: core.outputs.handback };
}

test('looks good passes, on the head, linked to the review', async () => {
  assert.deepEqual(await set({ OUTPUT: '{"verdict":"looks good"}', REVIEW_ID: '99' }), {
    state: 'success', description: 'looks good', sha: 'abc', context: 'Agent review',
    target_url: 'https://github.com/kubed-io/selenium-flow/pull/7#pullrequestreview-99', verdict: 'looks good', handback: '',
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

test("a family review's verdict is handed back to n8n, summary and all", async () => {
  const pass = await set({ TARGET: 'family', OUTPUT: '{"verdict":"looks good","summary":"The tab is kept.\\n"}', REVIEW_ID: '99' });
  assert.deepEqual(JSON.parse(pass.handback), {
    type: 'verdict', repo: 'kubed-io/selenium-flow', number: 7, sha: 'abc', verdict: 'looks good',
    summary: 'The tab is kept.', review_id: 99, run_id: 5,
  });
  const asked = JSON.parse((await set({ TARGET: 'family', OUTPUT: '{"verdict":"changes requested"}', COMMENT_ID: '5' })).handback);
  assert.deepEqual([asked.verdict, asked.summary, asked.review_id], ['changes requested', '', 0]);
});

test("a default review's verdict hands nothing back", async () => {
  for (const over of [{ OUTPUT: '{"verdict":"looks good","summary":"x"}' }, { TARGET: 'default', OUTPUT: '{"verdict":"looks good"}' }, { TARGET: 'default', OUTPUT: '{"verdict":"changes requested"}' }]) {
    assert.equal((await set(over)).handback, '', JSON.stringify(over));
  }
});

test('a review that ends without a verdict tells n8n it errored, on any PR (R-SM35)', async () => {
  for (const TARGET of ['family', 'default', undefined]) {
    for (const OUTPUT of ['', '{}', 'not json', '{"verdict":""}', '{"summary":"x"}']) {
      const s = await set({ TARGET, OUTPUT });
      assert.equal(s.state, 'error', `${TARGET} ${OUTPUT}`);
      assert.deepEqual(JSON.parse(s.handback), {
        type: 'review-error', repo: 'kubed-io/selenium-flow', number: 7, sha: 'abc', run_id: 5, retry_of: 0,
      }, `${TARGET} ${OUTPUT}`);
    }
  }
});

test("an errored review that was n8n's retry names the run it retried (R-SM35)", async () => {
  const s = await set({ TARGET: 'family', OUTPUT: '', RETRY_OF: '41' });
  assert.equal(JSON.parse(s.handback).retry_of, 41);
  for (const RETRY_OF of ['', 'x', '-3', '0']) {
    assert.equal(JSON.parse((await set({ OUTPUT: '', RETRY_OF })).handback).retry_of, 0, RETRY_OF);
  }
  // a verdict is a verdict, retry or not
  const pass = JSON.parse((await set({ TARGET: 'family', OUTPUT: '{"verdict":"looks good"}', RETRY_OF: '41' })).handback);
  assert.equal(pass.type, 'verdict');
  assert.equal('retry_of' in pass, false);
});

test("a family's last allowed review asking for changes hands back needs a human (R-SM28)", async () => {
  const last = await set({ TARGET: 'family', OUTPUT: '{"verdict":"changes requested","summary":"The tab is lost on reload."}', LAST: 'true', REVIEW_ID: '99' });
  assert.match(last.description, /^changes requested, last review/);
  const body = JSON.parse(last.handback);
  assert.deepEqual([body.verdict, body.summary, body.review_id], ['needs a human', 'The tab is lost on reload.', 99]);
  // without a summary, the status says why
  const bare = JSON.parse((await set({ TARGET: 'family', OUTPUT: '{"verdict":"changes requested"}', LAST: 'true' })).handback);
  assert.deepEqual([bare.verdict, bare.summary], ['needs a human', 'changes requested, last review: over to a human']);
  // not the last: changes requested, as it was
  const early = JSON.parse((await set({ TARGET: 'family', OUTPUT: '{"verdict":"changes requested"}' })).handback);
  assert.equal(early.verdict, 'changes requested');
});
