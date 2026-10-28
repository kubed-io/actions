# PR Route

Decides what an event on an agent-built pull request (head `issue-*`) is for the agents,
and the words its turn starts with. Reads the PR and its head commit; runs no Claude.

| Event | Before `plan approved` | After it |
|---|---|---|
| The owner's comment or review | `plan` | `code` |
| The `plan approved` label | | `code`, `prompt` plan-approved, `takeover` |
| A push to the draft, by the App or the owner | | `code`, `prompt` next-task; `none` when its commit says `Agent: done` |
| Copilot's review | | `code` |
| An `agent-code` dispatch | | `code`: `ci` → checks-failed with `run_id`, `review` → review-came-in, `copilot` (Copilot's hand-back) → review-came-in, after the route job waits for Copilot's review |
| Anything else (the App's own thread replies, a push out of draft) | `none` | `none` |

The prompts are kb prompts sent as slash commands (`prompts` + name), so the methodology's
own text drives each turn. A dispatch's prompt is the whole turn (`prompt_when: always`);
anything else is answered in its own words and gets the prompt only when nothing is unread.

```yaml
- uses: kubed-io/actions/pr-route@main
  id: route
  with:
    owner: "4399427"
    app: "235398881"
```

It answers `issue_comment`, `pull_request_target` (the label), `workflow_run` (a relay of
`pull_request` and `pull_request_review`) and `repository_dispatch`. The job's `if` still
gates who may cause each: only GitHub's event data can vouch for a sender before a runner
starts. The token needs `pull-requests: read` and `contents: read`.

| Input | Default | |
|---|---|---|
| `github_token` | `github.token` | |
| `owner` | | The owner's user id |
| `app` | | The code agent's (the App's bot's) user id |
| `copilot` | `175728472` | Copilot's reviewer |
| `branch_prefix` | `issue-` | |
| `label` | `plan approved` | |
| `prompts` | `/mcp__superpowers__superpowers_` | |

Outputs: `stage` (`plan`, `code`, `none`), `number`, `head`, `prompt`, `prompt_when`,
`takeover`, `run_id`, `reason` (a dispatch's).
