// Line comments: an answer on a PR that points at lines of its diff goes as one review, the
// answer its body and the comments under it, the way Copilot reviews. That is GitHub's review
// API, not a comment's; comment/end picks between them, so a step only says what to post.
//
// A step hands its comments over split already: `inline` on the diff it read, `outside` off
// it. Outside ones are listed in the body. GitHub refuses a whole review for one comment it
// will not place, so a refused review goes once more with every comment in its body; refused
// again, there is no review and the answer is a plain comment.

// a fence longer than any backtick run in the text, so a suggestion can hold code fences
function fence(text) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function commentBody(c) {
  if (typeof c.suggestion !== 'string') return c.body.trim();
  const f = fence(c.suggestion);
  return `${c.body.trim()}\n\n${f}suggestion\n${c.suggestion.replace(/\n$/, '')}\n${f}`;
}

function toGithub(c) {
  const out = { path: c.path, line: c.line, side: 'RIGHT', body: commentBody(c) };
  if (c.start_line && c.start_line !== c.line) Object.assign(out, { start_line: c.start_line, start_side: 'RIGHT' });
  return out;
}

// comments that are not under the review, as a list in its body
function listed(comments, title = 'Outside the diff') {
  if (!comments.length) return '';
  const items = comments.map((c) => {
    const where = c.start_line && c.start_line !== c.line ? `${c.path}:${c.start_line}-${c.line}` : `${c.path}:${c.line}`;
    return `- **\`${where}\`**: ${commentBody(c).replace(/\n/g, '\n  ')}`;
  });
  return `**${title}**\n\n${items.join('\n')}`;
}

// one COMMENT review on the commit the comments were made on; null when GitHub refuses twice
async function postReview({ github, context, core, number, lines, bodyWith }) {
  const at = { ...context.repo, pull_number: number, commit_id: lines.commit_id, event: 'COMMENT' };
  try {
    return (await github.rest.pulls.createReview({ ...at, body: bodyWith(listed(lines.outside)), comments: lines.inline.map(toGithub) })).data;
  } catch (e) {
    core.warning(`GitHub refused the review (${e.message}); posting it again with every comment in its body`);
  }
  try {
    return (await github.rest.pulls.createReview({ ...at, body: bodyWith(listed([...lines.inline, ...lines.outside], 'Line comments')), comments: [] })).data;
  } catch (e) {
    core.warning(`GitHub refused that too (${e.message}); the answer goes as a comment`);
    return null;
  }
}

module.exports = { fence, commentBody, toGithub, listed, postReview };
