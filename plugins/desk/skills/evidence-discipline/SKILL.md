---
name: evidence-discipline
description: Use before a recommendation or claim that depends on external, mutable or unverified facts, before quoting an estimate, when the answer you have arrived at is complex, and when writing factual claims into a PR, card, handoff or brief. Covers citation, primary sources and visual proof. Not needed for a routine status read from its source.
---

# Evidence discipline

Invoke this skill when a claim, recommendation or action depends on evidence worker has not yet verified. Each rule below has its own trigger; match the situation to the rule. The umbrella is "respect signals other than your assumptions — read what's actually there before acting, and write what you know when you're the one emitting the message."

The rules are siblings, not steps. Each is short, has a clear trigger, and applies independently.

## Cite every factual claim

**One-sentence statement.** Every factual claim to a human or an agent, in chat, pull request text, task cards, handoffs or subagent briefs, carries an inline link to its primary source, and a claim with no source is labeled as inference or unverified, never stated as fact.

**What to do.**

- **Link the source inline, next to the claim.** A source is a `file:line`, a pull request, commit, CI run or issue URL, a documentation URL, or a command with its output. Anything written to a Markdown file MUST have its inline links, because the reader of a file cannot ask where a claim came from.
- **Share a link across consecutive claims from one source**, and give a table a source column instead of a link per cell.
- **Label what you cannot source.** Write "inference:" or "unverified:" in front of it; a plausible claim with no source is not a fact.
- **Your own actions link to the artifact.** "Merged", "tests pass" and "PR opened" link to the merge, the CI run or test output, and the pull request. Because the link must exist, no action is announced before it has happened.
- **Numbers too.** An estimate cites the historical data behind it or carries no number; "Fixtures or refusal" below has the procedure.
- **Secrets, credentials, raw private transcripts and customer data stay out of Git.** Cite them by a pointer (`session-resumption` "Protected evidence"), never by copying them into a public place.

**Anti-patterns.** A handoff that says "all tests pass" with no run linked; a pull request description that states current behavior with no `file:line`; a status line that says "merged" before the merge exists; a task card that copies a private transcript excerpt instead of pointing at it.

## Primary sources before recommendations

**One-sentence statement.** When a recommendation or status depends on claims about an external system, product, policy, market or current behavior, start with the best reasonably available primary evidence (official documentation, source code, first-party telemetry, the live product surface, or the artifact itself) before intuition or secondary commentary, and never present a plausible inference as researched fact.

**What to do.** Keep an evidence ledger that separates four things:

- **Verified fact**: directly supported by primary evidence.
- **Evidence-based inference**: a reasoned conclusion from verified facts, labeled as inference.
- **Unknown**: the primary evidence does not answer it; missing documentation is not proof of the opposite.
- **Decision**: a chosen tradeoff or preference, not a discovered fact.

Secondary sources may locate primary evidence, frame questions or reveal competing hypotheses; they do not replace a load-bearing firsthand source that is reasonably available. If no primary source exists or access is blocked, say so and calibrate the recommendation instead of filling the gap with confidence. An inherited "done" or "all tests pass" is a claim to check, and a green suite that does not exercise the claimed behavior is not evidence for it.

**Do not hand back while material evidence remains readable.** Reading, verification and synthesis are agent work, not decision points. Before returning a research-backed recommendation, pull every reasonably available primary-source thread that could change the answer, verify each load-bearing claim directly and name the remaining unknowns, so the human receives a decision rather than an invitation to authorize more research.

## Evidence precedence

**One-sentence statement.** Decide which evidence answers a claim by the kind of claim, not by a fixed ranking of sources.

**What to do.** The desk's curated records govern intent, approval, authority and the agreed endpoint: what was asked, what was approved, who decides, and where the work ends. Current source systems govern mutable facts, such as a branch head, a work-item state, a published artifact or a live configuration, because those move after any record was written. Bounded session history reconstructs execution only: what actually happened in a run, read within a stated range, never a source of intent or approval. A later source read may update a mutable fact but never erases an approved decision. When a current source contradicts a curated record, record both, the fact as it stands and the decision that still governs, and take the conflict to the decision's owner instead of overwriting it.

## Answer the governing question

**One-sentence statement.** Answer the question that was actually asked, as simply as it can be answered, before any adjacent finding.

**What to do.** Before shipping an answer, ask: is this the simplest thing that could work, and if not, why not? Why is this needed at all, or is there an upstream "why" that dissolves the question? Would a reader a year from now ask why it is so complicated? Am I answering the question that was actually asked, or an adjacent one that is easier, more actionable or more interesting? A complex answer can be right, but only after the simpler approaches have been tried and ruled out. `interaction-style` §6 ("Answer the decision before the mechanics") applies this to counterfactual questions.

## Smoke before infinity

