---
schema_version: 1
title: "retry-budget"
status: in_progress
created: "2026-11-09T10:00:00Z"
updated: "2026-11-10T16:00:00Z"
track: service-health
repos: []
---

# Retry budget

Cap client retries so an outage does not multiply load on the services behind it.

## Proposal

Alex, 2026-11-10, from the design review notes below: allow at most three retries per request, with jittered backoff, and report the retries as one metric.

## Design review notes

- 2026-11-10: the review agreed the cap is worth trying; no owner for alert rules was named.
