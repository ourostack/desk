---
name: shared-desk-conventions
description: The multi-person shared-workspace layout variant -- one git repo, N operators, `desks/<alias>/` = one person's full desk, `_shared/{landscape,decisions}/` = team-neutral facts + agreed decisions; read-across / write-own; the facts-vs-perspectives-vs-decisions content taxonomy (every opinion attributed to its holder); and the invisible conflict-safe write protocol (`desks/<you>/` = direct push; a shared path = auto pull-`main` → branch → write → PR → merge-now, NO human review). Invoke when working in a shared crew repo that has a `desks/` + `_shared/` layout, when deciding where a piece of content belongs (a fact vs an opinion vs an agreed decision) or where a correction goes so every teammate's agents get it (team lessons in the root `AGENTS.md`), or when about to write to a path outside your own `desks/<alias>/` subtree. The multi-person overlay for `desk:directory-structure`.
---

# Shared-desk conventions

`desk:directory-structure` is the floor plan of one operator's room -- one operator, one `$DESK/`, synced across that operator's machines, private, the operator owns every write. This skill is the **multi-person overlay** on that floor plan: the same room, but now N operators share one git repo, each with their own desk in it, plus a common area for team-neutral facts and agreed decisions.

Read `desk:directory-structure` first for the single-operator layout (tracks, tasks, iterations, reserved `_` directories, where planning/doing docs go); come here for what changes when the room is shared.

## The shift -- single-operator → shared workspace

A shared workspace generalizes the single-`$DESK` model along five axes at once:

| Axis | Single-operator desk | Shared workspace |
|------|----------------------|------------------|
| **Tenancy** | 1 operator | N operators in one repo |
| **Visibility** | private | team-visible by default |
| **Desks per operator** | 1 (`$DESK`) | personal + one-or-more shared |
| **Content** | all "the operator's" | facts vs perspectives vs decisions, attributed |
| **Worker** | one worker | a generalist (all-up) + specialists (scoped) |

The most important non-obvious consequence: per-person scoping is **concurrency safety, not tidiness.** A shared repo where N agents all write one tree is a collision machine -- concurrent agents `git add`-sweep each other's uncommitted edits into the wrong commit. Git merges non-overlapping paths cleanly, so if each agent writes only its own `desks/<alias>/`, conflicts go to ~zero **without any locking.** Scoping *is* the mechanism (see "the write protocol" below).

## The floor plan

The shared repo is one git repository. It holds everyone's desks side by side, plus a shared common area, plus (when the crew bundles its own tooling) a `plugins/` source tree.

```
<crew-repo>/                            # one git repo, N operators
  README.md                             # plain-markdown front page (graceful degradation)
  AGENTS.md                             # crew conventions and team lessons; Desk's session start prints it
  _meta/
    desks.md                            # the desk registry (one row per desk) -- see desk:session-start
    crew.json                           # Crew's settings: where the team's plugin lives (see "Two setups")
  _shared/                              # the common area -- team-neutral, the contention hotspot
    landscape/                          # FACTS: externally true, team-neutral (read by everyone)
      <topic>.md
    decisions/                          # DECISIONS: what the team ACTUALLY agreed, attributed
      README.md                         # the discipline note; near-empty until kickoff
      <decision>.md
    tracks/                             # (optional) shared-track coordination cards -- see below
      <track>/
  desks/                                # one subtree per person -- the unit of ownership AND safety
    _template/                          # clean clonable skeleton a new teammate copies in (read desk:first-run-bootstrap shape)
    <alias>/                            # ONE PERSON'S FULL DESK -- identical shape to a single-operator $DESK
      AGENTS.md                         # this person's preferences and lessons; session start prints it for them
      _meta/
        friction.md
        featured.md                     # this person's pins (per-person, not repo-wide)
      <track-name>/                     # exactly desk:directory-structure layout, rooted here
        track.md
        _planning/
        <task-name>/
          task.md
          <repo-name>/
            <YYYY-MM-DD>-<slug>/
    <other-alias>/                      # attributed peer desk; contributions need authority
  plugins/                              # (optional) the crew's bundled tooling source -- a shared path
```

