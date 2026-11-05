# Comment Actions

One thread comment for a whole job. `comment/start` posts "Working on it…" before anything
runs; the steps between add to the answer; `comment/end` writes it, once. On a pull request
with line comments, that one answer is a review instead, the comments under it: a step only
says what to post, and comment/end picks GitHub's API for it. Two issue-agent
turns, a land and the end all answer in the one comment. A job that never reaches
`comment/end` ends with the failure note instead, keeping what the steps that finished said.

## Usage

```yaml
- id: comment
  uses: kubed-io/actions/comment/start@main
  with:
    github_token: ${{ steps.app.outputs.token }}

- id: plan
  uses: kubed-io/actions/issue-agent@main
  with:
    github_token: ${{ steps.app.outputs.token }}
    comment_id: ${{ steps.comment.outputs.comment_id }}
    session_key: plan-${{ github.event.issue.number }}
    scratch_cache: false

- id: code
  uses: kubed-io/actions/issue-agent@main
  with:
    github_token: ${{ steps.app.outputs.token }}
    comment_id: ${{ steps.plan.outputs.comment_id }}
    session_key: code-${{ github.event.issue.number }}
    scratch_cache: false

- uses: kubed-io/actions/issue-agent/land@main
  with:
    token: ${{ steps.app.outputs.token }}
    app_slug: ${{ steps.app.outputs.app-slug }}
    branch: ${{ needs.route.outputs.head }}
    output: ${{ steps.code.outputs.output }}
    number: ${{ steps.comment.outputs.number }}
    parts: true

- uses: kubed-io/actions/comment/end@main
  with:
    github_token: ${{ steps.app.outputs.token }}
    comment_id: ${{ steps.code.outputs.comment_id }}
```

Two issue-agent runs share a scratchpad cache key, so the job keeps it once, around them:
see issue-agent's `scratch_cache`. Run `comment/start` only when something will answer: with
nothing to say, `comment/end` deletes the placeholder.

## comment/start

Posts issue-agent's placeholder, marked with this run (`<!-- issue-agent-placeholder
{"run_id": N} -->`), so it is found wherever n8n moves it. Its post step, at the end of the
job, writes the failure note when `comment/end` did not finish.

| Input | Default | Description |
|---|---|---|
| `github_token` | required | The App's, as issue-agent's |
| `number` | the event's | The issue or PR |
| `prompt` | `""` | Quoted above "Working on it…" and the failure note |
| `live` | `true` | Mark it with the run; `false` never moves |
| `run_url` | this run's | The run link on the comment |

Outputs: `comment_id`, `number`.

## comment/end

Writes the parts as one reply, a seen marker for each session that answered, and marks the
comment written, so `comment/start`'s post leaves it alone. With line comments beside the
parts, the reply is the body of one `COMMENT` review on their commit, with the comments
under it, and the placeholder is deleted. Comments off the diff are listed in the body; a
review GitHub refuses goes once more with every comment in the body, and refused again, the
answer is a plain comment that lists them.

| Input | Default | Description |
|---|---|---|
| `github_token` | required | comment/start's |
| `number` | the event's | comment/start's |
| `comment_id` | comment/start's | The last issue-agent's, for a comment with no run marker |

Outputs: `comment_id`, empty when the answer went as a review or no step said anything;
`review_id`, the review the answer is the body of, when there were line comments.

## Parts

A step adds to the answer by writing markdown to
`${RUNNER_TEMP}/issue-comment/<number>/parts/NN-<name>.md`, numbered by arrival
(`comment/lib/parts.js`'s `addPart`). `comment/end` joins them in name order with a blank
line between, then the run link. Beside them:

| File | Written by | Is |
|---|---|---|
| `comment.json` | comment/start | The first id, the number, the run link |
| `seen.json` | issue-agent | Each session's seen marker, one per key; the next turn of that session starts after it |
| `lines.json` | issue-agent (`review: true`) | Line comments on one commit: `commit_id`, `inline` (on the diff), `outside` (off it) |
| `final.json` | comment/end | Written: start's post does nothing |

issue-agent writes its reply (header and text), with `comment_id`; issue-agent/land writes
what did not land, with `parts: true`.

JavaScript actions on `node24`, no dependencies: only one can have a post step, and end shares
start's code.
