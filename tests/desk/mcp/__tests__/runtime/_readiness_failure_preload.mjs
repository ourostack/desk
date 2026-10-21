// One-off failure observer for the explicit admission recovery cases. No timers,
// lifecycle handlers, replacement controllers/journals, or diagnostic I/O files.
import childProcess from "node:child_process"
import { createHash } from "node:crypto"
import { register, syncBuiltinESMExports } from "node:module"
import { performance } from "node:perf_hooks"
import { types } from "node:util"
import { pathToFileURL } from "node:url"
import { isMainThread, workerData } from "node:worker_threads"

const marker = "[readiness-failure] "
const sourceRoot = new URL("../../../../../plugins/desk/mcp/src/", import.meta.url).href
const methods = new Set(["client", "server", "journal", "mirror", "worker", "recordChange", "markUncertain", "status", "handshake", "beginConvergence", "tools/call", "tools/list"])
const phaseNames = new Set(["inspecting_runtime_pack", "restoring_runtime_dependencies", "mirroring_source", "waiting_for_publication_lock", "building"])
const spans = ["protect", "build", "copy", "stage", "dest", "rename"]
const events = new Set(["cov", "unknown", "limited", "phase", "start", "send", "recv", "done", "reply", "timeout", ...spans.flatMap(name => [name + ".begin", name + ".end", name + ".ok", name + ".throw"])])
const roles = new Set(["m", "w", "c", "l", "t"])
let observer = null
let loaderScope = null

function opaque(value) {
  return typeof value === "string" || typeof value === "number"
    ? createHash("sha256").update(String(value)).digest("hex").slice(0, 12) : undefined
}

// Passive samples only: an interval without an observation is NOT loop proof.
function fact(role, event, method, id) {
  if (!roles.has(role) || !events.has(event) ||
      (event === "phase" ? !phaseNames.has(method) : method !== undefined && !methods.has(method))) return null
  const utilization = performance.eventLoopUtilization()
  return { r: role, e: event, ...(method === undefined ? {} : { m: method }),
    ...(id === undefined ? {} : { q: opaque(id) }), t: Date.now(),
    a: Math.round(utilization.active), i: Math.round(utilization.idle) }
}

export function emit(event, method, id) {
  try {
    if (!observer) return
    const row = fact(observer.role, event, method, id)
    if (!row) return
    // Ordinary status traffic cannot consume the recording/protection budget.
    const group = method === "status" ? "status" : "important"
    const count = observer.counts[group]++
    const limit = group === "status" ? 12 : 100
    if (count === limit) process.stderr.write(marker + JSON.stringify(fact(observer.role, "limited", event === "phase" ? "worker" : method)) + "\n")
    if (count >= limit) return
    process.stderr.write(marker + JSON.stringify(row) + "\n")
  } catch { /* The observation must never become an operation's error. */ }
}

export function observeSync(label, operation) {
  return function(...args) {
    emit(label + ".begin")
    try {
      const value = Reflect.apply(operation, this, args)
      emit(label + ".end")
      return value
    } catch (error) {
      emit(label + ".throw")
      throw error
    }
  }
}

export const isMirror = value => typeof value === "string" && value.replaceAll("\\", "/").includes("/source-mirror/")

export function normalizePhase(value) {
  if (typeof value !== "string") return null
  if (phaseNames.has(value)) return value
  for (const name of ["waiting_for_publication_lock", "building"]) {
    if (value.startsWith(name + ":")) return name
  }
  return null
}

export function forwardPhase(onPhase, phase) {
  try {
    const name = normalizePhase(phase)
    if (name === null) emit("unknown", "worker")
    else emit("phase", name)
  } catch { /* Observation must not replace the callback's result or error. */ }
  return onPhase(phase)
}

function owned(url, suffix, scope) {
  try {
    const href = new URL(url).href
    return href === new URL(suffix, scope.sourceRoot).href ||
      href.startsWith(scope.cacheRoot) &&
      new RegExp("/source-mirror/[a-f0-9]{64}/src/" + suffix.replaceAll(".", "\\.") + "$", "u").test(new URL(href).pathname)
  } catch { return false }
}

export function wrapControllerFork(fork, preloadURL, scope) {
  return function(...args) {
    const file = args[0] instanceof URL ? args[0].href : typeof args[0] === "string" ? pathToFileURL(args[0]).href : ""
    if (owned(file, "readiness/controller-child.js", scope) && Array.isArray(args[1]) && args[2]) {
      const options = args[2]
      if (!(options.execArgv ?? []).includes(preloadURL)) {
        args[2] = { ...options, execArgv: [...(options.execArgv ?? []), "--import", preloadURL] }
      }
    }
    return Reflect.apply(fork, this, args)
  }
}

