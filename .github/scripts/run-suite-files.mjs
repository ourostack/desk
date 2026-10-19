// Runs the Desk unit test files one process each, with a per-file time limit, and writes a JSON result.
// Legacy hangs use tree termination; product mode fails at its original H without inventing retirement.
// Usage: node run-suite-files.mjs --shard 1/6 --out <results.json> [--timeout-ms 1800000] [--only <file regex>] [--tests-root <folder>] [--durations <table.json>]
// Exit code: 1 when any file failed, timed out or reported a failed test, so a job that runs this script is red whenever the suite is. 0 only when every file passed.
import { spawn, spawnSync } from "node:child_process"
import https from "node:https"
import tls from "node:tls"
import { createHash } from "node:crypto"
import { channel, tracingChannel } from "node:diagnostics_channel"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { PRODUCT_SELECTOR, NATIVE_TEST_NAME, isOwnedGitProductSelection,
  createProductTapCounter, createProductCompletion, captureProductEnvelope, productEnvelopeRemaining,
  normalizeF0Selection, initF0Inventory, createF0Completion, createF0Writer, createF0HostFrameReader,
  decodeF0BlobResponse, projectF0Intent, projectF0FirstHopEnv, spawnF0Child, finishF0Inventory } from "./owned-git-product-io.mjs"

