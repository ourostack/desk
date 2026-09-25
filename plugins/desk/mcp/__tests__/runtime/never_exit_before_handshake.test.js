// Degrade, never die: from spawn onward Desk always answers initialize and tools/list.
//
// Unit tests pin the in-process pieces (the last-resort catch, the Node floor check, the Node-16-safe failure clone and the full diagnostic tool list); spawned tests start index.js over stdio with a temporary HOME and desk root, inject real startup exceptions and time the handshake; the Node matrix runs the same handshake under every installed Node major.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { PassThrough } from "node:stream"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import {
  installedNodesByMajor,
  isolatedEnv,
  makeIsolatedHome,
  mcpRoot,
  runHandshake,
  toolPayload,
} from "../launch/_mcp_handshake.js"

const entrypoint = await import(pathToFileURL(path.join(mcpRoot, "index.js")).href)
const { TOOL_NAMES } = await import(pathToFileURL(path.join(mcpRoot, "src", "tool-names.js")).href)
const { startDiagnosticServer } = await import(pathToFileURL(path.join(mcpRoot, "src", "runtime", "diagnostic-server.js")).href)
const diagnostics = await import(pathToFileURL(path.join(mcpRoot, "src", "runtime", "diagnostics.js")).href)
const { terminalFailure, ActivationFailure } = await import(pathToFileURL(path.join(mcpRoot, "src", "activation", "failures.js")).href)

const HANDSHAKE_BUDGET_MS = 3000
const indexPath = path.join(mcpRoot, "index.js")
const nodes = installedNodesByMajor()
const compatibleNode = process.execPath

function assertFullToolList(tools) {
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), TOOL_NAMES)
}

