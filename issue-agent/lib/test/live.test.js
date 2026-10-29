const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const live = require('../live');
const state = require('../state');
const fake = require('./fake');

const OWNER = { login: 'kferrone', id: 4399427, type: 'User' };
const STRANGER = { login: 'someone', id: 1, type: 'User' };
const APP = { login: 'kubed-io[bot]', id: 235398881, type: 'Bot' };
const TRUST = { ids: ['4399427'], bots: [] };
const SEEN = { key: 'pr-81', through: '2026-10-29T10:00:00Z', id: '1' };

const at = (mm) => `2026-10-29T10:${mm}:00Z`;
const comment = (id, user, mm, body = 'text') => ({ id, user, created_at: at(mm), updated_at: at(mm), body });
const msg = (id, user, mm, kind = 'comment') => ({ id, kind, user, at: at(mm), updated: null, body: 'text' });
const placeholder = (id, runId, mm, user = APP) => comment(id, user, mm, `${state.TAG}\n${state.placeholderMarker(runId)}\nWorking on it…`);

// an inbox as the channel writes it, and the hook's cursor after the first `upTo` lines
function inbox(lines, upTo = lines.length) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'inbox.jsonl');
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).map((l) => `${l}\n`);
  fs.writeFileSync(file, text.join(''));
  if (upTo != null) fs.writeFileSync(`${file}.cursor`, String(Buffer.byteLength(text.slice(0, upTo).join(''))));
  return file;
}
const line = (comment_kind, comment_id) => ({ at: at('30'), kind: 'message', comment_kind, number: 81, delivery: `d${comment_id}`, comment_id, author: 'kferrone', created_at: at('00'), url: 'u', text: 't' });

test('the inbox is CLAUDE_CHANNEL_INBOX, else under RUNNER_TEMP, else under /tmp', () => {
  assert.equal(live.inboxPath({ CLAUDE_CHANNEL_INBOX: '/x/in.jsonl', RUNNER_TEMP: '/r' }), '/x/in.jsonl');
  assert.equal(live.inboxPath({ RUNNER_TEMP: '/r' }), '/r/agent-flow/inbox.jsonl');
  assert.equal(live.inboxPath({}), '/tmp/agent-flow/inbox.jsonl');
});

test('handed: the comments and reviews before the cursor; notices, replies and garbage are not', () => {
  const file = inbox([
    line('comment', 11),
    line('event', 12),
    { at: at('31'), kind: 'reply', comment_id: 11, status: 200, posted: true, text: 'r' },
    'not json',
    line('review', 500),
    line('comment', 13),
  ], 5);
  assert.deepEqual(live.handed(file), [{ kind: 'comment', id: '11' }, { kind: 'review', id: '500' }]);
});

test('handed: no inbox, no cursor, a zero, garbled or out-of-range cursor hand nothing over', () => {
  assert.deepEqual(live.handed('/nowhere/inbox.jsonl'), []);
  assert.deepEqual(live.handed(inbox([line('comment', 11)], null)), []);
  for (const cursor of ['0', 'x', '99999', '-1']) {
    const file = inbox([line('comment', 11)]);
    fs.writeFileSync(`${file}.cursor`, cursor);
    assert.deepEqual(live.handed(file), [], cursor);
  }
});

test('the placeholder is the newest of this run\'s, posted by a bot with the tag; a human\'s copy is not', () => {
  const comments = [
    placeholder(100, 7, '00'),
    placeholder(101, 7, '01', OWNER),
    placeholder(102, 6, '03'),
    comment(104, APP, '04', state.placeholderMarker(7)),
    placeholder(103, 7, '02'),
  ];
  assert.equal(live.findPlaceholder(comments, 7).id, 103);
  assert.equal(live.findPlaceholder(comments, 8), null);
});

test('advance: a handed message after the turn\'s through moves it there', () => {
  const messages = [msg(11, OWNER, '05')];
  assert.deepEqual(live.advance(SEEN, [{ kind: 'comment', id: '11' }], messages, TRUST), { ...SEEN, through: at('05'), id: '11' });
});

