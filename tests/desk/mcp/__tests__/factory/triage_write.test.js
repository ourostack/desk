// Real Git: a temporary bare remote and isolated clones, real hooks, real pushes. Nothing here mocks a commit or an
// acknowledgement; fault seams are used only to make a single Git call fail or to pause at a named step.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { promises as fs, readFileSync, lstatSync } from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { openImprovement } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { installCardGuard } from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"
import { acquireSyncLock } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { readTriageBasis } from "../../../../../plugins/desk/mcp/src/factory/triage-basis.js"
import {
  readAcknowledgedAnnotations, refreshTriage, resolveAcknowledgedTriage, toSafeTriageReview, triagePaths, validateTriageAnnotation, validateTriageIdentities,
} from "../../../../../plugins/desk/mcp/src/factory/triage-state.js"
import { publishOwnedTriage, writeProtectedTriageFile } from "../../../../../plugins/desk/mcp/src/factory/triage-write.js"
import { hookArgvScript } from "./_hook_argv.js"

const fixture = JSON.parse(readFileSync(new URL("./fixtures/v12-triage-local.json", import.meta.url)))
const KEY = fixture.key
const STORE = fixture.store
const T0 = Date.parse("2026-10-11T12:00:00.000Z")
const HOUR = 3600 * 1000
const posix = process.platform !== "win32"
const RESOURCE_ALARM = "triage_resource_unrecoverable"
const hex = (n) => randomBytes(n).toString("hex")
const slash = (p) => p.split(path.sep).join("/")
const resolveIssue = async (pointer) => ({ revision: 3, public: { kind: "issue", ref: `https://github.com/example-org/example-repo/issues/${pointer.split("#")[1]}`, revision: 3 } })
const HUMAN = fixture.safe_review
const AGENT = { ...HUMAN, route: "agent_ready", gate: null, authority_code: "existing_scope", summary_codes: ["source:andon", "route:agent_ready"] }
const PRIVATE_HOOKS = fileURLToPath(new URL("../../../../../hosted/bin/private-hooks", import.meta.url))

test("private commit carries the physical common directory across lexical junction traversal", async () => {
  const w = await world()
  const desk = w.clone("junction-common")
  const root = desk.deskRoot
  const log = path.join(w.base, "junction-hook.jsonl")
  await fs.writeFile(path.join(root, ".git/hooks/pre-commit"), hookArgvScript(), { mode: 0o755 })
  desk.env = { ...desk.env, DESK: root, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS, DESK_HOOK_LOG: log, DESK_HOOK_NODE: process.execPath }
  const before = git(w.origin, ["rev-parse", "main"])
  let candidate, administrative, commonBytes
  const trace = []
  const result = await publish(desk, { git: {
    async onStep(name) {
      if (name !== "before_commit") return
      const [token] = await fs.readdir(path.join(root, ".git/desk-triage"))
      candidate = path.join(root, ".git/desk-triage", token, "wt")
      const bytes = await fs.readFile(path.join(candidate, ".git"), "utf8")
      administrative = path.resolve(candidate, bytes.slice(8).trim())
      commonBytes = await fs.readFile(path.join(administrative, "commondir"), "utf8")
      assert.equal(commonBytes.trim(), "../..")
      assert.equal(path.resolve(administrative, commonBytes.trim()), path.join(root, ".git"))
      assert.notEqual(path.resolve(candidate, ".git", commonBytes.trim()), path.join(root, ".git"))
    },
    spawn(command, args, options) {
      // Git for Windows resolves ".." lexically across a junction. Model only
      // that provider boundary; the failed/successful Git and hooks remain real.
      const linked = options.cwd === candidate && lstatSync(path.join(candidate, ".git")).isSymbolicLink()
      const env = linked && !options.env.GIT_COMMON_DIR
        ? { ...options.env, GIT_COMMON_DIR: path.resolve(candidate, ".git", commonBytes.trim()) }
        : options.env
      assert.ok(!args.some((arg) => arg.includes(root)), "private paths never enter Git argv")
      const child = spawn(command, args, { ...options, env })
      let stdout = "", stderr = ""
      child.stdout.on("data", (chunk) => { stdout += chunk })
      child.stderr.on("data", (chunk) => { stderr += chunk })
      child.once("close", (status) => trace.push({ args, status, stdout, stderr, commonDir: env.GIT_COMMON_DIR, gitDir: env.GIT_DIR }))
      return child
    },
  } })
  assert.equal(result.state, "acknowledged", JSON.stringify({ result, trace: trace.slice(-16) }))
  assert.ok(trace.some((row) => row.args[0] === "commit" && row.status === 0), "actual successful commit")
  const rows = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse)
  assert.ok(rows.some((row) => row.hook.includes("pre-commit")), "original hook executed")
  for (const row of rows) {
    assert.equal(path.resolve(row.top), candidate, "nested Git discovers the same candidate")
    assert.equal(row.commonDir, path.join(root, ".git"), "original hooks inherit physical common-directory routing")
    assert.ok(![row.hook, ...row.args, ...row.kernel, ...row.ancestors.flat()].some((arg) => arg.replaceAll("\\", "/").includes(slash(root))), JSON.stringify(row))
  }
  assert.notEqual(git(w.origin, ["rev-parse", "main"]), before)
  assert.ok(remoteJson(w.origin, paths.annotation))
  assert.equal(git(root, ["worktree", "list", "--porcelain"]).split("worktree ").length - 1, 1)
  assert.equal(await fs.lstat(candidate).catch((error) => error.code), "ENOENT")
  assert.equal(desk.env.GIT_COMMON_DIR, undefined, "transport never mutates the caller environment")
})

test("private commit refuses damaged or foreign common-directory metadata before its gitfile swap", async () => {
  for (const mode of ["missing", "foreign"]) {
    const w = await world()
    const desk = w.clone("damaged-common")
    const root = desk.deskRoot
    desk.env = { ...desk.env, DESK: root, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS }
    const before = git(w.origin, ["rev-parse", "main"])
    let dot, dotBytes, common, bytes, retained
    const result = await publish(desk, { git: { async onStep(name) {
      if (name !== "before_commit") return
      const [token] = await fs.readdir(path.join(root, ".git/desk-triage"))
      dot = path.join(root, ".git/desk-triage", token, "wt/.git")
      dotBytes = await fs.readFile(dot, "utf8")
      common = path.join(path.resolve(path.dirname(dot), dotBytes.slice(8).trim()), "commondir")
      bytes = await fs.readFile(common, "utf8")
      if (mode === "missing") {
        retained = path.join(w.base, "retained-commondir")
        await fs.rename(common, retained)
      } else {
        await fs.writeFile(common, `${w.base}\n`)
      }
    } } })
    assert.equal(result.state, "write_failed", mode)
    assert.equal(git(w.origin, ["rev-parse", "main"]), before)
    assert.equal(remoteText(w.origin, paths.annotation).status, 128)
    assert.equal(await fs.readFile(dot, "utf8"), dotBytes, "failed admission never replaces the gitfile")
    assert.equal(await fs.lstat(path.join(path.dirname(path.dirname(dot)), "gitfile")).catch((error) => error.code), "ENOENT")
    if (mode === "missing") {
      assert.equal(await fs.readFile(retained, "utf8"), bytes)
      await fs.rename(retained, common)
    } else {
      assert.equal(await fs.readFile(common, "utf8"), `${w.base}\n`, "foreign metadata is preserved")
      await fs.writeFile(common, bytes)
    }
    assert.equal((await publish(desk)).state, "acknowledged", "exact fixture repair permits recovery")
    assert.equal(await fs.lstat(path.dirname(dot)).catch((error) => error.code), "ENOENT")
  }
})

test("private hook context failures and disabled policy never publish a candidate", async () => {
  for (const mode of ["config-failed", "location-failed", "dispatcher-parent", "dispatcher-child", "disabled"]) {
    const w = await world()
    const desk = w.clone("private-context-failure")
    desk.env = { ...desk.env, DESK: desk.deskRoot, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: mode === "dispatcher-parent" ? w.base : mode === "dispatcher-child" ? desk.deskRoot : PRIVATE_HOOKS }
    if (mode === "disabled") git(desk.deskRoot, ["config", "core.hooksPath", "/dev/null"])
    const before = git(w.origin, ["rev-parse", "main"])
    let rejected = 0
    const result = await publish(desk, { git: { spawn(command, args, options) {
      if ((mode === "config-failed" && args[0] === "config") ||
          (mode === "location-failed" && args[0] === "rev-parse" && args[1] === "--git-path")) {
        rejected += 1
        return spawn(command, ["rev-parse", "--verify", "refs/heads/nonexistent-private-context"], options)
      }
      return spawn(command, args, options)
    } } })
    assert.equal(result.state, mode === "disabled" ? "policy_refused" : "unsynchronized", mode)
    if (mode.endsWith("-failed")) assert.ok(rejected > 0, "the actual metadata command failed")
    assert.equal(git(w.origin, ["rev-parse", "main"]), before, mode)
    assert.equal(remoteText(w.origin, paths.annotation).status, 128)
  }
})

test("private hook preparation respects expiry both between metadata reads and before the Git spawn", async (t) => {
  for (const after of ["config", "location"]) {
    const w = await world()
    const desk = w.clone("private-budget")
    desk.env = { ...desk.env, DESK: desk.deskRoot, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS }
    const realNow = Date.now.bind(Date)
    let virtualNow = realNow(), expired = false
    const calls = []
    t.mock.method(Date, "now", () => virtualNow)
    try {
      const result = await publish(desk, { git: { spawn(command, args, options) {
        calls.push(args)
        const child = spawn(command, args, options)
        if (!expired && (after === "config" ? args[0] === "config" : args[0] === "rev-parse" && args[1] === "--git-path")) {
          child.once("close", () => { virtualNow += 10_001; expired = true })
        }
        return child
      } } })
      assert.equal(expired, true)
      assert.equal(result.state, "unsynchronized")
      assert.ok(!calls.some((args) => args[0] === "fetch"), "expired preparation never starts the requested Git operation")
      assert.equal(calls.some((args) => args[1] === "--git-path"), after === "location", "expiry between reads avoids the second metadata read")
      assert.equal(remoteText(w.origin, paths.annotation).status, 128)
    } finally {
      t.mock.restoreAll()
    }
    assert.equal((await publish(desk)).state, "acknowledged", "expiry left no candidate or persistent routing mutation")
  }
})