async function serveDiagnostic(diagnostic, messages) {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks = []
  output.on("data", (chunk) => chunks.push(chunk))
  const running = startDiagnosticServer({ diagnostic, input, output, serverVersion: "9.9.9" })
  input.end(messages.map((message) => JSON.stringify({ jsonrpc: "2.0", ...message })).join("\n") + "\n")
  await running
  return Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

// ---- the failure clone must work on Node 16 ----

test("terminal failures are deep-frozen plain copies, so the degraded path never needs structuredClone", (t) => {
  // Prove the copy never reaches for structuredClone, which Node 16 lacks.
  const original = globalThis.structuredClone
  globalThis.structuredClone = undefined
  t.after(() => { globalThis.structuredClone = original })
  const observed = { nested: { value: 1 }, list: [{ a: 1 }], kept: undefined }
  const failure = terminalFailure({ phase: "P", code: "c", observed, expected: { x: [1] }, automaticActions: [{ action: "a" }], summary: "s" })
  assert.deepEqual(failure.observed, { nested: { value: 1 }, list: [{ a: 1 }], kept: undefined })
  assert.notEqual(failure.observed.nested, observed.nested)
  assert.equal(Object.isFrozen(failure.observed.nested), true)
  assert.equal(Object.isFrozen(failure.observed.list[0]), true)
  assert.deepEqual(failure.expected, { x: [1] })
  assert.deepEqual(failure.automatic_actions, [{ action: "a" }])
  assert.deepEqual(terminalFailure({ expected: null, observed: undefined }).expected, {})
  assert.deepEqual(new ActivationFailure({ code: "c", summary: "s" }).observed, {})
  // Defaults and non-array automatic actions still yield a complete, plain envelope.
  assert.deepEqual(terminalFailure(), {
    status: "terminal", phase: undefined, code: undefined, retryable: false,
    expected: {}, observed: {}, automatic_actions: [], summary: undefined,
  })
  assert.deepEqual(terminalFailure({ automaticActions: "retry" }).automatic_actions, [])
  const bare = new ActivationFailure()
  assert.equal(bare.status, "terminal")
  assert.equal(bare.diagnostics, undefined)
  const withDiagnostics = new ActivationFailure({ summary: "s", diagnostics: [{ path: "p" }] })
  assert.deepEqual(withDiagnostics.diagnostics, [{ path: "p" }])
})

test("the runtime diagnostic path runs on Node 16", {
  skip: nodes.has(16) ? false : "no Node 16 is installed here (nvm or this process); the CI image carries only its own Node",
}, () => {
  const script = [
    `const { createRuntimeDiagnostic } = await import(${JSON.stringify(pathToFileURL(path.join(mcpRoot, "src", "runtime", "diagnostics.js")).href)})`,
    `const diagnostic = createRuntimeDiagnostic({ reason: "no_compatible_node", currentTarget: { id: "x" }, shippedTargets: [{ node_abi: "127" }] })`,
    `process.stdout.write(JSON.stringify({ state: diagnostic.state, code: diagnostic.code }))`,
  ].join("\n")
  const result = spawnSync(nodes.get(16).executable, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", NODE_OPTIONS: "" },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { state: "degraded:runtime_unsupported", code: "runtime_unsupported" })
})

// ---- diagnostic mode lists every tool and gates the ones it cannot run ----

test("diagnostic mode lists the full tool set, advertises listChanged, and gates data tools with status, code and fix", async () => {
  const diagnostic = diagnostics.createRuntimeDiagnostic({
    reason: "no_compatible_node",
    currentTarget: { id: "darwin-arm64-node-93" },
    shippedTargets: [{ id: "darwin-arm64-node-127", node_abi: "127" }],
  })
  assert.equal(diagnostic.state, "degraded:runtime_unsupported")
  assert.equal(diagnostic.fix, diagnostic.remediation[0].message)
  const [init, list, status, gated] = await serveDiagnostic(diagnostic, [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "desk_status", arguments: {} } },
    { id: 4, method: "tools/call", params: { name: "task_create", arguments: {} } },
  ])
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: true } })
  assertFullToolList(list)
  for (const tool of list.result.tools) {
    assert.equal(typeof tool.description, "string")
    assert.equal(tool.inputSchema.type, "object")
  }
  assert.deepEqual(
    list.result.tools.find((tool) => tool.name === "desk_doctor").inputSchema.properties.format.enum,
    ["full", "preview"],
  )
  assert.equal(status.result.isError, undefined)
  assert.equal(toolPayload(status).state, "degraded:runtime_unsupported")
  const refusal = toolPayload(gated)
  assert.equal(gated.result.isError, true)
  assert.equal(refusal.status, "degraded")
  assert.equal(refusal.code, "runtime_unsupported")
  assert.equal(refusal.fix, diagnostic.fix)
  assert.equal(refusal.tool, "task_create")
  assert.match(refusal.summary, /task_create is unavailable while Desk is in diagnostic mode/u)
})

test("a gated refusal still names a code and a fix when the diagnostic has neither", async () => {
  const setup = diagnostics.createSetupDiagnostic({})
  const bare = { status: "degraded", mode: "diagnostic", reason: "bare_reason", summary: "bare" }
  const [fromSetup] = await serveDiagnostic(setup, [{ id: 1, method: "tools/call", params: { name: "desk_search" } }])
  const [fromBare] = await serveDiagnostic(bare, [{ id: 1, method: "tools/call", params: { name: "lesson_add" } }])
  const setupRefusal = toolPayload(fromSetup)
  assert.equal(setupRefusal.status, "degraded")
  assert.equal(setupRefusal.code, "no_desk_root")
  assert.equal(setupRefusal.fix, setup.remediation[0].message)
  const bareRefusal = toolPayload(fromBare)
  assert.equal(bareRefusal.code, "bare_reason")
  assert.match(bareRefusal.fix, /desk_doctor/u)
})

// ---- the startup-exception diagnostic ----

