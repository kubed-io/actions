// git/commit: commits the checkout's changes to a branch through the API, so GitHub signs
// the commit: createCommitOnBranch for files, or the Git Data API when a submodule's pointer
// moves too, which createCommitOnBranch cannot write. Afterwards HEAD and the index are the
// new commit; the working tree is untouched, so changes it did not select stay changed.
//
// It never overwrites: the commit goes on the branch's head as it is now, so when the branch
// moved since the commit the checkout is at, and a path the commit writes changed there in
// between, nothing is committed and the step fails naming the paths.

const fs = require('fs');
const path = require('path');
const { lines, gql, headOid, compareFiles, matcher } = require('./util');

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const SUBMODULE_HINT = 'a submodule moves only to a commit made inside it: commit inside the submodule first';

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

// `ls-files -s` (`<mode> <sha> <stage>\t<path>`) or `ls-tree` (`<mode> commit <sha>\t<path>`)
// records, NUL-terminated: each gitlink's path and the commit it points at
function gitlinks(out) {
  const links = new Map();
  for (const r of out.split('\0').filter(Boolean)) {
    if (!r.startsWith('160000 ')) continue;
    const meta = r.slice(0, r.indexOf('\t')).split(' ');
    links.set(r.slice(r.indexOf('\t') + 1), meta[1] === 'commit' ? meta[2] : meta[1]);
  }
  return links;
}

// the commit a submodule is checked out at, '' when it is not checked out
async function checkedOut(exec, root, file) {
  const out = await git(exec, ['-C', path.join(root, file), 'rev-parse', 'HEAD'], { ignoreReturnCode: true });
  return out.trim();
}

function refuse(file) {
  throw new Error(`${file} is a submodule or inside one: ${SUBMODULE_HINT}`);
}

