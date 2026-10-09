const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const round = require('../round');
const state = require('../state');
const fake = require('./fake');

function structuredFile(value) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'structured-')), 'issue-agent-structured.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test('slugify drops the template prefix and keeps six words', () => {
  assert.equal(round.slugify('[feature]: Selenium screen recordings for every browser session ever'), 'selenium-screen-recordings-for-every-browser');
  assert.equal(round.slugify(''), 'untitled');
});

test('the first round fixes slug and path; the next keeps them', () => {
  const values = { structured: { slug: 'recordings' }, document: 'spec', template: 'docs/superpowers/specs/{date}-{slug}-design.md', title: 'x', number: 12, date: '2026-10-08', run: '5', artifact: '7', artifactUrl: 'a', summaryUrl: 's' };
  const one = round.nextState(null, values);
  assert.deepEqual(one, { slug: 'recordings', path: 'docs/superpowers/specs/2026-10-08-recordings-design.md', round: 1, run: '5', artifact: '7', artifact_url: 'a', summary_url: 's', approved: false });
  const two = round.nextState(one, { ...values, structured: { slug: 'other' }, date: '2026-10-09', run: '6' });
  assert.equal(two.path, one.path);
  assert.equal(two.round, 2);
});

test('header and links', () => {
  const s = { round: 3, summary_url: 'S', artifact_url: 'A', path: 'p', branch: 'b', approved: true };
  assert.equal(round.header(s, 'spec', true), '📄 **Spec** · round 3 (updated in this reply) · [read](S) · [download](A)');
  assert.equal(round.links(s, 'spec'), 'Spec, round 3: [read](S) · [download](A) · approved: `p` on `b`');
});

test('the summary is cut at 1 MiB with a note', () => {
  const big = 'x'.repeat(2 * 1024 * 1024);
  const out = round.summary('plan', 'T', 1, big);
  assert.ok(Buffer.byteLength(out) < 1024 * 1024);
  assert.ok(out.endsWith(`_Cut at 1 MiB: the artifact has all ${2 * 1024 * 1024} bytes._\n`));
  assert.ok(round.summary('plan', 'T', 1, 'small').startsWith('# Plan · T · round 1\n\nsmall'));
});

test('write then publish: artifact file, summary, body state, header', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'round-'));
  let body = 'Record the browser.';
  const github = fake.github({ 'issues.get': () => ({ number: 12, title: '[feature]: Recordings', body }), 'issues.update': (p) => { body = p.body; return {}; } });
  Object.assign(process.env, {
    NUMBER: '12', DOCUMENT: 'spec', DOCUMENT_PATH: 'docs/superpowers/specs/{date}-{slug}-design.md',
    STRUCTURED_FILE: structuredFile({ phase: 'spec', slug: 'recordings', spec: '# Recordings\n' }), RUNNER_TEMP: tmp,
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '5', CHECK_RUN_ID: '9', ARTIFACT_ID: '7', ARTIFACT_URL: 'https://a',
  });
  const core = fake.core();
  process.env.MODE = 'write';
  await round.run({ github, context: fake.context(), core });
  assert.equal(core.outputs.has_round, 'true');
  assert.match(core.outputs.file, /\d{4}-\d\d-\d\d-recordings-design\.md$/);
  assert.equal(fs.readFileSync(core.outputs.file, 'utf8'), '# Recordings\n');
  assert.match(core.outputs.date, /^\d{4}-\d\d-\d\d$/);
  process.env.MODE = 'publish';
  await round.run({ github, context: fake.context(), core });
  assert.ok(core.summaryText().startsWith('# Spec · [feature]: Recordings · round 1'));
  assert.equal(state.readState(body, 'spec').summary_url, 'https://github.com/kubed-io/selenium-flow/actions/runs/5#summary-9');
  assert.ok(body.startsWith('Record the browser.\n\n<!-- issue-agent:spec -->'));
  assert.ok(core.outputs.header.includes('round 1 (updated in this reply)'));
});

test('publish reuses the date write named, even across midnight', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'round-'));
  let body = 'Another reply.';
  const github = fake.github({ 'issues.get': () => ({ number: 12, title: '[feature]: Recordings', body }), 'issues.update': (p) => { body = p.body; return {}; } });
  Object.assign(process.env, { RUNNER_TEMP: tmp, DATE: '1999-12-31', MODE: 'write' });
  const core = fake.core();
  await round.run({ github, context: fake.context(), core });
  assert.equal(core.outputs.date, '1999-12-31');
  assert.ok(path.basename(core.outputs.file).includes('1999-12-31'));
  process.env.MODE = 'publish';
  await round.run({ github, context: fake.context(), core });
  assert.equal(state.readState(body, 'spec').path, `docs/superpowers/specs/1999-12-31-recordings-design.md`);
  assert.equal(path.basename(core.outputs.file), path.basename(state.readState(body, 'spec').path));
  delete process.env.DATE;
});

