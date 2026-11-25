// The wiki push against real repositories: a bare wiki and the checkout's clone of it. Only
// GitHub's API is a stand-in. The commit fast-forwards the wiki branch when it can, merges it
// when it cannot, and never picks a side: a passage both changed fails it, and nothing is
// pushed (quick-mcp, 2026-11-25: a rebase -X theirs dropped the merge commit e5c2812 and a
// sentence of issue-16's).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const submodule = require('../submodule');
const fake = require('./fake');

// no global or system config: no signing, no conflict style, no hooks of the host's. push()
// builds its env from process.env, so it is set here too
const ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
};
Object.assign(process.env, ENV);
const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: process.env, encoding: 'utf8' }).trim();
// `before(line)` runs ahead of each git command, so a test can move the remote mid-push
function runner(before = () => {}) {
  const calls = [];
  return {
    calls,
    getExecOutput: async (cmd, args, { env } = {}) => {
      const line = args.slice(2).join(' ');
      calls.push(line);
      before(line);
      const r = spawnSync(cmd, args, { env: env || process.env, encoding: 'utf8' });
      return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  };
}
// @actions/exec throws on a non-zero exit unless told not to
function strict(inner) {
  return {
    calls: inner.calls,
    getExecOutput: async (cmd, args, options = {}) => {
      const r = await inner.getExecOutput(cmd, args, options);
      if (r.exitCode && !options.ignoreReturnCode) throw new Error(`The process '${cmd}' failed with exit code ${r.exitCode}: ${args.join(' ')}\n${r.stderr}`);
      return r;
    },
  };
}

const DESIGN = ['# Design', '', '## Scope', '', 'The flow delivers material.', '', '## Order', '', 'Steps run in order.', '', '## Open', '', 'Nothing yet.', ''];
const edit = (text, from, to) => {
  assert.ok(text.includes(from), `no ${from}`);
  return text.replace(from, to);
};

// a commit in a work tree: `files` written and committed
function commit(dir, files, message) {
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  sh(dir, 'add', '--', ...Object.keys(files));
  sh(dir, 'commit', '-q', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD');
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

// the wiki (bare, master at w0) and a work tree that writes it; the checkout, its `docs` a
// clone of the wiki, is made by `checkout(pin)`
function repos() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'git-submodule-repos-'));
  const wiki = path.join(top, 'wiki.git');
  sh(top, 'init', '-q', '--bare', '-b', 'master', wiki);
  const w = path.join(top, 'wiki');
  sh(top, 'init', '-q', '-b', 'master', w);
  sh(w, 'remote', 'add', 'origin', wiki);
  const w0 = commit(w, { 'design.md': DESIGN.join('\n'), 'home.md': '# Home\n' }, 'the design');
  sh(w, 'push', '-q', 'origin', 'master');
  const root = path.join(top, 'checkout');
  const docs = path.join(root, 'docs');
  // the checkout's docs at `pin`, detached, as a submodule update leaves it
  const checkout = (pin) => {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.gitmodules'), `[submodule "docs"]\n\tpath = docs\n\turl = ${wiki}\n`);
    sh(top, 'clone', '-q', wiki, docs);
    sh(docs, 'checkout', '-q', '--detach', pin);
  };
  const ref = (name) => {
    const r = spawnSync('git', ['-C', wiki, 'rev-parse', '-q', '--verify', `refs/heads/${name}`], { env: process.env, encoding: 'utf8' });
    return r.status ? '' : r.stdout.trim();
  };
  const show = (rev, f) => sh(wiki, 'show', `${rev}:${f}`);
  return { top, wiki, w, w0, root, docs, checkout, ref, show };
}

// a code commit to `target` carrying the docs' changes
function go(r, { target = 'issue-16', startOf, exec = strict(runner()) } = {}) {
  const core = fake.core();
  const waits = [];
  const github = fake.github({ 'users.getByUsername': { id: 235398881 } });
  const run = submodule.push({
    github, core, exec, root: r.root, subs: ['docs'], message: 'docs: the code turn', author: 'kubed-io', auth: {},
    target, defaultBranch: 'main', startOf, wait: async (ms) => waits.push(ms),
  });
  return { run, core, waits, exec };
}

// issue-16 at A; issue-21 at B1 (the same paragraph, another way), then a hand-made merge of
// issue-16 keeping both sides, then B2: the incident's wiki
function incident(r) {
  const { w, w0 } = r;
  sh(w, 'checkout', '-q', '-b', 'issue-16', w0);
  const a = commit(w, { 'design.md': edit(read(w, 'design.md'), 'Steps run in order.', 'Steps run in order. A failed step is retried once.') }, "issue-16's sentence");
  sh(w, 'checkout', '-q', '-b', 'issue-21', w0);
  commit(w, { 'design.md': edit(read(w, 'design.md'), 'Steps run in order.', 'Steps run in order, each in its own pod.') }, "issue-21's sentence");
  spawnSync('git', ['-C', w, 'merge', '-q', '--no-edit', 'issue-16'], { env: process.env });
  fs.writeFileSync(path.join(w, 'design.md'), edit(read(w, 'design.md').replace(/<{7}[^\n]*\n|={7}\n|>{7}[^\n]*\n/g, ''), 'Steps run in order, each in its own pod.\nSteps run in order. A failed step is retried once.', 'Steps run in order, each in its own pod. A failed step is retried once.'));
  sh(w, 'add', 'design.md');
  sh(w, 'commit', '-q', '--no-edit');
  const merge = sh(w, 'rev-parse', 'HEAD');
  const b2 = commit(w, { 'home.md': '# Home\n\nSee the design.\n' }, "issue-21's home");
  sh(w, 'push', '-q', 'origin', 'issue-16', 'issue-21');
  return { a, merge, b2 };
}

