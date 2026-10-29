const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const setup = require('../setup');
const fake = require('./fake');

test('uuid5 matches Python\'s uuid.uuid5(NAMESPACE_URL, …)', () => {
  assert.equal(setup.uuid5('https://github.com/kubed-io/selenium-flow#issue-12'), '4e30b23f-1248-53b0-99c6-461b0a67dacd');
  assert.equal(setup.uuid5('https://github.com/kubed-io/selenium-flow#pr-40'), 'd846c6e7-cc42-5db5-8b1b-83e5b158ea31');
});

test('q quotes for a shell split', () => {
  assert.equal(setup.q("it's"), `'it'\\''s'`);
});

test('the guide lists only what exists', () => {
  const g = setup.guide((p) => ['README.md', 'wiki'].includes(p));
  assert.ok(g.includes('- `README.md`: what this repository is'));
  assert.ok(g.includes('- `wiki`:'));
  assert.ok(!g.includes('CONTRIBUTING'));
  assert.equal(setup.guide(() => false), '');
});

test('AGENTS.md is appended only when CLAUDE.md does not load it', () => {
  const files = (map) => (p) => (p in map ? map[p] : null);
  assert.ok(setup.agentsFallback(files({ 'AGENTS.md': 'Rules.' })).includes('Rules.'));
  assert.equal(setup.agentsFallback(files({ 'AGENTS.md': 'Rules.', 'CLAUDE.md': '@AGENTS.md\n' })), '');
  assert.equal(setup.agentsFallback(files({})), '');
});

const AGENT = `---
name: plan
description: Writes the plan of record.
tools: Read, Glob, Grep, Write
disallowedTools:
  - Bash
skills: writing-plans
model: opus
maxTurns: 80
---
You write this pull request's plan.
`;

const CODE = `---
name: code
description: Implements the approved plan.
model: opus
maxTurns: 200
permissionMode: acceptEdits
allowedTools: Read, Edit, Bash(git log:*)
disallowedTools:
  - NotebookEdit
  - WebFetch
---
You implement the plan.
`;

test('an agent file becomes one --agents entry: frontmatter fields, the body as its prompt', () => {
  const parsed = setup.parseAgent(AGENT, 'fallback');
  assert.equal(parsed.name, 'plan');
  assert.deepEqual(setup.toAgent(parsed), {
    plan: {
      description: 'Writes the plan of record.',
      tools: ['Read', 'Glob', 'Grep', 'Write'],
      skills: ['writing-plans'],
      model: 'opus',
      maxTurns: 80,
      prompt: "You write this pull request's plan.",
    },
  });
  assert.deepEqual(setup.toAgent(setup.parseAgent('Just a prompt.', 'info')), { info: { prompt: 'Just a prompt.', description: 'info' } });
});

test('the frontmatter\'s allowedTools and disallowedTools are flags, never the --agents entry\'s', () => {
  const parsed = setup.parseAgent(CODE, 'fallback');
  assert.deepEqual(setup.agentTools(parsed), { allowed: ['Read', 'Edit', 'Bash(git log:*)'], disallowed: ['NotebookEdit', 'WebFetch'] });
  const entry = setup.toAgent(parsed).code;
  // allowedTools is ours; `tools` would be an allow-list that cuts the agent off its MCP tools
  assert.equal(entry.allowedTools, undefined);
  assert.equal(entry.disallowedTools, undefined);
  assert.equal(entry.tools, undefined);
  assert.deepEqual(setup.agentTools(setup.parseAgent(AGENT, 'plan')), { allowed: [], disallowed: ['Bash'] });
  assert.deepEqual(setup.agentTools(setup.parseAgent('Just a prompt.', 'info')), { allowed: [], disallowed: [] });
});

test('the envelope: reply and notes always; the toggles add theirs; the role is output', () => {
  const bare = setup.envelope({});
  assert.deepEqual(bare.required, ['reply', 'notes']);
  assert.deepEqual(Object.keys(bare.properties), ['reply', 'notes']);
  assert.equal(bare.additionalProperties, false);

  const role = { type: 'object', properties: { commit_message: { $ref: '#/$defs/msg' } }, required: ['commit_message'], $defs: { msg: { type: 'string' } } };
  const full = setup.envelope({ role, review: true, threads: true, ready: true });
  assert.deepEqual(Object.keys(full.properties), ['reply', 'notes', 'review', 'threads', 'ready', 'output']);
  assert.deepEqual(full.required, ['reply', 'notes', 'output']);
  // the role's $defs move to the root, where its #/$defs references point
  assert.deepEqual(full.$defs, { msg: { type: 'string' } });
  assert.equal(full.properties.output.$defs, undefined);
  assert.deepEqual(full.properties.review.properties.comments.items.required, ['path', 'line', 'body']);

  const optional = setup.envelope({ role: { type: 'object', properties: { x: { type: 'string' } } } });
  assert.deepEqual(optional.required, ['reply', 'notes']);
});

