import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import { main } from "../../../../../plugins/desk/mcp/index.js"
import * as server from "../../../../../plugins/desk/mcp/src/server.js"
import { runInWorker } from "../../../../../plugins/desk/mcp/src/runtime/admission-worker.js"
import { copilotSessionFile, recordCopilotSession } from "../../../../../plugins/desk/mcp/src/runtime/copilot-session.js"
import { lastStartRootKey } from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"
import { controllerIdentity } from "../../../../../plugins/desk/mcp/src/readiness/identity.js"
import { request } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"
import { mkTempRoot } from "../_temp_roots.js"

let sequence = 0
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const update = { track: "work", slug: "one", status: "processing" }
const text = "---\nname: One\nstatus: drafting\n---\n\n# One\n"
const payload = (result) => JSON.parse(result.content[0].text)
function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function desk(root, person = null) {
  const prefix = person === null ? root : path.join(root, "desks", person)
  mkdirSync(path.join(root, "_meta"), { recursive: true })
  mkdirSync(path.join(root, person === null ? "_archive" : "desks"), { recursive: true })
  mkdirSync(path.join(prefix, "work", "one"), { recursive: true })
  writeFileSync(path.join(prefix, "work", "one", "task.md"), text)
  git(root, "init", "-b", "main")
  git(root, "config", "user.name", "Fixture")
  git(root, "config", "user.email", "fixture@example.invalid")
  git(root, "add", ".")
  git(root, "commit", "-m", "fixture")
  return root
}
function binding(file, root, extra = {}) {
  writeFileSync(file, JSON.stringify({
    schema_version: 1, desk: { root, state_branch: "main" },
    desk_runtime: { semantic: "unsupported", ...extra },
  }))
}

