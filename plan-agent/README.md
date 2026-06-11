# Plan Agent (Claude)

The "plan" half of an issue → plan → build loop. Claude reads the issue thread + repo and returns a structured `{ reply, plan }`. It is given **no write, edit, bash, or GitHub tools** — so it physically cannot implement, commit, branch, open a PR, or post to GitHub. Deterministic `github-script` steps do all GitHub I/O: a pre-step hands Claude the conversation as a file, and a post-step posts a short reply plus upserts **one pinned plan comment** (created the first run, edited in place after).

This separation is the whole point: a plan agent that *could* write would eventually treat "we should change X" as a build order. Here it can't — building is exclusively the downstream builder's job (e.g. assign GitHub Copilot to the issue).

## How it works

1. **Trigger** (in the *caller's* `if`) — an issue gets the `claude` label (first plan), or a human posts a comment containing `@claude` (iteration).
2. **Gather** — `gather-context.js` writes the issue body + full comment thread to `<scratch_dir>/context.md` (gitignored).
3. **Plan** — Claude (automation mode, `--json-schema`) reads that file + repo with read-only tools and returns `{ reply, plan }`. No file writes, no commands, no GitHub.
4. **Publish** — `publish-plan.js` upserts `plan` into one pinned comment (sentinel-marked) and posts `reply` as a short new comment.

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
| `anthropic_api_key` | yes | — | Anthropic API key for claude-code-action |
| `github_token` | yes | — | Token used for all comment I/O — typically a GitHub App installation token |
| `model` | no | `sonnet` | Claude model alias (`sonnet`, `opus`) or full id |
| `max_turns` | no | `40` | Max Claude Code turns (only used turns are billed) |
| `marker` | no | `<!-- plan-agent -->` | Sentinel first line identifying the single pinned plan comment |
| `scratch_dir` | no | `.plan` | Gitignored dir for the `context.md` hand-off file — **must be gitignored** |
| `context_file` | no | `""` | Optional repo-relative file of app-specific guidance, appended to the agent's system prompt |

## Notes

- The caller's job `if` is the real gate (e.g. require `@claude` in the comment body so a comment without it never spins a runner).
- The agent has **no Bash**, so it can't run `kubectl build`/`kubectl get` — it reads kustomize/krm YAML directly. (Trade-off taken deliberately: full Bash would re-open the door to git/implementation.)

## Files

| File | Purpose |
|---|---|
| `action.yml` | Composite action definition |
| `setup.sh` | Builds the system prompt (role + `context_file`) and minifies the schema → step outputs |
| `system-prompt.md` | Agent role — loaded via `--append-system-prompt-file` |
| `output-schema.json` | Structured-output schema (`reply`, `plan`) — minified into `--json-schema` |
| `gather-context.js` | Writes the issue + thread to `context.md` for the agent to read |
| `publish-plan.js` | Posts `reply` + upserts the pinned plan comment from `structured_output` |
