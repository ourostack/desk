---
schema_version: 1
title: T
status: drafting
created: '2026-10-15T04:26:04Z'
updated: '2026-10-15T04:26:04Z'
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
| a | — | widgets | in progress | https://github.com/o/widgets/pull/1 |
| b | — | widgets | pending | — |
| c | — | widgets | blocked | waits on infra |
| d | — | widgets | pending | https://github.com/o/widgets/pull/4 |
| e | — | widgets | dropped | not needed |

## Progress log

- 2026-10-01: began
