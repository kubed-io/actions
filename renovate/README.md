# Renovate Action

Runs [Renovate](https://docs.renovatebot.com/) with the kubed-io config in [config.json](config.json).
New versions land on the repo's **Dependency Dashboard** issue; a PR opens only when its box is ticked
there. The dashboard carries the `dependency-dashboard` label. A repo needs no `renovate.json`.

What it finds:

- `images:` tags in kustomizations and components, and remote resources pinned with a tag `?ref=`
- `image:` lines in any manifest, custom resources included
- `HelmChartInflationGenerator` files (`*inflate*`, `*generator*`, `*helm*`), http and `oci://` repos
- GitHub Actions `uses:` pins

`charts/` download caches are skipped.

How it behaves:

- A release is offered once it is 3 days old. Registries that give no release date (Grafana's
  Docker Hub tags, `oci://` charts) are offered at once.
- A dependency with no release in a year is marked abandoned on the dashboard.
- Known vulnerabilities (OSV) are listed on the dashboard, and their fixes open a PR without a tick.
- No hourly PR limit, so ticking several boxes opens them all in one run.
- Kubernetes PRs carry a note: the build diff must be version lines only before `kubectl up`.

## Usage

[kubed-io/workflows](https://github.com/kubed-io/workflows) runs it as a reusable workflow, with
the triggers in each repo's caller file: a tick in the dashboard, a push to main, weekly and on
demand. Renovate edits the dashboard as a bot at the end of every run, so that workflow drops
bot edits, or each run would start the next.

```yaml
- id: app
  uses: kubed-io/actions/app-token@main
  with:
    project: ${{ vars.GCP_PROJECT }}
    workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}
- uses: kubed-io/actions/renovate@main
  with:
    token: ${{ steps.app.outputs.token }}
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `token` | yes | — | Token that can write contents, issues and pull requests |
| `repositories` | no | the current repo | Repositories to scan, comma separated |
| `log-level` | no | `info` | Renovate's `LOG_LEVEL` |

## Try the config locally

`--platform=local` reports what it finds and changes nothing:

```bash
cd /projects/kubed-io/<repo>
RENOVATE_PLATFORM=local RENOVATE_CONFIG_FILE=/projects/kubed-io/actions/renovate/config.json \
  GITHUB_COM_TOKEN=$(gh auth token) npx --yes renovate@44
```
