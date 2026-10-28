# Review Route

Decides whether the review agent reviews a pull request's head. The answer is a commit
status on the head (`Agent review` by default): the PR's required check, and the memory of
what was judged. Runs no Claude; the review job runs only when `number` is set.

| What happened | Status | Then |
|---|---|---|
| A PR the agents did not build | `success`: not built by the agents | |
| Checks red on the head | `failure`: checks failed (fix n of max) | an `agent-code` dispatch, `reason: ci`, with the run |
| Only the base merged in since the last verdict | that verdict, `no changes since <sha>: …` | |
| Only a passing review's own suggestions applied since | `success`, `suggestions applied since <sha>: …` | |
| A new head, checks green | `pending`: reviewing (n of max) | `number`, `sha`, `last` for the review job |
| `max_reviews` verdicts without a pass | `failure`: needs a human | |

A head is judged once; an `agent-review` dispatch asks again, and the owner's own dispatch
is never capped.

An applied suggestion is a commit GitHub made from the PR's page (committer `web-flow`,
verified), co-authored by the `reviewer`, whose every added line is a line of a suggestion
block in the review that passed, for that file. Suggestions applied after `changes
requested` get a review: the review may have asked for more than its suggestions.

```yaml
- uses: kubed-io/actions/review-route@main
  id: route
  with:
    trusted: 4399427,41898282,235398881
    owner: "4399427"
```

It answers `workflow_run` (the checks run ended; one without the `checks_artifact` ran no
checks and is skipped), `pull_request_target` (a push, with no checks gate) and
`repository_dispatch`. The job's `if` still gates who may dispatch: only GitHub's event
data can vouch for a sender before a runner starts.

The token needs `pull-requests: read`, `statuses: write`, `actions: read` (the artifact) and
`contents: write` (the dispatch). The review job must set its verdict as the same bot, the
`reviewer`, since only its statuses count.

| Input | Default | |
|---|---|---|
| `github_token` | `github.token` | |
| `check` | `Agent review` | The status's context |
| `reviewer` | `41898282` | github-actions[bot]: whose statuses and suggestions are the review agent's |
| `trusted` | | User ids whose run or dispatch may start a review |
| `owner` | | The user id whose dispatch is never capped |
| `max_reviews` | `3` | |
| `max_fixes` | `3` | Commits with failed checks before a human |
| `branch_prefix` | `issue-` | |
| `labels` | `plan approved` | Labels a PR the agents built has, comma-separated |
| `checks_artifact` | `checks-report` | |

Outputs: `number` (empty: no review), `sha`, `last` (the last review before a human).
