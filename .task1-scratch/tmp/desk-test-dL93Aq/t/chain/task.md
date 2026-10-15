---
schema_version: 1
title: T
status: drafting
created: '2026-10-15T04:25:55Z'
updated: '2026-10-15T04:25:59Z'
track: t
repos:
  - name: widgets
flow:
  since: created
  rev: 0
  reached: drafting
  first_validating_at: null
  first_delivered_at: null
  delivered_at: null
  deliveries: 0
---

## Outcome

Ship it.

## Steps

| Step | Depends on | Repo | State | Evidence |
|---|---|---|---|---|
| api | — | widgets | delivered | https://github.com/o/widgets/pull/7 |
| ui | api | widgets | pending | — |

## Resources

| Exact resource / generation identity | Owning task / attempt / generation | Active writers / consumers | Intended disposition | Evidence pointer | Terminal disposition details |
|---|---|---|---|---|---|
| worktree:/Users/microsoft/code/desk-worktrees/v1b2-multiuser/.task1-scratch/tmp/desk-resources-lAxN6t/due | step api | — | — | — | removed-and-absent: git worktree list no longer shows it |
| branch:o/widgets#feat/api | step api | — | — | — |  |
| branch:o/widgets#feat/ui | step ui | — | — | — |  |

## Progress log

- 2026-10-01: began
- 2026-10-14: again
