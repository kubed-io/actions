// The parent's open questions (spec 2026-11-24 R-SM19, R-SM22a): the running list of what
// doesn't block, kept for Dr K. A parent turn's list is kept on the parent, collapsed in a block
// of its own, and the family's pull request to main carries it as its `## Open questions`
// section: written when it opens, from the list kept, and rewritten when a later turn changes
// the list. An empty list takes the section off; a turn without the field changes nothing.
//
// The hand-off that opens or refreshes that pull request (the parent's `open_pr`, R-SM30) also
// hands over the parent's `agent` sub-issues still open (SUB_ISSUES, JSON [{number, title}]):
// they are its `## Open sub-issues` section, taken off when none is open.

const { LIMIT, escape, readBlock, writeBlock, removeBlock, unwrap } = require('./notes');

const NAME = 'open-questions';
const SUBS = 'open-sub-issues';

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// one line each, naming the sub-issue it came from
function render(list) {
  return (Array.isArray(list) ? list : [])
    .map((q) => ({ text: escape(String(q?.text ?? '').replace(/\s+/g, ' ').trim()), from: Number(q?.from) || 0 }))
    .filter((q) => q.text)
    .map((q) => `- ${q.text}${q.from ? ` (#${q.from})` : ''}`)
    .join('\n');
}

const onParent = (list, count) => list && `<details>\n<summary>❓ Open questions · ${count}</summary>\n\n${list}\n\n</details>`;
const onPR = (list) => list && `## Open questions\n\n${list}`;

// one line each: the sub-issue and its title
function renderSubs(list) {
  return (Array.isArray(list) ? list : [])
    .filter((i) => Number.isSafeInteger(i?.number) && i.number > 0)
    .map((i) => `- #${i.number}${i.title ? ` ${escape(String(i.title).replace(/\s+/g, ' ').trim())}` : ''}`)
    .join('\n');
}
const onSubs = (list) => list && `## Open sub-issues\n\n${list}`;

// the body with the block written, or taken off when there is nothing to say
function keep(body, inner, name = NAME) {
  return inner ? writeBlock(body, name, inner) : removeBlock(body || '', name);
}

async function write({ core, update, body, next, where }) {
  if (next === (body || '')) return false;
  if (next.length > LIMIT) {
    core.warning(`the open questions would take ${where}'s body past ${LIMIT} characters: not written`);
    return false;
  }
  await update(next);
  return true;
}

async function run({ github, context, core, env = process.env }) {
  const { owner, repo } = context.repo;
  const number = Number(env.NUMBER) || 0;
  if (!number) return;
  // a turn's output (the spec job), or none: the hand-off opening the family's pull request
  const out = env.OUTPUT ? parse(env.OUTPUT) : null;
  if (env.OUTPUT && !Array.isArray(out?.open_questions)) return core.info('no open_questions this turn: nothing changes');
  // the hand-off's open sub-issues; none given, or unreadable, leaves the section as it is
  const subs = env.SUB_ISSUES ? parse(env.SUB_ISSUES) : null;
  if (env.SUB_ISSUES && !Array.isArray(subs)) core.warning('sub_issues is not a JSON list: the open sub-issues stay as they are');
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: number });
  let list = unwrap(readBlock(issue.body, NAME) || '').trim();
  if (out) {
    list = render(out.open_questions);
    const next = keep(issue.body, onParent(list, list ? list.split('\n').length : 0));
    const update = (body) => github.rest.issues.update({ owner, repo, issue_number: number, body });
    if (await write({ core, update, body: issue.body, next, where: `#${number}` })) core.info(`#${number}: open questions kept`);
  }
  // the family's pull request to main, when it is open
  const { data: pulls } = await github.rest.pulls.list({ owner, repo, head: `${owner}:issue-${number}`, base: env.DEFAULT, state: 'open', per_page: 1 });
  const pr = (pulls || [])[0];
  if (!pr) return;
  const update = (body) => github.rest.pulls.update({ owner, repo, pull_number: pr.number, body });
  let next = keep(pr.body, onPR(list));
  if (Array.isArray(subs)) next = keep(next, onSubs(renderSubs(subs)), SUBS);
  if (await write({ core, update, body: pr.body, next, where: `#${pr.number}` })) {
    core.info(`#${pr.number}: its open questions are #${number}'s`);
  }
}

module.exports = { NAME, SUBS, render, renderSubs, onParent, onPR, onSubs, keep, run };
