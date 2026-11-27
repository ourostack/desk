# Keep the work moving

Desk enforces [keep the work moving, and count only what ships](stalled-nudges.md) from outside the agent: an agent can't quietly stop, and can't look busy instead of working. Each part below lists how an agent could game it and the test that shows it can't.

## 1. The turn-end gate

Code: [turn-end-gate.cjs](../hooks/lib/turn-end-gate.cjs), called by the Stop hook right after the delivery reply check. It reads the session's own transcript. A session whose focused card is open (not `done`, `cancelled`, archived or still `drafting`, which the intake check owns) must end its turn with one `Ending:` line:

```text
Ending: done; shipped: <PR or run URL or commit sha this session produced>
Ending: waiting; on: <named event>; wake: <id of the schedule or watch you registered>; expires: <ISO time within 7 days>; blocks: <what cannot move>
Ending: blocked; on: <named person>; resume: <exact step that restarts the work>
Ending: no ready work; checked: <where you looked for ready work>
```

Headless lanes (no hooks, no transcript) call the same module as a command: `node plugins/desk/hooks/lib/turn-end-gate.cjs check --session <id> --evidence-file <output.txt> --pr-head <branch> --repo <owner/repo>`. It exits 0 for a verified ending, 10 with the resume text when the work did not ship, 2 on a bad call, and records the ending in the ledger. Because the output file is the agent's own words, `done` counts only when GitHub shows a pull request for the branch, and `waiting` is refused: a headless lane has no registered wake to check. The caller owns the resume cap.

Any other ending is corrected once, with this text. The correction is spent once per turn (`stop_hook_active` or an earlier correction means the turn ends and the ledger records `unverified`), so it can't loop. "No ready work" is a valid ending, so no agent has to invent work. Every ending is appended to `<state>/ouroboros-skills/desk/turn-ends/<session>.jsonl`, which the runner outside agent sessions reads (waits' expiry, "no ready work" audits).

| How an agent could game it | What stops it (test in [turn_end_gate.test.js](../../../tests/desk/mcp/__tests__/factory/turn_end_gate.test.js)) |
|---|---|
| Cite a wake that doesn't exist | `wake:` must be an id a schedule, automation or watch tool of this session returned or was given; an invented id, or one only echoed by `bash`, is corrected |
| Wait with a far or past expiry | `expires:` must be in the future and within 7 days; longer is a person's decision (`blocked`) |
| Say `done` with a made-up link | `shipped:` must appear in a tool result of this session; typed links and hashes are corrected |
| Block on "CI", "me" or "the user" | `blocked` needs a named person and a resume step |
| Skip the gate by never declaring a card | Not caught here: a session with no focused card has no job. The runner outside agent sessions (part 4) checks sessions with open pull requests regardless |
| Say "no ready work" to stop | Allowed and recorded with where it looked; the runner compares it against the roadmap's ready list |
| `done` that did not really ship | The gate only checks the claim is this session's own; shipped evidence is verified against GitHub by part 2 |

## 2. Progress from outcomes

Code: [outcomes.js](../mcp/src/runtime/outcomes.js), tests in [outcomes.test.js](../../../tests/desk/mcp/__tests__/runtime/outcomes.test.js). `progressOf` counts, for a card, only a pull request that GitHub says is merged (each once) and an acceptance check that passed on a named version. It reads the turn-end ledger, so a `done` ending is checked against GitHub, not taken at its word.

| How an agent could game it | What stops it |
|---|---|
| Send messages, commit, or stay "busy" | None of them is an input; the "waiting", "blocked" and "no ready work" endings add nothing either |
| Claim an unmerged or unknown pull request, or a bare sha | Listed as `unverified` with why, count stays 0 |
| Claim the same pull request again, or another card's | Counted once; other cards' endings are ignored |
| Report an acceptance pass with no version | Needs a check name and a version, and `passed: true` |

## 3. Ownership with expiring leases

