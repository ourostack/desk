// Handshake first, then admission: one spawned Desk per injected condition from the always-on investigation (§3e).
//
// Each case starts index.js over stdio with a temporary HOME, a temporary desk that is a Git clone of a temporary origin, and a lexical-only activation config. It asserts the handshake completes within 3 s with the full tool list, then that desk_status settles on the expected state, that reads and writes are gated the way that state allows, and that safe repairs happen with their one-line report.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import * as net from "node:net"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { TOOL_NAMES } from "../../src/tool-names.js"
import { controllerIdentity, deriveControllerEndpoint } from "../../src/readiness/identity.js"
import { connectOrStartController } from "../../src/readiness/controller-client.js"
import { readinessContracts } from "../../src/server.js"
import {
  HANDSHAKE_BUDGET_MS, git, makeGitDesk, readLastStart, settled, startDesk, writeActivation, writeFile,
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
  const { protocolVersion, lexicalContract } = readinessContracts({ lexical: "required", semantic: "unsupported" })
  const identity = controllerIdentity({ root: fixture.desk, protocolVersion, lexicalContract, semanticContract })
  const endpoint = deriveControllerEndpoint({ identity, env: {} })
  const stateDir = path.join(fixture.readinessHome, identity.id)
  return { identity, endpoint, stateDir, protocolVersion, lexicalContract }
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
    assert.equal(readLastStart(fixture).state, "degraded:root_unavailable")
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

test("a hung controller is detected after 3 missed checks and never stopped; reads and writes work throughout", { skip: posixOnly, timeout: 90000 }, async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const { endpoint, stateDir, identity } = controllerFixture(fixture)
  const hung = await startHungController(endpoint)
  t.after(() => hung.kill("SIGKILL"))
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const stat = statSync(endpoint)
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({
    schema_version: 1, identity, endpoint, socket: { dev: stat.dev, ino: stat.ino },
    owner: { pid: hung.pid, started_at: new Date().toISOString(), token: "hung-token" },
  }))
  await withDesk(t, fixture, { args: ["--activation-config", configPath], env: { DESK_READINESS_PROBE_MS: "300" } }, async (session) => {
    const first = await session.statusUntil(settled)
    assert.equal(first.state, "degraded:controller_unavailable")
    await assertReadsServeDirectly(session)
    const write = await session.call("task_create", { track: "ops", slug: "while-controller-hung", title: "Hung" })
    assert.equal(write.isError, false, JSON.stringify(write.payload))
    const detected = await session.statusUntil((payload) => payload.state === "degraded:controller_hung", { deadlineMs: 60000 })
    assert.equal(detected.admission.hung_controller.owner_pid, hung.pid)
    assert.match(detected.fix, /^Nothing to do: search uses plain text .* writes work .* recovers when it answers again or when its owning session \(pid \d+\) ends/u)
    assert.doesNotMatch(detected.fix, /task|A2b/u)
    const report = await session.call("desk_doctor", { repair: "reclaim_controller" })
    assert.equal(report.payload.status, "report")
    assert.equal(report.payload.controller.owner_pid, hung.pid)
    await assertReadsServeDirectly(session)
    const after = await session.call("task_create", { track: "ops", slug: "after-controller-hung", title: "Still writing" })
    assert.equal(after.isError, false, JSON.stringify(after.payload))
    assert.equal(hung.exitCode, null, "the owner process was never stopped")
    assert.equal(hung.signalCode, null)
  })
})

// Connections to a stopped owner's socket until the socket stops taking them: its accept queue is full, the state the other sessions' elections used to mistake for an abandoned socket. Returns the open connections.
async function fillAcceptQueue(endpoint, limit = 1000) {
  const sockets = []
  for (let count = 0; count < limit; count += 1) {
    const socket = net.createConnection(endpoint)
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("pending"), 200)
      socket.once("connect", () => { clearTimeout(timer); resolve("queued") })
      socket.once("error", (error) => { clearTimeout(timer); resolve(error.code ?? "error") })
    })
    sockets.push(socket)
    if (outcome !== "queued") return { sockets, full: outcome }
  }
  return { sockets, full: null }
}

