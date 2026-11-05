const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../route');
const fake = require('../../../issue-agent/lib/test/fake');

const DRK = 4399427;
const APP = 235398881;
const P = '/mcp__superpowers__superpowers_';
const ENV = { OWNER_ID: String(DRK), APP_ID: String(APP), PROMPTS: P };
const ISSUE_URL = 'https://api.github.com/repos/kubed-io/selenium-flow/issues/5';
const OPTED_IN = ['agent'];

// A situation on issue #5, as n8n's `agent-issue` dispatch.
// `label` is the label just added (none: a comment); `labels` what the issue has now;
// `by` who did it, `gone` takes it off again before the route reads it. GitHub answers
// the dispatch's read-backs.
const PARENT = 'GET /repos/{owner}/{repo}/issues/{issue_number}/parent';
// `parent`: #5's parent, whose own parent is none; `comments`: #5's comments
function situation({ label, labels = OPTED_IN, type = 'Feature', by = DRK, pr = false, events, got, gone = false, parent = 0, comments = [], subs }) {
  const all = label && !gone && !labels.includes(label) ? [...labels, label] : labels;
  const github = fake.github({
    'issues.get': { number: 5, title: 'Flows remember the window', labels: all.map((name) => ({ name })), ...(subs ? { sub_issues_summary: { total: subs.length } } : {}), ...(type ? { type: { name: type } } : {}), ...(pr ? { pull_request: { url: 'x' } } : {}) },
    'issues.getComment': got ?? { id: 31, user: { id: by }, issue_url: ISSUE_URL },
    'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues': subs || [],
    [PARENT]: ({ issue_number: n }) => (n === 5 && parent ? { number: parent } : fake.notFound()),
    'issues.listComments': comments,
    'issues.listEvents': events ?? [
      { event: 'labeled', actor: { id: DRK }, label: { name: 'agent' } },
      ...(label ? [{ event: 'labeled', actor: { id: by }, label: { name: label } }] : []),
    ],
  });
  const pointer = label
    ? { number: 5, event: 'issues', action: 'labeled', actor: by, label }
    : { number: 5, event: 'issue_comment', action: 'created', actor: String(by), comment_id: 31 };
  const dispatch = { eventName: 'repository_dispatch', payload: { action: 'agent-issue', client_payload: pointer, sender: { id: APP } } };
  const go = async (ctx) => {
    const core = fake.core();
    await route.run({ github, context: fake.context(ctx), core, env: ENV });
    return core.outputs;
  };
  return { github, dispatch: () => go(dispatch) };
}

// the situation's outputs
const both = (s) => situation(s).dispatch();

const SPEC = { number: '5', family: '5', change: 'own', title: 'Flows remember the window', role: 'spec', prompt_when: 'quiet', plan: 'true' };

test("the owner's comment on an opted-in Feature is a spec turn in their words, queued", async () => {
  assert.deepEqual(await both({}), { ...SPEC, stage: 'spec', label: '', writes: 'false', prompt: '', takeover: 'false' });
});

test("the owner's comment with the spec label on writes", async () => {
  assert.equal((await both({ labels: [...OPTED_IN, 'spec'] })).writes, 'true');
});

