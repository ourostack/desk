---
schema_version: 1
title: "retry-budget"
status: in_progress
created: "2026-11-09T10:00:00Z"
updated: "2026-11-12T11:00:00Z"
track: service-health
repos: []
---

# Retry budget

Cap client retries so an outage does not multiply load on the services behind it.

## Proposal

Drafted in [proposal.md](proposal.md) on 2026-11-12. Not yet on the reliability card.

## Design review notes

- 2026-11-10: the review agreed the cap is worth trying; no owner for alert rules was named.
