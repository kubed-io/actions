const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const checks = require('../checks');
const fake = require('../../../git/lib/test/fake');

const HEAD = 'a'.repeat(40);
const alert = (number, file, over = {}) => ({
  number, html_url: `https://github.com/kubed-io/actions/security/code-scanning/${number}`,
  tool: { name: 'CodeQL' }, rule: { id: 'py/x', security_severity_level: 'high' },
  most_recent_instance: { location: { path: file, start_line: 3 }, message: { text: `finding ${number}` } },
  ...over,
});
const thread = (id, n, over = {}) => ({
  id, isResolved: false, path: 'a.py', line: 3,
  first: { nodes: [{ author: { login: 'github-advanced-security' }, body: `## CodeQL\n\n[Show more details](https://github.com/kubed-io/actions/security/code-scanning/${n})` }] },
  last: { nodes: [{ author: { login: 'github-advanced-security' }, body: '' }] },
  ...over,
});

function setup(routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-checks-'));
  Object.assign(process.env, { NUMBER: '7', SCRATCH_DIR: '.issue', SCANS: 'CodeQL,Workflow Audit', GITHUB_WORKSPACE: dir });
  const github = fake.github({
    'pulls.get': { head: { sha: HEAD }, base: { ref: 'main' } },
    'pulls.listFiles': [{ filename: 'a.py' }, { filename: 'b.py' }],
    'checks.listForRef': [],
    'graphql:reviewThreads': { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    ...routes,
  });
  const read = (f) => fs.readFileSync(path.join(dir, '.issue', f), 'utf8');
  return { github, core: fake.core(), read };
}

const alerts = (byRef) => (p) => byRef[p.ref] ?? [];

test('new alerts come first with their thread; old ones only where the PR touches', async () => {
  const { github, core, read } = setup({
    'codeScanning.listAlertsForRepo': alerts({
      'refs/pull/7/merge': [alert(5, 'a.py'), alert(2, 'b.py'), alert(1, 'z.py')],
      'refs/heads/main': [alert(2, 'b.py'), alert(1, 'z.py')],
    }),
    'graphql:reviewThreads': { repository: { pullRequest: { reviewThreads: { nodes: [
      thread('T5', 5, { last: { nodes: [{ author: { login: 'kubed-io' }, body: 'Fixed in the next commit.' }] } }),
    ] } } } },
  });
  await checks.run({ github, context: fake.context(), core });
  const md = read('security.md');
  assert.match(md, /## New in this PR \(1\)\n\n### #5 · high · CodeQL `py\/x`/);
  assert.match(md, /Thread `T5` \(open\)\. Last reply, @kubed-io: "Fixed in the next commit\."/);
  assert.match(md, /## Already on main, in files this PR changes \(1\)\n\n### #2/);
  assert.match(md, /1 more alert open on main, in files this PR does not touch/);
  assert.ok(!md.includes('#1 ·'));
  assert.equal(core.outputs.new_alerts, '1');
  assert.equal(core.outputs.pending, 'false');
});

test('a PR never scanned says so, and counts no alerts', async () => {
  const { github, core, read } = setup({ 'codeScanning.listAlertsForRepo': () => fake.notFound() });
  await checks.run({ github, context: fake.context(), core });
  assert.match(read('security.md'), /No scan of this PR yet\./);
  assert.equal(core.outputs.new_alerts, '0');
});

test('a scan still running on the head is named, and pending', async () => {
  const { github, core, read } = setup({
    'codeScanning.listAlertsForRepo': alerts({}),
    'checks.listForRef': [{ id: 1, name: 'CodeQL', status: 'in_progress', app: { slug: 'github-actions' } }],
  });
  await checks.run({ github, context: fake.context(), core });
  assert.match(read('security.md'), /Still scanning aaaaaaa: CodeQL\./);
  assert.equal(core.outputs.pending, 'true');
});

test('a thread on an alert no longer open is left to resolve; a resolved one is not', async () => {
  const { github, core, read } = setup({
    'codeScanning.listAlertsForRepo': alerts({}),
    'graphql:reviewThreads': { repository: { pullRequest: { reviewThreads: { nodes: [
      thread('T9', 9), thread('T8', 8, { isResolved: true }),
      thread('TX', 4, { first: { nodes: [{ author: { login: 'kferrone' }, body: 'I think https://github.com/kubed-io/actions/security/code-scanning/4 is wrong' }] } }),
    ] } } } },
  });
  await checks.run({ github, context: fake.context(), core });
  const md = read('security.md');
  assert.match(md, /- #9: thread `T9`\. Resolve it\./);
  assert.ok(!md.includes('T8') && !md.includes('TX'));
});

test('annotations: failures and warnings of finished checks, never the scanner\'s', async () => {
  const { github, core, read } = setup({
    'codeScanning.listAlertsForRepo': alerts({}),
    'checks.listForRef': [
      { id: 1, name: 'Lint / Dockerfile Lint', status: 'completed', conclusion: 'failure', html_url: 'u1', app: { slug: 'github-actions' }, output: { annotations_count: 3 } },
      { id: 2, name: 'CodeQL', status: 'completed', conclusion: 'neutral', app: { slug: 'github-advanced-security' }, output: { annotations_count: 4 } },
      { id: 3, name: 'UI / UI', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, output: { annotations_count: 0 } },
    ],
    'checks.listAnnotations': (p) => (p.check_run_id === 1 ? [
      { annotation_level: 'failure', path: 'Dockerfile', start_line: 4, title: 'DL3008', message: 'Pin versions\n in apt get install' },
      { annotation_level: 'notice', path: 'Dockerfile', start_line: 9, message: 'fyi' },
    ] : assert.fail(`read annotations of ${p.check_run_id}`)),
  });
  await checks.run({ github, context: fake.context(), core });
  const md = read('checks.md');
  assert.match(md, /## Lint \/ Dockerfile Lint: failure\n\nu1\n\n- failure `Dockerfile:4` DL3008: Pin versions in apt get install/);
  assert.ok(!md.includes('fyi') && !md.includes('CodeQL'));
});

test('a head with nothing to say says so', async () => {
  const { github, core, read } = setup({ 'codeScanning.listAlertsForRepo': alerts({}) });
  await checks.run({ github, context: fake.context(), core });
  assert.match(read('checks.md'), /No failure or warning annotations on the head\./);
});