test("a startup exception becomes a named degraded state that carries the cause and a fix", () => {
  const plain = diagnostics.createStartupExceptionDiagnostic({ error: new Error("--root path does not exist: /nope") })
  assert.equal(plain.status, "degraded")
  assert.equal(plain.mode, "diagnostic")
  assert.equal(plain.reason, "startup_exception")
  assert.equal(plain.code, "startup_exception")
  assert.equal(plain.state, "degraded:startup_exception")
  assert.equal(plain.phase, "STARTING")
  assert.deepEqual(plain.observed, { name: "Error", message: "--root path does not exist: /nope" })
  assert.equal(plain.fix, plain.remediation[0].message)
  assert.match(plain.fix, /observed\.message/u)
  assert.equal(plain.lexical.serving_path, "blocked")

  const activation = diagnostics.createStartupExceptionDiagnostic({
    error: new ActivationFailure({ phase: "VERIFYING", code: "activation_policy_invalid", summary: "bad policy" }),
  })
  assert.equal(activation.phase, "VERIFYING")
  assert.deepEqual(activation.observed, { name: "ActivationFailure", message: "bad policy", failure_code: "activation_policy_invalid" })

  const thrownValue = diagnostics.createStartupExceptionDiagnostic({ error: "a string was thrown" })
  assert.deepEqual(thrownValue.observed, { name: "unknown", message: "a string was thrown" })
  const nothing = diagnostics.createStartupExceptionDiagnostic()
  assert.deepEqual(nothing.observed, { name: "unknown", message: "undefined" })
})

// ---- the last-resort catch ----

test("the entrypoint catch serves diagnostic mode instead of exiting when startup throws", async () => {
  const modulePath = indexPath
  const moduleUrl = pathToFileURL(modulePath).href
  const writes = []
  const exits = []
  const started = []
  const stderr = { write: (text) => writes.push(text) }
  const exit = (code) => exits.push(code)
  const startDiagnostic = async ({ error }) => { started.push(error.message) }

  await entrypoint.runIfEntrypoint({
    argv: ["node", modulePath], moduleUrl, stderr, exit, startDiagnostic,
    launch: async () => { throw new Error("async boom") },
  })
  await entrypoint.runIfEntrypoint({
    argv: ["node", modulePath], moduleUrl, stderr, exit, startDiagnostic,
    launch: () => { throw new Error("sync boom") },
  })
  assert.deepEqual(started, ["async boom", "sync boom"])
  assert.deepEqual(exits, [])
  assert.match(writes.join(""), /\[desk-mcp\] startup exception: async boom; serving diagnostic mode/u)

  await entrypoint.runIfEntrypoint({
    argv: ["node", modulePath], moduleUrl, stderr, exit,
    startDiagnostic: async () => { throw new Error("stdin closed") },
    launch: async () => { throw new Error("third boom") },
  })
  assert.deepEqual(exits, [1])
  assert.match(writes.join(""), /\[desk-mcp\] fatal: stdin closed/u)

  await entrypoint.runIfEntrypoint({
    argv: ["node", modulePath], moduleUrl, stderr, exit, startDiagnostic,
    launch: async () => { throw "not an Error" },
  })
  assert.match(writes.join(""), /startup exception: not an Error/u)
})

test("the default startup-exception starter serves the diagnostic on stdio with the package version", async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks = []
  output.on("data", (chunk) => chunks.push(chunk))
  const running = entrypoint.startStartupExceptionDiagnostic({ error: new Error("boom"), input, output })
  input.end([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "desk_status" } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n")
  await running
  const [init, status] = Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(init.result.serverInfo.version, entrypoint.resolveMcpServerVersion({ mcpRoot }))
  assert.equal(toolPayload(status).state, "degraded:startup_exception")
  assert.equal(toolPayload(status).observed.message, "boom")
})

// ---- the Node floor check at the top of main ----

