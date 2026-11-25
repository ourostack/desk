import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { PassThrough } from "node:stream"
import * as path from "node:path"
import { realpathSync } from "node:fs"
import { main } from "../../../../../plugins/desk/mcp/index.js"
import * as server from "../../../../../plugins/desk/mcp/src/server.js"
import { runAdmissionJob } from "../../../../../plugins/desk/mcp/src/runtime/admission-worker.js"
import { statusObservedSince } from "./_status_observation.js"
import { mkTempRoot } from "../_temp_roots.js"
import { removeTreeSync } from "../_remove_tree.js"

// A folder of this file's own, removed when the file ends. It was named by the process id alone and never removed, so a later run that got the same process id (Windows reuses them quickly) found the earlier run's repositories and failed 19 tests on their leftover branches, remotes and cards.
const here = realpathSync(await mkTempRoot("local-recovery-fixtures-"))
let sequence = 0
function fixture() {
  const root = path.join(here, `desk-${process.pid}-${++sequence}`)
  mkdirSync(path.join(root, "work", "one"), { recursive: true })
  writeFileSync(path.join(root, "work", "one", "task.md"), "---\nname: One\nstatus: drafting\n---\n\n# One\n")
  git(root, "init", "-b", "main")
  git(root, "config", "user.name", "Fixture")
  git(root, "config", "user.email", "fixture@example.invalid")
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", ".")
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture")
  return root
}
function git(root, ...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const env = () => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
})
function args(root, operation = "task_update") {
  return ["--root", root, "--operation", operation]
}
function input(value) {
  const stream = new PassThrough()
  stream.end(typeof value === "string" ? value : JSON.stringify(value))
  return stream
}
const update = { track: "work", slug: "one", status: "processing" }

// Admission, front door, card validation and Git writes are production.
async function launch(options) {
  const toServer = new PassThrough()
  const fromServer = new PassThrough()
  const handle = await main({
    ...options, input: toServer, output: fromServer,
    stateHome: path.join(options.cwd, ".session-state"),
    stderr: { write() {} }, admissionKickoffMs: 0,
    offload: runAdmissionJob,
    runtimeInspector: null,
    readinessPolicy: options.readinessPolicy ?? { semantic: "unsupported" },
    runtimeImporter: async () => server,
  })
  return {
    input: toServer, output: fromServer,
    close: async () => {
      // A refusal may arrive before admission settles. This fixture owns that asynchronous in-process launch as well as the front door.
      // `idle` waits for the attempt running when it is called, and a degraded session starts another at once, so ask until none is running.
      const settleBy = Date.now() + 15000
      while (handle.admission.running && Date.now() < settleBy) await handle.admission.idle({ waitMs: settleBy - Date.now() })
      assert.equal(handle.admission.running, false, "fixture admission must settle before the session closes")
      toServer.end()
      await handle.closed
    },
  }
}
async function recover(root, value = update, extra = [], launcher = launch, operation) {
  const { runRecovery } = await import("../../../../../plugins/desk/mcp/scripts/local-recovery.js")
  return runRecovery({
    argv: [...args(root, operation), ...extra], env: env(), cwd: root,
    input: input(value), launch: launcher, timeoutMs: 15000,
  })
}

test("local recovery is a maintained entry point", async () => {
  const file = new URL("../../../../../plugins/desk/mcp/scripts/local-recovery.js", import.meta.url)
  assert.doesNotThrow(() => readFileSync(file), "the recovery entry point must exist")
})

test("same-root update commits only the requested card, preserving staged and unstaged work", async () => {
  const root = fixture()
  writeFileSync(path.join(root, "staged.txt"), "staged\n")
  git(root, "add", "staged.txt")
  writeFileSync(path.join(root, "loose.txt"), "unstaged\n")
  const result = await recover(root)
  assert.equal(result.exitCode, 0, JSON.stringify(result.report))
  assert.equal(result.report.actualRoot, root)
  assert.equal(result.report.effects.mutation, "reported_applied")
  assert.match(readFileSync(path.join(root, "work/one/task.md"), "utf8"), /status: processing/u)
  assert.equal(git(root, "show", "--format=", "--name-only", "HEAD"), "work/one/task.md")
  assert.equal(git(root, "diff", "--cached", "--name-only"), "staged.txt")
  assert.equal(readFileSync(path.join(root, "loose.txt"), "utf8"), "unstaged\n")
})

for (const [name, value] of [
  ["JSON", '{"note":"SECRET_PARSE_SENTINEL",'],
  ["status", { ...update, status: "SECRET_INVALID_STATUS" }],
  ["frontmatter", { ...update, frontmatter: "SECRET_INVALID_FRONTMATTER" }],
  ["containment", { ...update, track: ".." }],
  ["missing card", { ...update, slug: "absent" }],
]) {
  test(`invalid ${name} refuses without changing the card or HEAD`, async () => {
    const root = fixture()
    const before = readFileSync(path.join(root, "work/one/task.md"), "utf8")
    const head = git(root, "rev-parse", "HEAD")
    const result = await recover(root, value)
    assert.notEqual(result.exitCode, 0)
    assert.equal(readFileSync(path.join(root, "work/one/task.md"), "utf8"), before)
    assert.equal(git(root, "rev-parse", "HEAD"), head)
    assert.doesNotMatch(JSON.stringify(result.report), /SECRET_/u)
    if (name !== "JSON") assert.equal(result.report.effects.mutation, "unknown", `isError alone cannot prove no write: ${JSON.stringify(result.report)}`)
  })
}

test("a missing explicit root never launches or falls back", async () => {
  const root = fixture()
  const result = await recover(path.join(root, "missing"), update, [], async () => assert.fail("no launch"))
  assert.equal(result.report.code, "root_unavailable")
  assert.equal(result.report.effects.mutation, "not_dispatched")
})

test("actual-root mismatch refuses before dispatch", async () => {
  const requested = fixture()
  const actual = fixture()
  const before = git(actual, "rev-parse", "HEAD")
  const result = await recover(requested, update, [], (options) => launch({ ...options, argv: ["--root", actual] }))
  assert.equal(result.report.code, "root_mismatch")
  assert.equal(result.report.actualRoot, actual)
  assert.equal(result.report.effects.mutation, "not_dispatched")
  assert.equal(git(actual, "rev-parse", "HEAD"), before)
})

