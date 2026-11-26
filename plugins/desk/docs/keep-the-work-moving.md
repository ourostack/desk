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
