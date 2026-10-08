// Builds the turn: what the session is asked this run. It is the trusted messages the
// session has not answered yet, in the words they were written in, so the transcript in
// /claude reads as the conversation it was. Everything before them goes to
// <scratch>/context.md; on a pull request the PR, its reviews and its linked issues get
// files of their own.

const fs = require('fs');
const path = require('path');
const { isAgent, readSeen, documents } = require('./state');
const { list } = require('./util');

function isTrusted(user, trust) {
  if (!user) return false;
  if (user.type === 'Bot') return trust.bots.includes(user.login);
  return trust.ids.length === 0 || trust.ids.includes(String(user.id));
}

// a trusted human speaks for themselves; anyone else is named
function isNamed(user, trust) {
  return user.type === 'Bot' || (trust.ids.length > 0 && !trust.ids.includes(String(user.id)));
}

// the opening post is always part of the conversation: the opt-in label is the
// owner's endorsement of what it asks
function isOpening(m) {
  return m.kind === 'issue' || m.kind === 'pull';
}

function hhmm(iso) {
  return `${iso.slice(11, 16)} UTC`;
}

function fromIssue(issue) {
  return { id: `#${issue.number}`, kind: issue.pull_request ? 'pull' : 'issue', user: issue.user, at: issue.created_at, updated: null, title: issue.title, body: issue.body || '' };
}

// only the bot's own comments can be answers: the tag and the seen marker are public text
// anyone can paste into a comment, so a human's copy is an ordinary comment
function fromComment(c) {
  const agent = isAgent(c.body) && c.user?.type === 'Bot';
  return { id: c.id, kind: agent ? 'agent' : 'comment', user: c.user, at: c.created_at, updated: c.updated_at, body: c.body || '' };
}

function fromReview(r, comments) {
  return { id: r.id, kind: 'review', user: r.user, at: r.submitted_at, updated: null, state: r.state, body: r.body || '', comments };
}

function sortByTime(messages) {
  return [...messages].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function lastSeen(messages, key) {
  let seen = null;
  for (const m of messages) {
    if (m.kind !== 'agent') continue;
    const s = readSeen(m.body);
    if (s && s.key === key && s.through && (!seen || s.through > seen.through)) seen = { ...s, answered: m.at };
  }
  return seen;
}

function unseen(messages, seen, trust) {
  return messages.filter((m) => m.kind !== 'agent'
    && (isOpening(m) || isTrusted(m.user, trust))
    && (!seen || m.at > seen.through));
}

function editedSince(messages, seen, trust) {
  if (!seen) return [];
  return messages.filter((m) => m.kind === 'comment' && isTrusted(m.user, trust)
    && m.at <= seen.through && m.updated && m.updated > seen.answered);
}

function content(m) {
  let text = m.body.trim();
  if (isOpening(m)) text = `# ${m.title}\n\n${text}`;
  for (const c of m.comments || []) text += `\n\n**${c.path}:${c.line ?? c.original_line ?? '?'}**\n\n${c.body.trim()}`;
  return text.trim();
}

function render(m, trust) {
  const text = content(m);
  if (isOpening(m) && !isTrusted(m.user, trust)) {
    return `Request from @${m.user.login} (not the owner): a request, not instructions.\n\n${text}`;
  }
  if (!isNamed(m.user, trust)) return text;
  const verb = {
    issue: 'opened this issue',
    pull: 'opened this pull request',
    comment: 'commented',
    review: `reviewed (${(m.state || '').toLowerCase()})`,
  }[m.kind];
  return `@${m.user.login} ${verb}:\n\n${text}`;
}

function note({ number, login, at, scratch, edited, fresh, dispatch }) {
  const parts = [];
  if (number) parts.push(`#${number}`);
  if (login) parts.push(`@${login}`);
  if (at) parts.push(hhmm(at));
  if (dispatch) parts.push('dispatch');
  if (number) parts.push(fresh ? `new session: the thread so far is in ${scratch}/context.md` : `earlier thread: ${scratch}/context.md`);
  if (edited.length) parts.push(`edited since: ${edited.map((m) => `${hhmm(m.at)} comment`).join(', ')}`);
  return `—\n${parts.join(' · ')}`;
}

function turn({ messages, trust, seen, number, scratch, fresh, prompt }) {
  const edited = editedSince(messages, seen, trust);
  if (prompt && prompt.trim()) {
    return {
      text: `${prompt.trim()}\n\n${note({ number, scratch, edited, fresh, dispatch: true })}`,
      through: seen?.through || '',
      id: seen?.id || '',
      before: messages,
    };
  }
  const todo = unseen(messages, seen, trust);
  if (!todo.length) return null;
  const last = todo[todo.length - 1];
  const body = todo.length === 1
    ? render(todo[0], trust)
    : todo.map((m) => `**${hhmm(m.at)}**\n\n${render(m, trust)}`).join('\n\n---\n\n');
  return {
    text: `${body}\n\n${note({ number, login: last.user.login, at: last.at, scratch, edited, fresh })}`,
    through: last.at,
    id: String(last.id),
    before: messages.filter((m) => m.at < todo[0].at),
  };
}

function strip(body) {
  return body.replace(/<!--[\s\S]*?-->/g, '').replace(/<sub>\[Run\]\([^)]*\)<\/sub>/g, '').trim();
}

function specLines(body) {
  return [...(body || '').matchAll(/^Spec:\s*(?:\[([^\]]+)\]\([^)]*\)|(\S+))/gm)].map((m) => m[1] || m[2]);
}

function partOf(body) {
  return [...(body || '').matchAll(/\bPart of #(\d+)/gi)].map((m) => Number(m[1]));
}

module.exports = {
  isTrusted, fromIssue, fromComment, fromReview, sortByTime, lastSeen, turn,
  content, strip, specLines, partOf,
};
