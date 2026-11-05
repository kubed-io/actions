// git/pr: open a PR from a branch, or find the open one. A found PR is left as it is, except
// that `draft: false` marks a draft one ready: the PR exists, in the state asked for. With no
// title it only finds: a branch whose PR was merged or closed meanwhile has nothing to do.

const { list, defaultBranch } = require('./util');

async function run({ github, context, core }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const branch = env.BRANCH;
  if (!branch) throw new Error('branch is required');
  const draft = env.DRAFT !== 'false';

  // with no base, the branch's open PR into anything
  const { data: open } = await github.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, ...(env.BASE ? { base: env.BASE } : {}), state: 'open' });
  if (open.length) {
    const pr = open[0];
    core.notice(`${branch} already has #${pr.number} open`);
    if (!draft && pr.draft) {
      // on the token given (the App's), so ready_for_review wakes what follows
      await github.graphql('mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }', { id: pr.node_id });
      core.info(`#${pr.number} is ready for review`);
    }
    return outputs(core, pr, false);
  }

  if (!env.TITLE) {
    core.notice(`${branch} has no open PR: nothing to do without a title to open one`);
    return core.setOutput('created', 'false');
  }
  const base = env.BASE || await defaultBranch(github, owner, repo);
  // "No commits between" is GitHub's to say: the caller commits first
  const { data: pr } = await github.rest.pulls.create({ owner, repo, title: env.TITLE, head: branch, base, body: env.BODY || '', draft });
  const labels = list(env.LABELS);
  if (labels.length) await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels });
  outputs(core, pr, true);
}

function outputs(core, pr, created) {
  core.setOutput('number', String(pr.number));
  core.setOutput('url', pr.html_url);
  core.setOutput('created', String(created));
}

module.exports = { run };
