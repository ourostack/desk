import "../_isolated_env.mjs"
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, writeFileSync } from "node:fs"
import * as fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import cp, { execFileSync as namedExecFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import vm from "node:vm"
import { syncBuiltinESMExports } from "node:module"
import { task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { prepareArchiveAggregate, ARCHIVE_LIMITS, archiveMarkerState } from "../../../../../plugins/desk/mcp/src/tools/archive-state.js"
import { openArchiveMoveSession } from "../../../../../plugins/desk/mcp/src/tools/archive-move.js"
import { withCreatedDirs } from "../../../../../plugins/desk/mcp/src/util/created-dirs.js"
import { parseMarkdownText, patchMarkdownFrontmatter, writeMarkdown, writeFileAtomic } from "../../../../../plugins/desk/mcp/src/util/fm.js"
const roots = []
const plans = new Set()
const initialFencedExecFileSync = cp.execFileSync
after(async () => {
  for (const plan of plans) try { await plan.close() } catch (error) {
    assert.ok(plan.receipt.descriptors.every(entry => entry.closed), `fixture FD not closed: ${error.message}`)
  }
  for (const root of roots) await fs.rm(root, { recursive: true, force: true })
})
const originalSpawn = cp.spawnSync
const originalAsyncSpawn = cp.spawn
cp.spawnSync = (command, ...args) => {
  if (command === "git") return { status: 1, stdout: "", stderr: "isolated noGit metadata seam; no subprocess" }
  throw new Error(`Native subprocess forbidden in aggregate source tests: ${command}`)
}
syncBuiltinESMExports()
cp.spawn = command => { throw new Error(`Native asynchronous process forbidden: ${command}`) }
syncBuiltinESMExports()
after(() => { cp.spawnSync = originalSpawn; cp.spawn = originalAsyncSpawn; syncBuiltinESMExports() })
const beforeTrack = "| Slug | State | Doing doc |\n| --- | --- | --- |\n| `job` | cancelled | [Doing](job/doing.md) |\n\n[Asset](job/assets/)\n"
const afterTrack = "| Slug | State | Doing doc |\n| --- | --- | --- |\n| `job` | cancelled | [Doing](_archive/job/doing.md) |\n\n[Asset](_archive/job/assets/)\n"
async function fixture(existingParent = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desk-archive-links-")))
  roots.push(root)
  const files = {
    "alpha/job/task.md": "---\nstatus: cancelled\n---\n\n[Guide](../guide.md#keep)\n",
    "alpha/job/notes.md": '[Guide](../guide.md "Title")\r\n[Self](task.md)\r\n',
    "alpha/job/doing.md": "# Doing\n",
    "alpha/job/assets/data.txt": "owned asset\n",
    "alpha/job/run.sh": "#!/bin/sh\nprintf owned\n",
    "alpha/peer/task.md": "[Job](../job/task.md)\n",
    "README.md": "[Notes](alpha/job/notes.md)\n",
    "alpha/guide.md": "# Guide\n",
    "alpha/track.md": beforeTrack,
    "foreign.txt": "foreign untracked content\n",
  }
  for (const [file, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(root, file), bytes, { mode: file.endsWith("run.sh") ? 0o755 : 0o644 })
  }
  if (existingParent) await fs.mkdir(path.join(root, "alpha/_archive"), { mode: 0o700 })
  const identities = {}
  for (const file of ["alpha/guide.md", "alpha/job/assets", "alpha/job/assets/data.txt", "foreign.txt"]) {
    const stat = await fs.lstat(path.join(root, file), { bigint: true })
    identities[file] = { dev: stat.dev, ino: stat.ino, mode: stat.mode }
  }
  const changes = []
  const invoke = extra => task_archive({ deskRoot: root, input: { track: "alpha", slug: "job" },
    search: { noteChange: file => changes.push(file) },
    env: { ...process.env, XDG_STATE_HOME: path.join(root, ".private-state") },
    spawnGit: () => { throw new Error("No Git mutation permitted") },
    schedulePush: () => { throw new Error("No push scheduled for noGit archive") }, ...extra })
  return { root, files, identities, changes, invoke, read: file => fs.readFile(path.join(root, file), "utf8") }
}
for (const existing of [false, true]) {
  test(`actual noGit handler preserves outbound intent with ${existing ? "existing" : "FIRST absent"} archive parent`, async () => {
    const f = await fixture(existing), result = await f.invoke()
    assert.equal(result.status, "archived")
    assert.equal(await f.read("alpha/_archive/job/task.md"), "---\nstatus: cancelled\n---\n\n[Guide](../../guide.md#keep)\n")
    assert.equal(await f.read("alpha/_archive/job/notes.md"), '[Guide](../../guide.md "Title")\r\n[Self](task.md)\r\n')
    assert.equal((await fs.stat(path.join(f.root, "alpha/_archive/job/run.sh"))).mode & 0o777, 0o755)
  })
}
test("actual noGit handler preserves inbound and structured-row plus directory target intent together", async () => {
  const f = await fixture()
  await f.invoke()
  assert.equal(await f.read("alpha/peer/task.md"), "[Job](../_archive/job/task.md)\n")
  assert.equal(await f.read("README.md"), "[Notes](alpha/_archive/job/notes.md)\n")
  assert.equal(await f.read("alpha/track.md"), afterTrack)
  for (const [old, before] of Object.entries(f.identities)) {
    const file = old.startsWith("alpha/job/") ? old.replace("alpha/job/", "alpha/_archive/job/") : old
    const stat = await fs.lstat(path.join(f.root, file), { bigint: true })
    assert.deepEqual({ dev: stat.dev, ino: stat.ino, mode: stat.mode }, before)
  }
  assert.equal(await f.read("foreign.txt"), "foreign untracked content\n")
  for (const file of ["alpha/job", "alpha/_archive/job", "alpha/peer/task.md", "README.md", "alpha/track.md"]) {
    assert.ok(f.changes.includes(file), `missing search invalidation ${file}`)
  }
})
async function prepare(f, options = {}) {
  const plan = await prepareArchiveAggregate({ effectiveRoot: f.root, srcDir: path.join(f.root, "alpha/job"),
    archiveDir: path.join(f.root, "alpha/_archive/job"), slug: "job", trackFile: path.join(f.root, "alpha/track.md"),
    deadline: Date.now() + 30000, evidenceDeadline: Date.now() + 40000, ...options })
  plans.add(plan); return plan
}
async function movedSession(f, dependencies = {}, options) {
  const plan = await prepare(f, options)
  const session = await openArchiveMoveSession({ source: plan.source, destination: plan.destination, aggregate: plan }, dependencies)
  await session.admit()
  await session.create(path.dirname(plan.destination), () => {})
  await session.move(() => plan.assertCurrent())
  return { plan, session }
}
for (const target of ["peer", "PR"]) {
  test(`AGI11 original close reaching D forbids subsequent ${target} evidence dispatch`, async t => {
    const f = await fixture(), file = path.join(f.root, "alpha/job/task.md")
    const before = "---\nstatus: processing\n---\n\n## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n| --- | --- | --- | --- | --- |\n" +
      (target === "peer" ? "| verify | — | — | pending | task:alpha/peer |\n" :
        "| verify | — | example/repo | pending | https://github.com/example/repo/pull/1 |\n")
    await fs.writeFile(file, before)
    const open = fs.open.bind(fs), access = fs.access.bind(fs), readFile = fs.readFile.bind(fs)
    let closed = false, evidenceCalls = 0
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
    t.mock.method(fs, "open", async (path, ...args) => {
      const handle = await open(path, ...args)
      if (path === file && !closed) {
        const close = handle.close.bind(handle)
        handle.close = async () => { await close(); closed = true; t.mock.timers.tick(30000) }
      }
      return handle
    })
    const peer = path.join(f.root, "alpha/peer/task.md")
    t.mock.method(fs, "access", (...args) => {
      if (closed && args[0] === peer) evidenceCalls++
      return access(...args)
    })
    t.mock.method(fs, "readFile", (...args) => {
      if (closed && args[0] === peer) evidenceCalls++
      return readFile(...args)
    })
    await assert.rejects(f.invoke({ input: { track: "alpha", slug: "job", evidence: { kind: "steps" } },
      fetchFn: async () => { evidenceCalls++; throw new Error("evidence fetch must not dispatch after D") } }),
    { code: "archive_deadline" })
    assert.equal(closed, true); assert.equal(evidenceCalls, 0)
    assert.equal(await readFile(file, "utf8"), before)
    await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
    await assert.rejects(fs.lstat(path.join(f.root, "alpha/_archive")), { code: "ENOENT" })
    assert.deepEqual(f.changes, [])
  })
}
for (const settlement of ["late successful", "late failed"]) {
  test(`AGI11 earlier original-read error survives ${settlement} descriptor close`, async t => {
    const f = await fixture(), file = path.join(f.root, "alpha/job/task.md"), open = fs.open.bind(fs)
    const primary = Object.freeze(new Error("first original read failed")), secondary = new Error("original close acknowledgement failed")
    let closeAttempted = false, cleanup, physicallyClosed = false
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
    t.mock.method(fs, "open", async (path, ...args) => {
      const handle = await open(path, ...args)
      if (path === file) {
        const close = handle.close.bind(handle); cleanup = close
        handle.read = async () => { throw primary }
        handle.close = async () => {
          closeAttempted = true; t.mock.timers.tick(30000)
          if (settlement === "late failed") throw secondary
          await close(); physicallyClosed = true
        }
      }
      return handle
    })
    t.after(async () => { if (cleanup && !physicallyClosed) await cleanup() })
    await assert.rejects(f.invoke(), error => error === primary)
    assert.equal(closeAttempted, true)
    await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
    await assert.rejects(fs.lstat(path.join(f.root, "alpha/_archive")), { code: "ENOENT" })
  })
}
for (const phase of ["evidence refresh", "last preflight", "self-reference helper", "inventory"]) {
  for (const replacement of ["outside symlink", "oversized file"]) {
    test(`AGI10 ${phase} rejects ${replacement} before any replacement content read`, async t => {
      const f = await fixture(), file = path.join(f.root, "alpha/job/task.md")
      const original = "---\nstatus: processing\n---\n\n## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n| --- | --- | --- | --- | --- |\n| check | — | — | pending | task:alpha/peer |\n"
      const body = phase === "self-reference helper" ? original.replace("task:alpha/peer", "task:alpha/job") : original
      await fs.writeFile(file, body)
      await fs.writeFile(path.join(f.root, "alpha/peer/task.md"), "---\nstatus: done\n---\n")
      const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desk-agi10-outside-")))
      roots.push(outside)
      const sentinel = path.join(outside, "sentinel.md")
      await fs.writeFile(sentinel, body)
      let replaced = false, replacementNameReads = 0, outsideOpens = 0, replacementFdReads = 0
      const replace = async () => {
        if (replaced) return
        await fs.unlink(file)
        if (replacement === "outside symlink") await fs.symlink(sentinel, file)
        else { await fs.writeFile(file, ""); await fs.truncate(file, 1048577) }
        replaced = true
      }
      const open = fs.open.bind(fs), readFile = fs.readFile.bind(fs)
      t.mock.method(fs, "open", async (target, ...args) => {
        if (target === sentinel) outsideOpens++
        const handle = await open(target, ...args)
        if (target === file) {
          const close = handle.close.bind(handle), read = handle.read.bind(handle), readAll = handle.readFile.bind(handle)
          const acquiredReplacement = replaced
          handle.read = (...readArgs) => {
            if (acquiredReplacement) replacementFdReads++
            return read(...readArgs)
          }
          handle.readFile = (...readArgs) => {
            if (acquiredReplacement) replacementFdReads++
            return readAll(...readArgs)
          }
          if (["last preflight", "self-reference helper"].includes(phase) && !replaced)
            handle.close = async () => { await close(); await replace() }
        }
        return handle
      })
      t.mock.method(fs, "readFile", async (target, ...args) => {
        if (replaced && (target === file || target === sentinel)) replacementNameReads++
        const bytes = await readFile(target, ...args)
        if (phase === "evidence refresh" && target === path.join(f.root, "alpha/peer/task.md")) await replace()
        return bytes
      })
      if (phase === "inventory") {
        const opendir = fs.opendir.bind(fs)
        t.mock.method(fs, "opendir", async (target, ...args) => {
          const dir = await opendir(target, ...args)
          if (target === f.root) await replace()
          return dir
        })
      }
      const input = phase === "last preflight" ? { track: "alpha", slug: "job", outcome: "cancelled" } :
        { track: "alpha", slug: "job", evidence: { kind: "steps" } }
      await assert.rejects(f.invoke({ input }), /original|card|changed|symlink|unsafe|version|bound/u)
      assert.equal(replaced, true)
      assert.equal(replacementNameReads, 0, "the name must be refused before reading replacement contents")
      assert.equal(outsideOpens, 0); assert.equal(replacementFdReads, 0)
      if (replacement === "outside symlink") {
        assert.equal((await fs.lstat(file)).isSymbolicLink(), true)
        assert.equal(await fs.readlink(file), sentinel)
      } else assert.equal((await fs.stat(file)).size, 1048577)
      assert.equal(await readFile(sentinel, "utf8"), body)
      await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
      await assert.rejects(fs.lstat(path.join(f.root, "alpha/_archive")), { code: "ENOENT" })
      assert.deepEqual(f.changes, [])
    })
  }
}
  test("AGI10 actual noGit report and terminal identity preserve local lineage without unsafe same-card reads", async t => {
    const f = await fixture(), file = path.join(f.root, "alpha/job/task.md")
    await fs.writeFile(file, "---\nstatus: cancelled\nfactory_report_unavailable: old\n---\n\nOriginal.\n")
    const asyncRead = fs.readFile.bind(fs), syncRead = fsSync.readFileSync, watched = new Set([file, path.join(f.root, "alpha/_archive/job/task.md")])
    let nameReads = 0
    t.mock.method(fs, "readFile", (target, ...args) => {
      if (watched.has(target)) nameReads++
      return asyncRead(target, ...args)
    })
    const syncMock = t.mock.method(fsSync.default, "readFileSync", (target, ...args) => {
      if (watched.has(target)) nameReads++
      return syncRead(target, ...args)
    })
    syncBuiltinESMExports()
    t.after(() => { syncMock.mock.restore(); syncBuiltinESMExports() })
    await syntheticFactoryState(f, async ({ root, env }) => {
      const result = await f.invoke({ env })
      assert.equal(result.status, "archived")
      const expected = createHash("sha256").update(`local:${f.root}\n\nalpha/job`).digest("hex").slice(0, 32)
      assert.equal(nameReads, 0)
      for (const directory of ["finalize", "evaluate-requests"]) {
        const names = await fs.readdir(path.join(root, directory))
        assert.deepEqual(names, [`${expected}.json`])
      }
      assert.ok(result.terminal_handoff.attempts.every(attempt => attempt.lineage.job === expected && attempt.lineage.root === f.root))
    }, t)
  })
  for (const card of ["", "---\nstatus: cancelled\n---\n\nSmall.\n"]) {
    test(`AGI10 ordinary ${card === "" ? "empty" : "small"} card retains safe archive behavior`, async () => {
      const f = await fixture()
      await fs.writeFile(path.join(f.root, "alpha/job/task.md"), card)
      const result = await f.invoke(card === "" ? { input: { track: "alpha", slug: "job", outcome: "cancelled" } } : {})
      assert.equal(result.status, "archived")
      if (card === "") assert.match(await f.read("alpha/_archive/job/task.md"), /status: cancelled/u)
      else assert.equal(await f.read("alpha/_archive/job/task.md"), card)
    })
  }
for (const phase of ["track plan", "inventory"]) {
  for (const edit of ["status", "repos", "steps"]) {
    test(`AGI7 original completion observation refuses ${edit} edit during ${phase}`, async t => {
      const f = await fixture()
      const original = "---\nstatus: processing\n---\n\n## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n| --- | --- | --- | --- | --- |\n| check | — | — | pending | task:alpha/peer |\n"
      await fs.writeFile(path.join(f.root, "alpha/job/task.md"), original)
      await fs.writeFile(path.join(f.root, "alpha/peer/task.md"), "---\nstatus: done\n---\n")
      await fs.mkdir(path.join(f.root, "alpha/held"))
      await fs.writeFile(path.join(f.root, "alpha/held/task.md"), "---\nstatus: processing\n---\n")
      const foreign = edit === "status" ? original.replace("status: processing", "status: paused") :
        edit === "repos" ? original.replace("status: processing", "status: processing\nrepos:\n  - https://github.com/example/changed-repo") :
          original + "| unsettled | — | — | pending | task:alpha/held |\n"
      let changed = false
      const change = async () => {
        if (!changed) { changed = true; await fs.writeFile(path.join(f.root, "alpha/job/task.md"), foreign) }
      }
      if (phase === "track plan") {
        const read = fs.readFile.bind(fs)
        t.mock.method(fs, "readFile", async (file, ...args) => {
          const bytes = await read(file, ...args)
          if (file === path.join(f.root, "alpha/track.md")) await change()
          return bytes
        })
      } else {
        const opendir = fs.opendir.bind(fs)
        t.mock.method(fs, "opendir", async (file, ...args) => {
          const dir = await opendir(file, ...args)
          if (file === f.root) await change()
          return dir
        })
      }
      await assert.rejects(f.invoke({ input: { track: "alpha", slug: "job", evidence: { kind: "steps" } } }),
        /original|card|completion|changed/u)
      assert.equal(changed, true)
      assert.equal(await f.read("alpha/job/task.md"), foreign)
      assert.equal(await f.read("alpha/track.md"), beforeTrack)
      await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
      await assert.rejects(fs.lstat(path.join(f.root, "alpha/_archive")), { code: "ENOENT" })
      assert.deepEqual(f.changes, [])
    })
  }
}
test("AGI7 same-byte new card inode is not adopted after completion preflight", async t => {
  const f = await fixture(), file = path.join(f.root, "alpha/job/task.md")
  const original = "---\nstatus: processing\n---\n\nCompleted without code.\n"
  await fs.writeFile(file, original)
  const retained = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desk-agi7-original-")))
  roots.push(retained)
  const read = fs.readFile.bind(fs)
  let changed = false, foreign
  t.mock.method(fs, "readFile", async (target, ...args) => {
    const bytes = await read(target, ...args)
    if (!changed && target === path.join(f.root, "alpha/track.md")) {
      changed = true; await fs.rename(file, path.join(retained, "original-task.md"))
      await fs.writeFile(file, original); foreign = await fs.lstat(file, { bigint: true })
    }
    return bytes
  })
  await assert.rejects(f.invoke({ input: { track: "alpha", slug: "job", outcome: "cancelled" } }), /original|card|changed/u)
  assert.equal(changed, true)
  assert.equal((await fs.lstat(file, { bigint: true })).ino, foreign.ino)
  assert.equal(await fs.readFile(file, "utf8"), original)
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
})
test("AGI7 same-byte card mode change cannot inherit the original completion observation", async t => {
  const f = await fixture(), file = path.join(f.root, "alpha/job/task.md"), read = fs.readFile.bind(fs)
  await fs.writeFile(file, "---\nstatus: processing\n---\n\nOriginal card.\n")
  let changed = false
  t.mock.method(fs, "readFile", async (target, ...args) => {
    const bytes = await read(target, ...args)
    if (!changed && target === path.join(f.root, "alpha/track.md")) { changed = true; await fs.chmod(file, 0o600) }
    return bytes
  })
  await assert.rejects(f.invoke({ input: { track: "alpha", slug: "job", outcome: "cancelled" } }), /original|card|changed/u)
  assert.equal(changed, true); assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  assert.equal(await fs.readFile(file, "utf8"), "---\nstatus: processing\n---\n\nOriginal card.\n")
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
})
test("AGI7 initial descriptor EOF edit is rejected before parsing a completion record", async t => {
  const f = await fixture(), file = path.join(f.root, "alpha/job/task.md"), open = fs.open.bind(fs)
  const before = "---\nstatus: processing\n---\n\nOriginal captured bytes.\n"
  const foreign = "---\nstatus: paused\n---\n\nChanged at original descriptor EOF.\n"
  await fs.writeFile(file, before)
  let changed = false
  t.mock.method(fs, "open", async (target, ...args) => {
    const handle = await open(target, ...args)
    if (target === file) {
      const read = handle.read.bind(handle)
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs)
        if (!changed && result.bytesRead === 0) { changed = true; await fs.writeFile(file, foreign) }
        return result
      }
    }
    return handle
  })
  await assert.rejects(f.invoke({ input: { track: "alpha", slug: "job", outcome: "cancelled" } }), /original|card|changed/u)
  assert.equal(changed, true); assert.equal(await fs.readFile(file, "utf8"), foreign)
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/_archive")), { code: "ENOENT" })
})
test("AGI7 an originally absent card cannot appear as an unvalidated processing archive", async t => {
  const f = await fixture(), file = path.join(f.root, "alpha/job/task.md")
  await fs.unlink(file)
  const foreign = "---\nstatus: processing\n---\n\nNew unvalidated card.\n", opendir = fs.opendir.bind(fs)
  let changed = false
  t.mock.method(fs, "opendir", async (target, ...args) => {
    const dir = await opendir(target, ...args)
    if (!changed && target === f.root) { changed = true; await fs.writeFile(file, foreign) }
    return dir
  })
  await assert.rejects(f.invoke(), /original|card|appeared|completion/u)
  assert.equal(changed, true); assert.equal(await fs.readFile(file, "utf8"), foreign)
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/_archive")), { code: "ENOENT" })
})
for (const failure of ["reader", "close", "expiry"]) {
  test(`AGI8 confirmed marker retirement stays known through later ${failure} uncertainty`, async t => {
    const f = await fixture()
    let now = Date.now(), removed = false, confirmed = false, unlinks = 0
    const io = { ...fs, unlink: async file => { unlinks++; await fs.unlink(file); removed = true },
      lstat: async (file, ...args) => {
        try { return await fs.lstat(file, ...args) } catch (error) {
          if (removed && file.endsWith("/.desk-archive-operation.json") && error.code === "ENOENT") confirmed = true
          throw error
        }
      } }
    const { plan, session } = await movedSession(f, { fs: io },
      { now: () => now, deadline: now + 30000, evidenceDeadline: now + 40000 })
    await session.applyFiles()
    const opendir = fs.opendir.bind(fs), primary = new Error(`post-retirement ${failure} unavailable`)
    let injected = false, cleanup, physicallyClosed = false
    t.mock.method(fs, "opendir", async (file, ...args) => {
      const dir = await opendir(file, ...args)
      if (confirmed && !injected && file === plan.destination) {
        injected = true
        const close = dir.close.bind(dir), read = dir.read.bind(dir)
        cleanup = close
        if (failure === "reader") dir.read = async () => { await read(); throw primary }
        if (failure === "close") dir.close = async () => { throw primary }
        else dir.close = async () => { await close(); physicallyClosed = true }
        if (failure === "expiry") now = plan.deadline
      }
      return dir
    })
    t.after(async () => { if (cleanup && !physicallyClosed) await cleanup() })
    await assert.rejects(session.close(), error => failure === "expiry" ? error.code === "archive_deadline" : error === primary)
    assert.equal(confirmed, true); assert.equal(injected, true); assert.equal(unlinks, 1)
    assert.equal(plan.receipt.marker.retired, true)
    assert.equal(plan.receipt.phase, "final_complete")
    assert.equal(plan.receipt.finalValidated, true)
    assert.equal(plan.sourceRow.children.has(plan.markerName), false)
    assert.equal(plan.rows.has(`${plan.sourcePrefix}/${plan.markerName}`), false)
    await assert.rejects(fs.lstat(path.join(plan.destination, plan.markerName)), { code: "ENOENT" })
    await session.close(new Error("no unlink replay"))
    assert.equal(unlinks, 1)
  })
}
test("AGI9 full Unicode-fold reference admits its outside non-Markdown target bytes before effects", async () => {
  const f = await fixture(), file = path.join(f.root, "alpha/peer/data.txt"), bytes = Buffer.from("actual outside data\n")
  await fs.writeFile(file, bytes)
  await fs.writeFile(path.join(f.root, "alpha/job/task.md"), "---\nstatus: cancelled\n---\n\n[STRASSE]\n\n[STRAẞE]: ../peer/data.txt\n")
  const plan = await prepare(f)
  try {
    const target = plan.rows.get("alpha/peer/data.txt")
    assert.ok(target.entry)
    assert.equal(target.entry.record.acquired, true); assert.equal(target.entry.closed, false)
    assert.deepEqual(target.before, bytes)
    const observed = plan.receipt.originalMap.find(row => row.path === "alpha/peer/data.txt")
    assert.equal(observed.byteCount, bytes.length); assert.match(observed.sha256, /^[a-f0-9]{64}$/u)
    assert.equal(plan.receipt.effects.length, 0)
  } finally { await plan.close() }
})
test("AGI9 folded target exceeding the actual64MiB cap refuses before marker or target read", async () => {
  const f = await fixture(), file = path.join(f.root, "alpha/peer/data.txt")
  await fs.writeFile(file, "")
  await fs.truncate(file, 67108865)
  await fs.writeFile(path.join(f.root, "alpha/job/task.md"), "---\nstatus: cancelled\n---\n\n[STRASSE]\n\n[STRAẞE]: ../peer/data.txt\n")
  await assert.rejects(f.invoke(), { code: "archive_limit" })
  assert.equal((await fs.stat(file)).size, 67108865)
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/_archive")), { code: "ENOENT" })
})
test("AGI9 actual folded outside target mutation during its EOF read rejects original admission", async t => {
  const f = await fixture(), file = path.join(f.root, "alpha/peer/data.txt")
  await fs.writeFile(file, "original outside target\n")
  await fs.writeFile(path.join(f.root, "alpha/job/task.md"), "---\nstatus: cancelled\n---\n\n[STRASSE]\n\n[STRAẞE]: ../peer/data.txt\n")
  const open = fs.open.bind(fs), foreign = "foreign target after original EOF\n"
  let changed = false
  t.mock.method(fs, "open", async (target, ...args) => {
    const handle = await open(target, ...args)
    if (target === file) {
      const read = handle.read.bind(handle)
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs)
        if (!changed && result.bytesRead === 0) { changed = true; await fs.writeFile(file, foreign) }
        return result
      }
    }
    return handle
  })
  await assert.rejects(f.invoke(), /changed|current|original/u)
  assert.equal(changed, true); assert.equal(await fs.readFile(file, "utf8"), foreign)
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
})
test("AGI9 real noGit handler preserves full-fold definition bytes and outside text target identity", async () => {
  const f = await fixture(), file = path.join(f.root, "alpha/peer/data.txt")
  await fs.writeFile(file, "original outside text\n")
  const before = await fs.lstat(file, { bigint: true })
  await fs.writeFile(path.join(f.root, "alpha/job/task.md"), "---\nstatus: cancelled\n---\n\n[STRASSE]\n\n[STRAẞE]: ../peer/data.txt\n")
  assert.equal((await f.invoke()).status, "archived")
  assert.equal(await f.read("alpha/_archive/job/task.md"), "---\nstatus: cancelled\n---\n\n[STRASSE]\n\n[STRAẞE]: ../../peer/data.txt\n")
  const after = await fs.lstat(file, { bigint: true })
  assert.deepEqual({ dev: after.dev, ino: after.ino, mode: after.mode }, { dev: before.dev, ino: before.ino, mode: before.mode })
  assert.equal(await fs.readFile(file, "utf8"), "original outside text\n")
})
for (const owner of ["inside", "outside"]) {
  for (const edit of ["bytes", "inode"]) {
    test(`AGI1 last stage read cannot overwrite original ${owner} owner ${edit}`, async () => {
      const f = await fixture(), { plan, session } = await movedSession(f)
      const row = plan.changed.find(item => item.relative.startsWith(`${plan.sourcePrefix}/`) === (owner === "inside"))
      assert.ok(row)
      const target = plan.currentPath(row), originalEntry = row.entry, originalVersion = { ...row.version }
      const originalExpected = Buffer.from(row.expectedBytes), read = plan.readBytes
      const foreign = Buffer.from("pending operator bytes must survive exactly\n")
      const retained = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desk-agi1-retained-")))
      roots.push(retained)
      let stageReads = 0, changed = false, foreignIdentity, stage
      plan.readBytes = async (entry, ...args) => {
        const bytes = await read(entry, ...args)
        if (entry.record.purpose === "archive replacement" &&
          entry.record.file.startsWith(`${target}.desk-archive-`) && ++stageReads === 2) {
          stage = entry.record.file
          if (edit === "inode") await fs.rename(target, path.join(retained, "original-owner"))
          await fs.writeFile(target, foreign, { mode: row.mode })
          foreignIdentity = await fs.lstat(target, { bigint: true }); changed = true
        }
        return bytes
      }
      try {
        await assert.rejects(session.applyFiles(), /changed|original|admission|current/u)
        assert.equal(changed, true)
        assert.deepEqual(await fs.readFile(target), foreign)
        assert.equal((await fs.lstat(target, { bigint: true })).ino, foreignIdentity.ino)
        assert.equal(row.entry, originalEntry)
        assert.deepEqual(row.version, originalVersion)
        assert.deepEqual(row.expectedBytes, originalExpected)
        assert.equal(plan.receipt.effects.some(effect => effect.kind === "replace" && effect.file === target), false)
        assert.ok(await fs.lstat(stage))
        assert.ok(await fs.lstat(path.join(plan.destination, ".desk-archive-operation.json")))
      } finally { await session.close(new Error("AGI1 original-owner interference")) }
    })
  }
}
for (const name of [".git", "node_modules"]) {
  for (const type of ["file", "symlink", "directory"]) {
    test(`AGI3 source ${name} ${type} cannot move outside the admitted inventory`, async () => {
      const f = await fixture(), storage = path.join(f.root, "alpha/job", name)
      if (type === "directory") {
        await fs.mkdir(storage); await fs.writeFile(path.join(storage, "unqualified.txt"), "not admitted storage contents")
      } else if (type === "symlink") await fs.symlink("../guide.md", storage)
      else await fs.writeFile(storage, "unsupported excluded-name file")
      const before = await fs.lstat(storage, { bigint: true })
      await assert.rejects(f.invoke(), /excluded|storage|unsupported|symlink|unsafe/u)
      assert.equal((await fs.lstat(storage, { bigint: true })).ino, before.ino)
      assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
      await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
      await assert.rejects(fs.lstat(path.join(f.root, "alpha/_archive")), { code: "ENOENT" })
      assert.deepEqual(f.changes, [])
    })
  }
  for (const type of ["file", "symlink"]) {
    test(`AGI3 outside ${name} ${type} cannot masquerade as an excluded storage directory`, async () => {
      const f = await fixture(), storage = path.join(f.root, "alpha/peer", name)
      if (type === "symlink") await fs.symlink("../guide.md", storage)
      else await fs.writeFile(storage, "not a directory boundary")
      const before = await fs.lstat(storage, { bigint: true })
      await assert.rejects(f.invoke(), /excluded|storage|unsupported|symlink|unsafe/u)
      assert.equal((await fs.lstat(storage, { bigint: true })).ino, before.ino)
      await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
      assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
    })
  }
  test(`AGI3 outside ${name} directory boundary mode remains part of admission`, async () => {
    const f = await fixture(), storage = path.join(f.root, "alpha/peer", name)
    await fs.mkdir(storage, { mode: 0o700 })
    await fs.writeFile(path.join(storage, "opaque.txt"), "must not be inventoried as a document")
    const plan = await prepare(f), session = await openArchiveMoveSession({ aggregate: plan })
    await fs.chmod(storage, 0o500)
    try {
      await assert.rejects(session.admit(), /changed|boundary|directory|current/u)
      assert.equal(plan.receipt.effects.length, 0)
      await assert.rejects(fs.lstat(path.join(plan.source, ".desk-archive-operation.json")), { code: "ENOENT" })
    } finally { await session.close(new Error("AGI3 opaque boundary drift")); await fs.chmod(storage, 0o700) }
  })
  test(`AGI3 typed outside ${name} directory stays opaque without losing ordinary archive behavior`, async t => {
    const f = await fixture(), storage = path.join(f.root, "alpha/peer", name), readdir = fs.readdir.bind(fs)
    const opendir = fs.opendir.bind(fs)
    await fs.mkdir(storage, { mode: 0o700 }); await fs.writeFile(path.join(storage, "opaque.md"), "not Markdown input: [bad](missing)")
    const before = await fs.lstat(storage, { bigint: true })
    const enters = file => file === storage || String(file).startsWith(`${storage}${path.sep}`)
    t.mock.method(fs, "readdir", (file, ...args) => {
      assert.equal(enters(file), false, "excluded storage may not be traversed")
      return readdir(file, ...args)
    })
    t.mock.method(fs, "opendir", (file, ...args) => {
      assert.equal(enters(file), false, "excluded storage may not be traversed")
      return opendir(file, ...args)
    })
    assert.equal((await f.invoke()).status, "archived")
    const after = await fs.lstat(storage, { bigint: true })
    assert.deepEqual({ ino: after.ino, mode: after.mode }, { ino: before.ino, mode: before.mode })
    assert.equal(await fs.readFile(path.join(storage, "opaque.md"), "utf8"), "not Markdown input: [bad](missing)")
  })
}
test("AGI4 actual root-directory link retains its target after a real noGit archive", async () => {
  const f = await fixture(), root = await fs.lstat(f.root, { bigint: true })
  await fs.writeFile(path.join(f.root, "alpha/job/task.md"), "---\nstatus: cancelled\n---\n\n[Root](../../)\n")
  const result = await f.invoke()
  assert.equal(result.status, "archived")
  assert.equal(await f.read("alpha/_archive/job/task.md"), "---\nstatus: cancelled\n---\n\n[Root](../../../)\n")
  const after = await fs.lstat(f.root, { bigint: true })
  assert.deepEqual({ dev: after.dev, ino: after.ino, mode: after.mode }, { dev: root.dev, ino: root.ino, mode: root.mode })
})
test("AGI4 root-directory support cannot admit an outside-root link", async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.root, "alpha/job/task.md"), "---\nstatus: cancelled\n---\n\n[Outside](../../../)\n")
  await assert.rejects(f.invoke(), /scope|outside|leaves/u)
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
  assert.ok(await fs.lstat(path.join(f.root, "alpha/job")))
})
async function entryLimitFixture(extra = 0, split = false) {
  const f = await fixture(), directories = [path.join(f.root, "zz-agi5-pool-a")]
  if (split) directories.push(path.join(f.root, "zz-agi5-pool-b"))
  for (const directory of directories) await fs.mkdir(directory)
  // The hand-authored fixture has ten files and five directories, including its root.
  const total = 4096 - 15 - directories.length + extra
  for (let start = 0; start < total; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, total - start) }, (_, offset) => {
      const index = start + offset
      return fs.writeFile(path.join(directories[index % directories.length], `agi5-entry-${String(index).padStart(4, "0")}`), "")
    }))
  }
  return { ...f, directories, entriesInPools: total }
}
function observeAggregateReaders(t, forbiddenWholeDirectoryReads = []) {
  const opendir = fs.opendir.bind(fs), readdir = fs.readdir.bind(fs), records = []
  t.mock.method(fs, "readdir", (file, ...args) => {
    assert.equal(forbiddenWholeDirectoryReads.includes(file), false, "AGI5 cannot materialize the whole directory before its limit")
    return readdir(file, ...args)
  })
  t.mock.method(fs, "opendir", async (file, options) => {
    assert.equal(options?.bufferSize, 1, "internal directory buffering must also be explicitly bounded")
    const dir = await opendir(file, options), read = dir.read.bind(dir), close = dir.close.bind(dir)
    const record = { file, reads: 0, entries: 0, closeCalls: 0, closed: false, cleanup: close }
    records.push(record)
    dir.read = async () => {
      record.reads++
      const entry = await read()
      if (entry !== null) record.entries++
      return entry
    }
    dir.close = async () => {
      record.closeCalls++
      await close(); record.closed = true
    }
    return dir
  })
  t.after(async () => { for (const record of records) if (!record.closed) await record.cleanup() })
  return records
}
test("AGI5 configured 4096-entry inventory succeeds through bounded readers with exact closure", async t => {
  const f = await entryLimitFixture(), readers = observeAggregateReaders(t, f.directories)
  const plan = await prepare(f)
  try {
    assert.equal(plan.rows.size, 4096)
    const poolReaders = readers.filter(reader => f.directories.includes(reader.file))
    assert.ok(poolReaders.length > 0)
    assert.ok(poolReaders.every(reader => reader.entries === 4080 && reader.closed && reader.closeCalls === 1))
    await plan.assertCurrent()
    assert.ok(readers.every(reader => reader.closed && reader.closeCalls === 1))
    assert.equal(plan.receipt.effects.length, 0)
  } finally { await plan.close() }
})
for (const split of [false, true]) {
  test(`AGI5 actual cap plus one across ${split ? "two directories" : "one directory"} refuses before effects`, async t => {
    const f = await entryLimitFixture(1, split), readers = observeAggregateReaders(t, f.directories)
    await assert.rejects(prepare(f), { code: "archive_limit" })
    assert.ok(readers.some(reader => f.directories.includes(reader.file)))
    assert.ok(readers.every(reader => reader.closed && reader.closeCalls === 1))
    await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
    await assert.rejects(fs.lstat(path.join(f.root, "alpha/_archive")), { code: "ENOENT" })
    assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
  })
}
test("AGI5 cap plus one is rejected before retaining or sorting the extra directory member", async t => {
  const f = await entryLimitFixture(1)
  const readers = observeAggregateReaders(t, f.directories)
  let failure
  await assert.rejects(prepare(f), error => {
    failure = error
    return error.code === "archive_limit"
  })
  const pool = failure.archiveAggregate.directoryReaders.find(reader => reader.file === f.directories[0])
  assert.equal(pool.entriesRead, 4081)
  assert.equal(pool.retained, 4080)
  assert.ok(readers.every(reader => reader.closed))
})
test("AGI5 post-admission cross-directory growth cannot begin any archive effect", async t => {
  const f = await entryLimitFixture(0, true), readers = observeAggregateReaders(t, f.directories)
  const plan = await prepare(f), session = await openArchiveMoveSession({ aggregate: plan })
  await fs.writeFile(path.join(f.directories[1], "agi5-entry-growth"), "foreign growth")
  try {
    await assert.rejects(session.admit(), /changed|member|directory|limit/u)
    assert.equal(plan.receipt.effects.length, 0)
    assert.ok(readers.every(reader => reader.closed && reader.closeCalls === 1))
    await assert.rejects(fs.lstat(path.join(plan.source, ".desk-archive-operation.json")), { code: "ENOENT" })
    assert.equal(await fs.readFile(path.join(f.directories[1], "agi5-entry-growth"), "utf8"), "foreign growth")
  } finally { await session.close(new Error("AGI5 foreign growth")) }
})
test("AGI5 a reader acquired at D is tracked and closed without a first read", async t => {
  const f = await fixture(), opendir = fs.opendir.bind(fs)
  let now = Date.now(), acquired = false, reads = 0, closed = false, cleanup
  const deadline = now + 30000
  t.mock.method(fs, "opendir", async (...args) => {
    const dir = await opendir(...args), read = dir.read.bind(dir), close = dir.close.bind(dir)
    acquired = true; cleanup = close; now = deadline
    dir.read = (...readArgs) => { reads++; return read(...readArgs) }
    dir.close = async () => { await close(); closed = true }
    return dir
  })
  t.after(async () => { if (cleanup && !closed) await cleanup() })
  await assert.rejects(prepare(f, { now: () => now, deadline, evidenceDeadline: deadline + 10000 }), { code: "archive_deadline" })
  assert.equal(acquired, true); assert.equal(reads, 0); assert.equal(closed, true)
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
})
test("AGI5 reader error after a real read retains the primary cause and closes its exact reader", async t => {
  const f = await fixture(), opendir = fs.opendir.bind(fs)
  const primary = Object.freeze(new Error("directory read outcome unavailable"))
  let acquired = false, closed = false, calls = 0, cleanup
  t.mock.method(fs, "opendir", async (...args) => {
    const dir = await opendir(...args), read = dir.read.bind(dir), close = dir.close.bind(dir)
    acquired = true; cleanup = close
    dir.read = async () => { calls++; await read(); throw primary }
    dir.close = async () => { await close(); closed = true }
    return dir
  })
  t.after(async () => { if (cleanup && !closed) await cleanup() })
  await assert.rejects(prepare(f), error => error === primary)
  assert.equal(acquired, true); assert.equal(calls, 1); assert.equal(closed, true)
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
})
for (const readFailure of [false, true]) {
  test(`AGI5 unknown reader close ${readFailure ? "preserves earlier read failure" : "cannot certify settlement"}`, async t => {
    const f = await fixture(), opendir = fs.opendir.bind(fs)
    const primary = new Error("primary directory read failed"), closing = new Error("directory close unacknowledged")
    let cleanup, closeCalls = 0
    t.mock.method(fs, "opendir", async (...args) => {
      const dir = await opendir(...args), read = dir.read.bind(dir)
      cleanup = dir.close.bind(dir)
      if (readFailure) dir.read = async () => { await read(); throw primary }
      dir.close = async () => { closeCalls++; throw closing }
      return dir
    })
    t.after(async () => { if (cleanup) await cleanup() })
    let failure
    await assert.rejects(prepare(f), error => {
      failure = error
      return error === (readFailure ? primary : closing)
    })
    assert.equal(closeCalls, 1)
    assert.equal(failure.archiveAggregate.directoryReaders[0].closeUnknown, true)
    assert.equal(failure.archiveAggregate.directoryReaders[0].closed, false)
    assert.ok(failure.archiveAggregate.descriptors.every(entry => entry.closed))
    if (readFailure) assert.equal(failure.archiveAggregate.directoryCloseFailure, closing.message)
    await assert.rejects(fs.lstat(path.join(f.root, "alpha/job/.desk-archive-operation.json")), { code: "ENOENT" })
  })
}
async function syntheticFactoryState(f, work, context) {
  const stateHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desk-agi2-state-")))
  roots.push(stateHome)
  const root = path.join(stateHome, "ouroboros-skills/desk/factory")
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const identity = fsSync.lstatSync(stateHome, { bigint: true }), saved = cp.execFileSync, acl = []
  let refusals = 0
  assert.equal(saved, initialFencedExecFileSync)
  assert.equal(namedExecFileSync, saved)
  assert.equal(saved.toString(), "() => refuse(name)", "the saved function must be the reviewed refusal, not an original native delegate")
  const output = "SYNTHETIC_ACL_NO_NATIVE_PROOF\n"
  const provenance = { qualification: "synthetic_ACL_not_native_platform_proof", root: stateHome,
    dev: String(identity.dev), ino: String(identity.ino), calls: acl, restored: false }
  const admit = target => {
    if (typeof target !== "string" || !path.isAbsolute(target) || path.normalize(target) !== target) return false
    const relative = path.relative(stateHome, target)
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return false
    const current = fsSync.lstatSync(stateHome, { bigint: true })
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino ||
      typeof process.getuid === "function" && current.uid !== BigInt(process.getuid()) ||
      fsSync.realpathSync(stateHome) !== stateHome) return false
    let cursor = stateHome
    const pieces = relative ? relative.split(path.sep) : []
    for (const [index, piece] of pieces.entries()) {
      cursor = path.join(cursor, piece)
      const stat = fsSync.lstatSync(cursor, { bigint: true })
      if (stat.isSymbolicLink() || (index < pieces.length - 1 ? !stat.isDirectory() :
        !stat.isDirectory() && !(stat.isFile() && stat.nlink === 1n))) return false
    }
    return fsSync.realpathSync(target) === target
  }
  const wrapper = (command, args, options) => {
    let accepted = false
    try {
      accepted = command === "/bin/ls" && Array.isArray(args) && args.length === 2 && args[0] === "-ldeq" &&
        options !== null && typeof options === "object" &&
        Reflect.ownKeys(options).length === 3 && ["encoding", "timeout", "maxBuffer"].every(key => Object.hasOwn(options, key)) &&
        options.encoding === "utf8" && options.timeout === 5000 && options.maxBuffer === 65536 && admit(args[1])
    } catch { accepted = false }
    if (!accepted) { refusals++; return saved(command, args, options) }
    acl.push({ command, args: [...args], options: { ...options }, root: stateHome,
      dev: String(identity.dev), ino: String(identity.ino), output, qualification: "synthetic_not_native_ACL" })
    return output
  }
  try {
    cp.execFileSync = wrapper; syncBuiltinESMExports()
    assert.equal(cp.execFileSync, wrapper); assert.equal(namedExecFileSync, wrapper)
    return await work({ root, stateHome, acl, env: { ...process.env, XDG_STATE_HOME: stateHome } })
  } finally {
    cp.execFileSync = saved; syncBuiltinESMExports()
    assert.equal(cp.execFileSync, initialFencedExecFileSync, "failed to restore the exact process refusal")
    assert.equal(namedExecFileSync, initialFencedExecFileSync, "failed to restore named process refusal coherence")
    provenance.restored = true
    context?.diagnostic(JSON.stringify(provenance))
    if (refusals) throw Object.assign(new Error("synthetic ACL boundary encountered an unadmitted process-call shape"),
      { code: "DESK_SOURCE_NATIVE_FORBIDDEN" })
  }
}
test("AGI2 preexisting marker admits no actual Factory helper or root repair", { skip: process.platform === "win32" }, async t => {
  const f = await fixture()
  await syntheticFactoryState(f, async ({ root, env, acl }) => {
    await fs.chmod(root, 0o755)
    await fs.writeFile(path.join(f.root, "alpha/job/.desk-archive-operation.json"), "")
    const result = await f.invoke({ env })
    assert.equal(result.status, "archive_pending")
    assert.equal((await fs.stat(root)).mode & 0o777, 0o755)
    assert.equal(acl.length, 0)
    assert.ok(result.terminal_handoff)
    assert.equal(result.terminal_handoff.status, "not_dispatched")
    assert.deepEqual(result.terminal_handoff.attempts, [])
  }, t)
})
test("AGI2 unmarked actual opted-in outbox keeps ordinary finalize and evaluation work", { skip: process.platform === "win32" }, async t => {
  const f = await fixture()
  await syntheticFactoryState(f, async ({ root, env, acl }) => {
    const result = await f.invoke({ env })
    assert.equal(result.status, "archived")
    let job
    for (const directory of ["finalize", "evaluate-requests"]) {
      const names = await fs.readdir(path.join(root, directory))
      assert.equal(names.length, 1)
      const request = JSON.parse(await fs.readFile(path.join(root, directory, names[0]), "utf8"))
      assert.equal(request.desk_root, f.root)
      assert.equal(request.job, names[0].replace(/\.json$/u, ""))
      job = request.job
    }
    assert.ok(result.terminal_handoff)
    assert.equal(result.terminal_handoff.status, "returned")
    assert.deepEqual(result.terminal_handoff.attempts.map(attempt => attempt.helper),
      ["factoryStateRoot.finalize", "requestFinalize", "factoryStateRoot.evaluation", "requestEvaluation"])
    assert.ok(result.terminal_handoff.attempts.every(attempt => attempt.state === "returned"))
    assert.ok(result.terminal_handoff.attempts.every(attempt =>
      attempt.lineage.root === f.root && attempt.lineage.deskRoot === f.root && attempt.lineage.job === job))
    if (process.platform === "darwin") assert.ok(acl.length > 0)
  }, t)
})
test("AGI2 marker during actual existing evaluation read retains accepted update and no later dispatch", { skip: process.platform === "win32" }, async t => {
  const f = await fixture()
  await syntheticFactoryState(f, async ({ root, env }) => {
    assert.equal((await f.invoke({ env })).status, "archived")
    const directory = path.join(root, "evaluate-requests"), names = await fs.readdir(directory)
    assert.equal(names.length, 1)
    const file = path.join(directory, names[0]), original = await fs.lstat(file, { bigint: true })
    const read = fs.readFile.bind(fs)
    let marked = false
    t.mock.method(fs, "readFile", async (target, ...args) => {
      const bytes = await read(target, ...args)
      if (!marked && target === file) {
        marked = true; await fs.writeFile(path.join(f.root, "alpha/_archive/job/.desk-archive-operation.json"), "")
      }
      return bytes
    })
    const result = await f.invoke({ env })
    assert.equal(marked, true); assert.equal(result.status, "archive_pending")
    assert.notEqual((await fs.lstat(file, { bigint: true })).ino, original.ino)
    const request = JSON.parse(await read(file, "utf8"))
    assert.equal(result.terminal_handoff.status, "unknown")
    assert.equal(result.terminal_handoff.attempts.length, 4)
    const attempt = result.terminal_handoff.attempts[3]
    assert.equal(attempt.helper, "requestEvaluation"); assert.equal(attempt.state, "returned")
    assert.deepEqual(attempt.result, request); assert.ok(attempt.postBarrier)
    t.diagnostic(JSON.stringify({ qualification: "actual_synthetic_outbox_FS_not_native_ACL", terminal: result.terminal_handoff }))
  }, t)
})
test("AGI2 failed accepted finalize preserves primary IO, internal cleanup and secondary marker separately", { skip: process.platform === "win32" }, async t => {
  const f = await fixture()
  await syntheticFactoryState(f, async ({ root, env }) => {
    const rename = fs.rename.bind(fs), rm = fs.rm.bind(fs)
    const primary = Object.freeze(Object.assign(new Error("first actual outbox rename failure"), { code: "EIO" }))
    let marked = false, cleaned = false
    t.mock.method(fs, "rename", async (from, to) => {
      if (!marked && path.dirname(to) === path.join(root, "finalize")) {
        marked = true; await fs.writeFile(path.join(f.root, "alpha/_archive/job/.desk-archive-operation.json"), "")
        throw primary
      }
      return rename(from, to)
    })
    t.mock.method(fs, "rm", async (file, ...args) => {
      const result = await rm(file, ...args)
      if (marked && path.dirname(file) === path.join(root, "finalize") && path.basename(file).startsWith(".tmp-")) cleaned = true
      return result
    })
    const result = await f.invoke({ env })
    assert.equal(result.status, "archive_pending"); assert.equal(marked, true); assert.equal(cleaned, true)
    assert.equal(result.publication.phase, "final_complete")
    assert.equal(result.publication.primary_error, primary.message)
    assert.equal(result.terminal_handoff.status, "unknown")
    assert.equal(result.terminal_handoff.attempts.length, 2)
    const attempt = result.terminal_handoff.attempts[1]
    assert.equal(attempt.state, "failed"); assert.equal(attempt.error.code, "EIO")
    assert.equal(attempt.error.message, primary.message); assert.ok(attempt.postBarrier)
    assert.deepEqual(await fs.readdir(path.join(root, "finalize")), [])
    await assert.rejects(fs.lstat(path.join(root, "evaluate-requests")), { code: "ENOENT" })
    assert.ok(await fs.lstat(path.join(f.root, "alpha/_archive/job/.desk-archive-operation.json")))
    t.diagnostic(JSON.stringify({ qualification: "actual_accepted_internal_cleanup_not_task_recall",
      cleaned, terminal: result.terminal_handoff }))
  }, t)
})
test("AGI2 accepted helper beyond original D and E is not canceled or followed by new work", { skip: process.platform === "win32" }, async t => {
  const f = await fixture()
  await syntheticFactoryState(f, async ({ root, env }) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
    const rename = fs.rename.bind(fs)
    let late = false
    t.mock.method(fs, "rename", async (from, to) => {
      const result = await rename(from, to)
      if (!late && path.dirname(to) === path.join(root, "finalize")) {
        late = true; t.mock.timers.tick(40001)
      }
      return result
    })
    const result = await f.invoke({ env })
    assert.equal(late, true); assert.equal(result.status, "archive_pending")
    assert.equal(result.publication.phase, "final_complete")
    assert.equal(result.publication.effects.marker.retired, true)
    assert.equal(result.terminal_handoff.status, "unknown")
    assert.equal(result.terminal_handoff.internalDeadlineSupported, false)
    assert.equal(result.terminal_handoff.attempts.length, 2)
    const attempt = result.terminal_handoff.attempts[1]
    assert.equal(attempt.helper, "requestFinalize"); assert.equal(attempt.state, "returned")
    assert.equal(attempt.late, true); assert.ok(attempt.settledAt >= attempt.originalDeadline + 10000)
    assert.ok(attempt.postBarrier)
    assert.equal((await fs.readdir(path.join(root, "finalize"))).length, 1)
    await assert.rejects(fs.lstat(path.join(root, "evaluate-requests")), { code: "ENOENT" })
    t.diagnostic(JSON.stringify({ qualification: "actual_outbox_FS_with_controlled_Date_not_native_lifetime_proof",
      terminal: result.terminal_handoff }))
  }, t)
})
test("AGI2 marker during accepted root preparation preserves real repair and unknown handoff", { skip: process.platform === "win32" }, async t => {
  const f = await fixture()
  await syntheticFactoryState(f, async ({ root, stateHome, env }) => {
    await fs.chmod(root, 0o755)
    const mkdir = fs.mkdir.bind(fs)
    let marked = false, notificationsAtDispatch
    t.mock.method(fs, "mkdir", async (file, ...args) => {
      const value = await mkdir(file, ...args)
      if (!marked && file === stateHome) {
        notificationsAtDispatch = f.changes.length
        marked = true; await fs.writeFile(path.join(f.root, "alpha/_archive/job/.desk-archive-operation.json"), "")
      }
      return value
    })
    const result = await f.invoke({ env })
    assert.equal(marked, true); assert.equal(result.status, "archive_pending")
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700, "accepted internal root work can repair mode after the racing marker")
    assert.equal(result.publication.phase, "final_complete")
    assert.ok(result.terminal_handoff)
    assert.equal(result.terminal_handoff.status, "unknown")
    assert.ok(notificationsAtDispatch > 0)
    assert.equal(f.changes.length, notificationsAtDispatch, "a terminal barrier must not replay already completed task notifications")
    assert.equal(result.terminal_handoff.attempts.length, 1)
    const attempt = result.terminal_handoff.attempts[0]
    assert.equal(attempt.helper, "factoryStateRoot.finalize"); assert.equal(attempt.state, "returned")
    assert.equal(attempt.result, root); assert.ok(attempt.postBarrier)
    await assert.rejects(fs.lstat(path.join(root, "finalize")), { code: "ENOENT" })
    await assert.rejects(fs.lstat(path.join(root, "evaluate-requests")), { code: "ENOENT" })
  }, t)
})
test("AGI2 marker during accepted finalize temporary write retains real request and stops next helper", { skip: process.platform === "win32" }, async t => {
  const f = await fixture()
  await syntheticFactoryState(f, async ({ root, env }) => {
    const open = fs.open.bind(fs)
    let marked = false
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await open(file, ...args)
      if (!marked && path.dirname(file) === path.join(root, "finalize") && path.basename(file).startsWith(".tmp-")) {
        marked = true; await fs.writeFile(path.join(f.root, "alpha/_archive/job/.desk-archive-operation.json"), "")
      }
      return handle
    })
    const result = await f.invoke({ env })
    assert.equal(marked, true); assert.equal(result.status, "archive_pending")
    const names = await fs.readdir(path.join(root, "finalize"))
    assert.equal(names.length, 1); assert.ok(names[0].endsWith(".json"))
    const request = JSON.parse(await fs.readFile(path.join(root, "finalize", names[0]), "utf8"))
    assert.equal(request.desk_root, f.root)
    assert.equal(result.publication.phase, "final_complete")
    assert.ok(result.terminal_handoff)
    assert.equal(result.terminal_handoff.status, "unknown")
    assert.equal(result.terminal_handoff.attempts.length, 2)
    const attempt = result.terminal_handoff.attempts[1]
    assert.equal(attempt.helper, "requestFinalize"); assert.equal(attempt.state, "returned")
    assert.deepEqual(attempt.result, request); assert.ok(attempt.postBarrier)
    await assert.rejects(fs.lstat(path.join(root, "evaluate-requests")), { code: "ENOENT" })
    assert.ok(await fs.lstat(path.join(f.root, "alpha/_archive/job/.desk-archive-operation.json")))
  }, t)
})
test("actual handler composes admitted report removal, derived state, done status and links once", async t => {
  const f = await fixture()
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T00:00:00Z") })
  const before = "---\nstatus: processing\nfactory_report_unavailable: old_reason\n---\n\n[Guide](../guide.md#keep)\n\n## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n| --- | --- | --- | --- | --- |\n| check | — | — | pending | task:alpha/peer |\n"
  await fs.writeFile(path.join(f.root, "alpha/job/task.md"), before)
  await fs.writeFile(path.join(f.root, "alpha/peer/task.md"), "---\nstatus: done\n---\n\n[Job](../job/task.md)\n")
  await fs.writeFile(path.join(f.root, "alpha/track.md"), beforeTrack.replace("| cancelled |", "| processing |"))
  const result = await f.invoke({ input: { track: "alpha", slug: "job", evidence: { kind: "steps" } } })
  assert.equal(result.status, "archived")
  const raw = await f.read("alpha/_archive/job/task.md"), { data, content } = parseMarkdownText(raw, "fixture")
  assert.equal(data.status, "done"); assert.equal(data.updated, "2026-11-02T00:00:00Z")
  assert.deepEqual(data.evidence, { kind: "steps", ref: "all 1 steps settled: 1 delivered, 0 dropped",
    recorded_at: "2026-11-02T00:00:00Z" })
  assert.equal(Object.hasOwn(data, "factory_report_unavailable"), false)
  assert.equal(content, "\n[Guide](../../guide.md#keep)\n\n## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n| --- | --- | --- | --- | --- |\n| check | — | — | delivered | task:alpha/peer |\n")
  assert.equal(await f.read("alpha/track.md"), afterTrack.replace("| cancelled |", "| done |"))
  assert.deepEqual(data.signoff, { state: "delivered_unsigned", at: null, reason: null })
  assert.deepEqual(data.flow, { since: "adopted", rev: 1, reached: "done", first_validating_at: "2026-11-02T00:00:00Z",
    first_delivered_at: "2026-11-02T00:00:00Z", delivered_at: "2026-11-02T00:00:00Z", deliveries: 1 })
})
test("real provider keeps readable writable exclusive stage fd through rename and positional full EOF", async () => {
  const f = await fixture(), { plan, session } = await movedSession(f)
  const open = plan.open, stageFDs = [], readPositions = []
  plan.open = async (file, flags, purpose, mode) => {
    const entry = await open(file, flags, purpose, mode)
    if (purpose === "archive replacement") {
      assert.equal(flags & 3, 2); assert.equal(mode, 0o600)
      const write = entry.handle.write.bind(entry.handle), read = entry.handle.read.bind(entry.handle)
      entry.handle.write = (bytes, offset, length, position) => write(bytes, offset, Math.min(7, length), position)
      entry.handle.read = (buffer, offset, length, position) => { readPositions.push(position); return read(buffer, offset, length, position) }
      stageFDs.push(entry)
    }
    return entry
  }
  await session.applyFiles()
  assert.ok(stageFDs.length > 0); assert.ok(readPositions.includes(0))
  for (const entry of stageFDs) {
    assert.equal(entry.closed, false); await entry.handle.stat()
    assert.equal(entry.record.returnedBytes, entry.record.plannedBytes)
  }
  await session.close()
  assert.equal(stageFDs.every(entry => entry.closed), true)
})
for (const timing of ["before rename", "after rename"]) {
  test(`foreign same-byte stage/installed inode ${timing} is not adopted`, async () => {
    const f = await fixture()
    let replaced = false, foreignPath
    const io = { ...fs }
    if (timing === "before rename") io.lstat = async (file, ...args) => {
      if (!replaced && file.endsWith(".tmp")) {
        replaced = true; const bytes = await fs.readFile(file)
        await fs.rename(file, `${file}.original-owned`)
        await fs.writeFile(file, bytes, { flag: "wx" }); foreignPath = file
      }
      return fs.lstat(file, ...args)
    }
    else io.rename = async (from, to) => {
      await fs.rename(from, to)
      if (!replaced && from.endsWith(".tmp")) {
        replaced = true; const bytes = await fs.readFile(to)
        await fs.rename(to, `${to}.owned-installed`)
        await fs.writeFile(to, bytes, { flag: "wx" }); foreignPath = to
      }
    }
    const { plan, session } = await movedSession(f, { fs: io })
    await assert.rejects(session.applyFiles(), /owned|stage|installed/u)
    assert.equal(replaced, true); assert.ok(await fs.readFile(foreignPath))
    assert.equal(session.retain, true)
    if (timing === "before rename") assert.equal(plan.receipt.effects.some(item => item.kind === "replace"), false)
    await session.close()
    assert.ok(await fs.lstat(foreignPath))
  })
}
test("partial returned FD bytes are captured before an expired post-write fence", async () => {
  const f = await fixture()
  let now = Date.now()
  const { plan, session } = await movedSession(f, {}, { now: () => now, deadline: now + 30000, evidenceDeadline: now + 40000 })
  const open = plan.open; let writes = 0, stage
  plan.open = async (...args) => {
    const entry = await open(...args)
    if (args[2] === "archive replacement") {
      stage = entry
      const write = entry.handle.write.bind(entry.handle)
      entry.handle.write = async (bytes, offset, length, position) => {
        writes++; const returned = await write(bytes, offset, 1, position); now = plan.deadline; return returned
      }
    }
    return entry
  }
  await assert.rejects(session.applyFiles(), { code: "archive_deadline" })
  assert.equal(writes, 1); assert.equal(stage.record.returnedBytes, 1)
  assert.equal(plan.receipt.effects.some(item => item.kind === "replace"), false)
  await session.close()
  assert.equal(stage.closed, true)
})
test("external archive-parent appearance is never joined or removed", async () => {
  const f = await fixture(), plan = await prepare(f)
  const io = { ...fs, mkdir: async file => {
    await fs.mkdir(file, { mode: 0o700 }); await fs.writeFile(path.join(file, "FOREIGN"), "not owned\n")
    throw Object.assign(new Error("appeared"), { code: "EEXIST" })
  } }
  const session = await openArchiveMoveSession({ source: plan.source, destination: plan.destination, aggregate: plan }, { fs: io })
  await session.admit()
  await assert.rejects(session.create(path.dirname(plan.destination), () => {}), { code: "EEXIST" })
  assert.equal(session.retain, true)
  await session.close()
  assert.equal(await f.read("alpha/_archive/FOREIGN"), "not owned\n")
  assert.ok(await fs.stat(path.join(f.root, "alpha/job")))
})
test("causal created-parent named inode cannot be replaced and adopted when its descriptor opens", async () => {
  const f = await fixture(), plan = await prepare(f), open = plan.open
  const retained = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desk-archive-parent-retained-")))
  roots.push(retained)
  let original, foreign, recorded = []
  plan.open = async (...args) => {
    if (args[2] === "created archive parent") {
      original = await fs.lstat(args[0], { bigint: true })
      await fs.rename(args[0], path.join(retained, "original-owned"))
      await fs.mkdir(args[0], { mode: 0o700 })
      foreign = await fs.lstat(args[0], { bigint: true })
    }
    return open(...args)
  }
  const session = await openArchiveMoveSession({ aggregate: plan })
  await session.admit()
  await assert.rejects(session.create(path.dirname(plan.destination), name => recorded.push(name)), /created parent/u)
  await session.close(new Error("created parent descriptor was replaced"))
  assert.notEqual(foreign.ino, original.ino)
  assert.deepEqual(recorded, [])
  assert.equal((await fs.lstat(path.dirname(plan.destination), { bigint: true })).ino, foreign.ino)
  assert.equal(plan.rows.has("alpha/_archive"), false)
})
test("a directory target's own changed membership refuses before moving any folder", async () => {
  const f = await fixture(), plan = await prepare(f)
  await fs.writeFile(path.join(f.root, "alpha/job/assets/FOREIGN"), "changed target\n")
  const session = await openArchiveMoveSession({ source: plan.source, destination: plan.destination, aggregate: plan })
  await assert.rejects(session.admit(), /directory/u)
  await session.close()
  assert.equal(plan.receipt.effects.length, 0)
  assert.ok(await fs.stat(path.join(f.root, "alpha/job")))
})
test("causal late descriptor settlement is recorded against the original evidence cutoff", async () => {
  const f = await fixture()
  let now = Date.now()
  const plan = await prepare(f, { now: () => now, deadline: now + 30000, evidenceDeadline: now + 40000 })
  now = plan.evidenceDeadline
  await assert.rejects(plan.close(), { code: "archive_evidence_deadline" })
  assert.equal(plan.receipt.descriptors.every(entry => entry.closed), true)
  assert.equal(plan.receipt.descriptors.some(entry => entry.closedAt >= plan.evidenceDeadline && entry.lateClose), true)
})
test("causal original and final maps retain immutable pre-effect hashes/modes/referent lineage", async () => {
  const f = await fixture(), { plan, session } = await movedSession(f)
  const before = plan.receipt.originalMap.find(row => row.path === "alpha/job/task.md")
  const after = plan.receipt.finalMap.find(row => row.beforePath === "alpha/job/task.md")
  assert.equal(before.byteCount, Buffer.byteLength(f.files["alpha/job/task.md"]))
  assert.equal(after.afterPath, "alpha/_archive/job/task.md")
  const originalHash = before.sha256, expectedFinalHash = after.sha256
  assert.notEqual(expectedFinalHash, originalHash)
  await session.applyFiles(); await session.close()
  assert.equal(before.sha256, originalHash); assert.equal(after.sha256, expectedFinalHash)
  assert.ok(plan.receipt.links.some(row => row.oldTarget === "alpha/guide.md"))
})
test("complete independently authored Final bytes and modes match the real provider with no extra files", async t => {
  const f = await fixture(), { plan, session } = await movedSession(f)
  const expected = {
    "alpha/_archive/job/task.md": "---\nstatus: cancelled\n---\n\n[Guide](../../guide.md#keep)\n",
    "alpha/_archive/job/notes.md": '[Guide](../../guide.md "Title")\r\n[Self](task.md)\r\n',
    "alpha/_archive/job/doing.md": "# Doing\n",
    "alpha/_archive/job/assets/data.txt": "owned asset\n",
    "alpha/_archive/job/run.sh": "#!/bin/sh\nprintf owned\n",
    "alpha/peer/task.md": "[Job](../_archive/job/task.md)\n",
    "README.md": "[Notes](alpha/_archive/job/notes.md)\n",
    "alpha/guide.md": "# Guide\n",
    "alpha/track.md": afterTrack,
    "foreign.txt": "foreign untracked content\n",
  }
  const originalMap = JSON.stringify(plan.receipt.originalMap)
  await session.applyFiles(); await session.close()
  const files = []
  async function visit(directory, prefix = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name, file = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(file, rel)
      else files.push(rel)
    }
  }
  await visit(f.root)
  assert.deepEqual(files.sort(), Object.keys(expected).sort())
  for (const [file, bytes] of Object.entries(expected)) {
    assert.equal(await f.read(file), bytes)
    assert.equal((await fs.stat(path.join(f.root, file))).mode & 0o777, file.endsWith("run.sh") ? 0o755 : 0o644)
  }
  assert.equal(JSON.stringify(plan.receipt.originalMap), originalMap)
  assert.equal(plan.receipt.phase, "final_complete")
  t.diagnostic(JSON.stringify({ qualification: "real_owned_noGit_provider_not_nativeGit_or_installed",
    expectedFiles: expected, receipt: plan.receipt }))
})
test("causal a new Git marker after noGit admission blocks before any archive effect", async () => {
  const f = await fixture(), plan = await prepare(f)
  await fs.mkdir(path.join(f.root, ".git"))
  const session = await openArchiveMoveSession({ source: plan.source, destination: plan.destination, aggregate: plan })
  await assert.rejects(session.admit(), { code: "archive_git_changed" })
  await session.close()
  assert.equal(plan.receipt.effects.length, 0)
  assert.ok(await fs.stat(path.join(f.root, "alpha/job")))
})
test("person-scoped handler never inventories or rewrites a sibling person's bytes", async () => {
  const f = await fixture(), wrapper = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desk-archive-person-")))
  roots.push(wrapper)
  await fs.mkdir(path.join(wrapper, "desks"), { recursive: true })
  await fs.rename(f.root, path.join(wrapper, "desks/ari"))
  await fs.mkdir(path.join(wrapper, "desks/bob"))
  const foreign = Buffer.from([255, 254, 253])
  await fs.writeFile(path.join(wrapper, "desks/bob/private.md"), foreign)
  const result = await task_archive({ deskRoot: wrapper, person: "ari", input: { track: "alpha", slug: "job" },
    env: { ...process.env, XDG_STATE_HOME: path.join(wrapper, ".state") },
    spawnGit: () => { throw new Error("No Git for own person") }, schedulePush: () => { throw new Error("No push") } })
  assert.equal(result.status, "archived")
  assert.equal(await fs.readFile(path.join(wrapper, "desks/ari/alpha/_archive/job/notes.md"), "utf8"),
    '[Guide](../../guide.md "Title")\r\n[Self](task.md)\r\n')
  assert.deepEqual(await fs.readFile(path.join(wrapper, "desks/bob/private.md")), foreign)
})
test("own document pointing outside its effective person scope refuses without reading the foreign target", async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.root, "README.md"), "[Foreign](../another-person/private.md)\n")
  await assert.rejects(f.invoke(), { code: "archive_scope" })
  assert.ok(await fs.lstat(path.join(f.root, "alpha/job")))
})
test("two row-link prefix insertions are a real positive with unrelated code and generic inbound bytes", async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.root, "alpha/job/a.md"), "# A\n")
  await fs.writeFile(path.join(f.root, "alpha/job/b.md"), "# B\n")
  const before = "| Slug | State | Doing doc |\n| --- | --- | --- |\n| `job` | cancelled | [A](job/a.md) [B](job/b.md) |\n\n`[Code](job/task.md)`\n\n[Real](job/task.md)\n\n[unused]: job/task.md\n"
  const expected = "| Slug | State | Doing doc |\n| --- | --- | --- |\n| `job` | cancelled | [A](_archive/job/a.md) [B](_archive/job/b.md) |\n\n`[Code](job/task.md)`\n\n[Real](_archive/job/task.md)\n\n[unused]: job/task.md\n"
  await fs.writeFile(path.join(f.root, "alpha/track.md"), before)
  assert.equal((await f.invoke()).status, "archived")
  assert.equal(await f.read("alpha/track.md"), expected)
})
test("overlapping created-directory callbacks retain original registry semantics and exact created names", async () => {
  const f = await fixture(), directory = path.join(f.root, "created-registry")
  let enteredA, enteredB, releaseA, releaseB, removals = 0
  const aEntered = new Promise(resolve => { enteredA = resolve }), bEntered = new Promise(resolve => { enteredB = resolve })
  const aWait = new Promise(resolve => { releaseA = resolve }), bWait = new Promise(resolve => { releaseB = resolve })
  const create = async (target, recordMade) => {
    try { await fs.mkdir(target); recordMade(target) } catch (error) { if (error.code !== "EEXIST") throw error }
  }
  const remove = async target => { removals++; await fs.rmdir(target) }
  const a = assert.rejects(withCreatedDirs(directory, async () => { enteredA(); await aWait; throw new Error("A") },
    { create, remove, shouldCleanup: () => false }), /A/)
  await aEntered
  const b = assert.rejects(withCreatedDirs(directory, async () => { enteredB(); await bWait; throw new Error("B") },
    { create, remove }), /B/)
  await bEntered; releaseA(); await a; releaseB(); await b
  assert.equal(removals, 0); assert.ok(await fs.lstat(directory))
  const next = path.join(f.root, "next-created")
  await assert.rejects(withCreatedDirs(next, async () => { throw new Error("fresh") }, { create, remove }), /fresh/)
  assert.equal(removals, 1)
  await assert.rejects(fs.lstat(next), { code: "ENOENT" })
})
for (const guarded of [false, true]) {
  test(`default created-directory ${guarded ? "successful callback" : "no-callback parity"} preserves mkdir and rollback`, async () => {
    const f = await fixture(), directory = path.join(f.root, "ordinary-created/deep")
    let admitted = !guarded
    const options = guarded ? { beforeCreate: async () => { admitted = true } } : {}
    await withCreatedDirs(directory, async () => {
      assert.equal(admitted, true); await fs.writeFile(path.join(directory, "owned"), "ordinary work")
    }, options)
    assert.equal(await fs.readFile(path.join(directory, "owned"), "utf8"), "ordinary work")
    const failed = path.join(f.root, "ordinary-failed/deep")
    await assert.rejects(withCreatedDirs(failed, async () => { throw new Error("ordinary failure") }, options), /ordinary failure/u)
    await assert.rejects(fs.lstat(path.dirname(failed)), { code: "ENOENT" })
  })
}
for (const retain of [false, true]) {
  test(`beforeCreate refusal releases overlap once with retention ${retain}`, async () => {
    const f = await fixture(), directory = path.join(f.root, "gate-overlap")
    let enteredA, releaseA, enteredB, releaseB
    const aEntered = new Promise(resolve => { enteredA = resolve }), aWait = new Promise(resolve => { releaseA = resolve })
    const bEntered = new Promise(resolve => { enteredB = resolve }), bWait = new Promise(resolve => { releaseB = resolve })
    const original = Object.freeze(new Error("exact beforeCreate refusal"))
    const a = assert.rejects(withCreatedDirs(directory, async () => { throw new Error("refused work must never run") }, {
      beforeCreate: async () => { enteredA(); await aWait; throw original }, shouldCleanup: () => !retain,
    }), error => error === original)
    await aEntered
    const b = assert.rejects(withCreatedDirs(directory, async () => {
      enteredB(); await bWait; throw new Error("ordinary overlapping failure")
    }), /ordinary overlapping failure/u)
    await bEntered
    const originalDirectory = await fs.lstat(directory, { bigint: true })
    releaseA(); await a
    assert.equal((await fs.lstat(directory, { bigint: true })).ino, originalDirectory.ino)
    releaseB(); await b
    if (retain) await fs.rename(directory, `${directory}-retained`)
    else await assert.rejects(fs.lstat(directory), { code: "ENOENT" })
    await assert.rejects(withCreatedDirs(directory, async () => { throw new Error("fresh registry") }), /fresh registry/u)
    await assert.rejects(fs.lstat(directory), { code: "ENOENT" })
  })
}
test("custom aggregate create never invokes the default beforeCreate seam twice", async () => {
  const f = await fixture(), directory = path.join(f.root, "custom-created")
  await withCreatedDirs(directory, () => fs.writeFile(path.join(directory, "owned"), "custom"), {
    create: async (file, recordMade) => { await fs.mkdir(file); recordMade(file) },
    beforeCreate: () => { throw new Error("default callback cannot govern custom aggregate creation") },
  })
  assert.equal(await fs.readFile(path.join(directory, "owned"), "utf8"), "custom")
})
test("causal throwing write after a physical partial effect records unknown return, not zero effects", async () => {
  const f = await fixture(), { plan, session } = await movedSession(f)
  const open = plan.open, original = Object.assign(new Error("write returned no count"), { code: "WRITE_UNKNOWN" })
  let stage
  plan.open = async (...args) => {
    const entry = await open(...args)
    if (args[2] === "archive replacement") {
      stage = entry; const write = entry.handle.write.bind(entry.handle)
      entry.handle.write = async (buffer, offset, length, position) => {
        await write(buffer, offset, 1, position); throw original
      }
    }
    return entry
  }
  await assert.rejects(session.applyFiles(), error => error === original)
  assert.equal(stage.record.returnedBytes, 0)
  assert.equal(stage.record.unknownReturns, 1)
  assert.equal(session.retain, true)
  await session.close()
})
test("causal nonextensible original writer error is preserved without attachment replacing it", async () => {
  const f = await fixture(), { plan, session } = await movedSession(f)
  const open = plan.open, original = Object.freeze(Object.assign(new Error("frozen original"), { code: "WRITE_FROZEN" }))
  plan.open = async (...args) => {
    const entry = await open(...args)
    if (args[2] === "archive replacement") entry.handle.write = async () => { throw original }
    return entry
  }
  await assert.rejects(session.applyFiles(), error => error === original)
  assert.equal(plan.receipt.primaryErrorAttachment, "unavailable")
  await session.close()
})
for (const placement of ["source", "destination"]) {
  for (const type of ["file", "directory", "symlink"]) {
    test(`causal any ${type} unfinished flag at ${placement} blocks even legacy transport without parsing`, async () => {
      const f = await fixture()
      if (placement === "destination") {
        await fs.mkdir(path.join(f.root, "alpha/_archive"))
        await fs.rename(path.join(f.root, "alpha/job"), path.join(f.root, "alpha/_archive/job"))
      }
      const directory = path.join(f.root, placement === "source" ? "alpha/job" : "alpha/_archive/job")
      const flag = path.join(directory, ".desk-archive-operation.json")
      if (type === "directory") await fs.mkdir(flag)
      else if (type === "symlink") await fs.symlink("NEVER_FOLLOW_OR_PARSE", flag)
      else await fs.writeFile(flag, "{malformed and incomplete")
      const marker = await fs.lstat(flag, { bigint: true })
      const before = await fs.readFile(path.join(directory, "task.md"))
      const result = await f.invoke({ openArchiveMove: async () => { throw new Error("legacy transport must not run") } })
      assert.equal(result.status, "archive_pending")
      assert.equal(result.publication.reason, "unqualified_original_map")
      assert.equal((await fs.lstat(flag, { bigint: true })).ino, marker.ino)
      assert.deepEqual(await fs.readFile(path.join(directory, "task.md")), before)
    })
  }
}
for (const phase of ["flag", "parent", "move", "first replacement"]) {
  test(`causal NEW invocation after partial ${phase} refuses without replay or retained-memory grant`, async () => {
    const f = await fixture(), plan = await prepare(f)
    let replaced = false
    const io = { ...fs, rename: async (from, to) => {
      await fs.rename(from, to)
      if (phase === "first replacement" && from.endsWith(".tmp") && !replaced) {
        replaced = true; throw new Error("returned replacement outcome deliberately unacknowledged")
      }
    } }
    const session = await openArchiveMoveSession({ source: plan.source, destination: plan.destination, aggregate: plan }, { fs: io })
    await session.admit()
    if (phase !== "flag") await session.create(path.dirname(plan.destination), () => {})
    if (["move", "first replacement"].includes(phase)) await session.move(() => plan.assertCurrent())
    if (phase === "first replacement") await assert.rejects(session.applyFiles())
    const actualDir = plan.moved ? plan.destination : plan.source
    const before = await fs.readFile(path.join(actualDir, "task.md"))
    const result = await f.invoke()
    assert.equal(result.status, "archive_pending"); assert.equal(result.publication.reason, "unqualified_original_map")
    assert.deepEqual(await fs.readFile(path.join(actualDir, "task.md")), before)
    assert.ok(await fs.lstat(path.join(actualDir, ".desk-archive-operation.json")))
    await session.close(new Error("deliberately parked incomplete operation"))
  })
}
test("causal source flag and directory move during a preflight await returns typed pending, not ENOENT", async t => {
  const f = await fixture(), open = fs.open.bind(fs)
  let changed = false
  t.mock.method(fs, "open", async (file, ...args) => {
    const handle = await open(file, ...args)
    if (file === path.join(f.root, "alpha/job/task.md")) {
      const read = handle.read.bind(handle)
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs)
        if (!changed && result.bytesRead === 0) {
          changed = true
          await fs.writeFile(path.join(f.root, "alpha/job/.desk-archive-operation.json"), "")
          await fs.mkdir(path.join(f.root, "alpha/_archive"))
          await fs.rename(path.join(f.root, "alpha/job"), path.join(f.root, "alpha/_archive/job"))
        }
        return result
      }
    }
    return handle
  })
  const result = await f.invoke()
  assert.equal(changed, true); assert.equal(result.status, "archive_pending")
  assert.equal(result.publication.reason, "unqualified_original_map")
  assert.equal(await f.read("alpha/_archive/job/task.md"), f.files["alpha/job/task.md"])
  assert.deepEqual(f.changes, [])
})
for (const timing of ["status read", "refill read", "publication preflight read", "patch helper read"]) {
  test(`legacy actual destination flag during ${timing} prevents report writes and success`, async t => {
    const f = await fixture(), read = fs.readFile.bind(fs)
    await fs.mkdir(path.join(f.root, "alpha/_archive"))
    await fs.rename(path.join(f.root, "alpha/job"), path.join(f.root, "alpha/_archive/job"))
    const file = path.join(f.root, "alpha/_archive/job/task.md")
    const before = "---\nstatus: cancelled\nfactory_report_unavailable: stale\n---\n\nUnchanged.\n"
    await fs.writeFile(file, before)
    let reads = 0, appeared = false
    const at = { "status read": 1, "refill read": 2, "publication preflight read": 3, "patch helper read": 4 }[timing]
    t.mock.method(fs, "readFile", async (target, ...args) => {
      const bytes = await read(target, ...args)
      if (target === file && ++reads === at) {
        appeared = true; await fs.writeFile(path.join(path.dirname(file), ".desk-archive-operation.json"), "not authority")
      }
      return bytes
    })
    const result = await f.invoke()
    assert.equal(appeared, true); assert.equal(result.status, "archive_pending")
    assert.equal(result.publication.reason, "unqualified_original_map")
    assert.equal(await read(file, "utf8"), before); assert.deepEqual(f.changes, [])
  })
}
test("legacy unmarked destination replacement during await cannot inherit the prior directory generation", async t => {
  const f = await fixture(), read = fs.readFile.bind(fs)
  const destination = path.join(f.root, "alpha/_archive/job")
  await fs.mkdir(path.dirname(destination)); await fs.rename(path.join(f.root, "alpha/job"), destination)
  let replaced = false
  t.mock.method(fs, "readFile", async (file, ...args) => {
    const bytes = await read(file, ...args)
    if (!replaced && file === path.join(destination, "task.md")) {
      replaced = true; await fs.rename(destination, `${destination}-original`)
      await fs.mkdir(destination); await fs.writeFile(path.join(destination, "task.md"), bytes)
    }
    return bytes
  })
  const result = await f.invoke()
  assert.equal(result.status, "archive_pending"); assert.equal(result.publication.reason, "unqualified_original_map")
  assert.equal(await read(path.join(destination, "task.md"), "utf8"), f.files["alpha/job/task.md"])
  assert.equal(await f.read("alpha/_archive/job-original/task.md"), f.files["alpha/job/task.md"])
  assert.deepEqual(f.changes, [])
})
test("an unreadable reserved slot is uncertainty, not absence", async t => {
  const f = await fixture(), lstat = fs.lstat.bind(fs)
  t.mock.method(fs, "lstat", (file, ...args) => file === path.join(f.root, "alpha/job/.desk-archive-operation.json")
    ? Promise.reject(Object.assign(new Error("marker observation denied"), { code: "EACCES" })) : lstat(file, ...args))
  const result = await f.invoke()
  assert.equal(result.status, "archive_pending"); assert.equal(result.publication.reason, "unqualified_original_map")
  assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
  assert.deepEqual(f.changes, [])
})
test("causal legacy missing-parent await must not mkdir or remove an externally appeared parent after a flag", async t => {
  const f = await fixture(), stat = fs.stat.bind(fs), mkdir = fs.mkdir.bind(fs)
  const directory = path.join(f.root, "alpha/_archive")
  let active = false, foreign, attempts = 0
  t.mock.method(fs, "mkdir", async (file, ...args) => {
    if (active && file === directory) attempts++
    return mkdir(file, ...args)
  })
  t.mock.method(fs, "stat", async (file, ...args) => {
    try { return await stat(file, ...args) } catch (error) {
      if (active && !foreign && file === directory && error.code === "ENOENT") {
        await fs.writeFile(path.join(f.root, "alpha/job/.desk-archive-operation.json"), "")
        await mkdir(directory); foreign = await fs.lstat(directory, { bigint: true })
      }
      throw error
    }
  })
  const result = await f.invoke({ openArchiveMove: async () => {
    active = true
    return { async admit() {}, async move(before) { await before(); throw new Error("move forbidden") }, async close() {} }
  } })
  assert.ok(foreign); assert.equal(result.status, "archive_pending")
  assert.equal((await fs.lstat(directory, { bigint: true })).ino, foreign.ino)
  assert.equal(attempts, 0)
  assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
})
for (const route of ["Git metadata", "Windows model", "custom move"]) {
  test(`reserved negative compatibility runs before ${route} admission without activating its provider`, async t => {
    const f = await fixture()
    await fs.writeFile(path.join(f.root, "alpha/job/.desk-archive-operation.json"), "")
    if (route === "Git metadata") await fs.mkdir(path.join(f.root, ".git"))
    if (route === "Windows model") {
      const original = Object.getOwnPropertyDescriptor(process, "platform")
      Object.defineProperty(process, "platform", { ...original, value: "win32" })
      t.after(() => Object.defineProperty(process, "platform", original))
    }
    const result = await f.invoke(route === "custom move"
      ? { moveArchive: () => { throw new Error("custom move must not run") } } : {})
    assert.equal(result.status, "archive_pending"); assert.equal(result.publication.reason, "unqualified_original_map")
    assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
    assert.deepEqual(f.changes, [])
  })
}
test("real success retires its own flag only after Final and FD closure; unmarked legacy remains idempotent", async () => {
  const f = await fixture(), { plan, session } = await movedSession(f)
  const marker = path.join(plan.destination, ".desk-archive-operation.json")
  assert.equal((await fs.lstat(marker)).mode & 0o777, 0o600)
  await session.applyFiles(); await session.close()
  assert.equal(plan.receipt.phase, "final_complete"); assert.equal(plan.receipt.marker.retired, true)
  assert.ok(plan.receipt.descriptors.every(entry => entry.closed))
  assert.deepEqual(plan.receipt.effects.map(effect => effect.kind).filter(kind => kind.startsWith("marker")),
    ["marker_create", "marker_retire"])
  await assert.rejects(fs.lstat(marker), { code: "ENOENT" })
  assert.equal((await f.invoke()).status, "already_archived")
  assert.equal(await f.read("alpha/track.md"), afterTrack)
})
test("exclusive marker is the first owned effect and retains its original FD inode and positional byte counts", async () => {
  const f = await fixture(), plan = await prepare(f), open = plan.open
  let entry, firstRead, positions = []
  plan.open = async (...args) => {
    const found = await open(...args)
    if (args[2] === "archive operation marker") {
      entry = found
      assert.equal(args[1] & 3, 2); assert.equal(args[3], 0o600)
      const write = found.handle.write.bind(found.handle), read = found.handle.read.bind(found.handle)
      found.handle.write = (bytes, offset, length, position) => {
        positions.push(position); return write(bytes, offset, Math.min(3, length), position)
      }
      found.handle.read = (buffer, offset, length, position) => {
        firstRead ??= position; return read(buffer, offset, length, position)
      }
    }
    return found
  }
  const session = await openArchiveMoveSession({ aggregate: plan })
  await session.admit()
  const marker = path.join(plan.source, ".desk-archive-operation.json"), original = await entry.handle.stat({ bigint: true })
  assert.equal((await fs.lstat(marker, { bigint: true })).ino, original.ino)
  assert.equal(plan.receipt.effects.length, 1); assert.equal(plan.receipt.effects[0].kind, "marker_create")
  assert.equal(firstRead, 0); assert.deepEqual(positions.slice(0, 3), [0, 3, 6])
  assert.equal(entry.record.returnedBytes, Buffer.byteLength('{"state":"unfinished"}\n'))
  await assert.rejects(fs.lstat(path.dirname(plan.destination)), { code: "ENOENT" })
  await session.close(new Error("parked before any parent or move"))
  assert.equal((await fs.lstat(marker, { bigint: true })).ino, original.ino)
})
for (const result of ["returned partial late", "thrown partial unknown", "open result unknown"]) {
  test(`marker ${result} retains exact physical effects and closes known FDs without moving`, async () => {
    const f = await fixture()
    let now = Date.now()
    const plan = await prepare(f, { now: () => now, deadline: now + 30000, evidenceDeadline: now + 40000 }), open = plan.open
    let markerFD
    plan.open = async (...args) => {
      const entry = await open(...args)
      if (args[2] === "archive operation marker") {
        markerFD = entry
        if (result === "open result unknown") throw new Error("open outcome unavailable after physical create")
        const write = entry.handle.write.bind(entry.handle)
        entry.handle.write = async (buffer, offset, length, position) => {
          const count = await write(buffer, offset, 1, position)
          if (result === "returned partial late") { now = plan.deadline; return count }
          throw new Error("physical partial marker write without returned count")
        }
      }
      return entry
    }
    const session = await openArchiveMoveSession({ aggregate: plan })
    await assert.rejects(session.admit())
    await session.close(new Error("initial admission failed"))
    assert.equal((await fs.stat(path.join(plan.source, ".desk-archive-operation.json"))).size,
      result === "open result unknown" ? 0 : 1)
    if (result !== "open result unknown") {
      assert.equal(markerFD.record.returnedBytes, result === "returned partial late" ? 1 : 0)
      assert.equal(markerFD.record.unknownReturns, result === "thrown partial unknown" ? 1 : 0)
    }
    assert.equal(plan.receipt.descriptors.every(entry => entry.closed), true)
    await assert.rejects(fs.lstat(path.dirname(plan.destination)), { code: "ENOENT" })
    assert.equal((await f.invoke()).publication.reason, "unqualified_original_map")
    assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
  })
}
test("reserved name appearing after admission is never overwritten or adopted", async () => {
  const f = await fixture(), plan = await prepare(f), open = plan.open
  const marker = path.join(plan.source, ".desk-archive-operation.json")
  let foreign
  plan.open = async (...args) => {
    if (args[2] === "archive operation marker") {
      await fs.writeFile(marker, "foreign"); foreign = await fs.lstat(marker, { bigint: true })
    }
    return open(...args)
  }
  const session = await openArchiveMoveSession({ aggregate: plan })
  await assert.rejects(session.admit(), { code: "EEXIST" }); await session.close(new Error("collision"))
  assert.equal((await fs.lstat(marker, { bigint: true })).ino, foreign.ino)
  assert.equal(await fs.readFile(marker, "utf8"), "foreign")
  assert.equal(plan.receipt.effects.some(effect => effect.kind === "marker_retire"), false)
})
test("foreign same-byte marker inode at retirement is neither adopted nor unlinked", async () => {
  const f = await fixture(), io = { ...fs }
  let armed = false, foreign
  io.lstat = async (file, ...args) => {
    if (armed && file.endsWith("/.desk-archive-operation.json")) {
      armed = false; const bytes = await fs.readFile(file)
      await fs.rename(file, `${file}.original-owned`); await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 })
      foreign = await fs.lstat(file, { bigint: true })
    }
    return fs.lstat(file, ...args)
  }
  const { plan, session } = await movedSession(f, { fs: io })
  await session.applyFiles(); armed = true
  await assert.rejects(session.close(), /original inode/u)
  const marker = path.join(plan.destination, ".desk-archive-operation.json")
  assert.equal((await fs.lstat(marker, { bigint: true })).ino, foreign.ino)
  assert.equal(plan.receipt.marker.retired, false)
  assert.equal(plan.receipt.effects.some(effect => effect.kind === "marker_retire"), false)
  assert.equal((await f.invoke()).publication.reason, "unqualified_original_map")
})
test("foreign same-byte marker replacing the created named source is not adopted into the original map", async () => {
  const f = await fixture(), plan = await prepare(f)
  let foreign, replaced = false
  const io = { ...fs, lstat: async (file, ...args) => {
    if (!replaced && file.endsWith("/.desk-archive-operation.json")) {
      replaced = true; const bytes = await fs.readFile(file)
      await fs.rename(file, `${file}.original-owned`); await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 })
      foreign = await fs.lstat(file, { bigint: true })
    }
    return fs.lstat(file, ...args)
  } }
  const session = await openArchiveMoveSession({ aggregate: plan }, { fs: io })
  await assert.rejects(session.admit(), /original exclusively created inode/u)
  await session.close(new Error("named source replaced"))
  assert.equal((await fs.lstat(path.join(plan.source, ".desk-archive-operation.json"), { bigint: true })).ino, foreign.ino)
  assert.equal(plan.receipt.effects.some(effect => effect.kind === "move" || effect.kind === "marker_retire"), false)
  assert.equal((await f.invoke()).publication.reason, "unqualified_original_map")
})
for (const result of ["permission refusal", "unknown mkdir return", "expired mkdir return", "symlink appearance"]) {
  test(`FIRST absent archive parent ${result} retains the flag and original registry ownership`, async () => {
    const f = await fixture()
    let now = Date.now(), made = [], plan
    const io = { ...fs }
    if (result === "symlink appearance") io.lstat = async (file, ...args) => {
      if (file === path.dirname(plan.destination)) await fs.symlink("peer", file)
      return fs.lstat(file, ...args)
    }
    else io.mkdir = async file => {
      if (result === "permission refusal") throw Object.assign(new Error("permission denied"), { code: "EACCES" })
      await fs.mkdir(file, { mode: 0o700 })
      if (result === "unknown mkdir return") throw new Error("mkdir response unknown")
      now = plan.deadline
    }
    plan = await prepare(f, { now: () => now, deadline: now + 30000, evidenceDeadline: now + 40000 })
    const session = await openArchiveMoveSession({ aggregate: plan }, { fs: io })
    await session.admit()
    await assert.rejects(withCreatedDirs(path.dirname(plan.destination), async () => { throw new Error("must not move") }, {
      create: (directory, recordMade) => session.create(directory, name => { made.push(name); recordMade(name) }),
      remove: directory => session.remove(directory), shouldCleanup: () => !session.retain,
    }))
    await session.close(new Error("parent is not qualified"))
    assert.deepEqual(made, [])
    assert.ok(await fs.lstat(path.join(plan.source, ".desk-archive-operation.json")))
    assert.equal(plan.receipt.effects.some(effect => effect.kind === "move" || effect.kind === "marker_retire"), false)
    if (result === "permission refusal") await assert.rejects(fs.lstat(path.dirname(plan.destination)), { code: "ENOENT" })
    else assert.ok(await fs.lstat(path.dirname(plan.destination)))
    assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
  })
}
for (const timing of ["before unlink", "lost unlink response"]) {
  test(`marker retirement ${timing} remains unknown without replay after every FD closed`, async () => {
    const f = await fixture()
    let calls = 0, plan
    const io = { ...fs, unlink: async file => {
      calls++; assert.ok(plan.receipt.descriptors.every(entry => entry.closed))
      if (timing === "lost unlink response") await fs.unlink(file)
      throw Object.assign(new Error(timing), { code: "UNLINK_UNQUALIFIED" })
    } }
    const state = await movedSession(f, { fs: io }); plan = state.plan
    await state.session.applyFiles()
    await assert.rejects(state.session.close(), { code: "UNLINK_UNQUALIFIED" })
    await state.session.close()
    assert.equal(calls, 1); assert.equal(plan.receipt.marker.retired, false)
    assert.equal(plan.receipt.finalValidated, true); assert.equal(plan.receipt.closed, true)
    assert.equal(plan.receipt.effects.find(effect => effect.kind === "marker_retire").returned, false)
    if (timing === "before unlink") assert.ok(await fs.lstat(path.join(plan.destination, ".desk-archive-operation.json")))
  })
}
test("original D expiring while required FDs close forbids a new marker unlink", async () => {
  const f = await fixture()
  let now = Date.now()
  const { plan, session } = await movedSession(f, {}, { now: () => now, deadline: now + 30000, evidenceDeadline: now + 40000 })
  await session.applyFiles()
  const last = [...plan.handles].at(-1), close = last.handle.close.bind(last.handle)
  last.handle.close = async () => { await close(); now = plan.deadline }
  await assert.rejects(session.close(), { code: "archive_deadline" })
  assert.ok(plan.receipt.descriptors.every(entry => entry.closed))
  assert.equal(plan.receipt.effects.some(effect => effect.kind === "marker_retire"), false)
  assert.ok(await fs.lstat(path.join(plan.destination, ".desk-archive-operation.json")))
})
test("one unknown descriptor close settles the others and never retires the marker", async t => {
  const f = await fixture(), { plan, session } = await movedSession(f)
  await session.applyFiles()
  const entry = [...plan.handles].at(-1), close = entry.handle.close.bind(entry.handle)
  entry.handle.close = async () => { throw new Error("owned FD closure not acknowledged") }
  t.after(() => close())
  await assert.rejects(session.close(), /closure not acknowledged/u)
  assert.equal(entry.record.closeUnknown, true)
  assert.equal(plan.receipt.descriptors.filter(record => record.closed).length, plan.receipt.descriptors.length - 1)
  assert.equal(plan.receipt.effects.some(effect => effect.kind === "marker_retire"), false)
  assert.ok(await fs.lstat(path.join(plan.destination, ".desk-archive-operation.json")))
})
test("late informational failure preserves actual Final-complete phase after confirmed retirement", async () => {
  const f = await fixture()
  let failed = false
  const result = await f.invoke({ statusContext: { get focus() {
    if (!failed) { failed = true; throw Object.freeze(new Error("late informational focus read")) }
    return null
  } } })
  assert.equal(result.status, "archive_pending"); assert.equal(result.publication.phase, "final_complete")
  assert.equal(result.publication.effects.marker.retired, true)
  assert.equal(await f.read("alpha/track.md"), afterTrack)
  await assert.rejects(fs.lstat(path.join(f.root, "alpha/_archive/job/.desk-archive-operation.json")), { code: "ENOENT" })
  assert.equal(Object.hasOwn(result, "factory_report"), false)
})
for (const kind of ["Finalize", "Evaluation"]) {
  test(`boundary model only: legacy task-local ${kind} post-await guard prevents the next dispatch`, async () => {
    const f = await fixture(), file = path.join(f.root, `UNEXPECTED_${kind}_REQUEST`)
    const source = await fs.readFile(new URL("../../../../../plugins/desk/mcp/src/tools/task.js", import.meta.url), "utf8")
    const expression = source.match(new RegExp(`async function requestTask${kind}\\([^]*?\\n\\}`, "u"))?.[0]
    assert.ok(expression)
    const original = Object.assign(new Error("unqualified_original_map"), { archiveMarkerPending: { status: "archive_pending" } })
    const fn = vm.runInNewContext(`(${expression})`, {
      factoryStateRoot: async () => {
        await fs.writeFile(path.join(f.root, "alpha/job/.desk-archive-operation.json"), "")
        return "synthetic opted-in state"
      },
      [`request${kind}`]: () => fs.writeFile(file, "This request must never be dispatched."),
      console: { error() {} },
    })
    const beforeEffect = async () => {
      const state = await archiveMarkerState({ effectiveRoot: f.root, srcDir: path.join(f.root, "alpha/job"),
        archiveDir: path.join(f.root, "alpha/_archive/job") })
      if (state.state !== "absent") throw original
    }
    await assert.rejects(fn({ deskRoot: f.root, env: {}, identity: { job: "synthetic" }, beforeEffect }), error => error === original)
    await assert.rejects(fs.lstat(file), { code: "ENOENT" })
  })
}
test("boundary model only: terminal sync observes a marker after the last evaluation await", async () => {
  const f = await fixture(), source = await fs.readFile(new URL("../../../../../plugins/desk/mcp/src/tools/task.js", import.meta.url), "utf8")
  const expression = source.match(/async function requestTaskTerminalSync\([^]*?\n\}/u)?.[0]
  assert.ok(expression)
  const original = Object.assign(new Error("unqualified_original_map"), { archiveMarkerPending: { status: "archive_pending" } })
  const fn = vm.runInNewContext(`(${expression})`, {
    taskJobOrNull: async () => ({}), requestTaskFinalize: async () => {},
    requestTaskEvaluation: () => fs.writeFile(path.join(f.root, "alpha/job/.desk-archive-operation.json"), ""),
    TERMINAL_STATUSES: new Set(["cancelled"]),
  })
  const beforeEffect = async () => {
    const state = await archiveMarkerState({ effectiveRoot: f.root, srcDir: path.join(f.root, "alpha/job"),
      archiveDir: path.join(f.root, "alpha/_archive/job") })
    if (state.state !== "absent") throw original
  }
  await assert.rejects(fn({ deskRoot: f.root, status: "cancelled", beforeEffect }), error => error === original)
})
for (const purpose of ["archive operation marker", "archive replacement"]) {
  test(`causal invalid returned ${purpose} count is unknown physical write, never zero-effect evidence`, async () => {
    const f = await fixture(), plan = await prepare(f), open = plan.open
    let damaged
    plan.open = async (...args) => {
      const entry = await open(...args)
      if (args[2] === purpose) {
        damaged = entry; const write = entry.handle.write.bind(entry.handle)
        entry.handle.write = async (buffer, offset, length, position) => {
          await write(buffer, offset, 1, position); return { bytesWritten: 0 }
        }
      }
      return entry
    }
    const session = await openArchiveMoveSession({ aggregate: plan })
    if (purpose === "archive replacement") {
      await session.admit(); await session.create(path.dirname(plan.destination), () => {})
      await session.move(() => plan.assertCurrent())
      await assert.rejects(session.applyFiles(), /invalid count/u)
    } else await assert.rejects(session.admit(), /invalid count/u)
    assert.equal(damaged.record.returnedBytes, 0); assert.equal(damaged.record.unknownReturns, 1)
    await session.close(new Error("invalid acknowledgement"))
    assert.equal(damaged.closed, true); assert.equal(session.retain, true)
  })
}
for (const timing of ["before stage", "after stage"]) {
  test(`causal legacy publication marker ${timing} prevents the next modeled Git mutation`, async () => {
    const f = await fixture(), file = path.join(f.root, "UNEXPECTED_GIT_MUTATION")
    const source = await fs.readFile(new URL("../../../../../plugins/desk/mcp/src/tools/archive-state.js", import.meta.url), "utf8")
    const expression = source.match(/(?:async )?function publishExpected\([^]*?\n\}/u)?.[0]
    assert.ok(expression)
    const marker = path.join(f.root, "alpha/job/.desk-archive-operation.json")
    if (timing === "before stage") await fs.writeFile(marker, "")
    const original = Object.assign(new Error("unqualified_original_map"), { archiveMarkerPending: { status: "archive_pending" } })
    const fn = vm.runInNewContext(`(${expression})`, {
      assertGitState() {},
      stagePaths() {
        writeFileSync(timing === "after stage" ? marker : file, "modeled dispatched stage effect")
        return { ok: true }
      },
      indexEntries: () => [], indexMatches: () => true,
      commitIndexPaths() { writeFileSync(file, "modeled commit must not occur"); return { ok: true } },
      gitFailure: value => value,
    })
    const beforeEffect = async () => {
      const state = await archiveMarkerState({ effectiveRoot: f.root, srcDir: path.join(f.root, "alpha/job"),
        archiveDir: path.join(f.root, "alpha/_archive/job") })
      if (state.state !== "absent") throw original
    }
    await assert.rejects(async () => fn({ root: f.root }, [], new Map(), "model only", [], beforeEffect), error => error === original)
    await assert.rejects(fs.lstat(file), { code: "ENOENT" })
  })
}
for (const timing of ["realpath", "temporary write", "target stat", "chmod"]) {
  test(`causal atomic markdown marker after ${timing} refuses the next mutation and retains its actual temporary`, async t => {
    const f = await fixture(), target = path.join(f.root, "alpha/job/task.md")
    const marker = path.join(f.root, "alpha/job/.desk-archive-operation.json")
    const original = Object.assign(new Error("marker refusal"), { code: "EPERM" })
    let appeared = false, temporary, renames = 0
    const opened = new WeakMap(), open = fs.open.bind(fs)
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await open(file, ...args); opened.set(handle, file); return handle
    })
    const method = { realpath: "realpath", "temporary write": "writeFile", "target stat": "stat", chmod: "chmod" }[timing]
    const action = fs[method].bind(fs), rename = fs.rename.bind(fs)
    t.mock.method(fs, method, async (file, ...args) => {
      const result = await action(file, ...args)
      const named = typeof file === "string" ? file : opened.get(file)
      const matches = timing === "realpath" || timing === "target stat" ? named === target : String(named).endsWith(".tmp")
      if (!appeared && matches) {
        appeared = true
        if (String(named).endsWith(".tmp")) temporary = named
        await fs.writeFile(marker, "")
      }
      return result
    })
    t.mock.method(fs, "rename", async (...args) => { renames++; return rename(...args) })
    const beforeWrite = async () => {
      const state = await archiveMarkerState({ effectiveRoot: f.root, srcDir: path.dirname(target),
        archiveDir: path.join(f.root, "alpha/_archive/job") })
      if (state.state !== "absent") throw original
    }
    await assert.rejects(writeFileAtomic(target, "new must not replace original", { beforeWrite }), error => error === original)
    assert.equal(appeared, true); assert.equal(renames, 0)
    assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
    const actualTemps = (await fs.readdir(path.dirname(target))).filter(name => name.endsWith(".tmp"))
    assert.equal(actualTemps.length, timing === "realpath" ? 0 : 1)
    if (temporary) assert.ok(await fs.lstat(temporary))
  })
}
test("causal frontmatter serialization fallback renews a marker guard after its mkdir await", async t => {
  const f = await fixture(), target = path.join(f.root, "alpha/job/task.md"), mkdir = fs.mkdir.bind(fs)
  await fs.writeFile(target, "body without frontmatter\n")
  let appeared = false
  t.mock.method(fs, "mkdir", async (file, ...args) => {
    const result = await mkdir(file, ...args)
    if (!appeared && file === path.dirname(target)) {
      appeared = true; await fs.writeFile(path.join(file, ".desk-archive-operation.json"), "")
    }
    return result
  })
  const original = new Error("fallback marker refusal")
  const beforeWrite = async () => {
    const state = await archiveMarkerState({ effectiveRoot: f.root, srcDir: path.dirname(target),
      archiveDir: path.join(f.root, "alpha/_archive/job") })
    if (state.state !== "absent") throw original
  }
  await assert.rejects(patchMarkdownFrontmatter(target, { status: "done" }, { beforeWrite }), error => error === original)
  assert.equal(appeared, true); assert.equal(await fs.readFile(target, "utf8"), "body without frontmatter\n")
})
for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`causal beforeWrite ${code} is terminal, never held-open fallback or cleanup`, async () => {
    const f = await fixture(), target = path.join(f.root, "alpha/job/task.md")
    const original = Object.freeze(Object.assign(new Error("guard refusal with held-open code"), { code }))
    await assert.rejects(writeMarkdown(target, { status: "done" }, "must not write", {
      atomic: true, beforeWrite: async () => { throw original },
    }), error => error === original)
    assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
    assert.deepEqual((await fs.readdir(path.dirname(target))).filter(name => name.endsWith(".tmp")), [])
  })
}
test("causal earlier atomic IO error survives secondary cleanup-admission refusal with its temporary retained", async t => {
  const f = await fixture(), target = path.join(f.root, "alpha/job/task.md")
  const original = new Error("original rename IO error"), secondary = new Error("cleanup admission refused")
  let ioFailed = false
  t.mock.method(fs, "rename", async () => { ioFailed = true; throw original })
  await assert.rejects(writeFileAtomic(target, "unpublished replacement", {
    beforeWrite: async () => { if (ioFailed) throw secondary },
  }), error => error === original)
  assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
  assert.equal((await fs.readdir(path.dirname(target))).filter(name => name.endsWith(".tmp")).length, 1)
  assert.equal(original.fmWrite.secondaryError, secondary.message)
})
test("causal guarded markdown temp replaced during write cannot be adopted for cleanup", async t => {
  const f = await fixture(), target = path.join(f.root, "alpha/job/task.md")
  const retained = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desk-markdown-retained-")))
  roots.push(retained)
  const write = fs.writeFile.bind(fs), rename = fs.rename.bind(fs), primary = new Error("rename IO failure")
  const opened = new WeakMap(), open = fs.open.bind(fs)
  t.mock.method(fs, "open", async (file, ...args) => {
    const handle = await open(file, ...args); opened.set(handle, file); return handle
  })
  let temporary, foreign
  t.mock.method(fs, "writeFile", async (file, ...args) => {
    const result = await write(file, ...args)
    const named = typeof file === "string" ? file : opened.get(file)
    if (!temporary && String(named).endsWith(".tmp")) {
      temporary = named; const bytes = await fs.readFile(named)
      await rename(named, path.join(retained, "original-owned"))
      await write(named, bytes, { flag: "wx", mode: 0o600 }); foreign = await fs.lstat(named, { bigint: true })
    }
    return result
  })
  t.mock.method(fs, "rename", async () => { throw primary })
  const beforeWrite = async () => {
    const state = await archiveMarkerState({ effectiveRoot: f.root, srcDir: path.dirname(target),
      archiveDir: path.join(f.root, "alpha/_archive/job") })
    assert.equal(state.state, "absent")
  }
  await assert.rejects(writeFileAtomic(target, "new", { beforeWrite }))
  assert.ok(foreign)
  assert.equal((await fs.lstat(temporary, { bigint: true })).ino, foreign.ino)
  assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
})
for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`guarded unmarked atomic ${code} still supports a qualified held-open fallback`, async t => {
    const f = await fixture(), target = path.join(f.root, "alpha/job/task.md")
    t.mock.method(fs, "rename", async () => { throw Object.assign(new Error("held open"), { code }) })
    const beforeWrite = async () => {
      const state = await archiveMarkerState({ effectiveRoot: f.root, srcDir: path.dirname(target),
        archiveDir: path.join(f.root, "alpha/_archive/job") })
      assert.equal(state.state, "absent")
    }
    await writeFileAtomic(target, "qualified fallback bytes", { beforeWrite })
    assert.equal(await fs.readFile(target, "utf8"), "qualified fallback bytes")
    assert.deepEqual((await fs.readdir(path.dirname(target))).filter(name => name.endsWith(".tmp")), [])
  })
}
for (const timing of ["cleanup stat", "cleanup returned"]) {
  test(`marker after atomic ${timing} prevents subsequent cleanup or fallback and preserves first IO cause`, async t => {
    const f = await fixture(), target = path.join(f.root, "alpha/job/task.md")
    const original = Object.assign(new Error("first held-open IO failure"), { code: "EPERM" })
    const lstat = fs.lstat.bind(fs), rm = fs.rm.bind(fs), write = fs.writeFile.bind(fs)
    let failed = false, appeared = false
    t.mock.method(fs, "rename", async () => { failed = true; throw original })
    const name = timing === "cleanup stat" ? "lstat" : "rm", action = timing === "cleanup stat" ? lstat : rm
    t.mock.method(fs, name, async (file, ...args) => {
      const result = await action(file, ...args)
      if (failed && !appeared && String(file).endsWith(".tmp")) {
        appeared = true; await write(path.join(path.dirname(target), ".desk-archive-operation.json"), "")
      }
      return result
    })
    const beforeWrite = async () => {
      const state = await archiveMarkerState({ effectiveRoot: f.root, srcDir: path.dirname(target),
        archiveDir: path.join(f.root, "alpha/_archive/job") })
      if (state.state !== "absent") throw new Error("new marker blocks cleanup and fallback")
    }
    await assert.rejects(writeFileAtomic(target, "must never fall back", { beforeWrite }), error => error === original)
    assert.equal(appeared, true); assert.equal(original.fmWrite.guardRefused, true)
    assert.equal(original.fmWrite.temporaryRemoved, timing === "cleanup returned")
    assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
    assert.equal((await fs.readdir(path.dirname(target))).filter(name => name.endsWith(".tmp")).length,
      timing === "cleanup returned" ? 0 : 1)
  })
}
test("unknown guarded markdown FD close retains temporary and never enters cleanup or fallback", async t => {
  const f = await fixture(), target = path.join(f.root, "alpha/job/task.md"), open = fs.open.bind(fs)
  const original = Object.freeze(new Error("guarded markdown descriptor close unknown"))
  t.mock.method(fs, "open", async (file, ...args) => {
    const handle = await open(file, ...args)
    if (String(file).endsWith(".tmp")) {
      const close = handle.close.bind(handle)
      handle.close = async () => { throw original }
      t.after(() => close())
    }
    return handle
  })
  await assert.rejects(writeFileAtomic(target, "unqualified temporary", { beforeWrite: async () => {} }), error => error === original)
  assert.equal((await fs.readdir(path.dirname(target))).filter(name => name.endsWith(".tmp")).length, 1)
  assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
})
test("actual legacy track writer retains temporary evidence when a destination marker appears during FD write", async t => {
  const f = await fixture(), open = fs.open.bind(fs), write = fs.writeFile.bind(fs), opened = new WeakMap()
  let retained
  t.mock.method(fs, "open", async (file, ...args) => {
    const handle = await open(file, ...args); opened.set(handle, file); return handle
  })
  t.mock.method(fs, "writeFile", async (file, ...args) => {
    const result = await write(file, ...args), named = typeof file === "string" ? file : opened.get(file)
    if (!retained && String(named).startsWith(path.join(f.root, "alpha/track.md."))) {
      retained = named; await write(path.join(f.root, "alpha/_archive/job/.desk-archive-operation.json"), "")
    }
    return result
  })
  const result = await f.invoke({ openArchiveMove: async ({ source, destination }) => ({
    async admit() {}, async move(before) { await before(); await fs.rename(source, destination) }, async close() {},
  }) })
  assert.equal(result.status, "archive_pending"); assert.equal(result.publication.reason, "unqualified_original_map")
  assert.equal(result.publication.file_write.temporary, retained)
  assert.equal(result.publication.file_write.temporaryWritten, true)
  assert.equal(result.publication.file_write.descriptor.closed, true)
  assert.equal(result.publication.file_write.guardRefused, true)
  assert.ok(await fs.lstat(retained))
  assert.equal(await f.read("alpha/track.md"), beforeTrack)
  assert.equal((await f.invoke()).publication.reason, "unqualified_original_map")
})
for (const key of Object.keys(ARCHIVE_LIMITS)) {
  test(`aggregate ${key} admission bound refuses before effects`, async () => {
    const f = await fixture()
    await assert.rejects(prepare(f, { limits: { ...ARCHIVE_LIMITS, [key]: 0 } }), { code: "archive_limit" })
    assert.equal(await f.read("alpha/job/task.md"), f.files["alpha/job/task.md"])
    await assert.rejects(fs.lstat(path.join(f.root, "alpha/_archive")), { code: "ENOENT" })
  })
}
test("known historical inbound owner is reported rather than silently left broken or rewritten", async () => {
  const f = await fixture()
  await fs.mkdir(path.join(f.root, "alpha/_archive/old"), { recursive: true })
  await fs.writeFile(path.join(f.root, "alpha/_archive/old/notes.md"), "[Job](../../job/task.md)\n")
  await assert.rejects(f.invoke(), { code: "archive_scope" })
  assert.equal(await f.read("alpha/_archive/old/notes.md"), "[Job](../../job/task.md)\n")
  assert.ok(await fs.stat(path.join(f.root, "alpha/job")))
})
for (const unsafe of ["symlink", "hardlink", "missing"]) {
  test(`unsafe ${unsafe} local referent is refused without repair`, async () => {
    const f = await fixture()
    const file = path.join(f.root, "alpha/guide.md")
    if (unsafe === "hardlink") await fs.link(file, path.join(f.root, "foreign-alias"))
    else {
      await fs.unlink(file)
      if (unsafe === "symlink") await fs.symlink("job/notes.md", file)
    }
    await assert.rejects(f.invoke(), /target|symlink|alias/u)
    assert.ok(await fs.stat(path.join(f.root, "alpha/job")))
  })
}
