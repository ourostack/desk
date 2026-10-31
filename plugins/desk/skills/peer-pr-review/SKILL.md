---
name: peer-pr-review
description: Review someone else's pull request when the operator gives you its link or number and asks for a review. Not for the operator's own PRs.
---

# peer-pr-review

An eleven-phase review of a PR by someone other than the operator: scaffold, read, walkthrough, backlog, full-line pass, voice and verify, confidence, post, vote, promote, archive. The operator's own PRs use `pr-self-review`, `pr-feedback-on-own-pr` and `pr-surface-hygiene`. The review folder layout and the connection-lens model are defined in the operator's `$DESK/_reviews/README.md`; this skill does not restate them.

## Hard rules

1. **Never read or cite test files.** Fetch the production diff only, and never anchor a comment to a test. The recipient cares about the production change, and test names pull the review into the wrong layer.
2. **At least one non-`direct-work` lens must be real.** An honest career, cross-team or pattern lens beats an overclaimed `direct-work` one.
3. **No verdict before the walkthrough.** Walk to explore, not to validate a conclusion.
4. **Every comment follows `operator-voice-comments`**, including its approval rule: nothing posts until the operator approves the exact text and destination or a standing grant names that kind of send, and no vote is cast without the operator's approval.
5. **Below 90% confidence, verify, soften or cut** before posting. The bar: "this is right because [evidence], and pushback would be answered by [source]".
6. **Anchor comments to method names, not line numbers** (`pr-surface-hygiene` PSH-002); line numbers drift.
7. **Empty `promotions:` at archive is a smell** (phase 10).
8. **Try to disprove a finding before the operator sees it as a conclusion** (phase 3). Never ask the operator to validate your technical reading; their role is product judgment after you have proved the mechanism.

## Workspace

Each review lives in `_reviews/<slug>/` on the desk: `task.md` (PR metadata, connection lenses, promotions, and the verdict at archive) and `notes.md` (the diff opener, walkthrough log, backlog, drafts, thread IDs and the recommended and final vote). Commit and push the desk after each phase that writes there (`git-hygiene`).

## Phase 1: Scaffold

1. Fetch the PR's title, author, repo, source branch, vote state, size and linked work item with the host's PR tool.
2. **Name the review from the PR's theme.** Pick the folder name yourself, with no proposal and no wait: 2 to 6 lowercase kebab-case words about what the PR changes, never the PR number, the author's name or the title copied. If `_reviews/` already holds a live review of the same PR, continue it (`task-lifecycle` "One job is one task"). A weak name is cheap to fix later with a Git move.
3. Decide the connection lenses with the operator, and list the lenses considered but not taken, one line each, in `task.md`.
4. Create `task.md` (status `reviewing`, empty `promotions[]`) and a `notes.md` scaffold, and push.

## Phase 2: Read

- Read the PR description and any author tour as a subject of review, not as authority.
- Fetch active threads first; a long PR's full thread list (including system threads) can overflow a tool result. Read resolved threads only when a question needs their history.
- Take the production diff only, against the PR's target branch: `git diff <merge-base>..<branch> -- ':!**/*Tests*' ':!**/*test*'` (adjust the globs to the repo's test layout).
- **No local clone** (a huge repo): have a child fetch each changed non-test file's base and head through the host's file-content API, diff them locally with `diff -u`, and save the result in `_reviews/<slug>/diff/`. Read it selectively, file by file. Do not stop to ask how to proceed.
- Write the opener at the top of `notes.md`: file count, line count and one sentence on what the change does.

## Phase 3: Walkthrough

Walk the diff with the operator: name what changed, raise questions, and let their judgment decide what becomes a backlog item. Log it in `notes.md`.

**Read order** for an engine, integration and UI diff: public types, the barrel or index, the orchestrator, config and flag utilities, the integration call site, the UI (skim; most logic bugs are upstream), then small files. Override it when the diff has another shape.

**Reality gate.** Before presenting a finding you found on your own, try to disprove it: state the strongest benign explanation; trace every alternate, legacy, cached and fallback path to its user-visible or persisted outcome; verify any outside SDK, API or host contract independently (the PR, its design doc and its comments are subjects, not proof); for flags or version skew, trace each relevant state combination; and write the concrete failing input and outcome. The finding either has a verified mechanism or is cut.

