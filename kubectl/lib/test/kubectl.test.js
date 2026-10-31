const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const kubectl = require('../kubectl');
const fake = require('../../../issue-agent/lib/test/fake');

test('the command and its args come first, the flags after', () => {
  assert.deepEqual(kubectl.cli({ CMD: 'plan', ARGS: '.', NAMESPACE: 'flow' }), ['plan', '.', '--namespace', 'flow']);
});

test('every flag, each only when its input is set', () => {
  const env = { CMD: 'get', ARGS: 'pods', ALL_NAMESPACES: 'true', NAMESPACE: '', SELECTOR: 'tier in (a,b)', OUTPUT: 'jsonpath={.items[*].metadata.name}', CONTEXT: 'home', DRY_RUN: 'server' };
  assert.deepEqual(kubectl.cli(env), [
    'get', 'pods', '--all-namespaces', '--selector', 'tier in (a,b)',
    '--output', 'jsonpath={.items[*].metadata.name}', '--context', 'home', '--dry-run=server',
  ]);
  assert.deepEqual(kubectl.cli({ CMD: 'build', ARGS: '.', ALL_NAMESPACES: 'false' }), ['build', '.']);
});

test('args split on spaces, a quoted part kept whole', () => {
  assert.deepEqual(kubectl.split('get pods -l "tier in (a,b)" --field-selector \'status.phase=Running\''),
    ['get', 'pods', '-l', 'tier in (a,b)', '--field-selector', 'status.phase=Running']);
  assert.deepEqual(kubectl.split(''), []);
});

test('args writes the command line NUL-ended and names the run its own files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kubectl-test-'));
  const core = fake.core();
  await kubectl.args({ core, env: { RUNNER_TEMP: tmp, CMD: 'get', ARGS: 'pods', SELECTOR: 'a b' } });
  assert.equal(fs.readFileSync(core.outputs.args_file, 'utf8'), 'get\0pods\0--selector\0a b\0');
  assert.equal(path.dirname(core.outputs.output_file), path.dirname(core.outputs.args_file));
  assert.match(core.outputs.error_file, /stderr$/);

  const again = fake.core();
  await kubectl.args({ core: again, env: { RUNNER_TEMP: tmp, CMD: 'get' } });
  assert.notEqual(again.outputs.output_file, core.outputs.output_file);
});

test('args without a command fails', async () => {
  await assert.rejects(kubectl.args({ core: fake.core(), env: { RUNNER_TEMP: os.tmpdir() } }), /cmd is required/);
});

test('capture gives the stdout without its last newline', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kubectl-test-')), 'stdout');
  fs.writeFileSync(file, 'n8nio/n8n:2.45.4\n');
  const core = fake.core();
  await kubectl.capture({ core, env: { OUT: file } });
  assert.equal(core.outputs.stdout, 'n8nio/n8n:2.45.4');
});
