// git/commit: commits the checkout's changes to a branch through createCommitOnBranch, so
// GitHub signs the commit. Afterwards HEAD and the index are the new commit; the working
// tree is untouched, so changes it did not select stay changed.

const fs = require('fs');
const path = require('path');
const { lines, gql, headOid, matcher } = require('./util');

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const SUBMODULE_HINT = 'the commit API cannot move a submodule pointer; commit it with git in its own step';

async function git(exec, args, options = {}) {
  const { stdout } = await exec.getExecOutput('git', args, { silent: true, ...options });
  return stdout;
}

// `git status --porcelain=v1 -z`: `XY path`, and for a rename or copy the old path as the
// next field. Every path is relative to the top of the repository.
function parseStatus(out) {
  const fields = out.split('\0');
  const changes = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const xy = field.slice(0, 2);
    const file = field.slice(3);
    if (xy === '!!') continue;
    if (UNMERGED.has(xy)) throw new Error(`${file} has an unresolved merge conflict`);
    const change = { xy, path: file };
    if (xy[0] === 'R' || xy[0] === 'C') {
      i += 1;
      change.from = fields[i];
    }
    changes.push(change);
  }
  return changes;
}

async function currentBranch(exec) {
  const name = (await git(exec, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (name && name !== 'HEAD') return name;
  const fallback = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  if (!fallback) throw new Error('the checkout is on no branch; set branch');
  return fallback;
}

function submodulePaths(root) {
  const file = path.join(root, '.gitmodules');
  if (!fs.existsSync(file)) return [];
  return [...fs.readFileSync(file, 'utf8').matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => m[1]);
}

// `<mode> ...\t<path>` records, NUL-terminated: the paths whose mode is a gitlink
function gitlinks(out) {
  return out.split('\0').filter(Boolean).filter((r) => r.startsWith('160000 ')).map((r) => r.slice(r.indexOf('\t') + 1));
}

function refuse(file) {
  throw new Error(`${file} is a submodule or inside one: ${SUBMODULE_HINT}`);
}

// A submodule's change cannot go through the API. Asked for by `files`, that fails; swept
// up by "every change", it is left out with a warning, for the step that commits it.
async function checkSubmodules({ exec, core, root, patterns, paths }) {
  const subs = submodulePaths(root);
  const inside = (p) => subs.some((s) => p === s || p.startsWith(`${s}/`));
  const explicit = patterns.length > 0;
  const skipped = [];
  const drop = (p) => (explicit ? refuse(p) : skipped.push(p));
  // a pattern reaching into a submodule can never match: say so rather than commit nothing
  for (const p of patterns) {
    const literal = p.replace(/^\.\//, '').split(/[*?]/)[0];
    if (subs.some((s) => literal.startsWith(`${s}/`))) refuse(p);
  }
  let kept = [];
  for (const p of paths) {
    if (inside(p) || p.endsWith('/')) drop(p);
    else kept.push(p);
  }
  if (kept.length) {
    // literal: a path with `*` in its name is not a pathspec glob
    const index = await git(exec, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...kept]);
    const head = await git(exec, ['--literal-pathspecs', 'ls-tree', '-z', 'HEAD', '--', ...kept], { ignoreReturnCode: true });
    const linked = new Set([...gitlinks(index), ...gitlinks(head)]);
    for (const p of linked) drop(p);
    kept = kept.filter((p) => !linked.has(p));
  }
  if (skipped.length) core.warning(`left out, as submodule changes (${SUBMODULE_HINT}): ${skipped.join(', ')}`);
  return kept;
}

// a path the working tree still has is an addition, one it lost a deletion
function fileChanges(root, changes) {
  const additions = [];
  const deletions = [];
  for (const file of changes) {
    const full = path.join(root, file);
    let stat = null;
    try { stat = fs.lstatSync(full); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!stat) {
      deletions.push({ path: file });
    } else if (stat.isDirectory()) {
      refuse(file);
    } else if (stat.isSymbolicLink()) {
      throw new Error(`${file} is a symlink: the commit API writes only regular files`);
    } else {
      additions.push({ path: file, contents: fs.readFileSync(full).toString('base64') });
    }
  }
  return { additions, deletions };
}

// the paths the commit touches: every change, a rename as its old path and its new
function selected(changes, patterns, root) {
  const match = patterns.length ? matcher(patterns) : () => true;
  const paths = new Set();
  for (const c of changes) {
    // a new path deleted again before commit was never on the branch
    const gone = 'ARC'.includes(c.xy[0]) && c.xy[1] === 'D';
    if (!gone && match(c.path)) paths.add(c.path);
    // a copy keeps its source; a rename's source goes unless it is back in the tree
    if (c.from && c.xy[0] === 'R' && match(c.from) && !fs.existsSync(path.join(root, c.from))) paths.add(c.from);
  }
  return [...paths].sort();
}

// one try, then one more on the branch's new head
async function commitOnBranch({ github, core, owner, repo, branch, message, fileChanges: changes }) {
  const [headline, ...rest] = message.split('\n');
  const body = rest.join('\n').trim();
  for (let attempt = 1; ; attempt += 1) {
    const expectedHeadOid = await headOid(github, owner, repo, branch);
    if (!expectedHeadOid) throw new Error(`branch ${branch} does not exist; git/branch makes it`);
    try {
      const input = {
        branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
        message: body ? { headline, body } : { headline },
        fileChanges: changes,
        expectedHeadOid,
      };
      const out = await github.graphql(gql('commit-on-branch'), { input });
      return out.createCommitOnBranch.commit;
    } catch (e) {
      if (attempt >= 2) throw e;
      core.warning(`the commit failed once (${e.message}); retrying on the new head`);
    }
  }
}

// git reads config from GIT_CONFIG_COUNT/KEY_n/VALUE_n: an auth header that never shows
// in a logged command line, and is masked if anything prints it
function authEnv(core, token, server = 'https://github.com') {
  if (!token) return {};
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  core.setSecret(header);
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${server}/.extraheader`, GIT_CONFIG_VALUE_0: header };
}

async function run({ github, context, core, exec }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const message = (env.MESSAGE || '').trim();
  if (!message) throw new Error('message is required');
  const patterns = lines(env.FILES);
  const allowEmpty = env.ALLOW_EMPTY === 'true';
  const branch = env.BRANCH || await currentBranch(exec);
  const root = (await git(exec, ['rev-parse', '--show-toplevel'])).trim() || env.GITHUB_WORKSPACE || process.cwd();

  const changes = parseStatus(await git(exec, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const paths = await checkSubmodules({ exec, core, root, patterns, paths: selected(changes, patterns, root) });

  if (!paths.length && !allowEmpty) {
    core.notice('nothing to commit');
    core.setOutput('sha', '');
    core.setOutput('url', '');
    core.setOutput('files', '[]');
    core.setOutput('committed', 'false');
    return;
  }

  const { additions, deletions } = fileChanges(root, paths);
  // an empty commit still sends additions: GitHub refuses a commit with no fileChanges
  const changesInput = deletions.length ? { additions, deletions } : { additions };
  const commit = await commitOnBranch({ github, core, owner, repo, branch, message, fileChanges: changesInput });

  // HEAD and index to the new commit; the working tree keeps what was not selected. The
  // fetch authenticates with this step's token through git's env config, never on the
  // command line, so a checkout without persisted credentials can fetch too.
  await exec.exec('git', ['fetch', '--no-tags', 'origin', branch], { env: { ...process.env, ...authEnv(core, process.env.TOKEN, process.env.GITHUB_SERVER_URL) } });
  await exec.exec('git', ['reset', '--mixed', 'FETCH_HEAD']);

  core.setOutput('sha', commit.oid);
  core.setOutput('url', commit.url);
  core.setOutput('files', JSON.stringify(paths));
  core.setOutput('committed', 'true');
}

module.exports = { authEnv, run, parseStatus };
