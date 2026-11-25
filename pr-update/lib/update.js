// Brings every open PR on a base up to date after a merge into it (cluster spec 2026-11-12,
// R-L9). GitHub's update-branch first; when it refuses (a conflict, or the head moved), the
// base is merged in a checkout and the two conflicts every agent PR has are resolved: a
// submodule pointer (the docs wiki) moves to its remote's head when that head holds both
// sides, else to a merge of the two pushed to the PR's own wiki branch (a passage both changed
// in conflict markers, for the agent), and the changelog's
// conflict hunks keep the base's lines, then the PR's. Any other
// conflict is the PR's agent's, and an agent's PR (head `prefix*`) is handed to it as the
// `agent-code` dispatch (reason `conflict`), naming the paths. The merge commit is made
// through the API as the App, so GitHub signs it, and the branch moves to it, never forced:
// a branch that moved under it is retried by the next merge. A base that changed a workflow
// file, which the App may not write, is a person's merge, and an agent's PR is told so once.

const fs = require('fs');
const path = require('path');

const IDENTITY = ['-c', 'user.name=pr-update', '-c', 'user.email=pr-update@users.noreply.github.com'];

async function git(exec, root, args, { env, ok = false } = {}) {
  const r = await exec.getExecOutput('git', ['-C', root, ...args], { silent: true, ignoreReturnCode: true, env });
  if (r.exitCode && !ok) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || '').trim() || `exit ${r.exitCode}`}`);
  return { code: r.exitCode, out: r.stdout || '', err: r.stderr || '' };
}

// git reads config from GIT_CONFIG_COUNT/KEY_n/VALUE_n: an auth header that never shows in
// a logged command line. The empty value first drops a header the checkout persisted, so
// only this token's is sent.
function authEnv(core, token, server = 'https://github.com') {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  core.setSecret(header);
  const key = `http.${server}/.extraheader`;
  return { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: key, GIT_CONFIG_VALUE_1: header };
}

// `git ls-files -u -z`: each conflicted path and its stages (1 the merge base, 2 ours, 3 theirs)
function unmerged(out) {
  const paths = new Map();
  for (const rec of out.split('\0').filter(Boolean)) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(rec);
    if (!m) continue;
    const [, mode, sha, stage, p] = m;
    if (!paths.has(p)) paths.set(p, {});
    paths.get(p)[stage] = { mode, sha };
  }
  return [...paths].map(([p, stages]) => ({ path: p, stages }));
}

const isLink = (s) => s[2]?.mode === '160000' && s[3]?.mode === '160000';
const isText = (s) => [s[2], s[3]].every((x) => x && /^1006[0-9]{2}$/.test(x.mode));

// each conflict hunk as theirs (the base's lines), then ours (the PR's) but for lines the
// base's already has; outside the hunks nothing changes. A diff3 hunk's merge-base section
// goes. Null when there is no hunk or one is cut off.
function unionHunks(text) {
  const out = [];
  let state = null;
  let ours = [];
  let theirs = [];
  let hunks = 0;
  for (const line of text.split('\n')) {
    if (state === null) {
      if (/^<{7}(?: |$)/.test(line)) {
        state = 'ours';
        ours = [];
        theirs = [];
      } else {
        out.push(line);
      }
    } else if (state === 'ours' && /^\|{7}(?: |$)/.test(line)) {
      state = 'base';
    } else if (state !== 'theirs' && /^={7}$/.test(line)) {
      state = 'theirs';
    } else if (state === 'theirs' && /^>{7}(?: |$)/.test(line)) {
      const seen = new Set(theirs.filter((l) => l.trim()));
      out.push(...theirs, ...ours.filter((l) => !seen.has(l)));
      state = null;
      hunks += 1;
    } else if (state === 'ours') {
      ours.push(line);
    } else if (state === 'theirs') {
      theirs.push(line);
    }
  }
  return state === null && hunks ? out.join('\n') : null;
}

// a submodule's url and branch from .gitmodules, by its path
async function submoduleOf(exec, root, sub) {
  const file = path.join(root, '.gitmodules');
  const { out } = await git(exec, root, ['config', '-f', file, '--get-regexp', '^submodule\\..*\\.path$'], { ok: true });
  const line = out.split('\n').find((l) => l.slice(l.indexOf(' ') + 1).trim() === sub);
  if (!line) return null;
  const name = line.slice('submodule.'.length, line.indexOf(' ') - '.path'.length);
  const url = (await git(exec, root, ['config', '-f', file, '--get', `submodule.${name}.url`], { ok: true })).out.trim();
  const branch = (await git(exec, root, ['config', '-f', file, '--get', `submodule.${name}.branch`], { ok: true })).out.trim();
  return url ? { url, branch } : null;
}

// the submodule remote's head, fetched into this repository so ancestry can be asked here;
// once a run per remote
async function remoteHead({ exec, root, env, sub, heads }) {
  const mod = await submoduleOf(exec, root, sub);
  if (!mod) return null;
  const key = `${mod.url} ${mod.branch}`;
  if (!heads.has(key)) {
    const fetched = await git(exec, root, ['fetch', '--no-tags', '--quiet', mod.url, mod.branch || 'HEAD'], { env, ok: true });
    heads.set(key, fetched.code ? null : (await git(exec, root, ['rev-parse', 'FETCH_HEAD'], { env })).out.trim());
  }
  return heads.get(key);
}

// a pointer both sides moved: to the remote's head when it holds both (via 'head'), else to a
// merge of the two made on the PR's own wiki branch (via 'merge', wikiMerge, with the files it
// left conflicted), else left conflicted (null)
async function resolveLink({ exec, root, env, conflict, heads, branch, base }) {
  const head = await remoteHead({ exec, root, env, sub: conflict.path, heads });
  let holds = Boolean(head);
  for (const side of holds ? [conflict.stages[2].sha, conflict.stages[3].sha] : []) {
    const { code } = await git(exec, root, ['merge-base', '--is-ancestor', side, head], { env, ok: true });
    if (code) holds = false;
  }
  const merged = holds ? null : await wikiMerge({ exec, root, env, conflict, branch, base });
  const to = holds ? head : merged?.commit;
  if (!to) return null;
  await git(exec, root, ['update-index', '--cacheinfo', `160000,${to},${conflict.path}`], { env });
  return holds ? { via: 'head' } : { via: 'merge', ...merged };
}

// `git merge-tree --write-tree --name-only -z`: the tree, the conflicted files, and whether
// every conflict is a passage both changed (`CONFLICT (contents)`), which leaves markers in
// the file; one deleted on a side, a binary, a rename does not
function mergeTreeOf(out) {
  const recs = out.split('\0');
  const tree = (recs[0] || '').trim();
  let i = 1;
  const files = [];
  while (i < recs.length && recs[i] !== '') files.push(recs[i++]);
  let text = true;
  for (i += 1; i < recs.length;) {
    const count = Number(recs[i]);
    if (!Number.isInteger(count) || recs[i] === '') break;
    const type = recs[i + 1 + count];
    if (type !== 'Auto-merging' && type !== 'CONFLICT (contents)') text = false;
    i += count + 3;
  }
  return { tree, files, text };
}

// The two sides' wiki commits merged onto the PR's own wiki branch: git/commit puts a branch's
// wiki commits there, never on the wiki's master (the public wiki, which only main's wiki.yml
// publishes), so master no longer holds both sides. Changes to different passages merge as
// git would. A passage both changed keeps both, in conflict markers labelled with the two
// wiki branches, for the PR's agent to settle (quick-mcp #41: `-X ours` dropped the base's
// side); such a merge is pushed only once the code merge is known to complete (pushWiki). A
// generated page both sides changed may be stale, which the PR's checks say. Any other kind of
// conflict leaves the pointer conflicted, for the agent. The commit's dates are its parents',
// so a retry makes the same commit. `{ commit, url, conflicts }`, or null.
async function wikiMerge({ exec, root, env, conflict, branch, base }) {
  const mod = await submoduleOf(exec, root, conflict.path);
  if (!mod || !branch) return null;
  const ours = conflict.stages[2].sha;
  const theirs = conflict.stages[3].sha;
  if ((await git(exec, root, ['fetch', '--no-tags', '--quiet', mod.url, ours, theirs], { env, ok: true })).code) return null;
  // the two sides as refs, so the markers name them
  const labels = [[`refs/wiki/${branch}`, ours], [`refs/wiki/${base}`, theirs]];
  let named = true;
  for (const [ref, sha] of labels) if ((await git(exec, root, ['update-ref', ref, sha], { env, ok: true })).code) named = false;
  const sides = named ? labels.map(([ref]) => ref.slice('refs/'.length)) : [ours, theirs];
  const tree = await git(exec, root, ['-c', 'merge.conflictStyle=merge', 'merge-tree', '--write-tree', '--name-only', '-z', ...sides], { env, ok: true });
  for (const [ref] of labels) await git(exec, root, ['update-ref', '-d', ref], { env, ok: true });
  const got = mergeTreeOf(tree.out);
  const conflicts = tree.code === 1 && got.files.length && got.text ? got.files : [];
  if ((tree.code && !conflicts.length) || !got.tree) return null;
  const dates = (await git(exec, root, ['show', '-s', '--format=%ct', ours, theirs], { env, ok: true })).out.split('\n').map(Number).filter(Boolean);
  const when = dates.length ? { GIT_AUTHOR_DATE: `@${Math.max(...dates)} +0000`, GIT_COMMITTER_DATE: `@${Math.max(...dates)} +0000` } : {};
  const message = `Merge the base's wiki into ${branch}${conflicts.length ? `\n\nConflicts for its agent: ${conflicts.join(', ')}` : ''}`;
  const made = await git(exec, root, [...IDENTITY, 'commit-tree', got.tree, '-p', ours, '-p', theirs, '-m', message], { env: { ...env, ...when }, ok: true });
  const commit = made.out.trim();
  if (made.code || !commit) return null;
  const merged = { commit, url: mod.url, conflicts };
  if (!conflicts.length && !(await pushWiki({ exec, root, env, merged, branch }))) return null;
  return merged;
}