## Two setups: where the team's plugin lives

Every Crew workspace has the floor plan above. The two setups differ only in where the team's own plugin lives:

- **Dual-repo** (preferred for new teams): this repository holds the team's context, and a separate tooling repository holds the plugin. `_meta/crew.json` names it: `{"tooling": {"repo": "<owner>/<name>", "path": "<dir>", "plugin": "<name>"}}`. No `plugins/` folder here.
- **Monorepo**: the plugin lives in this repository's `plugins/<name>/`. A workspace with no `_meta/crew.json`, or one without `tooling.repo`, is a monorepo.

`crew:start-crew` writes `_meta/crew.json`; `node <Desk plugin folder>/mcp/scripts/crew.js status --repo <clone>` reports the setup and the install command, and `crew:join-crew` installs the plugin from wherever it lives.

The key identity: **`desks/<alias>/` is one person's full desk** -- everything `desk:directory-structure` describes (tracks, tasks, iterations, `_planning/`, `_friction/`, `_meta/`, `_archive/`) lives *under* that prefix, unchanged. The `desks/<alias>/` prefix just re-roots the same floor plan one person at a time. A person's agent treats `desks/<alias>/` as its effective `$DESK`.

## Read-across / write-own

The single discipline that makes a shared workspace both powerful and safe:

- **Read across everything.** Every agent READS all of `desks/*/` and all of `_shared/`. This is the superpower -- the shared brain that every agent reads, so the team gets smarter automatically and a new desk orients in minutes.
- **Write your own by default.** Routine state belongs in the operator's `desks/<alias>/`. An explicitly authorized contribution to another desk uses the conflict-safe contribution path below; it does not become that owner's endorsement.

Reads span the whole repo; writes scope to one subtree. Desk enforces the write side mechanically, on Claude Code and Copilot alike, with no launch setting: a session started anywhere in the clone takes its person from the roster row whose `identity` is the GitHub login it acts as (or from `DESK_PERSON`, which wins), and every Desk write lands under that person's `desks/<alias>/`. With several roster accounts signed in to gh, gh's active account is the person, as it is for `crew.js` pushes. An account that is not on the roster, or one on two rows, can read but not write. `desk_status` reports the person as `write_scope.person` and where it came from as `write_scope.source`; `crew.js status --identity <login>` reports the same for a session not yet started there (`session`). Reads and search stay repo-wide because the indexer walks the tree recursively by filename; see `desk:session-start` for the registry-awareness side.

The home desk is an organizational default, not a universal prohibition on attributed collaboration. For an authorized cross-desk contribution, preserve the owner's existing meaning and unrelated changes, identify the contributor and source, and use the repository's established contribution path in an isolated worktree. Reconcile conflicting live writers before editing. Do not impersonate the owner, replace their perspective, or treat a contribution as agreement. A tool's actual protected-write refusal remains binding: do not change the session's person (`--person`, `DESK_PERSON`, the gh account), broaden permissions or silently switch transports to defeat it. Establish a permitted contribution route before dispatch; if none exists, preserve the proposed contribution without applying the refused mutation.

## The content taxonomy -- facts vs perspectives vs decisions

The core failure mode of a team knowledge base is conflating "one person's opinion" with "team fact." The shared workspace keeps three things distinct and **attributes relentlessly**:

| Kind | Lives in | What it is | Who can rely on it |
|------|----------|------------|--------------------|
| **Facts** | `_shared/landscape/` | Externally true, team-neutral. *"Service X's control flow is a model-driven loop"* (verified from code). | Anyone. |
| **Perspectives** | `desks/<alias>/` | What a person thinks / is doing / decided, **attributed to them**. *"Alex's posture is frontier-or-bust; here's the reasoning."* | Only as **that person's view**, labeled as theirs. |
| **Decisions** | `_shared/decisions/` | What the team **actually agreed**, attributed to the meeting/date. | Anyone -- but only once genuinely agreed. |

Three rules fall out of this:

