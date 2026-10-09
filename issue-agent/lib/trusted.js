// Whether a body's round state may be believed. Anyone who can edit an issue can append a
// fake state section, so the state counts only when the last editor of the body (the
// author when it was never edited) is an installed App or Action, which edit as a Bot, or
// one of the trusted users. The body is read in the same query as its editor, so the two
// always describe the same edit.

const { readState, validState } = require('./state');
const { gql } = require('./util');

async function bodyState(github, { owner, repo, number, document, body, ids, server }) {
  if (!readState(body, document)) return null;
  const { repository } = await github.graphql(gql('body-editor'), { owner, repo, number });
  const node = repository.issueOrPullRequest || {};
  if (typeof node.body === 'string') body = node.body;
  const actor = node.editor || node.author;
  const ok = !!actor && (actor.__typename === 'Bot' || ids.includes(String(actor.databaseId)));
  if (!ok) return null;
  return validState(readState(body, document), { server, owner, repo });
}

module.exports = { bodyState };