// to the PR's own wiki branch, never forced: false when it moved meanwhile
async function pushWiki({ exec, root, env, merged, branch }) {
  return !(await git(exec, root, ['push', '--quiet', merged.url, `${merged.commit}:refs/heads/${branch}`], { env, ok: true })).code;
}

async function resolveChangelog({ exec, root, env, conflict }) {
  const file = path.join(root, conflict.path);
  if (!fs.existsSync(file)) return false;
  const merged = unionHunks(fs.readFileSync(file, 'utf8'));
  if (merged === null) return false;
  fs.writeFileSync(file, merged);
  await git(exec, root, ['add', '--', conflict.path], { env });
  return true;
}

// `git diff-tree -r -z` between two trees: each changed path, its new mode and object
// (null when it went), and the mode it had
function changes(out) {
  const parts = out.split('\0');
  const rows = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) \S+ (\S+) ([A-Z])/.exec(parts[i]);
    if (m) rows.push({ path: parts[i + 1], was: m[1], mode: m[2], sha: m[4] === 'D' ? null : m[3] });
  }
  return rows;
}

// The merge in the index, as a commit GitHub signs. One pushed from here would carry no
// signature, and a ruleset that wants every change attributed then holds the PR for an
// extra approval (seen 2026-11-13 on selenium-flow#120). So the tree is rebuilt there on
// the head's: a blob the base has is on GitHub already, any other (a changelog union, a
// clean three-way merge) is sent; a pointer is just its commit. The branch then moves to
// the commit, never forced. 'moved' when it moved meanwhile.
async function signedMerge({ github, exec, root, env, owner, repo, base, branch, head, message }) {
  const tree = (await git(exec, root, ['write-tree'], { env })).out.trim();
  const headTree = (await git(exec, root, ['rev-parse', `${head}^{tree}`], { env })).out.trim();
  const baseSha = (await git(exec, root, ['rev-parse', `refs/remotes/origin/${base}`], { env })).out.trim();
  const entries = [];
  for (const c of changes((await git(exec, root, ['diff-tree', '-r', '-z', '--no-renames', headTree, tree], { env })).out)) {
    const mode = c.sha === null ? c.was : c.mode;
    const type = mode === '160000' ? 'commit' : 'blob';
    let sha = c.sha;
    if (sha && type === 'blob') {
      const onBase = (await git(exec, root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}:${c.path}`], { env, ok: true })).out.trim();
      if (onBase !== sha) {
        const file = path.join(root, c.path);
        const body = mode === '120000' ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
        ({ data: { sha } } = await github.rest.git.createBlob({ owner, repo, content: body.toString('base64'), encoding: 'base64' }));
      }
    }
    entries.push({ path: c.path, mode, type, sha });
  }
  if (entries.length) {
    const { data: made } = await github.rest.git.createTree({ owner, repo, base_tree: headTree, tree: entries });
    if (made.sha !== tree) throw new Error(`the tree GitHub built (${made.sha}) is not the merge's (${tree})`);
  }
  const { data: commit } = await github.rest.git.createCommit({ owner, repo, message, tree, parents: [head, baseSha] });
  try {
    await github.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha, force: false });
  } catch (e) {
    if (e.status === 422) return 'moved';
    throw e;
  }
  return 'pushed';
}

