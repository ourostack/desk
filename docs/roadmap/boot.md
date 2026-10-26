# Boot roadmap

The session boot (`plugins/desk/mcp/scripts/session-boot.js`) now checks only what the first reply needs. On a desk with 80 open tasks it went from 48 to 50 s to 4 to 8 s, measured on a heavily loaded Mac. The checks below were removed from a boot that names no task, or cut short. Bring one back only when a real session needs it, and record which session.

| Removed or cut check | Problem it would solve |
| --- | --- |
| Push routes for every open task's repos | Knowing, before the operator picks a task, which account can push each repo. Today the boot checks routes only for the task named with `--task`, and the no-task instruction tells the agent to run the boot again with `--task` once the operator picks one. On a desk with many repos the all-task check was one GitHub call per account per repo and alone used the whole 45 s budget. |
| Repo state (branch, clean or dirty, fetch) for every open task's repos | Seeing every clone's state in the first status block. Today only the named task's repos are fetched and read. A cheap local-only read (no fetch) for all repos could come back if agents miss it. |
| One `gh pr list` call per repo | Nothing: one GitHub search (`author:@me`, the 100 most recently updated) replaces it. The boot says when there were more than 100. |
| Sign-off scan run twice | Nothing: the factory status no longer scans deliveries that the sign-off step scans anyway. |
| A 45 s wall-clock budget | Waiting longer on a slow network. The budget is now 15 s, with 12 s for the desk sync. |
| Session-start hook lines past 3.5 s | Showing the pre-check, migration and commit-trailer lines on a machine slow enough that the hook would hit Copilot's 5 s limit. Past 3.5 s the hook prints the Desk foundation without them; the boot script runs the same checks again. |
| An unbounded wait for the factory status lock | Recording every boot-check skip. The hook now waits at most 250 ms for the lock, and the sign-off count at most 1 s. |
| `unchecked` migration lines in the hooks | Saying that a migration's check ran out of time. The boot script runs every migration check again with its own budget and reports what it finds. |
