// In-place recovery: fix the injected condition while Desk runs, and desk_status reaches ready with no restart and an unchanged tool list.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { installedNodesByMajor, mcpRoot } from "../launch/_mcp_handshake.js"
import { git, makeGitDesk, readLastStart, settled, startDesk, writeActivation, writeFile } from "./_admission_fixtures.js"

async function waitFor(predicate, { deadlineMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error("condition not reached in time")
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

test("a missing root recovers in place once the desk appears: ready, same tool list, a write lands", async (t) => {
  const fixture = await makeGitDesk()
  const pending = path.join(fixture.root, "later-desk")
  const configPath = writeActivation({ ...fixture, desk: pending })
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--root", pending] })
  t.after(() => session.close())
  const before = session.tools.result.tools
  const degraded = await session.statusUntil(settled)
  assert.equal(degraded.state, "degraded:root_unavailable")
  git(fixture.root, "clone", fixture.origin, pending)
  const ready = await session.statusUntil((payload) => payload.state === "ready")
  assert.equal(ready.status, "ok")
  assert.equal(ready.admission.state, "ready")
  const after = await session.request("tools/list")
  assert.deepEqual(after.result.tools, before)
  const write = await session.call("task_create", { track: "ops", slug: "recovered-write-check", title: "After recovery" })
  assert.equal(write.isError, false, JSON.stringify(write.payload))
  assert.equal(existsSync(path.join(pending, "ops", "recovered-write-check", "task.md")), true)
  assert.equal(readLastStart(fixture).state, "ready")
})

test("a malformed activation config recovers in place once it is fixed", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = path.join(fixture.root, "fixable.activation.json")
  writeFile(configPath, "{not json")
  const session = await startDesk(fixture, { args: ["--activation-config", configPath] })
  t.after(() => session.close())
  assert.equal((await session.statusUntil(settled)).state, "degraded:activation_config_invalid")
  writeActivation(fixture)
  writeFile(configPath, readFileSync(path.join(fixture.root, "desk.activation.json"), "utf8"))
  assert.equal((await session.statusUntil((payload) => payload.state === "ready")).state, "ready")
})

test("a detached HEAD with a local-only commit recovers once the commit is pushed and desk_doctor switches back: repaired, then ready", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "checkout", "--detach")
  writeFile(path.join(fixture.desk, "ops", "rescue.md"), "rescue\n")
  git(fixture.desk, "add", "-A")
  git(fixture.desk, "commit", "-m", "local work")
  const sha = git(fixture.desk, "rev-parse", "HEAD")
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] })
  t.after(() => session.close())
  const before = session.tools.result.tools
  const degraded = await session.statusUntil(settled)
  assert.equal(degraded.state, "degraded:state_branch_detached")
  // What the fix tells the agent to do: keep the commit on a pushed branch.
  assert.match(degraded.fix, /then call desk_doctor with \{"repair":"switch_state_branch"\}/u)
  git(fixture.desk, "push", "origin", "HEAD:refs/heads/rescue-work")
  // Only the first admission attempt switches on its own; after it, the doctor repair does.
  assert.equal((await session.call("desk_status")).payload.state, "degraded:state_branch_detached")
  const doctored = (await session.call("desk_doctor", { repair: "switch_state_branch" })).payload
  assert.equal(doctored.repair, `repaired: detached HEAD → main (was ${sha.slice(0, 12)})`)
  const ready = await session.statusUntil((payload) => payload.state === "ready")
  // The doctor's forced refresh runs a fresh attempt even when the .git/HEAD watch started one first, so desk_status reports the repair, and the repair log keeps it.
  assert.equal(ready.repair, doctored.repair)
  assert.match(readFileSync(path.join(fixture.stateDir, "repairs.log"), "utf8"), new RegExp(`repaired: detached HEAD → main \\(was ${sha.slice(0, 12)}\\)`, "u"))
  assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "main")
  assert.deepEqual((await session.request("tools/list")).result.tools, before)
})