function f0RunnerError(code) { throw Object.assign(new Error(code), { code }) }
function f0RequireValue(ok, code = "foundation") { if (!ok) f0RunnerError(code) }
function f0Positive(value) {
  f0RequireValue(typeof value === "string" && /^[1-9][0-9]*$/.exec(value)?.[0] === value)
  const number = Number(value)
  f0RequireValue(Number.isSafeInteger(number) && String(number) === value)
  return number
}
function f0ServiceJSON(bytes, cap) {
  f0RequireValue(Buffer.isBuffer(bytes) && bytes.length <= cap, "transport")
  const text = bytes.toString("utf8")
  f0RequireValue(Buffer.from(text).equals(bytes), "transport")
  let at = 0, tokens = 0, containers = 0, keys = 0, chars = 0
  const space = () => { while (at < text.length && /[ \t\r\n]/.test(text[at])) at++ }
  function string() {
    const start = at++
    let escaped = false
    while (at < text.length) {
      const c = text[at++]
      if (!escaped && c === '"') {
        f0RequireValue(at - start <= 32768, "transport")
        const value = JSON.parse(text.slice(start, at))
        chars += value.length
        f0RequireValue(chars <= 262144 && value.isWellFormed() && !value.includes("\0"), "transport")
        return value
      }
      if (!escaped && c === "\\") escaped = true
      else escaped = false
    }
    f0RunnerError("transport")
  }
  function read(depth) {
    space(); f0RequireValue(++tokens <= 65536 && depth <= 16, "transport")
    if (text[at] === '"') return string()
    if (text[at] === "{" || text[at] === "[") {
      f0RequireValue(++containers <= 4096, "transport")
      const object = text[at++] === "{", result = object ? {} : [], end = object ? "}" : "]", seen = new Set()
      space()
      if (text[at] === end) { at++; return result }
      for (;;) {
        if (object) {
          space(); f0RequireValue(text[at] === '"', "transport")
          const key = string()
          f0RequireValue(++keys <= 32768 && !seen.has(key) && !["__proto__", "prototype", "constructor"].includes(key), "transport")
          seen.add(key); space(); f0RequireValue(text[at++] === ":", "transport"); result[key] = read(depth + 1)
        } else result.push(read(depth + 1))
        space()
        if (text[at] === end) { at++; return result }
        f0RequireValue(text[at++] === ",", "transport")
      }
    }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, at)) { at += literal.length; return value }
    }
    const match = /^(?:0|[1-9][0-9]*)/.exec(text.slice(at))
    f0RequireValue(match && match[0].length <= 16, "transport"); at += match[0].length
    const value = Number(match[0]); f0RequireValue(Number.isSafeInteger(value), "transport"); return value
  }
  const value = read(0); space(); f0RequireValue(at === text.length, "transport"); return value
}
function f0ProjectServiceRun(raw) {
  const positive = (v) => { f0RequireValue(Number.isSafeInteger(v) && v > 0, "authorization"); return v }
  const string = (v, max) => {
    f0RequireValue(typeof v === "string" && v.length <= max && !/[^\x20-\x7e]/.test(v), "authorization")
    return Buffer.from(v).toString()
  }
  const actor = (v) => ({ id: positive(v?.id), login: string(v?.login, 39) })
  return { id: positive(raw?.id), attempt: positive(raw?.run_attempt), workflowId: positive(raw?.workflow_id),
    repositoryId: positive(raw?.repository?.id), headRepositoryId: positive(raw?.head_repository?.id),
    headSha: string(raw?.head_sha, 40), headBranch: string(raw?.head_branch, 256), event: string(raw?.event, 64),
    actor: actor(raw?.actor), triggeringActor: actor(raw?.triggering_actor), displayTitle: string(raw?.display_title, 256) }
}
async function runF0Inventory(selection) {
  const startedNs = process.hrtime.bigint(), deadlineNs = startedNs + 300000000000n
  const requests = new Set(), handles = new Set(), reader = createF0HostFrameReader()
  let lastNs = startedNs, finished = false, writer, agent, publicationLive
  let stdoutBytes = 0, stderrBytes = 0, child = null, intentForQuery = null
  const nowNs = () => {
    const now = process.hrtime.bigint()
    f0RequireValue(now >= lastNs, "deadline"); lastNs = now; return now
  }
  const owner = createF0Completion({ startedNs, nowNs, arm: setTimeout, disarm: clearTimeout,
    persist(packet, stillLive) { publicationLive = stillLive; f0RequireValue(writer, "io"); return writer.publish(packet) },
    terminate(code) {
      finished = true
      let exitCode = code
      for (const request of requests) { try { request.destroy() } catch { /* Unknown close cannot authorize success. */ } }
      try { if (agent) agent.destroy() } catch { exitCode = 1 }
      // Fatal teardown does not wait for or certify pending I/O retirement.
      if (code !== 0) for (const handle of handles) { try { void handle.close().catch(() => {}) } catch {} }
      process.exit(exitCode)
    } })
  owner.start()
  const live = () => {
    if (finished) return false
    try { if (nowNs() < deadlineNs) return true } catch {}
    owner.deadline(); return false
  }
  publicationLive = live
  const check = () => f0RequireValue(live(), "deadline")
  const fail = (code = "transport") => owner.error(
    ["foundation", "authorization", "source-mismatch", "source-changed", "deadline", "transport", "worker", "ownership", "io", "schema", "not-admitted"].includes(code) ? code : "schema")
  const physical = async (value, directory) => {
    check()
    f0RequireValue(typeof value === "string" && Buffer.byteLength(value) <= 1024 &&
      /^[A-Za-z]:\\/.test(value) && !/["\0\r\n]/.test(value) && path.normalize(value) === value)
    let current = path.parse(value).root
    for (const part of value.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      const st = await fs.promises.lstat(current, { bigint: true }); check()
      f0RequireValue(!st.isSymbolicLink() && (current === value && !directory ? st.isFile() : st.isDirectory()))
    }
    const resolved = await fs.promises.realpath(value); check()
    f0RequireValue(resolved.toLowerCase() === value.toLowerCase())
    return value
  }
  const identity = (st) => [st.dev, st.ino, st.size, st.mtimeNs, st.birthtimeNs].map(String).join(":")
  async function readSource(name, cap) {
    check()
    const file = path.join(workspace, ...name.split("/"))
    await physical(file, false)
    const handle = await fs.promises.open(file, "r"); handles.add(handle)
    try {
      check()
      const before = await handle.stat({ bigint: true }); check()
      const openedPath = await fs.promises.lstat(file, { bigint: true }); check()
      f0RequireValue(before.isFile() && !openedPath.isSymbolicLink() &&
        identity(before) === identity(openedPath) && before.size <= BigInt(cap), "source-mismatch")
      const buffer = Buffer.alloc(Number(before.size))
      for (let at = 0; at < buffer.length;) {
        check()
        const { bytesRead } = await handle.read(buffer, at, Math.min(65536, buffer.length - at), at); check()
        f0RequireValue(bytesRead > 0 && bytesRead <= buffer.length - at, "source-changed"); at += bytesRead
      }
      const after = await handle.stat({ bigint: true }), byPath = await fs.promises.lstat(file, { bigint: true }); check()
      f0RequireValue(!byPath.isSymbolicLink() &&
        identity(before) === identity(after) && identity(after) === identity(byPath), "source-changed")
      return buffer
    } finally { await handle.close(); handles.delete(handle) }
  }
  async function hashNode() {
    check(); await physical(process.execPath, false)
    const handle = await fs.promises.open(process.execPath, "r"); handles.add(handle)
    try {
      const before = await handle.stat({ bigint: true }); check()
      const named = await fs.promises.lstat(process.execPath, { bigint: true }); check()
      f0RequireValue(before.isFile() && !named.isSymbolicLink() && identity(before) === identity(named) &&
        before.size > 0n && before.size <= 536870912n, "foundation")
      const hash = createHash("sha256"), buffer = Buffer.alloc(65536)
      let at = 0
      while (BigInt(at) < before.size) {
        check()
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - at), at); check()
        f0RequireValue(bytesRead > 0, "foundation"); hash.update(buffer.subarray(0, bytesRead)); at += bytesRead
      }
      const after = await handle.stat({ bigint: true }), afterPath = await fs.promises.lstat(process.execPath, { bigint: true }); check()
      f0RequireValue(!afterPath.isSymbolicLink() && identity(before) === identity(after) &&
        identity(after) === identity(afterPath), "foundation")
      return hash.digest("hex")
    } finally { await handle.close(); handles.delete(handle) }
  }
  function getApi(apiPath, cap) {
    check(); f0RequireValue(requests.size === 0, "transport")
    return new Promise((resolve, reject) => {
      let result = null, failure = null
      const request = https.request({ hostname: "api.github.com", port: 443, servername: "api.github.com",
        path: apiPath, method: "GET", agent, ca: tls.rootCertificates, rejectUnauthorized: true,
        maxHeaderSize: 16384, highWaterMark: 65536,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
          "User-Agent": "owned-git-f0", "X-GitHub-Api-Version": "2026-03-10" } }, (response) => {
        let total = 0, declared = null
        const chunks = []
        const invalid = (code) => { failure = code; response.destroy(); request.destroy() }
        if (!live()) { invalid("deadline"); return }
        if (response.statusCode !== 200) { invalid("authorization"); return }
        if (response.rawHeaders.length > 256 || response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity") { invalid("transport"); return }
        const lengths = []
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          if (response.rawHeaders[i].toLowerCase() === "content-length") lengths.push(response.rawHeaders[i + 1])
        }
        if (lengths.length > 1 || lengths.length && /^(?:0|[1-9][0-9]*)$/.exec(lengths[0])?.[0] !== lengths[0]) { invalid("transport"); return }
        if (lengths.length) {
          declared = Number(lengths[0])
          if (!Number.isSafeInteger(declared) || declared > cap) { invalid("transport"); return }
        }
        response.on("data", (chunk) => {
          if (failure) return
          if (!live()) { invalid("deadline"); return }
          if (!Buffer.isBuffer(chunk) || total + chunk.length > cap) { invalid("transport"); return }
          total += chunk.length; chunks.push(Buffer.from(chunk))
        })
        response.once("error", () => invalid("transport"))
        response.once("aborted", () => invalid("transport"))
        response.once("end", () => {
          if (!live() || !response.complete || declared !== null && total !== declared) { invalid("transport"); return }
          const link = response.headers.link
          if (link !== undefined && typeof link !== "string") { invalid("transport"); return }
          result = { bytes: Buffer.concat(chunks, total), link }
        })
      })
      requests.add(request)
      request.setTimeout(10000, () => { failure = "transport"; request.destroy() })
      request.once("error", () => { failure ??= "transport"; request.destroy() })
      request.once("close", () => {
        requests.delete(request)
        if (result && !failure) resolve(result)
        else reject(Object.assign(new Error(failure ?? "transport"), { code: failure ?? "transport" }))
      })
      request.end()
    })
  }
  let workspace, token
  try {
    check()
    f0RequireValue(process.platform === "win32" && process.arch === "x64" && process.versions.node === "24.18.0")
    f0RequireValue(JSON.stringify(process.argv.slice(2)) === JSON.stringify(["--shard", "1/8", "--only", PRODUCT_SELECTOR]), "not-admitted")
    const env = process.env
    f0RequireValue(env.F0_REPOSITORY === "ourostack/desk" && env.F0_MATRIX_MODE === "standard" &&
      env.F0_MATRIX_SHARD === "1" && env.F0_MATRIX_TOTAL === "8" && env.F0_RUN_ATTEMPT === "1")
    token = env.F0_API_TOKEN
    f0RequireValue(typeof token === "string" && token.length > 0 && token.length <= 8192 && !/[\0\r\n]/.test(token), "authorization")
    workspace = await physical(env.F0_WORKSPACE, true)
    const psHome = await physical(env.F0_PS_HOME, true), runnerToolCache = await physical(env.F0_RUNNER_TOOL_CACHE, true)
    await physical(env.F0_PWSH_PATH, false); await physical(process.execPath, false)
    const systemRoot = await physical(env.SystemRoot, true), windir = await physical(env.WINDIR, true), systemDrive = env.SystemDrive
    f0RequireValue(systemRoot.toLowerCase() === windir.toLowerCase() && typeof systemDrive === "string" &&
      /^[A-Za-z]:$/.test(systemDrive) && systemRoot.slice(0, 2).toLowerCase() === systemDrive.toLowerCase() &&
      env.F0_PWSH_PATH === path.join(psHome, "pwsh.exe"))
    const runId = f0Positive(env.F0_RUN_ID), repositoryId = f0Positive(env.F0_REPOSITORY_ID), actorId = f0Positive(env.F0_ACTOR_ID)
    agent = new https.Agent({ keepAlive: false, ca: tls.rootCertificates, rejectUnauthorized: true })
    const current = f0ProjectServiceRun(f0ServiceJSON((await getApi(`/repos/ourostack/desk/actions/runs/${runId}`, 65536)).bytes, 65536))
    const context = { repository: { id: repositoryId, name: env.F0_REPOSITORY }, workflowId: 375820044,
      workflowRef: env.F0_WORKFLOW_REF, workflowSha: env.F0_WORKFLOW_SHA, event: env.F0_EVENT_NAME,
      sha: env.F0_GITHUB_SHA, ref: env.F0_GITHUB_REF, runId, attempt: f0Positive(env.F0_RUN_ATTEMPT),
      actor: { id: actorId, login: env.F0_ACTOR_LOGIN },
      triggeringActor: { id: current.triggeringActor.id, login: env.F0_TRIGGERING_ACTOR_LOGIN },
      matrix: { mode: env.F0_MATRIX_MODE, shard: f0Positive(env.F0_MATRIX_SHARD), total: f0Positive(env.F0_MATRIX_TOTAL) },
      workspace, psHome, runnerToolCache, nodeExecutable: process.execPath, nodeVersion: process.versions.node,
      systemRoot, windir, systemDrive }
    const root = path.join(workspace, "owned-git-f0-output")
    let rootIdentity = null
    const guardRoot = async () => {
      check(); const st = await fs.promises.lstat(root, { bigint: true }); check()
      f0RequireValue(st.isDirectory() && !st.isSymbolicLink() && rootIdentity === `${st.dev}:${st.ino}:${st.birthtimeNs}`, "io")
    }
    writer = createF0Writer({ root, stillLive: () => publicationLive(), io: {
      async exclusiveOpen(name) {
        await guardRoot()
        check()
        const file = path.join(root, name), handle = await fs.promises.open(file, "wx", 0o600); handles.add(handle)
        const initial = await handle.stat({ bigint: true })
        f0RequireValue(initial.isFile() && initial.size === 0n, "io")
        let done = false, submitted = 0
        return {
          async write(bytes, offset, length) {
            check(); f0RequireValue(offset === submitted, "io")
            const result = await handle.write(bytes, offset, length, offset); check()
            submitted += result.bytesWritten; return result.bytesWritten
          },
          async flush() { check(); await guardRoot(); await handle.sync(); check() },
          async close() {
            f0RequireValue(!done, "io"); done = true
            let failure = false
            try {
              const actual = await handle.stat({ bigint: true }), named = await fs.promises.lstat(file, { bigint: true })
              await guardRoot()
              f0RequireValue(!named.isSymbolicLink() && identity(actual) === identity(named) &&
                actual.dev === initial.dev && actual.ino === initial.ino && actual.size === BigInt(submitted), "io")
            } catch { failure = true }
            await handle.close(); handles.delete(handle)
            f0RequireValue(!failure, "io")
          },
        }
      },
    } })
    let listTotal = null, listSeen = 0, listPage = 0
    const init = await initF0Inventory({ selection, context, deadlineNs, edges: {
      nowNs, nowUtc: () => Math.floor(Date.now() / 1000),
      async getBlob(oid, cap) {
        const response = await getApi(`/repos/ourostack/desk/git/blobs/${oid}`, cap)
        if (oid === selection.intentOid) {
          const decoded = decodeF0BlobResponse(response.bytes, { oid, sha256: selection.intentSha256, maxDecoded: 4096, expectedBytes: null })
          intentForQuery = projectF0Intent(f0ServiceJSON(decoded.bytes, 4096))
        }
        return response.bytes
      },
      async getRun(id) { f0RequireValue(id === runId, "authorization"); return current },
      async getRunsPage(page) {
        f0RequireValue(intentForQuery && Number.isSafeInteger(page) && page === listPage + 1 && page <= 5, "authorization")
        const utc = (seconds) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z")
        const created = `${utc(intentForQuery.notBefore)}..${utc(intentForQuery.expires)}`
        const params = new URLSearchParams({ event: "workflow_dispatch", created, per_page: "20", page: String(page) })
        const apiPath = `/repos/ourostack/desk/actions/workflows/375820044/runs`
        const response = await getApi(`${apiPath}?${params}`, 1048576), raw = f0ServiceJSON(response.bytes, 1048576)
        f0RequireValue(Array.isArray(raw.workflow_runs) && raw.workflow_runs.length <= 20 &&
          Number.isSafeInteger(raw.total_count) && raw.total_count >= 0 && raw.total_count <= 100 &&
          (listTotal === null || raw.total_count === listTotal), "authorization")
        listTotal = raw.total_count; listSeen += raw.workflow_runs.length; listPage = page
        let hasNext = false
        const relations = new Set()
        if (response.link !== undefined) for (const part of response.link.split(",")) {
          const match = /^<([^<>]+)>;\s*rel="(next|prev|first|last)"$/.exec(part.trim())
          f0RequireValue(match && !relations.has(match[2]), "authorization"); relations.add(match[2])
          const url = new URL(match[1])
          f0RequireValue(url.origin === "https://api.github.com" && url.pathname === apiPath && !url.hash &&
            !url.username && !url.password && [...url.searchParams.keys()].length === 4 &&
            url.searchParams.get("event") === "workflow_dispatch" && url.searchParams.get("created") === created &&
            url.searchParams.get("per_page") === "20" &&
            /^[1-9][0-9]*$/.exec(url.searchParams.get("page") ?? "")?.[0] === url.searchParams.get("page"), "authorization")
          const linkedPage = Number(url.searchParams.get("page"))
          f0RequireValue(Number.isSafeInteger(linkedPage) &&
            (match[2] !== "first" || linkedPage === 1) &&
            (match[2] !== "prev" || linkedPage === page - 1) &&
            (match[2] !== "last" || linkedPage >= page && linkedPage <= 5), "authorization")
          if (match[2] === "next") { f0RequireValue(url.searchParams.get("page") === String(page + 1), "authorization"); hasNext = true }
        }
        f0RequireValue(hasNext ? raw.workflow_runs.length === 20 && listSeen < listTotal : listSeen === listTotal, "authorization")
        const runs = raw.workflow_runs.map(f0ProjectServiceRun).filter((run) => run.displayTitle === `NA1-F0 ${selection.intentSha256}`)
        return { runs, hasNext }
      },
      readSource, hashNode,
      async createFreshRoot() {
        check(); await fs.promises.mkdir(root, { recursive: false, mode: 0o700 }); check()
        const st = await fs.promises.lstat(root, { bigint: true })
        f0RequireValue(st.isDirectory() && !st.isSymbolicLink(), "io")
        rootIdentity = `${st.dev}:${st.ino}:${st.birthtimeNs}`
      },
      writeControl: (name, bytes) => writer.writeControl(name, bytes),
    } })
    check()
    const foundation = { systemRoot, windir, systemDrive, psHome, runnerToolCache }
    projectF0FirstHopEnv(init.launch.env, foundation)
    child = spawnF0Child({ launch: init.launch, foundation, spawn,
      readExclusions: () => ({ execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS,
        nodePath: process.env.NODE_PATH, coverage: process.env.NODE_V8_COVERAGE,
        compileCache: process.env.NODE_COMPILE_CACHE, redirectWarnings: process.env.NODE_REDIRECT_WARNINGS,
        constructorHasSubscribers: channel("child_process").hasSubscribers,
        spawnTraceHasSubscribers: tracingChannel("child_process.spawn").hasSubscribers }) })
    owner.attach(child)
    child.once("error", () => fail("worker"))
    child.stdout.on("error", () => fail("transport")); child.stderr.on("error", () => fail("transport"))
    child.stdout.on("data", (bytes) => {
      if (finished) return
      try {
        stdoutBytes += bytes.length; f0RequireValue(stdoutBytes <= 524292, "transport")
        owner.stdout(bytes); if (!finished) reader.push(bytes)
      } catch { fail("transport") }
    })
    child.stderr.on("data", (bytes) => {
      if (finished) return
      stderrBytes += bytes.length; owner.stderr(bytes)
      if (stderrBytes > 4096) fail("transport")
    })
    child.once("close", (code, signal) => {
      owner.closed(child, code, signal)
      if (finished) return
      void (async () => {
        check()
        const host = reader.end(), sourceAfter = []
        f0RequireValue(host.worker !== null, "worker")
        // The parent owns this observation; the worker only independently rehashes its image.
        host.worker.foundation.node.version = process.versions.node
        for (const row of init.sourceApproval.files) {
          const bytes = await readSource(row.path, 2097152), hash = createHash("sha256").update(bytes).digest("hex")
          sourceAfter.push({ id: row.id, bytes: bytes.length, sha256: hash,
            state: bytes.length === row.bytes && hash === row.sha256 ? "match" : "mismatch" })
        }
        const packet = finishF0Inventory({ init, host,
          observed: { actualChild: child, closedChild: child, rootExit: code, signal, errorLatched: false, deadlineLatched: false },
          sourceAfter, counters: { filesVisited: host.worker.visited.files, selectorsVisited: host.worker.visited.selectors,
            sourceBytes: sourceAfter.reduce((sum, row) => sum + row.bytes, 0), fileBytes: host.worker.visited.bytes,
            stdoutBytes, stderrBytes, elapsedMs: Number((nowNs() - startedNs) / 1000000n) } })
        if (packet.result.operation !== "completed") { fail(packet.error.code); return }
        await owner.publish(packet)
      })().catch((error) => fail(error?.code))
    })
    await owner.terminal
  } catch (error) { fail(error?.code) }
}

