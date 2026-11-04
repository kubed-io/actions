const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const run = require('../run');
const fake = require('../../../issue-agent/lib/test/fake');

const CTX = { repo: { owner: 'kubed-io', repo: 'mcp-kb' } };

test("repo: left out it is the organisation's .github (the input's default); empty, this repository", () => {
  assert.deepEqual(run.repoOf({ FORMS_REPO: 'kubed-io/.github' }, CTX), { owner: 'kubed-io', repo: '.github' });
  assert.deepEqual(run.repoOf({ FORMS_REPO: '' }, CTX), { owner: 'kubed-io', repo: 'mcp-kb' });
  assert.throws(() => run.repoOf({ FORMS_REPO: 'nope' }, CTX), /owner\/name/);
});

function forms() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-template-'));
  const dir = path.join(root, 'forms');
  fs.mkdirSync(dir);
  for (const n of fs.readdirSync(path.join(__dirname, 'forms'))) fs.copyFileSync(path.join(__dirname, 'forms', n), path.join(dir, n));
  return dir;
}

test('build by type: the form, its schema file and what filing needs', () => {
  const core = fake.core();
  run.build({ core, env: { FORMS_DIR: forms(), TYPE: 'Feature', TEMPLATE: '', TYPES: 'Feature,Bug' } });
  assert.equal(core.outputs.template, 'feature');
  assert.equal(core.outputs.type, 'Feature');
  assert.equal(core.outputs.labels, 'enhancement');
  const s = JSON.parse(fs.readFileSync(core.outputs.schema, 'utf8'));
  assert.ok('problem' in s.properties);
});

test('two builds in one job keep both schemas', () => {
  const dir = forms();
  const a = fake.core(); run.build({ core: a, env: { FORMS_DIR: dir, TYPE: 'Bug', TEMPLATE: '', TYPES: 'Feature,Bug' } });
  const b = fake.core(); run.build({ core: b, env: { FORMS_DIR: dir, TYPE: '', TEMPLATE: '', TYPES: 'Feature,Bug' } });
  assert.notEqual(a.outputs.schema, b.outputs.schema);
  assert.ok('what-happened' in JSON.parse(fs.readFileSync(a.outputs.schema, 'utf8')).properties);
});

test('build with neither: the catalog', () => {
  const core = fake.core();
  run.build({ core, env: { FORMS_DIR: forms(), TYPE: '', TEMPLATE: '', TYPES: 'Feature,Bug' } });
  assert.equal(core.outputs.template, '');
  const s = JSON.parse(fs.readFileSync(core.outputs.schema, 'utf8'));
  assert.deepEqual(s.properties.sub_issues.items.properties.type.enum, ['Feature', 'Bug']);
});

test('build of a type with no form fails and names what it looked among', () => {
  const core = fake.core();
  run.build({ core, env: { FORMS_DIR: forms(), TYPE: 'Question', TEMPLATE: '', TYPES: '' } });
  assert.match(core.failures.join(" "), /no form of type Question among .*bug/);
});
