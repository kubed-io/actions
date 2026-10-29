const test = require('node:test');
const assert = require('node:assert/strict');
const comment = require('../comment');
const state = require('../state');
const fake = require('./fake');

const RUN = 'https://github.com/kubed-io/selenium-flow/actions/runs/1/job/2';

test('the reply is header, answer, run link and the seen marker', () => {
  const body = comment.reply({ header: '📄 Plan · [plan.md](https://b/plan.md)', text: 'Done.\n', runUrl: RUN, seen: { key: 'issue-12', through: 't', id: '9' } });
  assert.equal(body, `${state.TAG}\n📄 Plan · [plan.md](https://b/plan.md)\n\nDone.\n\n<sub>[Run](${RUN})</sub>\n${state.seenMarker({ key: 'issue-12', through: 't', id: '9' })}`);
});

test('the header template is filled from the run and the role\'s output', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'h-')), 's.json');
  fs.writeFileSync(file, JSON.stringify({ reply: 'r', notes: 'n', output: { plan_path: 'docs/plan.md' } }));
  const header = comment.headerOf({ STRUCTURED_FILE: file, HEADER: '📄 [{{ output.plan_path }}]({{ blob }}/{{ output.plan_path }}) · #{{ number }}', BLOB: 'https://b', NUMBER: '81', RUN_URL: RUN });
  assert.equal(header, '📄 [docs/plan.md](https://b/docs/plan.md) · #81');
  assert.equal(comment.headerOf({ HEADER: '' }), '');
});

test('a dispatch prompt is quoted above the answer, and no seen marker without a message', () => {
  const body = comment.reply({ prompt: 'Is it safe?\nShort.', text: 'Yes.', runUrl: RUN, seen: { key: 'k', through: '' } });
  assert.ok(body.includes('> Is it safe?\n> Short.\n\nYes.'));
  assert.ok(!body.includes('issue-agent-seen'));
});

test('a seen marker spoofed in the reply text is not the one read back', () => {
  const fake = '<!-- issue-agent-seen {"key":"issue-12","through":"2099-01-01T00:00:00Z","id":"x"} -->';
  const body = comment.reply({ text: `Answer ${fake}`, runUrl: RUN, seen: { key: 'issue-12', through: 't', id: '9' } });
  assert.deepEqual(state.readSeen(body), { key: 'issue-12', through: 't', id: '9' });
});

test('placeholder and failure are tagged as the action\'s', () => {
  assert.ok(comment.placeholder({ runUrl: RUN }).startsWith(`${state.TAG}\nWorking on it…`));
  assert.ok(comment.failure({ runUrl: RUN }).includes("⚠️ I didn't finish this one."));
});

test('ack posts the placeholder and outputs its id; reply edits it', async () => {
  const github = fake.github({ 'issues.createComment': { id: 55 }, 'issues.updateComment': {} });
  const core = fake.core();
  Object.assign(process.env, { MODE: 'ack', NUMBER: '12', RUN_URL: RUN, PROMPT: '' });
  await comment.run({ github, context: fake.context(), core });
  assert.equal(core.outputs.comment_id, '55');
  Object.assign(process.env, { MODE: 'reply', COMMENT_ID: '55', REPLY: 'Hello.', HEADER: '', SESSION_KEY: 'issue-12', THROUGH: 't', THROUGH_ID: '9' });
  await comment.run({ github, context: fake.context(), core });
  const edit = github.calls.find((c) => c.name === 'issues.updateComment');
  assert.equal(edit.params.comment_id, 55);
  assert.ok(edit.params.body.includes('Hello.'));
  assert.equal(core.outputs.posted, 'true');
});

test('an empty reply fails the step', async () => {
  const core = fake.core();
  Object.assign(process.env, { MODE: 'reply', REPLY: '  ' });
  await comment.run({ github: fake.github(), context: fake.context(), core });
  assert.deepEqual(core.failures, ['the agent wrote no reply']);
  assert.equal(core.outputs.posted, undefined);
});

test('a prompt that is a slash command is not quoted: it is an instruction, not words in the thread', () => {
  const body = comment.reply({ prompt: '/mcp__superpowers__superpowers_review', text: 'Looks good.', runUrl: RUN, seen: { key: 'k', through: '' } });
  assert.ok(!body.includes('mcp__superpowers'));
  assert.ok(body.startsWith(`${state.TAG}\nLooks good.`));
  assert.ok(!comment.placeholder({ prompt: '/mcp__x__y', runUrl: RUN }).includes('mcp__x__y'));
});

// live_messages: the placeholder n8n moved, and the inbox the hook handed over
const os = require('os');
const path = require('path');
const fs = require('fs');

const OWNER = { login: 'kferrone', id: 4399427, type: 'User' };
const APP = { login: 'kubed-io[bot]', id: 235398881, type: 'Bot' };
const MOVED = { id: 60, user: APP, created_at: '2026-10-29T10:06:00Z', body: `${state.TAG}\n${state.placeholderMarker(7)}\nWorking on it…` };
const ASKED = { id: 11, user: OWNER, created_at: '2026-10-29T10:05:00Z', updated_at: '2026-10-29T10:05:00Z', body: 'how is it going?' };

