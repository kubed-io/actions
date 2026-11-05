// Copilot as a reviewer. The owner's own request opts a change in; after that the flow asks
// for each new head itself, on the App's token or GITHUB_TOKEN (both start a review since
// 2026-11). Its review wakes nothing directly: GitHub holds every run Copilot triggers, so
// n8n relays the review.

const REVIEWER = 'copilot-pull-request-reviewer[bot]';

// one bot, a different login per API
function isCopilot(user) {
  return !!user && (user.login === 'Copilot' || /^copilot-pull-request-reviewer(\[bot\])?$/.test(user.login));
}

// the review a cancelled or failed run leaves: no verdict
const failedReview = (review) => /^Copilot encountered an error/.test(review?.body || '');

const timeline = (github, { owner, repo, number }) => github.paginate(github.rest.issues.listEventsForTimeline,
  { owner, repo, issue_number: number, per_page: 100 });

// The owner's own request is the opt-in; the flow's requests for each head are not
function optedIn(events, ownerId) {
  return events.some((e) => e.event === 'review_requested' && isCopilot(e.requested_reviewer)
    && String(e.actor?.id) === String(ownerId));
}

// Copilot was asked to review a head: a request since its commit
function askedSince(events, date) {
  const t = Date.parse(date);
  return events.some((e) => e.event === 'review_requested' && isCopilot(e.requested_reviewer)
    && Date.parse(e.created_at) >= t);
}

// Copilot's reviews of one commit, oldest first
async function reviewsOf(github, { owner, repo, number, sha }) {
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: number, per_page: 100 });
  return reviews.filter((r) => isCopilot(r.user) && r.commit_id === sha);
}

const ask = (github, { owner, repo, number }) => github.rest.pulls.requestReviewers(
  { owner, repo, pull_number: number, reviewers: [REVIEWER] });

// folded away as outdated: the review stays, out of the way
const hide = (github, nodeId) => github.graphql(
  'mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { clientMutationId } }',
  { id: nodeId });

// the line comments a review left
async function reviewComments(github, { owner, repo, number, reviewId }) {
  const comments = await github.paginate(github.rest.pulls.listCommentsForReview, { owner, repo, pull_number: number, review_id: reviewId, per_page: 100 });
  return comments.length;
}

module.exports = { isCopilot, failedReview, timeline, optedIn, askedSince, reviewsOf, ask, hide, reviewComments };
