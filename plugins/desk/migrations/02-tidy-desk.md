---
id: 02-tidy-desk
description: Tidy this session's own desk once into the organization rules (scope lines, outcome names, one task per job, no loose files, no person or catch-all tracks), then announce it in one line (2026-09-25)
safety: safe
needs_restart: false
agent_work: true
---

## Detect

```bash
# Fires when desk_doctor reports organization findings other than stale tasks in this session's own desk subtree and
# that subtree's _meta/organization.json does not record tidy_version 1. Never fires for a desk that is not a Git
# repository. On a crew desk where no person resolves it fires too, so the tidy can say so in one line.
# The driver sets DESK_PLUGIN_ROOT to the Desk plugin root that holds this file, and DESK_TOOLS_ROOT and
# DESK_TOOLS_PERSON to the root.path and write_scope.person desk_status reports, so the tidy works on the tools' desk.
# It does not fire while another session holds the tidy's claim, or while a hold's reason still stands (the tidy
# stopped and nothing that stopped it has changed); then it prints `held: <reason>`, which the startup hooks relay.
command -v node >/dev/null 2>&1 || exit 1
[ -f "${DESK_PLUGIN_ROOT:-}/mcp/scripts/tidy-status.js" ] || exit 1
node "$DESK_PLUGIN_ROOT/mcp/scripts/tidy-status.js" --detect ${DESK_TOOLS_ROOT:+--root "$DESK_TOOLS_ROOT"} ${DESK_TOOLS_PERSON:+--person "$DESK_TOOLS_PERSON"}
```

## Safety check

```bash
# Anything that only has to wait (a merge or rebase in progress, another desk than the tools use) makes Migrate print
# one line and skip the tidy for this session; it never stops the session.
command -v git >/dev/null 2>&1 || { echo "git is required: the tidy moves files through Git so every move can be undone"; exit 1; }
exit 0
```

## Migrate

