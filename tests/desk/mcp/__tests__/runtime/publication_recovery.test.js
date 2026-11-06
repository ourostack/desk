import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, unlinkSync, readdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import childProcess from "node:child_process"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"
const { createPublicationContext, closePublicationContext, createPublicationIntent, requestPublication, readPublication, flushPublication, runPublicationWorker } =
  await import(process.env.DESK_PUBLICATION_REVIEW_MODULE ?? "../../../../../plugins/desk/mcp/src/runtime/publication-state.js")

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-publication-"))
  const root = path.join(dir, "root")
  const remote = path.join(dir, "remote.git")
  const home = path.join(dir, "home")
  for (const folder of [root, remote, path.join(home, "gh")]) mkdirSync(folder, { recursive: true })
  const env = { HOME: home, GH_CONFIG_DIR: path.join(home, "gh"), XDG_STATE_HOME: path.join(dir, "state"),
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
    PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" }
  if (process.platform === "darwin") env.GIT_EXEC_PATH = "/Library/Developer/CommandLineTools/usr/libexec/git-core"
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8", timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }

  const bare = (...args) => {
    const result = spawnSync("git", [`--git-dir=${remote}`, ...args], { env, encoding: "utf8", timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  bare("init", "--bare", "-q")
  git("init", "-q", "-b", "main")
  git("config", "user.name", "Publication fixture")
  git("config", "user.email", "fixture@example.invalid")
  writeFileSync(path.join(root, "seed"), "seed\n")
  git("add", "seed")
  git("commit", "-qm", "seed")
  git("remote", "add", "origin", remote)
  git("push", "-qu", "origin", "main")
  const noOps = { filer: [], delivery: [] }
  const options = { root, env, fileProblem: (input) => noOps.filer.push(input),
    scheduleDelivery: (input) => noOps.delivery.push(input) }
  const context = createPublicationContext({ root, env, sessionId: "owned-fixture" })
  t.after(() => {
    assert.deepEqual(noOps, { filer: [], delivery: [] })
    t.diagnostic(JSON.stringify({ retainedFixture: dir, noOps }))
  })
  return { dir, root, remote, env, git, bare, options, context }
}

function publicationDirectory(f) {
  const sync = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "sync")
  return path.join(sync, readdirSync(sync).find((name) => name.endsWith(".publication")))
}

function heldLaunch() {
  return { pid: process.pid, once() {}, unref() {} }
}

test("a known producer commit receives a durable accepted ticket and exact remote-verified flush", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, "own"), "own publication\n")
  f.git("add", "own")
  f.git("commit", "-qm", "owned producer")
  const targetCommit = f.git("rev-parse", "HEAD")
  const intent = createPublicationIntent({ context: f.context, targetCommit, producerOperationId: "owned-producer" })
  const queued = requestPublication({ context: f.context, intent })
  assert.equal(queued.state, "queued")
  assert.ok(queued.id)
  assert.equal(readPublication({ context: f.context, id: queued.id }).targetCommit, targetCommit)
  const pending = await flushPublication({ context: f.context, id: queued.id, timeoutMs: 0 })
  assert.ok(["queued", "accepted", "dispatching"].includes(pending.state))
  const final = await flushPublication({ context: f.context, id: queued.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ ticket: final }))
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.ok(final.acceptedAt)
  assert.ok(final.owner.start)
  assert.equal(final.verification.remoteCommit, targetCommit)
  assert.equal(f.bare("rev-parse", "refs/heads/main"), targetCommit)
  assert.equal(f.git("rev-parse", "HEAD"), targetCommit)
  assert.equal(readFileSync(path.join(f.root, "own"), "utf8"), "own publication\n")
  assert.equal(final.resources.childrenClosed, true)
})

test("serialized or foreign producer capabilities cannot request publication", (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "owned" })
  assert.throws(() => requestPublication({ context: JSON.parse(JSON.stringify(f.context)), intent }),
    { code: "publication_context_invalid" })
  assert.throws(() => requestPublication({ context: f.context, intent: JSON.parse(JSON.stringify(intent)) }),
    { code: "publication_intent_invalid" })
  const other = createPublicationContext({ root: f.root, env: f.env, sessionId: "different-session" })
  assert.throws(() => requestPublication({ context: other, intent }), { code: "publication_intent_invalid" })
})

test("closing a producer context leaves its accepted ticket observable to a fresh validated context", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, "own"), "survives producer loss\n")
  f.git("add", "own")
  f.git("commit", "-qm", "producer closes")
  const targetCommit = f.git("rev-parse", "HEAD")
  const intent = createPublicationIntent({ context: f.context, targetCommit, producerOperationId: "closing-producer" })
  const ticket = requestPublication({ context: f.context, intent })
  const deadline = Date.now() + 15000
  let observed = readPublication({ context: f.context, id: ticket.id })
  while (!observed.acceptedAt && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    observed = readPublication({ context: f.context, id: ticket.id })
  }
  assert.ok(observed.acceptedAt)
  closePublicationContext(f.context)
  assert.throws(() => requestPublication({ context: f.context, intent }), { code: "publication_context_invalid" })
  const fresh = createPublicationContext({ root: f.root, env: f.env, sessionId: "fresh-authorized-session" })
  assert.throws(() => requestPublication({ context: fresh, intent }), { code: "publication_intent_invalid" })
  const final = await flushPublication({ context: fresh, id: ticket.id, timeoutMs: 60000 })
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(final.targetCommit, targetCommit)
  assert.equal(final.deadline, observed.deadline)
  assert.equal(final.attempts.filter((attempt) => attempt.phase === "push").length, 1)
  assert.equal(f.bare("rev-parse", "refs/heads/main"), targetCommit)
})

test("a fresh context with a different producer scope cannot observe another scope's ticket", (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "scope-a" })
  const ticket = requestPublication({ context: f.context, intent, spawnImpl: () => { throw new Error("Owned launch failure") } })
  const foreign = createPublicationContext({ root: f.root, env: f.env, sessionId: "foreign-session", person: "another-person" })
  assert.throws(() => readPublication({ context: foreign, id: ticket.id }), { code: "publication_scope_mismatch" })
})

test("a stale producer context cannot publish through a replaced canonical root", (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "old-root" })
  renameSync(f.root, path.join(f.dir, "original-root"))
  mkdirSync(path.join(f.root, ".git"), { recursive: true })
  assert.throws(() => requestPublication({ context: f.context, intent, spawnImpl: () => { throw new Error("No worker may start") } }),
    { code: "publication_root_changed" })
})

test("new local commits do not cancel the earlier immutable publication target", async (t) => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, "first"), "first\n")
  f.git("add", "first")
  f.git("commit", "-qm", "first target")
  const targetCommit = f.git("rev-parse", "HEAD")
  const intent = createPublicationIntent({ context: f.context, targetCommit, producerOperationId: "first" })
  const ticket = requestPublication({ context: f.context, intent })
  writeFileSync(path.join(f.root, "second"), "second\n")
  f.git("add", "second")
  f.git("commit", "-qm", "later local target")
  const later = f.git("rev-parse", "HEAD")
  assert.notEqual(later, targetCommit)
  const final = await flushPublication({ context: f.context, id: ticket.id, timeoutMs: 60000 })
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(f.bare("rev-parse", "refs/heads/main"), targetCommit)
  assert.equal(f.git("rev-parse", "HEAD"), later)
})

test("changing branch or route cannot make a historical ticket current", async (t) => {
  const f = fixture(t)
  const targetCommit = f.git("rev-parse", "HEAD")
  const intent = createPublicationIntent({ context: f.context, targetCommit, producerOperationId: "already-current" })
  const ticket = requestPublication({ context: f.context, intent })
  const final = await flushPublication({ context: f.context, id: ticket.id, timeoutMs: 60000 })
  assert.equal(final.state, "verified", JSON.stringify(final))
  f.git("symbolic-ref", "HEAD", "refs/heads/other")
  const changedBranch = readPublication({ context: f.context, id: ticket.id })
  assert.equal(changedBranch.state, "unknown")
  assert.equal(changedBranch.historicalState, "verified")
  f.git("symbolic-ref", "HEAD", "refs/heads/main")
  f.git("remote", "set-url", "--push", "origin", path.join(f.dir, "never-published.git"))
  const changedRoute = readPublication({ context: f.context, id: ticket.id })
  assert.equal(changedRoute.state, "unknown")
  assert.equal(changedRoute.reason, "binding_changed")
})

test("an unqualified executable server hook blocks publication rather than bypassing its policy", async (t) => {
  const f = fixture(t)
  const before = f.bare("rev-parse", "refs/heads/main")
  const marker = path.join(f.dir, "server-hook-ran")
  writeFileSync(path.join(f.remote, "hooks", "pre-receive"), `#!/bin/sh\nprintf invoked > '${marker}'\n`, { mode: 0o700 })
  writeFileSync(path.join(f.root, "own"), "hook policy\n")
  f.git("add", "own")
  f.git("commit", "-qm", "requires unqualified server hook")
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "hook-policy" })
  const ticket = requestPublication({ context: f.context, intent })
  const final = await flushPublication({ context: f.context, id: ticket.id, timeoutMs: 60000 })
  assert.equal(final.state, "blocked", JSON.stringify(final))
  assert.equal(final.reason, "publication_server_hooks_not_qualified")
  assert.equal(final.attempts.filter((attempt) => attempt.phase === "push").length, 0)
  assert.equal(f.bare("rev-parse", "refs/heads/main"), before)
})

