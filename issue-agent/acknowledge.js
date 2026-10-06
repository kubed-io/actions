// Pre-step: post the reply comment before Claude starts, as a "working" placeholder
// with a spinner and a link to this run. publish-reply.js later edits the same
// comment into the answer, or report-failure.js into a failure note.
//
// Env (set by the action step):
//   ISSUE_NUMBER — the issue to post on
//   PROMPT       — the one-off prompt, if there was one (quoted first)
//   RUN_URL      — this run (or job)

const SPINNER = '<img src="https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />';

module.exports = async function acknowledge({ github, context, core }) {
  const prompt = (process.env.PROMPT || '').trim();
  const quoted = prompt ? prompt.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' : '';

  const { owner, repo } = context.repo;
  const issue_number = Number(process.env.ISSUE_NUMBER);
  const body = `${quoted}Working on it… ${SPINNER}\n\n<sub>[Follow the run](${process.env.RUN_URL})</sub>`;
  const { data } = await github.rest.issues.createComment({ owner, repo, issue_number, body });
  core.setOutput('comment_id', String(data.id));
  core.info(`posted placeholder ${data.id} on #${issue_number}`);
};
