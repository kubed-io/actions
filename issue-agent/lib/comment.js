// Every comment the action posts: the "Working on it…" placeholder, the reply it becomes,
// and the note that replaces it when the run does not finish. On a live turn n8n may have
// moved the placeholder, so the reply and the note find it by its run (live.js).

const fs = require('fs');
const path = require('path');
const { TAG, seenMarker, placeholderMarker } = require('./state');
const { fillHeader, wikisOf, linkTo } = require('./header');
const { settle } = require('./live');

const SPINNER = '<img src="https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />';

// A dispatch's prompt is quoted above the answer, so the thread reads as it happened. A
// slash command (an MCP prompt) is an instruction to the agent, not words in the thread.
function quote(prompt) {
  const text = (prompt || '').trim();
  if (!text || text.startsWith('/')) return '';
  return `${text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
}

function placeholder({ prompt, runUrl, runId }) {
  const marker = runId ? `${placeholderMarker(runId)}\n` : '';
  return `${TAG}\n${marker}${quote(prompt)}Working on it… ${SPINNER}\n\n<sub>[Follow the run](${runUrl})</sub>`;
}

function reply({ prompt, header, text, runUrl, seen }) {
  const head = header ? `${header}\n\n` : '';
  const tail = seen && seen.through ? `\n${seenMarker(seen)}` : '';
  return `${TAG}\n${head}${quote(prompt)}${text.trim()}\n\n<sub>[Run](${runUrl})</sub>${tail}`;
}

function failure({ prompt, runUrl }) {
  return `${TAG}\n${quote(prompt)}⚠️ I didn't finish this one. [See the run](${runUrl}) for what went wrong.`;
}

// the workflow's template, filled from this run and the role's output
function headerOf(env) {
  const structured = env.STRUCTURED_FILE && fs.existsSync(env.STRUCTURED_FILE) ? JSON.parse(fs.readFileSync(env.STRUCTURED_FILE, 'utf8')) : {};
  return fillHeader(env.HEADER, {
    output: structured?.output,
    run_url: env.RUN_URL,
    session_id: env.SESSION_ID,
    number: env.NUMBER,
    blob: env.BLOB,
  }, { link: linkTo({ blob: env.BLOB, wikis: wikisOf(gitmodules(env)) }) });
}

// the checkout's .gitmodules, for links into a wiki submodule; empty when there is none
function gitmodules(env) {
  const file = path.join(env.GITHUB_WORKSPACE || '.', '.gitmodules');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

async function post(github, { owner, repo, issue_number, comment_id, body }) {
  if (comment_id) return github.rest.issues.updateComment({ owner, repo, comment_id, body });
  return github.rest.issues.createComment({ owner, repo, issue_number, body });
}

async function run({ github, context, core }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const live = env.LIVE === 'true';
  const where = { owner, repo, issue_number: Number(env.NUMBER), comment_id: Number(env.COMMENT_ID) || 0 };

  if (env.MODE === 'ack') {
    const body = placeholder({ prompt: env.PROMPT, runUrl: env.RUN_URL, runId: live ? context.runId : 0 });
    const { data } = await github.rest.issues.createComment({ owner, repo, issue_number: where.issue_number, body });
    core.setOutput('comment_id', String(data.id));
    return;
  }
  if (env.MODE === 'failure') {
    if (live) {
      // a lookup that fails still takes the spinner down where it was first posted
      try {
        where.comment_id = (await settle({ github, context, env })).commentId;
      } catch (e) {
        core.warning(`the placeholder was not looked up (${e.message}); the note goes on the first one`);
      }
    }
    await post(github, { ...where, body: failure({ prompt: env.PROMPT, runUrl: env.RUN_URL }) });
    return;
  }
  if (!(env.REPLY || '').trim()) {
    core.setFailed('the agent wrote no reply');
    return;
  }
  let seen = { key: env.SESSION_KEY, through: env.THROUGH, id: env.THROUGH_ID };
  if (live) ({ commentId: where.comment_id, seen } = await settle({ github, context, env, seen }));
  const body = () => reply({ prompt: env.PROMPT, header: headerOf(env), text: env.REPLY, runUrl: env.RUN_URL, seen });
  let data;
  try {
    ({ data } = await post(github, { ...where, body: body() }));
  } catch (e) {
    // n8n moved the placeholder between the lookup and the edit: once more
    if (!live || e.status !== 404) throw e;
    ({ commentId: where.comment_id, seen } = await settle({ github, context, env, seen: { key: env.SESSION_KEY, through: env.THROUGH, id: env.THROUGH_ID } }));
    ({ data } = await post(github, { ...where, body: body() }));
  }
  // a cancel that lands after this must not overwrite the posted reply
  core.setOutput('posted', 'true');
  // not the placeholder's first id when n8n moved it, or none was left
  if (live) core.setOutput('comment_id', String(data.id));
}

module.exports = { placeholder, reply, failure, headerOf, run };
