// A long-running Desk server picks up a newer release without a restart: the watcher, the swap between calls in the session, the boot script and the browser server.
import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { main } from "../../../../../plugins/desk/mcp/index.js"
import { resolveAdmissionInputs } from "../../../../../plugins/desk/mcp/src/runtime/admission-worker.js"
import { createRuntimeRefresher, refreshIntervalMs, REFRESH_INTERVAL_MS } from "../../../../../plugins/desk/mcp/src/runtime/runtime-swap.js"
import { defaultTaskBoot, withStartupBoot } from "../../../../../plugins/desk/mcp/src/runtime/startup-boot.js"
import { mkTempRoot } from "../_temp_roots.js"
import { osEnv } from "../_os_env.js"

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const web = require(path.join(repoRoot, "plugins", "desk", "mcp", "web.cjs"))
const runningVersion = JSON.parse(readFileSync(path.join(repoRoot, "plugins", "desk", "plugin.json"), "utf8")).version
const NEWER = "99.0.1"

const payload = (result) => JSON.parse(result.content[0].text)
// What a client sees: an unset field is absent.
const plain = (value) => JSON.parse(JSON.stringify(value))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read) {
  for (let tries = 0; tries < 600; tries += 1) {
    const value = await read()
    if (value) return value
    await pause(10)
  }
  throw new Error("condition not reached")
}

test("the watcher checks in the background, at most once an interval, and reports what it found", async () => {
  let clock = 1_000_000
  const calls = []
  let answer = { state: "current", latest: "1.0.0" }
  const refresher = createRuntimeRefresher({ env: {}, now: () => clock, intervalMs: 1000, prepare: async (input) => { calls.push(input); return answer } })
  assert.equal(refresher.poke({ running: "1.0.0" }), true)
  assert.equal(refresher.poke({ running: "1.0.0" }), false, "one check at a time")
  await refresher.idle()
  assert.deepEqual(plain(refresher.describe()), { refresh: { state: "current", latest: "1.0.0", checked_at: new Date(clock).toISOString() } })
  clock += 999
  assert.equal(refresher.poke({ running: "1.0.0" }), false, "not again within the interval")
  clock += 1
  answer = { state: "failed", latest: "1.0.1", reason: "the download failed (HTTP 503)" }
  assert.equal(refresher.poke({ running: "1.0.0" }), true)
  await refresher.idle()
  assert.deepEqual(plain(refresher.describe().refresh), { state: "failed", latest: "1.0.1", reason: "the download failed (HTTP 503)", checked_at: new Date(clock).toISOString() })
  assert.deepEqual(calls, [{ running: "1.0.0" }, { running: "1.0.0" }])
  assert.equal(refresher.take(), null)
  assert.equal(refresher.ready, false)
})

test("a prepared runtime is taken once, a swap is recorded with swapped_at and from, and a throwing check is a failed one", async () => {
  const clock = 5_000
  const loaded = { runtimeServer: {}, runtimeStatus: {} }
  let next = async () => ({ state: "ready", latest: "2.0.0", loaded })
  const refresher = createRuntimeRefresher({ env: {}, now: () => clock, intervalMs: 0, prepare: () => next() })
  refresher.poke({ running: "1.0.0" })
  await refresher.idle()
  assert.equal(refresher.ready, true)
  assert.equal(refresher.poke({ running: "1.0.0" }), false, "nothing is checked while a runtime waits to be swapped in")
  assert.deepEqual(refresher.take(), { loaded, latest: "2.0.0" })
  assert.equal(refresher.take(), null)
  refresher.swapped({ from: "1.0.0", to: "2.0.0" })
  assert.deepEqual(plain(refresher.describe()), { refresh: { state: "swapped", latest: "2.0.0", checked_at: new Date(clock).toISOString() }, swapped_at: new Date(clock).toISOString(), from: "1.0.0" })
  next = async () => { throw new Error("boom\nsecond line") }
  refresher.poke({ running: "2.0.0" })
  await refresher.idle()
  assert.equal(refresher.describe().refresh.reason, "the check threw (boom)")
  next = async () => { throw "plain text" }
  refresher.poke()
  await refresher.idle()
  assert.equal(refresher.describe().refresh.reason, "the check threw (plain text)")
  assert.equal(refresher.describe().swapped_at, new Date(clock).toISOString(), "the last swap is still reported")
  refresher.abandoned("the swap failed (x)", "2.0.1")
  assert.deepEqual({ ...plain(refresher.describe().refresh), checked_at: undefined }, { state: "failed", latest: "2.0.1", reason: "the swap failed (x)", checked_at: undefined })
})

