// A submodule's own changes, committed inside it and pushed with git, for a repository with
// no commit API (a GitHub wiki). Its pointer is left for the commit that follows, which moves
// it through the API beside the files. The commit is the App's bot's, on the submodule's
// branch, rebased onto the remote head first: another run or a browser edit may have moved it
// past the pin, and a file both changed takes this commit's version. A push refused because
// the head moved again meanwhile is fetched, rebased and pushed again, up to TRIES in all
// (spec 2026-11-12 R-L10); any other failure, or the last refusal, is the caller's to keep.

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
// a push the remote refused only because its branch is ahead: worth a rebase and another go
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

// commits and pushes each submodule with changes inside it; returns those it pushed
async function push({ github, core, exec, root, subs, message, author, auth, wait = sleep }) {
  const pushed = [];
  for (const sub of subs) {
    const cwd = path.join(root, sub);
    if (!fs.existsSync(path.join(cwd, '.git'))) continue;
    if (!(await git(exec, cwd, ['status', '--porcelain'])).trim()) continue;
    if (!author) throw new Error(`${sub} changed inside: give author (the App's slug) to commit it`);
    const env = { ...process.env, ...auth, ...(await identity(github, author)) };
    const branch = branchOf(root, sub);
    await git(exec, cwd, ['checkout', '-B', branch], { env });
    await git(exec, cwd, ['add', '-A'], { env });
    await git(exec, cwd, ['commit', '-m', message], { env });
    for (let attempt = 1; ; attempt++) {
      await git(exec, cwd, ['fetch', '--no-tags', 'origin', branch], { env });
      await git(exec, cwd, ['rebase', '-X', 'theirs', 'FETCH_HEAD'], { env });
      const { exitCode, stderr = '' } = await exec.getExecOutput('git', ['-C', cwd, 'push', 'origin', `HEAD:refs/heads/${branch}`], { silent: true, ignoreReturnCode: true, env });
      if (!exitCode) break;
      const why = stderr.trim();
      if (!BEHIND.test(why) || attempt >= TRIES) throw new Error(`${sub}: the push to ${branch} failed${attempt > 1 ? ` after ${attempt} tries` : ''}: ${why || `exit ${exitCode}`}`);
      core.info(`${sub}: ${branch} moved during the push (try ${attempt} of ${TRIES}); rebasing again`);
      await wait(jitter());
    }
    core.info(`${sub}: pushed to ${branch}`);
    pushed.push(sub);
  }
  return pushed;
}

module.exports = { push, branchOf };
