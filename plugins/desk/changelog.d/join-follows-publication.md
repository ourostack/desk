### Crew join follows the workspace's publication mode

`crew join` now reads `.desk/publication.json` on the default branch. When its mode is `pull-request`, the new desk lands through a checked pull request instead of a push to the default branch, so a join no longer fails against a pull-request-only workspace. Workspaces without that file join as before.
