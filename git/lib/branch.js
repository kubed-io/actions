// git/branch: make a branch from a base, or find it. With an issue the branch is created
// linked to it, so it shows in the issue's Development panel.

const { gql, headOid } = require('./util');

async function run({ github, context, core }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const branch = env.BRANCH;
  if (!branch) throw new Error('branch is required');

  const existing = await headOid(github, owner, repo, branch);
  if (existing) {
    core.notice(`branch ${branch} already exists at ${existing}`);
    core.setOutput('sha', existing);
    core.setOutput('created', 'false');
    return;
  }

  const { data: repository } = await github.rest.repos.get({ owner, repo });
  const base = env.BASE || repository.default_branch;
  const oid = await headOid(github, owner, repo, base);
  if (!oid) throw new Error(`base branch ${base} does not exist`);

  if (env.ISSUE) {
    const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: Number(env.ISSUE) });
    await github.graphql(gql('linked-branch'), { issue: issue.node_id, repo: repository.node_id, oid, name: branch });
  } else {
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: oid });
  }

  core.setOutput('sha', oid);
  core.setOutput('created', 'true');
}

module.exports = { run };
