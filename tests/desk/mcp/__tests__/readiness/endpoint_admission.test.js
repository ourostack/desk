import { test } from "node:test"
import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { connectOrStartController, startControllerRuntime } from "../../src/server.js"

function fixture(t) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "desk-endpoints-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(root, "task.md"), "# Endpoint capture\n\nDocument vector.\n")
  return root
}

async function service(t, available) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    res.writeHead(available ? 200 : 503, { "content-type": "application/json" })
    res.end(JSON.stringify(available ? { embedding: Array(768).fill(0.1) } : { error: "unavailable" }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())))
  return { endpoint: `http://127.0.0.1:${server.address().port}/api/embeddings`, requests }
}

async function client(t, root, endpoint, variable = "DESK_EMBED_ENDPOINT") {
  const env = { ...process.env }
  for (const name of ["DESK_EMBED_ENDPOINT", "DESK_OLLAMA_ENDPOINT", "OLLAMA_HOST",
    "DESK_EMBED_MODEL", "OLLAMA_EMBED_MODEL"]) delete env[name]
  env[variable] = endpoint
  const child = fork(new URL("./fixtures/endpoint-client.js", import.meta.url),
    [root, path.join(root, "state"), endpoint],
    { env, stdio: ["ignore", "ignore", "pipe", "ipc"] })
  let stderr = ""
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const exited = once(child, "exit")
  t.after(async () => {
    if (child.connected) child.send("close")
    const [code] = await exited
    assert.equal(code, 0, stderr)
  })
  const result = await Promise.race([
    once(child, "message").then(([message]) => message),
    exited.then(([code]) => { throw new Error(`endpoint client exited ${code}: ${stderr}`) }),
  ])
  return result
}

for (const variable of ["DESK_EMBED_ENDPOINT", "DESK_OLLAMA_ENDPOINT", "OLLAMA_HOST"]) {
  test(`two processes with distinct ${variable} endpoints cannot own two lexical controllers`, { timeout: 20000 }, async (t) => {
    const root = fixture(t)
    const firstService = await service(t, true)
    const secondService = await service(t, true)
    const first = await client(t, root, firstService.endpoint, variable)
    const second = await client(t, root, secondService.endpoint, variable)
    assert.equal(first.started, true)
    assert.equal(second.started, false)
    assert.equal(second.code, "controller_semantic_mismatch")
    assert.equal(second.id, undefined, "the mismatched process must not receive a controller client")
    assert.deepEqual(second.diagnostic.expected, first.contract)
    assert.equal(second.diagnostic.observed.endpoints[0], secondService.endpoint)
    assert.equal(secondService.requests.length, 0)
  })
}

test("required second process cannot borrow the first endpoint's successful probe", { timeout: 20000 }, async (t) => {
  const root = fixture(t)
  const available = await service(t, true)
  const unavailable = await service(t, false)
  const first = await client(t, root, available.endpoint)
  const firstRequests = available.requests.length
  const second = await client(t, root, unavailable.endpoint)
  assert.equal(first.started, true)
  assert.equal(second.started, false)
  assert.equal(second.code, "controller_semantic_mismatch")
  assert.equal(second.id, undefined)
  assert.equal(unavailable.requests.length, 0, "mismatch refuses before another owner's endpoint work")
  assert.equal(available.requests.length, firstRequests, "second admission must not invoke first owner's probe")
})

test("document convergence and query probe use captured endpoints after environment changes", async (t) => {
  const root = fixture(t)
  const captured = "http://captured.test:11434/api/embeddings"
  for (const key of ["DESK_EMBED_ENDPOINT", "DESK_OLLAMA_ENDPOINT", "OLLAMA_HOST"]) {
    const before = process.env[key]
    process.env[key] = captured
    t.after(() => {
      if (before === undefined) delete process.env[key]
      else process.env[key] = before
    })
  }
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, request) => {
    calls.push({ url, ...JSON.parse(request.body) })
    return new Response(JSON.stringify({ embedding: Array(768).fill(0.1) }))
  })
  const controller = await connectOrStartController({
    deskRoot: root, policy: { lexical: "required", semantic: "required" },
    stateHome: path.join(root, "state"), ephemeral: true, controllerLauncher: startControllerRuntime,
  })
  try {
    process.env.DESK_EMBED_ENDPOINT = "http://changed.test:11434"
    const result = await controller.beginConvergence()
    assert.ok(calls.some(({ prompt }) => prompt.includes("Endpoint capture")))
    assert.ok(calls.some(({ prompt }) => prompt === "desk semantic health probe"))
    assert.ok(calls.every(({ url }) => url === captured))
    assert.deepEqual(controller.identity.semantic_contract.endpoints, [
      captured, "http://127.0.0.1:11434/api/embeddings", "http://localhost:11434/api/embeddings",
    ])
    assert.equal(result.semantic.query_embedding.available, true)
  } finally { await controller.close() }
})