// A submodule whose checkout is at a new commit moves its pointer: that is a `link`. Any
// other submodule change (edits inside it, an unmoved pointer, a deleted gitlink) cannot
// be committed from here: asked for by `files`, that fails; swept up by "every change", it
// is left out with a warning.
async function checkSubmodules({ exec, core, root, patterns, paths }) {
  const subs = submodulePaths(root);
  const inside = (p) => subs.some((s) => p.startsWith(`${s}/`));
  const explicit = patterns.length > 0;
  const skipped = [];
  const drop = (p) => (explicit ? refuse(p) : skipped.push(p));
  // a pattern reaching into a submodule can never match: say so rather than commit nothing
  for (const p of patterns) {
    const literal = p.replace(/^\.\//, '').split(/[*?]/)[0];
    if (subs.some((s) => literal.startsWith(`${s}/`))) refuse(p);
  }
  let kept = [];
  const links = [];
  for (const p of paths) {
    if (inside(p) || p.endsWith('/')) drop(p);
    else kept.push(p);
  }
  if (kept.length) {
    // literal: a path with `*` in its name is not a pathspec glob
    const index = gitlinks(await git(exec, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...kept]));
    const head = gitlinks(await git(exec, ['--literal-pathspecs', 'ls-tree', '-z', 'HEAD', '--', ...kept], { ignoreReturnCode: true }));
    const linked = new Set([...index.keys(), ...head.keys()]);
    for (const p of linked) {
      // where `git add` would point it: the submodule's checkout, or a pointer already staged
      const sha = index.has(p) ? (await checkedOut(exec, root, p)) || index.get(p) : '';
      if (sha && sha !== head.get(p)) links.push({ path: p, sha });
      else if (explicit && index.has(p)) throw new Error(`${p} has no new commit to point at: commit inside the submodule first`);
      else drop(p);
    }
    kept = kept.filter((p) => !linked.has(p));
  }
  if (skipped.length) core.warning(`left out, as submodule changes (${SUBMODULE_HINT}): ${skipped.join(', ')}`);
  return { kept, links };
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
      // git keeps only the executable bit
      const mode = stat.mode & 0o111 ? '100755' : '100644';
      additions.push({ path: file, contents: fs.readFileSync(full).toString('base64'), mode });
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

// A check run on the head each try will commit on: from the checkout's commit (`local`) to
// that head, the paths changed there must not be any the commit writes, or it would write
// over them. A rename there counts as its old path and its new.
function guard({ github, core, owner, repo, branch, local, paths }) {
  return async (head) => {
    if (!local || head === local) return;
    let files;
    try {
      files = await compareFiles(github, owner, repo, `${local}...${head}`);
    } catch (e) {
      if (e.status !== 404) throw e;
      throw new Error(`the checkout's commit ${local} is not on GitHub, so what moved on ${branch} since cannot be told; nothing was committed`);
    }
    const changed = new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
    const both = paths.filter((p) => changed.has(p)).sort();
    if (!both.length) return;
    core.setOutput('conflicts', JSON.stringify(both));
    throw new Error(`the branch ${branch} moved from ${local} to ${head} since the checkout and changed ${both.join(', ')} too: nothing was committed, so neither side is overwritten`);
  };
}

// one try, then one more on the branch's new head
async function commitOnBranch({ github, core, owner, repo, branch, message, fileChanges: changes, check }) {
  const [headline, ...rest] = message.split('\n');
  const body = rest.join('\n').trim();
  for (let attempt = 1; ; attempt += 1) {
    const expectedHeadOid = await headOid(github, owner, repo, branch);
    if (!expectedHeadOid) throw new Error(`branch ${branch} does not exist; git/branch makes it`);
    await check(expectedHeadOid);
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

// Files and moved submodules in one commit, through the Git Data API: blobs, a tree on the
// branch head's, a commit with no author or committer (GitHub signs it as the token's App),
// and the branch moved only by a fast forward. One try, then one more on the new head.
async function commitTree({ github, core, owner, repo, branch, message, additions, deletions, links, check }) {
  // the blobs once, after the first check passes: a refused commit uploads nothing
  let entries = null;
  const build = async () => {
    const blobs = [];
    for (const a of additions) {
      const { data } = await github.rest.git.createBlob({ owner, repo, content: a.contents, encoding: 'base64' });
      blobs.push({ path: a.path, mode: a.mode, type: 'blob', sha: data.sha });
    }
    return [
      ...blobs,
      ...deletions.map((d) => ({ path: d.path, mode: '100644', type: 'blob', sha: null })),
      ...links.map((l) => ({ path: l.path, mode: '160000', type: 'commit', sha: l.sha })),
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  };
  for (let attempt = 1; ; attempt += 1) {
    const head = await headOid(github, owner, repo, branch);
    if (!head) throw new Error(`branch ${branch} does not exist; git/branch makes it`);
    await check(head);
    entries = entries || await build();
    try {
      const { data: parent } = await github.rest.git.getCommit({ owner, repo, commit_sha: head });
      const { data: tree } = await github.rest.git.createTree({ owner, repo, base_tree: parent.tree.sha, tree: entries });
      const { data: made } = await github.rest.git.createCommit({ owner, repo, message, tree: tree.sha, parents: [head] });
      await github.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: made.sha, force: false });
      return { oid: made.sha, url: made.html_url };
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
  let { kept: paths, links } = await checkSubmodules({ exec, core, root, patterns, paths: selected(changes, patterns, root) });

  // `ignore` leaves changes out on purpose (workflow files a token cannot write, say),
  // and says so, so the caller can tell whoever made them
  const skip = matcher(lines(env.IGNORE));
  const ignored = env.IGNORE ? [...paths, ...links.map((l) => l.path)].filter(skip).sort() : [];
  if (ignored.length) {
    paths = paths.filter((p) => !skip(p));
    links = links.filter((l) => !skip(l.path));
    core.warning(`left out by ignore: ${ignored.join(', ')}`);
  }
  core.setOutput('ignored', JSON.stringify(ignored));

  if (!paths.length && !links.length && !allowEmpty) {
    core.notice('nothing to commit');
    core.setOutput('sha', '');
    core.setOutput('url', '');
    core.setOutput('files', '[]');
    core.setOutput('committed', 'false');
    return;
  }

  const { additions, deletions } = fileChanges(root, paths);
  // the commit the checkout is at, which a hook may have moved forward during the turn
  const local = (await git(exec, ['rev-parse', 'HEAD'], { ignoreReturnCode: true })).trim();
  const check = guard({ github, core, owner, repo, branch, local, paths: [...paths, ...links.map((l) => l.path)] });
  let commit;
  if (links.length) {
    commit = await commitTree({ github, core, owner, repo, branch, message, additions, deletions, links, check });
  } else {
    // an empty commit still sends additions: GitHub refuses a commit with no fileChanges
    const plain = additions.map(({ path: p, contents }) => ({ path: p, contents }));
    const changesInput = deletions.length ? { additions: plain, deletions } : { additions: plain };
    commit = await commitOnBranch({ github, core, owner, repo, branch, message, fileChanges: changesInput, check });
  }

  // HEAD and index to the new commit; the working tree keeps what was not selected. The
  // fetch authenticates with this step's token through git's env config, never on the
  // command line, so a checkout without persisted credentials can fetch too.
  await exec.exec('git', ['fetch', '--no-tags', 'origin', branch], { env: { ...process.env, ...authEnv(core, process.env.TOKEN, process.env.GITHUB_SERVER_URL) } });
  await exec.exec('git', ['reset', '--mixed', 'FETCH_HEAD']);

  core.setOutput('sha', commit.oid);
  core.setOutput('url', commit.url);
  core.setOutput('files', JSON.stringify([...paths, ...links.map((l) => l.path)].sort()));
  core.setOutput('committed', 'true');
}

module.exports = { authEnv, run, parseStatus };