test("private commit metadata damage and syscall denial hold without overwriting evidence", async (t) => {
  for (const mode of ["not-file", "invalid-gitfile", "backup-present", "backup-stat-denied", "link-denied"]) {
    const w = await world()
    const desk = w.clone("private-metadata")
    desk.env = { ...desk.env, DESK: desk.deskRoot, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS }
    let dot, backup, bytes, moved
    const realLstat = fs.lstat.bind(fs), realSymlink = fs.symlink.bind(fs)
    let denied = 0
    let result
    try {
      result = await publish(desk, { git: { onStep: async (name) => {
        if (name !== "before_commit") return
        const [token] = await fs.readdir(path.join(desk.deskRoot, ".git/desk-triage"))
        dot = path.join(desk.deskRoot, ".git/desk-triage", token, "wt/.git")
        backup = path.join(path.dirname(path.dirname(dot)), "gitfile")
        bytes = await fs.readFile(dot, "utf8")
        if (mode === "not-file") {
          moved = path.join(w.base, "original-gitfile")
          await fs.rename(dot, moved)
          await fs.mkdir(dot)
        } else if (mode === "invalid-gitfile") {
          await fs.writeFile(dot, "foreign metadata\n")
        } else if (mode === "backup-present") {
          await fs.writeFile(backup, "retained foreign backup\n")
        } else if (mode === "backup-stat-denied") {
          t.mock.method(fs, "lstat", async (file, ...args) => {
            if (file === backup) { denied += 1; throw Object.assign(new Error("backup inspection denied"), { code: "EACCES" }) }
            return realLstat(file, ...args)
          })
        } else {
          t.mock.method(fs, "symlink", async (target, file, ...args) => {
            if (file === dot) { denied += 1; throw Object.assign(new Error("directory link denied"), { code: "EACCES" }) }
            return realSymlink(target, file, ...args)
          })
        }
      } } })
    } finally {
      t.mock.restoreAll()
    }
    assert.equal(result.state, "write_failed", mode)
    assert.equal(remoteText(w.origin, paths.annotation).status, 128)
    assert.equal(result.resources.find((resource) => resource.kind === "worktree").disposition, "active")
    if (mode === "not-file") {
      assert.equal((await fs.lstat(dot)).isDirectory(), true)
      assert.equal(await fs.readFile(moved, "utf8"), bytes)
      await fs.rename(dot, path.join(w.base, "retained-foreign-directory"))
      await fs.rename(moved, dot)
    } else if (mode === "invalid-gitfile") {
      assert.equal(await fs.readFile(dot, "utf8"), "foreign metadata\n")
      await fs.writeFile(dot, bytes)
    } else if (mode === "backup-present") {
      assert.equal(await fs.readFile(backup, "utf8"), "retained foreign backup\n")
      assert.equal((await publish(desk)).alarm, RESOURCE_ALARM)
      await fs.rename(backup, path.join(w.base, "retained-foreign-backup"))
    } else {
      assert.ok(denied > 0)
      assert.equal(await fs.readFile(dot, "utf8"), bytes, "the original gitfile survives the failed filesystem boundary")
      assert.equal(await fs.lstat(backup).catch((error) => error.code), "ENOENT")
    }
    assert.equal((await publish(desk)).state, "acknowledged", `${mode}: the fixture's repair permits normal recovery`)
  }
})

test("private interrupted recovery handles the pre-link gap and retains malformed or inaccessible metadata", async (t) => {
  for (const mode of ["gap", "backup-directory", "backup-invalid", "backup-missing-target", "dot-regular", "backup-stat-denied", "dot-stat-denied"]) {
    const w = await world()
    const desk = w.clone("interrupted-metadata")
    desk.env = { ...desk.env, DESK: desk.deskRoot, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS }
    const stopped = await publish(desk, { git: { onStep(name) { if (name === "before_commit") throw new Error("interrupted candidate") } } })
    assert.equal(stopped.state, "write_failed")
    const resource = stopped.resources.find((resource) => resource.kind === "worktree")
    const dot = path.join(resource.path, ".git"), backup = path.join(path.dirname(resource.path), "gitfile")
    const bytes = await fs.readFile(dot, "utf8")
    const target = path.resolve(resource.path, bytes.slice(8).trim())
    if (mode === "backup-directory") await fs.mkdir(backup)
    else if (mode === "backup-invalid") await fs.writeFile(backup, "foreign backup\n")
    else if (mode === "backup-missing-target") await fs.writeFile(backup, `gitdir: ${path.join(desk.deskRoot, ".git/missing-admin")}\n`)
    else if (mode !== "backup-stat-denied") {
      await fs.rename(dot, backup)
      if (mode === "dot-regular") await fs.writeFile(dot, "foreign gitfile\n")
      if (mode === "dot-stat-denied") await fs.symlink(target, dot, process.platform === "win32" ? "junction" : "dir")
    }
    const realLstat = fs.lstat.bind(fs)
    let denied = 0, result
    try {
      if (mode.endsWith("stat-denied")) t.mock.method(fs, "lstat", async (file, ...args) => {
        if (file === (mode === "backup-stat-denied" ? backup : dot)) {
          denied += 1
          throw Object.assign(new Error("interrupted metadata inspection denied"), { code: "EACCES" })
        }
        return realLstat(file, ...args)
      })
      result = await publish(desk)
    } finally {
      t.mock.restoreAll()
    }
    if (mode === "gap") {
      assert.equal(result.state, "acknowledged")
    } else {
      assert.equal(result.state, "busy", mode)
      assert.equal(result.alarm, RESOURCE_ALARM)
      assert.equal(result.resources[0].disposition, "retained")
      if (mode === "backup-directory") {
        assert.equal((await fs.lstat(backup)).isDirectory(), true)
        await fs.rename(backup, path.join(w.base, "retained-backup-directory"))
      } else if (mode.startsWith("backup-") && !mode.endsWith("stat-denied")) {
        assert.equal((await fs.lstat(backup)).isFile(), true)
        await fs.rename(backup, path.join(w.base, "retained-foreign-backup"))
      } else if (mode === "dot-regular") {
        assert.equal(await fs.readFile(dot, "utf8"), "foreign gitfile\n")
        assert.equal(await fs.readFile(backup, "utf8"), bytes)
        await fs.rename(dot, path.join(w.base, "retained-foreign-dot"))
      } else {
        assert.ok(denied > 0)
      }
      assert.equal((await publish(desk)).state, "acknowledged", mode)
    }
    assert.equal(await fs.lstat(resource.path).catch((error) => error.code), "ENOENT")
    assert.equal(await fs.lstat(backup).catch((error) => error.code), "ENOENT")
  }
})

test("a hook replacing private Git metadata is retained and never acknowledged", async () => {
  const w = await world()
  const desk = w.clone("foreign-post-commit")
  desk.env = { ...desk.env, DESK: desk.deskRoot, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS }
  const hook = path.join(desk.deskRoot, ".git/hooks/post-commit")
  const body = "#!/bin/sh\nmv .git .git.foreign-link || exit $?\nprintf 'foreign metadata\\n' > .git\n"
  await fs.writeFile(hook, body, { mode: 0o755 })
  const result = await publish(desk)
  assert.equal(result.state, "write_failed")
  const resource = result.resources.find((resource) => resource.kind === "worktree")
  const dot = path.join(resource.path, ".git"), backup = path.join(path.dirname(resource.path), "gitfile")
  assert.equal(await fs.readFile(dot, "utf8"), "foreign metadata\n")
  assert.ok((await fs.readFile(backup, "utf8")).startsWith("gitdir: "))
  assert.equal((await publish(desk)).alarm, RESOURCE_ALARM)
  assert.equal(remoteText(w.origin, paths.annotation).status, 128)
  assert.equal(await fs.readFile(hook, "utf8"), body, "the original hook was not rewritten")
  await fs.rename(dot, path.join(w.base, "retained-foreign-dot"))
  await fs.rename(path.join(resource.path, ".git.foreign-link"), dot)
  await fs.rename(hook, path.join(w.base, "retained-post-commit"))
  assert.equal((await publish(desk)).state, "acknowledged")
})

test("protected triage file defaults write real owner-protected state", async () => {
  const w = await world()
  const desk = w.clone("protected-defaults")
  const file = await writeProtectedTriageFile(desk.env, ["basis", "default-options.json"], "{}\n")
  assert.equal(await fs.readFile(file, "utf8"), "{}\n")
  assert.ok(file.startsWith(`${w.base}${path.sep}`))
  if (posix) assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
})

test("a self-referential Git metadata report is refused by real Git without publication", async () => {
  const w = await world()
  const desk = w.clone("self-referential-admin")
  desk.env = { ...desk.env, DESK: desk.deskRoot, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS }
  const before = git(w.origin, ["rev-parse", "main"])
  let reports = 0, actualCommit
  const result = await publish(desk, { git: { spawn(command, args, options) {
    if (args.includes("--absolute-git-dir")) {
      reports += 1
      // Fault at the metadata boundary: return Git's real worktree path in the admin slot.
      // The subsequent commit is still the real Git command against that unusable context.
      return spawn(command, args.map((arg) => arg === "--absolute-git-dir" ? "--show-toplevel" : arg), options)
    }
    const child = spawn(command, args, options)
    if (args[0] === "commit") {
      actualCommit = { gitDir: options.env.GIT_DIR, status: null, stderr: "" }
      child.stderr.on("data", (chunk) => { actualCommit.stderr += chunk })
      child.once("close", (status) => { actualCommit.status = status })
    }
    return child
  } } })
  assert.equal(reports, 1)
  assert.equal(actualCommit.gitDir, ".")
  assert.notEqual(actualCommit.status, 0, "an actual Git commit rejects the worktree as its own administrative directory")
  assert.match(actualCommit.stderr, /not a git repository/)
  assert.equal(result.state, "policy_refused")
  assert.equal(git(w.origin, ["rev-parse", "main"]), before)
  assert.equal(remoteText(w.origin, paths.annotation).status, 128)
  assert.ok(result.resources.filter((resource) => resource.kind === "worktree").every((resource) => resource.disposition === "removed"))
})

