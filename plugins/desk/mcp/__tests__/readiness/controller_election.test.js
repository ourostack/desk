import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { fork } from "node:child_process"
import { createConnection, createServer } from "node:net"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"
import { tmpdir } from "node:os"
import * as path from "node:path"

import {
  connectOrStartController,
  createControllerResponseAccumulator,
} from "../../src/readiness/controller-client.js"
import { startReadinessController } from "../../src/readiness/controller-server.js"
import * as endpoints from "../../src/readiness/identity.js"

function tempFixture(prefix) {
  return mkdtempSync(path.join(realpathSync(tmpdir()), prefix))
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test("controller response buffering waits for a newline across chunks", () => {
  const lines = []
  const append = createControllerResponseAccumulator((line) => lines.push(line))
  append('{"id":')
  assert.deepEqual(lines, [])
  append('1,"result":{}}\n')
  assert.deepEqual(lines, ['{"id":1,"result":{}}'])
})

test("simultaneous compatible starters elect one controller", async () => {
  const root = tempFixture("desk-controller-root-")
  const stateHome = tempFixture("desk-controller-state-")
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
  const root = tempFixture("desk-controller-root-")
  const stateHome = tempFixture("desk-controller-state-")
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
  const root = tempFixture("desk-controller-root-")
  const stateHome = tempFixture("desk-controller-state-")
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

test("controller uses the default state home under the current HOME when stateHome is omitted", async (t) => {
  const root = tempFixture("desk-controller-root-")
  const home = tempFixture("desk-controller-home-")
  const previousHome = process.env.HOME
  process.env.HOME = home
  t.after(() => {
    process.env.HOME = previousHome
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
  const client = await connectOrStartController({ root, ephemeral: true })
  try {
    assert.equal(client.accepted, true)
    assert.equal(existsSync(path.join(home, ".cache", "ouroboros-skills", "desk", "readiness", client.id, "owner.json")), true)
  } finally {
    await client.close()
  }
})

test("non-ephemeral controllers publish successfully and can still be closed explicitly", async (t) => {
  const root = tempFixture("desk-controller-root-")
  const stateHome = tempFixture("desk-controller-state-")
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(stateHome, { recursive: true, force: true })
  })
  const client = await connectOrStartController({ root, stateHome, ephemeral: false })
  try {
    assert.equal(client.accepted, true)
    assert.equal((await client.status()).state, "CONTROL_READY")
  } finally {
    await client.close()
  }
})

test("controller startup without options fails before creating an owner", async () => {
  await assert.rejects(
    () => connectOrStartController(),
    { code: "ERR_INVALID_ARG_TYPE" },
  )
})

test("controller server startup without options fails before opening a listener", async () => {
  await assert.rejects(
    () => startReadinessController(),
    /absolute POSIX path/u,
  )
})

test("a second compatible client refreshes convergence from lexical ready", async () => {
  const root = tempFixture("desk-controller-root-")
  const stateHome = tempFixture("desk-controller-state-")
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
  const root = tempFixture("desk-owner-local-")
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
  const root = tempFixture("desk-owner-wire-")
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

test("compatible clients reuse an already running external controller through the owner handshake", async (t) => {
  const root = tempFixture("desk-owner-reuse-")
  const stateHome = path.join(root, "state")
  const contract = { mode: "background", embedding_spec: { model: "fixture", dimension: 768 }, endpoints: ["http://first.invalid"] }
  const owner = await ownershipProcess(root, stateHome, contract)
  t.after(async () => { await owner.close(); rmSync(root, { recursive: true, force: true }) })
  owner.send("start")
  const accepted = await owner.wait("accepted")
  const client = await connectOrStartController({
    root, stateHome, protocolVersion: 1, lexicalContract: { schema: 1 }, semanticContract: contract, ephemeral: true,
  })
  try {
    assert.equal(client.id, accepted.id)
    assert.equal((await client.status()).owner.pid, accepted.ownerPid)
  } finally {
    await client.close()
  }
})

test("invalid local owner records are refused without retaining a phantom client", async (t) => {
  const root = tempFixture("desk-owner-invalid-")
  const stateHome = path.join(root, "state")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  const ownerPath = path.join(stateHome, client.id, "owner.json")
  writeFileSync(ownerPath, JSON.stringify({ identity: client.identity, owner: { token: 42 } }))
  await assert.rejects(
    () => connectOrStartController({ root, stateHome, ephemeral: true }),
    /owner record is invalid/u,
  )
  await client.close()
  const replacement = await connectOrStartController({ root, stateHome, ephemeral: true })
  try { assert.equal((await replacement.status()).state, "CONTROL_READY") }
  finally { await replacement.close() }
})

test("controller publication failures propagate without treating them as election collisions", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = tempFixture("desk-owner-publish-")
  const stateHome = path.join(root, "state")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const identity = endpoints.controllerIdentity({ root, protocolVersion: 1, lexicalContract: {}, semanticContract: null })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(path.join(stateDir, "owner.json"), { recursive: true, mode: 0o700 })
  const endpoint = endpoints.deriveControllerEndpoint({ identity })
  let watcherCloses = 0
  t.after(() => rmSync(endpoint, { force: true }))
  await assert.rejects(
    () => connectOrStartController({
      root,
      stateHome,
      ephemeral: true,
      watcherFactory: async () => ({ close() { watcherCloses += 1 } }),
    }),
    { code: "EISDIR" },
  )
  assert.equal(watcherCloses, 1)
  assert.equal(existsSync(endpoint), false)
})

test("aborted controller requests fail before opening a socket", async (t) => {
  const root = tempFixture("desk-owner-abort-")
  const stateHome = path.join(root, "state")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  t.after(() => client.close())
  const abort = new AbortController()
  abort.abort(new Error("caller stopped waiting"))
  await assert.rejects(client.fenceEvents({ signal: abort.signal }), /caller stopped waiting/u)
})

test("controller election waits through a listener collision until the owner handshakes", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = tempFixture("desk-owner-wait-")
  const stateHome = path.join(root, "state")
  const identity = endpoints.controllerIdentity({ root, protocolVersion: 1, lexicalContract: {}, semanticContract: null })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const endpoint = endpoints.deriveControllerEndpoint({ identity })
  const token = "owner-token"
  let requests = 0
  const server = createServer((socket) => {
    let pending = ""
    socket.on("data", (chunk) => {
      pending += chunk
      if (!pending.includes("\n")) return
      requests++
      if (requests === 1) {
        socket.destroy()
        return
      }
      if (requests === 2) {
        const message = JSON.parse(pending.split("\n")[0])
        socket.end(`${JSON.stringify({
          id: message.id,
          result: { accepted: false, identity },
        })}\n`)
        return
      }
      const message = JSON.parse(pending.split("\n")[0])
      socket.end(`${JSON.stringify({
        id: message.id,
        result: { accepted: true, identity },
      })}\n`)
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, resolve)
  })
  const stat = lstatSync(endpoint)
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({
    identity,
    endpoint,
    socket: { dev: stat.dev, ino: stat.ino },
    owner: { token, pid: process.pid },
  }))
  t.after(() => {
    server.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(endpoint, { force: true })
  })
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  await client.close()
  assert.equal(requests >= 3, true)
})

test("external controller semantic mismatch during discovery is surfaced without takeover", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = tempFixture("desk-owner-semantic-discovery-")
  const stateHome = path.join(root, "state")
  const expected = { mode: "background", endpoints: ["http://owner.invalid"] }
  const observed = { mode: "required", endpoints: ["http://caller.invalid"] }
  const identity = endpoints.controllerIdentity({ root, protocolVersion: 1, lexicalContract: {}, semanticContract: expected })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const endpoint = endpoints.deriveControllerEndpoint({ identity })
  const token = "owner-token"
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({ identity, owner: { token } }))
  const server = createServer((socket) => {
    let pending = ""
    socket.on("data", (chunk) => {
      pending += chunk
      if (!pending.includes("\n")) return
      const message = JSON.parse(pending.split("\n")[0])
      socket.end(`${JSON.stringify({
        id: message.id,
        error: {
          code: "controller_semantic_mismatch",
          message: "semantic mismatch",
          diagnostic: { expected, observed },
        },
      })}\n`)
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, resolve)
  })
  t.after(() => {
    server.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(endpoint, { force: true })
  })
  await assert.rejects(
    () => connectOrStartController({ root, stateHome, semanticContract: expected, ephemeral: true }),
    { code: "controller_semantic_mismatch" },
  )
})

test("controller request timeout rejects bounded calls when an owner stops responding", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = tempFixture("desk-owner-timeout-")
  const stateHome = path.join(root, "state")
  const identity = endpoints.controllerIdentity({ root, protocolVersion: 1, lexicalContract: {}, semanticContract: null })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const endpoint = endpoints.deriveControllerEndpoint({ identity })
  const token = "owner-token"
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({ identity, owner: { token } }))
  const server = createServer((socket) => {
    let pending = ""
    socket.on("data", (chunk) => {
      pending += chunk
      if (!pending.includes("\n")) return
      const message = JSON.parse(pending.split("\n")[0])
      if (message.method === "handshake") {
        socket.end(`${JSON.stringify({ id: message.id, result: { accepted: true, identity } })}\n`)
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, resolve)
  })
  t.after(() => {
    server.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(endpoint, { force: true })
  })
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  await assert.rejects(client.status(), /readiness controller request timed out: status/u)
  await client.close()
})

test("controller request errors preserve diagnostic payloads", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = tempFixture("desk-owner-diagnostic-")
  const stateHome = path.join(root, "state")
  const identity = endpoints.controllerIdentity({ root, protocolVersion: 1, lexicalContract: {}, semanticContract: null })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const endpoint = endpoints.deriveControllerEndpoint({ identity })
  const token = "owner-token"
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({ identity, owner: { token } }))
  const diagnostic = { reason: "fixture_reason", message: "fixture diagnostic" }
  const server = createServer((socket) => {
    let pending = ""
    socket.on("data", (chunk) => {
      pending += chunk
      if (!pending.includes("\n")) return
      const message = JSON.parse(pending.split("\n")[0])
      if (message.method === "handshake") {
        socket.end(`${JSON.stringify({ id: message.id, result: { accepted: true, identity } })}\n`)
        return
      }
      socket.end(`${JSON.stringify({
        id: message.id,
        error: { code: "fixture_error", reason: "fixture_reason", message: "fixture failed", diagnostic },
      })}\n`)
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, resolve)
  })
  t.after(() => {
    server.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(endpoint, { force: true })
  })
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  await assert.rejects(client.status(), {
    code: "fixture_error",
    reason: "fixture_reason",
    diagnostic,
  })
  await client.close()
})

test("controller rejects wire requests with the wrong token before dispatching any method", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = tempFixture("desk-owner-auth-")
  const stateHome = path.join(root, "state")
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  const owner = JSON.parse(readFileSync(path.join(stateHome, client.id, "owner.json"), "utf8"))
  t.after(async () => {
    await client.close()
    rmSync(root, { recursive: true, force: true })
  })
  const response = await new Promise((resolve, reject) => {
    const socket = createConnection(owner.endpoint)
    let pending = ""
    socket.once("error", reject)
    socket.once("connect", () => socket.write(JSON.stringify({
      id: "wrong-token",
      method: "status",
      params: { token: "not-the-owner", identity: client.id, semantic_contract: null },
    }) + "\n"))
    socket.on("data", (chunk) => {
      pending += chunk
      if (!pending.includes("\n")) return
      socket.end()
      resolve(JSON.parse(pending.split("\n")[0]))
    })
  })
  assert.equal(response.error.code, undefined)
  assert.match(response.error.message, /authentication failed/u)
})

