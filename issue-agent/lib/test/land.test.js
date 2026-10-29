const test = require('node:test');
const assert = require('node:assert/strict');
const land = require('../land');
const fake = require('./fake');

const message = (OUTPUT) => {
  const core = fake.core();
  land.message({ core, env: { OUTPUT } });
  return core.outputs;
};

test('the commit message is the output\'s; the turn that finishes marks it done', () => {
  assert.deepEqual(message('{"commit_message":"Task 3: the cascade"}'), { message: 'Task 3: the cascade', done: 'false' });
  assert.deepEqual(message('{"commit_message":"Task 8: docs","done":true}'), { message: 'Task 8: docs\n\nAgent: done', done: 'true' });
});

test('no commit message, or no output at all, commits nothing; done still counts', () => {
  assert.deepEqual(message('{"done":true}'), { message: '', done: 'true' });
  for (const out of ['', '{}', 'not json', 'null']) assert.deepEqual(message(out), { message: '', done: 'false' });
});

function noted(env) {
  const github = fake.github({ 'issues.getComment': { body: 'Did task 3.' }, 'issues.updateComment': {} });
  return land.note({ github, context: fake.context(), env: { COMMENT_ID: '5', RUN_URL: 'https://run/1', ...env } })
    .then(() => github.calls.find((c) => c.name === 'issues.updateComment')?.params);
}

test('a failed commit is called out under the reply, with the run', async () => {
  const p = await noted({ FAILED: 'true', IGNORED: '' });
  assert.equal(p.comment_id, 5);
  assert.match(p.body, /^Did task 3\.\n\n> \[!CAUTION\]\n> \*\*This run's commit failed, so nothing above is on the branch\.\*\* See \[the run\]\(https:\/\/run\/1\)\.$/);
});

test('files left out are named under the reply', async () => {
  const p = await noted({ FAILED: 'false', IGNORED: '[".github/workflows/pr.yml"]' });
  assert.match(p.body, /> \*\*Not committed:\*\* `\.github\/workflows\/pr\.yml`\./);
});

test('nothing failed and nothing left out leaves the reply alone', async () => {
  assert.equal(await noted({ FAILED: 'false', IGNORED: '[]' }), undefined);
});

test('a draft is marked ready; a PR already out of draft is left as it is', async () => {
  for (const [draft, marks] of [[true, 1], [false, 0]]) {
    const github = fake.github({ 'pulls.get': { number: 7, draft, node_id: 'PR_7' }, graphql: {} });
    await land.ready({ github, context: fake.context(), core: fake.core(), env: { NUMBER: '7' } });
    const m = github.calls.filter((c) => c.name === 'graphql');
    assert.equal(m.length, marks);
    if (marks) assert.deepEqual(m[0].params, { id: 'PR_7' });
  }
});

test('a commit refused for a moved branch names the files, and says the changes are kept', async () => {
  const p = await noted({ FAILED: 'true', IGNORED: '', CONFLICTS: '["a.txt","docs"]', KEPT: 'true' });
  assert.match(p.body, /> \*\*This run's commit was refused: the branch moved and changed `a\.txt`, `docs` too, so nothing above is on the branch\.\*\*/);
  assert.match(p.body, /The changes are kept for the next turn\. See \[the run\]\(https:\/\/run\/1\)\.$/);
});

// a real repository and real git, as the job has them
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
  if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function realExec() {
  const calls = [];
  return {
    calls,
    getExecOutput: async (cmd, args, o = {}) => {
      calls.push([cmd, ...args]);
      const r = spawnSync(cmd, args, { cwd: o.cwd, encoding: 'utf8' });
      if (r.status && !o.ignoreReturnCode) throw new Error(r.stderr);
      return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'land-'));
  sh(root, 'init', '-q', '-b', 'main');
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  fs.writeFileSync(path.join(root, '.gitignore'), '.issue/\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'base');
  return root;
}

const read = (root, f) => fs.readFileSync(path.join(root, '.issue/scratch/unlanded', f), 'utf8');

test('what did not land goes to the scratchpad: each changed file, the deletions, the patch, and why', async () => {
  const root = repo({ 'a.txt': 'a\n', 'gone.txt': 'g\n', 'old.txt': 'o\n', 'deep/b.txt': 'b\n' });
  const head = sh(root, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(root, 'a.txt'), 'a2\n');
  fs.rmSync(path.join(root, 'gone.txt'));
  sh(root, 'mv', 'old.txt', 'new.txt');
  fs.mkdirSync(path.join(root, 'fresh'));
  fs.writeFileSync(path.join(root, 'fresh/c.txt'), 'c\n');
  // an older unlanded set is replaced, and the scratchpad's other files stay
  fs.mkdirSync(path.join(root, '.issue/scratch/unlanded/files'), { recursive: true });
  fs.writeFileSync(path.join(root, '.issue/scratch/unlanded/files/stale.txt'), 's');
  fs.writeFileSync(path.join(root, '.issue/scratch/mine.md'), 'm');
  const core = fake.core();
  await land.unlanded({ exec: realExec(), core, env: { GITHUB_WORKSPACE: root, SCRATCH_DIR: '.issue', CONFLICTS: '["a.txt"]', RUN_URL: 'https://run/1' } });
  assert.equal(core.outputs.kept, 'true');
  assert.equal(read(root, 'files/a.txt'), 'a2\n');
  assert.equal(read(root, 'files/new.txt'), 'o\n');
  assert.equal(read(root, 'files/fresh/c.txt'), 'c\n');
  assert.ok(!fs.existsSync(path.join(root, '.issue/scratch/unlanded/files/stale.txt')));
  assert.equal(fs.readFileSync(path.join(root, '.issue/scratch/mine.md'), 'utf8'), 'm');
  assert.equal(read(root, 'deleted.txt'), 'gone.txt\nold.txt\n');
  assert.match(read(root, 'changes.patch'), /^-a\n\+a2$/m);
  const why = read(root, 'README.md');
  assert.match(why, /https:\/\/run\/1/);
  assert.match(why, /changed `a\.txt` too/);
  assert.ok(why.includes(head));
  // the working tree is left as it was
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a2\n');
});

test('a clean tree keeps nothing', async () => {
  const root = repo({ 'a.txt': 'a\n' });
  const core = fake.core();
  await land.unlanded({ exec: realExec(), core, env: { GITHUB_WORKSPACE: root, SCRATCH_DIR: '.issue' } });
  assert.equal(core.outputs.kept, 'false');
  assert.ok(!fs.existsSync(path.join(root, '.issue/scratch/unlanded')));
});

test('changes inside a submodule are kept at their path in it, and its moved pointer in the patch', async () => {
  const wiki = repo({ 'page.md': 'p\n' });
  const root = repo({ 'a.txt': 'a\n' });
  sh(root, 'submodule', 'add', '-q', wiki, 'docs');
  sh(root, 'commit', '-q', '-m', 'docs');
  fs.writeFileSync(path.join(root, 'docs/page.md'), 'p2\n');
  fs.writeFileSync(path.join(root, 'docs/new.md'), 'n\n');
  const core = fake.core();
  await land.unlanded({ exec: realExec(), core, env: { GITHUB_WORKSPACE: root, SCRATCH_DIR: '.issue' } });
  assert.equal(core.outputs.kept, 'true');
  assert.equal(read(root, 'files/docs/page.md'), 'p2\n');
  assert.equal(read(root, 'files/docs/new.md'), 'n\n');
});
