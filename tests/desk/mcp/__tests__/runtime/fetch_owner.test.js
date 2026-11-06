import { test as nativeTest } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { fork } from "node:child_process"
import { writeFileSync, readFileSync, renameSync, mkdirSync, constants } from "node:fs"
import { randomUUID, createHash } from "node:crypto"
import { fetchFixture, processGroupExists } from "./_fetch_fixture.js"

const test = process.platform === "darwin" ? nativeTest : nativeTest.skip
const moduleURL = new URL("../../../../../plugins/desk/mcp/src/runtime/fetch-owner.js", import.meta.url)
async function until(predicate, timeoutMs) {
  const end = performance.now() + timeoutMs
  while (!await predicate()) {
    if (performance.now() >= end) throw new Error("owned boundary was not observed")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
async function api() {
  assert.ok(await fs.stat(moduleURL).catch(() => null), "the maintained fetch-owner module is missing")
  return import(moduleURL)
}

if (process.platform !== "darwin") nativeTest("fetch ownership refuses unsupported platforms without dispatch", async () => {
  const { runFetchOwner, inspectFetchOwner, cancelFetchOwner } = await api()
  for (const action of [runFetchOwner, inspectFetchOwner, cancelFetchOwner]) {
    const result = await action({ root: "/unused", operationId: randomUUID() })
    assert.equal(result.state, "blocked")
    assert.equal(result.reason, "unsupported_platform")
  }
})

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
    f.state.controllers.add(child)
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
      child.on("close", (code, signal) => {
        f.state.controllers.delete(child)
        console.log(`owned fetch controller closed: ${child.pid}; code: ${code}; signal: ${signal}; root: ${f.base}`)
        resolve({ code, signal, errors })
      })
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
  let received
  const receiving = new Promise(resolve => { received = resolve })
  f.state.afterChunk = bytes => { if (bytes >= 32768) received() }
  const child = await actor(t, f, "cancel", { progressTimeoutMs: 10000 })
  const progress = await child.wait(message => message.value?.phase === "fetching")
  let timer
  try {
    await Promise.race([receiving, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("owned cancellation transfer did not begin")), 4000)
    })])
  } finally { clearTimeout(timer) }
  assert.equal(f.state.payloads, 1)
  const answer = await cancelFetchOwner({ root: f.root, env: f.env, operationId: progress.value.operationId })
  assert.equal(answer.state, "pending")
  const result = (await child.wait(message => message.type === "result")).result
  assert.equal(result.state, "blocked")
  assert.equal(result.reason, "cancelled")
  assert.equal((await child.closed).code, 0)
  const fresh = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 3000 })
  assert.notEqual(fresh.state, "verified_git_objects")
})

