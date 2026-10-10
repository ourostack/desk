import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { PassThrough } from "node:stream"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { realpathSync } from "node:fs"
import { main } from "../../../../../plugins/desk/mcp/index.js"
import * as server from "../../../../../plugins/desk/mcp/src/server.js"
import { runAdmissionJob } from "../../../../../plugins/desk/mcp/src/runtime/admission-worker.js"

const here = path.resolve(process.env.DESK_RECOVERY_FIXTURES ?? path.join(realpathSync(tmpdir()), `local-recovery-fixtures-${process.pid}`))
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

// The external controller process runs in this test's event loop instead.
// Admission, journal, front door, card validation and Git writes are production.
async function launch(options) {
  const toServer = new PassThrough()
  const fromServer = new PassThrough()
  const controllers = []
  const runtimeServers = []
  const handle = await main({
    ...options, input: toServer, output: fromServer,
    stateHome: path.join(options.cwd, ".session-state"),
    stderr: { write() {} }, admissionKickoffMs: 0,
    offload: runAdmissionJob,
    runtimeInspector: null,
    readinessPolicy: options.readinessPolicy ?? { semantic: "unsupported" },
    runtimeImporter: async () => ({
      ...server,
      connectOrStartController: async (settings) => {
        const controller = await server.connectOrStartController({
          ...settings, ephemeral: true, controllerLauncher: async (settings) => {
            const runtime = await server.startControllerRuntime(settings)
            runtimeServers.push(runtime)
            return runtime
          },
        })
        controllers.push(controller)
        return controller
      },
    }),
  })
  return {
    input: toServer, output: fromServer,
    close: async () => {
      // A refusal may arrive before controller admission settles. This fixture
      // owns that asynchronous in-process launch as well as the front door.
      await handle.admission.idle({ waitMs: 15000 })
      assert.equal(handle.admission.running, false, "fixture admission must settle before controller disposal")
      toServer.end()
      await handle.closed
      for (const controller of controllers) await controller.close()
      for (const runtime of runtimeServers) await runtime.close()
      assert.ok(runtimeServers.every((runtime) => !runtime.server.listening), "all fixture-owned servers are closed")
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
    if (name !== "JSON") assert.equal(result.report.effects.mutation, "unknown", "isError alone cannot prove no write")
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

test("commit failure remains partial and retains the real applied write", async () => {
  const root = fixture()
  const head = git(root, "rev-parse", "HEAD")
  writeFileSync(path.join(root, ".git", "index.lock"), "fixture lock")
  const result = await recover(root)
  assert.equal(result.exitCode, 2)
  assert.equal(result.report.effects.commit, "failed")
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

test("state-branch options cannot override undeclared branch policy", async () => {
  const root = fixture()
  const head = git(root, "rev-parse", "HEAD")
  const result = await recover(root, update, ["--state-branch", "main"], async () => assert.fail("no launch"))
  assert.equal(result.report.code, "state_branch_not_declared")
  assert.equal(git(root, "rev-parse", "HEAD"), head)
})

test("timeout after dispatch is unknown and is never resent", async () => {
  const root = fixture()
  let dispatches = 0
  const launcher = async () => {
    const toServer = new PassThrough()
    const fromServer = new PassThrough()
    toServer.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString())
      if (!request.id) return
      let result = {}
      if (request.method === "tools/list") result = { tools: [{ name: "task_update" }] }
      if (request.params?.name === "desk_status") result = { content: [{ type: "text", text: JSON.stringify({
        state: "ready", root: { valid: true, path: root }, write_scope: { mode: "workspace", person: null, relative_path: "." },
        sync: "no remote configured",
      }) }] }
      if (request.params?.name === "task_update") {
        dispatches++
        writeFileSync(path.join(root, "applied.txt"), "effect before timeout")
        return
      }
      fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n")
    })
    return { input: toServer, output: fromServer, close: async () => toServer.end() }
  }
  const { runRecovery } = await import("../../../../../plugins/desk/mcp/scripts/local-recovery.js")
  const result = await runRecovery({ argv: args(root), env: env(), cwd: root, input: input(update), launch: launcher, timeoutMs: 80 })
  assert.equal(result.report.code, "timeout")
  assert.equal(result.report.effects.mutation, "unknown")
  assert.match(result.report.readback, /HEAD/u)
  assert.equal(dispatches, 1)
  assert.equal(readFileSync(path.join(root, "applied.txt"), "utf8"), "effect before timeout")
})

test("an already edited card is not falsely reported as committed", async () => {
  const root = fixture()
  const head = git(root, "rev-parse", "HEAD")
  writeFileSync(path.join(root, "work/one/task.md"), readFileSync(path.join(root, "work/one/task.md"), "utf8") + "\nLocal edit\n")
  const result = await recover(root)
  assert.equal(result.exitCode, 2)
  assert.equal(result.report.effects.commit, "not_observed")
  assert.equal(git(root, "rev-parse", "HEAD"), head)
  assert.match(readFileSync(path.join(root, "work/one/task.md"), "utf8"), /Local edit/u)
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
    const runtimeServers = []
    const desk = await startInProcess({
      argv: ["--root", mcpRoot], cwd: mcpRoot, env: env(),
      stateHome: path.join(mcpRoot, ".session-state"), runtimeInspector: null,
      readinessPolicy: { semantic: "unsupported" },
      runtimeImporter: async () => ({
        ...server,
        connectOrStartController: (settings) => server.connectOrStartController({
          ...settings, ephemeral: true, controllerLauncher: async (settings) => {
            const runtime = await server.startControllerRuntime(settings)
            runtimeServers.push(runtime)
            return runtime
          },
        }),
      }),
    })
    try {
      await desk.statusUntil((state) => state.state === "ready" && !state.status_detail, { deadlineMs: 15000 })
      const direct = await desk.call(operation, value)
      const local = await recover(localRoot, value, [], launch, operation)
      assert.equal(direct.isError, refused)
      assert.equal(local.exitCode === 0, !refused, JSON.stringify(local.report))
      assert.equal(local.report.result.status, direct.payload.status)
      assert.equal(git(localRoot, "show", "--format=", "--name-only", "HEAD"), git(mcpRoot, "show", "--format=", "--name-only", "HEAD"))
      if (refused) {
        assert.equal(readFileSync(path.join(localRoot, "work/one/task.md"), "utf8"), readFileSync(path.join(mcpRoot, "work/one/task.md"), "utf8"))
      }
    } finally {
      await desk.close()
      for (const runtime of runtimeServers) await runtime.close()
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
  const beforeCount = Number(git(root, "rev-list", "--count", "HEAD"))
  if (delayedResolution) {
    // Delay only delivery to the real resolver worker. Bootstrap, admission,
    // runtime, authority, status consumer and mutation all remain production.
    writeFileSync(preload, `
const threads = require("node:worker_threads");
const { syncBuiltinESMExports } = require("node:module");
const { appendFileSync } = require("node:fs");
const OriginalWorker = threads.Worker;
threads.Worker = class extends OriginalWorker {
  postMessage(job, ...rest) {
    if (job?.kind === "resolve") {
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
        pending: status.detail_pending, root: status.root?.path,
      }) + "\\n");
    } catch {}
    return write(chunk, ...rest);
  };
}
`)
  }
  const script = new URL("../../../../../plugins/desk/mcp/scripts/local-recovery.js", import.meta.url)
  const { fileURLToPath } = await import("node:url")
  const { controllerRecords, waitForProcessesGone } = await import("./_controller_exit.js")
  try {
    const result = spawnSync(process.execPath, [
      fileURLToPath(script), ...args(root), "--activation-config", activation, "--input-file", file,
    ], {
      cwd: root, encoding: "utf8", timeout: 75000,
      env: {
        ...env(), HOME: home, USERPROFILE: home,
        XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
        XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
        XDG_RUNTIME_DIR: path.join(home, "runtime"),
        ...(delayedResolution ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}` } : {}),
      },
    })
    assert.equal(result.status, 0, result.stdout)
    const report = JSON.parse(result.stdout)
    if (delayedResolution) {
      assert.equal(report.preflight.statusDetail, "cached_in_owned_session")
      assert.ok(Date.parse(report.preflight.statusDetailFrom) > 0)
      const observed = readFileSync(statusEvidence, "utf8").trim().split("\n").map(JSON.parse)
      const pending = observed.find((status) => status.detail?.includes("Destination verification is pending") &&
        status.detail.startsWith("cached:"))
      assert.ok(pending, "the actual bootstrap must publish a completed same-context detail while resolution is pending")
      assert.equal(pending.writes, "refused")
      assert.equal(pending.root, root)
      assert.ok(Date.parse(pending.from) > 0)
      assert.equal(report.preflight.statusDetailFrom, pending.from)
    }
    assert.equal(report.actualRoot, root)
    assert.equal(report.effects.commit, "observed")
    assert.equal(git(root, "show", "--format=", "--name-only", "HEAD"), "work/one/task.md")
    assert.equal(Number(git(root, "rev-list", "--count", "HEAD")), beforeCount + 1, "no mutation replay")
    assert.match(readFileSync(path.join(root, "work/one/task.md"), "utf8"), /status: processing/u)
  } finally {
    // Ordinary runtime controllers are persistent. This fixture owns each
    // recorded controller; verify its exact command before ending it.
    const records = controllerRecords([home])
    for (const record of records) {
      const command = spawnSync("ps", ["-p", String(record.pid), "-o", "command="], { encoding: "utf8", timeout: 5000 }).stdout.trim()
      if (!command) continue
      assert.ok(command.includes(home), `fixture must own controller PID ${record.pid}`)
      process.kill(record.pid, "SIGTERM")
    }
    await waitForProcessesGone(records.map((record) => record.pid), { timeoutMs: 10000 })
  }
})