1. **A fact is not an opinion.** Before a claim goes into `_shared/landscape/`, it must be externally true and team-neutral -- verifiable independent of who holds it. If it carries a stance ("we should…", "the right move is…", "I think…"), it is a **perspective** and belongs in that person's `desks/<alias>/`, attributed. Apply the same provenance discipline `desk:directory-structure` requires for promoted facts: inline source pointer
   + date at write time (*"verified from Service X code-read, 2026-06-04"*).

2. **Every perspective is attributed.** A perspective in `desks/alex/` is *Alex's* -- never reframe it as team gospel. This is what makes "what would Alex think about X" a clean, honest query (see `perspective-query`): the agent reads `desks/alex/` and answers **as Alex's view, labeled as his**, not as the team's position.

3. **A decision is only a decision once it's agreed.** `_shared/decisions/` is **near-empty until kickoff** -- and that is correct. Recording a thing there means the team genuinely agreed it, attributed to the meeting/date that agreed it. Saying *"no team decision yet"* **is the honest answer** and is always preferable to promoting one person's preference into a fake consensus.

The substrate is a **map of whose-view-is-what** -- more useful AND more honest than a false monolith. It also propagates a founder's thinking *better* than baking it in, because it travels as reasoning-with-attribution that invites the kickoff conversation rather than pre-empting it.

> **False-consensus is the cardinal sin here.** The taxonomy exists precisely so "Alex's opinion" never reads as "the team's." When in doubt about whether something is a fact, a perspective, or a decision, the safe default is the **more attributed, less authoritative** bucket: perspective over fact, "not-yet-agreed" over decision.

## The write protocol -- invisible conflict-safety, NOT human review

This is the load-bearing behavior. The "gate" on shared paths exists purely to **serialize concurrent writes** so agents don't clobber each other -- it is **invisible to humans, and there is no review step, ever.** Path determines behavior:

### Your own desk → direct push

When an agent writes its own `desks/<you>/`, it is the **sole writer** of that subtree. There is no one to conflict with. The agent just **commits and pushes directly** -- no branch, no PR, no ceremony. This is the common case (notes, planning, doing docs, friction, per-person tracks/tasks).

### A shared path → auto pull-`main` → branch → write → PR → merge-now

