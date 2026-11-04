---
name: pr-surface-hygiene
description: Rules for writing and auditing PR descriptions and comments. Use before drafting, opening or marking a PR ready, and before publishing comments.
---

# PR surface hygiene

People who did not watch a PR get written read its description and comments, often long after. Content that rots faster than anyone refreshes it misleads them, and content a pipeline already enforces is noise. Findings from `pr-self-review` and other evaluators cite these rules as `PSH-NNN`.

In scope: the PR description, top-level PR comments and replies not inside a reviewer thread. "PR ready" chat posts follow their own section below. Out of scope: replies inside a reviewer's thread (the thread anchors the location), commit messages (the spirit still applies), doing logs and task cards.

## PSH-001 — pipeline-enforced signals belong to the pipeline

If a required pipeline or branch policy enforces it, leave it out of the description: test pass counts (`[x] 312/312 green`), integration results, diff-coverage percentages, formatter and lint gates. `## Test plan` holds only human validation: manual runbooks ("INT smoke: hit X then Y, verify Z"), spot checks against dashboards, queries or logs, items a reviewer should verify, and things no gate checks (backward compatibility, rollout, runbooks, dark-launch switches). Open the section with:

> _Pipeline-enforced coverage (unit + integration + diff-coverage + style) is signaled by required-pipeline green. Items below are human-validation only._

## PSH-002 — stable anchors, not brittle inlines

| Brittle | Stable |
|---|---|
| `(12 tests)` after a unit summary | The test class or a `--filter` string, or nothing |
| `GraphServiceAdapter.cs:2745` | `GraphServiceAdapter.UpdateChannelAsync` |
| "the third unit" or other doing-doc numbering | The unit's name or the behavior it landed |
| "p99 ~42 ms on my dev box" | A link to the production dashboard |
| `312/312 green` | Pipeline green (PSH-001) |
| An undated timing from development | Dated, scoped evidence, or nothing |

Method and class names, thread IDs, test filters and behavior descriptions survive reformatting, refactors and archiving.

## PSH-003 — verify tracker citations; cited items must stand alone

Before citing a work-item ID in a description, comment or commit, read the item and confirm its title fits the role you cite it for, its state is what you expect and its body is not empty. Two follow-ups with similar wording are easy to swap; keep a one-line ID-to-title cheat sheet in the iteration notes. The cited item must explain itself: the scenario, what is still unknown, the evidence or telemetry shape, the decision rule for each outcome and where it came from. Fill an empty body before linking it.

## PSH-004 — say which kind of "agents" you mean

"Agents" can mean the reader or the reviewer's helper. Write `For agent reviewers: ...` when the agent is the reader, and `**Tip:** have your agent ...`, `Have your agent ...` or `Agent-assisted review: ...` when it helps a human. Never a bare `Agents: ...`.

## PSH-005 — write for the fresh reader

Lead with orientation, then substance, then the action. Cut:

1. **Self-referential glue** about how this artifact relates to another ("This comment is the per-step trace of what the description claims"). Start with the substance ("Per-step trace of the X chain").
2. **Decorative counts, SHAs and timelines** that do not help the reader navigate ("19 fail-fast steps" before a table that counts them; "against current HEAD (b390b8a418)"). Prefer method names even where a line range would help.
3. **"Updated for HEAD X" footers.**
4. **Pre-emptive defense** of a choice the reader has not questioned ("One PR by design — splitting would lose composition"). Chat posts are the exception (below).

If a fresh reader would ask "what does the author mean by X?", rewrite or drop it. Give each precise value (count, SHA, range, date) one home; anything else links to it.

## PSH-006 — no fabrication

