// The checks report: what failed in this workflow run, written for the code agent and
// uploaded as an artifact. Runs as the run's last job, after every check.
//
// report.md: per failed job, its failed steps, its failure and warning annotations, its
// error lines, and the log up to its last error. report.json: the same, counted.

const fs = require('fs');
const path = require('path');

const BAD = ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'];
const MAX_ERRORS = 40;
const MAX_NOTES = 50;
const TAIL = 150;

// no timestamps, no colour codes: the report is read, not displayed. The tail is the lines
// that led to the last error, before the post-job cleanup
function trimLog(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
  const errors = lines.filter((l) => l.includes('##[error]'));
  let end = lines.findIndex((l) => l.startsWith('Post job cleanup.'));
  if (end < 0) end = lines.length;
  const last = lines.slice(0, end).findLastIndex((l) => l.includes('##[error]'));
  const stop = last >= 0 ? last + 1 : end;
  return { errors: errors.slice(0, MAX_ERRORS), tail: lines.slice(Math.max(0, stop - TAIL), stop) };
}

async function log(github, repo, job) {
  try {
    const { data } = await github.rest.actions.downloadJobLogsForWorkflowRun({ ...repo, job_id: job.id });
    return trimLog(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  } catch (err) {
    return { errors: [`(log unavailable: ${err.message})`], tail: [] };
  }
}

async function notes(github, repo, job) {
  try {
    const all = await github.paginate(github.rest.checks.listAnnotations, { ...repo, check_run_id: job.id, per_page: 100 });
    return all.filter((a) => a.annotation_level !== 'notice').slice(0, MAX_NOTES);
  } catch { return []; }
}

async function run({ github, context, core, env = process.env }) {
  const { DIR, SHA } = env;
  const repo = context.repo;
  // every finished job but this one, which is still running
  const jobs = (await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo, run_id: context.runId, filter: 'latest', per_page: 100,
  })).filter((j) => j.name !== context.job && j.status === 'completed');
  const failed = jobs.filter((j) => BAD.includes(j.conclusion));

  const report = { sha: SHA, run: context.runId, passed: jobs.length - failed.length, failed: [] };
  const md = [`# Checks on ${SHA.slice(0, 7)}: ${failed.length ? `${failed.length} failed` : 'all passed'}`, ''];
  for (const job of failed) {
    const [l, a] = await Promise.all([log(github, repo, job), notes(github, repo, job)]);
    const steps = (job.steps || []).filter((s) => BAD.includes(s.conclusion)).map((s) => s.name);
    report.failed.push({ name: job.name, conclusion: job.conclusion, url: job.html_url, steps, annotations: a.length });
    md.push(`## ${job.name}: ${job.conclusion}`, '', job.html_url, '');
    if (steps.length) md.push(`Failed steps: ${steps.join(', ')}`, '');
    if (a.length) {
      md.push('### Annotations', '');
      for (const n of a) md.push(`- ${n.annotation_level} \`${n.path}:${n.start_line}\`${n.title ? ` ${n.title}` : ''}: ${n.message.replace(/\s+/g, ' ').slice(0, 500)}`);
      md.push('');
    }
    if (l.errors.length) md.push('### Errors', '', '```', ...l.errors, '```', '');
    if (l.tail.length) md.push('### The log, up to the error', '', '```', ...l.tail, '```', '');
  }
  if (!failed.length) md.push(`Every check passed (${jobs.length} jobs).`);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'report.md'), md.join('\n') + '\n');
  fs.writeFileSync(path.join(DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await core.summary.addRaw(md.join('\n').slice(0, 900000)).write();
  core.setOutput('failed', String(failed.length));
}

module.exports = { run, trimLog };
