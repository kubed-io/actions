# Kubectl Action

Runs a kubectl command and writes its output to the step summary through
[kubectl/summary](#kubectlsummary).

## Usage

```yaml
- uses: kubed-io/actions/kubectl@main
  with:
    cmd: plan

- uses: kubed-io/actions/kubectl@main
  with:
    cmd: up
    args: apps/openldap
```

## Outputs

| Output | Description |
|---|---|
| `output_file` | Absolute path to the file containing the full kubectl output (stdout) |

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `cmd` | yes | — | kubectl subcommand (e.g. `build`, `plan`, `up`) |
| `args` | no | `.` | Arguments passed after the command |
| `namespace` | no | — | Target namespace (`-n`) |

# kubectl/summary

The step summary of a kubectl command's output:

- `build`: each kind an accordion, each resource in it another, holding its YAML
- `plan`: the counts to create, update and prune, then each resource's diff. The generation
  bump and the `last-applied-configuration` line are left out of the diffs.
- `up`: the counts of each verb, what changed, the unchanged folded away
- anything else: the output in a block

A failed command leads with the end of its stderr.

```yaml
- run: kubectl build . > rendered.yaml

- uses: kubed-io/actions/kubectl/summary@main
  with:
    cmd: build
    file: rendered.yaml
```

| Input | Required | Default | Description |
|---|---|---|---|
| `cmd` | yes | — | The command the output came from |
| `file` | yes | — | The file holding its output |
| `args` | no | `.` | Its arguments, for the heading |
| `error_file` | no | — | Its stderr, shown when it failed |
| `outcome` | no | `success` | Its step's outcome |
