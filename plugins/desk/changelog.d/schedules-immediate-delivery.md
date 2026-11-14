### The schedules wake runner recommends `"delivery": "immediate"`

The [schedules](docs/schedules.md) guide now tells you to give the wake runner `"delivery": "immediate"` instead of `"enqueue"`. `enqueue` holds a prompt until the session's whole run ends, and a coordinator with a long-running background subagent counts as busy for that whole run, so a watchdog could arrive hours late, after the lane it was meant to catch had finished. `immediate` delivers at the next turn boundary without interrupting a turn in flight, and the runner still sends at most one prompt per session.
