// Progress from outcomes. A card's progress is what shipped and was checked: a merged pull request (in a release when one is named)
// or an acceptance check that passed on a named version. Messages, commits, turns and "busy" never add to it, because an agent can
// produce those without finishing anything. See docs/keep-the-work-moving.md.
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const PR_URL = /^https:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/pull\/(\d+)$/u

/** Where the turn-end gate records endings (the same place its hook writes them). */
export function endingsDir(env = process.env) {
  const home = env.HOME || os.homedir()
  const base = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, ".local", "state")
  return path.join(base, "ouroboros-skills", "desk", "turn-ends")
}

/** Reads every ending the turn-end gate recorded, oldest first. A damaged line is skipped, never counted. */
export function readEndings(dir) {
  let files
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")) } catch { return [] }
  const entries = []
  for (const file of files) {
    for (const line of readFileSync(path.join(dir, file), "utf8").split("\n")) {
      try { const e = JSON.parse(line); if (e && typeof e === "object") entries.push(e) } catch { /* skipped */ }
    }
  }
  return entries.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

/** Looks a pull request up on GitHub with the gh CLI. Returns { merged, repo, mergedAt } or null when GitHub cannot say. */
function ghPull(url) {
  const m = PR_URL.exec(url)
  if (!m) return null
  const run = spawnSync("gh", ["pr", "view", url, "--json", "state,mergedAt", "-q", "[.state,.mergedAt]|@tsv"], { encoding: "utf8", timeout: 20_000 })
  if (run.status !== 0) return null
  const [state, mergedAt] = run.stdout.trim().split("\t")
  return { repo: m[1], merged: state === "MERGED" && Boolean(mergedAt), mergedAt: mergedAt || null }
}

/**
 * Counts what shipped for one card. `evidence` is the list of claims to check; `lookup(url)` answers what GitHub says.
 * Each outcome counts once, however often it is claimed, and only when it checks out.
 */
export function progressOf({ card, endings = [], acceptance = [], lookup = ghPull }) {
  const shipped = []
  const unverified = []
  const seen = new Set()
  for (const e of endings) {
    if (e.card !== card || e.ending?.kind !== "done") continue
    const url = String(e.ending.shipped ?? "")
    if (seen.has(url.toLowerCase())) continue
    seen.add(url.toLowerCase())
    if (!PR_URL.test(url)) { unverified.push({ ref: url, why: "not a pull request URL, so nothing says it merged" }); continue }
    const pr = lookup(url)
    if (!pr) unverified.push({ ref: url, why: "GitHub could not confirm it" })
    else if (!pr.merged) unverified.push({ ref: url, why: "not merged" })
    else shipped.push({ kind: "merged_pr", ref: url, at: pr.mergedAt })
  }
  for (const a of acceptance) {
    if (a.card !== card) continue
    if (a.passed === true && typeof a.check === "string" && a.check && typeof a.version === "string" && a.version) shipped.push({ kind: "acceptance", ref: `${a.check}@${a.version}`, at: a.at ?? null })
    else unverified.push({ ref: String(a.check ?? ""), why: "an acceptance check counts only as passed on a named version" })
  }
  return { card, count: shipped.length, shipped, unverified }
}