test("the Node floor comes from engines.node and falls back to 20.0.0", () => {
  const read = (text) => entrypoint.resolveNodeFloor({ mcpRoot: "/fixture", readFile: () => text })
  assert.deepEqual(read(JSON.stringify({ engines: { node: ">=20.0.0" } })), [20, 0, 0])
  assert.deepEqual(read(JSON.stringify({ engines: { node: ">= v22.3" } })), [22, 3, 0])
  assert.deepEqual(read(JSON.stringify({ engines: { node: ">=24" } })), [24, 0, 0])
  assert.deepEqual(read(JSON.stringify({ engines: { node: "^22 || ^24" } })), [20, 0, 0])
  assert.deepEqual(read(JSON.stringify({})), [20, 0, 0])
  assert.deepEqual(read("{not json"), [20, 0, 0])
  assert.deepEqual(entrypoint.resolveNodeFloor({ mcpRoot }), [20, 0, 0])
  assert.deepEqual(entrypoint.resolveNodeFloor(), [20, 0, 0])
  assert.equal(entrypoint.nodeMeetsFloor("16.20.2", [20, 0, 0]), false)
  assert.equal(entrypoint.nodeMeetsFloor("19.9.9", [20, 0, 0]), false)
  assert.equal(entrypoint.nodeMeetsFloor("20.0.0", [20, 0, 0]), true)
  assert.equal(entrypoint.nodeMeetsFloor("20.10.0", [20, 9, 0]), true)
  assert.equal(entrypoint.nodeMeetsFloor("20.9.1", [20, 9, 2]), false)
  assert.equal(entrypoint.nodeMeetsFloor("24.0.0", [20, 0, 0]), true)
  assert.equal(entrypoint.nodeMeetsFloor("not-a-version", [20, 0, 0]), false)
})

test("an old Node goes straight to compatible-Node selection before any other startup work", async () => {
  const calls = []
  const inspection = {
    ok: true,
    runtime: {
      current_target: { id: "darwin-arm64-node-93" },
      shipped_targets: [{ id: "darwin-arm64-node-127", node_abi: "127" }],
      paths_checked: ["/plugin/support-matrix.json"],
    },
  }
  const result = await entrypoint.main({
    argv: ["--root", "/does/not/matter"],
    env: {},
    mcpRoot,
    nodeVersion: "16.20.2",
    runtimeInspector: () => inspection,
    runtimeImporter: async () => { throw new Error("must not import the runtime on an old Node") },
    nodeCandidateDiscoverer: () => ["/nvm/v22/bin/node"],
    nodeSelector: ({ candidates, currentTarget, shippedTargets }) => {
      calls.push(["select", candidates, currentTarget.id, shippedTargets.length])
      return { mode: "reexec", executable: "/nvm/v22/bin/node", paths_checked: candidates }
    },
    nodeReexecutor: async ({ executable, argv }) => {
      calls.push(["reexec", executable, argv])
      return { code: 0, signal: null, forwardedSignal: null }
    },
    diagnosticServerStarter: async () => { throw new Error("must not start diagnostic mode") },
  })
  assert.deepEqual(result, { code: 0, signal: null, forwardedSignal: null })
  assert.deepEqual(calls, [
    ["select", ["/nvm/v22/bin/node"], "darwin-arm64-node-93", 1],
    ["reexec", "/nvm/v22/bin/node", ["--root", "/does/not/matter"]],
  ])
})

test("an old Node with no compatible Node serves diagnostic mode, even when runtime inspection is unavailable", async () => {
  for (const runtimeInspector of [null, () => { throw new Error("inspection broke") }]) {
    const started = []
    await entrypoint.main({
      argv: [],
      env: {},
      mcpRoot,
      nodeVersion: "16.20.2",
      runtimeInspector,
      runtimeImporter: async () => { throw new Error("must not import") },
      nodeCandidateDiscoverer: () => [],
      nodeSelector: () => ({ mode: "diagnostic", reason: "no_compatible_node", paths_checked: [] }),
      diagnosticServerStarter: async ({ diagnostic }) => { started.push(diagnostic) },
    })
    assert.equal(started.length, 1)
    assert.equal(started[0].reason, "no_compatible_node")
    assert.equal(started[0].state, "degraded:runtime_unsupported")
    assert.equal(started[0].runtime.current_target.id, `${process.platform}-${process.arch}-node-${process.versions.modules}`)
  }
})

