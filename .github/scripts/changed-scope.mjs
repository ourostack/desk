// Says whether a change touches any of the given paths, so a job can skip work that the change cannot affect and still report success.
// Usage: node changed-scope.mjs [--outside] <base commit or empty> <path>...   A path ending in "/" is a folder prefix; any other path is an exact file.
// Without --outside it prints `run=true` when a changed file is in the scope. With --outside it prints `run=true` when a changed file is
// outside the scope, so the scope lists the only paths that may skip (the docs no test reads). Either way it prints `run=true` or
// `run=false` (for $GITHUB_OUTPUT) and a reason on stderr. An empty, all-zero or unknown base runs everything: a missing base may only
// widen what runs, never narrow it.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const inScope = (file, scope) => scope.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry))

export function touches(changed, scope) {
  return changed.some((file) => inScope(file, scope))
}

export function decide(base, scope, git = (args) => spawnSync("git", args, { encoding: "utf8" }), { outside = false } = {}) {
  if (!base || /^0+$/u.test(base) || git(["cat-file", "-e", `${base}^{commit}`]).status !== 0) return { run: true, reason: `no usable base (${base || "none"}), so everything runs` }
  const diff = git(["diff", "--name-only", "--no-renames", base, "HEAD"])
  if (diff.status !== 0) return { run: true, reason: `git diff failed (${diff.stderr.trim()}), so everything runs` }
  const changed = diff.stdout.split("\n").filter(Boolean)
  const hits = changed.filter((file) => inScope(file, scope) !== outside)
  if (outside) {
    return hits.length > 0
      ? { run: true, reason: `the change touches ${hits.slice(0, 5).join(", ")}, outside the skippable paths (${scope.join(", ")})` }
      : { run: false, reason: `every one of the ${changed.length} changed files is in the skippable paths (${scope.join(", ")})` }
  }
  return hits.length > 0
    ? { run: true, reason: `the change touches ${hits.slice(0, 5).join(", ")}` }
    : { run: false, reason: `none of the ${changed.length} changed files is in scope (${scope.join(", ")})` }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const outside = args[0] === "--outside"
  const [base, ...scope] = outside ? args.slice(1) : args
  const { run, reason } = decide(base, scope, undefined, { outside })
  console.error(reason)
  console.log(`run=${run}`)
}