test("the watcher defaults to the process environment, the clock and a silent log", async () => {
  const refresher = createRuntimeRefresher({ prepare: async () => ({ state: "failed", latest: "1.0.1", reason: "offline" }) })
  assert.equal(refresher.poke({ running: "1.0.0", soon: true }), true)
  await refresher.idle()
  assert.equal(refresher.describe().refresh.state, "failed")
  assert.match(refresher.describe().refresh.checked_at, /^\d{4}-/u)
})

test("DESK_RUNTIME_REFRESH=0 turns refreshing off, and the interval can be set in minutes", async () => {
  const refresher = createRuntimeRefresher({ env: { DESK_RUNTIME_REFRESH: "0" }, prepare: () => assert.fail("not asked") })
  assert.equal(refresher.poke({ running: "1.0.0" }), false)
  assert.deepEqual(plain(refresher.describe()), { refresh: { state: "not_applicable", reason: "DESK_RUNTIME_REFRESH=0" } })
  assert.equal(refreshIntervalMs({ DESK_RUNTIME_REFRESH_MINUTES: "2" }), 120000)
  assert.equal(refreshIntervalMs({ DESK_RUNTIME_REFRESH_MINUTES: "nonsense" }), REFRESH_INTERVAL_MS)
})

// main with the shipped wiring and a stand-in importer: the older copy serves first, and the release channel moves on afterwards.
async function serveWith({ release, importer, pin }) {
  const root = await mkTempRoot("runtime-swap-")
  const input = new PassThrough()
  const lines = []
  const handle = await main({
    argv: ["--root", root], env: osEnv({ HOME: root, DESK_RUNTIME_REFRESH_MINUTES: "0.0001" }), cwd: root, homeDir: root, stateHome: path.join(root, "state"),
    input, output: new PassThrough(), stderr: { write: (text) => { lines.push(text); return true } },
    admissionKickoffMs: 0, runtimeInspector: null, readinessPolicy: { semantic: "unsupported" },
    offload: async (job) => {
      const value = resolveAdmissionInputs(job.input)
      return pin === undefined || value.activation === undefined ? value : { ...value, activation: { ...value.activation, ...pin } }
    },
    newestRelease: release, runtimeImporter: importer,
  })
  await until(() => handle.admission.snapshot().state === "ready")
  return { handle, root, lines, finish: async () => { input.end(); await handle.closed } }
}

// A runtime that answers every call with its own name, so a test sees which one served; `copy` is the plugin folder it claims to load from.
function runtimeNamed(name, { copy, closed = [], gate } = {}) {
  return {
    _deskRuntime: copy === undefined ? undefined : { plugin_root: copy, source_mirror_path: path.join(copy, "mirror", `${name}-hash`), loaded_from_source_mirror: true },
    callTool: async ({ name: tool }) => {
      if (tool === "desk_search" && gate !== undefined) await gate
      return { content: [{ type: "text", text: JSON.stringify({ status: "ok", served_by: name }) }] }
    },
    createSearchEngine: () => ({ warm() {}, noteChange() {}, searchStatus: () => ({ state: "idle" }), async close() { closed.push(name) } }),
  }
}

