# Plan Agent (Claude)

The "plan" half of an issue → plan → build loop. Claude does homework on the repo, writes a structured plan to a gitignored file, and a deterministic step publishes that file into a single pinned comment (created the first time, edited in place after). The agent never writes to GitHub itself.

## How it works

1. **Trigger** — an issue gets the `claude` label (first plan) or a human posts a comment containing `@claude` (iteration).
2. **Homework** — Claude reads the issue, all comments, and relevant repo files. It never guesses.
3. **Plan file** — Claude writes the full plan as GitHub-flavored markdown to `.plan/plan.md` (gitignored, so no branch or PR is created). Its visible reply is short (1–3 sentences).
4. **Publish** — `publish-plan.js` upserts the plan file into one pinned comment identified by a sentinel marker line.

## Usage

Caller responsibilities: check out the repo, install any toolchain the homework needs, provide secrets, and gitignore the plan file path.

```yaml
- name: Checkout
  uses: actions/checkout@v6

- name: KRM Setup
  uses: kubed-io/actions/krm-setup@main

- name: Konnect
  uses: kubed-io/actions/kluster-konnect@main
  with:
    workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}
    project: ${{ vars.GCP_PROJECT }}
    kubeconfig: ${{ contains(github.event.issue.labels.*.name, 'kube') }}
    vpn: ${{ contains(github.event.issue.labels.*.name, 'vpn') }}

- name: Get secrets
  id: secrets
  uses: google-github-actions/get-secretmanager-secrets@v3
  with:
    secrets: |-
      anthropic:${{ vars.GCP_PROJECT }}/anthropic
      github_app:${{ vars.GCP_PROJECT }}/github-app

- name: Mint app token
  id: app-token
  uses: actions/create-github-app-token@v3
  with:
    client-id: ${{ fromJson(steps.secrets.outputs.github_app).github_app_client_id }}
    private-key: ${{ fromJson(steps.secrets.outputs.github_app).github_app_private_key }}

- name: Plan Agent
  uses: kubed-io/actions/plan-agent@main
  with:
    anthropic_api_key: ${{ steps.secrets.outputs.anthropic }}
    github_token: ${{ steps.app-token.outputs.token }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `anthropic_api_key` | yes | — | Anthropic API key passed to claude-code-action |
| `github_token` | yes | — | Token used to post/edit comments — typically a GitHub App installation token |
| `model` | no | `sonnet` | Claude model alias (`sonnet`, `opus`) or full model id |
| `max_turns` | no | `40` | Max Claude Code turns (only used turns are billed) |
| `label_trigger` | no | `claude` | Issue label that fires the first plan run |
| `marker` | no | `<!-- plan-agent -->` | Sentinel first line that identifies the single pinned plan comment |
| `plan_file` | no | `.plan/plan.md` | Repo-relative path Claude writes the plan to — must be gitignored |

## Labels

The workflow consuming this action should gate on labels to control what the agent can access:

| Label | Effect |
|---|---|
| `claude` | Trigger — fires the first plan |
| `kube` | Pass to `kluster-konnect` to load kubeconfig (enables `kubectl get` live resources) |
| `vpn` | Pass to `kluster-konnect` to connect OpenVPN (in-network access) |

## Files

| File | Purpose |
|---|---|
| `action.yml` | Composite action definition |
| `system-prompt.md` | Agent system prompt — `__PLAN_FILE__` is replaced at runtime with `inputs.plan_file` |
| `publish-plan.js` | Upserts the plan file into a single pinned comment via the GitHub REST API |
