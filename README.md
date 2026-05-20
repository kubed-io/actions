# actions

A collection of reusable GitHub Actions for kubed-io workflows.

## Actions

| Action | Description |
|---|---|
| [build-image](build-image/) | Sets up Buildx and bakes a Docker Compose file, optionally pushing to Docker Hub |
| [krm-setup](krm-setup/) | Installs the KRM toolchain (kubectl, kustomize, helm, krew, kompose, yq) and `kubed-krm` Python package |
| [kubeconfig](kubeconfig/) | Fetches a kubeconfig from GCP Secret Manager and sets `KUBECONFIG` for the job |
| [openvpn](openvpn/) | Fetches VPN credentials from GCP Secret Manager and connects to OpenVPN |
