# Plan Agent (Claude)

The "plan" half of an issue → plan → build loop. Claude reads the issue thread + repo and returns a structured `{ reply, plan }`. It is given **no write, edit, bash, or GitHub tools** — so it physically cannot implement, commit, branch, open a PR, or post to GitHub. Deterministic `github-script` steps do all GitHub I/O: a pre-step hands Claude the conversation as a file, and a post-step posts a short reply plus **syncs the plan into the issue body**, below a hard divider, under the human's original request.

This separation is the whole point: a plan agent that *could* write would eventually treat "we should change X" as a build order. Here it can't — building is exclusively the downstream builder's job (e.g. assign GitHub Copilot to the issue).

**Why the body, not a comment:** GitHub Copilot's cloud agent treats *the issue body as its prompt* — it anchors on the body, not the comment thread. Putting the plan in the body (everything above the `<!-- plan-agent -->` marker stays the human's, everything below is the agent's) means Copilot follows the plan with no instruction to "go read a comment." Pair it with a `.github/agents/*.agent.md` builder profile for an "implement the whole plan" identity.

**Reply mode** (`mode: reply`) reuses the same loop for a Q&A thread: Claude returns
`{ reply }` only, it is posted as a comment, and the issue body is never touched. Pair
it with `agent` (a repo's `.claude/agents/<name>.md`) and `session_key` to hold a
real conversation in an issue.

## How it works

1. **Trigger** (in the *caller's* `if`) — an issue gets the `claude` label (first plan), or a human posts a comment containing `@claude` (iteration).
2. **Gather** — `gather-context.js` writes the issue body + full comment thread to `<scratch_dir>/context.md` (gitignored), and the message that triggered the run to `latest.md`; a resumed reply session reads only that.
3. **Plan** — Claude (automation mode, `--json-schema`) reads that file + repo with read-only tools and returns `{ reply, plan }`. No file writes, no commands, no GitHub.
4. **Publish** — `publish-plan.js` syncs `plan` into the issue body (below the `marker` divider, preserving the human's text above it) and posts `reply` as a short new comment.

## Usage

Caller responsibilities: check out the repo, run `kluster-konnect` (its GCP auth is what fetches the keys), provide an Anthropic key + a GitHub App token, and **gitignore `scratch_dir`**.

```yaml
- uses: actions/checkout@v6
- uses: kubed-io/actions/kluster-konnect@main
  with:
    workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}
    project: ${{ vars.GCP_PROJECT }}
- id: secrets
  uses: google-github-actions/get-secretmanager-secrets@v3
  with:
    secrets: |-
      anthropic:${{ vars.GCP_PROJECT }}/anthropic
      github_app:${{ vars.GCP_PROJECT }}/github-app
- id: app-token
  uses: actions/create-github-app-token@v3
  with:
    client-id: ${{ fromJson(steps.secrets.outputs.github_app).github_app_client_id }}
    private-key: ${{ fromJson(steps.secrets.outputs.github_app).github_app_private_key }}
- uses: kubed-io/actions/plan-agent@main
  with:
    anthropic_api_key: ${{ steps.secrets.outputs.anthropic }}
    github_token: ${{ steps.app-token.outputs.token }}
    # context_file: .github/plan-agent.md   # optional app-specific guidance
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic_api_key` | no | `""` | Anthropic API key. Without it (or `claude_code_oauth_token`), claude-code-action reads `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` from the job's env |
| `claude_code_oauth_token` | no | `""` | Claude subscription token (`claude setup-token`) |
| `github_token` | yes | — | Token used for all comment I/O — typically a GitHub App installation token |
| `prompt` | no | `""` | A task that replaces the issue prompt; works without an issue (e.g. `workflow_dispatch`), with the answer in the `reply` output |
| `mode` | no | `plan` | `plan`: `{reply, plan}`, plan synced into the body. `reply`: `{reply}` only, posted as a comment |
| `agent` | no | `""` | Repo agent (`.claude/agents/<name>.md`) the session runs as; the mode's role is appended to it |
| `model` | no | `sonnet` | Claude model alias (`sonnet`, `opus`) or full id |
| `max_turns` | no | `40` | Max Claude Code turns (only used turns are billed) |
| `marker` | no | `<!-- plan-agent -->` | Hidden marker bounding the plan section in the issue body (human's request stays above it; plan regenerated below) |
| `scratch_dir` | no | `.plan` | Gitignored dir for the `context.md` hand-off file — **must be gitignored** |
| `context_file` | no | `""` | Optional repo-relative file of app-specific guidance, appended to the agent's system prompt |
| `mcp_config` | no | `""` | Optional extra MCP servers — inline JSON or a path to a JSON file. Rendered through `envsubst` to a temp `.mcp.json` (so `${VAR}` placeholders are filled from env, never hardcoded) and passed to `claude-code-action` via `--mcp-config`, merged with the built-in GitHub MCP |
| `allowed_tools` | no | `""` | Comma-separated tools to allow, e.g. `Bash(kubectl build:*)`; every server in `mcp_config` is allowed on top |
| `disallowed_tools` | no | `Bash,Edit,Write,MultiEdit,NotebookEdit` | The read-only guardrail; pass `""` to lift it |
| `extra_disallowed_tools` | no | `""` | Optional comma-separated tools appended to `disallowed_tools` — deny an MCP server's write tools to keep an MCP-enabled run read-only |
| `session_key` | no | `""` | Makes the conversation resumable: `uuid5(repo + key)` is the session ID, resumed where Claude's sessions persist (a runner with a shared `CLAUDE_CONFIG_DIR`) |
| `session_title` | no | `session_key` | The session's name when it starts |
| `claude_args` | no | `""` | Extra flags for Claude, e.g. `--permission-mode acceptEdits` |
| `allowed_bots` | no | `""` | Bots allowed to trigger the run |
| `path_to_claude_code_executable` | no | runner's `PATH_TO_CLAUDE_CODE_EXECUTABLE` | A preinstalled Claude Code; the action installs one when neither is set |
| `path_to_bun_executable` | no | runner's `PATH_TO_BUN_EXECUTABLE` | A preinstalled Bun; likewise |

### Read-only MCP example (n8n)

Give the plan agent read access to a live n8n instance via its MCP server while
denying every n8n write tool, so it can inspect real workflows but cannot mutate
them. The bearer token is injected via env (never written into YAML): export it to
the job env (e.g. from Secret Manager) as `N8N_MCP_TOKEN`, and reference it as
`${N8N_MCP_TOKEN}` inside `mcp_config` — `setup.sh` interpolates it at runtime.

```yaml
# earlier in the job, promote the secret to the job env so setup.sh's envsubst sees it:
- name: Export n8n MCP token
  env:
    TOKEN: ${{ steps.secrets.outputs.n8n_mcp_token }}
  run: echo "N8N_MCP_TOKEN=$TOKEN" >> "$GITHUB_ENV"

- uses: kubed-io/actions/plan-agent@main
  with:
    anthropic_api_key: ${{ steps.secrets.outputs.anthropic }}
    github_token: ${{ steps.app-token.outputs.token }}
    context_file: agents/workflow-maker/AGENT.md
    mcp_config: >-
      {"mcpServers":{"n8n":{"type":"http",
      "url":"http://n8n-mcp.flow.svc.cluster.local:3000/mcp",
      "headers":{"Authorization":"Bearer ${N8N_MCP_TOKEN}"}}}}
    extra_disallowed_tools: mcp__n8n__n8n_create_workflow,mcp__n8n__n8n_update_full_workflow,mcp__n8n__n8n_update_partial_workflow,mcp__n8n__n8n_delete_workflow
```

## Outputs

| Output | Description |
|---|---|
| `reply` | The agent's reply (also posted to the issue, when there is one) |
| `session_id` | The Claude session ID |
| `conclusion` | `success` or `failure` |

### On the kubed-io `claude` runner

The runner's image and job hook provide the subscription token, the preinstalled
`claude` and `bun`, the MCP profiles and a shared `/claude`, so a reply-mode
conversation needs no secrets:

```yaml
- uses: kubed-io/actions/plan-agent@main
  with:
    mode: reply
    agent: info-agent
    github_token: ${{ github.token }}
    mcp_config: ${{ env.CLAUDE_MCP_PROFILES }}/view.json
    allowed_tools: Bash(kubectl build:*)
    disallowed_tools: ""
    session_key: issue-${{ github.event.issue.number }}
    session_title: "${{ github.event.repository.name }}#${{ github.event.issue.number }}: ${{ github.event.issue.title }}"
    claude_args: --permission-mode acceptEdits --strict-mcp-config
```

## Notes

- The caller's job `if` is the real gate (e.g. require `@claude` in the comment body so a comment without it never spins a runner).
- By default the agent has **no Bash**, so it can't run `kubectl build`/`kubectl get` — it reads kustomize/krm YAML directly. (Trade-off taken deliberately: full Bash would re-open the door to git/implementation.) `allowed_tools` can open one command, e.g. `Bash(kubectl build:*)`.

## Files

| File | Purpose |
|---|---|
| `action.yml` | Composite action definition |
| `setup.sh` | Builds the system prompt (role + `context_file`) and minifies the schema → step outputs |
| `system-prompt.md` | Plan-mode role — loaded via `--append-system-prompt-file` |
| `output-schema.json` | Plan-mode structured-output schema (`reply`, `plan`) — minified into `--json-schema` |
| `reply-prompt.md` | Reply-mode role |
| `reply-schema.json` | Reply-mode schema (`reply`) |
| `gather-context.js` | Writes the issue + thread to `context.md` for the agent to read |
| `publish-plan.js` | Posts `reply` + syncs the plan from `structured_output` into the issue body |
