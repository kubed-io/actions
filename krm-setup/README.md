# KRM Setup Action

Installs the KRM toolchain into a GitHub Actions runner and adds everything to PATH.

**Installed tools:** kubectl, kustomize, helm, krew, kompose, yq, and all `kubectl-*` plugins from `kubed-io/krm`. The `kubed-krm` PyPI package is also installed, making `kubectl-fn`, `kubectl-kubed`, and related console scripts available.

## Usage

```yaml
- uses: kubed-io/actions/krm-setup@main
```

No inputs required. Pair with the `kubeconfig` action to get full cluster access:

```yaml
- uses: google-github-actions/auth@v3
  with:
    workload_identity_provider: ...
    service_account: ...

- uses: kubed-io/actions/kubeconfig@main

- uses: kubed-io/actions/krm-setup@main

- run: kubectl build .
