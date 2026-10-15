---
schema_version: 1
title: T
status: drafting
created: '2026-10-15T04:26:06Z'
updated: '2026-10-15T04:26:09Z'
track: t
repos:
  - name: widgets
  - name: gadgets
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
| a | — | widgets | dropped | still not needed |
| b | a | widgets | blocked | depends on a, which was dropped |
| c | a | widgets | blocked | depends on a, which was dropped |
| d | a | widgets | blocked | other reason |
| e | a | widgets | pending | — |

## Progress log

- 2026-10-01: began
