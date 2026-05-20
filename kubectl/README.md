# Kubectl Action

Runs a kubectl command and writes the output to the GitHub Actions step summary. Output is fenced as YAML for `build`, plain code block for everything else.

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
| `output_file` | Absolute path to the file containing the full kubectl output |

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `cmd` | yes | — | kubectl subcommand (e.g. `build`, `up`) |
| `args` | no | `.` | Arguments passed after the command |
| `namespace` | no | — | Target namespace (`-n`) |
