const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const reply = require('../reply');
const fake = require('./fake');

const user = (text) => ({ type: 'user', message: { content: [{ type: 'text', text }] } });
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
const text = (t, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: t }] } });
const tool = (name, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const result = { type: 'result', num_turns: 3, total_cost_usd: 0.25, permission_denials: [{}] };

test('the reply is the text before StructuredOutput, not the narration or the filler after', () => {
  const run = [
    { type: 'system', subtype: 'init' },
    user('Use ffmpeg.'),
    text('Let me look at the recorder.'),
    tool('Read'),
    toolResult(),
    text('Yes: the node image already ships ffmpeg.'),
    tool('StructuredOutput', { phase: 'questions' }),
    toolResult(),
    text('No response requested.'),
    result,
  ];
  assert.equal(reply.extractReply(run), 'Yes: the node image already ships ffmpeg.');
});

test('without a schema the reply is the final text', () => {
  assert.equal(reply.extractReply([user('Hi'), tool('Read'), toolResult(), text('One.'), text('Two.'), result]), 'One.\n\nTwo.');
});

test('a subagent\'s text is never the reply', () => {
  assert.equal(reply.extractReply([user('Hi'), text('Mine.'), text('Subagent says.', 'toolu_1'), tool('StructuredOutput')]), 'Mine.');
});

test('no text is an empty reply', () => {
  assert.equal(reply.extractReply([user('Hi'), tool('StructuredOutput')]), '');
});

test('stats come from the result message', () => {
  assert.deepEqual(reply.stats([user('x'), result]), { turns: 3, cost: 0.25, denials: 1 });
  assert.deepEqual(reply.stats([]), { turns: 0, cost: 0, denials: 0 });
});

test('run reads the execution file into outputs', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reply-')), 'claude-execution-output.json');
  fs.writeFileSync(file, JSON.stringify([user('Hi'), text('Hello.'), result]));
  process.env.EXECUTION_FILE = file;
  const core = fake.core();
  await reply.run({ core });
  assert.equal(core.outputs.reply, 'Hello.');
  assert.equal(core.outputs.turns, '3');
});

test('the structured output goes to a file, and the path to an output', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-'));
  const file = path.join(tmp, 'claude-execution-output.json');
  fs.writeFileSync(file, JSON.stringify([user('Hi'), text('Hello.'), { ...result, structured_output: { spec: '# S\n' } }]));
  Object.assign(process.env, { EXECUTION_FILE: file, RUNNER_TEMP: tmp });
  const core = fake.core();
  await reply.run({ core });
  assert.equal(core.outputs.structured_file, path.join(tmp, 'issue-agent-structured.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(core.outputs.structured_file, 'utf8')), { spec: '# S\n' });
});

test('without structured output the file output is empty', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-'));
  const file = path.join(tmp, 'e.json');
  fs.writeFileSync(file, JSON.stringify([user('Hi'), text('Hello.'), result]));
  Object.assign(process.env, { EXECUTION_FILE: file, RUNNER_TEMP: tmp });
  const core = fake.core();
  await reply.run({ core });
  assert.equal(core.outputs.structured_file, '');
});

test('no reply fails the step, so nothing after it runs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-'));
  const file = path.join(tmp, 'e.json');
  fs.writeFileSync(file, JSON.stringify([user('Hi'), tool('StructuredOutput'), result]));
  Object.assign(process.env, { EXECUTION_FILE: file, RUNNER_TEMP: tmp });
  const core = fake.core();
  await reply.run({ core });
  assert.deepEqual(core.failures, ['the agent wrote no reply']);
});

test('the message text wins; the structured reply covers a turn that wrote none', () => {
  assert.equal(reply.pick('Hello.', { reply: 'Also hello.' }), 'Hello.');
  assert.equal(reply.pick('', { reply: 'From the field.' }), 'From the field.');
  assert.equal(reply.pick('', {}), '');
});

test('run falls back to the structured reply, from the result message', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reply-')), 'claude-execution-output.json');
  fs.writeFileSync(file, JSON.stringify([user('Hi'), tool('StructuredOutput', { reply: 'Spec round 2 is up.' }), { ...result, structured_output: { reply: 'Spec round 2 is up.', spec: '# S' } }]));
  process.env.EXECUTION_FILE = file;
  process.env.RUNNER_TEMP = path.dirname(file);
  const core = fake.core();
  await reply.run({ core });
  assert.equal(core.outputs.reply, 'Spec round 2 is up.');
  assert.deepEqual(core.failures, []);
});
