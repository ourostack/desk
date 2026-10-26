---
name: pr-feedback-on-own-pr
description: Work through requested review feedback on the operator's own pull request and route fixes to the implementation owner. Not for another author's PR.
---

# pr-feedback-on-own-pr

Use when the operator asks to iterate on a PR's review feedback ("comments", "iterate", "address feedback", "review pass"), or when session start finds new active threads on a PR the operator tracks. Confirm which PR first: with no feedback run in progress, ask which PR and list the active tasks' PRs; with one, say which PR, phase and next step you are resuming; with several, list them and ask. The prior session may have worked on a different PR.

## Three documents

Each feedback iteration keeps three files in its iteration folder; each owns one concern, and the others point to it instead of restating it.

| File | Owns |
|------|------|
| `feedback.md` | What was agreed, per thread: the bucketed thread table, shape view, each thread's `proposed_action` and `action` tag, the sweep table, the pipeline log and each thread's final disposition. |
| `planning.md` | The iteration's scope and completion contract, kept by the Superpowers owner; context, dependencies and risks stay on the desk. |
| `doing.md` | How it is executed, unit by unit and test-first: signatures, test names, acceptance criteria, `Addresses: #threadIds`, the completion line it satisfies, its sweep sites and a progress log. |

Commit and push the desk after every edit to these files, so a new session can resume from `feedback.md` alone. Its top says the phase, start and update times and the next action, then a checklist of the nine phases, then the tables below.

## Modes

- **`interactive`** (default) runs every phase, with operator confirmation set by `approval_checkpoint`.
- **`auto-apply-only`** is called by `pr-self-review`'s loop. Only the synthetic self-review threads are in scope (real threads are read for awareness); phases 2 to 5 are skipped; each `resolution_path: auto` finding becomes one unit; fixes go to the one Superpowers implementation owner through `desk:using-superpowers-with-desk` with strict test-first work and the recorded publication authority; phase 8 runs normally; phase 9 only marks each applied finding addressed in the findings file. Return which findings were applied, which were skipped (for example, a fix that broke a test) and whether any code changed. Pass the loop's `deferred_items` list verbatim, under the same "do NOT re-flag UNLESS context has materially changed" header, to any child that applies fixes.

## Preferences on the task card

```yaml
pr_feedback_prefs:
  approval_checkpoint: architecture-and-behavior-only  # or: always | none (auto-apply-only acts as none)
  reply_format: behavioral   # "Addressed — <what changed>. <why it matches the ask, if not obvious>." SHA only if the reviewer needs a hunk.
  thread_close_policy: agent-closes-when-addressed     # or: agent-replies-operator-closes; the operator can override per thread
```

## Buckets

| Bucket | What it is | Operator confirms? |
|---|---|---|
| architecture | Refactor, split, move logic between layers, change a type's shape | Yes |
| behavior | Change what the code does (null handling, mapping, validation, log content) | Yes |
| doc | Redundant or leaky doc comments, a missing "why" | No |
| clarification | A question, not a change request | Reply first, no edit |
| nit | Small style or naming change | No |
| auto-comment | Bot output | See phase 2 |

## Phase 1: Gather

Pull every active thread from the PR host's review and comment API, write `feedback.md`, and propose a bucket for each row; classify a thread by its most recent human comment. If `artifacts/pr-self-review-findings.json` exists, add each finding as a synthetic thread: its `thread_id` as id, author `pr-self-review`, bucket `nit` or `doc` for `auto` findings and `behavior` or `architecture` for `human` ones, its file, line, body and suggested fix, and a `proposed_action` from its title. Synthetic threads go through every later phase like real ones; only phase 9 differs.

## Phase 2: Bot comments

Triage each bot thread by its body, not its author, because several services can post under one identity.

