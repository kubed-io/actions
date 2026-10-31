# K8s Summary

Kubernetes resources and their diffs as markdown in the step summary. One call per job, with
as many sections as the job has outputs: a PR's build and plan, an `up`, a query.

| `type` | Give it | Shows |
|---|---|---|
| `yaml` | manifests: multi-document YAML, a kubectl `List`, or the same as JSON | an accordion per kind, another per resource |
| `names` | one resource a line: `up`/`apply` output, or `get -o name` | the count of each verb, the unchanged folded away; plain names grouped by kind |
| `diff` | `kubectl diff` or `kubectl plan` output | the counts to create, update and prune, then a diff per resource, without the generation bump or the `last-applied-configuration` line |
| `text` | anything else | the output in a block, highlighted as `lang` |
| `auto` | any of the above | the view the content looks like (the default) |

A section whose `outcome` is not `success` leads with the end of its `error_file`.

## Usage

A build and a plan in one summary, from [kubectl](../kubectl/)'s outputs:

```yaml
- name: Build
  id: build
  uses: kubed-io/actions/kubectl@main
  with:
    cmd: build

- name: Plan
  id: plan
  uses: kubed-io/actions/kubectl@main
  with:
    cmd: plan

- name: Summary
  if: always()
  uses: kubed-io/actions/k8s-summary@main
  with:
    title: n8n
    sections: |
      - title: Build
        type: yaml
        file: ${{ steps.build.outputs.output_file }}
        error_file: ${{ steps.build.outputs.error_file }}
        outcome: ${{ steps.build.outcome }}
      - title: Plan
        type: diff
        file: ${{ steps.plan.outputs.output_file }}
        error_file: ${{ steps.plan.outputs.error_file }}
        outcome: ${{ steps.plan.outcome }}
```

One file:

```yaml
- run: kubectl get pods -n flow -o yaml > pods.yaml

- uses: kubed-io/actions/k8s-summary@main
  with:
    file: pods.yaml
```

`sections` is a YAML list with one `key: value` a line (or the same as JSON). Its keys are
`title`, `file`, `type`, `lang`, `error_file` and `outcome`. The single-section inputs come
first when both are given.

## Inputs

| Input | Default | Description |
|---|---|---|
| `title` | — | The summary's heading |
| `file` | — | One section's file |
| `content` | — | One section's text in place of `file`, such as a step output |
| `type` | `auto` | `yaml`, `names`, `diff`, `text` or `auto` |
| `lang` | — | The highlighting of a `text` block (`json`, `shell`, …) |
| `section-title` | — | The heading over that section |
| `error-file` | — | Its command's stderr |
| `outcome` | `success` | Its command step's outcome |
| `sections` | — | More sections, as above |
| `write` | `true` | `false` to only output the markdown |

## Outputs

| Output | Description |
|---|---|
| `markdown_file` | The markdown, for a PR comment or another summary |
