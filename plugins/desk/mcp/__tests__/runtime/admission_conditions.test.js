// Handshake first, then admission: one spawned Desk per injected condition from the always-on investigation (§3e).
//
// Each case starts index.js over stdio with a temporary HOME, a temporary desk that is a Git clone of a temporary origin, and a lexical-only activation config. It asserts the handshake completes within 3 s with the full tool list, then that desk_status settles on the expected state, that reads and writes are gated the way that state allows, and that safe repairs happen with their one-line report.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
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

test("a hung controller (socket accepts, never replies): reads serve directly, writes wait", { skip: posixOnly }, async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const { endpoint, stateDir, identity } = controllerFixture(fixture)
  mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 })
  const net = await import("node:net")
  const sockets = []
  const hung = net.createServer((socket) => { sockets.push(socket) })
  await new Promise((resolve) => hung.listen(endpoint, resolve))
  t.after(() => { for (const socket of sockets) socket.destroy(); hung.close() })
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const stat = statSync(endpoint)
  writeFileSync(path.join(stateDir, "owner.json"), JSON.stringify({
    schema_version: 1, identity, endpoint, socket: { dev: stat.dev, ino: stat.ino },
    owner: { pid: process.pid, started_at: new Date().toISOString(), token: "hung-token" },
  }))
  await withDesk(t, fixture, { args: ["--activation-config", configPath] }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:controller_unavailable")
    assert.match(status.fix, /re-elect/u)
    await assertReadsServeDirectly(session)
    await assertWritesRefused(session, "controller_unavailable")
  })
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

test("an embedding model override: lexical reads, degraded:embedding_model_mismatch", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture, { semantic: "background" })
  await withDesk(t, fixture, { args: ["--activation-config", configPath], env: { DESK_EMBED_MODEL: "some-other-model" } }, async (session) => {
    const status = await session.statusUntil(settled)
    assert.equal(status.state, "degraded:embedding_model_mismatch")
    assert.match(status.fix, /DESK_EMBED_MODEL/u)
    await assertReadsServeDirectly(session)
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
