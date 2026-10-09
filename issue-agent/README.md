# Issue Agent (Claude)

Claude in a GitHub issue or pull request, as a real Claude Code session. Your new
comments are the turn, in your words; the agent's answer is its reply, posted back.
Open the session from `/claude` in VS Code and it reads as the chat it was.

The workflow job gives it a purpose:

- **a role**: `instructions` (any markdown file in the repo) or `agent` (a native
  `.claude/agents/<name>.md`)
- **a schema**: structured fields beside the reply
- **document rounds** (`document`): a spec or plan returned whole each round, kept as
  an artifact, shown in the job summary, linked from a header on every reply
- **PR work**: `threads[]` in the output are answered and resolved, `ready: true` marks a
  draft ready, `push_token` pushes what the agent committed

`issue-agent/commit` commits an approved round: a branch linked to the issue, a signed
commit, and a draft PR naming the document.

`issue-agent/review` waits for Copilot's review of a PR's head once a user has asked for
it; `respond` says whether Copilot left comments for the code agent. Only a user can ask
Copilot (a request on GITHUB_TOKEN or an App's token does nothing), and every run Copilot's
review triggers is held for approval, so the run the user's request wakes does the waiting.

## Usage

```yaml
- uses: actions/checkout@v7
  with:
    persist-credentials: false
- uses: kubed-io/actions/issue-agent@main
  with:
    github_token: ${{ github.token }}
    instructions: |
      .issue/roles/claude/spec.md
      .github/claude/spec.md
    schema: .issue/roles/claude/spec.schema.json
    document: spec
    document_path: docs/superpowers/specs/{date}-{slug}-design.md
    opt_in_label: agent
    trusted_ids: ${{ vars.CLAUDE_OWNER_ID }}
    session_key: issue-${{ github.event.issue.number }}
```

`.issue/roles` is the org's base roles, checked out from `kubed-io/.github-private` by an earlier
`actions/checkout` step; `.github/claude/spec.md` is this repo's overlay. The job's `if` is the
real gate. Gitignore `scratch_dir` (`.issue`).

## Inputs

| Input | Default | Description |
|---|---|---|
| `github_token` | required | Thread I/O |
| `number` | the event's | Issue or PR; empty with `prompt` is a one-off |
| `prompt` | `""` | A one-off turn (dispatch) |
| `nudge` | `""` | A turn only when the thread has nothing new: an event with no words (a label, a push) |
| `instructions` | `""` | Markdown files, one per line, appended in order: base role, then the repo's overlay |
| `agent` | `""` | A native repo agent |
| `schema` | `""` | JSON Schema, inline or a path |
| `document` | `""` | Schema field holding a whole document |
| `document_path` | `docs/{document}s/{date}-{slug}.md` | Where an approved round lands |
| `push_token` | `""` | Pushes the agent's commits after the run, and marks a draft ready (an event that wakes workflows) |
| `opt_in_label` | `""` | Run only if a trusted id last added this label |
| `max_runs` | `0` | Cap on replies per session key per thread |
| `trusted_ids`, `trusted_bots` | the runner's `CLAUDE_OWNER_ID`, `CLAUDE_TRUSTED_BOTS` | Whose messages count, and whose edits to a body's round state are believed (a Bot's always are) |
| `session_key`, `session_title` | `""` | Resumable session |
| `model`, `max_turns` | `sonnet`, `40` | |
| `mcp_config` | `""` | Inline JSON or a file; `${VAR}` from env |
| `allowed_tools`, `disallowed_tools`, `claude_args` | `""` | |
| `allowed_bots` | the runner's `CLAUDE_ALLOWED_BOTS` | Bot actors claude-code-action accepts |
| `show_full_output` | `false` | Keep false in public repos |
| `anthropic_api_key`, `claude_code_oauth_token` | `""` | Credentials, when the job's env has none (off the `claude` runner) |
| `path_to_claude_code_executable`, `path_to_bun_executable` | the runner's `PATH_TO_*` | Preinstalled binaries; installed when unset |
| `scratch_dir` | `.issue` | Thread files; gitignore it |

## Outputs

`reply`, `structured`, `number`, `comment_id`, `session_id`, `conclusion`, `pushed`, `round`.

## Reading a session in VS Code

Open it to read it. To continue it there, fork it: `claude --resume <id> --fork-session`.
Two writers on one transcript corrupt it, and the issue never sees what is said in VS Code.
