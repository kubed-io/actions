// Pushes what the agent committed. The checkout keeps no credentials, so the agent never
// held one; the token arrives here, after Claude has finished.

const { askCopilot } = require('./copilot');

async function run({ github, context, core, exec }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  core.setSecret(env.PUSH_TOKEN);
  const host = new URL(env.GITHUB_SERVER_URL || 'https://github.com').host;
  const remote = `https://x-access-token:${env.PUSH_TOKEN}@${host}/${owner}/${repo}.git`;
  const tracking = `refs/remotes/issue-agent/${env.HEAD}`;

  await exec.exec('git', ['fetch', '--quiet', remote, `+refs/heads/${env.HEAD}:${tracking}`]);
  const { stdout } = await exec.getExecOutput('git', ['rev-list', '--count', `${tracking}..HEAD`]);
  const ahead = Number(stdout.trim());
  if (!ahead) {
    core.setOutput('pushed', 'false');
    core.info('nothing to push');
    return;
  }
  await exec.exec('git', ['push', remote, `HEAD:refs/heads/${env.HEAD}`]);
  core.setOutput('pushed', 'true');
  core.info(`pushed ${ahead} commit(s) to ${env.HEAD}`);

  // where no ruleset has Copilot review a push (a private repo on the Free plan); a draft
  // waits, since Copilot starts at ready for review
  if (env.REQUEST_REVIEW === 'copilot') await askCopilot({ github, context, core, number: Number(env.NUMBER) });
}

module.exports = { run };