// the merge commit's message: what was resolved
function messageOf({ base, branch, links, changelog }) {
  const done = [];
  const conflicted = (l) => (l.conflicts?.length ? `, conflicted in ${l.conflicts.map((f) => `${l.path}/${f}`).join(', ')}` : '');
  const at = (l) => (l.via === 'merge' ? `at a merge of both sides' wiki${conflicted(l)}` : 'at the wiki\'s head');
  if (links.length === 1) done.push(`the ${links[0].path} pointer ${at(links[0])}`);
  if (links.length > 1) done.push(`the ${links.map((l) => l.path).join(', ')} pointers ${links.every((l) => l.via === 'head') ? 'at their heads' : 'at their merges'}`);
  if (changelog) done.push(`${changelog}'s entries from both`);
  return `Merge ${base} into ${branch}${done.length ? `: ${done.join('; ')}` : ''}`;
}

// The workflow files the base changed since the PR's head left it, each with its new blob
// ('gone' when removed). The App's token has no `workflows` permission, so neither GitHub's
// update-branch nor a merge made here can bring one in.
const WORKFLOWS = '.github/workflows/';
async function workflowChanges({ github, owner, repo, base, head }) {
  const { data } = await github.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${head}...${base}` });
  return (data.files || [])
    .filter((f) => f.filename?.startsWith(WORKFLOWS) || f.previous_filename?.startsWith(WORKFLOWS))
    .map((f) => ({ path: f.filename, sha: f.status === 'removed' ? 'gone' : f.sha }));
}

// A person merges the base in. An agent's PR is told so once per change, by a comment its
// marker finds again; nothing dispatches or retries it.
async function askPerson({ github, owner, repo, base, prefix, pr, workflows }) {
  const branch = pr.head.ref;
  const paths = workflows.map((w) => w.path).join(', ');
  const result = `needs a person: ${paths}`;
  if (!prefix || !branch.startsWith(prefix)) return result;
  const marker = `<!-- pr-update: workflows ${base} ${workflows.map((w) => `${w.path}@${w.sha}`).join(' ')} -->`;
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 });
  if (comments.some((c) => String(c.body || '').includes(marker))) return `${result} (asked before)`;
  const names = workflows.map((w) => `\`${w.path}\``).join(', ');
  await github.rest.issues.createComment({ owner, repo, issue_number: pr.number,
    body: `${marker}\nA person must merge \`${base}\` into \`${branch}\`: it changed ${names}, which the App may not write, so this PR is not brought up to date, and nothing retries it.` });
  return `${result} (asked)`;
}

