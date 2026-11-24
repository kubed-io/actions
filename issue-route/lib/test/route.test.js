const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../route');
const fake = require('../../../issue-agent/lib/test/fake');

const DRK = 4399427;
const APP = 235398881;
const P = '/mcp__superpowers__superpowers_';
const ENV = { OWNER_ID: String(DRK), APP_ID: String(APP), PROMPTS: P, GITHUB_WORKFLOW_REF: 'kubed-io/selenium-flow/.github/workflows/agent-issue.yml@refs/heads/main', ACTIONS_TOKEN: 'ghs_actions' };
const ISSUE_URL = 'https://api.github.com/repos/kubed-io/selenium-flow/issues/5';
const OPTED_IN = ['agent'];

// A situation on issue #5, as n8n's `agent-issue` dispatch.
// `label` is the label just added (none: a comment); `labels` what the issue has now;
// `by` who did it, `gone` takes it off again before the route reads it. GitHub answers
// the dispatch's read-backs.
const PARENT = 'GET /repos/{owner}/{repo}/issues/{issue_number}/parent';
// `parent`: #5's parent, whose own parent is none; `comments`: #5's comments
// `runs`: this workflow's runs in flight, by status, each with its `jobs`
function situation({ label, labels = OPTED_IN, type = 'Feature', by = DRK, pr = false, events, got, gone = false, parent = 0, comments = [], subs, runs = {}, env = ENV }) {
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
  // the actions token's own client: the runs and their jobs
  const actions = fake.github({
    'actions.listWorkflowRuns': runs instanceof Error ? runs : ({ status }) => ({ workflow_runs: (runs[status] || []).map(({ id }) => ({ id })) }),
    'actions.listWorkflowRunsForRepo': ({ status }) => ({ workflow_runs: (runs[status] || []).map(({ id }) => ({ id })) }),
    'actions.listJobsForWorkflowRun': ({ run_id: id }) => ({ jobs: Object.values(runs).flat().find((r) => r.id === id)?.jobs || [] }),
  });
  const tokens = [];
  const getOctokit = (token) => { tokens.push(token); return actions; };
  const pointer = label
    ? { number: 5, event: 'issues', action: 'labeled', actor: by, label }
    : { number: 5, event: 'issue_comment', action: 'created', actor: String(by), comment_id: 31 };
  const dispatch = { eventName: 'repository_dispatch', payload: { action: 'agent-issue', client_payload: pointer, sender: { id: APP } } };
  const go = async (ctx) => {
    const core = fake.core();
    await route.run({ github, context: fake.context({ runId: 900, ...ctx }), core, getOctokit, env });
    go.core = core;
    return core.outputs;
  };
  return { github, actions, tokens, go, dispatch: () => go(dispatch) };
}

// the situation's outputs
const both = (s) => situation(s).dispatch();

const SPEC = { opt_in_label: 'agent', number: '5', family: '5', change: 'own', title: 'Flows remember the window', role: 'spec', prompt_when: 'quiet', plan: 'true', session: 'issue-5', fork_from: '', kin: 'alone' };

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

test("spec approved on a parent opens the parent's change, its agent sub-issues open or closed (R-SM33)", async () => {
  const out = await both({ ...APPROVE, subs: [sub(6, 'closed'), sub(7, 'open', [])] });
  assert.deepEqual([out.stage, out.change, out.open_sub_issues], ['handoff', 'parent', '[]']);
  const open = await both({ ...APPROVE, subs: [sub(6, 'closed'), sub(7, 'open')] });
  assert.deepEqual([open.stage, open.change, open.open_sub_issues], ['handoff', 'parent', JSON.stringify([{ number: 7, title: '' }])]);
});

// a run in flight with the family's make job in it, as the Actions API names a called job
const making = (family, status = 'in_progress') => ({ id: 41, jobs: [
  { id: 7, name: 'Agent / Accept', status: 'completed' },
  { id: 8, name: `Agent / Make the Sub-issue · #${family}`, status, html_url: 'https://github.com/x/runs/41/job/8' },
] });