test("controller reports unknown wire methods instead of dispatching them", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = tempFixture("desk-owner-unknown-method-")
  const stateHome = path.join(root, "state")
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  const owner = JSON.parse(readFileSync(path.join(stateHome, client.id, "owner.json"), "utf8"))
  t.after(async () => {
    await client.close()
    rmSync(root, { recursive: true, force: true })
  })
  const response = await new Promise((resolve, reject) => {
    const socket = createConnection(owner.endpoint)
    let pending = ""
    socket.once("error", reject)
    socket.once("connect", () => socket.write(JSON.stringify({
      id: "unknown-method",
      method: "notARealMethod",
      params: { token: owner.owner.token, identity: client.id, semantic_contract: null },
    }) + "\n"))
    socket.on("data", (chunk) => {
      pending += chunk
      if (!pending.includes("\n")) return
      socket.end()
      resolve(JSON.parse(pending.split("\n")[0]))
    })
  })
  assert.equal(response.error.code, undefined)
  assert.match(response.error.message, /unknown readiness controller method/u)
})

test("controller ignores blank wire lines and uses the default freshness_uncertain reason when none is supplied", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = tempFixture("desk-owner-default-reason-")
  const stateHome = path.join(root, "state")
  const client = await connectOrStartController({ root, stateHome, ephemeral: true })
  const owner = JSON.parse(readFileSync(path.join(stateHome, client.id, "owner.json"), "utf8"))
  t.after(async () => {
    await client.close()
    rmSync(root, { recursive: true, force: true })
  })

  await new Promise((resolve, reject) => {
    const socket = createConnection(owner.endpoint)
    socket.once("error", reject)
    socket.once("connect", () => socket.end("\n"))
    socket.once("close", resolve)
  })

  const response = await new Promise((resolve, reject) => {
    const socket = createConnection(owner.endpoint)
    let pending = ""
    socket.once("error", reject)
    socket.once("connect", () => socket.write(JSON.stringify({
      id: "default-reason",
      method: "markUncertain",
      params: { token: owner.owner.token, identity: client.id, semantic_contract: null },
    }) + "\n"))
    socket.on("data", (chunk) => {
      pending += chunk
      if (!pending.includes("\n")) return
      socket.end()
      resolve(JSON.parse(pending.split("\n")[0]))
    })
  })
  assert.equal(response.result.reason, "freshness_uncertain")
})

