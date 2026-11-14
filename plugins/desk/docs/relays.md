# Relays

A relay is a small GitHub automation the always-on runtime runs when a repository's own settings cannot do the job: for example, when changing a repository's settings needs an administrator. Like [issue drains](issue-drains.md) and [schedules](schedules.md), it spends no model turn. `relays poll` reads GitHub with conditional requests (an unchanged answer is a free `304`), acts, and prints no wakes. The code is [relays.js](../mcp/src/runtime/relays.js) and the `relays` command of [drains.js](../mcp/scripts/drains.js).

```sh
node <state>/ouroboros-skills/desk/drains/run.mjs relays poll      # poll the relays that are due and act
node <state>/ouroboros-skills/desk/drains/run.mjs relays status    # one line per relay
node <state>/ouroboros-skills/desk/drains/run.mjs status           # the drains, then the relays
node <state>/ouroboros-skills/desk/drains/run.mjs why --relay <name>        # a relay's recent fires, merges and waits
node <state>/ouroboros-skills/desk/drains/run.mjs why <owner/name>#<number> # the drain's wakes for an issue, plus what each merge relay decided
```

`run.mjs` is the [runner that needs no checkout](issue-drains.md#a-runner-that-needs-no-checkout); `<state>` is `$XDG_STATE_HOME` (else `~/.local/state`).

## Config

`relays.json` sits beside the drains' `config.json`, on the machine that runs the poll, and is never committed. An invalid entry fails the command with the reason; it is never dropped, because a dropped relay would stop a deploy or a merge.

Every relay has `name` (unique), `type`, and optionally `account` and `everySeconds` (10 or more, default 30). The account is the relay's own `account`, else the account the drains config gives the relay's repository, else the active `gh` account.

### `dispatch`

```json
{ "name": "data to pages", "type": "dispatch",
  "watch": { "repo": "owner/data", "workflow": "data.yml", "branch": "main", "conclusion": "success" },
  "fire":  { "repo": "owner/pages", "workflow": "pages.yml", "inputs": { "commit": "{{run.head_sha}}" } } }
```

- `watch.workflow` is the workflow's file name. `branch` is optional. `conclusion` can only be `"success"`.
- `fire` has `workflow` (a `workflow_dispatch` target, run on `ref`, default the repository's default branch, with optional `inputs`) or `event` (a `repository_dispatch` type, sent with `relay`, `run_id`, `run_url`, `head_sha` and `head_branch` in `client_payload`).
- `inputs` values may use `{{run.id}}`, `{{run.head_sha}}`, `{{run.head_branch}}`, `{{run.html_url}}` and `{{run.run_number}}` from the run that triggered the fire.

The first poll only records the runs that already succeeded. After that, a new successful run fires once, remembered by run id in `relays-state.json`, so a restart never fires it again. Runs that succeeded between two polls fire once, for the newest. A failed or cancelled run never fires. If GitHub refuses the fire, the run stays unhandled and the relay tries again after five minutes.

### `merge-when-green`

```json
{ "name": "pages merge", "type": "merge-when-green", "repo": "owner/pages",
  "label": "merge-when-green", "method": "squash", "deleteBranch": true,
  "requiredChecks": ["typecheck", "npm test (ubuntu-latest, *)"], "requireMainWorkflowGreen": "ci.yml" }
```

- `label`, `method` (`squash`, `merge` or `rebase`) and `deleteBranch` default to `merge-when-green`, `squash` and `true`.
- `requiredChecks` is a non-empty list of check-run names; `*` matches any text. A pattern needs at least one match, and every match must have completed with `success`: a missing, queued, skipped or failed check keeps the pull request waiting. Name a check exactly when its count matters.
- `requireMainWorkflowGreen` names a workflow file; the base branch's latest completed run of it must be `success`.

A labelled open pull request merges only when it is not a draft, GitHub reports it clean (not conflicted, behind, blocked or still being computed), every required check is green on its head, and the main-branch run is green. The merge names the head it checked, so GitHub refuses it if a push landed since. The relay never passes `--admin` or any bypass: it uses GitHub's ordinary merge, and GitHub's own branch rules still apply. A merge GitHub refuses is reported and tried again after five minutes, or at once for a new head. The branch is deleted after the merge when it lives in the same repository.

The relay keeps one comment per pull request, marked `<!-- desk-relay-status:<name> -->`, and edits it: what it waits on (at most every two minutes), then that it merged. A restart finds the comment again by its marker.

Only check runs are read, so a check that reports as a commit status never counts and the pull request waits.

## Visibility

`status` and `relays status` print one line per relay: when it last polled, its last fire or merge, and what it is waiting on (the next successful run, or each labelled pull request with the checks it lacks), plus `held:` when the quota paused it and `last error:` when the last poll failed. `why` answers for one relay (`--relay <name>`) or one pull request.

## Quota

Each poll sends the stored `ETag` as `If-None-Match`, and what a `304` means is kept next to the tag, so a quiet relay costs no quota. A relay shares its account's window with the issue drains: at 25 calls left it pauses until the window resets, and under 10% (or 200 calls) it polls at most every 15 minutes.

## Running it from Ouroboros

Give the always-on runtime a [wake runner](https://github.com/ourostack/ouroboros/blob/main/docs/app-sessions-sense.md#wake-runners) that runs the poll every 30 seconds. It prints no wakes, so it needs no `delivery`:

```json
{ "name": "relays", "command": ["<node>", "<state>/ouroboros-skills/desk/drains/run.mjs", "relays", "poll"], "everySeconds": 30 }
```

`ouro status` then lists each relay under the runner.
