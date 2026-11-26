// Decides whether the review agent reviews a PR's head, from an `agent-review` dispatch: the
// checks run's own, from its last job (`reason: checks`), or one that asks again. Its answer
// is a commit status on the head: the PR's required check, and the loop's memory, since a
// head the review agent already judged carries its status.
//
// Copilot never stands in for the review agent: asked for, its review is a second opinion,
// which wakes the code agent through pr-route like any review.
//
// The review's target (spec 2026-11-24 R-SM1): `family` for a sub-issue's PR into its
// family's branch `issue-<P>`, `default` for a PR to the default branch, the family's own
// included. A family pass carried to a new head is handed to n8n as the review's own is
// (R-SM10a): the `handback` output is its `verdict` body, which the workflow sends. So is a
// family PR stopped at the review or fix cap, as `needs a human` (R-SM28): no one watches a
// sub-issue's PR, so the parent hears of it.

const { verdictBody } = require('./verdict');

const VERDICT = /^(looks good|changes requested|needs a human)$|^changes requested, last review/;
// a verdict carried to a later commit, with the commit it was given on
const CARRIED = /^(?:no changes|suggestions applied) since \w+: /;
const failedChecks = (s) => /^checks failed/.test(s?.description || '');
const short = (sha) => (sha || '').slice(0, 7);
const BAD = ['failure', 'cancelled', 'timed_out'];
const csv = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const idIn = (url, anchor) => Number(new RegExp(`#${anchor}-(\\d+)$`).exec(url || '')?.[1]) || 0;
// a family's branch, the base a sub-issue's PR is opened on
const familyBranch = (prefix, ref) => (ref || '').startsWith(prefix) && /^\d+$/.test(ref.slice(prefix.length));
// what a family review left for the parent, between the markers agent-review.yml's header
// puts around it
const SUMMARY = /<!-- review-summary -->\n?([\s\S]*?)\n?<!-- \/review-summary -->/;
// a round's start (R-SM39): a sub-issue's PR merged into this one through GitHub's merge,
// or n8n's parent message on it, posted as the App (pr-route's PARENT_MESSAGE)
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const subIssueMerge = (prefix) => new RegExp(`^Merge pull request #\\d+ from [^/]+/${escape(prefix)}\\d+(?:\\s|$)`);
const PARENT_MESSAGE = /^<!-- parent-message /;

function settings(env) {
  return {
    check: env.CHECK,
    maxReviews: Number(env.MAX_REVIEWS),
    maxFixes: Number(env.MAX_FIXES),
    trusted: csv(env.TRUSTED),
    owner: env.OWNER,
    reviewer: env.REVIEWER,
    prefix: env.PREFIX,
    labels: csv(env.LABELS),
    artifact: env.ARTIFACT,
    app: env.APP,
  };
}

// what the PR itself changes at a commit, blind to line numbers, so merging the base in
// leaves it as it was; null when GitHub's compare is cut off at 300 files
// a submodule pointer's move (the docs wiki), which a branch update moves to the wiki's head
// every time main moves (cluster spec 2026-11-12, R-L9): it is no change of the PR's own
const POINTER = /^@@[^\n]*@@\n-Subproject commit [0-9a-f]+\n\+Subproject commit [0-9a-f]+\s*$/;