test("an already-applied target is verified by its single fresh remote observation without a redundant replay", async (t) => {
  const f = fixture(t)
  const bin = path.join(f.dir, "bin")
  const reads = path.join(f.dir, "remote-reads")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$3" = ls-remote ]; then
  if [ -e '${reads}' ]; then exit 1; fi
  printf read > '${reads}'
fi
exec /usr/bin/git "$@"
`, { mode: 0o700 })
  const env = { ...f.env, PATH: `${bin}:${f.env.PATH}` }
  const context = createPublicationContext({ root: f.root, env, sessionId: "single-observation" })
  const intent = createPublicationIntent({ context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "already-applied" })
  const ticket = requestPublication({ context, intent })
  const final = await flushPublication({ context, id: ticket.id, timeoutMs: 60000 })
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(final.attempts.filter((attempt) => ["before", "after"].includes(attempt.phase)).length, 1)
  assert.equal(final.attempts.filter((attempt) => attempt.phase === "push").length, 0)
  assert.equal(readFileSync(reads, "utf8"), "read")
})

test("an accepted push with a lost native response is verified by readback without a second push", async (t) => {
  const f = fixture(t)
  const bin = path.join(f.dir, "bin")
  const marker = path.join(f.dir, "push-applied")
  const pushes = path.join(f.dir, "pushes")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$3" = push ]; then
  printf push >> '${pushes}'
  /usr/bin/git "$@"
  result=$?
  if [ "$result" = 0 ]; then printf applied > '${marker}'; exec sleep 30; fi
  exit "$result"
fi
exec /usr/bin/git "$@"
`, { mode: 0o700 })
  writeFileSync(path.join(f.root, "own"), "accepted publication\n")
  f.git("add", "own")
  f.git("commit", "-qm", "lost response")
  const targetCommit = f.git("rev-parse", "HEAD")
  const context = createPublicationContext({ root: f.root, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` }, sessionId: "lost-response" })
  const intent = createPublicationIntent({ context, targetCommit, producerOperationId: "owned-loss" })
  const ticket = requestPublication({ context, intent })
  const deadline = Date.now() + 50000
  let observed = readPublication({ context, id: ticket.id })
  while ((!existsSync(marker) || !observed.resources.start) && Date.now() < deadline) {
    if (["blocked", "verified"].includes(observed.state) ||
      (observed.state === "unknown" && observed.reason !== "publication_owner_unverifiable")) break
    await new Promise((resolve) => setTimeout(resolve, 250))
    observed = readPublication({ context, id: ticket.id })
  }
  t.diagnostic(JSON.stringify({ firstResultBeforeAnyFaultOrRetry: observed }))
  assert.equal(existsSync(marker), true)
  assert.equal(await readProcessStart(observed.resources.childPid), observed.resources.start)
  t.diagnostic(JSON.stringify({ firstAppliedBeforeFault: observed, remote: f.bare("rev-parse", "refs/heads/main") }))
  process.kill(observed.resources.childPid, "SIGKILL")
  const final = await flushPublication({ context, id: ticket.id, timeoutMs: 60000 })
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(final.verification.remoteCommit, targetCommit)
  assert.equal(readFileSync(pushes, "utf8"), "push")
  assert.equal(final.attempts.filter((attempt) => attempt.phase === "push").length, 1)
  assert.equal(final.attempts.find((attempt) => attempt.phase === "push").resources.childrenClosed, true)
})

test("unchanged blocked publication is not redispatched and a relevant policy change creates a fresh intent", async (t) => {
  const f = fixture(t)
  const hook = path.join(f.remote, "hooks", "pre-receive")
  writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  writeFileSync(path.join(f.root, "own"), "blocked intent\n")
  f.git("add", "own")
  f.git("commit", "-qm", "blocked")
  const targetCommit = f.git("rev-parse", "HEAD")
  const intent = createPublicationIntent({ context: f.context, targetCommit, producerOperationId: "blocked-owner" })
  const first = requestPublication({ context: f.context, intent })
  const blocked = await flushPublication({ context: f.context, id: first.id, timeoutMs: 60000 })
  assert.equal(blocked.state, "blocked", JSON.stringify(blocked))
  writeFileSync(path.join(f.root, "unrelated-draft"), "do not retry on this write\n")
  const repeated = requestPublication({ context: f.context, intent, spawnImpl: () => assert.fail("Unchanged blocked ticket cannot redispatch") })
  assert.equal(repeated.id, first.id)
  assert.equal(repeated.state, "blocked")
  unlinkSync(hook)
  const freshIntent = createPublicationIntent({ context: f.context, targetCommit, producerOperationId: "relevant-policy-change" })
  const next = requestPublication({ context: f.context, intent: freshIntent })
  assert.notEqual(next.id, first.id)
  const final = await flushPublication({ context: f.context, id: next.id, timeoutMs: 60000 })
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(readFileSync(path.join(f.root, "unrelated-draft"), "utf8"), "do not retry on this write\n")
})

test("known-closed pregrant refusal retries admission without replaying a command or resetting the ticket deadline", async (t) => {
  const f = fixture(t)
  const observer = path.join(f.dir, "one-refused-admission.cjs")
  const marker = path.join(f.dir, "admission-selected")
  writeFileSync(observer, `const cp=require("node:child_process")
const fs=require("node:fs")
let selected=false
if(process.argv.includes("--native-owner")){
 try{fs.writeFileSync(${JSON.stringify(marker)},String(process.pid),{flag:"wx"});selected=true}catch(error){if(error.code!=="EEXIST")throw error}
}
if(selected)process.exit(1)
`)
  const context = createPublicationContext({ root: f.root, env: { ...f.env, NODE_OPTIONS: `--require=${observer}` }, sessionId: "admission-recovery" })
  const targetCommit = f.git("rev-parse", "HEAD")
  const intent = createPublicationIntent({ context, targetCommit, producerOperationId: "known-pregrant" })
  const ticket = requestPublication({ context, intent })
  const final = await flushPublication({ context, id: ticket.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ ticket: final }))
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(final.deadline, ticket.deadline)
  const admission = final.attempts.find((attempt) => attempt.phase === "admission") ??
    final.inspections?.find((inspection) => inspection.requestSent === false)
  assert.ok(admission)
  assert.equal(admission.requestSent, false)
  assert.equal(admission.resources.childrenClosed, true)
  assert.equal(final.inspections?.filter((inspection) => inspection.phase === admission.phase).length <= 2, true)
  assert.equal(final.attempts.filter((attempt) => attempt.phase === "before" && attempt.requestSent).length, 1)
  assert.equal(final.attempts.filter((attempt) => attempt.phase === "push").length, 0)
})

test("an accepted journal snapshot without a valid settlement owner is not accepted evidence", (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "malformed-owner" })
  const ticket = requestPublication({ context: f.context, intent, spawnImpl: () => { throw new Error("No worker dispatched") } })
  const sync = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "sync")
  const dir = path.join(sync, readdirSync(sync).find((name) => name.endsWith(".publication")))
  const file = path.join(dir, `${ticket.id}.json`)
  const record = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...record, state: "accepted", owner: null }))
  assert.throws(() => readPublication({ context: f.context, id: ticket.id }), { code: "publication_ticket_invalid" })
})

test("a final producer notification queued while publication owns the worker is not lost on release", async (t) => {
  const f = fixture(t)
  const bin = path.join(f.dir, "bin")
  const waiting = path.join(f.dir, "first-push-waiting")
  const release = path.join(f.dir, "release")
  const pushes = path.join(f.dir, "pushes")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$3" = push ]; then
  printf 'push\\n' >> '${pushes}'
  printf waiting > '${waiting}'
  while [ ! -e '${release}' ]; do sleep .01; done
fi
exec /usr/bin/git "$@"
`, { mode: 0o700 })
  const env = { ...f.env, PATH: `${bin}:${f.env.PATH}` }
  const context = createPublicationContext({ root: f.root, env, sessionId: "queued-final-producer" })
  writeFileSync(path.join(f.root, "first"), "first\n")
  f.git("add", "first")
  f.git("commit", "-qm", "first queued producer")
  const firstCommit = f.git("rev-parse", "HEAD")
  const firstIntent = createPublicationIntent({ context, targetCommit: firstCommit, producerOperationId: "first-producer" })
  const first = requestPublication({ context, intent: firstIntent })
  const deadline = Date.now() + 50000
  while (!existsSync(waiting) && Date.now() < deadline) {
    const observed = readPublication({ context, id: first.id })
    if (["blocked", "unknown"].includes(observed.state)) {
      t.diagnostic(JSON.stringify({ firstUnexpectedBeforeNextProducer: observed }))
      assert.fail(JSON.stringify(observed))
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.equal(existsSync(waiting), true)
  writeFileSync(path.join(f.root, "last"), "last producer notification\n")
  f.git("add", "last")
  f.git("commit", "-qm", "final queued producer")
  const lastCommit = f.git("rev-parse", "HEAD")
  const lastIntent = createPublicationIntent({ context, targetCommit: lastCommit, producerOperationId: "final-producer" })
  const last = requestPublication({ context, intent: lastIntent })
  assert.equal(last.state, "queued")
  writeFileSync(release, "release")
  const completed = await flushPublication({ context, id: last.id, timeoutMs: 60000 })
  assert.equal(completed.state, "verified", JSON.stringify(completed))
  const firstCompleted = readPublication({ context, id: first.id })
  assert.equal(firstCompleted.state, "verified", JSON.stringify(firstCompleted))
  assert.equal(completed.owner.pid, firstCompleted.owner.pid)
  assert.equal(f.bare("rev-parse", "refs/heads/main"), lastCommit)
  assert.equal(readFileSync(pushes, "utf8").split("\n").filter(Boolean).length, 2)
  assert.equal(completed.attempts.filter((attempt) => attempt.phase === "push").length, 1)
})

test("after an actual push only readback admission may retry and the push remains once-only", async (t) => {
  const f = fixture(t)
  const marker = path.join(f.dir, "push-completed")
  const selection = path.join(f.dir, "readback-admission")
  const pushes = path.join(f.dir, "pushes")
  const bin = path.join(f.dir, "bin")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$3" = push ]; then
  printf push >> '${pushes}'
  /usr/bin/git "$@"
  result=$?
  if [ "$result" = 0 ]; then printf applied > '${marker}'; fi
  exit "$result"
fi
exec /usr/bin/git "$@"
`, { mode: 0o700 })
  const observer = path.join(f.dir, "readback-refusal.cjs")
  writeFileSync(observer, `const cp=require("node:child_process")
const fs=require("node:fs")
let selected=false
if(process.argv.includes("--native-owner")&&fs.existsSync(${JSON.stringify(marker)})){
 try{fs.writeFileSync(${JSON.stringify(selection)},String(process.pid),{flag:"wx"});selected=true}catch(error){if(error.code!=="EEXIST")throw error}
}
if(selected)process.exit(1)
`)
  writeFileSync(path.join(f.root, "own"), "readback admission\n")
  f.git("add", "own")
  f.git("commit", "-qm", "readback admission")
  const targetCommit = f.git("rev-parse", "HEAD")
  const context = createPublicationContext({ root: f.root, env: { ...f.env, PATH: `${bin}:${f.env.PATH}`, NODE_OPTIONS: `--require=${observer}` },
    sessionId: "readback-admission" })
  const intent = createPublicationIntent({ context, targetCommit, producerOperationId: "after-push" })
  const ticket = requestPublication({ context, intent })
  const final = await flushPublication({ context, id: ticket.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ ticket: final }))
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(final.deadline, ticket.deadline)
  const failedReadback = final.attempts.find((attempt) => attempt.phase === "admission" && attempt.requestedPhase === "after")
  assert.ok(failedReadback)
  assert.equal(failedReadback.requestSent, false)
  assert.equal(failedReadback.resources.childrenClosed, true)
  assert.equal(final.attempts.filter((attempt) => attempt.phase === "push").length, 1)
  assert.equal(readFileSync(pushes, "utf8"), "push")
})

test("a target depending on a foreign same-branch conflict is refused without rewriting or clearing the conflict", async (t) => {
  const f = fixture(t)
  const seed = f.git("rev-parse", "HEAD")
  writeFileSync(path.join(f.root, "seed"), "foreign local change\n")
  f.git("add", "seed")
  f.git("commit", "-qm", "foreign dependency")
  writeFileSync(path.join(f.root, "own"), "depends on foreign parent\n")
  f.git("add", "own")
  f.git("commit", "-qm", "dependent own target")
  const targetCommit = f.git("rev-parse", "HEAD")
  const elsewhere = path.join(f.dir, "elsewhere")
  const run = (...args) => {
    const result = spawnSync("git", args, { env: f.env, encoding: "utf8", timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  run("clone", "-q", "-b", "main", f.remote, elsewhere)
  run("-C", elsewhere, "config", "user.name", "Owned remote fixture")
  run("-C", elsewhere, "config", "user.email", "fixture@example.invalid")
  writeFileSync(path.join(elsewhere, "seed"), "remote conflict\n")
  run("-C", elsewhere, "add", "seed")
  run("-C", elsewhere, "commit", "-qm", "remote independent change")
  run("-C", elsewhere, "push", "-q", "origin", "main")
  f.git("fetch", "-q", "origin")
  const merge = spawnSync("git", ["-C", f.root, "merge", "--no-commit", "origin/main"], { env: f.env, encoding: "utf8", timeout: 15000 })
  assert.equal(merge.status, 1)
  const before = { head: f.git("rev-parse", "HEAD"), index: readFileSync(path.join(f.root, ".git", "index")),
    merge: readFileSync(path.join(f.root, ".git", "MERGE_HEAD"), "utf8"), seed: readFileSync(path.join(f.root, "seed"), "utf8") }
  assert.equal(before.head, targetCommit)
  assert.notEqual(f.bare("rev-parse", "refs/heads/main"), seed)
  const intent = createPublicationIntent({ context: f.context, targetCommit, producerOperationId: "dependent-conflict" })
  const ticket = requestPublication({ context: f.context, intent })
  const final = await flushPublication({ context: f.context, id: ticket.id, timeoutMs: 60000 })
  assert.equal(final.state, "blocked", JSON.stringify(final))
  assert.equal(final.reason, "publication_dependency_not_fast_forward")
  assert.equal(final.attempts.filter((attempt) => attempt.phase === "push").length, 0)
  assert.equal(f.git("rev-parse", "HEAD"), before.head)
  assert.deepEqual(readFileSync(path.join(f.root, ".git", "index")), before.index)
  assert.equal(readFileSync(path.join(f.root, ".git", "MERGE_HEAD"), "utf8"), before.merge)
  assert.equal(readFileSync(path.join(f.root, "seed"), "utf8"), before.seed)
})

test("a definite native ownership refusal is blocked and cannot be retried as admission recovery", async (t) => {
  const f = fixture(t)
  const count = path.join(f.dir, "refused-native-starts")
  const observer = path.join(f.dir, "definite-refusal.cjs")
  writeFileSync(observer, `const fs=require("node:fs")
const index=process.argv.indexOf("--native-owner")
if(index!==-1){
 fs.appendFileSync(${JSON.stringify(count)},"native\\n")
 process.send({kind:"refused",token:process.argv[index+1],reason:"native_owner_identity_unavailable"},()=>process.exit(1))
}
`)
  const context = createPublicationContext({ root: f.root, env: { ...f.env, NODE_OPTIONS: `--require=${observer}` }, sessionId: "definite-refusal" })
  const intent = createPublicationIntent({ context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "trust-refusal" })
  const ticket = requestPublication({ context, intent })
  const final = await flushPublication({ context, id: ticket.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ ticket: final }))
  assert.equal(final.state, "blocked")
  const refusals = [...final.attempts.filter((attempt) => attempt.phase === "admission"),
    ...(final.inspections ?? []).filter((inspection) => inspection.requestSent === false)]
  assert.equal(refusals.length, 1)
  assert.equal(final.resources.childrenClosed, true)
  assert.equal(refusals[0].error, "native_owner_identity_unavailable")
  assert.equal(readFileSync(count, "utf8"), "native\n")
  assert.equal([...final.attempts, ...(final.inspections ?? [])].some((attempt) => attempt.requestSent), false)
})

test("unknown readback-helper closure after push stays unknown without another readback or push", async (t) => {
  const f = fixture(t)
  const pushed = path.join(f.dir, "pushed")
  const group = path.join(f.dir, "unknown-readback-group")
  const starts = path.join(f.dir, "readback-starts")
  const pushes = path.join(f.dir, "pushes")
  const bin = path.join(f.dir, "bin")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$3" = push ]; then
 printf push >> '${pushes}'
 /usr/bin/git "$@"
 result=$?
 if [ "$result" = 0 ]; then printf pushed > '${pushed}'; fi
 exit "$result"
fi
exec /usr/bin/git "$@"
`, { mode: 0o700 })
  const observer = path.join(f.dir, "unknown-readback.cjs")
  writeFileSync(observer, `const fs=require("node:fs")
const cp=require("node:child_process")
const {syncBuiltinESMExports}=require("node:module")
if(process.argv.includes("--native-owner")&&fs.existsSync(${JSON.stringify(pushed)})){
 fs.appendFileSync(${JSON.stringify(starts)},"readback\\n")
 fs.writeFileSync(${JSON.stringify(group)},String(process.pid))
 process.exit(1)
}
const original=cp.spawnSync
cp.spawnSync=function(command,args,options){
 if(process.argv.includes("--publication")&&command==="/bin/ps"&&["-g","-s"].includes(args[0])&&fs.existsSync(${JSON.stringify(group)})&&args[1]===fs.readFileSync(${JSON.stringify(group)},"utf8")){
  return original("/bin/sh",["-c",'sleep .35; exec /bin/ps "$@"',"owned-read-only-observation",...args],options)
 }
 return original(command,args,options)
}
syncBuiltinESMExports()
`)
  writeFileSync(path.join(f.root, "own"), "unknown readback\n")
  f.git("add", "own")
  f.git("commit", "-qm", "unknown readback")
  const targetCommit = f.git("rev-parse", "HEAD")
  const context = createPublicationContext({ root: f.root, env: { ...f.env, PATH: `${bin}:${f.env.PATH}`, NODE_OPTIONS: `--require=${observer}` },
    sessionId: "unknown-readback" })
  const intent = createPublicationIntent({ context, targetCommit, producerOperationId: "unknown-closure" })
  const ticket = requestPublication({ context, intent })
  const final = await flushPublication({ context, id: ticket.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ firstUnknownBeforeAnyRetry: final }))
  assert.equal(final.state, "unknown", JSON.stringify(final))
  assert.equal(final.resources.childrenClosed, false)
  assert.equal(readFileSync(pushes, "utf8"), "push")
  assert.equal(readFileSync(starts, "utf8"), "readback\n")
  assert.equal(final.attempts.filter((attempt) => attempt.phase === "push").length, 1)
  assert.equal(final.attempts.filter((attempt) => attempt.requestedPhase === "after").length, 1)
  assert.equal(final.deadline, ticket.deadline)
  closePublicationContext(context)
  const fresh = createPublicationContext({ root: f.root, env: { ...f.env, PATH: `${bin}:${f.env.PATH}`, NODE_OPTIONS: `--require=${observer}` },
    sessionId: "observe-unknown-only" })
  const observed = await flushPublication({ context: fresh, id: ticket.id, timeoutMs: 0 })
  assert.equal(observed.id, ticket.id)
  assert.equal(observed.state, "unknown")
  assert.equal(readFileSync(pushes, "utf8"), "push")
  assert.equal(readFileSync(starts, "utf8"), "readback\n")
})

