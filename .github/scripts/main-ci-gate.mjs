// The Desk release ships only what main's full CI passed. Pull requests run the fast tier; the Windows suite, the macOS and Windows legs,
// the runtime packs and the release dry runs run on main after the merge (AGENTS.md, "CI tiers"). Before the release builds, this waits
// for each named workflow's newest run that covers the release's commit, and fails unless that run succeeded.
// A run covers the commit only when nothing that differs between the run's commit and the release's commit would have started the
// workflow on a push to main (its paths or paths-ignore filter). So a commit a path filter skipped is covered by the run before it, a
// merge made with the workflow token is covered by the dispatched run on its branch (superpowers-upstream.yml), and a commit that did
// change something the workflow tests waits for its own run. A dispatch that ran only some files (run-name "Partial: ...") never counts.
// Usage: node main-ci-gate.mjs --repo <owner/name> --head <sha> --workflows <a.yml,b.yml> [--timeout-min 50] [--appear-min 10] [--poll-sec 30]
// Exit code: 0 when every workflow's covering run passed, 1 otherwise (failed, cancelled, missing or still running at the time limit).
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

export const PARTIAL_TITLE = "Partial:"

// A GitHub Actions path filter pattern as a regular expression: `**` crosses folders, `*` and `?` do not.
export function globRegExp(pattern) {
  let source = ""
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?"
        i += 2
      } else {
        source += ".*"
        i += 1
      }
    } else if (char === "*") source += "[^/]*"
    else if (char === "?") source += "[^/]"
    else source += char.replace(/[.+^${}()|[\]\\]/u, "\\$&")
  }
  return new RegExp(`^${source}$`, "u")
}

// The push trigger's path filter in a workflow file: { paths } or { ignore } or {} for none. Reads the plain block style our
// workflows use (`on:` / `  push:` / `    paths:` / `      - "glob"`).
export function pushFilters(text) {
  const lines = text.split(/\r?\n/u)
  const on = lines.indexOf("on:")
  const push = lines.findIndex((line, index) => index > on && line === "  push:")
  if (on === -1 || push === -1) throw new Error("the workflow has no push trigger")
  const filters = {}
  let key = null
  for (const line of lines.slice(push + 1)) {
    if (/^ {0,2}\S/u.test(line)) break
    const header = /^ {4}(paths|paths-ignore):\s*$/u.exec(line)
    if (header) {
      key = header[1] === "paths" ? "paths" : "ignore"
      filters[key] = []
      continue
    }
    const entry = /^ {6}-\s+["']?([^"'\s]+)["']?\s*$/u.exec(line)
    if (key && entry) filters[key].push(entry[1])
    else if (/^ {4}\S/u.test(line)) key = null
  }
  return filters
}

// Whether a push changing these files starts the workflow. GitHub applies `paths` in order, so a later `!pattern` drops a match.
export function triggers(filters, files) {
  if (files.length === 0) return false
  if (filters.paths) {
    return files.some((file) => filters.paths.reduce((hit, pattern) => (
      pattern.startsWith("!") ? (globRegExp(pattern.slice(1)).test(file) ? false : hit) : (globRegExp(pattern).test(file) ? true : hit)
    ), false))
  }
  if (filters.ignore) return files.some((file) => !filters.ignore.some((pattern) => globRegExp(pattern).test(file)))
  return true
}

// The newest run of one workflow that tests what `head` carries, or null. `changedSince(sha)` lists the files that differ between
// that commit and head, or returns null when the commit is not available.
export function coveringRun(runs, filters, changedSince) {
  const counted = runs
    .filter((run) => (run.event === "push" && run.head_branch === "main")
      || (run.event === "workflow_dispatch" && !String(run.display_title ?? "").startsWith(PARTIAL_TITLE)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  for (const run of counted) {
    const changed = changedSince(run.head_sha)
    if (changed !== null && !triggers(filters, changed)) return run
  }
  return null
}

export async function gate({ workflows, listRuns, filtersFor, changedSince, sleep, now, pollMs, timeoutMs, appearMs, log }) {
  const start = now()
  const deadline = start + timeoutMs
  const problems = []
  for (const workflow of workflows) {
    const filters = filtersFor(workflow)
    for (;;) {
      let runs
      try {
        runs = listRuns(workflow)
      } catch (error) {
        // A transient API failure is retried until the time limit, not taken as a verdict.
        if (now() >= deadline) {
          problems.push(`${workflow}: could not list its runs before the time limit (${error.message})`)
          break
        }
        log(`${workflow}: listing runs failed, retrying (${error.message})`)
        await sleep(pollMs)
        continue
      }
      const run = coveringRun(runs, filters, changedSince)
      if (run === null) {
        // A run starts within seconds of its push; allow a short wait for one that is not listed yet.
        if (now() >= Math.min(deadline, start + appearMs)) {
          problems.push(`${workflow}: no run covers this commit (it changed what the workflow tests, and no run on it exists), so nothing has tested it`)
          break
        }
        log(`${workflow}: no run covers this commit yet, waiting for one to appear`)
        await sleep(pollMs)
        continue
      }
      if (run.status === "completed") {
        if (run.conclusion === "success") log(`${workflow}: passed on ${run.head_sha.slice(0, 12)} (${run.html_url})`)
        else problems.push(`${workflow}: ${run.conclusion} on ${run.head_sha.slice(0, 12)} (${run.html_url})`)
        break
      }
      if (now() >= deadline) {
        problems.push(`${workflow}: still ${run.status} on ${run.head_sha.slice(0, 12)} after the time limit (${run.html_url})`)
        break
      }
      log(`${workflow}: waiting for ${run.html_url} (${run.status})`)
      await sleep(pollMs)
    }
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
  const repo = arg("--repo")
  const head = arg("--head")
  const workflows = String(arg("--workflows", "")).split(",").filter(Boolean)
  if (!repo || !/^[0-9a-f]{40}$/u.test(head ?? "") || workflows.length === 0) {
    console.error("usage: main-ci-gate.mjs --repo <owner/name> --head <sha> --workflows <a.yml,b.yml>")
    process.exit(2)
  }
  const workflowDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows")
  const api = (query) => {
    const result = spawnSync("gh", ["api", query], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr.trim())
    return JSON.parse(result.stdout).workflow_runs ?? []
  }
  const listRuns = (workflow) => [
    ...api(`repos/${repo}/actions/workflows/${workflow}/runs?branch=main&event=push&per_page=50`),
    ...api(`repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=50`),
  ]
  const changedSince = (sha) => {
    if (!/^[0-9a-f]{40}$/u.test(sha) || spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) return null
    const diff = spawnSync("git", ["diff", "--name-only", "--no-renames", sha, head], { encoding: "utf8" })
    return diff.status === 0 ? diff.stdout.split("\n").filter(Boolean) : null
  }
  const problems = await gate({
    workflows, listRuns, changedSince, log: console.log, now: Date.now,
    filtersFor: (workflow) => pushFilters(readFileSync(path.join(workflowDir, workflow), "utf8")),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollMs: Number(arg("--poll-sec", "30")) * 1000,
    timeoutMs: Number(arg("--timeout-min", "50")) * 60_000,
    appearMs: Number(arg("--appear-min", "10")) * 60_000,
  })
  for (const problem of problems) console.log(`::error::${problem}`)
  if (problems.length > 0) console.log("main's CI has not passed on the commit this release would ship; fix main (AGENTS.md says who) and the next release run ships it.")
  process.exit(problems.length > 0 ? 1 : 0)
}
