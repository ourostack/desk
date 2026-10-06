Claude Code keeps only a 2 KB preview of a SessionStart context that passes 10,000 characters, and alpha.196's sign-off section pushed Desk's context to 10,065 in the acceptance fixture, so the boot imperative at its end was cut off and Haiku agents skipped the boot (13 of 17 runs over the limit, 1 of 99 under it). The Claude startup hook now puts the `Desk startup:` line and any pre-check line first, ahead of the foundation and the RFC line, so the imperative is always inside the preview. The foundation's sign-off text is unchanged.

The boot's push-route line now says Desk already resolved the route, so the agent says it instead of re-checking it with gh, and never prints, counts or tests the token. A Copilot agent that re-checked a route, got a 404 and then probed `gh auth token` is the case it answers.

The boot-acceptance harness no longer reads a request to the operator, such as "confirm it's pushed or tell me where it is first", as a claim that the agent pushed.