test('the incident: a remote head the checkout already merged is fast-forwarded, its merge commit and both sentences kept', async () => {
  const r = repos();
  const { a, merge, b2 } = incident(r);
  r.checkout(b2);
  fs.writeFileSync(path.join(r.docs, 'home.md'), '# Home\n\nSee the design, and the order.\n');
  const t = go(r);
  assert.deepEqual(await t.run, ['docs']);
  const head = r.ref('issue-16');
  assert.equal(sh(r.wiki, 'rev-parse', `${head}^`), b2, 'this commit on the pin: a fast-forward');
  assert.ok(sh(r.wiki, 'rev-list', '--merges', head).split('\n').includes(merge), 'the merge commit is kept');
  assert.equal(sh(r.wiki, 'merge-base', '--is-ancestor', a, head), '');
  assert.match(r.show(head, 'design.md'), /^Steps run in order, each in its own pod\. A failed step is retried once\.$/m);
  assert.equal(r.show(head, 'home.md'), '# Home\n\nSee the design, and the order.');
  assert.ok(!t.exec.calls.some((c) => /^(rebase|merge |cherry-pick)/.test(c)), 'nothing rebased or merged');
});

test('a remote that moved on with another passage is merged, both edits and both histories kept', async () => {
  const r = repos();
  sh(r.w, 'checkout', '-q', '-b', 'issue-16', r.w0);
  const theirs = commit(r.w, { 'design.md': edit(read(r.w, 'design.md'), 'The flow delivers material.', 'The flow delivers material and bundles.') }, 'scope');
  sh(r.w, 'push', '-q', 'origin', 'issue-16');
  r.checkout(r.w0);
  fs.writeFileSync(path.join(r.docs, 'design.md'), edit(read(r.docs, 'design.md'), 'Nothing yet.', 'Whether a bundle is signed.'));
  assert.deepEqual(await go(r).run, ['docs']);
  const head = r.ref('issue-16');
  const [ours, remote] = sh(r.wiki, 'rev-parse', `${head}^1`, `${head}^2`).split('\n');
  assert.equal(remote, theirs);
  assert.equal(sh(r.wiki, 'log', '-1', '--format=%s', ours), 'docs: the code turn');
  const text = r.show(head, 'design.md');
  assert.match(text, /The flow delivers material and bundles\./);
  assert.match(text, /Whether a bundle is signed\./);
  assert.doesNotMatch(text, /^(<{7}|={7}|>{7})/m);
});

// a passage the remote and this commit both changed
function overlap(r, branch) {
  sh(r.w, 'checkout', '-q', '-b', branch, r.w0);
  const theirs = commit(r.w, { 'design.md': edit(read(r.w, 'design.md'), 'Nothing yet.', 'Bundles are signed.') }, 'signed');
  sh(r.w, 'push', '-q', 'origin', branch);
  return theirs;
}

const keptAsChanges = (r) => {
  assert.equal(sh(r.docs, 'rev-parse', 'HEAD'), r.w0, "the commit undone: the checkout back on its pin");
  assert.equal(sh(r.docs, 'status', '--porcelain'), 'M design.md', 'the changes left uncommitted, for keep_to');
  assert.match(read(r.docs, 'design.md'), /^Bundles are not signed\.$/m);
  assert.doesNotMatch(read(r.docs, 'design.md'), /^(<{7}|={7}|>{7})/m);
  assert.ok(!fs.existsSync(path.join(r.docs, '.git/MERGE_HEAD')), 'no merge left in progress');
  assert.ok(!fs.existsSync(path.join(r.docs, '.git/CHERRY_PICK_HEAD')), 'no cherry-pick left in progress');
};

test('a passage both changed fails it, naming the file: nothing pushed, no side picked, the changes left to keep', async () => {
  const r = repos();
  const theirs = overlap(r, 'issue-16');
  r.checkout(r.w0);
  fs.writeFileSync(path.join(r.docs, 'design.md'), edit(read(r.docs, 'design.md'), 'Nothing yet.', 'Bundles are not signed.'));
  const t = go(r);
  const e = await t.run.catch((err) => err);
  assert.ok(e instanceof Error);
  assert.match(e.message, /docs: issue-16 changed design\.md too/);
  assert.deepEqual(e.conflicts, ['docs/design.md']);
  assert.equal(r.ref('issue-16'), theirs, 'nothing pushed');
  assert.ok(!t.exec.calls.some((c) => c.startsWith('push')));
  keptAsChanges(r);
});

