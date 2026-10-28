# PR Checks

What a pull request's checks found, for an agent, written into its scratch directory
before it runs. Reads only.

| File | What is in it |
|---|---|
| `security.md` | Code scanning alerts open on the PR: new in this PR first, then those already on the base in files the PR changes, each with the thread the scanner opened on it; threads left open on alerts that are fixed or dismissed; whether a scan of the head is still running |
| `checks.md` | The failure and warning annotations of every finished check on the head, except the scanner's own (those are `security.md`) |

An alert keeps its own state: it is open until a scan stops finding it (fixed) or a human
dismisses it. The agent fixes the code, or declines with evidence on the alert's thread,
and resolves the thread through issue-agent's `threads`. It never dismisses.

```yaml
- uses: kubed-io/actions/pr-checks@main
  with:
    number: ${{ needs.route.outputs.number }}
```

The job's token needs `pull-requests: read`, `checks: read` and `security-events: read`.

| Input | Default | |
|---|---|---|
| `github_token` | `github.token` | |
| `number` | | The pull request |
| `scratch_dir` | `.issue` | issue-agent's scratch dir |
| `scans` | `CodeQL,Workflow Audit` | The scanning jobs' names, to tell a scan still running |

Outputs: `new_alerts` (alerts the PR brings that the base does not have), `pending`.

## Report

`pr-checks/report` is the other end: the checks workflow's last job, after every check. It
writes what failed in the run to `report.md` and `report.json` (per failed job: its failed
steps, its failure and warning annotations, its error lines, and the log up to its last
error, without timestamps or colour codes), puts the report in the step summary, and
uploads it as the `checks-report` artifact. The code agent downloads it from the run a
`ci` dispatch names; review-route skips a run that has none.

```yaml
checks:
  needs: [test, lint]
  # a draft's or a label's run ran no checks: no job, no artifact
  if: always() && !github.event.pull_request.draft
  permissions:
    actions: read
    checks: read
  steps:
  - uses: kubed-io/actions/pr-checks/report@main
```

| Input | Default | |
|---|---|---|
| `github_token` | `github.token` | Reads the run's jobs and logs (`actions: read`) and annotations (`checks: read`) |
| `sha` | the PR's head | |
| `artifact` | `checks-report` | |
| `retention_days` | `14` | |

Output: `failed`, how many jobs failed.
