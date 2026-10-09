const test = require('node:test');
const assert = require('node:assert/strict');
const copilot = require('../copilot');
const fake = require('./fake');

const COPILOT = { login: 'copilot-pull-request-reviewer[bot]', id: 175728472, type: 'Bot' };
const ASKED = { event: 'review_requested', requested_reviewer: { login: 'Copilot', type: 'Bot' } };
const REVIEWED = { event: 'reviewed', user: COPILOT };
const pr = (over = {}) => ({ draft: false, head: { sha: 'abc1234', ref: 'issue-4-x' }, ...over });
const noWait = async () => {};

// the timeline answers `before` until the request is made, then `after`
function timeline(before, after = before) {
  let asked = false;
  return {
    'issues.listEventsForTimeline': () => (asked ? after : before),
    'pulls.requestReviewers': () => { asked = true; return {}; },
  };
}

const review = (routes) => {
  const github = fake.github({ 'pulls.listReviews': [], 'pulls.listCommentsForReview': [], 'actions.listWorkflowRunsForRepo': [], ...routes });
  const core = fake.core();
  process.env.NUMBER = '5';
  process.env.TIMEOUT_MINUTES = '1';
  return copilot.run({ github, context: fake.context(), core, wait: noWait }).then(() => ({ github, core }));
};

test('Copilot is one bot under three logins', () => {
  for (const login of ['Copilot', 'copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]']) assert.ok(copilot.isCopilot({ login }));
  assert.ok(!copilot.isCopilot({ login: 'dependabot[bot]' }));
  assert.ok(!copilot.isCopilot(null));
});

test('only the timeline says Copilot was asked, and a later review answers the request', async () => {
  const asked = (events) => copilot.isAsked(fake.github({ 'issues.listEventsForTimeline': events }), { owner: 'o', repo: 'r', number: 5 });
  assert.equal(await asked([]), false);
  assert.equal(await asked([ASKED]), true);
  assert.equal(await asked([ASKED, REVIEWED]), false);
  assert.equal(await asked([ASKED, REVIEWED, ASKED]), true);
});

test('a request the timeline never shows is a token that cannot ask Copilot', async () => {
  const github = fake.github(timeline([], []));
  const core = fake.core();
  assert.equal(await copilot.askCopilot({ github, context: fake.context(), core, number: 5, wait: noWait }), false);
  assert.ok(core.notices.some((n) => n.includes('cannot ask Copilot')));
});

test('a pending request is not made twice', async () => {
  const github = fake.github(timeline([ASKED]));
  assert.equal(await copilot.askCopilot({ github, context: fake.context(), core: fake.core(), number: 5, wait: noWait }), true);
  assert.ok(!github.calls.some((c) => c.name === 'pulls.requestReviewers'));
});

test('a draft never asks Copilot', async () => {
  const { github, core } = await review({ 'pulls.get': pr({ draft: true }) });
  assert.ok(!github.calls.some((c) => c.name === 'pulls.requestReviewers'));
  assert.equal(core.outputs.respond, 'false');
});

test('out of draft, it asks, waits for the review of the head, and answers its comments', async () => {
  let polls = 0;
  const { github, core } = await review({
    'pulls.get': pr(),
    ...timeline([], [ASKED]),
    // no review on the first two polls, then Copilot's review of the head
    'pulls.listReviews': () => (polls++ < 2 ? [{ user: COPILOT, commit_id: 'old0000', id: 1 }] : [{ user: COPILOT, commit_id: 'abc1234', id: 2, html_url: 'u' }]),
    'pulls.listCommentsForReview': (p) => (p.review_id === 2 ? [{ id: 9 }, { id: 10 }] : []),
  });
  assert.deepEqual(github.calls.find((c) => c.name === 'pulls.requestReviewers').params.reviewers, ['copilot-pull-request-reviewer[bot]']);
  assert.equal(core.outputs.respond, 'true');
  assert.equal(core.outputs.comments, '2');
});

test('a clean review leaves nothing to answer', async () => {
  const { core } = await review({ 'pulls.get': pr(), 'pulls.listReviews': [{ user: COPILOT, commit_id: 'abc1234', id: 2 }] });
  assert.equal(core.outputs.respond, 'false');
  assert.equal(core.outputs.comments, '0');
});

test('a head Copilot already reviewed is not asked again', async () => {
  const { github } = await review({ 'pulls.get': pr(), 'pulls.listReviews': [{ user: COPILOT, commit_id: 'abc1234', id: 2 }] });
  assert.ok(!github.calls.some((c) => c.name === 'pulls.requestReviewers'));
});

test('a token that cannot ask Copilot fails the job', async () => {
  await assert.rejects(review({ 'pulls.get': pr(), ...timeline([], []) }), /could not be asked/);
});

test('no review in time only warns', async () => {
  const { core } = await review({ 'pulls.get': pr(), ...timeline([], [ASKED]) });
  assert.equal(core.outputs.respond, 'false');
  assert.ok(core.notices.some((n) => n.includes('did not review')));
});

test("Copilot's held runs are deleted, and nobody else's", async () => {
  const { github } = await review({
    'pulls.get': pr(),
    'pulls.listReviews': [{ user: COPILOT, commit_id: 'abc1234', id: 2 }],
    'actions.listWorkflowRunsForRepo': [{ id: 7, triggering_actor: { login: 'Copilot' } }, { id: 8, triggering_actor: { login: 'someone' } }],
    'actions.deleteWorkflowRun': {},
  });
  assert.deepEqual(github.calls.filter((c) => c.name === 'actions.deleteWorkflowRun').map((c) => c.params.run_id), [7]);
});
