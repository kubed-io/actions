// sub-issue-accepted: n8n's pointer to a box Dr K ticked on a proposal (proposal.js). The
// payload proves nothing, so the comment is read back: the App wrote it, on this thread, and the
// box is ticked now. The item comes from the comment's marker, not from the payload.

const { parse } = require('./proposal');
const { parentOf, familyOf } = require('./family');

async function run({ github, context, core, env = process.env }) {
  const { owner, repo } = context.repo;
  const p = context.payload.client_payload || {};
  const number = Number(p.number);
  const item = Number(p.item);
  core.setOutput('ok', 'false');
  const no = (why) => core.info(`not filed: ${why}`);
  if (!number || !Number.isInteger(item) || item < 0 || !p.comment_id) return no('an incomplete pointer');
  if (String(p.actor) !== String(env.OWNER_ID)) return no('not ticked by the owner');

  let comment;
  try {
    ({ data: comment } = await github.rest.issues.getComment({ owner, repo, comment_id: Number(p.comment_id) }));
  } catch (e) {
    if (e.status === 404) return no('the proposal is gone');
    throw e;
  }
  if (String(comment.user?.id) !== String(env.APP_ID)) return no("not the App's proposal");
  if (!String(comment.issue_url || '').endsWith(`/issues/${number}`)) return no('another thread');
  const proposal = parse(comment.body);
  const chosen = proposal?.items[item];
  if (!chosen) return no(`no item ${item}`);
  if (!proposal.ticked[item]) return no(`box ${item} is not ticked now`);

  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: number });
  if (issue.state !== 'open') return no(`#${number} is closed`);
  // a sub-issue's suggestions are its siblings: filed under its own parent
  const parent = (await parentOf(github, { owner, repo }, number)) || number;
  // the session and the queue are the family's, its top issue's
  const family = await familyOf(github, { owner, repo }, parent);

  core.setOutput('ok', 'true');
  core.setOutput('number', String(number));
  core.setOutput('parent', String(parent));
  core.setOutput('family', String(family));
  core.setOutput('type', chosen.type);
  core.setOutput('title', chosen.title);
  core.setOutput('why', chosen.why || '');
  core.info(`#${number} item ${item}: ${chosen.type} "${chosen.title}" under #${parent}`);
}

module.exports = { run };
