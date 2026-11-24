### A delegation logged with task_update names the child's session

`task_update` takes a new `child_session` field beside `log`. It writes a `Child session: <id>` line at the top of the log entry, so a drain or coordinator can read who owns delegated work from the task's log instead of searching for the session. `child_session` without `log`, or an id that is not a session id, is refused with nothing changed.
