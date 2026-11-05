const test = require('node:test');
const assert = require('node:assert/strict');
const copilot = require('../copilot');

const asked = (id, at) => ({ event: 'review_requested', actor: { id }, requested_reviewer: { login: 'Copilot', type: 'Bot' }, created_at: at });

test('Copilot is one bot under three logins', () => {
  for (const login of ['Copilot', 'copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]']) assert.ok(copilot.isCopilot({ login }));
  assert.ok(!copilot.isCopilot({ login: 'dependabot[bot]' }));
  assert.ok(!copilot.isCopilot(null));
});

test("only the owner's own request opts a change in", () => {
  assert.equal(copilot.optedIn([asked(4399427, '2026-11-04T08:00:00Z')], 4399427), true);
  assert.equal(copilot.optedIn([asked(235398881, '2026-11-04T08:00:00Z')], 4399427), false);
  assert.equal(copilot.optedIn([{ ...asked(4399427), requested_reviewer: { login: 'kferrone' } }], 4399427), false);
});

test('asked for a head: any request at or after its commit', () => {
  const events = [asked(4399427, '2026-11-04T08:00:00Z'), asked(235398881, '2026-11-04T09:00:00Z')];
  assert.equal(copilot.askedSince(events, '2026-11-04T09:00:00Z'), true);
  assert.equal(copilot.askedSince(events, '2026-11-04T09:00:01Z'), false);
});

test("Copilot's error review is no verdict", () => {
  assert.ok(copilot.failedReview({ body: 'Copilot encountered an error and was unable to review this pull request.' }));
  assert.ok(!copilot.failedReview({ body: '### Changes recommended' }));
});
