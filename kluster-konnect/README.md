# Kluster Konnect

Authenticates to GCP via OIDC, configures kubeconfig, and connects to OpenVPN. The standard first step for any workflow that needs cluster access.

## Behaviour

| Environment | What happens |
|---|---|
| Self-hosted runner inside the cluster | Builds kubeconfig from the mounted SA token — GCP auth, VPN, and kubeconfig fetch are all skipped |
| Cloud runner (e.g. `ubuntu-latest`) | GCP OIDC auth → fetch kubeconfig → connect to VPN |

`KUBECONFIG` is set in `$GITHUB_ENV` so all subsequent steps have cluster access automatically.

## Usage

```yaml
- uses: kubed-io/actions/kluster-konnect@main
  with:
    workload_identity_provider: projects/000000000000/locations/global/workloadIdentityPools/pool/providers/github
    project: your-gcp-project
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `workload_identity_provider` | yes | — | GCP WIF provider resource name |
| `project` | yes | — | GCP project ID |
| `service_account` | no | `github` | GCP service account name (email constructed as `name@project.iam.gserviceaccount.com`) |
| `kubeconfig_secret` | no | `github-kubeconfig` | Secret Manager secret name for kubeconfig (prefixed with `project/`) |
| `vpn_secret` | no | `github-openvpn` | Secret Manager secret name for VPN credentials (prefixed with `project/`) |