test("private triage keeps guarded nested commit message operands private before honest parent refusal", async () => {
  for (const configured of [null, "nested message hooks", "relative hooks"]) {
    const w = await world()
    const desk = w.clone("nested-message-hook")
    const root = desk.deskRoot
    await fs.mkdir(path.join(root, "project"))
    await fs.writeFile(path.join(root, "project/.keep"), "")
    const hooks = configured === "relative hooks" ? path.join(root, configured) : path.join(root, ".git", configured ?? "hooks")
    await fs.mkdir(hooks, { recursive: true })
    const originals = new Map()
    for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
      const body = hookArgvScript({ nestedCommit: name === "post-commit" })
      originals.set(name, body)
      if (configured !== null) await fs.writeFile(path.join(hooks, name), body, { mode: 0o755 })
    }
    // Seed without enabling the fixture hooks; the nested operation belongs only to triage.
    git(root, ["add", "--", "project", ...(configured === "relative hooks" ? [configured] : [])])
    git(root, ["commit", "-qm", "seed project and policy"])
    git(root, ["push", "-q", "origin", "main"])
    if (configured === null) for (const [name, body] of originals) await fs.writeFile(path.join(hooks, name), body, { mode: 0o755 })
    const hooksPath = configured === "relative hooks" ? configured : hooks
    if (configured !== null) git(root, ["config", "core.hooksPath", hooksPath])
    const log = path.join(w.base, "nested-message-argv.jsonl")
    const subdirectoryLog = path.join(w.base, "nested-message-discovery.txt")
    desk.env = { ...desk.env, DESK: root, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS, DESK_HOOK_LOG: log, DESK_HOOK_NODE: process.execPath, DESK_HOOK_SUBDIRECTORY_LOG: subdirectoryLog }
    const result = await publish(desk)
    const rows = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse)
    const worktree = rows.find((row) => row.hook.includes("pre-commit")).cwd
    assert.deepEqual((await fs.readFile(subdirectoryLog, "utf8")).trim().split("\n"), [path.join(worktree, "project"), worktree])
    for (const name of ["prepare-commit-msg", "commit-msg", "post-commit"]) {
      assert.ok(rows.some((row) => row.hook.includes(name) && row.nestedCommit), `guarded nested original ${name} executed`)
    }
    if (process.platform === "darwin") {
      for (const name of ["prepare-commit-msg", "commit-msg"]) {
        const row = rows.find((row) => row.hook.includes(name) && row.nestedCommit)
        assert.ok(row.ancestors.flat().some((arg) => arg.includes("private-hooks/dispatch.cjs") && arg.includes(`${name} .git/COMMIT_EDITMSG`)), "actual public dispatcher kernel argv, not only original forwarded arguments")
      }
    }
    for (const row of rows) {
      assert.ok(![row.hook, ...row.args, ...row.kernel, ...row.ancestors.flat()].some((arg) => arg.includes(root)), JSON.stringify(row))
      assert.equal(row.top, worktree)
      assert.equal(row.hooksPath, configured === null ? "" : hooksPath)
      assert.equal(row.effectiveHooksPath, PRIVATE_HOOKS)
      if (row.hook.includes("commit-msg")) assert.ok(row.message.includes(row.nestedCommit ? "nested message witness" : "Record factory triage annotation"))
    }
    assert.equal(result.state, "policy_unknown", "a second commit must still fail the unchanged parent check")
    assert.equal(remoteText(w.origin, paths.annotation).status, 128)
    assert.ok(result.resources.filter((resource) => resource.kind === "worktree").every((resource) => resource.disposition === "removed"))
    for (const [name, body] of originals) assert.equal(await fs.readFile(path.join(hooks, name), "utf8"), body, `original ${name} unchanged`)
  }
})

test("private triage recovers its interrupted gitfile swap but retains foreign replacement metadata", async () => {
  for (const foreign of [false, true]) {
    const w = await world()
    const desk = w.clone("gitfile-recovery")
    desk.env = { ...desk.env, DESK: desk.deskRoot, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS }
    const stopped = await publish(desk, { git: { onStep(name) { if (name === "before_commit") throw new Error("interrupted candidate") } } })
    assert.equal(stopped.state, "write_failed")
    const resource = stopped.resources.find((resource) => resource.kind === "worktree")
    const dot = path.join(resource.path, ".git")
    const backup = path.join(path.dirname(resource.path), "gitfile")
    const bytes = await fs.readFile(dot, "utf8")
    const target = path.resolve(resource.path, bytes.slice(8).trim())
    // Reproduce the exact durable metadata shape left by a stopped process during privateCommit.
    await fs.rename(dot, backup)
    await fs.symlink(foreign ? desk.deskRoot : target, dot, process.platform === "win32" ? "junction" : "dir")
    if (foreign) {
      const blocked = await publish(desk)
      assert.equal(blocked.state, "busy")
      assert.equal(blocked.alarm, RESOURCE_ALARM)
      assert.equal(blocked.resources[0].disposition, "retained")
      assert.equal(await fs.realpath(dot), await fs.realpath(desk.deskRoot), "foreign metadata was not replaced")
      assert.equal(await fs.readFile(backup, "utf8"), bytes, "the original gitfile is still retained")
      await fs.unlink(dot)
      await fs.symlink(target, dot, process.platform === "win32" ? "junction" : "dir")
    }
    const recovered = await publish(desk)
    assert.equal(recovered.state, "acknowledged", JSON.stringify(recovered))
    assert.ok(recovered.resources.filter((resource) => resource.kind === "worktree").every((resource) => resource.disposition === "removed"))
    assert.equal(await fs.lstat(backup).catch((error) => error.code), "ENOENT")
    assert.equal(await fs.lstat(resource.path).catch((error) => error.code), "ENOENT")
  }
})

test("private triage keeps same-worktree subdirectory Git, nested hooks and message argv valid together", async () => {
  const w = await world()
  const desk = w.clone("subdirectory-hook")
  const root = desk.deskRoot
  await fs.mkdir(path.join(root, "project"))
  await fs.writeFile(path.join(root, "project/.keep"), "")
  git(root, ["add", "--", "project"])
  git(root, ["commit", "-qm", "seed project"])
  git(root, ["push", "-q", "origin", "main"])
  const hooks = path.join(root, ".git/hooks")
  const originals = new Map()
  for (const name of ["post-checkout", "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-index-change"]) {
    const body = hookArgvScript({ nestedMutation: name === "pre-commit", subdirectory: name === "pre-commit" })
    originals.set(name === "pre-commit" ? "pre-commit.desk-chained" : name, body)
    await fs.writeFile(path.join(hooks, name), body, { mode: 0o755 })
  }
  assert.equal(installCardGuard(root).state, "installed")
  const log = path.join(w.base, "subdirectory-hook-argv.jsonl")
  const subdirectoryLog = path.join(w.base, "subdirectory-git.txt")
  desk.env = { ...desk.env, DESK: root, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS, DESK_HOOK_LOG: log, DESK_HOOK_NODE: process.execPath, DESK_HOOK_SUBDIRECTORY_LOG: subdirectoryLog }
  const result = await publish(desk)
  assert.equal(result.state, "acknowledged", JSON.stringify(result))
  const rows = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse)
  const worktree = rows.find((row) => row.hook.includes("pre-commit")).cwd
  assert.deepEqual((await fs.readFile(subdirectoryLog, "utf8")).trim().split("\n"), [path.join(worktree, "project"), worktree], "actual subdirectory cwd and real Git top-level result")
  assert.ok(rows.some((row) => row.hook.includes("post-index-change") && row.nestedMutation), "subdirectory mutation triggered the original nested hook")
  for (const row of rows) {
    assert.ok(![row.hook, ...row.args, ...row.kernel, ...row.ancestors.flat()].some((arg) => arg.includes(root)), JSON.stringify(row))
    assert.ok(row.top === root || row.top.startsWith(`${root}${path.sep}`))
    assert.equal(row.hooksPath, "")
    assert.equal(row.effectiveHooksPath, PRIVATE_HOOKS)
    if (row.hook.includes("commit-msg")) assert.ok(row.message.includes("Record factory triage annotation"))
  }
  for (const [name, body] of originals) assert.equal(await fs.readFile(path.join(hooks, name), "utf8"), body, `original ${name} is unchanged`)
})

test("private triage preserves routing for a nested hook-triggering Git mutation", async () => {
  for (const configured of [null, "nested policy hooks"]) {
    const w = await world()
    const desk = w.clone("nested-hook")
    const root = desk.deskRoot
    const hooks = path.join(root, ".git", configured ?? "hooks")
    await fs.mkdir(hooks, { recursive: true })
    if (configured !== null) git(root, ["config", "core.hooksPath", hooks])
    const probe = hookArgvScript()
    await fs.writeFile(path.join(hooks, "pre-commit"), hookArgvScript({ nestedMutation: true }), { mode: 0o755 })
    await fs.writeFile(path.join(hooks, "post-index-change"), probe, { mode: 0o755 })
    assert.equal(installCardGuard(root).state, "installed")
    const log = path.join(w.base, "nested-hook-argv.jsonl")
    desk.env = { ...desk.env, DESK: root, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS, DESK_HOOK_LOG: log, DESK_HOOK_NODE: process.execPath }
    const result = await publish(desk)
    assert.equal(result.state, "acknowledged", JSON.stringify(result))
    const rows = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse)
    assert.ok(rows.some((row) => row.hook.includes("pre-commit")), "original pre-commit ran")
    assert.ok(rows.some((row) => row.hook.includes("post-index-change") && row.nestedMutation), `original nested post-index-change ran: ${JSON.stringify(rows)}`)
    for (const row of rows) {
      assert.ok(![row.hook, ...row.args, ...row.kernel, ...row.ancestors.flat()].some((arg) => arg.includes(root)), JSON.stringify(row))
      assert.ok(row.top === root || row.top.startsWith(`${root}${path.sep}`), "nested Git retains its linked worktree context")
      assert.equal(row.hooksPath, configured === null ? "" : hooks)
      assert.equal(row.effectiveHooksPath, PRIVATE_HOOKS, "nested Git retains public routing over the original policy")
      if (row.toolCommit === "1") assert.equal(row.gitDir, undefined, "original hooks use same-worktree discovery, not a cwd-bound Git directory")
    }
    assert.equal(git(root, ["config", "--get", "core.hooksPath"], { allowFail: true }), configured === null ? "" : hooks)
    assert.ok(result.resources.filter((resource) => resource.kind === "worktree").every((resource) => resource.disposition === "removed"))
  }
})

test("private triage executable hook descendants keep policy, execution and message paths private", async () => {
  for (const configured of [null, "policy hooks", "relative hooks"]) {
    const world_ = await world()
    const desk = world_.clone("private-hook")
    const root = desk.deskRoot
    const hooks = configured === null ? path.join(root, ".git/hooks") : path.join(root, configured === "relative hooks" ? "" : ".git", configured)
    await fs.mkdir(hooks, { recursive: true })
    for (const name of ["post-checkout", "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
      await fs.writeFile(path.join(hooks, name), hookArgvScript(), { mode: 0o755 })
    }
    if (configured === "relative hooks") {
      git(root, ["add", "--", configured])
      git(root, ["commit", "-qm", "seed relative hook policy"])
      git(root, ["push", "-q", "origin", "main"])
    }
    const hooksPath = configured === "relative hooks" ? configured : hooks
    if (configured !== null) git(root, ["config", "core.hooksPath", hooksPath])
    assert.equal(installCardGuard(root).state, configured === "relative hooks" ? "tracked" : "installed")
    const log = path.join(world_.base, "hook-argv.jsonl")
    desk.env = { ...desk.env, DESK: root, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS, DESK_HOOK_LOG: log, DESK_HOOK_NODE: process.execPath }
    const trace = []
    const result = await publish(desk, { git: { spawn(command, args, options) {
      const child = spawn(command, args, options)
      let stdout = "", stderr = ""
      child.stdout.on("data", (chunk) => { stdout += chunk })
      child.stderr.on("data", (chunk) => { stderr += chunk })
      child.on("close", (status) => trace.push({ args, status, stdout: stdout.slice(0, 512), stderr: stderr.slice(0, 512) }))
      return child
    } } })
    const hookLog = await fs.readFile(log, "utf8").catch(() => "")
    assert.equal(result.state, "acknowledged", JSON.stringify({ result, trace: trace.slice(-16), hookLog }))
    const rows = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse)
    for (const name of ["post-checkout", "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
      assert.ok(rows.some((row) => row.hook.includes(name)), `hook did not execute: ${name}`)
    }
    for (const row of rows) {
      assert.ok(![row.hook, ...row.args, ...row.kernel, ...row.ancestors.flat()].some((arg) => arg.includes(root)), JSON.stringify(row))
      assert.ok(row.top === root || row.top.startsWith(`${root}${path.sep}`), "original hooks must retain their Git context")
      assert.equal(row.hooksPath, configured === null ? "" : hooksPath, "the original hook must observe the original hook policy")
      assert.equal(row.effectiveHooksPath, PRIVATE_HOOKS, "original hooks retain the effective private routing overlay")
      if (row.toolCommit === "1") assert.equal(row.gitDir, undefined, "original hooks have no cwd-bound Git directory")
      if (configured === "relative hooks") assert.equal(path.dirname(path.resolve(row.cwd, row.hook)), path.join(row.cwd, configured), "relative policy resolves in the actual hook cwd")
      if (row.hook.includes("commit-msg")) assert.ok(row.message.includes("Record factory triage annotation"))
    }
    assert.ok(result.resources.filter((r) => r.kind === "worktree").every((r) => r.disposition === "removed"))
    assert.equal(git(root, ["config", "--get", "core.hooksPath"], { allowFail: true }), configured === null ? "" : hooksPath)
  }
})

test("private triage still obeys an executable rejecting hook and never acknowledges its commit", async () => {
  const world_ = await world()
  const desk = world_.clone("private-reject")
  const root = desk.deskRoot
  const log = path.join(world_.base, "rejected-hook.jsonl")
  await fs.writeFile(path.join(root, ".git/hooks/pre-commit"), hookArgvScript(), { mode: 0o755 })
  installCardGuard(root)
  desk.env = { ...desk.env, DESK: root, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS, DESK_HOOK_LOG: log, DESK_HOOK_NODE: process.execPath, DESK_HOOK_EXIT: "23" }
  const trace = []
  const result = await publish(desk, { git: { spawn(command, args, options) {
    const started = performance.now()
    const child = spawn(command, args, options)
    let stdout = "", stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.once("close", (status) => trace.push({ args, status, stdout, stderr, elapsedMs: performance.now() - started, commonDir: options.env.GIT_COMMON_DIR, gitDir: options.env.GIT_DIR }))
    return child
  } } })
  assert.equal(result.state, "policy_refused", JSON.stringify({ result, trace }))
  const rows = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse)
  assert.ok(rows.some((row) => row.hook.includes("pre-commit")))
  assert.equal(remoteText(world_.origin, paths.annotation).status, 128)
})

