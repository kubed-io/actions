const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const file = require('../file');
const fake = require('../../../issue-agent/lib/test/fake');

const FORM = path.join(__dirname, 'forms', 'bug.json');
const FILLED = { title: 'The pod CrashLoops', 'what-happened': 'It crashes.', expected: 'It starts.', steps: '1. up' };
const env = (over = {}) => ({ FORM, OUTPUT: JSON.stringify(FILLED), PARENT: '33', LABELS: 'agent', ...over });
const names = (g) => g.calls.map((c) => c.name);

test('files the form, links it under the parent, then labels it', async () => {
  const github = fake.github({ 'issues.listSubIssues': [], 'issues.create': { id: 9001, number: 41, html_url: 'u41' }, 'issues.addSubIssue': {}, 'issues.addLabels': [] });
  const core = fake.core();
  await file.run({ github, context: fake.context(), core, env: env() });
  assert.deepEqual(names(github), ['issues.listSubIssues', 'issues.create', 'issues.addSubIssue', 'issues.addLabels']);
  const made = github.calls.find((c) => c.name === 'issues.create').params;
  assert.equal(made.title, 'The pod CrashLoops');
  assert.equal(made.type, 'Bug');
  assert.ok(made.body.startsWith('### Existing issues'));
  assert.deepEqual(github.calls.find((c) => c.name === 'issues.addSubIssue').params.sub_issue_id, 9001);
  assert.deepEqual(github.calls.find((c) => c.name === 'issues.addLabels').params.labels, ['agent']);
  assert.deepEqual(core.outputs, { number: '41', url: 'u41', created: 'true' });
});

test('a sub-issue of the same title is already filed: nothing is created', async () => {
  const github = fake.github({ 'issues.listSubIssues': [{ number: 40, title: 'the pod crashloops ', html_url: 'u40' }] });
  const core = fake.core();
  await file.run({ github, context: fake.context(), core, env: env() });
  assert.deepEqual(names(github), ['issues.listSubIssues']);
  assert.deepEqual(core.outputs, { number: '40', url: 'u40', created: 'false' });
});

test('a refused issue type still files the issue, without it', async () => {
  let first = true;
  const github = fake.github({
    'issues.listSubIssues': [],
    'issues.create': (p) => { if (first && p.type) { first = false; return Object.assign(new Error('type'), { status: 422 }); } return { id: 7, number: 42, html_url: 'u42' }; },
    'issues.addSubIssue': {}, 'issues.addLabels': [],
  });
  const core = fake.core();
  await file.run({ github, context: fake.context(), core, env: env() });
  assert.equal(core.outputs.number, '42');
  assert.equal(github.calls.filter((c) => c.name === 'issues.create').length, 2);
});

test('no title, nothing filed', async () => {
  const github = fake.github({});
  const core = fake.core();
  await file.run({ github, context: fake.context(), core, env: env({ OUTPUT: '{}' }) });
  assert.equal(github.calls.length, 0);
  assert.match(core.failures.join(' '), /no title/);
});