async function fixture(t, { explicit = false, person = null, capturedFolder = false, sessionRoot = false } = {}) {
  const base = await mkTempRoot("late-workspace-")
  const home = path.join(base, "home")
  const a = desk(path.join(home, "desk"), person)
  const b = desk(path.join(base, "b"), person)
  const cwd = capturedFolder ? a : path.join(base, "code")
  if (!capturedFolder) mkdirSync(cwd)
  const env = {
    ...process.env, HOME: home, XDG_STATE_HOME: path.join(base, "state"),
    XDG_CACHE_HOME: path.join(base, "cache"), XDG_CONFIG_HOME: path.join(base, "config"),
    XDG_DATA_HOME: path.join(base, "data"), XDG_RUNTIME_DIR: path.join(base, "runtime"),
    COPILOT_AGENT_SESSION_ID: `late-${process.pid}-${++sequence}`,
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  }
  delete env.DESK
  delete env.DESK_ACTIVATION_CONFIG
  delete env.CLAUDE_PLUGIN_DATA
  delete env.CLAUDE_PROJECT_DIR
  delete env.CODEX_HOME
  const input = new PassThrough()
  const output = new PassThrough()
  const waiting = new Map()
  let pending = ""
  let id = 0
  output.on("data", (chunk) => {
    pending += chunk
    let newline
    while ((newline = pending.indexOf("\n")) >= 0) {
      const response = JSON.parse(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      if (response.id !== undefined) waiting.get(response.id)?.(response.result)
    }
  })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id
    const deadline = setTimeout(() => reject(new Error(`${method} did not answer`)), 15000)
    waiting.set(requestId, (result) => {
      clearTimeout(deadline)
      waiting.delete(requestId)
      resolve(result)
    })
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`)
  })
  const controllers = []
  const focuses = []
  const endpoints = []
  const connectedRoots = []
  const resolutionTrace = []
  const dispatchTrace = []
  const statusTrace = []
  const convergenceTrace = []
  let hold = false
  let held = null
  // Only the external transport/election seam is replaced. The real worker,
  // authority, controller protocol, journal, handlers, and Git all run.
  // Test sockets are exact-owned, short paths; production rendezvous is unchanged.
  const connector = async ({ deskRoot, policy, stateHome }) => {
    const { protocolVersion, lexicalContract } = server.readinessContracts(policy)
    const identity = controllerIdentity({
      root: deskRoot, protocolVersion, lexicalContract,
      semanticContract: { mode: policy.semantic, embedding_spec: null },
    })
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\desk-late-${process.pid}-${++sequence}`
      : path.join(repoRoot, ".scratch", `s${process.pid}`, `${++sequence}.sock`)
    if (process.platform !== "win32") mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 })
    const controller = await server.startControllerRuntime({
      identity, endpoint, stateDir: path.join(stateHome, identity.id),
      policy, embed: null, ephemeral: true,
    })
    controllers.push(controller)
    endpoints.push(endpoint)
    connectedRoots.push(deskRoot)
    const call = (method, params = {}, timeoutMs = 2000) => request({
      endpoint, identity, method, params: { ...params, token: controller.owner.token }, timeoutMs,
    })
    assert.equal((await call("handshake")).accepted, true)
    return {
      accepted: true, identity,
      status: (timeoutMs) => call("status", {}, timeoutMs),
      beginConvergence: () => call("beginConvergence"),
      barrier: (params) => call("barrier", params, params?.wait ? null : 2000),
      recordChange: (change) => call("recordChange", typeof change === "string" ? { path: change } : change),
      fenceEvents: () => call("fenceEvents"),
      close: () => controller.close(),
    }
  }
  const handle = await main({
    argv: [...(explicit ? ["--root", a] : []), ...(sessionRoot ? ["--host-session-root", a] : []), ...(person ? ["--person", person] : [])],
    env, cwd, homeDir: home, input, output,
    stderr: { write() {} }, admissionKickoffMs: 0,
    stateHome: path.join(base, "session-state"),
    offload: async (job, options) => {
      const value = await runInWorker(job, options)
      if (job.kind === "resolve") {
        resolutionTrace.push({ root: value.root?.root, source: value.root?.source, at: new Date().toISOString() })
        if (hold) {
          hold = false
          await new Promise((resolve) => { held = resolve })
        }
      }
      return value
    }, runtimeInspector: null,
    runtimeImporter: async () => ({
      ...server, connectOrStartController: connector,
      beginBackgroundConvergence: async (admitted) => {
        const trace = { root: admitted.root, started: new Date().toISOString() }
        convergenceTrace.push(trace)
        try {
          return await server.beginBackgroundConvergence(admitted)
        } finally {
          trace.finished = new Date().toISOString()
        }
      },
      callTool: async (options) => {
        dispatchTrace.push({ name: options.name, root: options.deskRoot,
          admissionRoot: options.statusContext.admission?.root,
          authority: options.statusContext.admission?.authority, person: options.person })
        focuses.push(options.statusContext.focus)
        return server.callTool(options)
      },
    }),
  })
  t.after(async () => {
    await handle.admission.idle({ waitMs: 15000 })
    assert.equal(handle.admission.running, false)
    input.end()
    await handle.closed
    for (const controller of controllers) await controller.close()
    assert.ok(controllers.every((controller) => !controller.server.listening))
    const { existsSync } = await import("node:fs")
    if (process.platform !== "win32") assert.ok(endpoints.every((endpoint) => !existsSync(endpoint)))
  })
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "late-context-fixture", version: "1" } })
  await rpc("tools/list", {})
  await handle.admission.idle({ waitMs: 15000 })
  assert.equal(handle.admission.snapshot().state, "ready")
  const call = (name, args = {}) => rpc("tools/call", { name, arguments: args })
  const config = path.join(base, "binding.json")
  const associate = (root, extra) => {
    binding(config, root, extra)
    assert.equal(recordCopilotSession({
      sessionId: env.COPILOT_AGENT_SESSION_ID, folder: cwd, activationConfig: config, env,
    }), true)
  }
  const card = (root) => path.join(root, ...(person ? ["desks", person] : []), "work", "one", "task.md")
  const status = async () => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const started = Date.now()
      const cpu = process.cpuUsage()
      let eventLoopTurnMs = null
      const turn = setTimeout(() => { eventLoopTurnMs = Date.now() - started }, 0)
      const value = payload(await call("desk_status", { detail: true }))
      const elapsedMs = Date.now() - started
      clearTimeout(turn)
      statusTrace.push({ elapsedMs, eventLoopTurnMs, cpu: process.cpuUsage(cpu),
        state: value.state, root: value.root?.path, detailFrom: value.status_detail_from,
        phase: handle.session.context.phase })
      assert.ok(elapsedMs < 200, JSON.stringify({
        message: "every status request retains its 200 ms budget", elapsedMs,
        admission: handle.admission.snapshot(), phase: handle.session.context.phase,
        resolution: resolutionTrace, dispatch: dispatchTrace, statusTrace, convergenceTrace,
      }))
      if (value.root?.path) return value
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.fail("runtime status detail did not arrive")
  }
  return { a, b, base, cwd, env, handle, call, associate, config, card, connectedRoots, status, focuses,
    resolutionTrace, dispatchTrace, holdNextResolution: () => { hold = true },
    waitHeld: async () => {
      const deadline = Date.now() + 15000
      while (!held && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
      assert.ok(held, "the real resolver reply must be retained at the concurrency seam")
    },
    releaseResolution: () => { held() } }
}

