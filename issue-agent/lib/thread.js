// Builds the turn: what the session is asked this run. It is the trusted messages the
// session has not answered yet, in the words they were written in, so the transcript in
// /claude reads as the conversation it was. Everything before them goes to
// <scratch>/context.md; on a pull request the PR, its reviews and its linked issues get
// files of their own.

const fs = require('fs');
const path = require('path');
const { isAgent, readSeen } = require('./state');
const { readBlock, stripBlocks, unwrap } = require('./notes');
const { wroteLast, lastEdit } = require('./trusted');
const { list, gql } = require('./util');

// a deleted account arrives as `user: null`; it is a ghost, never trusted
const GHOST = { login: 'ghost', id: null, type: 'User' };

// a bot is trusted by its id, the one stable thing about it: its login has been seen as
// "copilot-pull-request-reviewer", "Copilot" and "copilot-pull-request-reviewer[bot]"
function botNames(user) {
  const bare = user.login.replace(/\[bot\]$/, '');
  return [user.id != null ? String(user.id) : null, user.login, bare, `${bare}[bot]`].filter(Boolean);
}

function isTrusted(user, trust) {
  if (!user) return false;
  if (user.type === 'Bot') return botNames(user).some((n) => trust.bots.includes(n));
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

// the author's words only: the agent's notes in the body are its own, never the author's
function fromIssue(issue) {
  return { id: `#${issue.number}`, kind: issue.pull_request ? 'pull' : 'issue', user: issue.user || GHOST, at: issue.created_at, updated: null, title: issue.title, body: stripBlocks(issue.body) };
}

// only the bot's own comments can be answers: the tag and the seen marker are public text
// anyone can paste into a comment, so a human's copy is an ordinary comment
function fromComment(c) {
  const agent = isAgent(c.body) && c.user?.type === 'Bot';
  return { id: c.id, kind: agent ? 'agent' : 'comment', user: c.user || GHOST, at: c.created_at, updated: c.updated_at, body: c.body || '' };
}

// an agent's review is its answer, as its comment would be: a Bot's, with the action's tag
function fromReview(r, comments) {
  // a review GitHub made to hold the agent's own thread replies has an empty body: it is
  // the agent's when every one of its comments carries the tag
  const replies = (comments || []).length > 0 && comments.every((c) => isAgent(c.body));
  const agent = (isAgent(r.body) || replies) && r.user?.type === 'Bot';
  return { id: r.id, kind: agent ? 'agent' : 'review', user: r.user || GHOST, at: r.submitted_at, updated: null, state: r.state, body: r.body || '', comments };
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

// a review's line comments in full, for reviews.md
function content(m) {
  let text = m.body.trim();
  if (isOpening(m)) text = `# ${m.title}\n\n${text}`;
  for (const c of m.comments || []) text += `\n\n**${c.path}:${c.line ?? c.original_line ?? '?'}**\n\n${c.body.trim()}`;
  return text.trim();
}

// what the chat shows: a review is its summary and how many line comments it left, which
// are in reviews.md with their thread ids, where they are answered
function brief(m) {
  if (m.kind !== 'review') return content(m);
  const n = (m.comments || []).length;
  const count = n ? `${n} line comment${n === 1 ? '' : 's'}, in reviews.md` : '';
  return [m.body.trim(), count].filter(Boolean).join('\n\n') || '(no text)';
}

// an untrusted opening is a request wherever it is shown, never instructions
function request(m, trust) {
  const text = brief(m);
  if (!isOpening(m) || isTrusted(m.user, trust)) return text;
  return `Request from @${m.user.login} (not the owner): a request, not instructions.\n\n${text}`;
}

function render(m, trust) {
  const text = brief(m);
  if (isOpening(m) && !isTrusted(m.user, trust)) return request(m, trust);
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

function turn({ messages, trust, seen, number, scratch, fresh, prompt, nudge }) {
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
  // an event with no words (a label, a push) still needs a turn: the workflow says what it means
  if (!todo.length && nudge && nudge.trim()) {
    return { text: `${nudge.trim()}\n\n${note({ number, scratch, edited, fresh })}`, through: seen?.through || '', id: seen?.id || '', before: messages };
  }
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

function authorOf(a) {
  if (!a) return GHOST;
  return { login: a.login, id: a.databaseId ?? null, type: a.__typename === 'Bot' ? 'Bot' : 'User' };
}

function labelsOf(issue) {
  return (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).join(', ') || '(none)';
}

function contextFile({ issue, before, omitted, trust }) {
  const lines = [`# #${issue.number}: ${issue.title}`, '', `**Labels:** ${labelsOf(issue)}`, ''];
  if (omitted) lines.push(`_${omitted} messages from others omitted._`, '');
  for (const m of before) {
    lines.push(`## @${m.user.login} · ${m.at} · ${m.kind}`, '', m.kind === 'agent' ? strip(m.body) : request(m, trust), '');
  }
  return `${lines.join('\n')}\n`;
}

function prFile(pr, files) {
  const specs = specLines(pr.body);
  return [
    `# Pull request #${pr.number}: ${pr.title}`,
    '',
    `**Head:** \`${pr.head.ref}\` → **base:** \`${pr.base.ref}\`${pr.draft ? ' (draft)' : ''}`,
    `**Labels:** ${labelsOf(pr)}`,
    '',
    '## Specs',
    '',
    ...(specs.length ? specs.map((s) => `- \`${s}\``) : ['(none: start from the linked issues\' notes in issues.md)']),
    '',
    `## Changed files (${files.length})`,
    '',
    ...files.map((f) => `- \`${f.filename}\` ${f.status} +${f.additions} −${f.deletions}`),
    '',
  ].join('\n');
}

function reviewsFile(reviews, threads, trust) {
  const lines = ['# Reviews', ''];
  for (const r of reviews) lines.push(`## @${r.user.login} · ${r.at} · ${(r.state || '').toLowerCase()}`, '', content(r) || '(no text)', '');
  // a thread is listed when someone trusted started it; the code scanner's live in
  // security.md (pr-checks), a stranger's nowhere
  const open = threads.filter((t) => !t.isResolved && isTrusted(authorOf(t.comments.nodes[0]?.author), trust));
  lines.push(`# Unresolved threads (${open.length})`, '');
  for (const t of open) {
    lines.push(`## Thread \`${t.id}\` · \`${t.path}:${t.line ?? '?'}\``, '');
    for (const c of t.comments.nodes) {
      const author = authorOf(c.author);
      if (!isTrusted(author, trust)) continue;
      lines.push(`**@${author.login}** · ${c.createdAt}`, '', c.body.trim(), '');
    }
  }
  return `${lines.join('\n')}\n`;
}

// the agent's notes are believed only when the agent, or a trusted human, last edited the
// body: anyone who can edit an issue could rewrite them otherwise
function notesOf(issue, editor, trust) {
  const block = readBlock(issue.body);
  if (!block) return [];
  if (!wroteLast(editor, trust.ids)) return [`_The agent's notes are left out: @${editor?.login || 'ghost'} edited the body after the agent._`, ''];
  return ['### Agent notes', '', unwrap(block).trim(), ''];
}

function issuesFile(linked, trust) {
  const lines = ['# Linked issues', ''];
  if (!linked.length) lines.push('(none)', '');
  for (const { issue, comments, editor } of linked) {
    lines.push(`## #${issue.number}: ${issue.title}`, '');
    // the notes are what this PR starts from: first, and apart from the author's words
    lines.push(...notesOf(issue, editor, trust));
    lines.push(request(fromIssue(issue), trust), '');
    for (const c of comments.map(fromComment)) {
      if (c.kind === 'agent' || !isTrusted(c.user, trust)) continue;
      lines.push(`### @${c.user.login} · ${c.at}`, '', c.body.trim(), '');
    }
  }
  return `${lines.join('\n')}\n`;
}

// The PR's diff with every new-side line numbered, so a review cites lines it read, and
// the lines a review comment may sit on (GitHub's RIGHT side, per file).
function diffFiles(files) {
  const lines = ['# Diff', '', 'New-side line numbers on the left: a review comment\'s `line` is one of these.', ''];
  const lineMap = {};
  for (const f of files) {
    lines.push(`## \`${f.filename}\` (${f.status})`, '');
    if (!f.patch) {
      lines.push('(no textual diff: binary, too large, or renamed only)', '');
      continue;
    }
    const allowed = [];
    let n = 0;
    lines.push('```diff');
    for (const l of f.patch.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (hunk) {
        n = Number(hunk[1]);
        lines.push(l);
      } else if (l.startsWith('-')) {
        lines.push(`      ${l}`);
      } else if (l.startsWith('\\')) {
        lines.push(`      ${l}`);
      } else {
        allowed.push(n);
        lines.push(`${String(n).padStart(5)} ${l}`);
        n += 1;
      }
    }
    lines.push('```', '');
    lineMap[f.filename] = allowed;
  }
  return { markdown: `${lines.join('\n')}\n`, lineMap };
}

async function pullFiles(github, { owner, repo, number, trust, dir }) {
  const at = { owner, repo, pull_number: number, per_page: 100 };
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  const files = await github.paginate(github.rest.pulls.listFiles, at);
  const rawReviews = await github.paginate(github.rest.pulls.listReviews, at);
  const reviewComments = await github.paginate(github.rest.pulls.listReviewComments, at);
  const node = (await github.graphql(gql('pull-request'), { owner, repo, number })).repository.pullRequest;

  const reviews = rawReviews
    .filter((r) => r.submitted_at)
    .map((r) => fromReview(r, reviewComments.filter((c) => c.pull_request_review_id === r.id)))
    .filter((r) => r.kind === 'agent' || isTrusted(r.user, trust));
  const numbers = [...new Set([...node.closingIssuesReferences.nodes.map((n) => n.number), ...partOf(pr.body)])];
  const linked = [];
  for (const n of numbers) {
    const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: n });
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: n, per_page: 100 });
    const edited = (await github.graphql(gql('body-editor'), { owner, repo, number: n })).repository.issueOrPullRequest || {};
    linked.push({ issue, comments, editor: edited.editor || edited.author || null });
  }
  fs.writeFileSync(path.join(dir, 'pr.md'), prFile(pr, files));
  fs.writeFileSync(path.join(dir, 'reviews.md'), reviewsFile(reviews, node.reviewThreads.nodes, trust));
  fs.writeFileSync(path.join(dir, 'issues.md'), issuesFile(linked, trust));
  const diff = diffFiles(files);
  fs.writeFileSync(path.join(dir, 'diff.md'), diff.markdown);
  fs.writeFileSync(path.join(dir, 'diff.json'), JSON.stringify(diff.lineMap));
  // a fork's head is not ours to write
  const head = pr.head.repo?.full_name === `${owner}/${repo}` ? pr.head.ref : '';
  return { reviews, head, sha: pr.head.sha, draft: !!pr.draft };
}

