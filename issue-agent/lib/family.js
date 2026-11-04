// An issue's family: its top parent, or the issue itself. A family is one conversation, so
// its issues share a session and take their turns one at a time (spec 2026-11-03 Part 4).

const DEPTH = 8;

// the issue's parent, 0 for none
async function parentOf(github, { owner, repo }, number) {
  try {
    const { data } = await github.request('GET /repos/{owner}/{repo}/issues/{issue_number}/parent', { owner, repo, issue_number: number });
    return Number(data?.number) || 0;
  } catch (e) {
    if (e.status === 404) return 0;
    throw e;
  }
}

async function familyOf(github, repo, number) {
  let top = Number(number);
  const seen = new Set([top]);
  for (let i = 0; i < DEPTH; i += 1) {
    const up = await parentOf(github, repo, top);
    if (!up || seen.has(up)) break;
    seen.add(up);
    top = up;
  }
  return top;
}

module.exports = { parentOf, familyOf };
