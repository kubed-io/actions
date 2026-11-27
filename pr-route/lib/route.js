// Decides what an event on an agent-built PR (head `issue-*`) is for the agents: a plan
// turn, a code turn, or nothing, and the words the turn starts with.
//
// Before `plan approved`: the owner's comments and reviews are plan turns. After it: the
// owner's comments and reviews, a review by Copilot, the label, an `agent-code` dispatch,
// and a push to the draft by the agent or the owner are code turns; a push whose commit says
// `Agent: done` is not. Anything else is nothing.
//
// The owner's approval is no turn, before the plan is approved or after: it says the change
// is done, and the merge follows. A comment or a request for changes keeps it going.
//
// The parent approves its sub-issues' plans (spec 2026-11-24 R-SM24): the App's `plan
// approved` counts as the owner's on a PR into its family's branch (base issue-<P>), and
// nowhere else. Not at the PR's opening either: a fix with no plan opens with the App's label,
// together with `agent`, and its code starts from its own dispatch.
//
// The parent messages its family PR (R-SM31): the App's comment that opens with n8n's
// `parent-message` marker counts as the owner's comment on the family PR of the parent it
// names: open, head issue-<P> in this repo, base the default branch, a body that closes #P.
//
// A downstream PR adopts an upstream epic's release (spec 2026-11-24 upstream releases): its body
// carries the epic's marker, and its issue, issue-<N>'s, the same one, by the App or Dr K
// (`upstream`). There the App's comment that opens with n8n's `upstream-release` or
// `upstream-message` note for that epic counts as the owner's comment, and the App's `plan
// approved` into the default branch as his label, after the opening (R-UR11). A final's note
// leads its code turn with upstream-final (R-UR14). Its code turns are `held` in draft until the
// App's final note for its epic is on the PR or its issue (R-UR19); every other code turn is not.
//
// Copilot's review is a second opinion, however it was asked for: out of draft, every one
// that says something is a turn, in its own words like the owner's. Copilot's newer reviews
// reach the relay as `edited` only, so its `edited` counts as its review; anyone else's edit
// is nothing. A review the agent-flow channel handed to a running turn is seen there, so the
// turn this one queues finds nothing new.
//
// It answers two dispatches. `agent-route` is n8n's relay of a review, a push, a comment or
// the approval label, and routes like the event it carries; its payload is a pointer, so
// who reviewed, commented or labelled is read back from GitHub. `agent-code` is the agents'
// own: failed checks, a review asking for changes, a Bug's fix, a conflict pr-update left.

const { lastLabeledBy } = require('../../issue-agent/lib/gate');
const { markerOf, noteOf, sameRef } = require('../../issue-agent/lib/upstream');

// the C1 marker, as a line of the PR's body: a downstream PR
const MARKED = /^<!-- upstream: [^\n]* -->$/m;

// a review that says Copilot could not review (a cancelled or failed run, nothing it could
// read): nothing to answer
// (seen 2026-11-13: "was unable to review … insufficient remaining quota", which woke a code turn)
const failedReview = (review) => /^(?:<!--[\s\S]*?-->\s*)?Copilot (?:encountered an error|wasn't able to review|was unable to review)/.test(review?.body || '');

const FINISHED = /^Agent: done$/m;

// n8n's marker on a parent's message, first in the comment
const PARENT_MESSAGE = /^<!-- parent-message (\{[^}]*\}) -->/;