| Bot | Body signal | Action |
|---|---|---|
| Ref update | "The reference refs/heads/... was updated." | Resolve silently. |
| Coverage or test service | Build or coverage output | Leave active; it clears when the gate turns green. |
| Privacy scan | A privacy-defect header and a pattern-match line | Default false positive. If the flagged line is plausibly real and this PR touched it, ask the operator "fix, false positive or pre-existing?". Never create follow-up items yourself. |
| AI review | An AI review badge, an embedded assistant span or a ` ```suggestion ` block | Reviewer feedback: bucket by content and walk it through. Never close it as noise. |
| Any other bot | | Ask the operator, in one batch. |

Read the first 100 to 200 characters of a body before closing any bot thread. If you closed an AI-review thread by mistake and the environment denies a reopen, that denial is correct; walk the thread through as it is and let the operator reopen it.

## Phase 3: Shape

Give the operator a shape view, not per-item proposals: two to five themes, which clusters gate which, the critical path, what could be deferred without blocking merge, the principles the feedback implies, and open questions. Discuss it as a conversation (`interaction-style`); a continuation message is agreement enough. Record it in `feedback.md`, "Shape view".

## Phase 4: Walk-through

Walk only the items the shape decisions did not settle, in dependency order; record the rest as `resolved-by-shape`. Nits and docs apply without discussion; architecture and behavior wait for the operator (`approval_checkpoint`). Do not act on each sentence of a correction separately (`interaction-style`, "Respond before editing"). Every reply, draft and inline pin follows `operator-voice-comments`.

Each thread gets one category:

| Category | Signal | Action |
|---|---|---|
| Code change requested | A directive about the diff | Plan it; it lands in phase 7; the phase 9 reply names it. |
| Question about code | "Why X?", "what does this do?" | Write `DRAFT REPLY:` for the operator. Never post it yourself; they may post it, rewrite it or change the code instead. |
| Needs human decision | Scope, architecture, product or an ambiguity the diff cannot settle | Write `NEEDS HUMAN: <author> on <file:line> — <summary>` and do nothing else. |
| Nit or style | Trivial formatting or naming | Apply if clearly better; otherwise ask. |

Each confirmed thread also gets an `action` tag, which phase 9 obeys. Every reply below is posted only after the operator approves its exact text (`operator-voice-comments` owns that rule):

- `post-and-resolve`: an explanation, or a `resolved-by-shape` change. Post the approved reply, then resolve.
- `post-and-stay-active-until-{unit}`: a code change scheduled in a unit. Post the approved "Addressing by doing X" and leave the thread active; after the unit lands, post the approved follow-up with the commit on the same thread, then resolve. Resolving on the promise lies about the state and breaks the reviewer's filter on active threads.
- `post-and-leave-open`: an open or human decision. Post the approved framing ("checking with X") and leave it active.

A thread leaves this phase `confirmed` with a `proposed_action` and an `action`, `resolved-by-shape`, `pending-clarification`, `draft-reply-pending-operator-approval` or `needs-human-decision`. If two human comments conflict, stop until they are reconciled. With more than 20 human comments, walk them in batches of about ten. For a comment on code the PR only touches nearby, ask whether it is in scope; if not, reply "pre-existing, follow-up tracked in `<tracker-id>`". If an architecture change would undo a unit the PR already built, give the operator the cost before planning.

## Phase 5: Sweep and bake in

- **Sweep.** For each confirmed item, search the whole PR diff for every other site the same rule covers; a single-site fix is a bug. Record `pattern → [file:line]` in the sweep table and each thread's sweep sites.
- **Bake in.** For each confirmed human comment, write the "do it right the first time" rule into the track's `_friction/` (even if it is "see rule X"), so the next PR does not draw the same comment.

## Phase 6a: Plan

Plan through `desk:using-superpowers-with-desk`, reusing the existing plan and approval: `superpowers:brainstorming` for missing architecture agreement, `superpowers:writing-plans` when a plan is needed. Shape a non-trivial plan as a dependency graph of units with the critical path and parallel branches marked; three linear units can be prose. Every unit lists its sweep sites, and every `post-and-stay-active-until-{unit}` thread appears as its own acceptance line in that unit: "Post follow-up reply on thread <id> referencing the landed commit, then mark thread Resolved."

Run at least two skeptical passes on the plan and fold in what they find, in a `## Skepticism passes` section: what breaks the plan (hidden coupling, timing, branch drift, untested paths, likely reviewer pushback), and where a reviewer with no context would flinch. Say so explicitly when a pass finds nothing. Then attest at the top of `planning.md` that every disposition has a unit, the passes ran and were incorporated, and no architectural question is open, and continue. Stop for the operator only when a disposition has no unit (go back to phases 3 and 4 for it), a pass raises a genuinely new architectural decision, or a prerequisite is missing (an unmerged dependency, a server down, an expired sign-in). Wanting to be safe is not a reason to stop.

## Phase 6b: Re-fetch before executing

Pull the active threads again and compare them with `feedback.md`. Bucket and assign any new thread to a unit before execution starts. Do not re-fetch between units.

## Phase 7: Execute

The same Superpowers implementation owner makes every fix, following the plan and its delegation limits. `superpowers:requesting-code-review` on the current candidate owns finding disposition and affected re-review; this skill does not start another fix loop. Strict test-first work, repository checks and the recorded publication endpoint apply. No code changes before this phase. Push each unit's commits as they land (`git-hygiene`), mark the unit done in `doing.md` with a progress entry, and tick `planning.md`'s completion criteria from landed evidence at the end.

