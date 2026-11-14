// Decides whether the Desk release may build the tip of main now, without ever waiting for a run.
// Pull requests run every check, so a merge whose pull request was tested against the main it landed on needs no second run. When
// main moved while the pull request's checks ran, two green pull requests could combine into a broken main, so the release holds
// until main's own run on that commit has passed, and the passing run starts the release again (desk-release.yml, workflow_run).
// A "main is red" issue (report-main-health.sh) holds every release.
// Usage: node release-gate.mjs --repo <owner/name> --head <sha> --event <push|workflow_run|workflow_dispatch|schedule> [--trigger-sha <sha> --trigger-conclusion <conclusion>]
// Prints `release=true` or `release=false` and a reason on stderr. Exit code 1 only while main is red.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const CI_WORKFLOWS = ["desk-mcp-tests.yml", "desk-windows-suite.yml"]

const isReleaseCommit = (commit) => commit.author?.login === "github-actions[bot]" || String(commit.commit?.message ?? "").startsWith("Release Desk ")
const newest = (runs) => [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]

// True when nothing but release commits landed on main after the pull request's checks started, so the tree they tested is main's tree.
export function movedSince(sha, commitsSince) {
  return commitsSince.some((commit) => commit.sha !== sha && !isReleaseCommit(commit))
}

// Whether each CI workflow's newest push run for `sha` finished green. A commit no run covers is not verified.
export function mainVerified(sha, runsFor) {
  const missing = []
  for (const workflow of CI_WORKFLOWS) {
    const run = newest(runsFor(workflow, sha).filter((candidate) => candidate.event === "push" || (candidate.event === "workflow_dispatch" && !String(candidate.display_title ?? "").startsWith("Partial:"))))
    if (!run) missing.push(`${workflow} has no run on this commit`)
    else if (run.status !== "completed") missing.push(`${workflow} is still running`)
    else if (run.conclusion !== "success") missing.push(`${workflow} finished ${run.conclusion}`)
  }
  return { ok: missing.length === 0, reason: missing.join("; ") }
}

// `api(path)` returns the parsed JSON of a GitHub API read; `redMain()` lists the open "main is red" issues.
export function gate({ repo, head, event, trigger = {}, api, redMain }) {
  const red = redMain()
  if (red.length > 0) return { red, release: false, reason: `main is red: ${red.join(", ")}` }
  const runsFor = (workflow, sha) => api(`repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=30`).workflow_runs ?? []
  const verified = mainVerified(head, runsFor)

  if (event === "push") {
    const prs = api(`repos/${repo}/commits/${head}/pulls`)
    const pr = prs.find((candidate) => candidate.merged_at && candidate.merge_commit_sha === head)
    if (pr) {
      const prRuns = api(`repos/${repo}/actions/workflows/desk-mcp-tests.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=30`).workflow_runs ?? []
      const run = newest(prRuns)
      if (run?.conclusion === "success") {
        const commits = api(`repos/${repo}/commits?sha=${head}&since=${run.run_started_at}&per_page=100`)
        if (!movedSince(head, commits)) return { red, release: true, reason: `#${pr.number} was tested against the main it landed on` }
        if (verified.ok) return { red, release: true, reason: "main's own run passed on this commit" }
        return { red, release: false, reason: `main moved while #${pr.number}'s checks ran, so the release waits for main's run on this commit (${verified.reason}); that run starts the release when it passes` }
      }
    }
    if (verified.ok) return { red, release: true, reason: "main's own run passed on this commit" }
    return { red, release: false, reason: `no pull request's passing checks cover this commit (${verified.reason}); main's run starts the release when it passes` }
  }

  if (event === "workflow_run") {
    if (trigger.sha !== head) return { red, release: false, reason: `the run that finished tested ${String(trigger.sha).slice(0, 12)}, not the tip of main; a newer run will start the release` }
    if (trigger.conclusion !== "success") return { red, release: false, reason: `the run that finished is ${trigger.conclusion}` }
    return verified.ok ? { red, release: true, reason: "main's own runs passed on this commit" } : { red, release: false, reason: `${verified.reason}; the other run starts the release when it passes` }
  }

  return verified.ok ? { red, release: true, reason: "main's own runs passed on this commit" } : { red, release: false, reason: `${verified.reason}; main's run starts the release when it passes` }
}

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.trim()}`)
  return result.stdout
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const repo = option("--repo")
  const head = option("--head")
  const event = option("--event")
  if (!repo || !head || !event) {
    console.error("usage: release-gate.mjs --repo <owner/name> --head <sha> --event <event> [--trigger-sha <sha> --trigger-conclusion <conclusion>]")
    process.exit(2)
  }
  const decision = gate({
    repo,
    head,
    event,
    trigger: { sha: option("--trigger-sha"), conclusion: option("--trigger-conclusion") },
    api: (path) => JSON.parse(gh(["api", path])),
    redMain: () => JSON.parse(gh(["issue", "list", "--repo", repo, "--state", "open", "--label", "red-main", "--json", "number,title"])).map((issue) => `#${issue.number} ${issue.title}`),
  })
  console.error(decision.reason)
  if (decision.red.length > 0) {
    console.error("::error::main is red, so nothing is released until these issues close:")
    for (const line of decision.red) console.error(line)
    process.exit(1)
  }
  console.log(`release=${decision.release}`)
}
