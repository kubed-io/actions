const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const form = require('../form');

// kubed-io/.github's own forms, as yq reads them
const DIR = path.join(__dirname, 'forms');
const FORMS = fs.readdirSync(DIR).map((n) => ({ file: n.replace(/\.json$/, ''), form: JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8')) }));
const get = (file) => FORMS.find((f) => f.file === file).form;

test('a form is a schema: a title, a property per field, its required ones', () => {
  const s = form.toSchema(get('bug'));
  assert.equal(s.title, '🐛 Bug');
  assert.deepEqual(Object.keys(s.properties), ['title', 'what-happened', 'expected', 'steps', 'scope', 'logs', 'context']);
  assert.deepEqual(s.required, ['title', 'what-happened', 'expected', 'steps']);
  assert.equal(s.properties['what-happened'].type, 'string');
  assert.equal(s.properties['what-happened'].title, 'What happened?');
  assert.equal(s.additionalProperties, false);
});

test("markdown and an attestation (every option required) are not the agent's to fill", () => {
  const keys = Object.keys(form.toSchema(get('feature')).properties);
  assert.ok(!keys.includes('search'));
  assert.deepEqual(keys, ['title', 'problem', 'solution', 'alternatives', 'context']);
});

test('a placeholder is an example, never a default', () => {
  const p = form.toSchema(get('bug')).properties.scope;
  assert.deepEqual(p.examples, ['e.g. apps/postgresql (data namespace), image kubed/postgresql:vX.Y.Z']);
  assert.equal(p.default, undefined);
});

test('a dropdown is its options, an array when multiple; checkboxes one boolean each', () => {
  const f = { name: 'x', body: [
    { type: 'dropdown', id: 'one', attributes: { label: 'One', options: ['a', 'b'] }, validations: { required: true } },
    { type: 'dropdown', id: 'many', attributes: { label: 'Many', options: ['a', 'b'], multiple: true } },
    { type: 'checkboxes', id: 'pick', attributes: { label: 'Pick', options: [{ label: 'red' }, { label: 'blue', required: true }] } },
    { type: 'input', attributes: { label: 'No Id Here' } },
  ] };
  const s = form.toSchema(f);
  assert.deepEqual(s.properties.one.enum, ['a', 'b']);
  assert.deepEqual(s.properties.many.items.enum, ['a', 'b']);
  assert.equal(s.properties.many.type, 'array');
  assert.deepEqual(Object.keys(s.properties.pick.properties), ['red', 'blue']);
  assert.deepEqual(s.properties.pick.required, ['blue']);
  assert.ok('no-id-here' in s.properties);
  assert.deepEqual(s.required, ['title', 'one']);
});

test('by type: the form whose type: it is; by template: the file stem', () => {
  assert.equal(form.pick(FORMS, { type: 'Bug' }).file, 'bug');
  assert.equal(form.pick(FORMS, { type: 'Feature' }).file, 'feature');
  // two Task forms: the first by file name
  assert.equal(form.pick(FORMS, { type: 'Task' }).file, 'agent-task');
  assert.equal(form.pick(FORMS, { template: 'make-workflow' }).file, 'make-workflow');
  assert.equal(form.pick(FORMS, { type: 'Question' }), null);
  assert.equal(form.pick(FORMS, { template: 'nope' }), null);
});

test('the catalog: sub-issues of the types that have a form, each a type, a title and why', () => {
  const s = form.catalog(FORMS, ['Feature', 'Bug', 'Question']);
  const item = s.properties.sub_issues.items;
  assert.deepEqual(item.properties.type.enum, ['Feature', 'Bug']);
  assert.deepEqual(item.required, ['type', 'title', 'why']);
  assert.ok(item.properties.type.description.includes('Bug: Report something'));
  assert.equal(form.catalog(FORMS, ['Question']), null);
});

test('filed as GitHub files the form: ### label, the value, _No response_ when empty', () => {
  const issue = form.toIssue(get('bug'), { title: 'The pod CrashLoops', 'what-happened': 'It crashes.', expected: 'It starts.', steps: '1. up', logs: 'boom' });
  assert.equal(issue.title, 'The pod CrashLoops');
  assert.equal(issue.type, 'Bug');
  assert.deepEqual(issue.labels, []);
  assert.equal(issue.body, [
    '### Existing issues', '', "- [ ] I searched the open issues and this isn't a duplicate.", '',
    '### What happened?', '', 'It crashes.', '',
    '### What did you expect?', '', 'It starts.', '',
    '### Steps to reproduce', '', '1. up', '',
    '### Where? (app / node / component)', '', '_No response_', '',
    '### Logs / output', '', '```shell\nboom\n```', '',
    '### Anything else?', '', '_No response_',
  ].join('\n'));
});

test("a form's title prefix and labels go on the issue", () => {
  const issue = form.toIssue(get('agent-task'), { title: 'Drop the gzip', summary: 'x', acceptance: 'y' });
  assert.equal(issue.title, '[task]: Drop the gzip');
  assert.deepEqual(issue.labels, ['enhancement']);
  assert.equal(issue.type, 'Task');
});