async function copyOf(root, version) {
  const copy = path.join(root, "copies", version)
  mkdirSync(path.join(copy, "mcp"), { recursive: true })
  writeFileSync(path.join(copy, "plugin.json"), JSON.stringify({ name: "desk", version }))
  return path.join(copy, "mcp")
}

const status = async (session) => payload(await session.callTool({ name: "desk_status", input: { detail: true } })).runtime

test("a newer release is swapped in on the next call, and desk_status reports what is serving, when it swapped and what it swapped from", async () => {
  const closed = []
  let latest = runningVersion
  let mcpRoot
  const imports = []
  const { handle, root, finish } = await serveWith({
    release: async ({ running }) => (latest === running ? { state: "current", running, latest } : { state: "loaded", running, latest, mcpRoot }),
    importer: async ({ mcpRoot: from }) => {
      imports.push(from)
      return from === mcpRoot ? runtimeNamed("newer", { copy: path.resolve(mcpRoot, ".."), closed }) : runtimeNamed("older", { closed })
    },
  })
  const before = await status(handle.session)
  assert.equal(before.plugin.version, runningVersion)
  assert.equal(before.swapped_at, undefined)
  assert.equal(payload(await handle.session.callTool({ name: "desk_search", input: { query: "x" } })).served_by, "older")

  mcpRoot = await copyOf(root, NEWER)
  latest = NEWER
  const swapped = await until(async () => {
    const runtime = await status(handle.session)
    return runtime.swapped_at === undefined ? null : runtime
  })
  assert.equal(swapped.plugin.version, NEWER, "runtime names what is serving, not what launched")
  assert.equal(swapped.from, runningVersion)
  assert.match(swapped.swapped_at, /^\d{4}-\d\d-\d\dT/u)
  assert.equal(swapped.plugin_root, path.resolve(mcpRoot, ".."))
  assert.equal(swapped.source_mirror_hash, "newer-hash")
  assert.equal(swapped.newest_release.newest, NEWER)
  assert.equal(payload(await handle.session.callTool({ name: "desk_search", input: { query: "x" } })).served_by, "newer")
  assert.equal(handle.session.servingPluginRoot(), path.resolve(mcpRoot, ".."))
  assert.deepEqual(closed, ["older"], "the older runtime's search engine closed; the newer one built its own")
  const compact = payload(await handle.session.callTool({ name: "desk_status", input: {} }))
  assert.equal(compact.plugin_version, NEWER)
  assert.equal(compact.runtime.from, runningVersion)
  assert.equal(compact.runtime.swapped_at, swapped.swapped_at)
  await finish()
})

test("a call that is already running finishes on the older runtime, and the call after it runs on the newer one", async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let latest = runningVersion
  let mcpRoot
  const { handle, root, finish } = await serveWith({
    release: async ({ running }) => (latest === running ? { state: "current", running, latest } : { state: "loaded", running, latest, mcpRoot }),
    importer: async ({ mcpRoot: from }) => from === mcpRoot ? runtimeNamed("newer", { copy: path.resolve(mcpRoot, "..") }) : runtimeNamed("older", { gate }),
  })
  // Nothing else keeps the process alive while the call waits on its gate.
  const keepAlive = setInterval(() => {}, 1000)
  await handle.session.callTool({ name: "desk_status", input: {} })
  const inFlight = handle.session.callTool({ name: "desk_search", input: { query: "slow" } })
  await pause(20)
  mcpRoot = await copyOf(root, NEWER)
  latest = NEWER
  // A status call never waits for the running call, so it leaves the swap for the next call that can take its turn.
  await until(async () => (await status(handle.session)).refresh?.state === "ready_to_swap")
  assert.equal((await status(handle.session)).swapped_at, undefined)
  const after = handle.session.callTool({ name: "desk_recall", input: { query: "next" } })
  await pause(20)
  release()
  assert.equal(payload(await inFlight).served_by, "older")
  assert.equal(payload(await after).served_by, "newer")
  clearInterval(keepAlive)
  await finish()
})

