---
name: pr-self-review
description: Thorough read-only review of your own PR when the operator asks for a self-review or polish pass. Findings feed the one Superpowers review cycle. Not a substitute for required reviewer approval.
---

# pr-self-review

Invoke `desk:using-superpowers-with-desk` and `superpowers:requesting-code-review`. The phases below supply the PR-specific rubric. Remediation and affected re-review belong to that one review cycle on the current candidate; the loop below is a detail of that cycle, never authority for a second fix owner or loop.

## Invariants

1. **Borrowed rules, one method.** Read the repository's `AGENTS.md` or `CLAUDE.md`, code standards and personas, falling back to the baseline rubric below. Preflight, evaluation, fact-check and report feed `superpowers:requesting-code-review`; the same Superpowers owner applies authorized changes and records every finding's disposition.
2. **Best model for every stage.** A cheap stage contaminates every stage after it.
3. **Thoroughness over speed.** No latency budget; a huge PR may take days. Narrow the scope (a file, a subsystem) rather than sample the diff or skip fact-check.
4. **A finding is a finding.** Output is `feedback.md`-compatible, so `pr-feedback-on-own-pr` handles self-review findings exactly like reviewer threads.
5. **Stable rule IDs** of the form `<PREFIX>-NNN` (`PSR-` for this skill's baseline, `PSH-` for `pr-surface-hygiene`, a repo prefix for its standards). Never renumber.
6. **One convergence owner.** `superpowers:requesting-code-review` owns finding disposition and affected re-review, with one implementation owner for all fixes. Nothing here enlarges delegation or turns an intentional alpha endpoint into main promotion.
7. **Collaborate first.** Run only after the operator and agent have worked through the PR together; if invoked earlier, say so and stop.

## Phase 1: Preflight

Build the context bundle the evaluator reads. Per repository (no cross-repo merging):

- `diff`: `git diff origin/main...HEAD` (three dots, so only what the branch adds), and `annotated_diff`, the same with file line numbers so findings can be checked.
- `rules`, merged from, in priority order for conflicts: the repo's `AGENTS.md` or `CLAUDE.md`; `plugins/<plugin>/repo-knowledge/<repo>/code-standards.md`; `.vscode/copilot/personas/*.instructions.md`; the baseline rubric. Keep a `rule_source_manifest` of which sources contributed.
- `plan_excerpt`: only the planning doc's `## Scope` and `## Completion Criteria` (or `null`), and `doing_excerpt`: the unit list, for context only. Plan coverage is not this skill's job.
- `deferred_items`: decisions already taken in this loop (empty on the first pass; see the loop).
- `repo_root`.

## Phase 2: Evaluate

One evaluator pass over the bundle; it may re-read cited files for more context. Each raw finding has `rule_id`, `severity` (`blocking`, `recommended` or `nit`), `resolution_path` (set in Phase 4), `file`, `line`, `title`, `body`, an optional `suggested_fix`, and `grounding_verified: false`.

- **Sub-threshold signals.** When the evaluator's reasoning says it considered flagging X and didn't, treat X as a candidate. If a cold reviewer would plausibly flag it, fix it cheaply now or report it as sub-threshold but likely visible. Ignore only the purely hypothetical.
- **Baseline rubric** (`PSR-001` to `PSR-005`, used only when no other source applies): null safety, deliberate error handling, a test for each new public function, unused imports, obvious typos. Nothing about naming, layout or idiom; those are repo conventions.
- **Names carry contracts.** A C# `Try*` method that throws outside cancellation paths, or a `Get*`, `Find*` or `Parse*` that silently returns `null`, is a `recommended` finding, whether or not the diff introduced it. If the throw tracing is uncertain, ask ("is this a Try-pattern violation?").
- **Walk into helpers.** When a catch, log, metric, audit or telemetry block calls a helper with the same exception or argument, read the helper for a double log or double emit; read helpers called within five lines of any candidate. If the helper's source is not available, ask.
- **Author comments are hypotheses.** For `// intentional`, `// by design` or `// parallel to X`, ask whether you would flag the code without the comment; if so, flag it with the comment's rationale in the body. Read the code the comment points to; the same pattern there doubles the signal.
- **New abstractions and provenance.** For a finding about a new abstraction, helper or pattern, or a claim about where code came from, apply `pr-review-interrogation`.
- **Tone.** A suggested comment or inline pin states the rationale a future maintainer needs ("X is shaped this way because Y"; "chose A over B because C"), never a rebuttal ("Do NOT flag this").

## Phase 3: Fact-check

Re-open each cited file at the cited line in the working tree. Keep a finding only if the line exists, the code matches the description and the issue is real in this context; set `grounding_verified: true`. Drop the rest silently. Check each finding independently, even when batched by file, with the best model.

## Phase 4: Report

A finding is `resolution_path: auto` only if the fix is deterministic, stays inside the flagged code (no public API or contract change), reverts in one commit and is right regardless of business judgment. Otherwise, and whenever unsure, it is `human`. Missing null checks, unused imports, a missing test, an off-by-one and a convention rename are `auto`; splitting a class, a retry strategy, API composability, missing telemetry and "consider another approach" are `human`.

**Test style is agent-owned:** framework within the project's choice, assertion style, Arrange-Act-Assert labels, `[Fact]` versus `[Theory]`, mock library, fixtures, naming and helper extraction are `auto`. Still `human`: adding or removing tests of real invariants, changing tests for a contract change, sweeping many files, or a change contested between two live conventions. Run the project's coverage gate before and after any test-style change that could move coverage, and keep it above the threshold.

**Pins for `human` findings.** When the operator decides to accept, defer or leave a `human` finding, add or strengthen an inline rationale pin at the flagged location, following `pr-feedback-on-own-pr` ("Pinning no-op decisions in code") and `operator-voice-comments`. The pin explains why, stands alone, has a rationale-first tone and sits where a reviewer would flag it; for a cross-file finding, pin each site or add a central note with a short pointer at each site. Re-read the pin cold: if you would still flag the code, strengthen it. A teammate's reviewer reads the PR without your context, so the pin, not the deferred list, is what carries the decision.

**Output.** Each finding, in a shape `pr-feedback-on-own-pr` reads as a synthetic thread:

```yaml
- thread_id: self-review-001
  source: pr-self-review
  iteration: 1
  rule_id: REPO-STD-007
  file: packages/foo/src/bar.ts
  line: 142
  severity: blocking | recommended | nit
  resolution_path: auto | human
  title: "short title"
  body: |
    explanation
  suggested_fix: |
    optional
  grounding_verified: true
```

Write `artifacts/pr-self-review.md` (by file, by severity, fixes inline) and `artifacts/pr-self-review-findings.json` in the iteration folder on the desk, rewritten each pass; Git keeps earlier passes.

## The convergence loop

When the operator says "ready": run Phases 1 to 4; hand the `auto` findings to `pr-feedback-on-own-pr` in `auto-apply-only` mode (no operator confirmation, no thread replies, only `auto` findings; it returns what it applied, what it skipped and whether code changed); run the repo's local verification gate (`git-hygiene`, "Pre-push gate"); commit and push; repeat. Each pass re-runs every phase on the new diff and re-verifies against the current tree.

- **Pipeline.** After pass N is pushed, start pass N+1's reviewer in the background on that head while you apply fixes. Skip this on a docs-only pass. Early passes may run several reviewers (code quality, security, tests); drop to one or two as findings plateau.
- **Deferred list.** After each accepted, deferred or left `human` finding is pinned, add one line to `artifacts/deferred-items.md`: what was decided and where its pin lives. Reviewer prompts include it under "known-deferred — do NOT re-flag UNLESS the deferred item's context has materially changed in this iteration's diff". A list entry without a pin is not enough.
- **PII is blocking.** User object IDs, emails and user names stored in entity tables or written to logs halt the loop for the operator. Tenant IDs, system IDs and hashed or anonymized identifiers are fine.
- **Different model.** Prefer a reviewer model other than the one that wrote the code.
- **Interrupt.** On "pause self-review", "stop the loop" or similar, finish the current pass to a clean tree, stop and report.

The loop stops, and you report which condition fired, what was applied across passes, what remains and any safeguard that came close, when: no findings remain; only `human` findings remain; a pass applied no code change; 10 passes ran (the default cap, tunable); the same `rule_id`, file and line survived two passes in a row; successive passes touch more files or lines than the first (scope creep); a fix broke a test that passed before; or the operator interrupted.
