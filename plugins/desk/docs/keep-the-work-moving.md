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