test("a stopped owner is never taken over: the other session reports controller_hung and never binds a second controller, and after SIGCONT one controller recovers", { skip: posixOnly, timeout: 180000 }, async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const { stateDir } = controllerFixture(fixture)
  const owner = await startDesk(fixture, { args: ["--activation-config", configPath] })
  t.after(() => { owner.child.kill("SIGCONT"); return owner.close() })
  assert.equal((await owner.statusUntil(settled)).state, "ready")
  const record = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
  assert.equal(record.owner.pid, owner.child.pid)
  const inode = statSync(record.endpoint).ino
  owner.child.kill("SIGSTOP")
  const filler = await fillAcceptQueue(record.endpoint)
  t.after(() => filler.sockets.forEach((socket) => socket.destroy()))
  t.diagnostic(`the stopped owner's socket stopped taking connections after ${filler.sockets.length - 1} (${filler.full ?? "never"})`)
  const other = await startDesk(fixture, { args: ["--activation-config", configPath], env: { DESK_READINESS_PROBE_MS: "500" } })
  t.after(() => other.close())
  const hung = await other.statusUntil((payload) => payload.state === "degraded:controller_hung", { deadlineMs: 90000, intervalMs: 500 })
  assert.equal(hung.admission.hung_controller.owner_pid, owner.child.pid)
  assert.equal(hung.admission.controller, "absent")
  assert.match(hung.fix, /^Nothing to do/u)
  // Keep the other session retrying: every attempt must leave the stopped owner's controller in place.
  for (let round = 0; round < 10; round += 1) {
    const status = (await other.call("desk_status")).payload
    assert.equal(status.state, "degraded:controller_hung")
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  await assertReadsServeDirectly(other)
  const write = await other.call("task_create", { track: "ops", slug: "while-owner-stopped", title: "Stopped owner" })
  assert.equal(write.isError, false, JSON.stringify(write.payload))
  assert.deepEqual(JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8")), record, "the owner record is unchanged")
  assert.equal(statSync(record.endpoint).ino, inode, "the stopped owner's socket was never unlinked")
  assert.doesNotMatch(other.stderr(), /readiness controller server error|EADDRINUSE/u)
  assert.deepEqual(readdirSync(fixture.readinessHome), [path.basename(stateDir)], "one controller folder for the root")
  owner.child.kill("SIGCONT")
  filler.sockets.forEach((socket) => socket.destroy())
  const recovered = await other.statusUntil((payload) => payload.state === "ready", { deadlineMs: 60000, intervalMs: 500 })
  assert.equal(recovered.admission.controller, "connected")
  assert.equal(recovered.admission.hung_controller, null)
  assert.deepEqual(JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8")), record, "still the one controller the owner started")
  assert.equal(statSync(record.endpoint).ino, inode)
  assert.equal((await owner.statusUntil(settled)).state, "ready", "the owner answers again")
  const journaled = await other.call("task_create", { track: "ops", slug: "after-owner-resumed", title: "Resumed owner" })
  assert.equal(journaled.isError, false, JSON.stringify(journaled.payload))
})

test("a rival controller with a different semantic contract: lexical reads, degraded:controller_semantic_mismatch", { skip: posixOnly }, async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const { protocolVersion, lexicalContract } = controllerFixture(fixture)
  const rival = await connectOrStartController({
    root: fixture.desk, protocolVersion, lexicalContract, stateHome: fixture.readinessHome, ephemeral: true,
    semanticContract: { mode: "background", embedding_spec: { id: "rival-spec", model: "rival-model" } },
    handlers: {},
  })
  t.after(() => rival.close())
  await withDesk(t, fixture, { args: ["--activation-config", configPath] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:controller_semantic_mismatch")
    await assertReadsServeDirectly(session)
  })
})

test("an embedding model override degrades semantic search only: ready, lexical reads and writes", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture, { semantic: "background" })
  await withDesk(t, fixture, { args: ["--activation-config", configPath], env: { DESK_EMBED_MODEL: "some-other-model", DESK_EMBED_ENDPOINT: "http://127.0.0.1:9" } }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "ready")
    assert.equal(status.semantic.status, "unavailable (embedding_override)")
    assert.match(status.semantic.fix, /DESK_EMBED_MODEL/u)
    await assertReadsServeDirectly(session)
    const recall = await session.call("desk_recall", { topic: "lighthouse" })
    assert.equal(recall.isError, true)
    assert.equal(recall.payload.code, "embedding_override")
    const write = await session.call("task_create", { track: "ops", slug: "override-write-check", title: "Override" })
    assert.equal(write.isError, false, JSON.stringify(write.payload))
  })
})

test("a readiness state directory with mode 755 is tightened to 700 and admission reaches ready", { skip: posixOnly }, async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const { stateDir } = controllerFixture(fixture)
  mkdirSync(stateDir, { recursive: true })
  chmodSync(stateDir, 0o755)
  await withDesk(t, fixture, { args: ["--activation-config", configPath] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "ready")
    assert.match(status.repair, /readiness state directory.*700/u)
    assert.equal(statSync(stateDir).mode & 0o777, 0o700)
  })
})

test("a corrupt owner record next to a stale socket is reclaimed and admission reaches ready", { skip: posixOnly }, async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const { endpoint, stateDir } = controllerFixture(fixture)
  await leaveStaleSocket(endpoint)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(stateDir, "owner.json"), "{corrupt")
  await withDesk(t, fixture, { args: ["--activation-config", configPath] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "ready", JSON.stringify(status.admission))
    const write = await session.call("task_create", { track: "ops", slug: "after-reclaim-check", title: "Reclaimed" })
    assert.equal(write.isError, false, JSON.stringify(write.payload))
  })
})