test("controller convergence reuses accepted defaults and keeps retry evidence", async (t) => {
  const root = tempFixture("desk-owner-defaults-")
  const stateHome = path.join(root, "state")
  let calls = 0
  const client = await connectOrStartController({
    root,
    stateHome,
    ephemeral: false,
    handlers: {
      beginConvergence: async () => {
        calls += 1
        if (calls === 1) return undefined
        if (calls === 2) throw Object.assign(new Error("superseded"), { code: "generation_superseded" })
        if (calls === 3) throw new Error("plain failure")
        return { indexed: true }
      },
    },
  })
  t.after(async () => {
    await client.close()
    rmSync(root, { recursive: true, force: true })
  })

  assert.deepEqual(await client.beginConvergence(), { accepted: true })
  assert.equal((await client.status()).state, "LEXICAL_READY")

  await assert.rejects(client.beginConvergence(), { code: "generation_superseded" })
  assert.equal((await client.status()).freshness.reason, "generation_superseded")
})

test("controller returns to lexical ready from RECOVERING and reports semantic convergence without diagnostics", async (t) => {
  const root = tempFixture("desk-owner-semantic-status-")
  const stateHome = path.join(root, "state")
  const client = await connectOrStartController({
    root,
    stateHome,
    ephemeral: false,
    semanticContract: { mode: "background", embedding_spec: { model: "fixture", dimension: 768 } },
    handlers: {
      beginConvergence: async () => ({
        semantic: {
          chunks_total: 1,
          vectors_indexed: 1,
          missing_vectors: 0,
          provenance_current: true,
          query_embedding: { available: true },
        },
      }),
    },
  })
  t.after(async () => {
    await client.close()
    rmSync(root, { recursive: true, force: true })
  })
  await client.markUncertain({ reason: "pending_change" })
  const result = await client.beginConvergence()
  assert.deepEqual(result.semantic.query_embedding, { available: true })
  const status = await client.status()
  assert.equal(status.state, "LEXICAL_READY")
  assert.equal(status.convergence.semantic.query_embedding.diagnostic, null)
})

