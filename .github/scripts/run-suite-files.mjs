// Runs the Desk unit test files one process each, with a per-file time limit, and writes a JSON result.
// A file that hangs is killed (whole process tree) and recorded as a timeout instead of stalling the shard.
// Usage: node run-suite-files.mjs --shard 1/6 --out <results.json> [--timeout-ms 300000]
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const [index, total] = arg("--shard", "1/1").split("/").map(Number)
const out = arg("--out", "suite-results.json")
const timeoutMs = Number(arg("--timeout-ms", "180000"))
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const testsRoot = path.join(repoRoot, "tests", "desk", "mcp", "__tests__")
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  return entry.isDirectory() ? walk(full) : entry.name.endsWith(".test.js") ? [full] : []
})
const files = walk(testsRoot).sort()
// Round-robin keeps a slow directory's files spread over the shards.
const mine = files.filter((_, i) => i % total === index - 1)

const killTree = (pid) => {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
  else try { process.kill(-pid, "SIGKILL") } catch { /* already gone */ }
}

const runFile = (file) => new Promise((resolve) => {
  const started = Date.now()
  const child = spawn(process.execPath, [
    "--import", pathToFileURL(path.join(testsRoot, "_isolated_env.mjs")).href, "--test", "--test-reporter=tap", file,
  ], { cwd: mcpRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, detached: process.platform !== "win32" })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, timeoutMs)
  child.on("close", (code) => {
    clearTimeout(timer)
    const failed = [...output.matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)].map((m) => m[1])
    const count = (key) => Number(new RegExp(`^# ${key} (\\d+)`, "m").exec(output)?.[1] ?? 0)
    resolve({
      file: path.relative(testsRoot, file).split(path.sep).join("/"),
      exitCode: code, timedOut, ms: Date.now() - started,
      pass: count("pass"), fail: count("fail"), skipped: count("skipped"), failedTests: [...new Set(failed)],
      tail: code === 0 ? "" : output.slice(-1500),
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
console.log(`\nfiles=${results.length} failing-files=${bad.length} tests-pass=${results.reduce((n, r) => n + r.pass, 0)} tests-fail=${results.reduce((n, r) => n + r.fail, 0)}`)
// The comparison is the product; a red suite is reported in the results rather than as a failed job.
process.exit(0)
