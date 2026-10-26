# Git Actions

Branch, commit and open a PR through the GitHub API. Every commit is made by the API with
no author or committer of its own, so GitHub signs it ("Verified"); nothing is
`git push`ed. Pass the
App's token, so what they make wakes workflows. None runs Claude; any runner will do.

## Usage

```yaml
- uses: actions/checkout@v7

- uses: kubed-io/actions/git/branch@v2
  with:
    token: ${{ steps.app.outputs.token }}
    branch: issue-${{ github.event.issue.number }}
    issue: ${{ github.event.issue.number }}

# ... something changes files in the checkout ...

- uses: kubed-io/actions/git/commit@v2
  with:
    token: ${{ steps.app.outputs.token }}
    branch: issue-${{ github.event.issue.number }}
    message: "docs: the spec for #${{ github.event.issue.number }}"
    files: docs/**
    allow_empty: true

- uses: kubed-io/actions/git/pr@v2
  with:
    token: ${{ steps.app.outputs.token }}
    branch: issue-${{ github.event.issue.number }}
    title: ${{ github.event.issue.title }}
    body: "Closes #${{ github.event.issue.number }}"
    labels: enhancement,agent
```

## git/branch

Makes a branch, or finds it.

| Input | Required | Default | Description |
|---|---|---|---|
| `token` | yes | — | Writes contents |
| `branch` | yes | — | The branch |
| `base` | no | the default branch | Where a new branch starts |
| `issue` | no | — | Create it linked to this issue (its Development panel) |

| Output | Description |
|---|---|
| `sha` | The branch's head |
| `created` | `false` when it already existed (not an error) |

## git/commit

Commits the checkout's changes to a branch. Afterwards `HEAD` and the index match the
commit and the working tree is left as it was, so changes it did not select stay changed.

| Input | Required | Default | Description |
|---|---|---|---|
| `token` | yes | — | Writes contents |
| `message` | yes | — | First line is the headline, the rest the body |
| `files` | no | every change | Paths, directories or globs (`**`, `*`, `?`) from the repository root, one per line |
| `branch` | no | the checkout's | Must exist (`git/branch` makes it) |
| `allow_empty` | no | `false` | Commit with no changes, so a PR can open on a new branch |

| Output | Description |
|---|---|
| `sha`, `url` | The commit; empty when nothing was committed |
| `files` | JSON list of the committed paths, deletions included |
| `committed` | `false` when there was nothing and `allow_empty` is off (not an error) |

- Changes come from `git status`: added, changed, deleted, untracked, and a rename as a
  delete plus an add. Files land as regular files: a symlink fails.
- A submodule checked out at a new commit moves its pointer in the same commit, beside
  the files: push the submodule's commit first (a wiki, say), then commit here. That
  commit goes through the Git Data API (blobs, a tree, a commit, a fast-forward of the
  branch), because `createCommitOnBranch` cannot write a gitlink; without one it is used
  as before.
- Other submodule changes cannot be committed from here: edits inside a submodule, a
  pointer with no new commit, a deleted gitlink. Swept up by "every change", they are
  left out with a warning naming them; named in `files`, they fail.
- Afterwards it fetches the branch with `token` (never on the command line) and resets
  `HEAD` and the index to the new commit, so `persist-credentials: false` is fine.

## git/pr

Opens a PR from a branch, or finds the open one and leaves it as it is.

| Input | Required | Default | Description |
|---|---|---|---|
| `token` | yes | — | Writes pull requests and issues |
| `branch` | yes | — | The head |
| `base` | no | the default branch | |
| `title` | yes | — | |
| `body` | no | `""` | |
| `draft` | no | `true` | |
| `labels` | no | — | Added to a new PR, comma-separated |

| Output | Description |
|---|---|
| `number`, `url` | The PR |
| `created` | `false` when an open one was found |

A branch with nothing beyond its base fails with GitHub's own message: commit first
(`git/commit` with `allow_empty`).
