# Reliability

## Outcome and scope

Agree how services retry and alert on transient failures across the platform teams.

## Current focus

2026-11-10: gathering proposals; no decision yet. Next action: each contributor adds an attributed view.

## Contributors and work

| Person | Contribution and work link | Commitment and source |
|---|---|---|
| Alex | [Retry budget](../../../desks/alex/service-health/retry-budget/task.md) | Proposed; the task's design review notes, 2026-11-10 |

## Open questions

- Should alerting count retried failures? Who can answer: the platform on-call lead (not recorded).

## Proposals and perspectives

- Sam, 2026-11-13, from a review call note (no link): retried failures should still count toward alerting, because a three-retry cap can hide a real outage. Sam's view, not yet tested.

## Decisions

No decision recorded.

## Evidence

- [Retry budget task](../../../desks/alex/service-health/retry-budget/task.md): the source of Alex's retry proposal.