test("a queued ticket cannot adopt a substituted branch and route before worker acceptance", async (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "captured-A" })
  const queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
  f.git("checkout", "-qb", "substitute")
  f.git("config", "branch.substitute.remote", "origin")
  f.git("config", "branch.substitute.merge", "refs/heads/substitute")
  const substituted = path.join(f.dir, "substituted.git")
  const created = spawnSync("git", [`--git-dir=${substituted}`, "init", "--bare", "-q"], { env: f.env, encoding: "utf8", timeout: 15000 })
  assert.equal(created.status, 0, created.stderr)
  f.git("remote", "set-url", "origin", substituted)
  const original = childProcess.spawn
  let admissions = 0
  childProcess.spawn = () => { admissions += 1; throw Object.assign(new Error("Owned actor-free admission guard"), { code: "owned_probe_no_dispatch" }) }
  syncBuiltinESMExports()
  try { await runPublicationWorker({ root: f.root, env: f.env, id: queued.id }) }
  finally { childProcess.spawn = original; syncBuiltinESMExports() }
  const recorded = JSON.parse(readFileSync(path.join(publicationDirectory(f), `${queued.id}.json`), "utf8"))
  t.diagnostic(JSON.stringify({ queuedAuthorization: queued, recorded, nativeAdmissions: admissions }))
  assert.equal(recorded.state, "blocked")
  assert.equal(recorded.reason, "publication_binding_changed")
  assert.equal(admissions, 0)
  assert.equal(queued.binding.branch, "refs/heads/main")
  assert.equal(recorded.binding.branch, "refs/heads/main")
})

test("an executable server post-update hook blocks before any push or hook invocation", async (t) => {
  const f = fixture(t)
  const invoked = path.join(f.dir, "post-update-invoked")
  writeFileSync(path.join(f.remote, "hooks", "post-update"), `#!/bin/sh\nprintf invoked > '${invoked}'\n`, { mode: 0o700 })
  const before = f.bare("rev-parse", "refs/heads/main")
  writeFileSync(path.join(f.root, "own"), "post-update protected\n")
  f.git("add", "own")
  f.git("commit", "-qm", "post-update target")
  const targetCommit = f.git("rev-parse", "HEAD")
  const intent = createPublicationIntent({ context: f.context, targetCommit, producerOperationId: "post-update-policy" })
  const queued = requestPublication({ context: f.context, intent })
  const final = await flushPublication({ context: f.context, id: queued.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ firstResult: final, hookInvoked: existsSync(invoked), remote: f.bare("rev-parse", "refs/heads/main") }))
  assert.equal(final.state, "blocked")
  assert.equal(final.reason, "publication_server_hooks_not_qualified")
  assert.equal(final.attempts.length, 0)
  assert.equal(existsSync(invoked), false)
  assert.equal(f.bare("rev-parse", "refs/heads/main"), before)
})

test("an old verified atomic FD snapshot cannot outrank the current unknown ticket generation", async (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "snapshot-generations" })
  const queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
  const file = path.join(publicationDirectory(f), `${queued.id}.json`)
  const initial = JSON.parse(readFileSync(file, "utf8"))
  const verified = { ...initial, revision: 4, state: "verified", owner: { pid: process.pid, start: await readProcessStart(process.pid) },
    resources: { childrenClosed: true }, verification: { remoteCommit: initial.targetCommit } }
  const current = { ...verified, revision: 5, state: "unknown", reason: "retained_current_uncertainty", verification: null }
  writeFileSync(file, JSON.stringify(verified))
  const original = fs.openSync
  let selected = false
  fs.openSync = function (name, ...args) {
    const fd = original(name, ...args)
    if (name === file && !selected) {
      selected = true
      writeFileSync(`${file}.replacement`, JSON.stringify(current))
      renameSync(`${file}.replacement`, file)
    }
    return fd
  }
  syncBuiltinESMExports()
  let observed
  try { observed = readPublication({ context: f.context, id: queued.id }) }
  finally { fs.openSync = original; syncBuiltinESMExports() }
  t.diagnostic(JSON.stringify({ firstObserved: observed, currentRevision: current.revision }))
  assert.equal(selected, true)
  assert.equal(observed.state, "unknown")
  assert.equal(observed.revision, 5)
  assert.equal(observed.reason, "retained_current_uncertainty")
})

test("bounded ticket inventory continues past 256 retained receipts to service queued work", async (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "past-history-page" })
  const queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
  const dir = publicationDirectory(f)
  const initial = JSON.parse(readFileSync(path.join(dir, `${queued.id}.json`), "utf8"))
  const owner = { pid: process.pid, start: await readProcessStart(process.pid) }
  const retained = Array.from({ length: 256 }, () => `${randomUUID()}.json`)
  for (const name of retained) writeFileSync(path.join(dir, name), JSON.stringify({ ...initial,
    id: name.slice(0, -5), revision: 4, state: "verified", owner, resources: { childrenClosed: true },
    verification: { remoteCommit: initial.targetCommit } }))
  const originalRead = fs.readdirSync
  const originalSpawn = childProcess.spawn
  let admissions = 0
  fs.readdirSync = function (name, ...args) {
    const entries = originalRead(name, ...args)
    return name === dir ? [...retained, ...entries.filter((entry) => !retained.includes(entry))] : entries
  }
  childProcess.spawn = () => { admissions += 1; throw Object.assign(new Error("Owned actor-free admission guard"), { code: "owned_probe_no_dispatch" }) }
  syncBuiltinESMExports()
  try { await runPublicationWorker({ root: f.root, env: f.env, id: queued.id }) }
  finally { fs.readdirSync = originalRead; childProcess.spawn = originalSpawn; syncBuiltinESMExports() }
  const recorded = JSON.parse(readFileSync(path.join(dir, `${queued.id}.json`), "utf8"))
  t.diagnostic(JSON.stringify({ firstRecorded: recorded, nativeAdmissions: admissions, retainedReceipts: retained.length }))
  assert.equal(recorded.state, "blocked")
  assert.equal(recorded.reason, "publication_local_inspection_failed")
  assert.equal(admissions, 1)
  assert.equal(retained.every((name) => existsSync(path.join(dir, name))), true)
})

test("an intent cannot enqueue after its authorized route changes", (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "before-enqueue-binding" })
  f.git("remote", "set-url", "origin", path.join(f.dir, "unapproved.git"))
  assert.throws(() => requestPublication({ context: f.context, intent,
    spawnImpl: () => assert.fail("Changed authorization cannot launch") }), { code: "publication_binding_changed" })
})

for (const change of ["administration-chain", "local-hook-policy"]) {
  test(`queued authorization refuses a changed ${change} before native admission`, async (t) => {
    const f = fixture(t)
    const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: change })
    const queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
    if (change === "administration-chain") {
      fs.cpSync(path.join(f.root, ".git"), path.join(f.dir, "shared-git"), { recursive: true })
      writeFileSync(path.join(f.root, ".git", "commondir"), "../../shared-git\n")
    } else {
      mkdirSync(path.join(f.dir, "substituted-hooks"))
      f.git("config", "core.hooksPath", path.join(f.dir, "substituted-hooks"))
    }
    const original = childProcess.spawn
    let admissions = 0
    childProcess.spawn = () => { admissions += 1; throw new Error("Owned actor-free admission guard") }
    syncBuiltinESMExports()
    try { await runPublicationWorker({ root: f.root, env: f.env, id: queued.id }) }
    finally { childProcess.spawn = original; syncBuiltinESMExports() }
    const recorded = JSON.parse(readFileSync(path.join(publicationDirectory(f), `${queued.id}.json`), "utf8"))
    t.diagnostic(JSON.stringify({ changed: change, recorded, nativeAdmissions: admissions }))
    assert.equal(recorded.state, "blocked")
    assert.equal(recorded.reason, "publication_binding_changed")
    assert.equal(admissions, 0)
  })
}

test("terminal generation is rechecked after local applicability inspection", async (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "terminal-recheck" })
  const queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
  const file = path.join(publicationDirectory(f), `${queued.id}.json`)
  const initial = JSON.parse(readFileSync(file, "utf8"))
  const verified = { ...initial, revision: 4, state: "verified", owner: { pid: process.pid, start: await readProcessStart(process.pid) },
    resources: { childrenClosed: true }, verification: { remoteCommit: initial.targetCommit } }
  writeFileSync(file, JSON.stringify(verified))
  const original = fs.statSync
  let selected = false
  fs.statSync = function (name, ...args) {
    const stat = original(name, ...args)
    if (name === queued.root && !selected) {
      selected = true
      writeFileSync(`${file}.replacement`, JSON.stringify({ ...verified, revision: 5, state: "unknown",
        reason: "changed_during_local_inspection", verification: null }))
      renameSync(`${file}.replacement`, file)
    }
    return stat
  }
  syncBuiltinESMExports()
  let observed
  try { observed = readPublication({ context: f.context, id: queued.id }) }
  finally { fs.statSync = original; syncBuiltinESMExports() }
  t.diagnostic(JSON.stringify({ firstObserved: observed, replacementActivated: selected }))
  assert.equal(selected, true)
  assert.equal(observed.state, "unknown")
  assert.equal(observed.revision, 5)
  assert.equal(observed.reason, "changed_during_local_inspection")
})

