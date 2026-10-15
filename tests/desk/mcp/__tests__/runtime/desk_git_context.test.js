import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { runGitRead } from "../../../../../plugins/desk/mcp/src/runtime/git-read-worker.js"
import { runGit } from "../../../../../plugins/desk/mcp/src/runtime/state-branch.js"
import { defaultSpawnWorker, runSyncPushCli, queueDeskProblemFiling } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { queueDeskProblemFiling as sessionFiler } from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"
import { planStaleRefresh, startStaleRefresh } from "../../../../../plugins/desk/mcp/src/runtime/stale-desk-refresh.js"
import { runTidyStatusCli, identityCachePath } from "../../../../../plugins/desk/mcp/src/desk/tidy.js"

const moduleUrl = new URL("../../../../../plugins/desk/mcp/src/runtime/desk-git-context.js", import.meta.url)
const fixture = () => realpathSync(mkdtempSync(path.join(tmpdir(), "desk-private-context-")))
const privateEnv = (root) => ({ ...process.env, DESK: root, DESK_ISOLATED_HOSTED: "1", XDG_STATE_HOME: path.join(root, ".state") })

test("Git helper preserves legacy bytes and only uses private cwd with real containment", async () => {
  const { deskGitInvocation } = await import(moduleUrl)
  const root = fixture()
  const args = ["diff-tree", "--root", "-r", "HEAD"]
  for (const env of [{}, { DESK_HOSTED: "1" }, { DESK_ISOLATED_HOSTED: "0" }]) {
    assert.deepEqual(deskGitInvocation({ root, args, env }), { args: ["-C", root, ...args], options: {} })
  }
  assert.deepEqual(deskGitInvocation({ root, args, env: privateEnv(root) }), { args, options: { cwd: root } })
  const outside = fixture()
  symlinkSync(outside, path.join(root, "escape"), "junction")
  for (const target of [outside, `${root}-sibling`, path.join(root, "escape"), path.join(root, "missing")]) {
    assert.throws(() => deskGitInvocation({ root: target, args, env: privateEnv(root) }), (error) => {
      assert.equal(error.code, "DESK_GIT_CONTEXT_REFUSED")
      assert.ok(!error.message.includes(root) && !error.message.includes(outside))
      return true
    })
  }
  assert.throws(() => deskGitInvocation({ root, args, env: { DESK_ISOLATED_HOSTED: "1" } }), /context refused/)
  for (const env of [{ DESK: 42 }, { DESK: "relative" }]) {
    assert.throws(() => deskGitInvocation({ root, args, env: { ...env, DESK_ISOLATED_HOSTED: "1" } }), /context refused/)
  }
  for (const target of [null, "relative"]) assert.throws(() => deskGitInvocation({ root: target, args, env: privateEnv(root) }), /context refused/)
  mkdirSync(path.join(root, "inside"))
  assert.deepEqual(deskGitInvocation({ root: path.join(root, "inside"), args, env: privateEnv(root) }).options, { cwd: path.join(root, "inside") })
})

test("real async Git consumers keep timeout, input flags and injected spawn contracts", async () => {
  const root = fixture()
  for (const isolated of [false, true]) {
    const env = isolated ? privateEnv(root) : { DESK_HOSTED: "1" }
    const args = ["diff-tree", "--root", "HEAD"]
    const calls = []
    const exec = (command, argv, options, callback) => {
      calls.push({ command, argv, options })
      callback(null, "ok\n", "")
      return { kill() {} }
    }
    assert.equal((await runGitRead({ root, args, env, timeoutMs: 1234 }, { execGit: exec })).status, 0)
    assert.equal((await runGit({ cwd: root, args, env, execFileImpl: exec })).ok, true)
    for (const call of calls) {
      assert.deepEqual(call.argv, isolated ? args : ["-C", root, ...args])
      assert.equal(call.options.cwd, isolated ? root : undefined)
      assert.equal(call.options.env.DESK_ISOLATED_HOSTED, env.DESK_ISOLATED_HOSTED)
    }
    assert.equal(calls[0].options.timeout, 1234)
    assert.equal(calls[1].options.timeout, 15000)
  }
  const outside = fixture()
  const exec = () => assert.fail("refused context must not reach Git")
  assert.equal((await runGitRead({ root: outside, args: ["status"], env: privateEnv(root), timeoutMs: 1234 }, { execGit: exec })).status, 1)
  const refused = await runGit({ cwd: outside, args: ["status"], env: privateEnv(root), execFileImpl: exec })
  assert.equal(refused.ok, false)
  assert.ok(!refused.stderr.includes(outside))
})

