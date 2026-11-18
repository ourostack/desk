### Lane processes end with their lane

`using-superpowers-with-desk` now says that every dev server, mock daemon, watcher and `sleep` polling loop a lane starts belongs to that lane: it runs in the lane's own process group, never detached, a polling loop has a bound, and the lane stops it by exact pid before it reports back. A lane that reports with one still running is `cleanup_pending`. Orphans from finished lanes had held a shared machine under memory pressure.
