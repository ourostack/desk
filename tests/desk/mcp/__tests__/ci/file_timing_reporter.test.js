import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import fileTimingReporter from "../_file_timing_reporter.mjs"
import { mkTempRoot } from "../_temp_roots.js"
import { waitForProcessesGone } from "../runtime/_controller_exit.js"

const ownFile = fileURLToPath(import.meta.url)
const reporter = pathToFileURL(path.resolve(path.dirname(ownFile), "../_file_timing_reporter.mjs")).href
const event = (type, file, duration_ms, extra = {}) => ({
  type, data: { file, name: file, nesting: 0, details: { duration_ms }, ...extra },
})
const drain = async (source) => {
  const chunks = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks.join("")
}

test("a pending file retains completed timings and its running identity before the source ends", async () => {
  const root = await mkTempRoot("file-timing-pending-")
  const timingsPath = path.join(root, "timings.json")
  const first = path.resolve(path.dirname(ownFile), "first.test.js")
  const second = path.resolve(path.dirname(ownFile), "second.test.js")
  let ready
  let release
  const reached = new Promise((resolve) => { ready = resolve })
  const blocked = new Promise((resolve) => { release = resolve })
  async function* events() {
    yield event("test:dequeue", first)
    yield event("test:complete", first, 1200)
    yield event("test:dequeue", second)
    yield event("test:complete", second, 3, { name: "a test within the pending file" })
    ready()
    await blocked
  }
  const consuming = drain(fileTimingReporter(events(), { timingsPath }))
  try {
    await reached
    assert.ok(existsSync(timingsPath), "the timing snapshot must exist before the source ends")
    const snapshot = JSON.parse(readFileSync(timingsPath, "utf8"))
    assert.equal(snapshot.file_seconds["tests/desk/mcp/__tests__/ci/first.test.js"], 1.2)
    assert.equal(snapshot.running_files.length, 1)
    assert.equal(snapshot.running_files[0].file, "tests/desk/mcp/__tests__/ci/second.test.js")
    assert.ok(Number.isFinite(Date.parse(snapshot.running_files[0].started_at)))
  } finally {
    release()
    await consuming
  }
})

test("unconfigured reporting preserves the longest top-level duration and existing JSON schema", async () => {
  async function* events() {
    yield event("test:complete", ownFile, 1250)
    yield event("test:complete", ownFile, 100)
    yield event("test:complete", ownFile, 9000, { nesting: 1 })
    yield event("test:pass", ownFile, 9000)
  }
  const output = await drain(fileTimingReporter(events(), { timingsPath: null }))
  assert.deepEqual(JSON.parse(output), {
    schema_version: 1,
    file_seconds: { "tests/desk/mcp/__tests__/ci/file_timing_reporter.test.js": 1.3 },
  })
})

test("an unwritable snapshot fails reporting instead of silently losing evidence", async () => {
  const root = await mkTempRoot("file-timing-error-")
  async function* events() {
    yield event("test:dequeue", ownFile)
  }
  await assert.rejects(drain(fileTimingReporter(events(), {
    timingsPath: path.join(root, "missing", "timings.json"),
  })), { code: "ENOENT" })
})

test("an interrupted real test runner leaves valid timings naming the blocked file", async () => {
  const root = await mkTempRoot("file-timing-interrupted-")
  const first = path.join(root, "first.test.mjs")
  const second = path.join(root, "second.test.mjs")
  const pidPath = path.join(root, "blocked.pid")
  const timingsPath = path.join(root, "timings.json")
  writeFileSync(first, 'import { test } from "node:test"; test("completed", () => {});\n')
  writeFileSync(second, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setTimeout(() => process.exit(2), 30000);
`)
  // These synthetic files contain no measured code; do not multiply the coverage loader's startup in them.
  const env = { ...process.env, NODE_OPTIONS: "", DESK_COVERAGE_TIMINGS_PATH: timingsPath }
  delete env.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, [
    "--test", "--test-concurrency=1",
    `--test-reporter=${reporter}`, "--test-reporter-destination=stdout",
    first, second,
  ], { env, stdio: ["ignore", "pipe", "pipe"] })
  let stderr = ""
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.stdout.resume()
  const closed = once(child, "close")
  let blockedPid
  try {
    const deadline = Date.now() + 15000
    while (!existsSync(pidPath)) {
      assert.equal(child.exitCode, null, stderr)
      assert.ok(Date.now() < deadline, `blocked fixture did not start: ${stderr}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    blockedPid = Number(readFileSync(pidPath, "utf8"))
    assert.ok(existsSync(timingsPath), `no snapshot while the real file is blocked: ${stderr}`)
    const before = JSON.parse(readFileSync(timingsPath, "utf8"))
    assert.equal(Object.keys(before.file_seconds).length, 1)
    assert.equal(path.basename(before.running_files[0].file), "second.test.mjs")
    child.kill("SIGTERM")
    await closed
    assert.deepEqual(JSON.parse(readFileSync(timingsPath, "utf8")), before)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    await closed
    if (blockedPid === undefined && existsSync(pidPath)) blockedPid = Number(readFileSync(pidPath, "utf8"))
    if (blockedPid !== undefined) {
      try {
        process.kill(blockedPid, "SIGTERM")
      } catch (error) {
        if (error.code !== "ESRCH") throw error
      }
      await waitForProcessesGone([blockedPid])
    }
  }
})

test("the watchdog artifact retains the test argument after a long inline loader", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkTempRoot("file-timing-process-dump-")
  mkdirSync(path.join(root, "desk-coverage-shard"))
  const workflowPath = path.resolve(path.dirname(ownFile), "../../../../../.github/workflows/desk-mcp-tests.yml")
  const command = readFileSync(workflowPath, "utf8").split("\n")
    .find((line) => line.trimStart().startsWith("ps ") && line.includes("stuck-process-tree.txt"))
  assert.ok(command, "the watchdog must retain its process evidence")
  const file = "tests/desk/mcp/__tests__/blocked.test.js"
  const loader = `data:text/javascript,${"x".repeat(1500)}`
  let child
  let closed
  try {
    if (process.platform === "linux") {
      child = spawn(process.execPath, [
        "-e", "setTimeout(() => {}, 5000)", "--", loader, file,
      ], { env: { ...process.env, NODE_OPTIONS: "" }, stdio: "ignore" })
      closed = once(child, "close")
      await once(child, "spawn")
    }
    const script = process.platform === "linux" ? command
      : `ps() { printf '%s\\n' "$DUMP"; }\n${command}`
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: root, DUMP: `123 123 1 10 S node --import ${loader} ${file}` },
    })
    assert.equal(result.status, 0, result.stderr)
    const dump = readFileSync(path.join(root, "desk-coverage-shard/stuck-process-tree.txt"), "utf8")
    const line = dump.split("\n").find((entry) => entry.includes(loader))
    assert.ok(line?.endsWith(file), "the retained process command must include the final test argument")
  } finally {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      await closed
    }
  }
})
