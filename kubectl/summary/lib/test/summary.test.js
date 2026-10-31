const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const summary = require('../summary');
const fake = require('../../../../issue-agent/lib/test/fake');

const BUILD = `apiVersion: v1
kind: ServiceAccount
metadata:
  name: app
  namespace: flow
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app.kubernetes.io/name: app
  name: app
  namespace: flow
spec:
  template:
    metadata:
      name: not-this-one
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: "worker"
  namespace: flow
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: reader
`;

const LONG = `    kubectl.kubernetes.io/last-applied-configuration: |
      {"apiVersion":"batch/v1",${'"x":1,'.repeat(100)}"kind":"CronJob"}`;

const PLAN = `diff -u -N /tmp/LIVE-1/batch.v1.CronJob.flow.backup /tmp/MERGED-2/batch.v1.CronJob.flow.backup
--- /tmp/LIVE-1/batch.v1.CronJob.flow.backup	2026-10-31 16:27:30 +0000
+++ /tmp/MERGED-2/batch.v1.CronJob.flow.backup	2026-10-31 16:27:30 +0000
@@ -5,7 +5,7 @@
${LONG}
   creationTimestamp: "2026-07-21T21:40:25Z"
-  generation: 2
+  generation: 3
   labels:
     app.kubernetes.io/name: app
@@ -122,7 +122,7 @@
             name: backups
-  schedule: 0 5 * * *
+  schedule: 17 4 * * *
   suspend: false
diff -u -N /tmp/LIVE-1/v1.ConfigMap.flow.app.env /tmp/MERGED-2/v1.ConfigMap.flow.app.env
--- /tmp/LIVE-1/v1.ConfigMap.flow.app.env	2026-10-31 16:27:30 +0000
+++ /tmp/MERGED-2/v1.ConfigMap.flow.app.env	2026-10-31 16:27:30 +0000
@@ -0,0 +1,4 @@
+apiVersion: v1
+kind: ConfigMap
+metadata:
+  name: app.env

# Prune — live applyset members not in the build (would be deleted by up):
  - configmap/app-old
`;

test('resources reads kind, name and namespace off the top-level metadata only', () => {
  const r = summary.resources(BUILD);
  assert.deepEqual(r.map((x) => [x.kind, x.namespace, x.name]), [
    ['ServiceAccount', 'flow', 'app'],
    ['Deployment', 'flow', 'app'],
    ['Deployment', 'flow', 'worker'],
    ['ClusterRole', '', 'reader'],
  ]);
});