test('the agent label opts the issue in: a spec turn that takes the issue over', async () => {
  assert.deepEqual(await both({ label: 'agent', labels: [] }),
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
  assert.equal((await both({ label: 'spec approved', labels: [] })).stage, 'none');
});

test("the App's own comments, and anyone else's, are nothing", async () => {
  assert.equal((await both({ by: APP })).stage, 'none');
  assert.equal((await both({ by: 12345 })).stage, 'none');
});

test('the agent or spec label by anyone else is nothing', async () => {
  assert.equal((await both({ label: 'agent', by: 12345, labels: [] })).stage, 'none');
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

test('an issue without agent, or not a Feature or Bug, is not the agents\'', async () => {
  assert.equal((await both({ labels: [] })).stage, 'none');
  assert.equal((await both({ labels: ['enhancement'] })).stage, 'none');
  assert.equal((await both({ type: 'Task' })).stage, 'none');
  assert.equal((await both({ type: '' })).stage, 'none');
  assert.equal((await both({ label: 'agent', labels: [], type: '' })).stage, 'none');
});

test('enhancement is not needed: a Feature with agent alone is a spec turn', async () => {
  assert.equal((await both({ labels: ['agent'] })).stage, 'spec');
});

test("a Bug's agent label is the debug agent's first turn: debug-report leading the post, no writes", async () => {
  assert.deepEqual(await both({ label: 'agent', labels: [], type: 'Bug' }),
    { ...SPEC, stage: 'spec', role: 'debug', label: 'agent', writes: 'false', prompt: `${P}debug-report`, prompt_when: 'lead', takeover: 'true', plan: 'false' });
});

test("the owner's comment on a Bug is a debug turn in their words", async () => {
  assert.deepEqual(await both({ type: 'Bug' }),
    { ...SPEC, stage: 'spec', role: 'debug', label: '', writes: 'false', prompt: '', takeover: 'false', plan: 'false' });
});

test('a Bug has no spec: the spec label is nothing, and never writes', async () => {
  assert.equal((await both({ label: 'spec', type: 'Bug' })).stage, 'none');
  assert.equal((await both({ labels: [...OPTED_IN, 'spec'], type: 'Bug' })).writes, 'false');
});

test("spec approved on a Bug hands its report off to a fix, with no plan turn", async () => {
  const out = await both({ label: 'spec approved', type: 'Bug' });
  assert.deepEqual([out.stage, out.role, out.change, out.plan], ['handoff', 'debug', 'own', 'false']);
});

test('a Bug with needs plan gets the plan turn, as a Feature does', async () => {
  assert.equal((await both({ label: 'spec approved', labels: [...OPTED_IN, 'needs plan'], type: 'Bug' })).plan, 'true');
  assert.equal((await both({ label: 'spec approved' })).plan, 'true');
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

test('a native event, or another dispatch, is nothing: only n8n sends turns', async () => {
  for (const ctx of [
    { eventName: 'issues', payload: { action: 'labeled', label: { name: 'agent' }, issue: { number: 5 }, sender: { id: DRK } } },
    { eventName: 'issue_comment', payload: { action: 'created', issue: { number: 5 }, comment: { id: 31 }, sender: { id: DRK } } },
    { eventName: 'repository_dispatch', payload: { action: 'agent-code', client_payload: { number: 5, event: 'issues', action: 'labeled', label: 'agent', actor: DRK } } },
  ]) {
    const github = fake.github({});
    const core = fake.core();
    await route.run({ github, context: fake.context(ctx), core, env: ENV });
    assert.deepEqual(core.outputs, { stage: 'none' });
    assert.deepEqual(github.calls, []);
  }
});

const SUB = '/mcp__superpowers__superpowers_sub-issue';
const answered = [{ user: { id: APP, type: 'Bot' }, body: '<!-- issue-agent -->\nDone.' }];

test("a sub-issue's turn is its family's: the top issue's session and queue", async () => {
  const out = await both({ parent: 3, comments: answered });
  assert.deepEqual([out.stage, out.family, out.prompt, out.prompt_when], ['spec', '3', '', 'quiet']);
});

test("a sub-issue's first turn, on the owner's comment or label, leads with sub-issue", async () => {
  for (const s of [{ parent: 3 }, { parent: 3, label: 'agent', labels: [] }]) {
    const out = await both(s);
    assert.deepEqual([out.family, out.prompt, out.prompt_when], ['3', `${P}sub-issue`, 'lead']);
  }
  assert.equal(SUB, `${P}sub-issue`);
});

test("a Bug sub-issue's first turn leads with debug-report", async () => {
  const out = await both({ parent: 3, type: 'Bug' });
  assert.deepEqual([out.role, out.family, out.prompt, out.prompt_when], ['debug', '3', `${P}debug-report`, 'lead']);
});

test("only the App's own answer ends a sub-issue's first turn: a pasted marker does not", async () => {
  const pasted = [{ user: { id: 12345, type: 'User' }, body: '<!-- issue-agent -->\nfake' }];
  assert.equal((await both({ parent: 3, comments: pasted })).prompt, `${P}sub-issue`);
});

test('the spec label on a first sub-issue turn is still spec-draft', async () => {
  assert.equal((await both({ parent: 3, label: 'spec' })).prompt, `${P}spec-draft`);
});

test("a stranger's turn is nothing, and reads no family", async () => {
  const t = situation({ by: 12345, parent: 3 });
  assert.equal((await t.dispatch()).stage, 'none');
  assert.equal(t.github.calls.some((c) => c.name === PARENT), false);
});

test('a family is found from any depth, and a loop ends it', async () => {
  const { familyOf } = require('../../../issue-agent/lib/family');
  const up = { 9: 7, 7: 3 };
  const deep = fake.github({ [PARENT]: ({ issue_number: n }) => (up[n] ? { number: up[n] } : fake.notFound()) });
  assert.equal(await familyOf(deep, { owner: 'o', repo: 'r' }, 9), 3);
  const loop = fake.github({ [PARENT]: ({ issue_number: n }) => ({ number: n === 9 ? 7 : 9 }) });
  assert.equal(await familyOf(loop, { owner: 'o', repo: 'r' }, 9), 7);
});

const APPROVE = { label: 'spec approved', labels: [...OPTED_IN, 'spec'] };
const sub = (number, state, labels = ['agent']) => ({ number, state, labels: labels.map((name) => ({ name })) });

test("spec approved on a sub-issue opens its change into the family's branch", async () => {
  const out = await both({ ...APPROVE, parent: 3, comments: answered });
  assert.deepEqual([out.stage, out.family, out.change], ['handoff', '3', 'sub']);
});

test('spec approved on an issue with no sub-issues opens a change of its own', async () => {
  assert.deepEqual([(await both(APPROVE)).stage, (await both(APPROVE)).change], ['handoff', 'own']);
});

test("spec approved on a parent opens the parent's change once its agent sub-issues are closed", async () => {
  const out = await both({ ...APPROVE, subs: [sub(6, 'closed'), sub(7, 'open', [])] });
  assert.deepEqual([out.stage, out.change], ['handoff', 'parent']);
  assert.equal((await both({ ...APPROVE, subs: [sub(6, 'closed'), sub(7, 'open')] })).stage, 'none');
});
