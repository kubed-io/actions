// Decides whether the review agent reviews a PR's head, from a finished checks run
// (workflow_run), a push (pull_request_target) or an `agent-review` dispatch. Its answer
// is a commit status on the head: the PR's required check, and the loop's memory, since a
// head the review agent already judged carries its status.

const VERDICT = /^(looks good|changes requested|needs a human)$|^changes requested, last review/;
// a verdict carried to a later commit, with the commit it was given on
const CARRIED = /^(?:no changes|suggestions applied) since \w+: /;
const failedChecks = (s) => /^checks failed/.test(s?.description || '');
const short = (sha) => (sha || '').slice(0, 7);
const csv = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

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
  };
}

// what the PR itself changes at a commit, blind to line numbers, so merging the base in
// leaves it as it was; null when GitHub's compare is cut off at 300 files
async function prChanges(github, repo, base, ref) {
  const { data } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${base}...${ref}` });
  if ((data.files?.length || 0) >= 300) return null;
  return data.files.map((f) => `${f.status} ${f.filename} ${f.previous_filename || ''}\n${
    f.patch == null ? `blob ${f.sha}` : f.patch.replace(/^@@[^@]*@@/gm, '@@')}`).sort().join('\n');
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

async function run({ github, context, core, env = process.env }) {
  const cfg = settings(env);
  const repo = context.repo;
  const e = context.payload;
  const dispatched = context.eventName === 'repository_dispatch';
  const checksRun = e.workflow_run;
  for (const k of ['number', 'sha', 'last']) core.setOutput(k, '');
  if (checksRun?.conclusion === 'cancelled') return core.info('cancelled: a newer push has its own run');

  let number = Number(dispatched ? e.client_payload?.pull_request
    : checksRun ? checksRun.pull_requests?.[0]?.number : e.pull_request?.number) || 0;
  // a fork's run names no PR: find it by its head
  if (!number && checksRun) {
    const { data: prs } = await github.rest.pulls.list({ ...repo, state: 'open', head: `${checksRun.head_repository?.owner?.login}:${checksRun.head_branch}` });
    number = prs.find((p) => p.head.sha === checksRun.head_sha)?.number || 0;
  }
  if (!number) return core.info('no pull request');
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number });
  if (pr.state !== 'open' || pr.draft) return core.info(`#${number} is ${pr.draft ? 'a draft' : pr.state}`);
  const sha = pr.head.sha;
  if (checksRun && checksRun.head_sha !== sha) return core.info(`${checksRun.head_sha} is no longer the head`);
  const runUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  const status = (state, description, target_url = runUrl) => github.rest.repos.createCommitStatus({
    ...repo, sha, state, description, target_url, context: cfg.check,
  });

  const ours = pr.head.repo?.full_name === `${repo.owner}/${repo.repo}`;
  const labels = pr.labels.map((l) => l.name);
  if (!ours || !pr.head.ref.startsWith(cfg.prefix) || !cfg.labels.every((l) => labels.includes(l))) {
    await status('success', 'not built by the agents');
    return core.info(`#${number} was not built by the agents`);
  }

  // the checks: a run without the collector's report ran none (a label, a draft)
  let checks = 'unknown';
  if (checksRun) {
    const { data } = await github.rest.actions.listWorkflowRunArtifacts({ ...repo, run_id: checksRun.id, name: cfg.artifact });
    if (!data.artifacts.length) return core.info('no checks ran in this run');
    checks = checksRun.conclusion === 'success' ? 'passed' : 'failed';
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
  const all = (await github.paginate(github.rest.pulls.listCommits, { ...repo, pull_number: number, per_page: 100 }))
    .map((c) => c.sha);
  const judged = [];
  for (const ref of all.filter((c) => c !== sha).reverse()) {
    const s = await mineOn(ref);
    if (s && (s.state === 'success' || s.state === 'failure')) judged.push({ ref, ...s });
  }

  // red: the code agent gets the run, the review waits for green
  if (checks === 'failed') {
    const fixes = judged.filter(failedChecks).length;
    if (fixes >= cfg.maxFixes) {
      await status('failure', `needs a human: checks failed on ${fixes + 1} commits`, checksRun.html_url);
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
    const carry = async (why, description) => {
      await status(prior.state, description, prior.target_url);
      core.info(`${sha} ${why} since ${prior.ref}`);
      return true;
    };
    // a commit that only brings the base in (Update branch) keeps it
    const [now, then] = await Promise.all([prChanges(github, repo, pr.base.ref, sha), prChanges(github, repo, pr.base.ref, prior.ref)]);
    if (now !== null && now === then) {
      return carry('changes nothing of the PR\'s', `no changes since ${short(prior.ref)}: ${verdict}`);
    }
    // so does a pass whose own suggestions were applied, and nothing else
    const reviewId = Number(/#pullrequestreview-(\d+)$/.exec(prior.target_url || '')?.[1]) || 0;
    const at = all.indexOf(prior.ref);
    const since = at < 0 ? [] : all.slice(at + 1);
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

  // reviews so far: commits with a verdict of the review agent's own, not a carried one
  const done = judged.filter((s) => VERDICT.test(s.description)).length;
  // the owner's own dispatch is never capped
  const capped = !(dispatched && actor === cfg.owner);
  if (capped && done >= cfg.maxReviews) {
    await status('failure', `needs a human: ${done} reviews without a pass`);
    return core.info(`${done} reviews without a pass: over to a human`);
  }
  await status('pending', `reviewing (${done + 1} of ${cfg.maxReviews})`);
  core.setOutput('number', String(number));
  core.setOutput('sha', sha);
  core.setOutput('last', String(capped && done + 1 >= cfg.maxReviews));
}

module.exports = { run, appliedSuggestion, suggested, prChanges };
