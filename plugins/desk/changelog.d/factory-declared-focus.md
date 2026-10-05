Desk now lets a session say which task it is working on, so the factory credits each job with the work really done on it. The new `task_focus` tool takes a track and slug (or `clear: true` for a side conversation that belongs to no task) and answers with the card's status and its last five progress entries. It writes nothing, needs no write authority, and keeps the focus in memory only. `task_create` takes `focus: true` to create a task and declare it in one call. If the server is still starting, `task_focus` waits up to 2 seconds for it, then answers or refuses.

The foundation and the session-start, start-task, session-resumption, task-lifecycle and Superpowers skills now tell the main agent to declare the task once, at the moment it picks or switches to one, and to clear the focus when it leaves task work for a side conversation. Subagents never declare: the brief a Superpowers mapping produces ends its Desk-Task line with `Never call task_focus; your work is credited through the Desk-Task line.` While a session has no focus, every task tool result carries a short hint for the main agent. Updating or archiving a card other than the focused one carries a hint too. A hint never blocks a call.

How work is credited changes in these ways:
- A declared task is credited first. Inference fills only the time nothing declares.
- Touching a card no longer makes a session part of that task. Creating, updating or committing another card binds nothing, and neither does another session's commit that happens to land during this session's own commit.
- Work in a code repository counts only for the one card that lists that repository.
- A very short inferred stretch joins its longer neighbour, and a declared stretch is never merged or dropped.
- Background subagents stay with the job they were spawned for.
- A session counts as shared between jobs only when their time really overlaps, and each job's time comes from active intervals, not from the wall-clock length of a segment.
- A task that was moved or renamed keeps its job.
- Each session's local receipt now records how it was bound and the measures behind it, and a value that was not recorded is absent, never zero.

Sessions whose capture marker was pruned after 30 days are rebuilt from their transcripts in desks that declare their store, when that is safe. The rest stay frozen, and the sweep records how many it rebuilt, how many it left frozen and why, and how many are pending.

`factory.js reconcile` now lists only tasks with real work in the window and places each task by the time its sessions held it. Cards touched only by housekeeping are counted, not listed. `not_bound` replaces `no_marker`, and `mechanical_only` is gone. Two new reasons say what reconcile used to hide: `status_unobserved` when a card's status changed while its session was focused elsewhere, and `focus_disagrees` when a declared stretch shows none of its own work. Each task now carries its story (its sessions in order, with active time and how each was bound), and the counts show how many commits were mentioned from another task's session and how many sessions were bound by declaration or by inference.

The one-time tidy and its revert end their commit message with the trailer `Desk-Tidy: true`, so they count as housekeeping, not as work on the tasks they moved.

A new `factory-work` skill carries the Lean reading and the terrarium checks (a sealed, self-sustaining factory that needs no human hand and never shows zero for "no data") for anyone designing, changing or reviewing the factory, and the Superpowers skill points reviewers at it.
