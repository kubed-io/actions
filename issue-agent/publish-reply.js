// Post-step: post the agent's structured { reply } as a comment on the issue. When
// the run came from a one-off prompt rather than the thread (e.g. a dispatch that
// joined this issue's conversation), the prompt is quoted first so the thread
// reads as the conversation it was.
//
// Env (set by the action step):
//   STRUCTURED   — the claude step's structured_output (JSON string)
//   ISSUE_NUMBER — the issue to post on
//   PROMPT       — the one-off prompt, if there was one

module.exports = async function publish({ github, context, core }) {
  let reply;
  try {
    reply = JSON.parse(process.env.STRUCTURED).reply;
  } catch (e) {
    core.warning(`structured_output was not valid JSON; nothing to publish: ${e.message}`);
    return;
  }
  if (!reply || !reply.trim()) {
    core.info('empty reply; nothing posted');
    return;
  }

  const prompt = (process.env.PROMPT || '').trim();
  const quoted = prompt ? prompt.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' : '';

  const { owner, repo } = context.repo;
  const issue_number = Number(process.env.ISSUE_NUMBER);
  await github.rest.issues.createComment({ owner, repo, issue_number, body: quoted + reply });
  core.info(`posted reply on #${issue_number}`);
};