test("a stale socket whose owner PID is dead is reclaimed and admission reaches ready", { skip: posixOnly }, async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const { endpoint, stateDir, identity } = controllerFixture(fixture)
  const deadPid = await leaveStaleSocket(endpoint)
  const stat = statSync(endpoint)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({
    schema_version: 1, identity, endpoint, socket: { dev: stat.dev, ino: stat.ino },
    owner: { pid: deadPid, started_at: new Date().toISOString(), token: "dead-token" },
  }))
  await withDesk(t, fixture, { args: ["--activation-config", configPath] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "ready", JSON.stringify(status.admission))
  })
})

test("a truncated index database never breaks desk_status and is rebuilt in the background", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  writeFile(path.join(fixture.desk, ".state", "desk-index.sqlite"), "SQLite format 3\u0000truncated")
  await withDesk(t, fixture, { args: ["--activation-config", configPath] }, async (session) => {
    const status = await session.statusUntil((payload) => payload.state === "ready" && payload.local_db?.state === "available")
    assert.equal(status.lexical_index.available, true)
    await assertReadsServeDirectly(session)
  })
})

// ---- the state branch: safe repairs and read-only fallback ----

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
    assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "main")
    assert.equal(readFileSync(path.join(fixture.desk, "notes-untracked.md"), "utf8"), "keep me\n")
    const lastStart = readLastStart(fixture)
    assert.equal(lastStart.state, "ready")
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
    assert.equal(doctor.payload.state, "ready")
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

test("two servers with different XDG_RUNTIME_DIR values elect one controller", { skip: posixOnly }, async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const runtimeDirs = [mkdtempSync("/tmp/dxa-"), mkdtempSync("/tmp/dxb-")]
  t.after(() => { for (const dir of runtimeDirs) rmSync(dir, { recursive: true, force: true }) })
  for (const dir of runtimeDirs) chmodSync(dir, 0o700)
  const first = await startDesk(fixture, { args: ["--activation-config", configPath], env: { XDG_RUNTIME_DIR: runtimeDirs[0] } })
  t.after(() => first.close())
  const second = await startDesk(fixture, { args: ["--activation-config", configPath], env: { XDG_RUNTIME_DIR: runtimeDirs[1] } })
  t.after(() => second.close())
  for (const session of [first, second]) {
    const status = await session.statusUntil((payload) => payload.state === "ready")
    assert.equal(status.admission.controller, "connected")
  }
  const { stateDir } = controllerFixture(fixture)
  const owner = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
  assert.ok([first.child.pid, second.child.pid].includes(owner.owner.pid))
  assert.match(owner.endpoint, /desk-readiness-\d+\/[0-9a-f]{32}\.sock$/u)
  for (const dir of runtimeDirs) assert.deepEqual(readdirSync(dir), [], "no controller socket was derived from XDG_RUNTIME_DIR")
})

// ---- refuse-but-connect: the launcher's --degraded start mode ----

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

async function assertAnswersFast(session, { forMs = 4000, budgetMs = 200 } = {}) {
  const until = Date.now() + forMs
  const timings = []
  while (Date.now() < until) {
    for (const [method, params] of [["tools/list", {}], ["ping", {}], ["tools/call", { name: "desk_status", arguments: {} }]]) {
      const { ms, response } = await session.timed(method, params)
      assert.equal(response.error, undefined)
      timings.push([method, ms])
      assert.ok(ms < budgetMs, `${method} took ${ms} ms while admission was busy`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return timings
}

test("a 30 s restore on the admission worker never delays tools/list, ping or desk_status", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const preload = new URL("./fixtures/slow-restore-preload.mjs", import.meta.url).href
  const session = await startDesk(fixture, { args: ["--activation-config", configPath], nodeArgs: ["--import", preload], env: { DESK_TEST_SLOW_RESTORE_MS: "30000" } })
  t.after(() => session.close())
  assert.ok(session.handshakeMs < HANDSHAKE_BUDGET_MS, `handshake took ${session.handshakeMs} ms`)
  const timings = await assertAnswersFast(session)
  t.diagnostic(`slowest answer during the stalled restore: ${Math.max(...timings.map(([, ms]) => ms))} ms over ${timings.length} requests`)
  assert.equal((await session.call("desk_status")).payload.state, "admitting", "the restore is still stalled")
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
  const timings = await assertAnswersFast(session)
  t.diagnostic(`slowest answer while the lock was held: ${Math.max(...timings.map(([, ms]) => ms))} ms over ${timings.length} requests`)
  assert.equal((await session.call("desk_status")).payload.state, "admitting")
  rmSync(lockDir, { recursive: true, force: true })
  assert.equal((await session.statusUntil((payload) => payload.state === "ready", { deadlineMs: 40000 })).state, "ready")
})