test("persistent atomic generation churn returns bounded unknown rather than stale verification", async (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "bounded-current-read" })
  const queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
  const file = path.join(publicationDirectory(f), `${queued.id}.json`)
  const initial = JSON.parse(readFileSync(file, "utf8"))
  const verified = { ...initial, revision: 4, state: "verified", owner: { pid: process.pid, start: await readProcessStart(process.pid) },
    resources: { childrenClosed: true }, verification: { remoteCommit: initial.targetCommit } }
  writeFileSync(file, JSON.stringify(verified))
  const original = fs.openSync
  let reads = 0
  fs.openSync = function (name, ...args) {
    const fd = original(name, ...args)
    if (name === file) {
      writeFileSync(`${file}.replacement`, JSON.stringify({ ...verified, revision: 5 + reads++ }))
      renameSync(`${file}.replacement`, file)
    }
    return fd
  }
  syncBuiltinESMExports()
  let observed
  try { observed = readPublication({ context: f.context, id: queued.id }) }
  finally { fs.openSync = original; syncBuiltinESMExports() }
  t.diagnostic(JSON.stringify({ observed, reads }))
  assert.equal(observed.state, "unknown")
  assert.equal(observed.reason, "publication_record_changed")
  assert.equal(reads, 2)
})

test("a terminal receipt without captured authorization binding is unqualified", async (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "missing-authorization" })
  const queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
  const file = path.join(publicationDirectory(f), `${queued.id}.json`)
  const initial = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...initial, state: "verified", binding: null,
    owner: { pid: process.pid, start: await readProcessStart(process.pid) },
    resources: { childrenClosed: true }, verification: { remoteCommit: initial.targetCommit } }))
  const observed = readPublication({ context: f.context, id: queued.id })
  assert.equal(observed.state, "unknown")
  assert.equal(observed.reason, "publication_binding_unavailable")
})

test("native publication progresses past retained history without deleting receipts or losing queued work", async (t) => {
  const f = fixture(t)
  const seedIntent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "history-proof" })
  const seed = requestPublication({ context: f.context, intent: seedIntent })
  const verified = await flushPublication({ context: f.context, id: seed.id, timeoutMs: 60000 })
  assert.equal(verified.state, "verified", JSON.stringify(verified))
  const dir = publicationDirectory(f)
  const template = JSON.parse(readFileSync(path.join(dir, `${seed.id}.json`), "utf8"))
  const retained = Array.from({ length: 256 }, () => `${randomUUID()}.json`)
  for (const name of retained) writeFileSync(path.join(dir, name), JSON.stringify({ ...template, id: name.slice(0, -5) }))
  const bin = path.join(f.dir, "history-bin")
  const pushes = path.join(f.dir, "history-pushes")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ "$3" = push ]; then printf push >> '${pushes}'; fi\nexec /usr/bin/git "$@"\n`, { mode: 0o700 })
  writeFileSync(path.join(f.root, "own"), "queued after retained history\n")
  f.git("add", "own")
  f.git("commit", "-qm", "after retained history")
  const targetCommit = f.git("rev-parse", "HEAD")
  const context = createPublicationContext({ root: f.root, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` }, sessionId: "after-history" })
  const intent = createPublicationIntent({ context, targetCommit, producerOperationId: "history-queued-target" })
  const queued = requestPublication({ context, intent })
  const final = await flushPublication({ context, id: queued.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ firstResult: final, retainedReceipts: retained.length }))
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(final.verification.remoteCommit, targetCommit)
  assert.equal(f.bare("rev-parse", "refs/heads/main"), targetCommit)
  assert.equal(readFileSync(pushes, "utf8"), "push")
  assert.equal(final.resources.childrenClosed, true)
  assert.equal(retained.every((name) => existsSync(path.join(dir, name))), true)
})

test("a binding change after remote observation blocks graph and push admission", async (t) => {
  const f = fixture(t)
  const bin = path.join(f.dir, "phase-binding-bin")
  const changed = path.join(f.dir, "binding-changed")
  const graph = path.join(f.dir, "graph-admissions")
  const pushes = path.join(f.dir, "push-admissions")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$3" = ls-remote ]; then
 /usr/bin/git "$@"
 result=$?
 if [ "$result" = 0 ] && [ ! -e '${changed}' ]; then
  /usr/bin/git -C "$2" remote set-url origin '${path.join(f.dir, "not-authorized.git")}'
  printf changed > '${changed}'
 fi
 exit "$result"
fi
if [ "$3" = fetch ]; then printf graph >> '${graph}'; fi
if [ "$3" = push ]; then printf push >> '${pushes}'; fi
exec /usr/bin/git "$@"
`, { mode: 0o700 })
  writeFileSync(path.join(f.root, "own"), "phase-bound target\n")
  f.git("add", "own")
  f.git("commit", "-qm", "phase-bound target")
  const context = createPublicationContext({ root: f.root, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` }, sessionId: "phase-binding" })
  const intent = createPublicationIntent({ context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "phase-binding-target" })
  const queued = requestPublication({ context, intent })
  const file = path.join(publicationDirectory(f), `${queued.id}.json`)
  const deadline = queued.deadline
  let recorded
  do {
    recorded = JSON.parse(readFileSync(file, "utf8"))
    if (["blocked", "unknown", "verified"].includes(recorded.state)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() < deadline)
  t.diagnostic(JSON.stringify({ firstSettled: recorded, graphDispatched: existsSync(graph), pushDispatched: existsSync(pushes) }))
  assert.equal(existsSync(changed), true)
  assert.equal(recorded.state, "blocked")
  assert.equal(recorded.reason, "publication_binding_changed")
  assert.equal(existsSync(graph), false)
  assert.equal(existsSync(pushes), false)
  assert.equal(recorded.resources.childrenClosed, true)
})

test("destination namespace substitution cannot reuse policy captured for another bare repository", (t) => {
  const f = fixture(t)
  const alias = path.join(f.dir, "destination-alias")
  const other = path.join(f.dir, "other.git")
  const initialized = spawnSync("git", [`--git-dir=${other}`, "init", "--bare", "-q"], { env: f.env, encoding: "utf8", timeout: 15000 })
  assert.equal(initialized.status, 0, initialized.stderr)
  writeFileSync(path.join(other, "hooks", "post-update"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  fs.symlinkSync(f.remote, alias, "dir")
  f.git("remote", "set-url", "origin", alias)
  const context = createPublicationContext({ root: f.root, env: f.env, sessionId: "namespace-owner" })
  const intent = createPublicationIntent({ context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "namespace-A" })
  unlinkSync(alias)
  fs.symlinkSync(other, alias, "dir")
  assert.throws(() => requestPublication({ context, intent, spawnImpl: heldLaunch }), { code: "publication_binding_changed" })
})

test("a caller bound to branch B cannot read a current branch A receipt as verified", async (t) => {
  const f = fixture(t)
  f.git("checkout", "-qb", "caller-B")
  f.git("config", "branch.caller-B.remote", "origin")
  f.git("config", "branch.caller-B.merge", "refs/heads/caller-B")
  const callerB = createPublicationContext({ root: f.root, env: f.env, sessionId: "caller-B" })
  createPublicationIntent({ context: callerB, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "bind-caller-B" })
  f.git("checkout", "-q", "main")
  const callerA = createPublicationContext({ root: f.root, env: f.env, sessionId: "caller-A" })
  const intent = createPublicationIntent({ context: callerA, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "authorized-A" })
  const queued = requestPublication({ context: callerA, intent, spawnImpl: heldLaunch })
  const file = path.join(publicationDirectory(f), `${queued.id}.json`)
  const initial = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...initial, state: "verified",
    owner: { pid: process.pid, start: await readProcessStart(process.pid) },
    resources: { childrenClosed: true }, verification: { remoteCommit: initial.targetCommit } }))
  const observed = readPublication({ context: callerB, id: queued.id })
  t.diagnostic(JSON.stringify({ receiptBinding: queued.binding, observed }))
  assert.equal(observed.state, "unknown")
  assert.equal(observed.reason, "publication_caller_binding_changed")
})

test("an exclusive active reservation is never visible as partial JSON", (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "atomic-reservation" })
  const originalWrite = fs.writeFileSync
  const originalOpen = fs.openSync
  const originalClose = fs.closeSync
  const originalLink = fs.linkSync
  let observation
  let observationError
  const inspect = (id) => {
    try { observation = readPublication({ context: f.context, id }) }
    catch (error) { observationError = { name: error.name, message: error.message } }
  }
  fs.writeFileSync = function (file, data, options) {
    if (typeof file === "string" && path.basename(file) === "active.json" && options?.flag === "wx") {
      const fd = originalOpen(file, "wx", options.mode)
      try {
        inspect(JSON.parse(data).id)
        originalWrite(fd, data)
      } finally { originalClose(fd) }
      return
    }
    return originalWrite(file, data, options)
  }
  fs.linkSync = function (source, target) {
    originalLink(source, target)
    if (path.basename(target) === "active.json") inspect(JSON.parse(readFileSync(target, "utf8")).id)
  }
  syncBuiltinESMExports()
  let queued
  try { queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch }) }
  finally { fs.writeFileSync = originalWrite; fs.linkSync = originalLink; syncBuiltinESMExports() }
  t.diagnostic(JSON.stringify({ duringExclusivePublication: observation, observationError }))
  assert.equal(observationError, undefined)
  assert.equal(observation.id, queued.id)
  assert.equal(observation.state, "queued")
})

test("unsupported atomic reservation publication is an explicit blocked launch without fallback", (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "unsupported-atomic-state" })
  const original = fs.linkSync
  fs.linkSync = (_source, target) => {
    if (path.basename(target) === "active.json") throw Object.assign(new Error("Owned unsupported atomic primitive"), { code: "EOPNOTSUPP" })
    return original(_source, target)
  }
  syncBuiltinESMExports()
  let queued
  try { queued = requestPublication({ context: f.context, intent, spawnImpl: () => assert.fail("Cannot spawn without atomic reservation") }) }
  finally { fs.linkSync = original; syncBuiltinESMExports() }
  assert.equal(queued.state, "blocked")
  assert.equal(queued.reason, "publication_launch_failed")
  assert.equal(queued.launchError, "EOPNOTSUPP")
  assert.equal(existsSync(path.join(publicationDirectory(f), "active.json")), false)
})

test("retirement cannot create an unbounded same-ticket admission retry after preflight failure", async (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "preflight-no-replay" })
  const queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
  const dir = publicationDirectory(f)
  const originalOpen = fs.opendirSync
  const originalSpawn = childProcess.spawn
  let failed = false
  let launches = 0
  fs.opendirSync = function (name, ...args) {
    if (name === dir && !failed) {
      failed = true
      throw Object.assign(new Error("Owned initial inventory failure"), { code: "EIO" })
    }
    return originalOpen(name, ...args)
  }
  childProcess.spawn = () => { launches += 1; return heldLaunch() }
  syncBuiltinESMExports()
  try { await assert.rejects(runPublicationWorker({ root: f.root, env: f.env, id: queued.id }), { code: "EIO" }) }
  finally { fs.opendirSync = originalOpen; childProcess.spawn = originalSpawn; syncBuiltinESMExports() }
  const active = JSON.parse(readFileSync(path.join(dir, "active.json"), "utf8"))
  assert.equal(launches, 0)
  assert.equal(active.id, queued.id)
  assert.equal(active.retirement.reason, "publication_retirement_admission_unknown")
  assert.equal(readPublication({ context: f.context, id: queued.id }).state, "unknown")
})

for (const form of ["absolute", "file-url", "encoded-file-url", "unsupported-file-url"]) {
  test(`symlink-sensitive parent traversal is rejected before enqueue for ${form}`, (t) => {
    const f = fixture(t)
    const approved = path.join(f.dir, "approved")
    const elsewhere = path.join(f.dir, "elsewhere")
    mkdirSync(approved)
    mkdirSync(path.join(elsewhere, "child"), { recursive: true })
    for (const location of [approved, elsewhere]) {
      const clone = spawnSync("git", ["clone", "--bare", "-q", f.remote, path.join(location, "repo.git")],
        { env: f.env, encoding: "utf8", timeout: 15000 })
      assert.equal(clone.status, 0, clone.stderr)
    }
    fs.symlinkSync(path.join(elsewhere, "child"), path.join(approved, "link"), "dir")
    const traversal = `${approved}/link/../repo.git`
    const route = form === "absolute" ? traversal : form === "unsupported-file-url" ? `file:${traversal}`
      : `file://${traversal.replace("/../", form === "encoded-file-url" ? "/%2e%2e/" : "/../")}`
    f.git("remote", "set-url", "origin", route)
    const context = createPublicationContext({ root: f.root, env: f.env, sessionId: "physical-traversal" })
    assert.throws(() => createPublicationIntent({ context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: form }),
      { code: form === "unsupported-file-url" ? "publication_transport_not_qualified" : "publication_destination_traversal_not_qualified" })
    assert.equal(existsSync(path.join(f.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "sync")), false)
  })
}

