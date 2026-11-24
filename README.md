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
| [comment/start](comment/), [comment/end](comment/) | One answer for a job: the spinner first, every step's part, written once at the end, as a comment or, with line comments, one review with them under it; the failure note when the end never comes |
| [git/branch](git/) | Makes a branch through the GitHub API, or finds it; optionally linked to an issue's Development panel |
| [git/commit](git/) | Commits the checkout's changes to a branch through the API, so every commit is GitHub-signed; a wiki submodule's changes pushed with git first; a failed commit's changes kept, and a summary of what is not on the branch |
| [git/pr](git/) | Opens a PR from a branch, draft by default with labels, or finds the open one; `draft: false` marks a found draft ready |
| [pr-checks](pr-checks/) | Writes what a PR's checks found for an agent: the code scanning alerts open on it, new first with their threads, and the head's failure and warning annotations |
| [issue-agent/handback](issue-agent/) | A family turn's hand-back to n8n: a sub-issue's `report`, a parent's `actions`, make-sub-issue's `filed`, or a sub-issue review's `verdict`, POSTed to the agent-flow callback; n8n's answer never fails the job |
| [issue-agent/questions](issue-agent/) | The parent's `open_questions`, kept on it and as the `## Open questions` section of the family's PR to main, with its `## Open sub-issues` |
| [issue-route](issue-route/) | Decides what n8n's `agent-issue` dispatch is, a family wake-up among them: a spec turn, the hand-off to a plan, the make-sub-issue turn or nothing, and the session the turn thinks in |
| [issue-template](issue-template/) | Turns an issue form into a JSON schema for an agent's output: one form by type or name, or a catalog of sub-issues to suggest |
| [pr-route](pr-route/) | Decides what a dispatch on an agent-built PR is: a plan turn, a code turn or nothing, and the kb prompt it starts with; an `agent-code` dispatch, or n8n's `agent-route` relay of a review, a push, a comment or the approval label |
| [pr-checks/report](pr-checks/) | The checks workflow's last job: what failed in the run, for the code agent, as the step summary and the `checks-report` artifact |
| [pr-checks/rerun](pr-checks/) | Re-runs a checks run's failed jobs once, when the failure was judged not the change's (a flaky test, an outage) |
| [pr-update](pr-update/) | Brings every open PR on a branch up to date after a merge: update-branch, else the merge with its docs pointer moved to a merge of both sides' wiki and the changelog's hunks unioned; any other conflict is the PR's agent's |
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
| [agent-issue.yml](.github/workflows/agent-issue.yml) | The spec agent on an issue, and the hand-off to a draft PR and its plan; a family's sub-issues in forked sessions, their reports and the parent's actions handed to n8n, and its open sub-issue PRs brought up to date when the family's branch moves. Called on the `agent-issue` dispatch, a family's wake-ups among them (`family_event`), and `sub-issue-accepted` |
| [agent-pr.yml](.github/workflows/agent-pr.yml) | The plan and code agents on an agents' PR. Called on the `agent-code` and `agent-route` dispatches |
| [agent-review.yml](.github/workflows/agent-review.yml) | The review agent and its `Agent review` status; a sub-issue's PR reviewed with its own prompt, its verdict handed to n8n. Called on the `agent-review` dispatch |
| [agent-renovate.yml](.github/workflows/agent-renovate.yml) | The renovate agent on a Renovate PR: what the bump needs as one follow-up commit, and a verdict. Called on the `agent-renovate` dispatch |

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

### The agent workflows

**Agents and roles.** An *agent* is one of the kubed-runner plugin's agent files in
kubed-io/talent-show (`plugins/kubed-runner/agents/`): who it is and how it works. An *agent
role* is a folder in [.github/roles/](.github/roles/) (`spec`, `spec-draft`, `plan`, `code`,
`review`, `debug`, `renovate`): the `settings.json` a job runs the agent with, its tools
(`permissions.allow` and `deny`) included, and the `schema.json` of what it answers. `spec-draft`
is the spec agent on a turn that writes the spec, and shares `spec`'s schema. An agent can take on one or more roles, and two roles can share an agent with
different settings and outputs. A job checks the roles out at run time as `AGENT_ROLES`.

