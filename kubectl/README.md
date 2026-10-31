# Kubectl Action

Runs a kubectl command. Its stdout and stderr each go to a file of their own, one pair per run,
for the steps after it: [k8s-summary](../k8s-summary/) shows them.

## Usage

```yaml
- uses: kubed-io/actions/kubectl@main
  with:
    cmd: build

- uses: kubed-io/actions/kubectl@main
  with:
    cmd: up
    args: apps/openldap
```

## Outputs

| Output | Description |
|---|---|
| `output_file` | The command's stdout |
| `error_file` | The command's stderr |

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `cmd` | yes | — | kubectl subcommand (e.g. `build`, `plan`, `up`) |
| `args` | no | `.` | Arguments passed after the command |
| `namespace` | no | — | Target namespace (`-n`) |