test('build groups the resources by kind, each one its own accordion', () => {
  const md = summary.render({ cmd: 'build', output: BUILD });
  assert.match(md, /^## `kubectl build`/);
  assert.match(md, /4 resources of 3 kinds/);
  assert.match(md, /<summary><b>Deployment<\/b> · 2<\/summary>/);
  assert.match(md, /<summary><code>flow\/worker<\/code><\/summary>\n\n```yaml\napiVersion: apps\/v1/);
  assert.match(md, /<summary><code>reader<\/code><\/summary>/);
});

test('build names the args when they are not the current directory', () => {
  assert.match(summary.render({ cmd: 'build', args: 'cluster', output: BUILD }), /^## `kubectl build cluster`/);
});

test('a resource too long for the summary is named, not shown', () => {
  const big = `kind: CustomResourceDefinition\nmetadata:\n  name: big.example.io\nspec:\n${'  x: y\n'.repeat(12000)}`;
  const md = summary.render({ cmd: 'build', output: big });
  assert.match(md, /<code>big\.example\.io<\/code>/);
  assert.match(md, /too long for the summary/);
  assert.doesNotMatch(md, /x: y/);
});

test('the fence outgrows backticks in the content', () => {
  assert.equal(summary.fenced('a\n```\nb', 'yaml'), '````yaml\na\n```\nb\n````');
});

test('ident splits a kubectl diff file name, dotted names and cluster scope included', () => {
  assert.deepEqual(summary.ident('/tmp/LIVE-1/v1.ConfigMap.flow.app.env'), { kind: 'ConfigMap', namespace: 'flow', name: 'app.env' });
  assert.deepEqual(summary.ident('/tmp/L/rbac.authorization.k8s.io.v1.ClusterRole..reader'), { kind: 'ClusterRole', namespace: '', name: 'reader' });
});

test('plan counts creates, updates and prunes', () => {
  const md = summary.render({ cmd: 'plan', output: PLAN });
  assert.match(md, /\*\*1\*\* to create · \*\*1\*\* to update · \*\*1\*\* to prune/);
  assert.match(md, /<code>~<\/code> CronJob <code>flow\/backup<\/code>/);
  assert.match(md, /<code>\+<\/code> ConfigMap <code>flow\/app\.env<\/code>/);
  assert.match(md, /- <code>-<\/code> <code>configmap\/app-old<\/code>/);
});

test('plan shows each diff as a diff, without the headers, the generation bump or the long context', () => {
  const md = summary.render({ cmd: 'plan', output: PLAN });
  assert.match(md, /```diff\n@@ -122,7 \+122,7 @@\n {13}name: backups\n- {2}schedule: 0 5 \* \* \*\n\+ {2}schedule: 17 4 \* \* \*/);
  assert.doesNotMatch(md, /^(---|\+\+\+) \/tmp/m);
  assert.doesNotMatch(md, /generation:/);
  assert.doesNotMatch(md, /"kind":"CronJob"/);
});

test('a small plan opens its diffs, a large one keeps them shut', () => {
  assert.match(summary.render({ cmd: 'plan', output: PLAN }), /<details open>/);
  const many = Array.from({ length: 4 }, (_, i) => `diff -u -N /a/v1.ConfigMap.ns.c${i} /b/v1.ConfigMap.ns.c${i}\n@@ -1 +1 @@\n-a\n+b`).join('\n');
  assert.doesNotMatch(summary.render({ cmd: 'plan', output: many }), /<details open>/);
});

test('a generation bump alone stays in the diff rather than leaving it empty', () => {
  const only = '@@ -5,3 +5,3 @@\n   x: 1\n-  generation: 2\n+  generation: 3';
  assert.deepEqual(summary.tidy(only.split('\n')), only.split('\n'));
});

test('plan with nothing to change says so', () => {
  assert.equal(summary.render({ cmd: 'plan', output: '' }), '## `kubectl plan`\n\nNo changes.\n');
});

test('up counts what it did and folds the unchanged away', () => {
  const out = 'configmap/a unchanged\ndeployment.apps/n8n configured\nsecret/old pruned\nI1030 throttling\n';
  const md = summary.render({ cmd: 'up', output: out });
  assert.match(md, /\*\*1\*\* configured · \*\*1\*\* pruned · \*\*1\*\* unchanged/);
  assert.match(md, /- configured <code>deployment\.apps\/n8n<\/code>\n- pruned <code>secret\/old<\/code>/);
  assert.match(md, /<summary>1 unchanged<\/summary>\n\n- <code>configmap\/a<\/code>/);
  assert.match(md, /<summary>The rest of the output<\/summary>\n\n```\nI1030 throttling\n```/);
});

test('a failed command leads with its error', () => {
  const md = summary.render({ cmd: 'up', output: '', errors: 'error: secrets "x" is forbidden', outcome: 'failure' });
  assert.match(md, /\*\*Failed\*\* \(failure\)\n\n```\nerror: secrets "x" is forbidden\n```/);
});

test('any other command is its output in a block', () => {
  assert.match(summary.render({ cmd: 'get', args: 'pods', output: 'NAME READY' }), /^## `kubectl get pods`\n\n```\nNAME READY\n```/);
});

test('run writes the files it is pointed at to the step summary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubectl-summary-'));
  fs.writeFileSync(path.join(dir, 'out.txt'), BUILD);
  const core = fake.core();
  await summary.run({ core, env: { CMD: 'build', ARGS: '.', OUTPUT_FILE: path.join(dir, 'out.txt'), ERROR_FILE: path.join(dir, 'missing'), OUTCOME: 'success' } });
  assert.match(core.summaryText(), /4 resources of 3 kinds/);
});
