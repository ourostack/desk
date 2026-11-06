import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fork } from "node:child_process"
import { fetchFixture } from "./_fetch_fixture.js"

const moduleURL = new URL("../../../../../plugins/desk/mcp/src/runtime/fetch-owner.js", import.meta.url)
async function api() {
  assert.ok(await fs.stat(moduleURL).catch(() => null), "the maintained fetch-owner module is missing")
  return import(moduleURL)
}

test("fetch owner verifies a pinned Git graph without applying source files", { timeout: 15000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  const index = await fs.readFile(path.join(f.root, ".git/index"))
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000 })
  assert.equal(result.state, "verified_git_objects", JSON.stringify(result))
  assert.equal(result.sourceApplied, false)
  assert.equal(result.lfsReady, false)
  assert.equal(f.git(f.root, ["rev-parse", "HEAD"]), f.baseline)
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/index")), index)
  await assert.rejects(fs.stat(path.join(f.root, "payload.bin")), { code: "ENOENT" })
  assert.equal(f.git(f.root, ["rev-parse", result.verifiedRef]), f.incoming)
})

test("one whole-job deadline also bounds initial remote inspection", { timeout: 10000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  f.state.stallAds = true
  const start = performance.now()
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 2500 })
  assert.equal(result.state, "blocked")
  assert.match(result.reason, /deadline/u, JSON.stringify(result))
  assert.ok(performance.now() - start < 3000)
  assert.equal(f.state.payloads, 0)
})

test("completed receipt reuse rechecks the remote instead of returning stale verified", { timeout: 20000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner, inspectFetchOwner } = await api()
  const first = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000 })
  assert.equal(first.state, "verified_git_objects")
  const count = f.state.payloads
  const reused = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000 })
  assert.equal(reused.state, "verified_git_objects")
  assert.equal(reused.operationId, first.operationId)
  assert.equal(f.state.payloads, count)
  f.git(f.seed, ["commit", "--allow-empty", "-qm", "advance"])
  f.git(f.seed, ["push", "-q", f.bare, "main"])
  const stale = await inspectFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000 })
  assert.notEqual(stale.state, "verified_git_objects")
})

test("remote readback stall cannot outlive the same whole-job deadline", { timeout: 10000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  f.state.afterBody = () => { f.state.stallAds = true }
  const started = performance.now()
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 3000 })
  assert.equal(result.state, "blocked")
  assert.match(result.reason, /deadline/u, JSON.stringify(result))
  assert.ok(performance.now() - started < 3500)
  assert.equal(f.git(f.root, ["rev-parse", "HEAD"]), f.baseline)
})

function actor(t, f, name, extra = {}) {
  const file = path.join(f.base, `${name}.json`)
  return fs.writeFile(file, JSON.stringify({ root: f.root, env: f.env, timeoutMs: 12000, ...extra })).then(() => {
    const child = fork(new URL("./_fetch_actor.mjs", import.meta.url), [file], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
    console.log(`owned fetch controller created: ${child.pid}; root: ${f.base}`)
    const messages = [], listeners = []
    let errors = ""
    child.stdout.resume(); child.stderr.on("data", bytes => { errors += bytes })
    child.on("message", message => {
      messages.push(message)
      for (const listener of [...listeners]) listener()
    })
    const closed = new Promise((resolve, reject) => {
      child.on("error", reject)
      child.on("close", (code, signal) => resolve({ code, signal, errors }))
    })
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      await closed
    })
    const wait = predicate => {
      const current = messages.find(predicate)
      if (current) return Promise.resolve(current)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`controller event missing: ${errors}`)), 15000)
        const check = () => {
          const found = messages.find(predicate)
          if (found) { clearTimeout(timer); listeners.splice(listeners.indexOf(check), 1); resolve(found) }
        }
        listeners.push(check)
      })
    }
    return { child, closed, wait }
  })
}

