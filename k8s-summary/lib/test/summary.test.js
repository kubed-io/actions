const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const summary = require('../summary');
const fake = require('../../../issue-agent/lib/test/fake');

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

const LIST = `apiVersion: v1
items:
- apiVersion: v1
  kind: Pod
  metadata:
    name: n8n-0
    namespace: flow
  spec:
    containers:
    - name: n8n
- apiVersion: v1
  kind: Pod
  metadata:
    name: n8n-1
    namespace: flow
kind: List
metadata:
  resourceVersion: ""
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

const UP = 'configmap/a unchanged\ndeployment.apps/n8n configured\nsecret/old pruned\nI1030 throttling\n';

const one = (type, content, over = {}) => summary.render({ sections: [{ type, content, ...over }] });

// --- yaml

test('yaml reads kind, name and namespace off the top-level metadata only', () => {
  assert.deepEqual(summary.resources(BUILD).map((x) => [x.kind, x.namespace, x.name]), [
    ['ServiceAccount', 'flow', 'app'],
    ['Deployment', 'flow', 'app'],
    ['Deployment', 'flow', 'worker'],
    ['ClusterRole', '', 'reader'],
  ]);
});

test('yaml groups the resources by kind, each one its own accordion', () => {
  const md = one('yaml', BUILD);
  assert.match(md, /4 resources of 3 kinds/);
  assert.match(md, /<summary><b>Deployment<\/b> · 2<\/summary>/);
  assert.match(md, /<summary><code>flow\/worker<\/code><\/summary>\n\n```yaml\napiVersion: apps\/v1/);
  assert.match(md, /<summary><code>reader<\/code><\/summary>/);
});

