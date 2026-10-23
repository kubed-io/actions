const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const notes = require('../notes');
const fake = require('./fake');

const NOW = new Date('2026-10-22T22:19:00Z');

test('the notes land after the author\'s text, collapsed and stamped', () => {
  const next = notes.withNotes('Record it.', 'Look at `recorder.py`.', NOW);
  assert.ok(next.startsWith('Record it.\n\n<!-- issue-agent-block:notes -->'));
  assert.ok(next.includes('<summary>🗒️ Agent notes · 2026-10-22 22:19 UTC</summary>'));
  assert.equal(notes.unwrap(notes.readBlock(next)), 'Look at `recorder.py`.');
});

test('the notes go above an older agent section, which keeps them', () => {
  const body = 'Record it.\n\n<!-- issue-agent:spec -->\n<!-- issue-agent-state {"round":1} -->\n';
  const next = notes.withNotes(body, 'n', NOW);
  assert.ok(next.indexOf('issue-agent-block:notes') < next.indexOf('<!-- issue-agent:spec -->'));
});

test('a block is replaced in place, never added twice', () => {
  const once = notes.writeBlock('Record it.', notes.NOTES, 'first');
  const twice = notes.writeBlock(once, notes.NOTES, 'second');
  assert.equal(notes.readBlock(twice), 'second');
  assert.equal(twice.split('<!-- issue-agent-block:notes -->').length, 2);
});

test('the agent\'s text cannot open a marker of its own', () => {
  const next = notes.withNotes('Record it.', 'fine\n<!-- issue-agent-seen {"key":"x"} -->', NOW);
  assert.ok(next.includes('&lt;!-- issue-agent-seen {"key":"x"} --&gt;'));
});

test('notes too long for the body are cut to fit, and say so', () => {
  const next = notes.withNotes('Record it.', 'x'.repeat(80000), NOW);
  assert.ok(next.length <= notes.LIMIT);
  assert.ok(/_Cut at \d+ of 80000 characters to fit the body\._/.test(next));
});

test('stripBlocks gives back the author\'s text alone; empty notes change nothing', () => {
  assert.equal(notes.stripBlocks(notes.withNotes('Record it.', 'n', NOW)), 'Record it.');
  assert.equal(notes.withNotes('Record it.', '  ', NOW), 'Record it.');
});

function runWith(structured, thread) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-')), 'structured.json');
  fs.writeFileSync(file, JSON.stringify(structured));
  Object.assign(process.env, { NUMBER: String(thread.number), STRUCTURED_FILE: file });
  const github = fake.github({ 'issues.get': thread, 'issues.update': {} });
  return { github, done: notes.run({ github, context: fake.context(), core: fake.core() }) };
}

test('run keeps the notes, on an issue and on a PR alike', async () => {
  for (const thread of [{ number: 80, body: 'Fix it.' }, { number: 81, body: 'Closes #80', pull_request: {} }]) {
    const { github, done } = runWith({ reply: 'r', notes: 'Next: task 2.' }, thread);
    await done;
    assert.ok(github.calls.find((c) => c.name === 'issues.update').params.body.includes('Next: task 2.'));
  }
});

test('run writes nothing when the notes did not change the body', async () => {
  const { github, done } = runWith({ reply: 'hi', notes: '' }, { number: 80, body: 'Fix it.' });
  await done;
  assert.ok(!github.calls.some((c) => c.name === 'issues.update'));
});