test("controller keeps RECOVERING state when queued reconciliation fails ordinarily", async (t) => {
  const root = tempFixture("desk-owner-recovering-")
  const stateHome = path.join(root, "state")
  const client = await connectOrStartController({
    root,
    stateHome,
    ephemeral: false,
    handlers: {
      beginConvergence: async () => { throw new Error("plain failure") },
    },
  })
  t.after(async () => {
    await client.close()
    rmSync(root, { recursive: true, force: true })
  })
  await client.markUncertain({})
  await assert.rejects(client.barrier({ capability: "lexical", wait: true }), /plain failure/u)
  assert.equal((await client.status()).state, "RECOVERING")
})

test("controller preserves RECOVERING when an in-flight convergence is invalidated and then fails", async (t) => {
  const root = tempFixture("desk-owner-midflight-")
  const stateHome = path.join(root, "state")
  let release
  const entered = new Promise((resolve) => {
    release = resolve
  })
  const client = await connectOrStartController({
    root,
    stateHome,
    ephemeral: false,
    handlers: {
      beginConvergence: async () => {
        await entered
        throw new Error("ordinary failure")
      },
    },
  })
  t.after(async () => {
    await client.close()
    rmSync(root, { recursive: true, force: true })
  })
  const work = client.beginConvergence()
  await client.markUncertain({ reason: "pending_change" })
  release()
  await assert.rejects(work, /ordinary failure/u)
  assert.equal((await client.status()).state, "RECOVERING")
})