// one PR: the result row for the summary
async function updatePr({ github, core, exec, owner, repo, base, root, changelog, prefix, env, heads, state, pr }) {
  const branch = pr.head.ref;
  const row = { number: pr.number, branch };

  // 1. current: the base is already in the head
  const { data: cmp } = await github.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${pr.head.sha}` });
  if (cmp.behind_by === 0) return { ...row, result: 'current' };

  // a workflow the base changed: a person's merge (quick-mcp #32)
  const workflows = await workflowChanges({ github, owner, repo, base, head: pr.head.sha });
  if (workflows.length) return { ...row, result: await askPerson({ github, owner, repo, base, prefix, pr, workflows }) };

  // 2. GitHub's own merge, when it has no conflict and the head is still where it was
  try {
    await github.rest.pulls.updateBranch({ owner, repo, pull_number: pr.number, expected_head_sha: pr.head.sha });
    return { ...row, result: 'updated' };
  } catch (e) {
    if (e.status !== 422) throw e;
    core.info(`#${pr.number}: update-branch refused (${e.message}); merging in the checkout`);
  }

  // 3. the merge here, both branches fetched fresh (the whole history, the first time)
  const unshallow = state.shallow ? ['--unshallow'] : [];
  await git(exec, root, ['fetch', '--no-tags', '--quiet', ...unshallow, 'origin',
    `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { env });
  state.shallow = false;
  const head = (await git(exec, root, ['rev-parse', `refs/remotes/origin/${branch}`], { env })).out.trim();
  await git(exec, root, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', head], { env });
  state.moved = true;
  if (!(await git(exec, root, ['merge-base', '--is-ancestor', `refs/remotes/origin/${base}`, head], { env, ok: true })).code) {
    return { ...row, result: 'current' };
  }
  // git merge wants an identity even with --no-commit; the commit is the API's, so it is
  // never recorded
  const merge = await git(exec, root, [...IDENTITY, '-c', 'merge.conflictStyle=merge', 'merge', '--no-commit', '--no-ff', '--quiet', `refs/remotes/origin/${base}`], { env, ok: true });
  if (merge.code > 1) {
    await git(exec, root, ['merge', '--abort'], { env, ok: true });
    throw new Error(`the merge failed: ${(merge.err || merge.out).trim() || `exit ${merge.code}`}`);
  }

  const links = [];
  let resolvedChangelog = '';
  const left = [];
  for (const conflict of unmerged((await git(exec, root, ['ls-files', '-u', '-z'], { env })).out)) {
    const link = isLink(conflict.stages) ? await resolveLink({ exec, root, env, conflict, heads, branch, base }) : null;
    if (link) links.push({ path: conflict.path, ...link });
    else if (conflict.path === changelog && isText(conflict.stages) && await resolveChangelog({ exec, root, env, conflict })) resolvedChangelog = changelog;
    else left.push(conflict.path);
  }
  // a wiki merge with markers is pushed only when the code merge completes; beside another
  // conflict its pointer is the agent's, as one that would not merge
  const held = links.filter((l) => l.conflicts?.length);
  for (const l of held) {
    if (left.length || !(await pushWiki({ exec, root, env, merged: l, branch }))) left.push(l.path);
  }
  left.sort();
  if (left.length) {
    await git(exec, root, ['merge', '--abort'], { env, ok: true });
    const result = `needs its agent: ${left.join(', ')}`;
    if (!prefix || !branch.startsWith(prefix)) return { ...row, result };
    // the agent's one event interface; its route decides whether that is a turn
    await github.rest.repos.createDispatchEvent({ owner, repo, event_type: 'agent-code',
      client_payload: { pull_request: pr.number, reason: 'conflict', base, paths: left.join(', ') } });
    return { ...row, result: `${result} (dispatched)` };
  }

  const message = messageOf({ base, branch, links, changelog: resolvedChangelog });
  const done = await signedMerge({ github, exec, root, env, owner, repo, base, branch, head, message });
  // never forced: a branch that moved meanwhile keeps its new commits
  if (done === 'moved') return { ...row, result: 'moved during the update; next merge retries' };
  // the wiki's files both sides changed: the merge is done, the markers are its agent's
  const wiki = held.flatMap((l) => l.conflicts.map((f) => `${l.path}/${f}`));
  const pointer = wiki.length ? `pointer (wiki conflicts: ${wiki.join(', ')})` : 'pointer';
  const resolved = [...(links.length ? [pointer] : []), ...(resolvedChangelog ? ['changelog'] : [])];
  const result = resolved.length ? `merged & resolved: ${resolved.join(', ')}` : 'merged';
  if (!wiki.length || !prefix || !branch.startsWith(prefix)) return { ...row, result };
  await github.rest.repos.createDispatchEvent({ owner, repo, event_type: 'agent-code',
    client_payload: { pull_request: pr.number, reason: 'conflict', base, paths: wiki.join(', '), wiki: wiki.join(', ') } });
  return { ...row, result: `${result} (dispatched)` };
}

// a family's branch (`issue-<P>`), the base of its sub-issues' PRs
const FAMILY = /^issue-\d+$/;
// a row whose PR's head this run moved
const moved = (row) => row.result === 'updated' || row.result.startsWith('merged');

// every open PR on `base` whose head is in this repository; one PR's trouble is its row. A
// family's branch this moved (its PR to main updated) is then a base too: its sub-issues' PRs
// follow, their rows naming it as `base`. `visited` keeps any base to once a run.
async function update({ github, core, exec, owner, repo, base, root, changelog = 'CHANGELOG.md', prefix = 'issue-', env = process.env, visited = new Set() }) {
  visited.add(base);
  const prs = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base, per_page: 100 });
  changelog = changelog.replace(/^\.\//, '');
  const mine = prs.filter((pr) => pr.head?.repo?.full_name === `${owner}/${repo}`);
  // where the job's checkout is: its branch, else its commit
  const start = (await git(exec, root, ['symbolic-ref', '-q', '--short', 'HEAD'], { env, ok: true })).out.trim()
    || (await git(exec, root, ['rev-parse', 'HEAD'], { env, ok: true })).out.trim();
  const state = { shallow: (await git(exec, root, ['rev-parse', '--is-shallow-repository'], { env, ok: true })).out.trim() === 'true' };
  const heads = new Map();
  const rows = [];
  for (const pr of mine) {
    let row;
    try {
      row = await updatePr({ github, core, exec, owner, repo, base, root, changelog, prefix, env, heads, state, pr });
    } catch (e) {
      row = { number: pr.number, branch: pr.head.ref, result: `failed: ${e.message.split('\n')[0]}` };
      core.warning(`#${pr.number}: ${e.message}`);
    }
    core.info(`#${row.number} ${row.branch}: ${row.result}`);
    rows.push(row);
  }
  for (const row of rows.slice()) {
    if (!moved(row) || !FAMILY.test(row.branch) || visited.has(row.branch)) continue;
    const followed = await update({ github, core, exec, owner, repo, base: row.branch, root, changelog, prefix, env, visited });
    rows.push(...followed.map((r) => ({ ...r, base: r.base || row.branch })));
  }
  // the checkout back where the job had it
  if (state.moved && start) await git(exec, root, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', start], { env, ok: true });
  return rows;
}

