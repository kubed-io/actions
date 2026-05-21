# Rclone Setup

Installs rclone, gnupg, and jq. Configures a `[gcs]` remote using Application Default Credentials.

Must run after `google-github-actions/auth` so `env_auth = true` has credentials to pick up.

## Example

```yaml
- uses: google-github-actions/auth@v3
  with:
    workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}
    service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}

- uses: kubed-io/actions/rclone-setup@main

- uses: kubed-io/actions/backup@main
  with:
    path: ./data/openldap
    bucket: my-backup-bucket
```
