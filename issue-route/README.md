# Issue Route

Decides what an event on a work item (an issue) is for the agents, and the words its turn
starts with. Reads the issue; runs no Claude.

Only a Feature or Bug issue with `agent` is the agents'. A Feature's turns are the spec
agent's (`role` `spec`); a Bug's are the debug agent's (`role` `debug`), which reports and
never writes, until `spec approved` hands its report off to a fix.

A sub-issue is part of its family: `family` is its top issue, whose queue the turn takes. It
thinks in a session of its own, `session` `issue-<family>/<number>`, whose first turn is a fork
of the parent's (`fork_from` `issue-<family>`); the parent, and an issue alone, keep
`issue-<number>`. `kin` says which it is: `sub-issue`, `parent` (it has sub-issues) or
`alone`. A sub-issue's first turn, until the App has answered on it, opens with the
`sub-issue` prompt (`lead`), or `debug-report` on a Bug.

`change` says what a hand-off opens: `sub`, a sub-issue's change into its family's branch
`issue-<family>`; `parent`, the parent's change into the default branch, its `agent` sub-issues
open or closed, with the parent's one `release:*` label as `release_label`; `own` otherwise.

`plan` says whether the change starts with a plan turn: always on a Feature; on a Bug only
with `needs plan`, which the debug agent adds for a nasty bug and the owner may add or take
off. Without it, the change goes straight to the code, built from the report.