test("an unbound context cannot adopt a replacement root through receipt observation", async (t) => {
  const f = fixture(t)
  const stale = f.context
  renameSync(f.root, path.join(f.dir, "original-root"))
  const cloned = spawnSync("git", ["clone", "-q", "-b", "main", f.remote, f.root], { env: f.env, encoding: "utf8", timeout: 15000 })
  assert.equal(cloned.status, 0, cloned.stderr)
  const fresh = createPublicationContext({ root: f.root, env: f.env, sessionId: "replacement-root" })
  const intent = createPublicationIntent({ context: fresh, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "replacement-receipt" })
  const queued = requestPublication({ context: fresh, intent, spawnImpl: heldLaunch })
  const file = path.join(publicationDirectory(f), `${queued.id}.json`)
  const original = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...original, state: "verified",
    owner: { pid: process.pid, start: await readProcessStart(process.pid) },
    resources: { childrenClosed: true }, verification: { remoteCommit: original.targetCommit } }))
  const originalSpawn = childProcess.spawnSync
  let gitCalls = 0
  childProcess.spawnSync = (...args) => { gitCalls += args[0] === "git" ? 1 : 0; return originalSpawn(...args) }
  syncBuiltinESMExports()
  try { assert.throws(() => readPublication({ context: stale, id: queued.id }), { code: "publication_root_changed" }) }
  finally { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports() }
  assert.equal(gitCalls, 0)
  assert.equal(readPublication({ context: fresh, id: queued.id }).state, "verified")
})

test("root replacement during receipt loading is refused before lazy admission", async (t) => {
  const f = fixture(t)
  const stale = f.context
  const savedA = path.join(f.dir, "saved-root-A")
  const savedB = path.join(f.dir, "saved-root-B")
  renameSync(f.root, savedA)
  const cloned = spawnSync("git", ["clone", "-q", "-b", "main", f.remote, f.root], { env: f.env, encoding: "utf8", timeout: 15000 })
  assert.equal(cloned.status, 0, cloned.stderr)
  const fresh = createPublicationContext({ root: f.root, env: f.env, sessionId: "prepared-root-B" })
  const intent = createPublicationIntent({ context: fresh, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "B-receipt" })
  const queued = requestPublication({ context: fresh, intent, spawnImpl: heldLaunch })
  const file = path.join(publicationDirectory(f), `${queued.id}.json`)
  const original = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...original, state: "verified",
    owner: { pid: process.pid, start: await readProcessStart(process.pid) },
    resources: { childrenClosed: true }, verification: { remoteCommit: original.targetCommit } }))
  renameSync(f.root, savedB)
  renameSync(savedA, f.root)
  const originalOpen = fs.openSync
  let replaced = false
  fs.openSync = function (name, ...args) {
    const fd = originalOpen(name, ...args)
    if (name === file && !replaced) {
      replaced = true
      renameSync(f.root, savedA)
      renameSync(savedB, f.root)
    }
    return fd
  }
  syncBuiltinESMExports()
  try { assert.throws(() => readPublication({ context: stale, id: queued.id }), { code: "publication_root_changed" }) }
  finally { fs.openSync = originalOpen; syncBuiltinESMExports() }
  assert.equal(replaced, true)
})

for (const ownerRemaining of [500, 1500]) {
test(`pre-EOF retirement hands off a fresh queued ticket with ${ownerRemaining}ms of old-owner life`, async (t) => {
  const f = fixture(t)
  const oldIntent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "old-terminal-flight" })
  const old = requestPublication({ context: f.context, intent: oldIntent, spawnImpl: heldLaunch })
  const dir = publicationDirectory(f)
  const oldFile = path.join(dir, `${old.id}.json`)
  const previous = JSON.parse(readFileSync(oldFile, "utf8"))
  writeFileSync(oldFile, JSON.stringify({ ...previous, state: "verified",
    owner: { pid: process.pid, start: await readProcessStart(process.pid) },
    resources: { childrenClosed: true }, verification: { remoteCommit: previous.targetCommit } }))
  writeFileSync(path.join(f.root, "own"), "queued before EOF\n")
  f.git("add", "own")
  f.git("commit", "-qm", "pre-EOF target")
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "fresh-pre-EOF" })
  const originalNow = Date.now
  let now = old.deadline - ownerRemaining
  Date.now = () => now
  let queued
  try { queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch }) }
  finally { Date.now = originalNow }
  const originalSync = childProcess.spawnSync
  const originalSpawn = childProcess.spawn
  let inspections = 0
  const handoffs = []
  childProcess.spawnSync = (command, args, options) => {
    const result = originalSync(command, args, options)
    if (command === "git" && args[2] === "config" && args[3] === "--null" && args[4] === "--list") {
      inspections += 1
      now = old.deadline + 1
    }
    return result
  }
  childProcess.spawn = (_command, args, options) => {
    if (args.includes("--native-owner") && ownerRemaining > 1000) {
      const child = originalSpawn(_command, args, options)
      child.on("message", (message) => {
        if (message.kind === "result" && message.status === 0 && inspections === 0) {
          inspections += 1
          now = old.deadline + 1
        }
      })
      return child
    }
    handoffs.push(args.at(-1))
    return heldLaunch()
  }
  Date.now = () => now
  syncBuiltinESMExports()
  let error
  try { await runPublicationWorker({ root: f.root, env: f.env, id: old.id }) }
  catch (observed) { error = observed.code }
  finally { Date.now = originalNow; childProcess.spawnSync = originalSync; childProcess.spawn = originalSpawn; syncBuiltinESMExports() }
  const retained = JSON.parse(readFileSync(path.join(dir, `${queued.id}.json`), "utf8"))
  t.diagnostic(JSON.stringify({ retained, oldDeadline: old.deadline, inspections, handoffs, error }))
  assert.equal(retained.state, "queued")
  assert.equal(retained.deadline, queued.deadline)
  assert.equal(retained.attempts.length, 0)
  assert.equal(existsSync(path.join(dir, "pending", `${queued.id}.json`)), true)
  assert.equal(inspections, ownerRemaining < 1000 ? 0 : 1)
  assert.deepEqual(handoffs, [queued.id])
  assert.equal(error, undefined)
})
}

test("native pre-EOF retirement transfers a live queued ticket under its original deadline", async (t) => {
  const f = fixture(t)
  const retiring = createPublicationContext({ root: f.root, env: f.env, sessionId: "native-retiring-flight", lifetimeMs: 10000 })
  const oldIntent = createPublicationIntent({ context: retiring, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "known-no-launch" })
  const old = requestPublication({ context: retiring, intent: oldIntent, spawnImpl: () => { throw new Error("Owned unavailable launch") } })
  assert.equal(old.state, "blocked")
  const dir = publicationDirectory(f)
  writeFileSync(path.join(dir, "active.json"), JSON.stringify({ id: old.id, dispatch: { pid: process.pid } }))
  writeFileSync(path.join(f.root, "own"), "native pre-EOF handoff\n")
  f.git("add", "own")
  f.git("commit", "-qm", "native pre-EOF handoff")
  const target = f.git("rev-parse", "HEAD")
  const intent = createPublicationIntent({ context: f.context, targetCommit: target, producerOperationId: "native-live-queue" })
  const queued = requestPublication({ context: f.context, intent })
  assert.equal(queued.state, "queued")
  while (Date.now() < old.deadline - 500) await new Promise((resolve) => setTimeout(resolve, 5))
  const remaining = old.deadline - Date.now()
  t.diagnostic(JSON.stringify({ retiringRemainingMs: remaining, queuedDeadline: queued.deadline, oldDeadline: old.deadline,
    oldOwner: "Actual test process invokes retained worker with controlled valid dispatch; new ticket uses actual spawned worker" }))
  assert.ok(remaining > 0 && remaining <= 500)
  await runPublicationWorker({ root: f.root, env: f.env, id: old.id })
  const final = await flushPublication({ context: f.context, id: queued.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ firstFinal: final }))
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(final.deadline, queued.deadline)
  assert.notEqual(final.owner.pid, process.pid)
  assert.equal(final.verification.remoteCommit, target)
  assert.equal(f.bare("rev-parse", "refs/heads/main"), target)
  assert.equal(final.attempts.filter((attempt) => attempt.phase === "push").length, 1)
  assert.equal(final.resources.childrenClosed, true)
})

for (const input of [
  ["internal-tab", "file://", "re\tpo.git"],
  ["internal-cr", "file://", "re\rpo.git"],
  ["trailing-tab", "file://", "repo.git\t"],
  ["leading-space", " file://", "repo.git"],
  ["leading-c0", "\u0001file://", "repo.git"],
  ["trailing-c0", "file://", "repo.git\u0001"],
]) {
  test(`raw destination input is not silently normalized for ${input[0]}`, (t) => {
    const f = fixture(t)
    const folder = path.join(f.dir, "approved")
    mkdirSync(folder)
    const cloned = spawnSync("git", ["clone", "--bare", "-q", f.remote, path.join(folder, "repo.git")],
      { env: f.env, encoding: "utf8", timeout: 15000 })
    assert.equal(cloned.status, 0, cloned.stderr)
    f.git("remote", "set-url", "origin", `${input[1]}${folder}/${input[2]}`)
    const context = createPublicationContext({ root: f.root, env: f.env, sessionId: "raw-route-audit" })
    assert.throws(() => createPublicationIntent({ context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: input[0] }),
      { code: "publication_destination_input_not_qualified" })
  })
}

test("context root identity is checked after recovery binding capture", (t) => {
  const f = fixture(t)
  const prepared = path.join(f.dir, "prepared-root")
  fs.cpSync(f.root, prepared, { recursive: true })
  const original = childProcess.spawnSync
  let replaced = false
  childProcess.spawnSync = function (command, args, options) {
    if (command === "git" && args.includes("--show-toplevel") && !replaced) {
      replaced = true
      renameSync(f.root, path.join(f.dir, "saved-root"))
      renameSync(prepared, f.root)
    }
    return original(command, args, options)
  }
  syncBuiltinESMExports()
  try {
    assert.throws(() => createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "capture-root-race" }),
      { code: "publication_root_changed" })
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports() }
  assert.equal(replaced, true)
})

test("context root identity is checked after the final terminal receipt reread", async (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "terminal-root-race" })
  const queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
  const file = path.join(publicationDirectory(f), `${queued.id}.json`)
  const originalTicket = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...originalTicket, state: "verified",
    owner: { pid: process.pid, start: await readProcessStart(process.pid) },
    resources: { childrenClosed: true }, verification: { remoteCommit: originalTicket.targetCommit } }))
  const prepared = path.join(f.dir, "terminal-prepared-root")
  fs.cpSync(f.root, prepared, { recursive: true })
  const original = fs.openSync
  let opens = 0
  fs.openSync = function (name, ...args) {
    const fd = original(name, ...args)
    if (name === file && ++opens === 2) {
      renameSync(f.root, path.join(f.dir, "terminal-saved-root"))
      renameSync(prepared, f.root)
    }
    return fd
  }
  syncBuiltinESMExports()
  try { assert.throws(() => readPublication({ context: f.context, id: queued.id }), { code: "publication_root_changed" }) }
  finally { fs.openSync = original; syncBuiltinESMExports() }
  assert.equal(opens, 2)
})

