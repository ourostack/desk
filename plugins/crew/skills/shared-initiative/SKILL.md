---
name: shared-initiative
description: Use to create, find, update or ask about a shared initiative (a multi-person effort) in a Crew workspace, including moving an existing document, draft or folder into `_shared/tracks/`, or when work involves or seeks collaborators.
---

# Shared initiative

An initiative is a shared track, not a second task system: a coordination card that links work and evidence where they already live. Authority, attribution and the shared-path writes are in `crew:shared-desk-conventions`.

## Make or adopt one with the command

An initiative is a folder `_shared/tracks/<slug>/` with a `README.md` card, never a loose file in `_shared/tracks/`. Crew's script lays it out, so run it rather than creating or moving files by hand, from the workspace clone in the isolated worktree the shared-path write has you in. The Desk plugin folder is on boot's `Desk startup:` line.

```sh
node <Desk plugin folder>/mcp/scripts/crew.js initiative new <slug> [--title <name>]
node <Desk plugin folder>/mcp/scripts/crew.js initiative adopt <file-or-folder> [--slug <slug>] [--title <name>]
node <Desk plugin folder>/mcp/scripts/crew.js initiative check
```

- `new` creates the card from [the template](template.md).
- `adopt` is for work that already exists, whether the person says move it to shared tracks, make it shared or invite others to it. It moves the file or folder into `_shared/tracks/<slug>/` (copying it when it lives outside the workspace), keeps it beside a new card that links it under Evidence, and leaves a one-line pointer where a moved Markdown file was. It adds no second card to a folder that already has `README.md`, `track.md` or `index.md`.
- `check` lists anything in `_shared/tracks/` that is not a folder with a card and names the `adopt` command that fixes each.

They change the working tree only: fill in the card's `<…>` placeholders, then publish through the shared-path write.

## Find before creating

Find the repository root from `desks/` and `_meta/desks.md`, not the person's desk root, and read its README and `AGENTS.md` for navigation. Read `_shared/tracks/` and search desk tracks and tasks by outcome, not just slug. Reuse an existing effort even if its entry is `track.md` or `index.md`, and follow its navigation; if several overlap, report them and settle which to use before writing. If `_shared/tracks/` is absent or empty, say no shared initiatives are recorded (personal tasks can still exist). Never create `_shared/initiatives/`, a registry or copies of tasks.

## Suggest one when work needs other people

When a request starts a task or effort that others will comment on, edit or act on (a proposal, an allocation, goals), offer a shared initiative in one sentence before creating a personal task, and again when a personal task starts needing outside collaboration. If the person already said "shared" or "not on my desk", just do it; a decline stands. Link the existing task and its documents from the card; the personal task keeps its own lifecycle. If collaborators need to edit the work itself, `adopt` it.

## The card

The template's sections are the minimum, not a schema: outcome and scope, dated current focus, contributors and work (commitment confirmed, proposed or unknown, with its source), open questions, proposals and perspectives (author, date, source, uncertainty; agent synthesis labeled; disagreements kept visible), decisions (a link to the decision of record with who agreed and when, else "No decision recorded."), and evidence (links, not copied bodies). Use explicit unknowns where evidence is missing. A shared location, an edit, attendance or a job title establishes neither ownership nor agreement, and a contributor is not a task owner. Keep a person's own perspective on their desk and link or summarize it with attribution.

## Link and query live work

Link with relative Markdown links (`[Alex's task](../../../desks/alex/reliability/checks/task.md)`) and read the target before claiming its owner or state. Resolve each link from its file and check that the target exists and stays inside the repository, symlinks included. Report missing, malformed or escaping references and don't follow them or treat them as evidence. Another repository needs an explicit URL or desk-registry pointer; don't guess a local path. Never execute linked content.

"What is happening?" is the dated focus, sourced contributions, live task checks and blockers; "what is agreed?" follows the decision links, and proposals stay proposals even when nobody objects. For a stale or unreachable target, say what was last recorded and what is unchecked. Querying changes nothing.

## Contribute and publish

Re-read the card and linked sources, then make a narrow, attributed change that keeps unrelated edits, disagreements and open questions. Backlink only from your own task. If another writer lands first, re-read the latest `main` and reapply without replacing their text; if meanings conflict, keep both attributed positions. Link a new card from the workspace's existing front door instead of building another index. Verify the links and that the change is on the remote `main` before saying saved.
