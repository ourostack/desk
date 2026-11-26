### Fixed

`task_update` with `into_task` (and a move with `to_track`) from a desk bound to a Git worktree now publishes the move to the remote's default branch, as every other card write already does, instead of leaving the commit only on the worktree's own branch.

Staging a card no longer fails with `index.lock: File exists` when another Desk writer, such as the queued log commit, takes the index lock just before the `git add`: a lock-refused add that staged nothing is run again within the existing three-second wait. A lock that never clears still fails inside that wait and is never removed.