const rawF0 = { event: process.env.F0_EVENT_NAME, only: process.env.F0_ONLY,
  elevated: process.env.F0_ELEVATED, phase: process.env.F0_PHASE,
  intentOid: process.env.F0_INTENT_OID, intentSha256: process.env.F0_INTENT_SHA256 }
const hasF0Bindings = Object.values(rawF0).some((value) => value !== undefined)
const f0Selection = normalizeF0Selection(rawF0)
if (hasF0Bindings && f0Selection.kind === "invalid") { console.error("not-admitted"); process.exit(1) }
if (f0Selection.kind === "f0") { await runF0Inventory(f0Selection); process.exit(1) }
const { suiteFiles } = await import("./suite-files.mjs")
const { assignShards, loadDurations } = await import("./suite-shards.mjs")

const cliEnvelope = captureProductEnvelope(process.hrtime.bigint())
const args = process.argv.slice(2)
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const [index, total] = arg("--shard", "1/1").split("/").map(Number)
const out = arg("--out", "suite-results.json")
const timeoutMs = Number(arg("--timeout-ms", "1800000"))
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const isolatedEnv = path.join(repoRoot, "tests", "desk", "mcp", "__tests__", "_isolated_env.mjs")
// --tests-root points the runner at another folder of test files (the gate test uses a synthetic one).
const testsRoot = path.resolve(arg("--tests-root", path.join(repoRoot, "tests", "desk", "mcp", "__tests__")))
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")