function liveEnv(mode, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
  const inbox = path.join(dir, 'inbox.jsonl');
  const text = `${JSON.stringify({ kind: 'message', comment_kind: 'comment', comment_id: 11, created_at: ASKED.created_at })}\n`;
  fs.writeFileSync(inbox, text);
  fs.writeFileSync(`${inbox}.cursor`, String(Buffer.byteLength(text)));
  Object.assign(process.env, {
    MODE: mode, LIVE: 'true', NUMBER: '12', COMMENT_ID: '55', RUN_URL: RUN, PROMPT: '', REPLY: 'Hello.', HEADER: '',
    SESSION_KEY: 'issue-12', THROUGH: '2026-10-29T10:00:00Z', THROUGH_ID: '9', IS_PR: 'false',
    TRUSTED_IDS: '4399427', TRUSTED_BOTS: '', CLAUDE_CHANNEL_INBOX: inbox, ...extra,
  });
}

test('live: the placeholder carries the run, on the line after the tag', async () => {
  liveEnv('ack');
  const github = fake.github({ 'issues.createComment': { id: 55 } });
  await comment.run({ github, context: fake.context({ runId: 7 }), core: fake.core() });
  const body = github.calls[0].params.body;
  assert.ok(body.startsWith(`${state.TAG}\n<!-- issue-agent-placeholder {"run_id": 7} -->\nWorking on it…`));
  assert.deepEqual(state.readPlaceholder(body), { run_id: 7 });
});

test('live: the answer goes into the placeholder where n8n moved it, and its seen marker covers what was handed over', async () => {
  liveEnv('reply');
  const github = fake.github({ 'issues.listComments': [ASKED, MOVED], 'issues.updateComment': { id: 60 } });
  const core = fake.core();
  await comment.run({ github, context: fake.context({ runId: 7 }), core });
  const edit = github.calls.find((c) => c.name === 'issues.updateComment').params;
  assert.equal(edit.comment_id, 60);
  assert.deepEqual(state.readSeen(edit.body), { key: 'issue-12', through: ASKED.created_at, id: '11' });
  assert.equal(state.readPlaceholder(edit.body), null);
  assert.equal(core.outputs.comment_id, '60');
  assert.equal(core.outputs.posted, 'true');
});

test('live: with no placeholder left, the answer is a new comment', async () => {
  liveEnv('reply');
  const github = fake.github({ 'issues.listComments': [ASKED], 'issues.createComment': { id: 61 } });
  const core = fake.core();
  await comment.run({ github, context: fake.context({ runId: 7 }), core });
  assert.equal(github.calls.find((c) => c.name === 'issues.createComment').params.issue_number, 12);
  assert.ok(!github.calls.some((c) => c.name === 'issues.updateComment'));
  assert.equal(core.outputs.comment_id, '61');
});

test('live: the failure note replaces the moved placeholder', async () => {
  liveEnv('failure');
  const github = fake.github({ 'issues.listComments': [ASKED, MOVED], 'issues.updateComment': { id: 60 } });
  await comment.run({ github, context: fake.context({ runId: 7 }), core: fake.core() });
  const edit = github.calls.find((c) => c.name === 'issues.updateComment').params;
  assert.equal(edit.comment_id, 60);
  assert.ok(edit.body.includes("I didn't finish this one"));
});

test('off: the placeholder, the answer and the failure note are today\'s, on the saved id, with no listing', async () => {
  for (const off of ['', 'false']) {
    liveEnv('ack', { LIVE: off });
    const github = fake.github({ 'issues.createComment': { id: 55 }, 'issues.updateComment': { id: 55 } });
    await comment.run({ github, context: fake.context({ runId: 7 }), core: fake.core() });
    assert.equal(github.calls[0].params.body, comment.placeholder({ prompt: '', runUrl: RUN }));
    assert.ok(!github.calls[0].params.body.includes('issue-agent-placeholder'));
    for (const mode of ['reply', 'failure']) {
      process.env.MODE = mode;
      const core = fake.core();
      await comment.run({ github, context: fake.context({ runId: 7 }), core });
      assert.equal(github.calls.at(-1).params.comment_id, 55);
      assert.equal(core.outputs.comment_id, undefined);
    }
    assert.deepEqual(state.readSeen(github.calls.at(-2).params.body), { key: 'issue-12', through: '2026-10-29T10:00:00Z', id: '9' });
    assert.ok(!github.calls.some((c) => c.name === 'issues.listComments'));
  }
});

test('live: a placeholder n8n moved between the lookup and the edit is looked up once more', async () => {
  liveEnv('reply');
  const MOVED_AGAIN = { ...MOVED, id: 62, created_at: '2026-10-29T10:07:00Z' };
  let listed = 0;
  const gone = Object.assign(new Error('Not Found'), { status: 404 });
  const github = fake.github({
    'issues.listComments': () => (listed++ ? [ASKED, MOVED_AGAIN] : [ASKED, MOVED]),
    'issues.updateComment': (p) => (p.comment_id === 60 ? gone : { id: p.comment_id }),
  });
  const core = fake.core();
  await comment.run({ github, context: fake.context({ runId: 7 }), core });
  assert.deepEqual(github.calls.filter((c) => c.name === 'issues.updateComment').map((c) => c.params.comment_id), [60, 62]);
  assert.equal(core.outputs.comment_id, '62');
  assert.equal(core.outputs.posted, 'true');
});

test('live: a failure note whose lookup fails still replaces the saved placeholder', async () => {
  liveEnv('failure');
  const github = fake.github({ 'issues.listComments': new Error('boom'), 'issues.updateComment': { id: 55 } });
  await comment.run({ github, context: fake.context({ runId: 7 }), core: fake.core() });
  assert.equal(github.calls.find((c) => c.name === 'issues.updateComment').params.comment_id, 55);
});
