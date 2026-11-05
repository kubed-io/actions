// On a pull request, the agent's line comments go to comment/end, which posts the answer as
// one review with them under it (comment/lib/lines.js). This step only says which are on the
// diff the agent read and which are off it: GitHub refuses a whole review for one comment it
// will not place, so the off ones are listed in the body instead.
//
// The comments are on the commit the checkout is at when the agent ends: a push brought in
// during the turn moved it past the head Gather read, so they are placed on that commit's diff.

const fs = require('fs');
const parts = require('../../comment/lib/parts');
const { diffFiles } = require('./thread');
const { compareFiles } = require('../../git/lib/util');

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

// the commit the checkout is at, Gather's head when there is no checkout to ask
async function checkedOut(exec, env) {
  if (!exec) return env.HEAD_SHA || '';
  const { stdout } = await exec.getExecOutput('git', ['rev-parse', 'HEAD'], { cwd: env.GITHUB_WORKSPACE, silent: true, ignoreReturnCode: true });
  return (stdout || '').trim() || env.HEAD_SHA || '';
}

// the lines a comment may sit on: Gather's diff, or for a commit it did not read, the PR's
// diff at that commit (its base...it), built as Gather builds it. None when that cannot be
// read: every comment is then listed in the body.
async function lineMapFor({ github, core, owner, repo, env, sha }) {
  if (sha === env.HEAD_SHA) return env.DIFF_FILE && fs.existsSync(env.DIFF_FILE) ? JSON.parse(fs.readFileSync(env.DIFF_FILE, 'utf8')) : {};
  try {
    const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: Number(env.NUMBER) });
    return diffFiles(await compareFiles(github, owner, repo, `${pr.base.ref}...${sha}`)).lineMap;
  } catch (e) {
    core.warning(`the diff at ${sha} could not be read (${e.message}); every comment goes in the body`);
    return {};
  }
}

async function run({ github, context, core, exec, env = process.env }) {
  const { owner, repo } = context.repo;
  const sha = await checkedOut(exec, env);
  core.setOutput('reviewed_sha', sha);
  const structured = env.STRUCTURED_FILE && fs.existsSync(env.STRUCTURED_FILE) ? JSON.parse(fs.readFileSync(env.STRUCTURED_FILE, 'utf8')) : {};
  const comments = (structured?.review?.comments || []).filter((c) => c && c.path && Number.isInteger(c.line) && (c.body || '').trim());
  if (!comments.length) return core.info('no line comments');
  if (sha !== env.HEAD_SHA) core.info(`the checkout moved from ${env.HEAD_SHA} to ${sha} during the turn: the comments are on ${sha}`);
  const { inline, outside } = split(comments, await lineMapFor({ github, core, owner, repo, env, sha }));
  parts.addLines(parts.dirOf(env, env.NUMBER), { commit_id: sha, inline, outside });
  core.info(`${inline.length} line comment(s) on the diff, ${outside.length} outside it, for comment/end`);
}

module.exports = { run, onDiff, split };
