// The Git read worker: desk_status's local Git reads, off the thread that answers the host.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { writeFileSync } from "node:fs"
import * as path from "node:path"
import { MessageChannel } from "node:worker_threads"
import { attachGitReadWorker, createGitReader, runGitRead } from "../../../../../plugins/desk/mcp/src/runtime/git-read-worker.js"
import { mkTempRoot } from "../_temp_roots.js"

const FAILED = { status: 1, stdout: "" }
const read = (root, args = ["remote"]) => ({ root, args, env: process.env, timeoutMs: 10_000 })

test("runGitRead runs git in the folder and reports success only when Git exits zero with text output", async () => {
  const calls = []
  const answer = (error, stdout) => runGitRead({ root: "/desk", args: ["remote"], env: { A: "1" }, timeoutMs: 5 }, { execGit: (...call) => { calls.push(call.slice(0, 3)); call[3](error, stdout) } })
  assert.deepEqual(await answer(null, "origin\n"), { status: 0, stdout: "origin\n" })
  assert.deepEqual(calls[0], ["git", ["-C", "/desk", "remote"], { encoding: "utf8", timeout: 5, env: { A: "1" }, windowsHide: true }])
  assert.deepEqual(await answer(Object.assign(new Error("exit 128"), { code: 128 }), "partial"), FAILED, "a failed command's output is not passed on")
  assert.deepEqual(await answer(Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }), ""), FAILED)
  assert.deepEqual(await answer(null, undefined), FAILED)
  assert.deepEqual(await runGitRead({ root: "/desk", args: [], env: {}, timeoutMs: 5 }, { execGit: () => { throw new Error("cannot start") } }), FAILED, "a Git that cannot be started")
})

test("attachGitReadWorker ignores anything but a Desk Git read worker's port", () => {
  const { port1, port2 } = new MessageChannel()
  assert.equal(attachGitReadWorker(null, { deskGitReadWorker: true }), false)
  assert.equal(attachGitReadWorker(port1, null), false)
  assert.equal(attachGitReadWorker(port1, { deskGitReadWorker: false }), false)
  port1.close()
  port2.close()
})

test("the worker side answers each read with its id, and a read that throws as a failed one", async () => {
  const { port1, port2 } = new MessageChannel()
  const execGit = (_git, args, _options, done) => {
    if (args.includes("boom")) throw new Error("spawn failed")
    done(null, args.join(" "))
  }
  assert.equal(attachGitReadWorker(port1, { deskGitReadWorker: true }, { execGit }), true)
  port2.postMessage({ id: 1, read: read("/a") })
  assert.deepEqual((await once(port2, "message"))[0], { id: 1, status: 0, stdout: "-C /a remote" })
  port2.postMessage({ id: 2, read: read("/b", ["boom"]) })
  assert.deepEqual((await once(port2, "message"))[0], { id: 2, ...FAILED })
  port1.close()
  port2.close()
})

test("a real worker reads a real repository, answers concurrent reads separately, reads again after idling, and reads a missing folder as failed", async (t) => {
  const root = await mkTempRoot("desk-git-read-")
  execFileSync("git", ["-C", root, "init", "-q"])
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://example.invalid/desk.git"])
  const reader = createGitReader()
  // Closed even when an assertion fails, so a worker left holding the process open cannot hang this file.
  t.after(() => reader.close())
  const [remote, inside, missing] = await Promise.all([
    reader.read(read(root)),
    reader.read(read(root, ["rev-parse", "--is-inside-work-tree"])),
    reader.read(read(path.join(root, "no-such-folder"))),
  ])
  assert.deepEqual(remote, { status: 0, stdout: "origin\n" })
  assert.deepEqual(inside, { status: 0, stdout: "true\n" })
  assert.deepEqual(missing, FAILED)
  // The worker released the process when those were answered; a later read must hold it again and be answered.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(await reader.read(read(root)), { status: 0, stdout: "origin\n" })
  await reader.close()
  assert.deepEqual(await reader.read(read(root)), { status: 0, stdout: "origin\n" }, "a read after close starts a new worker")
})

function fakeWorkers() {
  const made = []
  const createWorker = (url, options) => {
    const worker = Object.assign(new EventEmitter(), { url, options, posted: [], held: false, terminated: 0, ref() { this.held = true }, unref() { this.held = false }, async terminate() { this.terminated += 1 }, postMessage(message) { this.posted.push(message) } })
    made.push(worker)
    return worker
  }
  return { made, createWorker }
}

test("the reader starts one worker at the first read, holds the process open only while a read waits, and matches answers by id", async () => {
  const { made, createWorker } = fakeWorkers()
  const reader = createGitReader({ createWorker })
  assert.equal(made.length, 0, "no worker before the first read")
  const first = reader.read(read("/a"))
  const second = reader.read(read("/b"))
  assert.equal(made.length, 1)
  assert.equal(made[0].held, true, "a waiting read holds the process open")
  assert.match(String(made[0].url), /git-read-worker\.js$/u)
  assert.deepEqual(made[0].options, { workerData: { deskGitReadWorker: true } })
  assert.deepEqual(made[0].posted.map((message) => [message.id, message.read.root]), [[1, "/a"], [2, "/b"]])
  made[0].emit("message", { id: 99, status: 0, stdout: "nobody asked" })
  made[0].emit("message", { id: 2, status: 0, stdout: "two" })
  assert.equal(made[0].held, true, "one read still waits")
  made[0].emit("message", { id: 1, status: 0, stdout: "one" })
  assert.equal(made[0].held, false, "nothing waits, so the worker no longer holds the process open")
  const third = reader.read(read("/c"))
  assert.equal(made.length, 1, "the same worker serves later reads")
  assert.equal(made[0].held, true, "a read after idling holds the process open again")
  made[0].emit("message", { id: 3, status: 0, stdout: "three" })
  assert.deepEqual(await third, { status: 0, stdout: "three" })
  assert.equal(made[0].held, false)
  assert.deepEqual(await first, { status: 0, stdout: "one" })
  assert.deepEqual(await second, { status: 0, stdout: "two" })
})

