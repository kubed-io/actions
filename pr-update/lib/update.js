// Brings every open PR on a base up to date after a merge into it (cluster spec 2026-11-12,
// R-L9). GitHub's update-branch first; when it refuses (a conflict, or the head moved), the
// base is merged in a checkout and the two conflicts every agent PR has are resolved: a
// submodule pointer (the docs wiki) moves to its remote's head when that head holds both
// sides, and the changelog's conflict hunks keep the base's lines, then the PR's. Any other
// conflict is the PR's agent's, and an agent's PR (head `prefix*`) is handed to it as the
// `agent-code` dispatch (reason `conflict`), naming the paths. The merge is pushed as the App,
// never forced: a push the branch moved under is retried by the next merge.

const fs = require('fs');
const path = require('path');

// a push refused because the branch is ahead of what was merged
const MOVED = /\((fetch first|non-fast-forward)\)/;

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

// the bot's git identity: `<slug>[bot]` and its noreply address, which needs its user id
async function identity(github, slug) {
  const login = `${slug}[bot]`;
  const { data } = await github.rest.users.getByUsername({ username: login });
  const email = `${data.id}+${login}@users.noreply.github.com`;
  return { GIT_AUTHOR_NAME: login, GIT_COMMITTER_NAME: login, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email };
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

// a pointer both sides moved: to the remote's head when it holds both, else left conflicted
async function resolveLink({ exec, root, env, conflict, heads }) {
  const head = await remoteHead({ exec, root, env, sub: conflict.path, heads });
  if (!head) return false;
  for (const side of [conflict.stages[2].sha, conflict.stages[3].sha]) {
    const { code } = await git(exec, root, ['merge-base', '--is-ancestor', side, head], { env, ok: true });
    if (code) return false;
  }
  await git(exec, root, ['update-index', '--cacheinfo', `160000,${head},${conflict.path}`], { env });
  return true;
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

// the merge commit's message: what was resolved
function messageOf({ base, branch, links, changelog }) {
  const done = [];
  if (links.length === 1) done.push(`the ${links[0]} pointer at the wiki's head`);
  if (links.length > 1) done.push(`the ${links.join(', ')} pointers at their heads`);
  if (changelog) done.push(`${changelog}'s entries from both`);
  return `Merge ${base} into ${branch}${done.length ? `: ${done.join('; ')}` : ''}`;
}

// one PR: the result row for the summary
async function updatePr({ github, core, exec, owner, repo, base, root, changelog, prefix, env, heads, state, pr }) {
  const branch = pr.head.ref;
  const row = { number: pr.number, branch };

  // 1. current: the base is already in the head
  const { data: cmp } = await github.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${pr.head.sha}` });
  if (cmp.behind_by === 0) return { ...row, result: 'current' };

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
  const merge = await git(exec, root, ['-c', 'merge.conflictStyle=merge', 'merge', '--no-commit', '--no-ff', '--quiet', `refs/remotes/origin/${base}`], { env, ok: true });
  if (merge.code > 1) {
    await git(exec, root, ['merge', '--abort'], { env, ok: true });
    throw new Error(`the merge failed: ${(merge.err || merge.out).trim() || `exit ${merge.code}`}`);
  }

  const links = [];
  let resolvedChangelog = '';
  const left = [];
  for (const conflict of unmerged((await git(exec, root, ['ls-files', '-u', '-z'], { env })).out)) {
    if (isLink(conflict.stages) && await resolveLink({ exec, root, env, conflict, heads })) links.push(conflict.path);
    else if (conflict.path === changelog && isText(conflict.stages) && await resolveChangelog({ exec, root, env, conflict })) resolvedChangelog = changelog;
    else left.push(conflict.path);
  }
  if (left.length) {
    await git(exec, root, ['merge', '--abort'], { env, ok: true });
    const result = `needs its agent: ${left.join(', ')}`;
    if (!prefix || !branch.startsWith(prefix)) return { ...row, result };
    // the agent's one event interface; its route decides whether that is a turn
    await github.rest.repos.createDispatchEvent({ owner, repo, event_type: 'agent-code',
      client_payload: { pull_request: pr.number, reason: 'conflict', base, paths: left.join(', ') } });
    return { ...row, result: `${result} (dispatched)` };
  }

  await git(exec, root, ['commit', '--quiet', '--no-verify', '-m', messageOf({ base, branch, links, changelog: resolvedChangelog })], { env });
  // never forced: a branch that moved meanwhile keeps its new commits
  const push = await git(exec, root, ['push', 'origin', `HEAD:refs/heads/${branch}`], { env, ok: true });
  if (push.code) {
    if (MOVED.test(push.err)) return { ...row, result: 'moved during the update; next merge retries' };
    throw new Error(`the push failed: ${push.err.trim() || `exit ${push.code}`}`);
  }
  const resolved = [...(links.length ? ['pointer'] : []), ...(resolvedChangelog ? ['changelog'] : [])];
  return { ...row, result: resolved.length ? `merged & resolved: ${resolved.join(', ')}` : 'merged' };
}

// every open PR on `base` whose head is in this repository; one PR's trouble is its row
async function update({ github, core, exec, owner, repo, base, root, changelog = 'CHANGELOG.md', prefix = 'issue-', env = process.env }) {
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
  // the checkout back where the job had it
  if (state.moved && start) await git(exec, root, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', start], { env, ok: true });
  return rows;
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
  if (!env.APP_SLUG) throw new Error("no app slug: the App's bot commits the merges");
  const base = env.BASE || env.GITHUB_REF_NAME;
  if (!base) throw new Error('no base branch');
  const top = await git(exec, env.GITHUB_WORKSPACE || process.cwd(), ['rev-parse', '--show-toplevel'], { ok: true });
  if (top.code) throw new Error('no checkout: run actions/checkout first');
  const gitEnv = { ...env, ...authEnv(core, env.TOKEN, env.GITHUB_SERVER_URL), ...(await identity(github, env.APP_SLUG)) };
  const { owner, repo } = context.repo;
  const rows = await update({ github, core, exec, owner, repo, base, root: top.out.trim(), changelog: env.CHANGELOG || 'CHANGELOG.md', prefix: env.PREFIX ?? 'issue-', env: gitEnv });
  core.setOutput('results', JSON.stringify(rows));
  await core.summary.addRaw(table(base, rows)).write();
}

module.exports = { run, update, unionHunks, unmerged, messageOf, table, authEnv };
