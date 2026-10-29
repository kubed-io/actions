const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../route');
const fake = require('../../../issue-agent/lib/test/fake');

const DRK = 4399427;
const APP = 235398881;
const P = '/mcp__superpowers__superpowers_';
const ENV = { OWNER_ID: String(DRK), APP_ID: String(APP), PROMPTS: P };
const ISSUE_URL = 'https://api.github.com/repos/kubed-io/selenium-flow/issues/5';
const OPTED_IN = ['enhancement', 'agent'];

// A situation on issue #5, as GitHub sends it natively or as n8n's `agent-issue` dispatch.
// `label` is the label just added (none: a comment); `labels` what the issue has now;
// `by` who did it, `gone` takes it off again before the route reads it. GitHub answers
// the dispatch's read-backs with the same truth.
function situation({ label, labels = OPTED_IN, by = DRK, pr = false, events, got, gone = false }) {
  const all = label && !gone && !labels.includes(label) ? [...labels, label] : labels;
  const github = fake.github({
    'issues.get': { number: 5, title: 'Flows remember the window', labels: all.map((name) => ({ name })), ...(pr ? { pull_request: { url: 'x' } } : {}) },
    'issues.getComment': got ?? { id: 31, user: { id: by }, issue_url: ISSUE_URL },
    'issues.listEvents': events ?? [
      { event: 'labeled', actor: { id: DRK }, label: { name: 'enhancement' } },
      ...(label ? [{ event: 'labeled', actor: { id: by }, label: { name: label } }] : []),
    ],
  });
  const native = label
    ? { eventName: 'issues', payload: { action: 'labeled', label: { name: label }, issue: { number: 5 }, sender: { id: by } } }
    : { eventName: 'issue_comment', payload: { action: 'created', issue: { number: 5 }, comment: { id: 31 }, sender: { id: by } } };
  const pointer = label
    ? { number: 5, event: 'issues', action: 'labeled', actor: by, label }
    : { number: 5, event: 'issue_comment', action: 'created', actor: String(by), comment_id: 31 };
  const dispatch = { eventName: 'repository_dispatch', payload: { action: 'agent-issue', client_payload: pointer, sender: { id: APP } } };
  const go = async (ctx) => {
    const core = fake.core();
    await route.run({ github, context: fake.context(ctx), core, env: ENV });
    return core.outputs;
  };
  return { github, native: () => go(native), dispatch: () => go(dispatch) };
}

// the same situation gives the same outputs, natively and dispatched
async function both(s) {
  const t = situation(s);
  const native = await t.native();
  assert.deepEqual(await t.dispatch(), native);
  return native;
}

const SPEC = { number: '5', title: 'Flows remember the window' };

test("the owner's comment on an opted-in issue is a spec turn in their words, queued", async () => {
  assert.deepEqual(await both({}), { ...SPEC, stage: 'spec', label: '', writes: 'false', prompt: '', takeover: 'false' });
});

test("the owner's comment with the spec label on writes", async () => {
  assert.equal((await both({ labels: [...OPTED_IN, 'spec'] })).writes, 'true');
});

test('the agent label opts the issue in: a spec turn that takes the issue over', async () => {
  assert.deepEqual(await both({ label: 'agent', labels: ['enhancement'] }),
    { ...SPEC, stage: 'spec', label: 'agent', writes: 'false', prompt: '', takeover: 'true' });
});

test('the spec label is a spec turn with spec-draft, branch and writes on', async () => {
  assert.deepEqual(await both({ label: 'spec' }),
    { ...SPEC, stage: 'spec', label: 'spec', writes: 'true', prompt: `${P}spec-draft`, takeover: 'true' });
});

test('spec approved by the owner hands off to the plan, taking the issue over', async () => {
  const out = await both({ label: 'spec approved', labels: [...OPTED_IN, 'spec'] });
  assert.deepEqual([out.stage, out.takeover, out.prompt, out.label], ['handoff', 'true', '', 'spec approved']);
});

test('spec approved by anyone else, or on an issue not opted in, is nothing', async () => {
  assert.equal((await both({ label: 'spec approved', by: 12345 })).stage, 'none');
  assert.equal((await both({ label: 'spec approved', labels: ['enhancement'] })).stage, 'none');
});

