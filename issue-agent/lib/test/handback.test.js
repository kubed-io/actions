const test = require('node:test');
const assert = require('node:assert/strict');
const handback = require('../handback');
const fake = require('./fake');

const ENV = { AGENT_FLOW_CALLBACK_URL: 'http://n8n/cb', AGENT_FLOW_N8N_TOKEN: 'tok' };
const ACTIONS = [{ kind: 'message', number: 15, text: 'Keep the tab.' }, { kind: 'approve_spec', number: 16 }];

// a turn's hand-back: `fetch` records each POST and answers `status`, or throws
function handBack({ kin, output, number = '15', parent = '12', status = 200, env = ENV, fails }) {
  const posts = [];
  const fetch = async (url, init) => {
    posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (fails) throw fails;
    return { ok: status >= 200 && status < 300, status };
  };
  const core = fake.core();
  const run = handback.run({
    context: fake.context({ runId: 900 }), core, fetch,
    env: { ...env, KIN: kin, OUTPUT: output === undefined ? '' : JSON.stringify(output), NUMBER: number, PARENT: parent },
  });
  return run.then(() => ({ posts, core }));
}

test("a sub-issue's report goes to n8n as the report body, with the callback's token", async () => {
  const { posts, core } = await handBack({ kin: 'sub-issue', output: { report: 'Spec ready.\n' } });
  assert.deepEqual(posts, [{
    url: 'http://n8n/cb',
    headers: { 'content-type': 'application/json', 'x-agent-flow-token': 'tok' },
    body: { type: 'report', repo: 'kubed-io/selenium-flow', parent: 12, number: 15, report: 'Spec ready.', run_id: 900 },
  }]);
  assert.equal(core.outputs.sent, 'report');
});

test("a parent's actions go to n8n as the actions body, in order", async () => {
  const { posts } = await handBack({ kin: 'parent', number: '12', parent: '12', output: { actions: ACTIONS, report: 'not mine' } });
  assert.deepEqual(posts.map((p) => p.body), [{ type: 'actions', repo: 'kubed-io/selenium-flow', parent: 12, run_id: 900, actions: ACTIONS }]);
});

test('nothing is sent when the field is empty, missing, or not the kin\'s', async () => {
  for (const s of [
    { kin: 'sub-issue', output: { report: '  ' } },
    { kin: 'sub-issue', output: {} },
    { kin: 'sub-issue', output: { actions: ACTIONS } },
    { kin: 'sub-issue' },
    { kin: 'parent', output: { actions: [] } },
    { kin: 'parent', output: { report: 'Spec ready.' } },
    { kin: 'alone', output: { actions: ACTIONS, report: 'x' } },
  ]) {
    const { posts, core } = await handBack(s);
    assert.deepEqual([posts, core.notices], [[], []], JSON.stringify(s));
  }
});

test("n8n's refusal, or no answer, warns and never fails the job", async () => {
  const refused = await handBack({ kin: 'sub-issue', output: { report: 'r' }, status: 404 });
  assert.match(refused.core.notices[0], /n8n answered the report with 404/);
  const down = await handBack({ kin: 'parent', output: { actions: ACTIONS }, fails: new Error('connect ECONNREFUSED') });
  assert.match(down.core.notices[0], /the actions were not sent: connect ECONNREFUSED/);
  for (const t of [refused, down]) assert.deepEqual([t.core.failures, t.core.outputs.sent], [[], undefined]);
});

test('without the callback or its token, a warning and no POST', async () => {
  for (const env of [{ AGENT_FLOW_N8N_TOKEN: 'tok' }, { AGENT_FLOW_CALLBACK_URL: 'http://n8n/cb' }]) {
    const { posts, core } = await handBack({ kin: 'sub-issue', output: { report: 'r' }, env });
    assert.equal(posts.length, 0);
    assert.match(core.notices[0], /the report is not sent/);
  }
});
