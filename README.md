# actions

A collection of reusable GitHub Actions for kubed-io workflows.

## Actions

| Action | Description |
|---|---|
| [build-image](build-image/) | Sets up Buildx and bakes a Docker Compose file, optionally pushing to Docker Hub |
| [kluster-konnect](kluster-konnect/) | Authenticates to GCP, configures kubeconfig (in-cluster SA token or GCP Secret Manager), and optionally connects to OpenVPN |
| [kubectl](kubectl/) | Runs a kubectl command and writes output to the step summary |
| [issue-agent](issue-agent/) | Claude in an issue or PR as a real Claude Code session; the workflow gives it a role, a schema, document rounds, review threads and pushes. `issue-agent/commit` commits an approved round |
| [app-token](app-token/) | Mints a kubed-io GitHub App token from GCP Secret Manager through Workload Identity Federation, exporting no GCP credential to the job |
| [krm-setup](krm-setup/) | Installs the KRM toolchain (kubectl, kustomize, helm, krew, kompose, yq) and `kubed-krm` Python package |
