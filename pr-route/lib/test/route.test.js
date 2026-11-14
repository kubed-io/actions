const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../route');
const fake = require('../../../issue-agent/lib/test/fake');

const DRK = 4399427;
const APP = 235398881;
const COPILOT = 175728472;
const P = '/mcp__superpowers__superpowers_';
const ENV = { OWNER_ID: String(DRK), APP_ID: String(APP), COPILOT_ID: String(COPILOT), PREFIX: 'issue-', LABEL: 'plan approved', PROMPTS: P };

const ISSUE_URL = 'https://api.github.com/repos/kubed-io/selenium-flow/issues/7';
const labelEvents = (...evs) => evs.map(([event, id, name = 'plan approved']) => ({ event, actor: { id }, label: { name } }));

// the agents' PR #7; `approved` puts the label on it, `message` is its head commit's; `got`
// is the comment GitHub has, `events` the PR's issue events
function setup({ eventName, payload, approved = true, draft = true, message = 'Task 3', pr = {}, review = {}, lineComments = 2,
  got = { user: { id: DRK }, issue_url: ISSUE_URL }, events = labelEvents(['labeled', DRK]) }) {
  const github = fake.github({
    'pulls.get': {
      state: 'open', draft, labels: approved ? [{ name: 'plan approved' }] : [],
      head: { sha: 'h'.repeat(40), ref: 'issue-6', repo: { full_name: 'kubed-io/selenium-flow' } },
      ...pr,
    },
    'repos.getCommit': { commit: { message } },
    'pulls.getReview': { user: { id: DRK }, commit_id: 'h'.repeat(40), ...review },
    'pulls.listCommentsForReview': Array.from({ length: lineComments }, (_, i) => ({ id: i })),
    'issues.getComment': got,
    'issues.listEvents': events,
  });
  const core = fake.core();
  const go = () => route.run({ github, context: fake.context({ eventName, payload }), core, env: ENV });
  return { core, github, go };
}
// n8n's relay: a repository_dispatch of type agent-route, the payload a pointer
const routed = (extra = {}) => ({ eventName: 'repository_dispatch', payload: { action: 'agent-route', client_payload: { pull_request: 7, event: 'pull_request_review', action: 'submitted', actor: DRK, review_id: 9, ...extra }, sender: { id: 41898282 } } });
const push = (actor) => routed({ event: 'pull_request', action: 'synchronize', actor, review_id: undefined });
const dispatch = (reason, extra = {}) => ({ eventName: 'repository_dispatch', payload: { action: 'agent-code', client_payload: { pull_request: 7, reason, ...extra }, sender: { id: 41898282 } } });

const outcome = async (t) => { await t.go(); const o = t.core.outputs; return [o.stage, o.prompt, o.prompt_when]; };

test('only a dispatch is a turn: a native event is nothing', async () => {
  for (const ctx of [
    { eventName: 'issue_comment', payload: { issue: { number: 7 }, sender: { id: DRK } } },
    { eventName: 'pull_request_target', payload: { pull_request: { number: 7 }, sender: { id: DRK } } },
    { eventName: 'workflow_run', payload: { workflow_run: { event: 'pull_request', pull_requests: [{ number: 7 }], triggering_actor: { id: APP } } } },
  ]) {
    const t = setup(ctx);
    await t.go();
    assert.deepEqual(t.core.outputs, { stage: 'none' });
    assert.deepEqual(t.github.calls, []);
  }
});

test('before the approval, a push or a dispatch is nothing', async () => {
  assert.deepEqual((await outcome(setup({ ...push(DRK), approved: false })))[0], 'none');
  assert.deepEqual((await outcome(setup({ ...dispatch('ci'), approved: false })))[0], 'none');
});

test('a push to a PR out of draft, or by anyone else, wakes nothing', async () => {
  assert.equal((await outcome(setup({ ...push(APP), draft: false })))[0], 'none');
  assert.equal((await outcome(setup(push(12345))))[0], 'none');
});

test('failed checks are a code turn, its prompt the whole turn, with the run for its report', async () => {
  const t = setup(dispatch('ci', { run_id: 42 }));
  assert.deepEqual(await outcome(t), ['code', `${P}checks-failed`, 'always']);
  assert.equal(t.core.outputs.run_id, '42');
});

test("a Bug's fix dispatch is the first code turn, built from the report by fix-approved", async () => {
  const t = setup(dispatch('fix'));
  assert.deepEqual(await outcome(t), ['code', `${P}fix-approved`, 'always']);
  assert.equal(t.core.outputs.takeover, 'false');
});

