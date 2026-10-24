// What a pull request's checks found, written for an agent. Code scanning alerts are the
// to-do list that keeps its own state: open until a scan stops finding one (fixed) or a
// human dismisses it. Annotations are only what the head's checks said this time.

const fs = require('fs');
const path = require('path');

// GitHub's code scanning app: its check runs and its review threads
const SCANNER = 'github-advanced-security';
const LEVELS = ['failure', 'warning'];
const PER_RUN = 50;

const short = (sha) => (sha || '').slice(0, 7);
const oneLine = (text, max = 400) => (text || '').replace(/\s+/g, ' ').trim().slice(0, max);
const severity = (a) => a.rule?.security_severity_level || a.rule?.severity || 'unknown';
const where = (a) => {
  const l = a.most_recent_instance?.location || {};
  return `${l.path || '?'}:${l.start_line ?? '?'}`;
};

function list(github, fn, params) {
  if (github.paginate) return github.paginate(fn, params);
  return fn(params).then((r) => r.data);
}

// a ref with no analysis yet answers 404; a repository without code scanning, 403
async function openAlerts(github, repo, ref) {
  try {
    return await list(github, github.rest.codeScanning.listAlertsForRepo, { ...repo, ref, state: 'open', per_page: 100 });
  } catch (e) {
    if (e.status === 404 || e.status === 403) return null;
    throw e;
  }
}

// the scanner's threads, by the alert each one is about
async function scannerThreads(github, repo, number) {
  const query = fs.readFileSync(path.join(__dirname, 'graphql', 'threads.graphql'), 'utf8');
  const data = await github.graphql(query, { ...repo, number });
  const byAlert = new Map();
  for (const t of data.repository.pullRequest.reviewThreads.nodes) {
    const first = t.first.nodes[0];
    if (first?.author?.login !== SCANNER) continue;
    const alert = Number(/security\/code-scanning\/(\d+)/.exec(first.body || '')?.[1]) || 0;
    if (alert) byAlert.set(alert, { id: t.id, resolved: t.isResolved, last: t.last.nodes[0] });
  }
  return byAlert;
}

function threadLine(t) {
  if (!t) return 'No thread: it is not on a line this PR changed.';
  const state = t.resolved ? 'resolved' : 'open';
  const last = t.last && t.last.author?.login !== SCANNER
    ? ` Last reply, @${t.last.author?.login}: "${oneLine(t.last.body, 300)}"` : '';
  return `Thread \`${t.id}\` (${state}).${last}`;
}

function alertBlock(a, t) {
  return [
    `### #${a.number} · ${severity(a)} · ${a.tool?.name} \`${a.rule?.id}\``,
    '',
    `\`${where(a)}\`: ${oneLine(a.most_recent_instance?.message?.text || a.rule?.description)}`,
    '',
    a.html_url,
    '',
    threadLine(t),
    '',
  ];
}

function securityFile({ number, head, onPr, onBase, files, threads, scans }) {
  const md = [`# Code scanning on #${number}`, ''];
  const running = scans.filter((s) => s.status !== 'completed');
  if (running.length) md.push(`Still scanning ${short(head)}: ${running.map((s) => s.name).join(', ')}. This list can change when it ends.`, '');
  if (onPr === null) {
    md.push('No scan of this PR yet.', '');
    return md.join('\n');
  }
  const base = new Set((onBase || []).map((a) => a.number));
  const fresh = onPr.filter((a) => !base.has(a.number));
  const touched = onPr.filter((a) => base.has(a.number) && files.has(a.most_recent_instance?.location?.path));
  const elsewhere = onPr.filter((a) => base.has(a.number) && !files.has(a.most_recent_instance?.location?.path)).length;
  md.push(`## New in this PR (${fresh.length})`, '');
  if (!fresh.length) md.push('None.', '');
  for (const a of fresh) md.push(...alertBlock(a, threads.get(a.number)));
  if (touched.length) {
    md.push(`## Already on main, in files this PR changes (${touched.length})`, '');
    for (const a of touched) md.push(...alertBlock(a, threads.get(a.number)));
  }
  // a thread whose alert is no longer open still has to be resolved before a merge
  const open = new Set(onPr.map((a) => a.number));
  const settled = [...threads].filter(([n, t]) => !open.has(n) && !t.resolved);
  if (settled.length) {
    md.push(`## Threads left open on alerts that are no longer open (${settled.length})`, '');
    for (const [n, t] of settled) md.push(`- #${n}: thread \`${t.id}\`. Resolve it.`);
    md.push('');
  }
  if (elsewhere) md.push(`${elsewhere} more alert${elsewhere === 1 ? '' : 's'} open on main, in files this PR does not touch: not this PR's.`, '');
  return md.join('\n');
}

async function annotations(github, repo, runs) {
  const out = [];
  for (const run of runs) {
    if (run.app?.slug === SCANNER || run.status !== 'completed' || !run.output?.annotations_count) continue;
    const all = await list(github, github.rest.checks.listAnnotations, { ...repo, check_run_id: run.id, per_page: 100 });
    const kept = all.filter((a) => LEVELS.includes(a.annotation_level)).slice(0, PER_RUN);
    if (kept.length) out.push({ run, kept });
  }
  return out;
}

function checksFile({ head, found }) {
  const md = [`# Annotations on ${short(head)}`, ''];
  if (!found.length) md.push('No failure or warning annotations on the head.', '');
  for (const { run, kept } of found) {
    md.push(`## ${run.name}: ${run.conclusion || run.status}`, '', run.html_url || '', '');
    for (const a of kept) md.push(`- ${a.annotation_level} \`${a.path}:${a.start_line}\`${a.title ? ` ${oneLine(a.title, 120)}` : ''}: ${oneLine(a.message)}`);
    md.push('');
  }
  return md.join('\n');
}

async function run({ github, context, core }) {
  const env = process.env;
  const repo = context.repo;
  const number = Number(env.NUMBER);
  const dir = path.join(env.GITHUB_WORKSPACE || process.cwd(), env.SCRATCH_DIR || '.issue');
  const scanNames = (env.SCANS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number });
  const head = pr.head.sha;
  const [onPr, onBase, changed, threads, runs] = await Promise.all([
    openAlerts(github, repo, `refs/pull/${number}/merge`),
    openAlerts(github, repo, `refs/heads/${pr.base.ref}`),
    list(github, github.rest.pulls.listFiles, { ...repo, pull_number: number, per_page: 100 }),
    scannerThreads(github, repo, number),
    list(github, github.rest.checks.listForRef, { ...repo, ref: head, per_page: 100 }),
  ]);
  const files = new Set(changed.map((f) => f.filename));
  const scans = runs.filter((r) => scanNames.includes(r.name) && r.app?.slug !== SCANNER);
  const found = await annotations(github, repo, runs);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'security.md'), `${securityFile({ number, head, onPr, onBase, files, threads, scans })}\n`);
  fs.writeFileSync(path.join(dir, 'checks.md'), `${checksFile({ head, found })}\n`);
  const base = new Set((onBase || []).map((a) => a.number));
  const fresh = (onPr || []).filter((a) => !base.has(a.number)).length;
  core.setOutput('new_alerts', String(fresh));
  core.setOutput('pending', String(scans.some((s) => s.status !== 'completed')));
  core.info(`${fresh} new alerts, ${found.length} checks with annotations`);
}

module.exports = { run, securityFile, checksFile, SCANNER };
