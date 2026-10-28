const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../route');
const fake = require('../../../issue-agent/lib/test/fake');

const DRK = 4399427;
const APP = 235398881;
const COPILOT = 175728472;
const P = '/mcp__superpowers__superpowers_';
const ENV = { OWNER_ID: String(DRK), APP_ID: String(APP), COPILOT_ID: String(COPILOT), PREFIX: 'issue-', LABEL: 'plan approved', PROMPTS: P };

// the agents' PR #7; `approved` puts the label on it, `message` is its head commit's
function setup({ eventName, payload, approved = true, draft = true, message = 'Task 3', pr = {} }) {
  const github = fake.github({
    'pulls.get': {
      state: 'open', draft, labels: approved ? [{ name: 'plan approved' }] : [],
      head: { sha: 'h'.repeat(40), ref: 'issue-6', repo: { full_name: 'kubed-io/selenium-flow' } },
      ...pr,
    },
    'repos.getCommit': { commit: { message } },
  });
  const core = fake.core();
  const go = () => route.run({ github, context: fake.context({ eventName, payload }), core, env: ENV });
  return { core, go };
}
const comment = (id = DRK) => ({ eventName: 'issue_comment', payload: { issue: { number: 7 }, sender: { id } } });
const relayed = (event, id) => ({ eventName: 'workflow_run', payload: { workflow_run: { event, pull_requests: [{ number: 7 }], triggering_actor: { id } } } });
const dispatch = (reason, extra = {}) => ({ eventName: 'repository_dispatch', payload: { action: 'agent-code', client_payload: { pull_request: 7, reason, ...extra }, sender: { id: 41898282 } } });

const outcome = async (t) => { await t.go(); const o = t.core.outputs; return [o.stage, o.prompt, o.prompt_when]; };

test("before the approval, the owner's comment is a plan turn in their words", async () => {
  assert.deepEqual(await outcome(setup({ ...comment(), approved: false })), ['plan', '', 'quiet']);
});

test('before the approval, a push or a dispatch is nothing', async () => {
  assert.deepEqual((await outcome(setup({ ...relayed('pull_request', DRK), approved: false })))[0], 'none');
  assert.deepEqual((await outcome(setup({ ...dispatch('ci'), approved: false })))[0], 'none');
});

test('the approval label starts the code, takes the PR over, with the plan-approved prompt', async () => {
  const t = setup({ eventName: 'pull_request_target', payload: { pull_request: { number: 7 }, sender: { id: DRK } } });
  assert.deepEqual(await outcome(t), ['code', `${P}plan-approved`, 'quiet']);
  assert.equal(t.core.outputs.takeover, 'true');
  assert.equal(t.core.outputs.head, 'issue-6');
});

test("after the approval, the owner's comment is a code turn, taking no PR over", async () => {
  const t = setup(comment());
  assert.deepEqual(await outcome(t), ['code', '', 'quiet']);
  assert.equal(t.core.outputs.takeover, 'false');
});

test("the agent's push to the draft is the next task; the finishing one wakes nothing", async () => {
  assert.deepEqual(await outcome(setup(relayed('pull_request', APP))), ['code', `${P}next-task`, 'quiet']);
  assert.equal((await outcome(setup({ ...relayed('pull_request', APP), message: 'Task 8\n\nAgent: done' })))[0], 'none');
});

test('a push to a PR out of draft, or by anyone else, wakes nothing', async () => {
  assert.equal((await outcome(setup({ ...relayed('pull_request', APP), draft: false })))[0], 'none');
  assert.equal((await outcome(setup(relayed('pull_request', 12345))))[0], 'none');
});

test("a review wakes the code agent when it is the owner's or Copilot's, never the App's own replies", async () => {
  assert.equal((await outcome(setup(relayed('pull_request_review', DRK))))[0], 'code');
  assert.equal((await outcome(setup(relayed('pull_request_review', COPILOT))))[0], 'code');
  assert.equal((await outcome(setup(relayed('pull_request_review', APP))))[0], 'none');
});

test('failed checks are a code turn, its prompt the whole turn, with the run for its report', async () => {
  const t = setup(dispatch('ci', { run_id: 42 }));
  assert.deepEqual(await outcome(t), ['code', `${P}checks-failed`, 'always']);
  assert.equal(t.core.outputs.run_id, '42');
});

test('a review dispatch carries no run; an unknown reason says what woke it', async () => {
  const t = setup(dispatch('review', { review_id: 9 }));
  assert.deepEqual(await outcome(t), ['code', `${P}review-came-in`, 'always']);
  assert.equal(t.core.outputs.run_id, '');
  assert.deepEqual(await outcome(setup(dispatch('poke'))), ['code', 'Woken by poke: see what needs doing.', 'always']);
});

test("a PR not on the agents' branches, or closed, is nothing, and names no PR", async () => {
  for (const pr of [{ head: { sha: 'h', ref: 'feature', repo: { full_name: 'kubed-io/selenium-flow' } } }, { state: 'closed' },
    { head: { sha: 'h', ref: 'issue-6', repo: { full_name: 'someone/fork' } } }]) {
    const t = setup({ ...comment(), pr });
    await t.go();
    assert.deepEqual(t.core.outputs, { stage: 'none' });
  }
});

test("Copilot's hand-back is a review to answer, and says so in reason", async () => {
  const t = setup(dispatch('copilot', { sha: 'h', run_id: 3 }));
  assert.deepEqual(await outcome(t), ['code', `${P}review-came-in`, 'always']);
  assert.equal(t.core.outputs.reason, 'copilot');
  assert.equal(t.core.outputs.run_id, '');
});

test('reason is empty for anything but a dispatch', async () => {
  const t = setup(comment());
  await t.go();
  assert.equal(t.core.outputs.reason, '');
});