test("a HEAD change is noticed without a tool call: the .git/HEAD watch re-runs admission", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] })
  t.after(() => session.close())
  assert.equal((await session.statusUntil(settled)).state, "ready")
  git(fixture.desk, "checkout", "--detach")
  writeFile(path.join(fixture.desk, "ops", "unpushed.md"), "unpushed\n")
  git(fixture.desk, "add", "-A")
  git(fixture.desk, "commit", "-m", "unpushed")
  // No desk_status call: only the watch can move the recorded state.
  await waitFor(() => existsSync(path.join(fixture.stateDir, "last-start.json")) && readLastStart(fixture).state === "degraded:state_branch_detached")
  git(fixture.desk, "switch", "main")
  await waitFor(() => readLastStart(fixture).state === "ready")
})

test("a lost readiness controller is re-elected in the background by the surviving session", { skip: process.platform === "win32" ? "POSIX signals" : false }, async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  mkdirSync(fixture.stateDir, { recursive: true })
  const first = await startDesk(fixture, { args: ["--activation-config", configPath] })
  t.after(() => first.close())
  assert.equal((await first.statusUntil(settled)).state, "ready")
  const second = await startDesk(fixture, { args: ["--activation-config", configPath] })
  t.after(() => second.close())
  assert.equal((await second.statusUntil(settled)).state, "ready")
  // The first session owns the controller; kill it the way a closed host session would.
  first.child.kill("SIGKILL")
  await new Promise((resolve) => first.child.once("exit", resolve))
  const search = await second.call("desk_search", { query: "lighthouse" })
  assert.equal(search.isError, false)
  const write = await second.call("task_create", { track: "ops", slug: "after-owner-loss", title: "Survivor write" })
  assert.equal(write.isError, false, JSON.stringify(write.payload))
  assert.equal((await second.statusUntil((payload) => payload.state === "ready")).readiness.state !== "unavailable", true)
})

test("a deliberate git switch mid-session stays put: writes go read-only with the doctor fix, and switching back restores ready", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "branch", "--track", "feature", "origin/feature")
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--state-branch", "main"] })
  t.after(() => session.close())
  assert.equal((await session.statusUntil(settled)).state, "ready")
  // Clean and equal to its upstream: at startup Desk would switch this back; mid-session it must not.
  git(fixture.desk, "switch", "feature")
  await waitFor(() => readLastStart(fixture).state === "degraded:state_branch_mismatch")
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "feature", "Desk never switched the checkout")
  const write = await session.call("task_create", { track: "ops", slug: "mid-session-switch-check", title: "Blocked" })
  assert.equal(write.isError, true)
  assert.equal(write.payload.code, "state_branch_mismatch")
  assert.match(write.payload.fix, /desk_doctor with \{"repair":"switch_state_branch"\}/u)
  const status = await session.statusUntil(settled)
  assert.equal(status.state, "degraded:state_branch_mismatch")
  assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "feature")
  git(fixture.desk, "switch", "main")
  assert.equal((await session.statusUntil((payload) => payload.state === "ready")).state, "ready")
})

test("a session that never reaches ready never switches a deliberate git switch back: only the first admission attempt may", async (t) => {
  const fixture = await makeGitDesk()
  const configPath = writeActivation(fixture)
  git(fixture.desk, "branch", "--track", "feature", "origin/feature")
  // A launcher read-only code keeps the session degraded for its whole life.
  const session = await startDesk(fixture, { args: ["--activation-config", configPath, "--state-branch", "main", "--degraded", "identity_unavailable"] })
  t.after(() => session.close())
  const first = await session.statusUntil(settled)
  assert.equal(first.state, "degraded:identity_unavailable")
  // Clean and equal to its upstream: the first attempt would have switched this back; every later one must not.
  git(fixture.desk, "switch", "feature")
  const later = await session.statusUntil((payload) => payload.admission.attempts >= first.admission.attempts + 3, { deadlineMs: 30000, intervalMs: 500 })
  assert.equal(later.state, "degraded:identity_unavailable")
  assert.equal(later.admission.state_branch.ok, false)
  assert.equal((await session.call("desk_status")).payload.admission.state_branch.kind, later.admission.state_branch.kind)
  assert.equal(git(fixture.desk, "symbolic-ref", "--short", "HEAD"), "feature", "Desk never switched the checkout back")
  assert.doesNotMatch(session.stderr(), /repaired: branch feature/u)
  const write = await session.call("task_create", { track: "ops", slug: "never-ready-switch", title: "Blocked" })
  assert.equal(write.isError, true)
  assert.equal(write.payload.code, "state_branch_mismatch")
  assert.match(write.payload.fix, /desk_doctor with \{"repair":"switch_state_branch"\}/u)
})

