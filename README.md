# actions

Reusable GitHub Actions for kubed-io repos, and the reusable workflows built on them.

## Actions

| Action | Description |
|---|---|
| [build-image](build-image/) | Sets up Buildx and bakes a Docker Compose file, optionally pushing to Docker Hub |
| [kluster-konnect](kluster-konnect/) | Authenticates to GCP, configures kubeconfig (in-cluster SA token or GCP Secret Manager), and optionally connects to OpenVPN |
| [kubectl](kubectl/) | Runs a kubectl command, its stdout and stderr in files of their own for the steps after it |
| [k8s-summary](k8s-summary/) | Kubernetes resources and their diffs in the step summary: manifests as accordions by kind, plan and diff output as a diff per resource, up and apply output counted |
| [issue-agent](issue-agent/) | A Claude Code agent in an issue or PR as a real Claude Code session: its reply, its notes in the description, and on a PR its review comments. No git; it outputs its structured response for the steps after it |
| [issue-agent/land](issue-agent/) | Lands an agent's turn: its commit message, the wiki, one signed commit, a note on the reply when something did not land, the PR ready when done |
| [git/branch](git/) | Makes a branch through the GitHub API, or finds it; optionally linked to an issue's Development panel |
| [git/commit](git/) | Commits the checkout's changes to a branch through `createCommitOnBranch`, so every commit is GitHub-signed |
| [git/pr](git/) | Opens a PR from a branch, draft by default with labels, or finds the open one |
| [pr-checks](pr-checks/) | Writes what a PR's checks found for an agent: the code scanning alerts open on it, new first with their threads, and the head's failure and warning annotations |
| [issue-route](issue-route/) | Decides what an event on a work item is: a spec turn, the hand-off to a plan or nothing; natively or from n8n's `agent-issue` dispatch |
| [pr-route](pr-route/) | Decides what an event on an agent-built PR is: a plan turn, a code turn or nothing, and the kb prompt it starts with; also routes an `agent-route` dispatch, n8n's relay of a review, a push, a comment or the approval label |
| [pr-checks/report](pr-checks/) | The checks workflow's last job: what failed in the run, for the code agent, as the step summary and the `checks-report` artifact |
| [pr-checks/rerun](pr-checks/) | Re-runs a checks run's failed jobs once, when the failure was judged not the change's (a flaky test, an outage) |
| [review-route](review-route/) | Decides whether the review agent reviews a PR's head, as a commit status: red checks go to the code agent, a base merge or a passing review's applied suggestions keep the verdict; `review-route/verdict` sets the status from the review |
| [app-token](app-token/) | Mints a kubed-io GitHub App token from GCP Secret Manager through Workload Identity Federation, exporting no GCP credential to the job |
| [krm-setup](krm-setup/) | Installs the KRM toolchain (kubectl, kustomize, helm, krew, kompose, yq) and `kubed-krm` Python package |
| [renovate](renovate/) | Runs Renovate with the shared kubed-io config: kustomize, Helm generator and manifest image versions on the repo's Dependency Dashboard |

## Workflows

The jobs a repo calls whole, in [.github/workflows/](.github/workflows/): GitHub calls reusable
workflows from there only. Each is abstract: its one trigger is `workflow_call`, so it runs only
from an app repo's caller file, never here. A caller passes `secrets: inherit`, so a workflow can
use any secret the repo defines.

| Workflow | Does |
|---|---|
| [kubectl.yml](.github/workflows/kubectl.yml) | `kubectl build`, `plan` or `up` of the calling repo, its output in the job summary. `up` runs in the environment given, one at a time |
| [plan.yml](.github/workflows/plan.yml) | `kubectl build` and `kubectl plan` of the calling repo in one job, both in one summary |
| [renovate.yml](.github/workflows/renovate.yml) | Renovate's run for the calling repo: new versions on its Dependency Dashboard, a PR when a box is ticked |

```yaml
jobs:
  plan:
    uses: kubed-io/actions/.github/workflows/kubectl.yml@main
    with:
      cmd: plan
    secrets: inherit
    permissions:
      contents: read
      id-token: write
```

### kubectl.yml inputs

| Input | Default | Description |
|---|---|---|
| `cmd` | — | `build`, `plan` or `up` |
| `args` | `.` | The kustomization it runs on, relative to `cwd` |
| `cwd` | `.` | The directory kubectl runs in, relative to the repo's root |
| `runner` | the caller's `vars.DEFAULT_RUNNER` | A `runs-on` label |
| `environment` | the caller's `vars.DEPLOY_ENVIRONMENT` | The GitHub environment `up` runs in |

## An app repo

Copy [.github/app/](.github/app/) into the repo's `.github/workflows/`, unchanged:

| File | Runs |
|---|---|
| [deploy.yml](.github/app/deploy.yml) | `up` on a merge to main |
| [plan.yml](.github/app/plan.yml) | the build and the plan on a PR, in one summary; a repo's own `pr.yml` stays free for its PR chores |
| [kubectl.yml](.github/app/kubectl.yml) | any of them on demand, of the app or any kustomization in the repo, on `DEFAULT_RUNNER` or GitHub's |
| [renovate.yml](.github/app/renovate.yml) | Renovate on a dashboard tick, a merge, weekly and on demand |

The workflows read their settings from the repo's variables, so every repo names them alike.
An input of the same purpose overrides one. The repo needs:

| Variable | Is |
|---|---|
| `DEFAULT_RUNNER` | The `runs-on` label of the jobs |
| `DEPLOY_ENVIRONMENT` | The environment `up` runs in; give it a deployment branch rule of `main` alone |
| `GCP_PROJECT`, `GCP_WIF_PROVIDER` | What [kluster-konnect](kluster-konnect/) and [app-token](app-token/) sign in with |

The files are the same in every repo but for the Renovate cron: give each repo a day and hour
no other has, so the week spreads them out.
