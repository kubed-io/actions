// Pre-step: write the issue body + full comment thread to <scratch_dir>/context.md
// in the workspace so the read-only agent can ingest it without any GitHub access.
//
// Env (set by the action step):
//   SCRATCH_DIR — gitignored dir to write context.md into (default: .plan)

module.exports = async function gather({ github, context, core }) {
  const fs = require('fs');
  const path = require('path');

  const { owner, repo } = context.repo;
  const issue_number = context.issue.number;

  const issue = await github.rest.issues.get({ owner, repo, issue_number });
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number, per_page: 100,
  });

  const labels = (issue.data.labels || [])
    .map((l) => (typeof l === 'string' ? l : l.name))
    .join(', ');

  let out = `# Issue #${issue_number}: ${issue.data.title}\n\n`;
  out += `**Labels:** ${labels || '(none)'}\n\n`;
  out += `## Body\n\n${issue.data.body || '(empty)'}\n\n`;
  out += `## Comments (${comments.length})\n`;
  for (const c of comments) {
    out += `\n### @${c.user.login} — ${c.created_at}\n\n${c.body || ''}\n`;
  }

  const dir = path.join(process.env.GITHUB_WORKSPACE, process.env.SCRATCH_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'context.md'), out);
  core.info(`wrote ${process.env.SCRATCH_DIR}/context.md (${comments.length} comments)`);
};
