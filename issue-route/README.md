# Issue Route

Decides what an event on a work item (an issue) is for the agents, and the words its turn
starts with. Reads the issue; runs no Claude.

Only a Feature or Bug issue with `agent` is the agents'. A Feature's turns are the spec
agent's (`role` `spec`); a Bug's are the debug agent's (`role` `debug`), which reports and
never writes.

| Event | Before `spec approved` | After it |
|---|---|---|
| The owner's comment, on an `agent` Feature or Bug | `spec` | `none` |
| The owner's `agent` label, on a Feature | `spec`, `takeover` | `none` |
| The owner's `agent` label, on a Bug | `spec`, `prompt` debug-report (`always`), `takeover` | |
| The owner's `spec` label, on an opted-in Feature | `spec`, `prompt` spec-draft, `writes`, `takeover` | `none` |
| The owner's `spec approved` label, on an `agent` Feature | `handoff`, `takeover` | |
| Anything else (another type or none, the App's own comments, anyone else, any other label, `spec` or `spec approved` on a Bug, a PR) | `none` | `none` |

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

Outputs: `stage` (`spec`, `handoff`, `none`), `number`, `title`, `label`, `role`, `writes`,
`prompt`, `prompt_when`, `takeover`.