export function preloadArgs(fixture, name) {
  if (!["missing-root", "saved-binding", "initial-admission"].includes(name)) return []
  const url = new URL(import.meta.url)
  url.search = ""
  url.searchParams.set("case", name)
  url.searchParams.set("cache", pathToFileURL(fixture.runtimeCache + "/").href)
  return ["--import", url.href]
}

const protect = expression => `{ __rd("protect.begin"); let __ok = false; try { await ${expression}; __ok = true } finally { __rd(__ok ? "protect.ok" : "protect.throw") } }`

// Exact, atomic anchors; no partial instrumentation on an unfamiliar module.
export function transformSource(url, source, scope) {
  let name
  let replacements
  if (owned(url, "readiness/controller-client.js", scope)) {
    name = "client"
    replacements = [
      ["const id = randomUUID()", 'const id = randomUUID(); __rd("start", method, id)'],
      ['socket.once("connect", () => {\n      socket.write(', 'socket.once("connect", () => {\n      __rd("send", method, id); socket.write('],
      ["reject(new Error(`readiness controller request timed out: ${method}`))", '__rd("timeout", method, id); reject(new Error(`readiness controller request timed out: ${method}`))'],
      ["socket.on(\"data\", createControllerResponseAccumulator((line) => {", 'socket.on("data", createControllerResponseAccumulator((line) => { __rd("reply", method, id);'],
    ]
  } else if (owned(url, "readiness/controller-server.js", scope)) {
    name = "server"
    replacements = [
      ["request = JSON.parse(line)", 'request = JSON.parse(line); __rd("recv", request?.method, request?.id)'],
      ["const result = await builtin()", 'const result = await builtin(); __rd("done", request.method, request.id)'],
      ['if (!socket.destroyed) socket.end(`${JSON.stringify(responseMessage({ id: request.id, result }))}\\n`)',
        'if (!socket.destroyed) { socket.end(`${JSON.stringify(responseMessage({ id: request.id, result }))}\\n`); __rd("reply", request.method, request.id) }'],
    ]
  } else if (owned(url, "readiness/journal.js", scope)) {
    name = "journal"
    replacements = [
      ["if (protectFile && entries.length > 0) await protectFile(entries)", "if (protectFile && entries.length > 0) " + protect("protectFile(entries)")],
      ['await protect([{ path: staging, kind: "directory", created: true }])', protect('protect([{ path: staging, kind: "directory", created: true }])')],
      ['if (protectFile) await protectFile([{ path: temporary, kind: "file", created: true }])', "if (protectFile) " + protect('protectFile([{ path: temporary, kind: "file", created: true }])')],
    ]
  } else if (owned(url, "runtime/admission-worker.js", scope)) {
    name = "worker"
    replacements = [
      ["if (reply.phase !== undefined) return settled ? undefined : onPhase(reply.phase)",
        "if (reply.phase !== undefined) return settled ? undefined : __rf(onPhase, reply.phase)"],
    ]
  } else if (owned(url, "runtime/bootstrap.js", scope)) {
    name = "mirror"
    replacements = [
      ["  const lockIo = { platform, remove: removeDirectory, sleep, writeLockOwner }",
        `  const lockIo = { platform, remove: removeDirectory, sleep, writeLockOwner }
  if (__rm(destinationDir)) {
    if (build !== null) build = __rw("build", build)
    const __validate = validateDestination
    validateDestination = function(candidate) { return __rw(candidate === stagingDir ? "stage" : "dest", __validate).call(this, candidate) }
    rename = __rw("rename", rename)
  }`],
      ["cpSync(path.join(mcpRoot, entry), path.join(stagingPath, entry), {", '__rw("copy", cpSync)(path.join(mcpRoot, entry), path.join(stagingPath, entry), {'],
    ]
  } else return { source, coverage: "outside" }
  if (replacements.some(([anchor]) => source.split(anchor).length !== 2)) {
    return { source, coverage: "unknown", name }
  }
  let changed = source
  for (const [anchor, replacement] of replacements) changed = changed.replace(anchor, replacement)
  return {
    source: `import { emit as __rd, observeSync as __rw, isMirror as __rm, forwardPhase as __rf } from ${JSON.stringify(scope.helperURL)};\n__rd("cov", ${JSON.stringify(name)});\n` + changed,
    coverage: "applied", name,
  }
}

