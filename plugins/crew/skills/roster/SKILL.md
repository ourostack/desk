---
name: roster
description: The team roster in a Crew workspace -- the people file that lists the team and everyone the team works with (contacts, partners, former members), with notes about each. Use when finding the roster, adding or updating someone's entry (including a member's own entry after joining), adding a contact or a note about a person, or answering "who is X" / "who knows Y" / "who do we talk to about Z" in a shared workspace. Not the desk list in `_meta/desks.md`, which only records who has joined and where their desk is.
---

# The team roster

The roster is the team's people file: the team, and over time everyone the team works with (contacts, partners, former members) with notes the team would want to know about each. It is plain Markdown that a teammate can read with no agent.

## Find it

1. If the workspace's root `AGENTS.md` names a roster or people file (for example `team/roster.md`), that file is the roster. Otherwise, if its root `README.md` names one, use that.
2. Otherwise look for an existing `roster.md` or `team/roster*` in the repository; if exactly one exists, use it and tell the person which file you used.
3. Only if there is none, use `_shared/landscape/roster.md`, created with a one-line purpose and a `## Team` section the first time someone is added.

`_meta/desks.md` is the desk list Crew's scripts read. Never treat it as the roster or edit it by hand.

## Write to it

- The roster is a shared path: never push it straight to the default branch. In a temporary worktree from the latest default branch (never the person's own working tree, which may hold their uncommitted files), branch, edit, open a pull request and merge it at once, as `crew:shared-desk-conventions` describes. Retry from the latest default branch if someone else's change landed first. If the merge is refused, leave the pull request open and tell the person in plain words.
- Keep the file's own format and sections. Add a person as one entry (a table row, or a short section) where similar people are; change only the entry you mean to change.
- Facts only, each with where it came from (the person themselves, a meeting and date, a document). An opinion about a person is a perspective: it goes in the holder's own desk, attributed, never in the roster.
- Never write something a person asked to keep out, and never make up a field to fill a column; leave it empty.
- A member's own entry is theirs to correct: when they ask, change it as they say.

## Read from it

Answer "who is X", "who knows Y" or "who do we talk to about Z" from the roster first, then members' desks, and say which you used.
