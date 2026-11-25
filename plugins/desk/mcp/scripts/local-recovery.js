#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process"
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, statSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveStartupStateBranch } from "../src/runtime/startup-resolve.js"
import { redactCredentialLikeText } from "../src/util/redact.js"
import { TOOL_COMMIT_ENV } from "../src/desk/card-commit-guard.js"
import { defineCli, defineCommand, parse } from "../src/lib/ouro-ui/registry/ouro/ax/ax-command.ts"
import { runCli } from "../src/lib/ouro-ui/registry/ouro/ax/cli.ts"

const BOOTSTRAP = fileURLToPath(new URL("../bootstrap.cjs", import.meta.url))

function failure(code) {
  return Object.assign(new Error(code), { code })
}

const FLAGS = {
  root: { type: "string", required: true, description: "The Desk root the mutation is for." },
  operation: { type: "enum", required: true, values: ["task_update", "task_create", "task_archive", "desk_save"], description: "The Desk tool to run once." },
  "input-file": { type: "string", description: "A JSON file holding the tool's input, instead of stdin." },
  person: { type: "string", description: "The person whose desk the write must land in." },
  "activation-config": { type: "string", description: "The activation config that declares the state branch." },
  "state-branch": { type: "string", description: "The state branch the activation config declares." },
  publication: { type: "enum", values: ["deferred"], description: "deferred leaves the push for later." },
}

// A protocol command: stdout is one JSON report another program reads, with the report's own exit code (0 completed, 1 refused, 2 partial or unknown).
function recoveryCli(run) {
  return defineCli({
    name: "local-recovery",
    about: ["Runs one Desk mutation (a task update, create or archive, or a save) through the ordinary MCP bootstrap and prints a JSON report of what was and was not done; the tool's input is JSON on stdin."],
    command: defineCommand({ name: "local-recovery", summary: "Run one Desk mutation and report it.", effect: "private", protocol: true, output: "one JSON report", flags: FLAGS, text: (report) => JSON.stringify(report), run }),
  })
}

function argumentsFor(argv) {
  let parsed
  try { parsed = parse(recoveryCli(), argv) } catch { throw failure("invalid_arguments") }
  // An empty --person would otherwise read as no person at all, a wider scope than the caller named.
  if (parsed.kind !== "run" || Object.values(parsed.input).some((value) => value === "")) throw failure("invalid_arguments")
  return parsed.input
}

async function readInput(input, deadline) {
  let text = ""
  let bytes = 0
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const timer = setTimeout(() => input.destroy(failure("timeout")), Math.max(1, deadline - Date.now()))
  try {
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > 1024 * 1024) throw failure("input_too_large")
      try { text += decoder.decode(buffer, { stream: true }) } catch { throw failure("invalid_utf8") }
    }
    try { text += decoder.decode() } catch { throw failure("invalid_utf8") }
    return text
  } finally {
    clearTimeout(timer)
  }
}

// The bootstrap, not this client, chooses a compatible Node and restores the
// runtime. Payloads go through stdin; child stderr is never copied into output.
export function launchBootstrap({ argv, env, cwd, spawnChild = spawn, shutdownMs = 5000 }) {
  const child = spawnChild(process.execPath, [BOOTSTRAP, ...argv], { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  child.stderr.resume()
  let exited = false
  const closed = new Promise((resolve) => {
    child.once("exit", () => { exited = true; resolve() })
    child.once("error", () => { exited = true; resolve() })
  })
  return {
    input: child.stdin,
    output: child.stdout,
    pid: child.pid,
    closed,
    async close() {
      child.stdin.end()
      const wait = async (ms) => {
        let timer
        await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, ms) })])
        clearTimeout(timer)
      }
      await wait(shutdownMs)
      if (!exited) child.kill("SIGTERM")
      await wait(shutdownMs)
      if (!exited) throw failure("child_shutdown_unknown")
    },
  }
}

