// Lands an agent's turn on its branch: the commit message from its output, then (in the
// action) the wiki and the signed commit, then what the reply must not claim, and the PR
// marked ready when the agent says it is done.

// the turn that finishes the plan marks its commit, so its push wakes nothing
const DONE = 'Agent: done';

function message({ core, env = process.env }) {
  let out = {};
  try { out = JSON.parse(env.OUTPUT || '{}') || {}; } catch {}
  let text = typeof out.commit_message === 'string' ? out.commit_message : '';
  const done = out.done === true;
  if (done && text) text = `${text}\n\n${DONE}`;
  core.setOutput('message', text);
  core.setOutput('done', String(done));
}

// The reply was posted before the commit: it says what the commit left out, or that it
// failed, so it never claims work the branch does not have
async function note({ github, context, env = process.env }) {
  const id = Number(env.COMMENT_ID);
  const ignored = JSON.parse(env.IGNORED || '[]');
  const failed = env.FAILED === 'true';
  if (!id || (!failed && !ignored.length)) return;
  const { data: comment } = await github.rest.issues.getComment({ ...context.repo, comment_id: id });
  const body = failed
    ? `> [!CAUTION]\n> **This run's commit failed, so nothing above is on the branch.** See [the run](${env.RUN_URL}).`
    : `> [!WARNING]\n> **Not committed:** ${ignored.map((p) => `\`${p}\``).join(', ')}. This job's token can't write workflow files, so they need a commit by hand.`;
  await github.rest.issues.updateComment({ ...context.repo, comment_id: id, body: `${comment.body}\n\n${body}` });
}

// out of draft, on the token given (the App's), so ready_for_review wakes what follows
async function ready({ github, context, core, env = process.env }) {
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(env.NUMBER) });
  if (!pr.draft) return core.info(`#${pr.number} is already ready`);
  await github.graphql('mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }', { id: pr.node_id });
  core.info(`#${pr.number} is ready for review`);
}

module.exports = { message, note, ready, DONE };
