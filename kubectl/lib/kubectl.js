// The kubectl action's two script steps. args: the command line from the inputs, written
// for run.sh one NUL-ended argument each, with the run's files in a folder of their own.
// capture: the stdout as the step's `stdout` output.

const fs = require('fs');
const os = require('os');
const path = require('path');

// args split on spaces, a quoted part kept whole: -l "tier in (a,b)" is two arguments
function split(text) {
  const out = [];
  for (const m of (text || '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// The flags go after the args: build, plan and up read their first argument as the
// app's directory. A flag whose input is not set is left out.
function cli(env) {
  const flag = (name, value) => (value ? [`--${name}`, value] : []);
  return [
    ...split(`${env.CMD || ''} ${env.ARGS || ''}`),
    ...(env.ALL_NAMESPACES === 'true' ? ['--all-namespaces'] : []),
    ...flag('namespace', env.NAMESPACE),
    ...flag('selector', env.SELECTOR),
    ...flag('output', env.OUTPUT),
    ...flag('context', env.CONTEXT),
    ...(env.DRY_RUN ? [`--dry-run=${env.DRY_RUN}`] : []),
  ];
}

async function args({ core, env = process.env }) {
  const argv = cli(env);
  if (!argv.length) throw new Error('kubectl: cmd is required');
  const dir = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'kubectl-'));
  const file = (name) => path.join(dir, name);
  fs.writeFileSync(file('args'), argv.map((a) => `${a}\0`).join(''));
  core.setOutput('args_file', file('args'));
  core.setOutput('output_file', file('stdout'));
  core.setOutput('error_file', file('stderr'));
  core.info(`kubectl ${argv.join(' ')}`);
}

async function capture({ core, env = process.env }) {
  core.setOutput('stdout', fs.readFileSync(env.OUT, 'utf8').replace(/\n$/, ''));
}

module.exports = { args, capture, cli, split };
