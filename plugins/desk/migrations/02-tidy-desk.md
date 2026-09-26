---
id: 02-tidy-desk
description: Tidy this session's own desk once into the organization rules (scope lines, outcome names, one task per job, no loose files, no person or catch-all tracks), then announce it in one line (2026-09-25)
safety: safe
needs_restart: false
agent_work: true
---

## Detect

```bash
# Fires when desk_doctor reports organization findings in this session's own desk subtree and that subtree's
# _meta/organization.json does not record tidy_version 1. Never fires for a desk that is not a Git repository,
# or for a crew desk when DESK_PERSON does not name this session's own desk.
# The driver sets DESK_PLUGIN_ROOT to the Desk plugin root that holds this file, and DESK_PERSON on a crew desk.
command -v node >/dev/null 2>&1 || exit 1
[ -f "${DESK_PLUGIN_ROOT:-}/mcp/scripts/tidy-status.js" ] || exit 1
node "$DESK_PLUGIN_ROOT/mcp/scripts/tidy-status.js" --detect
```

## Safety check

```bash
command -v git >/dev/null 2>&1 || { echo "git is required: the tidy moves files through Git so every move can be undone"; exit 1; }
node "$DESK_PLUGIN_ROOT/mcp/scripts/tidy-status.js" --safety
```

## Migrate

```bash
# The tidy is agent work, so this block changes nothing. It prints this desk's findings and the steps the agent
# now performs in this session with the Desk tools, in order.
set -eu
node "$DESK_PLUGIN_ROOT/mcp/scripts/tidy-status.js" --report
record="node '$DESK_PLUGIN_ROOT/mcp/scripts/tidy-status.js' --write-record"
[ -z "${DESK_PERSON:-}" ] || record="$record --person $DESK_PERSON"
cat <<STEPS

Tidy this desk now, as ordinary work in this session. Do not ask first and do not wait for an answer: tidy, announce it in one line, and carry on.

Rules for every step:
- Work only inside this session's own desk, named above. A peer's crew desk is theirs: never change it.
- If the human has told you not to write in this session, skip the tidy entirely and leave everything as it is.
- Move and rename only through Git: task_move and track_rename stage a git mv, and git mv moves a loose file. Never delete content.
- Never change a task's status. Stale tasks are reported only; their status belongs to the work.
- Build every new name from the outcome, 2 to 6 lowercase kebab-case words. Never copy text from an old name, and never write a redacted (credential-like) old name anywhere: not in a card, a commit message or the announcement.

Steps, in order:
1. Scope lines. For every track without one (track_missing_scope), write a scope line from its tasks with track_update (frontmatter.scope), in the form "<what belongs>; not <what doesn't>".
2. Names. Rename every prompt-like, credential-like or badly shaped name (name_prompt_like, name_credential_like, name_shape): a task with task_move (to_slug), a track with track_rename (to). A path shown as <redacted segment> is a credential-like name; find the folder by listing its parent yourself.
3. Duplicates. For each group of tasks for one job (duplicate_job), keep the oldest task (earliest created) and merge each other task into it with task_move (into_task: the kept task). The merged folder becomes an iteration folder of the kept task, so nothing that holds unique content is archived or lost.
4. Loose files. git mv each loose file (loose_file) into the task it belongs to, or into the track's _planning/ when it concerns the whole track. When no task or track fits, create one with task_create or track_create first.
5. Person-named and catch-all tracks (track_person_name, track_catch_all). Move each task, live or archived, into a track whose scope line clearly fits, or into a new track made with track_create (an outcome name and a scope line), using task_move (to_track). Then git mv the emptied track into the desk's _archive/.
6. Empty tracks (track_empty). git mv each into the desk's _archive/.
7. Record and commit. Write _meta/organization.json in this session's own desk with: $record
   Fix the files that task_move and track_rename reported under mentions when they matter. Run desk_doctor to confirm the Organization section. Commit only the paths the tidy touched, with a message that lists every move and rename, then push.

Then send the Announce line below with this tidy's own counts and the commit link.
If the human objects, revert the tidy through Git and keep _meta/organization.json, so the tidy does not run again.
STEPS
```

## Announce

I tidied up my desk a bit: <what changed, with counts, for example 4 tasks renamed, 2 new tracks, 12 loose files filed>. Say if you mind and I'll put anything back. <commit link>
