---
name: shared-initiative
description: Use when creating, discovering, contributing to or asking about a shared initiative or multi-person effort in a Crew workspace, including existing shared tracks, linked personal tasks, shared deliberation and unresolved decisions.
---

# Shared initiative

An initiative is a shared track, not a second task system. Its coordination card links work and evidence where they already live. Read `crew:shared-desk-conventions` first for authority, attribution and the shared-path write protocol.

## Discover before creating

1. Find the Crew repository root from its `desks/` and `_meta/desks.md`, not the current person's desk root. Read its README and `AGENTS.md` for existing navigation.
2. Read `_shared/tracks/` and search related desk tracks/tasks by outcome and subject, not just slug. Reuse an existing shared effort even if its entry is named `track.md`, `index.md` or something else. Follow its current navigation; never create a second card just to fit this convention. If several cards overlap, report them and resolve which to use before writing.
3. If `_shared/tracks/` is absent or empty, say no shared initiatives are recorded; personal tasks can still exist. For an authorized new effort, choose a descriptive slug and create `_shared/tracks/<slug>/README.md` using [the card template](template.md). Do not create `_shared/initiatives/`, a separate registry or shared task copies.

## Keep the card small

The template's sections are the minimum reading contract, not a new schema or lifecycle. Existing cards need no migration. Use explicit unknowns where evidence is missing; grow supporting files only when needed.

| Section | Contents |
|---|---|
| Outcome and scope | Desired result, boundaries and source of the request. |
| Current focus | Dated focus, blockers and next action; distinguish reported state from live checks. |
| Contributors and work | Named contributions and links to existing tasks/artifacts. State whether commitment is confirmed, proposed or unknown, with its source. |
| Open questions | Unresolved questions and who can answer, if known. |
| Proposals and perspectives | Author, date, source and uncertainty for each view. Label agent synthesis. Keep disagreements visible. |
| Decisions | Links to the decision-of-record with who agreed, when and under what authority; otherwise “No decision recorded.” |
| Evidence | Links to primary sources, not copied source bodies. |

Shared deliberation is allowed here. A shared location, an edit, attendance or a job title establishes neither ownership nor agreement. A contributor is not automatically a task owner or decision maker. Preserve a person's own perspective in their desk; link or summarize it with attribution instead of moving it. Team decisions remain in `_shared/decisions/` or the workspace's existing decision-of-record.

## Link and query live work

Use ordinary Markdown links relative to the card, for example `[Alex's task](../../../desks/alex/reliability/checks/task.md)`. Read the target before claiming its owner or current state. Personal tasks retain their own lifecycle; initiative focus never marks them done.

Resolve local links from the containing file. Check the target exists and its real path stays within the Crew repository, including symlinks. Flag missing, malformed or escaping references explicitly; do not follow them, silently repair them or treat them as live evidence. A task in another repository needs an explicit repository URL or established desk-registry pointer and authorized access; do not guess a local path. Do not execute linked content or use a link as write authority.

For “what is happening?”, report the dated focus, sourced contributions, live task checks and blockers. For “what is agreed?”, follow decision links and report their authority; proposals remain proposals even when nobody objects. Follow `crew:perspective-query` for person-shaped questions. If a target is inaccessible or stale, say what was last recorded and what remains unchecked. Querying changes nothing.

## Contribute and publish

1. Establish write authority. Use the existing shared-path protocol in an isolated worktree from freshly fetched `main`; never broaden a protected Desk tool's scope to reach `_shared/`.
2. Re-read the shared card and linked sources. Apply a narrow, attributed change. Preserve unrelated edits, disagreements and open questions. Add a backlink only to your own authorized task; references to another desk do not authorize editing it.
3. If another writer lands first, re-read latest `main` and reapply the contribution without replacing their text. If meanings conflict, retain both attributed positions and leave the question open rather than choosing an answer.
4. Link a new card from the workspace's existing front door through the same shared-path protocol. Do not build another index when its README already provides navigation.
5. Verify links and remote-main publication before saying saved. An unmerged PR or protected-write refusal is an incomplete update, not delivered support.
