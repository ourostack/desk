---
name: fast-honest-ci
description: Use when creating or reviewing a CI workflow or merge queue, when CI is slow, queued, flaky, red, over budget or out of Actions minutes, when re-running a failed job, owning the default branch's health or planning a release. Not for one test's product logic.
---

# Fast, honest CI

CI should cost as little wall clock and money as it can while proving the same things. Every pipeline aims to finish within 10 minutes of the push, queueing included, on free or standard runners (a goal; the guard in section 5 enforces only the work), with every gate still running, and every red run gets a cause before anyone runs it again. Never trade a gate for speed. Worked examples (a public component library, a private desktop app and a private context repository) are in [`examples.md`](examples.md). The GitHub figures below were checked on 2026-11-02; they change, so check the linked page before relying on a number.

## 1. Measure before changing anything

- Download CI output from the operator's own repositories without asking.
- CI is the merge gate, not the workbench. When the product itself is slow or janky, profile it locally on synthetic data shaped like the human's, find where the time goes, and fix that cause; never iterate on a theory by pushing and rerunning CI to see whether it turns green. Prove a fix locally first, then let CI confirm it once.
- Pull the run's jobs and steps from the Actions API and find the critical path: the job that finishes last, and why. Count queue time separately from work time. Change nothing on a guess.
- Once jobs are fast, waiting for a runner usually costs more than the work. Every plan caps concurrent jobs per account: standard runners allow 20 on Free, 60 on Team and 500 on Enterprise, and macOS only 5, 5 and 50, a macOS cap that larger runners share ([Actions limits](https://docs.github.com/en/actions/reference/limits)). Every repository in the organization, or the enterprise, draws on the same pool.
- Know what a minute costs. Standard runners are free in public repositories, but larger runners are billed even there; in private repositories a macOS minute costs about ten times a Linux one ($0.062 against $0.006), and a failed run plus its re-run pays for both ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).

## 2. Speed it up, in this order

1. **Fix the slowest tests at their cause:** real timers, fixed sleeps, a close that waits on nothing. A faster test is faster on every shard, laptop and re-run.
2. **Shard by measured time, not by count or name.** Put the longest file into the emptiest shard, from times recorded on the same runner type, and keep two guards: a test that every file runs exactly once, and one that fails when new or slower tests push a shard past its share, so a shard can't quietly become the critical path. Splitting by count balances only when files are even ([Playwright sharding](https://playwright.dev/docs/test-sharding)).
3. **Cache by lockfile.** Key on OS, architecture, runtime version and the lockfile hash, and save the cache before any test can fail. A repository holds 10 GB of cache by default, entries unused for 7 days are evicted, and a pull request can restore its base branch's cache ([dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)).
4. **Split independent work into its own jobs,** and wait on events, never fixed sleeps. The run is as long as its longest job.
5. **Run less where it is safe, and fail closed.** Choose what to run inside the workflow (a `changes` or `plan` job), never with a workflow-level `paths` filter on a required check: a workflow skipped that way leaves its checks "Pending" and blocks the merge ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)). Anything shared, unmapped or unreadable runs everything, and the default branch and the merge queue always run everything: test-impact selection needs that full run as its safety net ([test impact analysis](https://martinfowler.com/articles/rise-test-impact-analysis.html)).
6. **Fail fast on pull requests only.** A pull request's run stops soon after a job fails, preferably through a watcher job that cancels the run, which keeps the failed job marked "failure" with its logs. A matrix's `fail-fast` is on by default and cancels its siblings on every branch ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategyfail-fast)), so set it to `${{ github.event_name == 'pull_request' }}`, or to `false` where a watcher job fails fast. Default-branch runs always finish whole.
7. **One run per commit on the default branch; cancel only superseded pull request runs.** Use `cancel-in-progress` for pull requests only, and give each default-branch run its own group: a shared group cancels and replaces a pending run even without `cancel-in-progress`, and groups shared across workflows cancel each other ([concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)). A commit with no verdict hides which merge broke the branch.
8. **Give every job a `timeout-minutes`** near twice its usual time; the default is 360 minutes ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes)). Time out a hung test so it fails its shard in minutes and names itself.
9. **Add the budget guard last,** or it fails every run before the speed-ups land (section 5).

## 3. Spend runners like money

