# Issue Agent (Claude)

A Claude Code agent in a GitHub issue or pull request, as a real Claude Code session.
Your new comments are the turn, in your words. The agent answers with:

- **a reply**, posted as a comment;
- **notes**, kept collapsed at the bottom of the description: what the next run, or the
  pull request after an issue, starts from;
- on a pull request, **a review**: line comments and suggestions under its reply, the way
  Copilot reviews (`review: true`).

Where n8n relays Copilot's review (as an `agent-route` dispatch, see
[pr-route](../pr-route/)), nothing waits for it; `review/` and its wait are for
repositories without n8n.

It does nothing else: no git, no workflow. Its structured response is its output, so the
steps after it decide what to commit (`git/commit`), branch (`git/branch`) or open
(`git/pr`). Open the session from `/claude` in VS Code and it reads as the chat it was.

## Usage

```yaml
- uses: actions/checkout@v7
  with:
    persist-credentials: false
- id: agent
  uses: kubed-io/actions/issue-agent@main
  with:
    github_token: ${{ steps.app.outputs.token }}
    agent: plan
    append_system_prompt: Plans go under docs/superpowers/plans/.
    header: "📄 [{{ output.plan_path }}]({{ link:output.plan_path }})"
    session_key: pr-${{ github.event.issue.number }}
- uses: kubed-io/actions/git/commit@main
  with:
    token: ${{ steps.app.outputs.token }}
    message: ${{ fromJSON(steps.agent.outputs.output).commit_message }}
```

The `agent` is a name: the claude runner image's `$CLAUDE_AGENTS/<name>/`, whose
`schema.json` and `mcp.json` are the `schema` and `mcp_config` unless the job gives its own.
A repository that brings its own agent names a file instead. Either is loaded with
`--agents`, and its body replaces Claude Code's default system prompt. Then the action's
contract and `append_system_prompt` are appended. A name only the repo's
`.claude/agents/` has is left to Claude Code.

The frontmatter's `allowedTools` and `disallowedTools` (a comma list or a YAML list) become
`--allowedTools` and `--disallowedTools`; a job's `allowed_tools` or `disallowed_tools`
replaces them.

## What the agent returns

The action wraps the role's `schema` in its own:

| Field | | |
|-------|-|-|
| `reply` | always | The answer, posted as written. |
| `notes` | always | Kept in the description, whole, every turn. |
| `review` | `review: true`, on a PR | `comments[]`: `path`, `line` (and `start_line`), `body`, `suggestion`. |
| `threads` | on a PR (`threads: true`) | Answers to unresolved review threads: `id`, `reply`, `resolve`. |
| `ready` | `ready: true`, on a draft PR | True marks it ready for review. |
| `output` | `schema` given | The role's own fields. |

Beside the turn, in `{scratch_dir}/`: `context.md`, `notes.md`, and on a PR `pr.md`,
`reviews.md`, `issues.md` (each linked issue with its agent's notes) and `diff.md` (every
new-side line numbered).

## Inputs

| Input | Default | Description |
|---|---|---|
| `github_token` | required | Thread I/O; the App's, so what it posts wakes workflows |
| `number` | the event's | For a run started off the thread |
| `agent` | `""` | A name (`$CLAUDE_AGENTS/<name>/`, else `.claude/agents/`), or an agent file |
| `schema` | the agent's `schema.json` | The role's output schema, inline or a path; becomes `output` |
| `append_system_prompt` | `""` | This job's extras, inline or a path |
| `prompt` | `""` | The event's turn, for an event with no words |
| `prompt_when` | `quiet` | `quiet`: only when nothing new; `always`: every run, quoted above the reply |
| `header` | `""` | Template above the reply: `{{ output.<field> }}`, `{{ link:output.<field> }}` (the file's wiki page when it is in a wiki submodule, else its blob), `{{ run_url }}`, `{{ session_id }}`, `{{ number }}`, `{{ blob }}` |
| `review`, `threads`, `ready` | `false`, `true`, `false` | The PR fields the agent gets |
| `session_key` | `""` | Resumable session |
| `trusted` | the runner's `CLAUDE_OWNER_ID`, `CLAUDE_TRUSTED_BOTS` | Ids and bots whose messages count |
| `opt_in_label`, `max_runs` | `""`, `0` | The gate |
| `mcp_config` | the agent's `mcp.json` | Inline JSON or a file; `${VAR}` from env |
| `compact` | `""` | Compact a resumed session before the turn, steered by these instructions |
| `model`, `max_turns`, `allowed_tools`, `disallowed_tools`, `permission_mode` | the agent's | Per-job overrides |
| `claude_args` | `""` | Extra Claude Code flags |
| `show_full_output` | `false` | Keep false in public repos |
| `scratch_dir` | `.issue` | Thread files; gitignore it |
| `live_messages` | `false` | n8n's pushes reach the running turn (claude runner); see below |

## Live messages

With `live_messages: true` on the claude runner, the owner's comments reach the agent while it
works, and it can answer them at once. The run loads the runner's agent-flow channel
(`$CLAUDE_MCP_PROFILES/channel.json`, merged into the one MCP file) and its `PostToolBatch` and
`Stop` hooks (`--settings`), and allows `mcp__agent-flow__reply`. It needs
`AGENT_FLOW_N8N_TOKEN` in the job's env and `AGENT_FLOW_CALLBACK_URL` on the runner; without
them, or the profile, it warns and runs as off. A `--settings` in `claude_args` replaces the
hooks.

The placeholder carries `<!-- issue-agent-placeholder {"run_id": N} -->`, since n8n reposts it
under each in-flight reply: the answer, the failure note and the review find it by that. The
answer's seen marker covers the comments and reviews the hook handed over, but never one older
that it did not, so the comment's own queued run finds nothing new and none is lost.

## Outputs

`structured` (the whole response, JSON), `output` (the role's part, JSON), `reply`,
`number`, `comment_id`, `review_id`, `head_sha`, `session_id`, `conclusion`.

## Landing the turn

`issue-agent/land` puts a turn's work on its branch, after the agent step. From the
agent's `output` it takes `commit_message`, plus `Agent: done` on it when `done` is true, so
that push wakes nothing. It pushes the wiki submodule with git, then makes one signed commit
through the API, with the wiki's pointer in it. If the commit fails, or `ignore` leaves
files out, it says so under the turn's reply, so the reply never claims work the branch
does not have. When the agent is done, it marks `pull_request` ready. No commit message
means no commit.

```yaml
- uses: kubed-io/actions/issue-agent/land@main
  id: land
  with:
    token: ${{ steps.app.outputs.token }}
    app_slug: ${{ steps.app.outputs.app-slug }}
    branch: ${{ needs.route.outputs.head }}
    output: ${{ steps.agent.outputs.output }}
    comment_id: ${{ steps.agent.outputs.comment_id }}
    # the App cannot write workflow files, and one in the commit refuses all of it
    ignore: .github/workflows/**
    pull_request: ${{ needs.route.outputs.number }}
```

Inputs: `token`, `app_slug`, `branch`, `output`, `comment_id`, `files` and `ignore` (as
git/commit's), `wiki` (the submodule, `docs`; empty for none), `pull_request` (empty never
marks one ready). Outputs: `message`, `done`, `sha`, `ignored`.

## Reading a session in VS Code

Open it to read it. To continue it there, fork it: `claude --resume <id> --fork-session`.
Two writers on one transcript corrupt it, and the issue never sees what is said in VS Code.
