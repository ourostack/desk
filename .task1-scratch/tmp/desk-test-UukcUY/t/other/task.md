---
schema_version: 1
title: T
status: drafting
created: '2026-10-15T04:26:24Z'
updated: '2026-10-15T04:26:25Z'
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
| b | — | widgets | delivered | https://github.com/o/widgets/pull/1 |
| c | b | widgets | pending | — |
| t3 | — | widgets | delivered | https://github.com/o/widgets/pull/2 |

## Progress log

- 2026-10-01: began
