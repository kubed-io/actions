// git/pr: open a PR from a branch, or find the open one. A found PR is left as it is.

const { list, defaultBranch } = require('./util');

async function run({ github, context, core }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const branch = env.BRANCH;
  if (!branch) throw new Error('branch is required');
  if (!env.TITLE) throw new Error('title is required');
  const base = env.BASE || await defaultBranch(github, owner, repo);

  const { data: open } = await github.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, base, state: 'open' });
  if (open.length) {
    core.notice(`${branch} already has #${open[0].number} open`);
    return outputs(core, open[0], false);
  }

  // "No commits between" is GitHub's to say: the caller commits first
  const { data: pr } = await github.rest.pulls.create({ owner, repo, title: env.TITLE, head: branch, base, body: env.BODY || '', draft: env.DRAFT !== 'false' });
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