test("private triage does not turn an unexecutable hook directory into a successful commit", async () => {
  const world_ = await world()
  const desk = world_.clone("private-hook-directory")
  await fs.mkdir(path.join(desk.deskRoot, ".git/hooks/pre-commit"))
  desk.env = { ...desk.env, DESK: desk.deskRoot, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS }
  assert.equal((await publish(desk)).state, "policy_refused")
})

test("private built-in triage keeps worktree operands desk-relative and completes real acknowledgement", async () => {
  const world_ = await world()
  const desk = world_.clone("private")
  const root = desk.deskRoot
  desk.env = { ...desk.env, DESK: root, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS }
  const calls = []
  const spawnPrivate = (command, args, options) => {
    assert.ok(!args.includes("-C"))
    assert.ok(!args.some((arg) => arg.includes(root) || arg.includes(world_.base)))
    assert.ok(options.cwd === root || options.cwd.startsWith(`${root}${path.sep}`))
    calls.push(args)
    return spawn(command, args, options)
  }
  const result = await publish(desk, { git: { spawn: spawnPrivate } })
  assert.equal(result.state, "acknowledged", JSON.stringify(result))
  assert.ok(calls.some((args) => args[0] === "worktree" && args[1] === "add"))
  assert.ok(calls.some((args) => args[0] === "push"))
  assert.ok(result.resources.filter((resource) => resource.kind === "worktree").every((resource) => resource.disposition === "removed"))
  assert.ok(remoteJson(world_.origin, paths.annotation))
})

function git(cwd, args, { allowFail = false } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

async function world({ agents = true, attributes = null } = {}) {
  const base = await mkTempRoot("triage-write-")
  const origin = path.join(base, "origin.git")
  git(base, ["init", "-q", "--bare", origin])
  const seed = path.join(base, "seed")
  await fs.mkdir(seed)
  git(seed, ["init", "-q"])
  await fs.mkdir(path.join(seed, "_archive"))
  await fs.writeFile(path.join(seed, "_archive", ".keep"), "")
  if (agents) await fs.writeFile(path.join(seed, "AGENTS.md"), "Agents may fix factory defects in existing scope.\n")
  if (attributes !== null) await fs.writeFile(path.join(seed, ".gitattributes"), attributes)
  await fs.writeFile(path.join(seed, "README.md"), "desk\n")
  for (const key of [KEY, fixture.related_key]) {
    const opened = await openImprovement({ deskRoot: seed, personPrefix: "", key, source: "andon", evidence: [`issue:${key.slice(6)}`], plugin: "desk", signal: null, now: T0 })
    assert.equal(opened.result, "opened")
  }
  commitAll(seed, "seed")
  git(seed, ["remote", "add", "origin", origin])
  git(seed, ["push", "-q", "-u", "origin", "main"])
  const clones = {}
  const clone = (name, config = []) => {
    const deskRoot = path.join(base, name)
    git(base, ["clone", "-q", ...config, origin, deskRoot])
    configure(deskRoot)
    clones[name] = { name, deskRoot, env: { ...process.env, XDG_STATE_HOME: path.join(base, `${name}-state`) } }
    return clones[name]
  }
  return { base, origin, clone }
}

function configure(root) {
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
}

function commitAll(root, message) {
  configure(root)
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", message])
}

async function basisFor(desk, { now = T0, key = KEY } = {}) {
  return (await readTriageBasis({ deskRoot: desk.deskRoot, personPrefix: "", key, now, evidence: { resolve: resolveIssue } })).basis
}

async function publish(desk, overrides = {}) {
  return publishOwnedTriage({
    env: desk.env, deskRoot: desk.deskRoot, personPrefix: "", key: KEY, store: STORE,
    expectedBasis: overrides.expectedBasis ?? (await basisFor(desk)), review: { ...HUMAN, protected_result: hex(16) }, operation: "review", now: T0,
    evidence: { resolve: resolveIssue },
    ...overrides,
  })
}

const paths = triagePaths("/desk", "", KEY)
const remoteText = (origin, file) => spawnSync("git", ["-C", origin, "show", `main:${file}`], { encoding: "utf8" })
function remoteJson(origin, file) {
  const shown = remoteText(origin, file)
  return shown.status === 0 ? JSON.parse(shown.stdout) : null
}
// Every ID the remote's registry has ever held, across its whole history.
function idsEverPublished(origin) {
  const ids = new Set()
  for (const commit of git(origin, ["log", "--format=%H", "main", "--", paths.registry]).split("\n").filter(Boolean)) {
    for (const entry of JSON.parse(git(origin, ["show", `${commit}:${paths.registry}`])).entries) ids.add(entry.id)
  }
  return ids
}

function barrier(count) {
  let seen = 0
  let open
  const gate = new Promise((resolve) => { open = resolve })
  return async () => {
    seen += 1
    if (seen === count) open()
    await gate
  }
}

// Pushes a change to the remote through a separate clone, as another host would.
async function remoteChange(world_, name, change, message = "remote change") {
  const other = path.join(world_.base, `${name}-${hex(4)}`)
  git(world_.base, ["clone", "-q", world_.origin, other])
  await change(other)
  commitAll(other, message)
  git(other, ["push", "-q", "origin", "main"])
}

// Replaces one Git subcommand with a failing call (a real Git process that exits non-zero), leaving everything else real.
function failing(match, replacement = ["config", "--no-such-option"]) {
  return (command, args, options) => (match(args.slice(2)) ? spawn(command, [...args.slice(0, 2), ...replacement], options) : spawn(command, args, options))
}

function liveState(root) {
  return { head: git(root, ["rev-parse", "HEAD"]), index: git(root, ["diff", "--cached", "--binary"]), status: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) }
}

