// issue-agent between comment/start and comment/end: the comment is theirs, so the answer
// becomes a part, and the run says where the comment is now.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('../state');
const thread = require('../thread');
const comment = require('../comment');
const parts = require('../../../comment/lib/parts');
const fake = require('./fake');

const OWNER = { login: 'kferrone', id: 4399427, type: 'User' };
const APP = { login: 'kubed-io[bot]', id: 9, type: 'Bot' };
const RUN = 'https://run/7';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pair-'));
const c = (id, user, at, body) => ({ id, user, created_at: at, updated_at: at, body });
const placeholder = (id, at, runId = 7) => c(id, APP, at, `${state.TAG}\n${state.placeholderMarker(runId)}\nWorking on it…`);

test('each session reads its own marker from the trailing group; one before it never counts', () => {
  const plan = { key: 'plan', through: 't1', id: '1' };
  const code = { key: 'code', through: 't2', id: '2' };
  const one = `${state.TAG}\nDone.\n\n<sub>[Run](${RUN})</sub>\n${state.seenMarker(plan)}\n\n> [!WARNING]\n> **Not committed:** x.`;
  assert.deepEqual(state.readSeenFor(one, 'plan'), plan);
  assert.equal(state.readSeenFor(one, 'code'), null);
  const both = `${state.TAG}\nquoting ${state.seenMarker({ key: 'other', through: 't9', id: '9' })}\n\n<sub>[Run](${RUN})</sub>\n${state.seenMarker(plan)}\n${state.seenMarker(code)}`;
  assert.deepEqual(state.readSeenFor(both, 'code'), code);
  assert.deepEqual(state.readSeenFor(both, 'plan'), plan);
  assert.equal(state.readSeenFor(both, 'other'), null);
  const m = [thread.fromComment(c(5, APP, '2026-11-03T10:10:00Z', both))];
  assert.equal(thread.lastSeen(m, 'plan').through, 't1');
});

test('a second turn in the job: this run\'s placeholder is no message, and the first turn\'s answer counts as seen', async () => {
  const ws = tmp();
  const temp = tmp();
  const issue = { number: 12, title: 'T', body: 'Do it.', user: OWNER, created_at: '2026-11-03T10:00:00Z', labels: [] };
  const github = fake.github({
    'issues.get': issue,
    'issues.listComments': [c(20, OWNER, '2026-11-03T10:01:00Z', 'Plan it.'), placeholder(21, '2026-11-03T10:02:00Z'), placeholder(22, '2026-11-03T09:00:00Z', 6)],
  });
  const env = { GITHUB_WORKSPACE: ws, RUNNER_TEMP: temp, NUMBER: '12', PROMPT: '', TRUSTED_IDS: '4399427', TRUSTED_BOTS: '', SESSION_KEY: 'issue-12', SCRATCH_DIR: '.issue', RESUMED: 'true', COMMENT_ID: '21' };
  Object.assign(process.env, env);
  let core = fake.core();
  await thread.run({ github, context: fake.context({ runId: 7 }), core });
  assert.ok(core.outputs.prompt.includes('Plan it.'));
  const context = fs.readFileSync(path.join(ws, '.issue', 'context.md'), 'utf8');
  assert.equal(context.split('Working on it').length, 2, 'only the other run\'s placeholder is in the context');

  parts.addSeen(parts.dirOf(env, 12), { key: 'issue-12', through: core.outputs.through, id: core.outputs.through_id });
  core = fake.core();
  await thread.run({ github, context: fake.context({ runId: 7 }), core });
  assert.equal(core.outputs.prompt, '');
  for (const k of Object.keys(env)) delete process.env[k];
});

test('the answer is a part with its header, and its seen marker waits beside it', async () => {
  const temp = tmp();
  const env = { MODE: 'part', RUNNER_TEMP: temp, NUMBER: '12', COMMENT_ID: '21', LIVE: 'false', REPLY: 'Planned.\n', HEADER: '📄 Plan', PROMPT: '', SESSION_KEY: 'issue-12', THROUGH: 't', THROUGH_ID: '20', RUN_URL: RUN };
  Object.assign(process.env, env);
  const github = fake.github();
  await comment.run({ github, context: fake.context({ runId: 7 }), core: fake.core() });
  assert.equal(github.calls.length, 0);
  const dir = parts.dirOf(env, 12);
  assert.deepEqual(parts.partsOf(dir), ['📄 Plan\n\nPlanned.']);
  assert.deepEqual(parts.seenOf(dir).map(({ answered, ...s }) => s), [{ key: 'issue-12', through: 't', id: '20' }]);
  for (const k of Object.keys(env)) delete process.env[k];
});

test('the run ends saying where the comment is now: where n8n moved it, or comment/start\'s', async () => {
  const env = { MODE: 'where', NUMBER: '12', COMMENT_ID: '21' };
  Object.assign(process.env, env);
  let core = fake.core();
  await comment.run({ github: fake.github({ 'issues.listComments': [placeholder(21, '2026-11-03T10:02:00Z'), placeholder(30, '2026-11-03T10:05:00Z')] }), context: fake.context({ runId: 7 }), core });
  assert.equal(core.outputs.comment_id, '30');
  core = fake.core();
  await comment.run({ github: fake.github({ 'issues.listComments': new Error('down') }), context: fake.context({ runId: 7 }), core });
  assert.equal(core.outputs.comment_id, '21');
  assert.equal(core.notices.length, 1);
  for (const k of Object.keys(env)) delete process.env[k];
});
