const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const report = require('../report');
const fake = require('../../../issue-agent/lib/test/fake');

const SHA = 'abcdef1234567890';
const job = (id, name, conclusion, over = {}) => ({ id, name, conclusion, status: 'completed', html_url: `https://run/job/${id}`, steps: [], ...over });

function setup(routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-report-'));
  const github = fake.github({ 'checks.listAnnotations': [], ...routes });
  const core = fake.core();
  const context = fake.context({ runId: 77, job: 'checks' });
  const go = () => report.run({ github, context, core, env: { DIR: dir, SHA } });
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  return { go, read, core, github };
}

test('every check passed: says so, counts the finished jobs, skips the one still running', async () => {
  const t = setup({ 'actions.listJobsForWorkflowRun': [
    job(1, 'Test', 'success'), job(2, 'Lint', 'skipped'), { id: 3, name: 'Checks', status: 'in_progress' },
  ] });
  await t.go();
  assert.equal(t.read('report.md'), '# Checks on abcdef1: all passed\n\nEvery check passed (2 jobs).\n');
  assert.deepEqual(JSON.parse(t.read('report.json')), { sha: SHA, run: 77, passed: 2, failed: [] });
  assert.equal(t.core.outputs.failed, '0');
  assert.match(t.core.summaryText(), /all passed/);
});

test('a failed job brings its steps, annotations, errors and the log up to its last error', async () => {
  const log = [
    '2026-10-28T10:00:00.0000000Z setup',
    '2026-10-28T10:00:01.0000000Z \x1b[31mFAILED\x1b[0m tests/test_a.py::test_x',
    '2026-10-28T10:00:02.0000000Z ##[error]Process completed with exit code 1.',
    '2026-10-28T10:00:03.0000000Z Post job cleanup.',
    '2026-10-28T10:00:04.0000000Z ##[error]cleanup noise',
  ].join('\n');
  const t = setup({
    'actions.listJobsForWorkflowRun': [
      job(1, 'Test', 'failure', { steps: [{ name: 'Setup', conclusion: 'success' }, { name: 'Test', conclusion: 'failure' }] }),
      job(2, 'Lint', 'success'),
    ],
    'actions.downloadJobLogsForWorkflowRun': log,
    'checks.listAnnotations': [
      { annotation_level: 'failure', path: 'a.py', start_line: 3, title: 'boom', message: 'it\n  broke' },
      { annotation_level: 'notice', path: 'a.py', start_line: 1, message: 'fyi' },
    ],
  });
  await t.go();
  const md = t.read('report.md');
  assert.match(md, /^# Checks on abcdef1: 1 failed\n\n## Test: failure\n\nhttps:\/\/run\/job\/1\n\nFailed steps: Test\n/);
  assert.match(md, /- failure `a\.py:3` boom: it broke\n/);
  assert.ok(!md.includes('fyi'));
  assert.match(md, /### Errors\n\n```\n##\[error\]Process completed with exit code 1\.\n##\[error\]cleanup noise\n```/);
  assert.match(md, /### The log, up to the error\n\n```\nsetup\nFAILED tests\/test_a\.py::test_x\n##\[error\]Process completed with exit code 1\.\n```/);
  assert.deepEqual(JSON.parse(t.read('report.json')).failed,
    [{ name: 'Test', conclusion: 'failure', url: 'https://run/job/1', steps: ['Test'], annotations: 1 }]);
  assert.equal(t.core.outputs.failed, '1');
});

test('a log that cannot be read is named, and the report still writes', async () => {
  const t = setup({
    'actions.listJobsForWorkflowRun': [job(1, 'Bench', 'timed_out')],
    'actions.downloadJobLogsForWorkflowRun': () => Object.assign(new Error('Gone'), { status: 410 }),
    'checks.listAnnotations': () => new Error('nope'),
  });
  await t.go();
  assert.match(t.read('report.md'), /## Bench: timed_out[\s\S]*\(log unavailable: Gone\)/);
});

test('the tail stops at the last error before cleanup, and keeps at most 150 lines', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
  lines[250] = '##[error]here';
  const { tail, errors } = report.trimLog(lines.join('\n'));
  assert.equal(tail.length, 150);
  assert.equal(tail.at(-1), '##[error]here');
  assert.deepEqual(errors, ['##[error]here']);
  assert.equal(report.trimLog('a\nb\nPost job cleanup.\nc').tail.join(','), 'a,b');
});
