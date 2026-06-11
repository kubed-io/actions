// Post-step: take the agent's structured { reply, plan } and do all the GitHub
// writes deterministically — the agent itself has no GitHub tools.
//   - plan  → upsert ONE pinned comment identified by MARKER (created the first
//             run, edited in place after).
//   - reply → posted as a short new comment.
//
// Env (set by the action step):
//   MARKER     — sentinel first line that identifies the pinned plan comment
//   STRUCTURED — the claude step's structured_output (JSON string)

module.exports = async function publish({ github, context, core }) {
  let parsed;
  try {
    parsed = JSON.parse(process.env.STRUCTURED);
  } catch (e) {
    core.warning(`structured_output was not valid JSON; nothing to publish: ${e.message}`);
    return;
  }

  const { reply, plan } = parsed;
  const marker = process.env.MARKER;
  const { owner, repo } = context.repo;
  const issue_number = context.issue.number;

  // Upsert the single pinned plan comment.
  if (plan && plan.trim()) {
    const body = `${marker}\n${plan}`;
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner, repo, issue_number, per_page: 100,
    });
    const existing = comments.find((c) => c.body && c.body.startsWith(marker));
    if (existing) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
      core.info(`updated plan comment ${existing.id}`);
    } else {
      const res = await github.rest.issues.createComment({ owner, repo, issue_number, body });
      core.info(`created plan comment ${res.data.id}`);
    }
  } else {
    core.info('no plan in structured output; skipped plan comment');
  }

  // Post the short conversational reply.
  if (reply && reply.trim()) {
    await github.rest.issues.createComment({ owner, repo, issue_number, body: reply });
    core.info('posted reply');
  }
};
