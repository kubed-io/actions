// Called from the composite action via:
//   const publish = require(`${process.env.PLAN_AGENT_DIR}/publish-plan.js`);
//   await publish({ github, context, core });
//
// Env vars (set by the action step):
//   PLAN_FILE  — repo-relative path to the plan markdown file (default: .plan/plan.md)
//   MARKER     — sentinel first line used to identify the single pinned comment

module.exports = async function publish({ github, context, core }) {
  const fs = require('fs');
  const path = require('path');

  const planFile = process.env.PLAN_FILE;
  const marker = process.env.MARKER;
  const file = path.join(process.env.GITHUB_WORKSPACE, planFile);

  if (!fs.existsSync(file)) {
    core.info(`no ${planFile} written; nothing to publish`);
    return;
  }

  const body = `${marker}\n` + fs.readFileSync(file, 'utf8');
  const { owner, repo } = context.repo;
  const issue_number = context.issue.number;

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });

  const existing = comments.find(c => c.body && c.body.startsWith(marker));
  if (existing) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    core.info(`updated plan comment ${existing.id}`);
  } else {
    const res = await github.rest.issues.createComment({ owner, repo, issue_number, body });
    core.info(`created plan comment ${res.data.id}`);
  }
};
