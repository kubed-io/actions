# GPG Backup

Tars a directory, encrypts it with GPG, and uploads to GCS. Pruning keeps the last N backups per prefix.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `path` | yes | — | Local directory to back up |
| `bucket` | yes | — | GCS bucket name |
| `prefix` | no | basename of `path` | Key prefix within the bucket |
| `gpg_secret` | no | `gpg` | GCP Secret Manager secret with GPG credentials JSON |
| `keep` | no | `7` | Backups to retain per prefix (0 = keep all) |

## GPG secret format

The GCP secret must be a JSON object:
```json
{
  "public.key": "<armored public key>",
  "private.key": "<armored private key>",
  "email": "user@example.com",
  "password": "<gpg passphrase>"
}
```

## Artifact naming

`{basename}-{timestamp}.tar.gz.gpg` → e.g. `openldap-20260521-120000.tar.gz.gpg`

## Example

```yaml
jobs:
  backup:
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
    - uses: kubed-io/actions/backup@main
      with:
        path: ./data/openldap
        bucket: my-backup-bucket
```