for (const kind of ["activation", "branch", "endpoint", "advance", "after-publication"]) {
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
    if (kind === "endpoint") assert.equal(f.state.requests.some(url => url.includes("/changed")), false)
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
  assert.equal(f.state.requests.length, 0)
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

test("the whole-job budget also caps initial local metadata before reservation", { timeout: 6000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  const { spawnSync } = await import("node:child_process")
  const fifo = path.join(f.base, "blocked-native-config")
  assert.equal(spawnSync("/usr/bin/mkfifo", [fifo]).status, 0)
  const started = performance.now()
  const job = runFetchOwner({ root: f.root, env: { ...f.env, GIT_CONFIG_GLOBAL: fifo }, timeoutMs: 2500 })
  let pids = []
  while (pids.length === 0 && performance.now() - started < 500) {
    await new Promise(resolve => setTimeout(resolve, 20))
    const observed = spawnSync("/usr/bin/pgrep", ["-P", String(process.pid)], { encoding: "utf8" })
    pids = observed.stdout.trim().split(/\s+/u).map(Number).filter(pid => pid > 0 && pid !== observed.pid)
  }
  assert.equal(pids.length, 1, "the native metadata child must be observed before claiming its closure")
  console.log(`owned fetch bootstrap child observed: ${pids[0]}; root: ${f.base}`)
  const result = await job
  assert.equal(result.reason, "whole_job_deadline")
  assert.ok(performance.now() - started < 3000)
  assert.throws(() => process.kill(pids[0], 0), { code: "ESRCH" })
  assert.equal(f.state.requests.length, 0)
})

test("bootstrap uses the same trusted Git as transfer rather than an arbitrary PATH executable", { timeout: 15000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  const bin = path.join(f.base, "unqualified-bin"), marker = path.join(f.base, "path-git-ran")
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\nprintf ran >> "${marker}"\nexec /usr/bin/git "$@"\n`, { mode: 0o700 })
  const result = await runFetchOwner({ root: f.root, env: { ...f.env, PATH: `${bin}:/usr/bin:/bin` }, timeoutMs: 10000 })
  assert.equal(result.state, "verified_git_objects")
  await assert.rejects(fs.stat(marker), { code: "ENOENT" })
})

test("cancellation with no current owner is explicitly blocked, not an unhandled private-file error", { timeout: 5000 }, async t => {
  const f = await fetchFixture(t), { cancelFetchOwner } = await api()
  const result = await cancelFetchOwner({ root: f.root, env: f.env, operationId: randomUUID() })
  assert.equal(result.state, "blocked")
  assert.equal(result.reason, "owner_unavailable")
})

test("a stale cancellation token cannot cancel the held operation", { timeout: 15000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  const directory = path.join(f.root, ".git", "desk-fetch-owner")
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000, onProgress(event) {
    if (event.phase === "fetching") writeFileSync(path.join(directory, `cancel-${event.operationId}.json`), JSON.stringify({ operationId: event.operationId, token: randomUUID() }))
  } })
  assert.equal(result.state, "verified_git_objects")
  assert.equal(result.sourceApplied, false)
  assert.equal(result.lfsReady, false)
})

test("a replacement owner is retained and cannot be cancelled by the old operation", { timeout: 15000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner, cancelFetchOwner } = await api()
  const ownerFile = path.join(f.root, ".git", "desk-fetch-owner", "owner.json")
  let replacement, oldOperation
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000, onProgress(event) {
    if (event.phase !== "fetching") return
    oldOperation = event.operationId
    const owner = JSON.parse(readFileSync(ownerFile, "utf8"))
    replacement = JSON.stringify({ ...owner, operationId: randomUUID(), token: randomUUID(), pid: process.pid }) + "\n"
    writeFileSync(ownerFile, replacement)
  } })
  assert.equal(result.state, "blocked")
  assert.equal(result.reason, "owner_changed")
  assert.equal(result.custody, "retained")
  assert.equal(await fs.readFile(ownerFile, "utf8"), replacement)
  assert.equal((await cancelFetchOwner({ root: f.root, env: f.env, operationId: oldOperation })).reason, "owner_changed")
  assert.equal(await fs.readFile(ownerFile, "utf8"), replacement)
})

test("unknown closure witness retains custody even when a verified ref was created", { timeout: 15000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  const directory = path.join(f.root, ".git", "desk-fetch-owner")
  let operationId
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000, onProgress(event) {
    if (event.phase !== "published") return
    operationId = event.operationId
    const witness = path.join(directory, "subtree.json")
    renameSync(witness, path.join(directory, "preserved-subtree.json"))
    writeFileSync(witness, JSON.stringify({ operationId, token: randomUUID(), closed: false }))
  } })
  assert.equal(result.state, "blocked")
  assert.equal(result.custody, "retained")
  assert.ok(await fs.stat(path.join(directory, "owner.json")))
  assert.equal(result.candidateRef, `refs/desk/fetch-owner/${operationId}/candidate`)
  assert.equal(result.verifiedRef, `refs/desk/fetch-owner/${operationId}/verified`)
  assert.equal(result.pinnedOid, f.incoming)
  assert.equal(Object.hasOwn(result, "observedOid"), false, "an unobserved generation must not be invented")
  assert.equal(f.git(f.root, ["rev-parse", `refs/desk/fetch-owner/${operationId}/verified`]), f.incoming)
  assert.notEqual((await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 3000 })).state, "verified_git_objects")
})

test("an unrelated remote replacement retains the fetched candidate without readiness", { timeout: 15000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  let operationId, replacement, fixtureFailure
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000, onProgress(event) {
    if (event.phase !== "fetched") return
    try {
      operationId = event.operationId
      f.git(f.seed, ["switch", "--orphan", "rewritten"])
      f.git(f.seed, ["commit", "--allow-empty", "-qm", "unrelated replacement"])
      replacement = f.git(f.seed, ["rev-parse", "HEAD"])
      f.git(f.seed, ["push", "-q", f.bare, `${replacement}:refs/heads/rewritten`])
      f.git(f.seed, ["--git-dir", f.bare, "update-ref", "refs/heads/main", replacement, f.incoming])
    } catch (error) { fixtureFailure = error; throw error }
  } })
  if (fixtureFailure) throw fixtureFailure
  assert.equal(result.reason, "source_generation_changed")
  assert.equal(result.observedOid, replacement)
  assert.notEqual(replacement, f.incoming)
  assert.equal(f.git(f.root, ["rev-parse", `refs/desk/fetch-owner/${operationId}/candidate`]), f.incoming)
  assert.equal(f.git(f.root, ["rev-parse", "HEAD"]), f.baseline)
})

test("a matching receipt cannot replace actual complete Git object closure", { timeout: 20000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner, inspectFetchOwner } = await api()
  const first = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000 })
  assert.equal(first.state, "verified_git_objects")
  const missingTree = "f".repeat(40)
  const bytes = `tree ${missingTree}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\nmissing tree\n`
  const { spawnSync } = await import("node:child_process")
  let broken
  for (const root of [f.root, f.bare]) {
    const args = root === f.bare ? ["--git-dir", root] : ["-C", root]
    const answer = spawnSync("/usr/bin/git", [...args, "hash-object", "-t", "commit", "-w", "--stdin"], { input: bytes, encoding: "utf8", env: f.env })
    assert.equal(answer.status, 0, answer.stderr)
    broken = answer.stdout.trim()
  }
  f.git(f.root, ["update-ref", first.verifiedRef, broken])
  f.git(f.root, ["--git-dir", f.bare, "update-ref", "refs/heads/main", broken, f.incoming])
  const directory = path.join(f.root, ".git", "desk-fetch-owner"), file = path.join(directory, first.operationId, "receipt.json")
  const record = JSON.parse(await fs.readFile(file, "utf8"))
  record.scope.oid = broken
  await fs.writeFile(file, JSON.stringify(record) + "\n")
  await fs.writeFile(path.join(directory, "last.json"), JSON.stringify({ operationId: first.operationId,
    digest: createHash("sha256").update(JSON.stringify(record)).digest("hex") }) + "\n")
  const inspected = await inspectFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000 })
  assert.equal(inspected.reason, "missing_object_closure")
  assert.notEqual(inspected.state, "verified_git_objects")
})

test("a verified graph containing LFS pointers grants no materialization or upload readiness", { timeout: 15000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"e".repeat(64)}\nsize 3\n`
  await fs.writeFile(path.join(f.seed, "payload.bin"), pointer)
  f.git(f.seed, ["add", "payload.bin"]); f.git(f.seed, ["commit", "-qm", "pointer only"]); f.git(f.seed, ["push", "-q", f.bare, "main"])
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000 })
  assert.equal(result.state, "verified_git_objects")
  assert.equal(f.git(f.root, ["show", `${result.verifiedRef}:payload.bin`]), pointer.trim())
  assert.equal(result.sourceApplied, false)
  assert.equal(result.lfsReady, false)
  await assert.rejects(fs.stat(path.join(f.root, "payload.bin")), { code: "ENOENT" })
})

