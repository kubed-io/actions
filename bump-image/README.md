# Bump Image Tag Action

Rewrites the image tag in a kustomization or Helm values file and commits the
change back to the repo. Generalizes the inline "bump newTag" step so a build
workflow can point a deploy manifest at a freshly pushed image.

Only the matched `<key>:` line is touched, so surrounding comments and
formatting stay byte-stable. The commit message is derived from the repo name
(`<repo>: bump image tag to <tag> [skip ci]`), and `[skip ci]` prevents the
commit from retriggering the build.

## Inputs

| Input  | Required | Default  | Description |
| ------ | -------- | -------- | ----------- |
| `file` | yes      |          | Path to the file holding the tag key, e.g. `components/base/kustomization.yaml` or `components/helm/values.yaml`. |
| `tag`  | yes      |          | The new tag to set. |
| `key`  | no       | `newTag` | The YAML key holding the tag. Use `newTag` for a kustomize `images` entry, or `imageTag` for a Helm `values.yaml`. |

If the tag is already current the action logs a message and exits without
committing.

## Requirements

The job must check out the repo (`actions/checkout`) and have
`permissions: contents: write` so the push succeeds.

## Usage

Kustomize (default key), using `GIT_SHA` exported by `build-image`:

```yaml
- name: Bump image tag
  if: github.event_name == 'push' || inputs.push
  uses: kubed-io/actions/bump-image@main
  with:
    file: components/base/kustomization.yaml
    tag: ${{ env.GIT_SHA }}
```

Helm values file:

```yaml
- name: Bump image tag
  uses: kubed-io/actions/bump-image@main
  with:
    file: components/helm/values.yaml
    key: imageTag
    tag: ${{ env.GIT_SHA }}
```
