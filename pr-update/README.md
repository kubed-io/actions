# PR Update

Brings every open PR on a branch up to date after a merge into it. Each agent PR moves the
`docs` pointer (the wiki) to its own wiki commit and adds lines under the changelog's
`## [Unreleased]`, so once one merges the others conflict there. Specs and plans are
committed straight to the wiki's master, so its head holds every PR's wiki commits: the
pointer conflict resolves to it (cluster spec 2026-11-12, R-L9).

For every open PR whose base is `base` and whose head is in this repository:

| Step | Result |
|---|---|
| The base is already in the head | `current` |
| GitHub's update-branch, from the head it was at, takes | `updated` |
| Else the base is merged into the head in the checkout, and resolves | `merged`, or `merged & resolved: pointer, changelog` |
| A conflict it does not resolve | `needs its agent: <paths>`, the merge aborted; ` (dispatched)` when the head is an agent's |
| The branch moved before the update (the agent committed) | `moved during the update; next merge retries` |
| Anything else that went wrong for that PR | `failed: <why>` |

What the merge resolves:

- **A submodule pointer** both sides moved: its remote (`.gitmodules`' url, at its
  `branch` or the remote's default) is fetched into the repository, and when its head holds
  both sides' commits the pointer moves to that head. Otherwise it stays conflicted.
- **The changelog**: each conflict hunk becomes the base's lines, then the PR's, a PR line
  identical to one of the base's kept once. Nothing outside the hunks changes.

Any other conflicted path is the PR's agent's. When the head starts with `prefix`
(`issue-` by default; empty turns it off), the agent is told: an `agent-code` dispatch,
`{pull_request, reason: conflict, base, paths}`, which pr-route makes a code turn that
names the base and the paths. The merge commit is made through the API with the App's
token, its message saying what was resolved: GitHub signs it, so a ruleset that wants
changes attributed asks no extra approval, and the PR's workflows run on it. The merged
tree is rebuilt on the head's there, sending only the blobs the base lacks. The branch
moves to it, never forced. The summary is
a table of every PR and its result, and `results` the same as JSON. Only a setup error (no
token, no checkout) fails the step.

```yaml
on:
  push:
    branches: [main]

jobs:
  pr-update:
    runs-on: ubuntu-26.04
    permissions:
      contents: read
    steps:

    - uses: actions/checkout@v7
      with:
        fetch-depth: 0
        persist-credentials: false

    - uses: kubed-io/actions/pr-update@main
      with:
        client-id: ${{ vars.GH_CLIENT_ID }}
        private-key: ${{ secrets.GH_APP_KEY }}
```

The job's token needs only to check out: the step mints the App's token with
`contents: write` and `pull-requests: write`, and authenticates git with it alone. The
checkout needs no submodules, as the pointer's remote is fetched by url. Give it
`fetch-depth: 0`; a shallow one is unshallowed the first time a PR needs the merge. The
step leaves the checkout where it found it.

n8n trusts the App's pushes like the agent's own landing commit: one into a live turn is
delivered to it, one on a draft in its code stage with no live turn dispatches a next-task
turn.

A main that changed workflow files may need the App's `workflows` permission for the update;
without it that PR is `failed`.

| Input | Default | |
|---|---|---|
| `client-id` | | The App's client id |
| `private-key` | | The App's private key |
| `base` | `github.ref_name` | The branch whose PRs are updated |
| `changelog` | `CHANGELOG.md` | The changelog whose hunks are unioned |

| Output | |
|---|---|
| `results` | JSON list of `{number, branch, result}` |
