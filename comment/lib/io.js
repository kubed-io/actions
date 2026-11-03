// What actions/github-script would hand a script, for a node action with no dependencies:
// `github` as much of Octokit as comment.js uses, on fetch; `core` on the runner's files.

const crypto = require('crypto');
const fs = require('fs');

function client(token, env = process.env) {
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  async function call(method, route, body) {
    const res = await fetch(`${api}${route}`, { method, headers, body: body && JSON.stringify(body) });
    if (!res.ok) throw Object.assign(new Error(`${method} ${route}: ${res.status} ${await res.text()}`), { status: res.status });
    return { data: res.status === 204 ? null : await res.json() };
  }
  const at = ({ owner, repo }) => `/repos/${owner}/${repo}/issues`;
  const issues = {
    createComment: (p) => call('POST', `${at(p)}/${p.issue_number}/comments`, { body: p.body }),
    updateComment: (p) => call('PATCH', `${at(p)}/comments/${p.comment_id}`, { body: p.body }),
    deleteComment: (p) => call('DELETE', `${at(p)}/comments/${p.comment_id}`),
    listComments: (p) => call('GET', `${at(p)}/${p.issue_number}/comments?per_page=${p.per_page || 30}&page=${p.page || 1}`),
  };
  async function paginate(fn, params) {
    const all = [];
    for (let page = 1; ; page += 1) {
      const { data } = await fn({ ...params, page });
      all.push(...data);
      if (data.length < (params.per_page || 30)) return all;
    }
  }
  return { rest: { issues }, paginate };
}

// GITHUB_OUTPUT and GITHUB_STATE take `name<<delimiter` blocks, so a value may hold anything
function append(file, name, value) {
  const d = `ghadelimiter_${crypto.randomUUID()}`;
  fs.appendFileSync(file, `${name}<<${d}\n${value}\n${d}\n`);
}

function core(env = process.env) {
  return {
    setOutput: (name, value) => append(env.GITHUB_OUTPUT, name, value),
    saveState: (name, value) => append(env.GITHUB_STATE, name, value),
    info: (m) => console.log(m),
    warning: (m) => console.log(`::warning::${m}`),
    setFailed: (m) => {
      console.log(`::error::${m}`);
      process.exitCode = 1;
    },
  };
}

function context(env = process.env) {
  const [owner, repo] = (env.GITHUB_REPOSITORY || '/').split('/');
  return { repo: { owner, repo }, runId: Number(env.GITHUB_RUN_ID) };
}

// one step of comment.js; a post step never fails the job, it warns
async function main(step, { soft = false } = {}) {
  const env = process.env;
  const out = core(env);
  try {
    await require('./comment')[step]({ github: client(env.INPUT_GITHUB_TOKEN, env), context: context(env), core: out, env });
  } catch (e) {
    if (soft) out.warning(`comment/${step}: ${e.message}`);
    else out.setFailed(e.message);
  }
}

module.exports = { client, core, context, main };
