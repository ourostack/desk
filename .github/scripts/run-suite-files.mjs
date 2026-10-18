// Runs the Desk unit test files one process each, with a per-file time limit, and writes a JSON result.
// Legacy hangs use tree termination; product mode fails at its original H without inventing retirement.
// Usage: node run-suite-files.mjs --shard 1/6 --out <results.json> [--timeout-ms 1800000] [--only <file regex>] [--tests-root <folder>] [--durations <table.json>]
// Exit code: 1 when any file failed, timed out or reported a failed test, so a job that runs this script is red whenever the suite is. 0 only when every file passed.
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { suiteFiles } from "./suite-files.mjs"
import { assignShards, loadDurations } from "./suite-shards.mjs"
import { PRODUCT_SELECTOR, NATIVE_TEST_NAME, isOwnedGitProductSelection,
  createProductTapCounter, createProductCompletion, captureProductEnvelope, productEnvelopeRemaining } from "./owned-git-product-io.mjs"

const cliEnvelope = captureProductEnvelope(process.hrtime.bigint())
const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const [index, total] = arg("--shard", "1/1").split("/").map(Number)
const out = arg("--out", "suite-results.json")
const timeoutMs = Number(arg("--timeout-ms", "1800000"))
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const isolatedEnv = path.join(repoRoot, "tests", "desk", "mcp", "__tests__", "_isolated_env.mjs")
// --tests-root points the runner at another folder of test files (the gate test uses a synthetic one).
const testsRoot = path.resolve(arg("--tests-root", path.join(repoRoot, "tests", "desk", "mcp", "__tests__")))
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")

// The same file list the verdict job checks against (suite-files.mjs). Which shard runs which file comes from suite-shards.mjs: longest first by the measured times in suite-durations.json, so the shards finish together.
// --only <regex> narrows the run to matching files (relative to the tests folder, forward slashes) for quick investigation runs.
const only = String(arg("--only", "") ?? "")
const productRequested = only === PRODUCT_SELECTOR
const productMode = isOwnedGitProductSelection(only, process.env.DESK_TEST_SUITE_MODE)
if (productRequested && (!productMode || process.platform !== "win32" ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || timeoutMs !== 120000 || total !== 8 ||
  testsRoot !== path.join(repoRoot, "tests", "desk", "mcp", "__tests__"))) {
  console.error("owned-git product: not_admitted")
  process.exit(1)
}
const durations = loadDurations(arg("--durations", undefined))
const plan = assignShards(suiteFiles(testsRoot, only), total, durations)
const mine = (plan[index - 1]?.files ?? []).map((file) => path.join(testsRoot, ...file.split("/")))
console.log(`shard ${index}/${total}: ${mine.length} files, predicted ${Math.round(plan[index - 1].seconds / 60)} min; all shards predicted (min): ${plan.map((s) => Math.round(s.seconds / 60)).join(" ")}`)
const unlisted = plan.flatMap((s) => s.files).filter((file) => !(file in durations.files))
if (unlisted.length > 0) console.log(`::warning::${unlisted.length} test files are not in suite-durations.json and use the default weight of ${durations.defaultSeconds}s; refresh the table: ${unlisted.slice(0, 5).join(", ")}`)

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
  const frames = (/^\s*stack: \|-\n([\s\S]*?)^\s*\.\.\./m.exec(body)?.[1] ?? "").split("\n").map((l) => l.trim().replace(/file:\/\/\/[A-Z]:\/a\/desk\/desk\//g, "")).filter(Boolean)
  // The first frames show where it failed; the first frames in the test files show what the test was doing.
  const stack = [...frames.slice(0, 3), ...frames.filter((l) => l.includes("__tests__") && !l.includes("_isolated_env")).slice(0, 3)].join(" | ")
  return { name: m[1], error: error.slice(0, 3000), stack: stack.slice(0, 700) }
})