**Teaching mode.** When the operator is new to the repo or asks to learn it, start at the runtime entry point, not the changed helper: map the request from the service boundary through the workflow entry, the dispatcher, the handler or tool and downstream dependencies, one slice at a time in the signed-in browser, defining local vocabulary first. Only then layer the diff on: what changed, what is inherited, and which routes bypass the change. Keep your own findings in `notes.md` until the operator reaches that code and forms a view; leading with a finding teaches the finding, not the system. When they state a judgment, draft the narrow comment, invoke `operator-voice-comments`, verify every claim and run the phase 7 checks; post mid-walkthrough only with their approval of the exact text and destination, or under a standing grant that names that kind of send, and record the thread ID.

For a question about a design premise ("is this abstraction needed?", "where did this type come from?"), use `pr-review-interrogation`; the PR's own docs and description are not the answer.

## Phase 4: Backlog

Collect decided-to-post items under "Backlog" in `notes.md`, each with its anchor (file and method or class), the ask in one sentence, a rough confidence (high, medium, low) and its connection lens, which phase 10 needs. Add, merge and drop items as later hunks change earlier ones.

## Phase 5: Full-line pass

Re-read every line of the non-test diff in order to catch what the walkthrough missed, drop concerns later hunks resolved, and find patterns visible only across the whole diff. Then lock the backlog.

- **Large files** (over about 500 changed lines): form two or three hypotheses about where bugs would live, grep for them (for example `timeoutMs|setTimeout|Promise.race|abort|signal`), read about 50 lines around each match and re-grep as new names appear. Zero matches for a needed behavior is itself a finding.
- **New names beside old ones.** When the diff adds a constant, type, helper or config key next to an existing one with overlapping purpose (case, plural or looser-typing pairs), check every importer of both and confirm each uses the right one; a wrong import surfaces only at run time.

## Phase 6: Voice and verify

Invoke `operator-voice-comments` explicitly (not from memory, which misses internal labels such as track slugs and phase numbers) and apply it to every backlog comment: strip padding, match the operator's voice, and verify each load-bearing claim by reading the exact lines end to end. Every draft must pass the voice test and the dial test.

## Phase 7: Confidence and value

Give each comment an honest confidence. Resolve the usual 70 to 89% cases before posting: an inferred mechanism (read the lines or cut), "similar code elsewhere" without naming it (name the file and method or cut), and an unverified history claim (check `git log` or the operator's notes, cite it, or cut). Hedging an unverified claim is not a resolution.

Then cut a comment that is true but not worth posting: one an automated check (coverage, build, policy, CI) will already raise, and one that is only a concern because you lack the deployment, access or flag context; verify that landscape first, and if it holds, the disposition is "no finding", not a question for the author. A review with nothing beyond what the checks catch is a valid outcome; sign off. Every remaining comment is above the bar; there is no "post with caveats".

## Phase 8: Post

Show the operator the final comments and destinations and post only what they approve, or what a standing grant names (skip any already posted in teaching mode). File-thread comments anchor to the file and name the method in the body; an optional short top-level comment frames the review ("couple of small things, otherwise looks good") and carries no per-item asks. Record each thread ID in `notes.md`. If a draft changed after phase 6, re-run both tests on the new text. Reference other PRs and issues with the host's auto-link (`#1234` on GitHub, `!<id>` for merge requests on some hosts), not raw URLs or "PR 1234".

## Phase 9: Vote

Recommend a vote and cast it only with the operator's approval:

| Backlog | Vote |
|---|---|
| Only nits, and an author with clean follow-through | `Approved` |
| A real bug or substantive change | `ApprovedWithSuggestions` |
| Unresolved design-premise questions | `NoVote` |
| A major mechanism error or scope mismatch | `WaitingForAuthor` |

Record the recommended and final vote in `notes.md`.

## Phase 10: Promote

Apply each `promotions[]` entry to its target, such as a context bullet in `<track>/track.md` or an insight in `_landscape/<topic>.md`. When the lens was honestly thin, mark the entry `applied: skip-by-design` instead of deleting it. If `promotions:` is empty, re-read the log and backlog: usually an insight was not captured; write it down and add the entry.

## Phase 11: Archive

Set `status: done`, write the verdict, resolve every promotion to `true` or `skip-by-design`, and add a short `closed_decision` (for example `approved-with-suggestions-3-comments-posted` or `signed-off-no-comment`). Then move the folder to `_reviews/_archive/<slug>/` (`archive-workflow`) and push. The archive is read-only; a later pass is a new review.

```yaml
verdict:
  vote: <Approved|ApprovedWithSuggestions|NoVote|WaitingForAuthor>   # the operator's final vote
  comments_posted: <count>          # your file-thread and top-level comments, not bot threads
  thread_ids: [<id>, ...]           # empty for signed-off-no-comment
  signed_off_at: <ISO-8601>         # later commits are outside this review
```
