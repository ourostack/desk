---
name: track-card-format
description: Schema + body template for `track.md` — the per-track dashboard at the root of each track directory — including the one-line `scope:` that routes new work to a track. Use when creating a new track, reading an existing track, deciding whether work belongs in a track, or updating a track card's frontmatter, scope line or tasks table.
---

# Track card format

`track.md` is the label on the drawer. it sits at the root of a track directory and **is a working dashboard, not just metadata** — the first thing a resuming operator reads. make it useful.

## Frontmatter schema

```yaml
---
schema_version: 1
title: "<track title>"
scope: "<what belongs>; not <what doesn't>"
status: active | closed

# Link to predecessor track (if this track succeeds a closed one)
predecessor:
  slug: <predecessor-track-slug>
  title: "..."
  status: closed

# Provenance (if track was adopted from an existing planning bundle)
adopted_from:
  source_path: /path/to/source
  source_sha: <commit if applicable>
  adopted_at: 2026-01-15T14:30:00Z
  adopted_by: <operator alias>

# Pointer to the canonical cross-repo plan
planning: ./_planning/planning.md
---
```

consumer agents extending this with their own work-tracker schema (e.g. enterprise overlays with Feature / Epic hierarchies) add their own frontmatter block — typically the overlay ships a `<overlay>:card-fields` skill defining the tracker-specific shape (e.g. `tracker:` and `tracker_defaults:` keys).

## Scope line

`scope:` is one line, at most 240 characters, in the form `<what belongs>; not <what doesn't>`, for example `scope: "Billing service invoicing and payment retries; not the storefront checkout UI"`. The scope line is how new work is routed: `start-task` reads every active track's scope line and files work in a track only when the scope clearly fits, and otherwise creates a new track. Write it so a reader who has never seen the track can decide in seconds whether a piece of work belongs there; the `not` half names the neighbour work most likely to be misfiled.

`track_create` requires it and rejects a missing, multi-line or over-long scope. `track_update` sets or changes it with the same check (`frontmatter.scope`). Tracks created before the scope line existed stay readable; `desk_doctor` reports each one as `track_missing_scope`, and the agent adds the line when it tidies (`interaction-style` section 2).

A track name follows the same rules as a task name (see `start-task`), and in addition a track is never named after a person and never a catch-all such as `misc`, `general` or `inbox`: `track_create` and `track_rename` reject both. A track is created together with its first task; a track with no live tasks is archived (`archive-workflow`).

## Schema versioning

`schema_version: 1` declares the current track-card schema. same semantics as task.md: files missing the field are treated as `schema_version: 0` and continue to parse cleanly (v1 is a strict superset of v0); new tracks always write `schema_version: 1`; bump only on genuinely breaking changes.

## Body sections (recommended template)

```markdown
## Context

Optional: background a reader needs that the one-line `scope:` cannot hold.

## Tasks

| Slug | State | Repos | Tracker link | Doing doc |
|------|-------|-------|--------------|-----------|
| `api-validation-layer` | drafting | OrderService (local), OrderUI (local) | <link to work-tracker item, if any> | `api-validation-layer/OrderService/...-doing-validation.md` |

## Ordering

1. `api-validation-layer` Phase 1 must ship before UI can adopt the new contract.

## Adoption summary (if adopted)

- **Source**: planning bundle at `<path>` (see frontmatter `adopted_from`)
- **Inherited from predecessor track**: <summary of what was preserved vs reparented>
- **New work items under this track**: <summary>
- **Planning docs preserved**: see `_planning/` (current) and `_planning/_history/` (superseded)
```

consumer agents may add a "Work-tracker structure" body section (e.g. an enterprise Feature/Requirement/Task hierarchy) — that belongs in the consumer's extension skill, not here.

keep the body concise. when a resuming operator slides the drawer open, they should know what's in flight and what's next in under 30 seconds.