async function writeHook(desk, body) {
  const hooks = path.join(desk.deskRoot, ".git", "hooks")
  await fs.mkdir(hooks, { recursive: true })
  const file = path.join(hooks, "pre-commit")
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

test("simultaneous_assignment_requires_remote_ack", async () => {
  const w = await world()
  const a = w.clone("a")
  const b = w.clone("b")
  assert.deepEqual(readAcknowledgedAnnotations({ deskRoot: a.deskRoot, personPrefix: "" }), { source: "remote", annotations: [], damaged: 0 })
  const gate = barrier(2)
  const onStep = (name) => (name === "remote_read" ? gate() : undefined)
  const [ra, rb] = await Promise.all([publish(a, { git: { onStep } }), publish(b, { git: { onStep } })])
  const states = [ra.state, rb.state].sort()
  assert.deepEqual(states, ["acknowledged", "adopted"], JSON.stringify([ra, rb]))
  assert.equal(ra.id, rb.id, "the loser adopts the acknowledged ID")
  assert.equal(ra.revision, 1)
  assert.equal(rb.revision, 1, "the same review is adopted with no redundant revision")
  assert.deepEqual(idsEverPublished(w.origin), new Set([ra.id]), "the losing ID never reached the remote")
  const registry = remoteJson(w.origin, paths.registry)
  assert.deepEqual(registry.entries, [{ key: KEY, store: STORE.toLowerCase(), id: ra.id, revision: 1, public_basis: null }])
  const winner = ra.state === "acknowledged" ? ra : rb
  assert.equal(winner.ack.remote, "origin")
  assert.equal(winner.ack.ref, "refs/heads/main")
  assert.equal(winner.ack.commit, git(w.origin, ["rev-parse", "main"]))
  assert.equal(winner.ack.registry_blob, git(w.origin, ["rev-parse", `main:${paths.registry}`]))
  assert.equal(winner.ack.annotation_blob, git(w.origin, ["rev-parse", `main:${paths.annotation}`]))
  for (const result of [ra, rb]) assert.ok(result.resources.filter((r) => r.kind === "worktree").every((r) => r.disposition === "removed"), JSON.stringify(result.resources))
  // The loser keeps its equivalent basis under the adopted review's token, so its own mechanical refresh can recheck the review.
  const loser = ra.state === "adopted" ? a : b
  const loserRefresh = await refreshTriage({ env: loser.env, deskRoot: loser.deskRoot, personPrefix: "", now: T0, evidence: { resolve: resolveIssue } })
  assert.deepEqual(loserRefresh.changes, [], JSON.stringify(loserRefresh.changes))
  assert.equal(loserRefresh.coverage.reviewed, 1)

  // Concurrent new revisions on the same ID converge to distinct revisions, never an equal-revision conflict.
  const gate2 = barrier(2)
  const onStep2 = (name) => (name === "remote_read" ? gate2() : undefined)
  const [r2a, r2b] = await Promise.all([
    publish(a, { review: { ...AGENT, protected_result: hex(16) }, git: { onStep: onStep2 } }),
    publish(b, { review: { ...HUMAN, gate: "spend", summary_codes: ["source:andon", "route:human_decision", "gate:spend"], protected_result: hex(16) }, git: { onStep: onStep2 } }),
  ])
  assert.deepEqual([r2a.state, r2b.state], ["acknowledged", "acknowledged"], JSON.stringify([r2a, r2b]))
  assert.deepEqual([r2a.revision, r2b.revision].sort(), [2, 3])
  assert.equal(r2a.id, ra.id)
  assert.equal(r2b.id, ra.id)
  assert.equal(remoteJson(w.origin, paths.annotation).revision, 3)

  // A second store gets its own random ID for the same card; the first store's high-water mark is kept.
  const other = await publish(a, { store: "example-org/second-store", review: { ...AGENT, protected_result: hex(16) } })
  assert.equal(other.state, "acknowledged")
  assert.notEqual(other.id, ra.id)
  assert.equal(other.revision, 4)
  assert.deepEqual(remoteJson(w.origin, paths.registry).entries.map((entry) => [entry.store, entry.id, entry.revision]), [
    ["example-org/example-store", ra.id, 3], ["example-org/second-store", other.id, 4],
  ])
  assert.equal(validateTriageIdentities(remoteText(w.origin, paths.registry).stdout).ok, true)

  // The resolver reads only the acknowledged registry.
  git(a.deskRoot, ["fetch", "-q", "origin"])
  const protectedResult = remoteJson(w.origin, paths.annotation).review.protected_result
  assert.deepEqual(resolveAcknowledgedTriage({ deskRoot: a.deskRoot, personPrefix: "", store: "example-org/second-store", id: other.id, revision: 4 }), { state: "resolved", key: KEY, protected_result: protectedResult })
  assert.deepEqual(resolveAcknowledgedTriage({ deskRoot: a.deskRoot, personPrefix: "", store: STORE, id: ra.id, revision: 1 }), { state: "stale", key: KEY })
  assert.deepEqual(resolveAcknowledgedTriage({ deskRoot: a.deskRoot, personPrefix: "", store: STORE, id: other.id, revision: 4 }), { state: "not_resolved" })
  assert.deepEqual(resolveAcknowledgedTriage({ deskRoot: a.deskRoot, personPrefix: "", store: STORE, id: hex(16), revision: 1 }), { state: "not_resolved" })
  assert.equal(readAcknowledgedAnnotations({ deskRoot: a.deskRoot, personPrefix: "" }).source, "remote")
})

test("loser_with_a_different_review_writes_the_next_revision_under_the_winning_id", async () => {
  const w = await world()
  const a = w.clone("a")
  const b = w.clone("b")
  const gate = barrier(2)
  const onStep = (name) => (name === "remote_read" ? gate() : undefined)
  const [ra, rb] = await Promise.all([publish(a, { git: { onStep } }), publish(b, { review: { ...AGENT, protected_result: hex(16) }, git: { onStep } })])
  assert.deepEqual([ra.state, rb.state], ["acknowledged", "acknowledged"])
  assert.equal(ra.id, rb.id)
  assert.deepEqual([ra.revision, rb.revision].sort(), [1, 2])
  assert.equal(idsEverPublished(w.origin).size, 1)
})

test("changed_basis_during_push_holds_and_unrelated_advance_retries_once", async () => {
  const w = await world()
  const a = w.clone("a")
  let changed = false
  const stale = await publish(a, {
    git: {
      onStep: async (name) => {
        if (name !== "before_commit" || changed) return
        changed = true
        await remoteChange(w, "card", async (root) => {
          const file = path.join(root, triagePaths(root, "", KEY).card)
          await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(`["issue:example-org/example-repo#101"]`, `["issue:example-org/example-repo#101","issue:example-org/example-repo#5"]`))
        })
      },
    },
  })
  assert.equal(stale.state, "stale_basis")
  assert.equal(stale.id, undefined)
  assert.equal(remoteJson(w.origin, paths.registry), null, "nothing was emitted")

  const b = w.clone("b")
  let advanced = false
  const retried = await publish(b, {
    git: {
      onStep: async (name) => {
        if (name !== "before_commit" || advanced) return
        advanced = true
        await remoteChange(w, "unrelated", (root) => fs.writeFile(path.join(root, "unrelated.md"), "x\n"))
      },
    },
  })
  assert.equal(retried.state, "acknowledged", JSON.stringify(retried))

  const twice = await publish(b, {
    review: { ...AGENT, protected_result: hex(16) },
    git: { onStep: async (name) => { if (name === "before_commit") await remoteChange(w, "again", (root) => fs.writeFile(path.join(root, `u-${hex(3)}.md`), "x\n")) } },
  })
  assert.equal(twice.state, "unacknowledged", "a second rejection is not retried again")
  assert.equal(remoteJson(w.origin, paths.annotation).revision, 1)

  // Readback that no longer matches the basis (the card changed right after the push) is not an acknowledgement.
  git(b.deskRoot, ["pull", "-q"])
  const readback = await publish(b, {
    review: { ...AGENT, protected_result: hex(16) },
    git: {
      onStep: async (name) => {
        if (name === "pushed") {
          await remoteChange(w, "after", async (root) => {
            const file = path.join(root, triagePaths(root, "", KEY).card)
            await fs.writeFile(file, `${await fs.readFile(file, "utf8")}\n`)
          })
        }
      },
    },
  })
  assert.equal(readback.state, "unacknowledged")

  // Evidence revisions are resolved live at publication, not taken from the prepared basis.
  git(b.deskRoot, ["pull", "-q"])
  const head = git(w.origin, ["rev-parse", "main"])
  const edited = async (pointer) => ({ ...(await resolveIssue(pointer)), revision: 4 })
  assert.equal((await publish(b, { evidence: { resolve: edited } })).state, "stale_basis", "the public issue changed since the review")
  assert.equal((await publish(b, { evidence: {} })).state, "stale_basis", "no live resolver can answer for the issue")
  assert.equal((await publish(b, { evidence: { resolve: () => { throw new Error("offline") } } })).state, "stale_basis", "a failing resolver proves nothing")
  assert.equal(git(w.origin, ["rev-parse", "main"]), head, "nothing was pushed")
  // The resolver is handed the card as published, as readTriageBasis hands it.
  const seen = []
  const recording = async (pointer, card) => {
    seen.push(card?.key)
    return resolveIssue(pointer)
  }
  assert.equal((await publish(b, { evidence: { resolve: recording }, git: { onStep: (name) => { if (name === "remote_read") throw new Error("stop") } } })).state, "write_failed")
  assert.ok(seen.length > 0 && seen.every((key) => key === KEY), JSON.stringify(seen))
  // A checkout behind the remote card cannot hand over the expected card: the basis read elsewhere does not hold here.
  const c = w.clone(`c-${hex(3)}`)
  await remoteChange(w, "behind", async (root) => {
    const file = path.join(root, triagePaths(root, "", KEY).card)
    await fs.writeFile(file, `${await fs.readFile(file, "utf8")}\n`)
  })
  git(b.deskRoot, ["pull", "-q"])
  assert.equal((await publish(c, { expectedBasis: await basisFor(b) })).state, "stale_basis")
  let pushed = false
  const editedAfterPush = async (pointer) => (pushed ? edited(pointer) : resolveIssue(pointer))
  const late = await publish(b, {
    review: { ...HUMAN, gate: "intent", summary_codes: ["source:andon", "route:human_decision", "gate:intent"], protected_result: hex(16) },
    evidence: { resolve: editedAfterPush },
    git: { onStep: (name) => { if (name === "pushed") pushed = true } },
  })
  assert.equal(late.state, "unacknowledged", "evidence that changed by readback is not acknowledged")
})

test("dirty_siblings_are_preserved_and_relevant_local_state_holds", async () => {
  const w = await world()
  const a = w.clone("a")
  await fs.writeFile(path.join(a.deskRoot, "README.md"), "edited by another session\n")
  await fs.mkdir(path.join(a.deskRoot, "notes"))
  await fs.writeFile(path.join(a.deskRoot, "notes", "staged.md"), "staged\n")
  git(a.deskRoot, ["add", "notes/staged.md"])
  await fs.writeFile(path.join(a.deskRoot, "notes", "untracked.md"), "untracked\n")
  const before = liveState(a.deskRoot)
  const result = await publish(a)
  assert.equal(result.state, "acknowledged")
  assert.deepEqual(liveState(a.deskRoot), before, "live HEAD, index, tree and siblings are untouched")
  assert.equal(await fs.readFile(path.join(a.deskRoot, "README.md"), "utf8"), "edited by another session\n")
  await assert.rejects(fs.lstat(path.join(a.deskRoot, paths.dir)), "no annotation copy is left in the live checkout")

  // A relevant dirty, staged or untracked path holds: the local state could disagree with what would be published.
  const card = path.join(a.deskRoot, paths.card)
  const cardBytes = await fs.readFile(card)
  await fs.appendFile(card, "\n")
  assert.equal((await publish(a, { expectedBasis: await basisFor({ ...a }) })).state, "unsynchronized")
  await fs.writeFile(card, cardBytes)
  await fs.mkdir(path.join(a.deskRoot, paths.dir), { recursive: true })
  await fs.writeFile(path.join(a.deskRoot, paths.annotation), "{}\n")
  assert.equal((await publish(a)).state, "unsynchronized")
  await fs.unlink(path.join(a.deskRoot, paths.annotation))
})

test("local_only_canonical_or_ruling_commit_holds", async () => {
  const w = await world()
  const a = w.clone("a")
  await fs.writeFile(path.join(a.deskRoot, "AGENTS.md"), "Scope narrowed locally.\n")
  git(a.deskRoot, ["commit", "-q", "-am", "local ruling"])
  const head = git(a.deskRoot, ["rev-parse", "HEAD"])
  const result = await publish(a)
  assert.equal(result.state, "unsynchronized")
  assert.equal(result.id, undefined)
  assert.equal(git(a.deskRoot, ["rev-parse", "HEAD"]), head, "the local-only commit is preserved")
  assert.equal(remoteJson(w.origin, paths.registry), null)

  // Behind the remote on a relevant path: the prepared basis no longer equals the remote basis.
  const b = w.clone("b")
  await remoteChange(w, "rules", (root) => fs.writeFile(path.join(root, "AGENTS.md"), "Remote ruling change.\n"))
  assert.equal((await publish(b)).state, "stale_basis")
  // A ruling that appeared only on the remote changes the basis too.
  const c = w.clone("c")
  await remoteChange(w, "operator", async (root) => fs.writeFile(path.join(root, "_meta", "operator-rules.md"), "New rule.\n"))
  assert.equal((await publish(c)).state, "stale_basis")
  // An expired claim at publication time changes effective ownership.
  git(c.deskRoot, ["pull", "-q"])
  const basis = await basisFor(c)
  assert.equal((await publish(c, { expectedBasis: { ...basis, claim: { state: "live", expires_at: new Date(T0 - 1000).toISOString() } } })).state, "stale_basis")
})

