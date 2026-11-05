// comment/start and comment/end: one thread comment for a whole job. Start posts
// issue-agent's "Working on it…"; the steps between leave parts (parts.js); end writes them
// as the answer, once. When end never does, start's post turns it into the failure note.
//
// The comment is found the way issue-agent and n8n find it: the newest placeholder of this
// run, since n8n reposts it under each in-flight reply. One without the run's marker (`live:
// false`) never moves, so its id is enough.
//
// With line comments (lines.js) the answer is one review instead: the same body, the comments
// under it, and the placeholder goes. Either way, one post.

const { placeholder, reply, failure } = require('../../issue-agent/lib/comment');
const { seenMarker } = require('../../issue-agent/lib/state');
const { findPlaceholder } = require('../../issue-agent/lib/live');
const parts = require('./parts');
const lines = require('./lines');

// the answer: the parts as one reply, a seen marker for each session that answered
function answerBody({ texts, runUrl, seen }) {
  return `${reply({ text: texts.join('\n\n'), runUrl })}${markers(seen)}`;
}

// what finished is kept, and its sessions' markers with it: their messages were answered
function failureBody({ prompt, texts, runUrl, seen }) {
  return `${failure({ prompt, runUrl, text: texts.join('\n\n') })}${texts.length ? markers(seen) : ''}`;
}

function markers(seen) {
  return seen.map(({ key, through, id }) => `\n${seenMarker({ key, through, id })}`).join('');
}

// the newest placeholder of this run, or the id last known
async function locate({ github, context, number, known }) {
  const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: number, per_page: 100 });
  return findPlaceholder(comments, context.runId)?.id || known || 0;
}

// an edit of a comment n8n moved meanwhile is looked up once more; none left, a new one
async function write({ github, context, number, known, body }) {
  let id = await locate({ github, context, number, known });
  for (let i = 0; i < 2 && id; i += 1) {
    try {
      return (await github.rest.issues.updateComment({ ...context.repo, comment_id: id, body })).data;
    } catch (e) {
      if (e.status !== 404) throw e;
      id = await locate({ github, context, number, known: 0 });
    }
  }
  return (await github.rest.issues.createComment({ ...context.repo, issue_number: number, body })).data;
}

function runUrlOf(env) {
  return env.INPUT_RUN_URL || `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

async function start({ github, context, core, env = process.env }) {
  const number = Number(env.INPUT_NUMBER);
  if (!number) throw new Error('no issue or pull request: give `number`');
  const runUrl = runUrlOf(env);
  const live = env.INPUT_LIVE !== 'false';
  const body = placeholder({ prompt: env.INPUT_PROMPT, runUrl, runId: live ? context.runId : 0 });
  const { data } = await github.rest.issues.createComment({ ...context.repo, issue_number: number, body });
  const dir = parts.dirOf(env, number);
  parts.open(dir, { comment_id: data.id, number, run_url: runUrl });
  core.saveState('dir', dir);
  core.setOutput('comment_id', String(data.id));
  core.setOutput('number', String(number));
}

// the end of the job: a comment comment/end did not write never keeps its spinner
async function post({ github, context, core, env = process.env }) {
  const dir = env.STATE_dir;
  if (!dir) return;
  if (parts.isFinal(dir)) return core.info('comment/end wrote the comment');
  const info = parts.commentOf(dir);
  if (!info) return;
  const body = failureBody({ prompt: env.INPUT_PROMPT, texts: parts.partsOf(dir), runUrl: info.run_url, seen: parts.seenOf(dir) });
  const data = await write({ github, context, number: info.number, known: info.comment_id, body });
  core.warning(`comment/end did not run: comment ${data.id} says so`);
}

// the placeholder, wherever it is now; already gone is fine
async function remove({ github, context, number, known }) {
  const id = await locate({ github, context, number, known });
  try {
    if (id) await github.rest.issues.deleteComment({ ...context.repo, comment_id: id });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
}

async function end({ github, context, core, env = process.env }) {
  const number = Number(env.INPUT_NUMBER);
  const dir = parts.dirOf(env, number);
  const info = parts.commentOf(dir);
  if (!info) throw new Error(`no comment/start for #${number} in this job`);
  if (parts.isFinal(dir)) throw new Error(`the comment on #${number} is already written`);
  const known = Number(env.INPUT_COMMENT_ID) || info.comment_id;
  const texts = parts.partsOf(dir);
  core.setOutput('review_id', '');
  // nothing was said: no answer, and no spinner left behind
  if (!texts.length) {
    await remove({ github, context, number, known });
    parts.finalize(dir, 0);
    core.setOutput('comment_id', '');
    return core.info('no step left a part: the placeholder is gone');
  }
  const seen = parts.seenOf(dir);
  const bodyWith = (extra) => answerBody({ texts: extra ? [...texts, extra] : texts, runUrl: info.run_url, seen });
  const said = parts.linesOf(dir);
  if (said?.inline.length) {
    const review = await lines.postReview({ github, context, core, number, lines: said, bodyWith });
    if (review) {
      await remove({ github, context, number, known });
      parts.finalize(dir, 0);
      core.setOutput('comment_id', '');
      core.setOutput('review_id', String(review.id));
      return core.info(`review ${review.id}: ${texts.length} part(s), ${said.inline.length} line comment(s)`);
    }
  }
  // no review: any line comments are listed in the comment
  const all = said ? [...said.inline, ...said.outside] : [];
  const body = bodyWith(lines.listed(all, said?.inline.length ? 'Line comments' : 'Outside the diff'));
  const data = await write({ github, context, number, known, body });
  parts.finalize(dir, data.id);
  core.setOutput('comment_id', String(data.id));
  core.info(`comment ${data.id}: ${texts.length} part(s)`);
}

module.exports = { answerBody, failureBody, locate, write, start, post, end };