// the parent a message names, when it is the App's message on that parent's family PR
function parentMessage(pr, comment, repo) {
  let parent = 0;
  try {
    parent = Number(JSON.parse((PARENT_MESSAGE.exec(comment?.body || '') || [])[1] || '{}').parent) || 0;
  } catch {
    return 0;
  }
  const closes = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${parent}\\b`, 'i');
  const family = parent > 0 && pr.head?.ref === `issue-${parent}` && pr.head?.repo?.full_name === repo
    && !!pr.base?.ref && pr.base.ref === pr.base?.repo?.default_branch && closes.test(pr.body || '');
  return family ? parent : 0;
}

// the PR's opening labels arrive together: a label within this of the App's `agent` is one
const OPENING_MS = 10000;

// the latest `labeled` event for the label, unless it came off again
function lastLabeled(events, label) {
  let last = null;
  for (const e of events) {
    if (e.label?.name !== label) continue;
    if (e.event === 'labeled') last = e;
    if (e.event === 'unlabeled') last = null;
  }
  return last;
}

// the App's label came with the PR's opening: the App's `agent` was added at the same time
function atOpening(events, label, app) {
  const t = Date.parse(label.created_at);
  return events.some((e) => e.event === 'labeled' && e.label?.name === 'agent' && String(e.actor?.id) === app
    && Math.abs(Date.parse(e.created_at) - t) <= OPENING_MS);
}

function settings(env) {
  return {
    owner: env.OWNER_ID,
    app: env.APP_ID,
    copilot: env.COPILOT_ID,
    prefix: env.PREFIX,
    label: env.LABEL,
    prompts: env.PROMPTS,
  };
}

// The stage an event is for, from who caused it and what it was. `byUpstream`: the epic's note
// on its downstream PR, a comment, which counts as the owner's
function stageOf({ dispatched, approved, pushed, review, byOwner, byApp, byCopilot, copilotOk = true, draft, finished, byParent = false, byUpstream = false }) {
  if (dispatched) return approved ? 'code' : 'none';
  if (!approved) return (byOwner || byUpstream) && !pushed ? 'plan' : 'none';
  // a review wakes the code agent when it is the owner's or Copilot's: the agent's own
  // thread replies arrive as reviews too, by the App, and must not wake it again
  if (review) return byOwner || (byCopilot && copilotOk) ? 'code' : 'none';
  // a comment, the label: the owner's, read back from GitHub; the parent's message on its family
  // PR, and its label on a sub-issue's PR, too
  if (!pushed) return byOwner || byParent || byUpstream ? 'code' : 'none';
  return draft && (byOwner || byApp) && !finished ? 'code' : 'none';
}

// What a turn with no words of its own starts with: a kb prompt, sent as a slash command,
// so the methodology's own text drives the turn
// pr-update's conflict: the paths it could not settle, which the agent merges in, and the wiki's
// files it merged with markers where both sides changed a passage (`wiki`), which the agent
// only edits: the merge is already on the branch
function conflictPrompt({ base, paths, wiki }) {
  const list = (s) => String(s || '').split(',').map((p) => p.trim()).filter(Boolean);
  const marked = list(wiki);
  const code = list(paths).filter((p) => !marked.includes(p));
  const named = base ? `\`${base}\`` : 'The base';
  const markers = `this branch's wiki and the base's changed the same passages of ${marked.join(', ')}. `
    + 'Those files hold conflict markers: `<<<<<<<` this branch\'s side, `>>>>>>>` the base\'s. Settle each by editing the file so both sides\' changes stay, '
    + `and leave no marker anywhere in them. Run no git in the wiki${code.length ? '' : ' and merge nothing'}: the job's commit carries the wiki and the pin together.`;
  if (!code.length && marked.length) return `${named} moved, and pr-update merged it in, the wiki too, but ${markers} Then run the checks and carry on.`;
  return `${named} moved, and merging it into this branch conflicts in ${code.join(', ') || 'files the update could not settle'}. `
    + 'Merge it in, resolve them so both sides\' changes stay, run the checks, and carry on. '
    + `Merge in this checkout (\`git merge --no-commit --no-ff origin/${base || '<base>'}\`), `
    + '`git add` what you resolved and leave it uncommitted: the job commits it as a real merge.'
    + (marked.length ? ` In the wiki, ${markers}` : '');
}

function promptOf({ dispatched, reason, labelled, pushed, base, paths, wiki, upstreamFinal = false }, prefix) {
  const turn = (name) => `${prefix}${name}`;
  // fix: a Bug's change with no plan, started by its hand-off, built from the approved report
  // conflict: pr-update could not bring the branch up to date after a merge into its base, or
  // merged its wiki with markers
  const reasons = {
    review: turn('review-came-in'), ci: turn('checks-failed'), fix: turn('fix-approved'),
    conflict: conflictPrompt({ base, paths, wiki }),
  };
  if (dispatched) return reasons[reason] || `Woken by ${reason || 'a dispatch'}: see what needs doing.`;
  if (labelled) return turn('plan-approved');
  // the epic's final: move the pins and finish (R-UR14, R-UR15)
  if (upstreamFinal) return turn('upstream-final');
  if (pushed) return turn('next-task');
  return '';
}

// the App's final note for the epic, on the PR or its issue
async function finalNoted({ github, context, cfg, upstream, numbers }) {
  for (const n of numbers) {
    const comments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: n, per_page: 100 });
    const final = comments.some((c) => {
      const note = String(c.user?.id) === cfg.app ? noteOf(c.body) : null;
      return note?.kind === 'release' && note.final && sameRef(note.upstream, upstream);
    });
    if (final) return true;
  }
  return false;
}

