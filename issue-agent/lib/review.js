// On a pull request, a reply with line comments is posted as one review, the way Copilot
// reviews: the reply is the review's body and the comments sit under it, on the lines of
// the diff the agent read. Always a COMMENT; the verdicts are a human's.
//
// GitHub refuses a whole review for one comment off the diff, so each comment is checked
// against the diff Gather saw ({scratch}/diff.json): one off it moves into the body. If
// GitHub refuses anyway, the review goes once more with every comment in the body; if
// that fails too, nothing is posted here and the Reply step posts a plain comment.
//
// The review is of the commit the checkout is at when the agent ends: a push brought in
// during the turn moved it past the head Gather read, so the review goes on that commit,
// with the lines of its own diff.

const fs = require('fs');
const { reply, headerOf } = require('./comment');
const { settle } = require('./live');
const { diffFiles } = require('./thread');
const { compareFiles } = require('../../git/lib/util');

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

// every line of the range must be one the diff shows on its new side: one hunk, unbroken
function onDiff(c, lineMap) {
  const lines = lineMap[c.path];
  if (!lines) return false;
  const start = c.start_line ?? c.line;
  if (!(start <= c.line)) return false;
  const set = new Set(lines);
  for (let n = start; n <= c.line; n += 1) if (!set.has(n)) return false;
  return true;
}

function split(comments, lineMap) {
  const inline = [];
  const outside = [];
  for (const c of comments) (onDiff(c, lineMap) ? inline : outside).push(c);
  return { inline, outside };
}

function outsideSection(outside) {
  if (!outside.length) return '';
  const items = outside.map((c) => {
    const where = c.start_line && c.start_line !== c.line ? `${c.path}:${c.start_line}-${c.line}` : `${c.path}:${c.line}`;
    return `- **\`${where}\`**: ${commentBody(c).replace(/\n/g, '\n  ')}`;
  });
  return `\n\n**Outside the diff**\n\n${items.join('\n')}`;
}

function toGithub(c) {
  const out = { path: c.path, line: c.line, side: 'RIGHT', body: commentBody(c) };
  if (c.start_line && c.start_line !== c.line) Object.assign(out, { start_line: c.start_line, start_side: 'RIGHT' });
  return out;
}

// the commit the checkout is at, Gather's head when there is no checkout to ask
async function checkedOut(exec, env) {
  if (!exec) return env.HEAD_SHA || '';
  const { stdout } = await exec.getExecOutput('git', ['rev-parse', 'HEAD'], { cwd: env.GITHUB_WORKSPACE, silent: true, ignoreReturnCode: true });
  return (stdout || '').trim() || env.HEAD_SHA || '';
}

// the lines a comment may sit on: Gather's diff, or for a commit it did not read, the PR's
// diff at that commit (its base...it), built as Gather builds it. None when that cannot be
// read: every comment then goes in the body.
async function lineMapFor({ github, core, owner, repo, env, sha }) {
  if (sha === env.HEAD_SHA) return env.DIFF_FILE && fs.existsSync(env.DIFF_FILE) ? JSON.parse(fs.readFileSync(env.DIFF_FILE, 'utf8')) : {};
  try {
    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: Number(env.NUMBER) });
    return diffFiles(await compareFiles(github, owner, repo, `${pr.base.ref}...${sha}`)).lineMap;
  } catch (e) {
    core.warning(`the diff at ${sha} could not be read (${e.message}); every comment goes in the review's body`);
    return {};
  }
}

async function run({ github, context, core, exec }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  core.setOutput('posted', 'false');
  const sha = await checkedOut(exec, env);
  core.setOutput('reviewed_sha', sha);
  const structured = env.STRUCTURED_FILE && fs.existsSync(env.STRUCTURED_FILE) ? JSON.parse(fs.readFileSync(env.STRUCTURED_FILE, 'utf8')) : {};
  const comments = (structured?.review?.comments || []).filter((c) => c && c.path && Number.isInteger(c.line) && (c.body || '').trim());
  if (!comments.length || !(env.REPLY || '').trim()) return;
  if (sha !== env.HEAD_SHA) core.info(`the checkout moved from ${env.HEAD_SHA} to ${sha} during the turn: the review is on ${sha}`);
  const lineMap = await lineMapFor({ github, core, owner, repo, env, sha });
  let seen = { key: env.SESSION_KEY, through: env.THROUGH, id: env.THROUGH_ID };
  // on a live turn the placeholder is wherever n8n last moved it
  let placeholderId = Number(env.COMMENT_ID) || 0;
  if (env.LIVE === 'true') ({ commentId: placeholderId, seen } = await settle({ github, context, env, seen }));
  const bodyFor = (outside) => reply({ prompt: env.PROMPT, header: headerOf(env), text: `${env.REPLY.trim()}${outsideSection(outside)}`, runUrl: env.RUN_URL, seen });
  const at = { owner, repo, pull_number: Number(env.NUMBER), commit_id: sha, event: 'COMMENT' };

  const { inline, outside } = split(comments, lineMap);
  let review = null;
  try {
    ({ data: review } = await github.rest.pulls.createReview({ ...at, body: bodyFor(outside), comments: inline.map(toGithub) }));
  } catch (e) {
    core.warning(`GitHub refused the review (${e.message}); posting it again with every comment in its body`);
    try {
      ({ data: review } = await github.rest.pulls.createReview({ ...at, body: bodyFor(comments), comments: [] }));
    } catch (e2) {
      core.warning(`GitHub refused that too (${e2.message}); the reply goes as a comment`);
      return;
    }
  }
  // the review is the one response: the placeholder comment goes
  if (placeholderId) await github.rest.issues.deleteComment({ owner, repo, comment_id: placeholderId });
  core.setOutput('posted', 'true');
  core.setOutput('review_id', String(review.id));
  core.info(`review ${review.id}: ${inline.length} on the diff, ${outside.length} outside it`);
}

module.exports = { fence, commentBody, onDiff, split, outsideSection, toGithub, run };
