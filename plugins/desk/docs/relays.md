# Relays

A relay is a small GitHub automation the always-on runtime runs when a repository's own settings cannot do the job: for example, when changing a repository's settings needs an administrator. Like [issue drains](issue-drains.md), [schedules](schedules.md) and [webhooks](webhooks.md), it spends no model turn. `relays poll` reads GitHub with conditional requests (an unchanged answer is a free `304`), acts, and prints no wakes. The code is [relays.js](../mcp/src/runtime/relays.js) and the `relays` command of [drains.js](../mcp/scripts/drains.js).

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

Every relay has `name` (unique), `type`, and optionally `account` and `everySeconds` (10 or more, default 30). The account is the relay's own `account`, else the account the drains config gives the relay's repository, else the active `gh` account. A relay with nothing pending (no new run, nothing labelled) backs off: after 20 empty polls its interval stretches, to at least two minutes. `backOffWhenIdle: false` keeps it on `everySeconds` however long it is idle, for a relay whose idle polls are free 304s and whose event must be heard within seconds (a release that a consuming repository's update bot is waiting for, say).

### `dispatch`

```json
{ "name": "data to pages", "type": "dispatch",
  "watch": { "repo": "owner/data", "workflow": "data.yml", "branch": "main", "conclusion": "success" },
  "fire":  { "repo": "owner/pages", "workflow": "pages.yml", "inputs": { "commit": "{{run.head_sha}}" } } }
```

- `watch.workflow` is the workflow's file name. `branch` is optional. `conclusion` can only be `"success"`.
- `fire` has `workflow` (a `workflow_dispatch` target, run on `ref`, default the repository's default branch, with optional `inputs`) or `event` (a `repository_dispatch` type, sent with `relay`, `run_id`, `run_url`, `head_sha` and `head_branch` in `client_payload`).
- `inputs` values may use `{{run.id}}`, `{{run.head_sha}}`, `{{run.head_branch}}`, `{{run.html_url}}` and `{{run.run_number}}` from the run that triggered the fire.
- `settleSeconds` (a whole number from 0 to 3600, default 60) is how long the newest successful head must stay the newest before the relay fires for it. `0` fires on the poll that sees the head.

The first poll only records the runs that already succeeded. After that the relay fires at most once per watched `head_sha`, and it never fires again for a head it has fired for or passed over for a newer one, even when a second run on that head (another event's run, say) succeeds after a newer head has fired. A successful run on a head that has not fired yet starts a pending fire for that head. A newer head that succeeds within `settleSeconds` replaces it and starts the quiet period again, and another run on the same head only renames the run. Once the quiet period passes, the relay fires once for the newest head. The last fired head, the pending head and the run ids are kept in `relays-state.json`, so a restart neither fires a head twice nor drops a fire that is still settling. A failed or cancelled run never fires. If GitHub refuses the fire, the pending fire waits and the relay tries again after five minutes.

### `merge-when-green`

```json
{ "name": "pages merge", "type": "merge-when-green", "repo": "owner/pages",
  "label": "merge-when-green", "method": "squash", "deleteBranch": true,
  "requiredChecks": ["typecheck", "npm test (ubuntu-latest, *)"], "requireMainWorkflowGreen": "ci.yml" }
```

- `label`, `method` (`squash`, `merge` or `rebase`) and `deleteBranch` default to `merge-when-green`, `squash` and `true`.
- The merge always sends an explicit message: the pull request title plus ` (#n)` and its body, with any AI or bot `Co-authored-by:` line removed (a `rebase` merge has no message). GitHub otherwise copies the co-author trailers of the branch's commits into the commit on the default branch, and the repository's squash-message setting does not stop that. A lane that merges by hand does the same: `gh pr merge <n> --squash --subject "<title> (#<n>)" --body "<body without AI trailers>"`, with `--auto` when it waits for checks.
- `requiredChecks` is a non-empty list of check-run names; `*` matches any text. A pattern needs at least one match, and the newest attempt of every match must have completed with `success`: GitHub keeps a rerun's earlier attempts on the same head, and only the newest counts, as branch rules judge it. A missing, queued, skipped or failed check keeps the pull request waiting. Name a check exactly when its count matters. GitHub posts a matrix job that it skipped before the matrix expanded under its unexpanded name, such as `npm test (${{ matrix.os }}, ${{ matrix.shard }}/${{ strategy.job-total }})`. A skipped check like that satisfies each required pattern that starts with the text before its first `${{`, here `npm test (`, and it counts as skipped, so it passes only with `skippedPasses`. It stands in for a matrix that never ran: when the same pattern also matches jobs the matrix did expand, the skipped template is ignored and only the expanded jobs count.
- `skippedPasses` (`true` or `false`, default off) lets a match that completed `skipped` or `neutral` count as green. Use it for a check that a repository's own path filters skip on a change that does not touch its area. `failure`, `cancelled`, `timed_out`, `action_required` and any other conclusion, a check still running, and a missing check keep the pull request waiting either way.
- Every other check run and commit status on the head must be green too, whether or not `requiredChecks` names it: a path-filtered check that nobody listed still holds the pull request while its newest attempt is `failure`, `cancelled`, `timed_out`, `action_required`, `startup_failure` or `stale`, or while it is queued or running. A commit status holds while it is `failure`, `error` or `pending`. Only a skipped or neutral check that nothing requires is ignored, because that is what a path filter leaves behind. The relay posts no check run or status of its own (only its status comment, which is not one), so nothing is excluded by name. The status says which other checks hold a pull request, such as `1 other check on the head not green (weekly-page failure)`.
- `requireMainWorkflowGreen` names a workflow file; the latest completed run of it on the repository's default branch that was not cancelled must be `success`, whichever branch the pull request targets. Queued, in-progress and cancelled runs are not judged (a cancelled one was superseded by a newer push), so a busy branch does not hold a merge back; the status and `why` name the run that was judged. A red main run does not hold a head that contains the default branch's tip and is green on every job that failed in that run: a revert of the breaking commit, a fix and a flake that passed this time all qualify, so a pull request that heals main can always merge. Check runs of any event on the head count (push, pull_request or a dispatch). A job that failed on main but has no run on the head (it runs only on push) makes the relay dispatch the workflow (`workflow_dispatch`) on the pull request's branch once per head and wait for that run; if the workflow has no `workflow_dispatch` trigger, or the branch is in a fork, the status comment says so, names the jobs and suggests adding the trigger. Any other head waits.

- `updateBehind` (`true` or `false`, default off) brings a head that is behind its base up to date with `PUT /pulls/<n>/update-branch` (once per head, with `expected_head_sha`) when one of its check runs has failed and a rerun would reuse the old tree, in case the base has already fixed it. It needs no `strict` block, which is for a repository whose branch rules do not judge checks. A pending or green head is left alone, so a busy base does not restart every pull request's checks. A conflict is reported in the status comment, as in strict mode.
- `strict` (optional) judges the head by the jobs of named workflows and keeps the head current with its base, for a repository whose branch rules do not (GitHub reports a head that is behind as clean when nothing requires it to be up to date):

  ```json
  "strict": { "requiredWorkflows": ["ci"], "advisoryJobs": ["budget"], "advisoryWorkflows": ["resource"], "requireCurrentBase": true, "serial": true }
  ```

  - `requiredWorkflows` (non-empty) names workflows by their `name:` or file name without the extension, case-insensitively. Every job of the newest run of each on the head must have finished `success` (`skipped` or `neutral` only with `skippedPasses`). A workflow that has not started, a job still queued or running, or a run whose later jobs have not been created yet keeps the pull request waiting, and the status says which, such as `ci job typecheck to finish (in_progress)`.
  - `advisoryJobs` and `advisoryWorkflows` (optional lists) are ignored when judging: a job named in the first (exactly, or as a matrix job that starts with the name and a parenthesis), and every job of a workflow named in the second, whether it is red or still running. The status comment names an advisory job that is not green as a warning (`Advisory, not judged: ...`).
  - `requireCurrentBase` (default `true`) makes the head contain the base branch's tip. Each poll compares the base with the head; when the head is `behind` or `diverged`, the relay calls `PUT /pulls/<n>/update-branch` with `expected_head_sha` once for that head, and then waits for the new head's checks (`updated branch to main (the head was abc1234); waiting for ci on the new head`). A refusal, a merge conflict say, is reported in the status comment as `could not update the branch to main (...)` and is not retried for that head; a push (or a new head) starts over. The merge happens only on a green, current head, and still names that head so GitHub refuses it after a push. A base that moves in the seconds between the last poll and the merge is the one gap, as with any merge that is not queued.
  - `requireCurrentBase: false` is merge-on-green: a head that is green on its own checks merges at once, however far behind the base it is, any number in parallel; the relay never updates it. Main is then protected after the merge (post-merge checks and auto-revert), and the red-main exemption still applies. A textual conflict still waits, and the status comment says so. `serial` (default `true`) lets only the oldest labelled pull request be updated at a time; `false` removes that queue.
  - Everything else about the head still applies: `requiredChecks` and every other check and status (minus the advisory jobs, by name) must be green. Unknown fields in `strict` fail the config. The block takes the same field names as an `ms-desk` strict-merge policy.

A labelled open pull request merges only when it is not a draft, GitHub reports it clean (not conflicted, behind, blocked or still being computed; with `strict.requireCurrentBase` a behind head is updated instead of waiting), every check and status on its head is green (the required ones also have to exist), and the main-branch run is green. The merge names the head it checked, so GitHub refuses it if a push landed since. The relay never passes `--admin` or any bypass: it uses GitHub's ordinary merge, and GitHub's own branch rules still apply. A merge GitHub refuses is reported and tried again after five minutes, or at once for a new head. The branch is deleted after the merge when it lives in the same repository.

The relay keeps one comment per pull request, marked `<!-- desk-relay-status:<name> -->`, and edits it: what it waits on (at most every ten minutes, because each edit makes the next poll read the pull request again in full), then that it merged. A restart finds the comment again by its marker.

Only check runs are read, so a check that reports as a commit status never counts and the pull request waits.

## Visibility

`status` and `relays status` print one line per relay: when it last polled, its last fire or merge, and what it is waiting on (the next successful run, or each labelled pull request with the checks it lacks), plus `held:` when the quota paused it and `last error:` when the last poll failed. A dispatch line also names the head it last fired for and any pending head with its settle. `why` answers for one relay (`--relay <name>`, which gives a dispatch's `lastFiredHead`, `pending` and `settleSeconds`) or one pull request.

## Quota

A repository can own its merge predicate: when the base branch has `.github/merge-checks.json` with a `required` list of check names (globs allowed), the relay judges those checks in place of the relay's `requiredChecks`, a check that has not reported counts as missing. Every relay also waits for the whole head: any check run or commit status still queued, pending or running holds the merge, as does one that failed or timed out, even when the list does not name it. Cancelled, skipped and neutral checks do not hold it. The file is read from the base branch with a conditional request, and a base without it is asked again every five minutes; without the file the configured checks apply.

Each poll sends the stored `ETag` as `If-None-Match`, and what a `304` means is kept next to the tag, so a quiet relay costs no quota. A labelled pull request still waiting on checks is read again no sooner than every 30 seconds, growing to every minute as it waits, because every read of running checks is a full answer that counts; a green head still merges on the read that sees it. When GitHub has not yet worked out whether a green head merges cleanly (`mergeable` is null), the relay does not wait for that: it sends the merge, which makes GitHub work it out. A `405` then means "not yet" and the pull request is read and tried again on the next poll; a real conflict shows up on that read and is reported as a conflict. A `merge-when-green` relay with nothing labelled polls up to four times less often. `relays status` shows what each relay has spent in the current hour, as counted calls and free `304`s. A relay shares its account's window with the issue drains: at 25 calls left it pauses until the window resets, and under 10% (or 200 calls) it polls at most every 15 minutes.

On a host where MS Desk's `gh` shim keeps its spend ledger (`~/.local/state/ms-desk/gh-quota`, or `MS_DESK_QUOTA_DIR`), Desk's own direct GitHub calls (relays, drains and the delivery gate, which use an account's token and so bypass the shim) add one line to that same `calls.log` for each send, under the host's session id (`COPILOT_AGENT_SESSION_ID`, else `AGENCY_SESSION_ID`, else `desk-drain-<pid>`). The account is the token's own: the login Desk already knows, else the one GitHub reports for the token (one `GET /user` per token per process, even when calls start together; recorded too). A token GitHub names no account for (an installation token) is recorded as `unresolved`, which the shim's report does not group (Desk counts them in `unattributedSends()`), and held under the floor of the numbers its own answers carry; if the lookup got no answer, its reads are held (`spend_held`) until one does, since nothing says which floor applies. The `<kind>.rate` numbers are written from an append-only observation log (`<kind>.rate.obs`) and re-checked against it, with no lock to go stale, so within a window they only ever tighten: concurrent processes and out-of-order answers cannot raise them. A send that gets no answer is recorded as `unknown` (it may or may not have been charged; the shim's report counts it as sent). A read is held under the shim's floor (`MS_DESK_GH_FLOOR`, default 500; merge-path reads run down to `MS_DESK_GH_MERGE_FLOOR`) using the shim's `<kind>.rate` numbers, refreshed from the free `rate_limit` read and from the quota headers of every answer: a poll halts as rate limited and the delivery gate answers `not_verified`; writes and GraphQL (its own pool, not counted as REST spend) always run. If the ledger cannot be written Desk still sends, and raises the process warning `DESK_SPEND_UNRECORDED` so the gap is visible. Without the ledger folder, or with `MS_DESK_QUOTA=off`, nothing changes. This accounts for Desk's own direct calls only: a `gh` that does not resolve to the shim, or a token used elsewhere on the host, still spends quota the ledger does not see.

## Running it from Ouroboros

Give the always-on runtime a [wake runner](https://github.com/ourostack/ouroboros/blob/main/docs/app-sessions-sense.md#wake-runners) that runs the poll every 30 seconds. It prints no wakes, so it needs no `delivery`:

```json
{ "name": "relays", "command": ["<node>", "<state>/ouroboros-skills/desk/drains/run.mjs", "relays", "poll"], "everySeconds": 30 }
```

`ouro status` then lists each relay under the runner.
