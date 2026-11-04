// Sub-issues the issue agent suggests (its output's `sub_issues`), as the end of its reply: a
// checkbox per item and a hidden marker holding the items. Dr K's tick is the yes: n8n sends
// `sub-issue-accepted` with the box's index, and the job reads the item back from the marker.

const MARK = 'sub-issue-proposal';
const HEADING = '**Sub-issues** — tick one to file it';
const ICON = { Feature: '✨', Bug: '🐛' };

// `-->` inside a title must not end the marker early
const safe = (json) => json.replace(/>/g, '\\u003e');

function render(items) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && i.type && i.title);
  if (!list.length) return '';
  const rows = list.map((i) => `- [ ] ${ICON[i.type] || '•'} ${i.type}: ${i.title}${i.why ? ` — ${i.why}` : ''}`);
  const items_ = list.map(({ type, title, why }) => ({ type, title, why: why || '' }));
  return `${HEADING}\n\n${rows.join('\n')}\n\n<!-- ${MARK} ${safe(JSON.stringify({ items: items_ }))} -->`;
}

// The items and each box's state, in order; null when the body has no proposal
function parse(body) {
  const text = body || '';
  const m = text.match(new RegExp(`<!-- ${MARK} (\\{[\\s\\S]*?\\}) -->`));
  if (!m) return null;
  let items;
  try {
    items = JSON.parse(m[1]).items;
  } catch (e) {
    return null;
  }
  const start = text.lastIndexOf(HEADING, m.index);
  const block = text.slice(start < 0 ? 0 : start, m.index);
  const ticked = block.split('\n').filter((l) => /^- \[[ xX]\] /.test(l)).map((l) => /^- \[[xX]\]/.test(l));
  return { items: Array.isArray(items) ? items : [], ticked };
}

module.exports = { MARK, HEADING, render, parse };
