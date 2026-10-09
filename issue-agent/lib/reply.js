// Reads claude-code-action's execution_file (every Agent SDK message of the run) for the
// agent's reply and the run's numbers.
//
// The reply is what the agent wrote to the person as plain text: the text after its last
// tool result, up to its StructuredOutput call when it has a schema. Text written before
// any other tool call is narration, and anything after StructuredOutput is filler.

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

async function run({ core }) {
  const file = process.env.EXECUTION_FILE;
  const messages = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const text = extractReply(messages);
  const { turns, cost, denials } = stats(messages);
  const structured = structuredOf(messages);
  let structuredFile = '';
  if (structured !== null) {
    structuredFile = path.join(process.env.RUNNER_TEMP, 'issue-agent-structured.json');
    fs.writeFileSync(structuredFile, JSON.stringify(structured));
  }
  core.setOutput('structured_file', structuredFile);
  core.setOutput('reply', text);
  core.setOutput('turns', String(turns));
  core.setOutput('cost', String(cost));
  core.setOutput('denials', String(denials));
  // nothing was said, so nothing may be written, published or posted on its behalf
  if (!text.trim()) core.setFailed('the agent wrote no reply');
  core.info(`reply ${text.length} chars · ${turns} turns · $${cost} · ${denials} denials`);
}

module.exports = { extractReply, stats, structuredOf, run };