// a table for the base, then one for each family branch the run followed
function summaryOf(base, rows) {
  const bases = [...new Set(rows.map((r) => r.base).filter(Boolean))];
  const strip = ({ base: _, ...r }) => r;
  return [table(base, rows.filter((r) => !r.base)), ...bases.map((b) => table(b, rows.filter((r) => r.base === b).map(strip)))].join('\n');
}

function table(base, rows) {
  if (!rows.length) return `### Open PRs on \`${base}\`\n\nNone.\n`;
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  return [`### Open PRs on \`${base}\``, '', '| PR | Branch | Result |', '|---|---|---|',
    ...rows.map((r) => `| #${r.number} | \`${cell(r.branch)}\` | ${cell(r.result)} |`), ''].join('\n');
}

async function run({ github, context, core, exec }) {
  const env = process.env;
  if (!env.TOKEN) throw new Error('no token: the App token was not minted');
  const base = env.BASE || env.GITHUB_REF_NAME;
  if (!base) throw new Error('no base branch');
  const top = await git(exec, env.GITHUB_WORKSPACE || process.cwd(), ['rev-parse', '--show-toplevel'], { ok: true });
  if (top.code) throw new Error('no checkout: run actions/checkout first');
  const gitEnv = { ...env, ...authEnv(core, env.TOKEN, env.GITHUB_SERVER_URL) };
  const { owner, repo } = context.repo;
  const rows = await update({ github, core, exec, owner, repo, base, root: top.out.trim(), changelog: env.CHANGELOG || 'CHANGELOG.md', prefix: env.PREFIX ?? 'issue-', env: gitEnv });
  core.setOutput('results', JSON.stringify(rows));
  await core.summary.addRaw(summaryOf(base, rows)).write();
}

module.exports = { run, update, unionHunks, unmerged, mergeTreeOf, changes, messageOf, table, summaryOf, authEnv };
