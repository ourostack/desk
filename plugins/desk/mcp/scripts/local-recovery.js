#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process"
import { realpathSync, statSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveStartupStateBranch } from "../src/runtime/startup-resolve.js"
import { redactCredentialLikeText } from "../src/util/redact.js"

const OPERATIONS = new Set(["task_update", "task_create", "task_archive", "desk_save"])
const FLAGS = new Set(["--root", "--operation", "--input-file", "--person", "--activation-config", "--state-branch"])
const BOOTSTRAP = fileURLToPath(new URL("../bootstrap.cjs", import.meta.url))

function failure(code) {
  return Object.assign(new Error(code), { code })
}

function argumentsFor(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (!FLAGS.has(flag) || !argv[i + 1] || argv[i + 1].startsWith("--") || options[flag] !== undefined) {
      throw failure("invalid_arguments")
    }
    options[flag] = argv[i + 1]
  }
  if (!options["--root"] || !OPERATIONS.has(options["--operation"])) throw failure("invalid_arguments")
  return options
}

async function readInput(input, deadline) {
  let text = ""
  const timer = setTimeout(() => input.destroy(failure("timeout")), Math.max(1, deadline - Date.now()))
  try {
    for await (const chunk of input) {
      text += chunk.toString("utf8")
      if (Buffer.byteLength(text) > 1024 * 1024) throw failure("input_too_large")
    }
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
  let broken = null
  const pending = new Map()
  const fail = (code) => {
    broken = failure(code)
    for (const waiter of pending.values()) waiter.reject(broken)
  }
  transport.input.on("error", () => fail("transport_error"))
  transport.output.on("error", () => fail("transport_error"))
  transport.output.on("end", () => fail("transport_closed"))
  transport.closed?.then(() => fail("transport_closed"))
  transport.output.on("data", (chunk) => {
    buffered += chunk.toString("utf8")
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
    async request(method, params) {
      if (Date.now() >= deadline) throw failure("timeout")
      const id = ++sequence
      let timer
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(failure("timeout")), Math.max(1, deadline - Date.now()))
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

/** One mutation at most, through the ordinary MCP bootstrap and admission. */
export async function runRecovery({
  argv = process.argv.slice(2), env = process.env, cwd = process.cwd(),
  input = process.stdin, launch = launchBootstrap, timeoutMs = 60000,
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
  const deadline = Date.now() + timeoutMs
  try {
    const options = argumentsFor(argv)
    report.operation = options["--operation"]
    report.requestedRoot = path.resolve(cwd, options["--root"])
    let root
    try {
      root = realpathSync(report.requestedRoot)
      if (!statSync(root).isDirectory()) throw failure("root_unavailable")
    } catch { throw failure("root_unavailable") }
    report.requestedRoot = root
    if (env.DESK_TOOL_COMMIT !== undefined) throw failure("commit_override_refused")
    const serverArgs = ["--root", root]
    for (const flag of ["--person", "--activation-config", "--state-branch"]) {
      if (options[flag]) serverArgs.push(flag, options[flag])
    }
    if (options["--state-branch"]) {
      let declared
      try {
        declared = resolveStartupStateBranch({
          args: { activationConfig: options["--activation-config"] }, env, cwd,
        })
      } catch { throw failure("activation_unavailable") }
      if (declared !== options["--state-branch"]) throw failure("state_branch_not_declared")
    }
    let text
    if (options["--input-file"]) {
      try {
        const file = path.resolve(cwd, options["--input-file"])
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
          (options["--person"] && scope.person !== options["--person"])
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
    const response = await client.request("tools/call", { name: report.operation, arguments: payload })
    const result = toolPayload(response)
    report.result = redact(result, payload)
    report.git.headAfter = gitHead(root, env)
    if (response.isError || result.status === "error") throw failure("tool_error")
    if (!["updated", "created", "archived", "already_archived", "committed", "nothing_to_commit"].includes(result.status)) {
      throw failure("unexpected_tool_result")
    }
    report.effects.mutation = ["nothing_to_commit", "already_archived"].includes(result.status)
      ? "reported_complete" : "reported_applied"
    report.effects.commit = result.commit?.status === "failed" ? "failed"
      : report.git.headBefore !== null && report.git.headAfter !== null
        ? report.git.headBefore !== report.git.headAfter ? "observed" : "not_observed"
        : "unknown"
    report.effects.push = status.sync === "no remote configured" ? "not_applicable" : "pending"
    const commitExpected = ["updated", "created", "archived", "committed"].includes(result.status)
    if (report.effects.commit === "failed" || report.effects.push === "pending" ||
        (commitExpected && report.effects.commit !== "observed")) {
      report.status = "partial"
      report.code = report.effects.commit === "failed" ? "commit_failed"
        : report.effects.push === "pending" ? "push_pending" : "commit_not_observed"
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
  const { exitCode, report } = await runRecovery()
  process.stdout.write(JSON.stringify(report) + "\n")
  process.exitCode = exitCode
}