test("damaged_or_disagreeing_identity_state_holds", async () => {
  const w = await world()
  const a = w.clone("a")
  const writeTriage = (registry, annotation) => remoteChange(w, "triage", async (root) => {
    await fs.mkdir(path.join(root, paths.dir), { recursive: true })
    if (registry !== undefined) await fs.writeFile(path.join(root, paths.registry), registry)
    if (annotation !== undefined) await fs.writeFile(path.join(root, paths.annotation), annotation)
  })
  const entry = (revision) => `${JSON.stringify({ schema: "desk.factory.triage-identities/1", entries: [{ key: KEY, store: STORE.toLowerCase(), id: hex(16), revision, public_basis: null }] })}\n`
  const annotation = (revision, key = KEY) => `${JSON.stringify({
    schema: "desk.factory.triage-local/1", key, revision,
    basis: { generation: hex(16), canonical_revision: "a".repeat(40), public_evidence_revisions: [], protected_basis: hex(16) },
    review: HUMAN, attempt: { state: "reviewed", at: new Date(T0).toISOString(), reason: "review_accepted" },
  })}\n`
  await writeTriage("{damaged")
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "identity_conflict")
  await writeTriage(entry(1))
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "identity_conflict", "a registry entry without its annotation")
  await writeTriage(entry(3), annotation(2))
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "identity_conflict", "the registry ahead of the annotation")
  await writeTriage(entry(1), annotation(1, fixture.related_key))
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "identity_conflict", "an annotation for another card at this card's path")
  await writeTriage(undefined, "{}\n")
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "identity_conflict", "a damaged annotation")
  await writeTriage(entry(Number.MAX_SAFE_INTEGER), annotation(Number.MAX_SAFE_INTEGER))
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "write_failed", "a high-water mark that cannot advance")
})

test("unsafe_triage_paths_in_the_remote_tree_hold", async () => {
  const w = await world()
  const a = w.clone("a")
  await remoteChange(w, "file", async (root) => fs.writeFile(path.join(root, paths.dir), "a file where the folder belongs\n"))
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "unsafe_path")
  await remoteChange(w, "folder", async (root) => {
    await fs.unlink(path.join(root, paths.dir))
    await fs.mkdir(path.join(root, paths.annotation), { recursive: true })
    await fs.writeFile(path.join(root, paths.annotation, "keep"), "x\n")
  })
  git(a.deskRoot, ["pull", "-q"])
  assert.equal((await publish(a)).state, "unsafe_path")
})

test("crash_after_push_is_adopted_by_the_next_pass", async () => {
  const w = await world()
  const a = w.clone("a")
  const review = { ...HUMAN, protected_result: hex(16) }
  const crashed = await publish(a, { review, git: { onStep: (name) => { if (name === "pushed") throw new Error("killed") } } })
  assert.equal(crashed.state, "unacknowledged")
  assert.equal(crashed.id, undefined, "no ID is emitted before readback")
  assert.ok(crashed.resources.some((r) => r.kind === "worktree" && r.disposition === "active"), "the candidate is left for recovery")
  const pushed = remoteJson(w.origin, paths.registry).entries[0]
  const next = await publish(a, { review })
  assert.equal(next.state, "adopted")
  assert.equal(next.id, pushed.id)
  assert.equal(next.revision, 1)
  assert.ok(next.resources.some((r) => r.kind === "worktree" && r.disposition === "removed"), JSON.stringify(next.resources))

  // A crash before anything could be pushed is a write failure, also recovered.
  const early = await publish(a, { review: { ...AGENT, protected_result: hex(16) }, git: { onStep: (name) => { if (name === "remote_read") throw new Error("killed") } } })
  assert.equal(early.state, "write_failed")
})

test("withdrawal_restart_and_reappearance_keep_identity_and_advance_revision", async () => {
  const w = await world()
  const a = w.clone("a")
  const first = await publish(a)
  assert.equal(first.state, "acknowledged")
  // Invalidation keeps the last valid review as stale context: a failed or changed review never becomes empty success.
  const prior = remoteJson(w.origin, paths.annotation).review
  // The invalidation records the refresh's own reason; one an invalidation cannot have, or a reason on another operation, is refused.
  assert.equal((await publish(a, { operation: "invalidate", review: null, reason: "card_removed" })).state, "policy_refused")
  assert.equal((await publish(a, { reason: "claim_changed" })).state, "policy_refused")
  const invalidated = await publish(a, { operation: "invalidate", review: null, reason: "claim_changed" })
  assert.equal(invalidated.state, "acknowledged")
  assert.equal(invalidated.revision, 2)
  const staleAnnotation = remoteJson(w.origin, paths.annotation)
  assert.deepEqual(staleAnnotation.review, prior)
  assert.deepEqual(staleAnnotation.attempt.state, "stale")
  assert.equal(staleAnnotation.attempt.reason, "claim_changed")
  assert.equal((await publish(a, { operation: "invalidate", review: null })).state, "adopted", "already stale on this basis")
  assert.equal((await publish(a, { review: null })).state, "policy_refused", "a refused review is never published")
  assert.equal(remoteJson(w.origin, paths.annotation).revision, 2)

  await remoteChange(w, "remove", (root) => fs.unlink(path.join(root, triagePaths(root, "", KEY).card)))
  git(a.deskRoot, ["pull", "-q"])
  const gone = await basisFor(a)
  assert.equal(gone.canonical_revision, null)
  assert.equal((await publish(a, { expectedBasis: gone })).state, "policy_refused", "a review needs its card")
  const withdrawn = await publish(a, { operation: "withdraw", review: null, expectedBasis: gone })
  assert.equal(withdrawn.state, "acknowledged")
  assert.equal(withdrawn.id, first.id)
  assert.equal(withdrawn.revision, 3)
  assert.equal(remoteJson(w.origin, paths.annotation).review, null)
  assert.deepEqual(remoteJson(w.origin, paths.registry).entries.map((entry) => entry.id), [first.id], "identity is retained after removal")
  assert.equal((await publish(a, { operation: "withdraw", review: null, expectedBasis: gone })).state, "adopted")
  assert.equal((await publish(a, { operation: "invalidate", review: null, expectedBasis: { ...gone, canonical_revision: "a".repeat(40) } })).state, "stale_basis")

  // The card reappears: same ID, a higher revision, and a fresh review is required.
  await openImprovement({ deskRoot: a.deskRoot, personPrefix: "", key: KEY, source: "andon", evidence: [`issue:${KEY.slice(6)}`], plugin: "desk", signal: null, now: T0 + HOUR })
  commitAll(a.deskRoot, "reopen")
  git(a.deskRoot, ["pull", "-q", "--rebase"])
  git(a.deskRoot, ["push", "-q"])
  const refreshed = await refreshTriage({ env: a.env, deskRoot: a.deskRoot, personPrefix: "", now: T0 + HOUR })
  assert.equal(refreshed.changes.length, 0, "a withdrawn annotation is not live and is not rewritten")
  const back = await publish(a, { expectedBasis: await basisFor(a), review: { ...AGENT, protected_result: hex(16) } })
  assert.equal(back.state, "acknowledged")
  assert.equal(back.id, first.id)
  assert.equal(back.revision, 4)

  // Nothing to invalidate or withdraw for a card that never had an annotation.
  const other = await basisFor(a, { key: fixture.related_key })
  assert.equal((await publish(a, { key: fixture.related_key, expectedBasis: other, operation: "invalidate", review: null })).state, "policy_refused")
  // The mechanical refresh sees the acknowledged review as fresh on this host.
  const fresh = await refreshTriage({ env: a.env, deskRoot: a.deskRoot, personPrefix: "", now: T0 + HOUR, evidence: { resolve: resolveIssue } })
  assert.equal(fresh.coverage.reviewed, 1)
})

test("valid_private_result_never_enters_git_review", async () => {
  const w = await world()
  const a = w.clone("a")
  const basis = await basisFor(a)
  const safe = toSafeTriageReview({ result: fixture.private_candidate.result, basis, authorizedEvidence: fixture.private_candidate.authorized_evidence, protectedToken: hex(16), briefKeys: [KEY, fixture.related_key] })
  assert.equal(safe.state, "safe")
  // A candidate is never accepted as a review.
  assert.equal((await publish(a, { review: fixture.private_candidate.result })).state, "policy_refused")
  const result = await publish(a, { review: safe.review, expectedBasis: basis })
  assert.equal(result.state, "acknowledged")
  // Every committed blob, staged and pushed, holds only safe codes and tokens.
  const commit = result.ack.commit
  const diff = git(w.origin, ["show", "--format=", "--patch", commit])
  for (const sentinel of fixture.private_candidate.sentinels) assert.equal(diff.includes(sentinel), false, sentinel)
  assert.equal(diff.includes(basis.fingerprint), false, "the private basis digest stays out of Git")
  assert.equal(diff.includes("private-repo"), false)
  assert.equal(validateTriageAnnotation(remoteText(w.origin, paths.annotation).stdout).ok, true)
  assert.deepEqual(git(w.origin, ["show", "--name-only", "--format=", commit]).split("\n").sort(), [paths.annotation, paths.registry].sort())
})

test("chained_commit_policy_refusal_prevents_ack", async () => {
  const w = await world()
  const a = w.clone("a")
  const log = path.join(w.base, "hook.log")
  await writeHook(a, `echo "$(git rev-parse --show-toplevel)|$DESK_TOOL_COMMIT|$DESK_CARD_GUARD_RUNNING" >> "${slash(log)}"\nif git diff --cached | grep -q human_decision; then echo refused >&2; exit 1; fi\nexit 0`)
  const guard = installCardGuard(a.deskRoot)
  assert.equal(guard.chained, true, JSON.stringify(guard))
  const refused = await publish(a)
  assert.equal(refused.state, "policy_refused")
  assert.equal(remoteJson(w.origin, paths.registry), null, "no push")
  assert.ok(refused.resources.filter((r) => r.kind === "worktree").every((r) => r.disposition === "removed"))
  const accepted = await publish(a, { review: { ...AGENT, protected_result: hex(16) } })
  assert.equal(accepted.state, "acknowledged")
  const lines = (await fs.readFile(log, "utf8")).trim().split("\n")
  assert.equal(lines.length, 2, "the chained policy ran for both candidates")
  for (const line of lines) {
    const [top, tool, running] = line.split("|")
    assert.match(slash(top), /\/triage\/ops\/[0-9a-f]{32}\/wt$/u, "the hook ran in the candidate worktree, not the live checkout")
    assert.equal(tool, "1")
    assert.equal(running, "1", "Desk's own guard ran first and chained the policy")
  }
})

test("policy_reads_candidate_tree_not_live_head", async () => {
  const w = await world()
  const a = w.clone("a")
  await writeHook(a, `if [ -e "$(git rev-parse --show-toplevel)/poison.txt" ]; then exit 1; fi\nexit 0`)
  await fs.writeFile(path.join(a.deskRoot, "poison.txt"), "only in the live checkout\n")
  assert.equal((await publish(a)).state, "acknowledged")
})