test('flags: the agent, schema, MCP servers and their resource tools, overrides, session', () => {
  const args = setup.flags({
    agentsFile: '/t/agents.json', agent: 'plan', schema: '{"type":"object"}', mcpFile: '/t/mcp.json', mcpServers: ['kb'],
    over: { model: 'sonnet', maxTurns: '5', permissionMode: 'acceptEdits', allowed: ['Read'], disallowed: ['Bash'] },
    session: { id: 'u', title: "x's", resumed: false },
  });
  assert.equal(args, `--agents '/t/agents.json' --agent 'plan' --json-schema '{"type":"object"}' --mcp-config '/t/mcp.json' --model 'sonnet' --max-turns '5' --permission-mode 'acceptEdits' --allowedTools 'Read,mcp__kb,ListMcpResourcesTool,ReadMcpResourceTool' --disallowedTools 'Bash' --session-id u --name 'x'\\''s'`);
  assert.equal(setup.flags({ session: { id: 'u', resumed: true } }), '--resume u');
  assert.ok(setup.flags({ mcpFile: '/t/mcp.json', settingsFile: '/t/s.json' }).startsWith(`--mcp-config '/t/mcp.json' --settings '/t/s.json'`));
  // a name Claude Code finds itself: no --agents file
  assert.equal(setup.flags({ agent: 'info-agent' }), `--agent 'info-agent'`);
});

test('a name the repository\'s .claude/agents/ has passes through; a missing agent file is an error', async () => {
  const { ws, github } = scene();
  fs.mkdirSync(path.join(ws, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude/agents/info-agent.md'), '---\nname: info-agent\n---\nAnswers.\n');
  process.env.AGENT = 'info-agent';
  const core = fake.core();
  await setup.run({ github, context: fake.context(), core });
  assert.ok(core.outputs.args.startsWith(`--agent 'info-agent'`));
  assert.ok(!core.outputs.args.includes('--agents'));
  process.env.AGENT = '.issue/roles/claude/agents/nope.md';
  await assert.rejects(setup.run({ github, context: fake.context(), core: fake.core() }), /agent not found/);
});

// the --json-schema value, back out of its shell quoting
function schemaOf(args) {
  const m = /--json-schema '((?:[^']|'\\'')*)'/.exec(args);
  return JSON.parse(m[1].replace(/'\\''/g, "'"));
}

function scene({ pr = false, draft = false } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-'));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-'));
  fs.mkdirSync(path.join(ws, '.issue/roles/claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.issue/roles/claude/agents/plan.md'), AGENT);
  fs.writeFileSync(path.join(ws, '.issue/roles/claude/agents/plan.schema.json'), '{"type":"object","properties":{"commit_message":{"type":"string"}},"required":["commit_message"]}');
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'House rules.');
  const id = setup.uuid5('https://github.com/kubed-io/selenium-flow#pr-81');
  fs.mkdirSync(path.join(cfg, 'projects/-projects-kubed-io-selenium-flow'), { recursive: true });
  fs.writeFileSync(path.join(cfg, `projects/-projects-kubed-io-selenium-flow/${id}.jsonl`), '');
  Object.assign(process.env, {
    GITHUB_WORKSPACE: ws, RUNNER_TEMP: tmp, GITHUB_REPOSITORY: 'kubed-io/selenium-flow', CLAUDE_CONFIG_DIR: cfg,
    CLAUDE_CODE_PROJECT_DIR_NAME: '-projects-kubed-io-selenium-flow', NUMBER: '81',
    AGENT: '.issue/roles/claude/agents/plan.md', SCHEMA: '.issue/roles/claude/agents/plan.schema.json',
    APPEND_SYSTEM_PROMPT: 'In this job, plans go under docs/.', MCP_CONFIG: '{"mcpServers":{"kb":{"url":"${KB_URL}"}}}', KB_URL: 'https://kb',
    REVIEW: 'true', THREADS: '', READY: 'true', MODEL: '', MAX_TURNS: '', PERMISSION_MODE: '', ALLOWED_TOOLS: '', DISALLOWED_TOOLS: '',
    SESSION_KEY: 'pr-81', SCRATCH_DIR: '.issue', LIVE_MESSAGES: '',
  });
  for (const name of ['AGENT_FLOW_N8N_TOKEN', 'AGENT_FLOW_CALLBACK_URL', 'CLAUDE_MCP_PROFILES', 'CLAUDE_AGENTS']) delete process.env[name];
  const github = fake.github({
    'issues.get': { number: 81, title: 'Flows tab', ...(pr ? { pull_request: {} } : {}) },
    'pulls.get': { draft },
  });
  return { ws, tmp, id, github };
}

