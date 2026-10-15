---
schema_version: 1
title: T
status: drafting
created: '2026-10-15T04:25:56Z'
updated: '2026-10-15T04:25:58Z'
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
| done | — | widgets | delivered | task:t/card-done |
| stuck | — | widgets | in progress | task:t/card-stuck |
| going | — | widgets | in progress | task:t/card-going |
| gone | — | widgets | delivered | task:t/card-gone |
| ghost | — | widgets | pending | task:t/card-none |

## Progress log

- 2026-10-01: began
- 2026-10-14: checked
- 2026-10-14: checked
