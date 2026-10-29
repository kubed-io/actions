# Issue Route

Decides what an event on a work item (an issue) is for the agents, and the words its turn
starts with. Reads the issue; runs no Claude.

| Event | Before `spec approved` | After it |
|---|---|---|
| The owner's comment, on an `enhancement` + `agent` issue | `spec` | `none` |
| The owner's `agent` label, on an `enhancement` issue | `spec`, `takeover` | `none` |
| The owner's `spec` label, on an opted-in issue | `spec`, `prompt` spec-draft, `writes`, `takeover` | `none` |
| The owner's `spec approved` label, on an `agent` issue | `handoff`, `takeover` | |
| Anything else (the App's own comments, anyone else, any other label, a PR) | `none` | `none` |

```yaml
- uses: kubed-io/actions/issue-route@main
  id: route
  with:
    owner: "4399427"
    app: "235398881"
```

It answers `issues` (labeled), `issue_comment` (created) and `repository_dispatch`
`agent-issue`, where n8n relays them instead (`client_payload`: `number`, `event`, `action`,
`actor`, `comment_id`, `label`; a pointer: the comment's author and the labeler are read back
from GitHub). The same situation routes the same either way. The job's `if` still gates who
may cause each. The token needs `issues: read`.

| Input | Default | |
|---|---|---|
| `github_token` | `github.token` | |
| `owner` | | The owner's user id |
| `app` | | The App's bot's user id |
| `prompts` | `/mcp__superpowers__superpowers_` | |

Outputs: `stage` (`spec`, `handoff`, `none`), `number`, `title`, `label`, `writes`, `prompt`,
`takeover`.
