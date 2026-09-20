import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { fork } from "node:child_process"
import { createConnection } from "node:net"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { connectOrStartController } from "../../src/readiness/controller-client.js"

test("simultaneous compatible starters elect one controller", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-controller-root-"))
  const stateHome = mkdtempSync(path.join(tmpdir(), "desk-controller-state-"))
  try {
    const options = {
      root,
      stateHome,
      protocolVersion: 1,
      lexicalContract: { schema: 1, chunker: "v1", normalization: "v1" },
      ephemeral: true,
    }
    const [first, second] = await Promise.all([
      connectOrStartController(options),
      connectOrStartController(options),
    ])
    assert.equal(first.accepted, true)
    assert.equal(second.accepted, true)
    assert.equal(first.id, second.id)
    const statuses = await Promise.all([first.status(), second.status()])
    assert.equal(statuses[0].owner.pid, statuses[1].owner.pid)
    await first.close()
    await second.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(stateHome, { recursive: true, force: true })
  }
})

test("incompatible protocols use isolated controller namespaces", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-controller-root-"))
  const stateHome = mkdtempSync(path.join(tmpdir(), "desk-controller-state-"))
  try {
    const common = {
      root,
      stateHome,
      lexicalContract: { schema: 1, chunker: "v1", normalization: "v1" },
    }
    const first = await connectOrStartController({ ...common, protocolVersion: 1, ephemeral: true })
    const second = await connectOrStartController({ ...common, protocolVersion: 2, ephemeral: true })
    assert.notEqual(first.id, second.id)
    await first.close()
    await second.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(stateHome, { recursive: true, force: true })
  }
})

test("successful convergence advances the lexical barrier to ready", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-controller-root-"))
  const stateHome = mkdtempSync(path.join(tmpdir(), "desk-controller-state-"))
  try {
    const client = await connectOrStartController({
      root,
      stateHome,
      protocolVersion: 1,
      lexicalContract: { schema: 1, chunker: "v1", normalization: "v1" },
      handlers: {
        beginConvergence: async () => ({ indexed: true }),
      },
      ephemeral: true,
    })
    assert.deepEqual(await client.beginConvergence(), { indexed: true })
    assert.equal((await client.status()).state, "LEXICAL_READY")
    assert.equal(
      (await client.barrier({ capability: "lexical" })).current,
      true,
    )
    await client.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(stateHome, { recursive: true, force: true })
  }
})

test("a second compatible client refreshes convergence from lexical ready", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-controller-root-"))
  const stateHome = mkdtempSync(path.join(tmpdir(), "desk-controller-state-"))
  let first
  let second
  try {
    const options = {
      root,
      stateHome,
      protocolVersion: 1,
      lexicalContract: { schema: 1, chunker: "v1", normalization: "v1" },
      handlers: {
        beginConvergence: async () => ({ indexed: true }),
      },
      ephemeral: true,
    }
    first = await connectOrStartController(options)
    assert.deepEqual(await first.beginConvergence(), { indexed: true })
    assert.equal((await first.status()).state, "LEXICAL_READY")

    second = await connectOrStartController(options)
    assert.deepEqual(await second.beginConvergence(), { indexed: true })
    assert.equal((await second.status()).state, "LEXICAL_READY")
  } finally {
    await second?.close?.()
    await first?.close?.()
    rmSync(root, { recursive: true, force: true })
    rmSync(stateHome, { recursive: true, force: true })
  }
})

test("F2 in-process semantic mismatch refuses without retaining a phantom client", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-owner-local-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const common = { root, stateHome: path.join(root, "state"), ephemeral: true }
  const firstContract = { mode: "background", endpoints: ["http://first.invalid"] }
  const secondContract = { mode: "required", endpoints: ["http://second.invalid"] }
  const results = await Promise.allSettled([
    connectOrStartController({ ...common, semanticContract: firstContract }),
    connectOrStartController({ ...common, semanticContract: secondContract }),
  ])
  const clients = results.filter((r) => r.status === "fulfilled").map((r) => r.value)
  t.after(async () => { for (const client of clients) await client.close() })
  assert.equal(clients.length, 1)
  const refused = results.find((r) => r.status === "rejected").reason
  assert.equal(refused.code, "controller_semantic_mismatch")
  assert.deepEqual(refused.diagnostic.expected, firstContract)
  assert.deepEqual(refused.diagnostic.observed, secondContract)
  await clients[0].close()
  const replacement = await connectOrStartController({ ...common, semanticContract: secondContract })
  try { assert.deepEqual((await replacement.status()).identity.semantic_contract, secondContract) }
  finally { await replacement.close() }
})

test("F2 wire handshake preserves semantic diagnostics and mismatched mutations are refused", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-owner-wire-"))
  const stateHome = path.join(root, "state")
  const expected = { mode: "background", embedding_spec: { id: "active", dimension: 768 }, endpoints: ["http://first.invalid"] }
  const observed = { ...expected, endpoints: ["http://other.invalid"] }
  let mutations = 0
  const client = await connectOrStartController({
    root, stateHome, ephemeral: true, semanticContract: expected,
    handlers: { beginConvergence: () => { mutations++; return { indexed: true } } },
  })
  t.after(async () => { await client.close(); rmSync(root, { recursive: true, force: true }) })
  const owner = JSON.parse(readFileSync(path.join(stateHome, client.id, "owner.json"), "utf8"))
  for (const method of ["handshake", "beginConvergence", "recordChange"]) {
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection(owner.endpoint)
      let pending = ""
      socket.setTimeout(2_000, () => socket.destroy(new Error("wire request timed out")))
      socket.once("error", reject)
      socket.once("connect", () => socket.write(JSON.stringify({
        id: method, method, params: { token: owner.owner.token, identity: client.id, semantic_contract: observed, path: "task.md" },
      }) + "\n"))
      socket.on("data", (chunk) => {
        pending += chunk
        if (!pending.includes("\n")) return
        socket.end()
        resolve(JSON.parse(pending.split("\n")[0]))
      })
    })
    const diagnostic = method === "handshake" ? response.result.diagnostic : response.error.diagnostic
    if (method === "handshake") assert.equal(response.result.accepted, false)
    else assert.equal(response.error.code, "controller_semantic_mismatch")
    assert.deepEqual(diagnostic.expected, expected)
    assert.deepEqual(diagnostic.observed, observed)
  }
  assert.equal(mutations, 0)
  assert.equal(existsSync(path.join(root, ".state")), false)
  assert.equal(existsSync(path.join(stateHome, client.id, "journal")), false)
})

