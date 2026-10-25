// Handshake first, then admission: one spawned Desk per injected condition from the always-on investigation (§3e).
//
// Each case starts index.js over stdio with a temporary HOME, a temporary desk that is a Git clone of a temporary origin, and a lexical-only activation config. It asserts the handshake completes within 3 s with the full tool list, then that desk_status settles on the expected state, that reads and writes are gated the way that state allows, and that safe repairs happen with their one-line report.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { once } from "node:events"
import * as net from "node:net"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { TOOL_NAMES } from "../../../../../plugins/desk/mcp/src/tool-names.js"
import { controllerIdentity, deriveControllerEndpoint } from "../../../../../plugins/desk/mcp/src/readiness/identity.js"
import { readinessContracts } from "../../../../../plugins/desk/mcp/src/server.js"
import { killAndWait } from "../_kill_and_wait.js"
import {
  HANDSHAKE_BUDGET_MS, git, lastStartUntil, makeGitDesk, sessionBuild, settled, startDesk, writeActivation, writeFile,
} from "./_admission_fixtures.js"

const posixOnly = process.platform === "win32" ? "unix sockets and file modes are POSIX-only" : false

function assertHandshake(session) {
  assert.ok(session.handshakeMs < HANDSHAKE_BUDGET_MS, `handshake took ${session.handshakeMs} ms`)
  assert.equal(session.initialize.result.serverInfo.name, "desk-mcp")
  assert.deepEqual(session.initialize.result.capabilities, { tools: { listChanged: true } })
  assert.deepEqual(session.tools.result.tools.map((tool) => tool.name), TOOL_NAMES)
}

async function withDesk(t, fixture, options, run) {
  const session = await startDesk(fixture, options)
  t.after(() => session.close())
  assertHandshake(session)
  return run(session)
}

async function assertReadsServeDirectly(session) {
  const search = await session.call("desk_search", { query: "lighthouse" })
  assert.equal(search.isError, false, JSON.stringify(search.payload))
  assert.match(JSON.stringify(search.payload), /harbor-lights/u)
}

async function assertWritesRefused(session, code) {
  const write = await session.call("task_create", { track: "ops", slug: "blocked-write-check", title: "Blocked" })
  assert.equal(write.isError, true)
  assert.equal(write.payload.status, "degraded")
  assert.equal(write.payload.code, code)
  assert.equal(write.payload.tool, "task_create")
  assert.equal(typeof write.payload.fix, "string")
  assert.ok(write.payload.fix.length > 0)
}

function controllerFixture(fixture, semanticContract = { mode: "unsupported", embedding_spec: null }) {
  const { protocolVersion, lexicalContract, build } = readinessContracts({ lexical: "required", semantic: "unsupported" }, { build: sessionBuild() })
  const identity = controllerIdentity({ root: fixture.desk, protocolVersion, lexicalContract, semanticContract, build })
  const endpoint = deriveControllerEndpoint({ identity, env: {} })
  const stateDir = path.join(fixture.readinessHome, identity.id)
  return { identity, endpoint, stateDir, protocolVersion, lexicalContract, build }
}

