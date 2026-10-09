// Asks Copilot to review a pull request once it is out of draft, at most once per head
// commit: a draft is still being built, and a head Copilot has already reviewed (or is
// already asked to) needs nothing more. Being state-based, it cannot start a loop.

const COPILOT = 'copilot-pull-request-reviewer[bot]';

// one bot, a different login per API
function isCopilot(user) {
  return !!user && (user.login === 'Copilot' || /^copilot-pull-request-reviewer(\[bot\])?$/.test(user.login));
}

async function askCopilot({ github, context, core, number }) {
  const { owner, repo } = context.repo;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (pr.draft) {
    core.info('a draft: Copilot waits for ready for review');
    return false;
  }
  if ((pr.requested_reviewers || []).some(isCopilot)) return false;
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
  if (reviews.some((r) => isCopilot(r.user) && r.commit_id === pr.head.sha)) return false;
  try {
    await github.rest.pulls.requestReviewers({ owner, repo, pull_number: number, reviewers: [COPILOT] });
    core.info(`asked Copilot to review ${pr.head.sha.slice(0, 7)}`);
    return true;
  } catch (e) {
    core.warning(`could not request Copilot's review: ${e.message}`);
    return false;
  }
}

module.exports = { isCopilot, askCopilot };
