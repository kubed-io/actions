const test = require('node:test');
const assert = require('node:assert/strict');
const comment = require('../comment');
const state = require('../state');
const fake = require('./fake');

const RUN = 'https://github.com/kubed-io/selenium-flow/actions/runs/1/job/2';

test('the reply is header, answer, run link and the seen marker', () => {
  const body = comment.reply({ header: '📄 **Spec** · round 2', text: 'Done.\n', runUrl: RUN, seen: { key: 'issue-12', through: 't', id: '9' } });
  assert.equal(body, `${state.TAG}\n> 📄 **Spec** · round 2\n\nDone.\n\n<sub>[Run](${RUN})</sub>\n${state.seenMarker({ key: 'issue-12', through: 't', id: '9' })}`);
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
