// Lands an agent's turn on its branch: the commit message from its output, then (in the
// action) the wiki and the signed commit, then what the reply must not claim, and the PR
// marked ready when the agent says it is done. What does not land is kept in the scratchpad
// for the next turn.

const fs = require('fs');
const path = require('path');

// the turn that finishes the plan marks its commit, so its push wakes nothing
const DONE = 'Agent: done';

function message({ core, env = process.env }) {
  let out = {};
  try { out = JSON.parse(env.OUTPUT || '{}') || {}; } catch {}
  let text = typeof out.commit_message === 'string' ? out.commit_message : '';
  const done = out.done === true;
  if (done && text) text = `${text}\n\n${DONE}`;
  core.setOutput('message', text);
  core.setOutput('done', String(done));
}

// The reply was posted before the commit: it says what the commit left out, or that it
// failed, so it never claims work the branch does not have
async function note({ github, context, env = process.env }) {
  const id = Number(env.COMMENT_ID);
  const ignored = JSON.parse(env.IGNORED || '[]');
  const failed = env.FAILED === 'true';
  if (!id || (!failed && !ignored.length)) return;
  const { data: comment } = await github.rest.issues.getComment({ ...context.repo, comment_id: id });
  const conflicts = JSON.parse(env.CONFLICTS || '[]');
  const why = conflicts.length
    ? `This run's commit was refused: the branch moved and changed ${conflicts.map((p) => `\`${p}\``).join(', ')} too, so nothing above is on the branch.`
    : 'This run\'s commit failed, so nothing above is on the branch.';
  const kept = env.KEPT === 'true' ? ' The changes are kept for the next turn.' : '';
  const body = failed
    ? `> [!CAUTION]\n> **${why}**${kept} See [the run](${env.RUN_URL}).`
    : `> [!WARNING]\n> **Not committed:** ${ignored.map((p) => `\`${p}\``).join(', ')}. This job's token can't write workflow files, so they need a commit by hand.`;
  await github.rest.issues.updateComment({ ...context.repo, comment_id: id, body: `${comment.body}\n\n${body}` });
}

// out of draft, on the token given (the App's), so ready_for_review wakes what follows
async function ready({ github, context, core, env = process.env }) {
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(env.NUMBER) });
  if (!pr.draft) return core.info(`#${pr.number} is already ready`);
  await github.graphql('mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }', { id: pr.node_id });
  core.info(`#${pr.number} is ready for review`);
}

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

// The commit failed, so the turn's working tree is all there is of its work: it goes to
// {scratch}/scratch/unlanded/, which the scratchpad keeps for the next turn. Each changed or
// new file as it was left (files/), the paths deleted, the tracked changes as a patch on the
// checkout's commit, and why. The working tree is left as it is.
async function unlanded({ exec, core, env = process.env }) {
  const root = env.GITHUB_WORKSPACE || process.cwd();
  const scratch = (env.SCRATCH_DIR || '.issue').replace(/\/+$/, '');
  const skip = (p) => p === scratch || p.startsWith(`${scratch}/`);
  const { files, deleted } = await changesIn(exec, root, '', skip);
  if (!files.length && !deleted.length) {
    core.setOutput('kept', 'false');
    return;
  }
  const dir = path.join(root, scratch, 'scratch', 'unlanded');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const to = path.join(dir, 'files', f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(path.join(root, f), to, { verbatimSymlinks: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  if (deleted.length) fs.writeFileSync(path.join(dir, 'deleted.txt'), `${deleted.sort().join('\n')}\n`);
  const head = (await git(exec, root, ['rev-parse', 'HEAD'])).trim();
  fs.writeFileSync(path.join(dir, 'changes.patch'), await git(exec, root, ['diff', '--binary', 'HEAD']));
  const conflicts = JSON.parse(env.CONFLICTS || '[]');
  const lines = [
    '# Unlanded',
    '',
    `The turn of ${env.RUN_URL || 'an earlier run'} did not land: its changes are here, not on the branch.`,
    ...(conflicts.length ? ['', `The branch moved while it ran and changed ${conflicts.map((p) => `\`${p}\``).join(', ')} too.`] : []),
    '',
    '- `files/`: each changed or new file as that turn left it, at its path.',
    ...(deleted.length ? ['- `deleted.txt`: the paths it deleted.'] : []),
    `- \`changes.patch\`: its changes to tracked files, against \`${head}\`.`,
    '',
    'Bring back what still holds, on top of the branch as it is now; then delete this folder.',
    '',
  ];
  fs.writeFileSync(path.join(dir, 'README.md'), lines.join('\n'));
  core.setOutput('kept', 'true');
  core.warning(`not landed, kept in ${path.relative(root, dir)}: ${[...files, ...deleted].sort().join(', ')}`);
}

module.exports = { message, note, ready, unlanded, DONE };