Their jobs on the `claude` runner run for a `repository_dispatch` only, which always runs the
caller on the default branch: the runner group lists these files, so no branch's caller reaches
it. The caller grants the jobs' permissions, the union of the jobs' own.

| Input | Of | Description |
|---|---|---|
| `wiki` | agent-issue, agent-pr | The wiki submodule's path. `docs` when the specs live in the wiki, which lands first and docs/ is its pointer; `wiki` when docs/ is in the repo |

A repo's own setup for the code agent, past Python, is a composite action at
`.github/actions/agent-setup/`; agent-pr.yml runs it when the checkout has one.

agent-issue.yml's caller lists the dispatch types it runs on: `agent-issue` and
`sub-issue-accepted`. A family's wake-ups are `agent-issue` dispatches whose
`client_payload.family_event` is `sub-issue-closed`, `sub-issue-reported`, `parent-message`,
`sub-issue-file` or `sub-issue-start` ([issue-route](issue-route/) has their payloads). Its
hand-backs go to the agent-flow callback with the channel's token: a sub-issue's
`{type: "report", repo, parent, number, report, run_id}`, from the spec or the debug agent, a
parent's `{type: "actions", repo, parent, run_id, actions}`, and make-sub-issue's
`{type: "filed", repo, parent, number, run_id}`, on which n8n starts the new sub-issue. The
parent is labelled `epic` when its first sub-issue is filed, and the family's change to main
carries the parent's one `release:*` label.

An upstream epic (a library's parent issue) carries its downstream projects along. Its actions
add `release_level {level}` and `prerelease {summary}`, and `message`, `approve_spec` and
`approve_plan` take a downstream `repo`. A downstream issue carries the epic's marker,
`<!-- upstream: <owner>/<repo>#<P> -->`, and so does its PR's body. Its turns are woken by
`upstream-start` and `upstream-message`, the epic's by `downstream-reported`. They hand back
`{type: "upstream-report", repo, number, upstream, report, pull_request?, run_id}`, from a
turn's `report` or, on the PR's plan turns, saying the plan is ready. The PR stays draft until
the epic's final: agent-pr.yml's Mark Ready runs only on pr-route's `held` `false`.

agent-review.yml reviews a sub-issue's PR (base `issue-<P>`) with the `review-sub-issue`
prompt, and hands its verdict to the same callback after the check, as
`{type: "verdict", repo, number, sha, verdict, summary, review_id, run_id}`; a pass carried to
a new head goes too, from a short job on the claude runner, and so does a `needs a human` when
the PR stops at the review or fix cap, or its last allowed review asks for changes. Other PRs
are reviewed as before.

agent-renovate.yml takes no inputs. Its dispatch is `{pull_request, reason, comment_id}`,
`reason` being `opened`, `comment` (with the comment's id) or `updated`. Its role files are
[.github/roles/renovate/](.github/roles/renovate/), whose settings deny deploying, committing
and merging, and give the automatic compact the agent's keep-list.

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
| [agent-renovate.yml](.github/app/agent-renovate.yml) | the renovate agent on a Renovate PR, on n8n's `agent-renovate` dispatch |

The workflows read their settings from the repo's variables, so every repo names them alike.
An input of the same purpose overrides one. The repo needs:

| Variable | Is |
|---|---|
| `DEFAULT_RUNNER` | The `runs-on` label of the jobs |
| `DEPLOY_ENVIRONMENT` | The environment `up` runs in; give it a deployment branch rule of `main` alone |
| `GCP_PROJECT`, `GCP_WIF_PROVIDER` | What [kluster-konnect](kluster-konnect/) and [app-token](app-token/) sign in with |

The files are the same in every repo but for the Renovate cron: give each repo a day and hour
no other has, so the week spreads them out.