async function waitForRelease(ownerFile, endpoint) {
  const deadline = Date.now() + 10000
  while (existsSync(ownerFile) || existsSync(endpoint)) {
    assert.ok(Date.now() < deadline, "the session's child must release its rendezvous after the parent ends")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// A socket file that nobody listens on: a child process binds it and is killed before it can clean up.
async function leaveStaleSocket(endpoint) {
  mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 })
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(endpoint)}, () => process.stdout.write("up"))`], { stdio: ["ignore", "pipe", "inherit"] })
  await new Promise((resolve) => child.stdout.once("data", resolve))
  const pid = child.pid
  child.kill("SIGKILL")
  await new Promise((resolve) => child.once("exit", resolve))
  return pid
}

// ---- conditions that stop admission before the desk is readable ----

test("a --root that does not exist: handshake, then degraded:root_unavailable with a fix", async (t) => {
  const fixture = await makeGitDesk()
  await withDesk(t, fixture, { args: ["--root", path.join(fixture.root, "missing-desk")] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:root_unavailable")
    assert.match(status.fix, /missing-desk/u)
    assert.match(status.fix, /desk_status/u)
    await assertWritesRefused(session, "root_unavailable")
    const read = await session.call("desk_search", { query: "lighthouse" })
    assert.equal(read.isError, true)
    assert.equal(read.payload.code, "root_unavailable")
    await lastStartUntil(fixture, (record) => record.state === "degraded:root_unavailable")
  })
})

test("a malformed activation config: handshake, then degraded:activation_config_invalid", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = path.join(fixture.root, "broken.activation.json")
  writeFile(configPath, "{not json")
  await withDesk(t, fixture, { args: ["--activation-config", configPath] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:activation_config_invalid")
    assert.match(status.fix, /valid JSON/u)
    await assertWritesRefused(session, "activation_config_invalid")
  })
})

test("an invalid readiness policy: handshake, then degraded:activation_policy_invalid", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture, { semantic: "sometimes" })
  await withDesk(t, fixture, { args: ["--activation-config", configPath] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:activation_policy_invalid")
    assert.match(status.fix, /semantic/u)
  })
})

test("invalid write authority: reads serve, writes refuse with degraded:authority_invalid", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture, { semantic: "unsupported", write_authority: "person" })
  await withDesk(t, fixture, { args: ["--activation-config", configPath] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:authority_invalid")
    await assertReadsServeDirectly(session)
    await assertWritesRefused(session, "authority_invalid")
  })
})

// ---- readiness controller faults: controller-free reads, background re-election ----

// A controller process that accepts connections and never answers, the way a wedged Desk does. It stands in for another session's Desk MCP server.
async function startHungController(endpoint) {
  mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 })
  const child = spawn(process.execPath, ["-e",
    `require("net").createServer(() => {}).listen(${JSON.stringify(endpoint)}, () => process.stdout.write("up"))`,
  ], { stdio: ["ignore", "pipe", "inherit"] })
  await new Promise((resolve) => child.stdout.once("data", resolve))
  return child
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`a host retaining ${signal} keeps its live controller through two signal and election cycles`, { skip: posixOnly, timeout: 120000 }, async (t) => {
    const fixture = await makeGitDesk()
    const configPath = writeActivation(fixture)
    const { stateDir } = controllerFixture(fixture)
    const ownerFile = path.join(stateDir, "owner.json")
    const preload = path.join(fixture.root, "retaining-host.mjs")
    writeFile(preload, `
      import { isMainThread } from "node:worker_threads"
      if (isMainThread) {
        process.on(${JSON.stringify(signal)}, () => process.stderr.write("HOST_RETAINS_PROCESS\\n"))
      }
    `)
    const sockets = []
    const owner = await startDesk(fixture, { args: ["--activation-config", configPath], nodeArgs: ["--import", preload] })
    t.after(() => {
      for (const socket of sockets) socket.destroy()
      return owner.close()
    })
    assertHandshake(owner)
    assert.equal((await owner.statusUntil(settled)).state, "ready")
    const record = JSON.parse(readFileSync(ownerFile, "utf8"))
    assert.equal(record.owner.parent_pid, owner.child.pid)
    assert.notEqual(record.owner.pid, owner.child.pid)
    // Connect before either signal: even an unlinked controller can still answer through an accepted socket.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const socket = net.createConnection(record.endpoint)
      sockets.push(socket)
      await once(socket, "connect", { signal: AbortSignal.timeout(10000) })
    }
    const outcomes = []
    for (let cycle = 0; cycle < 2; cycle += 1) {
      owner.child.kill(signal)
      while (owner.stderr().split("HOST_RETAINS_PROCESS\n").length - 1 <= cycle) {
        await once(owner.child.stderr, "data", { signal: AbortSignal.timeout(10000) })
      }
      assert.equal(owner.child.exitCode, null)
      assert.equal(owner.child.signalCode, null)
      assert.deepEqual((await owner.request("ping")).result, {})
      const ownershipKept = existsSync(ownerFile) && existsSync(record.endpoint)
      const other = await startDesk(fixture, { args: ["--activation-config", configPath] })
      t.after(() => other.close())
      assertHandshake(other)
      assert.equal((await other.statusUntil((payload) => payload.state === "ready")).admission.controller, "connected")
      const elected = JSON.parse(readFileSync(ownerFile, "utf8"))
      const socket = sockets[cycle]
      let response = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk) => { response += chunk })
      const reply = once(socket, "end", { signal: AbortSignal.timeout(10000) })
      socket.write(`${JSON.stringify({
        type: "request", id: cycle, method: "handshake",
        params: { token: record.owner.token, identity: record.identity.id, semantic_contract: record.identity.semantic_contract },
      })}\n`)
      await reply
      const handshake = JSON.parse(response).result
      assert.equal(handshake.accepted, true)
      assert.equal(handshake.owner.pid, record.owner.pid, "the original controller child is still serving")
      await assertReadsServeDirectly(other)
      const write = await other.call("task_create", { track: "ops", slug: `retained-${signal.toLowerCase()}-${cycle}`, title: "Retained controller" })
      assert.equal(write.isError, false, JSON.stringify(write.payload))
      outcomes.push({
        cycle: cycle + 1,
        ownershipKept,
        sameOwner: elected.owner.pid === record.owner.pid && elected.owner.token === record.owner.token,
        sameSocket: elected.socket.dev === record.socket.dev && elected.socket.ino === record.socket.ino,
      })
      t.diagnostic(JSON.stringify({ signal, ...outcomes[cycle], sessionPid: owner.child.pid, originalPid: record.owner.pid, electedPid: elected.owner.pid }))
      assert.deepEqual(await other.close(), { code: 0, signal: null })
    }
    assert.deepEqual(outcomes, [1, 2].map((cycle) => ({ cycle, ownershipKept: true, sameOwner: true, sameSocket: true })))
    assert.deepEqual(JSON.parse(readFileSync(ownerFile, "utf8")), record, "the retained controller keeps its exact ownership record")
    assert.deepEqual((await owner.request("tools/list")).result.tools, owner.tools.result.tools)
    assert.deepEqual(await owner.close(), { code: 0, signal: null })
    await waitForRelease(ownerFile, record.endpoint)
    assert.equal(existsSync(ownerFile), false)
    assert.equal(existsSync(record.endpoint), false)
  })
}

test("a clean detached HEAD on a remote branch is switched back to the state branch, keeping untracked files", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "checkout", "--detach", "origin/feature")
  const detachedSha = git(fixture.desk, "rev-parse", "HEAD")
  writeFile(path.join(fixture.desk, "notes-untracked.md"), "keep me\n")
  await withDesk(t, fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "ready")
    assert.equal(status.repair, `repaired: detached HEAD → main (was ${detachedSha.slice(0, 12)})`)
    // The compact answer, the one an agent reads, tells it too.
    assert.deepEqual((await session.call("desk_status", {})).payload.notes.filter((note) => note.startsWith("repaired:")), [status.repair])
    assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "main")
    assert.equal(readFileSync(path.join(fixture.desk, "notes-untracked.md"), "utf8"), "keep me\n")
    const lastStart = await lastStartUntil(fixture, (record) => record.state === "ready")
    assert.equal(lastStart.repair, status.repair)
    assert.match(readFileSync(path.join(fixture.stateDir, "repairs.log"), "utf8"), /repaired: detached HEAD → main/u)
  })
})

test("a detached HEAD with a local-only commit is not repaired: reads serve, writes refuse", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "checkout", "--detach")
  writeFile(path.join(fixture.desk, "ops", "local.md"), "local only\n")
  git(fixture.desk, "add", "-A")
  git(fixture.desk, "commit", "-m", "local only")
  const sha = git(fixture.desk, "rev-parse", "HEAD")
  await withDesk(t, fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:state_branch_detached")
    assert.deepEqual(status.admission.blockers, ["local_only_commits"])
    assert.match(status.fix, /push/u)
    assert.equal(git(fixture.desk, "rev-parse", "HEAD"), sha)
    await assertReadsServeDirectly(session)
    await assertWritesRefused(session, "state_branch_detached")
  })
})

test("a detached HEAD with a tracked edit is not repaired", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "checkout", "--detach", "origin/feature")
  writeFile(path.join(fixture.desk, "_meta", "friction.md"), "# Friction\n\nedited\n")
  await withDesk(t, fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:state_branch_detached")
    assert.deepEqual(status.admission.blockers, ["tracked_changes"])
    assert.equal(existsSync(path.join(fixture.desk, "ops", "feature-note.md")), true)
  })
})

test("a rebase in progress is not repaired", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "checkout", "--detach", "origin/feature")
  mkdirSync(path.join(fixture.desk, ".git", "rebase-merge"), { recursive: true })
  await withDesk(t, fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:state_branch_detached")
    assert.deepEqual(status.admission.blockers, ["operation_in_progress"])
  })
})

test("another branch that is clean and equal to its upstream is switched back to the state branch", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "switch", "--track", "origin/feature")
  const sha = git(fixture.desk, "rev-parse", "HEAD")
  await withDesk(t, fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "ready")
    assert.equal(status.repair, `repaired: branch feature → main (was ${sha.slice(0, 12)})`)
    assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "main")
  })
})

test("another branch with local commits stays put: degraded:state_branch_mismatch, read-only", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "switch", "--track", "origin/feature")
  writeFile(path.join(fixture.desk, "ops", "more.md"), "more\n")
  git(fixture.desk, "add", "-A")
  git(fixture.desk, "commit", "-m", "unpushed")
  await withDesk(t, fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:state_branch_mismatch")
    assert.deepEqual(status.admission.blockers, ["local_only_commits"])
    assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "feature")
    await assertWritesRefused(session, "state_branch_mismatch")
  })
})

test("a pushed branch with no upstream waits for desk_doctor's switch_state_branch repair", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "switch", "-c", "review-copy", "origin/feature", "--no-track")
  await withDesk(t, fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:state_branch_mismatch")
    assert.deepEqual(status.admission.blockers, [])
    assert.match(status.fix, /desk_doctor.*switch_state_branch/u)
    const doctor = await session.call("desk_doctor", { repair: "switch_state_branch" })
    assert.equal(doctor.isError, false, JSON.stringify(doctor.payload))
    assert.match(doctor.payload.repair, /^repaired: branch review-copy → main/u)
    assert.equal(doctor.payload.state, "ready", JSON.stringify(doctor.payload))
    assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "main")
  })
})

test("the state branch can come from the activation config instead of the flag", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture, { semantic: "unsupported" }, { state_branch: "main" })
  git(fixture.desk, "checkout", "--detach", "origin/feature")
  await withDesk(t, fixture, { args: ["--activation-config", configPath] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "ready")
    assert.match(status.repair, /^repaired: detached HEAD → main/u)
  })
})

// ---- the controller rendezvous ignores XDG_RUNTIME_DIR ----

test("--degraded with an integrity code starts connected and refuses every data tool", async (t) => {
  const fixture = await makeGitDesk()
  await withDesk(t, fixture, { args: ["--root", fixture.desk, "--degraded", "lifecycle_conflict", "--degraded-reason", "two providers claim worker"] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:lifecycle_conflict")
    assert.equal(status.mode, "refused")
    assert.match(status.fix, /two providers claim worker/u)
    const read = await session.call("desk_search", { query: "lighthouse" })
    assert.equal(read.isError, true)
    assert.equal(read.payload.code, "lifecycle_conflict")
    await assertWritesRefused(session, "lifecycle_conflict")
  })
})

test("--degraded with a crew-state code serves reads and refuses writes; with --state-branch, Desk's own check takes over", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  await withDesk(t, fixture, { args: ["--activation-config", configPath, "--degraded", "identity_unavailable", "--degraded-reason", "gh is not signed in"] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:identity_unavailable")
    await assertReadsServeDirectly(session)
    await assertWritesRefused(session, "identity_unavailable")
  })
  const handedOff = await makeGitDesk()
  const handedOffConfig = writeActivation(handedOff)
  git(handedOff.desk, "checkout", "--detach", "origin/feature")
  await withDesk(t, handedOff, { args: ["--activation-config", handedOffConfig, "--degraded", "crew_state_unavailable", "--state-branch", "main"] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "ready")
    assert.match(status.repair, /^repaired: detached HEAD → main/u)
  })
})

// ---- nothing blocks the thread that answers the host ----

// Send tools/list, ping and desk_status every `intervalMs` for `forMs`, or, with `untilState`, until desk_status reports that state and then `afterMs` more.
// A blocked thread stalls the answers, and the test says so two ways: the median answer must come within `budgetMs` (the same 200 ms on every platform: one slow answer on a shared runner is jitter, a slow median is a busy thread),
// and no single answer may take longer than `hardCapMs`, which a thread blocked for a second or more exceeds and jitter (the slowest Windows sample seen so far was 506 ms) does not. A single 1.5 s block fails the cap even though the median stays low. The measured values go to the test's diagnostics.
const ANSWER_BUDGET_MS = 200
const ANSWER_HARD_CAP_MS = 750
const median = (values) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)]
async function assertAnswersFast(session, t, { forMs = 4000, budgetMs = ANSWER_BUDGET_MS, hardCapMs = ANSWER_HARD_CAP_MS, intervalMs = 100, untilState = null, afterMs = 0, deadlineMs = 60000 } = {}) {
  const started = Date.now()
  let until = untilState === null ? started + forMs : Infinity
  const timings = []
  const states = []
  while (Date.now() < until) {
    for (const [method, params] of [["tools/list", {}], ["ping", {}], ["tools/call", { name: "desk_status", arguments: { detail: true } }]]) {
      const { ms, response } = await session.timed(method, params)
      assert.equal(response.error, undefined)
      timings.push([method, ms])
      assert.ok(ms < hardCapMs, `${method} took ${ms} ms while admission was busy, over the ${hardCapMs} ms cap`)
      if (method !== "tools/call") continue
      const state = JSON.parse(response.result.content[0].text).state
      if (states.at(-1) !== state) states.push(state)
      if (state === untilState && until === Infinity) until = Date.now() + afterMs
    }
    assert.ok(Date.now() - started < deadlineMs, `desk_status never reported ${untilState}; states: ${states.join(" → ")}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  const middle = median(timings.map(([, ms]) => ms))
  t.diagnostic(`answer times while admission was busy: median ${middle} ms, slowest ${Math.max(...timings.map(([, ms]) => ms))} ms, over ${timings.length} requests`)
  assert.ok(middle < budgetMs, `the median answer took ${middle} ms while admission was busy (budget ${budgetMs} ms); times: ${timings.map(([, ms]) => ms).join(" ")}`)
  return { timings, states }
}

