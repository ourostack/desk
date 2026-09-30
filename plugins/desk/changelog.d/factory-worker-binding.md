The factory now credits each subagent's work to its own task. A subagent is bound to the task named in the `Desk-Task` line of its brief, or inherits the task of its parent when the parent is on exactly one task. A subagent with no `Desk-Task` line whose parent works on several tasks stays unattributed instead of being spread across them.

A desk commit that touches task cards in more than 3 tasks no longer credits any of them, because such a commit is housekeeping and not work on those tasks.

Each job now gets only its own workers' active time, tool calls and pull requests, so a session that served several jobs no longer gives each of them the whole session. A subagent's model now comes from its own replies, and Copilot events are attributed per worker.

Sessions Desk already processed are re-derived once after you upgrade, so their numbers follow the new rules. They are not re-derived again on later sweeps.

The briefs that the Superpowers mapper produces now carry a `Desk-Task: <track>/<slug>` line, and the [`using-superpowers-with-desk`](skills/using-superpowers-with-desk/SKILL.md) skill tells the agent to copy it verbatim into every implementer and reviewer brief.

The first start after you upgrade re-derives every past session, so delivery of the changed sessions may finish on the following start.

Time from a worker that several jobs share is marked partial (`worker_shared`) rather than split between them.
