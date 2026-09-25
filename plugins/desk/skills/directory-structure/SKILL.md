---
name: directory-structure
description: Canonical layout of `$DESK/` — tracks, tasks, repo workspaces, reserved `_` directories, what may sit at the desk and track roots, naming conventions, renames, and rules for where planning/doing docs go. Use when creating a new track or task directory, placing a planning/doing doc or report, renaming or moving a task or track, or auditing or tidying a desk that looks disorganized.
---

# Directory structure

this is the floor plan of the room. the desk lives at `$DESK/` — the same shape whether that resolves to a Claude Code workspace (e.g. `~/<your-workspace>/` for a corporate worker overlay), an ouro agent's bundle subdirectory (`~/AgentBundles/<name>.ouro/desk/`), or any other host context. drawers are tracks. folders are tasks. pages are iterations. the back of the room is `_archive/`, still browsable, still mine.

```
$DESK/
  .gitignore                            # includes .machine-local.yml
  .machine-local.yml                    # gitignored: per-machine local_path overrides (see repo-handling)
  AGENTS.md                             # operator preferences that compose with every session's instructions
  artifacts/                            # committed vector packs, snapshots, and publication policy
    publication-policy.json
    publication-policy.schema.json
    vector-packs/<embedding-spec-id>/
    snapshots/<embedding-spec-id>/
  _meta/
    friction.md                         # append-only friction backlog for this operator
    operator-rules.md                   # optional: longer operator rules that AGENTS.md points to
    preview-feedback.md                 # explicitly offered, attributed preview feedback (see preview-feedback); distinct from an iteration's feedback.md
  <track-name>/                         # one directory per track (maps to an external work-tracking Feature (GitHub Project / Jira Epic / enterprise work-item tracker / etc.))
    track.md                            # track card — dashboard (see track-card-format)
    _friction/                          # per-track friction entries; archived siblings in _friction/_archive/
    _planning/                          # cross-repo planning artifacts
      planning.md                       # authoritative cross-repo plan
      design.md                         # design doc(s)
      tracker-snapshot-YYYY-MM-DD.md    # snapshot of external-tracker state at adoption (optional)
      _history/                         # superseded / historical artifacts
        README.md                       # explains what each historical file was
        <older-doc>.md
    <task-name>/                        # one directory per task within the track
      task.md                           # task card (see task-card-format)
      <repo-name>/                      # workspace per repo the task touches (matches task.md repos[].name)
        <YYYY-MM-DD>-<slug>/            # one iteration directory (e.g. 2026-04-13-initial-impl)
          planning.md                   # per-iteration planning doc
          doing.md                      # per-iteration doing doc
          feedback.md                   # present when iteration is feedback-triggered
          artifacts/                    # per-iteration outputs (coverage checklist, logs, drafts)
            planning-coverage-checklist.md
            ...
        _archive/                       # archived iterations for THIS repo (sibling to active iterations)
          <YYYY-MM-DD>-<slug>/
    _archive/                           # archived tasks within this track
      <task-name>/                      # moved here when done or cancelled
  _archive/                             # archived tracks
    <track-name>/                       # moved here when all tasks in the track are terminal
```

### iteration-directory rules

a page is what i lay open on the desk for a single work session — one iteration directory per session, named by date.

- **date prefix is `<YYYY-MM-DD>`, not `<YYYY-MM-DD-HHMM>`.** one iteration per day per repo is the default expectation; if two iterations land on the same day, the slug differentiates them (e.g. `2026-04-13-initial-impl` and `2026-04-13-arch-refinement`).
- **slug trigger values** (kebab-case; the agent picks the one that fits, or names a new trigger from what the iteration does):
  - `initial-impl` — first iteration on a repo; starts fresh or from adoption
  - `review-pass-N` — PR feedback iteration; N increments per round
  - `architecture-review` — larger refactor triggered by review
  - `post-int-smoke-fixes` — integration-environment findings
  - `revert-and-reland` — previous PR reverted; re-PR with fixes
  - `pre-merge-polish` — final pass before merge
- **no `iterations/` wrapper directory.** every direct child of `<repo-name>/` is either `_archive/` or a date-prefixed iteration directory. (an `iterations/` wrapper was considered and rejected — redundant depth given the `_archive/` sibling already differentiates active from archived.)
- **`_archive/` is a direct child of `<repo-name>/`.** archived iterations move there as a whole directory — `planning.md`, `doing.md`, `feedback.md`, and `artifacts/` preserved together as a single unit. see `archive-workflow`.
- **`artifacts/` is per-iteration**, not per-doing-doc. coverage checklists, audit logs, PR-description drafts, compliance logs — every output for that iteration lands here.

