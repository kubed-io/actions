const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const round = require('../round');
const state = require('../state');
const fake = require('./fake');

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
    STRUCTURED: JSON.stringify({ phase: 'spec', slug: 'recordings', spec: '# Recordings\n' }), RUNNER_TEMP: tmp,
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
  Object.assign(process.env, { MODE: 'write', STRUCTURED: JSON.stringify({ phase: 'questions' }) });
  const core = fake.core();
  await round.run({ github: fake.github({ 'issues.get': { number: 12, title: 't', body: '' } }), context: fake.context(), core });
  assert.equal(core.outputs.has_round, 'false');
});
