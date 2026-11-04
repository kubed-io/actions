# Issue Template

Turns an issue form into a JSON schema for an agent's output, so the agent writes an issue
the way the form asks for it. Feed `schema` to issue-agent's `schema`.

| Asked for | `schema` is |
|---|---|
| `type: Bug` | the form whose `type:` is Bug, as one issue: a `title` and a property per field |
| `template: bug` | that form, by file stem |
| neither | a catalog: `sub_issues`, each one of `types` that has a form, a `title` and `why` |

```yaml
- uses: kubed-io/actions/issue-template@main
  id: form
  with:
    type: Bug
- uses: kubed-io/actions/issue-agent@main
  with:
    schema: ${{ steps.form.outputs.schema }}
```

The forms come from `repo`'s `.github/ISSUE_TEMPLATE/`: left out, the organisation's `.github`
repository, where kubed-io keeps them for every repository; given empty (`repo: ''`), the
repository the workflow runs in.

A field is a property by its `id`: an input or textarea a string (a placeholder is an
example), a dropdown one of its options (an array when `multiple`), checkboxes a boolean per
option. Markdown, and checkboxes whose every option is required (an attestation by the
person filing), are left out. `validations.required` makes a property required.
`lib/form.js`'s `toIssue` files a filled item as GitHub files the submitted form.

Needs yq (mikefarah), which GitHub's Ubuntu runners and the krm runners have.

| Input | Default | |
|---|---|---|
| `github_token` | `github.token` | Reads the forms' repository |
| `type` | | Picks the form whose `type:` it is |
| `template` | | Picks a form by file stem |
| `types` | `Feature,Bug` | The types a catalog offers |
| `repo` | `<owner>/.github` | `''` for this repository |

Outputs: `schema` (a file), `template`, `type`, `labels`, `title_prefix`.
