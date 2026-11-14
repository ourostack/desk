### Merge relays can count a skipped check as passing

A `merge-when-green` relay takes an optional `skippedPasses: true`. With it, a required check that completed `skipped` or `neutral` counts as green, so a repository whose own path filters skip a check on changes outside that check's area can still merge. `failure`, `cancelled`, `timed_out`, `action_required` and any other conclusion, a check still running, and a missing check keep the pull request waiting, as before. The option defaults to off, so existing relays behave as they did. See [relays](docs/relays.md).
