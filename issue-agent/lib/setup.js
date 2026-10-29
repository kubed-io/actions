// Everything claude-code-action is given besides the turn: the agent (a Claude Code agent
// file, loaded through --agents), the appended system prompt (the contract, the job's own
// text, a guide to the repo's rule files), the envelope schema, MCP servers, per-job
// overrides, the session, and with live_messages the agent-flow channel and its hooks.

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

// Frontmatter in Claude Code's agent format: `key: value` lines and `- item` lists. A
// comma list stays a string; toAgent splits the fields Claude wants as arrays.
function parseAgent(text, fallbackName) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { name: fallbackName, prompt: text.trim() };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) {
      meta[key] = [...(Array.isArray(meta[key]) ? meta[key] : []), unquote(item[1])];
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1];
    meta[key] = kv[2] === '' ? [] : unquote(kv[2]);
  }
  return { ...meta, name: meta.name || fallbackName, prompt: m[2].trim() };
}

function unquote(v) {
  const t = v.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}

const ARRAYS = ['tools', 'disallowedTools', 'skills'];
const NUMBERS = ['maxTurns'];

// the --agents JSON entry: { <name>: { description, prompt, tools, … } }
function toAgent(parsed) {
  const { name, ...fields } = parsed;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (ARRAYS.includes(k)) out[k] = Array.isArray(v) ? v : String(v).split(',').map((x) => x.trim()).filter(Boolean);
    else if (NUMBERS.includes(k)) out[k] = Number(v);
    else out[k] = v;
  }
  if (!out.description) out.description = name;
  return { [name]: out };
}

const REVIEW = {
  type: 'object',
  additionalProperties: false,
  description: 'Line comments on this pull request\'s diff (diff.md beside the thread files). With any, your reply is posted as the body of one review with these under it.',
  properties: {
    comments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          line: { type: 'integer', description: 'The new-side line, from diff.md; the last line of a range.' },
          start_line: { type: 'integer', description: 'The first line of a range.' },
          body: { type: 'string' },
          suggestion: { type: 'string', description: 'Exactly what lines start_line..line should read, plain text, no fence.' },
        },
        required: ['path', 'line', 'body'],
      },
    },
  },
  required: ['comments'],
};

const THREADS = {
  type: 'array',
  description: 'Every unresolved review thread (reviews.md beside the thread files) you answered.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'The thread id from reviews.md.' },
      reply: { type: 'string' },
      resolve: { type: 'boolean', description: 'True when you fixed or settled it.' },
    },
    required: ['id', 'reply', 'resolve'],
  },
};

// The action's own fields, with the role's schema as `output`. The role's $defs move to
// the root, where its `#/$defs/…` references still point.
function envelope({ role, review, threads, ready }) {
  const properties = {
    reply: { type: 'string', description: 'Your answer to the person, markdown, posted exactly as written.' },
    notes: { type: 'string', description: 'Your notes on this thread, whole, every turn: what the next run, or the pull request after this issue, starts from.' },
  };
  const required = ['reply', 'notes'];
  const schema = { type: 'object', additionalProperties: false, properties, required };
  if (review) properties.review = REVIEW;
  if (threads) properties.threads = THREADS;
  if (ready) properties.ready = { type: 'boolean', description: 'True to mark this draft pull request ready for review.' };
  if (role) {
    const { $defs, definitions, $schema, ...rest } = role;
    properties.output = rest;
    if ((rest.required || []).length) required.push('output');
    if ($defs) schema.$defs = $defs;
    if (definitions) schema.definitions = definitions;
  }
  return schema;
}

// The claude runner's agent-flow channel (kubed-io/github runners/claude/channel): its MCP
// server keeps the inbox and the reply tool; in -p only these hooks hand the inbox to the turn.
const CHANNEL_HOOK = 'bun /home/runner/channel/hook.js';
const REPLY_TOOL = 'mcp__agent-flow__reply';

