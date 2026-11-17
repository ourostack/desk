---
name: shared-desk-conventions
description: Use in a shared Crew repo (`desks/`, `_shared/`) to decide where content belongs, answer what a teammate thinks or works on, whether something is agreed, who someone is or who knows what, adding or updating a roster entry, contact or fact about a person, write outside your own `desks/<alias>/`, or before saying work is saved, done or ready.
---

# Shared-desk conventions

A shared workspace is `desk:directory-structure` with several people in one Git repository: each has a desk, and a common area holds team facts, agreed decisions and shared efforts. Plain Markdown first: someone who never runs an agent can read all of it.

```
<crew-repo>/
  README.md                   front page
  AGENTS.md                   team conventions and lessons; Desk's session start prints it
  _meta/desks.md              the desk list Crew's scripts read: one row per member (identity -> alias). Never edit it by hand, even through a pull request; each row decides who a session writes as, and `crew.js join` is the only gate
  _meta/crew.json             where the team's plugin lives (below)
  _shared/landscape/          FACTS: externally true, team-neutral, with a source
  _shared/decisions/          DECISIONS: what the team agreed, with who and when
  _shared/tracks/<slug>/      shared initiatives (`crew:shared-initiative`)
  desks/_template/            the skeleton a new member copies
  desks/<alias>/              one person's whole desk, laid out as `desk:directory-structure`
    AGENTS.md                 their own preferences and lessons
    _inbox/                   notes teammates left them (`note`)
```

The team's plugin is in a separate tooling repository (dual-repo: `_meta/crew.json` has `tooling.repo`) or in this repository's `plugins/<name>/` (monorepo: no `crew.json`, or none with `tooling.repo`). `crew.js status` reports which, and the install command. The plugin holds only the team's own process, written as skills; `desk:content-routing` "When a team shares a workspace" owns the rest of the rule.

## Read across, write your own

Read all of `desks/*/` and `_shared/`. Routine writes go to your own `desks/<alias>/`, committed and pushed straight to `main`: nobody else writes there, so nothing can conflict. Desk takes your person from the desk-list row whose `identity` is the GitHub login you act as (`DESK_PERSON` wins), and its own writes land under that desk. `desk_status` `write_scope` and `crew.js status --identity <login>` say who a session is.

A path anyone may write (`_shared/`, `plugins/`, the roster, the root `AGENTS.md`; never `_meta/desks.md`) goes through a short pull request: fetch the latest `main`, branch, write, open the pull request and merge it at once, retrying if `main` moved. The pull request only serializes writers; it is not a review.

When a member asks you to change another member's desk, do it: their request is the authorization. Use the same path in an isolated worktree, change only what was asked, keep the owner's other work and any concurrent edit, and say in the commit and pull request whose desk it is and who asked. It is not the owner's endorsement.

### Saved means on the remote `main`

Work is saved only when the remote `main` has it; a local commit, a branch in a worktree or an unmerged pull request is not. Land each durable write as you go: push, or push the branch and merge its pull request straight away. Before saying "saved", "done" or "ready", and before ending a turn that wrote files, run `git fetch origin main`, `git status --short --branch` and `git branch --no-merged origin/main` in the workspace checkout and your worktree, and finish whatever they show. `git merge-base --is-ancestor <your-commit> origin/main` proves a commit landed. If a push or merge fails, name the error and what is still at risk. Never call it saved.

## Facts, perspectives, decisions

Attribute everything, so one person's view never reads as the team's.

| Kind | Lives in | Say it as |
|---|---|---|
| Fact | `_shared/landscape/` | a team fact, citing its source and date |
| Perspective | `desks/<alias>/` | that person's view, from the first word |
| Deliberation | `_shared/tracks/<slug>/` | each view attributed; location is not agreement |
| Decision | `_shared/decisions/` | what the team agreed, with who and when |

A claim with a stance ("we should", "I think") is a perspective, not a fact. A decision exists only once the team agreed it; "no team decision recorded" is the honest answer and invites the conversation. When unsure, pick the more attributed, less authoritative home.

## Questions about people and agreement

These read only; reading grants no write authority.

- **"What would Alex think about X?"** Read `desks/alex/` and initiative cards for contributions attributed to them, and follow their links. Answer as Alex's view, labeled so. If neither records a view, say the workspace doesn't, and don't attribute a fact or an unlabeled contribution to them. Report conflicting views separately: "Alex thinks A; Sam thinks B".
- **"What is Sam working on?"** Read their desk now (tracks, tasks, recent work) rather than a cached summary, and report what it shows. Work that moved to another clone is read there, live.
- **"Is X agreed?"** In `_shared/decisions/`: agreed, as of its date. In `_shared/landscape/`: a fact, not a decision. Only on a desk: that person's take. Only proposed in `_shared/tracks/`: deliberation, not agreed unless a linked decision says so. A view in the repo with no holder is reported as unattributed.
- **"Who is X?" or "who knows Y?"** Answer from the roster, then members' desks, and say which. The roster is the team's people file (the team and everyone it works with), found where the root `AGENTS.md` or README names it, else an existing `roster.md` or `team/roster*`, else `_shared/landscape/roster.md`. It is not `_meta/desks.md`. A fact about a person ("Alex is the billing expert") is a roster entry with its source, not a `note`. Add or change one entry in the file's own format through a pull request: facts only, each with its source, nothing a person asked to keep out, and no opinions about people (those are perspectives, on the holder's desk). A member's own entry is theirs to correct.

## Team lessons

A correction that holds for the whole team goes into the root `AGENTS.md` of the repository the team works in, under `## Lessons`, one line each: `- **<rule>.** <detail> (<alias>, <date>; <source>)`. A personal preference goes into that person's `desks/<alias>/AGENTS.md`; how Desk or Crew itself behaves becomes an improvement card. A team lesson cites an agreed decision or who said it, where and when; when unsure, keep it personal. `lesson_add` routes and writes all three (`scope: "team"` merges its own pull request, and its reply says whether it merged). Copilot CLI and Codex load a repository's `AGENTS.md` themselves; Claude Code needs `@AGENTS.md` in `CLAUDE.md`.

## Notes and shared efforts

- `note` tells one teammate something at their next session start: a handoff, a change that affects them, a question. Write it in your own voice and relay what someone else thinks as your understanding of it. Leave one only when the operator asked or it is plainly part of the authorized work, never for routine progress. Never edit, move or delete a note: `ack` is the only change. Everyone in the workspace can read it, so put nothing private in it. Its reply says whether it merged. Acknowledge notes left for you with `note` and `ack` once the operator has seen them.
- Work that involves or seeks other collaborators belongs in a shared initiative: suggest one before keeping it on one desk (`crew:shared-initiative`).
- Two or more members preparing for one meeting keep the prep in one shared folder, reusing an existing one for that date and subject, else where the workspace already keeps meeting records, else `_shared/meetings/<YYYY-MM-DD>-<slug>/`. Its README says when, who organizes and the goal with a link to where they said it; drafts live under `prep/`, edited by everyone through their agents, and the capture lands there afterward. Each member's desk links to it and keeps their own view there.

## Setting up

`crew:start-crew` makes a repository a Crew workspace; `crew:join-crew` adds a member.
