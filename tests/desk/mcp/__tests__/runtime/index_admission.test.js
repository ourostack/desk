// index.js wiring for handshake-first admission: the state-branch option, the pre-handshake Node handoff, and the session it starts behind the front door.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { writeFileSync } from "node:fs"
import { PassThrough } from "node:stream"
import * as path from "node:path"
import { main, parseArgs, resolveStartupStateBranch } from "../../index.js"
import { mkTempRoot } from "../_temp_roots.js"

test("--state-branch is parsed, and the activation config's desk.state_branch is the fallback", async () => {
  assert.equal(parseArgs(["--state-branch", "main"]).stateBranch, "main")
  assert.equal(parseArgs(["--state-branch"]).stateBranch, undefined)
  const root = await mkTempRoot("desk-state-branch-config-")
  const withBranch = path.join(root, "with.json")
  const without = path.join(root, "without.json")
  writeFileSync(withBranch, JSON.stringify({ schema_version: 1, desk: { root, state_branch: "trunk" } }))
  writeFileSync(without, JSON.stringify({ schema_version: 1, desk: { root } }))
  assert.equal(resolveStartupStateBranch({ args: { stateBranch: "main", activationConfig: withBranch }, env: {} }), "main")
  assert.equal(resolveStartupStateBranch({ args: { activationConfig: withBranch }, env: {} }), "trunk")
  assert.equal(resolveStartupStateBranch({ args: { activationConfig: without }, env: {} }), null)
  assert.equal(resolveStartupStateBranch({ args: {}, env: {} }), null)
  const previous = process.env.DESK_ACTIVATION_CONFIG
  process.env.DESK_ACTIVATION_CONFIG = withBranch
  try {
    assert.equal(resolveStartupStateBranch(), "trunk", "the defaults read the live environment")
  } finally {
    if (previous === undefined) delete process.env.DESK_ACTIVATION_CONFIG
    else process.env.DESK_ACTIVATION_CONFIG = previous
  }
})

test("an unsupported Node target is handed off before the handshake even when the activation config is broken", async () => {
  const root = await mkTempRoot("desk-preflight-broken-config-")
  const configPath = path.join(root, "broken.json")
  writeFileSync(configPath, "{not json")
  let diagnostic
  await main({
    argv: ["--activation-config", configPath],
    env: {},
    cwd: root,
    homeDir: root,
    runtimeImporter: async () => assert.fail("no runtime import before a compatible Node"),
    runtimeInspector: () => ({ ok: false, reason: "unsupported_target", runtime: { current_target: { id: "x" }, shipped_targets: [] } }),
    nodeCandidateDiscoverer: () => [],
    nodeSelector: () => ({ mode: "diagnostic", reason: "no_compatible_node", paths_checked: [] }),
    diagnosticServerStarter: (options) => { diagnostic = options.diagnostic },
  })
  assert.equal(diagnostic.reason, "no_compatible_node")
  assert.equal(diagnostic.runtime.runtime_cache_path, null)
})