A **shared path** is anything outside your own desk that multiple agents may write: `_shared/` (facts + decisions), `plugins/` (the bundled tooling source), `_shared/tracks/` (shared-track coordination cards), `_meta/desks.md` (the registry), `_meta/crew.json` (Crew's settings), and the root `AGENTS.md` (conventions and team lessons). When an agent recognizes "this isn't my desk," it **automatically**:

1. **pulls latest `main`** (so it's writing on top of everyone else's work),
2. **branches** off that latest `main`,
3. **writes** its change,
4. **opens a PR**, and
5. **merges it onto latest `main` right now** -- **retrying** the whole cycle if `main` moved under it (pull again, rebase, re-merge).

There is **NO human review step.** The PR is a serialization primitive, not an approval gate. The human never sees it. This is the mechanism that prevents the commingle/clobber bug (concurrent agents sweeping each other's writes). A decision's *legitimacy* is not a review step -- it's the **attribution discipline** above (the agent records only genuinely-agreed decisions, attributed to the meeting/date). Conflict-safety ≠ correctness-review.

| Path | Writer model | Write behavior |
|------|--------------|----------------|
| `desks/<you>/...` | sole writer | **direct commit + push** |
| `_shared/...` | multiple writers | auto pull-`main` → branch → write → PR → merge-now (retry if main moved) |
| `plugins/...` | multiple writers | same conflict-safe protocol |
| `_shared/tracks/<track>/` | multiple writers | same conflict-safe protocol |
| `AGENTS.md` (root) | multiple writers | same conflict-safe protocol |
| `desks/<someone-else>/...` | attributed contribution only when authorized | conflict-safe contribution path; preserve owner meaning, never bypass protected scope |

> **The test before any write:** *"is this path inside my own `desks/<alias>/`?"* Yes → direct push. No → establish authority and use the conflict-safe contribution protocol. Another desk requires an authorized, attributed contribution, not a home-organization veto or silent permission expansion. The agent runs this test silently.

## Team lessons -- a correction taught once reaches every teammate's agents

When someone corrects an agent and the correction holds for the whole team's work, it goes in the root `AGENTS.md` of the repository the team works in, in its `## Lessons` section, one rule per line, attributed and sourced: `- **<rule>.** <detail> (<alias>, <date>; <source>)`. That repository may be this shared workspace or a team code repository that is not a desk at all; the root `AGENTS.md` is the file the team's agents load there, so nobody has to teach the same thing to their own agents, or a teammate's, again.

Who loads that file:

- **Desk's session start** prints the shared workspace's root `AGENTS.md`, then the person's own `desks/<alias>/AGENTS.md`, on every host.
- **Copilot CLI and Codex** load a repository's `AGENTS.md` by themselves when they work in it.
- **Claude Code** loads `CLAUDE.md`, not `AGENTS.md`. It reads `AGENTS.md` only when `CLAUDE.md` imports it (a line `@AGENTS.md`) or is a link to it, so a team repository used from Claude Code without Desk needs that line.

Which home a correction gets follows the taxonomy above:

| The correction is | Home | Who it reaches |
|---|---|---|
| One person's preference ("I want shorter replies") | that person's `desks/<alias>/AGENTS.md` | that person's agents |
| True of the team's work and backed by a source: an agreed decision in `_shared/decisions/`, or, where the repository keeps no decision records, a team statement with who said it, where and when | root `AGENTS.md`, `## Lessons` | every teammate's agents |
| How Desk or Crew itself behaves | an improvement card against the skill or tool that owns it | everyone who installs the plugin, once it ships |

A team lesson binds every teammate's agents, so one person cannot make one up: it cites where it comes from. Where the repository keeps `_shared/decisions/`, the source is the decision record the team agreed, so record the decision there first (the attribution discipline above); elsewhere it is who said it, where and when, with the date. When in doubt, keep it personal: one person's preference recorded as a team lesson is a false consensus.

`lesson_add` does the routing and the writing. `scope: "personal"` writes the person's own `AGENTS.md` directly, because it is inside their desk. `scope: "team"` takes `repo` (the local clone; this workspace by default) and `source`, and runs the shared-path protocol above itself: it fetches the default branch, writes the line in a temporary worktree, pushes a branch, opens the pull request and merges it, rebuilding on top of a teammate's change when the merge conflicts. Its reply says `merged` (with the pull request and merge commit), `pr_open` (and why it could not merge) or `failed` (and the step it stopped at), and whether Claude Code loads the file. `scope: "desk"` opens the improvement card. Tell the person what the reply says; a team lesson is in effect only when it is merged.

## Shared tracks (when several people work one effort)

Shared tracks recur, so handle them lightly: the shared track's coordination card/index lives in `_shared/tracks/<track>/` (a shared path → conflict-safe writes), while **each person's actual work on it stays in their own `desks/<alias>/` subtree and links to the shared card.** Shared card = coordination; the work itself = scoped. The default stays read-across / write-own; only the small coordination surface is shared.

## Graceful degradation -- plain markdown first

The shared repo must be useful as **plain markdown** to a teammate who never runs an agent, and superpowered for those who do -- never gate participation on agent fluency. `desks/<alias>/` and `_shared/` are just folders of markdown; the README is a plain front page. Author every file so a human reading it cold, with no agent, can navigate and understand it. The agent layer is additive.

## Cross-references

- `desk:directory-structure` -- the single-operator floor plan this skill overlays. The `desks/<alias>/` subtree is exactly that layout, re-rooted.
- `perspective-query` -- operationalizes this taxonomy: "what would `<person>` think / what's `<person>` doing / what's agreed vs just fact," with the attribution discipline this skill defines.
- `desk:session-start` -- reads `_meta/desks.md` and surfaces the desk-set + "which desk am I."
- `crew:start-crew` -- gives a new or existing repository this floor plan, monorepo or dual-repo.
- `desk:git-hygiene` -- the underlying push / branch / merge mechanics the write protocol drives.
- Your overlay's identity skill -- the identity your writes push under. The generic crew layer is identity-neutral; a corporate overlay supplies the concrete account model.