test("sync child root is env-only privately and explicit CLI root still works", async () => {
  const root = fixture()
  const env = privateEnv(root)
  let call
  defaultSpawnWorker({ root, env, debounceMs: 7, spawnImpl: (...args) => {
    call = args
    return { on() {}, unref() {} }
  } })
  assert.deepEqual(call[1].slice(-2), ["--debounce-ms", "7"])
  assert.equal(call[1][0], "--input-type=module")
  assert.ok(!call[1].some((arg) => arg.includes(".js") || arg.includes(root)))
  assert.ok(call[2].env.DESK_BUILTIN_SCRIPT.endsWith("/sync-push.js"))
  assert.equal(call[2].env.DESK, root)
  let seen
  assert.equal(await runSyncPushCli({ argv: ["--debounce-ms", "7"], env, runWorker: (options) => { seen = options } }), 0)
  assert.equal(seen.root, root)
  assert.equal(seen.debounceMs, 7)
  assert.equal(await runSyncPushCli({ argv: ["--root", root], env: {}, runWorker: (options) => { seen = options } }), 0)
  assert.equal(seen.root, root)
})

test("sync env-only script performs a real Git push, not a stubbed result", async () => {
  const base = fixture()
  const root = path.join(base, "clone")
  const origin = path.join(base, "origin")
  mkdirSync(root)
  mkdirSync(origin)
  const git = (cwd, args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git(origin, ["init", "--bare", "-q"])
  git(root, ["init", "-q"])
  git(root, ["config", "user.name", "Synthetic"])
  git(root, ["config", "user.email", "synthetic@example.invalid"])
  writeFileSync(path.join(root, "card.md"), "first")
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "first"])
  git(root, ["remote", "add", "origin", origin])
  git(root, ["push", "-qu", "origin", "HEAD"])
  writeFileSync(path.join(root, "card.md"), "second")
  git(root, ["commit", "-qam", "second"])
  const { deskScriptInvocation } = await import(moduleUrl)
  const invocation = deskScriptInvocation({
    script: fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/sync-push.js", import.meta.url)),
    args: ["--debounce-ms", "0"], env: privateEnv(root),
  })
  assert.ok(!invocation.args.some((arg) => arg.includes(root) || arg.includes(".js")))
  const result = spawnSync(process.execPath, invocation.args, {
    ...invocation.options, encoding: "utf8", timeout: 20000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(git(origin, ["show", "HEAD:card.md"]), "second")
})

test("tidy identity script accepts private env root and writes its actual cache", () => {
  const root = fixture()
  const env = privateEnv(root)
  let output = ""
  const code = runTidyStatusCli({
    argv: ["--refresh-identity"], env, cwd: root, homeDir: root, now: 123,
    spawnGh: () => ({ status: 0, stdout: "synthetic-login\n" }),
    io: { stdout: { write() {} }, stderr: { write: (text) => { output += text } } },
  })
  assert.equal(code, 0, output)
  assert.equal(JSON.parse(readFileSync(identityCachePath({ env, homeDir: root }), "utf8"))[root].identity, "synthetic-login")
})

test("real tidy script resolves its env-only root and persists an unavailable identity without host authority", async () => {
  const root = fixture()
  const env = { ...privateEnv(root), PATH: "", HOME: root }
  const { deskScriptInvocation } = await import(moduleUrl)
  const invocation = deskScriptInvocation({
    script: fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/tidy-status.js", import.meta.url)),
    args: ["--refresh-identity"], env,
  })
  const result = spawnSync(process.execPath, invocation.args, { ...invocation.options, cwd: root, encoding: "utf8", timeout: 20000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(identityCachePath({ env, homeDir: root }), "utf8"))[root].identity, null)
})

test("private unsupported repair and filing explicitly refuse before any spawn or host state", () => {
  const root = fixture()
  const env = privateEnv(root)
  const spawn = () => assert.fail("private customer context must not spawn host repair or filer")
  for (const filer of [queueDeskProblemFiling, sessionFiler]) {
    assert.match(filer({ root, env, reason: "failure", host: "host-private-id", spawnImpl: spawn }).file, /not filed.*isolated hosted/)
  }
  const finding = { running: "1", latest: "2" }
  const prepared = planStaleRefresh({ finding, env, pluginRoot: root, agentHost: "claude", allowInTest: true })
  assert.equal(prepared.state, "unavailable")
  assert.match(prepared.reason, /isolated hosted/)
  assert.equal(startStaleRefresh({ prepared: { plan: {}, dir: root }, finding, env, root, spawn }).state, "unavailable")
  assert.deepEqual(readdirSync(root), [])
})

test("private tidy identity launch carries env-only root, and unsafe roots never launch", async () => {
  const { resolvePerson } = await import("../../../../../plugins/desk/mcp/src/desk/tidy.js")
  const root = fixture()
  const env = privateEnv(root)
  const calls = []
  const spawnBackground = (...args) => { calls.push(args); return { unref() {} } }
  const options = { env, homeDir: root, roster: [{ alias: "synthetic", identity: "synthetic-login" }], spawnBackground }
  assert.equal(resolvePerson(root, options), undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].at(-1), "--refresh-identity")
  assert.equal(calls[0][1][0], "--input-type=module")
  assert.ok(calls[0][2].env.DESK_BUILTIN_SCRIPT.endsWith("/tidy-status.js"))
  assert.equal(calls[0][2].env.DESK, root)
  const outside = fixture()
  assert.equal(resolvePerson(outside, options), undefined)
  assert.equal(calls.length, 1)
  assert.throws(() => defaultSpawnWorker({ root: outside, env, debounceMs: 0, spawnImpl: spawnBackground }), /context refused/)
  await assert.rejects(runSyncPushCli({ argv: ["--root", outside], env }), /context refused/)
  assert.equal(runTidyStatusCli({
    argv: ["--refresh-identity", "--root", outside], env, cwd: root,
    io: { stdout: { write() {} }, stderr: { write: (text) => assert.ok(!text.includes(outside)) } },
  }), 2)
})