test("a conflict dispatch, pr-update's, is a code turn in words: the base and the paths it could not settle", async () => {
  const t = setup(dispatch('conflict', { base: 'main', paths: 'src/x.py, docs' }));
  assert.deepEqual(await outcome(t), ['code',
    "`main` moved, and merging it into this branch conflicts in src/x.py, docs. Merge it in, resolve them so both sides' changes stay, run the checks, and carry on. "
      + "Merge in this checkout (`git merge --no-commit --no-ff origin/main`), `git add` what you resolved and leave it uncommitted: the job commits it as a real merge.",
    'always']);
  assert.equal(t.core.outputs.reason, 'conflict');
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
    const t = setup({ ...routed({ event: 'issue_comment', action: 'created', comment_id: 31, review_id: undefined }), pr });
    await t.go();
    assert.deepEqual(t.core.outputs, { stage: 'none' });
  }
});

test('reason is empty for anything but an agent-code dispatch', async () => {
  const t = setup(routed({ event: 'issue_comment', action: 'created', comment_id: 31, review_id: undefined }));
  await t.go();
  assert.equal(t.core.outputs.reason, '');
});


test("agent-route: the owner's review is a code turn after the approval, a plan turn before", async () => {
  assert.deepEqual(await outcome(setup({ ...routed(), draft: false })), ['code', '', 'quiet']);
  assert.equal((await outcome(setup({ ...routed(), approved: false })))[0], 'plan');
});

// #68: the approval started a code turn that was still running when the PR was merged
test("agent-route: the owner's approval is nothing, before the plan is approved or after", async () => {
  for (const approved of [true, false]) {
    const t = setup({ ...routed(), approved, review: { state: 'APPROVED', body: '' } });
    assert.equal((await outcome(t))[0], 'none');
  }
  // with words in it, still nothing
  assert.equal((await outcome(setup({ ...routed(), review: { state: 'APPROVED', body: 'Ship it' } })))[0], 'none');
  // a comment or a request for changes is still a turn
  for (const state of ['COMMENTED', 'CHANGES_REQUESTED']) {
    assert.equal((await outcome(setup({ ...routed(), review: { state, body: 'One more thing' } })))[0], 'code');
  }
});

test("agent-route: Copilot's review, submitted or edited, is a code turn in its own words, like the owner's", async () => {
  for (const action of ['submitted', 'edited']) {
    const t = setup({ ...routed({ actor: COPILOT, action }), draft: false, review: { user: { id: COPILOT }, commit_id: 'old', body: '### Changes recommended' } });
    assert.deepEqual(await outcome(t), ['code', '', 'quiet']);
  }
});

test("agent-route: Copilot's review on a draft, before the approval, or one saying it could not review, is nothing", async () => {
  const base = { ...routed({ actor: COPILOT, action: 'edited' }), draft: false, review: { user: { id: COPILOT } } };
  assert.equal((await outcome(setup({ ...base, draft: true })))[0], 'none');
  assert.equal((await outcome(setup({ ...base, approved: false })))[0], 'none');
  for (const body of ['Copilot encountered an error and was unable to review this pull request.', "Copilot wasn't able to review any files in this pull request.", 'Copilot was unable to review this pull request because the user who requested the review has insufficient remaining quota.']) {
    assert.equal((await outcome(setup({ ...base, review: { user: { id: COPILOT }, body } })))[0], 'none');
  }
});

test("agent-route: a review claiming to be Copilot's, by someone else, or anyone else's edit, is nothing", async () => {
  assert.equal((await outcome(setup({ ...routed({ actor: COPILOT }), draft: false, review: { user: { id: 12345 } } })))[0], 'none');
  assert.equal((await outcome(setup({ ...routed({ action: 'edited' }), draft: false })))[0], 'none');
});

test("agent-route: the App's own review replies are nothing", async () => {
  assert.equal((await outcome(setup({ ...routed({ actor: APP }), draft: false, review: { user: { id: APP } } })))[0], 'none');
});

test("agent-route: a payload actor the review's author contradicts is nothing", async () => {
  assert.equal((await outcome(setup({ ...routed({ actor: DRK }), review: { user: { id: 12345 } } })))[0], 'none');
});

test('agent-route: the App\'s push to the draft is the next task; the finishing one wakes nothing', async () => {
  const push = routed({ event: 'pull_request', action: 'synchronize', actor: APP, review_id: undefined });
  assert.deepEqual(await outcome(setup({ ...push })), ['code', `${P}next-task`, 'quiet']);
  assert.equal((await outcome(setup({ ...push, message: 'Task 8\n\nAgent: done' })))[0], 'none');
});

test('agent-route: an unknown or missing event, or an action the relay never carried, is nothing', async () => {
  assert.equal((await outcome(setup(routed({ event: undefined, review_id: undefined }))))[0], 'none');
  assert.equal((await outcome(setup({ ...routed({ event: 'issue_comment' }), approved: false })))[0], 'none');
  assert.equal((await outcome(setup(routed({ action: 'dismissed' }))))[0], 'none');
  assert.equal((await outcome(setup(routed({ event: 'pull_request', action: 'labeled', actor: DRK, review_id: undefined }))))[0], 'none');
});

