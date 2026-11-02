# Fast, honest CI: worked examples

Three repositories that applied [`SKILL.md`](SKILL.md), measured on GitHub-hosted runners in late October and early November 2026. The first is public and linked to its sources. The other two are private, so they are described without links, and their numbers come from their own run records.

## A public component library

[ourostack/ouro-ui](https://github.com/ourostack/ouro-ui) runs browser, script, end-to-end, visual, latency and install tests on the shared runner pool of a Team-plan organization, through a merge queue. Its [CI speed guide](https://github.com/ourostack/ouro-ui/blob/main/docs/guides/ci-speed.md) ([#466](https://github.com/ourostack/ouro-ui/pull/466)) is the operating manual; the workflow lines below are at commit [`403748d`](https://github.com/ourostack/ouro-ui/blob/403748d2aaee087c96f9561161f18e52a294c6e3/.github/workflows/ci.yml).

- **Concurrency.** A new push to a pull request cancels that pull request's run; every merge-queue entry, push to main and dispatched run gets a group of its own, since other workflows wait on that exact run ([ci.yml lines 12–18](https://github.com/ourostack/ouro-ui/blob/403748d2aaee087c96f9561161f18e52a294c6e3/.github/workflows/ci.yml#L12-L18)).
- **Timeouts from data.** Each job ends within about twice the 90th percentile of its passing runs, and 10 minutes at least, so a hung mirror fails a job instead of holding the queue for 6 hours ([lines 19–27](https://github.com/ourostack/ouro-ui/blob/403748d2aaee087c96f9561161f18e52a294c6e3/.github/workflows/ci.yml#L19-L27)).
- **Test impact that fails closed.** A `plan` job runs a pull request's changed components and every component that imports them. A change to anything shared, or one it can't map, runs everything, and so do main, the merge queue, dispatched runs and release branches. Every required check still reports, and a reduced job passes on what it ran ([lines 36–47](https://github.com/ourostack/ouro-ui/blob/403748d2aaee087c96f9561161f18e52a294c6e3/.github/workflows/ci.yml#L36-L47)).
- **No second run of a tested commit.** A push to main that the merge queue already tested runs only the one job the queue couldn't ([line 46](https://github.com/ourostack/ouro-ui/blob/403748d2aaee087c96f9561161f18e52a294c6e3/.github/workflows/ci.yml#L46)). The slow install test runs in the queue, not on every pull request, unless the pull request changes it ([line 50](https://github.com/ourostack/ouro-ui/blob/403748d2aaee087c96f9561161f18e52a294c6e3/.github/workflows/ci.yml#L50)).
- **Time-balanced shards,** from recorded per-file times, refreshed from the run's own output; reduced runs split their selected tests by the same times ([#481](https://github.com/ourostack/ouro-ui/pull/481)).
- **Merge queue sized to the pool.** It builds at most 3 entries at once, merges 1 to 3 together, only when all are green, and squash-merges ([main's rules](https://api.github.com/repos/ourostack/ouro-ui/rules/branches/main)).
- **A budget guard that judges work, not luck.** `ci-budget` records the critical path from each job's start, so a wait for a runner doesn't count, plus the wall time a developer waits and the runner time taken from the shared pool. It fails only pull requests, and checks an over-budget path against an earlier attempt or full run before blaming the change; on a merge group or push it warns, so it never bounces a queue entry ([lines 1374–1389](https://github.com/ourostack/ouro-ui/blob/403748d2aaee087c96f9561161f18e52a294c6e3/.github/workflows/ci.yml#L1374-L1389)).
- **Honest flakes.** A drop from the queue is treated as a red run, never re-queued automatically; a quarantined test needs an open issue and owner, and only Release and its rehearsal retry, once, on the record ([CI speed guide](https://github.com/ourostack/ouro-ui/blob/main/docs/guides/ci-speed.md#quarantine-a-test-on-the-record)).
- **Gotcha: a cache that silently missed.** Jobs in a container image without `zstd` compressed caches with gzip and missed the caches the runner had saved; lending the runner's own `zstd` fixed it ([lines 29–34](https://github.com/ourostack/ouro-ui/blob/403748d2aaee087c96f9561161f18e52a294c6e3/.github/workflows/ci.yml#L29-L34)).

## A private desktop app (Windows and macOS)

The app's CI took about 35 minutes on main. Two days later, 162 of 164 green first attempts finished under 10 minutes, with a median of 8.8, the same test count per platform and nothing retried.

- **Measure first.** The critical path was one Windows test job at 30.8 minutes, on a 2-core runner that ran one test file at a time. Guesses (a faster temp drive, antivirus off) gained nothing when probed.
- **Fix, shard, cache.** Tests on real timers moved to a held clock (264 s to 127 s). Five duration-balanced shards replaced round-robin ones that had run 92 to 307 s each; balanced, each held about 228 s. A lockfile-keyed cache turned 70–105 s of install into a 19–26 s restore.
- **Fail fast and finish main.** A watcher job cancels a red pull request run 19 s after the first failure; main runs each finish in their own group.
- **Then the queue became the cost.** With jobs fitting in about 9 minutes, main's macOS jobs waited 8 to 22 minutes for a runner, behind other work in an enterprise-wide 50-job macOS cap. Six hours of macOS demand split: pull request CI 37%, branch probes 23%, main 19%, a docs site's pull requests 18%. The fixes:
  - Pull requests that change only tests and tooling run only the macOS unit tests, from a fail-closed list; main, the merge queue and manual runs run every job.
  - Site, probe and pull request macOS jobs wait in a Linux job while main has a macOS job without a runner: it checks every 60 seconds for at most 20 minutes, release paths never wait, and an API error lets every job go.
  - Probes take a Mac only for a Mac question, cap matrices at `max-parallel: 2`, and run on dispatch or their own paths.
  - Estimated effect for jammed main runs: mean macOS wait from 14.9 to 7.6 minutes.
- **Gotcha: queued jobs that look like work.** GitHub reports a job cancelled while still queued as if it ran for its whole wait. Count only jobs that got a runner; here that took six hours of macOS demand from 2,658 to 2,347 runner-minutes.
- **A shard plan drifts.** Planned shards of 366 s ran 295 to 475 s once test times changed, and one hit its timeout. Re-measured times, one more shard and a guard that new tests add a shard keep it balanced.
- **The runner was the flake, twice.** A macOS disk that stalled for seconds under heavy writes, and a Windows image slow to read a runtime on first use, failed timing checks. Each was proven by measurement across many jobs and fixed without loosening a check: the macOS tests run from a RAM disk, and a background step reads the runtime's files during the build, off the critical path.
- **Budget guard.** The last job needs every other one, fails a pull request over 10 minutes, and on main opens or updates one tracked item with an owner. A test fails when a new job isn't in its `needs`.

## A private context repository

A documentation and shared-context repository whose workflows run on Linux in 12 s to about 3.4 minutes. Speed was already fine; the work was to keep it so and to stop paying for runner trips.

- **Measured 484 runs before changing anything.** No job had waited more than 17 s for a runner.
- **One fewer runner trip.** A follow-on job that checked out and set up Node again became steps at the end of the job before it, saving about 15 s of a 39 s run and one pass through the organization's runner queue.
- **A budget guard on every workflow,** ported from the desktop app: it fails over 10 minutes and only warns on scheduled runs.

## Further reading

- GitHub: [Actions limits](https://docs.github.com/en/actions/reference/limits), [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [budgets and alerts](https://docs.github.com/en/billing/concepts/budgets-and-alerts), [larger runners](https://docs.github.com/en/actions/concepts/runners/larger-runners), [concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), [merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue), [dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching), [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).
- Sharding and selection: [Playwright sharding](https://playwright.dev/docs/test-sharding), [the rise of test impact analysis](https://martinfowler.com/articles/rise-test-impact-analysis.html).
- Flakes: [flaky tests at Google and how we mitigate them](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html).
