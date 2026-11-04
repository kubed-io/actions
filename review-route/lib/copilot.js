// The code job's two steps on a change the owner gave Copilot (review-route/copilot).
//
// wait: before a code turn, Copilot's review of the head, when it was asked for one, so the
// turn answers the checks and Copilot together.
// ask: after a code turn, Copilot is asked to review the new head, alongside its checks.
// Neither does anything on a draft, or on a change Copilot was never opted into.

const copilot = require('../../issue-agent/lib/copilot');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (sha) => (sha || '').slice(0, 7);

// the change, its head and the timeline, when Copilot is the change's reviewer
async function copilots(github, context, core, env) {
  const repo = context.repo;
  const number = Number(env.NUMBER);
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number });
  if (pr.state !== 'open' || pr.draft) return core.info(`#${number} is ${pr.draft ? 'a draft' : pr.state}`);
  const events = await copilot.timeline(github, { ...repo, number });
  if (!copilot.optedIn(events, env.OWNER)) return core.info(`#${number} is the review agent's`);
  const sha = pr.head.sha;
  const { data: commit } = await github.rest.repos.getCommit({ ...repo, ref: sha });
  return { repo, number, sha, events, committed: commit.commit.committer.date };
}

async function wait({ github, context, core, env = process.env, pause = sleep }) {
  const c = await copilots(github, context, core, env);
  if (!c) return;
  const reviewed = async () => (await copilot.reviewsOf(github, { ...c.repo, number: c.number, sha: c.sha })).length > 0;
  if (await reviewed()) return core.info(`Copilot already reviewed ${short(c.sha)}`);
  if (!copilot.askedSince(c.events, c.committed)) return core.info(`Copilot was not asked to review ${short(c.sha)}`);
  const timeoutMs = Number(env.TIMEOUT_MINUTES || 20) * 60000;
  const intervalMs = Number(env.INTERVAL_SECONDS || 20) * 1000;
  for (let waited = 0; waited < timeoutMs; waited += intervalMs) {
    await pause(intervalMs);
    if (await reviewed()) return core.notice(`Copilot reviewed ${short(c.sha)}: the turn answers it too`);
  }
  core.warning(`Copilot did not review ${short(c.sha)} in time: the turn goes on without it`);
}

async function ask({ github, context, core, env = process.env }) {
  const c = await copilots(github, context, core, env);
  if (!c) return;
  const reviews = await copilot.reviewsOf(github, { ...c.repo, number: c.number, sha: c.sha });
  if (reviews.some((r) => !copilot.failedReview(r))) return core.info(`Copilot already reviewed ${short(c.sha)}`);
  if (copilot.askedSince(c.events, c.committed)) return core.info(`Copilot is already asked to review ${short(c.sha)}`);
  await copilot.ask(github, { ...c.repo, number: c.number });
  core.notice(`Copilot asked to review ${short(c.sha)}`);
}

async function run(args) {
  const step = (args.env || process.env).STEP;
  if (step === 'wait') return wait(args);
  if (step === 'ask') return ask(args);
  throw new Error(`unknown step: ${step}`);
}

module.exports = { run, wait, ask };
