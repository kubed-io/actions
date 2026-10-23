// The hidden markers issue-agent keeps on GitHub. Each is an HTML comment, so it never
// renders, and the human's text is never touched.
//
//   <!-- issue-agent -->               on every comment and review the action posts
//   <!-- issue-agent-seen {...} -->    on a reply: the last message it answered
//
// The notes block in a body has its own markers (notes.js).

const TAG = '<!-- issue-agent -->';
// a marker's JSON never holds `-->` (encode) and never opens another comment, so a stray
// unclosed marker cannot swallow the real one after it
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

module.exports = { TAG, seenMarker, readSeen, isAgent };
