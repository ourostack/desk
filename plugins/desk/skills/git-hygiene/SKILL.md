---
name: git-hygiene
description: Keep code repos synced and leave no state behind. Use before work in a repo, after every ref change, when a required check fails or validation proof may be reused, before every push, and when work ends.
---

# Git hygiene

> Boot first: if the Desk boot has not run in this session, run the absolute command on the `Desk startup:` line in your context (without it, `node <this skill's base directory>/../../mcp/scripts/session-boot.js`; add `--task "<name>"` when the operator named a task). A child agent with a bounded brief follows its brief and skips this.

> **overlay users**: consumer overlays may add their own state-sync workflow for the `$DESK/` repo, identity context (e.g. enterprise-managed git accounts), and overlay-specific anti-patterns. This skill stays generic.

The agent's pushes must reach the remote intact and on the right branch. This skill covers source-as-evidence reads, the pre-push CI-parity gate, merge-conflict EOL/BOM rules, force-push safe-conditions, and the post-commit verify gate.

## Code repos

These are the actual project repos where implementation happens (paths resolved via the `repo-handling` skill).

**Before starting work**: follow the recorded repository policy. The task's recorded source is its channel, the branch consumers track: before the first write or worktree, verify the checkout is on that channel or a task branch from it, its branch relationship to the remote channel, and the relevant version surface, and do not describe an unfetched checkout as current with the remote. There is no frozen candidate: reviewers and evaluators use the channel as it stands when they run. A commit hash is evidence only: record the head you saw, and never pin work, a review or a handoff to it.

**Dependency declarations track channels, not commits.** Dependencies between plugins (`agency.json`, plugin manifests, bundle declarations) track their release channel branch, such as `@main`, from the canonical repository, never an exact commit or a fork: a pinned commit silently freezes every consumer downstream and keeps later fixes from reaching them. Record the exact commits that were qualified in the evidence, not in the dependency. Repositories enforce this with a dependency-channel check in CI.
```bash
cd <repo-local-path>
git fetch origin                          # ALWAYS first — see the stale-status trap below
git rev-list --count HEAD..origin/main    # how far behind is the base you'd branch from?
# If on a feature branch from prior work:
git rebase origin/main   # or `git merge origin/main`, per repo convention
# If on main:
git pull origin main
git status               # check for uncommitted changes; warn, don't silently overwrite
```

### The stale-status trap — `git status` lies without a fetch

`git fetch` is not an optional first line of the recipe above — it is the **load-bearing** one, and the failure mode when it's skipped is silent and expensive.

`git status` reports your branch as "up to date with 'origin/main'" by comparing against the **last-fetched** remote-tracking ref — a local cache that can be arbitrarily old. With no `git fetch` first, "up to date" only means "up to date with a possibly-ancient local copy of the remote," **not** "current with what's actually on the server." A clone that's been idle (or that another machine has been pushing to) can read "up to date" while sitting dozens of commits and several releases behind reality.

Branch off that stale base and the entire unit of work lands on dead code: the diff is computed against an old tree, the PR opens against a base that no longer reflects `main`, conventions may have drifted underneath you, and — worst — if the work targets a running artifact, you can "fix" something the operator already moved past, or even ship a **downgrade**. The cost is invisible until the work lands on the wrong base, and by then recovery is a full redo plus a credibility hit ("you said it was done").

The rule:

1. **Treat a no-fetch `git status` as `unknown`, never as `current`.** `git fetch` (or `git pull --rebase`) before branching or starting work in ANY code repo — every session, even for a one-line fix. Staleness scales with how long since the clone was last touched; you cannot eyeball it.
2. **Quantify the gap before branching.** `git rev-list --count HEAD..origin/main` — a non-zero count means your local base is behind; sync (`git checkout main && git pull --rebase`, or branch from `origin/main` directly) before doing anything else. Don't trust a green-looking `status`; trust the count after a fresh fetch.
3. **Cross-check HEAD against the real artifact when the work targets one.** If you're changing something with a deployed/published form (an installed app, a released package, a live service), compare the clone's version/HEAD against what's actually running (installed version, latest release tag, live response). A gap between the clone and reality is a second, independent staleness signal — stop and sync first.
4. **"Done" means the operator's real artifact changed — not "a PR exists" or "a harness passed."** Verify the outcome against the thing the operator actually uses (the installed binary, the live endpoint, the rendered output), not only a synthetic test or an open PR. A green proxy can hide that the operator's experience is unchanged.