test("background convergence that throws synchronously is reported, never turned into a second server", async () => {
  const { admitInProcess } = await import("./_in_process_desk.js")
  const started = await admitInProcess({
    argv: [],
    env: { DESK: mcpRoot },
    mcpRoot,
    runtimeInspector: null,
    readinessPolicy: {},
    runtimeImporter: async () => ({
      admitControlPlane: async () => ({ authority: { mode: "workspace", person: null }, controller: null }),
      beginBackgroundConvergence: () => { throw new Error("sync convergence failure") },
    }),
  })
  assert.equal(started.snapshot.state, "ready")
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(started.stderr, /background convergence failed: sync convergence failure/u)
})

// ---- spawned: real startup exceptions over stdio ----

async function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, typeof value === "string" ? value : JSON.stringify(value))
}

const startupExceptions = [
  {
    id: "--root names a missing path",
    args: (fixture) => ["--root", path.join(fixture.root, "missing-desk")],
    message: /--root path does not exist/u,
    state: "degraded:root_unavailable",
  },
  {
    id: "--host-session-root names a missing path",
    args: (fixture) => ["--host-session-root", path.join(fixture.root, "missing-session")],
    message: /host\/session root path does not exist/u,
    state: "degraded:root_unavailable",
  },
  {
    id: "the activation config is not JSON",
    args: async (fixture) => {
      const configPath = path.join(fixture.root, "activation.json")
      await writeJson(configPath, "{not json")
      return ["--activation-config", configPath]
    },
    message: /must be valid JSON/u,
    state: "degraded:activation_config_invalid",
  },
  {
    id: "the activation config has the wrong schema",
    args: async (fixture) => {
      const configPath = path.join(fixture.root, "activation.json")
      await writeJson(configPath, { schema_version: 2, desk: { root: fixture.desk } })
      return ["--activation-config", configPath]
    },
    message: /schema_version must be 1/u,
    state: "degraded:activation_config_invalid",
  },
  {
    id: "the readiness policy is invalid",
    args: async (fixture) => {
      const configPath = path.join(fixture.root, "activation.json")
      await writeJson(configPath, { schema_version: 1, desk: { root: fixture.desk }, desk_runtime: { semantic: "sometimes" } })
      return ["--activation-config", configPath]
    },
    message: /readiness policy/iu,
    failureCode: "activation_policy_invalid",
    state: "degraded:activation_policy_invalid",
  },
]

for (const scenario of startupExceptions) {
  test(`a bad start (${scenario.id}): the handshake completes within 3 s with the full tool list, then a named degraded state`, async () => {
    const fixture = await makeIsolatedHome("desk-startup-exception-")
    const args = await scenario.args(fixture)
    const result = await runHandshake({
      command: compatibleNode,
      args: [indexPath, ...args],
      cwd: fixture.root,
      env: isolatedEnv(fixture, { DESK: undefined, PATH: `${path.dirname(compatibleNode)}:/usr/bin:/bin` }),
    })
    assert.ok(result.handshakeMs < HANDSHAKE_BUDGET_MS, `handshake took ${result.handshakeMs} ms`)
    assert.equal(result.initialize.result.serverInfo.name, "desk-mcp")
    assertFullToolList(result.tools)
    const status = toolPayload(result.status)
    assert.equal(status.state, scenario.state)
    assert.match(status.observed.message, scenario.message)
    assert.match(status.fix, /desk_status/u)
    if (scenario.failureCode) assert.equal(status.observed.failure_code, scenario.failureCode)
    assert.doesNotMatch(result.stderr, /startup exception/u)
  })
}

// ---- the Node matrix ----

const matrix = [16, 20, 22, 24]

for (const major of matrix) {
  const node = nodes.get(major)
  test(`Node ${major} completes the handshake through index.js with a compatible Node also installed`, {
    skip: node ? false : `no Node ${major} is installed here; the matrix runs every major that is`,
  }, async () => {
    const fixture = await makeIsolatedHome(`desk-node-${major}-`)
    const result = await runHandshake({
      command: node.executable,
      args: [indexPath],
      cwd: fixture.root,
      env: isolatedEnv(fixture, { PATH: `${path.dirname(node.executable)}:${path.dirname(compatibleNode)}:/usr/bin:/bin` }),
    })
    assert.ok(result.handshakeMs < HANDSHAKE_BUDGET_MS, `Node ${node.version}: handshake took ${result.handshakeMs} ms`)
    assertFullToolList(result.tools)
    assert.equal(result.status.result.isError, undefined, JSON.stringify(result.status))
  })
}