test("the App's own comments, and anyone else's, are nothing", async () => {
  assert.equal((await both({ by: APP })).stage, 'none');
  assert.equal((await both({ by: 12345 })).stage, 'none');
});

test('the agent or spec label by anyone else is nothing', async () => {
  assert.equal((await both({ label: 'agent', by: 12345, labels: ['enhancement'] })).stage, 'none');
  assert.equal((await both({ label: 'spec', by: APP })).stage, 'none');
});

test('any other label wakes nothing, the enhancement label included', async () => {
  assert.equal((await both({ label: 'enhancement', labels: ['agent'] })).stage, 'none');
  assert.equal((await both({ label: 'bug' })).stage, 'none');
});

test('after spec approved, a comment or a spec label is nothing: the change carries on', async () => {
  const done = [...OPTED_IN, 'spec approved'];
  assert.equal((await both({ labels: done })).stage, 'none');
  assert.equal((await both({ label: 'spec', labels: done })).stage, 'none');
});

test('an issue without enhancement and agent is not the agents\'', async () => {
  assert.equal((await both({ labels: ['enhancement'] })).stage, 'none');
  assert.equal((await both({ labels: ['agent'] })).stage, 'none');
  assert.equal((await both({ label: 'agent', labels: [] })).stage, 'none');
});

test('a pull request is not a work item, spec approved included', async () => {
  assert.equal((await both({ pr: true })).stage, 'none');
  assert.equal((await both({ label: 'spec approved', pr: true })).stage, 'none');
});

test('a label taken off again before the route reads it is nothing', async () => {
  const off = [{ event: 'labeled', actor: { id: DRK }, label: { name: 'spec' } }, { event: 'unlabeled', actor: { id: DRK }, label: { name: 'spec' } }];
  assert.equal((await both({ label: 'spec', gone: true, events: off })).stage, 'none');
});

test('agent-issue: the comment\'s author is read back by its id; a contradiction, another thread or a gone comment is nothing', async () => {
  const t = situation({});
  await t.dispatch();
  assert.deepEqual(t.github.calls.find((c) => c.name === 'issues.getComment').params, { owner: 'kubed-io', repo: 'selenium-flow', comment_id: 31 });
  assert.equal((await situation({ got: { user: { id: 12345 }, issue_url: ISSUE_URL } }).dispatch()).stage, 'none');
  assert.equal((await situation({ got: { user: { id: DRK }, issue_url: ISSUE_URL.replace(/5$/, '6') } }).dispatch()).stage, 'none');
  assert.equal((await situation({ got: fake.notFound() }).dispatch()).stage, 'none');
});

test('agent-issue: the labeler is the latest to add that label, whatever the payload says', async () => {
  // the payload names the owner; the issue's events say someone else added it
  const t = situation({ label: 'spec', events: [{ event: 'labeled', actor: { id: 12345 }, label: { name: 'spec' } }] });
  assert.equal((await t.dispatch()).stage, 'none');
  assert.deepEqual(t.github.calls.find((c) => c.name === 'issues.listEvents').params, { owner: 'kubed-io', repo: 'selenium-flow', issue_number: 5, per_page: 100 });
});

test('agent-issue: an unknown event or action, or no number, is nothing and reads nothing', async () => {
  for (const pointer of [
    { number: 5, event: 'issues', action: 'unlabeled', actor: DRK, label: 'agent' },
    { number: 5, event: 'issue_comment', action: 'edited', actor: DRK, comment_id: 31 },
    { number: 5, event: 'pull_request_review', action: 'submitted', actor: DRK },
    { event: 'issue_comment', action: 'created', actor: DRK, comment_id: 31 },
    { number: 5, event: 'issues', action: 'labeled', actor: DRK },
  ]) {
    const github = fake.github({});
    const core = fake.core();
    await route.run({ github, context: fake.context({ eventName: 'repository_dispatch', payload: { action: 'agent-issue', client_payload: pointer } }), core, env: ENV });
    assert.deepEqual(core.outputs, { stage: 'none' });
    assert.deepEqual(github.calls, []);
  }
});

test('a native event it was never meant for is nothing', async () => {
  const github = fake.github({});
  const core = fake.core();
  await route.run({ github, context: fake.context({ eventName: 'issues', payload: { action: 'opened', issue: { number: 5 }, sender: { id: DRK } } }), core, env: ENV });
  assert.deepEqual(core.outputs, { stage: 'none' });
});
