# Kluster Konnect

Authenticates to GCP via OIDC, configures kubeconfig, and optionally connects to OpenVPN. The standard first step for any workflow that needs cluster access.

## Kubeconfig detection

| Environment | Behaviour |
|---|---|
| Self-hosted runner inside the cluster | Builds kubeconfig from the mounted SA token — GCP auth skipped entirely |
| Cloud runner (e.g. `ubuntu-latest`) | Authenticates to GCP via OIDC and fetches kubeconfig from Secret Manager |

`KUBECONFIG` is set in `$GITHUB_ENV` so all subsequent steps have cluster access automatically.

## Usage

```yaml
- uses: kubed-io/actions/kluster-konnect@main
  with:
    workload_identity_provider: projects/000000000000/locations/global/workloadIdentityPools/pool/providers/github
    service_account: github@your-project.iam.gserviceaccount.com
    kubeconfig_secret: your-project/github-kubeconfig
```

With VPN:
```yaml
- uses: kubed-io/actions/kluster-konnect@main
  with:
    workload_identity_provider: ...
    service_account: ...
    kubeconfig_secret: ...
    vpn: 'true'
    vpn_secret: your-project/github-openvpn
```

Self-hosted runner (GCP inputs still required but auth and kubeconfig fetch are skipped):
```yaml
- uses: kubed-io/actions/kluster-konnect@main
  with:
    workload_identity_provider: ...
    service_account: ...
    kubeconfig_secret: ...
```

## Inputs

| Input | Required | Description |
|---|---|---|
| `workload_identity_provider` | yes | GCP WIF provider resource name |
| `service_account` | yes | GCP service account email to impersonate |
| `kubeconfig_secret` | yes | GCP Secret Manager secret for kubeconfig (`project/name`) |
| `vpn` | no | Connect to OpenVPN (default: `false`) |
| `vpn_secret` | no | GCP Secret Manager secret for VPN credentials (`project/name`) |
