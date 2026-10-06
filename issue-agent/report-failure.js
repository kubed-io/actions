// Failure step: turn the placeholder into a note that the run didn't finish, so the
// thread never shows a spinner forever.
//
// Env (set by the action step):
//   COMMENT_ID — the placeholder acknowledge.js posted
//   PROMPT     — the one-off prompt, if there was one
//   RUN_URL    — this run (or job)

module.exports = async function reportFailure({ github, context, core }) {
  const prompt = (process.env.PROMPT || '').trim();
  const quoted = prompt ? prompt.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' : '';
  const { owner, repo } = context.repo;
  await github.rest.issues.updateComment({
    owner, repo,
    comment_id: Number(process.env.COMMENT_ID),
    body: `${quoted}⚠️ I didn't finish this one. [See the run](${process.env.RUN_URL}) for what went wrong.`,
  });
  core.info('marked the placeholder as failed');
};