test("commit failure remains partial and retains the real applied write", async (t) => {
  const root = fixture()
  const head = git(root, "rev-parse", "HEAD")
  writeFileSync(path.join(root, ".git", "index.lock"), "fixture lock")
  const result = await recover(root)
  assert.equal(result.exitCode, 2, JSON.stringify(result.report))
  assert.equal(result.report.effects.commit, "failed")
  assert.equal(result.report.result.status, "commit_failed")
  assert.match(result.report.result.commit.reason, /index\.lock/u)
  t.diagnostic(JSON.stringify({ exitCode: result.exitCode, status: result.report.result.status, commit: result.report.effects.commit }))
  assert.match(readFileSync(path.join(root, "work/one/task.md"), "utf8"), /status: processing/u)
  assert.equal(git(root, "rev-parse", "HEAD"), head)
})

test("a configured remote is pending, not blanket success", async () => {
  const root = fixture()
  git(root, "remote", "add", "origin", path.join(root, "nonexistent-remote"))
  const result = await recover(root)
  assert.equal(result.exitCode, 2)
  assert.equal(result.report.effects.push, "pending")
  assert.match(readFileSync(path.join(root, "work/one/task.md"), "utf8"), /status: processing/u)
})

// The server runs on the real process environment, as it does under bootstrap.cjs, so the tools' own push scheduling
// sees the mode. The run without the option is the control: it proves the real worker pushes here.
for (const deferred of [false, true]) {
  test(`${deferred ? "deferred publication commits and leaves the remote alone" : "without deferral the same write reaches the remote"}`, async () => {
    const root = fixture()
    const remote = `${root}-remote`
    const init = spawnSync("git", ["init", "--bare", "-b", "main", remote], { encoding: "utf8", timeout: 5000 })
    assert.equal(init.status, 0, init.stderr)
    git(root, "remote", "add", "origin", remote)
    git(root, "push", "--quiet", "-u", "origin", "main")
    const before = git(root, "--git-dir", remote, "rev-parse", "refs/heads/main")
    let serverEnv
    try {
      const result = await recover(root, update, deferred ? ["--publication", "deferred"] : [], (options) => {
        if (deferred) assert.deepEqual(options.argv.slice(-2), ["--publication", "deferred"])
        serverEnv = process.env
        return launch({ ...options, env: process.env })
      })
      assert.equal(result.report.effects.commit, "observed", JSON.stringify(result.report))
      assert.equal(result.report.effects.push, deferred ? "deferred" : "pending")
      assert.equal(result.exitCode, deferred ? 0 : 2)
      assert.equal(serverEnv.DESK_PUBLICATION, deferred ? "deferred" : undefined)
      const committed = git(root, "rev-parse", "HEAD")
      assert.notEqual(committed, before)
      let landed = before
      for (let waited = 0; waited < 15_000 && landed === before; waited += 250) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        if (deferred && waited >= 6000) break
        landed = git(root, "--git-dir", remote, "rev-parse", "refs/heads/main")
      }
      assert.equal(landed, deferred ? before : committed)
    } finally {
      delete process.env.DESK_PUBLICATION
    }
  })
}

test("an unknown publication mode refuses before launch", async () => {
  const root = fixture()
  const result = await recover(root, update, ["--publication", "later"], async () => assert.fail("no launch"))
  assert.equal(result.report.code, "invalid_arguments")
})

test("state-branch options cannot override undeclared branch policy", async () => {
  const root = fixture()
  const head = git(root, "rev-parse", "HEAD")
  const result = await recover(root, update, ["--state-branch", "main"], async () => assert.fail("no launch"))
  assert.equal(result.report.code, "state_branch_not_declared")
  assert.equal(git(root, "rev-parse", "HEAD"), head)
})

// A fake server that answers every request, after `statusDelayMs` for desk_status, and answers task_update after `updateDelayMs`
// (never, when it is null). It records each task_update it receives and applies an effect before answering.
function fakeServer(root, { statusDelayMs = 0, updateDelayMs = null, onDispatch, onStatus, result = { status: "nothing_to_commit" } }) {
  return async () => {
    const toServer = new PassThrough()
    const fromServer = new PassThrough()
    const reply = (id, result, delayMs) => setTimeout(() => fromServer.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"), delayMs)
    toServer.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString())
      if (!request.id) return
      if (request.method === "tools/list") return reply(request.id, { tools: [{ name: "task_update" }] }, 0)
      if (request.params?.name === "desk_status") {
        onStatus?.()
        return reply(request.id, { content: [{ type: "text", text: JSON.stringify({
        state: "ready", root: { valid: true, path: root }, write_scope: { mode: "workspace", person: null, relative_path: "." },
        sync: "no remote configured",
        }) }] }, statusDelayMs)
      }
      if (request.params?.name === "task_update") {
        onDispatch()
        writeFileSync(path.join(root, "applied.txt"), "effect before answer")
        if (updateDelayMs !== null) reply(request.id, { content: [{ type: "text", text: JSON.stringify(result) }] }, updateDelayMs)
        return
      }
      reply(request.id, {}, 0)
    })
    return { input: toServer, output: fromServer, close: async () => toServer.end() }
  }
}

test("timeout after dispatch is unknown and is never resent", async () => {
  const root = fixture()
  let dispatches = 0
  const { runRecovery } = await import("../../../../../plugins/desk/mcp/scripts/local-recovery.js")
  // The dispatched call's own budget starts when it is sent, so a loaded machine's slow startup cannot spend it first.
  const result = await runRecovery({
    argv: args(root), env: env(), cwd: root, input: input(update), dispatchTimeoutMs: 80,
    launch: fakeServer(root, { onDispatch: () => dispatches++ }),
  })
  assert.equal(result.report.code, "timeout")
  assert.equal(result.report.effects.mutation, "unknown")
  assert.match(result.report.readback, /HEAD/u)
  assert.equal(dispatches, 1)
  assert.equal(readFileSync(path.join(root, "applied.txt"), "utf8"), "effect before answer")
})