test("policy_timeout_holds_without_bypass", async () => {
  const w = await world()
  const a = w.clone("a")
  const pidFile = path.join(w.base, "hook.pid")
  await writeHook(a, `"${slash(process.execPath)}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)" "${slash(pidFile)}"`)
  const result = await publish(a, { git: { timeoutMs: 3000 } })
  assert.equal(result.state, "policy_unknown")
  assert.equal(remoteJson(w.origin, paths.registry), null, "no push, no acknowledgement")
  const pid = Number(await fs.readFile(pidFile, "utf8"))
  let alive = true
  for (let tries = 0; tries < 50 && alive; tries += 1) {
    try {
      process.kill(pid, 0)
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch {
      alive = false
    }
  }
  assert.equal(alive, false, "the hung hook's process was ended with its group (its process tree on Windows)")
  assert.ok(result.resources.filter((r) => r.kind === "worktree").every((r) => r.disposition === "removed"), "only own staged files: removed")
})

test("changed_disabled_or_unreadable_policy_holds", async () => {
  const w = await world()
  const a = w.clone("a")
  const hook = await writeHook(a, `echo "# touched" >> "$0"\nexit 0`)
  assert.equal((await publish(a)).state, "policy_unknown", "the hook changed itself during the commit")
  await writeHook(a, "echo extra > extra.txt\ngit add extra.txt\nexit 0")
  assert.equal((await publish(a)).state, "policy_unknown", "an extra committed path")
  await writeHook(a, "echo left > leftover.txt\nexit 0")
  const left = await publish(a)
  assert.equal(left.state, "policy_unknown", "a file the hook left behind")
  const retained = left.resources.find((r) => r.kind === "worktree")
  assert.equal(retained.disposition, "retained", "the call that made it keeps what the hook left")
  // A file a hook left is never deleted: the worktree is kept, and every later call is busy with the stable alarm code.
  await fs.writeFile(hook, "#!/bin/sh\nexit 0\n")
  const blocked = await publish(a)
  assert.equal(blocked.state, "busy", "an unrecovered resource blocks new ones")
  assert.equal(blocked.alarm, RESOURCE_ALARM)
  assert.equal(blocked.resources[0].path, retained.path)
  assert.equal(blocked.resources[0].disposition, "retained")
  assert.equal(await fs.readFile(path.join(retained.path, "leftover.txt"), "utf8"), "left\n", "the hook's file survives recovery")
  assert.equal((await publish(a)).alarm, RESOURCE_ALARM, "still raised on the next call")
  // Once the leftover is dealt with, the next call recovers the worktree by itself.
  await fs.unlink(path.join(retained.path, "leftover.txt"))
  const recovered = await publish(a)
  assert.equal(recovered.state, "acknowledged", JSON.stringify(recovered))
  assert.equal(recovered.alarm, undefined)
  assert.equal(recovered.resources[0].disposition, "removed")

  git(a.deskRoot, ["config", "core.hooksPath", "/dev/null"])
  assert.equal((await publish(a, { review: { ...AGENT, protected_result: hex(16) } })).state, "policy_refused", "hooks turned off")
  git(a.deskRoot, ["config", "core.hooksPath", path.join(a.deskRoot, "README.md")])
  assert.equal((await publish(a, { review: { ...AGENT, protected_result: hex(16) } })).state, "policy_unknown", "a hooks folder that cannot be read")
  const hooks = path.join(w.base, "hooks")
  await fs.mkdir(path.join(hooks, "sub"), { recursive: true })
  // Links need privileges on Windows; a folder is enough there.
  if (posix) await fs.symlink("/nonexistent", path.join(hooks, "linked"))
  git(a.deskRoot, ["config", "core.hooksPath", hooks])
  assert.equal((await publish(a, { review: { ...AGENT, protected_result: hex(16) } })).state, "acknowledged", "links and folders in the hooks folder are fingerprinted, not run")
  if (posix && process.getuid?.() !== 0) {
    await fs.writeFile(path.join(hooks, "secret"), "x", { mode: 0o000 })
    assert.equal((await publish(a, { review: { ...HUMAN, gate: "voice", summary_codes: ["source:andon", "route:human_decision", "gate:voice"], protected_result: hex(16) } })).state, "policy_unknown", "a hook file that cannot be read")
    await fs.chmod(path.join(hooks, "secret"), 0o600)
  }
  git(a.deskRoot, ["config", "core.hooksPath", path.join(w.base, "no-hooks-here")])
  assert.equal((await publish(a, { review: { ...HUMAN, gate: "account", summary_codes: ["source:andon", "route:human_decision", "gate:account"], protected_result: hex(16) } })).state, "acknowledged", "an absent hooks folder is an empty policy")
})

test("unsafe_inputs_and_environment_are_refused_before_git", async () => {
  const w = await world()
  const a = w.clone("a")
  const basis = await basisFor(a)
  const cases = [
    [{ operation: "approve" }, "policy_refused"],
    [{ store: "not a store" }, "unsafe_path"],
    [{ deskRoot: "relative/desk" }, "unsafe_path"],
    [{ key: "not a key" }, "unsafe_path"],
    [{ personPrefix: "../escape" }, "unsafe_path"],
    [{ review: { ...HUMAN, decision: "private" } }, "policy_refused"],
    [{ operation: "invalidate", review: HUMAN }, "policy_refused"],
    [{ now: "not a time" }, "policy_refused"],
    [{ expectedBasis: { ...basis, key: fixture.related_key } }, "policy_refused"],
    [{ expectedBasis: { ...basis, rulings: [{ id: "../x", revision: "a".repeat(40) }] } }, "policy_refused"],
    [{ expectedBasis: { ...basis, claim: { state: "maybe" } } }, "policy_refused"],
    [{ expectedBasis: { ...basis, canonical_revision: "HEAD" } }, "policy_refused"],
    [{ expectedBasis: null }, "policy_refused"],
    [{ operation: "withdraw", review: null }, "policy_refused"],
    [{ env: { ...a.env, DESK_CARD_GUARD_RUNNING: "1" } }, "policy_refused"],
    [{ env: { ...a.env, GIT_DIR: path.join(a.deskRoot, ".git") } }, "policy_refused"],
    [{ env: { ...a.env, GIT_CONFIG_PARAMETERS: "'core.hookspath'='/dev/null'" } }, "policy_refused"],
  ]
  for (const [overrides, state] of cases) assert.equal((await publish(a, { expectedBasis: basis, ...overrides })).state, state, JSON.stringify(overrides))
  assert.equal((await publish(a, { expectedBasis: basis, review: undefined, operation: "invalidate" })).state, "policy_refused", "nothing to invalidate yet")
  assert.equal((await publish(a, { expectedBasis: { ...(await basisFor(a)), public_evidence_revisions: [{ kind: "issue", ref: "not a pointer", revision: 1 }] } })).state, "policy_refused", "an unsafe public pointer never reaches the annotation")
  assert.equal(remoteJson(w.origin, paths.registry), null)
})

test("non_git_unsynchronized_busy_and_failed_git_calls_hold", async () => {
  const w = await world()
  const a = w.clone("a")
  const basis = await basisFor(a)
  const plain = await mkTempRoot("triage-plain-")
  assert.equal((await publish({ ...a, deskRoot: plain }, { expectedBasis: basis })).state, "not_git")
  const nested = path.join(a.deskRoot, "notes")
  await fs.mkdir(nested)
  assert.equal((await publish({ ...a, deskRoot: nested }, { expectedBasis: basis })).state, "not_git", "a folder inside the desk is not the desk")
  assert.equal((await publish(a, { git: { spawn: () => { throw new Error("no git") } } })).state, "not_git")
  assert.equal((await publish(a, { git: { spawn: (command, args, options) => spawn(`${command}-definitely-missing`, args, options) } })).state, "not_git")

  git(a.deskRoot, ["branch", "--unset-upstream"])
  assert.equal((await publish(a)).state, "unsynchronized")
  git(a.deskRoot, ["branch", "--set-upstream-to=origin/main"])
  await fs.writeFile(path.join(a.deskRoot, ".git", "MERGE_HEAD"), `${git(a.deskRoot, ["rev-parse", "HEAD"])}\n`)
  assert.equal((await publish(a)).state, "unsynchronized", "a merge in progress")
  await fs.unlink(path.join(a.deskRoot, ".git", "MERGE_HEAD"))

  const lock = await acquireSyncLock({ root: a.deskRoot, env: a.env })
  try {
    assert.deepEqual(await publish(a), { state: "busy", resources: [] }, "a held lock is transient: no alarm")
  } finally {
    lock.release()
  }
  await fs.rename(w.origin, `${w.origin}.away`)
  assert.equal((await publish(a)).state, "unsynchronized", "no fetch")
  await fs.rename(`${w.origin}.away`, w.origin)

  const fails = async (match, state, replacement) => assert.equal((await publish(a, { review: { ...AGENT, protected_result: hex(16) }, git: { spawn: failing(match, replacement) } })).state, state, String(match))
  await fails((args) => args[0] === "rev-parse" && args[1] === "refs/remotes/origin/main", "unsynchronized")
  await fails((args) => args[0] === "status" && args.includes("--"), "unsynchronized")
  await fails((args) => args[0] === "worktree" && args[1] === "add", "write_failed")
  await fails((args) => args[0] === "add", "write_failed")
  await fails((args) => args[0] === "diff" && args[1] === "--cached", "policy_refused")
  await fails((args) => args[0] === "config" && args[1] === "--get-all", "policy_unknown")
  await fails((args) => args[0] === "rev-parse" && args[1] === "--git-path", "policy_unknown")
  await fails((args) => args[0] === "diff-tree", "policy_unknown")
  await fails((args) => args[0] === "status" && args.includes("--ignored") && !args.includes("--"), "policy_unknown")
  await fails((args) => args[0] === "push", "unacknowledged")
  const hung = (command, args, options) => (args[2] === "push" ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], options) : spawn(command, args, options))
  assert.equal((await publish(a, { review: { ...AGENT, protected_result: hex(16) }, git: { spawn: hung, timeoutMs: 4000 } })).state, "unacknowledged", "a push with an unknown outcome is not retried as if refused")
  // A clean worktree whose removal fails is retained and blocks the next call until it can be removed.
  const retained = await publish(a, { review: { ...AGENT, protected_result: hex(16) }, git: { spawn: failing((args) => args[0] === "worktree" && args[1] === "remove") } })
  assert.equal(retained.state, "acknowledged")
  assert.equal(retained.resources.find((r) => r.kind === "worktree").disposition, "retained")
  // While its removal keeps failing, every call is busy with the stable alarm code a loop raises.
  const stuck = await publish(a, { review: { ...HUMAN, protected_result: hex(16) }, git: { spawn: failing((args) => args[0] === "worktree" && args[1] === "remove") } })
  assert.equal(stuck.state, "busy")
  assert.equal(stuck.alarm, RESOURCE_ALARM)
  assert.equal(stuck.resources[0].disposition, "retained")
  const next = await publish(a, { review: { ...HUMAN, protected_result: hex(16) } })
  assert.equal(next.state, "acknowledged")
  assert.equal(next.resources[0].disposition, "removed", "recovered first")
})

