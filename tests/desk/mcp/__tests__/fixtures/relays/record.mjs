// Records the raw GitHub data a relay replay needs, for one repository, into a directory kept outside the repository.
// Run it by hand with a signed-in `gh`; the sanitizer turns the raw files into the small fixtures the tests read. Nothing here runs in CI.
//
//   node record.mjs --repo owner/name --out <raw-dir> [--pulls 40] [--main-workflow ci.yml] [--watch-workflow site.yml] [--days 3]
//                   [--gh "gh"]   (the command that runs `gh`; for example `node gh-account.mjs work`)
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({ options: { repo: { type: "string" }, out: { type: "string" }, pulls: { type: "string", default: "0" }, "main-workflow": { type: "string" }, "watch-workflow": { type: "string" }, days: { type: "string", default: "3" }, gh: { type: "string", default: "gh" } } })
if (!values.repo || !values.out) throw new Error("--repo and --out are required")
const [command, ...prefix] = values.gh.split(" ")
const api = (route) => JSON.parse(execFileSync(command, [...prefix, "api", route], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }))
const save = (name, value) => writeFileSync(path.join(values.out, name), `${JSON.stringify(value, null, 1)}\n`)
mkdirSync(values.out, { recursive: true })

const repo = values.repo
const wanted = Number(values.pulls)

/** Pages through a list route until `enough` says so or a page comes back short. */
function pages(route, key, enough = () => false) {
  const all = []
  for (let page = 1; page <= 30; page++) {
    const body = api(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`)
    const list = key ? body[key] : body
    all.push(...list)
    if (list.length < 100 || enough(all)) break
  }
  return all
}

if (wanted > 0) {
  const closed = pages(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, null, (all) => all.filter((pull) => pull.merged_at).length >= wanted * 1.5)
  const merged = closed.filter((pull) => pull.merged_at).sort((a, b) => b.merged_at.localeCompare(a.merged_at)).slice(0, wanted)
  const pullRecords = merged.map((pull) => ({ number: pull.number, mergedAt: pull.merged_at, headSha: pull.head.sha, draft: pull.draft, labels: pull.labels.map((label) => label.name), baseRef: pull.base.ref }))
  const records = pullRecords.map((pull) => ({
    ...pull,
    latest: pages(`/repos/${repo}/commits/${pull.headSha}/check-runs`, "check_runs"),
    all: pages(`/repos/${repo}/commits/${pull.headSha}/check-runs?filter=all`, "check_runs"),
  }))
  save("pulls.json", records)
  if (values["main-workflow"] && records.length > 0) {
    const oldest = records[records.length - 1].mergedAt
    const runs = pages(`/repos/${repo}/actions/workflows/${values["main-workflow"]}/runs?branch=${api(`/repos/${repo}`).default_branch}&status=completed`, "workflow_runs", (all) => all.at(-1).created_at < oldest)
    save("main-runs.json", runs)
  }
}

if (values["watch-workflow"]) {
  const since = new Date(Date.now() - Number(values.days) * 86_400_000).toISOString().slice(0, 10)
  const runs = pages(`/repos/${repo}/actions/workflows/${values["watch-workflow"]}/runs?branch=${api(`/repos/${repo}`).default_branch}&created=%3E%3D${since}`, "workflow_runs")
  save("watch-runs.json", runs)
}