test("controller reports string convergence failures through status and suppresses destroyed-socket error replies", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = tempFixture("desk-owner-string-failure-")
  const stateHome = path.join(root, "state")
  const client = await connectOrStartController({
    root,
    stateHome,
    ephemeral: false,
    handlers: {
      beginConvergence: async () => { throw "string convergence failure" },
      barrier: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        throw new Error("delayed barrier failure")
      },
    },
  })
  const owner = JSON.parse(readFileSync(path.join(stateHome, client.id, "owner.json"), "utf8"))
  t.after(async () => {
    await client.close()
    rmSync(root, { recursive: true, force: true })
  })

  await assert.rejects(client.beginConvergence(), /string convergence failure/u)
  assert.equal((await client.status()).convergence.diagnostic.message, "string convergence failure")

  await new Promise((resolve, reject) => {
    const socket = createConnection(owner.endpoint)
    socket.once("error", reject)
    socket.once("connect", () => {
      socket.write(JSON.stringify({
        id: "destroyed",
        method: "barrier",
        params: { token: owner.owner.token, identity: client.id, semantic_contract: null },
      }) + "\n")
      socket.destroy()
      setTimeout(resolve, 60)
    })
  })
})

test("controller serializes null ids and string errors, and tolerates destroyed sockets during failures", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = tempFixture("desk-owner-wire-errors-")
  const stateHome = path.join(root, "state")
  const client = await connectOrStartController({
    root,
    stateHome,
    ephemeral: true,
    handlers: {
      barrier: () => { throw "string failure" },
    },
  })
  const owner = JSON.parse(readFileSync(path.join(stateHome, client.id, "owner.json"), "utf8"))
  t.after(async () => {
    await client.close()
    rmSync(root, { recursive: true, force: true })
  })

  const nullIdResponse = await new Promise((resolve, reject) => {
    const socket = createConnection(owner.endpoint)
    let pending = ""
    socket.once("error", reject)
    socket.once("connect", () => socket.write(JSON.stringify({
      method: "barrier",
      params: { token: owner.owner.token, identity: client.id, semantic_contract: null },
    }) + "\n"))
    socket.on("data", (chunk) => {
      pending += chunk
      if (!pending.includes("\n")) return
      socket.end()
      resolve(JSON.parse(pending.split("\n")[0]))
    })
  })
  assert.equal(nullIdResponse.id, null)
  assert.equal(nullIdResponse.error.message, "string failure")

  await new Promise((resolve, reject) => {
    const socket = createConnection(owner.endpoint)
    socket.once("error", reject)
    socket.once("connect", () => {
      socket.write("{bad json}\n")
      socket.destroy()
      setTimeout(resolve, 50)
    })
  })
})

test("controller owner publication and cleanup use win32 fallbacks when platform detection says win32", async (t) => {
  const root = tempFixture("desk-owner-win32-")
  const stateHome = path.join(root, "state")
  const identity = endpoints.controllerIdentity({ root, protocolVersion: 1, lexicalContract: {}, semanticContract: null })
  const endpoint = path.join(root, "controller.sock")
  const stateDir = path.join(stateHome, identity.id)
  const originalPlatform = process.platform
  Object.defineProperty(process, "platform", { value: "win32" })
  t.after(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
    rmSync(root, { recursive: true, force: true })
    rmSync(endpoint, { force: true })
  })
  const server = await startReadinessController({ identity, endpoint, stateDir, ephemeral: true })
  try {
    const owner = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
    assert.equal(owner.socket, null)
  } finally {
    await server.close()
  }
})

test("controller close clears queued reconciliation before it runs", async (t) => {
  const root = tempFixture("desk-owner-close-")
  const stateHome = path.join(root, "state")
  let convergences = 0
  const client = await connectOrStartController({
    root,
    stateHome,
    ephemeral: true,
    handlers: {
      beginConvergence: async () => {
        convergences += 1
        return { indexed: true }
      },
    },
  })
  const owner = JSON.parse(readFileSync(path.join(stateHome, client.id, "owner.json"), "utf8"))
  writeFileSync(path.join(path.dirname(path.join(stateHome, client.id, "owner.json")), "extra.txt"), "leftover")
  await client.markUncertain({})
  await client.close()
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(convergences <= 1, true)
  assert.equal(existsSync(path.join(path.dirname(path.join(stateHome, client.id, "owner.json")), "owner.json")), false)
  assert.equal(existsSync(path.join(path.dirname(path.join(stateHome, client.id, "owner.json")), "extra.txt")), true)
  rmSync(root, { recursive: true, force: true })
  rmSync(owner.endpoint, { force: true })
})

