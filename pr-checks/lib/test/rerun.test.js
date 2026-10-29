const test = require('node:test');
const assert = require('node:assert/strict');
const rerun = require('../rerun');
const fake = require('../../../issue-agent/lib/test/fake');

function setup(run) {
  const github = fake.github({
    'actions.getWorkflowRun': run instanceof Error ? run : { id: 41, run_attempt: 1, status: 'completed', conclusion: 'failure', ...run },
    'actions.reRunWorkflowFailedJobs': {},
  });
  const core = fake.core();
  const context = fake.context({});
  const go = (env = {}) => rerun.run({ github, context, core, env: { RUN_ID: '41', MAX_ATTEMPTS: '2', ...env } });
  const reran = () => github.calls.some((c) => c.name === 'actions.reRunWorkflowFailedJobs');
  return { go, core, reran, github };
}

test('a failed run on its first attempt: its failed jobs are re-run', async () => {
  const t = setup({});
  await t.go();
  assert.equal(t.reran(), true);
  assert.equal(t.github.calls.find((c) => c.name === 'actions.reRunWorkflowFailedJobs').params.run_id, 41);
  assert.equal(t.core.outputs.rerun, 'true');
});

test('a run already re-run as often as allowed is left for a human', async () => {
  const t = setup({ run_attempt: 2 });
  await t.go();
  assert.equal(t.reran(), false);
  assert.equal(t.core.outputs.rerun, 'false');
  assert.match(t.core.notices.join('\n'), /already ran 2 times/);
});

test('max_attempts raises the limit', async () => {
  const t = setup({ run_attempt: 2 });
  await t.go({ MAX_ATTEMPTS: '3' });
  assert.equal(t.reran(), true);
});

test('a run that did not fail, or is still going, is not re-run', async () => {
  for (const run of [{ conclusion: 'success' }, { status: 'in_progress', conclusion: null }, { conclusion: 'cancelled' }]) {
    const t = setup(run);
    await t.go();
    assert.equal(t.reran(), false, JSON.stringify(run));
    assert.equal(t.core.outputs.rerun, 'false');
  }
});

test('no run id: nothing to do', async () => {
  const t = setup({});
  await t.go({ RUN_ID: '' });
  assert.equal(t.reran(), false);
  assert.equal(t.core.outputs.rerun, 'false');
});
