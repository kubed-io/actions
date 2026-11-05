// On a pull request: answers review threads the way the agent decided (a reply, and a
// resolve when it fixed or settled one). A reply and its resolve happen together, never one
// without the other.

const { TAG } = require('./state');
const fs = require('fs');
const { gql } = require('./util');

function structured(env) {
  return env.STRUCTURED_FILE ? JSON.parse(fs.readFileSync(env.STRUCTURED_FILE, 'utf8')) : {};
}

async function run({ github, context, core }) {
  const env = process.env;
  const out = structured(env);
  for (const t of out.threads || []) {
    // tagged, so the review GitHub wraps a reply in reads as the agent's own next run
    await github.graphql(gql('reply-thread'), { thread: t.id, body: `${t.reply}\n\n${TAG}` });
    if (t.resolve) await github.graphql(gql('resolve-thread'), { thread: t.id });
    core.info(`thread ${t.id}: replied${t.resolve ? ' and resolved' : ''}`);
  }
}

module.exports = { run };