function protocol(transport, deadline) {
  let sequence = 0
  let buffered = ""
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let broken = null
  const pending = new Map()
  const fail = (code) => {
    broken = failure(code)
    for (const waiter of pending.values()) waiter.reject(broken)
  }
  transport.input.on("error", () => fail("transport_error"))
  transport.output.on("error", () => fail("transport_error"))
  transport.output.on("end", () => {
    try { buffered += decoder.decode() } catch { fail("protocol_parse_error"); return }
    fail("transport_closed")
  })
  transport.closed?.then(() => fail("transport_closed"))
  transport.output.on("data", (chunk) => {
    try { buffered += decoder.decode(Buffer.from(chunk), { stream: true }) } catch { fail("protocol_parse_error"); return }
    if (Buffer.byteLength(buffered) > 4 * 1024 * 1024) return fail("protocol_parse_error")
    let newline
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { fail("protocol_parse_error"); return }
      if (message?.jsonrpc !== "2.0") { fail("protocol_parse_error"); return }
      const waiter = pending.get(message.id)
      if (!waiter) continue
      if (message.error) waiter.reject(failure("protocol_error"))
      else if (message.result === undefined) waiter.reject(failure("protocol_parse_error"))
      else waiter.resolve(message.result)
    }
  })
  function send(message) {
    if (broken) throw broken
    transport.input.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
  }
  return {
    notify(method) { send({ method }) },
    async request(method, params, until = deadline) {
      if (Date.now() >= until) throw failure("timeout")
      const id = ++sequence
      let timer
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(failure("timeout")), Math.max(1, until - Date.now()))
          pending.set(id, { resolve, reject })
          try { send({ id, method, params }) } catch (error) { reject(error) }
        })
      } finally {
        clearTimeout(timer)
        pending.delete(id)
      }
    },
  }
}

function toolPayload(response) {
  try {
    const text = response.content.find((item) => item.type === "text")?.text
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw failure("tool_parse_error")
    return parsed
  } catch {
    throw failure("tool_parse_error")
  }
}

function redact(value, input) {
  const strings = []
  function collect(item) {
    if (typeof item === "string" && item.length) strings.push(item)
    else if (item && typeof item === "object") Object.values(item).forEach(collect)
  }
  collect(input)
  // JSON encoding also covers escaped input in JSON strings embedded in errors.
  const needles = [...new Set(strings.flatMap((text) => [text, JSON.stringify(text).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length)
  function visit(item) {
    if (typeof item === "string") {
      for (const needle of needles) item = item.split(needle).join("[input redacted]")
      return redactCredentialLikeText(item)
    }
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, visit(val)]))
    return item
  }
  return visit(value)
}

function gitHead(root, env) {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root, env, encoding: "utf8", timeout: 5000, windowsHide: true,
  })
  return result.status === 0 ? result.stdout.trim() : null
}

// The qualified namespace of one log: the root and every directory below it down to the leaf, each by exact (dev, ino). Any symbolic link, non-directory parent or non-regular leaf, and a root that is not its own real path, disqualifies it.
function qualifyLog(root, rel) {
  try {
    if (realpathSync(root) !== path.resolve(root)) return null
    const identity = (stat) => ({ dev: stat.dev, ino: stat.ino })
    const chain = []
    let current = path.resolve(root)
    const parts = rel.split(/[\\/]/u)
    for (const [index, part] of [null, ...parts].entries()) {
      if (part !== null) current = path.join(current, part)
      const stat = lstatSync(current, { bigint: true })
      const last = index === parts.length
      if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory())) return null
      chain.push(identity(stat))
    }
    return { file: current, chain }
  } catch { return null }
}
const sameChain = (a, b) => a.chain.length === b.chain.length && a.chain.every((entry, i) => entry.dev === b.chain[i].dev && entry.ino === b.chain[i].ino)