for (const scenario of [
  { name: "owner-timeout-closed", operation: "config", timeout: true, closed: true, ownerExpired: true, queued: true, cause: "publication" },
  { name: "owner-timeout-unknown", operation: "config", timeout: true, closed: false, ownerExpired: true, queued: false, cause: "publication" },
  { name: "independent-timeout", operation: "config", timeout: true, closed: true, ownerExpired: false, queued: false },
  { name: "independent-closure-before-owner", operation: "config", timeout: true, closed: true, ownerRemaining: 5200, closureOffset: -100, queued: false, reason: "ETIMEDOUT", inspectionOffset: -200, cause: "inspection" },
  { name: "independent-closure-after-owner", operation: "config", timeout: true, closed: true, ownerRemaining: 5200, closureOffset: 100, queued: false, reason: "ETIMEDOUT", inspectionOffset: -200, cause: "inspection" },
  { name: "equal-bounds-timeout", operation: "config", timeout: true, closed: true, ownerRemaining: 5000, closureOffset: 100, queued: false, reason: "ETIMEDOUT", inspectionOffset: 0, cause: "ambiguous" },
  { name: "successful-late-closure-before-owner", operation: "config", timeout: false, lateSuccess: true, closed: true, ownerRemaining: 5200, closureOffset: -100, queued: false, reason: "ETIMEDOUT", inspectionOffset: -200, cause: "inspection" },
  { name: "successful-late-closure-after-owner", operation: "config", timeout: false, lateSuccess: true, closed: true, ownerRemaining: 5200, closureOffset: 115, queued: false, reason: "ETIMEDOUT", inspectionOffset: -200, cause: "inspection" },
  { name: "successful-late-closure-equal-bounds", operation: "config", timeout: false, lateSuccess: true, closed: true, ownerRemaining: 5000, closureOffset: 115, queued: false, reason: "ETIMEDOUT", inspectionOffset: 0, cause: "ambiguous" },
  { name: "successful-late-closure-owner-bound", operation: "config", timeout: false, lateSuccess: true, closed: true, ownerRemaining: 1500, closureOffset: 115, queued: true, inspectionOffset: 0, cause: "publication" },
  { name: "successful-late-closure-unknown", operation: "config", timeout: false, lateSuccess: true, closed: false, ownerRemaining: 5200, closureOffset: 115, queued: false, cause: "inspection" },
  { name: "successful-late-closure-expired-ticket", operation: "config", timeout: false, lateSuccess: true, closed: true, ownerRemaining: 1500, closureOffset: 115, lifetime: 1000, queued: false, cause: "publication" },
  ...[-100, 115].flatMap((closureOffset) => [
    { kind: "identity-refusal", operation: "config", status: null, primitiveError: "native_owner_identity_unavailable", requestSent: false, reason: "publication_local_inspection_failed" },
    { kind: "nonzero-command", operation: "config", status: 128, requestSent: true, reason: "publication_local_inspection_failed" },
    { kind: "spawn-failure", operation: "config", status: null, primitiveSpawnError: "ENOENT", requestSent: false, reason: "publication_local_inspection_failed" },
    { kind: "configuration-policy", operation: "config", status: 0, stdout: "remote.pushdefault\nunsafe\0", requestSent: true, reason: "publication_push_policy_not_qualified" },
    { kind: "truncated-policy-output", operation: "config", status: 0, stdout: "remote.pushdefault\nunsafe\0", maxOutput: 1, requestSent: true, reason: "publication_local_inspection_failed" },
    { kind: "target-type", operation: "cat-file", status: 0, stdout: "blob\n", requestSent: true, reason: "publication_target_not_commit" },
    { kind: "lfs-policy", operation: "grep", status: 0, stdout: "owned:.gitattributes\n", requestSent: true, reason: "publication_lfs_not_qualified" },
    { kind: "lfs-failure", operation: "grep", status: 128, requestSent: true, reason: "publication_lfs_inspection_unknown" },
    { kind: "private-ref-mismatch", operation: "rev-parse", status: 0, stdout: `${"f".repeat(40)}\n`, requestSent: true, reason: "publication_remote_changed", remoteAttempts: 2 },
    { kind: "dependency-refusal", operation: "merge-base", status: 1, requestSent: true, reason: "publication_dependency_not_fast_forward", remoteAttempts: 2 },
    { kind: "dependency-failure", operation: "merge-base", status: 128, requestSent: true, reason: "publication_dependency_unknown", remoteAttempts: 2 },
    { kind: "cancelled-success", operation: "config", status: 0, requestSent: true, cancelled: true, reason: "publication_cancelled" },
  ].map((outcome) => ({ ...outcome, name: `primitive-${outcome.kind}-${closureOffset < 0 ? "before" : "after"}-owner`,
    primitive: true, closed: true, ownerRemaining: 1500, closureOffset, queued: false }))),
  { name: "primitive-allowed-lfs-absence", operation: "grep", primitive: true, status: 1, requestSent: true, closed: true, ownerRemaining: 1500, closureOffset: 115, queued: true },
  { name: "primitive-genuine-owner-success", operation: "config", primitive: true, status: 0, requestSent: true, closed: true, ownerRemaining: 1500, closureOffset: 115, queued: true },
  { name: "primitive-cancelled-unknown", operation: "config", primitive: true, status: 0, requestSent: true, cancelled: true, closed: false, ownerRemaining: 1500, closureOffset: 115, queued: false },
  { name: "primitive-truncated-deadline", operation: "config", primitive: true, status: null, primitiveError: "deadline",
    stdout: "x".repeat(1048577), requestSent: true, closed: true, ownerRemaining: 1500, closureOffset: 115,
    queued: false, reason: "publication_local_inspection_failed", truncated: true },
  ...["before", "graph", "push", "after"].flatMap((phase) => [
    { kind: "cancelled", cancelled: true, truncated: false },
    { kind: "truncated", cancelled: false, truncated: true },
    { kind: "cancelled-truncated", cancelled: true, truncated: true },
  ].map((flags) => ({ ...flags, name: `outgoing-${phase}-${flags.kind}`, phase, outgoing: true,
    operation: { before: "ls-remote", graph: "fetch", push: "push", after: "ls-remote" }[phase],
    primitive: true, status: 0, requestSent: true, closed: true, ownerRemaining: 1500, closureOffset: -1350,
    queued: false, reason: flags.cancelled ? "publication_cancelled" : "publication_output_truncated",
    remoteAttempts: { before: 1, graph: 2, push: 3, after: 4 }[phase] }))),
  { name: "outgoing-before-unknown-cancelled", phase: "before", outgoing: true, operation: "ls-remote",
    primitive: true, status: 0, requestSent: true, cancelled: true, closed: false, ownerRemaining: 1500,
    closureOffset: -1350, queued: false, remoteAttempts: 1 },
  { name: "independent-pre-admission-before-owner", operation: "config", closed: true, ownerRemaining: 5200, closureOffset: -100, preAdmission: true, queued: false, reason: "ETIMEDOUT" },
  { name: "independent-pre-admission-after-owner", operation: "config", closed: true, ownerRemaining: 5200, closureOffset: 100, preAdmission: true, queued: false, reason: "ETIMEDOUT" },
  { name: "equal-bounds-pre-admission", operation: "config", closed: true, ownerRemaining: 5000, closureOffset: 100, preAdmission: true, queued: false, reason: "ETIMEDOUT" },
  { name: "owner-bound-pre-admission", operation: "config", closed: true, ownerRemaining: 1500, closureOffset: 100, preAdmission: true, queued: true },
  { name: "independent-expired-primitive", operation: "config", closed: true, ownerRemaining: 5200, closureOffset: 100, primitiveExpired: true, queued: false, reason: "ETIMEDOUT" },
  { name: "expired-own-ticket", operation: "config", timeout: true, closed: true, ownerExpired: true, queued: false, lifetime: 1000 },
  { name: "expired-before-lfs", operation: "cat-file", timeout: false, closed: true, ownerExpired: true, queued: true },
  { name: "expired-before-remote", operation: "grep", timeout: false, closed: true, ownerExpired: true, queued: true },
  { name: "expired-remote-primitive-entry", operation: "ls-remote", timeout: false, closed: true, ownerExpired: true, queued: true, primitiveExpired: true },
  { name: "expired-before-ancestor", operation: "rev-parse", timeout: false, closed: true, ownerExpired: true, queued: false, remoteAttempts: 2 },
]) {
  test(`source-controlled inspection closure and deadline: ${scenario.name}`, async (t) => {
    if (!process.env.DESK_PUBLICATION_REVIEW_MODULE) { t.skip("Source-extracted logic control; native closure qualifies separately"); return }
    const f = fixture(t)
    const oldIntent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "inspection-old" })
    const old = requestPublication({ context: f.context, intent: oldIntent, spawnImpl: heldLaunch })
    const dir = publicationDirectory(f)
    const oldFile = path.join(dir, `${old.id}.json`)
    const original = JSON.parse(readFileSync(oldFile, "utf8"))
    writeFileSync(oldFile, JSON.stringify({ ...original, state: "verified",
      owner: { pid: process.pid, start: await readProcessStart(process.pid) },
      resources: { childrenClosed: true }, verification: { remoteCommit: original.targetCommit } }))
    writeFileSync(path.join(f.root, "own"), "inspection deadline\n")
    f.git("add", "own")
    f.git("commit", "-qm", "inspection deadline")
    const context = createPublicationContext({ root: f.root, env: f.env, sessionId: scenario.name, lifetimeMs: scenario.lifetime ?? 60000 })
    const intent = createPublicationIntent({ context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: scenario.name })
    const realNow = Date.now
    let now = old.deadline - (scenario.ownerRemaining ?? 1500)
    Date.now = () => now
    let queued
    try { queued = requestPublication({ context, intent, spawnImpl: heldLaunch }) }
    finally { Date.now = realNow }
    const originalSync = childProcess.spawnSync
    const originalSpawn = childProcess.spawn
    const expiredSpawns = []
    const handoffs = []
    let stimulated = false
    const control = { knownClosure: scenario.outgoing ? true : scenario.closed, calls: [], primitive: scenario.primitive ? scenario : undefined,
      target: queued.targetCommit, before: original.targetCommit,
      lateSuccessOperation: scenario.lateSuccess ? scenario.operation : undefined,
      expiredPrimitiveOperation: scenario.primitiveExpired || scenario.preAdmission ? scenario.operation : undefined,
      expirePolicyCheck: scenario.preAdmission,
      expireBeforeAdmission: () => { stimulated = true; now = old.deadline + (scenario.closureOffset ?? 1) } }
    globalThis.__publicationInspectionProbe = control
    Date.now = () => now
    childProcess.spawnSync = (command, args, options) => {
      if (String(command).endsWith("git") && now >= old.deadline) {
        expiredSpawns.push(args[2])
        return { status: null, error: { code: "ETIMEDOUT" }, signal: "SIGKILL", stdout: "", stderr: "source probe refuses expired dispatch" }
      }
      if (!scenario.primitive && String(command).endsWith("git") && args[2] === scenario.operation && !stimulated &&
        (scenario.operation !== "rev-parse" || args[3]?.startsWith("refs/desk-publication/"))) {
        stimulated = true
        const result = scenario.timeout ? { status: null, error: { code: "ETIMEDOUT" }, signal: "SIGKILL", stdout: "", stderr: "owned simulated inspection timeout" }
          : originalSync(command, args, options)
        now = scenario.closureOffset !== undefined ? old.deadline + scenario.closureOffset
          : scenario.ownerExpired ? old.deadline + 1 : old.deadline - 1400
        return result
      }

      return originalSync(command, args, options)
    }
    childProcess.spawn = (_command, args) => { handoffs.push(args.at(-1)); return heldLaunch() }
    syncBuiltinESMExports()
    let error
    try { await runPublicationWorker({ root: f.root, env: f.env, id: old.id }) }
    catch (observed) { error = observed.code }
    finally {
      Date.now = realNow; childProcess.spawnSync = originalSync; childProcess.spawn = originalSpawn
      delete globalThis.__publicationInspectionProbe
      syncBuiltinESMExports()
    }
    const result = JSON.parse(readFileSync(path.join(dir, `${queued.id}.json`), "utf8"))
    t.diagnostic(JSON.stringify({ scenario: scenario.name, result, expiredSpawns, handoffs, error,
      closureInput: "SOURCE-PROBE VIRTUAL input; not native closure qualification" }))
    assert.equal(stimulated, true)
    assert.equal(expiredSpawns.length, 0)
    assert.equal(result.attempts.length, scenario.remoteAttempts ?? 0)
    if (scenario.reason) {
      assert.equal(result.state, scenario.outgoing && ["push", "after"].includes(scenario.phase) ? "unknown" : "blocked")
      assert.equal(result.reason, scenario.reason)
    }
    if (scenario.preAdmission) {
      assert.equal(control.calls.length, 0)
      assert.equal(result.inspections?.length ?? 0, 0)
    }
    if (scenario.inspectionOffset !== undefined) {
      assert.equal(result.inspections.length, 1)
      const inspection = result.inspections[0]
      assert.equal(inspection.deadline, old.deadline + scenario.inspectionOffset)
      assert.equal(inspection.error, scenario.lateSuccess ? null : "deadline")
      if (scenario.lateSuccess) assert.equal(inspection.status, 0)
      assert.equal(inspection.timedOut, true)
      assert.equal(inspection.requestSent, true)
      assert.equal(inspection.resources.childrenClosed, true)
    }
    if (scenario.cause) assert.equal(result.inspections[0].deadlineCause, scenario.cause)
    if (scenario.primitive && !scenario.outgoing) {
      const inspection = result.inspections.find((entry) => entry.phase === ({
        config: "configuration", "cat-file": "target", grep: "lfs", "rev-parse": "private-ref", "merge-base": "dependency",
      })[scenario.operation])
      assert.ok(inspection)
      assert.equal(inspection.status, scenario.closed ? scenario.status : null)
      assert.equal(inspection.error, scenario.closed ? scenario.primitiveError ?? scenario.primitiveSpawnError ?? null : "helper_closure_unknown")
      assert.equal(inspection.cancelled, scenario.cancelled ?? false)
      assert.equal(inspection.requestSent, scenario.requestSent)
      assert.equal(inspection.resources.childrenClosed, scenario.closed)
      assert.equal(inspection.deadline, old.deadline)
      assert.equal(inspection.deadlineCause, "publication")
      assert.equal(inspection.timedOut, scenario.closureOffset > 0)
      if (scenario.maxOutput) assert.equal(inspection.outputTruncated, true)
      if (scenario.truncated) assert.equal(inspection.outputTruncated, true)
      assert.ok(result.acceptedAt)
      assert.equal(existsSync(path.join(dir, "pending", `${queued.id}.json`)), scenario.queued || !scenario.closed)
    }
    if (scenario.outgoing) {
      const attempt = result.attempts.at(-1)
      assert.equal(attempt.phase, scenario.phase)
      assert.equal(attempt.status, scenario.closed ? 0 : null)
      assert.equal(attempt.cancelled, scenario.cancelled)
      assert.equal(attempt.outputTruncated, scenario.truncated ?? false)
      assert.equal(attempt.requestSent, true)
      assert.equal(attempt.resources.childrenClosed, scenario.closed)
      assert.notEqual(result.state, "verified")
      assert.equal(result.verification, null)
      assert.equal(result.attempts.filter((entry) => entry.phase === "push").length,
        ["push", "after"].includes(scenario.phase) ? 1 : 0)
      assert.equal(existsSync(path.join(dir, "pending", `${queued.id}.json`)), !scenario.closed)
      assert.ok(result.acceptedAt)
    }
    if (scenario.lateSuccess) {
      assert.equal(result.inspections.length, 1)
      assert.equal(result.inspections[0].status, 0)
      assert.equal(result.inspections[0].error, null)
      assert.equal(result.inspections[0].timedOut, true)
      assert.equal(result.inspections[0].requestSent, true)
      assert.equal(result.inspections[0].resources.childrenClosed, scenario.closed)
      assert.ok(result.acceptedAt)
      assert.equal(existsSync(path.join(dir, "pending", `${queued.id}.json`)), scenario.queued || !scenario.closed)
    }
    if (scenario.queued) {
      assert.equal(result.state, "queued")
      assert.deepEqual(handoffs, [queued.id])
      assert.equal(existsSync(path.join(dir, "pending", `${queued.id}.json`)), true)
    } else {
      assert.notEqual(result.state, "queued")
      assert.equal(handoffs.length, 0)
      if (!scenario.closed) assert.equal(result.state, "unknown")
    }
    assert.equal(result.deadline, queued.deadline)
  })
}

