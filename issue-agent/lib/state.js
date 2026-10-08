// The hidden markers issue-agent keeps on GitHub. Each is an HTML comment, so it never
// renders, and the human's text is never touched.
//
//   <!-- issue-agent -->               on every comment the action posts
//   <!-- issue-agent:<document> -->    in a body: the human's text above, the action's below
//   <!-- issue-agent-state {...} -->   a document's round state, in that section
//   <!-- issue-agent-seen {...} -->    on a reply: the last message it answered

const TAG = '<!-- issue-agent -->';
const STATE = /<!-- issue-agent-state (\{.*?\}) -->/s;
const SEEN = /<!-- issue-agent-seen (\{.*?\}) -->/gs;

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
  return found ? JSON.parse(found[1]) : null;
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
  return found ? JSON.parse(found[1]) : null;
}

function isAgent(body) {
  return (body || '').includes(TAG);
}

module.exports = { TAG, marker, split, readState, writeSection, documents, seenMarker, readSeen, isAgent };
