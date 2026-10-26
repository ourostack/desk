// Says whether a change touches any of the given paths, so a job can skip work that the change cannot affect and still report success.
// Usage: node changed-scope.mjs <base commit or empty> <path>...   A path ending in "/" is a folder prefix; any other path is an exact file.
// Prints `run=true` or `run=false` (for $GITHUB_OUTPUT) and a reason on stderr. An empty, all-zero or unknown base runs everything:
// a missing base may only widen what runs, never narrow it.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export function touches(changed, scope) {
  return changed.some((file) => scope.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry)))
}

export function decide(base, scope, git = (args) => spawnSync("git", args, { encoding: "utf8" })) {
  if (!base || /^0+$/u.test(base) || git(["cat-file", "-e", `${base}^{commit}`]).status !== 0) return { run: true, reason: `no usable base (${base || "none"}), so everything runs` }
  const diff = git(["diff", "--name-only", base, "HEAD"])
  if (diff.status !== 0) return { run: true, reason: `git diff failed (${diff.stderr.trim()}), so everything runs` }
  const changed = diff.stdout.split("\n").filter(Boolean)
  return touches(changed, scope)
    ? { run: true, reason: `the change touches ${changed.filter((file) => touches([file], scope)).slice(0, 5).join(", ")}` }
    : { run: false, reason: `none of the ${changed.length} changed files is in scope (${scope.join(", ")})` }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, ...scope] = process.argv.slice(2)
  const { run, reason } = decide(base, scope)
  console.error(reason)
  console.log(`run=${run}`)
}
