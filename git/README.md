# Git Actions

Branch, commit and open a PR through the GitHub API. Every commit is made by the API with
no author or committer of its own, so GitHub signs it ("Verified"); only a submodule with
no commit API (a wiki) is `git push`ed, by git/commit, before its pointer moves. Pass the
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
| `trailers` | no | — | `Key: value` lines after the message, a blank line between (`Agent: done`) |
| `submodules` | no | — | Submodules it may commit inside, one per line (a wiki): changes in one that `files` reaches are committed and pushed with git first |
| `author` | no | — | The App's slug, whose bot authors a submodule's commit; needed only when one changed |
| `keep_to` | no | — | A folder from the top: a failed commit's changes are written there, so they are not lost |

| Output | Description |
|---|---|
| `sha`, `url` | The commit; empty when nothing was committed |
| `files` | JSON list of the committed paths, deletions included |
| `ignored` | JSON list of the changed paths `ignore` left out |
| `committed` | `false` when there was nothing and `allow_empty` is off (not an error) |
| `conflicts` | JSON list of the paths the branch also changed, when that refused the commit |
| `kept` | `true` when a failed commit's changes went to `keep_to` |
| `summary` | Markdown saying what is not on the branch (failed, refused, or left out by `ignore`); empty when everything selected was committed |

- Changes come from `git status`: added, changed, deleted, untracked, and a rename as a
  delete plus an add. Files land as regular files: a symlink fails.
- A submodule checked out at a new commit moves its pointer in the same commit, beside
  the files. One in `submodules` with changes inside it (a wiki, which has no commit API)
  gets that commit here first, as the App's bot. It goes to the submodule branch named
  after the branch being committed to (`issue-137` for `issue-137`), never to the wiki's
  `master`: that is the public wiki, and only the repository's own publish (main's
  wiki.yml) writes it, so a branch's pages reach it by merging. A commit to the default
  branch goes to `.gitmodules`' `branch`, else `master`. It is rebased onto that branch's
  remote head when there is one (a file both changed takes this commit's version), else
  starts the branch from the pin, and is pushed with git. A push refused because the branch moved again
  meanwhile is fetched, rebased and pushed again, up to 3 tries a second or few apart; any
  other failure, or a third refusal, fails the commit (and `keep_to` keeps it). A submodule
  not listed is never pushed. That commit goes through the Git Data API (blobs, a tree, a
  commit, a fast-forward of the branch), because `createCommitOnBranch` cannot write a
  gitlink; without one it is used as before.
- A merge left uncommitted (`MERGE_HEAD`, resolved but not committed) becomes a merge
  commit: the head, then `MERGE_HEAD`, as its parents, through the Git Data API too, even
  when the merge changes nothing. Without the second parent the branch would never hold
  what it merged, and its PR would stay behind its base.
- Other submodule changes cannot be committed from here: edits inside a submodule not in
  `submodules`, a pointer with no new commit, a deleted gitlink. Swept up by "every change", they are
  left out with a warning naming them; named in `files`, they fail.
- It never overwrites. The commit goes on the branch's head as it is now; when that is not
  the commit the checkout is at (someone pushed meanwhile), the files changed in between
  must not be any it writes, submodule pointers included. If one is, nothing is committed
  and the step fails naming the paths and both commits.
- Afterwards it fetches the branch with `token` (never on the command line) and resets
  `HEAD` and the index to the new commit, so `persist-credentials: false` is fine.

## git/pr

Opens a PR from a branch, or finds the open one and leaves it as it is, except that
`draft: false` marks a found draft ready. With no `base`, a PR into any base is found.

| Input | Required | Default | Description |
|---|---|---|---|
| `token` | yes | — | Writes pull requests and issues |
| `branch` | yes | — | The head |
| `base` | no | the default branch | |
| `title` | to open one | — | |
| `body` | no | `""` | |
| `draft` | no | `true` | |
| `labels` | no | — | Added to a new PR, comma-separated |

| Output | Description |
|---|---|
| `number`, `url` | The PR |
| `created` | `false` when an open one was found |

A branch with nothing beyond its base fails with GitHub's own message: commit first
(`git/commit` with `allow_empty`).