test("a slow startup does not shorten the dispatched call's budget", async () => {
  const root = fixture()
  let dispatches = 0
  const { runRecovery } = await import("../../../../../plugins/desk/mcp/scripts/local-recovery.js")
  // Startup spends 300 of its 400 ms; the dispatched call then answers after 300 ms, inside its own 2 s budget. With one deadline
  // for the whole session, the call would time out with an applied but unknown write.
  const result = await runRecovery({
    argv: args(root), env: env(), cwd: root, input: input(update), timeoutMs: 400, dispatchTimeoutMs: 2000,
    launch: fakeServer(root, { statusDelayMs: 300, updateDelayMs: 300, onDispatch: () => dispatches++ }),
  })
  assert.equal(dispatches, 1)
  assert.notEqual(result.report.code, "timeout", JSON.stringify(result.report))
  assert.equal(result.report.effects.mutation, "reported_complete", JSON.stringify(result.report))
})

test("the whole run ends within its total budget, which caps the dispatched call's own budget", async (t) => {
  const root = fixture()
  let dispatches = 0
  const { runRecovery } = await import("../../../../../plugins/desk/mcp/scripts/local-recovery.js")
  // Advance the budget clock by exactly 300 ms at preflight. Real sleeping made
  // this test refuse before dispatch when instrumented Git/setup spent the
  // remaining budget on a loaded host. Keep all budgets and the real elapsed
  // ceiling: the write's real 300 ms answer must lose to its capped 200 ms timer.
  const clockStart = Date.now()
  let clock = clockStart
  t.mock.method(Date, "now", () => clock)
  const started = performance.now()
  const result = await runRecovery({
    argv: args(root), env: env(), cwd: root, input: input(update), timeoutMs: 400, dispatchTimeoutMs: 2000, totalTimeoutMs: 500,
    launch: fakeServer(root, { onStatus: () => { clock = clockStart + 300 }, updateDelayMs: 300, onDispatch: () => dispatches++ }),
  })
  assert.equal(dispatches, 1)
  assert.equal(result.report.code, "timeout", JSON.stringify(result.report))
  assert.equal(result.report.effects.mutation, "unknown")
  assert.equal(readFileSync(path.join(root, "applied.txt"), "utf8"), "effect before answer")
  assert.ok(performance.now() - started < 1500, "the run ended near its 500 ms total, not after the write's 2 s")
})

// task_update used to write such a card and skip the commit, and the recovery reported `commit_not_observed`; it now commits the card
// with the edit it already held, and its answer says so.
test("an already edited card is committed with its earlier edit, and the answer says the commit includes it", async () => {
  const root = fixture()
  const head = git(root, "rev-parse", "HEAD")
  writeFileSync(path.join(root, "work/one/task.md"), readFileSync(path.join(root, "work/one/task.md"), "utf8") + "\nLocal edit\n")
  const result = await recover(root)
  assert.equal(result.report.effects.commit, "observed", JSON.stringify(result.report))
  assert.notEqual(git(root, "rev-parse", "HEAD"), head)
  assert.match(result.report.result.included_uncommitted_changes, /this commit includes them/u)
  assert.match(git(root, "show", "HEAD:work/one/task.md"), /Local edit/u)
  assert.equal(git(root, "status", "--porcelain", "--", "work/one/task.md"), "")
})

for (const [operation, value, expected] of [
  ["task_create", { track: "work", slug: "two", title: "Two" }, "work/two/task.md"],
  ["task_archive", { track: "work", slug: "one", outcome: "cancelled" }, "work/_archive/one/task.md"],
  ["desk_save", { files: [{ path: "report.txt", content: "PRIVATE_CONTENT_SENTINEL" }], message: "Save report" }, "report.txt"],
]) {
  test(`${operation} uses the full validated pipeline and exact-path Git commits`, async () => {
    const root = fixture()
    writeFileSync(path.join(root, "peer.txt"), "peer")
    git(root, "add", "peer.txt")
    const result = await recover(root, value, [], launch, operation)
    assert.equal(result.exitCode, 0, JSON.stringify(result.report))
    assert.ok(readFileSync(path.join(root, expected)).length > 0)
    assert.ok(git(root, "show", "--format=", "--name-only", "HEAD").includes(expected))
    assert.equal(git(root, "diff", "--cached", "--name-only"), "peer.txt")
    assert.doesNotMatch(JSON.stringify(result.report), /PRIVATE_CONTENT_SENTINEL/u)
  })
}

test("person authority denial preserves card and HEAD", async () => {
  const root = fixture()
  const head = git(root, "rev-parse", "HEAD")
  const card = readFileSync(path.join(root, "work/one/task.md"), "utf8")
  const result = await recover(root, update, ["--person", "ari"])
  assert.equal(result.report.code, "admission_refused")
  assert.equal(result.report.effects.mutation, "not_dispatched")
  assert.equal(git(root, "rev-parse", "HEAD"), head)
  assert.equal(readFileSync(path.join(root, "work/one/task.md"), "utf8"), card)
})

test("provider/person disagreement is not bypassed by local recovery", async () => {
  const root = fixture()
  const head = git(root, "rev-parse", "HEAD")
  const result = await recover(root, update, ["--person", "ari"], (options) => launch({
    ...options,
    readinessPolicy: { semantic: "unsupported", write_authority: "person", authority_provider: "registry" },
    authorityProviders: { registry: async () => ({ mode: "person", person: "bob" }) },
  }))
  assert.equal(result.report.code, "admission_refused")
  assert.equal(result.report.effects.mutation, "not_dispatched")
  assert.equal(git(root, "rev-parse", "HEAD"), head)
})

test("declared state branch preserves the runtime's refusal without switching dirty state", async () => {
  const root = fixture()
  const config = path.join(root, "activation.json")
  writeFileSync(config, JSON.stringify({ schema_version: 1, desk: { root, state_branch: "main" } }))
  git(root, "switch", "-c", "feature")
  writeFileSync(path.join(root, "work/one/task.md"), readFileSync(path.join(root, "work/one/task.md"), "utf8") + "\nDirty\n")
  const head = git(root, "rev-parse", "HEAD")
  const result = await recover(root, update, ["--activation-config", config, "--state-branch", "main"])
  assert.equal(result.report.code, "admission_refused")
  assert.equal(result.report.effects.mutation, "not_dispatched")
  assert.equal(git(root, "branch", "--show-current"), "feature")
  assert.equal(git(root, "rev-parse", "HEAD"), head)
  assert.match(readFileSync(path.join(root, "work/one/task.md"), "utf8"), /Dirty/u)
})

