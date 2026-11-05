# Review Route

Decides whether the review agent reviews a pull request's head. The answer is a commit
status on the head (`Agent review` by default): the PR's required check, and the memory of
what was judged. Runs no Claude; the review job runs only when `number` is set.

| What happened | Status | Then |
|---|---|---|
| A PR the agents did not build | `success`: not built by the agents; none on a checks dispatch | |
| Checks red on the head | `failure`: checks failed (fix n of max) | an `agent-code` dispatch, `reason: ci`, with the run |
| Only the base merged in since the last verdict | that verdict, `no changes since <sha>: …` | |
| Only a passing review's own suggestions applied since | `success`, `suggestions applied since <sha>: …` | |
| Checks green on a change the owner asked Copilot to review | `pending`: checks passed: waiting for Copilot, or Copilot's verdict when its review of the head is in | Copilot is asked for the head, unless asked since its commit; an `agent-review` dispatch still asks the review agent |
| Copilot's review of the head (`reason: copilot`), the checks green | `success`: Copilot: looks good (no line comments), or `failure`: Copilot: changes requested (n of max) | changes requested: an `agent-code` dispatch, `reason: copilot`, with `review_id` |
| Copilot's review before the checks end, or after red ones | | none: the checks' end reads it, or the code turn answers it |
| Copilot encountered an error (its draft gate's cancel, or a failure) | hidden; on the ready head, `failure`: needs a human after two | Copilot is asked again, once |
| A new head, checks green | `pending`: reviewing (n of max) | `number`, `sha`, `last` for the review job |
| `max_reviews` verdicts without a pass, the review agent's or Copilot's | `failure`: needs a human | |

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
checks and is skipped), `pull_request_target` (a push, with no checks gate) and an
`agent-review` dispatch. A dispatch with `reason: checks` is the checks run's last job
pointing at its own run, and is routed as that run:

```json
{"pull_request": 7, "reason": "checks", "run_id": 123, "sha": "<head>", "failed": 0}
```

The run is read back: its head must be `sha` and the PR's, its `triggering_actor` must be
trusted, and its finished jobs, not `failed`, say whether the checks passed. A dispatch with
`reason: copilot` and a `review_id` is Copilot's review, forwarded from n8n's relay by
agent-pr.yml. Any other `agent-review` dispatch asks again.

A change is Copilot's when the timeline holds the `owner`'s own request for Copilot's
review; the requests the flow makes for each head never opt a change in. The job's `if` still gates who may dispatch: only
GitHub's event data can vouch for a sender before a runner starts.

The token needs `pull-requests: write` (asking Copilot, hiding its error reviews),
`statuses: write`, `actions: read` (the artifact) and `contents: write` (the dispatch). The review job must set its verdict as the same bot, the
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

## Verdict

`review-route/verdict` is the other end: after the review agent, it sets the review status
on the head that was reviewed, linked to the review. `looks good` passes, any other verdict
fails, and no verdict is an error. It must run on the reviewer's token (the built-in one),
since review-route reads back only the reviewer's statuses.

```yaml
- uses: kubed-io/actions/review-route/verdict@main
  if: always()
  with:
    number: ${{ needs.route.outputs.number }}
    sha: ${{ needs.route.outputs.sha }}
    last: ${{ needs.route.outputs.last }}
    output: ${{ steps.agent.outputs.output }}
    review_id: ${{ steps.answer.outputs.review_id }}
    comment_id: ${{ steps.answer.outputs.comment_id }}
```

`answer` is the job's comment/end, which runs first: the review agent's answer is one
comment, or one review when it has line comments.

Output: `verdict`.

## Copilot

`review-route/copilot` is the code job's side of a change the owner asked Copilot to
review. `step: wait`, before a code turn, holds until Copilot's review of the head is in,
when it was asked for one (`timeout_minutes`, 20), so the turn answers the checks and
Copilot together. `step: ask`, after the turn lands, asks Copilot for the new head,
alongside its checks. Neither does anything on a draft or a change that is not Copilot's.

```yaml
- uses: kubed-io/actions/review-route/copilot@main
  with:
    github_token: ${{ steps.app.outputs.token }}
    step: ask
    number: ${{ needs.route.outputs.number }}
    owner: "4399427"
```