test("actual protocol reconciles ready fallback A to late saved B before mutation and clears task focus", async (t) => {
  const f = await fixture(t)
  assert.equal(payload(await f.call("task_focus", { track: "work", slug: "one" })).status, "focused")
  const aHead = git(f.a, "rev-parse", "HEAD")
  f.associate(f.b)
  const result = await f.call("task_update", update)
  assert.notEqual(result.isError, true, JSON.stringify(result))
  assert.equal(readFileSync(f.card(f.a), "utf8"), text)
  assert.equal(git(f.a, "rev-parse", "HEAD"), aHead)
  assert.match(readFileSync(f.card(f.b), "utf8"), /status: processing/u)
  assert.equal(git(f.b, "show", "--format=", "--name-only", "HEAD"), "work/one/task.md")
  assert.deepEqual(f.connectedRoots, [f.a, f.b])
  const record = JSON.parse(readFileSync(path.join(f.base, "session-state", "last-start", `${lastStartRootKey(f.b)}.json`), "utf8"))
  assert.equal(record.state, "ready")
  const status = await f.status()
  assert.equal(status.root.path, f.b)
  assert.equal(f.focuses.at(-1).get(), null)
  assert.equal(status.admission.state_branch.branch, "main")
  assert.equal(status.write_scope.mode, "workspace")
})

test("an explicit A remains A when the same host record later associates B", async (t) => {
  const f = await fixture(t, { explicit: true })
  f.associate(f.b)
  assert.notEqual((await f.call("task_update", update)).isError, true)
  assert.match(readFileSync(f.card(f.a), "utf8"), /status: processing/u)
  assert.equal(readFileSync(f.card(f.b), "utf8"), text)
  assert.ok(f.connectedRoots.length > 0)
  assert.ok(f.connectedRoots.every((root) => root === f.a))
})

test("invalid late associations and missing binding files refuse without changing either desk", async (t) => {
  const f = await fixture(t)
  const heads = [f.a, f.b].map((root) => git(root, "rev-parse", "HEAD"))
  f.associate(path.join(f.base, "absent"))
  const refused = await f.call("task_update", update)
  assert.equal(refused.isError, true)
  assert.equal(payload(refused).code, "root_unavailable")
  assert.doesNotMatch(payload(refused).fix, /override/u)
  f.associate(f.b)
  renameSync(f.config, `${f.config}.missing`)
  const missing = await f.call("task_update", update)
  assert.equal(missing.isError, true)
  assert.equal(payload(missing).code, "activation_config_invalid")
  assert.deepEqual([f.a, f.b].map((root) => git(root, "rev-parse", "HEAD")), heads)
  assert.equal(readFileSync(f.card(f.a), "utf8"), text)
  assert.equal(readFileSync(f.card(f.b), "utf8"), text)
})