for (const event of ["error", "exit"]) {
  test(`a worker ${event} fails the reads it had not answered, is reported once, and the next read starts a new worker`, async () => {
    const { made, createWorker } = fakeWorkers()
    const reported = []
    const reader = createGitReader({ createWorker, onError: (reason) => reported.push(reason) })
    const lost = [reader.read(read("/a")), reader.read(read("/b"))]
    made[0].emit(event, event === "error" ? new Error("worker failed") : 1)
    assert.deepEqual(await Promise.all(lost), [FAILED, FAILED])
    assert.deepEqual(reported, [event === "error" ? "the Git read worker failed: worker failed" : "the Git read worker exited (code 1)"])
    const next = reader.read(read("/c"))
    assert.equal(made.length, 2)
    // The old worker's exit arrives after its error: it must not fail the new worker's reads, or be reported.
    made[0].emit("exit", 1)
    made[1].emit("message", { id: made[1].posted[0].id, status: 0, stdout: "ok" })
    assert.deepEqual(await next, { status: 0, stdout: "ok" })
    // A second failure is not reported again.
    const again = reader.read(read("/d"))
    made[1].emit("error", "second failure")
    assert.deepEqual(await again, FAILED)
    assert.equal(reported.length, 1)
  })
}

test("close stops the worker without reporting a failure, fails the reads still waiting, and is safe with no worker", async () => {
  const { made, createWorker } = fakeWorkers()
  const reported = []
  const reader = createGitReader({ createWorker, onError: (reason) => reported.push(reason) })
  await reader.close()
  const waiting = reader.read(read("/a"))
  await reader.close()
  assert.equal(made[0].terminated, 1)
  assert.deepEqual(await waiting, FAILED)
  made[0].emit("exit", 1)
  assert.deepEqual(reported, [])
})

test("a failure is reported even when no handler is given or the handler throws", async () => {
  for (const options of [{}, { onError: () => { throw new Error("logger failed") } }, { onError: (reason) => assert.equal(reason, "the Git read worker failed: text reason") }]) {
    const { made, createWorker } = fakeWorkers()
    const reader = createGitReader({ createWorker, ...options })
    const lost = reader.read(read("/a"))
    made[0].emit("error", "text reason")
    assert.deepEqual(await lost, FAILED)
  }
})

test("a worker that cannot start, or a read that cannot be posted, answers as failed and leaves the reader usable", async () => {
  let fail = true
  const { made, createWorker } = fakeWorkers()
  const reported = []
  const reader = createGitReader({ createWorker: (...args) => { if (fail) throw new Error("no threads"); return createWorker(...args) }, onError: (reason) => reported.push(reason) })
  assert.deepEqual(await reader.read(read("/a")), FAILED)
  assert.deepEqual(reported, ["the Git read worker could not take a read: no threads"])
  fail = false
  const posted = reader.read(read("/b"))
  made[0].postMessage = () => { throw "cannot clone" }
  assert.deepEqual(await reader.read(read("/c")), FAILED)
  assert.equal(made[0].held, true, "the read posted earlier still waits")
  made[0].emit("message", { id: made[0].posted[0].id, status: 0, stdout: "b" })
  assert.deepEqual(await posted, { status: 0, stdout: "b" })
  // The failed read left nothing waiting: an exit now has no read to fail.
  made[0].emit("exit", 0)
})

test("a process that used the reader exits by itself once its reads are answered", async () => {
  const script = path.join(await mkTempRoot("desk-git-read-exit-"), "read.mjs")
  writeFileSync(script, `import { createGitReader } from ${JSON.stringify(new URL("../../../../../plugins/desk/mcp/src/runtime/git-read-worker.js", import.meta.url).href)}
const answer = await createGitReader().read({ root: process.cwd(), args: ["--version"], env: process.env, timeoutMs: 10000 })
console.log(answer.status)
`)
  // Without the release, the idle worker would hold the process open until the timeout kills it.
  assert.equal(execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000 }).trim(), "0")
})

// A script that starts a read which blocks for 20 s whatever happens to its input, waits until Git has really started it, then calls process.exit.
// The Git alias runs in the OS temp folder, so the orphaned sleep never sits in a fixture folder.
function exitWhileReadingScript(moduleUrl, marker) {
  const shellMarker = marker.replaceAll("\\", "/")
  return `import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { createGitReader } from ${JSON.stringify(moduleUrl)}
createGitReader().read({ root: tmpdir(), args: ["-c", ${JSON.stringify(`alias.wait=!echo started > "${shellMarker}"; sleep 20`)}, "wait"], env: process.env, timeoutMs: 60000 })
const poll = setInterval(() => { if (existsSync(${JSON.stringify(marker)})) { clearInterval(poll); console.log("exiting"); process.exit(0) } }, 20)
`
}

test("a process can exit at once while a read is still running", async () => {
  const root = await mkTempRoot("desk-git-read-exit-running-")
  const script = path.join(root, "exit.mjs")
  writeFileSync(script, exitWhileReadingScript(new URL("../../../../../plugins/desk/mcp/src/runtime/git-read-worker.js", import.meta.url).href, path.join(root, "started.txt")))
  // A worker that waited for Git synchronously could not be stopped, so the exit would wait out the 20 s sleep and this call would time out.
  assert.equal(execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 12_000 }).trim(), "exiting")
})