async function prChanges(github, repo, base, ref) {
  const { data } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${base}...${ref}` });
  if ((data.files?.length || 0) >= 300) return null;
  return data.files.filter((f) => !POINTER.test(f.patch || '')).map((f) => `${f.status} ${f.filename} ${f.previous_filename || ''}\n${
    f.patch == null ? `blob ${f.sha}` : f.patch.replace(/^@@[^@]*@@/gm, '@@')}`).sort().join('\n');
}

// the summary of the review a status links to, read back from its review or comment; empty
// when it cannot be, and n8n keeps the one the review sent
async function summaryOf(github, repo, number, url) {
  const review = idIn(url, 'pullrequestreview');
  const comment = idIn(url, 'issuecomment');
  if (!review && !comment) return '';
  try {
    const { data } = review
      ? await github.rest.pulls.getReview({ ...repo, pull_number: number, review_id: review })
      : await github.rest.issues.getComment({ ...repo, comment_id: comment });
    return SUMMARY.exec((data?.body || '').replace(/\r\n/g, '\n'))?.[1].trim() || '';
  } catch {
    return '';
  }
}

// every line a review's suggestion blocks would put in each file
async function suggested(github, repo, number, reviewId) {
  const comments = await github.paginate(github.rest.pulls.listCommentsForReview,
    { ...repo, pull_number: number, review_id: reviewId, per_page: 100 });
  const byPath = new Map();
  for (const c of comments) {
    const body = (c.body || '').replace(/\r\n/g, '\n');
    for (const m of body.matchAll(/^(`{3,})suggestion[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)) {
      const lines = byPath.get(c.path) || new Set();
      for (const l of m[2].replace(/\n$/, '').split('\n')) lines.add(l);
      byPath.set(c.path, lines);
    }
  }
  return byPath;
}

// A suggestion applied from the PR's page: a commit GitHub made and signed (web-flow),
// co-authored by the reviewer, whose every added line is one the review suggested for
// that file. Applying a batch of them makes one such commit.
function appliedSuggestion(commit, reviewer, byPath) {
  if (commit.committer?.login !== 'web-flow' || !commit.commit?.verification?.verified) return false;
  if (commit.parents?.length !== 1) return false;
  const coauthor = new RegExp(`^Co-authored-by: [^<\\n]*<${reviewer}\\+[^>]*>[ \\t]*$`, 'mi');
  if (!coauthor.test(commit.commit.message || '')) return false;
  const files = commit.files || [];
  return files.length > 0 && files.every((f) => {
    const lines = byPath.get(f.filename);
    if (!lines || f.status !== 'modified' || f.patch == null) return false;
    return f.patch.split('\n').filter((l) => l.startsWith('+')).every((l) => lines.has(l.slice(1)));
  });
}

// A checks run that points at itself from its last job is still running: it failed when
// any job that finished did
async function jobsFailed(github, repo, runId) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun,
    { ...repo, run_id: runId, filter: 'latest', per_page: 100 });
  return jobs.filter((j) => j.status === 'completed' && BAD.includes(j.conclusion)).length;
}