// A queued log is already in the working tree. It counts as committed only when the working file, hashed with the path's own Git filters (EOL included), is the very blob `head` holds at that path. Status flags such as assume-unchanged cannot hide a difference from that comparison, and every path is literal. A path Git neither tracks at `head` nor lists as indexed or untracked (missing, ignored) stays unknown; that listing reads names only, never the file's bytes, and runs only through a qualified namespace.
// Acquisition: the qualified namespace is walked, the leaf opened with O_NOFOLLOW, and the descriptor must be the walked leaf (exact bigint dev/ino) and the walk must repeat unchanged BEFORE Git is handed the descriptor, and again after. Git then reads that descriptor; `--path` only supplies the logical attribute/filter context. This pins what is hashed to the object the qualified path named; it does not keep the namespace unchanged while reading, and Node has no race-free openat. It observes content at `head`; it does not attribute who wrote it. `probe` is a test seam between the steps.
export function logCommitState(root, env, rel, head, probe = {}) {
  if (typeof rel !== "string" || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/u).includes("..") || !head) return "unknown"
  const git = (args, stdio) => spawnSync("git", ["--literal-pathspecs", ...args], { cwd: root, env, encoding: "utf8", timeout: 5000, windowsHide: true, ...(stdio ? { stdio } : {}) })
  const first = qualifyLog(root, rel)
  const blob = git(["rev-parse", "--verify", `${head}:${rel}`])
  if (blob.status !== 0) {
    // Not at `head`: only the names Git lists (index entries, untracked non-ignored files) are consulted, never the file's bytes, and only through a namespace that qualified before and still does after.
    if (first === null) return "unknown"
    probe.afterWalk?.()
    const listed = git(["ls-files", "--cached", "--others", "--exclude-standard", "--", rel])
    const again = qualifyLog(root, rel)
    return listed.status === 0 && listed.stdout.trim() !== "" && again !== null && sameChain(first, again) ? "pending" : "unknown"
  }
  if (first === null) return "unknown"
  probe.afterWalk?.()
  let fd
  try {
    fd = openSync(first.file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const opened = fstatSync(fd, { bigint: true })
    const leaf = first.chain.at(-1)
    if (!opened.isFile() || opened.dev !== leaf.dev || opened.ino !== leaf.ino) return "unknown"
    probe.afterOpen?.()
    const again = qualifyLog(root, rel)
    if (again === null || !sameChain(first, again)) return "unknown"
    const working = git(["hash-object", `--path=${rel}`, "--stdin"], [fd, "pipe", "pipe"])
    probe.afterHash?.()
    const after = fstatSync(fd, { bigint: true })
    const last = qualifyLog(root, rel)
    if (working.status !== 0 || last === null || !sameChain(first, last)
      || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) return "unknown"
    return working.stdout.trim() === blob.stdout.trim() ? "committed" : "pending"
  } catch { return "unknown" } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** One mutation at most, through the ordinary MCP bootstrap and admission. */
export async function runRecovery({
  argv = process.argv.slice(2), options, env = process.env, cwd = process.cwd(),
  input = process.stdin, launch = launchBootstrap, timeoutMs = 60000, dispatchTimeoutMs = 60000, totalTimeoutMs = 100000,
} = {}) {
  const report = {
    operation: null, requestedRoot: null, actualRoot: null,
    status: "refused", code: null, result: null,
    preflight: null,
    transport: null,
    effects: { mutation: "not_dispatched", commit: "not_dispatched", push: "not_dispatched" },
    git: { headBefore: null, headAfter: null },
    readback: "In requestedRoot, read the exact card/files named in the original JSON. Run git status --short, git rev-parse HEAD, git log -1 --name-status, and git rev-list --left-right --count HEAD...@{upstream} (if configured). Do not retry an uncertain mutation before this readback.",
  }
  let transport
  let payload
  let exitCode = 1
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  // The whole run ends within totalTimeoutMs, so it prints its report before a 120 s command limit (Claude Code's default) kills it.
  const totalDeadline = startedAt + totalTimeoutMs
  try {
    options ??= argumentsFor(argv)
    report.operation = options["operation"]
    report.requestedRoot = path.resolve(cwd, options["root"])
    let root
    try {
      root = realpathSync(report.requestedRoot)
      if (!statSync(root).isDirectory()) throw failure("root_unavailable")
    } catch { throw failure("root_unavailable") }
    report.requestedRoot = root
    if (env[TOOL_COMMIT_ENV] !== undefined) throw failure("commit_override_refused")
    const serverArgs = ["--root", root]
    for (const flag of ["person", "activation-config", "state-branch", "publication"]) {
      if (options[flag]) serverArgs.push(`--${flag}`, options[flag])
    }
    if (options["state-branch"]) {
      let declared
      try {
        declared = resolveStartupStateBranch({
          args: { activationConfig: options["activation-config"] }, env, cwd,
        })
      } catch { throw failure("activation_unavailable") }
      if (declared !== options["state-branch"]) throw failure("state_branch_not_declared")
    }
    let text
    if (options["input-file"]) {
      try {
        const file = path.resolve(cwd, options["input-file"])
        if (statSync(file).size > 1024 * 1024) throw failure("input_too_large")
        text = await fs.readFile(file, "utf8")
      } catch { throw failure("input_file_unavailable") }
    } else text = await readInput(input, deadline)
    try {
      payload = JSON.parse(text)
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw failure("invalid_json")
    } catch { throw failure("invalid_json") }

    const sessionStartedAt = Date.now()
    transport = await launch({ argv: serverArgs, env: { ...env }, cwd })
    report.transport = { pid: transport.pid ?? null, shutdown: "open" }
    const client = protocol(transport, deadline)
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "desk-local-recovery", version: "1" } })
    client.notify("notifications/initialized")
    const catalog = await client.request("tools/list")
    if (!catalog.tools?.some((tool) => tool.name === report.operation)) throw failure("operation_unavailable")
    let status
    let scope
    for (;;) {
      const response = await client.request("tools/call", { name: "desk_status", arguments: { detail: true } })
      status = toolPayload(response)
      report.actualRoot = status.root?.path ?? null
      if (report.actualRoot !== null) {
        let actual
        try { actual = realpathSync(report.actualRoot) } catch { throw failure("actual_root_unavailable") }
        report.actualRoot = actual
        if (actual !== root) throw failure("root_mismatch")
      }
      if (response.isError || (status.state && status.state !== "admitting" && status.state !== "ready")) {
        report.result = redact(status, payload)
        throw failure("admission_refused")
      }
      if (status.status_error) {
        report.result = redact(status, payload)
        throw failure("status_unavailable")
      }
      if (status.state === "ready" && !status.detail_pending) {
        // This client owns a new server, so its cache cannot establish a
        // destination from an older host session. Keep the timestamp evidence.
        if (status.status_detail &&
            !(Date.parse(status.status_detail_from) >= sessionStartedAt)) {
          report.result = redact(status, payload)
          throw failure("status_stale")
        }
        if (!status.root?.valid || report.actualRoot !== root) throw failure("actual_root_unavailable")
        scope = status.write_scope
        const scopeMismatch = !scope || (scope.mode !== "workspace" && scope.mode !== "person") ||
          (scope.mode === "workspace" && (scope.person !== null || scope.relative_path !== ".")) ||
          (scope.mode === "person" && (!scope.person || scope.relative_path !== `desks/${scope.person}`)) ||
          (options["person"] && scope.person !== options["person"])
        if (!scopeMismatch) break
        if (!status.status_detail) throw failure("scope_mismatch")
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
    }
    report.preflight = {
      statusDetail: status.status_detail ? "cached_in_owned_session" : "current",
      statusDetailFrom: status.status_detail_from ?? null,
      writeScope: scope,
    }

    report.git.headBefore = gitHead(root, env)
    report.effects = { mutation: "unknown", commit: "unknown", push: "unknown" }
    // The dispatched call gets its own budget from the moment it is sent, so a slow startup cannot spend it, capped by the whole run's
    // deadline. With the defaults the preflight ends within 60 s, so the write always has at least 40 s.
    const response = await client.request("tools/call", { name: report.operation, arguments: payload }, Math.min(Date.now() + dispatchTimeoutMs, totalDeadline))
    const result = toolPayload(response)
    report.result = redact(result, payload)
    // Only an admitted queued log is accepted; a bare "logged" without it stays unexpected.
    const queuedPath = result.status === "logged" && result.commit === "queued" ? result.path
      : result.status === "updated" && result.log?.commit === "queued" ? result.log.path : null
    report.git.headAfter = gitHead(root, env)
    const logState = queuedPath === null ? null : logCommitState(root, env, queuedPath, report.git.headAfter)
    if (response.isError || result.status === "error") throw failure("tool_error")
    if (!["logged", "updated", "created", "archived", "already_archived", "committed", "nothing_to_commit", "commit_failed", "commit_unknown"].includes(result.status) || (result.status === "logged" && queuedPath === null)) {
      throw failure("unexpected_tool_result")
    }
    report.effects.mutation = ["nothing_to_commit", "already_archived"].includes(result.status)
      ? "reported_complete" : "reported_applied"
    const headChanged = report.git.headBefore !== null && report.git.headAfter !== null && report.git.headBefore !== report.git.headAfter
    const logOnly = result.status === "logged"
    if (queuedPath !== null) {
      report.effects.log = logState === "pending" ? "queued" : logState === "committed" && headChanged ? "observed" : "unknown"
      report.queued = { path: queuedPath, state: logState, committer: options["publication"] === "deferred" ? "next_session_start" : "background_worker" }
    }
    report.effects.commit = logOnly ? report.effects.log
      : result.commit?.status === "failed" ? "failed"
      : result.commit?.status === "unknown" ? "unknown"
      : report.git.headBefore !== null && report.git.headAfter !== null
        ? report.git.headBefore !== report.git.headAfter ? "observed" : "not_observed"
        : "unknown"
    report.effects.push = status.sync === "no remote configured" ? "not_applicable" : options["publication"] === "deferred" ? "deferred" : "pending"
    const commitExpected = ["updated", "created", "archived", "committed"].includes(result.status) || (logOnly && logState === "committed")
    const logPending = report.effects.log === "queued"
    if (report.effects.log === "unknown") {
      report.readback = `The entry at ${queuedPath} was reported written, but Git does not show it committed or pending. Do not resend it: that may duplicate the entry. Read that path first. ${report.readback}`
    }
    if (logPending) {
      // --publication deferred schedules no background worker, so nothing in this run will commit the entry.
      const who = report.queued.committer === "background_worker" ? "its commit is pending in Desk's background writer"
        : "publication is deferred, so no background commit is scheduled: the next Desk session start commits it, or commit that path yourself"
      report.readback = `Entry written to ${queuedPath}; ${who}. Do not resend it: that would duplicate the entry. ${report.readback}`
    }
    if (report.effects.commit === "failed" || result.commit?.status === "unknown" || report.effects.push === "pending" || logPending ||
        report.effects.log === "unknown" || (commitExpected && report.effects.commit !== "observed")) {
      report.status = "partial"
      report.code = report.effects.commit === "failed" ? "commit_failed"
        : result.commit?.status === "unknown" ? "commit_unknown"
        : commitExpected && report.effects.commit !== "observed" ? "commit_not_observed"
        : logPending ? "commit_queued"
        : report.effects.log === "unknown" ? "log_evidence_unknown"
        : "push_pending"
      exitCode = 2
    } else {
      report.status = "completed"
      report.code = "tool_completed"
      exitCode = 0
    }
  } catch (error) {
    report.code = error.code ?? "recovery_error"
    report.status = report.effects.mutation === "not_dispatched" ? "refused" : "unknown"
    exitCode = report.effects.mutation === "not_dispatched" ? 1 : 2
  } finally {
    if (transport) {
      try {
        await transport.close()
        report.transport.shutdown = "closed"
      } catch {
        report.transport.shutdown = "unknown"
        report.status = report.effects.mutation === "not_dispatched" ? "refused" : "partial"
        report.code = "child_shutdown_unknown"
        exitCode = report.effects.mutation === "not_dispatched" ? 1 : 2
      }
    }
  }
  return { exitCode, report }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let recovered
  const cli = recoveryCli(async (options) => (recovered = await runRecovery({ options })).report)
  const code = await runCli(cli, process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, { env: process.env })
  process.exitCode = recovered?.exitCode ?? code
}
