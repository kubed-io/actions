// live_messages: the answer's side of a turn n8n could talk to. The placeholder is found by
// its run, since n8n reposts it below each in-flight reply, and the seen marker covers what
// the agent-flow hook handed the turn (the channel's inbox, up to the hook's cursor).

const fs = require('fs');
const path = require('path');
const { isAgent, readPlaceholder } = require('./state');
const { fromComment, fromReview, unseen } = require('./thread');
const { list } = require('./util');

// where the channel and its hook keep it
function inboxPath(env) {
  return env.CLAUDE_CHANNEL_INBOX || path.join(env.RUNNER_TEMP || '/tmp', 'agent-flow', 'inbox.jsonl');
}

// The comments and reviews the hook handed over: inbox lines before its cursor, a byte
// offset at a line's end. No cursor, or one that does not fit the inbox, hands nothing.
function handed(file) {
  let data;
  let cursor;
  try {
    data = fs.readFileSync(file);
    cursor = Number(fs.readFileSync(`${file}.cursor`, 'utf8').trim());
  } catch {
    return [];
  }
  if (!Number.isSafeInteger(cursor) || cursor <= 0 || cursor > data.length) return [];
  const out = [];
  for (const text of data.subarray(0, cursor).toString('utf8').split('\n')) {
    let line = null;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    const kind = line?.comment_kind;
    if (line?.kind === 'message' && (kind === 'comment' || kind === 'review') && line.comment_id != null) {
      out.push({ kind, id: String(line.comment_id) });
    }
  }
  return out;
}

// a human can paste the marker, so only a bot's tagged comment counts; n8n's copy is newest
function findPlaceholder(comments, runId) {
  const mine = comments.filter((c) => c.user?.type === 'Bot' && isAgent(c.body) && readPlaceholder(c.body)?.run_id === Number(runId));
  mine.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
  return mine.pop() || null;
}

// `through` moves to the latest message handed over, but never onto or past a trusted one
// the hook did not hand over (posted before the channel was live, or a push that failed):
// that one is still unseen, and the next turn takes it.
function advance(seen, got, messages, trust) {
  if (!seen.through || !got.length) return seen;
  const keys = new Set(got.map((h) => `${h.kind}:${h.id}`));
  const after = unseen(messages, seen, trust).filter((m) => m.at > seen.through);
  const isHanded = (m) => keys.has(`${m.kind}:${m.id}`);
  const gap = after.filter((m) => !isHanded(m)).reduce((min, m) => (min === null || m.at < min ? m.at : min), null);
  let out = seen;
  for (const m of after) {
    if (isHanded(m) && (gap === null || m.at < gap) && m.at > out.through) out = { ...seen, through: m.at, id: String(m.id) };
  }
  return out;
}

// The placeholder's id now (0 when there is none), and with `seen` the marker the answer
// carries. One listing of the comments; on a PR the reviews too once anything was handed
// over, since a review not handed over holds `through` back like a comment does.
async function settle({ github, context, env, seen }) {
  const { owner, repo } = context.repo;
  const number = Number(env.NUMBER);
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });
  const commentId = findPlaceholder(comments, context.runId)?.id || 0;
  if (!seen) return { commentId };
  const got = handed(inboxPath(env));
  if (!got.length) return { commentId, seen };
  const messages = comments.map(fromComment);
  if (env.IS_PR === 'true') {
    const at = { owner, repo, pull_number: number, per_page: 100 };
    const reviews = await github.paginate(github.rest.pulls.listReviews, at);
    const lines = await github.paginate(github.rest.pulls.listReviewComments, at);
    for (const r of reviews.filter((x) => x.submitted_at)) messages.push(fromReview(r, lines.filter((c) => c.pull_request_review_id === r.id)));
  }
  const trust = { ids: list(env.TRUSTED_IDS), bots: list(env.TRUSTED_BOTS) };
  return { commentId, seen: advance(seen, got, messages, trust) };
}

module.exports = { inboxPath, handed, findPlaceholder, advance, settle };