// The same file serves as preload and supported module hook. Loader workers do
// not satisfy the admission-worker sentinel, so registration cannot recurse.
export function initialize(scope) {
  loaderScope = scope
  observer = { role: "l", counts: { status: 0, important: 0 } }
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context)
  if (!loaderScope || loaded.format !== "module" || loaded.source == null) return loaded
  const original = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8")
  const changed = transformSource(url, original, loaderScope)
  if (changed.coverage === "unknown") emit("unknown", changed.name)
  return changed.coverage === "applied" ? { ...loaded, source: changed.source } : loaded
}

function safeRow(row) {
  if (!row || !roles.has(row.r) || !events.has(row.e) ||
      (row.e === "phase" ? !phaseNames.has(row.m) : row.m !== undefined && !methods.has(row.m))) return null
  if (["cov", "unknown"].includes(row.e) && !["client", "server", "journal", "mirror", "worker"].includes(row.m)) return null
  if (![row.t, row.a, row.i].every(value => typeof value === "number" && Number.isFinite(value))) return null
  return { r: row.r, e: row.e, ...(row.m === undefined ? {} : { m: row.m }),
    ...(typeof row.q === "string" && /^[a-f0-9]{12}$/u.test(row.q) ? { q: row.q } : {}),
    t: row.t, a: row.a, i: row.i }
}

export function failurePrefix(stderr) {
  const rows = []
  for (const line of String(stderr).slice(-16384).split("\n")) {
    if (!line.startsWith(marker)) continue
    try { const row = safeRow(JSON.parse(line.slice(marker.length))); if (row) rows.push(row) } catch { /* not evidence */ }
  }
  rows.sort((a, b) => a.t - b.t)
  const cov = [...new Set(rows.filter(row => row.e === "cov").map(row => row.r + "/" + row.m))]
  const phaseUnknown = String(stderr).length > 16384 || !cov.includes("m/worker") ||
    !rows.some(row => row.e === "phase") ||
    rows.some(row => row.e === "unknown" && row.m === "worker" || row.e === "limited" && row.m !== "status")
  const summary = { coverage_unknown: String(stderr).length > 16384 || rows.some(row => row.e === "unknown" || row.e === "limited") ||
    ["m/client", "w/mirror", "c/server", "c/journal"].some(value => !cov.includes(value)) || phaseUnknown, cov,
    phase_coverage_unknown: phaseUnknown,
    t0: rows[0]?.t ?? null, phases: [], spans: [], rpc: [], truncated: String(stderr).length > 16384 || rows.some(row => row.e === "limited") }
  const starts = new Map()
  const totals = new Map()
  const requests = new Map()
  for (const row of rows) {
    const [label, action] = row.e.split(".")
    const key = row.r + "/" + label
    if (row.e === "phase") {
      summary.phases.push([row.m, row.t - summary.t0])
    } else if (spans.includes(label)) {
      if (action === "begin") starts.set(key, row.t)
      else if (starts.has(key)) {
        const value = totals.get(key) ?? [key, 0, 0]
        value[1]++
        value[2] += Math.max(0, row.t - starts.get(key))
        totals.set(key, value)
        starts.delete(key)
      }
    } else if (["start", "send", "recv", "done", "reply", "timeout"].includes(row.e)) {
      if (!row.q) continue
      const key = row.m + "/" + row.q
      const request = requests.get(key) ?? { m: row.m ?? "unknown", q: row.q, samples: {} }
      // c0/client start, cs/send, sv/server receive, sd/done, sr/server
      // reply, cr/client reply, ct/timeout. a/i are passive ELU deltas.
      const field = { start: "c0", send: "cs", recv: "sv", done: "sd", reply: row.r === "c" ? "sr" : "cr", timeout: "ct" }[row.e]
      request[field] = row.t - summary.t0
      const side = row.r === "c" ? "s" : "c"
      const first = request.samples[side]
      if (first) {
        request[side + "a"] = Math.max(0, row.a - first[0])
        request[side + "i"] = Math.max(0, row.i - first[1])
      } else request.samples[side] = [row.a, row.i]
      requests.set(key, request)
    }
  }
  summary.spans = [...totals.values(), ...[...starts].map(([key, at]) => [key, "pending", at - summary.t0])]
  const hot = value => ["recordChange", "markUncertain"].includes(value.m)
  const timelines = [...requests.values()].map(({ samples, ...value }) => value)
  summary.rpc = ["recordChange", "markUncertain"].flatMap(method => timelines.filter(value => value.m === method).slice(-1))
    .concat(timelines.filter(value => !hot(value)).slice(-1))
  let prefix = "[readiness-failure " + JSON.stringify(summary) + "]\n"
  while (Buffer.byteLength(prefix) > 960) {
    summary.truncated = true
    summary.coverage_unknown = true
    summary.phase_coverage_unknown = true
    const optional = summary.rpc.findIndex(value => !hot(value))
    if (optional >= 0) summary.rpc.splice(optional, 1)
    else if (summary.spans.length) summary.spans.pop()
    else if (summary.cov.length) summary.cov.pop()
    else if (summary.phases.length) summary.phases.shift()
    else {
      // Never discard a critical request to retain optional ELU/detail fields.
      summary.rpc = summary.rpc.map(({ m, q, cs, sv, sr, cr, ct }) => ({ m, q, cs, sv, sr, cr, ct }))
      prefix = "[readiness-failure " + JSON.stringify(summary) + "]\n"
      break
    }
    prefix = "[readiness-failure " + JSON.stringify(summary) + "]\n"
  }
  return prefix
}

