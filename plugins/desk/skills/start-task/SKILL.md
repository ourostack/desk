---
name: start-task
description: >-
  Start a new task in the workspace from an operator description or from work
  the agent recognizes as task-shaped. Names the task from its outcome, routes
  it to the track whose scope line fits (or creates a new track with a scope
  line), and writes the task card, with no naming or filing question to the
  human. Use when the operator says "start a new task: <description>", "work
  on X", "I need to do Y", "track this", "this is worth tracking", or when an
  agent recognizes mid-conversation that it's working on something
  task-worthy ("I'm investigating Z; this is a real task").
---

# Start a task

Invoke `desk:using-superpowers-with-desk` at its `start` entry for the engineering handoff. Desk retains outcome identity, scope and the explicit go; Superpowers consumes them without another intake or lifecycle.

A task enters the workspace through one of two paths. Both end in the same place: a new `task.md` under a track directory in `$DESK/`. The agent names and files the task itself and never asks the human to choose a name, a track or a location (`interaction-style` section 2).

For overlays with their own work-item tracker (and a work-item ID), consumer overlays typically ship a tracker-aware `start-task` variant that also captures the tracker's ID + URL and walks the work-item-relations chain to find the parent Feature's track.

## Is it a new task?

One job is one task (`task-lifecycle`). Before creating anything, search the desk (`desk_search`) for a live task with the same outcome. A follow-up, a re-review or a retry of the same outcome is a new iteration of the existing task, not a new task: add the iteration under that task (`directory-structure`) and continue there.

## Name the task from the outcome

Name the task yourself from the outcome it delivers, with no proposal step and no wait for confirmation. The name is 2 to 6 lowercase kebab-case words and at most 48 characters, such as `oauth-login-fix` or `api-validation-layer`. Build it from what the work achieves, never from the words the human typed: a name never starts with a greeting or request word (`hi`, `please`, `can`, `lets`, `help`), and never carries a secret, an address or other sensitive text. `task_create` enforces these rules; when it rejects a name, name the outcome again rather than trimming the rejected text.

A name that turns out weak is cheap to fix later with `task_move`, so choose a good name quickly and move on.

## Route by scope line

Read the `scope:` line of every active track (`track-card-format`). File the task in a track only when that scope clearly fits; the nearest track is not good enough. When none clearly fits, create a new track with `track_create`, giving it an outcome name and a scope line, then create the task in it. Never file work under a track named after a person or a catch-all track such as `misc` or `general`, and never create one; `track_create` rejects both names.

If an existing track has no scope line, write one from its tasks with `track_update` before routing against it.

## Path A — operator-described

Triggers: "start a new task: …", "work on …", "I need to add X to Y", "let's track …", "new task: …".

1. **Check it is a new task**, as above.
2. **Name the task and route it**, as above.
3. **Create the task** with `task_create` at `$DESK/<track>/<slug>/`, per `desk:task-card-format`:
   - `title: <slug>`
   - `status: drafting`
   - `created` / `updated`: now (UTC ISO-8601)
   - `track: <track-slug>`
   - `initiated_by: operator`
   - `repos: []` — populate only if the description names code repos; otherwise leave empty for non-coding tasks.
4. **Add the task's row** to the track's `## Tasks` table, then **commit and push** the task card and track card to the workspace repo.
5. Hand off through `desk:using-superpowers-with-desk` at its `start` entry. Consume the existing approval or use `superpowers:brainstorming` to resolve missing agreement. Already-approved work can transition directly to `processing`; keep any required plan and doing record at the existing Desk paths.

## Path B — agent-initiated

Triggers: the agent notices mid-conversation that it's doing something worth tracking ("I'm digging into Z — this is a real task, not a one-shot answer"), OR the operator mentions something in passing that's clearly task-shaped ("oh, worth tracking that").

1. **Create it and announce it in one line.** Check it is a new task, name it and route it as above, create it, and tell the human in one line, for example "Tracking this as `flaky-login-test` in the `auth-hardening` track." Do not wait for a reply. An explicit instruction not to write overrides this path (`using-desk` "Authority").
2. **Same task.md shape as Path A**, except:
   - `initiated_by: agent`
   - Include a one-line `origin_note:` field summarizing what the agent was doing when it noticed (e.g. "spawned from investigation in `<other-task>` on 2026-05-18").
3. Track row, commit and push: same as Path A.
4. Resume the in-flight conversation; the task card is now the durable anchor for the work.

## Output shape (both paths)

```yaml
---
title: <slug>
status: drafting
created: <UTC-ISO-8601>
updated: <UTC-ISO-8601>
track: <track-slug>
initiated_by: operator | agent
# origin_note: "<context>"   # Path B only
repos: []                    # optional; only if coding work
---
```

See `desk:task-card-format` for the full schema (adoption signals, iterations history, repo `local_path` portability), `desk:track-card-format` for the parent track shape and its scope line, and `desk:directory-structure` for where this all lands under `$DESK/`.

## Linking later

Either path can be linked to an external tracker (GitHub Issue, Jira, or an enterprise work-item tracker) after creation by appending the relevant fields to `task.md`. No state transition required.
