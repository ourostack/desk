// Runs the Desk unit test files one process each, with a per-file time limit, and writes a JSON result.
// A file that hangs is killed (whole process tree) and recorded as a timeout instead of stalling the shard.
// Usage: node run-suite-files.mjs --shard 1/6 --out <results.json> [--timeout-ms 420000] [--only <file regex>]
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const [index, total] = arg("--shard", "1/1").split("/").map(Number)
const out = arg("--out", "suite-results.json")
const timeoutMs = Number(arg("--timeout-ms", "420000"))
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const testsRoot = path.join(repoRoot, "tests", "desk", "mcp", "__tests__")
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  return entry.isDirectory() ? walk(full) : entry.name.endsWith(".test.js") ? [full] : []
})
const files = walk(testsRoot).sort()
// Round-robin keeps a slow directory's files spread over the shards.
// --only <regex> narrows the run to matching files (relative to the tests folder, forward slashes) for quick investigation runs.
const only = String(arg("--only", "") ?? "")
const wanted = only === "" ? files : files.filter((f) => new RegExp(only, "u").test(path.relative(testsRoot, f).split(path.sep).join("/")))
const mine = wanted.filter((_, i) => i % total === index - 1)

// What is still running under the test process when it hit its time limit, so a hang names the stuck command.
const describeDescendants = (rootPid) => {
  if (process.platform !== "win32") return ""
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
  { encoding: "utf8", timeout: 30000 })
  try {
    const all = [].concat(JSON.parse(probe.stdout || "[]"))
    const keep = new Set([rootPid])
    for (let grew = true; grew;) {
      grew = false
      for (const p of all) if (keep.has(p.ParentProcessId) && !keep.has(p.ProcessId)) { keep.add(p.ProcessId); grew = true }
    }
    return all.filter((p) => keep.has(p.ProcessId)).map((p) => `${p.ProcessId}<-${p.ParentProcessId} ${p.Name} ${String(p.CommandLine ?? "").slice(0, 300)}`).join("\n")
  } catch { return "(process list unavailable)" }
}

const killTree = (pid) => {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
  else try { process.kill(-pid, "SIGKILL") } catch { /* already gone */ }
}

// One compact record per failed test: its name, the assertion or error text and the first stack frames.
const failures = (output) => [...output.matchAll(/^\s*not ok \d+ - ([^\n]+?)(?: # [^\n]*)?\n([\s\S]*?)(?=^\s*(?:# Subtest|ok \d+|not ok \d+|1\.\.))/gm)].map((m) => {
  const body = m[2]
  const error = /^\s*error: ([\s\S]*?)^\s*code:/m.exec(body)?.[1]?.trim() ?? ""
  const stack = /^\s*stack: \|-\n([\s\S]*?)^\s*\.\.\./m.exec(body)?.[1]?.split("\n").slice(0, 4).map((l) => l.trim()).join(" | ") ?? ""
  return { name: m[1], error: error.slice(0, 700), stack: stack.slice(0, 500) }
})

const runFile = (file) => new Promise((resolve) => {
  const started = Date.now()
  const child = spawn(process.execPath, [
    "--import", pathToFileURL(path.join(testsRoot, "_isolated_env.mjs")).href, "--test", "--test-reporter=tap", file,
  ], { cwd: mcpRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, detached: process.platform !== "win32" })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  let timedOut = false
  let stuck = ""
  const timer = setTimeout(() => { timedOut = true; stuck = describeDescendants(child.pid); killTree(child.pid) }, timeoutMs)
  child.on("close", (code) => {
    clearTimeout(timer)
    const failed = [...output.matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)].map((m) => m[1])
    const count = (key) => Number(new RegExp(`^# ${key} (\\d+)`, "m").exec(output)?.[1] ?? 0)
    resolve({
      file: path.relative(testsRoot, file).split(path.sep).join("/"),
      exitCode: code, timedOut, ms: Date.now() - started,
      pass: count("pass"), fail: count("fail"), skipped: count("skipped"), failedTests: [...new Set(failed)],
      failures: failures(output),
      stuck, tail: timedOut ? output.slice(-2500) : "",
      firstFailures: code === 0 ? "" : [...output.matchAll(/^\s*not ok \d+ - [\s\S]*?(?=^\s*(?:# Subtest|ok \d+|not ok \d+|1\.\.))/gm)].slice(0, 3).map((m) => m[0].slice(0, 1500)).join("\n----\n") || output.slice(-1500),
    })
  })
})

const results = []
for (const file of mine) {
  const result = await runFile(file)
  results.push(result)
  console.log(`${result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "ok     " : "FAIL   "} ${result.file} pass=${result.pass} fail=${result.fail} ${result.ms}ms`)
}
fs.writeFileSync(out, JSON.stringify({ shard: `${index}/${total}`, platform: process.platform, results }, null, 1))
const bad = results.filter((r) => r.exitCode !== 0)
const timeouts = results.filter((r) => r.timedOut)
const sum = (key) => results.reduce((n, r) => n + r[key], 0)
const summary = `files=${results.length} failing-files=${bad.length} timeouts=${timeouts.length} tests-pass=${sum("pass")} tests-fail=${sum("fail")}`
console.log(`\n${summary}`)
// Written beside the results; the workflow appends it to the job summary, because a standard user cannot write the runner's summary file.
const lines = [
  "| Files | Files with a failure | Timeouts | Tests passed | Tests failed |",
  "|---|---|---|---|---|",
  `| ${results.length} | ${bad.length} | ${timeouts.length} | ${sum("pass")} | ${sum("fail")} |`,
  "",
]
if (timeouts.length > 0) lines.push(`Timed out: ${timeouts.map((r) => `\`${r.file}\``).join(", ")}`, "")
fs.writeFileSync(out.replace(/\.json$/u, "") + "-summary.md", lines.join("\n") + "\n")
// The comparison is the product; a red suite is reported in the results and the summary rather than as a failed job.
process.exit(0)
