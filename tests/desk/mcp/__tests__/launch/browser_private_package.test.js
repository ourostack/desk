import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import os from "node:os"
import { createRequire } from "node:module"
import { mcpRoot } from "./_mcp_handshake.js"
import { removeTree } from "../_remove_tree.js"
import { readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"

const require = createRequire(import.meta.url)
const controller = require(path.join(mcpRoot, "browser-private.cjs"))

function daemonExitConfirmed(daemon, observed, probe = pid => process.kill(pid, 0)) {
  if (typeof observed === "string" && observed.length > 0) return observed !== daemon.started
  try { probe(daemon.pid) }
  catch (error) {
    if (error.code === "ESRCH") return true
  }
  return false
}

test("failed daemon inspection does not establish exit while the PID still exists", () => {
  assert.equal(daemonExitConfirmed({ pid: 123, started: "recorded-generation" }, null, () => {}), false)
  assert.equal(daemonExitConfirmed({ pid: process.pid, started: "recorded-generation" }, null), false)
})

for (const [observed, error, expected] of [
  ["recorded-generation", "must-not-probe", false],
  ["different-generation", "must-not-probe", true],
  [null, "ESRCH", true],
  [null, "EPERM", false],
  [null, "EACCES", false],
  [null, "ETIMEDOUT", false],
  ["", null, false],
]) {
  test("daemon exit custody distinguishes " + String(observed) + " / " + String(error), () => {
    let calls = 0
    const probe = () => {
      calls++
      if (error === "must-not-probe") throw new Error("generation observation must not inspect a replacement PID")
      if (error) throw Object.assign(new Error("owned fixture probe"), { code: error })
    }
    assert.equal(daemonExitConfirmed({ pid: 123, started: "recorded-generation" }, observed, probe), expected)
    assert.equal(calls, error === "must-not-probe" ? 0 : 1)
  })
}

test("actual installed private CLI retains isolated live pages and disposes only its own browser", {
  skip: process.env.DESK_PRIVATE_BROWSER_SMOKE !== "1",
  timeout: 240000,
}, async t => {
  // Unlike automatic unit-fixture teardown, a failed real launch must retain
  // its lifecycle metadata until its browser disposal can be established.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "desk-private-package-"))
  console.log("RESOURCE actual private package " + root)
  const state = path.join(root, "state")
  const evidence = process.env.DESK_PRIVATE_BROWSER_EVIDENCE || root + "-evidence"
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 })
  const options = {
    env: { ...process.env, DESK_BROWSER_STATE_DIR: state },
    firstInstallMs: 120000,
    startRefresh: () => {},
  }
  const contexts = []
  const namespaces = new Set()
  const daemons = []
  const receipt = {
    scope: "Actual maintained CLI and real installed browser, fresh private state; no operator profile, extension, login or native-agent claim.",
    sourceRevision: process.env.GITHUB_SHA || null,
    platform: process.platform, nodeVersion: process.version,
    operations: [], checks: [],
  }
  let server
  let completed = false
  let unconfirmedCreate = false
  t.after(async () => {
    const errors = []
    for (const id of contexts) {
      const result = await controller.run(["discard", id], options)
      receipt.operations.push({ operation: "cleanup", state: result.payload.state, exitCode: result.exitCode })
      if (result.exitCode !== 0) errors.push("Private context cleanup was not confirmed")
    }
    if (server) await new Promise(resolve => server.close(resolve))
    for (const daemon of daemons) {
      const deadline = Date.now() + 15000
      while (!daemonExitConfirmed(daemon, await readProcessStart(daemon.pid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
      if (!daemonExitConfirmed(daemon, await readProcessStart(daemon.pid))) errors.push("Recorded private daemon generation exit remains unconfirmed")
    }
    if (unconfirmedCreate) errors.push("A failed creation retains an unresolved startup obligation")
    receipt.assertionsComplete = completed
    receipt.cleanupConfirmed = errors.length === 0
    receipt.fixtureRetained = !completed || errors.length !== 0
    receipt.resources = { fixtureRoot: root, socketDirectories: [...namespaces], daemonGenerations: daemons }
    if (receipt.fixtureRetained) receipt.retainedFixtureRoot = root
    fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
    if (errors.length) throw new Error(errors.join("; "))
    if (completed) {
      for (const directory of namespaces) await removeTree(directory)
      await removeTree(root)
      receipt.resources.fixtureAbsent = !fs.existsSync(root)
      receipt.resources.socketDirectoriesAbsent = [...namespaces].every(directory => !fs.existsSync(directory))
      fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
    }
  })
  async function run(args) {
    const result = await controller.run(args, options)
    if (args[0] === "create" && result.payload.contextId) {
      contexts.push(result.payload.contextId)
      if (result.exitCode !== 0) unconfirmedCreate = true
    }
    if (result.payload.resources?.socketDirectory) namespaces.add(result.payload.resources.socketDirectory)
    receipt.operations.push({ operation: args[0], command: args[0] === "run" ? args[3] : undefined, exitCode: result.exitCode, state: result.payload.state })
    assert.equal(result.exitCode, 0, result.payload.message)
    if (args[0] === "create") {
      const pid = result.payload.result?.pid
      if (!Number.isInteger(pid) || pid <= 0) unconfirmedCreate = true
      assert.ok(Number.isInteger(pid) && pid > 0, "Actual CLI must return its daemon PID")
      const started = await readProcessStart(pid)
      if (!started) unconfirmedCreate = true
      assert.ok(started, "Daemon generation must be observable")
      daemons.push({ pid, started })
      assert.equal(JSON.parse(fs.readFileSync(result.payload.resources.configFile)).browser.launchOptions.headless, true)
    }
    return result.payload
  }
  function value(response) {
    const result = response.result.result
    return typeof result === "string" ? JSON.parse(result) : result
  }
  server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html")
    response.end("<!doctype html><title>Private browser verification</title><style>body{font:22px system-ui;margin:64px}pre{padding:24px;background:#eef2f8}</style><h1>Private browser verification</h1><p>Owned local fixture. No account data.</p><pre id='state'></pre><script>window.instance=crypto.randomUUID();window.render=()=>document.querySelector('#state').textContent=JSON.stringify({marker:localStorage.getItem('marker'),cookie:document.cookie,page:window.instance},null,2);render();</script>")
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const url = "http://127.0.0.1:" + server.address().port + "/"
  const a = (await run(["create"])).contextId
  const b = (await run(["create"])).contextId
  const installed = require(path.join(mcpRoot, "web.cjs")).readInstalled(state)
  assert.ok(installed, "Browser generation must be verified")
  receipt.runtime = { mcpVersion: installed.version, coreVersion: installed.core }
  await run(["run", a, "--", "goto", url])
  await run(["run", b, "--", "goto", url])
  receipt.browser = value(await run(["run", a, "--", "eval", "() => ({userAgent:navigator.userAgent})"]))
  const before = value(await run(["run", a, "--", "eval", "() => {localStorage.setItem('marker','agent-A');document.cookie='probe=A; SameSite=Lax';render();return {marker:localStorage.getItem('marker'),cookie:document.cookie,page:window.instance};}"]))
  const peer = value(await run(["run", b, "--", "eval", "() => ({marker:localStorage.getItem('marker'),cookie:document.cookie,page:window.instance})"]))
  assert.equal(before.marker, "agent-A")
  assert.equal(peer.marker, null)
  assert.equal(peer.cookie, "")
  assert.notEqual(before.page, peer.page)
  receipt.checks.push("cookies/storage/pages are isolated")
  await run(["keep", a])
  await run(["resume", a])
  assert.deepEqual(value(await run(["run", a, "--", "eval", "() => ({marker:localStorage.getItem('marker'),cookie:document.cookie,page:window.instance})"])), before)
  receipt.checks.push("fresh clients keep/resume the exact live page")
  await run(["run", a, "--", "screenshot", "--filename=" + path.join(evidence, "private-A.png")])
  await run(["run", b, "--", "screenshot", "--filename=" + path.join(evidence, "private-B.png")])
  await run(["discard", a])
  assert.deepEqual(value(await run(["run", b, "--", "eval", "() => ({marker:localStorage.getItem('marker'),cookie:document.cookie,page:window.instance})"])), peer)
  receipt.checks.push("discard A preserves B exact page/state")
  assert.equal(fs.existsSync(path.join(evidence, "private-A.png")), true)
  completed = true
})