test("helper loss cannot leave its Git process group beyond the whole-job ceiling", { timeout: 10000 }, async t => {
  const f = await fetchFixture(t)
  f.state.stallAfter = 32768
  let received
  const receiving = new Promise(resolve => { received = resolve })
  f.state.afterChunk = count => { if (count >= 32768) received() }
  const started = performance.now()
  const owner = await actor(t, f, "lost-helper", { timeoutMs: 5000, progressTimeoutMs: 4000 })
  await owner.wait(message => message.value?.phase === "fetching")
  let timer
  try {
    await Promise.race([receiving, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("owned transfer did not begin")), 4000)
    })])
  } finally { clearTimeout(timer) }
  const directory = path.join(f.root, ".git", "desk-fetch-owner")
  const witness = JSON.parse(await fs.readFile(path.join(directory, "subtree.json"), "utf8"))
  const { spawnSync } = await import("node:child_process")
  const children = spawnSync("/usr/bin/pgrep", ["-P", String(witness.helperPid)], { encoding: "utf8" })
  assert.equal(children.status, 0, children.stderr)
  const pids = children.stdout.trim().split(/\s+/u).map(Number)
  assert.equal(pids.length, 1)
  const group = pids[0]
  await f.trackGroup(group)
  process.kill(witness.helperPid, "SIGKILL")
  const result = (await owner.wait(message => message.type === "result")).result
  assert.equal(result.state, "blocked")
  assert.equal(result.custody, "retained")
  assert.ok(await fs.stat(path.join(directory, "owner.json")))
  const end = started + 5500
  while (processGroupExists(group) && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(processGroupExists(group), false, "lost helper left a live network process group")
  assert.equal((await owner.closed).code, 0)
})

