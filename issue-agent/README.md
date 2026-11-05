# Issue Agent (Claude)

A Claude Code agent in a GitHub issue or pull request, as a real Claude Code session.
Your new comments are the turn, in your words. The agent answers with:

- **a reply**, posted as a comment;
- **notes**, kept collapsed at the bottom of the description: what the next run, or the
  pull request after an issue, starts from;
- on a pull request, **line comments** and suggestions (`review: true`), handed to
  [comment/end](../comment/), which posts the answer as one review with them under it, the
  way Copilot reviews.

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
    agent: .issue/roles/claude/agents/plan.md
    schema: .issue/roles/claude/agents/plan.schema.json
    append_system_prompt: Plans go under docs/superpowers/plans/.
    header: "📄 [{{ output.plan_path }}]({{ link:output.plan_path }})"
    session_key: pr-${{ github.event.issue.number }}
- uses: kubed-io/actions/git/commit@main
  with:
    token: ${{ steps.app.outputs.token }}
    message: ${{ fromJSON(steps.agent.outputs.output).commit_message }}
```

The `agent` is a Claude Code agent file (frontmatter and body). It is loaded with
`--agents` from wherever the workflow put it, and its body replaces Claude Code's default
system prompt. Then the action's contract and `append_system_prompt` are appended.

On the claude runner, a role's agent comes from a plugin instead, and its `settings` say
which (kubed-io/claude-control's `kubed-runner`). Each role's settings sit beside its schema:

```yaml
    settings: ${{ env.CLAUDE_AGENTS }}/plan/settings.json   # turns kubed-runner on, agent kubed-runner:plan
    schema: ${{ env.CLAUDE_AGENTS }}/plan/schema.json
```

The plugin brings the agent's MCP servers, and each agent's `tools` list is what it may use.
Leave `--strict-mcp-config` out of `claude_args`: it drops a plugin's servers.

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
new-side line numbered). And `scratch/`, the agent's own: what it leaves there is there next
turn of the same issue or PR, kept in the repository's Actions cache (restored from the newest
`agent-scratch-<owner>-<repo>-<number>-` entry, saved even when the turn fails). Not artifacts:
a public repository's artifacts are anyone's to download, its caches only its workflows'.

## Inputs

| Input | Default | Description |
|---|---|---|
| `github_token` | required | Thread I/O; the App's, so what it posts wakes workflows |
| `number` | the event's | For a run started off the thread |
| `agent` | `""` | A Claude Code agent file, or a name Claude Code knows |
| `schema` | `""` | The role's output schema, inline or a path; becomes `output` |
| `settings` | `""` | Claude Code settings, inline or a path: a role's plugin and agent; merged with the live hooks |
| `append_system_prompt` | `""` | This job's extras, inline or a path |
| `prompt` | `""` | The event's turn, for an event with no words |
| `prompt_when` | `quiet` | `quiet`: only when nothing new; `always`: every run, quoted above the reply |
| `header` | `""` | Template above the reply: `{{ output.<field> }}`, `{{ link:output.<field> }}` (the file's wiki page when it is in a wiki submodule, else its blob), `{{ run_url }}`, `{{ session_id }}`, `{{ number }}`, `{{ blob }}` |
| `review`, `threads` | `false`, `true` | The PR fields the agent gets |
| `session_key` | `""` | Resumable session |
| `trusted` | the runner's `CLAUDE_OWNER_ID`, `CLAUDE_TRUSTED_BOTS` | Ids and bots whose messages count |
| `opt_in_label`, `max_runs` | `""`, `0` | The gate |
| `mcp` | `""` | Inline JSON or a file; `${VAR}` from env |
| `compact` | `""` | Compact a resumed session before the turn, steered by these instructions |
| `model`, `max_turns`, `allowed_tools`, `disallowed_tools`, `permission_mode` | the agent's | Per-job overrides |
| `claude_args` | `""` | Extra Claude Code flags |
| `show_full_output` | `false` | Keep false in public repos |
| `scratch_dir` | `.issue` | Thread files; gitignore it |
| `keep_scratch` | `true` | Keep `{scratch_dir}/scratch/` from turn to turn |
| `scratch_cache` | `true` | Restore and save it here; `false` when the workflow does, around the job |
| `comment_id` | `""` | comment/start's: answer in its comment, see below |
| `live_messages` | `false` | n8n's pushes reach the running turn (claude runner); see below |

## Live messages

With `live_messages: true` on the claude runner, the owner's comments reach the agent while it
works, and it can answer them at once. The run loads the runner's agent-flow channel
(`$CLAUDE_MCP_PROFILES/channel.json`, merged into the one MCP file) and its `PostToolBatch` and
`Stop` hooks (`--settings`), and allows `mcp__agent-flow__reply`. It needs
`AGENT_FLOW_N8N_TOKEN` in the job's env and `AGENT_FLOW_CALLBACK_URL` on the runner; without
them, or the profile, it warns and runs as off. The hooks are merged into the `settings`
input's file, so the run has one `--settings`; another in `claude_args` replaces them.

The placeholder carries `<!-- issue-agent-placeholder {"run_id": N} -->`, since n8n reposts it
under each in-flight reply: the answer and the failure note find it by that. The
answer's seen marker covers the comments and reviews the hook handed over, but never one older
that it did not, so the comment's own queued run finds nothing new and none is lost.

## Inside comment/start and comment/end

Given [comment/start](../comment/)'s `comment_id`, the thread comment is the pair's: the agent
posts no placeholder, reply or failure note. Its reply goes to comment/end as a part, with its
seen marker, and its line comments (`review: true`) go beside it, so comment/end posts the
answer once: a comment, or one review with them under it. Its `comment_id` output is where the
comment is when it ends, since n8n may have moved it. Two runs in one job answer in one
comment, and a second turn of the same session starts after the first's answer.

Two runs share one scratchpad cache key, so the workflow keeps it instead, once around the
job, and saves it even when a turn failed:

```yaml
- uses: actions/cache/restore@v6
  with:
    path: .issue/scratch
    key: agent-scratch-${{ github.repository_owner }}-${{ github.event.repository.name }}-${{ env.NUMBER }}-${{ github.run_id }}-${{ github.run_attempt }}
    restore-keys: agent-scratch-${{ github.repository_owner }}-${{ github.event.repository.name }}-${{ env.NUMBER }}-