test("native local-inspection owner timeout hands off only after actual group closure", async (t) => {
  const f = fixture(t)
  const bin = path.join(f.dir, "inspection-timeout-bin")
  const marker = path.join(f.dir, "inspection-timeout-once")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$3" = config ] && [ "$GIT_TERMINAL_PROMPT" = 0 ] && [ ! -e '${marker}' ]; then
 printf once > '${marker}'
 exec /bin/sleep 2
fi
exec /usr/bin/git "$@"
`, { mode: 0o700 })
  const env = { ...f.env, PATH: `${bin}:${f.env.PATH}` }
  const oldContext = createPublicationContext({ root: f.root, env, sessionId: "old-inspector", lifetimeMs: 10000 })
  const oldIntent = createPublicationIntent({ context: oldContext, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "no-old-dispatch" })
  const old = requestPublication({ context: oldContext, intent: oldIntent, spawnImpl: () => { throw new Error("Owned unavailable old launch") } })
  const dir = publicationDirectory(f)
  writeFileSync(path.join(dir, "active.json"), JSON.stringify({ id: old.id, dispatch: { pid: process.pid } }))
  writeFileSync(path.join(f.root, "own"), "owned inspection timeout\n")
  f.git("add", "own")
  f.git("commit", "-qm", "owned inspection timeout")
  const context = createPublicationContext({ root: f.root, env, sessionId: "new-inspector" })
  const target = f.git("rev-parse", "HEAD")
  const intent = createPublicationIntent({ context, targetCommit: target, producerOperationId: "new-inspection-ticket" })
  const queued = requestPublication({ context, intent })
  while (Date.now() < old.deadline - 1500) await new Promise((resolve) => setTimeout(resolve, 5))
  await runPublicationWorker({ root: f.root, env, id: old.id })
  const retired = JSON.parse(readFileSync(path.join(dir, `${queued.id}.json`), "utf8"))
  t.diagnostic(JSON.stringify({ firstHandoffRead: retired, oldDeadline: old.deadline }))
  const timeout = retired.inspections?.find((inspection) => inspection.error === "deadline" && inspection.timedOut)
  assert.ok(timeout, JSON.stringify(retired))
  assert.equal(timeout.resources.childrenClosed, true)
  assert.equal(timeout.deadline, old.deadline)
  const final = await flushPublication({ context, id: queued.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ firstFinal: final }))
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(final.deadline, queued.deadline)
  assert.equal(final.verification.remoteCommit, target)
  assert.equal(final.attempts.filter((attempt) => attempt.phase === "push").length, 1)
  assert.equal(final.resources.childrenClosed, true)
})

for (const character of ["space", "tab"]) {
test(`an unambiguous encoded file URL retains native publication support for ${character}`, async (t) => {
  const f = fixture(t)
  const remote = path.join(f.dir, character === "space" ? "remote with spaces.git" : "remote with\ttab.git")
  const cloned = spawnSync("git", ["clone", "--bare", "-q", f.remote, remote], { env: f.env, encoding: "utf8", timeout: 15000 })
  assert.equal(cloned.status, 0, cloned.stderr)
  f.git("remote", "set-url", "origin", pathToFileURL(remote).href)
  writeFileSync(path.join(f.root, "own"), "encoded file URL\n")
  f.git("add", "own")
  f.git("commit", "-qm", "encoded file URL")
  const context = createPublicationContext({ root: f.root, env: f.env, sessionId: "encoded-file-support" })
  const target = f.git("rev-parse", "HEAD")
  const intent = createPublicationIntent({ context, targetCommit: target, producerOperationId: "encoded-file-target" })
  const queued = requestPublication({ context, intent })
  const final = await flushPublication({ context, id: queued.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ firstFinal: final }))
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(final.verification.remoteCommit, target)
  assert.equal(final.attempts.filter((attempt) => attempt.phase === "push").length, 1)
  assert.equal(final.resources.childrenClosed, true)
})
}

test("a closed expired ticket hands off queued work without resetting its original deadline", async (t) => {
  const f = fixture(t)
  const expiredContext = createPublicationContext({ root: f.root, env: f.env, sessionId: "expiring-owner", lifetimeMs: 1000 })
  const expiredIntent = createPublicationIntent({ context: expiredContext, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "expired" })
  const expired = requestPublication({ context: expiredContext, intent: expiredIntent, spawnImpl: heldLaunch })
  writeFileSync(path.join(f.root, "own"), "queued with remaining life\n")
  f.git("add", "own")
  f.git("commit", "-qm", "remaining-life target")
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "remaining-life" })
  const queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
  const originalNow = Date.now
  const originalSpawn = childProcess.spawn
  let launches = 0
  Date.now = () => expired.deadline + 1
  childProcess.spawn = () => { launches += 1; return heldLaunch() }
  syncBuiltinESMExports()
  try { await runPublicationWorker({ root: f.root, env: f.env, id: expired.id }) }
  finally { Date.now = originalNow; childProcess.spawn = originalSpawn; syncBuiltinESMExports() }
  const dir = publicationDirectory(f)
  const grant = JSON.parse(readFileSync(path.join(dir, "active.json"), "utf8"))
  const old = JSON.parse(readFileSync(path.join(dir, `${expired.id}.json`), "utf8"))
  const next = JSON.parse(readFileSync(path.join(dir, `${queued.id}.json`), "utf8"))
  t.diagnostic(JSON.stringify({ expired: old, queued: next, handedOffGrant: grant, launches }))
  assert.equal(old.state, "blocked")
  assert.equal(old.reason, "publication_deadline")
  assert.equal(old.attempts.length, 0)
  assert.equal(grant.id, queued.id)
  assert.equal(next.deadline, queued.deadline)
  assert.equal(launches, 1)
})

for (const failure of ["old-deadline-crossing", "post-release-stream-error"]) {
  test(`a cooperating EOF enqueue survives ${failure} during handoff`, async (t) => {
    const f = fixture(t)
    const firstIntent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "before-EOF" })
    const first = requestPublication({ context: f.context, intent: firstIntent, spawnImpl: heldLaunch })
    writeFileSync(path.join(f.root, "own"), "cooperating EOF producer\n")
    f.git("add", "own")
    f.git("commit", "-qm", "EOF producer target")
    const nextIntent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "after-EOF" })
    const dir = publicationDirectory(f)
    const originalOpen = fs.opendirSync
    const originalSpawn = childProcess.spawn
    const originalNow = Date.now
    let now = originalNow()
    let opened = 0
    let injected = false
    let producerObservedBusy = false
    let next
    const handoffs = []
    childProcess.spawn = (_command, args) => {
      if (args.includes("--native-owner")) throw Object.assign(new Error("Owned actor-free command guard"), { code: "owned_probe_no_dispatch" })
      handoffs.push({ id: args.at(-1), at: Date.now() })
      return heldLaunch()
    }

    Date.now = () => now
    fs.opendirSync = function (name, ...args) {
      if (name === dir && ++opened > 1 && failure === "post-release-stream-error") {
        throw Object.assign(new Error("Owned post-release inventory failure"), { code: "EIO" })
      }
      const directory = originalOpen(name, ...args)
      let eof = false
      return {
        readSync() { const entry = directory.readSync(); eof ||= entry === null; return entry },
        closeSync() {
          directory.closeSync()
          if (name === dir && eof && !injected) {
            injected = true
            now = first.deadline - 1
            producerObservedBusy = JSON.parse(readFileSync(path.join(dir, "active.json"), "utf8")).id === first.id
            next = requestPublication({ context: f.context, intent: nextIntent, spawnImpl: heldLaunch })
            if (failure === "old-deadline-crossing") now = first.deadline + 1
          }
        },
      }
    }
    syncBuiltinESMExports()
    try { await runPublicationWorker({ root: f.root, env: f.env, id: first.id }) }
    finally {
      Date.now = originalNow
      fs.opendirSync = originalOpen
      childProcess.spawn = originalSpawn
      syncBuiltinESMExports()
    }
    const active = JSON.parse(readFileSync(path.join(dir, "active.json"), "utf8"))
    const retained = JSON.parse(readFileSync(path.join(dir, `${next.id}.json`), "utf8"))
    t.diagnostic(JSON.stringify({ producerObservedBusy, firstDeadline: first.deadline, next, retained, handoffs, active }))
    assert.equal(producerObservedBusy, true)
    assert.equal(handoffs.length, 1)
    assert.equal(handoffs[0].id, next.id)
    assert.equal(active.id, next.id)
    assert.equal(retained.deadline, next.deadline)
    assert.equal(next.deadline - handoffs[0].at >= 59998, true)
  })
}

test("retirement never hides an inventory error when another generation owns the grant", async (t) => {
  const f = fixture(t)
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "retirement-error" })
  const queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
  const dir = publicationDirectory(f)
  const original = fs.opendirSync
  fs.opendirSync = function (name, ...args) {
    if (name === dir) {
      const file = path.join(dir, "active.json")
      const active = JSON.parse(readFileSync(file, "utf8"))
      writeFileSync(file, JSON.stringify({ ...active, owner: { pid: process.pid, start: "different-generation" } }))
      throw Object.assign(new Error("Owned inventory failure after generation change"), { code: "EIO" })
    }
    return original(name, ...args)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(runPublicationWorker({ root: f.root, env: f.env, id: queued.id }), { code: "EIO" }) }
  finally { fs.opendirSync = original; syncBuiltinESMExports() }
  assert.equal(JSON.parse(readFileSync(path.join(dir, "active.json"), "utf8")).owner.start, "different-generation")
})

test("expired retirement retains unknown custody and exposes it to queued observers", async (t) => {
  const f = fixture(t)
  const context = createPublicationContext({ root: f.root, env: f.env, sessionId: "expired-custody", lifetimeMs: 1000 })
  const firstIntent = createPublicationIntent({ context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "old-flight" })
  const first = requestPublication({ context, intent: firstIntent, spawnImpl: heldLaunch })
  const dir = publicationDirectory(f)
  const template = JSON.parse(readFileSync(path.join(dir, `${first.id}.json`), "utf8"))
  const unknownId = randomUUID()
  const unknown = { ...template, id: unknownId, state: "unknown", reason: "known_unclosed_native_scope",
    owner: { pid: process.pid, start: await readProcessStart(process.pid) }, resources: { childrenClosed: false } }
  const unknownFile = path.join(dir, `${unknownId}.json`)
  writeFileSync(unknownFile, JSON.stringify(unknown))
  writeFileSync(path.join(f.root, "own"), "must wait for custody\n")
  f.git("add", "own")
  f.git("commit", "-qm", "custody-held target")
  const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "waiting-for-custody" })
  const queued = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
  const originalNow = Date.now
  const originalSpawn = childProcess.spawn
  let launches = 0
  Date.now = () => first.deadline + 1
  childProcess.spawn = () => { launches += 1; return heldLaunch() }
  syncBuiltinESMExports()
  try { await runPublicationWorker({ root: f.root, env: f.env, id: first.id }) }
  finally { Date.now = originalNow; childProcess.spawn = originalSpawn; syncBuiltinESMExports() }
  const active = JSON.parse(readFileSync(path.join(dir, "active.json"), "utf8"))
  const observed = readPublication({ context: f.context, id: queued.id })
  t.diagnostic(JSON.stringify({ active, queuedObserver: observed, launches }))
  assert.equal(launches, 0)
  assert.equal(active.id, first.id)
  assert.equal(active.retirement.reason, "publication_retirement_custody_unknown")
  assert.deepEqual(JSON.parse(readFileSync(unknownFile, "utf8")), unknown)
  assert.equal(observed.state, "unknown")
  assert.equal(observed.reason, "publication_retirement_custody_unknown")
  assert.equal(observed.deadline, queued.deadline)
})

test("native observation uses the approved resolved repository despite a last-moment alias switch", async (t) => {
  const f = fixture(t)
  const alias = path.join(f.dir, "native-destination-alias")
  const other = path.join(f.dir, "other.git")
  const clone = spawnSync("git", ["clone", "--bare", "-q", f.remote, other], { env: f.env, encoding: "utf8", timeout: 15000 })
  assert.equal(clone.status, 0, clone.stderr)
  fs.symlinkSync(f.remote, alias, "dir")
  f.git("remote", "set-url", "origin", alias)
  const bin = path.join(f.dir, "resolved-bin")
  const resolved = path.join(f.dir, "observed-destination")
  const graph = path.join(f.dir, "unexpected-graph")
  const pushes = path.join(f.dir, "unexpected-push")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$3" = ls-remote ]; then
 printf '%s' "$7" > '${resolved}'
 rm '${alias}'
 ln -s '${other}' '${alias}'
fi
if [ "$3" = fetch ]; then printf graph > '${graph}'; fi
if [ "$3" = push ]; then printf push > '${pushes}'; fi
exec /usr/bin/git "$@"
`, { mode: 0o700 })
  writeFileSync(path.join(f.root, "own"), "resolved-route target\n")
  f.git("add", "own")
  f.git("commit", "-qm", "resolved-route target")
  const context = createPublicationContext({ root: f.root, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` }, sessionId: "native-resolution" })
  const intent = createPublicationIntent({ context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "native-resolved-route" })
  const queued = requestPublication({ context, intent })
  const file = path.join(publicationDirectory(f), `${queued.id}.json`)
  let recorded
  do {
    recorded = JSON.parse(readFileSync(file, "utf8"))
    if (["verified", "blocked", "unknown"].includes(recorded.state)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() < queued.deadline)
  t.diagnostic(JSON.stringify({ firstSettled: recorded, actualDestination: readFileSync(resolved, "utf8") }))
  assert.equal(recorded.state, "blocked")
  assert.equal(recorded.reason, "publication_binding_changed")
  assert.equal(readFileSync(resolved, "utf8"), fs.realpathSync(f.remote))
  assert.equal(existsSync(graph), false)
  assert.equal(existsSync(pushes), false)
  assert.equal(recorded.attempts[0].status, 0)
  assert.equal(recorded.resources.childrenClosed, true)
})

test("native EOF handoff publishes the same queued ticket under its own unchanged lifetime", async (t) => {
  const f = fixture(t)
  const clock = path.join(f.dir, "virtual-clock-offset")
  const entered = path.join(f.dir, "owner-at-EOF")
  const release = path.join(f.dir, "release-EOF")
  const pushes = path.join(f.dir, "handoff-pushes")
  writeFileSync(clock, "0")
  const loader = path.join(f.dir, "bounded-EOF-clock.cjs")
  writeFileSync(loader, `const fs=require("node:fs")
const {performance}=require("node:perf_hooks")
const {syncBuiltinESMExports}=require("node:module")
const RealDate=Date
const realNow=RealDate.now.bind(RealDate)
const offset=()=>Number(fs.readFileSync(${JSON.stringify(clock)},"utf8"))
global.Date=class extends RealDate{
 constructor(...args){super(...(args.length?args:[realNow()+offset()]))}
 static now(){return realNow()+offset()}
}
if(process.argv.includes("--publication")){
 const original=fs.opendirSync
 fs.opendirSync=function(name,...args){
  const directory=original(name,...args)
  let eof=false
  return{
   readSync(){const entry=directory.readSync();eof||=entry===null;return entry},
   closeSync(){
    directory.closeSync()
    if(eof&&name.endsWith(".publication")&&!fs.existsSync(${JSON.stringify(entered)})){
     fs.writeFileSync(${JSON.stringify(entered)},JSON.stringify({pid:process.pid,id:process.argv.at(-1)}))
     const until=performance.now()+3000
     while(!fs.existsSync(${JSON.stringify(release)})&&performance.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)
     if(!fs.existsSync(${JSON.stringify(release)}))throw Error("Owned EOF stimulus was not released")
    }
   }
  }
 }
 syncBuiltinESMExports()
}
`)
  const bin = path.join(f.dir, "handoff-bin")
  mkdirSync(bin)
  writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ "$3" = push ]; then printf push >> '${pushes}'; fi\nexec /usr/bin/git "$@"\n`, { mode: 0o700 })
  const env = { ...f.env, PATH: `${bin}:${f.env.PATH}`, NODE_OPTIONS: `--require=${loader}` }
  const context = createPublicationContext({ root: f.root, env, sessionId: "native-EOF" })
  const firstIntent = createPublicationIntent({ context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "native-before-EOF" })
  writeFileSync(path.join(f.root, "own"), "native queued handoff\n")
  f.git("add", "own")
  f.git("commit", "-qm", "native queued handoff")
  const target = f.git("rev-parse", "HEAD")
  const nextIntent = createPublicationIntent({ context, targetCommit: target, producerOperationId: "native-after-EOF" })
  const first = requestPublication({ context, intent: firstIntent })
  const dir = publicationDirectory(f)
  while (!existsSync(entered) && Date.now() < first.deadline) {
    const record = JSON.parse(readFileSync(path.join(dir, `${first.id}.json`), "utf8"))
    if (["blocked", "unknown"].includes(record.state)) { t.diagnostic(JSON.stringify({ firstUnexpected: record })); assert.fail(JSON.stringify(record)) }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(existsSync(entered), true)
  const oldOwner = JSON.parse(readFileSync(entered, "utf8"))
  const busy = JSON.parse(readFileSync(path.join(dir, "active.json"), "utf8"))
  assert.equal(busy.id, first.id)
  const realNow = Date.now
  let next
  writeFileSync(clock, String(first.deadline - 1 - realNow()))
  Date.now = () => realNow() + Number(readFileSync(clock, "utf8"))
  try { next = requestPublication({ context, intent: nextIntent }) }
  finally { Date.now = realNow }
  writeFileSync(clock, String(first.deadline + 1 - realNow()))
  writeFileSync(release, "release")
  const final = await flushPublication({ context, id: next.id, timeoutMs: 60000 })
  t.diagnostic(JSON.stringify({ oldOwner, firstDeadline: first.deadline, queuedOriginal: next, firstFinal: final,
    clockControl: "Shared fixture-only virtual wall clock; no OS clock change or elapsed-60s claim" }))
  assert.equal(final.state, "verified", JSON.stringify(final))
  assert.equal(final.id, next.id)
  assert.equal(final.deadline, next.deadline)
  assert.notEqual(final.owner.pid, oldOwner.pid)
  assert.equal(f.bare("rev-parse", "refs/heads/main"), target)
  assert.equal(readFileSync(pushes, "utf8"), "push")
  assert.equal(final.resources.childrenClosed, true)
})

for (const failure of ["EIO", "publication_pending_notification_changed"]) {
  test(`handoff retains its notification and uncertainty after ${failure}`, async (t) => {
    const f = fixture(t)
    const firstIntent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "retirement-failure" })
    const first = requestPublication({ context: f.context, intent: firstIntent, spawnImpl: heldLaunch })
    writeFileSync(path.join(f.root, "own"), "retained notification\n")
    f.git("add", "own")
    f.git("commit", "-qm", "retained notification")
    const intent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "retained-next" })
    const dir = publicationDirectory(f)
    const originalOpen = fs.opendirSync
    const originalSpawn = childProcess.spawn
    const originalNow = Date.now
    let now = originalNow()
    let next
    let injected = false
    let launches = 0
    childProcess.spawn = (_command, args) => {
      if (args.includes("--native-owner")) throw Object.assign(new Error("Owned pregrant guard"), { code: "owned_probe_no_dispatch" })
      launches += 1
      return heldLaunch()
    }
    Date.now = () => now
    fs.opendirSync = function (name, ...args) {
      if (name === path.join(dir, "pending") && failure === "EIO") {
        throw Object.assign(new Error("Owned pending inventory failure"), { code: "EIO" })
      }
      const directory = originalOpen(name, ...args)
      let eof = false
      return {
        readSync() { const entry = directory.readSync(); eof ||= entry === null; return entry },
        closeSync() {
          directory.closeSync()
          if (name === dir && eof && !injected) {
            injected = true
            now = first.deadline - 1
            next = requestPublication({ context: f.context, intent, spawnImpl: heldLaunch })
            if (failure !== "EIO") {
              const file = path.join(dir, "pending", `${next.id}.json`)
              const notification = JSON.parse(readFileSync(file, "utf8"))
              writeFileSync(file, JSON.stringify({ ...notification, bindingKey: "not-the-authorized-binding" }))
            }
            now = first.deadline + 1
          }
        },
      }
    }
    syncBuiltinESMExports()
    try { await assert.rejects(runPublicationWorker({ root: f.root, env: f.env, id: first.id }), { code: failure }) }
    finally { Date.now = originalNow; fs.opendirSync = originalOpen; childProcess.spawn = originalSpawn; syncBuiltinESMExports() }
    const active = JSON.parse(readFileSync(path.join(dir, "active.json"), "utf8"))
    const observed = readPublication({ context: f.context, id: next.id })
    t.diagnostic(JSON.stringify({ firstRetirementFailure: active, queuedObserver: observed, launches }))
    assert.equal(launches, 0)
    assert.equal(active.id, first.id)
    assert.equal(active.retirement.reason, failure)
    assert.equal(observed.state, "unknown")
    assert.equal(observed.reason, failure)
    assert.equal(existsSync(path.join(dir, "pending", `${next.id}.json`)), true)
    assert.equal(observed.deadline, next.deadline)
  })
}