export function annotateTestError(error, stderr) {
  // Inspect own DATA descriptors only; never stringify/read a thrown object.
  if (!types.isNativeError(error)) return error
  const message = Object.getOwnPropertyDescriptor(error, "message")
  const code = Object.getOwnPropertyDescriptor(error, "code")
  if (!message?.writable || typeof message.value !== "string" ||
      code?.value !== "ERR_ASSERTION" && !message.value.startsWith("desk_status did not reach the expected state within 20000 ms;") ||
      message.value.startsWith("[readiness-failure ")) return error
  try { Object.defineProperty(error, "message", { ...message, value: failurePrefix(stderr) + message.value }) } catch { /* preserve the test error */ }
  return error
}

export async function withReadinessFailure(session, operation) {
  const wire = []
  const input = session.child.stdin
  const output = session.child.stdout
  const originalWrite = input.write
  const originalDescriptor = Object.getOwnPropertyDescriptor(input, "write")
  const requests = new Map()
  let attached = false
  let pending = ""
  const note = (event, message) => {
    const id = opaque(message.id)
    if (event === "send" && ["tools/list", "tools/call"].includes(message.method)) {
      if (requests.size === 32) requests.delete(requests.keys().next().value)
      requests.set(id, message.method)
    }
    const method = requests.get(id)
    if (event === "reply") requests.delete(id)
    if (wire.length === 12) wire.shift()
    wire.push(fact("t", event, method, message.id))
  }
  const wrapped = function(chunk, ...args) {
    try { note("send", JSON.parse(String(chunk))) } catch { /* observe only */ }
    return Reflect.apply(originalWrite, this, [chunk, ...args])
  }
  const receive = chunk => {
    try {
      pending += String(chunk)
      if (pending.length > 16384) { pending = ""; return }
      let end
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        try { const message = JSON.parse(line); if (message.id !== undefined) note("reply", message) } catch { /* not evidence */ }
      }
    } catch { /* observe only */ }
  }
  try {
    input.write = wrapped
    output.on("data", receive)
    attached = true
  } catch { /* Do not turn an unavailable observer into a failed operation. */ }
  try { return await operation() }
  catch (error) {
    try { annotateTestError(error, session.stderr() + "\n" + wire.filter(Boolean).map(row => marker + JSON.stringify(row)).join("\n")) } catch { /* preserve original error */ }
    throw error
  } finally {
    try {
      if (input.write === wrapped) {
        if (originalDescriptor) Object.defineProperty(input, "write", originalDescriptor)
        else delete input.write
      }
      if (attached) output.off("data", receive)
    } catch { /* The original operation/error remains authoritative. */ }
  }
}

const selected = process.execArgv.find(value => {
  try { return new URL(value).pathname === new URL(import.meta.url).pathname && new URL(value).searchParams.has("case") } catch { return false }
})
if (selected && ["missing-root", "saved-binding", "initial-admission"].includes(new URL(selected).searchParams.get("case")) &&
    (isMainThread || workerData?.deskAdmissionWorker === true)) {
  const preload = new URL(selected)
  const scope = { sourceRoot, cacheRoot: preload.searchParams.get("cache"), helperURL: preload.href }
  observer = { role: isMainThread ? (process.argv[1]?.replaceAll("\\", "/").endsWith("/controller-child.js") ? "c" : "m") : "w",
    counts: { status: 0, important: 0 } }
  try {
    register(preload.href, { data: scope })
    childProcess.fork = wrapControllerFork(childProcess.fork, preload.href, scope)
    syncBuiltinESMExports()
  } catch {
    emit("unknown", "client")
    emit("unknown", "mirror")
  }
}