test("a fetch or load that fails keeps the serving runtime and says so in runtime", async () => {
  let release = { state: "fell_back", latest: NEWER, reason: "the download failed (HTTP 503)" }
  const imports = []
  let mcpRoot
  const { handle, root, finish } = await serveWith({
    release: async ({ running }) => ({ running, ...release }),
    importer: async ({ mcpRoot: from }) => {
      imports.push(from)
      if (from === mcpRoot) throw new Error("the copy is broken")
      return runtimeNamed("older")
    },
  })
  const fetchFailed = await until(async () => {
    const runtime = await status(handle.session)
    return runtime.refresh?.state === "failed" ? runtime : null
  })
  assert.equal(fetchFailed.refresh.latest, NEWER)
  assert.equal(fetchFailed.refresh.reason, "the download failed (HTTP 503)")
  assert.equal(fetchFailed.plugin.version, runningVersion)
  assert.equal(fetchFailed.swapped_at, undefined)
  const compactFailed = payload(await handle.session.callTool({ name: "desk_status", input: {} })).runtime
  assert.equal(compactFailed.plugin.version, runningVersion)
  assert.equal(compactFailed.swapped_at, undefined)
  assert.equal(compactFailed.refresh.latest, NEWER)
  assert.equal(payload(await handle.session.callTool({ name: "desk_search", input: { query: "x" } })).served_by, "older")

  mcpRoot = await copyOf(root, NEWER)
  release = { state: "loaded", latest: NEWER, mcpRoot }
  const loadFailed = await until(async () => {
    const runtime = await status(handle.session)
    return /did not load/u.test(runtime.refresh?.reason ?? "") ? runtime : null
  })
  assert.match(loadFailed.refresh.reason, new RegExp(`^the ${NEWER} copy did not load`, "u"))
  assert.equal(loadFailed.plugin.version, runningVersion)
  assert.equal(payload(await handle.session.callTool({ name: "desk_search", input: { query: "x" } })).served_by, "older")
  assert.equal(handle.admission.snapshot().state, "ready")
  await finish()
})

test("a pinned runtime, or a switch turned off, is never refreshed", async () => {
  const pinned = await serveWith({ pin: { runtimeCacheDir: "/pinned" }, release: async () => assert.fail("not asked"), importer: async () => runtimeNamed("older") })
  const runtime = await until(async () => {
    const found = await status(pinned.handle.session)
    return found.refresh?.state === "not_applicable" ? found : null
  })
  assert.equal(runtime.refresh.reason, "this session pins its runtime source")
  await pinned.finish()
})

test("a runtime that cannot say what it is is not swapped in, and no check starts before a runtime is serving", async () => {
  const pokes = []
  const reasons = []
  const refresher = {
    ready: false,
    poke: (input) => { pokes.push(input) },
    take: () => ({ latest: "9.9.9", loaded: { runtimeServer: {}, runtimeStatus: { get plugin_root() { throw new Error("unreadable") } } } }),
    abandoned: (reason, latest) => { reasons.push([reason, latest]) },
    describe: () => ({ refresh: { state: "checking" } }),
    swapped: () => assert.fail("not swapped"),
  }
  const root = await mkTempRoot("runtime-swap-unsure-")
  const input = new PassThrough()
  let open
  const loading = new Promise((resolve) => { open = resolve })
  const keepAlive = setInterval(() => {}, 1000)
  const handle = await main({
    argv: ["--root", root], env: osEnv({ HOME: root }), cwd: root, homeDir: root, stateHome: path.join(root, "state"),
    input, output: new PassThrough(), stderr: { write: () => true },
    admissionKickoffMs: 0, runtimeInspector: null, readinessPolicy: { semantic: "unsupported" },
    offload: async (job) => resolveAdmissionInputs(job.input),
    runtimeRefresher: refresher, runtimeImporter: async () => { await loading; return runtimeNamed("older") },
  })
  await handle.session.callTool({ name: "desk_status", input: {} })
  assert.deepEqual(pokes, [], "nothing is checked while the runtime is still loading")
  open()
  await until(() => handle.admission.snapshot().state === "ready")
  await handle.session.callTool({ name: "desk_status", input: {} })
  assert.equal(pokes.length, 1)
  assert.equal(pokes[0].soon, true)
  refresher.ready = true
  assert.equal(payload(await handle.session.callTool({ name: "desk_search", input: { query: "x" } })).served_by, "older")
  assert.deepEqual(reasons, [["the 9.9.9 runtime could not say what it is (unreadable)", "9.9.9"]])
  clearInterval(keepAlive)
  input.end()
  await handle.closed
})