test("a matching caller scope key cannot hide stale captured configuration identity", async (t) => {
  const f = fixture(t)
  const oldIntent = createPublicationIntent({ context: f.context, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "old-config-identity" })
  const old = requestPublication({ context: f.context, intent: oldIntent, spawnImpl: heldLaunch })
  const config = path.join(f.root, ".git", "config")
  writeFileSync(`${config}.replacement`, readFileSync(config))
  renameSync(`${config}.replacement`, config)
  const fresh = createPublicationContext({ root: f.root, env: f.env, sessionId: "new-config-identity" })
  const intent = createPublicationIntent({ context: fresh, targetCommit: f.git("rev-parse", "HEAD"), producerOperationId: "fresh-config-identity" })
  const queued = requestPublication({ context: fresh, intent, spawnImpl: heldLaunch })
  assert.equal(queued.binding.key, old.binding.key)
  const file = path.join(publicationDirectory(f), `${queued.id}.json`)
  const initial = JSON.parse(readFileSync(file, "utf8"))
  writeFileSync(file, JSON.stringify({ ...initial, state: "verified",
    owner: { pid: process.pid, start: await readProcessStart(process.pid) },
    resources: { childrenClosed: true }, verification: { remoteCommit: initial.targetCommit } }))
  const observed = readPublication({ context: f.context, id: queued.id })
  assert.equal(observed.state, "unknown")
  assert.equal(observed.reason, "publication_caller_binding_changed")
})