test('a push refused because the wiki branch moved meanwhile is fetched, merged and pushed again', async () => {
  const r = repos();
  sh(r.w, 'checkout', '-q', '-b', 'issue-16', r.w0);
  commit(r.w, { 'home.md': '# Home\n\nFirst.\n' }, 'first');
  sh(r.w, 'push', '-q', 'origin', 'issue-16');
  r.checkout(r.w0);
  fs.writeFileSync(path.join(r.docs, 'design.md'), edit(read(r.docs, 'design.md'), 'Nothing yet.', 'Whether a bundle is signed.'));
  // another run pushes a passage of its own between this run's fetch and its push
  let moved = '';
  const exec = strict(runner((line) => {
    if (!line.startsWith('push') || moved) return;
    moved = commit(r.w, { 'design.md': edit(read(r.w, 'design.md'), 'The flow delivers material.', 'The flow delivers material and bundles.') }, 'meanwhile');
    sh(r.w, 'push', '-q', 'origin', 'issue-16');
  }));
  const t = go(r, { exec });
  assert.deepEqual(await t.run, ['docs']);
  assert.equal(t.exec.calls.filter((c) => c.startsWith('push')).length, 2);
  assert.equal(t.waits.length, 1);
  const head = r.ref('issue-16');
  assert.equal(sh(r.wiki, 'merge-base', '--is-ancestor', moved, head), '');
  const text = r.show(head, 'design.md');
  assert.match(text, /The flow delivers material and bundles\./);
  assert.match(text, /Whether a bundle is signed\./);
  assert.equal(r.show(head, 'home.md'), '# Home\n\nFirst.');
});

// a sub-issue's new wiki branch, issue-28, starting from its family's pin
test("startAt: a family pin the checkout's pin already holds needs nothing: this commit on the pin, merge commit kept", async () => {
  const r = repos();
  const { a, merge, b2 } = incident(r);
  r.checkout(b2);
  fs.writeFileSync(path.join(r.docs, 'home.md'), '# Home\n\nSee the design, and the order.\n');
  const t = go(r, { target: 'issue-28', startOf: async () => a });
  assert.deepEqual(await t.run, ['docs']);
  const head = r.ref('issue-28');
  assert.equal(sh(r.wiki, 'rev-parse', `${head}^`), b2);
  assert.ok(sh(r.wiki, 'rev-list', '--merges', head).split('\n').includes(merge));
  assert.match(r.show(head, 'design.md'), /^Steps run in order, each in its own pod\. A failed step is retried once\.$/m);
  assert.ok(!t.exec.calls.some((c) => /^(rebase|merge |cherry-pick)/.test(c)));
});

test('startAt: a family pin elsewhere takes this commit alone, its other passage kept beside the family\'s', async () => {
  const r = repos();
  sh(r.w, 'checkout', '-q', '-b', 'issue-16', r.w0);
  const fam = commit(r.w, { 'design.md': edit(read(r.w, 'design.md'), 'The flow delivers material.', 'The flow delivers material and bundles.') }, "the family's");
  sh(r.w, 'push', '-q', 'origin', 'issue-16');
  // the checkout's pin is a master commit the family has not got
  sh(r.w, 'checkout', '-q', 'master');
  const pin = commit(r.w, { 'home.md': '# Home\n\nMaster only.\n' }, 'master only');
  sh(r.w, 'push', '-q', 'origin', 'master');
  r.checkout(pin);
  fs.writeFileSync(path.join(r.docs, 'design.md'), edit(read(r.docs, 'design.md'), 'Nothing yet.', 'Whether a bundle is signed.'));
  const t = go(r, { target: 'issue-28', startOf: async () => fam });
  assert.deepEqual(await t.run, ['docs']);
  const head = r.ref('issue-28');
  assert.equal(sh(r.wiki, 'rev-parse', `${head}^`), fam, 'this commit alone, on the family pin');
  assert.equal(sh(r.wiki, 'log', '-1', '--format=%s', head), 'docs: the code turn');
  const text = r.show(head, 'design.md');
  assert.match(text, /The flow delivers material and bundles\./);
  assert.match(text, /Whether a bundle is signed\./);
  assert.equal(r.show(head, 'home.md'), '# Home', "the pin's master-only commit is not brought along");
});

test('startAt: a passage the family pin changed too fails it: no wiki branch started, the changes left to keep', async () => {
  const r = repos();
  const fam = overlap(r, 'issue-16');
  r.checkout(r.w0);
  fs.writeFileSync(path.join(r.docs, 'design.md'), edit(read(r.docs, 'design.md'), 'Nothing yet.', 'Bundles are not signed.'));
  const t = go(r, { target: 'issue-28', startOf: async () => fam });
  const e = await t.run.catch((err) => err);
  assert.ok(e instanceof Error);
  assert.match(e.message, /docs: issue-28 cannot start from .* changed design\.md too/);
  assert.deepEqual(e.conflicts, ['docs/design.md']);
  assert.equal(r.ref('issue-28'), '');
  assert.ok(!t.exec.calls.some((c) => c.startsWith('push')));
  keptAsChanges(r);
});