```bash
# The tidy is agent work, so this block changes no desk content. It takes the tidy's claim, so no other session
# tidies this desk meanwhile, and prints this desk's findings and the steps the agent now performs in this session
# with the Desk tools, in order. When the tidy cannot run this session, it prints the one line to say instead, and no
# steps.
set -u
script="$DESK_PLUGIN_ROOT/mcp/scripts/tidy-status.js"
if ! report=$(node "$script" --report ${DESK_TOOLS_ROOT:+--root "$DESK_TOOLS_ROOT"} ${DESK_TOOLS_PERSON:+--person "$DESK_TOOLS_PERSON"}); then
  printf '%s\n' "$report"
  exit 0
fi
printf '%s\n' "$report"
claim=$(printf '%s\n' "$report" | sed -n 's/^Tidy claim: \([^ ]*\) .*/\1/p')
flags="${DESK_TOOLS_ROOT:+ --root '$DESK_TOOLS_ROOT'}${DESK_TOOLS_PERSON:+ --person '$DESK_TOOLS_PERSON'} --claim '$claim'"
record="node '$script' --write-record$flags"
defer="node '$script' --defer '<one-line reason>'$flags"
cat <<STEPS

Tidy this desk now, as ordinary work in this session. Do not ask first and do not wait for an answer: tidy, announce it in one line, and carry on. This session holds the tidy's claim (above), so no other session tidies this desk meanwhile.

Rules for every step:
- Work only inside this session's own desk, named above. A peer's crew desk is theirs: never change it.
- If the human has told you not to write in this session, skip the tidy entirely and leave everything as it is.
- Leave alone every task and track that holds uncommitted changes listed above: another session may be working there. Name them as left alone in the announcement.
- Stage as you go, and stage only what the tidy itself changed, so your own earlier steps never look like another session's work. On a Git desk task_move, track_rename, track_create and track_update stage what they write. Right after any other change the tidy makes, such as a task_create card or a file you fix by hand, git add exactly that path (put DESK_TOOL_COMMIT=1 in front of a git add that names a task card, or the task-status guard denies it); never git add a folder, a pattern or -A. task_move and track_rename let staged changes through as this tidy's own work and refuse unstaged changes or untracked files, which belong to another session; never pass allow_dirty to get past that. Before moving a task or track, check git diff --cached --name-only -- <its path>: if it lists anything the tidy did not stage, leave that task or track alone.
- If the tidy cannot finish in this session for any reason (for example the checks in step 7 fail, or a guard refuses a git command), stop, leave what you staged as it is, and run: $defer
  with the reason in place of <one-line reason>. That releases the claim and keeps session start from asking again until this desk's latest commit or its uncommitted changes differ. Then say the reason in one line.
- Move and rename only through Git: task_move and track_rename stage a git mv, and git mv moves a loose file. An untracked loose file that is not ignored gets git add first, then git mv. Leave ignored files where they are. Never delete content.
- Never change a task's status. Stale tasks are reported only; their status belongs to the work.
- Build every new name from the outcome, 1 to 6 lowercase kebab-case words. Never copy text from an old name, and never write an old name that failed the credential or prompt check (shown as <redacted segment>, name_credential_like or name_prompt_like) anywhere: not in a card, a commit message or the announcement. Describe such a move by its new name only.
- Never rename or move a track or task folder with a raw git mv, a bare `git add -A` or a folder/pattern add, or by deleting `.git/index.lock` — all four are forbidden, whatever the reason. A track or task only ever moves through track_rename or task_move (step 4's loose-file git mv is not a track or task move), with one exception: step 5 and step 6's own git mv of a track this report listed into the desk's `_archive/` is the one raw move a track folder ever makes, because no tool for it exists yet. If a git command is refused, that is the tool protecting another session's work, not an obstacle to route around by hand.

Steps, in order:
1. Scope lines. For every track without one (track_missing_scope), write a scope line from its tasks with track_update (frontmatter.scope), in the form "<what belongs>; not <what doesn't>".
2. Names. Rename every prompt-like, credential-like or badly shaped name (name_prompt_like, name_credential_like, name_shape) by the handle its finding shows: a task with task_move (handle, to_slug), a track with track_rename (handle, to). A path shown as <redacted segment> is a credential-like name: never list its parent, open the folder or otherwise recover the name; the handle is all the rename needs. Build the new name from the card's status, repos and the work you know about. A loose entry shown as <redacted segment> has no handle: leave it where it is and name it as left alone.
3. Duplicates. duplicate_job only means two cards mention the same pull request. Merge a group only when you judge that both cards describe the same outcome; leave the others and mention them. Keep the oldest task (earliest created) and merge the other into it with task_move (into_task: the kept task, and to_track when the kept task is in another track). Never hide a live task: when the duplicate is not done or cancelled and the kept task is, keep the live one instead, or skip the merge. When the kept task sits in a track that step 5 will empty, re-file that track's tasks first.
4. Loose files. git mv each loose file or folder (loose_file) into the task it belongs to, or into the track's _planning/ when it concerns the whole track, or into _meta/ when it concerns the whole desk. Never create a task just to hold files. A loose folder that is clearly a task gets a card with task_create instead of a move. A loose entry whose name fails the name rules gets an outcome name when it moves.
5. Person-named and catch-all tracks (track_person_name, track_catch_all). Move each task, live or archived, into a track whose scope line clearly fits, or into a new track made with track_create (an outcome name and a scope line), using task_move (to_track). Then git mv the emptied track into the desk's _archive/.
6. Empty tracks (track_empty). git mv each into the desk's _archive/.
7. Check, record and commit. Fix the files that task_move and track_rename reported under mentions when they matter, and git add each one. Run desk_doctor to confirm the Organization section. The tidy paths are the old and the new path of every move and rename and the files you fixed. Everything the tidy changed is staged, so check that git diff --name-only -- <tidy paths> and git ls-files --others --exclude-standard -- <tidy paths> print nothing, and that git diff --cached --name-status -- <tidy paths> lists only the tidy's changes. If one of those paths holds changes that are not the tidy's, leave the tidy uncommitted, run the defer command above, and stop with one line saying so. Otherwise write _meta/organization.json in this session's own desk with: $record
   Then git add the record and commit with git commit -- <tidy paths> <the record> and nothing else, so any other staged work stays staged exactly as it was and is never committed with the tidy; never unstage anyone else's work. Put DESK_TOOL_COMMIT=1 in front of that git commit: it tells the desk's pre-commit hook, which refuses a hand commit that edits a task card, that Desk's own tidy is committing the cards it moved. The message lists every move and rename by its new name and ends with the trailer `Desk-Tidy: true` on a last line of its own after a blank line, so Desk's reports count the commit as housekeeping, not as work on those tasks. Then push.

Then send the Announce line below with this tidy's own counts, anything left alone, and the commit link.
If the human objects, run git revert --no-commit <tidy commit>, restore the record with git checkout <tidy commit> -- <this session's own desk>/_meta/organization.json, and commit both together, so the desk is back as it was and the tidy does not run again. Put DESK_TOOL_COMMIT=1 in front of that git commit too, and keep the trailer: the message ends with the trailer `Desk-Tidy: true` on a last line of its own, because the revert restores task cards and the desk's pre-commit hook refuses a hand commit of one.
STEPS
```

## Announce

I tidied up my desk a bit: <what changed, with counts, for example 4 tasks renamed, 2 new tracks, 12 loose files filed>. <What I left alone, if anything, for example: I left 2 tasks alone because another session is working in them.> Say if you mind and I'll put anything back. <commit link>