### Pinning no-op decisions in code

When a reviewer finding or a self-review finding is decided as no change, defer or keep as is, add a short, lasting comment at the cited line that explains why. Not pinning is the exception, because an unpinned decision is re-flagged by every later reviewer.

- **Place it** at the line a reviewer would flag. For a smell across many files, use one top-of-file or module note with a pointer at each site.
- **Write the rationale, not a rebuttal:** "Non-nullable bool on the GET response even though PATCH uses bool? — consumers treat unset and false the same, so the tri-state never surfaces." Never "Do NOT flag this", "Reviewers have suggested X" or "Stop proposing changes".
- **Exceptions:** a genuine "later" is a TODO, not a pin; a missing feature, test or log has no line to pin, so record the decision on the task card; a pure judgment call with no code rationale goes on the task card instead of an invented rationale.
- **Re-read the pin cold.** If you would still flag the code, strengthen or move the pin.

## Phase 8: Pipelines

Every required pipeline green and coverage at or above its gate, with no cap on attempts; ten or more rounds on a large repo is normal. Return to the operator only for a blocker that needs them (`interaction-style`), never for a count. Log every run, green or red, as a row in `feedback.md`:

| # | push SHA | pipeline(s) | status | failure mode | diagnosis | remedy | outcome |
|---|----------|-------------|--------|--------------|-----------|--------|---------|

Diagnoses: `flake (matches prior fingerprint)`, `flake (new)` with enough detail to match later, `stale-main`, `real regression (compile)`, `real regression (test)`, `coverage gap`, `formatter`, `environment`. Keep repo-specific failure fingerprints in the repo's notes file.

- **Infrastructure or code.** A timed-out or disconnected agent, a network or registry error, a cancelled job with no code error, disk, container or out-of-memory failures, and service errors with no compile or test trail are infrastructure: re-run the check (for example `gh run rerun`) instead of pushing a fake fix, log it as `environment`, and count it separately from code fixes. After two re-runs of the same build, tell the operator it needs CI platform support. Compiler errors, assertion failures with repo stack traces, lint, format and coverage failures need code.
- **Waiting.** Wait for long pipelines with one backgrounded poll loop that fires once: it refreshes its sign-in each tick, ticks every three to four minutes, and exits 0 when done or 1 on a hard timeout. Never re-dispatch helpers that report "still running" without waiting. In shell polling, filter JSON with `jq` or Python rather than `--query`, pass JSON through a temp file, use a quoted heredoc for inline Python, write with `json.dump(data, sys.stdout)`, and treat one failed tick (`2>/dev/null || echo '[]'`) as "try again".
- **Run phase 9 alongside.** After the last unit is pushed, verify threads while pipelines run; replies cite stable commits. Update a reply only if a pipeline fix changes a unit's landed shape.

## Phase 9: Verify each thread

Pull the threads once more and handle any new one first. Then, for each human thread in dependency order, read the reviewer's ask, the `proposed_action`, the `action` tag, the assigned units and the landed diff. The landed code must satisfy the ask; intent does not count. If it does not, go back to phase 6a or 7, never resolve with caveats. If it does, draft a behavioral reply (what changed and why it meets the ask, without restating the reviewer's words or sounding defensive). Show the operator every drafted reply with its thread in one batch, post only what they approve, word for word, under `operator-voice-comments`, then resolve or leave each thread active as its tag says. A synthetic self-review thread has no PR thread: mark its finding addressed instead. The phase ends when no human thread is unresolved; skip a thread the reviewer closed, and mark an operator-skipped one `operator-skip`, with an approved reply pointing at the decision.

- **Links.** Reference other PRs and issues with the host's auto-link syntax (`#<id>` on GitHub; `!<id>` for GitLab merge requests), not raw URLs or "PR <id>". A reply on a thread may cite that thread's file and line; leave out unrelated test counts, unit numbers and timings (`pr-surface-hygiene`).
- **Duplicates.** After any flow that created threads, list the PR's live threads and look for copies of the new content (a retry can leave an earlier post). Keep the one the description links to or the newest; delete the duplicate's comment and close the empty thread.
- **Bulk edits of a comment.** Replace matches with nothing rather than placeholder prose, and count matches before and after: a non-zero count after means the pattern missed, and a length change that does not match the matches means it hit something else.

## Hard rules

- Each phase produces its own kind of output: analysis while shaping, proposals in the walk-through, code in phase 7, replies in phase 9.
- No code edits between phases 1 and 7.
- Every confirmed human comment is swept and baked in.
- Phase 9 loops over landed code; a promise never resolves a thread.
- A permission denial or unreachable service is a real reason to return to the operator (`interaction-style`).
