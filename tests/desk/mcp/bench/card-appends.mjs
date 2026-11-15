// Micro-benchmark: what N rapid appends to one task cost, and what they leave in Git.
// Usage: node card-appends.mjs [--src <path to a plugins/desk/mcp/src>] [--field note|log] [--n 10] [--policy 1|0] [--label <text>]
// A scratch desk and a stand-in remote are built in the OS temp folder. With `--policy 1` the desk carries a published purpose
// policy, the shape of a repository that merges through checked pull requests, and the push is never run, so every
// append lands while the one before it is still unpublished. Prints one JSON line: time per append, appends refused,
// commits made, pushes scheduled, and Git processes started (counted through a stand-in `git` first on PATH, so a
// loaded machine's slow clock does not hide what a call costs; not on Windows). `--src` times another checkout of the code (the commit before a change).
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(arg("--src", path.join(here, "..", "..", "..", "..", "plugins", "desk", "mcp", "src")))
const field = arg("--field", "note")
const n = Number(arg("--n", "10"))
const policy = arg("--policy", "1") === "1"
const label = arg("--label", path.basename(path.dirname(path.dirname(path.dirname(path.dirname(src))))))

const base = fs.mkdtempSync(path.join(os.tmpdir(), "desk-bench-"))
process.env.HOME = base
process.env.USERPROFILE = base
process.env.XDG_STATE_HOME = path.join(base, "state")
const root = path.join(base, "desk")
const countFile = path.join(base, "git-calls.txt")
if (process.platform !== "win32") {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
  fs.mkdirSync(path.join(base, "bin"))
  fs.writeFileSync(path.join(base, "bin", "git"), `#!/bin/sh\necho x >> "${countFile}"\nexec "${real}" "$@"\n`, { mode: 0o755 })
  process.env.PATH = `${path.join(base, "bin")}${path.delimiter}${process.env.PATH}`
}
const git = (...rest) => {
  const result = spawnSync("git", ["-C", root, ...rest], { encoding: "utf8", windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${rest[0]}: ${result.stderr}`)
  return result.stdout.trim()
}
fs.mkdirSync(path.join(root, "track", "work"), { recursive: true })
fs.writeFileSync(path.join(root, "track", "work", "task.md"), "---\nschema_version: 1\ntitle: Work\nstatus: processing\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n# Work\n\n**Next step:** Keep going.\n")
if (policy) {
  fs.mkdirSync(path.join(root, ".desk"))
  fs.writeFileSync(path.join(root, ".desk", "content-home.json"), JSON.stringify({
    schema_version: 1, mode: "declared-purpose", repository: "sample/context",
    context_purposes: ["coordination"], product_purposes: ["product-contract"],
  }))
}
spawnSync("git", ["init", "-q", "-b", "main", root])
git("config", "user.name", "Bench")
git("config", "user.email", "bench@example.com")
git("add", ".")
git("commit", "-qm", "Published context")
git("remote", "add", "origin", "https://github.com/sample/context.git")
git("update-ref", "refs/remotes/origin/main", "HEAD")
git("config", "branch.main.remote", "origin")
git("config", "branch.main.merge", "refs/heads/main")
const first = git("rev-list", "--count", "HEAD")
const callsBefore = () => (fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8").split("\n").filter(Boolean).length : 0)
const setup = callsBefore()

const { task_update } = await import(pathToFileURL(path.join(src, "tools", "task.js")).href)
let pushes = 0
const times = []
const refusals = []
const content_home = policy ? { purpose: "coordination", lifecycle: "current" } : undefined
for (let i = 0; i < n; i += 1) {
  const text = `Ruling ${i}: keep the append cheap.`
  const input = { track: "track", slug: "work", [field]: text, ...(content_home ? { content_home } : {}) }
  const started = performance.now()
  try {
    await task_update({ deskRoot: root, input, schedulePush: () => { pushes += 1 } })
  } catch (error) {
    refusals.push(String(error.message).match(/content_home_[a-z_]+/u)?.[0] ?? "refused")
  }
  times.push(performance.now() - started)
}
let drained = 0
const lanePath = path.join(src, "runtime", "append-lane.js")
if (fs.existsSync(lanePath)) {
  const started = performance.now()
  await (await import(pathToFileURL(lanePath).href)).drainAppendLanes()
  drained = performance.now() - started
}
const gitProcesses = callsBefore() - setup
const commits = Number(git("rev-list", "--count", "HEAD")) - Number(first)
const sum = times.reduce((a, b) => a + b, 0)
const sorted = [...times].sort((a, b) => a - b)
console.log(JSON.stringify({
  label, field, policy, n, platform: process.platform,
  appendsRefused: refusals.length, refusedWith: [...new Set(refusals)],
  meanMsPerAppend: +(sum / n).toFixed(1), p50Ms: +sorted[Math.floor(n / 2)].toFixed(1), maxMs: +sorted[n - 1].toFixed(1), totalMs: Math.round(sum), drainMs: Math.round(drained),
  commitsMade: commits, pushesScheduled: pushes, gitProcessesPerAppend: +(gitProcesses / n).toFixed(1),
}))
fs.rmSync(base, { recursive: true, force: true })
process.exit(0)