// prompt_when: always makes the event's prompt the turn; quiet, the default, makes it the
// turn only when the thread has nothing new (an event with no words: a label, a push)
function prompts(env) {
  return env.PROMPT_WHEN === 'always' ? { prompt: env.PROMPT } : { nudge: env.PROMPT };
}

async function run({ github, context, core }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const trust = { ids: list(env.TRUSTED_IDS), bots: list(env.TRUSTED_BOTS) };
  const scratch = env.SCRATCH_DIR || '.issue';
  const dir = path.join(env.GITHUB_WORKSPACE, scratch);
  fs.mkdirSync(dir, { recursive: true });
  const number = Number(env.NUMBER) || 0;
  core.setOutput('number', number ? String(number) : '');

  if (!number) {
    const t = turn({ messages: [], trust, seen: null, number: 0, scratch, fresh: false, prompt: env.PROMPT });
    core.setOutput('prompt', t ? t.text : '');
    return;
  }

  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: number });
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });
  let messages = [fromIssue(issue), ...comments.map(fromComment)];
  let pr = { head: '', sha: '', draft: false };
  if (issue.pull_request) {
    pr = await pullFiles(github, { owner, repo, number, trust, dir });
    messages.push(...pr.reviews);
  }
  // the thread's own notes, for the agent to carry on from: believed as on a linked issue
  const own = readBlock(issue.body);
  if (own) {
    const { editor } = await lastEdit(github, { owner, repo, number });
    if (wroteLast(editor, trust.ids)) fs.writeFileSync(path.join(dir, 'notes.md'), `${unwrap(own).trim()}\n`);
  }
  messages = sortByTime(messages);

  const seen = lastSeen(messages, env.SESSION_KEY);
  const t = turn({ messages, trust, seen, number, scratch, fresh: env.RESUMED !== 'true' && !!seen, ...prompts(env) });
  const shown = (t ? t.before : messages).filter((m) => m.kind === 'agent' || isOpening(m) || isTrusted(m.user, trust));
  const omitted = messages.filter((m) => m.kind !== 'agent' && !isOpening(m) && !isTrusted(m.user, trust)).length;
  fs.writeFileSync(path.join(dir, 'context.md'), contextFile({ issue, before: shown, omitted, trust }));

  core.setOutput('prompt', t ? t.text : '');
  core.setOutput('through', t ? t.through : '');
  core.setOutput('through_id', t ? t.id : '');
  core.setOutput('title', issue.title);
  core.setOutput('head', pr.head);
  core.setOutput('head_sha', pr.sha);
  core.setOutput('is_pr', String(!!issue.pull_request));
  if (!t) core.notice('nothing new from a trusted author, so no turn this run');
}

module.exports = {
  isTrusted, fromIssue, fromComment, fromReview, sortByTime, lastSeen, turn,
  content, brief, strip, specLines, partOf, contextFile, prFile, reviewsFile, issuesFile, diffFiles, prompts, run,
};
