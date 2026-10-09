// On a pull request: answers review threads the way the agent decided (a reply, and a
// resolve when it fixed or settled one), and marks a draft ready when the agent says the
// work is done. A reply and its resolve happen together, never one without the other.

const fs = require('fs');
const { gql } = require('./util');

function structured(env) {
  return env.STRUCTURED_FILE ? JSON.parse(fs.readFileSync(env.STRUCTURED_FILE, 'utf8')) : {};
}

async function run({ github, context, core }) {
  const env = process.env;
  const out = structured(env);
  // ready runs as its own step, on the App's token: a GITHUB_TOKEN event wakes no
  // workflow, and ready for review is what has Copilot review the PR
  if (env.MODE === 'ready') {
    // a run that pushed has more coming; ready waits for a run that pushed nothing
    if (out.ready !== true || env.PUSHED === 'true') return;
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: Number(env.NUMBER) });
    if (pr.draft) await github.graphql(gql('ready-for-review'), { id: pr.node_id });
    return;
  }
  for (const t of out.threads || []) {
    await github.graphql(gql('reply-thread'), { thread: t.id, body: t.reply });
    if (t.resolve) await github.graphql(gql('resolve-thread'), { thread: t.id });
    core.info(`thread ${t.id}: replied${t.resolve ? ' and resolved' : ''}`);
  }
}

module.exports = { run };
