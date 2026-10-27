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
| `ignore` | no | — | Paths or globs left out even when changed, with a warning; for example workflow files the token cannot write |
| `branch` | no | the checkout's | Must exist (`git/branch` makes it) |
| `allow_empty` | no | `false` | Commit with no changes, so a PR can open on a new branch |

| Output | Description |
|---|---|
| `sha`, `url` | The commit; empty when nothing was committed |
| `files` | JSON list of the committed paths, deletions included |
| `ignored` | JSON list of the changed paths `ignore` left out |
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

## git/submodule

Commits what changed inside a submodule and pushes it to the submodule's own branch, with
git, for a repository that has no commit API (a GitHub wiki). The pointer is left alone:
run `git/commit` next, and it moves the pointer in the same signed commit as the files.

```yaml
- uses: kubed-io/actions/git/submodule@main
  with:
    path: docs
    message: ${{ steps.msg.outputs.message }}
    token: ${{ steps.app.outputs.token }}
    app_slug: ${{ steps.app.outputs.app-slug }}
- uses: kubed-io/actions/git/commit@main
  with:
    token: ${{ steps.app.outputs.token }}
    branch: ${{ env.BRANCH }}
    message: ${{ steps.msg.outputs.message }}
```

| Input | Required | Default | Description |
|---|---|---|---|
| `path` | no | `docs` | The submodule |
| `branch` | no | `master` | The submodule's branch, rebased onto its remote head first |
| `message` | yes | — | The commit message |
| `token` | yes | — | Pushes the submodule's repository |
| `app_slug` | yes | — | The App whose bot authors the commit |

| Output | Description |
|---|---|
| `sha` | The submodule's new commit; empty when nothing changed |
| `committed` | `false` when nothing changed under `path` (not an error) |

It lives here, not in the repository it serves: a workflow running a local action runs
whatever the checked-out branch holds, so an agent's branch could change it.

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
