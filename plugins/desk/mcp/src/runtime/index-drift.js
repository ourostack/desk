// Index tracing: a shared diagnostic primitive that snapshots the Git staging
// area immediately before and immediately after Desk's own bash blocks run
// (boot checks, migration blocks), so a staged path that appears mid-run is
// caught the moment it happens instead of surfacing later as an opaque pull
// failure. See spec.md §3 "Index tracing" — this is the diagnostic primitive
// every later part of the design reuses; it depends on nothing else in that
// design (no `kaizen-file.js`, no failure-contract filer).
//
// `spawnGit` is an injectable seam over `node:child_process`'s `spawnSync`,
// for tests only; real callers never pass it — mirrors `util/git-stage.js`'s
// own `run()` helper, hardened the way `runtime/git-inspection.js` hardens
// its own Git calls (`core.fsmonitor=false`, `core.hooksPath=/dev/null`,
// `GIT_OPTIONAL_LOCKS=0`), plus a short timeout of its own: a snapshot call
// sits on a budgeted hot path (a boot check's own budget, as little as 20 ms;
// a migration block's, up to 2 s), so an unbounded `git` can never hang it.

const INDEX_TRACE_TIMEOUT_MS = 1000

function run(spawnGit, root, args) {
  return spawnGit("git", ["-C", root, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8",
    timeout: INDEX_TRACE_TIMEOUT_MS,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  })
}

/**
 * The paths currently staged (the index) under `root`, or `null` when the
 * read failed or timed out — never thrown. `null` is deliberately not `[]`:
 * they mean different things. A caller that snapshots `null` before a block
 * runs must skip the after-snapshot and the diff entirely, not treat the
 * unknown "before" as empty — that would turn a merely-failed read into a
 * false positive naming every already-staged path as new.
 */
export function snapshotStagedPaths({ root, spawnGit }) {
  let result
  try {
    result = run(spawnGit, root, ["diff", "--cached", "--name-only"])
  } catch {
    return null
  }
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

/** The paths present in `after` but not in `before` — what newly became staged between two snapshots. */
export function diffStagedPaths(before, after) {
  const seen = new Set(before)
  return after.filter((entry) => !seen.has(entry))
}

/**
 * The `Desk problem:` block every mechanism emits (spec.md, "The block
 * format"): a `Desk problem: <mechanism> — <symptom>` header line, then
 * `broke`/`means`/`fix`/`file`/`tell`, each on its own two-space-indented
 * line, in that order. `symptom` is a short, identity-bearing phrase for the
 * header alone (for example `unexpected file staged during probe`); `broke`
 * carries the full detail (exact paths and all) for the body.
 */
export function formatDeskProblem({ mechanism, symptom, broke, means, fix, file, tell }) {
  return [
    `Desk problem: ${mechanism} — ${symptom}`,
    `  broke: ${broke}`,
    `  means: ${means}`,
    `  fix: ${fix}`,
    `  file: ${file}`,
    `  tell: ${tell}`,
  ].join("\n")
}

/** The honest, no-op filing step: never called with `env` missing -- see the header above `formatIndexDriftProblem`. */
async function noFiler() {
  return { file: "not filed: filer_unavailable" }
}

/**
 * The complete index-drift `Desk problem:` block for `drift` (one or more
 * newly staged paths) found while `label` ran — a boot check's own id, or a
 * migration's `<id>:detect`/`<id>:safety-check`/`<id>:migrate` tag. `kind`
 * names what kind of thing `label` is, for the prose ("boot check" or
 * "migration block"). Shared by every index-tracing call site so the wording
 * never drifts between them.
 *
 * `means` and `tell` deliberately stop short of naming `label` as the staging
 * agent: the same-process check and a different session's own work landing
 * at that exact moment look identical from here, so both are named as
 * possibilities rather than one being asserted as fact.
 *
 * Migrated onto the failure contract (spec.md §1, Part 5): filing is never
 * done here, and never awaited by this function's own callers past this
 * call -- `fileProblem` is an injectable hook. With no default filing
 * step (real callers on a hot, tightly budgeted path could not afford an
 * account lookup and `gh` calls inline), the block renders honestly with
 * `file: not filed: filer_unavailable`; each real call site (boot-
 * checks.cjs's registry loop, pending-migrations.js's `pendingMigrations`
 * and `runMigrationCli`) supplies its own closure that queues the same
 * detached `file-desk-problem.js` run every other migrated mechanism uses
 * and reports `file: filing in background`.
 */
export async function formatIndexDriftProblem({ kind, label, drift, env, host, fileProblem = noFiler }) {
  const plural = drift.length !== 1
  const paths = drift.join(", ")
  const { file } = await fileProblem({ env, host, reason: `${label}: unexpected staged path(s) appeared during this ${kind}: ${paths}` })
  return formatDeskProblem({
    mechanism: "index-drift",
    symptom: `unexpected ${plural ? "files" : "file"} staged during ${label}`,
    broke: `${label}: unexpected staged path(s) appeared during this ${kind}: ${paths}`,
    means: `${paths} appeared in the index while ${kind} "${label}" ran — it may have staged ${plural ? "them" : "it"}, or another session may have staged ${plural ? "them" : "it"} at the same time`,
    fix: "not undone — staged paths left as-is for inspection",
    file,
    tell: `${plural ? "Files" : "A file"} appeared in the index while "${label}" ran (${paths}); it may have staged ${plural ? "them" : "it"}, or another session may have staged ${plural ? "them" : "it"} at the same time. Left as-is so you can inspect it.`,
  })
}
