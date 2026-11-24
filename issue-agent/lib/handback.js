// A family turn's hand-back to n8n (spec 2026-11-24 R-SM17, R-SM21): a sub-issue's `report`,
// which n8n posts on the parent and wakes it with; a parent's `actions`, which n8n carries out
// in order. Each goes to the agent-flow callback with the channel's token. Nothing goes when the
// field is empty, and n8n's answer never fails the job: a refusal or no answer is a warning.

const TIMEOUT = 10000;

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// the body for the turn's kin, or null: a sub-issue reports, a parent acts
function bodyOf({ kin, output, repo, number, parent, runId }) {
  const { report, actions } = output || {};
  if (kin === 'sub-issue' && typeof report === 'string' && report.trim()) {
    return { type: 'report', repo, parent, number, report: report.trim(), run_id: runId };
  }
  if (kin === 'parent' && Array.isArray(actions) && actions.length) {
    return { type: 'actions', repo, parent: number, run_id: runId, actions };
  }
  return null;
}

async function run({ context, core, fetch = globalThis.fetch, env = process.env }) {
  const { owner, repo } = context.repo;
  const body = bodyOf({
    kin: env.KIN,
    output: parse(env.OUTPUT),
    repo: `${owner}/${repo}`,
    number: Number(env.NUMBER) || 0,
    parent: Number(env.PARENT) || 0,
    runId: Number(context.runId) || 0,
  });
  if (!body) return core.info('nothing to hand back');
  const what = body.type === 'report' ? 'the report is' : 'the actions are';
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
    return core.warning(`${body.type === 'report' ? 'the report was' : 'the actions were'} not sent: ${err.message}`);
  }
  core.setOutput('sent', body.type);
  core.info(`${body.type} sent for #${body.number || body.parent}`);
}

module.exports = { bodyOf, run };
