// A submodule's own changes, committed inside it and pushed with git, for a repository with
// no commit API (a GitHub wiki). Its pointer is left for the commit that follows, which moves
// it through the API beside the files. The commit is the App's bot's, on a branch of the
// submodule named after the branch being committed to (`issue-137` for `issue-137`), never on
// the wiki's master: master is the public wiki, and main's wiki.yml alone publishes to it, so
// a branch's pages and design files reach it only by merging. Several branches pushing to
// master published unmerged pages and rewrote each other's generated ones (selenium-flow
// #140/#141, 2026-11-13). Only a commit to the repository's default branch goes to the
// branch .gitmodules names (else master), as before. When that branch has a remote head
// already in the commit's history the push is a fast-forward; else the head is merged in (no
// -X: history and merge commits are kept, and nothing silently picks a side). A rebase -X
// theirs here once linearised a merge commit away and dropped a sentence issue-16 had
// (quick-mcp, 2026-11-25). A passage both changed fails it, the merge aborted and nothing
// pushed. A branch with no wiki branch yet starts one from the pin, or, given `startOf`, from
// the commit it names: a sub-issue's wiki branch starts where its family's branch points the
// wiki, this commit alone cherry-picked onto it (nothing to do when the pin already holds
// it), so it has the family's earlier specs (quick-mcp #31: issue-28's started at master,
// without issue-16's pin). A wiki branch that exists is never moved. A push refused because
// the head moved again meanwhile is fetched, merged and pushed again, up to TRIES in all
// (spec 2026-11-12 R-L10); any other failure, or the last refusal, is the caller's to keep:
// the commit is undone, the changes left uncommitted on the pin for keep_to.

const fs = require('fs');
const path = require('path');

async function git(exec, cwd, args, options = {}) {
  const { stdout } = await exec.getExecOutput('git', ['-C', cwd, ...args], { silent: true, ...options });
  return stdout;
}

// the branch .gitmodules names for it, else the wiki's
function branchOf(root, sub) {
  const file = path.join(root, '.gitmodules');
  if (!fs.existsSync(file)) return 'master';
  let inside = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const header = /^\s*\[submodule\s+"[^"]*"\]\s*$/.test(line);
    if (header) inside = false;
    const p = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (p) inside = p[1] === sub;
    const b = /^\s*branch\s*=\s*(.+?)\s*$/.exec(line);
    if (inside && b) return b[1];
  }
  return 'master';
}

const TRIES = 3;
// what git says when the remote has no such branch
const MISSING = /couldn't find remote ref/;
// a push the remote refused only because its branch is ahead: worth a merge and another go
const BEHIND = /\((fetch first|non-fast-forward)\)/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 1 to 3 seconds, so two runs that collided do not collide again
const jitter = () => 1000 + Math.floor(Math.random() * 2000);

// the bot's git identity: `<slug>[bot]` and its noreply address, which needs its user id
async function identity(github, slug) {
  const login = `${slug}[bot]`;
  const { data } = await github.rest.users.getByUsername({ username: login });
  const email = `${data.id}+${login}@users.noreply.github.com`;
  return { GIT_AUTHOR_NAME: login, GIT_COMMITTER_NAME: login, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email };
}

// the submodule branch a commit to `target` goes to: its own name, or .gitmodules' branch for
// the default branch (and when either is unknown)
function wikiBranch(root, sub, target, defaultBranch) {
  return target && defaultBranch && target !== defaultBranch ? target : branchOf(root, sub);
}

// true when FETCH_HEAD is already in HEAD's history
async function holds(exec, cwd, env) {
  const { exitCode, stderr = '' } = await exec.getExecOutput('git', ['-C', cwd, 'merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'], { silent: true, ignoreReturnCode: true, env });
  if (exitCode > 1) throw new Error(`merge-base --is-ancestor FETCH_HEAD HEAD failed: ${stderr.trim() || `exit ${exitCode}`}`);
  return !exitCode;
}

// a merge or cherry-pick (`op`) that stopped: aborted, and an error naming what both changed
// (paths from the top, as `conflicts`), or saying why it failed when nothing conflicted
async function stopped({ exec, cwd, sub, env, op, stderr, why }) {
  const unmerged = (await git(exec, cwd, ['diff', '--name-only', '--diff-filter=U'], { env })).split('\n').filter(Boolean);
  await exec.getExecOutput('git', ['-C', cwd, op, '--abort'], { silent: true, ignoreReturnCode: true, env });
  if (!unmerged.length) return new Error(`${sub}: ${why}: ${op} failed: ${(stderr || '').trim()}`);
  return Object.assign(new Error(`${sub}: ${why} changed ${unmerged.join(', ')} too: nothing was pushed, so neither side is overwritten`), {
    conflicts: unmerged.map((f) => `${sub}/${f}`),
  });
}

// HEAD caught up with the remote head just fetched: nothing when HEAD already holds it (the
// push is a fast-forward), else a merge of it
async function catchUp({ exec, core, cwd, sub, branch, env }) {
  if (await holds(exec, cwd, env)) return;
  const merged = await exec.getExecOutput('git', ['-C', cwd, 'merge', '--no-edit', 'FETCH_HEAD'], { silent: true, ignoreReturnCode: true, env });
  if (merged.exitCode) throw await stopped({ exec, cwd, sub, env, op: 'merge', stderr: merged.stderr, why: branch });
  core.info(`${sub}: merged ${branch}'s remote head`);
}