// the epic is closed: its family PR merged, which is its final release, whether or not that
// note reached this thread. A downstream issue that wasn't labelled when the final went out
// never gets the note, and its PR would stay a draft for good (mcp-kb #107). Unreadable: false,
// the safe side
async function epicClosed({ github, upstream }) {
  const m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(upstream || '');
  if (!m) return false;
  try {
    const { data } = await github.rest.issues.get({ owner: m[1], repo: m[2], issue_number: Number(m[3]) });
    return data?.state === 'closed';
  } catch {
    return false;
  }
}

async function run({ github, context, core, env = process.env }) {
  const cfg = settings(env);
  const e = context.payload;
  const viaRoute = context.eventName === 'repository_dispatch' && e.action === 'agent-route';
  const dispatched = context.eventName === 'repository_dispatch' && e.action === 'agent-code';
  core.setOutput('stage', 'none');
  if (!viaRoute && !dispatched) return core.info(`${context.eventName}: only n8n's relay and an agent-code dispatch are turns`);
  const number = Number(e.client_payload?.pull_request) || 0;
  if (!number) return core.info('no pull request');
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  const ours = pr.head.repo?.full_name === `${context.repo.owner}/${context.repo.repo}`;
  if (pr.state !== 'open' || !ours || !pr.head.ref.startsWith(cfg.prefix)) return core.info(`#${number} is not the agents'`);

  // a downstream PR: the epic its issue's marker names (R-UR7); a marked body whose issue does
  // not vouch for it is no downstream PR, but its code turns stay held
  const marked = MARKED.test(pr.body || '');
  let upstream = '';
  const issueNumber = Number(/^\d+$/.test(pr.head.ref.slice(cfg.prefix.length)) ? pr.head.ref.slice(cfg.prefix.length) : 0);
  if (marked && issueNumber) {
    let issue = null;
    try {
      ({ data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: issueNumber }));
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    upstream = markerOf(issue, cfg)?.ref || '';
    core.info(upstream ? `#${number}: downstream of ${upstream}` : `#${number}: a marked body, but #${issueNumber} carries no marker by the App or Dr K`);
  }
  core.setOutput('upstream', upstream);

  const carried = viaRoute ? e.client_payload?.event : '';
  const via = e.client_payload?.action;
  const pushed = carried === 'pull_request' && via === 'synchronize';
  const review = carried === 'pull_request_review' && (via === 'submitted' || via === 'edited');
  const commented = carried === 'issue_comment' && via === 'created';
  const labelled = carried === 'pull_request' && via === 'labeled' && e.client_payload?.label === cfg.label;
  // the relay carries only these: a push, a submitted review, a new comment, the approval label
  if (viaRoute && !pushed && !review && !commented && !labelled) return core.info('agent-route: unknown event');
  let actor = String(viaRoute ? e.client_payload?.actor : e.sender?.id);
  let copilotOk = true;
  if (review) {
    // the payload is a pointer: who reviewed, and of what, is read back from GitHub
    const reviewId = Number(e.client_payload?.review_id) || 0;
    let got = null;
    if (reviewId) {
      try {
        ({ data: got } = await github.rest.pulls.getReview({ ...context.repo, pull_number: number, review_id: reviewId }));
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    // an approval ends the conversation: what follows is the merge, not a turn
    if (got?.state === 'APPROVED') return core.info(`#${number}: an approval is no turn`);
    if (!got || String(got.user?.id) !== actor) actor = 'unknown';
    // only Copilot's review arrives as an edit; anyone else's edit is no review
    if (via === 'edited' && actor !== cfg.copilot) actor = 'unknown';
    // one that says it could not review says nothing to answer
    if (actor === cfg.copilot) copilotOk = !pr.draft && !failedReview(got);
  }
  let byParent = false;
  let byUpstream = false;
  let upstreamFinal = false;
  if (commented) {
    const commentId = Number(e.client_payload?.comment_id) || 0;
    let got = null;
    if (commentId) {
      try {
        ({ data: got } = await github.rest.issues.getComment({ ...context.repo, comment_id: commentId }));
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    const here = got?.issue_url?.endsWith(`/issues/${number}`);
    if (!got || !here || String(got.user?.id) !== actor) actor = 'unknown';
    // the App's: the parent's message, on its family PR only
    if (actor === cfg.app) {
      const parent = parentMessage(pr, got, `${context.repo.owner}/${context.repo.repo}`);
      byParent = parent > 0;
      // the epic's note, on its downstream PR (R-UR11)
      const note = upstream && !byParent ? noteOf(got.body) : null;
      byUpstream = ['release', 'message'].includes(note?.kind) && sameRef(note.upstream, upstream);
      upstreamFinal = byUpstream && note.kind === 'release' && note.final;
      core.info(byParent ? `#${number}: the message of #${parent}, the family's parent`
        : byUpstream ? `#${number}: the ${note.kind} of ${upstream}${upstreamFinal ? ', its final' : ''}`
          : `#${number}: the App's comment is no parent's message on its family PR, nor its epic's note`);
    }
  }
  const approved = pr.labels.some((l) => l.name === cfg.label);
  if (labelled) {
    // gone again: nothing to approve
    if (!approved) return core.info(`agent-route: ${cfg.label} is no longer on #${number}`);
    const events = await github.paginate(github.rest.issues.listEvents, { ...context.repo, issue_number: number, per_page: 100 });
    actor = String(lastLabeledBy(events, cfg.label)?.id ?? 'unknown');
    // the App's, for the parent: into issue-<P> only, or for the epic: a downstream PR into the
    // default branch (R-UR11); and after the PR opened
    if (actor === cfg.app) {
      const family = /^\d+$/.test((pr.base?.ref || '').slice(cfg.prefix.length)) && pr.base.ref.startsWith(cfg.prefix);
      const epic = !!upstream && !!pr.base?.ref && pr.base.ref === pr.base?.repo?.default_branch;
      byParent = (family || epic) && !atOpening(events, lastLabeled(events, cfg.label), cfg.app);
      if (!byParent) core.info(`#${number}: the App's ${cfg.label} ${family || epic ? 'came with the opening' : `on a PR into ${pr.base?.ref || 'nothing'}`}: not the parent's or the epic's`);
    }
  }
  // the run that finished the plan said so on its commit: its push wakes nothing
  const { data: head } = await github.rest.repos.getCommit({ ...context.repo, ref: pr.head.sha });
  const facts = {
    dispatched, pushed, labelled,
    approved,
    review,
    copilotOk,
    byOwner: actor === cfg.owner,
    byApp: actor === cfg.app,
    byCopilot: actor === cfg.copilot,
    byParent,
    byUpstream,
    upstreamFinal: upstreamFinal && approved,
    draft: pr.draft,
    finished: FINISHED.test(head.commit.message),
    reason: e.client_payload?.reason,
    base: e.client_payload?.base,
    paths: e.client_payload?.paths,
    wiki: e.client_payload?.wiki,
  };
  const stage = stageOf(facts);
  core.setOutput('stage', stage);
  core.setOutput('number', String(number));
  core.setOutput('head', pr.head.ref);
  core.setOutput('prompt', promptOf(facts, cfg.prompts));
  // a dispatched event (checks failed, a review) is the point of its run: its prompt is
  // the whole turn, and anything unread is the next one. A slash command only works at
  // the start of a turn, so it cannot follow the thread's messages
  // the epic's final leads into the thread's unseen posts, the note among them
  core.setOutput('prompt_when', dispatched ? 'always' : facts.upstreamFinal ? 'lead' : 'quiet');
  // a code turn on a downstream PR stays draft until its epic's final (R-UR19), noted on the thread
  // or shown by the epic being closed; any other's never
  // holds, so Mark Ready runs as ever. Not a code turn: no word
  let held = '';
  if (stage === 'code') {
    held = marked
      ? String(!(upstream && ((await finalNoted({ github, context, cfg, upstream, numbers: [number, issueNumber] }))
        || (await epicClosed({ github, upstream })))))
      : 'false';
  }
  core.setOutput('held', held);
  // the checks run whose report the code job downloads
  const runId = dispatched && facts.reason === 'ci' ? Number(e.client_payload?.run_id) || 0 : 0;
  core.setOutput('run_id', runId ? String(runId) : '');
  // the approval label takes the PR over; anything else waits its turn
  core.setOutput('takeover', String(labelled));
  // the dispatch's reason
  core.setOutput('reason', dispatched ? String(facts.reason || '') : '');
  core.info(`#${number}: ${stage}${held ? `, held ${held}` : ''}`);
}

module.exports = { run, stageOf, promptOf, failedReview, parentMessage };
