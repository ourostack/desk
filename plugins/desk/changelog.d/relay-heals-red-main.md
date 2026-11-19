### The merge relay lets a PR that heals a red main through

A relay with `requireMainWorkflowGreen` no longer holds every pull request while the default branch's latest run is red. A pull request into the default branch merges when its head contains the branch's tip and every job that failed on the red run is green on the head, so a revert, a fix, or a head that passes the red jobs is never stuck behind the red it answers. Anything else still waits, and the merge comment names the jobs the head healed. See [relays](docs/relays.md).
