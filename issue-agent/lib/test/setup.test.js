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
  const g = setup.guide((p) => ['README.md', 'saga'].includes(p));
  assert.ok(g.includes('- `README.md`: what this repository is'));
  assert.ok(g.includes('- `saga`:'));
  assert.ok(!g.includes('CONTRIBUTING'));
  assert.equal(setup.guide(() => false), '');
});

test('AGENTS.md is appended only when CLAUDE.md does not load it', () => {
  const files = (map) => (p) => (p in map ? map[p] : null);
  assert.ok(setup.agentsFallback(files({ 'AGENTS.md': 'Rules.' })).includes('Rules.'));
  assert.equal(setup.agentsFallback(files({ 'AGENTS.md': 'Rules.', 'CLAUDE.md': '@AGENTS.md\n' })), '');
  assert.ok(setup.agentsFallback(files({ 'AGENTS.md': 'Rules.', 'CLAUDE.md': 'Other.' })).includes('Rules.'));
  assert.equal(setup.agentsFallback(files({})), '');
});

test('flags: agent, schema, MCP servers and their resource tools, session', () => {
  const args = setup.flags({ agent: 'info-agent', schema: '{"type":"object"}', mcpFile: '/t/mcp.json', mcpServers: ['kb'], allowed: ['Read'], disallowed: ['Bash'], session: { id: 'u', title: "x's", resumed: false } });
  assert.equal(args, `--agent 'info-agent' --json-schema '{"type":"object"}' --mcp-config '/t/mcp.json' --allowedTools 'Read,mcp__kb,ListMcpResourcesTool,ReadMcpResourceTool' --disallowedTools 'Bash' --session-id u --name 'x'\\''s'`);
  assert.equal(setup.flags({ mcpServers: [], allowed: [], disallowed: [], session: { id: 'u', resumed: true } }), '--resume u');
});

test('run writes the system prompt and resumes an existing transcript', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-'));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-'));
  fs.mkdirSync(path.join(ws, '.issue/roles/claude'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.github/claude'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.issue/roles/claude/spec.md'), 'You write specs.');
  fs.writeFileSync(path.join(ws, '.issue/roles/claude/spec.schema.json'), '{ "type": "object" }');
  fs.writeFileSync(path.join(ws, '.github/claude/spec.md'), 'Here, cite the saga.');
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'House rules.');
  const id = setup.uuid5('https://github.com/kubed-io/selenium-flow#issue-12');
  fs.mkdirSync(path.join(cfg, 'projects/-projects-kubed-io-selenium-flow'), { recursive: true });
  fs.writeFileSync(path.join(cfg, `projects/-projects-kubed-io-selenium-flow/${id}.jsonl`), '');
  Object.assign(process.env, {
    GITHUB_WORKSPACE: ws, RUNNER_TEMP: tmp, GITHUB_REPOSITORY: 'kubed-io/selenium-flow', CLAUDE_CONFIG_DIR: cfg,
    CLAUDE_CODE_PROJECT_DIR_NAME: '-projects-kubed-io-selenium-flow', INSTRUCTIONS: '.issue/roles/claude/spec.md\n.github/claude/spec.md\n',
    SCHEMA: '.issue/roles/claude/spec.schema.json', AGENT: '', MCP_CONFIG: '{"mcpServers":{"kb":{"url":"${KB_URL}"}}}', KB_URL: 'https://kb',
    ALLOWED_TOOLS: 'Read', DISALLOWED_TOOLS: '', SESSION_KEY: 'issue-12', SESSION_TITLE: 't', SCRATCH_DIR: '.issue',
  });
  const core = fake.core();
  await setup.run({ core });
  const prompt = fs.readFileSync(core.outputs.system_prompt_file, 'utf8');
  assert.ok(prompt.includes('## Working in a GitHub issue or pull request'));
  assert.ok(prompt.includes('`.issue/context.md`'));
  assert.ok(prompt.indexOf('You write specs.') < prompt.indexOf('Here, cite the saga.'));
  assert.ok(prompt.includes('House rules.'));
  assert.equal(core.outputs.resumed, 'true');
  assert.ok(core.outputs.args.includes(`--resume ${id}`));
  assert.ok(core.outputs.args.includes(`--json-schema '{"type":"object"}'`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'issue-agent-mcp.json'), 'utf8')).mcpServers.kb.url, 'https://kb');
});

test('a session key without a project dir name warns that resume is off', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-'));
  Object.assign(process.env, {
    GITHUB_WORKSPACE: ws, RUNNER_TEMP: tmp, GITHUB_REPOSITORY: 'kubed-io/selenium-flow', INSTRUCTIONS: '', SCHEMA: '', AGENT: '', MCP_CONFIG: '',
    ALLOWED_TOOLS: '', DISALLOWED_TOOLS: '', SESSION_KEY: 'issue-12', SESSION_TITLE: '', SCRATCH_DIR: '.issue',
  });
  delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  const core = fake.core();
  await setup.run({ core });
  assert.ok(core.notices.some((m) => /cannot resume here/.test(m)));
  assert.equal(core.outputs.resumed, 'false');
});
