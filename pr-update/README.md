# PR Update

Brings every open PR on a branch up to date after a merge into it. Each agent PR moves the
`docs` pointer (the wiki) to its own wiki commit and adds lines under the changelog's
`## [Unreleased]`, so once one merges the others conflict there. Each PR's wiki commits
are on the wiki branch named after it (git/commit), not the wiki's master, so the pointer
conflict resolves to a merge of the two sides made on that branch (cluster spec 2026-11-12,
R-L9; the wiki branches 2026-11-13).

For every open PR whose base is `base` and whose head is in this repository:

| Step | Result |
|---|---|
| The base is already in the head | `current` |
| The base changed a workflow file, which the App may not write | `needs a person: <paths>`; an agent's PR is told once, by a comment, ` (asked)` |
| GitHub's update-branch, from the head it was at, takes | `updated` |
| Else the base is merged into the head in the checkout, and resolves | `merged`, or `merged & resolved: pointer, changelog` |
| It resolves, but the wiki merge left markers in a passage both sides changed | `merged & resolved: pointer (wiki conflicts: <files>)`; ` (dispatched)` when the head is an agent's |
| A conflict it does not resolve | `needs its agent: <paths>`, the merge aborted; ` (dispatched)` when the head is an agent's |
| The branch moved before the update (the agent committed) | `moved during the update; next merge retries` |
| Anything else that went wrong for that PR | `failed: <why>` |

What the merge resolves:

- **A submodule pointer** both sides moved: its remote (`.gitmodules`' url, at its
  `branch` or the remote's default) is fetched into the repository, and when its head holds
  both sides' commits the pointer moves to that head. Otherwise the two sides' commits are
  merged (`merge-tree`), the merge is pushed, never forced, to the PR's own wiki branch, and
  the pointer moves to it. Never to the wiki's master or the base's wiki branch. Changes to
  different passages merge as git merges them. A passage both sides changed keeps both, in
  standard conflict markers labelled `wiki/<head>` (the PR's) and `wiki/<base>`; that merge
  is pushed only when nothing else conflicts, so the code merge completes, and the PR's agent
  is sent the `agent-code` dispatch with the files under the submodule's path as `paths` and
  `wiki` (quick-mcp #41: `-X ours` would have dropped the base's side). The merge's dates are
  its parents', so a retry makes the same commit. A generated page both changed may then be
  stale, which the PR's checks catch for its agent. Any other wiki conflict (a file deleted
  on one side, a binary), a wiki merge beside another conflict, or a refused push leaves the
  pointer conflicted.
- **The changelog**: each conflict hunk becomes the base's lines, then the PR's, a PR line
  identical to one of the base's kept once. Nothing outside the hunks changes.

Any other conflicted path is the PR's agent's. When the head starts with `prefix`
(`issue-` by default; empty turns it off), the agent is told: an `agent-code` dispatch,
`{pull_request, reason: conflict, base, paths}`, which pr-route makes a code turn that
names the base and the paths; with `wiki` it says the merge is done and the markers in
those files are to be settled by editing them, the wiki and the pin then committed together.
The merge commit is made through the API with the App's
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

When both the base and the PR changed the changelog, GitHub's update-branch is skipped and the
merge is made in the checkout, where the changelog is rebuilt from both sides' own texts: the
base's file as it is, its released sections untouched, with its `[Unreleased]` holding its own
entries and then each entry the PR's `[Unreleased]` has that the base's text lacks, under its
own subsection (Keep a Changelog's order). A merge alone has no notion of `[Unreleased]` rolled
into a version: after a release it left a PR's entries under the new version heading, rewriting
released notes (quick-mcp #55, #56). Either side without an `[Unreleased]` falls back to the
union of conflict hunks.

A PR with a live agent turn is never merged into. A turn's job checks the branch out and
commits from that checkout, so a merge under it would move the branch, and the commit would be
refused rather than overwrite (selenium-flow #215 lost a task so). The step reads the
repository's in-progress runs whose name holds `Agent`, and their jobs. A job still running
whose name ends `#<n>`, the PR's number or the issue its `issue-<n>` branch is for, defers
that PR: its row says `deferred: a live turn (run <id>)`. The step's own run is never one.
agent-pr.yml's last job, *Up to Date After the Turn*, then runs the step with `pull-request`
once the turn is over, whether it committed or not. Runs that can't be read defer nothing,
with a warning.

n8n trusts the App's pushes like the agent's own landing commit: one into a live turn is
delivered to it, one on a draft in its code stage with no live turn dispatches a next-task
turn.

A base that changed a workflow file is a person's merge: the App's token has no `workflows`
permission, so neither update-branch nor the merge here can bring it in (quick-mcp #32). When
the head starts with `prefix`, the PR gets one comment saying a person must merge the base in,
found again by its marker (the base, each path and its blob), so a later run does not post it
twice. Nothing dispatches or retries it.

A family's branch (`issue-<P>`) that the run moved, its PR to main updated or merged, is then
a base too: its sub-issues' PRs are brought up to date the same way, their rows naming it as
`base` and the summary a table for it. Each base is updated once a run, so a cycle stops.

Each agent-flow repository's wiki.yml also runs it on every push to a family's branch, with
that branch as the base, so a commit made straight to `issue-<P>` brings its sub-issues' PRs
along. agent-issue.yml also runs this step on a family's branch after a
sub-issue's change merges into it (n8n's `sub-issue-closed` wake-up) and after the parent's
turn commits there, as its hand-off does after opening a sub-issue's PR into it.

| Input | Default | |
|---|---|---|
| `client-id` | | The App's client id |
| `private-key` | | The App's private key |
| `base` | `github.ref_name` | The branch whose PRs are updated |
| `changelog` | `CHANGELOG.md` | The changelog whose hunks are unioned |
| `pull-request` | | One PR to bring up to date, its base read from it, in place of every PR on `base` |

| Output | |
|---|---|
| `results` | JSON list of `{number, branch, result}`, and `base` on a followed family branch's rows |