// The same file list the verdict job checks against (suite-files.mjs). Which shard runs which file comes from suite-shards.mjs: longest first by the measured times in suite-durations.json, so the shards finish together.
// --only <regex> narrows the run to matching files (relative to the tests folder, forward slashes) for quick investigation runs.
const only = String(arg("--only", "") ?? "")
const productRequested = only === PRODUCT_SELECTOR
if (productRequested) { console.error("not-admitted"); process.exit(1) }
const productMode = isOwnedGitProductSelection(only, process.env.DESK_TEST_SUITE_MODE)
if (productRequested && (!productMode || process.platform !== "win32" ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || timeoutMs !== 120000 || total !== 8 ||
  testsRoot !== path.join(repoRoot, "tests", "desk", "mcp", "__tests__"))) {
  console.error("owned-git product: not_admitted")
  process.exit(1)
}
const durations = loadDurations(arg("--durations", undefined))
const plan = assignShards(suiteFiles(testsRoot, only), total, durations)
const mine = (plan[index - 1]?.files ?? []).map((file) => path.join(testsRoot, ...file.split("/")))
console.log(`shard ${index}/${total}: ${mine.length} files, predicted ${Math.round(plan[index - 1].seconds / 60)} min; all shards predicted (min): ${plan.map((s) => Math.round(s.seconds / 60)).join(" ")}`)
const unlisted = plan.flatMap((s) => s.files).filter((file) => !(file in durations.files))
if (unlisted.length > 0) console.log(`::warning::${unlisted.length} test files are not in suite-durations.json and use the default weight of ${durations.defaultSeconds}s; refresh the table: ${unlisted.slice(0, 5).join(", ")}`)

