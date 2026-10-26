---
name: lesson-capture
description: After a task reaches `done` or a non-trivial iteration, mine its records for lessons and record each with `lesson_add` where it takes effect.
---

# lesson-capture

the small reference shelf by the window is where lessons go. when a piece of work wraps up — a task closes, an iteration ships, something clicks into place during retrospect — i sit with my own paperwork from the job, read it back, and decide which bits of it earned a place on the shelf. future-me will pull a volume down and be glad the work didn't get lost in the move.

designed for long-lived autonomous agents (ouroboros, personal agents) where the operator doesn't manually curate every friction. corporate-worker overlays typically use `friction-management` (operator-driven); ouro agents typically use both.

## When to invoke

- task transitions to `done` (lifecycle state change)
- an iteration ships and i have bandwidth before the next one
- i notice a pattern recurring across multiple recent tasks
- an operator explicitly asks ("review your own work and capture lessons")

do NOT invoke during in-flight work — wait until the iteration is committable. the shelf is for things that already happened.

## What gets read back

for each iteration of the just-completed task, i pull the paperwork:

1. **`planning.md`** — scope decisions, alternatives rejected, assumptions made
2. **`doing.md`** — the executed plan; especially where it diverged from planning
3. **`feedback.md`** — operator's marks, PR review responses; corrections worth encoding
4. **`artifacts/`** — supporting files; sometimes contain debug logs / decision rationale not in the docs
5. **commit messages** — `git log --oneline <iteration-branch>` for the actual change shape

what i'm looking for:

- **mistakes i made** — wrong assumption, missed check, premature optimization, dropped consideration
- **patterns that recurred** — same correction across multiple commits, repeated "i keep hitting this"
- **anti-patterns surfaced** — pre-existing behavior that proved costly during this iteration
- **new conventions discovered** — operator-confirmed shapes that aren't yet in skill bodies
- **cross-skill conflicts** — places where two skills' guidance disagreed and one had to give
- **a rule that keeps being broken** — the surrounding process shape is pushing against it; propose the process change (reorder a step, add a phase), not a louder restatement of the rule

## Waste the evaluator found

when the job reported to a factory store, its job report there carries the evaluator's waste labels and the job's measures (tool failures, retries, defects, flow efficiency). waste whose cause is the shared system (Desk, a skill, a tool, the factory) is not a private note: propose a kaizen card for it by recording a kaizen candidate with `friction_add` and `about: "system"` (no `file_card`), the plugin and friction class, the measure the waste moved as `signal`, and the job ids as `evidence_jobs`, worded generically per `friction-management`. lesson-capture never files a card itself: the candidate opens its own improvement card with no signoff, the loop's mirror step files the store issue, and the store's build then checks the countermeasure against that measure once it ships. waste whose cause is this desk's setup, or the work's own subject matter, follows the rest of this skill.

## Output: lessons that take effect

each lesson worth keeping lands through `lesson_add`, which puts it where something loads it. pick the scope by whose behaviour it changes:

- **personal** — this operator's preference. it becomes a line in their AGENTS.md, which session start prints.
- **desk** — how Desk's tools or an installed plugin's skills behave. name the `owner` that carries the behaviour (`skill:<plugin>:<skill>` for any installed plugin, overlays included; `tool:<name>`, `brief` or `foundation`); the tool records system friction against it and opens an improvement card, which the improvement loop turns into a pull request.
- **team** — every teammate's agents in a repository the team shares: a Crew workspace, or a team's code repository that is not a desk. pass `repo` (your local clone; the desk itself is the default in a Crew workspace) and `source`: the `_shared/decisions/` record where the repository keeps them, else who said it, where and when. the tool writes the line into that repository's root AGENTS.md through a pull request and merges it, and says `merged`, `pr_open` or `failed`. Copilot CLI and Codex load a repository's AGENTS.md; Claude Code loads it only through CLAUDE.md, and the reply says which.

the **owner** call is a `content-routing` decision — operator-specific stays in the workspace; a general lesson goes to the plugin layer that owns it; within a plugin, the always-on foundation vs a triggered skill.

each lesson is one rule on one line, with its evidence quoted in the desk note or the improvement card's friction entry. tell the operator what the tool's reply says (`in_effect` and `message`), never "this is now a standing lesson" on your own word: a lesson nothing loads is not kept.

a correction the operator gave is theirs, so record it straight away. a lesson i inferred from my own paperwork is a proposal: personal and team lessons wait for the operator's confirm; a desk lesson goes to its improvement card, whose pull request is the review.

## Relationship to friction-management

| dimension | friction-management | lesson-capture |
|-----------|---------------------|----------------|
| trigger | operator pins a card to the corkboard | agent reads its own paperwork after a task wraps |
| driver | operator | agent |
| encoding decision | operator + agent in same pass | agent proposes; operator (or self-authorized agent) confirms |
| cadence | reactive (when friction happens) | periodic (post-task) |

both end in the same place: a change where it is loaded — a line in an AGENTS.md, or an improvement card that ships a change to a skill or tool (or a no-op-with-reason if the lesson doesn't warrant encoding). they're complementary, not competing. the corkboard catches the live snags; the shelf catches the slow-cooked lessons.

## Hard rules

1. **don't fabricate lessons.** if i read three iterations and find no real lesson, i say so. quiet completion is better than forced output. the shelf isn't a quota.
2. **quote evidence.** each proposed lesson cites the artifact(s) that surfaced it. no inference without source.
3. **concrete landing place.** "should probably go somewhere" is not actionable. name the scope, and for a desk lesson the owner `lesson_add` takes.
4. **don't over-encode.** a single mistake during one iteration usually isn't a rule worth shelving. wait for the second occurrence — OR explicitly note "first occurrence; flagging in case of recurrence" without yet proposing encoding.
5. **respect existing rules.** before proposing a new rule, check if an existing skill already covers it. if yes, the proposal is "make the existing rule stickier" (e.g., promote it from a triggered skill into the always-on `using-desk` foundation) rather than "add new rule."

## What this skill does NOT do

- it does not modify skill bodies directly. a desk lesson reaches a skill through its improvement card.
- it does not log itself as friction. the lesson IS the output; friction-management handles operator-surfaced pain points separately.
- it does not run on every task. lightweight tasks (one-commit fixes, mechanical rebases) typically have no lessons worth shelving. pick its moments.

## Inspired by

AIDLC's `continuous-improvement` skill (auto-update target instruction files post-session). adapted for desk's agent-vs-operator-driven distinction.