test("foreign_or_vanished_operation_records", async () => {
  const w = await world()
  const a = w.clone("a")
  const crashed = await publish(a, { git: { onStep: (name) => { if (name === "pushed") throw new Error("killed") } } })
  const record = crashed.resources.find((r) => r.kind === "worktree")
  // The worktree vanished (someone removed the folder): the record and branch are still cleaned up.
  git(a.deskRoot, ["worktree", "remove", "--force", record.path])
  const after = await publish(a)
  assert.equal(after.state, "adopted")
  assert.equal(git(a.deskRoot, ["branch", "--list", "desk-triage/*"]), "", "the owned branch is gone")
  // A record this writer does not own is never touched and blocks new resources.
  const ops = path.dirname(path.dirname(record.path))
  await fs.writeFile(path.join(ops, `${"f".repeat(32)}.json`), `${JSON.stringify({ schema: "something-else" })}\n`)
  await fs.writeFile(path.join(ops, "README"), "not a record\n")
  const blocked = await publish(a)
  assert.equal(blocked.state, "busy")
  assert.equal(blocked.alarm, RESOURCE_ALARM)
  assert.equal(blocked.resources[0].ref, null)
  await fs.writeFile(path.join(ops, `${"f".repeat(32)}.json`), "{not json")
  assert.equal((await publish(a)).state, "busy")
})

test("windows_platform_paths_use_tree_kill_and_acl_protection", async (t) => {
  const w = await world()
  const a = w.clone("a")
  const systemRoot = path.join(w.base, "fake-system-root")
  await fs.mkdir(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"), { recursive: true })
  await fs.writeFile(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "stand-in; the runner is injected")
  const protectedPaths = []
  const aclRunner = async ({ payload }) => {
    const request = JSON.parse(payload)
    protectedPaths.push(...request.paths.map((entry) => entry.path))
    return {
      code: 0, stderr: "",
      stdout: JSON.stringify({ status: "ok", results: request.paths.map((entry) => ({ ...entry, owner_sid: "S-1-5-21-1-2-3-1001", owner_reassigned: false, protected: true, rule_count: 1 })) }),
    }
  }
  const env = { ...a.env, SystemRoot: systemRoot }
  const file = await writeProtectedTriageFile(env, ["basis", "x.json"], "{}\n", { platform: "win32", runner: aclRunner })
  assert.ok(protectedPaths.includes(file))
  const result = await publish({ ...a, env }, { git: { platform: "win32", aclRunner } })
  assert.equal(result.state, "acknowledged", JSON.stringify(result))
  for (const platform of ["linux", "win32"]) {
    let committed = false
    let candidateDot
    let linked = 0
    const before = git(w.origin, ["rev-parse", "main"])
    const realSymlink = fs.symlink.bind(fs)
    // Simulate an ordinary Windows provider, without Developer Mode, on every host.
    const windowsLink = async (target, file, type) => {
      if (type !== "junction") throw Object.assign(new Error("unprivileged directory symlink denied"), { code: "EPERM" })
      assert.equal(path.isAbsolute(target), true)
      return realSymlink(target, file, process.platform === "win32" ? "junction" : "dir")
    }
    let privateResult
    try {
      privateResult = await publish({ ...a, env: { ...env, DESK: a.deskRoot, DESK_ISOLATED_HOSTED: "1", DESK_PRIVATE_HOOKS_DIR: PRIVATE_HOOKS } }, {
        review: platform === "linux" ? { ...AGENT, protected_result: hex(16) } : { ...HUMAN, gate: "spend", summary_codes: ["source:andon", "route:human_decision", "gate:spend"], protected_result: hex(16) },
        git: { platform, aclRunner, onStep: async (name) => {
          if (name !== "before_commit") return
          const [token] = await fs.readdir(path.join(a.deskRoot, ".git/desk-triage"))
          candidateDot = path.join(a.deskRoot, ".git/desk-triage", token, "wt/.git")
          t.mock.method(fs, "symlink", async (target, file, type) => {
            if (file !== candidateDot) return realSymlink(target, file, type)
            assert.equal(type, platform === "linux" ? "dir" : "junction")
            assert.equal(path.isAbsolute(target), platform === "win32")
            linked += 1
            return windowsLink(path.resolve(path.dirname(file), target), file, "junction")
          })
        }, spawn(command, args, options) {
          if (args[0] === "commit") {
            committed = true
            assert.equal(options.env.DESK_PRIVATE_HOOK_RUNNER, platform === "linux" ? "/bin/sh" : process.execPath)
            assert.equal(options.env.DESK_PRIVATE_HOOK_DISPATCH, path.join(PRIVATE_HOOKS, platform === "linux" ? "dispatch.sh" : "dispatch.cjs"))
          }
          assert.ok(!args.some((arg) => arg.includes(a.deskRoot)))
          return spawn(command, args, options)
        } },
      })
    } finally {
      t.mock.restoreAll()
    }
    assert.equal(privateResult.state, "acknowledged", `${platform}: ${JSON.stringify(privateResult)}`)
    assert.equal(committed, true, "platform transport performs a real commit, not adoption")
    assert.equal(linked, 1, "only the exact candidate metadata uses the host-safe provider")
    assert.notEqual(git(w.origin, ["rev-parse", "main"]), before, "the real commit reached the remote")
    assert.equal(remoteText(w.origin, paths.annotation).status, 0)
    assert.equal(privateResult.resources.filter((resource) => resource.kind === "worktree").length, 1)
    assert.ok(privateResult.resources.filter((resource) => resource.kind === "worktree").every((resource) => resource.disposition === "removed"))
    assert.equal(await fs.lstat(path.dirname(candidateDot)).catch((error) => error.code), "ENOENT", "the real candidate directory was removed")
  }
  // On Windows a timed-out call is ended with its process tree (taskkill /T); here the stand-in push ends by itself, so the call
  // settles either way and is never taken for a refused push.
  const slowPush = (command, args, options) => (args[2] === "push" ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], options) : spawn(command, args, options))
  const timed = await publish({ ...a, env }, { review: { ...AGENT, protected_result: hex(16) }, git: { platform: "win32", aclRunner, spawn: slowPush, timeoutMs: 1000 } })
  assert.equal(timed.state, "unacknowledged")
  assert.ok(protectedPaths.some((p) => p.endsWith(".json") && p.includes(`${path.sep}basis${path.sep}`)))
})

test("authority_is_proved_at_the_git_boundary", async () => {
  const w = await world()
  const a = w.clone("a")
  const before = await basisFor(a)
  assert.ok(before.authority.codes.includes("existing_scope"))
  const result = { ...fixture.private_candidate.result, route: "agent_ready", authority: { code: "existing_scope", ruling_ids: ["AGENTS.md"] }, decision: null, gate_reason: null, recommendation: null, safe_continuation: null }
  const toSafe = (basis) => toSafeTriageReview({ result, basis, authorizedEvidence: [], protectedToken: hex(16), briefKeys: [KEY, fixture.related_key] })
  const agentReady = toSafe(before)
  assert.equal(agentReady.state, "safe")

  // The ruling is revoked with the card bytes unchanged: the agent-ready review is refused on the fresh basis, and nothing is pushed.
  await remoteChange(w, "revoke", (root) => fs.unlink(path.join(root, "AGENTS.md")))
  git(a.deskRoot, ["pull", "-q"])
  const head = git(w.origin, ["rev-parse", "main"])
  const after = await basisFor(a)
  assert.equal(after.canonical_revision, before.canonical_revision, "same card bytes")
  assert.deepEqual(after.authority.codes, ["investigation_only", "human_gate"])
  assert.deepEqual(toSafe(after), { state: "refused", review: null, errors: [{ code: "authority_unproved", path: "" }] })
  assert.equal((await publish(a, { review: agentReady.review, expectedBasis: after })).state, "policy_refused")
  assert.equal((await publish(a, { review: agentReady.review, expectedBasis: before })).state, "stale_basis", "the basis read before the revocation no longer holds")
  assert.equal(git(w.origin, ["rev-parse", "main"]), head, "nothing was pushed")
  assert.equal(remoteJson(w.origin, paths.registry), null)

  // A basis that claims more authority than its rulings give is refused, whoever built it.
  const forged = [
    { ...after, authority: { ...after.authority, codes: ["existing_scope", ...after.authority.codes] } },
    { ...before, authority: { ...before.authority, codes: ["approved_plan", ...before.authority.codes] } },
    { ...before, authority: { ...before.authority, codes: ["approved_plan", ...before.authority.codes], plan_ids: ["plans/unread.md"] } },
    { ...before, authority: { ...before.authority, codes: ["ship_it"] } },
    { ...before, authority: null },
    { ...before, authority: { codes: before.authority.codes } },
    { ...before, evidence: [{ id: "evidence:0", pointer: "issue:x#1", revision: 0 }] },
    { ...before, evidence: null },
  ]
  // Without a live resolver only self-describing evidence resolves, so the issue-backed basis does not hold.
  assert.equal((await publishOwnedTriage({ env: a.env, deskRoot: a.deskRoot, personPrefix: "", key: KEY, store: STORE, expectedBasis: after, review: { ...HUMAN, protected_result: hex(16) }, operation: "review", now: T0 })).state, "stale_basis")
  for (const expectedBasis of forged) assert.equal((await publish(a, { review: agentReady.review, expectedBasis })).state, "policy_refused", JSON.stringify(expectedBasis.authority))
  // A human gate stays possible without a ruling.
  assert.equal((await publish(a, { expectedBasis: after })).state, "acknowledged")
})

test("unresolved_authority_never_publishes_agent_ready", async () => {
  const w = await world({ agents: false })
  const a = w.clone("a")
  const basis = await basisFor(a)
  assert.equal(basis.authority.state, "unresolved")
  assert.deepEqual(basis.authority.codes, ["investigation_only", "human_gate"])
  const result = { ...fixture.private_candidate.result, route: "agent_ready", authority: { code: "existing_scope", ruling_ids: ["AGENTS.md"] }, decision: null, gate_reason: null, recommendation: null, safe_continuation: null }
  assert.equal(toSafeTriageReview({ result, basis, authorizedEvidence: [], protectedToken: hex(16), briefKeys: [KEY] }).state, "refused")
  assert.equal((await publish(a, { review: { ...AGENT, protected_result: hex(16) }, expectedBasis: basis })).state, "policy_refused")
  assert.equal((await publish(a, { review: { ...AGENT, authority_code: "approved_plan", protected_result: hex(16) }, expectedBasis: basis })).state, "policy_refused")
  assert.equal(remoteJson(w.origin, paths.registry), null, "nothing was pushed")
})

test("crlf_checkout_keeps_the_basis_git_would_commit", async () => {
  // Cards keep their LF bytes (the card reader reads LF cards only); every other text file, AGENTS.md included, is converted.
  const w = await world({ attributes: `${path.posix.dirname(paths.card)}/*.md -text\n` })
  const a = w.clone("a", ["-c", "core.autocrlf=true"])
  assert.match(await fs.readFile(path.join(a.deskRoot, "AGENTS.md"), "utf8"), /\r\n$/u, "the checkout converted AGENTS.md to CRLF")
  const basis = await basisFor(a)
  assert.equal(basis.rulings.find((ruling) => ruling.id === "AGENTS.md").revision, git(a.deskRoot, ["rev-parse", "HEAD:AGENTS.md"]))
  assert.equal(basis.canonical_revision, git(a.deskRoot, ["rev-parse", `HEAD:${paths.card}`]))
  const result = await publish(a, { expectedBasis: basis })
  assert.equal(result.state, "acknowledged", JSON.stringify(result))
})
