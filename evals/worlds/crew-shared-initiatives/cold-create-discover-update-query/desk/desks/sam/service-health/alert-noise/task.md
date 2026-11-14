---
schema_version: 1
title: "alert-noise"
status: in_progress
created: "2026-11-09T12:00:00Z"
updated: "2026-11-11T09:30:00Z"
track: service-health
repos: []
---

# Alert noise

Reduce pages that do not need a human.

## Disagreement

Sam, 2026-11-11, from the review thread on this task: retried failures should still count toward alerting, because a three-retry cap can hide a real outage until users notice. Sam has not tested this against last quarter's incidents.
