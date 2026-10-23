// Whether the agent's notes in a body may be believed. Anyone who can edit an issue can
// rewrite its notes block, so the notes count only when the body's last editor (the
// author when it was never edited) is an installed App or Action, which edit as a Bot, or
// one of the trusted ids.

const { gql } = require('./util');

function wroteLast(editor, ids) {
  return !!editor && (editor.__typename === 'Bot' || ids.includes(String(editor.databaseId)));
}

// the body and its last editor, in one query, so the two describe the same edit
async function lastEdit(github, { owner, repo, number }) {
  const { repository } = await github.graphql(gql('body-editor'), { owner, repo, number });
  const node = repository.issueOrPullRequest || {};
  return { body: node.body ?? null, editor: node.editor || node.author || null };
}

module.exports = { wroteLast, lastEdit };
