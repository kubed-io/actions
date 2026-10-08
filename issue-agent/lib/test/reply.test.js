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