test('advance: never past a trusted message the hook did not hand over (posted before the channel was live)', () => {
  const messages = [msg(10, OWNER, '03'), msg(11, OWNER, '05')];
  assert.deepEqual(live.advance(SEEN, [{ kind: 'comment', id: '11' }], messages, TRUST), SEEN);
  // handed, missed, handed: only the first counts
  const three = [msg(11, OWNER, '04'), msg(12, OWNER, '05'), msg(13, OWNER, '06')];
  const handed = [{ kind: 'comment', id: '11' }, { kind: 'comment', id: '13' }];
  assert.deepEqual(live.advance(SEEN, handed, three, TRUST), { ...SEEN, through: at('04'), id: '11' });
});

test('advance: a missed message in the same second as a handed one holds through back', () => {
  const messages = [msg(11, OWNER, '05'), msg(12, OWNER, '05')];
  assert.deepEqual(live.advance(SEEN, [{ kind: 'comment', id: '11' }], messages, TRUST), SEEN);
});

test('advance: a stranger\'s comment and the agent\'s own are not missed messages', () => {
  const messages = [msg(10, STRANGER, '02'), { ...msg(9, APP, '03'), kind: 'agent' }, msg(11, OWNER, '05')];
  assert.equal(live.advance(SEEN, [{ kind: 'comment', id: '11' }], messages, TRUST).through, at('05'));
});

test('advance: a review is matched as a review, never as a comment with the same id', () => {
  const messages = [msg(500, OWNER, '05', 'review')];
  assert.equal(live.advance(SEEN, [{ kind: 'review', id: '500' }], messages, TRUST).through, at('05'));
  assert.deepEqual(live.advance(SEEN, [{ kind: 'comment', id: '500' }], messages, TRUST), SEEN);
});

test('advance: no turn through, or nothing handed, leaves the marker as it was', () => {
  const messages = [msg(11, OWNER, '05')];
  const none = { key: 'pr-81', through: '', id: '' };
  assert.deepEqual(live.advance(none, [{ kind: 'comment', id: '11' }], messages, TRUST), none);
  assert.deepEqual(live.advance(SEEN, [], messages, TRUST), SEEN);
});

test('settle on a PR: one comment listing finds the placeholder; a handed review is read from the reviews', async () => {
  const github = fake.github({
    'issues.listComments': [placeholder(60, 7, '01'), comment(11, OWNER, '04')],
    'pulls.listReviews': [{ id: 500, user: OWNER, submitted_at: at('06'), state: 'COMMENTED', body: 'Hm.' }],
    'pulls.listReviewComments': [],
  });
  const env = { NUMBER: '81', IS_PR: 'true', TRUSTED_IDS: '4399427', TRUSTED_BOTS: '', CLAUDE_CHANNEL_INBOX: inbox([line('comment', 11), line('review', 500)]) };
  const out = await live.settle({ github, context: fake.context({ runId: 7 }), env, seen: SEEN });
  assert.equal(out.commentId, 60);
  assert.deepEqual(out.seen, { ...SEEN, through: at('06'), id: '500' });
  assert.equal(github.calls.filter((c) => c.name === 'issues.listComments').length, 1);
});

test('settle with nothing handed reads no reviews; with no seen it only finds the placeholder', async () => {
  const github = fake.github({ 'issues.listComments': [placeholder(60, 7, '01')] });
  const env = { NUMBER: '81', IS_PR: 'true', TRUSTED_IDS: '4399427', CLAUDE_CHANNEL_INBOX: '/nowhere/inbox.jsonl' };
  assert.deepEqual(await live.settle({ github, context: fake.context({ runId: 7 }), env, seen: SEEN }), { commentId: 60, seen: SEEN });
  assert.deepEqual(await live.settle({ github, context: fake.context({ runId: 8 }), env }), { commentId: 0 });
  assert.ok(!github.calls.some((c) => c.name.startsWith('pulls.')));
});