test("the boot runs from the serving runtime's plugin folder, and the one-task boot from its script", async () => {
  const root = await mkTempRoot("runtime-swap-boot-")
  const copy = path.join(root, "copy")
  mkdirSync(path.join(copy, "mcp", "scripts"), { recursive: true })
  const script = path.join(copy, "mcp", "scripts", "session-boot.js")
  writeFileSync(script, "")
  const started = []
  const env = { COPILOT_AGENT_SESSION_ID: "swap-boot", DESK_PLUGIN_ROOT: path.join(root, "agency-copy") }
  const taskCalls = []
  const callTool = withStartupBoot({
    callTool: async (call) => ({ content: [{ type: "text", text: call.name }] }),
    env, stateDir: path.join(root, "state"), allowInTest: true, waitMs: 0, servingRoot: () => copy,
    start: (options) => { started.push(options.script); return { state: "started" } },
    taskBoot: async (options) => { taskCalls.push(options.script); return "task boot" },
  })
  await callTool({ name: "task_focus", input: { track: "t", slug: "s" } })
  assert.deepEqual(started, [script])
  assert.deepEqual(taskCalls, [script])
  // A serving folder with no boot script leaves the boot to the plugin folder the host cached.
  const bare = withStartupBoot({ callTool: async () => ({ content: [] }), env: { ...env, COPILOT_AGENT_SESSION_ID: "swap-bare" }, stateDir: path.join(root, "state"), allowInTest: true, waitMs: 0, servingRoot: () => path.join(root, "bare"), start: (options) => { started.push(options.script); return { state: "started" } } })
  await bare({ name: "desk_search", input: {} })
  assert.equal(started[1], path.join(root, "agency-copy", "mcp", "scripts", "session-boot.js"))
  const calls = []
  const exec = (file, args, options, done) => { calls.push(args); done(null, "pushed from the newer boot\n") }
  assert.equal(await defaultTaskBoot({ env, track: "t", slug: "s", script, exec }), "pushed from the newer boot\n")
  assert.deepEqual(calls, [[script, "--task", "t/s", "--task-only"]])
  // A boot script that fails, prints nothing or cannot run leaves the in-process boot to answer.
  const hung = () => new Promise(() => {})
  for (const failing of [(file, args, options, done) => done(new Error("exit 1")), (file, args, options, done) => done(null, "  "), () => { throw new Error("no spawn") }]) {
    assert.match(await defaultTaskBoot({ env, track: "t", slug: "s", script, exec: failing, waitMs: 20, bootFn: hung }), /^Push route and repos for t\/s were not checked in time/u)
  }})

function webServer(options) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const waiting = new Map()
  let buffered = ""
  stdout.setEncoding("utf8")
  stdout.on("data", (chunk) => {
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      waiting.get(message.id)?.(message)
    }
  })
  let next = 0
  const request = (method, params) => new Promise((resolve) => {
    const id = ++next
    waiting.set(id, resolve)
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
  const done = web.serve({ stdin, stdout, signals: new EventEmitter(), exit() {}, ...options })
  return { stdin, request, done }
}

const reply = (text) => ({ content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text) }], isError: false })
const GONE = { name: "browser_command", arguments: { contextId: "11111111-1111-4111-8111-111111111111", args: ["snapshot"] } }
const OPEN = { name: "browser_context", arguments: { action: "open" } }

