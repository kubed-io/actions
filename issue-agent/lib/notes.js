// The agent's notes on a thread, kept in its body: what the PR side starts from. Every turn
// returns `notes` whole (an overview, findings, a mini plan); an issue's turn may also
// return a draft of the document. Each lands in its own collapsed block, between the
// human's text and the document's state section, so a section write keeps them and the
// PR's issues.md reads them with the issue.

const fs = require('fs');

const NOTES = 'notes';
const DRAFT = 'draft';
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

function readBlock(body, name) {
  return find(body, name)?.inner ?? null;
}

function removeBlock(body, name) {
  const at = find(body, name);
  if (!at) return body || '';
  return `${body.slice(0, at.start).trimEnd()}\n\n${body.slice(at.end).trimStart()}`.trim();
}

// the body as its author wrote it, with the agent's blocks taken out
function stripBlocks(body) {
  return removeBlock(removeBlock(body || '', NOTES), DRAFT);
}

// in place when the block is there; otherwise before the first document section, or last
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

function fit(text, room, why) {
  if (text.length <= room) return text;
  const cut = `\n\n_Cut at ${room} of ${text.length} characters to fit the body. ${why}_`;
  return `${text.slice(0, Math.max(0, room - cut.length))}${cut}`;
}

function stamp(now) {
  return `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// what is left for one block once the rest of the body, and its wrapping, is counted
function room(body, name) {
  return LIMIT - removeBlock(body, name).length - 200;
}

// notes first: they are the hand-off; a draft takes what room is left
function blocks(body, { notes, draft, document, now }) {
  let next = body || '';
  if (typeof notes === 'string' && notes.trim()) {
    const text = fit(escape(notes.trim()), room(next, NOTES), 'Ask the agent for shorter notes.');
    next = writeBlock(next, NOTES, details(`🗒️ Agent notes · ${stamp(now)}`, text));
  }
  if (typeof draft === 'string' && draft.trim()) {
    const text = fit(escape(draft.trim()), room(next, DRAFT), "The whole draft is the round's artifact, linked below.");
    next = writeBlock(next, DRAFT, details(`📐 Draft ${document} · ${stamp(now)}`, text));
  }
  return next;
}

async function run({ github, context, core }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const issue_number = Number(env.NUMBER) || 0;
  if (!issue_number || !env.STRUCTURED_FILE || !fs.existsSync(env.STRUCTURED_FILE)) return;
  const structured = JSON.parse(fs.readFileSync(env.STRUCTURED_FILE, 'utf8'));
  const notes = structured?.[env.NOTES_FIELD || NOTES];
  const { data: thread } = await github.rest.issues.get({ owner, repo, issue_number });
  // a draft belongs to an issue; a PR's document is committed on its branch
  const draft = !thread.pull_request && env.DOCUMENT ? structured?.[env.DOCUMENT] : null;
  const body = blocks(thread.body, { notes, draft, document: env.DOCUMENT, now: new Date() });
  if (body === (thread.body || '')) return;
  await github.rest.issues.update({ owner, repo, issue_number, body });
  core.setOutput('kept', 'true');
}

module.exports = { NOTES, DRAFT, LIMIT, escape, readBlock, stripBlocks, writeBlock, blocks, run };