test("removed context does not redirect a bound session back to a fallback", async (t) => {
  const f = await fixture(t)
  f.associate(f.b)
  assert.notEqual((await f.call("task_update", update)).isError, true)
  const record = copilotSessionFile(path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk"), f.env.COPILOT_AGENT_SESSION_ID)
  renameSync(record, `${record}.removed`)
  for (let i = 0; i < 2; i += 1) {
    const result = await f.call("task_update", { ...update, status: "done" })
    assert.equal(result.isError, true)
    assert.equal(payload(result).code, "root_unavailable")
  }
  assert.equal(readFileSync(f.card(f.a), "utf8"), text)
  assert.match(readFileSync(f.card(f.b), "utf8"), /status: processing/u)
})

test("a mutation cannot join destination proof sampled before its request", async (t) => {
  const f = await fixture(t, { capturedFolder: true })
  f.associate(f.b)
  assert.notEqual((await f.call("task_update", update)).isError, true)
  f.holdNextResolution()
  await f.call("desk_status", { detail: true })
  await f.waitHeld()
  assert.equal(f.resolutionTrace.at(-1).root, f.b)
  assert.equal(f.resolutionTrace.at(-1).source, "activation-config")
  const record = copilotSessionFile(path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk"), f.env.COPILOT_AGENT_SESSION_ID)
  renameSync(record, `${record}.removed`)
  const heads = [f.a, f.b].map((root) => git(root, "rev-parse", "HEAD"))
  const mutations = f.dispatchTrace.filter((call) => call.name === "task_update").length
  const pending = f.call("task_update", update)
  // The request has reached admission before the retained stale reply arrives.
  await new Promise((resolve) => setImmediate(resolve))
  f.releaseResolution()
  const result = await pending
  assert.equal(result.isError, true, JSON.stringify({ result, resolution: f.resolutionTrace, dispatch: f.dispatchTrace }))
  assert.equal(payload(result).code, "root_unavailable")
  assert.equal(f.dispatchTrace.filter((call) => call.name === "task_update").length, mutations)
  assert.deepEqual([f.a, f.b].map((root) => git(root, "rev-parse", "HEAD")), heads)
})

for (const failure of ["removed", "untrusted", "unreadable"]) {
  test(`${failure} saved association cannot reselect the captured launch desk`, async (t) => {
    const f = await fixture(t, { capturedFolder: true })
    assert.equal(f.handle.session.context.root.root, f.a)
    assert.equal(f.handle.session.context.root.source, "host-project")
    f.associate(f.b)
    assert.notEqual((await f.call("task_update", update)).isError, true)
    assert.equal(f.handle.session.context.root.root, f.b)
    assert.equal(f.handle.session.context.root.source, "activation-config")
    await f.status()
    const heads = [f.a, f.b].map((root) => git(root, "rev-parse", "HEAD"))
    const cards = [f.a, f.b].map((root) => readFileSync(f.card(root), "utf8"))
    const record = copilotSessionFile(path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk"), f.env.COPILOT_AGENT_SESSION_ID)
    if (failure === "removed") renameSync(record, `${record}.removed`)
    else if (failure === "untrusted") writeFileSync(record, "{unreadable JSON")
    else {
      renameSync(record, `${record}.saved`)
      mkdirSync(record)
      assert.throws(() => readFileSync(record, "utf8"), "the actual record read must fail")
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await f.call("task_update", update)
      assert.equal(result.isError, true, JSON.stringify({
        message: "lost B association must not dispatch", result,
        resolution: f.resolutionTrace, dispatch: f.dispatchTrace,
        root: f.handle.session.context.root, phase: f.handle.session.context.phase,
      }))
      assert.equal(payload(result).code, "root_unavailable")
      assert.doesNotMatch(payload(result).fix, /override|bootstrap|rebind/u)
    }
    assert.deepEqual([f.a, f.b].map((root) => git(root, "rev-parse", "HEAD")), heads)
    assert.deepEqual([f.a, f.b].map((root) => readFileSync(f.card(root), "utf8")), cards)
    assert.deepEqual(f.connectedRoots, [f.a, f.b], "no A authority/controller is acquired after losing B")
    const status = payload(await f.call("desk_status", { detail: true }))
    assert.equal(status.code, "root_unavailable")
    assert.equal(status.write_scope, undefined, "no cached B ownership survives failed resolution")
    if (failure === "unreadable") renameSync(record, `${record}.unreadable-directory`)
    f.associate(f.b)
    assert.notEqual((await f.call("task_update", update)).isError, true)
    assert.equal(f.handle.session.context.root.root, f.b)
    assert.deepEqual(f.connectedRoots, [f.a, f.b, f.b])
  })
}

test("a host/session root retains precedence over a late saved association", async (t) => {
  const f = await fixture(t, { capturedFolder: true, sessionRoot: true })
  f.associate(f.b)
  assert.notEqual((await f.call("task_update", update)).isError, true)
  assert.equal(f.handle.session.context.root.root, f.a)
  assert.equal(f.handle.session.context.root.source, "host-session-root")
  assert.equal(readFileSync(f.card(f.b), "utf8"), text)
})

test("late recorded folder evidence can upgrade an initial home-folder guess", async (t) => {
  const f = await fixture(t)
  assert.equal(f.handle.session.context.root.source, "home_fallback")
  assert.equal(recordCopilotSession({
    sessionId: f.env.COPILOT_AGENT_SESSION_ID, folder: f.b, env: f.env,
  }), true)
  assert.notEqual((await f.call("task_update", update)).isError, true)
  assert.equal(f.handle.session.context.root.root, f.b)
  assert.equal(f.handle.session.context.root.source, "host-project")
  assert.equal(readFileSync(f.card(f.a), "utf8"), text)
  assert.match(readFileSync(f.card(f.b), "utf8"), /status: processing/u)
  assert.deepEqual(f.connectedRoots, [f.a, f.b])
})

test("late person policy cannot reuse fallback workspace authority", async (t) => {
  const f = await fixture(t)
  f.associate(f.b, { write_authority: "person" })
  const result = await f.call("task_update", update)
  assert.equal(result.isError, true)
  assert.equal(payload(result).code, "authority_invalid")
  assert.equal(readFileSync(f.card(f.a), "utf8"), text)
  assert.equal(readFileSync(f.card(f.b), "utf8"), text)
})

test("a recorded desk folder cannot mask an invalid saved association", async (t) => {
  const f = await fixture(t)
  f.associate(path.join(f.base, "missing"))
  assert.equal(recordCopilotSession({
    sessionId: f.env.COPILOT_AGENT_SESSION_ID, folder: f.b, activationConfig: f.config, env: f.env,
  }), true)
  const result = await f.call("task_update", update)
  assert.equal(result.isError, true)
  assert.equal(payload(result).code, "root_unavailable")
  assert.equal(readFileSync(f.card(f.a), "utf8"), text)
  assert.equal(readFileSync(f.card(f.b), "utf8"), text)
})