test('agent-route: a review without a usable id, or one GitHub no longer has, is nothing, not a failure', async () => {
  for (const review_id of [undefined, 'abc', 0]) {
    assert.equal((await outcome(setup(routed({ review_id }))))[0], 'none');
  }
  const t = setup(routed());
  const missing = Object.assign(new Error('Not Found'), { status: 404 });
  const github = fake.github({ 'pulls.get': { state: 'open', draft: true, labels: [{ name: 'plan approved' }], head: { sha: 'h', ref: 'issue-6', repo: { full_name: 'kubed-io/selenium-flow' } } }, 'repos.getCommit': { commit: { message: '' } }, 'pulls.getReview': missing });
  const core = fake.core();
  await route.run({ github, context: fake.context(routed()), core, env: ENV });
  assert.equal(core.outputs.stage, 'none');
  assert.ok(t);
});

// phase 3: n8n relays the owner's comments and the approval label as agent-route too
const said = (extra = {}) => routed({ event: 'issue_comment', action: 'created', comment_id: 31, review_id: undefined, ...extra });
const approval = (extra = {}) => routed({ event: 'pull_request', action: 'labeled', label: 'plan approved', review_id: undefined, ...extra });
test("agent-route: the owner's comment is a plan turn before the approval, a code turn after, in their words", async () => {
  assert.deepEqual(await outcome(setup({ ...said(), approved: false })), ['plan', '', 'quiet']);
  const t = setup(said());
  assert.deepEqual(await outcome(t), ['code', '', 'quiet']);
  assert.equal(t.core.outputs.takeover, 'false');
  assert.equal(t.core.outputs.head, 'issue-6');
});

test("agent-route: the comment's author is read back by its id", async () => {
  const t = setup(said());
  await t.go();
  assert.deepEqual(t.github.calls.find((c) => c.name === 'issues.getComment').params, { owner: 'kubed-io', repo: 'selenium-flow', comment_id: 31 });
});

test("agent-route: a comment by anyone but the owner, the App's own included, is nothing, before or after the approval", async () => {
  for (const approved of [true, false]) {
    for (const id of [APP, COPILOT, 12345]) {
      assert.equal((await outcome(setup({ ...said({ actor: id }), approved, got: { user: { id }, issue_url: ISSUE_URL } })))[0], 'none');
    }
  }
});

test('agent-route: a comment whose author contradicts the actor, on another thread, gone, or with no id, is nothing', async () => {
  assert.equal((await outcome(setup({ ...said(), got: { user: { id: 12345 }, issue_url: ISSUE_URL } })))[0], 'none');
  assert.equal((await outcome(setup({ ...said(), got: { user: { id: DRK }, issue_url: ISSUE_URL.replace(/7$/, '8') } })))[0], 'none');
  assert.equal((await outcome(setup({ ...said(), got: fake.notFound() })))[0], 'none');
  for (const comment_id of [undefined, 'abc', 0]) {
    assert.equal((await outcome(setup(said({ comment_id }))))[0], 'none');
  }
});

test('agent-route: a comment action other than created is nothing', async () => {
  assert.equal((await outcome(setup(said({ action: 'edited' }))))[0], 'none');
});

test("agent-route: the owner's approval label takes the PR over and starts the code, with plan-approved", async () => {
  const t = setup(approval());
  assert.deepEqual(await outcome(t), ['code', `${P}plan-approved`, 'quiet']);
  assert.equal(t.core.outputs.takeover, 'true');
  assert.equal(t.core.outputs.head, 'issue-6');
});

test('agent-route: the labeler is the latest labeled event for that label, whatever the payload says', async () => {
  // the payload's actor is not who labelled it
  assert.equal((await outcome(setup({ ...approval({ actor: 12345 }) })))[0], 'code');
  // the owner labelled it once, then someone else did, after it was removed
  const relabelled = labelEvents(['labeled', DRK], ['unlabeled', DRK], ['labeled', 12345], ['labeled', DRK, 'agent']);
  assert.equal((await outcome(setup({ ...approval(), events: relabelled })))[0], 'none');
});

test('agent-route: the approval label by anyone else, never labelled, or taken off again, is nothing', async () => {
  assert.equal((await outcome(setup({ ...approval({ actor: APP }), events: labelEvents(['labeled', APP]) })))[0], 'none');
  assert.equal((await outcome(setup({ ...approval(), events: labelEvents(['labeled', DRK, 'agent']) })))[0], 'none');
  assert.equal((await outcome(setup({ ...approval(), events: labelEvents(['labeled', DRK], ['unlabeled', DRK]), approved: false })))[0], 'none');
  // gone from the PR, whatever the events say
  assert.equal((await outcome(setup({ ...approval(), approved: false })))[0], 'none');
});

test('agent-route: any other label is an unknown event', async () => {
  const t = setup({ ...approval({ label: 'agent' }), events: labelEvents(['labeled', DRK, 'agent']) });
  assert.equal((await outcome(t))[0], 'none');
  assert.equal(t.github.calls.some((c) => c.name === 'issues.listEvents'), false);
  assert.equal((await outcome(setup(approval({ label: undefined }))))[0], 'none');
});
