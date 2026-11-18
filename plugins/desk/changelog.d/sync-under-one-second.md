### Saves on a big desk no longer wait for Git LFS

A save from `task_update`, `track_update` and the other card tools now commits on a private index and starts the post-commit hook in the background. Git LFS's post-commit hook walks every file in the checkout, which took seconds on a desk of about 12,000 files and sometimes ended in "commit status unknown, reason timeout". The save now returns as soon as the commit is on the branch. Hooks still run; the post-commit one just doesn't hold the save up.

The push no longer runs Git LFS's pre-push upload scan when none of the files being pushed is an LFS file. Any doubt keeps the scan.

The background sync worker now retries a failed fetch, a rejected push, an unreachable remote or a deadline by itself, waiting 2 s, 5 s, 15 s and then 60 s between tries, so a save is no longer left until the next write retries it. A conflict or a refused login is still reported at once, because it needs a person.

`sync-push.js` now also exits with a message that says what happened and what to do next when the worker ends in a state it does not recognize, instead of exiting with a bare failure code.

A new test, `sync_budget.test.js`, holds a save on a 12,000-file repository with a slow post-commit hook to under one second, checks that a stuck sync does not block the next save, and checks the retry and the failure message.