async function ownershipProcess(root, stateHome, semanticContract) {
  const child = fork(new URL("./fixtures/controller-ownership-client.js", import.meta.url),
    [root, stateHome, JSON.stringify(semanticContract)], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  const history = [], waiters = []
  let stderr = "", closed = false
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.on("message", (message) => {
    history.push(message)
    for (const waiter of [...waiters]) {
      if (message.event === "failed") waiter.reject(new Error(message.message))
      else if (waiter.events.includes(message.event)) waiter.resolve(message)
      else continue
      waiters.splice(waiters.indexOf(waiter), 1)
    }
  })
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => {
      for (const waiter of waiters) waiter.reject(new Error(`owner fixture exited ${code}: ${stderr}`))
      resolve(code)
    })
  })
  const result = {
    history, semanticContract,
    send: (message) => child.send(message),
    wait(...events) {
      const existing = history.find((message) => events.includes(message.event))
      return existing ? Promise.resolve(existing) : new Promise((resolve, reject) => waiters.push({ events, resolve, reject }))
    },
    async close() {
      if (closed) return
      closed = true
      if (child.connected) child.send("close")
      const timer = setTimeout(() => child.kill(), 15_000)
      try { assert.equal(await exit, 0, stderr) } finally { clearTimeout(timer) }
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" })
    },
  }
  await result.wait("ready")
  return result
}

for (const difference of ["mode", "endpoints"]) {
  test(`F2 concurrent processes differing by semantic ${difference} elect exactly one lexical writer`, { timeout: 60_000 }, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "desk-owner-process-"))
    const stateHome = path.join(root, "state")
    const processes = []
    t.after(async () => {
      for (const child of [...processes].reverse()) await child.close()
      rmSync(root, { recursive: true, force: true })
    })
    writeFileSync(path.join(root, "task.md"), "quartz owner")
    const contract = { mode: "background", embedding_spec: { model: "fixture", dimension: 768 }, endpoints: ["http://first.invalid"] }
    const other = difference === "mode" ? { ...contract, mode: "required" }
      : { ...contract, endpoints: ["http://second.invalid"] }
    const starters = await Promise.all([
      ownershipProcess(root, stateHome, contract), ownershipProcess(root, stateHome, other),
    ])
    processes.push(...starters)
    for (const child of starters) child.send("start")
    const outcomes = await Promise.all(starters.map((child) => child.wait("accepted", "refused")))
    const owners = starters.filter((_, i) => outcomes[i].event === "accepted")
    assert.equal(owners.length, 1, JSON.stringify(outcomes))
    for (const owner of owners) owner.send("converge")
    await Promise.all(owners.map((owner) => owner.wait("embedding-held")))
    const reuse = await ownershipProcess(root, stateHome, owners[0].semanticContract)
    processes.push(reuse)
    reuse.send("start")
    const reused = await reuse.wait("accepted", "refused")
    assert.equal(reused.event, "accepted")
    reuse.send("converge")
    assert.equal((await reuse.wait("converged")).result.reused, true)
    for (const owner of owners) owner.send("release")
    await Promise.all(owners.map((owner) => owner.wait("converged")))
    const db = new Database(path.join(root, ".state", "desk-index.sqlite"), { readonly: true })
    let vectors, orphans, generations
    try {
      sqliteVec.load(db)
      vectors = db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs").get().n
      orphans = db.prepare(`SELECT COUNT(*) AS n FROM chunk_vecs v
        LEFT JOIN chunks c ON c.id = v.chunk_id WHERE c.id IS NULL`).get().n
      generations = db.prepare("SELECT COUNT(*) AS n FROM lexical_generations").get().n
    } finally { db.close() }
    assert.equal(owners.length, 1, JSON.stringify({ accepted: owners.length, orphans, generations }))
    const winnerIndex = starters.indexOf(owners[0])
    const refused = outcomes[1 - winnerIndex]
    assert.equal(refused.code, "controller_semantic_mismatch")
    assert.deepEqual(refused.diagnostic.expected, owners[0].semanticContract)
    assert.deepEqual(refused.diagnostic.observed, starters[1 - winnerIndex].semanticContract)
    assert.equal(processes.flatMap((p) => p.history).filter((m) => m.event === "listener-started").length, 1)
    assert.equal(processes.flatMap((p) => p.history).filter((m) => m.event === "mutation-started").length, 1)
    assert.equal(reused.id, outcomes[winnerIndex].id)
    assert.equal(reused.ownerPid, outcomes[winnerIndex].ownerPid)
    assert.equal(readdirSync(stateHome).length, 1)
    assert.equal(generations, 1)
    assert.equal(vectors, 1)
    assert.equal(orphans, 0)
  })
}