test("linked worktree processes reserve one common-directory fetch", { timeout: 20000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  f.state.interval = 150
  const linked = path.join(f.base, "linked")
  f.git(f.root, ["worktree", "add", "-qb", "linked", linked])
  f.git(linked, ["config", "branch.linked.remote", "origin"])
  f.git(linked, ["config", "branch.linked.merge", "refs/heads/main"])
  const activation = path.join(f.base, "linked.activation.json")
  await fs.writeFile(activation, JSON.stringify({ schema_version: 1, desk: { root: linked, state_branch: "linked" } }))
  const child = await actor(t, f, "owner")
  await child.wait(message => message.value?.phase === "fetching")
  const joined = await runFetchOwner({ root: linked, env: { ...f.env, DESK_ACTIVATION_CONFIG: activation }, timeoutMs: 5000 })
  assert.equal(joined.state, "pending")
  assert.equal((await child.wait(message => message.type === "result")).result.state, "verified_git_objects")
  assert.equal((await child.closed).code, 0)
  assert.equal(f.state.payloads, 1)
})

test("external cancellation retains custody until the Git subtree closes", { timeout: 15000 }, async t => {
  const f = await fetchFixture(t), { cancelFetchOwner, runFetchOwner } = await api()
  f.state.stallAfter = 32768
  const child = await actor(t, f, "cancel", { progressTimeoutMs: 10000 })
  const progress = await child.wait(message => message.value?.phase === "fetching")
  const answer = await cancelFetchOwner({ root: f.root, env: f.env, operationId: progress.value.operationId })
  assert.equal(answer.state, "pending")
  const result = (await child.wait(message => message.type === "result")).result
  assert.equal(result.state, "blocked")
  assert.equal(result.reason, "cancelled")
  assert.equal((await child.closed).code, 0)
  const fresh = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 3000 })
  assert.notEqual(fresh.state, "verified_git_objects")
})

for (const kind of ["activation", "branch", "endpoint", "rewrite", "after-publication"]) {
  test(`fresh ${kind} change cannot become a verified receipt`, { timeout: 15000 }, async t => {
    const f = await fetchFixture(t), { runFetchOwner } = await api()
    let changed = false
    const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000, onProgress(event) {
      const phase = kind === "after-publication" ? "published" : "fetched"
      if (event.phase !== phase || changed) return
      changed = true
      if (kind === "activation") {
        // Synchronous fixture mutation models a different process's completed write at this observed boundary.
        f.git(f.root, ["config", "desk.testActivation", "changed"])
      } else if (kind === "branch") {
        f.git(f.root, ["switch", "-qc", "external"])
      } else if (kind === "endpoint") {
        f.git(f.root, ["remote", "set-url", "origin", `${f.endpoint}/changed`])
      } else {
        f.git(f.seed, ["commit", "--allow-empty", "-qm", "external advance"])
        f.git(f.seed, ["push", "-q", f.bare, "main"])
      }
    } })
    assert.equal(changed, true)
    assert.equal(result.state, "blocked")
    assert.match(result.reason, /context_changed|generation_changed/u)
    await assert.rejects(fs.stat(path.join(f.root, "payload.bin")), { code: "ENOENT" })
  })
}

test("activation bound to a different root cannot dispatch", { timeout: 10000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  await fs.writeFile(f.activation, JSON.stringify({ schema_version: 1, desk: { root: f.seed, state_branch: "main" } }))
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 7000 })
  assert.equal(result.state, "blocked")
  assert.equal(result.reason, "activation_root_mismatch")
  assert.equal(f.state.payloads, 0)
})

test("configured credential and reference-hook policy are refused without executing or disabling them", { timeout: 15000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  const helper = path.join(f.base, "credential-helper")
  await fs.writeFile(helper, "#!/bin/sh\necho should-not-run >&2\n", { mode: 0o700 })
  f.git(f.root, ["config", "credential.helper", helper])
  const credential = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 6000 })
  assert.equal(credential.state, "blocked")
  assert.equal(credential.reason, "credential_or_repository_policy_unqualified")
  assert.equal(f.git(f.root, ["config", "--get", "credential.helper"]), helper)
  f.git(f.root, ["config", "--unset", "credential.helper"])
  const hook = path.join(f.root, ".git/hooks/reference-transaction")
  await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
  const refused = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 6000 })
  assert.equal(refused.reason, "reference_hook_unqualified")
  assert.equal(await fs.readFile(hook, "utf8"), "#!/bin/sh\nexit 1\n")
  assert.equal(f.state.payloads, 0)
})

test("public results and receipts never copy transport error payloads", { timeout: 10000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  f.state.secretError = "fixture-secret-super-token"
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 6000 })
  assert.equal(result.state, "blocked")
  assert.equal(JSON.stringify(result).includes(f.state.secretError), false)
})
