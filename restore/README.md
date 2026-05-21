# GPG Restore

Downloads an encrypted backup from GCS, decrypts with GPG, and extracts into a target directory. Streams directly from GCS — no staging file to disk.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `path` | yes | — | Destination directory to extract into |
| `bucket` | yes | — | GCS bucket name |
| `prefix` | yes | — | Key prefix within the bucket |
| `filename` | no | latest | Specific backup filename (default: most recent) |
| `gpg_secret` | no | `gpg` | GCP Secret Manager secret with GPG credentials JSON |

## Example

```yaml
jobs:
  restore:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
    - uses: actions/checkout@v6
    - uses: google-github-actions/auth@v3
      with:
        workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}
        service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}
    - uses: kubed-io/actions/rclone-setup@main
    - uses: kubed-io/actions/restore@main
      with:
        path: ./data/openldap
        bucket: my-backup-bucket
        prefix: openldap
```
