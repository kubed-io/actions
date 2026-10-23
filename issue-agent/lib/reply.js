// Reads claude-code-action's execution_file (every Agent SDK message of the run) for the
// structured output (the envelope: reply, notes, and the rest) and the run's numbers.
// The reply is the envelope's `reply`; the run's last message text covers a run whose
// structured output never came, so a failure still says something.

const fs = require('fs');
const path = require('path');

function extractReply(messages) {
  let texts = [];
  for (const m of messages) {
    if (m.parent_tool_use_id) continue;
    if (m.type === 'user') {
      texts = [];
      continue;
    }
    if (m.type !== 'assistant') continue;
    for (const block of m.message?.content || []) {
      if (block.type === 'text' && block.text.trim()) texts.push(block.text.trim());
      if (block.type !== 'tool_use') continue;
      if (block.name === 'StructuredOutput') return texts.join('\n\n');
      texts = [];
    }
  }
  return texts.join('\n\n');
}

function stats(messages) {
  const result = [...messages].reverse().find((m) => m.type === 'result') || {};
  return {
    turns: result.num_turns ?? 0,
    cost: result.total_cost_usd ?? 0,
    denials: (result.permission_denials || []).length,
  };
}

// the result message's structured output, as a file: a document outgrows an env var
function structuredOf(messages) {
  const result = [...messages].reverse().find((m) => m.type === 'result');
  return result?.structured_output ?? null;
}

// the envelope's reply when there is one; the message text otherwise
function pick(text, structured) {
  if (typeof structured?.reply === 'string' && structured.reply.trim()) return structured.reply;
  return text;
}

async function run({ core }) {
  const file = process.env.EXECUTION_FILE;
  const messages = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const { turns, cost, denials } = stats(messages);
  const structured = structuredOf(messages);
  const text = pick(extractReply(messages), structured);
  let structuredFile = '';
  if (structured !== null) {
    structuredFile = path.join(process.env.RUNNER_TEMP, 'issue-agent-structured.json');
    fs.writeFileSync(structuredFile, JSON.stringify(structured));
  }
  core.setOutput('structured_file', structuredFile);
  core.setOutput('structured', structured === null ? '' : JSON.stringify(structured));
  core.setOutput('output', structured?.output === undefined ? '' : JSON.stringify(structured.output));
  core.setOutput('reply', text);
  core.setOutput('turns', String(turns));
  core.setOutput('cost', String(cost));
  core.setOutput('denials', String(denials));
  // nothing was said, so nothing may be written, published or posted on its behalf
  if (!text.trim()) core.setFailed('the agent wrote no reply');
  core.info(`reply ${text.length} chars · ${turns} turns · $${cost} · ${denials} denials`);
}

module.exports = { extractReply, stats, structuredOf, pick, run };