test("unsupported watchdog loader policy is explicit and never dispatched as an unbounded fallback", { timeout: 10000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  const result = await runFetchOwner({ root: f.root, env: { ...f.env, PERL5OPT: "-Mstrict" }, timeoutMs: 4000 })
  assert.equal(result.state, "blocked")
  assert.equal(result.reason, "watchdog_policy_unqualified")
  assert.equal(f.state.requests.length, 0)
})

test("the native per-file storage ceiling blocks an oversized incoming pack without applying source", { timeout: 15000 }, async t => {
  const f = await fetchFixture(t, 2 * 1024 * 1024), { runFetchOwner } = await api()
  const cap = 1024 * 1024
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000, maxFileBytes: cap })
  assert.equal(result.state, "blocked")
  assert.equal(result.reason, "storage_limit", JSON.stringify(result))
  const directory = path.join(f.root, ".git", "objects", "pack")
  for (const entry of await fs.readdir(directory)) assert.ok((await fs.stat(path.join(directory, entry))).size <= cap, entry)
  assert.equal(f.git(f.root, ["rev-parse", "HEAD"]), f.baseline)
  await assert.rejects(fs.stat(path.join(f.root, "payload.bin")), { code: "ENOENT" })
})

for (const value of ["", "http://127.0.0.1:1"]) test(`named-remote proxy policy ${value || "(direct)"} cannot be bypassed by a captured URL`, { timeout: 10000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  f.git(f.root, ["config", "remote.origin.proxy", value])
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 6000 })
  assert.equal(result.reason, "credential_or_repository_policy_unqualified")
  assert.equal(f.state.requests.length, 0)
  assert.equal(f.git(f.root, ["config", "--get", "remote.origin.proxy"]), value)
})

for (const kind of ["replacement", "graft"]) test(`history ${kind} policy is not mistaken for raw Git object closure`, { timeout: 10000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  if (kind === "replacement") {
    const tree = f.git(f.root, ["rev-parse", "HEAD^{tree}"])
    const replacement = f.git(f.root, ["commit-tree", tree, "-m", "fixture replacement"])
    f.git(f.root, ["replace", f.baseline, replacement])
  } else {
    await fs.writeFile(path.join(f.root, ".git", "info", "grafts"), f.baseline + "\n")
  }
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 6000 })
  assert.equal(result.reason, "history_overlay_unqualified")
  assert.equal(f.state.requests.length, 0)
})

