// One fetch job's Git subprocess scope. The controller's IPC disconnect is a cancellation, not permission to leave Git running.
import fs from "node:fs"
import { spawn } from "node:child_process"
import { performance } from "node:perf_hooks"
import { killProcessGroup } from "./git-inspection.js"

let job, end, timer, child, command, closing = false, reason = null, escalation
const writeWitness = closed => {
  const bytes = Buffer.from(JSON.stringify({ operationId: job.operationId, token: job.token, helperPid: process.pid, closed, reason }) + "\n")
  fs.writeSync(4, bytes, 0, bytes.length, 0)
  fs.ftruncateSync(4, bytes.length)
  fs.fsyncSync(4)
}
const send = value => { if (process.connected) process.send(value) }
function finish() {
  if (child) return
  clearTimeout(timer); clearTimeout(escalation)
  writeWitness(true)
  send({ type: "closed", reason })
  if (process.connected) process.disconnect()
}
function stop(why) {
  reason ??= why
  closing = true
  if (child && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGTERM") } catch (error) { if (error.code !== "ESRCH") throw error }
    escalation ??= setTimeout(() => { if (child) killProcessGroup(child) }, 200)
  } else finish()
}
process.on("disconnect", () => { if (job) stop("controller_exit") })
process.on("SIGTERM", () => { if (job) stop("helper_terminated") })
process.on("message", message => {
  if (message.type === "init" && !job) {
    job = message
    end = performance.now() + job.remainingMs
    writeWitness(false)
    timer = setTimeout(() => stop("whole_job_deadline"), Math.max(1, job.remainingMs - 600))
    send({ type: "ready" })
    return
  }
  if (!job) return
  if (message.type === "finish" || message.type === "stop") { stop(message.reason ?? "finished"); return }
  if (message.type !== "git" || child || closing) return
  if (!Array.isArray(message.args) || !message.args.every(arg => typeof arg === "string" && !arg.includes("\0")) ||
      message.args.join("").length > 65536) { stop("invalid_command"); return }
  const available = end - performance.now() - 600
  if (available <= 0) { stop("whole_job_deadline"); return }
  command = message
  let stdout = "", stderr = "", frame = "", previous = "", lastProgress = performance.now()
  let failure
  const limit = Math.min(available, message.timeoutMs ?? available)
  const commandTimer = setTimeout(() => { failure = "whole_job_deadline"; stop(failure) }, limit)
  // The native per-file limit bounds pack/index/reverse-index storage, including children. No shell text comes from the repository.
  child = spawn("/bin/sh", ["-c", 'ulimit -f "$1" || exit 125; shift; exec "$@"', "desk-fetch", String(job.fileBlocks), job.git, "-C", message.cwd, ...message.args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  })
  send({ type: "child", pid: child.pid, phase: message.phase })
  const progressTimer = message.phase === "fetch" ? setInterval(() => {
    if (performance.now() - lastProgress >= job.progressTimeoutMs) { failure = "progress_observation_expired"; stop(failure) }
  }, 100) : null
  child.stdout.on("data", data => {
    stdout += data.toString("utf8")
    if (Buffer.byteLength(stdout) > 1024 * 1024) { failure = "output_capacity"; stop(failure) }
  })
  child.stderr.on("data", data => {
    const text = data.toString("utf8")
    stderr = (stderr + text).slice(-32768)
    frame += text
    const lines = frame.split(/[\r\n]/u)
    frame = lines.pop().slice(-1024)
    for (const line of lines) {
      const match = /(?:Receiving objects|Resolving deltas):\s*(\d+)% \((\d+)\/(\d+)\)(?:,\s*([\d.]+)\s*(bytes|KiB|MiB|GiB))?/u.exec(line)
      const remote = /remote: (?:Enumerating|Counting|Compressing) objects:\s*(\d+)/u.exec(line)
      if ((match || remote) && line !== previous) {
        previous = line
        lastProgress = performance.now()
        send({ type: "progress", phase: /Receiving/u.test(line) ? "receiving" : match ? "resolving" : "remote_preparation",
          completed: Number(match?.[2] ?? remote[1]), total: match ? Number(match[3]) : null,
          bytes: match?.[4] ? Math.ceil(Number(match[4]) * ({ bytes: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 })[match[5]]) : null })
      }
    }
  })
  child.on("error", () => { failure = "git_spawn_failed" })
  child.on("close", (code, signal) => {
    clearTimeout(commandTimer); clearInterval(progressTimer); clearTimeout(escalation); escalation = null
    child = null
    send({ type: "result", id: command.id, code, signal, stdout, stderr,
      reason: failure ?? (closing ? reason : signal === "SIGXFSZ" || /File too large|signal 25/u.test(stderr) ? "storage_limit" : null) })
    if (closing) finish()
  })
})
