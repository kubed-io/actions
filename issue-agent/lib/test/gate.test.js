const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../gate');
const { TAG, seenMarker } = require('../state');
const fake = require('./fake');

const labeled = (id, login, name = 'agent') => ({ event: 'labeled', label: { name }, actor: { id, login } });
const env = (over) => Object.assign(process.env, { NUMBER: '12', OPT_IN_LABEL: 'agent', MAX_RUNS: '0', TRUSTED_IDS: '4399427', SESSION_KEY: 'issue-12', ...over });

test('the last time the label was added decides', () => {
  assert.equal(gate.lastLabeledBy([labeled(1, 'someone'), labeled(4399427, 'kferrone')], 'agent').login, 'kferrone');
  assert.equal(gate.lastLabeledBy([labeled(4399427, 'kferrone'), labeled(1, 'someone')], 'agent').login, 'someone');
  assert.equal(gate.lastLabeledBy([labeled(1, 'x', 'enhancement')], 'agent'), null);
});

test('removing the label revokes it', () => {
  const unlabeled = { event: 'unlabeled', label: { name: 'agent' }, actor: { id: 4399427, login: 'kferrone' } };
  assert.equal(gate.lastLabeledBy([labeled(4399427, 'kferrone'), unlabeled], 'agent'), null);
  assert.equal(gate.lastLabeledBy([labeled(1, 'someone'), unlabeled, labeled(4399427, 'kferrone')], 'agent').login, 'kferrone');
});

test('a label a template applied for a stranger stops the run, silently', async () => {
  env({});
  const github = fake.github({ 'issues.listEventsForTimeline': [labeled(1, 'someone')] });
  const core = fake.core();
  await gate.run({ github, context: fake.context(), core });
  assert.equal(core.outputs.allowed, 'false');
  assert.ok(!github.calls.some((c) => c.name === 'issues.createComment'));
});

test('the owner\'s label lets it run', async () => {
  env({});
  const core = fake.core();
  await gate.run({ github: fake.github({ 'issues.listEventsForTimeline': [labeled(4399427, 'kferrone')] }), context: fake.context(), core });
  assert.equal(core.outputs.allowed, 'true');
});

test('max_runs pauses with one note', async () => {
  env({ OPT_IN_LABEL: '', MAX_RUNS: '2' });
  const agent = { user: { login: 'github-actions[bot]', type: 'Bot' } };
  const done = { ...agent, body: `${TAG}\n${seenMarker({ key: 'issue-12', through: 't' })}` };
  const github = fake.github({ 'issues.listComments': [done, done], 'issues.createComment': {} });
  const core = fake.core();
  await gate.run({ github, context: fake.context(), core });
  assert.equal(core.outputs.allowed, 'false');
  assert.equal(github.calls.filter((c) => c.name === 'issues.createComment').length, 1);
  assert.equal(gate.runsSoFar([done, { body: 'x' }], 'issue-12'), 1);
  const stranger = { body: done.body, user: { login: 'someone', type: 'User' } };
  assert.equal(gate.runsSoFar([done, stranger], 'issue-12'), 1);
});

test('a one-off with no thread is always allowed', async () => {
  env({ NUMBER: '' });
  const core = fake.core();
  await gate.run({ github: fake.github(), context: fake.context(), core });
  assert.equal(core.outputs.allowed, 'true');
});

test('an empty trusted list refuses everyone, the owner included', async () => {
  env({ TRUSTED_IDS: '' });
  const core = fake.core();
  await gate.run({ github: fake.github({ 'issues.listEventsForTimeline': [labeled(4399427, 'kferrone')] }), context: fake.context(), core });
  assert.equal(core.outputs.allowed, 'false');
});

test('the cap note is posted once, and not again after later comments', async () => {
  env({ OPT_IN_LABEL: '', MAX_RUNS: '2' });
  const agent = { user: { login: 'github-actions[bot]', type: 'Bot' } };
  const done = { ...agent, body: `${TAG}\n${seenMarker({ key: 'issue-12', through: 't' })}` };
  const capNote = { user: agent.user, body: `${TAG}\n<!-- issue-agent-cap -->\nPaused.` };
  const ownerComment = { user: { login: 'kferrone', type: 'User' }, body: 'more' };
  const github = fake.github({ 'issues.listComments': [done, done, capNote, ownerComment], 'issues.createComment': {} });
  const core = fake.core();
  await gate.run({ github, context: fake.context(), core });
  assert.equal(core.outputs.allowed, 'false');
  assert.equal(github.calls.filter((c) => c.name === 'issues.createComment').length, 0);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const parts = require('../../../comment/lib/parts');

test("a refused turn the thread is waiting on says why, in comment/start's comment", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  env({ RUNNER_TEMP: tmp });
  parts.open(parts.dirOf(process.env, 12), { comment_id: 7, number: 12 });
  const core = fake.core();
  await gate.run({ github: fake.github({ 'issues.listEventsForTimeline': [labeled(235398881, 'kubed-io[bot]')] }), context: fake.context(), core });
  assert.equal(core.outputs.allowed, 'false');
  const [said] = parts.partsOf(parts.dirOf(process.env, 12));
  assert.match(said, /didn't run: `agent was last added by @kubed-io\[bot\], not a trusted user`/);
});

test('with no comment/start, a refusal leaves nothing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  env({ RUNNER_TEMP: tmp });
  await gate.run({ github: fake.github({ 'issues.listEventsForTimeline': [labeled(1, 'someone')] }), context: fake.context(), core: fake.core() });
  assert.deepEqual(parts.partsOf(parts.dirOf(process.env, 12)), []);
});

test("the App's label counts when its bot's id is trusted, never its login", async () => {
  const events = [labeled(235398881, 'kubed-io[bot]')];
  for (const [ids, allowed] of [['4399427,235398881', 'true'], ['4399427,kubed-io[bot]', 'false']]) {
    env({ TRUSTED_IDS: ids, RUNNER_TEMP: fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')) });
    const core = fake.core();
    await gate.run({ github: fake.github({ 'issues.listEventsForTimeline': events }), context: fake.context(), core });
    assert.equal(core.outputs.allowed, allowed, ids);
  }
});
