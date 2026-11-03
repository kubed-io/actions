// The thread comment comment/start opens and comment/end writes once, and what the steps
// between leave for it, in ${RUNNER_TEMP}/issue-comment/<number>/:
//
//   comment.json      comment/start's: the placeholder's first id and the run link
//   parts/NN-name.md  a step's piece of the answer, markdown; joined in name order
//   seen.json         the seen marker of each session that answered, in answer order
//   final.json        comment/end's: the comment is written, so start's post does nothing
//
// Only the file system: no GitHub, so issue-agent, land and the comment actions share it.

const fs = require('fs');
const os = require('os');
const path = require('path');

function dirOf(env, number) {
  return path.join(env.RUNNER_TEMP || os.tmpdir(), 'issue-comment', String(Number(number) || 0));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// a second comment/start on the same thread in one job starts from nothing
function open(dir, info) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'parts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'comment.json'), JSON.stringify(info));
}

function commentOf(dir) {
  return readJson(path.join(dir, 'comment.json'), null);
}

// numbered by arrival, so the comment reads in the order the steps ran
function addPart(dir, name, text) {
  const at = path.join(dir, 'parts');
  fs.mkdirSync(at, { recursive: true });
  const n = fs.readdirSync(at).filter((f) => f.endsWith('.md')).length + 1;
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';
  const file = path.join(at, `${String(n).padStart(2, '0')}-${slug}.md`);
  fs.writeFileSync(file, `${String(text).trim()}\n`);
  return file;
}

function partsOf(dir) {
  const at = path.join(dir, 'parts');
  if (!fs.existsSync(at)) return [];
  return fs.readdirSync(at).filter((f) => f.endsWith('.md')).sort()
    .map((f) => fs.readFileSync(path.join(at, f), 'utf8').trim())
    .filter(Boolean);
}

// one entry per session key: a later turn of the same session moves its own forward
function addSeen(dir, seen, answered = new Date().toISOString()) {
  if (!seen?.through) return;
  const all = seenOf(dir).filter((s) => s.key !== seen.key || s.through > seen.through);
  if (all.some((s) => s.key === seen.key)) return;
  all.push({ key: seen.key, through: seen.through, id: seen.id, answered });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'seen.json'), JSON.stringify(all));
}

function seenOf(dir) {
  const all = readJson(path.join(dir, 'seen.json'), []);
  return Array.isArray(all) ? all : [];
}

function finalize(dir, commentId) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'final.json'), JSON.stringify({ comment_id: commentId || 0 }));
}

function isFinal(dir) {
  return fs.existsSync(path.join(dir, 'final.json'));
}

module.exports = { dirOf, open, commentOf, addPart, partsOf, addSeen, seenOf, finalize, isFinal };
