# Reliability

## Outcome and scope

Agree how services retry and alert on transient failures across the platform teams.

## Current focus

2026-11-10 snapshot: Alex's retry-budget task was in progress. The snapshot was copied from the task, not checked live.

## Contributors and work

| Person | Contribution and work link | Commitment and source |
|---|---|---|
| Alex | [Retry budget](../../../desks/alex/service-health/retry-budget/task.md) | Proposed; the task's design review notes |
| Sam | [Alert noise plan](../../../desks/sam/service-health/alert-noise/plan.md | Proposed; Sam's review comment |
| Jo | [Team handbook](../../../../team-handbook/README.md) | Unknown; no source recorded |
| Priya | [Load test task](../../../desks/priya/load/task.md) | Unknown; no source recorded |

## Open questions

- Should alerting count retried failures? Who can answer: the platform on-call lead (not recorded).

## Proposals and perspectives

- Alex, 2026-11-10, from the retry budget task: three retries with jittered backoff.
- Sam, 2026-11-11, from the alert noise task: retried failures should still count toward alerting.

## Decisions

No decision recorded.

## Evidence

- [Retry budget task](../../../desks/alex/service-health/retry-budget/task.md): the source of Alex's proposal.
- [Load test summary](evidence-link.md): a load test summary kept outside this workspace.