test('a label queues like a comment while its family has a sub-issue being filed, running or waiting', async () => {
  for (const status of ['in_progress', 'queued']) {
    const t = situation({ label: 'spec', parent: 3, comments: answered, runs: { [status]: [making(3, status === 'queued' ? 'pending' : 'in_progress')] } });
    const out = await t.dispatch();
    assert.deepEqual([out.stage, out.family, out.takeover], ['spec', '3', 'false']);
    assert.match(t.go.core.notices[0], /spec queues behind Agent \/ Make the Sub-issue · #3/);
  }
});

test("a label still takes over when the make job in flight is another family's, finished, or this run's own", async () => {
  assert.equal((await both({ label: 'spec', runs: { in_progress: [making(3)] } })).takeover, 'true');
  assert.equal((await both({ label: 'spec', parent: 3, comments: answered, runs: { in_progress: [making(3, 'completed')] } })).takeover, 'true');
  assert.equal((await both({ label: 'spec', parent: 3, comments: answered, runs: { in_progress: [{ ...making(3), id: 900 }] } })).takeover, 'true');
  // `#3` is not `#30`
  assert.equal((await both({ label: 'spec', parent: 3, comments: answered, runs: { in_progress: [making(30)] } })).takeover, 'true');
});

test("the make-job look is the workflow's own runs, in flight; a comment or a hand-off never looks", async () => {
  const t = situation({ label: 'agent', labels: [] });
  await t.dispatch();
  const looks = t.actions.calls.filter((c) => c.name === 'actions.listWorkflowRuns').map((c) => c.params);
  assert.deepEqual(t.tokens, ['ghs_actions']);
  assert.deepEqual(looks, [
    { owner: 'kubed-io', repo: 'selenium-flow', status: 'in_progress', per_page: 100, workflow_id: 'agent-issue.yml' },
    { owner: 'kubed-io', repo: 'selenium-flow', status: 'queued', per_page: 100, workflow_id: 'agent-issue.yml' },
  ]);
  for (const s of [{}, { label: 'spec approved', labels: [...OPTED_IN, 'spec'] }]) {
    const u = situation(s);
    await u.dispatch();
    assert.deepEqual([u.tokens, u.actions.calls], [[], []]);
  }
});

test('without the workflow ref the look is the repo-wide runs', async () => {
  const t = situation({ label: 'spec', parent: 3, comments: answered, runs: { in_progress: [making(3)] }, env: { ...ENV, GITHUB_WORKFLOW_REF: '' } });
  assert.equal((await t.dispatch()).takeover, 'false');
  assert.equal(t.actions.calls.some((c) => c.name === 'actions.listWorkflowRunsForRepo'), true);
});

test("a failed look never blocks the route: the label takes over, as before, and says why", async () => {
  const t = situation({ label: 'spec', parent: 3, comments: answered, runs: Object.assign(new Error('Resource not accessible by integration'), { status: 403 }) });
  const out = await t.dispatch();
  assert.deepEqual([out.stage, out.takeover], ['spec', 'true']);
  assert.match(t.go.core.notices[0], /could not look for a make job in family #3 \(403 Resource not accessible/);
});

test('without an actions token there is no look: the label takes over, as before, and says so', async () => {
  const t = situation({ label: 'spec', parent: 3, comments: answered, runs: { in_progress: [making(3)] }, env: { ...ENV, ACTIONS_TOKEN: '' } });
  assert.equal((await t.dispatch()).takeover, 'true');
  assert.deepEqual([t.tokens, t.actions.calls], [[], []]);
  assert.match(t.go.core.notices[0], /no actions_token, so no look for a make job in family #3; spec takes over/);
});

// Sessions (spec 2026-11-24 R-SM12, R-SM13): a sub-issue thinks in a thread of its own, forked
// from its parent's; the parent, and an issue alone, keep issue-<number>

test("a sub-issue's turn is its own session, issue-<family>/<number>, forked from the family's", async () => {
  const out = await both({ parent: 3, comments: answered });
  assert.deepEqual([out.session, out.fork_from, out.kin], ['issue-3/5', 'issue-3', 'sub-issue']);
});

test("a parent's turn, and an issue's alone, are issue-<number>, forked from nothing", async () => {
  const parent = await both({ subs: [sub(6, 'open')] });
  assert.deepEqual([parent.session, parent.fork_from, parent.kin], ['issue-5', '', 'parent']);
  const alone = await both({});
  assert.deepEqual([alone.session, alone.fork_from, alone.kin], ['issue-5', '', 'alone']);
});

// The App's `spec approved` (spec 2026-11-24 R-SM19, R-SM20): the parent approves a sub-issue's
// spec on Dr K's behalf, inside its family only

test("the App's spec approved on an agent sub-issue hands off its change into the family's branch", async () => {
  const out = await both({ ...APPROVE, by: APP, parent: 3, comments: answered });
  assert.deepEqual([out.stage, out.family, out.change, out.number], ['handoff', '3', 'sub', '5']);
});

test("the App's spec approved on a middle-tier issue, a sub-issue with sub-issues of its own, is nothing", async () => {
  const out = await both({ ...APPROVE, by: APP, parent: 3, comments: answered, subs: [sub(8, 'closed')] });
  assert.deepEqual([out.stage, out.why], ['none', "the App's spec approved on a parent: only Dr K's opens the family's change"]);
});

test("the App's spec approved on a top-level issue or a parent is nothing, and says why", async () => {
  const top = situation({ ...APPROVE, by: APP });
  assert.deepEqual([(await top.dispatch()).stage, top.go.core.outputs.why], ['none', "the App's spec approved on a top-level issue"]);
  const parent = situation({ ...APPROVE, by: APP, subs: [sub(6, 'closed')] });
  assert.deepEqual([(await parent.dispatch()).stage, parent.go.core.outputs.why], ['none', "the App's spec approved on a parent: only Dr K's opens the family's change"]);
});

test("the App's spec approved on a sub-issue without agent is nothing; its other labels and comments are still nothing", async () => {
  const out = await both({ label: 'spec approved', labels: ['spec'], by: APP, parent: 3 });
  assert.deepEqual([out.stage, out.why], ['none', 'not opted in']);
  assert.equal((await both({ label: 'agent', labels: [], by: APP, parent: 3 })).stage, 'none');
  assert.equal((await both({ label: 'spec', by: APP, parent: 3 })).stage, 'none');
  assert.equal((await both({ by: APP, parent: 3, comments: answered })).stage, 'none');
});

test("Dr K's labels route as before, on a sub-issue and on a parent", async () => {
  const approved = await both({ ...APPROVE, parent: 3, comments: answered });
  assert.deepEqual([approved.stage, approved.change, approved.takeover], ['handoff', 'sub', 'true']);
  const parent = await both({ ...APPROVE, subs: [sub(6, 'closed')] });
  assert.deepEqual([parent.stage, parent.change], ['handoff', 'parent']);
  const label = await both({ label: 'agent', labels: [], parent: 3, comments: answered });
  assert.deepEqual([label.stage, label.takeover, label.prompt], ['spec', 'true', '']);
  // a Dr K label reads no parent before the stage is known
  const t = situation({ label: 'spec' });
  await t.dispatch();
  assert.equal(t.github.calls.filter((c) => c.name === PARENT).length, 1);
});

// n8n's family wake-ups (spec 2026-11-24 R-SM10, R-SM17, R-SM19, R-E2): an `agent-issue`
// dispatch whose `family_event` names it, and a pointer the route reads back. #3 is the parent, #5 and #6 its sub-issues, #9 an
// issue alone, #12 a parent of another family (#13)
const FAMILY_ISSUES = {
  3: { number: 3, title: 'Flows', labels: ['agent'], type: 'Feature', subs: 2 },
  5: { number: 5, title: 'Flows remember the window', labels: ['agent'], type: 'Feature', state: 'closed' },
  6: { number: 6, title: 'Flows remember the tab', labels: ['agent'], type: 'Bug', state: 'open' },
  9: { number: 9, title: 'Alone', labels: ['agent'], type: 'Feature' },
  12: { number: 12, title: 'Other', labels: ['agent'], type: 'Feature', subs: 1 },
  13: { number: 13, title: 'Other part', labels: ['agent'], type: 'Feature' },
  7: { number: 7, title: 'Flows remember the size', labels: ['agent'], type: 'Feature', state: 'open' },
};
const UP = { 5: 3, 6: 3, 7: 3, 13: 12 };
const url = (n) => `https://api.github.com/repos/kubed-io/selenium-flow/issues/${n}`;
// 40: the 📨 report on #3, 41: the parent's message on #5, both the App's
const FAMILY_COMMENTS = { 40: { id: 40, user: { id: APP }, issue_url: url(3) }, 41: { id: 41, user: { id: APP }, issue_url: url(5) } };

// `threads`: an issue's comments, by number; a sub-issue with none of the App's answers is on its first turn
function dispatched(kind, payload, { issues = {}, comments = {}, threads = { 5: answered, 6: answered } } = {}) {
  const all = { ...FAMILY_ISSUES, ...issues };
  const notes = { ...FAMILY_COMMENTS, ...comments };
  const github = fake.github({
    'issues.get': ({ issue_number: n }) => {
      const i = all[n];
      if (!i) return fake.notFound();
      return { number: i.number, title: i.title, state: i.state || 'open', labels: i.labels.map((name) => ({ name })), ...(i.type ? { type: { name: i.type } } : {}), ...(i.subs ? { sub_issues_summary: { total: i.subs } } : {}), ...(i.pr ? { pull_request: { url: 'x' } } : {}) };
    },
    'issues.getComment': ({ comment_id: id }) => notes[id] || fake.notFound(),
    [PARENT]: ({ issue_number: n }) => (UP[n] ? { number: UP[n] } : fake.notFound()),
    'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues': ({ issue_number: n }) => Object.values(all).filter((i) => UP[i.number] === n).map((i) => ({ number: i.number, title: i.title, state: i.state || 'open', labels: i.labels.map((name) => ({ name })) })),
    'issues.listComments': ({ issue_number: n }) => threads[n] || [],
    'issues.listEvents': [],
  });
  const go = async () => {
    const core = fake.core();
    const context = fake.context({ eventName: 'repository_dispatch', payload: { action: 'agent-issue', client_payload: { family_event: kind, ...payload }, sender: { id: APP } } });
    await route.run({ github, context, core, getOctokit: () => { throw new Error('no look'); }, env: ENV });
    go.core = core;
    return core.outputs;
  };
  return { github, go };
}
const send = async (kind, payload, over) => dispatched(kind, payload, over).go();

const PARENT_TURN = { stage: 'spec', opt_in_label: 'agent', number: '3', family: '3', change: 'own', plan: 'true', label: '', title: 'Flows', role: 'spec', writes: 'false', prompt_when: 'lead', takeover: 'false', session: 'issue-3', fork_from: '', kin: 'parent' };

test('sub-issue-closed is a parent turn with sub-issue-closed, leading, queued', async () => {
  assert.deepEqual(await send('sub-issue-closed', { parent: 3, number: 5, merged: true }),
    { ...PARENT_TURN, prompt: `${P}sub-issue-closed` });
});

test("sub-issue-reported is a parent turn with sub-issue-reported, on the App's report on the parent", async () => {
  assert.deepEqual(await send('sub-issue-reported', { parent: 3, number: 5, comment_id: 40 }),
    { ...PARENT_TURN, prompt: `${P}sub-issue-reported` });
});

test("parent-message is the sub-issue's turn with parent-message, in its own session forked from the parent's", async () => {
  assert.deepEqual(await send('parent-message', { parent: 3, number: 5, comment_id: 41 }),
    { ...PARENT_TURN, number: '5', title: 'Flows remember the window', prompt: `${P}parent-message`, session: 'issue-3/5', fork_from: 'issue-3', kin: 'sub-issue' });
});

test("sub-issue-file is the make-sub-issue turn in the parent's session: type and title, then the ask", async () => {
  const out = await send('sub-issue-file', { parent: 3, type: 'Bug', title: 'Flows lose the tab', ask: 'The tab is its own fix.\nIt merges first.' });
  assert.deepEqual(out, { ...PARENT_TURN, stage: 'file', item_type: 'Bug', prompt: `${P}make-sub-issue Bug: Flows lose the tab\nAsk: The tab is its own fix. It merges first.`, prompt_when: 'always' });
});

test('sub-issue-closed on a sub-issue still open is nothing, and says so', async () => {
  const issues = { 5: { ...FAMILY_ISSUES[5], state: 'open' } };
  const out = await send('sub-issue-closed', { parent: 3, number: 5, merged: true }, { issues });
  assert.deepEqual([out.stage, out.why], ['none', '#5 is still open']);
});

test('an empty or null family_event is no family wake-up: the turn routes as today', async () => {
  for (const familyEvent of ['', null]) {
    const github = fake.github({
      'issues.get': { number: 5, title: 'Flows remember the window', labels: [{ name: 'agent' }], type: { name: 'Feature' } },
      'issues.getComment': { id: 31, user: { id: DRK }, issue_url: ISSUE_URL },
      [PARENT]: fake.notFound(),
    });
    const core = fake.core();
    const pointer = { family_event: familyEvent, number: 5, event: 'issue_comment', action: 'created', actor: String(DRK), comment_id: 31 };
    await route.run({ github, context: fake.context({ eventName: 'repository_dispatch', payload: { action: 'agent-issue', client_payload: pointer, sender: { id: APP } } }), core, env: ENV });
    assert.deepEqual(core.outputs, { ...SPEC, stage: 'spec', label: '', writes: 'false', prompt: '', takeover: 'false' }, String(familyEvent));
  }
});

test('a family dispatch reads its pointer back: a sub-issue of another family, or of none, is nothing', async () => {
  for (const [kind, payload] of [
    ['sub-issue-closed', { parent: 3, number: 13, merged: true }],
    ['sub-issue-closed', { parent: 3, number: 9, merged: true }],
    ['sub-issue-reported', { parent: 3, number: 13, comment_id: 40 }],
  ]) {
    const out = await send(kind, payload);
    assert.equal(out.stage, 'none', `${kind} ${JSON.stringify(payload)}`);
    assert.match(out.why, /is not #3's sub-issue/);
  }
});

test("a parent turn is on a family's top issue only: a sub-issue named as the parent is nothing", async () => {
  assert.equal((await send('sub-issue-closed', { parent: 5, number: 6, merged: true })).stage, 'none');
  assert.equal((await send('sub-issue-file', { parent: 5, type: 'Feature', title: 'x', ask: 'y' })).stage, 'none');
  // an issue alone may file its first sub-issue
  assert.equal((await send('sub-issue-file', { parent: 9, type: 'Feature', title: 'x', ask: 'y' })).stage, 'file');
});

test("parent-message is on a sub-issue only: a top-level issue or a parent is nothing", async () => {
  const top = await send('parent-message', { parent: 9, number: 9, comment_id: 41 }, { comments: { 41: { id: 41, user: { id: APP }, issue_url: url(9) } } });
  assert.deepEqual([top.stage, top.why], ['none', 'not a sub-issue']);
  const parent = await send('parent-message', { parent: 3, number: 3, comment_id: 40 });
  assert.equal(parent.stage, 'none');
});

test("the report or message must be the App's comment on the thread the turn is on", async () => {
  for (const [kind, payload, comments] of [
    ['sub-issue-reported', { parent: 3, number: 5, comment_id: 40 }, { 40: { id: 40, user: { id: DRK }, issue_url: url(3) } }],
    ['sub-issue-reported', { parent: 3, number: 5, comment_id: 40 }, { 40: { id: 40, user: { id: APP }, issue_url: url(5) } }],
    ['sub-issue-reported', { parent: 3, number: 5, comment_id: 77 }, {}],
    ['sub-issue-reported', { parent: 3, number: 5 }, {}],
    ['parent-message', { parent: 3, number: 5, comment_id: 41 }, { 41: { id: 41, user: { id: 12345 }, issue_url: url(5) } }],
    ['parent-message', { parent: 3, number: 5, comment_id: 40 }, {}],
  ]) {
    const out = await send(kind, payload, { comments });
    assert.equal(out.stage, 'none', `${kind} ${JSON.stringify(payload)}`);
  }
});

test('a parent-message to a sub-issue past its spec is dropped as PAST-SPEC: its change carries on', async () => {
  const issues = { 5: { ...FAMILY_ISSUES[5], labels: ['agent', 'spec approved'] } };
  const out = await send('parent-message', { parent: 3, number: 5, comment_id: 41 }, { issues });
  assert.equal(out.stage, 'none');
  assert.match(out.why, /^PAST-SPEC: /);
});

test('an agent-issue dispatch without family_event routes as before; an unknown one, or a family type of its own, is nothing', async () => {
  // the owner's comment, exactly as today
  assert.deepEqual(await both({}), { ...SPEC, stage: 'spec', label: '', writes: 'false', prompt: '', takeover: 'false' });
  for (const payload of [
    { action: 'agent-issue', client_payload: { family_event: 'sub-issue-opened', parent: 3, number: 5 } },
    { action: 'sub-issue-closed', client_payload: { parent: 3, number: 5, merged: true } },
    { action: 'sub-issue-file', client_payload: { parent: 3, type: 'Feature', title: 'x' } },
  ]) {
    const github = fake.github({});
    const core = fake.core();
    await route.run({ github, context: fake.context({ eventName: 'repository_dispatch', payload: { ...payload, sender: { id: APP } } }), core, env: ENV });
    assert.deepEqual([core.outputs.stage, github.calls], ['none', []], JSON.stringify(payload));
  }
});

test('a family dispatch on an issue not a Feature or Bug, or a pull request, is nothing', async () => {
  for (const three of [
    { type: 'Task' },
    { pr: true },
  ]) {
    const issues = { 3: { ...FAMILY_ISSUES[3], ...three } };
    assert.equal((await send('sub-issue-closed', { parent: 3, number: 5, merged: true }, { issues })).stage, 'none', JSON.stringify(three));
    assert.equal((await send('sub-issue-file', { parent: 3, type: 'Feature', title: 'x', ask: 'y' }, { issues })).stage, 'none', JSON.stringify(three));
  }
});

// R-SM29: a parent is opted in by its sub-issues
test('sub-issue-closed on a parent without agent runs when the closed sub-issue carries agent', async () => {
  const issues = { 3: { ...FAMILY_ISSUES[3], labels: [] } };
  assert.deepEqual(await send('sub-issue-closed', { parent: 3, number: 5, merged: true }, { issues }),
    { ...PARENT_TURN, opt_in_label: 'none', prompt: `${P}sub-issue-closed` });
});

test('sub-issue-closed and -reported on a parent without agent are nothing when the sub-issue lacks agent', async () => {
  const issues = { 3: { ...FAMILY_ISSUES[3], labels: [] }, 5: { ...FAMILY_ISSUES[5], labels: [] } };
  for (const [kind, payload] of [['sub-issue-closed', { merged: true }], ['sub-issue-reported', { comment_id: 40 }]]) {
    const out = await send(kind, { parent: 3, number: 5, ...payload }, { issues });
    assert.deepEqual([out.stage, out.why], ['none', 'not opted in'], kind);
  }
});

test('a Dr K comment on a parent without agent is still nothing', async () => {
  const out = await both({ labels: [], by: DRK, subs: [sub(6, 'closed')] });
  assert.deepEqual([out.stage, out.why], ['none', 'not opted in']);
});

test('sub-issue-file on a parent without agent runs with an agent sub-issue, and is dropped with none', async () => {
  const file = { parent: 3, type: 'Bug', title: 'Flows lose the tab', ask: 'y' };
  const issues = { 3: { ...FAMILY_ISSUES[3], labels: [] } };
  const via = await send('sub-issue-file', file, { issues });
  assert.deepEqual([via.stage, via.opt_in_label], ['file', 'none']);
  const bare = { ...issues, 5: { ...FAMILY_ISSUES[5], labels: [] }, 6: { ...FAMILY_ISSUES[6], labels: [] }, 7: { ...FAMILY_ISSUES[7], labels: [] } };
  const out = await send('sub-issue-file', file, { issues: bare });
  assert.deepEqual([out.stage, out.why], ['none', 'not opted in']);
});

test('sub-issue-file needs a Feature or Bug and a title', async () => {
  assert.equal((await send('sub-issue-file', { parent: 3, type: 'Task', title: 'x', ask: 'y' })).stage, 'none');
  assert.equal((await send('sub-issue-file', { parent: 3, type: 'Feature', title: ' ', ask: 'y' })).stage, 'none');
  const bare = await send('sub-issue-file', { parent: 3, type: 'Feature', title: 'Flows keep the tab' });
  assert.equal(bare.prompt, `${P}make-sub-issue Feature: Flows keep the tab`);
});

test('a family dispatch without its numbers reads nothing', async () => {
  for (const [kind, payload] of [
    ['sub-issue-closed', { number: 5 }],
    ['sub-issue-closed', { parent: 3 }],
    ['sub-issue-reported', { parent: 3, comment_id: 40 }],
    ['parent-message', { comment_id: 41 }],
    ['parent-message', { number: 5, comment_id: 41 }],
    ['sub-issue-file', { type: 'Feature', title: 'x' }],
    ['sub-issue-start', { number: 7 }],
    ['sub-issue-start', { parent: 3 }],
    ['family-pr', { number: 3 }],
  ]) {
    const t = dispatched(kind, payload);
    assert.equal((await t.go()).stage, 'none');
    assert.deepEqual(t.github.calls, []);
  }
});

test("parent-message names the family: another family's parent is nothing", async () => {
  const out = await send('parent-message', { parent: 12, number: 5, comment_id: 41 });
  assert.deepEqual([out.stage, out.why], ['none', '#5 is not #12\'s sub-issue']);
});

test("a sub-issue's first turn, woken by the parent's message, opens with the sub-issue prompt", async () => {
  const out = await send('parent-message', { parent: 3, number: 5, comment_id: 41 }, { threads: {} });
  assert.deepEqual([out.stage, out.prompt, out.prompt_when, out.session, out.fork_from], ['spec', `${P}sub-issue`, 'lead', 'issue-3/5', 'issue-3']);
  // a Bug's first turn opens with debug-report, as on Dr K's comment
  const bug = await send('parent-message', { parent: 3, number: 6, comment_id: 42 }, { threads: {}, comments: { 42: { id: 42, user: { id: APP }, issue_url: url(6) } } });
  assert.deepEqual([bug.role, bug.prompt], ['debug', `${P}debug-report`]);
});

test("sub-issue-start is a filed sub-issue's first turn: the sub-issue prompt, in its own session forked from the parent's", async () => {
  assert.deepEqual(await send('sub-issue-start', { parent: 3, number: 7 }, { threads: {} }),
    { ...PARENT_TURN, number: '7', title: 'Flows remember the size', prompt: `${P}sub-issue`, session: 'issue-3/7', fork_from: 'issue-3', kin: 'sub-issue' });
  const bug = await send('sub-issue-start', { parent: 3, number: 6 }, { threads: {} });
  assert.deepEqual([bug.stage, bug.role, bug.prompt, bug.prompt_when], ['spec', 'debug', `${P}debug-report`, 'lead']);
});

test("sub-issue-start reads its pointer back: an open agent sub-issue of the parent, before spec approved", async () => {
  for (const [payload, issues, why] of [
    [{ parent: 3, number: 13 }, {}, /is not #3's sub-issue/],
    [{ parent: 3, number: 9 }, {}, /not a sub-issue/],
    [{ parent: 5, number: 6 }, {}, /is not #5's sub-issue/],
    [{ parent: 3, number: 5 }, {}, /#5 is closed/],
    [{ parent: 3, number: 7 }, { 7: { ...FAMILY_ISSUES[7], labels: ['agent', 'spec approved'] } }, /^PAST-SPEC: /],
    [{ parent: 3, number: 7 }, { 7: { ...FAMILY_ISSUES[7], labels: [] } }, /not opted in/],
    [{ parent: 3, number: 7 }, { 7: { ...FAMILY_ISSUES[7], pr: true } }, /a pull request/],
  ]) {
    const out = await send('sub-issue-start', payload, { issues, threads: {} });
    assert.equal(out.stage, 'none', JSON.stringify(payload));
    assert.match(out.why, why, JSON.stringify(payload));
  }
});

// R-SM32: a parent's family turns never stop for spec approved; a sub-issue's still do
test('a parent with spec approved still takes its family wake-ups', async () => {
  const issues = { 3: { ...FAMILY_ISSUES[3], labels: ['agent', 'spec approved'] } };
  assert.deepEqual(await send('sub-issue-closed', { parent: 3, number: 5, merged: true }, { issues }),
    { ...PARENT_TURN, prompt: `${P}sub-issue-closed` });
  assert.equal((await send('sub-issue-reported', { parent: 3, number: 5, comment_id: 40 }, { issues })).stage, 'spec');
  assert.equal((await send('sub-issue-file', { parent: 3, type: 'Feature', title: 'x', ask: 'y' }, { issues })).stage, 'file');
  assert.equal((await send('family-pr', { parent: 3 }, { issues })).stage, 'handoff');
});

// R-SM30: the parent's open_pr, n8n's family-pr wake-up, is the hand-off of the family's change
const FAMILY_PR = {
  stage: 'handoff', opt_in_label: 'agent', number: '3', family: '3', change: 'parent', plan: 'true', label: '', title: 'Flows',
  role: 'spec', writes: 'false', prompt: '', prompt_when: 'quiet', takeover: 'false', session: 'issue-3', fork_from: '', kin: 'parent',
  open_sub_issues: JSON.stringify([{ number: 6, title: 'Flows remember the tab' }, { number: 7, title: 'Flows remember the size' }]),
};

test('family-pr opens the parent change while its agent sub-issues are still open, and lists them', async () => {
  assert.deepEqual(await send('family-pr', { parent: 3 }), FAMILY_PR);
});

test('family-pr on a parent without agent runs through an agent sub-issue, and is nothing without one', async () => {
  const issues = { 3: { ...FAMILY_ISSUES[3], labels: [] } };
  assert.deepEqual(await send('family-pr', { parent: 3 }, { issues }), { ...FAMILY_PR, opt_in_label: 'none' });
  const bare = { ...issues, 5: { ...FAMILY_ISSUES[5], labels: [] }, 6: { ...FAMILY_ISSUES[6], labels: [] }, 7: { ...FAMILY_ISSUES[7], labels: [] } };
  const out = await send('family-pr', { parent: 3 }, { issues: bare });
  assert.deepEqual([out.stage, out.why], ['none', 'not opted in']);
});

test('family-pr only lists the open sub-issues that carry agent', async () => {
  const issues = { 6: { ...FAMILY_ISSUES[6], labels: [] } };
  const out = await send('family-pr', { parent: 3 }, { issues });
  assert.equal(out.open_sub_issues, JSON.stringify([{ number: 7, title: 'Flows remember the size' }]));
});

test('family-pr is on a family top issue with sub-issues only', async () => {
  const sub = await send('family-pr', { parent: 5 });
  assert.equal(sub.stage, 'none');
  assert.match(sub.why, /is a sub-issue of #3/);
  const alone = await send('family-pr', { parent: 9 });
  assert.deepEqual([alone.stage, alone.why], ['none', '#9 has no sub-issues']);
  assert.equal((await send('family-pr', { parent: 3 }, { issues: { 3: { ...FAMILY_ISSUES[3], type: 'Task' } } })).stage, 'none');
  assert.equal((await send('family-pr', { parent: 3 }, { issues: { 3: { ...FAMILY_ISSUES[3], pr: true } } })).stage, 'none');
});