test('run: the agent file, the system prompt, the envelope on a draft PR, and a resumed session', async () => {
  const { tmp, id, github } = scene({ pr: true, draft: true });
  const core = fake.core();
  await setup.run({ github, context: fake.context(), core });
  const prompt = fs.readFileSync(core.outputs.system_prompt_file, 'utf8');
  assert.ok(prompt.startsWith('## Working in a GitHub issue or pull request'));
  assert.ok(prompt.indexOf('never commit') < prompt.indexOf('In this job, plans go under docs/.'));
  assert.ok(prompt.includes('House rules.'));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(tmp, 'issue-agent-agents.json'), 'utf8'))), ['plan']);
  assert.ok(core.outputs.args.includes(`--agent 'plan'`));
  const schema = schemaOf(core.outputs.args);
  assert.deepEqual(Object.keys(schema.properties), ['reply', 'notes', 'review', 'threads', 'ready', 'output']);
  assert.equal(core.outputs.resumed, 'true');
  assert.ok(core.outputs.args.includes(`--resume ${id}`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'issue-agent-mcp.json'), 'utf8')).mcpServers.kb.url, 'https://kb');
});

test('run on an issue gives the agent none of the PR fields', async () => {
  const { github } = scene();
  const core = fake.core();
  await setup.run({ github, context: fake.context(), core });
  const schema = schemaOf(core.outputs.args);
  assert.deepEqual(Object.keys(schema.properties), ['reply', 'notes', 'output']);
});

test('a session key without a project dir name warns that resume is off', async () => {
  const { github } = scene();
  delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  const core = fake.core();
  await setup.run({ github, context: fake.context(), core });
  assert.ok(core.notices.some((m) => /cannot resume here/.test(m)));
  assert.equal(core.outputs.resumed, 'false');
});

test('the hook settings are the channel README\'s: hook.js on PostToolBatch and Stop', () => {
  const hook = [{ hooks: [{ type: 'command', command: 'bun /home/runner/channel/hook.js' }] }];
  assert.deepEqual(setup.hookSettings(), { hooks: { PostToolBatch: hook, Stop: hook } });
});

// the claude runner's env, with the channel's profile beside the others
function channel() {
  const profiles = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
  fs.writeFileSync(path.join(profiles, 'channel.json'), JSON.stringify({ mcpServers: { 'agent-flow': { type: 'stdio', command: 'bun', args: ['/home/runner/channel/server.js'] } } }));
  Object.assign(process.env, { AGENT_FLOW_N8N_TOKEN: 't', AGENT_FLOW_CALLBACK_URL: 'http://n8n/cb', CLAUDE_MCP_PROFILES: profiles });
}

function allowedOf(args) {
  return /--allowedTools '([^']*)'/.exec(args)[1].split(',');
}