const runProductFile = async (file) => {
  const H = cliEnvelope.Hns
  const counter = createProductTapCounter(), bytes = { stdout: 0, stderr: 0 }
  const env = {}
  for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATH", "TEMP", "TMP", "PATHEXT",
    "GITHUB_WORKSPACE", "GITHUB_SHA", "GITHUB_EVENT_NAME", "GITHUB_REF_NAME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const isolation = path.join(repoRoot, `.owned-git-source-isolation-${process.hrtime.bigint()}`)
  Object.assign(env, { DESK_TEST_RUN_DIR: isolation, TMPDIR: isolation, TEMP: isolation, TMP: isolation,
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", DESK_TEST_OWNED_GIT_NATIVE: "1",
    DESK_TEST_OWNED_GIT_H: H.toString(), DESK_TEST_SUITE_MODE: "standard" })
  const heldFiles = new Set()
  let completion
  const live = () => {
    if (completion.snapshot().terminalCode !== null) return false
    if (!productEnvelopeRemaining(cliEnvelope, process.hrtime.bigint())) {
      completion.deadline(); return false
    }
    return true
  }
  const persist = async (row) => {
    if (path.resolve(out) !== path.join(repoRoot, "results.json")) throw new Error("ci_envelope")
    const json = Buffer.from(JSON.stringify({ shard: `${index}/${total}`, platform: process.platform,
      aclProbe: null, results: [row] }, null, 1))
    const summary = Buffer.from("| Files | Files with a failure | Timeouts | Tests passed | Tests failed |\n" +
      "|---|---|---|---|---|\n" +
      `| 1 | ${row.exitCode === 0 ? 0 : 1} | ${row.timedOut ? 1 : 0} | ${row.pass} | ${row.fail} |\n`)
    if (json.length > 4096 || summary.length > 4096 || heldFiles.size) throw new Error("ci_envelope")
    for (const [name, buffer] of [["results.json", json], ["results-summary.md", summary]]) {
      if (!live()) return
      const file = path.join(repoRoot, name)
      let st
      try { st = await fs.promises.lstat(file) }
      catch (error) { if (error.code !== "ENOENT") throw error }
      if (!live()) return
      if (st && (!st.isFile() || st.isSymbolicLink())) throw new Error("ci_envelope")
      const handle = await fs.promises.open(file, "w")
      heldFiles.add(handle)
      if (!live()) return
      try {
        let at = 0
        while (at < buffer.length) {
          if (!live()) return
          const { bytesWritten } = await handle.write(buffer, at, buffer.length - at, at)
          if (!live()) return
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffer.length - at) {
            throw new Error("ci_envelope")
          }
          at += bytesWritten
        }
      } finally {
        if (live()) {
          await handle.close()
          heldFiles.delete(handle)
        }
      }
      if (!live()) return
    }
  }
  completion = createProductCompletion({ envelope: cliEnvelope, nowNs: () => process.hrtime.bigint(),
    counter, bytes, arm: setTimeout, disarm: clearTimeout, persist, terminate: (code) => process.exit(code) })
  try {
    if (!await completion.prepare()) return
    if (!live()) return
    await fs.promises.mkdir(isolation)
    if (!live()) return
    const child = spawn(process.execPath, ["--import", pathToFileURL(isolatedEnv).href, "--test", "--test-reporter=tap",
      `--test-name-pattern=^${NATIVE_TEST_NAME}$`, file], { cwd: mcpRoot, env, windowsHide: true })
    await completion.attach(child)
  } catch { completion.error() }
}

const runFile = (file) => new Promise((resolve) => {
  const started = Date.now()
  const child = spawn(process.execPath, [
    "--import", pathToFileURL(isolatedEnv).href, "--test", "--test-reporter=tap", file,
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
      // A file that exits non-zero with no failing assertion (a native abort) leaves its reason only in the raw output.
      outputTail: code !== 0 && !timedOut ? output.slice(-4000) : "",
      firstFailures: code === 0 ? "" : [...output.matchAll(/^\s*not ok \d+ - [\s\S]*?(?=^\s*(?:# Subtest|ok \d+|not ok \d+|1\.\.))/gm)].slice(0, 3).map((m) => m[0].slice(0, 1500)).join("\n----\n") || output.slice(-1500),
    })
  })
})

// How long Windows PowerShell and Desk's own ACL provider take here, because every protected write starts one.
const probeAcl = async () => {
  if (process.platform !== "win32") return null
  const timed = (fn) => { const t = Date.now(); const value = fn(); return [Date.now() - t, value] }
  const plain = Array.from({ length: 3 }, () => timed(() => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "1"], { encoding: "utf8" }).status)[0])
  const { protectWindowsPaths } = await import(pathToFileURL(path.join(mcpRoot, "src", "factory", "windows-acl.js")).href)
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), "acl-probe-"))
  const provider = []
  for (let i = 0; i < 3; i += 1) {
    const t = Date.now()
    try { await protectWindowsPaths([{ path: dir, kind: "directory", created: false }]); provider.push(Date.now() - t) } catch (error) { provider.push(`${Date.now() - t}ms ${error.message.slice(0, 200)}`) }
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return { powershellStartMs: plain, desk_acl_provider_ms: provider }
}
if (productMode && mine.length > 0) {
  if (mine.length !== 1) process.exit(1)
  await runProductFile(mine[0])
  process.exit(1)
}
const aclProbe = !productMode && args.includes("--probe-acl") ? await probeAcl() : null
console.log("acl probe:", JSON.stringify(aclProbe))

const results = []
for (const file of mine) {
  const result = await runFile(file)
  results.push(result)
  console.log(`${result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "ok     " : "FAIL   "} ${result.file} pass=${result.pass} fail=${result.fail} ${result.ms}ms`)
}
fs.writeFileSync(out, JSON.stringify({ shard: `${index}/${total}`, platform: process.platform, aclProbe, results }, null, 1))
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
// The job result is the gate: any failing file, timeout or failed test makes it red. The results and summary are written first so a red job still shows what failed.
process.exit(bad.length > 0 || timeouts.length > 0 || sum("fail") > 0 ? 1 : 0)