test("private shared callers execute real Git, preserve staged files and retain diff-tree --root", async () => {
  const root = fixture()
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git(["init", "-q"])
  git(["config", "user.name", "Synthetic"])
  git(["config", "user.email", "synthetic@example.invalid"])
  writeFileSync(path.join(root, ".gitignore"), ".state/\n")
  writeFileSync(path.join(root, "note.md"), "first\n")
  git(["add", "."])
  git(["commit", "-qm", "first"])
  const first = git(["rev-parse", "HEAD"])
  const saved = { DESK: process.env.DESK, DESK_ISOLATED_HOSTED: process.env.DESK_ISOLATED_HOSTED }
  process.env.DESK = root
  process.env.DESK_ISOLATED_HOSTED = "1"
  const calls = []
  const spawnGit = (command, args, options) => {
    assert.ok(!args.includes("-C"))
    assert.ok(!args.some((arg) => arg.includes(root)))
    assert.ok(options.cwd === root || options.cwd.startsWith(`${root}${path.sep}`))
    calls.push(args)
    return spawnSync(command, args, options)
  }
  try {
    const stage = await import("../../../../../plugins/desk/mcp/src/util/git-stage.js")
    const { ensureStateIgnored } = await import("../../../../../plugins/desk/mcp/src/util/state-ignore.js")
    const { installCardGuard } = await import("../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js")
    const { operatorNames } = await import("../../../../../plugins/desk/mcp/src/desk/naming.js")
    const { uncommittedPaths } = await import("../../../../../plugins/desk/mcp/src/desk/tidy.js")
    const { snapshotStagedPaths } = await import("../../../../../plugins/desk/mcp/src/runtime/index-drift.js")
    const { isLocalOnlyClone } = await import("../../../../../plugins/desk/mcp/src/tools/local-only.js")
    const { createCommitResolver } = await import("../../../../../plugins/desk/mcp/src/factory/commit-resolve.js")
    const { createDeskReaders, readDeskRemote } = await import("../../../../../plugins/desk/mcp/src/factory/desk-repo.js")
    const { readAcknowledged } = await import("../../../../../plugins/desk/mcp/src/factory/triage-outbox.js")
    const { readAcknowledgedAnnotations } = await import("../../../../../plugins/desk/mcp/src/factory/triage-state.js")
    const { repoStates, resolvePushAccounts } = await import("../../../../../plugins/desk/mcp/src/runtime/boot.js")
    const { stageAndCommitFile } = await import("../../../../../plugins/desk/mcp/src/tools/_card-commit.js")
    const { task_create, task_archive } = await import("../../../../../plugins/desk/mcp/src/tools/task.js")
    const { task_move } = await import("../../../../../plugins/desk/mcp/src/tools/move.js")
    const { prRepoVerdict } = await import("../../../../../plugins/desk/mcp/src/tools/done-evidence.js")
    const { reconcile } = await import("../../../../../plugins/desk/mcp/src/factory/reconcile.js")
    const { isolatedDeskRoot } = await import(moduleUrl)
    assert.equal(isolatedDeskRoot(root), root)
    assert.equal(stage.isGitRepository(root, spawnGit), true)
    ensureStateIgnored(root, { spawnGit })
    assert.equal(installCardGuard(root, { spawnGit }).state, "installed")
    assert.ok(operatorNames(root, { env: process.env, homeDir: root, spawnGitConfig: spawnGit }).includes("synthetic"))
    assert.equal(isLocalOnlyClone(root, { spawnGit, deskRoot: root }), false)
    writeFileSync(path.join(root, "note.md"), "second\n")
    assert.ok(uncommittedPaths(root, root, { spawnGit }).includes("note.md"))
    stage.stagePaths(root, ["note.md"], spawnGit)
    assert.ok(snapshotStagedPaths({ root, spawnGit }).includes("note.md"))
    assert.equal(stageAndCommitFile(path.join(root, "note.md"), "second", spawnGit), undefined)
    const resolved = createCommitResolver()({ gitRoot: root, cwd: root, shas: [first.slice(0, 8)] })
    assert.deepEqual(resolved.fulls, [first])
    const readers = createDeskReaders({ deskRoot: root })
    assert.equal(readers.gitCommitTaskPaths(first).exists, true)
    assert.equal(readDeskRemote({ deskRoot: root, spawn: spawnGit }), null)
    assert.equal(readAcknowledged({ deskRoot: root, personPrefix: "", key: "issue:1" }), null)
    assert.deepEqual(readAcknowledgedAnnotations({ deskRoot: root, personPrefix: "" }).annotations, [])
    const cards = [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: "local", mode: "local", local_path: "." }] } }]
    assert.equal(repoStates({ cards, root, spawnGit, homeDir: root, now: () => 0, deadline: 60000 }).states[0].present, true)
    assert.equal((await resolvePushAccounts({ cards, root, spawnGit, homeDir: root, now: () => 0, runner: () => assert.fail("no remote authority") }))[0].result, "not_a_github_repo")
    assert.equal(prRepoVerdict({ name: "local", localPath: "." }, "synthetic/desk", { spawnGit, homeDir: root, deskRoot: root }), "unknown")
    assert.equal(reconcile({ deskRoot: root, personPrefix: "", since: "2026-01-01T00:00:00Z", until: "2026-12-31T00:00:00Z", env: process.env }).ok, true)
    await task_create({ deskRoot: root, input: { track: "work", slug: "private-card", title: "Private card" }, env: process.env, spawnGit, schedulePush() {} })
    const moved = await task_move({ deskRoot: root, input: { track: "work", slug: "private-card", to_slug: "moved-card" }, spawnGit, schedulePush() {} })
    assert.equal(moved.to, "work/moved-card")
    assert.deepEqual(uncommittedPaths(root, path.join(root, "work"), { spawnGit }), [])
    const cardFile = path.join(root, "work/moved-card/task.md")
    writeFileSync(cardFile, readFileSync(cardFile, "utf8").replace("status: drafting", "status: cancelled"))
    assert.equal(stageAndCommitFile(cardFile, "cancel synthetic card", spawnGit), undefined)
    assert.equal((await task_archive({ deskRoot: root, input: { track: "work", slug: "moved-card" }, env: process.env, spawnGit, schedulePush() {} })).status, "archived")
    assert.ok(calls.some((args) => args.includes("diff")))
    const { deskGitInvocation } = await import(moduleUrl)
    const invocation = deskGitInvocation({ root, args: ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", first] })
    assert.ok(spawnSync("git", invocation.args, { ...invocation.options, encoding: "utf8" }).stdout.includes("note.md"))
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