### Folder trust is path trust, not revision trust

A host may use path-level folder trust to load repository-owned executable configuration. After every ref change, inspect that repository-owned executable configuration before the host can load or run it. A trusted path does not make a new revision trusted. For read-only inspection of untrusted source, use the remote source API instead of trusting the checkout only to read it.

When a checked-out branch modifies a command-bearing file, such as a hook, pipeline, task runner, package script, or policy, diff it against the protected base and verify explicit approval before executing the changed command. Reading a branch is not running it.

**During work**: the selected Superpowers implementation owner commits and pushes only within the recorded publication authority.

**At the delivery endpoint**: use `superpowers:verification-before-completion` and the recorded repository policy, not the literal finishing menu of a provider skill or the retired integration contract. Resolve that policy through `repo-handling`, existing PR and host-specific skills; do not invent another delivery engine. If the endpoint or contribution authority is unknown, resolve that specific gap before publication or deletion rather than guessing.

Where the recorded repository or task policy requires human approval, wait for it; once recorded, resume the existing gates, merge and clean up through the approved repository/host path without a second go. An intentional alpha-only endpoint still forbids plugin main merge: preserve its named alpha refs and worktree until their recorded transfer or cleanup trigger. Neither technical access nor a provider's finishing options extends publication authority.

Keep delivery and exact resource dispositions in the mapped progress record under `## Delivery` and `## Resources`, using the single [task-lifecycle table definition](../task-lifecycle/SKILL.md#delivery-and-resource-accounting). Pending cleanup is `cleanup_pending` there while canonical status stays `validating`; a merge receipt alone cannot close the task. The tiny adapter selects an entry, not delivery, recovery, scheduling or accounting.

### Exact-owned cleanup

**Close-out belongs to every owner, not just the root controller.** When a task, iteration or delegated assignment ends, its owner reconciles every worktree and branch it created, removes only exact-owned safe worktrees and merged local/remote branches whose endpoint permits removal, and returns every surviving checkout it touched to that checkout's recorded state branch (`main` by default). Switching is also a mutation: require authority, a clean checkout, no Git operation, preserved commits and no other writer; otherwise record the exact blocker rather than switching someone else's checkout. An intentional PR-only or alpha worktree remains on its delivery branch with a named owner and cleanup trigger. Do not wait for the parent task or the session to end.

Record resources at creation with their owning task/attempt, repository/path or host operation identity, intended disposition and evidence pointer. Before cleanup, reconcile current ownership and live consumers; a remembered name, old PID, clean status or successful root exit alone is not proof. The host must identify the exact prior process generation and all owned descendants, including delegated/remote writers and MCP/command children. Never use process-name patterns, `pkill`, `killall` or pattern-based process termination; only the owning host's exact-identity cleanup path may terminate a verified task-owned process. Unobservable writers remain non-ready, not absent.

Before deleting a worktree, require exact repository/path/branch ownership and verified absence of all writers and live consumers, plus preservation of uncommitted changes, untracked files and local-only commits. Read back the agreed delivery ref and source content at the destination; for a merged task verify the actual merge and that no post-review source was left behind. Do not use a matching branch-name pattern, a merge flag alone or an archive's mere existence as deletion authority. An intentionally unmerged alpha worktree is retained unless its recorded policy authorizes a verified transfer or later removal.

After exact-owner removal, record **removed-and-absent** only with readback of the resource's absence, including its worktree registration/path or owned process generation/descendants. Otherwise record an acknowledged **named transfer** or **retained-with-trigger** with the responsible owner, exact resource and cleanup trigger through `task-lifecycle`. Failed cleanup, unknown ownership or an unresolved operation stays pending; never force-delete preserved work to manufacture a clean endpoint.

The [workspace-tidy boot check](../../docs/workspace-tidy.md) lists only the bound desk and repositories on active or recently finished task cards, then defers all safety inspection and removal. It cannot infer ownership from a branch name, clean status, missing remote ref or dead root process. An owner may leave its documented machine-local version-2 release receipt only after the host has reconciled the entire generation and all consumers; no receipt is the safe default. Creation, revocation and reacquisition use the same exact branch/worktree claim as cleanup; never unlink a receipt directly or attach a consumer after a refused revocation, and never issue a removal receipt for an intentionally retained alpha. Read the repair's retained per-resource evidence, copy verified dispositions into canonical Resources, then acknowledge only that exact evidence id/digest. Another boot is not an acknowledgement and must not erase unresolved branches or removal receipts.

## Code clone hygiene — `main` is the resting state; do work in worktrees

This section covers code repositories. A desk uses `main`; a branch only to coordinate writers working at the same time. A code clone is shared infrastructure: many sessions, machines, and agents touch the same checkout over time. Its **resting state is `main`** — clean, current, predictable. An agent that parks a clone on its own feature branch and walks away forces the next session into archaeology ("what is this branch, is it safe to build on?") before it can start.

The discipline:

1. **The canonical clone stays on `main`.** Never leave it checked out on a feature branch between units of work. At session start, if a clone is sitting on a feature branch from prior work, return it to `main` once that work is resolved (merged — or explicitly preserved, see verify-before-delete below).
2. **Do each unit of work in a git worktree off `main`**, not by checking out a branch in the canonical clone:
   ```bash
   git -C <clone> fetch origin
   git -C <clone> worktree add -b <branch> <approved-task-worktree> origin/main
   # edit / commit / push / PR / review / merge from the worktree
   # (use `git -C <worktree>` for EVERY git command — see work-orchestration
   #  "Worktree-isolated sub-agent dispatch" for the cwd-reset trap)
   ```
   The worktree isolates the work: parallel units never collide in the working tree, and the canonical clone's resting state is never perturbed.
3. **Clean up after yourself only at the recorded endpoint.** For an authorized merge, confirm the source-system PR state and actual merged source first; for GitHub, `gh pr view <id> --json state --jq .state` must return `MERGED`. This is necessary, not sufficient: apply every exact-owned cleanup gate above before `git worktree remove <path>` or deleting the specific branch. Do not chain removal unconditionally after merge or let a merge command's automatic branch deletion bypass these gates. Reconcile the canonical clone through the recorded repository policy afterward. An alpha or PR-only endpoint instead preserves or transfers the exact refs/worktree with a named owner and trigger. The end state has zero unaccounted-for resources, not zero deliberately retained branches. If merge failed or ownership/absence is uncertain, preserve the work and keep cleanup pending.

**Why:** the clone's checked-out state is cattle, not a pet — only `main` and the remote are durable. This is the working-copy layer of "Never leave state behind" (below) and the branch → PR → merge drive-to-merge motion: branch in a worktree → PR → merge → delete branch → remove worktree → clone back on clean `main`, no residue at any layer.

### Verify before delete — cleanup is not destroy

Before deleting a leftover branch found at session start, confirm its content is actually on `main`:

```bash
git -C <clone> fetch origin
git -C <clone> diff origin/main..<branch> --stat
```

Empty diff is content evidence, not deletion authority. Apply the recorded endpoint and all exact-owned cleanup gates before deleting the specific branch, including live-writer/consumer absence and any required retention or transfer. A squash-merge can leave the branch ahead in ancestry even when its content is merged, but that is not permission to bypass ownership checks. Non-empty diff means the branch carries different content: preserve and reconcile it, and pursue merge only when authorized. "These were probably just left behind" is a hypothesis to verify, not a license to delete unexamined work.

## Reading source as evidence

The `## Code repos` rules above cover keeping a checkout current across a session. The runtime-investigation companion to that rule: when the agent is reading source to inform a runtime question, the local working tree is not a trustworthy substrate by default — `origin/<branch>` is.

The fetch and pull steps in this skill apply only to checkouts the task owns. A clone the task does not own is never mutated: no fetch, pull, checkout, switch, stash, reset or branch. Read it with `git show` on refs it already has, through the hosting service's source API, or from your own clone or worktree. The single exception: the operator's explicit instruction to update that specific clone authorizes that update, because authority follows the verb (`using-desk` "Authority"). `repo-handling` ("Other people's repositories and clones") states the same rule.

### Default to `origin/<branch>`, not the working tree

When reading source to inform a runtime question — any "why does X behave this way?" investigation — default to reading from `origin`, not from the local working tree:

1. In a checkout the task owns, run `git fetch` first (cheap, always safe). For a clone you do not own, use the alternatives above.
2. Read via `git show origin/<branch>:<path>` rather than the filesystem. This avoids the stale-checkout failure mode where the local branch is N commits behind and the agent doesn't realize it.
3. If the agent does read from the filesystem, confirm `git rev-list --count HEAD..origin/<branch>` is `0` first. If non-zero, `git pull` or fall back to step 2.

### When the operator says "pull latest"

It means every repo in the current investigation, code repos most of all when their source is evidence for runtime behavior; they sit on feature branches and are easy to forget. If unsure which repos, ask. Pull a clone the task does not own only when the instruction names that clone.

**The smell.** "The source says X but runtime does Y, so there must be a hidden mechanism" usually means you are reading stale source. Check `git log origin/<branch>..` or `git show origin/<branch>:<path>` before theorizing (`runtime-symptom-investigation`). Theories built on stale source are expensive to retract.

## Pre-push gate

Every `git push` that carries code changes is a CI-parity boundary. The agent reproduces every routine gate the CI pipelines will run, locally, **before** the push — not after, not in parallel, not optimistically. Explicit final-candidate expensive gates use the exact-SHA exception below.

Three layers, all mandatory, all green:

1. **Build.** Compile the affected project(s) in the same configuration CI uses. For .NET, that's `--configuration Release`, which enables `TreatWarningsAsErrors` / `CodeAnalysisTreatWarningsAsErrors` + analyzer + formatter MSBuild targets. Debug config skips several gates; it is not a substitute. Language-equivalent rules for other stacks — whatever posture the CI pipeline uses, the local build matches it.
2. **Test.** Run the test projects that cover the touched code. The scope is set by the diff, not by the closest test project (see `## Test scope — cover consumers` below). If the full suite is too slow, filter — but filter across every test project touched by the change, not one.
3. **Formatter.** Run the style gate the CI pipeline enforces (`dotnet csharpier --check`, `prettier --check`, `gofmt -l`, `rustfmt --check`, etc.). A Release .NET build that invokes csharpier-as-MSBuild-target covers this inside layer 1; standalone formatter runs are the fallback when the build config doesn't.

All three green → push. Any red → fix locally, re-run all three, then push. **Never push red.** The pipelines will reject the push, you'll wait 20–40 minutes for CI to report what you could have learned in 60 seconds, and every reviewer-visible red pipeline on the PR erodes the signal that green ones are meaningful.

### Pre-push gate is not an iteration gate

The pre-push gate runs before every `git push`. It does **not** run between every edit in a local iteration loop — drafting, exploring, and mid-iteration fix-ups are exempt. The distinction is the push boundary: inside the loop, the agent iterates freely; at the push, CI-parity is the only correct posture.

A corollary: **do not wait for CI pipelines to finalize before starting the next iteration.** Local gates have already established that the push won't red the pipeline. Trust that and keep moving. Waiting on CI between iterations multiplies queue time by iteration count — a 5-iteration loop with one 20-minute CI wait per iteration becomes a two-hour human-facing latency for what could have been ~10 minutes of contiguous agent work plus one end-of-loop CI wait.

At end-of-loop (convergence reached, findings drained, or operator interrupt), wait for the most recent push's pipelines to finalize. If any pipeline goes red, treat it as a new finding — fix, push, wait again. Only when all pipelines are green does the loop exit.

### Final-candidate expensive gates

Coverage, fully instrumented builds, and explicitly designated release or package gates are an exception to routine every-push local repetition when the repository or task declares them final-candidate gates. Intermediate pushes still require the smallest targeted build, test, and formatter proof that covers their changes.

Run each expensive gate after the last source, configuration, or dependency mutation against the exact candidate SHA and before final delivery. Record the SHA, command, and retained artifact or report. If that SHA or any relevant input changes, invalidate the proof and rerun the gate.

This defers redundant local execution; it is not waived validation. CI may still run the expensive gate on earlier pushes, and any failure remains actionable.

### Attribute failures after they happen

Do not establish a separate baseline preemptively. When a required build, test, or formatter check fails and the failure may be pre-existing, preserve the current tree and classify it in this order:

1. Current target CI at the exact target SHA.
2. The same command in a clean merge-base worktree.
3. A previously recorded, reproducible baseline tied to a commit.

Unknown remains failed evidence. Do not fix an unrelated baseline failure unless the task scope requires it.

### Reuse proof only while inputs match

Reuse a previous validation result only while its source/diff fingerprint, exact command and selection, dependency and configuration fingerprint, and environment all match the current run. Record the reused run or artifact. If any relevant input changed, rerun the affected proof.

### Commands are repo-specific

Exact build / test / formatter commands live under `../repo-knowledge/<repo>/` (`repo-handling` "Repo knowledge" loads them). Each repo's `pre-push-gates.md` (or equivalent) captures the safe-default build line, test-project cut-lines, and formatter fallback. For repos without `repo-knowledge` content, consult the repo's own build / test docs before the first push.

## Test scope — cover consumers, not just the unit under change

A filtered test run covers only the test project you point it at. When a change touches a public surface, the pre-push run must cover every consumer project's tests. List touched files with `git diff --name-only origin/<base>...HEAD`, map each to its test project by the conventions in `repo-knowledge/<repo>/`, and run each distinct test project. When the diff touches a signature, interface, abstract type or DTO, default to the repo's broad target (often the full solution); use per-service runs only when the change is provably internal.

## Test-count sanity check

"All tests pass" on a stale binary is a silent failure. Track `expected = previous + added − removed` and compare it with the reported count before pushing. If they differ, rebuild the test project without `--no-build`, rerun, and if the count still differs, find the discovery problem (a stale binary, an incremental-build cache after big moves, a filter that misses the new test's name, a missing `[Fact]`/`[Theory]` or equivalent) before pushing.

## Merge-conflict resolution — EOL / BOM artifacts

On Windows clones with `text eol=*` attributes, a merge from main can conflict on files that differ only in BOM or line endings; a file outside the task's scope with equal insertions and deletions in `git diff --stat origin/<base>...HEAD` is the sign. `git add`, `git stash`, `git checkout origin/<base> -- <path>` and `--skip-worktree` all run the check-in filter and ship the noise into the PR (and pull in that path's code owners). Write origin's blob into the index instead:

```bash
BLOB=$(git rev-parse origin/<base>:<path>)
git update-index --cacheinfo 100644,$BLOB,<path>
```

The working tree may still show "M"; that is cosmetic. Resolve real semantic conflicts normally.

## Never leave state behind

Before the session ends, persist task-owned changes through the recorded contribution path. In a desk, commit your own paths to `main` (`git pull --rebase --autostash`, `git commit <paths>`, `git push`), and use a branch only to coordinate writers working at the same time. In a code repository, commit and push only when authorized; a no-push or local-handoff endpoint must preserve the exact commits and required worktree instead. Preserve unfinished source through `desk:session-resumption` when it is not ready to commit, without sweeping unrelated files. Apply this to canonical task/progress state and code changes through their respective owners; persistence is not authority to publish or delete.

At session start, if git status in any repo shows unexpected uncommitted changes, surface them to the operator before doing anything else — they may represent orphaned work from a previous session.

Never move a branch ref in place with `git update-ref` or an equivalent under a dirty checkout. In a desk, run `git pull --rebase --autostash` and commit only your own paths; other sessions' unfinished files stay where they are. In a code repository, start from a clean temporary worktree based on the current remote destination, replay only the exact task-owned change, stage only an explicit staged-path allowlist, inspect `git diff --cached --name-status` against that allowlist, then inspect the full staged diff before commit.

(overlay users: consumer overlays often ship a state-repo-specific anti-pattern note — never branch or open a PR on a state repo to get around a denied push to `main`; the denial is a permission setting to fix, not a workflow to route around.)

## Commit identity and secrets

If the operator lists a commit address for the repository's owner, set the repository's `user.email` to it before committing; on a new machine, set it once in each clone. GitHub can block any push whose newest commit carries a private email.

Do not store secrets, credentials or private tokens in the desk.

## Pre-commit scans (authorship, diff-scope)

Run both scans before every commit. They are procedures, not shipped hooks; an operator may install a local `commit-msg` hook built from the same pattern.

### AI-attribution strip

No AI-attribution trailer or credit line appears in any commit message or PR description the agent authors, on any repository. Operator authorship overrides repository conventions: a repository's `CLAUDE.md`, `AGENTS.md` or contributing guide is authoritative for coding standards, build commands and layout, not for the authorship of work the operator ships under their name. If a repository's instructions prescribe AI attribution, flag it on first encounter, and once the operator confirms the override, apply it to every later commit in that repository.

```bash
git diff --cached --format=%B HEAD 2>/dev/null | \
  grep -niE "Co-Authored-By:|Co-authored with|Generated (with|by) |Built (by|with) |AI-assisted"
```

Forbidden: `Co-Authored-By:` naming any agent, assistant, model or harness (for example `Co-Authored-By: Claude ...` or `Co-Authored-By: GitHub Copilot ...`); `Co-authored with Claude ...`; `Generated with Claude Code`, `Generated with Copilot` or any "Generated with …" credit; `Built by Copilot` or any "Built by …" credit to a tool; `AI-assisted`; and any variant naming the agent or harness as a contributor. Strip each hit that credits an agent and redo the commit; a human co-author, or the same words in an unrelated sentence, stays. Run the same scan on a PR description before `gh pr create` or `gh pr edit --body-file`.

### Targeted staging — never `git add -A` in a shared or multi-track workspace

Stage the explicit files your unit wrote (`git add <path> <path>`), never `git add -A` or `git add .` from a workspace root where other agents or tracks leave files: it sweeps their in-flight work into your commit and makes the message lie by omission. When in doubt, `git status` first and stage by name.

### Diff-scope scan

Lean diffs: every commit contains exactly the lines required for its stated scope and nothing more, with no drive-by prose edits and no "while I'm here" improvements. Extra touched lines cost slower review, more nits, more merge conflicts and more doubt about what the change does. Before every commit, read `git diff --cached` against the unit's stated scope and revert hunks it does not need, especially adjacent doc-comment rewrites and prose polish. Polish is a separate, named activity with its own unit and commit.

### Pre-PR diff-scope check

Before opening or syncing an authorized PR (through `desk:using-superpowers-with-desk`), run `git diff --stat origin/<base>...HEAD`. Every file must be named in the task's `repos[].paths` or follow directly from one (a regenerated lockfile, a test the change required). Anything else stops the PR until explained: usually an EOL or BOM artifact (above), a stray file from `git add -A`, or drive-by churn.

## Post-commit verify gate

After every commit and before pushing or claiming it shipped, run `git show --stat HEAD` and check each thing the message claims ("feedback.md updates", "new friction entry", "regenerated artifacts") against the file list. If something is missing, stage it and make a new commit (do not amend a pushed commit), then re-check. `git status` shows the next state, not what the commit carried.

## Force-push — safe-conditions procedure

Force-push is destructive; usually hand it to the operator. A version-file conflict between parallel PRs is better solved by merge and a normal push (`work-orchestration`, "Version-file conflicts on parallel PRs — merge, don't rebase"). The agent may force-push without asking again only when all of these hold:

1. The branch is the operator's personal namespace (`user/<alias>/...`); never `main`, `master`, a shared feature branch or a release branch.
2. It uses `git push --force-with-lease=<branch>:<expected-remote-sha> origin <branch>`, never `--force`.
3. `git cherry origin/<branch>` shows no `+` line you did not mean to drop.
4. For rewritten history (a mailmap rename, `git filter-repo`, an AI-attribution strip), `git fetch origin && git log HEAD..origin/<branch>` is empty right before the push, because a rewrite silently drops commits that landed after your last fetch. Prefer rewriting in a fresh `git clone --mirror`. If commits were dropped, fetch the orphaned tip by its hash (GitHub keeps it for about 90 days), rebase the chain onto the rewritten base and push again.

Stop and hand the operator the exact command when any condition fails, the push would drop someone else's commit, or the push is denied for permissions; the denial is correct, so do not retry it. For an AI-attribution cleanup, verify `git log --format=%B origin/main..HEAD` passes the scan above before pushing.

## PowerShell from bash

Bash expands `$env:PATH` inside double quotes before PowerShell sees it. Single-quote the PowerShell command: `powershell -NoProfile -Command '$env:PATH -split ";" | Select-String WindowsApps'`.
