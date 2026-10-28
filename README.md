# actions

A collection of reusable GitHub Actions for kubed-io workflows.

## Actions

| Action | Description |
|---|---|
| [build-image](build-image/) | Sets up Buildx and bakes a Docker Compose file, optionally pushing to Docker Hub |
| [kluster-konnect](kluster-konnect/) | Authenticates to GCP, configures kubeconfig (in-cluster SA token or GCP Secret Manager), and optionally connects to OpenVPN |
| [kubectl](kubectl/) | Runs a kubectl command and writes output to the step summary |
| [issue-agent](issue-agent/) | A Claude Code agent in an issue or PR as a real Claude Code session: its reply, its notes in the description, and on a PR its review comments. No git; it outputs its structured response for the steps after it |
| [issue-agent/land](issue-agent/) | Lands an agent's turn: its commit message, the wiki, one signed commit, a note on the reply when something did not land, the PR ready when done |
| [git/branch](git/) | Makes a branch through the GitHub API, or finds it; optionally linked to an issue's Development panel |
| [git/commit](git/) | Commits the checkout's changes to a branch through `createCommitOnBranch`, so every commit is GitHub-signed |
| [git/pr](git/) | Opens a PR from a branch, draft by default with labels, or finds the open one |
| [pr-checks](pr-checks/) | Writes what a PR's checks found for an agent: the code scanning alerts open on it, new first with their threads, and the head's failure and warning annotations |
| [pr-route](pr-route/) | Decides what an event on an agent-built PR is: a plan turn, a code turn or nothing, and the kb prompt it starts with |
| [pr-checks/report](pr-checks/) | The checks workflow's last job: what failed in the run, for the code agent, as the step summary and the `checks-report` artifact |
| [review-route](review-route/) | Decides whether the review agent reviews a PR's head, as a commit status: red checks go to the code agent, a base merge or a passing review's applied suggestions keep the verdict; `review-route/verdict` sets the status from the review |
| [app-token](app-token/) | Mints a kubed-io GitHub App token from GCP Secret Manager through Workload Identity Federation, exporting no GCP credential to the job |
| [krm-setup](krm-setup/) | Installs the KRM toolchain (kubectl, kustomize, helm, krew, kompose, yq) and `kubed-krm` Python package |