# ... comment/start, issue-agent with scratch_cache: false, twice, git/commit, comment/end ...
- if: always()
  uses: actions/cache/save@v6
  with:
    path: .issue/scratch
    key: agent-scratch-${{ github.repository_owner }}-${{ github.event.repository.name }}-${{ env.NUMBER }}-${{ github.run_id }}-${{ github.run_attempt }}
```

Without `comment_id` it posts and edits its own comment, as before; that goes when every
caller uses comment/start.

## Outputs

`structured` (the whole response, JSON), `output` (the role's part, JSON), `reply`,
`number`, `comment_id` (with comment/start, where its comment is now), `head_sha`, `reviewed_sha`, `session_id`, `conclusion`.
`reviewed_sha` is the commit the line comments are on: the checkout's when the turn ended, past
`head_sha` when a push was brought in during it, and then line comments are checked against
that commit's diff.

## Committing the turn

The agent writes; it never commits. The workflow commits its work with
[git/commit](../git/), from its `output`:

```yaml
- id: commit
  if: fromJSON(steps.agent.outputs.output || '{}').commit_message
  continue-on-error: true
  uses: kubed-io/actions/git/commit@main
  with:
    token: ${{ steps.app.outputs.token }}
    branch: ${{ needs.route.outputs.head }}
    message: ${{ fromJSON(steps.agent.outputs.output).commit_message }}
    keep_to: .issue/scratch/uncommitted
- uses: kubed-io/actions/comment/end@main
  with:
    github_token: ${{ steps.app.outputs.token }}
    append: ${{ steps.commit.outputs.summary }}
```

`summary` goes in the answer, so the reply never claims work the branch does not have.

## Reading a session in VS Code

Open it to read it. To continue it there, fork it: `claude --resume <id> --fork-session`.
Two writers on one transcript corrupt it, and the issue never sees what is said in VS Code.
