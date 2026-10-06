# Issue Agent (Claude)

Runs one of your repo's Claude agents inside a GitHub issue. The agent
(`.claude/agents/<name>.md`) is the role; this action only adds what working in an
issue needs:

- the thread as files the agent reads (`<scratch_dir>/context.md`, and `latest.md`
  for the message that triggered the run)
- a short contract appended to the agent's prompt: answer, and return `{ reply }`
- the reply comment, posted before Claude starts as "Working on it…" with a spinner and
  a link to the run, then edited into the answer (or into a failure note if the run
  doesn't finish)
- one Claude session per `session_key`, resumed where sessions persist, so a resumed
  run reads only the new message

It also takes a one-off `prompt`. With an issue (the event's, or `issue_number`),
the prompt is answered inside that issue's conversation and quoted above the posted
reply; without one, the answer comes back only as the `reply` output. Use the same
`session_key` from an issue event and a dispatch and they are one conversation.

Claude only. On the kubed-io `claude` runner it needs no secrets: the subscription
token, `claude`, `bun`, the MCP profiles and `/claude` come with the runner.

## Usage

```yaml
- uses: actions/checkout@v7
- uses: kubed-io/actions/issue-agent@main
  with:
    agent: info-agent
    github_token: ${{ github.token }}           # needs issues: write
    mcp_config: ${{ env.CLAUDE_MCP_PROFILES }}/view.json
    allowed_tools: Bash(kubectl build:*)
    session_key: ${{ github.event.issue.title }}
    claude_args: --permission-mode acceptEdits --strict-mcp-config
```

The caller's job `if` is the gate: which labels, which comment authors. Gitignore
`scratch_dir` (`.issue` by default).

## Inputs

| Input | Default | Description |
|---|---|---|
| `agent` | required | The repo agent the session runs as |
| `github_token` | required | Token for reading the thread and posting the reply |
| `issue_number` | the event's issue | The issue to work in |
| `prompt` | `""` | A one-off message instead of the thread's newest one |
| `session_key` | `""` | Resumable conversation key; `uuid5(repo + key)` is the session ID |
| `session_title` | `session_key` | The session's name when it starts |
| `model` | `sonnet` | Claude model |
| `max_turns` | `40` | Max Claude Code turns |
| `mcp_config` | `""` | MCP servers (inline JSON or a file); every server in it is allowed |
| `allowed_tools` | `""` | Tools to allow, e.g. `Bash(kubectl build:*)` |
| `disallowed_tools` | `""` | Tools to deny |
| `context_file` | `""` | Repo file appended to the issue contract |
| `claude_args` | `""` | Extra flags for Claude |
| `allowed_bots` | `""` | Bots allowed to trigger the run |
| `scratch_dir` | `.issue` | Where the thread files go |
| `anthropic_api_key`, `claude_code_oauth_token` | `""` | Credentials; the job's env when both are empty |
| `path_to_claude_code_executable`, `path_to_bun_executable` | the runner's `PATH_TO_*` | Preinstalled binaries; installed when unset |

## Outputs

| Output | Description |
|---|---|
| `reply` | The agent's reply |
| `issue_number` | The issue it worked in, empty for a one-off |
| `comment_id` | The comment the reply is in |
| `session_id` | The Claude session ID |
| `conclusion` | `success` or `failure` |
