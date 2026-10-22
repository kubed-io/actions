const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const notes = require('../notes');
const state = require('../state');
const fake = require('./fake');

const NOW = new Date('2026-10-22T22:19:00Z');
const SPEC = { slug: 'rec', path: 'docs/superpowers/specs/2026-10-22-rec-design.md', round: 1, run: '5', artifact: '7',
  artifact_url: 'https://github.com/kubed-io/selenium-flow/actions/runs/5/artifacts/7',
  summary_url: 'https://github.com/kubed-io/selenium-flow/actions/runs/5#summary-9', approved: false };

test('the blocks land between the author\'s text and the round section, which keeps them', () => {
  const body = state.writeSection('Record it.', 'spec', SPEC, ['links']);
  const next = notes.blocks(body, { notes: 'Look at `recorder.py`.', draft: '# Rec', document: 'spec', now: NOW });
  assert.ok(next.startsWith('Record it.\n\n<!-- issue-agent-block:notes -->'));
  assert.ok(next.indexOf('issue-agent-block:draft') < next.indexOf('<!-- issue-agent:spec -->'));
  assert.ok(next.includes('<summary>🗒️ Agent notes · 2026-10-22 22:19 UTC</summary>'));
  assert.ok(next.includes('<summary>📐 Draft spec · 2026-10-22 22:19 UTC</summary>'));
  // a later round rewrites the section and the blocks survive it
  const again = state.writeSection(next, 'spec', { ...SPEC, round: 2 }, ['links']);
  assert.equal(notes.readBlock(again, notes.NOTES), notes.readBlock(next, notes.NOTES));
  assert.equal(state.readState(again, 'spec').round, 2);
});

test('a block is replaced in place, never added twice', () => {
  const once = notes.writeBlock('Record it.', notes.NOTES, 'first');
  const twice = notes.writeBlock(once, notes.NOTES, 'second');
  assert.equal(notes.readBlock(twice, notes.NOTES), 'second');
  assert.equal(twice.split('<!-- issue-agent-block:notes -->').length, 2);
});

test('the agent\'s text cannot open a marker of its own', () => {
  const sneaky = `fine\n<!-- issue-agent:spec -->\n<!-- issue-agent-state {"round":9} -->`;
  const next = notes.blocks('Record it.', { notes: sneaky, now: NOW });
  assert.equal(state.readState(next, 'spec'), null);
  assert.ok(next.includes('&lt;!-- issue-agent:spec --&gt;'));
});

test('notes too long for the body are cut to fit, and say so', () => {
  const next = notes.blocks('Record it.', { notes: 'x'.repeat(80000), now: NOW });
  assert.ok(next.length <= notes.LIMIT);
  assert.ok(/_Cut at \d+ of 80000 characters to fit the body\./.test(next));
});

test('stripBlocks gives back the author\'s text alone', () => {
  const body = notes.blocks('Record it.', { notes: 'n', draft: 'd', document: 'spec', now: NOW });
  assert.equal(notes.stripBlocks(body), 'Record it.');
});

function runWith(structured, thread) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-')), 'structured.json');
  fs.writeFileSync(file, JSON.stringify(structured));
  Object.assign(process.env, { NUMBER: String(thread.number), STRUCTURED_FILE: file, DOCUMENT: 'spec', NOTES_FIELD: 'notes' });
  const github = fake.github({ 'issues.get': thread, 'issues.update': {} });
  return { github, done: notes.run({ github, context: fake.context(), core: fake.core() }) };
}

test('run keeps the notes and the draft on an issue', async () => {
  const { github, done } = runWith({ notes: 'Start at the grid.', spec: '# Draft' }, { number: 80, body: 'Fix it.' });
  await done;
  const body = github.calls.find((c) => c.name === 'issues.update').params.body;
  assert.ok(body.includes('Start at the grid.'));
  assert.ok(body.includes('# Draft'));
});

test('run keeps only the notes on a PR: its document is committed on the branch', async () => {
  const { github, done } = runWith({ notes: 'Next: task 2.', spec: '# Not here' }, { number: 81, body: 'Closes #80', pull_request: {} });
  await done;
  const body = github.calls.find((c) => c.name === 'issues.update').params.body;
  assert.ok(body.includes('Next: task 2.'));
  assert.ok(!body.includes('# Not here'));
});

test('run writes nothing when the turn returned no notes', async () => {
  const { github, done } = runWith({ reply: 'hi' }, { number: 80, body: 'Fix it.' });
  await done;
  assert.ok(!github.calls.some((c) => c.name === 'issues.update'));
});
