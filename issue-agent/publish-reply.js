// Post-step: put the agent's structured { reply } into the placeholder comment that
// acknowledge.js posted (or a new comment, without one). A one-off prompt (e.g. a
// dispatch that joined this issue's conversation) is quoted first, so the thread
// reads as the conversation it was.
//
// Env (set by the action step):
//   STRUCTURED   — the claude step's structured_output (JSON string)
//   ISSUE_NUMBER — the issue to post on
//   COMMENT_ID   — the placeholder to edit, if any
//   PROMPT       — the one-off prompt, if there was one
//   RUN_URL      — this run (or job)

module.exports = async function publish({ github, context, core }) {
  let reply;
  try {
    reply = JSON.parse(process.env.STRUCTURED).reply;
  } catch (e) {
    core.setFailed(`structured_output was not valid JSON: ${e.message}`);
    return;
  }
  if (!reply || !reply.trim()) {
    core.setFailed('the agent returned an empty reply');
    return;
  }

  const prompt = (process.env.PROMPT || '').trim();
  const quoted = prompt ? prompt.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' : '';
  const body = `${quoted}${reply}\n\n<sub>[Run](${process.env.RUN_URL})</sub>`;

  const { owner, repo } = context.repo;
  const issue_number = Number(process.env.ISSUE_NUMBER);
  const comment_id = Number(process.env.COMMENT_ID);
  if (comment_id) {
    await github.rest.issues.updateComment({ owner, repo, comment_id, body });
    core.info(`answered in comment ${comment_id} on #${issue_number}`);
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number, body });
    core.info(`posted reply on #${issue_number}`);
  }
};
