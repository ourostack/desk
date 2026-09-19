import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { connectOrStartController } from "../../src/readiness/controller-client.js"

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(t, handler) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-convergence-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, stateHome: path.join(root, "state"), ephemeral: true,
    handlers: { beginConvergence: handler } }
}

test("simultaneous clients share one controller-owned convergence and recover after failure", async (t) => {
  const entered = deferred()
  const release = deferred()
  let calls = 0
  const options = fixture(t, async () => {
    calls += 1
    if (calls === 1) {
      entered.resolve()
      await release.promise
      throw new Error("real convergence failure")
    }
    return { indexed: true }
  })
  const first = await connectOrStartController(options)
  const second = await connectOrStartController(options)
  let outcome
  try {
    outcome = Promise.allSettled([first.beginConvergence()])
    await entered.promise
    const reused = await second.beginConvergence()
    assert.deepEqual(reused, {
      accepted: true, reused: true, in_progress: true, state: "LEXICAL_CONVERGING",
    })
    assert.equal((await second.status()).state, "LEXICAL_CONVERGING")
    const waiting = Promise.allSettled([second.barrier({ capability: "lexical", wait: true })])
    release.resolve()
    const failed = [...await outcome, ...await waiting]
    assert.equal(calls, 1)
    assert.deepEqual(failed.map((result) => result.reason?.message), [
      "real convergence failure", "real convergence failure",
    ])
    assert.equal((await second.status()).state, "RECOVERING")
    assert.deepEqual(await second.beginConvergence(), { indexed: true })
    assert.equal(calls, 2)
    assert.deepEqual(await first.beginConvergence(), {
      accepted: true, reused: true, state: "LEXICAL_READY",
    })
    assert.equal(calls, 2)
  } finally {
    release.resolve()
    await outcome
    await second.close()
    await first.close()
  }
})

test("exiting initiating client does not cancel controller-owned work observed by a later client", async (t) => {
  const entered = deferred()
  const release = deferred()
  let calls = 0
  const options = fixture(t, async () => {
    calls += 1
    entered.resolve()
    await release.promise
    return { indexed: true }
  })
  const ownerClient = await connectOrStartController(options)
  const owner = JSON.parse(readFileSync(path.join(options.stateHome, ownerClient.id, "owner.json")))
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\desk-readiness-${ownerClient.identity.user.username}-${ownerClient.id}`
    : path.join(options.stateHome, ownerClient.id, "controller.sock")
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import net from "node:net";
    const socket = net.createConnection(${JSON.stringify(endpoint)});
    socket.on("connect", () => socket.write(JSON.stringify({
      id: "initiator", method: "beginConvergence",
      params: { token: ${JSON.stringify(owner.owner.token)} }
    }) + "\\n"));
    process.stdin.once("data", () => process.exit(0));
  `], { stdio: ["pipe", "ignore", "pipe"] })
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code))
  })
  let later
  try {
    await entered.promise
    child.stdin.end("exit\n")
    assert.equal(await closed, 0)
    later = await connectOrStartController(options)
    assert.equal((await later.status()).state, "LEXICAL_CONVERGING")
    assert.deepEqual(await later.beginConvergence(), {
      accepted: true, reused: true, in_progress: true, state: "LEXICAL_CONVERGING",
    })
    const waiting = later.barrier({ capability: "lexical", wait: true })
    const outcome = Promise.allSettled([waiting])
    release.resolve()
    const [result] = await outcome
    assert.equal(result.status, "fulfilled")
    assert.equal(result.value.current, true)
    assert.equal(calls, 1)
    assert.equal((await later.barrier({ capability: "lexical" })).current, true)
  } finally {
    release.resolve()
    if (child.exitCode === null) child.kill()
    await closed
    await later?.close()
    await ownerClient.close()
  }
})

test("convergence may exceed the control request timeout without losing its result", async (t) => {
  const options = fixture(t, async () => {
    await new Promise((resolve) => setTimeout(resolve, 2100))
    return { indexed: true }
  })
  const client = await connectOrStartController(options)
  try {
    assert.deepEqual(await client.beginConvergence(), { indexed: true })
  } finally {
    await client.close()
  }
})