iteration frontmatter carries scope identifiers (`track`, `task`, `repo`, `iteration`, `pr`, `trigger`) so an agent doesn't need to parse the directory path to know which page it's looking at.

## naming conventions

- **track directory**: outcome name for the body of work the track holds, such as the originating Feature/Epic's outcome; never a person's name or a catch-all. example: `order-service-hardening`.
- **task directory**: outcome name for what the task delivers. must match `task.md`'s `title` field exactly. example: `api-validation-layer`.
- **repo workspace**: matches the upstream repo name exactly. example: `OrderService`, `OrderUI`.
- **system directories**: `artifacts/`, `_planning/`, `_archive/`, `_meta/`, `_history/`. these are not task directories. `_`-prefixed dirs sort to the top in `ls`; `artifacts/` is deliberately plain because it is shared repo data, not a hidden local cache.

The agent chooses every track and task name itself, from the outcome, without asking (`start-task` has the rules; `task_create`, `track_create`, `task_move` and `track_rename` enforce them). Names are not permanent. Rename or move a task with `task_move` (to another track, a new name or both) and rename a track with `track_rename`. Both stage the move with `git mv` on a Git desk, update `track:` in the moved task cards and the `## Tasks` tables, and report other files that still mention the old path; fix the ones that matter in the same commit.

## rules

- **track directories** are created together with their first task, when no active track's scope line clearly fits the work (`start-task`, `track-card-format`).
- **task directories** are created when new work starts (`start-task`), never for another round of an existing job (`task-lifecycle` "One job is one task").
- **repo workspaces** are created when worker begins work on a specific repo within a task.
- **track root stays readable.** never dump planning artifacts, design docs, flow diagrams, or binaries directly at track root — use `_planning/`. "What may sit where" below lists what belongs.
- **repo-shared embedding artifacts live at `$DESK/artifacts/`, never `.state/`.** `.state/` is local and ignored; `artifacts/vector-packs/` and `artifacts/snapshots/` are committed only when the repo's publication policy explicitly approves them.
- **PR-surface artifacts live at `<task>/<repo>/`, not inside an iteration's `artifacts/`.** the PR description, draft top-level PR comments, and other PR-surface artifacts span every iteration of the same PR (initial-impl → review-pass-N → pre-merge-polish → pr-feedback → pr-self-review) and are rewritten in place over time. they belong alongside other task-level surfaces like `integration-smoke.md`. the `<iteration>/artifacts/` directory is for iteration-bounded outputs only (diff snapshots, raw findings, evaluator logs). test: "is this artifact rewritten across multiple iterations of the same PR?" — yes → task-level (`<task>/<repo>/pr-description.md`); no → iteration-level (`<task>/<repo>/<iteration>/artifacts/`).
- **ad-hoc operator-facing tooling lives in the desk, not the product repo.** smoke scripts, repro harnesses, exploration notebooks, quick-check utilities — these live in `$DESK/<track>/<task>/<RepoName>/...`, NOT in the product repo. the product repo is only for artifacts that go through production review and ship. heuristic: if reviewers on the product PR wouldn't want to see this file, it belongs on the desk. when a brief says "commit to repo," confirm the destination explicitly OR surface the desk as the default and require operator override.

## What may sit where

Nothing is loose. These are the only entries allowed at each root; everything else is loose.

- **At the desk root:** track folders (each with a `track.md`), underscore folders such as `_meta/` and `_archive/`, `desks/` in a crew workspace, the shared `artifacts/` folder this layout defines, `AGENTS.md`, `README.md`, `CLAUDE.md`, and dotfiles such as `.gitignore`.
- **At a track root:** `track.md`, task folders (each with a `task.md`) and underscore folders such as `_planning/`, `_friction/` and `_archive/`.

Everything else is loose. Reports, status notes and handoffs belong in a task or iteration folder, and cross-repo plans in `<track>/_planning/`. `desk_doctor` reports loose entries as `loose_file` in its Organization section, together with missing scope lines, person or catch-all track names, weak names, empty tracks, several tasks for one job and stale tasks. Fix what it reports by moving files into the task, iteration or underscore folder they belong to, and announce the tidy in one line (`interaction-style` section 2). Tidying never changes a task's status and never deletes content.

## planning doc scope determines location

- **cross-repo plans** → `<track>/_planning/`
- **single-repo plans** → inside the per-iteration directory: `<track>/<task>/<repo>/<YYYY-MM-DD>-<slug>/planning.md`
- **doing docs** → per-iteration, sibling to `planning.md`: `<track>/<task>/<repo>/<YYYY-MM-DD>-<slug>/doing.md`
- **feedback docs** (PR-feedback iterations only) → per-iteration, sibling to planning/doing: `<track>/<task>/<repo>/<YYYY-MM-DD>-<slug>/feedback.md`