test("retained operation capacity blocks transfer without deleting prior custody", { timeout: 10000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  const directory = path.join(f.root, ".git", "desk-fetch-owner"), prior = Array.from({ length: 4 }, () => randomUUID())
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 6000, onProgress(event) {
    if (event.phase === "reserved") for (const name of prior) {
      const target = path.join(directory, name)
      // These represent retained interrupted operations, not reclaimable empty slots.
      mkdirSync(target, { mode: 0o700 })
    }
  } })
  assert.equal(result.reason, "retained_operation_capacity")
  assert.equal(f.state.payloads, 0)
  for (const name of prior) assert.ok((await fs.stat(path.join(directory, name))).isDirectory())
})

test("a late old-operation cancel cannot overwrite a replacement operation's request", { timeout: 10000 }, async t => {
  const f = await fetchFixture(t), { cancelFetchOwner } = await api()
  const common = await fs.realpath(path.join(f.root, ".git")), directory = path.join(common, "desk-fetch-owner")
  await fs.mkdir(directory, { mode: 0o700 })
  const first = { operationId: randomUUID(), token: randomUUID(), common, pid: process.pid, start: "fixture" }
  const replacement = { ...first, operationId: randomUUID(), token: randomUUID() }
  await fs.writeFile(path.join(directory, "owner.json"), JSON.stringify(first), { mode: 0o600 })
  const originalOpen = fs.open
  let interleaved = false
  fs.open = async function(file, flags, ...rest) {
    if (!interleaved && flags === "wx" && String(file).includes("cancel") && String(file).endsWith(".tmp")) {
      interleaved = true
      await fs.writeFile(path.join(directory, "owner.json"), JSON.stringify(replacement))
      assert.equal((await cancelFetchOwner({ root: f.root, env: f.env, operationId: replacement.operationId })).state, "pending")
    }
    return originalOpen.call(this, file, flags, ...rest)
  }
  try {
    assert.equal((await cancelFetchOwner({ root: f.root, env: f.env, operationId: first.operationId })).reason, "owner_changed")
  } finally { fs.open = originalOpen }
  assert.equal(interleaved, true)
  const requests = []
  for (const name of await fs.readdir(directory)) if (name.startsWith("cancel") && name.endsWith(".json")) {
    requests.push(JSON.parse(await fs.readFile(path.join(directory, name), "utf8")))
  }
  assert.ok(requests.some(record => record.operationId === replacement.operationId && record.token === replacement.token),
    "the replacement's exact cancellation must survive the old call's delayed write")
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "owner.json"), "utf8")).operationId, replacement.operationId)
})

