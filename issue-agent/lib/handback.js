// A family turn's hand-back to n8n (spec 2026-11-24 R-SM17, R-SM21): a sub-issue's `report`,
// which n8n posts on the parent and wakes it with; a parent's `actions`, which n8n carries out
// in order. Each goes to the agent-flow callback with the channel's token. Nothing goes when the
// field is empty, and n8n's answer never fails the job: a refusal or no answer is a warning.
// A body made elsewhere (review-route's `verdict`, R-SM4) goes as it is, in place of these.
// make-sub-issue hands back the number it filed (`filed`, R-SM25), and n8n starts its first turn.
// A downstream issue's turn reports to its upstream epic (`upstream-report`, spec 2026-11-24
// upstream releases, R-UR9), and so does its PR's plan turn, saying its plan is ready.

const TIMEOUT = 10000;
const REF = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[1-9]\d*$/;

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// the body for the turn's kin, or null: a sub-issue reports, a parent acts, a downstream issue
// reports to its epic
function bodyOf({ kin, output, repo, number, parent, upstream, pullRequest, runId }) {
  const { report, actions } = output || {};
  if (kin === 'filed') return filed({ type: 'filed', repo, parent, number, run_id: runId });
  if (kin === 'downstream' || kin === 'downstream-plan') {
    if (!REF.test(upstream || '') || !id(number)) return null;
    if (kin === 'downstream' && typeof report === 'string' && report.trim()) {
      return { type: 'upstream-report', repo, number, upstream, report: report.trim(), run_id: runId };
    }
    const plan = typeof output?.plan_path === 'string' ? output.plan_path.trim() : '';
    if (kin === 'downstream-plan' && plan && id(pullRequest)) {
      return { type: 'upstream-report', repo, number, upstream, report: `The plan is ready on #${pullRequest}: \`${plan}\`.`, pull_request: pullRequest, run_id: runId };
    }
    return null;
  }
  if (kin === 'sub-issue' && typeof report === 'string' && report.trim()) {
    return { type: 'report', repo, parent, number, report: report.trim(), run_id: runId };
  }
  if (kin === 'parent' && Array.isArray(actions) && actions.length) {
    return { type: 'actions', repo, parent: number, run_id: runId, actions };
  }
  return null;
}

// the bodies n8n's callback takes
const TYPES = ['verdict', 'report', 'actions', 'filed', 'upstream-report'];

// a filed body names the new sub-issue and its parent, two different issues
const id = (n) => Number.isInteger(n) && n > 0;
const filed = (body) => (id(body.number) && id(body.parent) && body.number !== body.parent ? body : null);

// a body that came made: sent only when it is one of the callback's types
function made(text, core) {
  const body = parse(text);
  const typed = body && typeof body === 'object' && TYPES.includes(body.type);
  if (typed && (body.type !== 'filed' || filed(body))) return body;
  core.warning(`the body is not one n8n takes (${TYPES.join(', ')}): nothing is sent`);
  return null;
}

async function run({ context, core, fetch = globalThis.fetch, env = process.env }) {
  const { owner, repo } = context.repo;
  const body = (env.BODY || '').trim() ? made(env.BODY, core) : bodyOf({
    kin: env.KIN,
    output: parse(env.OUTPUT),
    repo: `${owner}/${repo}`,
    number: Number(env.NUMBER) || 0,
    parent: Number(env.PARENT) || 0,
    upstream: (env.UPSTREAM || '').trim(),
    pullRequest: Number(env.PULL_REQUEST) || 0,
    runId: Number(context.runId) || 0,
  });
  if (!body) return core.info('nothing to hand back');
  const plural = body.type === 'actions';
  const what = `the ${body.type} ${plural ? 'are' : 'is'}`;
  if (!env.AGENT_FLOW_CALLBACK_URL || !env.AGENT_FLOW_N8N_TOKEN) {
    return core.warning(`no AGENT_FLOW_CALLBACK_URL or AGENT_FLOW_N8N_TOKEN: ${what} not sent`);
  }
  try {
    const res = await fetch(env.AGENT_FLOW_CALLBACK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-flow-token': env.AGENT_FLOW_N8N_TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return core.warning(`n8n answered the ${body.type} with ${res.status}: it may not act on it`);
  } catch (err) {
    return core.warning(`the ${body.type} ${plural ? 'were' : 'was'} not sent: ${err.message}`);
  }
  core.setOutput('sent', body.type);
  core.info(`${body.type} sent for #${body.number || body.parent}`);
}

module.exports = { bodyOf, run };
