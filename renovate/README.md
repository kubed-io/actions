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

## Usage

Runs on a tick in the dashboard, a push to main, weekly and on demand. Renovate edits the dashboard
as a bot at the end of every run, so the `if` drops bot edits or each run would start the next.
[kubed-io/grafana](https://github.com/kubed-io/grafana/blob/main/.github/workflows/renovate.yml) is
the reference copy.

```yaml
on:
  issues:
    types:
    - edited
  push:
    branches:
    - main
  schedule:
  - cron: 0 6 * * 1
  workflow_dispatch:

concurrency:
  group: renovate
  cancel-in-progress: false

jobs:
  renovate:
    if: >-
      github.event_name != 'issues'
      || (contains(github.event.issue.labels.*.name, 'dependency-dashboard')
      && github.event.sender.type != 'Bot')
    runs-on: ubuntu-26.04
    permissions:
      contents: read
      id-token: write
    steps:
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
