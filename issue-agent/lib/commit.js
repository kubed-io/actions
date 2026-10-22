// issue-agent/commit: commits the latest round of a document once it is approved. On an
// issue it creates the branch, linked to the issue, and can open the draft PR; on a PR it
// commits to the PR's head. GitHub signs commits made through createCommitOnBranch.

const fs = require('fs');
const path = require('path');
const { TAG, writeSection, safePath, readState } = require('./state');
const { bodyState } = require('./trusted');
const { links, label, slugify } = require('./round');
const { fill, gql, list } = require('./util');

async function headOid(github, owner, repo, branch) {
  try {
    const { data } = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return data.object.sha;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

function failure({ document, runUrl }) {
  return `${TAG}\n⚠️ I couldn't commit the approved ${document}. [See the run](${runUrl}) for why; a fresh round and a new approval label will retry.`;
}

async function run({ github, context, core }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const number = Number(env.NUMBER);
  const document = env.DOCUMENT;
  if (env.MODE === 'failure') {
    await github.rest.issues.createComment({ owner, repo, issue_number: number, body: failure({ document, runUrl: env.RUN_URL }) });
    return;
  }
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: number });
  const state = await bodyState(github, { owner, repo, number, document, body: issue.body, ids: list(env.TRUSTED_IDS), server: env.GITHUB_SERVER_URL });
  // a state someone else wrote is refused outright: never committed, never skipped past
  if (!state && readState(issue.body, document)) throw new Error(`the ${document} round on #${number} was not written by the agent; ask for a fresh round`);
  // an issue with no draft hands off its notes alone: a branch and a PR, no document
  if (!state && !issue.pull_request) return handOff({ github, core, env, owner, repo, number, issue, document });
  if (!state) throw new Error(`#${number} has no ${document} round to commit`);

  if (env.MODE === 'read') {
    core.setOutput('run', String(state.run));
    core.setOutput('artifact', String(state.artifact));
    core.setOutput('file', path.basename(state.path));
    return;
  }

  // a second approval (the label taken off and put back) commits nothing again; the
  // jobs after it still run
  if (state.approved && state.branch && state.commit) {
    core.notice(`the ${document} round on #${number} is already approved and committed`);
    core.setOutput('branch', state.branch);
    core.setOutput('path', state.path);
    core.setOutput('commit_url', `${env.GITHUB_SERVER_URL}/${owner}/${repo}/commit/${state.commit}`);
    core.setOutput('pull_request', '');
    return;
  }

  if (!safePath(state.path)) throw new Error(`refusing to commit ${state.path}: a document lands under docs/`);
  const contents = fs.readFileSync(path.join(env.DOWNLOAD_DIR, path.basename(state.path)));
  const { data: repository } = await github.rest.repos.get({ owner, repo });

  let branch;
  if (issue.pull_request) {
    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
    if (pr.head.repo.full_name !== `${owner}/${repo}`) throw new Error('the PR head is in another repository');
    branch = pr.head.ref;
  } else {
    branch = fill(env.BRANCH, { number, slug: state.slug, document });
    if (await headOid(github, owner, repo, branch)) throw new Error(`branch ${branch} already exists, and is never overwritten`);
    const base = await headOid(github, owner, repo, repository.default_branch);
    await github.graphql(gql('linked-branch'), { issue: issue.node_id, repo: repository.node_id, oid: base, name: branch });
  }

  const headline = fill(env.MESSAGE, { document, title: issue.title, number });
  const additions = [{ path: state.path, contents: contents.toString('base64') }];
  let commit;
  for (let attempt = 1; !commit; attempt += 1) {
    const expectedHeadOid = await headOid(github, owner, repo, branch);
    try {
      const out = await github.graphql(gql('commit-on-branch'), { input: { branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch }, message: { headline }, fileChanges: { additions }, expectedHeadOid } });
      commit = out.createCommitOnBranch.commit;
    } catch (e) {
      if (attempt >= 2) throw e;
      core.warning(`the commit failed once (${e.message}); retrying on the new head`);
    }
  }

  const blob = `${env.GITHUB_SERVER_URL}/${owner}/${repo}/blob/${branch}/${state.path}`;
  let pull = '';
  if (!issue.pull_request && env.PULL_REQUEST === 'draft') {
    const body = `${label(document)}: [${state.path}](${blob})\n\nCloses #${number}\n`;
    pull = await openPull({ github, env, owner, repo, issue, branch, base: repository.default_branch, body });
  }

  const approved = { ...state, approved: true, branch, commit: commit.oid };
  await github.rest.issues.update({ owner, repo, issue_number: number, body: writeSection(issue.body, document, approved, [links(approved, document)]) });
  const opened = pull ? ` Draft pull request: #${pull}.` : '';
  await github.rest.issues.createComment({ owner, repo, issue_number: number, body: `${TAG}\n${label(document)} approved and committed: [\`${state.path}\`](${blob}) in ${commit.url}.${opened}` });

  core.setOutput('branch', branch);
  core.setOutput('path', state.path);
  core.setOutput('commit_url', commit.url);
  core.setOutput('pull_request', pull);
}

async function openPull({ github, env, owner, repo, issue, branch, base, body }) {
  const { data: pr } = await github.rest.pulls.create({ owner, repo, title: issue.title, head: branch, base, body, draft: true });
  // the hand-off carries the issue's opt-in to the PR, where it gates plan and code
  const labels = list(env.PULL_REQUEST_LABELS);
  if (labels.length) await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels });
  return String(pr.number);
}

// No draft to commit: the issue's notes go on alone. GitHub opens no PR on a branch with
// nothing new, so the branch starts with one empty commit (signed, like any other).
async function handOff({ github, core, env, owner, repo, number, issue, document }) {
  core.setOutput('path', '');
  if (env.MODE === 'read') {
    core.setOutput('artifact', '');
    return;
  }
  const branch = fill(env.BRANCH, { number, slug: slugify(issue.title), document });
  const { data: repository } = await github.rest.repos.get({ owner, repo });
  if (await headOid(github, owner, repo, branch)) {
    // a second approval finds the hand-off it already made
    const { data: open } = await github.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: 'open' });
    if (!open.length) throw new Error(`branch ${branch} already exists, and is never overwritten`);
    core.notice(`#${number} is already handed off to #${open[0].number}`);
    core.setOutput('branch', branch);
    core.setOutput('commit_url', '');
    core.setOutput('pull_request', '');
    return;
  }
  const base = await headOid(github, owner, repo, repository.default_branch);
  await github.graphql(gql('linked-branch'), { issue: issue.node_id, repo: repository.node_id, oid: base, name: branch });
  const headline = `${issue.title} (#${number})`;
  const out = await github.graphql(gql('commit-on-branch'), { input: { branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch }, message: { headline }, fileChanges: { additions: [] }, expectedHeadOid: base } });
  const commit = out.createCommitOnBranch.commit;
  let pull = '';
  if (env.PULL_REQUEST === 'draft') {
    const body = `Closes #${number}\n\nStarts from #${number}'s notes.\n`;
    pull = await openPull({ github, env, owner, repo, issue, branch, base: repository.default_branch, body });
  }
  const opened = pull ? ` Draft pull request: #${pull}.` : '';
  await github.rest.issues.createComment({ owner, repo, issue_number: number, body: `${TAG}\nHanded off with this issue's notes, on \`${branch}\`.${opened}` });
  core.setOutput('branch', branch);
  core.setOutput('commit_url', commit.url);
  core.setOutput('pull_request', pull);
}

module.exports = { failure, run };
