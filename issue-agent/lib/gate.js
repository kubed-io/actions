// Decides whether this run may happen at all, before anything is posted.
//
// opt_in_label: the label must have been added, the last time, by a trusted id. An issue
// template applies its labels for whoever files it, so a label proves nothing on its own.
// max_runs: a cap on the agent's replies under one session key in one thread.

const { TAG, readSeen, isAgent } = require('./state');
const { list } = require('./util');

const CAP = '<!-- issue-agent-cap -->';

function lastLabeledBy(events, label) {
  let actor = null;
  for (const e of events) if (e.event === 'labeled' && e.label?.name === label) actor = e.actor;
  return actor;
}

// only the agent's own comments count: a stranger in a public repo can paste markers
const isOwnRun = (c, key) => isAgent(c.body) && c.user?.type === 'Bot' && readSeen(c.body)?.key === key;

function runsSoFar(comments, key) {
  return comments.filter((c) => isOwnRun(c, key)).length;
}

async function run({ github, context, core }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const issue_number = Number(env.NUMBER) || 0;
  const ids = list(env.TRUSTED_IDS);
  const allow = (ok, why) => {
    core.setOutput('allowed', String(ok));
    if (!ok) core.notice(why);
  };

  if (!issue_number) return allow(true);

  if (env.OPT_IN_LABEL) {
    const events = await github.paginate(github.rest.issues.listEventsForTimeline, { owner, repo, issue_number, per_page: 100 });
    const actor = lastLabeledBy(events, env.OPT_IN_LABEL);
    if (!actor || !ids.includes(String(actor.id))) {
      return allow(false, `${env.OPT_IN_LABEL} was last added by ${actor ? `@${actor.login}` : 'nobody'}, not a trusted user`);
    }
  }

  const max = Number(env.MAX_RUNS) || 0;
  if (max > 0) {
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 });
    const runs = runsSoFar(comments, env.SESSION_KEY);
    if (runs >= max) {
      let lastOwn = -1;
      comments.forEach((c, i) => { if (isOwnRun(c, env.SESSION_KEY)) lastOwn = i; });
      const noted = comments.slice(lastOwn + 1).some((c) => c.body?.includes(CAP));
      if (!noted) {
        await github.rest.issues.createComment({ owner, repo, issue_number, body: `${TAG}\n${CAP}\nPaused: this conversation has had ${runs} agent runs, its cap. Raise \`max_runs\` in the workflow to go on.` });
      }
      return allow(false, `${runs} runs reached max_runs ${max}`);
    }
  }
  return allow(true);
}

module.exports = { lastLabeledBy, runsSoFar, run };