test('yaml opens a kubectl List into its items', () => {
  const md = one('yaml', LIST);
  assert.match(md, /2 resources of 1 kind\b/);
  assert.match(md, /<summary><code>flow\/n8n-1<\/code><\/summary>\n\n```yaml\napiVersion: v1\nkind: Pod/);
  assert.doesNotMatch(md, /<b>List<\/b>/);
});

test('yaml reads JSON, a List or one resource', () => {
  const list = JSON.stringify({ kind: 'List', items: [{ kind: 'Pod', metadata: { name: 'p', namespace: 'ns' } }] });
  assert.match(one('yaml', list), /<summary><code>ns\/p<\/code><\/summary>\n\n```json\n\{/);
  assert.match(one('yaml', JSON.stringify({ kind: 'Node', metadata: { name: 'nuc' } })), /<b>Node<\/b> · 1/);
});

test('a resource too long for the summary is named, not shown', () => {
  const big = `kind: CustomResourceDefinition\nmetadata:\n  name: big.example.io\nspec:\n${'  x: y\n'.repeat(12000)}`;
  const md = one('yaml', big);
  assert.match(md, /<code>big\.example\.io<\/code>/);
  assert.match(md, /too long for the summary/);
  assert.doesNotMatch(md, /x: y/);
});

test('the fence outgrows backticks in the content', () => {
  assert.equal(summary.fenced('a\n```\nb', 'yaml'), '````yaml\na\n```\nb\n````');
});

// --- diff

test('ident splits a kubectl diff file name, dotted names and cluster scope included', () => {
  assert.deepEqual(summary.ident('/tmp/LIVE-1/v1.ConfigMap.flow.app.env'), { kind: 'ConfigMap', namespace: 'flow', name: 'app.env' });
  assert.deepEqual(summary.ident('/tmp/L/rbac.authorization.k8s.io.v1.ClusterRole..reader'), { kind: 'ClusterRole', namespace: '', name: 'reader' });
});

test('diff counts creates, updates and prunes', () => {
  const md = one('diff', PLAN);
  assert.match(md, /\*\*1\*\* to create · \*\*1\*\* to update · \*\*1\*\* to prune/);
  assert.match(md, /<code>~<\/code> CronJob <code>flow\/backup<\/code>/);
  assert.match(md, /<code>\+<\/code> ConfigMap <code>flow\/app\.env<\/code>/);
  assert.match(md, /- <code>-<\/code> <code>configmap\/app-old<\/code>/);
});

test('diff shows each as a diff, without the headers, the generation bump or the long context', () => {
  const md = one('diff', PLAN);
  assert.match(md, /```diff\n@@ -122,7 \+122,7 @@\n {13}name: backups\n- {2}schedule: 0 5 \* \* \*\n\+ {2}schedule: 17 4 \* \* \*/);
  assert.doesNotMatch(md, /^(---|\+\+\+) \/tmp/m);
  assert.doesNotMatch(md, /generation:/);
  assert.doesNotMatch(md, /"kind":"CronJob"/);
});

test('a small diff shows open, a large one shut', () => {
  assert.match(one('diff', PLAN), /<details open>/);
  const many = Array.from({ length: 4 }, (_, i) => `diff -u -N /a/v1.ConfigMap.ns.c${i} /b/v1.ConfigMap.ns.c${i}\n@@ -1 +1 @@\n-a\n+b`).join('\n');
  assert.doesNotMatch(one('diff', many), /<details open>/);
});

test('a generation bump alone stays in the diff rather than leaving it empty', () => {
  const only = '@@ -5,3 +5,3 @@\n   x: 1\n-  generation: 2\n+  generation: 3';
  assert.deepEqual(summary.tidy(only.split('\n')), only.split('\n'));
});

test('an empty diff says there are no changes', () => {
  assert.equal(one('diff', ''), 'No changes.\n');
});

// --- names

test('names from up count each verb and fold the unchanged away', () => {
  const md = one('names', UP);
  assert.match(md, /\*\*1\*\* configured · \*\*1\*\* pruned · \*\*1\*\* unchanged/);
  assert.match(md, /- configured <code>deployment\.apps\/n8n<\/code>\n- pruned <code>secret\/old<\/code>/);
  assert.match(md, /<summary>1 unchanged<\/summary>\n\n- <code>configmap\/a<\/code>/);
  assert.match(md, /<summary>The rest of the output<\/summary>\n\n```\nI1030 throttling\n```/);
});

test('names from get -o name are grouped by kind', () => {
  const md = one('names', 'pod/n8n-0\npod/n8n-1\ndeployment.apps/n8n\n');
  assert.match(md, /3 resources of 2 kinds/);
  assert.match(md, /<summary><b>pod<\/b> · 2<\/summary>\n\n- <code>n8n-0<\/code>\n- <code>n8n-1<\/code>/);
});

// --- text and auto

test('text is the output in a block, in its lang', () => {
  assert.equal(one('text', 'NAME READY'), '```\nNAME READY\n```\n');
  assert.equal(one('text', '{"a":1}', { lang: 'json' }), '```json\n{"a":1}\n```\n');
});

test('auto tells the views apart', () => {
  assert.equal(summary.detect(PLAN), 'diff');
  assert.equal(summary.detect(BUILD), 'yaml');
  assert.equal(summary.detect(LIST), 'yaml');
  assert.equal(summary.detect(UP), 'names');
  assert.equal(summary.detect('pod/a\npod/b'), 'names');
  assert.equal(summary.detect('NAME   READY\nn8n-0  1/1'), 'text');
});

test('an unknown type is refused', () => {
  assert.throws(() => one('table', 'x'), /type "table" is not one of/);
});

// --- sections

test('sections stack under the title, each under its own', () => {
  const md = summary.render({ title: 'n8n', sections: [{ title: 'Build', type: 'yaml', content: BUILD }, { title: 'Plan', type: 'diff', content: '' }] });
  assert.match(md, /^## n8n\n\n### Build\n\n4 resources of 3 kinds[\s\S]*\n### Plan\n\nNo changes\.\n$/);
});

test('the sections input reads as YAML or JSON', () => {
  const yaml = '- title: Build\n  file: rendered.yaml\n  type: yaml\n# a note\n- title: "Plan"\n  file: /tmp/out.txt\n  type: diff\n';
  const want = [{ title: 'Build', file: 'rendered.yaml', type: 'yaml' }, { title: 'Plan', file: '/tmp/out.txt', type: 'diff' }];
  assert.deepEqual(summary.parseSections(yaml), want);
  assert.deepEqual(summary.parseSections(JSON.stringify(want)), want);
  assert.throws(() => summary.parseSections('- title: x\n  just words'), /cannot read "just words"/);
});

test('a failed section leads with its error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8s-summary-'));
  fs.writeFileSync(path.join(dir, 'err'), 'error: secrets "x" is forbidden\n');
  const md = summary.render({ sections: [{ type: 'names', content: '', outcome: 'failure', error_file: path.join(dir, 'err') }] });
  assert.equal(md, '**Failed** (failure)\n\n```\nerror: secrets "x" is forbidden\n```\n');
});

test('a skipped section says so and nothing else', () => {
  assert.equal(summary.render({ sections: [{ title: 'Plan', type: 'diff', file: '', outcome: 'skipped' }] }), '### Plan\n\nSkipped.\n');
});

test('run takes the single file first, then the sections, and writes the summary and the file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8s-summary-'));
  fs.writeFileSync(path.join(dir, 'build.yaml'), BUILD);
  fs.writeFileSync(path.join(dir, 'up.txt'), UP);
  const core = fake.core();
  const env = {
    RUNNER_TEMP: dir,
    TITLE: 'n8n',
    FILE: path.join(dir, 'build.yaml'),
    SECTION_TITLE: 'Build',
    TYPE: 'yaml',
    SECTIONS: `- title: Up\n  file: ${path.join(dir, 'up.txt')}\n`,
  };
  await summary.run({ core, env });
  const md = core.summaryText();
  assert.ok(md.indexOf('### Build') < md.indexOf('### Up'));
  assert.match(md, /\*\*1\*\* configured/);
  assert.equal(fs.readFileSync(core.outputs.markdown_file, 'utf8'), md);
});

test('run with write false only outputs the markdown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8s-summary-'));
  const core = fake.core();
  await summary.run({ core, env: { RUNNER_TEMP: dir, CONTENT: 'pod/a', WRITE: 'false' } });
  assert.equal(core.summaryText(), '');
  assert.match(fs.readFileSync(core.outputs.markdown_file, 'utf8'), /1 resource of 1 kind/);
});
