// The fail-fast pass every pull request runs before the full suites: it parses every changed JavaScript, JSON and YAML file and runs the
// changed Desk unit test files that are quick on their own, so a syntax error or a broken test fails in about two minutes instead of after
// the coverage shards. It narrows nothing: the coverage shards still run every test file, including the ones this pass leaves to them.
// Usage: node quick-checks.mjs <base commit or empty>
// Exit code: 1 when a file does not parse or a test fails, 0 otherwise.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadDurations, weightOf } from "./suite-shards.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const testsPrefix = "tests/desk/mcp/__tests__/"

// The budget is in the Windows seconds the duration table records; a Linux runner takes about a quarter of that, and four files run at
// once, so a full budget is well under a minute. A single file above the per-file limit is left to the shards.
export const BUDGET_SECONDS = 600
export const PER_FILE_SECONDS = 120

// Which changed files to parse and which changed test files to run. `changed` is repository-relative with forward slashes.
export function plan(changed, durations, exists = (file) => fs.existsSync(path.join(repoRoot, file))) {
  const present = [...new Set(changed)].filter(exists).sort()
  const parse = {
    js: present.filter((file) => /\.(?:c|m)?js$/u.test(file)),
    json: present.filter((file) => file.endsWith(".json")),
    yaml: present.filter((file) => /\.ya?ml$/u.test(file)),
  }
  const tests = present.filter((file) => file.startsWith(testsPrefix) && file.endsWith(".test.js")).map((file) => file.slice(testsPrefix.length))
  const run = []
  const deferred = []
  let spent = 0
  // Lightest first, so the budget runs as many files as it can.
  for (const file of [...tests].sort((a, b) => weightOf(a, durations) - weightOf(b, durations) || (a < b ? -1 : 1))) {
    const seconds = weightOf(file, durations)
    if (seconds > PER_FILE_SECONDS || spent + seconds > BUDGET_SECONDS) deferred.push(file)
    else {
      run.push(file)
      spent += seconds
    }
  }
  return { parse, run: run.sort(), deferred: deferred.sort() }
}

export function changedFiles(base, git = (args) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" })) {
  if (!base || /^0+$/u.test(base) || git(["cat-file", "-e", `${base}^{commit}`]).status !== 0) return null
  const diff = git(["diff", "--name-only", "--no-renames", "--diff-filter=d", base, "HEAD"])
  return diff.status === 0 ? diff.stdout.split("\n").filter(Boolean) : null
}

// One message per file that does not parse; `root` is the folder the paths are relative to.
export function parseErrors({ js, json, yaml }, root = repoRoot) {
  const require = createRequire(path.join(repoRoot, "plugins", "desk", "mcp", "package.json"))
  const { load } = require("js-yaml")
  const errors = []
  for (const file of js) {
    const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { encoding: "utf8" })
    if (result.status !== 0) errors.push(`${file}: ${result.stderr.trim().split("\n").slice(0, 6).join("\n")}`)
  }
  for (const file of json) {
    try { JSON.parse(fs.readFileSync(path.join(root, file), "utf8")) } catch (error) { errors.push(`${file}: ${error.message}`) }
  }
  for (const file of yaml) {
    try { load(fs.readFileSync(path.join(root, file), "utf8")) } catch (error) { errors.push(`${file}: ${error.message.split("\n")[0]}`) }
  }
  return errors
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const changed = changedFiles(process.argv[2])
  if (changed === null) {
    console.log("No usable base, so this pass checks nothing; the full suites run every file.")
    process.exit(0)
  }
  const { parse, run, deferred } = plan(changed, loadDurations())
  const errors = parseErrors(parse)
  console.log(`Parsed ${parse.js.length} JavaScript, ${parse.json.length} JSON and ${parse.yaml.length} YAML files.`)
  for (const error of errors) console.log(`::error::${error}`)
  if (deferred.length > 0) console.log(`Left to the coverage shards (over this pass's time budget): ${deferred.join(", ")}`)
  let failed = errors.length > 0
  if (run.length > 0) {
    console.log(`Running ${run.length} changed test files: ${run.join(", ")}`)
    const result = spawnSync(process.execPath, [
      "--import", path.join(repoRoot, testsPrefix, "_isolated_env.mjs"), "--test", "--test-concurrency=4",
      ...run.map((file) => path.join(repoRoot, testsPrefix, file)),
    ], { cwd: path.join(repoRoot, "plugins", "desk", "mcp"), stdio: "inherit", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    if (result.status !== 0) failed = true
  } else console.log("No changed test file to run here.")
  process.exit(failed ? 1 : 0)
}