| Event | Before `spec approved` | After it |
|---|---|---|
| The owner's comment, on an `agent` Feature or Bug | `spec` | `none` |
| The owner's `agent` label, on a Feature | `spec`, `takeover` | `none` |
| The owner's `agent` label, on a Bug | `spec`, `prompt` debug-report (`lead`), `takeover` | |
| The owner's `spec` label, on an opted-in Feature | `spec`, `prompt` spec-draft, `writes`, `takeover` | `none` |
| The owner's `spec approved` label, on an `agent` Feature | `handoff`, `takeover`, `plan` true | |
| The owner's `spec approved` label, on an `agent` Bug | `handoff`, `takeover`, `plan` true with `needs plan` | |
| The owner's `spec approved` label, on an `agent` parent, its sub-issues open or closed | `handoff`, `change` parent, `open_sub_issues` | |
| The owner's `agent` or `spec` label while the family's sub-issue is being filed | as above, without `takeover` | |
| The App's `spec approved` label, on an `agent` sub-issue (the parent's `approve_spec`) | `handoff`, `change` sub | |
| The App's `spec approved` label on a top-level issue or a parent | `none` | |
| `sub-issue-closed`, `sub-issue-reported`: on the parent | `spec`, its prompt (`lead`) | the same (R-SM32) |
| `parent-message`: on the sub-issue | `spec`, its prompt (`lead`), or on its first turn `sub-issue` | `none` |
| `sub-issue-start`: on the sub-issue just filed | `spec`, `sub-issue` (`lead`; a Bug's `debug-report`) | `none` |
| `sub-issue-file`: on the parent | `file`, `make-sub-issue` (`always`), `item_type` | the same (R-SM32) |
| `family-pr`: on the parent (its `open_pr`, or Dr K's `spec approved` on an unlabelled parent) | `handoff`, `change` parent, `open_sub_issues`, `release_label` | the same |
| `upstream-start`, `upstream-message`: on a downstream issue | `spec`, its prompt (`lead`), `kin` downstream, `upstream` | `none` |
| `downstream-reported`: on the open epic | `spec`, `downstream-reported` (`lead`), `kin` parent | |
| The owner's comment or label on a downstream issue | as on any issue, `kin` downstream, `upstream` | |
| The App's `spec approved` label on a downstream issue (the epic's `approve_spec`) | `handoff`, `change` own | |
| Anything else (another type or none, the App's own comments, anyone else, any other label, `spec` on a Bug, a PR) | `none` | `none` |

```yaml
- uses: kubed-io/actions/issue-route@main
  id: route
  with:
    owner: "4399427"
    app: "235398881"
```

It answers n8n's `repository_dispatch` `agent-issue`: a label added or a comment made
(`client_payload`: `number`, `event`, `action`, `actor`, `comment_id`, `label`; a pointer:
the comment's author and the labeler are read back from GitHub). The job's `if` gates who may
dispatch. The token needs `issues: read`.

It answers n8n's family wake-ups too: the same `agent-issue` dispatch, whose
`client_payload.family_event` names it, so a caller lists no new type. Each is a pointer read
back the same way; without `family_event` the dispatch is a label or a comment, as before, and
an unknown one is nothing:

| `family_event` | `client_payload` | The turn | Read back |
|---|---|---|---|
| `sub-issue-closed` | `parent`, `number`, `merged` | the parent's, `sub-issue-closed` | `number` is in `parent`'s family |
| `sub-issue-reported` | `parent`, `number`, `comment_id` | the parent's, `sub-issue-reported` | as above, and the comment is the App's, on the parent |
| `parent-message` | `parent`, `number`, `comment_id` | the sub-issue's, `parent-message`; on its first turn `sub-issue` | `number` is in `parent`'s family, and the comment is the App's, on it |
| `sub-issue-start` | `parent`, `number` | the filed sub-issue's first turn, `sub-issue` | `number` is in `parent`'s family and still open |
| `sub-issue-file` | `parent`, `type`, `title`, `ask` | the make-sub-issue turn on the parent | `type` is a Feature or Bug, and there is a title |
| `family-pr` | `parent` | no turn: the hand-off opens the family's change, or refreshes the one open | `parent` is a family's top issue with sub-issues |
| `upstream-start` | `number`, `upstream` | the downstream issue's first turn, `upstream-release`, in a fresh session | `number` is open, an `agent` Feature, top-level, and carries `upstream`'s marker |
| `upstream-message` | `number`, `upstream`, `comment_id` | the downstream issue's, `upstream-message` | as above, and the comment is the App's, on it, opening with `upstream`'s note |
| `downstream-reported` | `parent`, `repo`, `number`, `comment_id` | the epic's, `downstream-reported` | `parent` is open and a family's top issue, and the comment is the App's report of `repo#number` on it |

A downstream issue (spec 2026-11-24 upstream releases) carries one hidden line naming the epic
whose release it adopts, `<!-- upstream: <owner>/<repo>#<P> -->`. It counts only on an issue the
App or Dr K wrote, and two different markers are none (`issue-agent/lib/upstream.js`). Such an
issue alone is `kin` `downstream`, with the epic as `upstream`: its turn's `report` goes to the
epic. The repo of `upstream` compares case-insensitively, the number exactly.

The issue the turn is on carries `agent` and is a Feature or Bug; the parent's turns need
`parent` to be its family's top issue, and so do a sub-issue's, whose `parent` names it. A
sub-issue's first turn (no answer of the App's on it yet) opens with `sub-issue` however it was
woken (R-SM25). A sub-issue's wake-up past `spec approved` is nothing, `why` `PAST-SPEC: …`:
a message to a sub-issue whose change is open does not reach it. A parent's go on past it
(R-SM32): there `spec approved` is Dr K asking for the family's change. A parent without
`agent` is opted in by an `agent` sub-issue (R-SM29). Anything else is nothing.

Not yet covered: a Bug parent's debug agent returns no `actions` or `open_questions`, so a Bug
family is not run by its parent. A parent's first `file`, before it has any sub-issue, is not
handed to n8n: only a `parent` (`kin`) turn's `actions` are.

A label's `takeover` cancels the family's running turn, so it waits while a sub-issue is being
filed: when another of the workflow's runs, in progress or queued, has a job named `Make the
Sub-issue · #<family>` not yet completed, the label queues like a comment and a notice says
so. The look is on `actions_token`, which may read actions (an App token, so the caller's
job needs no `actions: read`); without it the label takes over, as before, with a notice, and
when the look fails, with a warning.

| Input | Default | |
|---|---|---|
| `github_token` | `github.token` | |
| `actions_token` | `""` | May read actions: the look for a make job in flight |
| `owner` | | The owner's user id |
| `app` | | The App's bot's user id |
| `prompts` | `/mcp__superpowers__superpowers_` | |

Outputs: `stage` (`spec`, `handoff`, `file`, `none`), `why`, `number`, `family`, `change`,
`plan`, `title`, `label`, `role`, `writes`, `prompt`, `prompt_when`, `takeover`, `session`,
`fork_from`, `kin`, `item_type`, `open_sub_issues`, `opt_in_label`, `upstream`, `release_label`.