Calendar timelines, historical specifics, code-mechanism claims and bot-derived urgency follow [`operator-voice-comments`, "No fabrication"](../operator-voice-comments/SKILL.md#no-fabrication).

## PSH-007 — "out of scope" means this repo

List only items that are in the same repo, could have been part of this diff and were deliberately deferred with a tracked reason. Ask: "if this were done, would it land in this PR's repo?" If not, it does not belong in the list. Cross-repo context goes in the "What" section as one line of track framing ("Part of [Feature N]; this is the <repo> piece. The AdminUX side ships separately as <Task M>."), without prose about why the work was split.

## PSH-008 — use the repo's template and convention

Before opening any PR, look for a template (`.github/PULL_REQUEST_TEMPLATE.md`, `.github/PULL_REQUEST_TEMPLATE/*.md`, a root or `docs/` `pull_request_template.md`, or the host's equivalent) and read the last two or three merged PRs, which show the real convention; if the operator has written PRs in the repo, mirror theirs. Never invent sections (`## Problem`, `## Background`, `## Validation`) where a template or convention exists. Without either, a short `## What` and `## Why` is the safe default.

## PSH-009 — one body for human and agent readers

Anything both people and agents read (PR descriptions, bug reports, runbooks, status posts) gets one canonical body. No "For your AI agent" or "Agent prompt" section and no JSON or YAML that mirrors the prose: a second copy drifts. Use stable headings ("Repro", "Acceptance criteria", "Suspect code surface"), put queries and commands in code blocks and references in tables, and use `<details>` for depth humans skip. A separate machine-readable attachment for tooling is fine.

## PSH-010 — visual proof blocks creation and readiness

Before opening a PR (including a draft), marking it ready or saying it is ready for review, read the full diff and classify whether it changes anything a person sees, including rendered documents, replies, errors and settings. The PR body must contain an inline image of the actual changed result, or a standalone `No visual change: <specific accurate reason>` for wholly nonvisual work. A link to an image, a comment elsewhere, a terminal success line or a promise to add proof later does not satisfy this gate. A visible change cannot use the reason as a bypass; privacy is not a no-visual-change reason.

Run the bundled checker against the exact body to publish, using the actual loaded skill directory and an existing body file:

```sh
node <loaded-desk-plugin>/skills/pr-surface-hygiene/check-visual-proof.cjs --body <pr-body-file> --visual-change yes
```

Use `--visual-change no` only after confirming the full diff is nonvisual. A nonzero exit blocks publication or readiness. The checker accepts HTTPS Markdown images, reference images and quoted HTML `<img src="...">` images; it rejects common comment/code examples and placeholders. It is a conservative presence check, not a Markdown renderer or proof that a URL loads, a capture is genuine or a reason is true. Inspect the rendered body, open the images with the intended reviewer access and check their relevance and privacy. Badges, unrelated images, hidden markup and stale captures do not count even if the checker passes. Replace unsupported markup with a plain inline image; do not skip the check.

After authorized creation or a body update, read the saved body back from the PR, rerun the same check and inspect its rendering. Repeat against the current diff and saved body immediately before a ready transition or review announcement; earlier success does not cover later edits. If published proof is missing or invalid, block the readiness claim, report the gap and correct it only within existing authority. This gate never grants permission to create, edit or change a PR's state.

For private captures, use [`evidence-discipline`, "Privacy-safe rendered proof"](../evidence-discipline/SKILL.md#privacy-safe-rendered-proof). If safe proof cannot be produced, keep readiness blocked and state what remains unverified.

## PSH-011 — offer repository enforcement; do not install it by default

When the repository lacks equivalent enforcement, recommend the [opt-in PR template and CI check](repository-setup.md). Offer setup once in the current task; a PR-writing request does not authorize changing repository workflows, templates, required checks, permissions or user-wide rules. Preserve existing templates and policy. Install only within explicit repository-owner approval, and leave required-check settings to their authorized owner.

## Allowed specifics

- A reply inside a reviewer's thread may cite that thread's line or quote its code.
- Dated, scoped evidence ("INT, 2026-04-22 14:05, my-dev-tenant") is fine.
- A number that is part of the behavior ("retries up to 5 times", "cache TTL is 30 seconds") is fine.

## Check every line

Whether you are writing a surface or auditing one another owner drafted (for example `artifacts/pr-description.md` from the Superpowers owner, before authorized publication through `desk:using-superpowers-with-desk`), ask of each line: does a required pipeline already enforce this? Will it rot before the PR closes? Will it still be true in six months? Is there a stable anchor that says the same? Fix or drop any line that fails; edit the draft in place before the PR opens, when fixing is cheap. Upstream drafts typically list test suites in `## Test plan`, add `(N tests)` to units, cite `file:line` and say "Unit N". If the draft is clean, say nothing.

## Chat-share posts

A "PR ready for review" chat post is not a short PR description. The reader is deciding whether to open the PR at all, and the chat client already previews the title.

1. Do not restate the link preview.
2. Lead with the action: "X PR ready for review!"
3. Add one line that heads off the first reaction (size, scope, the ask, urgency) and says where the longer answer is ("see the description's 'how to review' section"). This overrides PSH-005's rule against pre-emptive defense.
4. Keep it to two to four short lines.

Leave greeting, mentions and formality to the operator; `operator-voice-comments` covers the chat register.