test("main answers the handshake, starts admission on its own without a client, and exits cleanly when input closes", async () => {
  const root = await mkTempRoot("desk-main-kickoff-")
  const input = new PassThrough()
  const output = new PassThrough()
  let closed = false
  const handle = await main({
    argv: ["--root", root],
    env: {},
    cwd: root,
    homeDir: root,
    stateHome: path.join(root, "state"),
    input,
    output,
    stderr: { write() { return true } },
    admissionKickoffMs: 5,
    runtimeInspector: null,
    runtimeImporter: async () => ({ connectOrStartController: async () => ({ accepted: true }) }),
    onClosed: () => { closed = true },
  })
  // The first tools/list starts admission; the kickoff timer that follows finds it already started.
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const deadline = Date.now() + 5000
  while (handle.admission.snapshot().state === "admitting" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(handle.admission.snapshot().state, "ready")
  input.end()
  await handle.closed
  assert.equal(closed, true)
})

test("the default stateHome follows HOME and XDG_STATE_HOME", async () => {
  const root = await mkTempRoot("desk-main-default-state-")
  const input = new PassThrough()
  const handle = await main({
    argv: ["--root", path.join(root, "missing")],
    env: { HOME: root, XDG_STATE_HOME: path.join(root, "xdg-state") },
    cwd: root,
    input,
    output: new PassThrough(),
    stderr: { write() { return true } },
    admissionKickoffMs: 0,
    runtimeInspector: null,
    runtimeImporter: async () => assert.fail("not reached"),
  })
  const deadline = Date.now() + 5000
  while (handle.admission.snapshot().state === "admitting" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(handle.admission.snapshot().state, "degraded:root_unavailable")
  input.end()
  await handle.closed
  const { existsSync } = await import("node:fs")
  assert.equal(existsSync(path.join(root, "xdg-state", "ouroboros-skills", "desk", "last-start.json")), true)
})

test("with the real runtime inspector and importer, main restores the runtime after the handshake and serves reads", {
  skip: process.versions.modules === "127" ? false : "this platform's committed runtime pack is for Node ABI 127",
}, async () => {
  const root = await mkTempRoot("desk-main-real-runtime-")
  const desk = path.join(root, "desk")
  const { mkdirSync } = await import("node:fs")
  mkdirSync(desk)
  writeFileSync(path.join(desk, "task.md"), "# Harbor\n\nThe lighthouse keeper logs ferries.\n")
  const { startInProcess } = await import("./_in_process_desk.js")
  const session = await startInProcess({
    argv: ["--root", desk],
    env: { DESK_RUNTIME_CACHE_DIR: path.join(root, "runtime-cache"), HOME: root },
    cwd: root,
    homeDir: root,
    readinessPolicy: { semantic: "unsupported" },
  })
  try {
    // Wait for background convergence too, so nothing is still writing the index when the fixture is removed.
    const ready = await session.statusUntil((payload) => payload.state === "ready" && payload.readiness?.state === "LEXICAL_READY", { deadlineMs: 60000 })
    assert.equal(ready.status, "ok")
    const search = await session.call("desk_search", { query: "lighthouse" })
    assert.equal(search.isError, false)
    assert.match(JSON.stringify(search.payload), /task\.md/u)
  } finally {
    await session.close()
  }
})

test("the entrypoint gives main an onClosed that exits when the host closes stdin", async () => {
  const { runIfEntrypoint } = await import("../../index.js")
  const { pathToFileURL } = await import("node:url")
  const indexPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "index.js")
  const exits = []
  let options
  await runIfEntrypoint({
    argv: ["node", indexPath],
    moduleUrl: pathToFileURL(indexPath).href,
    exit: (code) => exits.push(code),
    launch: async (given) => { options = given },
  })
  options.onClosed()
  assert.deepEqual(exits, [0])
})

test("--degraded: integrity codes refuse, read-only codes keep reads, and a crew-state code with --state-branch hands over to Desk", async () => {
  const { launcherMode, parseArgs } = await import("../../index.js")
  assert.equal(launcherMode({}), null)
  assert.deepEqual(parseArgs(["--degraded", "snapshot_missing", "--degraded-reason", "no snapshot"]), { root: null, person: null, degraded: "snapshot_missing", degradedReason: "no snapshot" })
  assert.deepEqual(launcherMode(parseArgs(["--degraded", "snapshot_missing", "--degraded-reason", "no snapshot"])), { code: "snapshot_missing", reason: "no snapshot", mode: "refuse", blocksWrites: true })
  assert.deepEqual(launcherMode({ degraded: "Bad Code!" }), { code: "launcher_refused", reason: "the launcher reported launcher_refused", mode: "refuse", blocksWrites: true })
  assert.deepEqual(launcherMode({ degraded: "identity_not_emu" }), { code: "identity_not_emu", reason: "the launcher reported identity_not_emu", mode: "read_only", blocksWrites: true })
  assert.deepEqual(launcherMode({ degraded: "crew_state_not_main", stateBranch: "main" }), { code: "crew_state_not_main", reason: "the launcher reported crew_state_not_main", mode: "read_only", blocksWrites: false })
  assert.equal(launcherMode({ degraded: "repository_mismatch", stateBranch: "main" }).blocksWrites, true, "only crew-state codes are handed to the state-branch check")
})

test("--degraded takes precedence over --onboarding", async () => {
  const { startInProcess } = await import("./_in_process_desk.js")
  const desk = await startInProcess({ argv: ["--onboarding", "crew:join-crew", "--degraded", "registry_malformed"], runtimeImporter: async () => assert.fail("no runtime in refuse mode") })
  try {
    assert.equal((await desk.statusUntil((payload) => payload.state !== "admitting")).state, "degraded:registry_malformed")
  } finally {
    await desk.close()
  }
})

test("DESK_READINESS_PROBE_MS tunes the hung-controller probe", async () => {
  const { hungTuning } = await import("../../index.js")
  assert.deepEqual(hungTuning({ DESK_READINESS_PROBE_MS: "300" }), { probeMs: 300 })
  assert.deepEqual(hungTuning({ DESK_READINESS_PROBE_MS: "0" }), {})
  assert.deepEqual(hungTuning({ DESK_READINESS_PROBE_MS: "soon" }), {})
  assert.deepEqual(hungTuning({}), {})
})

test("crash handlers hand uncaught errors and rejections to the session, and are removed on close", async () => {
  const { installCrashHandlers } = await import("../../index.js")
  const { EventEmitter } = await import("node:events")
  const target = new EventEmitter()
  const recorded = []
  const writes = []
  const remove = installCrashHandlers({ session: { recordException: (kind, error) => recorded.push([kind, error]) }, stderr: { write: (text) => writes.push(text) }, target })
  target.emit("uncaughtException", new Error("boom"))
  target.emit("unhandledRejection", "rejected")
  assert.deepEqual(recorded.map(([kind]) => kind), ["uncaught_exception", "unhandled_rejection"])
  assert.match(writes.join(""), /crash handlers installed/u)
  remove()
  assert.equal(target.listenerCount("uncaughtException"), 0)
  assert.equal(target.listenerCount("unhandledRejection"), 0)
  const input = new PassThrough()
  const root = await mkTempRoot("desk-main-crash-handlers-")
  const handle = await main({
    argv: ["--root", root], env: {}, cwd: root, homeDir: root, stateHome: path.join(root, "state"),
    input, output: new PassThrough(), stderr: { write() { return true } }, admissionKickoffMs: 0,
    runtimeInspector: null, runtimeImporter: async () => ({ connectOrStartController: async () => ({ accepted: true }) }),
    crashHandlers: true,
  })
  const before = process.listenerCount("uncaughtException")
  input.end()
  await handle.closed
  assert.equal(process.listenerCount("uncaughtException"), before - 1, "closing removes the handler main installed")
})

test("the shipped importer runs inspection and restore through the admission job, and each failure names its state", async () => {
  const { importPreparedRuntime } = await import("../../index.js")
  const { importRuntimeServer, inspectRuntimeDependencyPack } = await import("../../src/runtime/bootstrap.js")
  const { admitInProcess } = await import("./_in_process_desk.js")
  const root = await mkTempRoot("desk-main-worker-runtime-")
  const jobs = []
  const admitWith = (reply, extra = {}) => admitInProcess({
    argv: ["--root", root], env: {}, cwd: root, homeDir: root,
    runtimeImporter: importRuntimeServer,
    runtimeInspector: inspectRuntimeDependencyPack,
    offload: async (job) => {
      jobs.push(job.kind)
      if (job.kind === "resolve") return (await import("../../src/runtime/admission-worker.js")).runAdmissionJob(job)
      assert.equal(job.input.inspect, extra.inspect ?? true)
      return reply
    },
    ...extra,
  })
  assert.equal((await admitWith({ inspectionError: { message: "x" } })).snapshot.diagnostic.reason, "runtime_inspection_failed")
  assert.equal((await admitWith({ inspection: { ok: false, reason: "missing_pack", runtime: {} } })).snapshot.diagnostic.reason, "missing_pack")
  const locked = await admitWith({ inspection: null, restoreError: { message: "lock", lock: { dir: "/c.publish-lock", pid: 77 } } }, { runtimeInspector: null, inspect: false })
  assert.equal(locked.snapshot.state, "degraded:runtime_restore_locked")
  assert.match(locked.snapshot.fix, /pid 77/u)
  const unknownHolder = await admitWith({ inspection: null, restoreError: { message: "lock", lock: { dir: "/c.publish-lock", pid: null } } }, { runtimeInspector: null, inspect: false })
  assert.match(unknownHolder.snapshot.summary, /owner record is unreadable/u)
  const restoreFailed = await admitWith({ inspection: { ok: true, runtime: {} }, restoreError: { message: "disk full" } })
  assert.equal(restoreFailed.snapshot.diagnostic.reason, "runtime_restore_failed")
  assert.equal(restoreFailed.snapshot.diagnostic.restore_error, "disk full")
  const importFailed = await admitWith({ inspection: null, prepared: { sourceMirrorPath: path.join(root, "no-mirror") } }, { runtimeInspector: null, inspect: false })
  assert.equal(importFailed.snapshot.diagnostic.reason, "runtime_restore_failed")
  assert.ok(jobs.includes("runtime"))

  const loaded = await importPreparedRuntime({
    mcpRoot: "/plugin/mcp",
    prepared: { sourceMirrorPath: "/mirror", runtimeCacheDir: "/cache", target: "t", packDir: "/pack" },
    load: async (url) => {
      assert.match(url, /\/mirror\/src\/server\.js$/u)
      return { configureRuntimeArtifacts: ({ pluginRoot }) => assert.equal(pluginRoot, "/plugin"), marker: 1 }
    },
  })
  assert.equal(loaded.marker, 1)
  assert.deepEqual(loaded._deskRuntime, { plugin_root: "/plugin", runtime_cache_dir: "/cache", source_mirror_path: "/mirror", target: "t", pack_dir: "/pack", loaded_from_source_mirror: true })
  assert.equal((await importPreparedRuntime({ mcpRoot: "/p/mcp", prepared: { sourceMirrorPath: "/m" }, load: async () => ({}) }))._deskRuntime.loaded_from_source_mirror, true)
})
