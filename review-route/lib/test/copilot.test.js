const test = require('node:test');
const assert = require('node:assert/strict');
const steps = require('../copilot');
const fake = require('../../../issue-agent/lib/test/fake');

const DRK = 4399427;
const APP = 235398881;
const HEAD = 'b'.repeat(40);
const COPILOT = { login: 'copilot-pull-request-reviewer[bot]', id: 175728472 };
// the owner's opt-in at eight, on the draft; the head committed at nine
const asked = (id, at = '2026-11-04T08:00:00Z') => ({ event: 'review_requested', actor: { id }, requested_reviewer: { login: 'Copilot' }, created_at: at });
const review = (over = {}) => ({ id: 41, user: COPILOT, commit_id: HEAD, body: '### Changes recommended', ...over });

function setup({ pr = {}, events = [asked(DRK)], reviews = [] } = {}) {
  const github = fake.github({
    'pulls.get': { state: 'open', draft: false, head: { sha: HEAD }, ...pr },
    'issues.listEventsForTimeline': events,
    'repos.getCommit': { commit: { committer: { date: '2026-11-04T09:00:00Z' } } },
    'pulls.listReviews': typeof reviews === 'function' ? reviews : () => reviews,
    'pulls.requestReviewers': {},
  });
  const core = fake.core();
  const env = { NUMBER: '7', OWNER: String(DRK), TIMEOUT_MINUTES: '1', INTERVAL_SECONDS: '20' };
  let pauses = 0;
  const pause = async () => { pauses += 1; };
  const run = (step) => steps.run({ github, context: fake.context(), core, env: { ...env, STEP: step }, pause });
  const asks = () => github.calls.filter((c) => c.name === 'pulls.requestReviewers').map((c) => c.params.reviewers);
  return { github, core, run, asks, pauses: () => pauses };
}

test('ask: the new head of a change the owner gave Copilot gets its review', async () => {
  const t = setup();
  await t.run('ask');
  assert.deepEqual(t.asks(), [['copilot-pull-request-reviewer[bot]']]);
});

test('ask: not on a draft, not on the review agent\'s change, not twice for one head', async () => {
  for (const t of [
    setup({ pr: { draft: true } }),
    setup({ events: [] }),
    setup({ events: [asked(APP)] }),
    setup({ events: [asked(DRK), asked(APP, '2026-11-04T09:00:30Z')] }),
    setup({ reviews: [review()] }),
  ]) {
    await t.run('ask');
    assert.deepEqual(t.asks(), []);
  }
});

test('ask: a head Copilot failed on is asked again', async () => {
  const t = setup({ reviews: [review({ body: 'Copilot encountered an error and was unable to review this pull request.' })] });
  await t.run('ask');
  assert.equal(t.asks().length, 1);
});

test('wait: holds until Copilot reviews the head it was asked for', async () => {
  let polls = 0;
  const t = setup({
    events: [asked(DRK), asked(APP, '2026-11-04T09:00:30Z')],
    reviews: () => (++polls >= 3 ? [review()] : []),
  });
  await t.run('wait');
  assert.equal(t.pauses(), 2);
  assert.ok(t.core.notices.some((n) => n.includes('the turn answers it too')));
});

test('wait: nothing to wait for when Copilot reviewed already, or was not asked for the head', async () => {
  for (const t of [setup({ reviews: [review()] }), setup(), setup({ pr: { draft: true } }), setup({ events: [] })]) {
    await t.run('wait');
    assert.equal(t.pauses(), 0);
  }
});

test('wait: gives up after the timeout, and the turn goes on', async () => {
  const t = setup({ events: [asked(DRK), asked(APP, '2026-11-04T09:00:30Z')] });
  await t.run('wait');
  assert.equal(t.pauses(), 3);
  assert.ok(t.core.notices.some((n) => n.includes('did not review')));
});