test('live: the channel joins the one MCP file, the hooks come as --settings, reply is allowed', async () => {
  const { tmp, github } = scene();
  channel();
  process.env.LIVE_MESSAGES = 'true';
  const core = fake.core();
  await setup.run({ github, context: fake.context(), core });
  const args = core.outputs.args;
  assert.equal(core.outputs.live, 'true');
  // claude-code-action keeps only the last of several --mcp-config files
  assert.equal(args.match(/--mcp-config /g).length, 1);
  const mcp = JSON.parse(fs.readFileSync(path.join(tmp, 'issue-agent-mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['kb', 'agent-flow']);
  const settings = /--settings '([^']*)'/.exec(args)[1];
  assert.equal(settings, path.join(tmp, 'issue-agent-settings.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), setup.hookSettings());
  const allowed = allowedOf(args);
  assert.ok(allowed.includes('mcp__agent-flow__reply'));
  assert.ok(allowed.includes('mcp__kb'));
  assert.ok(!allowed.includes('mcp__agent-flow'));
});

test('live with no mcp_config: the MCP file is the channel alone', async () => {
  const { tmp, github } = scene();
  channel();
  Object.assign(process.env, { LIVE_MESSAGES: 'true', MCP_CONFIG: '' });
  const core = fake.core();
  await setup.run({ github, context: fake.context(), core });
  const mcp = JSON.parse(fs.readFileSync(path.join(tmp, 'issue-agent-mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['agent-flow']);
  assert.deepEqual(allowedOf(core.outputs.args).filter((t) => t.startsWith('mcp__')), ['mcp__agent-flow__reply']);
});

async function runWith(env) {
  const { tmp, github } = scene();
  channel();
  for (const [k, v] of Object.entries(env)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  const core = fake.core();
  await setup.run({ github, context: fake.context(), core });
  return { core, tmp };
}

test('off, the channel in reach changes nothing: the args and MCP file of a runner without it', async () => {
  const bare = fake.core();
  const { tmp: bareTmp, github } = scene();
  await setup.run({ github, context: fake.context(), core: bare });
  const bareMcp = fs.readFileSync(path.join(bareTmp, 'issue-agent-mcp.json'), 'utf8');
  for (const value of ['', 'false']) {
    const { core, tmp } = await runWith({ LIVE_MESSAGES: value });
    assert.equal(core.outputs.args.replaceAll(tmp, bareTmp), bare.outputs.args);
    assert.equal(fs.readFileSync(path.join(tmp, 'issue-agent-mcp.json'), 'utf8'), bareMcp);
    assert.ok(!fs.existsSync(path.join(tmp, 'issue-agent-settings.json')));
    assert.equal(core.outputs.live, 'false');
    assert.deepEqual(core.notices, []);
  }
});

test('on without the token, the callback URL or the channel profile: a warning, and the turn runs as off', async () => {
  for (const missing of [{ AGENT_FLOW_N8N_TOKEN: null }, { AGENT_FLOW_CALLBACK_URL: '' }, { CLAUDE_MCP_PROFILES: '/nowhere' }]) {
    const { core, tmp } = await runWith({ LIVE_MESSAGES: 'true', ...missing });
    assert.equal(core.outputs.live, 'false');
    assert.ok(!core.outputs.args.includes('--settings'));
    assert.ok(!core.outputs.args.includes('agent-flow'));
    assert.ok(!fs.existsSync(path.join(tmp, 'issue-agent-settings.json')));
    assert.equal(core.notices.length, 1);
    assert.match(core.notices[0], /live_messages/);
  }
});

// the claude runner image's agents: $CLAUDE_AGENTS/<name>/ with AGENT.md, schema.json, mcp.json
function agents({ schema = true, mcp = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  fs.mkdirSync(path.join(root, 'code'));
  fs.writeFileSync(path.join(root, 'code/AGENT.md'), CODE);
  if (schema) fs.writeFileSync(path.join(root, 'code/schema.json'), '{"type":"object","properties":{"done":{"type":"boolean"}},"required":["done"]}');
  if (mcp) fs.writeFileSync(path.join(root, 'code/mcp.json'), '{"mcpServers":{"coder":{"url":"${KB_URL}/coder"}}}');
  return root;
}

async function asName(env = {}, opts = {}) {
  const { ws, tmp, github } = scene();
  const root = agents(opts);
  Object.assign(process.env, { CLAUDE_AGENTS: root, AGENT: 'code', SCHEMA: '', MCP_CONFIG: '' });
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const core = fake.core();
  await setup.run({ github, context: fake.context(), core });
  return { ws, tmp, root, core, args: core.outputs.args };
}

function listOf(flag, args) {
  const m = new RegExp(`--${flag} '([^']*)'`).exec(args);
  return m ? m[1].split(',') : null;
}

test('a name is the runner image\'s agent: $CLAUDE_AGENTS/<name>/AGENT.md, through --agents', async () => {
  const { tmp, args } = await asName();
  const entry = JSON.parse(fs.readFileSync(path.join(tmp, 'issue-agent-agents.json'), 'utf8'));
  assert.deepEqual(Object.keys(entry), ['code']);
  assert.equal(entry.code.prompt, 'You implement the plan.');
  assert.equal(entry.code.permissionMode, 'acceptEdits');
  assert.equal(entry.code.allowedTools, undefined);
  assert.ok(args.includes(`--agents '${path.join(tmp, 'issue-agent-agents.json')}' --agent 'code'`));
});

test('a name\'s folder gives the schema and the MCP servers when the job gives none', async () => {
  const { tmp, args } = await asName();
  assert.deepEqual(schemaOf(args).properties.output.required, ['done']);
  const mcp = JSON.parse(fs.readFileSync(path.join(tmp, 'issue-agent-mcp.json'), 'utf8'));
  assert.deepEqual(mcp, { mcpServers: { coder: { url: 'https://kb/coder' } } });
  assert.ok(listOf('allowedTools', args).includes('mcp__coder'));
});

test('a job\'s schema and mcp_config win over the folder\'s', async () => {
  const { tmp, args } = await asName({ SCHEMA: '{"type":"object","properties":{"plan_path":{"type":"string"}},"required":["plan_path"]}', MCP_CONFIG: '{"mcpServers":{"kb":{"url":"${KB_URL}"}}}' });
  assert.deepEqual(schemaOf(args).properties.output.required, ['plan_path']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(tmp, 'issue-agent-mcp.json'), 'utf8')).mcpServers), ['kb']);
});

test('a folder without schema.json or mcp.json: no output field, no MCP file', async () => {
  const { tmp, args } = await asName({}, { schema: false, mcp: false });
  assert.deepEqual(Object.keys(schemaOf(args).properties), ['reply', 'notes']);
  assert.ok(!args.includes('--mcp-config'));
  assert.ok(!fs.existsSync(path.join(tmp, 'issue-agent-mcp.json')));
});

test('the frontmatter\'s tools are the flags; the job\'s allowed_tools and disallowed_tools win', async () => {
  const own = (await asName()).args;
  assert.deepEqual(listOf('allowedTools', own), ['Read', 'Edit', 'Bash(git log:*)', 'mcp__coder', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
  assert.deepEqual(listOf('disallowedTools', own), ['NotebookEdit', 'WebFetch']);
  const narrowed = (await asName({ ALLOWED_TOOLS: 'Read,Glob', DISALLOWED_TOOLS: 'Bash,Edit,Write' })).args;
  assert.deepEqual(listOf('allowedTools', narrowed), ['Read', 'Glob', 'mcp__coder', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
  assert.deepEqual(listOf('disallowedTools', narrowed), ['Bash', 'Edit', 'Write']);
});

test('a path agent\'s frontmatter tools are flags too', async () => {
  const { ws, github } = scene();
  fs.writeFileSync(path.join(ws, '.issue/roles/claude/agents/code.md'), CODE);
  process.env.AGENT = '.issue/roles/claude/agents/code.md';
  const core = fake.core();
  await setup.run({ github, context: fake.context(), core });
  assert.deepEqual(listOf('allowedTools', core.outputs.args).slice(0, 3), ['Read', 'Edit', 'Bash(git log:*)']);
  assert.deepEqual(listOf('disallowedTools', core.outputs.args), ['NotebookEdit', 'WebFetch']);
});

test('live with a name: the channel joins the folder\'s mcp.json, and reply joins the frontmatter\'s tools', async () => {
  const { tmp, github } = scene();
  channel();
  Object.assign(process.env, { CLAUDE_AGENTS: agents(), AGENT: 'code', SCHEMA: '', MCP_CONFIG: '', LIVE_MESSAGES: 'true' });
  const core = fake.core();
  await setup.run({ github, context: fake.context(), core });
  const mcp = JSON.parse(fs.readFileSync(path.join(tmp, 'issue-agent-mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['coder', 'agent-flow']);
  assert.equal(mcp.mcpServers.coder.url, 'https://kb/coder');
  const allowed = listOf('allowedTools', core.outputs.args);
  assert.deepEqual(allowed.slice(0, 4), ['Read', 'Edit', 'Bash(git log:*)', 'mcp__agent-flow__reply']);
  assert.ok(allowed.includes('mcp__coder'));
  // and with the job's tools in place of the frontmatter's
  process.env.ALLOWED_TOOLS = 'Read';
  const narrowed = fake.core();
  await setup.run({ github, context: fake.context(), core: narrowed });
  assert.deepEqual(listOf('allowedTools', narrowed.outputs.args).slice(0, 2), ['Read', 'mcp__agent-flow__reply']);
});

test('a name with no folder, no AGENT.md or no CLAUDE_AGENTS is an error naming the path', async () => {
  const { github } = scene();
  const root = agents();
  Object.assign(process.env, { CLAUDE_AGENTS: root, AGENT: 'nope' });
  await assert.rejects(setup.run({ github, context: fake.context(), core: fake.core() }), (e) => e.message.includes(path.join(root, 'nope/AGENT.md')) && /CLAUDE_AGENTS/.test(e.message));
  fs.mkdirSync(path.join(root, 'empty'));
  process.env.AGENT = 'empty';
  await assert.rejects(setup.run({ github, context: fake.context(), core: fake.core() }), (e) => e.message.includes(path.join(root, 'empty/AGENT.md')));
  delete process.env.CLAUDE_AGENTS;
  process.env.AGENT = 'code';
  await assert.rejects(setup.run({ github, context: fake.context(), core: fake.core() }), /CLAUDE_AGENTS is not set/);
});