// A Node that bootstrap.cjs does not run Desk in (no shipped pack for its ABI here), so it re-runs index.js as a child under this Node. It must understand --import in NODE_OPTIONS (Node 20 and later).
function reexecNode() {
  const shipped = JSON.parse(readFileSync(path.join(mcpRoot, "artifacts", "runtime-deps", `${JSON.parse(readFileSync(path.join(mcpRoot, "package.json"), "utf8")).version}`, "support-matrix.json"), "utf8"))
  const abis = new Set(shipped.targets.filter((target) => target.platform === process.platform && target.arch === process.arch).map((target) => String(target.node_abi)))
  const candidates = [...installedNodesByMajor().values()].map((entry) => entry.executable)
  for (const executable of ["/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node"]) if (existsSync(executable)) candidates.push(executable)
  for (const executable of candidates) {
    const probe = spawnSync(executable, ["-p", "process.versions.modules + ' ' + process.versions.node"], { encoding: "utf8" })
    const [abi, version] = (probe.stdout ?? "").trim().split(" ")
    if (probe.status === 0 && Number(version?.split(".")[0]) >= 20 && !abis.has(abi)) return executable
  }
  return null
}

const crashPaths = [
  { name: "index.js as the entry point", entry: "index" },
  { name: "bootstrap.cjs running index.js in its own process", entry: "bootstrap" },
  { name: "the .mcp.json inline launcher running bootstrap.cjs in its own process", entry: "launcher" },
  { name: "bootstrap.cjs re-running index.js as a child under a Node with a shipped pack", entry: "bootstrap", reexec: true },
]

for (const launch of crashPaths) {
  const node = launch.reexec ? reexecNode() : process.execPath
  const skip = process.platform === "win32" ? "POSIX signals" : node === null ? "no installed Node 20+ without a shipped pack to start bootstrap.cjs under" : false
  test(`a crash after ready never ends the process (${launch.name}): it degrades to runtime_exception, keeps answering and re-admits`, { skip }, async (t) => {
    const fixture = await makeGitDesk()
    const configPath = writeActivation(fixture)
    const preload = new URL("./fixtures/crash-after-ready-preload.mjs", import.meta.url).href
    // NODE_OPTIONS reaches a re-exec child too; the crash is injected into whichever process runs Desk.
    const session = await startDesk(fixture, { args: ["--activation-config", configPath], entry: launch.entry, node, env: { NODE_OPTIONS: `--import=${preload}` } })
    t.after(() => session.close())
    assert.equal((await session.statusUntil(settled)).state, "ready")
    // Worker threads load the preload too, so a process can say it more than once.
    const armed = [...new Set([...session.stderr().matchAll(/\[crash-preload\] armed pid (\d+)/gu)].map((match) => Number(match[1])))]
    const deskPid = launch.reexec ? armed.find((pid) => pid !== session.child.pid) : session.child.pid
    assert.deepEqual(armed.sort(), (launch.reexec ? [session.child.pid, deskPid] : [deskPid]).sort(), session.stderr())
    process.kill(deskPid, "SIGUSR2")
    await waitFor(() => /caught unhandled_rejection/u.test(session.stderr()))
    const status = (await session.call("desk_status")).payload
    assert.deepEqual(status.admission.exceptions.map((entry) => [entry.kind, entry.message]), [
      ["uncaught_exception", "injected unhandled error event"],
      ["unhandled_rejection", "injected unhandled rejection"],
    ])
    assert.match(session.stderr(), /state: degraded:runtime_exception/u)
    assert.equal((await session.statusUntil((payload) => payload.state === "ready")).state, "ready")
    const write = await session.call("task_create", { track: "ops", slug: "after-crash-write", title: "Still serving" })
    assert.equal(write.isError, false, JSON.stringify(write.payload))
    assert.equal(session.child.exitCode, null, "the process is still running")
  })
}