test("Node 16 with no compatible Node anywhere serves diagnostic mode instead of crashing", {
  skip: nodes.has(16) ? false : "no Node 16 is installed here; CI covers the diagnostic path in-process",
}, async () => {
  const node = nodes.get(16)
  const fixture = await makeIsolatedHome("desk-node-16-alone-")
  const result = await runHandshake({
    command: node.executable,
    args: [indexPath],
    cwd: fixture.root,
    env: isolatedEnv(fixture, { PATH: `${path.dirname(node.executable)}:/usr/bin:/bin` }),
  })
  assert.ok(result.handshakeMs < HANDSHAKE_BUDGET_MS, `handshake took ${result.handshakeMs} ms`)
  assert.equal(result.initialize.result.serverInfo.name, "desk-mcp-diagnostic")
  assertFullToolList(result.tools)
  const status = toolPayload(result.status)
  assert.equal(status.reason, "no_compatible_node")
  assert.equal(status.state, "degraded:runtime_unsupported")
  assert.doesNotMatch(result.stderr, /structuredClone/u)
})

// ---- a transient controller election is retried in the background, after the handshake ----

const electionTimeout = () => new Error("readiness controller election did not converge")

test("a controller election that times out is retried in the background: degraded first, then ready in the same session", async () => {
  const { startInProcess } = await import("./_in_process_desk.js")
  let attempts = 0
  const desk = await startInProcess({
    argv: [],
    env: { DESK: mcpRoot },
    mcpRoot,
    runtimeInspector: null,
    readinessPolicy: {},
    runtimeImporter: async () => ({
      admitControlPlane: async () => {
        attempts += 1
        if (attempts === 1) throw electionTimeout()
        return { authority: { mode: "workspace", person: null }, controller: null }
      },
    }),
  })
  try {
    const degraded = await desk.settled()
    assert.equal(degraded.state, "degraded:controller_unavailable")
    assert.match(degraded.fix, /re-elects it in the background after 1, 2, 5, 10 and 30 s/u)
    // desk_status retries at once instead of waiting for the backoff.
    const ready = await desk.statusUntil((payload) => payload.state === "ready")
    assert.equal(ready.admission.attempts, 2)
    assert.equal(attempts, 2)
  } finally {
    await desk.close()
  }
})

test("an unexpected error thrown inside admission becomes degraded:admission_exception and recovers in place", async () => {
  const { startInProcess } = await import("./_in_process_desk.js")
  let attempts = 0
  const desk = await startInProcess({
    argv: [],
    env: { DESK: mcpRoot },
    mcpRoot,
    runtimeInspector: null,
    readinessPolicy: {},
    runtimeImporter: async () => ({
      admitControlPlane: async () => {
        attempts += 1
        if (attempts === 1) throw new TypeError("injected admission failure")
        return { authority: { mode: "workspace", person: null }, controller: null }
      },
    }),
  })
  try {
    const failed = await desk.settled()
    assert.equal(failed.state, "degraded:admission_exception")
    assert.deepEqual(failed.diagnostic.observed, { name: "TypeError", message: "injected admission failure" })
    assert.equal((await desk.statusUntil((payload) => payload.state === "ready")).state, "ready")
  } finally {
    await desk.close()
  }
})

test("a failure payload keeps an own __proto__ key as a plain property", () => {
  const observed = JSON.parse('{"__proto__": {"polluted": true}, "kept": 1}')
  const failure = terminalFailure({ observed })
  assert.equal(Object.getPrototypeOf(failure.observed), Object.prototype)
  assert.deepEqual(Object.keys(failure.observed), ["__proto__", "kept"])
  assert.equal(failure.observed.polluted, undefined)
})