test("the browser server builds the newer release's controller, serves new browsers and tools from it, and leaves open browsers with their own", async () => {
  const tmp = await mkTempRoot("runtime-swap-web-")
  const newerRoot = path.join(tmp, "newer-plugin")
  const newerContexts = {}
  const closed = []
  const newer = {
    settings: { pluginRoot: newerRoot, contexts: newerContexts },
    call: async (name, input) => {
      if (input.action !== "open") return reply("newer ran it")
      if (input.browser === "plain") return reply("not JSON at all")
      if (input.browser === "null") return reply("null")
      if (input.browser === "number") return reply("7")
      if (input.browser === "bare") return reply({ contextId: "x" })
      newerContexts["22222222-2222-4222-8222-222222222222"] = {}
      return reply({ contextId: "22222222-2222-4222-8222-222222222222", runtime: { plugin: { name: "desk", version: NEWER }, plugin_root: newerRoot } })
    },
    closeAll: async () => { closed.push("newer") },
  }
  mkdirSync(newerRoot, { recursive: true })
  writeFileSync(path.join(newerRoot, "plugin.json"), JSON.stringify({ version: NEWER }))
  const newerTools = [{ name: "browser_context", description: "newer description", inputSchema: { type: "object" } }]
  let answer = { state: "failed", latest: NEWER, reason: "the download failed (HTTP 503)" }
  const refresher = createRuntimeRefresher({ env: {}, intervalMs: 0, prepare: async () => answer })
  const { stdin, request, done } = webServer({ tmpDir: tmp, env: { ...process.env, DESK_BROWSER_STATE_DIR: path.join(tmp, "state") }, refresher: { refresher } })
  // The older controller answers while a check fails, and a failed check changes nothing.
  assert.equal((await request("tools/call", GONE)).result.isError, true)
  await refresher.idle()
  assert.equal(refresher.describe().refresh.state, "failed")
  assert.notEqual((await request("tools/list")).result.tools[0].description, "newer description")
  assert.equal((await request("tools/call", GONE)).result.isError, true, "the older controller still answers")

  answer = { state: "ready", latest: NEWER, loaded: { controller: newer, tools: newerTools, version: NEWER } }
  await request("tools/call", GONE)
  await refresher.idle()
  answer = { state: "current", latest: NEWER }
  const swapped = JSON.parse((await request("tools/call", OPEN)).result.content[0].text)
  assert.equal(swapped.runtime.plugin.version, NEWER)
  assert.equal(swapped.runtime.from, runningVersion)
  assert.match(swapped.runtime.swapped_at, /^\d{4}-/u)
  assert.equal(swapped.runtime.refresh.state, "swapped")
  assert.deepEqual((await request("tools/list")).result.tools, newerTools)
  assert.equal((await request("tools/call", { name: "browser_context", arguments: { action: "open", browser: "plain" } })).result.content[0].text, "not JSON at all", "an answer that is not the browser's JSON passes through")
  for (const [browser, text] of [["null", "null"], ["number", "7"], ["bare", JSON.stringify({ contextId: "x" })]]) {
    assert.equal((await request("tools/call", { name: "browser_context", arguments: { action: "open", browser } })).result.content[0].text, text, `${browser}: an answer with no runtime to add to passes through`)
  }
  assert.equal((await request("tools/call", { name: "browser_command", arguments: { contextId: "22222222-2222-4222-8222-222222222222", args: ["snapshot"] } })).result.content[0].text, "newer ran it")
  stdin.end()
  await done
  assert.deepEqual(closed, ["newer"], "every controller closes its browsers when the server ends")
})

