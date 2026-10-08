// Everything claude-code-action is given besides the turn: the appended system prompt
// (the contract, the job's role, a guide to the repo's own rule files) and the flags for
// the agent, schema, MCP servers, tools and session.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { list, fill } = require('./util');

const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

function uuid5(name) {
  const ns = Buffer.from(NAMESPACE_URL.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// claude-code-action splits claude_args like a shell
function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const GUIDE = [
  ['README.md', 'what this repository is'],
  ['CONTRIBUTING.md', 'how a change lands here; read it before you plan or change code'],
  ['.github/copilot-instructions.md', 'the rules GitHub Copilot reviews every pull request against'],
  ['.github/instructions', 'more review rules, each file for the paths in its `applyTo`'],
  ['docs/superpowers/specs', 'earlier specs; write like them'],
  ['docs/superpowers/plans', 'earlier plans; write like them'],
  ['saga', 'the design record; cite it and stay consistent with it'],
  ['wiki', 'the user documentation'],
  ['.github/workflows', 'what CI runs: the checks a change must pass'],
];

function guide(exists) {
  const rows = GUIDE.filter(([p]) => exists(p));
  if (!rows.length) return '';
  return ['## This repository', '', 'Read what you need of these before you act:', '', ...rows.map(([p, what]) => `- \`${p}\`: ${what}`)].join('\n');
}

// Claude Code reads CLAUDE.md on its own; AGENTS.md only when CLAUDE.md imports it
function agentsFallback(read) {
  const agents = read('AGENTS.md');
  if (agents == null) return '';
  const claude = read('CLAUDE.md');
  if (claude != null && /@AGENTS\.md/.test(claude)) return '';
  return `## This repository's rules (AGENTS.md)\n\n${agents.trim()}`;
}

function flags({ agent, schema, mcpFile, mcpServers = [], allowed = [], disallowed = [], session }) {
  const args = [];
  if (agent) args.push('--agent', q(agent));
  if (schema) args.push('--json-schema', q(schema));
  if (mcpFile) args.push('--mcp-config', q(mcpFile));
  const allow = [...allowed, ...mcpServers.map((s) => `mcp__${s}`)];
  if (mcpServers.length) allow.push('ListMcpResourcesTool', 'ReadMcpResourceTool');
  if (allow.length) args.push('--allowedTools', q(allow.join(',')));
  if (disallowed.length) args.push('--disallowedTools', q(disallowed.join(',')));
  if (session) args.push(...(session.resumed ? ['--resume', session.id] : ['--session-id', session.id, '--name', q(session.title)]));
  return args.join(' ');
}

async function run({ core }) {
  const env = process.env;
  const ws = env.GITHUB_WORKSPACE;
  const at = (p) => (path.isAbsolute(p) ? p : path.join(ws, p));
  const read = (p) => (fs.existsSync(at(p)) && fs.statSync(at(p)).isFile() ? fs.readFileSync(at(p), 'utf8') : null);
  const exists = (p) => fs.existsSync(at(p));
  // inline JSON, or a file: absolute, or relative to the repo
  const inline = (value) => {
    const v = (value || '').trim();
    if (!v || v.startsWith('{')) return v;
    const text = read(v);
    if (text == null) throw new Error(`not found: ${v}`);
    return text;
  };

  const contract = fill(fs.readFileSync(path.join(__dirname, 'contract.md'), 'utf8'), { scratch: env.SCRATCH_DIR || '.issue' });
  // the role, base first, then the repo's overlay: one file per line
  const instructions = (env.INSTRUCTIONS || '').split('\n').map((l) => l.trim()).filter(Boolean).map((f) => {
    const text = read(f);
    if (text == null) throw new Error(`instructions not found: ${f}`);
    return text.trim();
  }).join('\n\n');
  const promptFile = path.join(env.RUNNER_TEMP, 'issue-agent-system.md');
  fs.writeFileSync(promptFile, `${[contract.trim(), instructions, guide(exists), agentsFallback(read)].filter(Boolean).join('\n\n')}\n`);

  const schemaText = inline(env.SCHEMA);
  const schema = schemaText ? JSON.stringify(JSON.parse(schemaText)) : '';

  let mcpFile = '';
  let mcpServers = [];
  const mcpText = inline(env.MCP_CONFIG);
  if (mcpText) {
    const config = JSON.parse(mcpText.replace(/\$\{(\w+)\}/g, (_, name) => env[name] ?? ''));
    mcpServers = Object.keys(config.mcpServers || {});
    mcpFile = path.join(env.RUNNER_TEMP, 'issue-agent-mcp.json');
    fs.writeFileSync(mcpFile, JSON.stringify(config));
  }

  // uuid5(repo + key) is the session id, so the same key resumes the same session
  // wherever Claude's sessions persist (the claude runner's /claude)
  let session = null;
  if (env.SESSION_KEY) {
    const id = uuid5(`https://github.com/${env.GITHUB_REPOSITORY}#${env.SESSION_KEY}`);
    const home = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || '', '.claude');
    const transcript = path.join(home, 'projects', env.CLAUDE_CODE_PROJECT_DIR_NAME || 'none', `${id}.jsonl`);
    session = { id, title: env.SESSION_TITLE || env.SESSION_KEY, resumed: fs.existsSync(transcript) };
  }

  const args = flags({ agent: env.AGENT, schema, mcpFile, mcpServers, allowed: list(env.ALLOWED_TOOLS), disallowed: list(env.DISALLOWED_TOOLS), session });
  core.setOutput('system_prompt_file', promptFile);
  core.setOutput('args', args);
  core.setOutput('has_schema', String(!!schema));
  core.setOutput('resumed', String(!!session?.resumed));
  core.setOutput('session_id', session?.id || '');
  core.info(args);
}

module.exports = { uuid5, q, guide, agentsFallback, flags, run };
