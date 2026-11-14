---
schema_version: 1
title: "retry-budget"
status: done
created: "2026-11-09T10:00:00Z"
updated: "2026-11-13T08:00:00Z"
track: service-health
repos: []
---

# Retry budget

Cap client retries so an outage does not multiply load on the services behind it.

## Outcome

2026-11-13: the three-retry cap with jittered backoff shipped in the client library. Recorded by Alex on this task.