for (const phase of ["startup", "request"]) test(`parent bounds an actually stalled helper during ${phase}`, { timeout: 9000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  const { spawnSync } = await import("node:child_process")
  const fifo = path.join(f.base, "helper-start-fifo"), pidFile = path.join(f.base, "helper-start.pid")
  assert.equal(spawnSync("/usr/bin/mkfifo", [fifo]).status, 0)
  let gate = await fs.open(fifo, constants.O_RDWR | constants.O_NONBLOCK)
  const preload = path.join(f.base, "stall-helper.cjs")
  await fs.writeFile(preload, `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on("SIGTERM",()=>{});fs.readFileSync(${JSON.stringify(fifo)});`)
  let pid, settled = false
  const started = performance.now()
  const job = runFetchOwner({ root: f.root, env: { ...f.env, ...(phase === "startup" ? { NODE_OPTIONS: `--require=${preload}` } : {}) },
    timeoutMs: 2500, onProgress(event) {
      if (phase === "request" && event.phase === "fetching") {
        pid = JSON.parse(readFileSync(path.join(f.root, ".git", "desk-fetch-owner", "subtree.json"), "utf8")).helperPid
        console.log(`owned fetch stalled helper observed: ${pid}; phase: ${phase}; root: ${f.base}`)
        process.kill(pid, "SIGSTOP")
      }
    } }).then(value => { settled = true; return value })
  try {
    if (phase === "startup") {
      await until(async () => { try { pid = Number(await fs.readFile(pidFile, "utf8")); return true } catch (error) { if (error.code === "ENOENT") return false; throw error } }, 1500)
      console.log(`owned fetch stalled helper observed: ${pid}; phase: ${phase}; root: ${f.base}`)
    }
    let timer
    const result = await Promise.race([job, new Promise(resolve => { timer = setTimeout(() => resolve({ state: "still_pending" }), 3200) })])
    clearTimeout(timer)
    assert.equal(result.state, "blocked", "an unresponsive helper cannot own an unbounded await")
    assert.equal(result.reason, "whole_job_deadline")
    assert.ok(performance.now() - started < 3000)
    assert.equal(result.custody, "retained")
    assert.ok(await fs.stat(path.join(f.root, ".git", "desk-fetch-owner", "owner.json")))
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  } finally {
    await gate.close()
    if (!settled && pid) {
      try { process.kill(pid, phase === "request" ? "SIGCONT" : "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
    }
    await job
  }
})

test("native linked-worktree rebind cannot use the original lease for a replacement repository", { timeout: 15000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  const linked = path.join(f.base, "linked-original"), other = path.join(f.base, "replacement"), otherLinked = path.join(f.base, "linked-replacement")
  f.git(f.root, ["worktree", "add", "-qb", "linked", linked, f.baseline])
  f.git(f.root, ["config", "branch.linked.remote", "origin"]); f.git(f.root, ["config", "branch.linked.merge", "refs/heads/main"])
  f.git(f.base, ["clone", "-q", "--no-local", f.bare, other])
  f.git(other, ["worktree", "add", "-qb", "linked", otherLinked, f.baseline])
  await fs.copyFile(path.join(f.root, ".git", "config"), path.join(other, ".git", "config"))
  assert.equal(f.git(linked, ["config", "--null", "--list"]), f.git(otherLinked, ["config", "--null", "--list"]))
  const binding = path.join(f.base, "linked.activation.json")
  await fs.writeFile(binding, JSON.stringify({ schema_version: 1, desk: { root: linked, state_branch: "linked" } }))
  const dotgit = path.join(linked, ".git"), original = await fs.readFile(dotgit)
  const replacementGitDir = f.git(otherLinked, ["rev-parse", "--absolute-git-dir"])
  let requestsAtRebind
  try {
    const result = await runFetchOwner({ root: linked, env: { ...f.env, DESK_ACTIVATION_CONFIG: binding }, timeoutMs: 10000, onProgress(event) {
      if (event.phase !== "publishing") return
      requestsAtRebind = f.state.requests.length
      writeFileSync(dotgit, `gitdir: ${replacementGitDir}\n`)
    } })
    const replacementRefs = f.git(other, ["for-each-ref", "--format=%(refname)", "refs/desk/fetch-owner/"])
    console.log(`owned binding result: ${JSON.stringify({ state: result.state, reason: result.reason, requestsAtRebind,
      requestsAfter: f.state.requests.length, replacementRefs })}; root: ${f.base}`)
    assert.equal(result.state, "blocked")
    assert.equal(result.reason, "repository_binding_changed")
    assert.equal(f.state.requests.length, requestsAtRebind)
    assert.equal(replacementRefs, "")
  } finally { await fs.writeFile(dotgit, original) }
})

for (const kind of ["signal", "request"]) test(`actual helper shutdown ${kind} cancellation cannot publish success`, { timeout: 15000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner, cancelFetchOwner } = await api()
  const { spawnSync } = await import("node:child_process")
  const fifo = path.join(f.base, "shutdown-fifo"), marker = path.join(f.base, "shutdown-entered")
  assert.equal(spawnSync("/usr/bin/mkfifo", [fifo]).status, 0)
  const gate = await fs.open(fifo, constants.O_RDWR | constants.O_NONBLOCK)
  const preload = path.join(f.base, "shutdown-helper.cjs")
  await fs.writeFile(preload, `const fs=require("node:fs");process.on("message",m=>{if(m.type==="finish"){fs.writeFileSync(${JSON.stringify(marker)},"closing");fs.readFileSync(${JSON.stringify(fifo)});}});`)
  const controller = new AbortController()
  const job = runFetchOwner({ root: f.root, env: { ...f.env, NODE_OPTIONS: `--require=${preload}` }, timeoutMs: 10000, signal: controller.signal })
  let opened = true
  try {
    await until(async () => { try { await fs.stat(marker); return true } catch (error) { if (error.code === "ENOENT") return false; throw error } }, 9000)
    const directory = path.join(f.root, ".git", "desk-fetch-owner"), owner = JSON.parse(await fs.readFile(path.join(directory, "owner.json"), "utf8"))
    if (kind === "signal") controller.abort()
    else assert.equal((await cancelFetchOwner({ root: f.root, env: f.env, operationId: owner.operationId })).state, "pending")
    await gate.close(); opened = false
    const result = await job
    const record = JSON.parse(await fs.readFile(path.join(directory, owner.operationId, "receipt.json"), "utf8"))
    console.log(`owned shutdown result: ${JSON.stringify({ kind, state: result.state, reason: result.reason,
      receiptState: record.state, receiptReason: record.reason, subtreeClosed: record.subtreeClosed })}; root: ${f.base}`)
    assert.equal(result.state, "blocked")
    assert.equal(result.reason, "cancelled")
    assert.equal(record.state, "blocked")
    assert.equal(record.reason, "cancelled")
    assert.equal(record.subtreeClosed, true)
    await assert.rejects(fs.stat(path.join(directory, "owner.json")), { code: "ENOENT" })
  } finally { if (opened) await gate.close(); await job }
})

for (const kind of ["unknown-witness", "receipt-obstruction"]) test(`generation evidence survives finalizer ${kind}`, { timeout: 15000 }, async t => {
  const f = await fetchFixture(t), { runFetchOwner } = await api()
  const directory = path.join(f.root, ".git", "desk-fetch-owner")
  let operationId, observedOid, fixtureFailure
  const result = await runFetchOwner({ root: f.root, env: f.env, timeoutMs: 10000, onProgress(event) {
    if (event.phase !== "fetched") return
    try {
      operationId = event.operationId
      f.git(f.seed, ["commit", "--allow-empty", "-qm", "advance after actual transfer"])
      f.git(f.seed, ["push", "-q", f.bare, "main"])
      observedOid = f.git(f.seed, ["rev-parse", "HEAD"])
      if (kind === "unknown-witness") {
        const witness = path.join(directory, "subtree.json")
        renameSync(witness, path.join(directory, "preserved-evidence-witness.json"))
        writeFileSync(witness, JSON.stringify({ operationId, token: randomUUID(), closed: false }))
      } else {
        const receipt = path.join(directory, operationId, "receipt.json")
        renameSync(receipt, path.join(directory, operationId, "receipt-before-obstruction.json"))
        mkdirSync(receipt, { mode: 0o700 })
      }
    } catch (error) { fixtureFailure = error; throw error }
  } })
  if (fixtureFailure) throw fixtureFailure
  console.log(`owned finalizer evidence: ${JSON.stringify({ kind, ...result, expectedPinned: f.incoming, expectedObserved: observedOid })}; root: ${f.base}`)
  assert.equal(result.state, "blocked")
  assert.equal(result.reason, "source_generation_changed")
  assert.equal(result.custody, "retained")
  assert.equal(result.pinnedOid, f.incoming)
  assert.equal(result.observedOid, observedOid)
  assert.equal(result.candidateRef, `refs/desk/fetch-owner/${operationId}/candidate`)
  assert.equal(result.verifiedRef, `refs/desk/fetch-owner/${operationId}/verified`)
  assert.equal(result.sourceApplied, false)
  assert.equal(result.lfsReady, false)
  assert.equal(f.git(f.root, ["rev-parse", result.candidateRef]), f.incoming)
  const { spawnSync } = await import("node:child_process")
  assert.notEqual(spawnSync("/usr/bin/git", ["-C", f.root, "rev-parse", "--verify", result.verifiedRef], { env: f.env }).status, 0,
    "a retained reserved name must not imply publication")
  assert.ok(await fs.stat(path.join(directory, "owner.json")))
  if (kind === "receipt-obstruction") {
    assert.equal(result.cleanup, "unverified")
    assert.ok((await fs.stat(path.join(directory, operationId, "receipt.json"))).isDirectory())
  }
})
