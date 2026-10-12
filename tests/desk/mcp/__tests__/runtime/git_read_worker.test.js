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

test("runGitRead runs git in the folder and reports success only for a zero exit with text output", () => {
  const calls = []
  const answer = (result) => runGitRead({ root: "/desk", args: ["remote"], env: { A: "1" }, timeoutMs: 5 }, { spawnGit: (...call) => { calls.push(call); return result } })
  assert.deepEqual(answer({ status: 0, stdout: "origin\n" }), { status: 0, stdout: "origin\n" })
  assert.deepEqual(calls[0], ["git", ["-C", "/desk", "remote"], { encoding: "utf8", timeout: 5, env: { A: "1" }, windowsHide: true }])
  assert.deepEqual(answer({ status: 128, stdout: "partial" }), FAILED, "a failed command's output is not passed on")
  assert.deepEqual(answer({ status: null, stdout: "" }), FAILED, "a timeout or a Git that could not start")
  assert.deepEqual(answer({ status: 0, stdout: undefined }), FAILED)
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
  const spawnGit = (_git, args) => {
    if (args.includes("boom")) throw new Error("spawn failed")
    return { status: 0, stdout: args.join(" ") }
  }
  assert.equal(attachGitReadWorker(port1, { deskGitReadWorker: true }, { spawnGit }), true)
  port2.postMessage({ id: 1, read: read("/a") })
  assert.deepEqual((await once(port2, "message"))[0], { id: 1, status: 0, stdout: "-C /a remote" })
  port2.postMessage({ id: 2, read: read("/b", ["boom"]) })
  assert.deepEqual((await once(port2, "message"))[0], { id: 2, ...FAILED })
  port1.close()
  port2.close()
})

test("a real worker reads a real repository, answers concurrent reads separately, and reads a missing folder as failed", async () => {
  const root = await mkTempRoot("desk-git-read-")
  execFileSync("git", ["-C", root, "init", "-q"])
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://example.invalid/desk.git"])
  const reader = createGitReader()
  const [remote, inside, missing] = await Promise.all([
    reader.read(read(root)),
    reader.read(read(root, ["rev-parse", "--is-inside-work-tree"])),
    reader.read(read(path.join(root, "no-such-folder"))),
  ])
  assert.deepEqual(remote, { status: 0, stdout: "origin\n" })
  assert.deepEqual(inside, { status: 0, stdout: "true\n" })
  assert.deepEqual(missing, FAILED)
})

function fakeWorkers() {
  const made = []
  const createWorker = (url, options) => {
    const worker = Object.assign(new EventEmitter(), { url, options, posted: [], held: false, ref() { this.held = true }, unref() { this.held = false }, postMessage(message) { this.posted.push(message) } })
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
  assert.deepEqual(await first, { status: 0, stdout: "one" })
  assert.deepEqual(await second, { status: 0, stdout: "two" })
})

for (const event of ["error", "exit"]) {
  test(`a worker ${event} fails the reads it had not answered, and the next read starts a new worker`, async () => {
    const { made, createWorker } = fakeWorkers()
    const reader = createGitReader({ createWorker })
    const lost = [reader.read(read("/a")), reader.read(read("/b"))]
    made[0].emit(event, event === "error" ? new Error("worker failed") : 1)
    assert.deepEqual(await Promise.all(lost), [FAILED, FAILED])
    const next = reader.read(read("/c"))
    assert.equal(made.length, 2)
    // The old worker's exit arrives after its error: it must not fail the new worker's reads.
    made[0].emit("exit", 1)
    made[1].emit("message", { id: made[1].posted[0].id, status: 0, stdout: "ok" })
    assert.deepEqual(await next, { status: 0, stdout: "ok" })
  })
}

test("a worker that cannot start, or a read that cannot be posted, answers as failed and leaves the reader usable", async () => {
  let fail = true
  const { made, createWorker } = fakeWorkers()
  const reader = createGitReader({ createWorker: (...args) => { if (fail) throw new Error("no threads"); return createWorker(...args) } })
  assert.deepEqual(await reader.read(read("/a")), FAILED)
  fail = false
  const posted = reader.read(read("/b"))
  made[0].postMessage = () => { throw new Error("cannot clone") }
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
