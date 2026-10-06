// Pre-step: write the issue body + full comment thread to <scratch_dir>/context.md,
// and the message that triggered this run (the new comment, else the issue) to
// <scratch_dir>/latest.md — all a resumed session needs to read.
//
// Env (set by the action step):
//   SCRATCH_DIR  — gitignored dir to write into
//   ISSUE_NUMBER — the issue (the event's own, or one a dispatch named)

module.exports = async function gather({ github, context, core }) {
  const fs = require('fs');
  const path = require('path');

  const { owner, repo } = context.repo;
  const issue_number = Number(process.env.ISSUE_NUMBER);

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

  const comment = context.payload.comment;
  const latest = comment
    ? `### @${comment.user.login} — ${comment.created_at}\n\n${comment.body || ''}\n`
    : `# Issue #${issue_number}: ${issue.data.title}\n\n${issue.data.body || '(empty)'}\n`;

  const dir = path.join(process.env.GITHUB_WORKSPACE, process.env.SCRATCH_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'context.md'), out);
  fs.writeFileSync(path.join(dir, 'latest.md'), latest);
  core.info(`wrote ${process.env.SCRATCH_DIR}/context.md (${comments.length} comments) and latest.md`);
};