test("the browser server builds its watcher on the first call, and leaves an answer it cannot read alone", async () => {
  const tmp = await mkTempRoot("runtime-swap-web-factory-")
  let made = 0
  const refresher = createRuntimeRefresher({ env: {}, intervalMs: 0, prepare: async () => ({ state: "current", latest: runningVersion }) })
  const odd = { name: "browser_context", arguments: { action: "open", browser: "nonsense" } }
  const { stdin, request, done } = webServer({ tmpDir: tmp, env: { ...process.env, DESK_BROWSER_STATE_DIR: path.join(tmp, "state") },
    refresherFactory: async () => { made += 1; return { refresher } } })
  assert.equal((await request("tools/call", GONE)).result.isError, true)
  await until(() => refresher.describe().refresh.checked_at !== undefined)
  assert.equal(made, 1)
  // An open that fails is the browser's own answer, with no runtime to add to.
  assert.equal((await request("tools/call", odd)).result.isError, true)
  stdin.end()
  await done
  // A plugin folder with no readable version still serves.
  for (const folder of [tmp, path.join(tmp, "versionless")]) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, "plugin.json"), "{}")
  }
  for (const pluginRoot of [path.join(tmp, "versionless"), path.join(tmp, "missing")]) {
    const unknown = webServer({ tmpDir: tmp, pluginRoot, env: { ...process.env, DESK_BROWSER_STATE_DIR: path.join(tmp, "state") }, refresher: { refresher: createRuntimeRefresher({ env: {}, intervalMs: 0, prepare: async (input) => ({ state: "current", latest: String(input.running) }) }) } })
    assert.equal((await unknown.request("tools/call", GONE)).result.isError, true)
    unknown.stdin.end()
    await unknown.done
  }
  const broken = webServer({ tmpDir: tmp, env: { ...process.env, DESK_BROWSER_STATE_DIR: path.join(tmp, "state") }, refresherFactory: async () => { throw new Error("no watcher") } })
  assert.equal((await broken.request("tools/call", GONE)).result.isError, true, "a watcher that cannot start leaves the server as it is")
  broken.stdin.end()
  await broken.done
})

test("the browser server finds the newer release's controller, or says why it did not", async () => {
  const tmp = await mkTempRoot("runtime-swap-web-prepare-")
  const copy = async (name, files) => {
    const mcpRoot = path.join(tmp, name, "mcp")
    mkdirSync(mcpRoot, { recursive: true })
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(mcpRoot, file), text)
    return mcpRoot
  }
  const prepare = (release) => web.prepareNewerBrowser({ running: "1.0.0", env: {}, homeDir: tmp, pluginRoot: tmp, newestRelease: async () => release })
  assert.deepEqual(await prepare({ state: "not_applicable", reason: "off" }), { state: "not_applicable", reason: "off" })
  assert.deepEqual(await prepare({ state: "current", latest: "1.0.0" }), { state: "current", latest: "1.0.0" })
  assert.deepEqual(await prepare({ state: "fell_back", latest: "1.0.1", reason: "offline" }), { state: "failed", latest: "1.0.1", reason: "offline" })
  const good = await copy("good", { "web.cjs": "exports.createController = () => ({ settings: { pluginRoot: 'x', contexts: {} } })", "web-catalog.json": JSON.stringify({ tools: [{ name: "browser_context" }] }) })
  const ready = await prepare({ state: "loaded", latest: "1.0.1", mcpRoot: good })
  assert.equal(ready.state, "ready")
  assert.equal(ready.loaded.version, "1.0.1")
  assert.deepEqual(ready.loaded.tools, [{ name: "browser_context" }])
  for (const [name, files, why] of [
    ["empty", {}, /Cannot find module/u],
    ["no-controller", { "web.cjs": "exports.other = 1", "web-catalog.json": JSON.stringify({ tools: [] }) }, /it has no browser server/u],
  ]) {
    const result = await prepare({ state: "loaded", latest: "1.0.2", mcpRoot: await copy(name, files) })
    assert.equal(result.state, "failed")
    assert.match(result.reason, /^the 1\.0\.2 copy did not load \(/u)
    assert.match(result.reason, why)
  }
})
