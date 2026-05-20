# OpenVPN Action

Fetches VPN credentials from GCP Secret Manager and connects to OpenVPN.

Requires GCP authentication to already be configured (via `google-github-actions/auth`).

## Usage

```yaml
- uses: google-github-actions/auth@v3
  with:
    workload_identity_provider: ...
    service_account: ...

- uses: kubed-io/actions/openvpn@main
```

## Inputs

| Input | Description | Default |
|---|---|---|
| `secret` | GCP Secret Manager secret in format `project/name` | `kelly-ferrone/github-openvpn` |

## Secret Format

The GCP secret must be a JSON object with the following keys:

```json
{
  "username": "vpn-username",
  "password": "vpn-password",
  "profile": "<contents of .ovpn file>"
}
```

See `apps/github/providers/openvpn` in the cluster repo to manage this secret.