// What is still running under the test process when it hit its time limit, so a hang names the stuck command.
const describeDescendants = (rootPid) => {
  if (process.platform !== "win32") return ""
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
  { encoding: "utf8", timeout: 30000 })
  try {
    const all = [].concat(JSON.parse(probe.stdout || "[]"))
    const keep = new Set([rootPid])
    for (let grew = true; grew;) {
      grew = false
      for (const p of all) if (keep.has(p.ParentProcessId) && !keep.has(p.ProcessId)) { keep.add(p.ProcessId); grew = true }
    }
    return all.filter((p) => keep.has(p.ProcessId)).map((p) => `${p.ProcessId}<-${p.ParentProcessId} ${p.Name} ${String(p.CommandLine ?? "").slice(0, 300)}`).join("\n")
  } catch { return "(process list unavailable)" }
}

const killTree = (pid) => {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
  else try { process.kill(-pid, "SIGKILL") } catch { /* already gone */ }
}

// One compact record per failed test: its name, the assertion or error text and the first stack frames.
const failures = (output) => [...output.matchAll(/^\s*not ok \d+ - ([^\n]+?)(?: # [^\n]*)?\n([\s\S]*?)(?=^\s*(?:# Subtest|ok \d+|not ok \d+|1\.\.))/gm)].map((m) => {
  const body = m[2]
  const error = /^\s*error: ([\s\S]*?)^\s*code:/m.exec(body)?.[1]?.trim() ?? ""
  const frames = (/^\s*stack: \|-\n([\s\S]*?)^\s*\.\.\./m.exec(body)?.[1] ?? "").split("\n").map((l) => l.trim().replace(/file:\/\/\/[A-Z]:\/a\/desk\/desk\//g, "")).filter(Boolean)
  // The first frames show where it failed; the first frames in the test files show what the test was doing.
  const stack = [...frames.slice(0, 3), ...frames.filter((l) => l.includes("__tests__") && !l.includes("_isolated_env")).slice(0, 3)].join(" | ")
  return { name: m[1], error: error.slice(0, 3000), stack: stack.slice(0, 700) }
})

const runProductFile = async (file) => {
  const H = cliEnvelope.Hns
  const counter = createProductTapCounter(), bytes = { stdout: 0, stderr: 0 }
  const env = {}
  for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATH", "TEMP", "TMP", "PATHEXT",
    "GITHUB_WORKSPACE", "GITHUB_SHA", "GITHUB_EVENT_NAME", "GITHUB_REF_NAME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const isolation = path.join(repoRoot, `.owned-git-source-isolation-${process.hrtime.bigint()}`)
  Object.assign(env, { DESK_TEST_RUN_DIR: isolation, TMPDIR: isolation, TEMP: isolation, TMP: isolation,
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", DESK_TEST_OWNED_GIT_NATIVE: "1",
    DESK_TEST_OWNED_GIT_H: H.toString(), DESK_TEST_SUITE_MODE: "standard" })
  const heldFiles = new Set()
  let completion
  const live = () => {
    if (completion.snapshot().terminalCode !== null) return false
    if (!productEnvelopeRemaining(cliEnvelope, process.hrtime.bigint())) {
      completion.deadline(); return false
    }
    return true
  }
  const persist = async (row) => {
    if (path.resolve(out) !== path.join(repoRoot, "results.json")) throw new Error("ci_envelope")
    const json = Buffer.from(JSON.stringify({ shard: `${index}/${total}`, platform: process.platform,
      aclProbe: null, results: [row] }, null, 1))
    const summary = Buffer.from("| Files | Files with a failure | Timeouts | Tests passed | Tests failed |\n" +
      "|---|---|---|---|---|\n" +
      `| 1 | ${row.exitCode === 0 ? 0 : 1} | ${row.timedOut ? 1 : 0} | ${row.pass} | ${row.fail} |\n`)
    if (json.length > 4096 || summary.length > 4096 || heldFiles.size) throw new Error("ci_envelope")
    for (const [name, buffer] of [["results.json", json], ["results-summary.md", summary]]) {
      if (!live()) return
      const file = path.join(repoRoot, name)
      let st
      try { st = await fs.promises.lstat(file) }
      catch (error) { if (error.code !== "ENOENT") throw error }
      if (!live()) return
      if (st && (!st.isFile() || st.isSymbolicLink())) throw new Error("ci_envelope")
      const handle = await fs.promises.open(file, "w")
      heldFiles.add(handle)
      if (!live()) return
      try {
        let at = 0
        while (at < buffer.length) {
          if (!live()) return
          const { bytesWritten } = await handle.write(buffer, at, buffer.length - at, at)
          if (!live()) return
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffer.length - at) {
            throw new Error("ci_envelope")
          }
          at += bytesWritten
        }
      } finally {
        if (live()) {
          await handle.close()
          heldFiles.delete(handle)
        }
      }
      if (!live()) return
    }
  }
  completion = createProductCompletion({ envelope: cliEnvelope, nowNs: () => process.hrtime.bigint(),
    counter, bytes, arm: setTimeout, disarm: clearTimeout, persist, terminate: (code) => process.exit(code) })
  try {
    if (!await completion.prepare()) return
    if (!live()) return
    await fs.promises.mkdir(isolation)
    if (!live()) return
    const child = spawn(process.execPath, ["--import", pathToFileURL(isolatedEnv).href, "--test", "--test-reporter=tap",
      `--test-name-pattern=^${NATIVE_TEST_NAME}$`, file], { cwd: mcpRoot, env, windowsHide: true })
    await completion.attach(child)
  } catch { completion.error() }
}

const runFile = (file) => new Promise((resolve) => {
  const started = Date.now()
  const child = spawn(process.execPath, [
    "--import", pathToFileURL(isolatedEnv).href, "--test", "--test-reporter=tap", file,
  ], { cwd: mcpRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, detached: process.platform !== "win32" })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  let timedOut = false
  let stuck = ""
  const timer = setTimeout(() => { timedOut = true; stuck = describeDescendants(child.pid); killTree(child.pid) }, timeoutMs)
  child.on("close", (code) => {
    clearTimeout(timer)
    const failed = [...output.matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)].map((m) => m[1])
    const count = (key) => Number(new RegExp(`^# ${key} (\\d+)`, "m").exec(output)?.[1] ?? 0)
    resolve({
      file: path.relative(testsRoot, file).split(path.sep).join("/"),
      exitCode: code, timedOut, ms: Date.now() - started,
      pass: count("pass"), fail: count("fail"), skipped: count("skipped"), failedTests: [...new Set(failed)],
      failures: failures(output),
      stuck, tail: timedOut ? output.slice(-2500) : "",
      // A file that exits non-zero with no failing assertion (a native abort) leaves its reason only in the raw output.
      outputTail: code !== 0 && !timedOut ? output.slice(-4000) : "",
      firstFailures: code === 0 ? "" : [...output.matchAll(/^\s*not ok \d+ - [\s\S]*?(?=^\s*(?:# Subtest|ok \d+|not ok \d+|1\.\.))/gm)].slice(0, 3).map((m) => m[0].slice(0, 1500)).join("\n----\n") || output.slice(-1500),
    })
  })
})

// How long Windows PowerShell and Desk's own ACL provider take here, because every protected write starts one.
const probeAcl = async () => {
  if (process.platform !== "win32") return null
  const timed = (fn) => { const t = Date.now(); const value = fn(); return [Date.now() - t, value] }
  const plain = Array.from({ length: 3 }, () => timed(() => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "1"], { encoding: "utf8" }).status)[0])
  const { protectWindowsPaths } = await import(pathToFileURL(path.join(mcpRoot, "src", "factory", "windows-acl.js")).href)
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), "acl-probe-"))
  const provider = []
  for (let i = 0; i < 3; i += 1) {
    const t = Date.now()
    try { await protectWindowsPaths([{ path: dir, kind: "directory", created: false }]); provider.push(Date.now() - t) } catch (error) { provider.push(`${Date.now() - t}ms ${error.message.slice(0, 200)}`) }
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return { powershellStartMs: plain, desk_acl_provider_ms: provider }
}
if (productMode && mine.length > 0) {
  if (mine.length !== 1) process.exit(1)
  await runProductFile(mine[0])
  process.exit(1)
}
const aclProbe = !productMode && args.includes("--probe-acl") ? await probeAcl() : null
console.log("acl probe:", JSON.stringify(aclProbe))

const results = []
for (const file of mine) {
  const result = await runFile(file)
  results.push(result)
  console.log(`${result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "ok     " : "FAIL   "} ${result.file} pass=${result.pass} fail=${result.fail} ${result.ms}ms`)
}
fs.writeFileSync(out, JSON.stringify({ shard: `${index}/${total}`, platform: process.platform, aclProbe, results }, null, 1))
const bad = results.filter((r) => r.exitCode !== 0)
const timeouts = results.filter((r) => r.timedOut)
const sum = (key) => results.reduce((n, r) => n + r[key], 0)
const summary = `files=${results.length} failing-files=${bad.length} timeouts=${timeouts.length} tests-pass=${sum("pass")} tests-fail=${sum("fail")}`
console.log(`\n${summary}`)
// Written beside the results; the workflow appends it to the job summary, because a standard user cannot write the runner's summary file.
const lines = [
  "| Files | Files with a failure | Timeouts | Tests passed | Tests failed |",
  "|---|---|---|---|---|",
  `| ${results.length} | ${bad.length} | ${timeouts.length} | ${sum("pass")} | ${sum("fail")} |`,
  "",
]
if (timeouts.length > 0) lines.push(`Timed out: ${timeouts.map((r) => `\`${r.file}\``).join(", ")}`, "")
fs.writeFileSync(out.replace(/\.json$/u, "") + "-summary.md", lines.join("\n") + "\n")
// The job result is the gate: any failing file, timeout or failed test makes it red. The results and summary are written first so a red job still shows what failed.
process.exit(bad.length > 0 || timeouts.length > 0 || sum("fail") > 0 ? 1 : 0)
