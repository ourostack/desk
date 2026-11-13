### Drain status comments carry a marker so the issue watcher does not wake the drain for them

The `draining-issues` skill now tells a drain to put `<!-- ouro-drain-status -->` in its own acknowledgement and status comments. Ouroboros' issue-drain watcher uses the marker to skip those comments' creation and edits, while a comment without it, from any account, still wakes the drain.