Before wrapping an expression in something that hides its failures (a self-restarting runner such as Task Scheduler, a systemd `Restart=always` unit or a CronJob, or a polling loop such as `until <expr>; do sleep N; done` or a background wait on a CLI's output), run the inner expression once, in the foreground, under the same account, environment and comparison. Then wrap it.

- **Supervised runner:** run one iteration through a temporary one-shot entry with the same principal, exercising the cold-start path (no cache). Check the exit code, the expected artifact and that no orphan processes remain.
- **Polling loop:** run the compared command once and check that it exits 0, that the field it reads exists and is non-empty, and that its type and shape match what you compare it to. `gh pr checks 70 --json conclusion` fails because the field is not there, so `until [ "$(...)" = "SUCCESS" ]` would spin forever while CI finished long ago.

A supervisor that says "running" while every iteration exits 1, and a loop that can never match, both fail silently. Debug at the one-shot level.

## Messages over models

When a tool's warning or error names the fix, that message is the fix: apply it before forming any theory. "X is set but ignored, use Y" means set Y; look up a named HRESULT; on a 404 for a named cloud resource, confirm the resource exists in this subscription before blaming auth. Do not spend an hour on a hypothesis tree when the first warning line said what to change. This is the cheapest discriminator in `runtime-symptom-investigation`.

## State outcomes definitively

When you write an outcome message (a script's final line, a chat reply, a PR comment, a log), you hold the signal that decides it: an exit code, a response, a file on disk. Branch on it and print one of two clear messages, each naming the next move: it succeeded and here is the result, or it failed and here is the fallback. Never ship "should be ready", "may have worked" or "the key vault has it too if the push succeeded" when the script's own variable knows. If you cannot reach the signal, fix that gap rather than hedge. This is the writing side of "Messages over models".

## Fixtures or refusal

When asked for a duration, cost or scope estimate, or when composing anything for the operator that contains one, check for fixtures first: stage definitions in the relevant skill or runbook, past run records and telemetry from earlier runs. If they exist, the answer cites them by path and line range. If they do not, the answer strips the estimate rather than guessing: "I have no fixture for that; I can measure it, or proceed without an estimate." Inheritance does NOT excuse the estimate: a number in another agent's plan, an upstream tool's output or an earlier turn is stripped at composition time unless someone had a fixture. Quoting "10 to 30 minutes per iteration" when past runs showed 2.5 hours distorts every plan built on it.

This section is the one statement of the rule; `operator-voice-comments` ("No fabrication") and `interaction-style` §7 point here. If the estimate drives a hard-to-reverse decision, also apply `preflight-actions`.

## Discover before invent

Before building a wrapper, orchestrator, helper, config knob or script around an existing system, find and read its entry-point documentation (`RUN_PATH.md`, `scripts/README.md`, an agent manifest, a README's automation section, a `Makefile` or `justfile`). If it already exposes what you are about to build, call it; your code stays a thin wrapper and the owners keep the logic. If not, build yours and consider asking the owners to extend theirs. Read a new tool's README before drafting any install or invocation command. Checking costs minutes; duplicating and migrating costs hours.

## Sniff before transferring auth state

Before believing a plan that copies a token cache, session or credential file between users or machines, read the file's first 20 bytes (`head -c 20 | xxd`, or `Get-Content -Encoding Byte -TotalCount 20`):

- `01 00 00 00 D0 8C 9D DF 01 15 D1 11 8C 7A 00 C0 4F C2 97 EB` is Windows DPAPI user scope. A cross-user copy appears to work and fails silently when the cached token next expires, hours or days later. Have the user sign in once as themselves instead.
- PEM (`-----BEGIN`) or JSON (`{`) is plaintext and can be copied; still lock down access and keep it out of logs.
- Anything else is an unknown envelope; investigate first. macOS Keychain and Linux secret stores are per-user too: assume per-user encryption until the bytes prove otherwise.

## Test it twice

A mechanism whose value is surviving an event (a reboot, a token refresh, a reconnect, a scheduled restart, any self-healing) is confirmed only after two consecutive instances of that event succeed. One success can be a fluke: a first reboot that recovers on a fresh secret, followed by three that fail identically. Record both cycles in the experiment's outcome table. "Smoke before infinity" checks the first run; this checks durability.

## Process tree, not process name

Clean up the processes you spawned by lineage, never by name alone. Use a tracked list of the PIDs you started, a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, or a process group killed with `kill -- -<pgid>`, or skip cleanup when the tool cleans up after itself. `pkill <name>`, `taskkill /IM` or `Get-Process <name> | Stop-Process -Force` also kills the operator's and other agents' processes, silently and with no crash report to trace. The same rule applies to deleting files by glob, registry keys by prefix or network rules by tag.

## Verify precedent against HEAD

Before a prompt, plan or brief says "this extends PR #1234's pattern" or "we already migrated X to Y", check that the precedent is in HEAD: `git show <ref> -- <file>`, `git log --all --grep "<feature>"`, or a grep of current source for its claimed effect. What a PR proposed and what landed often differ. If HEAD disagrees, narrow the claim, pick another precedent or drop it before anyone builds on it.

## Test coverage: seven categories

When writing or auditing tests for a change, cover each category or mark it `N/A` with a reason (for example `N/A: pure function, no state`):

1. **Happy path:** the normal input, asserting the value and side effects.
2. **Edge cases:** boundaries such as zero, maximum and minimum length, each as its own test.
3. **Null and empty:** absent or empty inputs where the API allows them.
4. **State:** initial state, operation, expected state, including idempotence.
5. **Caching:** hit, miss, invalidation and stale data after a write; caching bugs show on the second call.
6. **Authorization:** allowed and refused callers, expired tokens, wrong tenant, missing scopes.
7. **Exceptions:** each catch fires its fallback; each throw raises the right type under its condition.

Name tests `{Given}_{When}_{Method}_{Assertion}`, for example `GivenValidPayload_WhenSavedTwice_AddDocument_ReturnsIdempotent`.

## Visual proof when it helps

Where a visual would help a human verify a state, capture bounded visual proof at that stage, including working or doing logs and intermediate milestones such as pull request opened, reviewed, or merged states. When a milestone claims a rendered, installed, merged, rollout or other consumer-visible state, capture that real result, not a terminal success line. It supplements rather than replaces tests, logs and system-of-record readback. Capture only the relevant bounded view, never secrets or sensitive/private content; if capture is impossible, record why and use the strongest safe alternative. Nonvisual work gets no artificial screenshots.