Code: [leases.js](../mcp/src/runtime/leases.js), tests in [leases.test.js](../../../tests/desk/mcp/__tests__/runtime/leases.test.js). `drains leases take --card <card> --owner <session> --repo <owner/name> --branch <branch>` records a claim in `claims.json`; `drains leases status` lists each as `held`, `lapsed` (nothing pushed for two hours since the claim or the last push) or `ownerless` (its session's history shows it ended or is gone). The last push is GitHub's own event time for the branch, which an agent cannot backdate the way it can a commit date.

| How an agent could game it | What stops it |
|---|---|
| Send messages or rerun to keep a claim alive | Neither is an input; only a push GitHub recorded renews |
| Claim the card again to restart the clock | A held card is not retaken and keeps its original start, for its owner and anyone else |
| Write a later `claimedAt`, a future push time or a `renewedAt` into the file | Times in the future count for nothing, and unknown fields are ignored |
| Keep a dead session's claim as a placeholder | An ended or missing owner history makes it `ownerless`, so it can be taken |

## 4. The keeper outside agent sessions

Code: [keepers.js](../mcp/src/runtime/keepers.js), tests in [keepers.test.js](../../../tests/desk/mcp/__tests__/runtime/keepers.test.js). `run.mjs keepers check` (the same launcher as `stalled`) spends no model turn. Each run shows this host's heartbeat under `<state>/ouroboros-skills/desk/heartbeats/<host>.json`, reads the turn-end ledger and the leases, reads each peer's heartbeat over `ssh` (no prompt), and lists what needs a job:

- `wait_expired`: a wait's expiry passed and nothing ended it afterwards.
- `wait_renewed`: three waits in a row on the same thing, even unexpired.
- `unverified_end`: the gate could not verify the last ending.
- `lease_lapsed`, `no_owner`: see part 3.
- `peer_silent`: a peer's heartbeat is missing, unreadable, from the future or older than 30 minutes.

`keepers.json` in the drains state folder names this host and its peers: `{ "host": "laptop", "repo": "<a clone of a repo both hosts can push to>", "peers": [{ "host": "mini" }] }`. Run the command every 10 minutes with whatever the host has (launchd `StartInterval`, Task Scheduler, cron) on two hosts that are always on, each naming the other. The laptop sleeps, so it is not a keeper. A run is idempotent: it reports the same findings until someone acts, and delivering them to the lead or the owner is the wake runner's job, as for `stalled poll`.

| How an agent could game it | What stops it |
|---|---|
| Look busy | Busy is not an input; findings come from the ledger and leases alone (test: a running session hides nothing) |
| Renew a wait again and again | Three in a row on the same thing is a finding even while unexpired |
| Replace an expired wait with a later ending | Only a later `done`, `blocked` or `no ready work` clears it, each with its own checks from parts 1 and 2 |
| Stop the keeper or fake a peer's heartbeat | Each keeper publishes its heartbeat as a blob on `refs/heartbeats/<host>` of the shared remote and reads the other's from there, so no host needs inbound ssh and a Dev Box can join as a third (a peer with an `ssh` alias is still read over ssh); a missing, old or future heartbeat is `peer_silent` |
| Delete its own ledger file | Not caught by one host; the ledger is outside the agent's tools, and a missing ledger leaves leases (GitHub pushes) and the peer's view to catch the card |

The keeper only lists findings and wakes no session. A runner that delivers findings by waking sessions must wake them one at a time and bound the sessions a machine runs at once, as the `work-orchestration` skill requires.

## 5. Waits on systems we own

A wait whose `on` names CI, checks, a workflow, the merge queue, auto-merge, a release, publishing, a pipeline, a runner or the keeper, and whose expiry passed or that was renewed three times in a row, shows as `fix_system` instead of `wait_expired` or `wait_renewed`. Its job is to fix that system, then clear the wait with a `done` ending that names the fix. Waits on people or outside systems keep their own kinds.

| How an agent could game it | What stops it |
|---|---|
| Name the wait vaguely ("it") so it is not seen as an owned system | It is still a `wait_expired` finding at expiry, so only the label changes, not whether someone looks (test) |
| Renew a wait on the merge queue forever | Three in a row is a `fix_system` finding even while unexpired (test) |
| Clear the finding by ending with `no ready work` | A `fix_system` job is ready work; the keeper keeps listing it until a `done` with shipped evidence replaces the wait |
