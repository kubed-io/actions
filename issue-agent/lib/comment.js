// Every comment the action posts: the "Working on it…" placeholder, the reply it becomes,
// and the note that replaces it when the run does not finish.

const { TAG, seenMarker } = require('./state');

const SPINNER = '<img src="https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />';

// A dispatch's prompt is quoted above the answer, so the thread reads as it happened
function quote(prompt) {
  const text = (prompt || '').trim();
  return text ? `${text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n` : '';
}

function placeholder({ prompt, runUrl }) {
  return `${TAG}\n${quote(prompt)}Working on it… ${SPINNER}\n\n<sub>[Follow the run](${runUrl})</sub>`;
}

function reply({ prompt, header, text, runUrl, seen }) {
  const head = header ? `> ${header}\n\n` : '';
  const tail = seen && seen.through ? `\n${seenMarker(seen)}` : '';
  return `${TAG}\n${head}${quote(prompt)}${text.trim()}\n\n<sub>[Run](${runUrl})</sub>${tail}`;
}

function failure({ prompt, runUrl }) {
  return `${TAG}\n${quote(prompt)}⚠️ I didn't finish this one. [See the run](${runUrl}) for what went wrong.`;
}

async function post(github, { owner, repo, issue_number, comment_id, body }) {
  if (comment_id) return github.rest.issues.updateComment({ owner, repo, comment_id, body });
  return github.rest.issues.createComment({ owner, repo, issue_number, body });
}

async function run({ github, context, core }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const where = { owner, repo, issue_number: Number(env.NUMBER), comment_id: Number(env.COMMENT_ID) || 0 };

  if (env.MODE === 'ack') {
    const { data } = await github.rest.issues.createComment({ owner, repo, issue_number: where.issue_number, body: placeholder({ prompt: env.PROMPT, runUrl: env.RUN_URL }) });
    core.setOutput('comment_id', String(data.id));
    return;
  }
  if (env.MODE === 'failure') {
    await post(github, { ...where, body: failure({ prompt: env.PROMPT, runUrl: env.RUN_URL }) });
    return;
  }
  if (!(env.REPLY || '').trim()) {
    core.setFailed('the agent wrote no reply');
    return;
  }
  const seen = { key: env.SESSION_KEY, through: env.THROUGH, id: env.THROUGH_ID };
  await post(github, { ...where, body: reply({ prompt: env.PROMPT, header: env.HEADER, text: env.REPLY, runUrl: env.RUN_URL, seen }) });
}

module.exports = { placeholder, reply, failure, run };