test("a legitimately declared person scope writes only that person's card", async () => {
  const root = fixture()
  mkdirSync(path.join(root, "desks/ari/work/one"), { recursive: true })
  writeFileSync(path.join(root, "desks/ari/work/one/task.md"), readFileSync(path.join(root, "work/one/task.md"), "utf8"))
  git(root, "add", "desks")
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "person fixture")
  const workspaceCard = readFileSync(path.join(root, "work/one/task.md"), "utf8")
  const result = await recover(root, update, ["--person", "ari"], (options) => launch({
    ...options, readinessPolicy: { semantic: "unsupported", write_authority: "person" },
  }))
  assert.equal(result.exitCode, 0, JSON.stringify(result.report))
  assert.equal(git(root, "show", "--format=", "--name-only", "HEAD"), "desks/ari/work/one/task.md")
  assert.equal(readFileSync(path.join(root, "work/one/task.md"), "utf8"), workspaceCard)
})

test("stdin waiting is bounded before any launch", async () => {
  const { runRecovery } = await import("../../../../../plugins/desk/mcp/scripts/local-recovery.js")
  const root = fixture()
  const waiting = new PassThrough()
  // The watchdog is a test bound, not a successful fallback.
  const watchdog = setTimeout(() => waiting.end("{}"), 1000)
  const started = Date.now()
  try {
    const result = await runRecovery({
      argv: args(root), env: env(), cwd: root, input: waiting,
      launch: async () => assert.fail("input timeout must not launch"), timeoutMs: 50,
    })
    assert.equal(result.report.code, "timeout")
    assert.equal(result.report.effects.mutation, "not_dispatched")
    assert.ok(Date.now() - started < 500)
  } finally {
    clearTimeout(watchdog)
    waiting.destroy()
  }
})

for (const [operation, value, refused] of [
  ["task_update", update, false],
  ["task_create", { track: "work", slug: "two", title: "Two" }, false],
  ["task_archive", { track: "work", slug: "one", outcome: "cancelled" }, false],
  ["desk_save", { files: [{ path: "report.txt", content: "Report" }], message: "Save" }, false],
  ["task_update", { ...update, status: "invalid" }, true],
  ["task_update", { ...update, frontmatter: [] }, true],
  ["task_update", { ...update, track: ".." }, true],
  ["task_update", { ...update, slug: "missing" }, true],
]) {
  test(`ordinary MCP and local entry have the same ${refused ? "refusal" : "write"} outcome: ${operation} ${JSON.stringify(value)}`, async () => {
    await import("../_isolated_env.mjs")
    const { startInProcess } = await import("./_in_process_desk.js")
    const mcpRoot = fixture()
    const localRoot = fixture()
    const desk = await startInProcess({
      argv: ["--root", mcpRoot], cwd: mcpRoot, env: env(),
      stateHome: path.join(mcpRoot, ".session-state"), runtimeInspector: null,
      readinessPolicy: { semantic: "unsupported" },
      runtimeImporter: async () => server,
    })
    try {
      const since = Date.now()
      await desk.statusUntil((state) => state.state === "ready" &&
        statusObservedSince(state, { root: mcpRoot, since }), { deadlineMs: 15000 })
      const direct = await desk.call(operation, value)
      const local = await recover(localRoot, value, [], launch, operation)
      assert.equal(direct.isError, refused, JSON.stringify(direct.payload))
      assert.equal(local.exitCode === 0, !refused, JSON.stringify(local.report))
      // A run that fails before the tool answers has no result; the report then names the code and the step that failed.
      assert.equal(local.report.result?.status, direct.payload.status, JSON.stringify(local.report))
      assert.equal(git(localRoot, "show", "--format=", "--name-only", "HEAD"), git(mcpRoot, "show", "--format=", "--name-only", "HEAD"))
      if (refused) {
        assert.equal(readFileSync(path.join(localRoot, "work/one/task.md"), "utf8"), readFileSync(path.join(mcpRoot, "work/one/task.md"), "utf8"))
      }
    } finally {
      await desk.close()
    }
  })
}

