// A commit that failed leaves the working tree as the only copy of its changes: they are
// written to a folder the caller keeps (a cache, a scratchpad), so they are not lost. Each
// changed or new file as it was (files/), the paths deleted, the tracked changes as a patch
// on the checkout's commit, and a README saying why. The working tree is left as it is.

const fs = require('fs');
const path = require('path');

async function git(exec, cwd, args) {
  const { stdout } = await exec.getExecOutput('git', args, { cwd, silent: true });
  return stdout;
}

// every change `git status` shows (not what it ignores), as paths from the top: the files
// the tree has, and those it lost. A submodule or a nested repository is looked into.
async function changesIn(exec, root, prefix, skip) {
  const out = await git(exec, path.join(root, prefix), ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const fields = out.split('\0');
  const files = [];
  const deleted = [];
  const add = async (p) => {
    const rel = prefix ? `${prefix}/${p.replace(/\/$/, '')}` : p.replace(/\/$/, '');
    if (skip(rel)) return;
    const full = path.join(root, rel);
    let stat = null;
    try { stat = fs.lstatSync(full); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!stat) deleted.push(rel);
    else if (!stat.isDirectory()) files.push(rel);
    else if (fs.existsSync(path.join(full, '.git'))) {
      const inner = await changesIn(exec, root, rel, skip);
      files.push(...inner.files);
      deleted.push(...inner.deleted);
    }
  };
  for (let i = 0; i < fields.length; i += 1) {
    if (!fields[i]) continue;
    const xy = fields[i].slice(0, 2);
    await add(fields[i].slice(3));
    // a rename's or copy's source follows: gone unless it is back in the tree
    if (xy[0] === 'R' || xy[0] === 'C') {
      i += 1;
      await add(fields[i]);
    }
  }
  return { files, deleted };
}

// writes the changes to `to` (from the repository's top); false when there were none
async function keep({ exec, core, root, to, conflicts = [], runUrl = '' }) {
  const rel = to.replace(/^\.\//, '').replace(/\/+$/, '');
  const skip = (p) => p === rel || p.startsWith(`${rel}/`);
  const { files, deleted } = await changesIn(exec, root, '', skip);
  if (!files.length && !deleted.length) return false;
  const dir = path.join(root, rel);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const dest = path.join(dir, 'files', f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(root, f), dest, { verbatimSymlinks: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  if (deleted.length) fs.writeFileSync(path.join(dir, 'deleted.txt'), `${deleted.sort().join('\n')}\n`);
  const head = (await git(exec, root, ['rev-parse', 'HEAD'])).trim();
  fs.writeFileSync(path.join(dir, 'changes.patch'), await git(exec, root, ['diff', '--binary', 'HEAD']));
  const lines = [
    '# Not committed',
    '',
    `The commit of ${runUrl || 'an earlier run'} failed: these changes are here, not on the branch.`,
    ...(conflicts.length ? ['', `The branch moved meanwhile and changed ${conflicts.map((p) => `\`${p}\``).join(', ')} too.`] : []),
    '',
    '- `files/`: each changed or new file as it was left, at its path.',
    ...(deleted.length ? ['- `deleted.txt`: the paths deleted.'] : []),
    `- \`changes.patch\`: the changes to tracked files, against \`${head}\`.`,
    '',
    'Bring back what still holds, on top of the branch as it is now; then delete this folder.',
    '',
  ];
  fs.writeFileSync(path.join(dir, 'README.md'), lines.join('\n'));
  core.warning(`not committed, kept in ${rel}: ${[...files, ...deleted].sort().join(', ')}`);
  return true;
}

module.exports = { keep, changesIn };
