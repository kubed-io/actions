// The hidden markers issue-agent keeps on GitHub. Each is an HTML comment, so it never
// renders, and the human's text is never touched.
//
//   <!-- issue-agent -->               on every comment the action posts
//   <!-- issue-agent:<document> -->    in a body: the human's text above, the action's below
//   <!-- issue-agent-state {...} -->   a document's round state, in that section
//   <!-- issue-agent-seen {...} -->    on a reply: the last message it answered

const TAG = '<!-- issue-agent -->';
// a marker's JSON never holds `-->` (encode) and never opens another comment, so a stray
// unclosed marker cannot swallow the real one after it
const STATE = /<!-- issue-agent-state (\{(?:(?!-->|<!--)[\s\S])*?\}) -->/;
const SEEN = /<!-- issue-agent-seen (\{(?:(?!-->|<!--)[\s\S])*?\}) -->/g;

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// so a value can never close its comment early
function encode(value) {
  return JSON.stringify(value).replace(/-->/g, '--\\u003e');
}

function marker(document) {
  return `<!-- issue-agent:${document} -->`;
}

function split(body, document) {
  const text = body || '';
  const at = text.lastIndexOf(marker(document));
  if (at === -1) return { human: text.trimEnd(), section: '' };
  return { human: text.slice(0, at).trimEnd(), section: text.slice(at) };
}

function readState(body, document) {
  const found = split(body, document).section.match(STATE);
  return found ? parse(found[1]) : null;
}

function writeSection(body, document, state, lines) {
  const { human } = split(body, document);
  const section = [marker(document), `<!-- issue-agent-state ${encode(state)} -->`, '', ...lines].join('\n');
  return human ? `${human}\n\n${section}\n` : `${section}\n`;
}

function documents(body) {
  return [...(body || '').matchAll(/<!-- issue-agent:([\w-]+) -->/g)]
    .map((m) => ({ document: m[1], state: readState(body, m[1]) }))
    .filter((d) => d.state);
}

function seenMarker(seen) {
  return `<!-- issue-agent-seen ${encode(seen)} -->`;
}

function readSeen(body) {
  // the real marker is appended last, after any text the agent wrote, so the last one wins
  const found = [...(body || '').matchAll(SEEN)].pop();
  return found ? parse(found[1]) : null;
}

function isAgent(body) {
  return (body || '').includes(TAG);
}

// A state block can be written by anyone who can edit the issue, so a path from it is
// trusted only when it is a document under docs/ (no traversal, no empty segment).
function safePath(p) {
  return typeof p === 'string' && /^docs\/[A-Za-z0-9._\/-]+\.md$/.test(p)
    && !p.split('/').some((s) => s === '..' || s === '');
}

// What the agent wrote, or null: a state is trusted for what it can only be if the agent
// wrote it, so every value that steers a write or a link is checked against its shape.
function validState(state, { server, owner, repo }) {
  if (!state || typeof state !== 'object') return null;
  const digits = (v) => (typeof v === 'string' || typeof v === 'number') && /^\d+$/.test(String(v));
  const runs = `${server}/${owner}/${repo}/actions/runs/${state.run}`;
  // the links land in the bot's own replies, so they must be exactly the ones it writes
  const summary = typeof state.summary_url === 'string' && state.summary_url.startsWith(runs)
    && /^(#summary-\d+)?$/.test(state.summary_url.slice(runs.length));
  const ok = digits(state.run) && digits(state.artifact)
    && Number.isInteger(state.round) && state.round > 0
    && typeof state.slug === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(state.slug)
    && safePath(state.path)
    && summary
    && state.artifact_url === `${runs}/artifacts/${state.artifact}`;
  return ok ? state : null;
}

module.exports = { TAG, marker, split, readState, writeSection, documents, seenMarker, readSeen, isAgent, safePath, validState };
