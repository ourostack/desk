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
// own `run()` helper exactly.

function run(spawnGit, root, args) {
  return spawnGit("git", ["-C", root, ...args], { encoding: "utf8" })
}

/**
 * The paths currently staged (the index) under `root`. A failing or missing
 * `git` yields `[]` rather than throwing — a snapshot that can't be taken
 * fails toward reporting no drift, never a false one.
 */
export function snapshotStagedPaths({ root, spawnGit }) {
  let result
  try {
    result = run(spawnGit, root, ["diff", "--cached", "--name-only"])
  } catch {
    return []
  }
  if (result.status !== 0 || typeof result.stdout !== "string") return []
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
 * The five-field `Desk problem:` block every migrated mechanism emits (spec.md,
 * "The block format"): a `Desk problem: <mechanism> — <broke>` header line,
 * then `broke`/`means`/`fix`/`file`/`tell`, each on its own two-space-indented
 * line, in that order. The header's short symptom is `broke`'s own text, so a
 * caller that wants a specific check or migration identity to show up in the
 * header names it first, inside `broke` (for example `` `${id}: ...` ``).
 */
export function formatDeskProblem({ mechanism, broke, means, fix, file, tell }) {
  return [
    `Desk problem: ${mechanism} — ${broke}`,
    `  broke: ${broke}`,
    `  means: ${means}`,
    `  fix: ${fix}`,
    `  file: ${file}`,
    `  tell: ${tell}`,
  ].join("\n")
}