function hookSettings(command = CHANNEL_HOOK) {
  const hook = [{ hooks: [{ type: 'command', command }] }];
  return { hooks: { PostToolBatch: hook, Stop: hook } };
}

// the channel's profile when live_messages is on and the runner can carry it, else null
function channelOf(env, core) {
  if (env.LIVE_MESSAGES !== 'true') return null;
  const file = path.join(env.CLAUDE_MCP_PROFILES || '', 'channel.json');
  let why = '';
  if (!env.AGENT_FLOW_N8N_TOKEN || !env.AGENT_FLOW_CALLBACK_URL) why = 'AGENT_FLOW_N8N_TOKEN or AGENT_FLOW_CALLBACK_URL is not set';
  else if (!env.CLAUDE_MCP_PROFILES || !fs.existsSync(file)) why = `there is no channel profile at ${file}`;
  if (why) {
    core.warning(`live_messages is on, but ${why}: messages wait for the next turn`);
    return null;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function flags({ agentsFile, agent, schema, mcpFile, settingsFile, mcpServers = [], over = {}, session }) {
  const args = [];
  if (agentsFile) args.push('--agents', q(agentsFile));
  if (agent) args.push('--agent', q(agent));
  if (schema) args.push('--json-schema', q(schema));
  if (mcpFile) args.push('--mcp-config', q(mcpFile));
  if (settingsFile) args.push('--settings', q(settingsFile));
  if (over.model) args.push('--model', q(over.model));
  if (over.maxTurns) args.push('--max-turns', q(over.maxTurns));
  if (over.permissionMode) args.push('--permission-mode', q(over.permissionMode));
  const allow = [...(over.allowed || []), ...mcpServers.map((s) => `mcp__${s}`)];
  if (mcpServers.length) allow.push('ListMcpResourcesTool', 'ReadMcpResourceTool');
  if (allow.length) args.push('--allowedTools', q(allow.join(',')));
  if ((over.disallowed || []).length) args.push('--disallowedTools', q(over.disallowed.join(',')));
  if (session) args.push(...(session.resumed ? ['--resume', session.id] : ['--session-id', session.id, '--name', q(session.title)]));
  return args.join(' ');
}

async function run({ github, context, core }) {
  const env = process.env;
  const ws = env.GITHUB_WORKSPACE;
  const at = (p) => (path.isAbsolute(p) ? p : path.join(ws, p));
  const read = (p) => (fs.existsSync(at(p)) && fs.statSync(at(p)).isFile() ? fs.readFileSync(at(p), 'utf8') : null);
  const exists = (p) => fs.existsSync(at(p));
  // a file (absolute, or relative to the repo), else the value itself
  const fileOr = (value) => {
    const v = (value || '').trim();
    if (!v || v.includes('\n') || v.startsWith('{')) return v;
    return read(v) ?? v;
  };

  const scratch = env.SCRATCH_DIR || '.issue';
  // the agent's own folder, which the action keeps from turn to turn
  fs.mkdirSync(path.join(ws || '.', scratch, 'scratch'), { recursive: true });

  // what kind of thread this is decides which of the action's fields the agent gets
  const number = Number(env.NUMBER) || 0;
  let isPr = false;
  let draft = false;
  let title = '';
  if (number) {
    const { data: thread } = await github.rest.issues.get({ ...context.repo, issue_number: number });
    title = thread.title || '';
    if (thread.pull_request) {
      isPr = true;
      const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
      draft = !!pr.draft;
    }
  }

  const contract = fill(fs.readFileSync(path.join(__dirname, 'contract.md'), 'utf8'), { scratch });
  const extra = fileOr(env.APPEND_SYSTEM_PROMPT);
  const promptFile = path.join(env.RUNNER_TEMP, 'issue-agent-system.md');
  fs.writeFileSync(promptFile, `${[contract.trim(), extra.trim(), guide(exists), agentsFallback(read)].filter(Boolean).join('\n\n')}\n`);

  // the agent: a file is loaded through --agents; anything else is a name Claude knows
  let agentsFile = '';
  let agent = '';
  if (env.AGENT) {
    const text = read(env.AGENT);
    if (text != null) {
      const parsed = parseAgent(text, path.basename(env.AGENT).replace(/\.md$/, ''));
      agent = parsed.name;
      agentsFile = path.join(env.RUNNER_TEMP, 'issue-agent-agents.json');
      fs.writeFileSync(agentsFile, JSON.stringify(toAgent(parsed)));
    } else if (/[/\\]|\.md$/.test(env.AGENT)) {
      throw new Error(`agent not found: ${env.AGENT}`);
    } else {
      // a name: an agent Claude Code finds itself, in the repo's .claude/agents/
      agent = env.AGENT;
    }
  }

  const roleText = fileOr(env.SCHEMA);
  const role = roleText ? JSON.parse(roleText) : null;
  const on = (v, dflt) => (v === '' || v == null ? dflt : v === 'true');
  const schema = JSON.stringify(envelope({
    role,
    review: isPr && on(env.REVIEW, false),
    threads: isPr && on(env.THREADS, true),
    ready: isPr && draft && on(env.READY, false),
  }));

  let mcpFile = '';
  let mcpServers = [];
  let config = null;
  const mcpText = fileOr(env.MCP_CONFIG);
  if (mcpText) {
    config = JSON.parse(mcpText.replace(/\$\{(\w+)\}/g, (_, name) => env[name] ?? ''));
    mcpServers = Object.keys(config.mcpServers || {});
  }
  // one file: claude-code-action keeps only the last of several --mcp-config files
  const channel = channelOf(env, core);
  if (channel) config = { ...config, mcpServers: { ...config?.mcpServers, ...channel.mcpServers } };
  if (config) {
    mcpFile = path.join(env.RUNNER_TEMP, 'issue-agent-mcp.json');
    fs.writeFileSync(mcpFile, JSON.stringify(config));
  }
  let settingsFile = '';
  if (channel) {
    settingsFile = path.join(env.RUNNER_TEMP, 'issue-agent-settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(hookSettings()));
  }

  // uuid5(repo + key) is the session id, so the same key resumes the same session
  // wherever Claude's sessions persist (the claude runner's /claude)
  let session = null;
  if (env.SESSION_KEY) {
    if (!env.CLAUDE_CODE_PROJECT_DIR_NAME) core.warning('session_key is set but CLAUDE_CODE_PROJECT_DIR_NAME is not, so sessions cannot resume here');
    const id = uuid5(`https://github.com/${env.GITHUB_REPOSITORY}#${env.SESSION_KEY}`);
    const home = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || '', '.claude');
    const transcript = path.join(home, 'projects', env.CLAUDE_CODE_PROJECT_DIR_NAME || 'none', `${id}.jsonl`);
    const name = title ? `${env.GITHUB_REPOSITORY.split('/').pop()}#${number} ${title}` : env.SESSION_KEY;
    session = { id, title: name, resumed: fs.existsSync(transcript) };
  }

  const over = {
    model: env.MODEL,
    maxTurns: env.MAX_TURNS,
    permissionMode: env.PERMISSION_MODE,
    // the channel's one tool, not the whole server
    allowed: [...list(env.ALLOWED_TOOLS), ...(channel ? [REPLY_TOOL] : [])],
    disallowed: list(env.DISALLOWED_TOOLS),
  };
  const args = flags({ agentsFile, agent, schema, mcpFile, settingsFile, mcpServers, over, session });
  core.setOutput('system_prompt_file', promptFile);
  core.setOutput('args', args);
  core.setOutput('resumed', String(!!session?.resumed));
  core.setOutput('session_id', session?.id || '');
  core.setOutput('live', String(!!channel));
  core.info(args);
}

module.exports = { uuid5, q, guide, agentsFallback, parseAgent, toAgent, envelope, hookSettings, flags, run };