test("a 30 s restore on the admission worker never delays tools/list, ping or desk_status", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const preload = new URL("./fixtures/slow-restore-preload.mjs", import.meta.url).href
  const session = await startDesk(fixture, { args: ["--activation-config", configPath], nodeArgs: ["--import", preload], env: { DESK_TEST_SLOW_RESTORE_MS: "30000" } })
  t.after(() => session.close())
  assert.ok(session.handshakeMs < HANDSHAKE_BUDGET_MS, `handshake took ${session.handshakeMs} ms`)
  const { timings } = await assertAnswersFast(session, t)
  t.diagnostic(`slowest answer during the stalled restore: ${Math.max(...timings.map(([, ms]) => ms))} ms over ${timings.length} requests`)
  assert.equal((await session.call("desk_status", { detail: true })).payload.state, "admitting", "the restore is still stalled")
})

test("the transition to ready never delays tools/list, ping or desk_status: the runtime import, the controller election and the start of convergence", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const preload = new URL("./fixtures/slow-restore-preload.mjs", import.meta.url).href
  // A short stall, so the requests are already flowing when the restore finishes and admission reaches ready.
  const session = await startDesk(fixture, { args: ["--activation-config", configPath], nodeArgs: ["--import", preload], env: { DESK_TEST_SLOW_RESTORE_MS: "1500" } })
  t.after(() => session.close())
  const { timings, states } = await assertAnswersFast(session, t, { intervalMs: 20, untilState: "ready", afterMs: 3000 })
  assert.deepEqual(states, ["admitting", "ready"])
  const slowest = Object.fromEntries(["tools/list", "ping", "tools/call"].map((method) => [method, Math.max(...timings.filter(([name]) => name === method).map(([, ms]) => ms))]))
  t.diagnostic(`slowest answers across the transition to ready: ${JSON.stringify(slowest)} ms over ${timings.length} requests`)
})

test("a runtime publication lock held by another process never delays tools/list, ping or desk_status, and admission completes once it is released", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const lockDir = `${fixture.runtimeCache}.publish-lock`
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ schema_version: 1, pid: process.pid, token: "held-by-test" }))
  t.after(() => rmSync(lockDir, { recursive: true, force: true }))
  const session = await startDesk(fixture, { args: ["--activation-config", configPath] })
  t.after(() => session.close())
  const { timings } = await assertAnswersFast(session, t)
  t.diagnostic(`slowest answer while the lock was held: ${Math.max(...timings.map(([, ms]) => ms))} ms over ${timings.length} requests`)
  assert.equal((await session.call("desk_status", { detail: true })).payload.state, "admitting")
  rmSync(lockDir, { recursive: true, force: true })
  assert.equal((await session.statusUntil((payload) => payload.state === "ready", { deadlineMs: 40000 })).state, "ready")
})