`_history/` within `_planning/` holds superseded/historical/binary artifacts with a `README.md` explaining what each was and what replaced it.

## content discipline when filing facts

layout (where files live) is one half of desk hygiene; *what content goes in which file* is the other half. two rules govern the second half.

### consolidate, don't proliferate

when new context arrives during an in-flight track, **fold into existing files** rather than creating per-beat standalone files. per-beat tracking files (e.g. `thread-replies-2026-04-13.md`, `<reviewer>-fc-simplify-reply.md`, `<topic>-update-notes.md`) clutter the desk — the active surface becomes hard to scan, and the next agent picking up the track can't tell which file is the canonical home for a given fact.

**a new file is acceptable for:**
- a complete published artifact (the canonical record of what was sent — a draft that became the final PR description, a meeting-notes doc the operator will share).
- a fundamentally new sub-track within the larger track.
- a focused working document the operator explicitly asked for.

**a new file is NOT acceptable for:**
- "i want to capture this thread before it scrolls out" — fold into the existing `_friction/` entry or planning-doc Progress log.
- "reviewer X said something specific so let me track their thread" — fold into the existing PR feedback doc.
- "let me start a new doc for the next conversation beat" — the next beat fits in the existing doc; if it doesn't, the existing doc is in the wrong shape and needs restructuring (not duplication).

**test before creating a new file.** could the content land in an existing file (planning.md, doing.md, friction entry, task.md, the PR feedback doc) without making that file incoherent? if yes, fold. if no — and the reason is a real shape mismatch, not just "i don't want to scroll" — then a new file is justified.

### context-of-mention isn't scope-of-fact

when the operator surfaces a fact during a session focused on a specific surface (a meeting, a review task, a track), **don't tie the fact to that surface in desk prose unless the operator explicitly says so**.

the failure mode: the operator mentions a general desk-wide fact (e.g. a renaming convention that applies across multiple agents) during a discussion of one specific track. worker captures the fact in that track's planning doc as if it were *caused by* or *scoped to* that track — speculating a causal tie ("part of the X review's round-2 outcome") that the operator never made. months later the next reader sees the fact filed under the wrong scope and can't tell whether it applies broadly.

**quick check before committing a captured fact.** is the fact broader than what the current session is about? if yes:
- file it broadly (cross-track `_landscape/` entry, `_meta/` doc, or the relevant track-of-record for the fact, not the track that happened to be the conversation surface).
- don't claim a causal link to the current task / track / review unless the operator stated one.

**the default phrasing.** "operator surfaced this 2026-MM-DD" rather than "during the X review, operator said Y" — the date stamp captures origin without implying scope.

### provenance for promoted facts

when promoting a synthesized fact into `_landscape/*.md`, `_meta/*.md`, or any cross-cutting fact-doc, **include an inline pointer to the source** at write time.

the author has the source fresh in conversation context; the future reader (worker on a future session, or operator post-review) does not. pointer cost is small at author time and large at read time. author-time worker has the wrong intuition about who benefits from the pointer, because at author time the source feels too obvious to need naming.

**the rule.**

1. **always include source type and date** at minimum: *"per Andrei status tweet 2025-12-10 on Feature 4724364"* / *"promoted from Ruby's billing dev design review, 2026-04-29"*. a clickable URL is ideal but not required.
2. **for compound claims** ("X confirmed, Y open"), name the source for each half if they came from different events. they often did. if they came from the same event, say so explicitly so a future reader doesn't double-dig.
3. **for status claims that decay** (`R4`, "confirmed", "open", "in flight"), prefix with `Status as of <date>:` so the next reader knows when this was last verified. state changes silently; the date doesn't.
4. **at edit time**, if a claim's source is no longer traceable from the doc, either find and add the source pointer or rewrite the claim in less declarative language ("worker synthesis from past session, source not captured — verify before citing").

**better shapes.**

| Bad (no provenance) | Good (inline pointer) |
|---|---|
| `(R4 2026-04-30; X confirmed, Y alignment needed)` | `(R4 2026-04-30; X chosen as path + Y alignment open — both per <author> status tweet 2025-12-10 on the work item)` |
| `<person>'s migration is blocked on auth.` | `<person>'s migration is blocked on S2S auth (per <person> status tweet 2026-04-23: "Will setup a call with <other-person> today").` |
| `<system> indexing takes up to N days end-to-end.` | `<system> indexing takes up to N days end-to-end (promoted from <person>'s billing dev design review, 2026-04-29).` |

the fix is mechanical: at promotion time, write the inline pointer first, then the prose. pointer-first authoring also surfaces missing sources at the moment they can still be reconstructed, rather than weeks later when the author is gone from context.
