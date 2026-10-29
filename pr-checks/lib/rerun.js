// Re-runs a checks run's failed jobs, when someone who read the failure judged it not the
// change's (a flaky test, an outage). At most max_attempts runs in all, so a failure that
// comes back is left for a human, not retried forever.

async function run({ github, context, core, env = process.env }) {
  core.setOutput('rerun', 'false');
  const runId = Number(env.RUN_ID) || 0;
  if (!runId) return core.info('no run to re-run');
  const max = Number(env.MAX_ATTEMPTS) || 2;
  const { data: r } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runId });
  if (r.status !== 'completed' || r.conclusion !== 'failure') {
    return core.info(`run ${runId} is ${r.status === 'completed' ? r.conclusion : r.status}: nothing to re-run`);
  }
  if ((r.run_attempt || 1) >= max) {
    return core.notice(`run ${runId} already ran ${r.run_attempt} times, the most allowed: over to a human`);
  }
  await github.rest.actions.reRunWorkflowFailedJobs({ ...context.repo, run_id: runId });
  core.setOutput('rerun', 'true');
  core.notice(`re-running the failed jobs of run ${runId} (attempt ${(r.run_attempt || 1) + 1} of ${max})`);
}

module.exports = { run };
