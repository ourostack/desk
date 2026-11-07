// The Desk release ships only what main's full CI passed. Pull requests run the fast tier; the Windows suite, the macOS and Windows legs,
// the runtime packs and the release dry runs run on main after the merge (AGENTS.md, "CI tiers"). Before the release builds, this waits
// for each named workflow's newest run on main whose commit the release carries, and fails unless that run succeeded.
// A main commit with no run of a workflow (a push its path filter skipped, or a merge made with the workflow token) is covered by the
// newest earlier run: such a merge ran the same workflows on its branch first (superpowers-upstream.yml dispatches them).
// Usage: node main-ci-gate.mjs --repo <owner/name> --head <sha> --workflows <a.yml,b.yml> [--timeout-min 50] [--poll-sec 30]
// Exit code: 0 when every workflow's newest run passed, 1 otherwise (failed, cancelled, missing or still running at the time limit).
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const MAIN_EVENTS = new Set(["push", "workflow_dispatch"])

// The newest main run of one workflow whose commit `head` contains, or null.
export function newestRun(runs, isAncestor) {
  return runs
    .filter((run) => MAIN_EVENTS.has(run.event) && run.head_branch === "main" && isAncestor(run.head_sha))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null
}

export async function gate({ workflows, listRuns, isAncestor, sleep, now, pollMs, timeoutMs, log }) {
  const deadline = now() + timeoutMs
  const problems = []
  for (const workflow of workflows) {
    for (;;) {
      const run = newestRun(listRuns(workflow), isAncestor)
      if (run === null) {
        problems.push(`${workflow}: no run on main covers this commit, so nothing has tested it there`)
        break
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
  const listRuns = (workflow) => {
    const result = spawnSync("gh", ["api", `repos/${repo}/actions/workflows/${workflow}/runs?branch=main&per_page=50`], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(`could not list ${workflow} runs: ${result.stderr.trim()}`)
    return JSON.parse(result.stdout).workflow_runs ?? []
  }
  const isAncestor = (sha) => spawnSync("git", ["merge-base", "--is-ancestor", sha, head]).status === 0
  const problems = await gate({
    workflows, listRuns, isAncestor, log: console.log, now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollMs: Number(arg("--poll-sec", "30")) * 1000,
    timeoutMs: Number(arg("--timeout-min", "50")) * 60_000,
  })
  for (const problem of problems) console.log(`::error::${problem}`)
  if (problems.length > 0) console.log("main's CI has not passed on the commit this release would ship; fix main (AGENTS.md says who) and the next release run ships it.")
  process.exit(problems.length > 0 ? 1 : 0)
}
