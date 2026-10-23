// The agent's notes on a thread, kept in its body: the one piece of state the action
// keeps. Every turn returns `notes` whole; they land in one collapsed block after the
// author's text, replaced in place, and are read back next turn ({scratch}/notes.md) and
// by a PR's issues.md.

const fs = require('fs');

const NOTES = 'notes';
// GitHub refuses a body over 65536 characters; the rest of the body keeps its room
const LIMIT = 65000;

const open = (name) => `<!-- issue-agent-block:${name} -->`;
const close = (name) => `<!-- /issue-agent-block:${name} -->`;

// the agent's text can never open or close a marker of its own
function escape(text) {
  return String(text).replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
}

function find(body, name) {
  const text = body || '';
  const start = text.indexOf(open(name));
  if (start === -1) return null;
  const end = text.indexOf(close(name), start);
  if (end === -1) return null;
  return { start, end: end + close(name).length, inner: text.slice(start + open(name).length, end).trim() };
}

function readBlock(body, name = NOTES) {
  return find(body, name)?.inner ?? null;
}

function removeBlock(body, name) {
  const at = find(body, name);
  if (!at) return body || '';
  return `${body.slice(0, at.start).trimEnd()}\n\n${body.slice(at.end).trimStart()}`.trim();
}

// the body as its author wrote it, with the agent's notes taken out
function stripBlocks(body) {
  return removeBlock(body || '', NOTES);
}

// in place when the block is there; otherwise before any older agent section, or last
function writeBlock(body, name, inner) {
  const text = body || '';
  const block = `${open(name)}\n${inner}\n${close(name)}`;
  const at = find(text, name);
  if (at) return `${text.slice(0, at.start)}${block}${text.slice(at.end)}`;
  const section = text.search(/<!-- issue-agent:[\w-]+ -->/);
  if (section === -1) return text.trim() ? `${text.trimEnd()}\n\n${block}\n` : `${block}\n`;
  return `${text.slice(0, section).trimEnd()}\n\n${block}\n\n${text.slice(section)}`;
}

function details(summary, text) {
  return `<details>\n<summary>${summary}</summary>\n\n${text.trim()}\n\n</details>`;
}

// the notes' own text, out of the collapsed block
function unwrap(inner) {
  const m = /<details>\s*<summary>[\s\S]*?<\/summary>\s*([\s\S]*?)\s*<\/details>\s*$/.exec(inner || '');
  return m ? m[1] : (inner || '');
}

function fit(text, room) {
  if (text.length <= room) return text;
  const cut = `\n\n_Cut at ${room} of ${text.length} characters to fit the body._`;
  return `${text.slice(0, Math.max(0, room - cut.length))}${cut}`;
}

function stamp(now) {
  return `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function withNotes(body, notes, now) {
  if (typeof notes !== 'string' || !notes.trim()) return body || '';
  const room = LIMIT - removeBlock(body || '', NOTES).length - 200;
  return writeBlock(body, NOTES, details(`🗒️ Agent notes · ${stamp(now)}`, fit(escape(notes.trim()), room)));
}

async function run({ github, context, core }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const issue_number = Number(env.NUMBER) || 0;
  if (!issue_number || !env.STRUCTURED_FILE || !fs.existsSync(env.STRUCTURED_FILE)) return;
  const { notes } = JSON.parse(fs.readFileSync(env.STRUCTURED_FILE, 'utf8')) || {};
  const { data: thread } = await github.rest.issues.get({ owner, repo, issue_number });
  const body = withNotes(thread.body, notes, new Date());
  if (body === (thread.body || '')) return;
  await github.rest.issues.update({ owner, repo, issue_number, body });
  core.setOutput('kept', 'true');
}

module.exports = { NOTES, LIMIT, escape, readBlock, stripBlocks, writeBlock, unwrap, withNotes, run };
