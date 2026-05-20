# Kubeconfig Action

Fetches a kubeconfig from GCP Secret Manager, writes it to `$RUNNER_TEMP`, and sets `KUBECONFIG` in the job environment so all subsequent steps have cluster access.

Requires GCP authentication to already be configured (via `google-github-actions/auth`).

## Usage

```yaml
- uses: google-github-actions/auth@v3
  with:
    workload_identity_provider: ...
    service_account: ...

- uses: kubed-io/actions/kubeconfig@main
```

## Inputs

| Input | Description | Default |
|---|---|---|
| `secret` | GCP Secret Manager secret in format `project/name` | `kelly-ferrone/github-kubeconfig` |

## Secret Format

The GCP secret must be a complete kubeconfig YAML string. See `apps/github/providers/kubernetes` in the cluster repo to manage this secret.
