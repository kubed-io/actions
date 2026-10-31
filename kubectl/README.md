# Kubectl Action

Runs a kubectl command in a working directory. Its stdout and stderr each go to a file of their
own, one pair per run, for the steps after it: [k8s-summary](../k8s-summary/) shows them.

The common flags are inputs of their own. They go after the command and its `args`, since
`build`, `plan` and `up` read their first argument as the app's directory.

## Usage

```yaml
- uses: kubed-io/actions/kubectl@main
  with:
    cmd: build
    cwd: apps/openldap

- uses: kubed-io/actions/kubectl@main
  with:
    cmd: get
    args: pods
    namespace: flow
    selector: app.kubernetes.io/name=n8n
    output: yaml

- id: image
  uses: kubed-io/actions/kubectl@main
  with:
    cmd: get
    args: deployment/n8n
    namespace: flow
    output: jsonpath={.spec.template.spec.containers[0].image}
    capture: true
- run: echo "${{ steps.image.outputs.stdout }}"
```

Three steps: `Args` builds the command line, `Kubectl` runs it in `cwd`, and `Output` gives the
stdout as an output, only with `capture`.

## Inputs

| Input | Default | Description |
|---|---|---|
| `cmd` | — | The kubectl command (`get`, `apply`, `build`, `plan`, `up`, …) |
| `args` | `.` | Its arguments, split on spaces (quotes are not honoured) |
| `cwd` | `.` | The directory it runs in; the paths in `args` are relative to it |
| `namespace` | — | `--namespace` |
| `all-namespaces` | — | `true` for `--all-namespaces` |
| `selector` | — | `--selector`, a label selector |
| `output` | — | `--output`: `yaml`, `json`, `name`, `wide`, `jsonpath=…` |
| `context` | — | `--context`, the kubeconfig context |
| `dry-run` | — | `--dry-run`: `server`, `client` or `none` |
| `capture` | — | `true` to give the stdout as the `stdout` output too |

## Outputs

| Output | Description |
|---|---|
| `output_file` | The command's stdout |
| `error_file` | The command's stderr |
| `stdout` | The stdout itself, when `capture` is `true`: for a short result like a jsonpath, as an output is held to 1 MB |
