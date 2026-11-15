# Stalled-card nudges

A coordinator can end its turn with its task card unfinished, nothing running and no final report. It looks done and is not. Desk nudges that session once, with this text: "Your focused card isn't done and nothing is running: walk its definition of done; continue, or write the final report (Asked / Delivered / Accept or send back?)." The wake adds the card, how long the session has been idle, and how to stop the nudges.

Like [issue drains](issue-drains.md) and [schedules](schedules.md), Desk decides and spends no model turn: `stalled poll` prints the nudges that are due, and whatever runs it (an always-on agent runtime) delivers them and reports back. The code is [stalled.js](../mcp/src/runtime/stalled.js) and the `stalled` command of [drains.js](../mcp/scripts/drains.js).

```sh
node <state>/ouroboros-skills/desk/drains/run.mjs stalled status   # a dry run: who would be nudged now, and why the others are left alone; records nothing
node <state>/ouroboros-skills/desk/drains/run.mjs stalled poll     # print the nudges that are due
node <state>/ouroboros-skills/desk/drains/run.mjs stalled ack ...  # report a nudge's delivery (each wake carries the exact command)
```

`run.mjs` is the [runner that needs no checkout](issue-drains.md#a-runner-that-needs-no-checkout); `<state>` is `$XDG_STATE_HOME` (else `~/.local/state`).

## Who is nudged

A session is nudged when all of these hold:

- Its last turn ended 15 or more minutes ago, and not more than 24 hours ago. Older sessions are abandoned, and a nudge would wake them for nothing.
- It declared a focused card with `task_focus` (or `task_create` with `focus: true`) and the card is not `done`, `cancelled` or archived. A session that never declared a card is not nudged.
- Nothing runs: no background subagent, no background shell job, no session it created and still coordinates (one that ended its turn less than 15 minutes ago counts as running, because its report is about to arrive), and the app does not say the session is running.
- It waits on nobody: no open question, plan approval or permission prompt; the card is not `collaborating` (waiting for a person's approval); the card's blocker does not name a person's decision and a date (`Waiting on Ari's approval, expected 2026-11-20`; a date already past does not count); its last message is not already a final report (`Asked:` and `Delivered:` lines).
- It is not a drain (a session in `config.json`, or one titled `Drain: …`), which has its own wake.
- This idle stretch was not nudged yet. The nudge is offered with the same id on every poll until the runner reports a delivery, so a held nudge never piles up. When the session works again and goes idle again, that is a new stretch.

**Opt out per card** with `nudge: false` in its frontmatter. The default is on.

## What it reads

Everything comes from the Copilot app's own files, read-only: each session's history (`<session-state>/<id>/events.jsonl`, read backwards; a focus read once is remembered, so only new history is read again) and the app's database (`data.db`, through Node's `node:sqlite`) for its running flag, titles and the sessions a coordinator created. Where the database cannot be read, running sessions a coordinator created are not seen, and the status line says so.

## Config

`stalled.json` beside the drains' `config.json` is optional:

```json
{ "idleMinutes": 15, "maxIdleHours": 24, "desks": ["~/my-desk"] }
```

`desks` adds desk folders to look for cards in. A card is found in the session's own working folder and Git root, the desk folders in the home folder, and the member desks of a Crew workspace.

## Running it from Ouroboros

Add a [wake runner](https://github.com/ourostack/ouroboros/blob/main/docs/app-sessions-sense.md#wake-runners) to the app-sessions sense's `wakeRunners`, with `"delivery": "immediate"` so the nudge lands at the next turn boundary:

```json
{ "name": "stalled cards", "command": ["<node>", "<state>/ouroboros-skills/desk/drains/run.mjs", "stalled", "poll"], "everySeconds": 60, "delivery": "immediate" }
```

`ouro status` then shows the runner and the command's own lines, one for each session it would nudge or leaves alone with a focused card.

## Where Ouroboros isn't installed

Nothing watches a session from outside, so Desk cannot nudge an idle one. The fallback runs inside the session: the first `desk_status` call made while its focused card is unfinished and has not been updated for 15 minutes leads with `nudge`, once per session, in the same words minus "nothing is running", which a session cannot know about itself. The session's focus is the one it declared in this process, or else the last one in its own history, so a session resumed after a restart is covered. A session that never calls `desk_status` is not reached, and the card must carry an `updated` stamp; the same rest rules and `nudge: false` apply.