- **Standard runners first.** A larger or paid runner needs the owner's explicit approval of its budget, recorded before the first run. Speed bought with paid minutes is a decision, not an optimization.
- **Give every organization and costly repository a budget, and know what it stops.** Actions budgets can stop usage when reached and can be scoped to single repositories ([budgets and alerts](https://docs.github.com/en/billing/concepts/budgets-and-alerts)). In one organization, one private repository's macOS minutes spent the whole $10 Actions budget in a day, and CI stopped across the organization, a public repository included (observed; the evidence is private). Scope a budget to the costly repository, so it stops alone.
- **Treat scarce pools as scarce.** Run on macOS, Windows or GPU runners only what is that platform's own; everything else runs on Linux. Merging jobs saves setup seconds; moving work off the scarce runner saves minutes and queue time.
- **Yield to the default branch.** Work that can wait (pull request jobs on a scarce runner, scheduled jobs, probes) waits in a cheap Linux job, with a cap, while the default branch's CI has a job without a runner. A release path never waits, and an API error lets everything run at once. Yielding may delay a job, never skip or fail one.
- **Cap experiments.** A probe takes a scarce runner only for a question about that platform, caps its matrix with `max-parallel` ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategymax-parallel)), and runs on dispatch or on its own files' paths, never on every push.
- **Poll gently.** A watcher or yield step spends the token's API budget (`GITHUB_TOKEN`: 1,000 requests an hour per repository, 15,000 on Enterprise Cloud, [Actions limits](https://docs.github.com/en/actions/reference/limits)). Poll at most every minute in CI and every 5 minutes from an agent session, and stop on 403 or 429.
- **Cancel what nobody will read:** superseded pull request runs, and a merge-queue run whose entry has left the queue.

## 4. Merge queues

- Workflows that are required checks need the `merge_group` trigger, or the queue waits on checks that never start ([merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
- **Size build concurrency to the runner pool.** It limits how many `merge_group` builds run at once (1 to 100). Entries building at once, times jobs per run, plus pull request traffic, should fit under the plan's concurrent-job limit. Merge limits batch merges; they don't combine builds.
- **Don't test the same commit twice.** When the queue fast-forwards the branch to a commit its group already tested, the push run can skip the suite.
- **A drop is a red run:** read its failure first. A known or likely flake may be re-run once, with the run link stated in the pull request; then fix the cause. Never close a pull request or discard work because a check failed.
- **Keep generated files out of commits,** or queue entries that regenerate the same file conflict and drop.

## 5. The budget guard

A final job needs every other job and writes each job's minutes to the step summary. It records two numbers: the critical path, timed from each job's start so a wait for a runner doesn't count, and the wall clock from the run's start to the last job's finish, queueing included. On pull requests it fails only when the critical path is over budget, since a shared runner pool can make any green run wait. Wall clock is reported, never a reason to fail. On the default branch, the merge queue and scheduled runs it only reports, and an over-budget run files or updates one tracked item with an owner. A test fails when a new job is missing from the guard's `needs`. Ratchet the budget down as the median falls; never raise it to pass.

## 6. A red check

- **Read the failure, then fix its cause.** Read the exact failure and the log around it, name the two things racing, make the bad order happen every time, then fix it where the truth is decided. Flakes are common, not rare: at Google, 84% of observed pass-to-fail transitions involved a flaky test ([flaky tests at Google](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html)), and each one hides real breakage until it has a cause.
- **Three outcomes:** a test bug, fixed with probe counts that fail without the fix and pass with it; a product bug, where you stop, tell its owner and fix the product with a regression test; or a known failure whose signature (its exact message) is already filed with an owner, which may get one re-run, recorded on the run or pull request. GitHub's own service failing while every test passed is filed the same way.
- **Never** loosen a gate, lengthen a timeout, take fewer samples, retry automatically, or skip or quarantine a test without an open issue and owner. A bounded, logged retry in product code against a busy OS resource is behaviour, not a test re-run.
- **Revert on evidence, not suspicion.** Probe the suspect change first.
- **Own the default branch.** A watcher alerts on each new red run (poll at most every 5 minutes), one owner is named within 15 minutes, a root-cause fix or a clean revert lands before the next release, and each red run, owner and outcome is recorded.

## 7. Ship small, ship often

- **One change per pull request.** A big change is slower to test, harder to verify and harder to bisect or revert.
- **Release each proven fix the same day,** without waiting for other fixes. Never batch fixes behind a daily or weekly schedule. A scheduled release may still run, but only to sweep up what's left; nothing waits for it.
- **A merged change reaches its live surface in seconds.** Measure from merge to live and treat a slow deploy as a pipeline defect to fix, not a wait to accept: a site, tracker or page update that takes 40 minutes to appear is broken (Ari, 2026-11-11 15:51 PT: "these tracker updates/deployments need to take seconds, not this crazy 40+ minutes LOL"; 2026-11-10 15:18 PT: "any value you ship should be deployed within seconds"). Prefer a merge queue with auto-merge over waiting to press merge (Ari, 2026-11-12 12:37 PT: "don't we want merge queue + auto merge?").
- **Fast CI makes this cheap.** If a release takes too long to ship one fix at a time, fix the pipeline, not the cadence. A worked release train is in [`examples.md`](examples.md#a-private-desktop-app-windows-and-macos).

## Done when

Run links show the wall clock and runner minutes before and after; test counts per platform are the same or higher; nothing retries that didn't before; nothing new runs on a paid runner without a recorded approval; a flake fix names its run, cause and probe counts; an independent reviewer passed it (`desk:independent-review`); and the next default-branch runs stay under budget.