async function run({ github, context, core, env = process.env }) {
  const cfg = settings(env);
  const repo = context.repo;
  const e = context.payload;
  for (const k of ['number', 'sha', 'last', 'target', 'handback']) core.setOutput(k, '');
  if (context.eventName !== 'repository_dispatch' || e.action !== 'agent-review') {
    return core.info(`${context.eventName}: only an agent-review dispatch is routed`);
  }
  const sent = e.client_payload || {};
  // the checks run's pointer to itself routes as the run; any other dispatch asks again
  const pointer = sent.reason === 'checks';
  const dispatched = !pointer;
  let checksRun = null;
  if (pointer) {
    ({ data: checksRun } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: Number(sent.run_id) }));
    if (checksRun.event !== 'pull_request') return core.info(`run ${checksRun.id} is a ${checksRun.event} run`);
    if (checksRun.head_sha !== sent.sha) return core.info(`run ${checksRun.id} ran on ${short(checksRun.head_sha)}, not ${short(sent.sha)}`);
  }
  if (checksRun?.conclusion === 'cancelled') return core.info('cancelled: a newer push has its own run');

  const number = Number(sent.pull_request) || 0;
  if (!number) return core.info('no pull request');
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number });
  if (pr.state !== 'open' || pr.draft) return core.info(`#${number} is ${pr.draft ? 'a draft' : pr.state}`);
  const sha = pr.head.sha;
  const target = familyBranch(cfg.prefix, pr.base.ref) ? 'family' : 'default';
  if (checksRun && checksRun.head_sha !== sha) return core.info(`${checksRun.head_sha} is no longer the head`);
  const runUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  const status = (state, description, target_url = runUrl) => github.rest.repos.createCommitStatus({
    ...repo, sha, state, description, target_url, context: cfg.check,
  });
  // a cap: over to a human, and on a family PR the parent hears of it, the status its summary
  const stalled = async (description, target_url) => {
    await status('failure', description, target_url);
    if (target !== 'family') return;
    core.setOutput('handback', JSON.stringify(verdictBody({
      repo: `${repo.owner}/${repo.repo}`, number, sha, verdict: 'needs a human', summary: description, runId: context.runId,
    })));
  };

  const ours = pr.head.repo?.full_name === `${repo.owner}/${repo.repo}`;
  const labels = pr.labels.map((l) => l.name);
  if (!ours || !pr.head.ref.startsWith(cfg.prefix) || !cfg.labels.every((l) => labels.includes(l))) {
    // the pointer comes only for the agents' PRs, whose check this is
    if (pointer) return core.info(`#${number} was not built by the agents: no status`);
    await status('success', 'not built by the agents');
    return core.info(`#${number} was not built by the agents`);
  }

  // the checks: a run without the collector's report ran none (a label, a draft)
  let checks = 'unknown';
  if (checksRun) {
    const { data } = await github.rest.actions.listWorkflowRunArtifacts({ ...repo, run_id: checksRun.id, name: cfg.artifact });
    if (!data.artifacts.length) return core.info('no checks ran in this run');
    const failed = await jobsFailed(github, repo, checksRun.id);
    if (sent.failed != null && Number(sent.failed) !== failed) {
      core.warning(`run ${checksRun.id} reported ${sent.failed} failed jobs, its jobs say ${failed}`);
    }
    checks = failed ? 'failed' : 'passed';
  }

  // the review agent's own statuses are the memory: one per commit it judged
  const mineOn = async (ref) => {
    const { data } = await github.rest.repos.listCommitStatusesForRef({ ...repo, ref, per_page: 100 });
    return data.find((s) => s.context === cfg.check && String(s.creator?.id) === cfg.reviewer);
  };
  const mine = await mineOn(sha);
  if (mine?.state === 'success') return core.info(`${sha} already passed`);
  // a head is judged once; a dispatch asks again, and checks that turn green again
  // (a re-run) bring the review the red ones held back
  if (mine && !dispatched && !(failedChecks(mine) && checks === 'passed')) return core.info(`${sha} already ${mine.state}`);
  const actor = String((checksRun ? checksRun.triggering_actor : e.sender)?.id);
  if (!cfg.trusted.includes(actor)) return core.info(`${actor} cannot start an agent`);

  // the PR's commits, oldest first, and the review agent's status on each before the head
  const commits = await github.paginate(github.rest.pulls.listCommits, { ...repo, pull_number: number, per_page: 100 });
  const all = commits.map((c) => c.sha);
  const judged = [];
  for (const ref of all.filter((c) => c !== sha).reverse()) {
    const s = await mineOn(ref);
    if (s && (s.state === 'success' || s.state === 'failure')) judged.push({ ref, ...s });
  }

  // the caps count this round's commits only: from the latest sub-issue merge, and created
  // after the latest parent message, so the newer of the two starts it (R-SM39)
  const merged = subIssueMerge(cfg.prefix);
  const from = commits.findLastIndex((c) => merged.test((c.commit?.message || '').split('\n')[0]));
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: number, per_page: 100 }) || [];
  const said = comments.filter((c) => String(c.user?.id) === cfg.app && PARENT_MESSAGE.test(c.body || ''))
    .map((c) => Date.parse(c.created_at)).filter(Number.isFinite);
  const saidAt = said.length ? Math.max(...said) : null;
  const inRound = new Set(commits.slice(Math.max(from, 0))
    .filter((c) => saidAt === null || Date.parse(c.commit?.committer?.date) > saidAt).map((c) => c.sha));
  const round = judged.filter((s) => inRound.has(s.ref));

  // red: the code agent gets the run, the review waits for green
  if (checks === 'failed') {
    const fixes = round.filter(failedChecks).length;
    if (fixes >= cfg.maxFixes) {
      await stalled(`needs a human: checks failed on ${fixes + 1} commits`, checksRun.html_url);
      return core.info(`checks failed on ${fixes + 1} commits: over to a human`);
    }
    await status('failure', `checks failed (fix ${fixes + 1} of ${cfg.maxFixes})`, checksRun.html_url);
    await github.rest.repos.createDispatchEvent({
      ...repo, event_type: 'agent-code',
      client_payload: { pull_request: number, reason: 'ci', run_id: checksRun.id },
    });
    return core.info(`checks failed: agent-code dispatched with run ${checksRun.id}`);
  }

  // the last verdict, the review agent's own or one carried forward
  const prior = judged.find((s) => VERDICT.test(s.description) || CARRIED.test(s.description));
  if (prior && !dispatched) {
    const verdict = prior.description.replace(CARRIED, '');
    const reviewId = idIn(prior.target_url, 'pullrequestreview');
    const carry = async (why, description) => {
      await status(prior.state, description, prior.target_url);
      core.info(`${sha} ${why} since ${prior.ref}`);
      // a family pass merges on n8n's word: it hears of the carried one too
      if (target === 'family' && prior.state === 'success') {
        core.setOutput('handback', JSON.stringify(verdictBody({
          repo: `${repo.owner}/${repo.repo}`, number, sha, verdict,
          summary: await summaryOf(github, repo, number, prior.target_url), reviewId, runId: context.runId,
        })));
      }
      return true;
    };
    const at = all.indexOf(prior.ref);
    const since = at < 0 ? [] : all.slice(at + 1);
    // commits that only bring the base in (Update branch, a hand merge) keep it. Every commit
    // since must be a merge: one of the PR's own that moves only the wiki's pointer is a spec
    // change, and prChanges can't see it
    const parents = new Map(commits.map((c) => [c.sha, c.parents?.length || 0]));
    if (since.length && since.every((ref) => parents.get(ref) > 1)) {
      const [now, then] = await Promise.all([prChanges(github, repo, pr.base.ref, sha), prChanges(github, repo, pr.base.ref, prior.ref)]);
      if (now !== null && now === then) {
        return carry('changes nothing of the PR\'s', `no changes since ${short(prior.ref)}: ${verdict}`);
      }
    }
    // so does a pass whose own suggestions were applied, and nothing else
    if (prior.state === 'success' && reviewId && since.length && since.at(-1) === sha) {
      const byPath = await suggested(github, repo, number, reviewId);
      if (byPath.size) {
        const commits = await Promise.all(since.map((ref) => github.rest.repos.getCommit({ ...repo, ref }).then((r) => r.data)));
        if (commits.every((c) => appliedSuggestion(c, cfg.reviewer, byPath))) {
          return carry('only applies the review\'s suggestions', `suggestions applied since ${short(prior.ref)}: ${verdict}`);
        }
      }
    }
  }

  // reviews this round without a pass: the review agent's own verdicts (not carried ones) newer
  // than its latest pass, which ends a run of them. Counting the pass too stalled a PR whose
  // last review passed, when a merge of the base was not carried (selenium-flow #218)
  const own = round.filter((s) => VERDICT.test(s.description));
  const passed = own.findIndex((s) => s.state === 'success');
  const done = passed < 0 ? own.length : passed;
  // the owner's own dispatch is never capped
  const capped = !(dispatched && actor === cfg.owner);
  if (capped && done >= cfg.maxReviews) {
    await stalled(`needs a human: ${done} reviews without a pass`);
    return core.info(`${done} reviews without a pass: over to a human`);
  }
  await status('pending', `reviewing (${done + 1} of ${cfg.maxReviews})`);
  core.setOutput('number', String(number));
  core.setOutput('sha', sha);
  core.setOutput('last', String(capped && done + 1 >= cfg.maxReviews));
  core.setOutput('target', target);
}

module.exports = { run, appliedSuggestion, suggested, prChanges };
