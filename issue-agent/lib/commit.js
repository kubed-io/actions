// issue-agent/commit: commits the latest round of a document once it is approved. On an
// issue it creates the branch, linked to the issue, and can open the draft PR; on a PR it
// commits to the PR's head. GitHub signs commits made through createCommitOnBranch.

const fs = require('fs');
const path = require('path');
const { TAG, readState, writeSection } = require('./state');
const { links, label } = require('./round');
const { fill, gql } = require('./util');

async function headOid(github, owner, repo, branch) {
  try {
    const { data } = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return data.object.sha;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function run({ github, context, core }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const number = Number(env.NUMBER);
  const document = env.DOCUMENT;
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: number });
  const state = readState(issue.body, document);
  if (!state) throw new Error(`#${number} has no ${document} round to commit`);

  if (env.MODE === 'read') {
    core.setOutput('run', String(state.run));
    core.setOutput('artifact', String(state.artifact));
    core.setOutput('file', path.basename(state.path));
    return;
  }

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
    const { data: pr } = await github.rest.pulls.create({ owner, repo, title: issue.title, head: branch, base: repository.default_branch, body, draft: true });
    pull = String(pr.number);
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

module.exports = { run };
