// On a pull request: answers review threads the way the agent decided (a reply, and a
// resolve when it fixed or settled one), and marks a draft ready when the agent says the
// work is done. A reply and its resolve happen together, never one without the other.

const fs = require('fs');
const { gql } = require('./util');
const { askCopilot } = require('./copilot');

async function run({ github, context, core }) {
  const env = process.env;
  const out = env.STRUCTURED_FILE ? JSON.parse(fs.readFileSync(env.STRUCTURED_FILE, 'utf8')) : {};
  for (const t of out.threads || []) {
    await github.graphql(gql('reply-thread'), { thread: t.id, body: t.reply });
    if (t.resolve) await github.graphql(gql('resolve-thread'), { thread: t.id });
    core.info(`thread ${t.id}: replied${t.resolve ? ' and resolved' : ''}`);
  }
  // a run that pushed has a review coming; ready waits for a run that pushed nothing
  if (out.ready === true && env.PUSHED !== 'true') {
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(env.NUMBER) });
    if (pr.draft) await github.graphql(gql('ready-for-review'), { id: pr.node_id });
  }
  // a run that pushed asked already; this covers a PR just marked ready, by the agent or
  // by hand, whose head Copilot has not seen
  if (env.REQUEST_REVIEW === 'copilot' && env.PUSHED !== 'true') await askCopilot({ github, context, core, number: Number(env.NUMBER) });
}

module.exports = { run };
