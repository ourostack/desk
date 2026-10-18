// Qualification harness only. No production mutations or f4 coordinator imports.
import "../_isolated_env.mjs"
import fs from "node:fs"
import { promises as io } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fork, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { moveArchive } from "../../../../../plugins/desk/mcp/src/tools/archive-move.js"
import { readMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { installCardGuard } from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"
import { openChangeJournal } from "../../../../../plugins/desk/mcp/src/readiness/journal.js"
import { factoryStateRoot } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { schedulePush as normalSchedulePush, runPushWorker } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { readOwnProcessStart, readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"

export const RUN = process.env.DESK_TEST_RUN_DIR
if (!RUN || !fs.existsSync(RUN)) throw new Error("Qualification requires the pre-created owned DESK_TEST_RUN_DIR")
export const ART = path.join(RUN, "archive-qualification")
fs.mkdirSync(ART, { recursive: true })
export const SLUG = "archive-proof"
export const RESOURCE = "branch:qualification/owned#retained-fixture"
export const digest = (value) => createHash("sha256").update(value).digest("hex")
export const exists = (file) => fs.existsSync(file)
export function record(type, detail = {}) {
  fs.appendFileSync(path.join(ART, `events-${process.pid}.jsonl`),
    JSON.stringify({ pid: process.pid, ...detail, type, at: new Date().toISOString() }) + "\n")
}
export const gitCalls = []
export async function ownIdentity() {
  return { pid: process.pid, exe: process.execPath, start: await readOwnProcessStart() }
}
export function realGit(file, args, options = {}) {
  if (file !== "git") throw new Error("Only normal fixture Git is admitted")
  if (args.some((arg) => ["push", "fetch", "pull", "clone", "ls-remote"].includes(arg))) {
    record("forbidden-network-command", { args })
    throw new Error("Qualification fixture must not execute network Git")
  }
  const began = process.hrtime.bigint().toString()
  const result = spawnSync(file, args, { ...options, timeout: Math.min(options.timeout || 5000, 5000) })
  const receipt = { pid: result.pid, exe: "git", args, status: result.status, signal: result.signal,
    spawnMonotonicNs: began, endMonotonicNs: process.hrtime.bigint().toString(), directlyWaited: true,
    error: result.error?.code ?? null }
  gitCalls.push(receipt)
  record("git-completed", receipt)
  return result
}
export function git(root, ...args) {
  const answer = realGit("git", ["-C", root, ...args], { encoding: "utf8" })
  if (answer.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${answer.stderr}`)
  return answer.stdout.trimEnd()
}
export function envFor(base, root) {
  const env = { ...process.env, DESK: root, XDG_STATE_HOME: path.join(base, "state") }
  // Same fixture-context exclusions as factory/_session_helpers.js. Never strip preloads.
  for (const name of ["DESK_ACTIVATION_CONFIG", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR", "CODEX_HOME", "DESK_PERSON", "CLAUDE_CONFIG_DIR"])
    delete env[name]
  return env
}
export function descriptor(base, root, person = null) {
  const prefix = person === null ? root : path.join(root, "desks", person)
  return { base, root, person, prefix, src: path.join(prefix, "t", SLUG),
    dst: path.join(prefix, "t", "_archive", SLUG), card: path.join(prefix, "t", SLUG, "task.md"),
    archived: path.join(prefix, "t", "_archive", SLUG, "task.md"),
    track: path.join(prefix, "t", "track.md"), env: envFor(base, root) }
}

const actors = new Set()
const workers = new Set()
const HELPER = fileURLToPath(import.meta.url)
function bounded(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
  })]).finally(() => clearTimeout(timer))
}
function next(actor, type) {
  const read = () => actor.messages.find((message) => message.type === type)
  if (read()) return Promise.resolve(read())
  if (actor.exit) return Promise.reject(new Error(`Actor ${actor.pid} exited before ${type}`))
  return bounded(new Promise((resolve, reject) => {
    const wake = () => {
      if (read()) { actor.waiters.delete(wake); resolve(read()) }
      else if (actor.exit) { actor.waiters.delete(wake); reject(new Error(`Actor ${actor.pid} exited before ${type}`)) }
    }
    actor.waiters.add(wake)
  }), 6000, `${actor.role}:${type}`)
}
export const actorMessage = next
export function send(actor, value) {
  if (actor.child.connected && !actor.exit) actor.child.send(value, (error) => {
    if (error) record("owned-pipe-send-error", { childPid: actor.pid, cmd: value.cmd, code: error.code })
  })
}
export function spawnActor(role, fixture, mode = "plain") {
  // Remove runner execution flags only. Preserve every --import and NODE_OPTIONS.
  const execArgv = process.execArgv.filter((arg) => arg !== "--test" && !arg.startsWith("--test-"))
  const child = fork(HELPER, [role, JSON.stringify({ base: fixture.base, root: fixture.root, person: fixture.person, mode })], {
    execArgv, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  const actor = { child, pid: child.pid, role, messages: [], waiters: new Set(), exit: null, stderr: "", stdout: "" }
  actors.add(actor)
  record("actor-born", { childPid: child.pid, role, exe: process.execPath,
    importCount: execArgv.filter((arg) => arg === "--import").length,
    helperArgPresent: child.spawnargs.includes(HELPER), fixture: fixture.root })
  child.stderr.on("data", (chunk) => { actor.stderr += String(chunk) })
  child.stdout.on("data", (chunk) => { actor.stdout += String(chunk) })
  child.on("message", (message) => {
    actor.messages.push(message)
    record("actor-message", { childPid: actor.pid, role, message })
    for (const wake of actor.waiters) wake()
  })
  actor.ended = new Promise((resolve) => child.once("exit", (code, signal) => {
    actor.exit = { code, signal, stderr: actor.stderr, stdout: actor.stdout }
    record("actor-ended", { childPid: actor.pid, role, ...actor.exit })
    for (const wake of actor.waiters) wake()
    resolve(actor.exit)
  }))
  actor.ready = (async () => {
    const hello = await next(actor, "hello")
    const independent = await readProcessStart(actor.pid)
    if (hello.pid !== actor.pid || hello.exe !== process.execPath || !hello.start || independent !== hello.start)
      throw new Error("Actor PID/start/exe ownership did not qualify")
    actor.identity = hello
    record("actor-identity", { childPid: actor.pid, ...hello, independentlyMatched: true })
    return actor
  })()
  return actor
}
export async function finishActor(actor) {
  if (actor.exit) return actor.exit
  send(actor, { cmd: "abort" })
  send(actor, { cmd: "finish" })
  // No name-based signals. The child's fixed self-lease is the final bound.
  return bounded(actor.ended, 22000, "graceful owned actor retirement")
}
export function scheduleFor(fixture) {
  return ({ root }) => normalSchedulePush({
    root, env: fixture.env, debounceMs: 0,
    spawnWorker() {
      const actor = spawnActor("push", fixture)
      const pending = (async () => {
        await actor.ready
        send(actor, { cmd: "start" })
        const outcome = await next(actor, "result")
        send(actor, { cmd: "finish" })
        const exit = await bounded(actor.ended, 5000, "normal push worker exit")
        if (outcome.error || exit.code !== 0 || !["skipped", "busy"].includes(outcome.result?.result))
          throw new Error(`No-remote normal push worker did not retire normally: ${JSON.stringify({ outcome, exit })}`)
        return { root: fixture.root, pid: actor.pid, result: outcome.result, exit }
      })()
      workers.add(pending)
      pending.catch((error) => record("owned-worker-rejected", { childPid: actor.pid, message: error.message }))
      // This is an actual spawned worker, not a fake scheduled/success result.
    },
  })
}
export async function drainActors() {
  const outcomes = await Promise.allSettled([...workers])
  const cleanup = await Promise.allSettled([...actors].filter((actor) => !actor.exit).map(finishActor))
  const failures = [...outcomes, ...cleanup].filter((item) => item.status === "rejected")
  if (failures.length) throw new AggregateError(failures.map((item) => item.reason), "Owned actor teardown failed")
  const completed = outcomes.map((item) => item.value)
  for (const item of completed) {
    if (item.result.result === "busy" && !completed.some((peer) => peer.root === item.root && peer.result.result === "skipped"))
      throw new Error(`A coalesced busy fixture worker has no qualified no-remote holder: ${item.pid}`)
  }
  return [...actors].map(({ pid, role, identity, exit }) => ({ pid, role, identity, exit }))
}
export function options(fixture, extra = {}) {
  return { deskRoot: fixture.root, person: fixture.person, env: fixture.env,
    spawnGit: realGit, schedulePush: scheduleFor(fixture), ...extra }
}
export async function openReadiness(fixture, name) {
  const journal = await openChangeJournal({ root: fixture.root, stateDir: path.join(fixture.base, `journal-${name}`) })
  return {
    journal,
    readiness: {
      async recordChange(change) {
        const row = await journal.appendChange(change)
        record("journal-durable-append", { root: fixture.root, row })
        return { recorded: true }
      },
      async markUncertain(reason) { record("readiness-mark-uncertain", { reason, root: fixture.root }) },
    },
  }
}
export async function fixture(name, { onGit = false, person = null, status = "processing", resource = false } = {}) {
  const base = path.join(RUN, "archive-cases", name)
  await io.mkdir(base, { recursive: true })
  const root = path.join(base, "desk")
  await io.mkdir(path.join(root, "_meta"), { recursive: true })
  await io.mkdir(path.join(root, "_archive"))
  const out = descriptor(base, root, person)
  record("fixture-owned", { name, base, root, person, onGit })
  await io.writeFile(path.join(root, "_meta", "fixture.md"), "Owned archive qualification fixture.\n")
  await io.writeFile(path.join(root, "proof.md"), "Owned non-code completion evidence.\n")
  await task_create(options(out, { input: { track: "t", slug: SLUG, title: "Archive proof", status,
    body: "## Outcome\n\nPreserve the real terminal record.\n\n## Progress log\n\n**Next step:** qualify archive.\n" } }))
  await io.writeFile(out.track,
    `---\nschema_version: 1\ntitle: Archive track\n---\n\n## Tasks\n\n| Slug | State | Repos | Tracker link | Doing doc |\n|---|---|---|---|---|\n| \`${SLUG}\` | ${status} | — | — | [task](${SLUG}/task.md) |\n`)
  await io.mkdir(path.dirname(out.dst), { recursive: true })
  await io.writeFile(path.join(out.src, "companion.txt"), "OWNED_TRACKED_BASE\n")
  if (resource) await task_update(options(out, { input: { track: "t", slug: SLUG, resource: { identity: RESOURCE, intended: "retain until qualification review" } } }))
  // Test-owned state only: no consent/config records are created or changed.
  out.factory = await factoryStateRoot(out.env, { deskRoot: root })
  if (onGit) {
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.name", "Owned archive fixture")
    git(root, "config", "user.email", "archive-qualification@example.invalid")
    git(root, "add", "--", "_meta", "proof.md", person ? "desks" : "t")
    git(root, "commit", "-q", "-m", "owned archive baseline")
    out.guard = installCardGuard(root, { spawnGit: realGit })
    if (!["installed", "current"].includes(out.guard.state)) throw new Error(`Real card guard did not install: ${JSON.stringify(out.guard)}`)
    if (git(root, "remote") !== "") throw new Error("Fixture unexpectedly has a remote")
  }
  return out
}
export async function requests(fixture) {
  const result = {}
  for (const name of ["finalize", "evaluate-requests"]) {
    const dir = path.join(fixture.factory, name)
    const names = exists(dir) ? (await io.readdir(dir)).filter((value) => value.endsWith(".json")).sort() : []
    result[name] = await Promise.all(names.map(async (name) => {
      const file = path.join(dir, name)
      const text = await io.readFile(file, "utf8")
      return { name, digest: digest(text), mtimeNs: String((await io.stat(file, { bigint: true })).mtimeNs),
        record: JSON.parse(text) }
    }))
  }
  return result
}
export async function complete(fixture, readiness) {
  return task_update(options(fixture, { readiness, input: { track: "t", slug: SLUG, status: "done",
    evidence: { kind: "non_code", ref: "proof.md" }, note: "Owned outcome delivered; acceptance is still pending." } }))
}
export const readCard = (file) => readMarkdown(file)
export function errorData(error) {
  return { name: error.name, message: error.message, code: error.code ?? null, path: error.path ?? null,
    actual_path: error.actual_path ?? null, phase: error.archive_phase ?? error.phase ?? null }
}

if (process.argv[1] === HELPER) {
  const role = process.argv[2]
  const config = JSON.parse(process.argv[3])
  const owned = descriptor(config.base, config.root, config.person)
  const inbox = []
  const wake = new Set()
  process.on("message", (message) => { inbox.push(message); for (const notify of wake) notify() })
  const take = (cmd) => {
    const read = () => inbox.find((message) => message.cmd === cmd || message.cmd === "abort")
    if (read()) return Promise.resolve(read())
    return new Promise((resolve) => {
      const notify = () => { if (read()) { wake.delete(notify); resolve(read()) } }
      wake.add(notify)
    })
  }
  const sendMessage = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()))
  const lease = setTimeout(() => { record("actor-lease-expired", { role }); process.exit(124) }, 20000)
  lease.unref()
  await sendMessage({ type: "hello", pid: process.pid, exe: process.execPath, start: await readOwnProcessStart(),
    role, importCount: process.execArgv.filter((arg) => arg === "--import").length,
    nodeOptionsPresent: Object.hasOwn(process.env, "NODE_OPTIONS") })
  const start = await take("start")
  let result
  let failure
  let reader
  let renameReturned = false
  try {
    if (start.cmd === "abort") throw new Error("Owned qualification aborted before action")
    if (role === "push") result = await runPushWorker({ root: owned.root, env: owned.env, debounceMs: 0, spawnGit: realGit })
    else {
      reader = await openReadiness(owned, `actor-${process.pid}`)
      const qualifiedMove = async (source, destination, atUse) => {
        const nativeMove = await moveArchive(source, destination, async () => {
          await atUse()
          if (config.mode !== "plain") {
            await sendMessage({ type: "rename-barrier", source, destination, gitCallsBeforeRename: gitCalls.length })
            const command = await take("go")
            if (command.cmd === "abort") throw new Error("Owned qualification aborted at pre-rename barrier")
          }
        })
        if (nativeMove) record("native-move-returned", nativeMove)
        renameReturned = true
        if (config.mode === "exit-after-rename") {
          const receipt = { pid: process.pid, exe: process.execPath, source, destination,
            actualDestination: fs.realpathSync(destination), gitCallsBeforeExit: gitCalls.length,
            gitPublicationCallsBeforeExit: gitCalls.filter((call) =>
              ["add", "commit", "update-index", "update-ref", "read-tree", "mv", "reset", "checkout", "switch", "merge", "rebase", "stash"].includes(call.args[2]) ||
              (call.args[2] === "hash-object" && call.args.includes("-w"))).length,
            cardHash: digest(fs.readFileSync(path.join(destination, "task.md"))), exitCode: 37 }
          fs.writeFileSync(path.join(owned.base, "crash-after-rename.json"), JSON.stringify(receipt, null, 2) + "\n")
          record("intentional-exit-after-actual-rename", receipt)
          process.exit(37)
        }
      }
      result = await task_archive(options(owned, { readiness: reader.readiness, input: { track: "t", slug: SLUG }, moveArchive: qualifiedMove }))
    }
  } catch (error) { failure = errorData(error) }
  finally {
    if (reader) await reader.journal.close()
  }
  await sendMessage({ type: "result", result: result ?? null, error: failure ?? null, renameReturned })
  await take("finish")
  await drainActors()
  clearTimeout(lease)
  process.disconnect()
}