test('no document in the output is no round', async () => {
  Object.assign(process.env, { MODE: 'write', STRUCTURED_FILE: structuredFile({ phase: 'questions' }) });
  const core = fake.core();
  await round.run({ github: fake.github({ 'issues.get': { number: 12, title: 't', body: '' } }), context: fake.context(), core });
  assert.equal(core.outputs.has_round, 'false');
});

test('a state block planted with a path outside docs/ is not kept', () => {
  const values = { structured: { slug: 'recordings' }, document: 'spec', template: 'docs/superpowers/specs/{date}-{slug}-design.md', title: 'Recordings', number: 12, date: '2026-10-08', run: '5', artifact: '7', artifactUrl: 'a', summaryUrl: 's' };
  const planted = { slug: 'x', path: '.github/workflows/x.yml', round: 4 };
  const next = round.nextState(planted, values);
  assert.equal(next.path, 'docs/superpowers/specs/2026-10-08-recordings-design.md');
  assert.equal(next.slug, 'recordings');
  assert.equal(next.round, 5);
});

const OK = {
  slug: 'recordings', path: 'docs/superpowers/specs/2026-10-08-recordings-design.md', round: 2, run: '5', artifact: '7',
  artifact_url: 'https://github.com/kubed-io/selenium-flow/actions/runs/5/artifacts/7',
  summary_url: 'https://github.com/kubed-io/selenium-flow/actions/runs/5#summary-9', approved: false,
};
const user = (login, id) => ({ __typename: 'User', login, databaseId: id });
const editedBy = (editor) => ({ 'graphql:issueOrPullRequest': { repository: { issueOrPullRequest: { author: user('stranger', 2), editor } } } });

function readWith(editor, env = {}) {
  Object.assign(process.env, { MODE: 'read', NUMBER: '12', DOCUMENT: 'spec', GITHUB_SERVER_URL: 'https://github.com', TRUSTED_IDS: '1', ...env });
  const github = fake.github({ 'issues.get': { number: 12, title: 't', body: state.writeSection('x', 'spec', OK, []) }, ...editedBy(editor) });
  const core = fake.core();
  return round.run({ github, context: fake.context(), core }).then(() => core);
}

test('read ignores a state the untrusted author edited last', async () => {
  const core = await readWith(user('stranger', 2));
  assert.equal(core.outputs.artifact, undefined);
  assert.ok(core.notices.some((m) => /not written by the agent/.test(m)));
});

test('read uses a state a Bot or a trusted id edited last', async () => {
  assert.equal((await readWith({ __typename: 'Bot', login: 'app', databaseId: 9 })).outputs.artifact, '7');
  assert.equal((await readWith(user('kelly', 1))).outputs.artifact, '7');
});

test('place says so when the last round can no longer be downloaded', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  Object.assign(process.env, { GITHUB_WORKSPACE: ws, SCRATCH_DIR: '.issue', FILE: 'x.md', DOWNLOADED: 'failure' });
  const github = fake.github({ 'issues.get': { number: 12, title: 't', body: state.writeSection('x', 'spec', OK, []) }, ...editedBy({ __typename: 'Bot', login: 'app', databaseId: 9 }) });
  process.env.MODE = 'place';
  await round.run({ github, context: fake.context(), core: fake.core() });
  assert.equal(fs.readFileSync(path.join(ws, '.issue', 'spec.md'), 'utf8'),
    'Round 2 of this spec is no longer downloadable (artifacts expire after 90 days). Work from this session, and return the whole spec again.\n');
});

test('place moves the downloaded round into place', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  fs.mkdirSync(path.join(ws, '.issue'));
  fs.writeFileSync(path.join(ws, '.issue', 'x.md'), '# Spec\n');
  Object.assign(process.env, { GITHUB_WORKSPACE: ws, SCRATCH_DIR: '.issue', FILE: 'x.md', DOWNLOADED: 'success', MODE: 'place' });
  const github = fake.github({ 'issues.get': { number: 12, title: 't', body: state.writeSection('x', 'spec', OK, []) }, ...editedBy({ __typename: 'Bot', login: 'app', databaseId: 9 }) });
  await round.run({ github, context: fake.context(), core: fake.core() });
  assert.equal(fs.readFileSync(path.join(ws, '.issue', 'spec.md'), 'utf8'), '# Spec\n');
});
