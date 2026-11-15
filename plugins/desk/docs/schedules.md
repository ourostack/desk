# Schedules

A schedule sends one prompt to a session every N minutes without the app's session automations. The app queues every run it misses while a session is busy and replays them back to back, and each replay is a full model turn. A schedule is due once however many intervals went by. Like [issue drains](issue-drains.md), Desk owns the part that decides and spends no model turn: `schedule poll` prints the wakes that are due, and whatever runs it (an always-on agent runtime) delivers them and reports back. The code is [schedules.js](../mcp/src/runtime/schedules.js) and the `schedule` command of [drains.js](../mcp/scripts/drains.js).

**To move a coordinator's watchdog off its app automation:** add `{ "name": "<session name> watchdog", "session": "<session id>", "prompt": "<the automation's prompt text>", "everyMinutes": <N> }` to `schedules` in `schedules.json` (below), run `node <state>/ouroboros-skills/desk/drains/run.mjs schedule status` to see its next run, and clear the app automation once the first prompt has landed.

```sh
node <state>/ouroboros-skills/desk/drains/run.mjs schedule poll     # print the prompts that are due
node <state>/ouroboros-skills/desk/drains/run.mjs schedule ack ...  # report a prompt's delivery (each wake carries the exact command)
node <state>/ouroboros-skills/desk/drains/run.mjs schedule status   # one line per schedule: last sent, next run
```

`run.mjs` is the [runner that needs no checkout](issue-drains.md#a-runner-that-needs-no-checkout); `<state>` is `$XDG_STATE_HOME` (else `~/.local/state`).

## Config

`schedules.json` sits beside the drains' `config.json`, on the machine that runs the poll, and is never committed:

```json
{ "schedules": [
  { "name": "epoch 3 watchdog", "session": "<session id>", "prompt": "Watchdog: check the lanes and the open pull requests.", "everyMinutes": 60 }
] }
```

`session`, `prompt` and `everyMinutes` (a whole number, 1 or more) are required. `name` defaults to the session id and must be unique, so give each schedule on one session its own. An invalid entry fails the command with the reason; it is never dropped, because a dropped schedule would stop a watchdog. Editing a prompt takes effect at the next poll; changing `everyMinutes` counts the next run from that poll. `--config` and `--state` point the command elsewhere.

## How a schedule runs

- A schedule seen for the first time runs one interval later, not at once.
- A due schedule is offered once per poll with the same wake id until a delivery lands. Three missed intervals send one prompt, because the next run is counted from the delivery that landed, never from the missed one.
- If the runner cannot deliver (the session still has the last prompt queued, or the app refused), it reports the failure with `--error`, the schedule stays due and the same wake comes back with the next poll: one prompt waits, never a pile.
- Each wake names its prompt as `replaces`, so a runner that supports it takes an older copy of the prompt still queued in the session back before it sends the new one.

## Running it from Ouroboros

Give the always-on runtime a [wake runner](https://github.com/ourostack/ouroboros/blob/main/docs/app-sessions-sense.md#wake-runners) in the app-sessions sense's `wakeRunners`, with `"delivery": "immediate"`: a prompt lands at the next turn boundary without interrupting a turn in flight, and the runner still sends at most one prompt per session. Don't use `"enqueue"`, because it waits for the session's whole run to end, and a coordinator with a long-running background subagent counts as busy for that whole run, so a watchdog can arrive hours late.

```json
{ "name": "schedules", "command": ["<node>", "<state>/ouroboros-skills/desk/drains/run.mjs", "schedule", "poll"], "everySeconds": 60, "delivery": "immediate" }
```

`ouro status` then lists each schedule under the runner: its cadence, when it last landed and when it runs next.