for (const delayedResolution of [false, true]) test(`the spawned CLI updates a real Git desk through ordinary bootstrap with no test runtime${delayedResolution ? " while destination verification is pending" : ""}`, {
  skip: process.platform === "win32" ? "This native Unix fixture verifies exact PID teardown with ps; protocol and in-process Git coverage remain cross-platform." : false,
}, async () => {
  const root = fixture()
  const home = path.join(root, ".child-home")
  mkdirSync(home)
  const activation = path.join(root, "activation.json")
  writeFileSync(activation, JSON.stringify({
    schema_version: 1, desk: { root },
    desk_runtime: { root: "workspace", write_authority: "workspace", lexical: "required", semantic: "unsupported" },
  }))
  const file = path.join(root, "input.json")
  writeFileSync(file, JSON.stringify(update))
  const preload = path.join(root, "delayed-worker.cjs")
  const statusEvidence = path.join(root, "pending-status.jsonl")
  const delayMarker = path.join(root, "completed-status.marker")
  const completedStatus = path.join(root, "completed-status.json")
  const resolverEvidence = path.join(root, "resolver-delay.jsonl")
  const beforeCount = Number(git(root, "rev-list", "--count", "HEAD"))
  if (delayedResolution) {
    // Delay only delivery to the real resolver worker. Bootstrap, admission,
    // runtime, authority, status consumer and mutation all remain production.
    writeFileSync(preload, `
const threads = require("node:worker_threads");
const { syncBuiltinESMExports } = require("node:module");
const { appendFileSync, existsSync } = require("node:fs");
const OriginalWorker = threads.Worker;
threads.Worker = class extends OriginalWorker {
  postMessage(job, ...rest) {
    if (job?.kind === "resolve" && existsSync(${JSON.stringify(delayMarker)})) {
      appendFileSync(${JSON.stringify(resolverEvidence)}, JSON.stringify({
        observedCompletedStatus: true, injectedDelayMs: 150, at: new Date().toISOString(),
      }) + "\\n");
      setTimeout(() => super.postMessage(job, ...rest), 150);
    } else {
      return super.postMessage(job, ...rest);
    }
  }
};
syncBuiltinESMExports();
if (threads.isMainThread) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = function(chunk, ...rest) {
    try {
      const response = JSON.parse(String(chunk));
      const status = JSON.parse(response.result?.content?.[0]?.text);
      if (status.admission) appendFileSync(${JSON.stringify(statusEvidence)}, JSON.stringify({
        state: status.state, writes: status.admission.writes,
        detail: status.status_detail, from: status.status_detail_from,
        pending: status.detail_pending, root: status.root?.path, scope: status.write_scope?.mode ?? null, at: new Date().toISOString(),
      }) + "\\n");
    } catch {}
    return write(chunk, ...rest);
  };
}
`)
  }
  const script = delayedResolution
    ? new URL("./_prewarmed_recovery.js", import.meta.url)
    : new URL("../../../../../plugins/desk/mcp/scripts/local-recovery.js", import.meta.url)
  const { fileURLToPath } = await import("node:url")
  const result = spawnSync(process.execPath, [
    fileURLToPath(script), ...args(root), "--activation-config", activation, "--input-file", file,
  ], {
    cwd: root, encoding: "utf8", timeout: 75000,
    env: {
      ...env(), HOME: home, USERPROFILE: home,
      XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
      XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
      XDG_RUNTIME_DIR: path.join(home, "runtime"),
      ...(delayedResolution ? {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`,
        DESK_FIXTURE_DELAY_MARKER: delayMarker, DESK_FIXTURE_COMPLETED_STATUS: completedStatus,
      } : {}),
    },
  })
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  const report = JSON.parse(result.stdout)
  if (delayedResolution) {
    const completed = JSON.parse(readFileSync(completedStatus, "utf8"))
    assert.equal(completed.state, "ready")
    assert.equal(completed.root, root)
    assert.ok(completed.elapsedMs < 200, "observable completed status retains the unchanged cap")
    assert.ok(completed.readinessElapsedMs < 15000, "prewarm retains the original readiness deadline")
    assert.equal(completed.observations.at(-1).ready, true)
    assert.equal(completed.observations.at(-1).qualified, true)
    assert.equal(completed.observations.at(-1).elapsedMs, completed.elapsedMs)
    assert.ok(completed.observations.every((sample) => Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0))
    assert.equal(report.preflight.statusDetail, "cached_in_owned_session")
    assert.ok(Date.parse(report.preflight.statusDetailFrom) > 0)
    const observed = readFileSync(statusEvidence, "utf8").trim().split("\n").map(JSON.parse)
    // Several pending-marked details can be answered while resolution is delayed, and the client keeps polling until a ready status
    // also passes its write-scope check, so its preflight need not be the first one: on Linux CI it was one computed about 0.7 s
    // later. The preflight must be one of the pending-marked details answered after the prewarm finished.
    const answered = observed.filter((status) => Date.parse(status.at) >= Date.parse(completed.completedObservedAt) &&
      status.detail?.includes("Destination verification is pending") && status.detail.startsWith("cached:"))
    assert.ok(answered.length > 0, "the actual bootstrap must publish a completed same-context detail while resolution is pending")
    const pending = answered.find((status) => status.from === report.preflight.statusDetailFrom)
    assert.ok(pending, `the preflight must use a pending-marked detail: ${JSON.stringify({ preflight: report.preflight, answered })}`)
    assert.equal(pending.writes, "refused")
    assert.equal(pending.root, root)
    assert.ok(Date.parse(pending.from) > 0)
    if (completed.from) assert.ok(Date.parse(pending.from) >= Date.parse(completed.from), "pending detail never predates the observed completed cache")
    const delayed = readFileSync(resolverEvidence, "utf8").trim().split("\n").map(JSON.parse)
    assert.ok(delayed.length > 0)
    assert.ok(delayed.every((job) => job.observedCompletedStatus && job.injectedDelayMs === 150 &&
      Date.parse(job.at) >= Date.parse(completed.completedObservedAt)))
  }
  assert.equal(report.actualRoot, root)
  assert.equal(report.effects.commit, "observed")
  assert.equal(git(root, "show", "--format=", "--name-only", "HEAD"), "work/one/task.md")
  assert.equal(Number(git(root, "rev-list", "--count", "HEAD")), beforeCount + 1, "no mutation replay")
  assert.match(readFileSync(path.join(root, "work/one/task.md"), "utf8"), /status: processing/u)
})

// A queued log is in the working tree when the call returns. Its commit belongs to Desk's background writer, so the tests below accept either moment and only assert what holds at both.
async function commitOfLog(root, rel, headBefore) {
  const stop = Date.now() + 30000
  while (Date.now() < stop) {
    if (git(root, "rev-parse", "HEAD") !== headBefore && git(root, "status", "--porcelain", "--", rel) === "") return git(root, "show", "--format=", "--name-only", "HEAD")
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return null
}
const logOnly = { track: "work", slug: "one", log: "Diagnosed: the P0 cause is the stale index." }

function assertQueuedOrObserved(result, rel, headBefore, root) {
  const { report } = result
  assert.equal(report.effects.mutation, "reported_applied", JSON.stringify(report))
  assert.equal(report.queued.path, rel)
  assert.match(readFileSync(path.join(root, rel), "utf8"), /stale index/u, "the entry is in the log whichever moment this reads")
  assert.notEqual(report.code, "unexpected_tool_result")
  if (report.effects.log === "queued") {
    assert.equal(result.exitCode, 2)
    assert.equal(report.status, "partial")
    assert.equal(report.code, "commit_queued")
    assert.equal(report.effects.commit, "queued")
    assert.equal(report.git.headBefore, report.git.headAfter, "nothing committed at return")
    assert.match(report.readback, /Do not resend/u)
  } else {
    assert.equal(report.effects.log, "observed")
    assert.equal(report.effects.commit, "observed")
    assert.notEqual(report.git.headAfter, headBefore)
  }
}

test("a log-only update is reported as an admitted queued write, not unexpected_tool_result", async () => {
  const root = fixture()
  const headBefore = git(root, "rev-parse", "HEAD")
  const result = await recover(root, logOnly)
  assertQueuedOrObserved(result, "work/one/log.md", headBefore, root)
  assert.equal(result.report.effects.push, "not_applicable")
  assert.equal(await commitOfLog(root, "work/one/log.md", headBefore), "work/one/log.md")
  assert.equal(Number(git(root, "rev-list", "--count", `${headBefore}..HEAD`)), 1, "one commit, no replay")
})

test("a log-only update in a published member desk is queued under the default coordination purpose", async () => {
  const root = fixture()
  mkdirSync(path.join(root, "desks/ari/work/one"), { recursive: true })
  mkdirSync(path.join(root, ".desk"))
  writeFileSync(path.join(root, "desks/ari/work/one/task.md"), readFileSync(path.join(root, "work/one/task.md"), "utf8"))
  writeFileSync(path.join(root, ".desk/content-home.json"), JSON.stringify({
    schema_version: 1, mode: "declared-purpose", repository: "sample/context",
    context_purposes: ["coordination", "project-plan", "metadata", "source-context", "historical-evidence", "migration-pointer"],
    product_purposes: ["product-contract", "product-tool", "product-run-artifact"],
  }))
  git(root, "add", ".")
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "member desk")
  const remote = path.join(here, `remote-${process.pid}-${++sequence}.git`)
  git(root, "init", "--bare", "-b", "main", remote)
  git(root, "remote", "add", "origin", remote)
  git(root, "push", "--quiet", "-u", "origin", "main")
  const headBefore = git(root, "rev-parse", "HEAD")
  const rel = "desks/ari/work/one/log.md"
  const result = await recover(root, logOnly, ["--person", "ari"], (options) => launch({
    ...options, readinessPolicy: { semantic: "unsupported", write_authority: "person" },
  }))
  assertQueuedOrObserved(result, rel, headBefore, root)
  assert.equal(result.report.effects.push, "pending")
  assert.equal(await commitOfLog(root, rel, headBefore), rel)
  assert.equal(readFileSync(path.join(root, "work/one/task.md"), "utf8").includes("log"), false)
})

test("a mixed update keeps the observed card commit and the queued log separate, at either timing", async () => {
  const root = fixture()
  const headBefore = git(root, "rev-parse", "HEAD")
  const result = await recover(root, { ...logOnly, status: "processing" })
  const { report } = result
  // Under heavy host load the real card commit can exhaust its own time budget; recovery then correctly says commit_unknown, and the deterministic cases below cover the observed path.
  if (report.result.commit?.status === "unknown") return assert.equal(report.code, "commit_unknown")
  assert.equal(report.effects.commit, "observed", JSON.stringify(report))
  assert.equal(report.queued.path, "work/one/log.md")
  assert.ok(["queued", "observed"].includes(report.effects.log), JSON.stringify(report))
  assert.equal(result.exitCode, report.effects.log === "queued" ? 2 : 0)
  if (report.effects.log === "queued") assert.equal(report.code, "commit_queued")
  assert.match(readFileSync(path.join(root, "work/one/task.md"), "utf8"), /status: processing/u)
  // Whichever commit lands first, the log ends committed once, under its own path.
  const stop = Date.now() + 30000
  while (Date.now() < stop && spawnSync("git", ["cat-file", "-e", "HEAD:work/one/log.md"], { cwd: root }).status !== 0) await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(git(root, "status", "--porcelain", "--", "work/one/log.md"), "")
  assert.equal(Number(git(root, "rev-list", "--count", `${headBefore}..HEAD`)), 2)
  assert.equal(git(root, "log", "--format=%H", "--", "work/one/log.md").split("\n").length, 1)
})

// The fake server's tool call applies `during` to the fixture before answering, so each timing is exact rather than raced.
const MIXED = { status: "updated", commit: { status: "committed" }, log: { path: "work/one/log.md", commit: "queued" } }
function commitCard(root) {
  writeFileSync(path.join(root, "work/one/task.md"), "---\nname: One\nstatus: processing\n---\n\n# One\n")
  git(root, "add", "work/one/task.md")
  git(root, "commit", "-m", "card")
}
async function mixed(during, answer = MIXED, extra = []) {
  const root = fixture()
  const { runRecovery } = await import("../../../../../plugins/desk/mcp/scripts/local-recovery.js")
  const result = await runRecovery({
    argv: [...args(root), ...extra], env: env(), cwd: root, input: input(logOnly),
    launch: fakeServer(root, { onDispatch: () => during(root), updateDelayMs: 0, result: answer }),
  })
  return { root, ...result }
}
const writeLog = (root) => writeFileSync(path.join(root, "work/one/log.md"), "# Log\n\n## entry\n")

test("mixed update, log still pending after the card commit: card observed, log queued, exit 2", async () => {
  const { report, exitCode } = await mixed((root) => { commitCard(root); writeLog(root) })
  assert.equal(report.effects.commit, "observed")
  assert.equal(report.effects.log, "queued")
  assert.equal(report.code, "commit_queued")
  assert.equal(exitCode, 2)
  assert.match(report.readback, /Do not resend/u)
})

test("mixed update, log committed before readback: both observed, exit 0", async () => {
  const { report, exitCode } = await mixed((root) => {
    commitCard(root)
    writeLog(root)
    git(root, "add", "work/one/log.md")
    git(root, "commit", "-m", "log")
  })
  assert.equal(report.effects.commit, "observed")
  assert.equal(report.effects.log, "observed")
  assert.equal(exitCode, 0, JSON.stringify(report))
})

for (const [name, during, answer] of [
  ["a missing log path", (root) => commitCard(root), MIXED],
  ["an ignored untracked log (a blank status)", (root) => {
    writeFileSync(path.join(root, ".gitignore"), "log.md\n")
    git(root, "add", ".gitignore")
    commitCard(root)
    writeLog(root)
  }, MIXED],
  ["an invalid log path", (root) => commitCard(root), { ...MIXED, log: { path: "../outside.md", commit: "queued" } }],
]) {
  test(`mixed update with ${name} keeps the card observation but never claims the log observed`, async () => {
    const { report, exitCode } = await mixed(during, answer)
    assert.equal(report.effects.commit, "observed", "the card observation is preserved")
    assert.equal(report.effects.log, "unknown")
    assert.equal(report.status, "partial")
    assert.equal(report.code, "log_evidence_unknown")
    assert.equal(exitCode, 2)
    assert.match(report.readback, /Do not resend/u)
  })
}

// A tracked log that differs from HEAD while Git's status is told to ignore it: the readback compares content with the blob at the reported HEAD.
for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`a tracked log changed behind ${flag} is pending, not observed`, async () => {
    const { report, exitCode } = await mixed((root) => {
      writeLog(root)
      git(root, "add", "work/one/log.md")
      commitCard(root)
      git(root, "update-index", flag, "work/one/log.md")
      writeFileSync(path.join(root, "work/one/log.md"), "# Log\n\n## entry\n\n## newer queued entry\n")
      assert.equal(git(root, "status", "--porcelain", "--", "work/one/log.md"), "", "status is blind to the change")
    })
    assert.equal(report.effects.log, "queued", JSON.stringify(report.effects))
    assert.equal(report.code, "commit_queued")
    assert.equal(exitCode, 2)
  })
}

// The log lives in a directory literally named "[ab]"; an unrelated dirty file matches that name as a glob.
const globFixture = (root) => {
  mkdirSync(path.join(root, "work/[ab]"), { recursive: true })
  writeFileSync(path.join(root, "work/[ab]/log.md"), "# Log\n\n## entry\n")
}
const globAnswer = { ...MIXED, log: { path: "work/[ab]/log.md", commit: "queued" } }
const dirtyGlobMatch = (root) => {
  mkdirSync(path.join(root, "work/a"), { recursive: true })
  writeFileSync(path.join(root, "work/a/log.md"), "unrelated dirty file\n")
}

test("an unrelated dirty path matching the log path as a glob does not make a committed log pending", async () => {
  const { report, exitCode } = await mixed((root) => {
    globFixture(root)
    git(root, "add", "-f", "work/[ab]/log.md")
    commitCard(root)
    dirtyGlobMatch(root)
  }, globAnswer)
  assert.equal(report.effects.log, "observed", JSON.stringify(report.effects))
  assert.equal(exitCode, 0, JSON.stringify(report))
})

test("an unrelated dirty path matching an ignored log path as a glob does not make it pending", async () => {
  const { report, exitCode } = await mixed((root) => {
    commitCard(root)
    writeFileSync(path.join(root, ".git/info/exclude"), "work/[[]ab]/\n")
    globFixture(root)
    dirtyGlobMatch(root)
  }, globAnswer)
  assert.equal(report.effects.log, "unknown", JSON.stringify(report.effects))
  assert.equal(exitCode, 2)
})

// Descriptor-bound acquisition, exercised directly. A `git` shim records every hash-object call, so "refused without hashing" is observed.
const LOG_TEXT = "# Log\n\n## entry\n"
async function scene({ text = LOG_TEXT, files = {} } = {}) {
  const { logCommitState } = await import("../../../../../plugins/desk/mcp/scripts/local-recovery.js")
  const root = fixture()
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(root, name), body)
  writeFileSync(path.join(root, "work/one/log.md"), text)
  git(root, "add", "-A")
  git(root, "commit", "-m", "log")
  const shim = path.join(here, `shim-${sequence}`)
  mkdirSync(shim, { recursive: true })
  const calls = path.join(shim, "calls.txt")
  writeFileSync(calls, "")
  writeFileSync(path.join(shim, "git"), `#!/bin/sh\ncase " $* " in *" hash-object "*) echo hash >> "${calls}";; esac\nPATH='${process.env.PATH}' exec git "$@"\n`)
  chmodSync(path.join(shim, "git"), 0o755)
  const sibling = path.join(here, `sibling-${sequence}`)
  mkdirSync(sibling, { recursive: true })
  const head = git(root, "rev-parse", "HEAD")
  const state = (probe, at = root) => logCommitState(at, { ...env(), PATH: `${shim}:${process.env.PATH}` }, "work/one/log.md", head, probe)
  const hashed = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).length
  const relocate = (copy) => {
    const dir = path.join(root, "work/one")
    if (copy) { mkdirSync(path.join(sibling, "one"), { recursive: true }); copyFileSync(path.join(dir, "log.md"), path.join(sibling, "one/log.md")); removeTreeSync(dir) }
    else renameSync(dir, path.join(sibling, "one"))
    symlinkSync(path.join(sibling, "one"), dir)
  }
  return { root, sibling, state, hashed, relocate }
}

test("an in-root log equal to the HEAD blob is committed and hashed once", async () => {
  const { state, hashed } = await scene()
  assert.equal(state(), "committed")
  assert.equal(hashed(), 1)
})

test("a CRLF working log under an eol=lf attribute still equals its HEAD blob", async () => {
  const { root, state } = await scene({ text: "# Log\n", files: { ".gitattributes": "*.md text eol=lf\n" } })
  writeFileSync(path.join(root, "work/one/log.md"), "# Log\r\n")
  assert.equal(state(), "committed")
})

test("a changed in-root log is pending", async () => {
  const { root, state } = await scene()
  writeFileSync(path.join(root, "work/one/log.md"), `${LOG_TEXT}more\n`)
  assert.equal(state(), "pending")
})

for (const [name, text] of [["matching", LOG_TEXT], ["changed", `${LOG_TEXT}other\n`]]) {
  test(`a task directory relocated outside the root and linked from its old parent is refused without hashing (${name} bytes)`, async () => {
    const { sibling, state, hashed, relocate } = await scene()
    relocate(false)
    writeFileSync(path.join(sibling, "one/log.md"), text)
    assert.equal(state(), "unknown")
    assert.equal(hashed(), 0)
  })
}

test("a different object swapped in between the walk and the open is refused without hashing", async () => {
  const { state, hashed, relocate } = await scene()
  assert.equal(state({ afterWalk: () => relocate(true) }), "unknown")
  assert.equal(hashed(), 0)
})

test("the very directory walked, relocated and linked from its old parent between walk and open, is refused without hashing", async () => {
  const { state, hashed, relocate } = await scene()
  assert.equal(state({ afterOpen: () => relocate(false), afterWalk: () => {} }), "unknown")
  assert.equal(hashed(), 0)
})

test("the same directory relocated before the open (same inode reached through a link) is refused without hashing", async () => {
  const { state, hashed, relocate } = await scene()
  assert.equal(state({ afterWalk: () => relocate(false) }), "unknown")
  assert.equal(hashed(), 0)
})

test("a leaf symbolic link and a linked root are refused without hashing", async () => {
  const leaf = await scene()
  const target = path.join(leaf.sibling, "log.md")
  writeFileSync(target, LOG_TEXT)
  unlinkSync(path.join(leaf.root, "work/one/log.md"))
  symlinkSync(target, path.join(leaf.root, "work/one/log.md"))
  assert.equal(leaf.state(), "unknown")
  const linked = await scene()
  const alias = path.join(here, `alias-${sequence}`)
  symlinkSync(linked.root, alias)
  assert.equal(linked.state(undefined, alias), "unknown")
  assert.equal(leaf.hashed() + linked.hashed(), 0)
})

test("a regular log swapped for a FIFO between the walk and the open is refused without blocking", { skip: process.platform === "win32" && "POSIX FIFOs only" }, async () => {
  const { root } = await scene()
  const helper = path.join(here, `fifo-${sequence}.mjs`)
  const log = path.join(root, "work/one/log.md")
  writeFileSync(helper, `import { lstatSync, unlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { logCommitState } from ${JSON.stringify(new URL("../../../../../plugins/desk/mcp/scripts/local-recovery.js", import.meta.url).href)}
const swap = () => {
  unlinkSync(${JSON.stringify(log)})
  const made = spawnSync("mkfifo", [${JSON.stringify(log)}], { encoding: "utf8" })
  if (made.status !== 0 || !lstatSync(${JSON.stringify(log)}).isFIFO()) throw new Error("mkfifo failed: " + made.status + " " + made.stderr)
}
console.log(logCommitState(${JSON.stringify(root)}, process.env, "work/one/log.md", ${JSON.stringify(git(root, "rev-parse", "HEAD"))}, { afterWalk: swap }))
`)
  const out = spawnSync(process.execPath, [helper], { encoding: "utf8", timeout: 4000, killSignal: "SIGKILL", env: isolatedEnv() })
  assert.equal(out.error, undefined, "the open must not block on a FIFO")
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.signal, null)
  assert.equal(out.stderr, "")
  assert.equal(out.stdout.trim(), "unknown")
})

test("a log removed between the walk and the open is unknown without hashing", async () => {
  const { root, state, hashed } = await scene()
  assert.equal(state({ afterWalk: () => unlinkSync(path.join(root, "work/one/log.md")) }), "unknown")
  assert.equal(hashed(), 0)
})

test("a log changed while Git reads it is unknown", async () => {
  const { root, state } = await scene()
  assert.equal(state({ afterHash: () => writeFileSync(path.join(root, "work/one/log.md"), `${LOG_TEXT}appended\n`) }), "unknown")
})

test("log-only update with a missing log path is unknown evidence, not observed", async () => {
  const { report, exitCode } = await mixed(() => {}, { status: "logged", path: "work/one/log.md", commit: "queued" })
  assert.equal(report.effects.log, "unknown")
  assert.equal(exitCode, 2)
  assert.match(report.readback, /Do not resend/u)
})

for (const [name, answer] of [
  ["a log without the queued marker", { status: "logged", path: "work/one/log.md" }],
  ["an unknown status", { status: "SOMETHING_NEW" }],
]) {
  test(`${name} still ends unexpected and is never resent`, async () => {
    const root = fixture()
    let dispatches = 0
    const { runRecovery } = await import("../../../../../plugins/desk/mcp/scripts/local-recovery.js")
    const result = await runRecovery({
      argv: args(root), env: env(), cwd: root, input: input(logOnly),
      launch: fakeServer(root, { onDispatch: () => dispatches++, updateDelayMs: 0, result: answer }),
    })
    assert.equal(result.report.code, "unexpected_tool_result")
    assert.equal(result.report.effects.mutation, "unknown")
    assert.equal(result.exitCode, 2)
    assert.equal(dispatches, 1)
  })
}

test("deferred publication reports that no background commit is scheduled for a queued log", async () => {
  const root = fixture()
  const headBefore = git(root, "rev-parse", "HEAD")
  const result = await recover(root, logOnly, ["--publication", "deferred"])
  assert.equal(result.report.queued.committer, "next_session_start")
  assert.equal(result.report.effects.log, "queued")
  assert.equal(result.report.code, "commit_queued")
  assert.match(result.report.readback, /no background commit is scheduled/u)
  assert.equal(git(root, "rev-parse", "HEAD"), headBefore)
})

test("a log refused for a missing card changes nothing", async () => {
  const root = fixture()
  const headBefore = git(root, "rev-parse", "HEAD")
  const result = await recover(root, { ...logOnly, slug: "absent" })
  assert.equal(result.report.code, "tool_error")
  assert.equal(git(root, "rev-parse", "HEAD"), headBefore)
  assert.equal(git(root, "status", "--porcelain", "--", "work"), "")
})

// Only PATH is inherited: no tokens, hosts, Git config or default-desk profile reach the real spawned process.
function isolatedEnv() {
  const home = path.join(here, "spawned-home")
  mkdirSync(home, { recursive: true })
  return {
    PATH: process.env.PATH,
    HOME: home, USERPROFILE: home, TMPDIR: home,
    XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
    DESK_STATE_HOME: path.join(home, "desk-state"),
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  }
}

test("the queued commit survives a real spawned bootstrap being closed", async () => {
  const root = fixture()
  const headBefore = git(root, "rev-parse", "HEAD")
  const { runRecovery, launchBootstrap } = await import("../../../../../plugins/desk/mcp/scripts/local-recovery.js")
  const spawnedEnv = isolatedEnv()
  const allowed = /^(PATH|HOME|USERPROFILE|TMPDIR|XDG_[A-Z]+_HOME|DESK_STATE_HOME|GIT_CONFIG_GLOBAL|GIT_CONFIG_NOSYSTEM|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL))$/u
  assert.deepEqual(Object.keys(spawnedEnv).filter((key) => !allowed.test(key)), [], "only controlled variables reach the spawned bootstrap")
  for (const key of ["HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "DESK_STATE_HOME", "GIT_CONFIG_GLOBAL"]) {
    assert.ok(spawnedEnv[key].startsWith(here), `${key} stays under the synthetic temp root`)
  }
  const result = await runRecovery({
    argv: args(root), env: spawnedEnv, cwd: root,
    input: input(logOnly), launch: launchBootstrap, timeoutMs: 60000,
  })
  assert.equal(result.report.transport.shutdown, "closed", JSON.stringify(result.report))
  assertQueuedOrObserved(result, "work/one/log.md", headBefore, root)
  assert.equal(await commitOfLog(root, "work/one/log.md", headBefore), "work/one/log.md", "the detached worker commits after the child is gone")
})