test("direct controller close tolerates a rejecting convergence promise", async (t) => {
  const root = tempFixture("desk-owner-direct-close-")
  const stateHome = path.join(root, "state")
  const identity = endpoints.controllerIdentity({ root, protocolVersion: 1, lexicalContract: {}, semanticContract: null })
  const endpoint = endpoints.deriveControllerEndpoint({ identity })
  const stateDir = path.join(stateHome, identity.id)
  const entered = deferred()
  const release = deferred()
  const controller = await startReadinessController({
    identity,
    endpoint,
    stateDir,
    ephemeral: true,
    handlers: {
      beginConvergence: async () => {
        entered.resolve()
        await release.promise
        throw new Error("close failure")
      },
    },
  })
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(endpoint, { force: true })
  })
  const owner = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
  const beginResponse = new Promise((resolve, reject) => {
    const socket = createConnection(owner.endpoint)
    let pending = ""
    socket.once("error", reject)
    socket.once("connect", () => socket.write(JSON.stringify({
      id: "begin",
      method: "beginConvergence",
      params: { token: owner.owner.token, identity: identity.id, semantic_contract: null },
    }) + "\n"))
    socket.on("data", (chunk) => {
      pending += chunk
      if (!pending.includes("\n")) return
      socket.end()
      resolve(JSON.parse(pending.split("\n")[0]))
    })
  })
  await entered.promise
  release.resolve()
  await controller.close()
  assert.match((await beginResponse).error.message, /close failure/u)
})

test("direct controller close clears queued reconciliation and tolerates ENOTEMPTY cleanup", async (t) => {
  const root = tempFixture("desk-owner-direct-queue-")
  const stateHome = path.join(root, "state")
  const identity = endpoints.controllerIdentity({ root, protocolVersion: 1, lexicalContract: {}, semanticContract: null })
  const endpoint = endpoints.deriveControllerEndpoint({ identity })
  const stateDir = path.join(stateHome, identity.id)
  const originalSetImmediate = globalThis.setImmediate
  const originalClearImmediate = globalThis.clearImmediate
  const scheduled = []
  let cleared = null
  globalThis.setImmediate = (callback, ...args) => {
    const token = { callback, args }
    scheduled.push(token)
    return token
  }
  globalThis.clearImmediate = (token) => {
    cleared = token
  }
  const controller = await startReadinessController({ identity, endpoint, stateDir, ephemeral: true })
  t.after(() => {
    globalThis.setImmediate = originalSetImmediate
    globalThis.clearImmediate = originalClearImmediate
    rmSync(root, { recursive: true, force: true })
    rmSync(endpoint, { force: true })
  })
  const owner = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
  writeFileSync(path.join(stateDir, "extra.txt"), "leftover")
  await new Promise((resolve, reject) => {
    const socket = createConnection(owner.endpoint)
    let pending = ""
    socket.once("error", reject)
    socket.once("connect", () => socket.write(JSON.stringify({
      id: "queue",
      method: "markUncertain",
      params: { token: owner.owner.token, identity: identity.id, semantic_contract: null, reason: "pending_change" },
    }) + "\n"))
    socket.on("data", (chunk) => {
      pending += chunk
      if (!pending.includes("\n")) return
      socket.end()
      resolve(JSON.parse(pending.split("\n")[0]))
    })
  })
  await controller.close()
  assert.equal(scheduled.length > 0, true)
  assert.equal(cleared !== null, true)
  assert.equal(existsSync(path.join(stateDir, "owner.json")), false)
  assert.equal(existsSync(path.join(stateDir, "extra.txt")), true)
})

test("direct controller close propagates unexpected state-dir removal errors", async (t) => {
  const root = tempFixture("desk-owner-direct-error-")
  const stateHome = path.join(root, "state")
  const identity = endpoints.controllerIdentity({ root, protocolVersion: 1, lexicalContract: {}, semanticContract: null })
  const endpoint = endpoints.deriveControllerEndpoint({ identity })
  const stateDir = path.join(stateHome, identity.id)
  const controller = await startReadinessController({ identity, endpoint, stateDir, ephemeral: true })
  t.after(() => {
    chmodSync(stateHome, 0o700)
    rmSync(root, { recursive: true, force: true })
    rmSync(endpoint, { force: true })
  })
  chmodSync(stateHome, 0o500)
  await assert.rejects(controller.close(), (error) => error?.code === "EACCES" || error?.code === "EPERM")
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
    const root = tempFixture("desk-owner-process-")
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
