# actions

A collection of reusable GitHub Actions for kubed-io workflows.

## Actions

| Action | Description |
|---|---|
| [build-image](build-image/) | Sets up Buildx and bakes a Docker Compose file, optionally pushing to Docker Hub |
| [kluster-konnect](kluster-konnect/) | Authenticates to GCP, configures kubeconfig (in-cluster SA token or GCP Secret Manager), and optionally connects to OpenVPN |
| [kubectl](kubectl/) | Runs a kubectl command and writes output to the step summary |
| [issue-agent](issue-agent/) | Runs a repo's Claude agent in a GitHub issue: thread in, reply out, one resumable session per key |
| [plan-agent](plan-agent/) | The plan half of an issue → plan → build loop: replies and syncs a plan into the issue body |
| [krm-setup](krm-setup/) | Installs the KRM toolchain (kubectl, kustomize, helm, krew, kompose, yq) and `kubed-krm` Python package |