// a new submodule branch: this commit (`ours`, on the pin) moved onto `from`; nothing to do
// when the pin already holds `from`. Left on the pin when there is no `from` or it cannot be
// fetched
async function startAt({ exec, core, cwd, sub, branch, env, from, ours }) {
  if (!from) return;
  const fetched = await exec.getExecOutput('git', ['-C', cwd, 'fetch', '--no-tags', 'origin', from], { silent: true, ignoreReturnCode: true, env });
  if (fetched.exitCode) {
    core.warning(`${sub}: ${branch} starts from the checkout's pin: ${from} could not be fetched (${(fetched.stderr || '').trim() || `exit ${fetched.exitCode}`})`);
    return;
  }
  if (!(await holds(exec, cwd, env))) {
    await git(exec, cwd, ['checkout', '-q', '-B', branch, 'FETCH_HEAD'], { env });
    const picked = await exec.getExecOutput('git', ['-C', cwd, 'cherry-pick', '--keep-redundant-commits', ours], { silent: true, ignoreReturnCode: true, env });
    if (picked.exitCode) throw await stopped({ exec, cwd, sub, env, op: 'cherry-pick', stderr: picked.stderr, why: `${branch} cannot start from ${from}: it` });
  }
  core.info(`${sub}: ${branch} starts from ${from}`);
}

// the commit undone: HEAD back on the pin, this commit's changes left uncommitted, so the
// caller's keep_to finds them (a commit only in this checkout would be lost with it)
async function undo({ exec, core, cwd, sub, env, pin, ours }) {
  if (!pin || !ours) return;
  for (const args of [['reset', '-q', '--hard', ours], ['reset', '-q', pin]]) {
    const r = await exec.getExecOutput('git', ['-C', cwd, ...args], { silent: true, ignoreReturnCode: true, env });
    if (r.exitCode) {
      core.warning(`${sub}: the commit could not be undone (${(r.stderr || '').trim() || `exit ${r.exitCode}`}): its changes are only in ${ours}`);
      return;
    }
  }
}

// commits and pushes each submodule with changes inside it; returns those it pushed.
// `startOf(sub)`: the commit a submodule branch that does not exist yet starts from, '' for the pin
async function push({ github, core, exec, root, subs, message, author, auth, target, defaultBranch, startOf, wait = sleep }) {
  const pushed = [];
  for (const sub of subs) {
    const cwd = path.join(root, sub);
    if (!fs.existsSync(path.join(cwd, '.git'))) continue;
    if (!(await git(exec, cwd, ['status', '--porcelain'])).trim()) continue;
    if (!author) throw new Error(`${sub} changed inside: give author (the App's slug) to commit it`);
    const env = { ...process.env, ...auth, ...(await identity(github, author)) };
    const branch = wikiBranch(root, sub, target, defaultBranch);
    const pin = (await git(exec, cwd, ['rev-parse', 'HEAD'], { env, ignoreReturnCode: true })).trim();
    await git(exec, cwd, ['checkout', '-B', branch], { env });
    await git(exec, cwd, ['add', '-A'], { env });
    await git(exec, cwd, ['commit', '-m', message], { env });
    const ours = (await git(exec, cwd, ['rev-parse', 'HEAD'], { env, ignoreReturnCode: true })).trim();
    try {
      for (let attempt = 1; ; attempt++) {
        // a branch's first wiki commit has no remote branch to catch up with: it starts at the pin
        const fetched = await exec.getExecOutput('git', ['-C', cwd, 'fetch', '--no-tags', 'origin', branch], { silent: true, ignoreReturnCode: true, env });
        if (!fetched.exitCode) await catchUp({ exec, core, cwd, sub, branch, env });
        // only a branch the remote has not got starts anywhere; a fetch that failed otherwise
        // (the network, say) leaves the commit on the pin, and a push onto a branch that exists fails
        else if (attempt === 1 && startOf && MISSING.test(fetched.stderr || '')) await startAt({ exec, core, cwd, sub, branch, env, from: await startOf(sub), ours });
        const { exitCode, stderr = '' } = await exec.getExecOutput('git', ['-C', cwd, 'push', 'origin', `HEAD:refs/heads/${branch}`], { silent: true, ignoreReturnCode: true, env });
        if (!exitCode) break;
        const why = stderr.trim();
        if (!BEHIND.test(why) || attempt >= TRIES) throw new Error(`${sub}: the push to ${branch} failed${attempt > 1 ? ` after ${attempt} tries` : ''}: ${why || `exit ${exitCode}`}`);
        core.info(`${sub}: ${branch} moved during the push (try ${attempt} of ${TRIES}); merging again`);
        await wait(jitter());
      }
    } catch (e) {
      await undo({ exec, core, cwd, sub, env, pin, ours });
      throw e;
    }
    core.info(`${sub}: pushed to ${branch}`);
    pushed.push(sub);
  }
  return pushed;
}

module.exports = { push, branchOf, wikiBranch };
