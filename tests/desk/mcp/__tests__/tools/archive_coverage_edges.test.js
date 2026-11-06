import "./_archive_source_fence.mjs"
import "../_isolated_env.mjs"
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { planArchiveLinks } from "../../../../../plugins/desk/mcp/src/util/archive-link-plan.js"
import { prepareArchiveAggregate, archiveMarkerState, archiveHasGit, prepareArchiveState, prepareArchivedCardPublication } from "../../../../../plugins/desk/mcp/src/tools/archive-state.js"
import { openArchiveMoveSession } from "../../../../../plugins/desk/mcp/src/tools/archive-move.js"
import { writeFileAtomic } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { task_archive, task_update, headSha, taskJobOrNull, requestTaskFinalize } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import markdown from "../../../../../plugins/desk/mcp/src/util/markdown-links.cjs"
import { withCreatedDirs } from "../../../../../plugins/desk/mcp/src/util/created-dirs.js"

const roots = []
const plans = new Set()
after(async () => {
  for (const plan of plans) try { await plan.close() } catch (error) {
    assert.ok(plan.receipt.descriptors.every(entry => entry.closed || entry.closeUnknown), error.message)
  }
  for (const root of roots) await fs.rm(root, { recursive: true, force: true })
})
const posixTest = ["darwin", "linux"].includes(process.platform) ? test : test.skip
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "desk-archive-coverage-")))
  roots.push(root)
  await fs.mkdir(path.join(root, "t/job"), { recursive: true })
  await fs.writeFile(path.join(root, "t/job/task.md"), "---\nstatus: cancelled\n---\n\n[Guide](../guide.md)\n")
  await fs.writeFile(path.join(root, "t/guide.md"), "# Guide\n")
  return { root, source: path.join(root, "t/job"), destination: path.join(root, "t/_archive/job") }
}
async function prepare(f, extra = {}) {
  const plan = await prepareArchiveAggregate({ effectiveRoot: f.root, srcDir: f.source, archiveDir: f.destination,
    slug: "job", trackFile: path.join(f.root, "t/track.md"), deadline: Date.now() + 30000,
    evidenceDeadline: Date.now() + 40000, ...extra })
  plans.add(plan)
  return plan
}
async function session(f, extra = {}) {
  const plan = await prepare(f)
  const opened = await openArchiveMoveSession({ aggregate: plan }, extra)
  return { plan, opened }
}
function document(before, extra = {}) {
  return { path: "t/job/task.md", before, mode: 0o644, ancestry: ["directory"],
    identity: { type: "regular_file", dev: "1", ino: "2" },
    version: { size: String(Buffer.byteLength(before)), mtimeNs: "3", ctimeNs: "4" }, ...extra }
}
const linkPlan = (documents, entries = []) => planArchiveLinks({
  sourcePrefix: "t/job", destinationPrefix: "t/_archive/job", documents, entries,
})
test("planner rejects missing inventories instead of returning an applicable empty plan", () => {
  for (const options of [undefined, {}, { documents: [] }, { entries: [] }])
    assert.throws(() => planArchiveLinks(options), TypeError)
})
test("planner reports duplicate target observations and duplicate document ownership", () => {
  const owner = document("[Guide](../guide.md)\n")
  const target = { path: "t/guide.md", type: "regular_file", ancestry: ["directory"] }
  const result = linkPlan([owner, owner], [target, target])
  assert.deepEqual(result.refusals.map(row => row.code), ["duplicate_target_observation", "duplicate_document"])
  assert.equal(result.files.length, 1)
})
test("planner refuses stale completion observations without projecting bytes", () => {
  const result = linkPlan([document("unchanged", { observation: "changed" })])
  assert.deepEqual(result.refusals, [{ code: "input_not_current", path: "t/job/task.md" }])
  assert.deepEqual(result.files, [])
})
test("planner refuses references escaping the effective desk", () => {
  const result = linkPlan([document("[Outside](../../../foreign.md)")])
  assert.deepEqual(result.refusals.map(row => row.code), ["target_outside_desk"])
})
test("planner encodes newly introduced special path segments without rewriting the retained suffix", () => {
  const result = planArchiveLinks({ sourcePrefix: "t/job", destinationPrefix: "t/!'()*/job",
    documents: [document("[Task](job/task.md)\n", { path: "t/track.md" })],
    entries: [{ path: "t/job/task.md", type: "regular_file", ancestry: ["directory"] }] })
  assert.deepEqual(result.refusals, [])
  assert.equal(result.files[0].after, "[Task](%21%27%28%29%2A/job/task.md)\n")
})
test("planner can rewrite a directory reference to its new owning directory", () => {
  const result = planArchiveLinks({ sourcePrefix: "t/job", destinationPrefix: "t/_archive/job",
    documents: [document("[Dir](../../job)", { path: "t/_archive/job/task.md" })],
    entries: [{ path: "t/job", type: "directory", ancestry: ["directory"] }] })
  assert.deepEqual(result.refusals, [])
  assert.equal(result.files[0].after, "[Dir](.)")
})
for (const [before, target, code] of [
  ["[Guide](../guide&unknown;.md)", "t/guide&unknown;.md", "unsupported_destination"],
  ["[Guide](..&#47;guide.md)", "t/guide.md", "ambiguous_separator"],
]) test(`planner preserves a specific ${code} refusal from the real Markdown decoder`, () => {
  const result = linkPlan([document(before)], [{ path: target, type: "regular_file", ancestry: ["directory"] }])
  assert.deepEqual(result.refusals.map(row => row.code), [code])
  assert.equal(result.files[0].after, before)
})
test("planner preserves non-encoding decoder errors instead of claiming invalid UTF-8", t => {
  const original = Object.freeze(new Error("decoder resource unavailable"))
  t.mock.method(TextDecoder.prototype, "decode", () => { throw original })
  assert.throws(() => linkPlan([document(Buffer.from("bytes"))]), error => error === original)
})
test("planner preserves a non-URI decoder fault instead of substituting an encoding refusal", t => {
  const original = Object.freeze(new Error("URI decoder unavailable"))
  t.mock.method(globalThis, "decodeURIComponent", () => { throw original })
  assert.throws(() => linkPlan([document("[Guide](../guide.md)")]), error => error === original)
})
test("marker observation refuses a non-directory effective root and an escaping logical source", async () => {
  const f = await fixture()
  assert.equal((await archiveMarkerState({ effectiveRoot: path.join(f.source, "task.md"),
    srcDir: f.source, archiveDir: f.destination })).state, "unverified")
  assert.equal((await archiveMarkerState({ effectiveRoot: f.root,
    srcDir: path.dirname(f.root), archiveDir: f.destination })).state, "unverified")
})
test("marker observation supports the root itself as a selected directory without granting ownership", async () => {
  const f = await fixture()
  const state = await archiveMarkerState({ effectiveRoot: f.root, srcDir: f.root, archiveDir: f.destination })
  assert.equal(state.state, "absent")
  assert.equal(state.bindings.root, state.bindings.source)
})
for (const timing of ["before realpath", "after realpath", "after missing metadata"]) {
  test(`Git metadata routing retains its original deadline ${timing}`, async () => {
    const f = await fixture()
    let reads = 0
    const now = () => timing === "before realpath" || ++reads >= (timing === "after realpath" ? 2 : 3) ? 100 : 0
    await assert.rejects(archiveHasGit(f.root, 100, now), { code: "archive_deadline" })
  })
}
test("Git metadata routing preserves a real observation error", async t => {
  const f = await fixture(), original = new Error("metadata inaccessible"), lstat = fs.lstat.bind(fs)
  t.mock.method(fs, "lstat", (file, ...args) => file === path.join(f.root, ".git")
    ? Promise.reject(original) : lstat(file, ...args))
  await assert.rejects(archiveHasGit(f.root, Date.now() + 30000), error => error === original)
})
for (const placement of ["ancestry", "recheck"]) test(`marker ${placement} access error stays unverified`, async t => {
  const f = await fixture(), lstat = fs.lstat.bind(fs)
  let rootReads = 0
  t.mock.method(fs, "lstat", (file, ...args) => {
    if (file === f.root) rootReads++
    if (placement === "ancestry" && file === path.join(f.root, "t") ||
      placement === "recheck" && file === f.root && rootReads === 2)
      return Promise.reject(Object.assign(new Error("access denied"), { code: "EACCES" }))
    return lstat(file, ...args)
  })
  const state = await archiveMarkerState({ effectiveRoot: f.root, srcDir: f.source, archiveDir: f.destination })
  assert.deepEqual(state, { state: "unverified", reason: "EACCES" })
})
test("marker observation does not adopt an absent parent that appears during its recheck", async t => {
  const f = await fixture(), lstat = fs.lstat.bind(fs)
  const parent = path.dirname(f.destination)
  let reads = 0
  t.mock.method(fs, "lstat", async (file, ...args) => {
    if (file === parent && ++reads === 2) await fs.mkdir(parent)
    return lstat(file, ...args)
  })
  assert.equal((await archiveMarkerState({ effectiveRoot: f.root, srcDir: f.source, archiveDir: f.destination })).state, "unverified")
  assert.ok((await lstat(parent)).isDirectory())
})
posixTest("aggregate refuses outside source and occupied destination before any session effects", async () => {
  const f = await fixture()
  await assert.rejects(prepare(f, { srcDir: path.dirname(f.root) }), { code: "archive_scope" })
  await fs.mkdir(f.destination, { recursive: true })
  await assert.rejects(prepare(f), { code: "archive_occupied" })
})
posixTest("aggregate refuses an existing marker before inventory reads", async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.source, ".desk-archive-operation.json"), "foreign")
  await assert.rejects(prepare(f), { code: "archive_marker_pending" })
  assert.equal(await fs.readFile(path.join(f.source, ".desk-archive-operation.json"), "utf8"), "foreign")
})
posixTest("a failed directory-reader acquisition is recorded as unknown rather than no resource", async t => {
  const f = await fixture(), original = Object.freeze(new Error("opendir response lost"))
  t.mock.method(fs, "opendir", async () => { throw original })
  await assert.rejects(prepare(f), error => error === original)
})
posixTest("invalid directory-reader output refuses and records an unknown read outcome", async t => {
  const f = await fixture(), opendir = fs.opendir.bind(fs)
  t.mock.method(fs, "opendir", async (...args) => {
    const dir = await opendir(...args)
    dir.read = async () => ({ name: 7 })
    return dir
  })
  await assert.rejects(prepare(f), error => {
    assert.equal(error.code, "archive_directory_unknown")
    assert.equal(error.archiveAggregate.directoryReaders[0].unknownReturns, 1)
    assert.equal(error.archiveAggregate.directoryReaders[0].closed, true)
    return true
  })
})
for (const kind of ["early EOF", "overreported read", "opened version"]) {
  posixTest(`aggregate original-file ${kind} cannot certify an admitted input`, async t => {
    const f = await fixture(), open = fs.open.bind(fs), target = path.join(f.source, "task.md")
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await open(file, ...args)
      if (file === target) {
        if (kind === "opened version") {
          const stat = handle.stat.bind(handle)
          handle.stat = async (...values) => { const result = await stat(...values); result.ino++; return result }
        } else handle.read = async () => ({ bytesRead: kind === "early EOF" ? 0 : 65537 })
      }
      return handle
    })
    await assert.rejects(prepare(f), { code: "archive_changed" })
  })
}
for (const before of [Buffer.from([0xff]), Buffer.from("[Bad](../bad%2fpath)"), Buffer.from("[Web](https://example.test/) [Fragment](#x)\n[Guide](../guide.md)")]) {
  posixTest(`aggregate observes exact Markdown encoding and local-target class ${before.toString("hex")}`, async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.source, "task.md"), before)
    if (before[0] === 0xff) await assert.rejects(prepare(f), { code: "archive_encoding" })
    else if (before.includes(Buffer.from("%2f"))) await assert.rejects(prepare(f), { code: "archive_target" })
    else { const plan = await prepare(f); assert.equal(plan.receipt.links.length, 1); await plan.close() }
  })
}
posixTest("aggregate completion observation mismatch is not adopted into its original map", async () => {
  const f = await fixture()
  await fs.unlink(path.join(f.source, "task.md"))
  await assert.rejects(prepare(f, { cardObservation: { state: "present", bytes: Buffer.from("missing") } }), { code: "archive_card_changed" })
})
posixTest("aggregate final-card bytes remain subject to the actual document cap", async () => {
  const f = await fixture()
  await assert.rejects(prepare(f, { composeCard: () => "x".repeat(1048577) }), { code: "archive_limit" })
})
posixTest("aggregate missing source directory is refused after a complete original inventory", async () => {
  const f = await fixture()
  await fs.rm(f.source, { recursive: true })
  await assert.rejects(prepare(f), { code: "archive_source" })
})
for (const fault of ["failed open", "unqualified stat", "non-held rename", "close after write error"]) {
  test(`guarded atomic writer preserves ${fault} with exact retained-effects diagnostics`, async t => {
    const f = await fixture(), target = path.join(f.source, "task.md")
    const before = await fs.readFile(target), original = Object.assign(new Error(`owned ${fault}`), { code: "EIO" })
    const open = fs.open.bind(fs), rename = fs.rename.bind(fs), write = fs.writeFile.bind(fs)
    let cleanup
    t.mock.method(fs, "open", async (file, ...args) => {
      if (!file.endsWith(".tmp")) return open(file, ...args)
      if (fault === "failed open") throw original
      const handle = await open(file, ...args)
      if (fault === "unqualified stat") {
        const stat = handle.stat.bind(handle)
        handle.stat = async (...values) => { const result = await stat(...values); result.nlink = 2n; return result }
      }
      if (fault === "close after write error") {
        cleanup = handle.close.bind(handle)
        handle.close = async () => { throw new Error("close response unavailable") }
      }
      return handle
    })
    t.after(async () => { if (cleanup) await cleanup() })
    t.mock.method(fs, "rename", (...args) => fault === "non-held rename" ? Promise.reject(original) : rename(...args))
    t.mock.method(fs, "writeFile", (file, ...args) => fault === "close after write error" && typeof file !== "string"
      ? Promise.reject(original) : write(file, ...args))
    await assert.rejects(writeFileAtomic(target, "new", { beforeWrite: async () => {} }), error => {
      if (fault !== "unqualified stat") assert.equal(error, original)
      assert.equal(error.fmWrite.temporaryAttempted, true)
      if (fault === "non-held rename") assert.equal(error.fmWrite.temporaryRemoved, true)
      if (fault === "close after write error") assert.equal(error.fmWrite.descriptor.closeUnknown, true)
      return true
    })
    assert.deepEqual(await fs.readFile(target), before)
  })
}
posixTest("aggregate provider exposes its exact receipt and refuses each pre-admission mutation", async () => {
  const f = await fixture(), { plan, opened } = await session(f)
  assert.equal(opened.receipt, plan.receipt)
  await assert.rejects(opened.create(path.dirname(f.destination), () => {}), /not admitted/u)
  await assert.rejects(opened.move(() => {}), /one admitted session/u)
  await assert.rejects(opened.applyFiles(), /original completed move/u)
  await assert.rejects(opened.remove(path.dirname(f.destination)), /not qualified/u)
  await opened.close(new Error("not admitted"))
  await assert.rejects(opened.admit(), /cannot be reused/u)
  await opened.close()
  assert.equal(await fs.readFile(path.join(f.source, "task.md"), "utf8"),
    "---\nstatus: cancelled\n---\n\n[Guide](../guide.md)\n")
})
posixTest("a second admission never reuses or overwrites the original operation marker", async () => {
  const f = await fixture(), { opened } = await session(f)
  await opened.admit()
  const before = await fs.readFile(path.join(f.source, ".desk-archive-operation.json"))
  await assert.rejects(opened.admit(), /cannot be reused/u)
  await opened.close(new Error("retained admitted marker"))
  assert.deepEqual(await fs.readFile(path.join(f.source, ".desk-archive-operation.json")), before)
})
posixTest("aggregate move requires a function and an admitted destination parent", async () => {
  const f = await fixture(), { opened } = await session(f)
  await opened.admit()
  await assert.rejects(opened.move(null), /one admitted session/u)
  await assert.rejects(opened.move(async () => {}), /parent has not been qualified/u)
  await opened.close(new Error("no parent"))
  await assert.rejects(fs.lstat(f.destination), { code: "ENOENT" })
})
posixTest("aggregate creation rejects an unrelated destination before invoking filesystem mutation", async () => {
  const f = await fixture(), { opened } = await session(f)
  await opened.admit()
  await assert.rejects(opened.create(f.root, () => {}), /not admitted/u)
  await opened.close(new Error("wrong directory"))
})
posixTest("aggregate effect receipt bound refuses before creating an operation marker", async () => {
  const f = await fixture(), { plan, opened } = await session(f)
  plan.receipt.effects.push(...Array.from({ length: 4096 }, () => ({ kind: "observation", returned: true })))
  await assert.rejects(opened.admit(), /effect record bound exceeded/u)
  await opened.close(new Error("receipt full"))
  assert.equal(plan.receipt.effects.length, 4096)
  await assert.rejects(fs.lstat(path.join(f.source, ".desk-archive-operation.json")), { code: "ENOENT" })
})
test("aggregate provider refuses a Windows dependency binding without starting native work", async () => {
  const f = await fixture(), plan = await prepare(f)
  await assert.rejects(openArchiveMoveSession({ aggregate: plan }, { platform: "win32" }), /POSIX-only/u)
  assert.deepEqual(plan.receipt.effects, [])
  await plan.close()
})
posixTest("an admitted session removes only its own empty created parent and rejects reuse", async () => {
  const f = await fixture(), { plan, opened } = await session(f), parent = path.dirname(f.destination)
  await opened.admit()
  await opened.create(parent, () => {})
  assert.equal(opened.retain, false)
  await opened.remove(parent)
  assert.equal(plan.rows.has("t/_archive"), false)
  await assert.rejects(fs.lstat(parent), { code: "ENOENT" })
  await assert.rejects(opened.remove(parent), /not qualified/u)
  await opened.close(new Error("cleanup tested"))
})
posixTest("an admitted created parent with a subsequently admitted child is not removed", async () => {
  const f = await fixture(), { plan, opened } = await session(f), parent = path.dirname(f.destination)
  await opened.admit(); await opened.create(parent, () => {})
  const child = path.join(parent, "owned-child")
  await fs.writeFile(child, "retained")
  await plan.refreshDirectory(plan.parentRow(parent), [["owned-child", plan.childStamp(await fs.lstat(child, { bigint: true }))]])
  await assert.rejects(opened.remove(parent), /not empty/u)
  await opened.close(new Error("nonempty directory retained"))
  assert.equal(await fs.readFile(child, "utf8"), "retained")
})
posixTest("created-parent cleanup refuses while closed, moved, or retaining uncertain effects", async () => {
  for (const state of ["closed", "moved", "retain"]) {
    const f = await fixture(), io = state === "retain"
      ? { ...fs, rename: async () => { throw new Error("transport boundary failed") } } : fs
    const { opened } = await session(f, { fs: io }), parent = path.dirname(f.destination)
    await opened.admit(); await opened.create(parent, () => {})
    if (state === "closed") await opened.close(new Error("closed parent"))
    if (state === "moved") await opened.move(async () => {})
    if (state === "retain") {
      await assert.rejects(opened.move(async () => {}), /transport boundary/u)
      assert.equal(opened.retain, true)
    }
    await assert.rejects(opened.remove(parent), /not qualified/u)
    await opened.close(new Error("cleanup refusal"))
    assert.ok((await fs.lstat(parent)).isDirectory())
  }
})
for (const failure of ["marker type", "created parent mode", "replacement parent", "stage type", "stage bytes", "stage mode"]) {
  posixTest(`aggregate ${failure} refusal retains actual files and never certifies Final`, async () => {
    const f = await fixture(), { plan, opened } = await session(f)
    const step = plan.step
    let injected = false
    plan.step = async (label, work, capture) => {
      const value = await step(label, work, capture)
      if (!injected && (
        failure === "marker type" && label === "marker original descriptor" ||
        failure === "created parent mode" && label === "created parent original name" ||
        failure === "stage type" && label === "created stage identity" ||
        failure === "stage mode" && label === "completed stage identity")) {
        injected = true
        if (failure === "created parent mode" || failure === "stage mode") value.mode ^= 0o001n
        else value.nlink = 2n
      }
      return value
    }
    const readBytes = plan.readBytes
    plan.readBytes = async (...args) => {
      const bytes = await readBytes(...args)
      if (!injected && failure === "stage bytes" && plan.moved) { injected = true; return Buffer.from("foreign") }
      return bytes
    }
    if (failure === "marker type") await assert.rejects(opened.admit(), /private single-link/u)
    else {
      await opened.admit()
      if (failure === "created parent mode") await assert.rejects(opened.create(path.dirname(f.destination), () => {}), /type\/mode/u)
      else {
        await opened.create(path.dirname(f.destination), () => {})
        await opened.move(async () => {})
        if (failure === "replacement parent") {
          const parentRow = plan.parentRow
          plan.parentRow = () => undefined
          await assert.rejects(opened.applyFiles(), /replacement parent/u)
          plan.parentRow = parentRow; injected = true
        } else await assert.rejects(opened.applyFiles(), /stage|final map/u)
      }
    }
    await opened.close(new Error("controlled refused observation"))
    assert.equal(injected, true)
    assert.notEqual(plan.receipt.phase, "final_complete")
  })
}
posixTest("archive-parent observation errors remain primary and do not create the parent", async () => {
  const f = await fixture(), original = Object.assign(new Error("parent observation denied"), { code: "EACCES" })
  const io = { ...fs, lstat: (file, ...args) => file === path.dirname(f.destination)
    ? Promise.reject(original) : fs.lstat(file, ...args) }
  const { opened } = await session(f, { fs: io })
  await opened.admit()
  await assert.rejects(opened.create(path.dirname(f.destination), () => {}), error => error === original)
  await opened.close(original)
  await assert.rejects(fs.lstat(path.dirname(f.destination)), { code: "ENOENT" })
})
posixTest("marker retirement preserves an access error and a still-present name", async () => {
  for (const failure of ["access", "presence"]) {
    const f = await fixture()
    let unlinked = false
    const io = { ...fs,
      unlink: async file => { unlinked = true; if (failure === "access") await fs.unlink(file) },
      lstat: async (file, ...args) => {
        if (unlinked && failure === "access" && file.endsWith(".desk-archive-operation.json"))
          throw Object.assign(new Error("absence cannot be observed"), { code: "EACCES" })
        return fs.lstat(file, ...args)
      },
    }
    const { plan, opened } = await session(f, { fs: io })
    await opened.admit(); await opened.create(path.dirname(f.destination), () => {})
    await opened.move(async () => {}); await opened.applyFiles()
    await assert.rejects(opened.close(), failure === "access" ? /absence cannot be observed/u : /retirement is unqualified/u)
    assert.equal(plan.receipt.marker.retired, false)
    assert.notEqual(plan.receipt.phase, "final_complete")
  }
})
posixTest("settlement cutoff is checked after the plan close returns", async () => {
  const f = await fixture(), { plan, opened } = await session(f), close = plan.close
  await opened.admit()
  plan.close = async () => { await close(); plan.evidenceDeadline = 0 }
  await assert.rejects(opened.close(new Error("primary")), /settlement deadline expired/u)
  assert.equal(plan.receipt.closed, true)
})
test("a guarded atomic write preserves a thrown function as the primary failure", async t => {
  const f = await fixture(), original = function primaryFailure() {}
  const errors = []
  t.mock.method(console, "error", (...args) => errors.push(args))
  await assert.rejects(writeFileAtomic(path.join(f.source, "task.md"), "new", { beforeWrite: async () => { throw original } }),
    error => error === original)
  assert.equal(errors.length, 0)
  assert.equal(original.fmWrite.guardRefused, true)
})
posixTest("a function-valued primary admission failure is preserved without replacing its identity", async () => {
  const f = await fixture(), { plan, opened } = await session(f), primary = function unavailableAdmission() {}
  plan.assertCurrent = async () => { throw primary }
  await assert.rejects(opened.admit(), error => error === primary)
  assert.equal(primary.archiveAggregate, plan.receipt)
  await opened.close(primary)
})
posixTest("a creation plan with no admitted root parent cannot escape its inventory", async () => {
  const f = await fixture(), { plan, opened } = await session(f)
  await opened.admit()
  plan.parentRow = () => undefined
  await assert.rejects(opened.create(path.dirname(f.destination), () => {}), /leaves its admitted root/u)
  await opened.close(new Error("invalid parent lineage"))
  await assert.rejects(fs.lstat(path.dirname(f.destination)), { code: "ENOENT" })
})
const invoke = (f, extra = {}) => task_archive({ deskRoot: f.root, input: { track: "t", slug: "job" },
  env: { ...process.env, XDG_STATE_HOME: path.join(f.root, "private-state") },
  spawnGit: () => { throw new Error("test forbids Git mutation") }, schedulePush() {}, ...extra })
for (const fault of ["route stat", "card stat", "oversized card", "descriptor version", "oversized read", "early EOF", "close failure"]) {
  posixTest(`original completion reader preserves ${fault} without moving the task`, async t => {
    const f = await fixture(), target = path.join(f.source, "task.md"), before = await fs.readFile(target)
    const open = fs.open.bind(fs), lstat = fs.lstat.bind(fs)
    const original = Object.assign(new Error(`owned ${fault}`), { code: "EACCES" })
    let routeReads = 0
    t.mock.method(fs, "lstat", async (file, options) => {
      if (file === target && (fault === "route stat" && !options?.bigint && ++routeReads > 1 || fault === "card stat" && options?.bigint))
        throw original
      const stat = await lstat(file, options)
      if (file === target && fault === "oversized card" && options?.bigint) stat.size = 1048577n
      return stat
    })
    let cleanup
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await open(file, ...args)
      if (file === target) {
        if (fault === "descriptor version") {
          const stat = handle.stat.bind(handle)
          handle.stat = async (...values) => { const result = await stat(...values); result.ino++; return result }
        }
        if (fault === "oversized read" || fault === "early EOF")
          handle.read = async () => ({ bytesRead: fault === "early EOF" ? 0 : before.length + 1 })
        if (fault === "close failure") {
          cleanup = handle.close.bind(handle)
          handle.close = async () => { throw original }
        }
      }
      return handle
    })
    t.after(async () => { if (cleanup) await cleanup() })
    await assert.rejects(invoke(f), error => {
      if (["route stat", "card stat", "close failure"].includes(fault)) assert.equal(error, original)
      else assert.match(error.message, /byte bound|descriptor differs|size changed|ended early/u)
      return true
    })
    assert.deepEqual(await fs.readFile(target), before)
    await assert.rejects(fs.lstat(f.destination), { code: "ENOENT" })
  })
}
posixTest("the same original card cannot disappear on its final completion reread", async t => {
  const f = await fixture(), target = path.join(f.source, "task.md")
  const lstat = fs.lstat.bind(fs)
  let observed = 0
  t.mock.method(fs, "lstat", async (file, options) => {
    if (file === target && options?.bigint && ++observed === 3) await fs.rename(target, `${target}.retained`)
    return lstat(file, options)
  })
  await assert.rejects(invoke(f), /completion card disappeared/u)
  assert.equal(await fs.readFile(`${target}.retained`, "utf8"), "---\nstatus: cancelled\n---\n\n[Guide](../guide.md)\n")
})
for (const attempts of [0, 1]) {
  test(`Factory handoff records a pre-dispatch blocker after ${attempts} previously accepted helpers`, async () => {
    const f = await fixture(), original = Object.assign(new Error("marker blocks new helper"), { archiveMarkerPending: true })
    const handoff = { deadline: null, attempts: Array.from({ length: attempts }, () => ({ state: "returned" })) }
    await assert.rejects(requestTaskFinalize({ deskRoot: f.root, env: {}, identity: {},
      terminalHandoff: handoff, beforeEffect: async () => { throw original } }), error => error === original)
    assert.equal(handoff.status, attempts ? "unknown" : "not_dispatched")
    assert.equal(handoff.blockedBefore.helper, "factoryStateRoot.finalize")
    assert.equal(handoff.attempts.length, attempts)
  })
  test(`Factory handoff never admits a helper after its deadline with ${attempts} prior helpers`, async () => {
    const f = await fixture(), handoff = { deadline: 0, attempts: Array.from({ length: attempts }, () => ({ state: "returned" })) }
    await assert.rejects(requestTaskFinalize({ deskRoot: f.root, env: {}, identity: {},
      terminalHandoff: handoff, beforeEffect: async () => {} }), error => error.archiveTerminalPending === true)
    assert.equal(handoff.status, attempts ? "unknown" : "not_dispatched")
    assert.equal(handoff.attempts.length, attempts)
  })
}
test("legacy finalize renews its supplied barrier before and after the disabled Factory root observation", async () => {
  const f = await fixture()
  let barriers = 0
  await requestTaskFinalize({ deskRoot: f.root, env: { ...process.env, XDG_STATE_HOME: `${f.root}-absent-state` },
    identity: null, beforeEffect: async () => { barriers++ } })
  assert.equal(barriers, 2)
})
test("a missing terminal identity is reported without admitting a Factory helper", async t => {
  const f = await fixture(), messages = []
  t.mock.method(console, "error", (...args) => messages.push(args))
  const handoff = { deadline: null, attempts: [] }
  await requestTaskFinalize({ deskRoot: f.root, env: {}, identity: null, terminalHandoff: handoff })
  assert.deepEqual(messages, [["desk_factory: finalize_request_deferred"]])
  assert.deepEqual(handoff.attempts, [])
})
test("an invalid original noGit deadline cannot resolve a later task identity", async () => {
  const f = await fixture()
  assert.equal(await taskJobOrNull({ deskRoot: f.root, person: null, track: "t", slug: "job",
    noGit: { deadline: NaN } }), null)
})
for (const resource of ["root directory", "card file"]) {
  posixTest(`unknown ${resource} close blocks renewed aggregate admission`, async t => {
    const f = await fixture(), open = fs.open.bind(fs), target = resource === "card file" ? path.join(f.source, "task.md") : f.root
    let cleanup
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await open(file, ...args)
      if (file === target) {
        cleanup = handle.close.bind(handle)
        handle.close = async () => { throw new Error("owned close response unavailable") }
      }
      return handle
    })
    t.after(async () => { if (cleanup) await cleanup() })
    const plan = await prepare(f)
    await assert.rejects(plan.close(), /close response/u)
    await assert.rejects(plan.assertCurrent(), /descriptor closure is unqualified/u)
    if (resource === "root directory")
      await assert.rejects(plan.refreshDirectory(plan.parentRow(f.root), []), /parent descriptor closure/u)
  })
}
posixTest("a replacement target cannot use a descriptor already released by its original plan", async () => {
  const f = await fixture(), plan = await prepare(f)
  await plan.close()
  await assert.rejects(plan.assertReplacementTarget(plan.rows.get("t/job/task.md")), /original replacement admission is unavailable/u)
})
for (const fault of ["held bytes", "after-read version", "parent transition identity", "last parent", "last target"]) {
  posixTest(`renewed aggregate ${fault} check refuses the foreign observation`, async t => {
    const f = await fixture(), target = path.join(f.source, "task.md"), open = fs.open.bind(fs)
    let active = false, injected = false
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await open(file, ...args)
      if (file === target) {
        const read = handle.read.bind(handle)
        handle.read = async (...values) => {
          const result = await read(...values)
          if (active && !injected && fault === "held bytes" && result.bytesRead > 0) {
            values[0][0] ^= 1; injected = true
          }
          if (active && !injected && fault === "after-read version" && result.bytesRead === 0) {
            await fs.writeFile(target, "---\nstatus: cancelled\n---\n\n[Guide](../guide.md)\n"); injected = true
          }
          return result
        }
      }
      return handle
    })
    const plan = await prepare(f), lstat = fs.lstat.bind(fs)
    let parentReads = 0, targetReads = 0
    t.mock.method(fs, "lstat", async (file, ...args) => {
      const value = await lstat(file, ...args)
      if (active && file === f.source) parentReads++
      if (active && file === target) targetReads++
      if (active && !injected && (
        fault === "parent transition identity" && file === f.root ||
        fault === "last parent" && file === f.source && parentReads === 2 ||
        fault === "last target" && file === target && targetReads === 3)) {
        value.ino++; injected = true
      }
      return value
    })
    active = true
    if (fault === "parent transition identity")
      await assert.rejects(plan.refreshDirectory(plan.parentRow(f.root), []), /own parent generation changed/u)
    else if (fault === "last parent" || fault === "last target")
      await assert.rejects(plan.assertReplacementTarget(plan.rows.get("t/job/task.md")), /original replacement (parent|target) changed/u)
    else await assert.rejects(plan.assertCurrent(), /held input bytes|original file changed during currentness/u)
    assert.equal(injected, true)
    assert.deepEqual(plan.receipt.effects, [])
    await plan.close()
  })
}
posixTest("an inventory directory changed after its members were read is not admitted", async t => {
  const f = await fixture(), opendir = fs.opendir.bind(fs)
  let changed = false
  t.mock.method(fs, "opendir", async (file, ...args) => {
    const dir = await opendir(file, ...args), read = dir.read.bind(dir)
    dir.read = async () => {
      const result = await read()
      if (file === f.source && result === null && !changed) {
        changed = true
        await fs.writeFile(path.join(file, "foreign-added.txt"), "not admitted")
      }
      return result
    }
    return dir
  })
  await assert.rejects(prepare(f), /directory membership changed during inventory/u)
  assert.equal(await fs.readFile(path.join(f.source, "foreign-added.txt"), "utf8"), "not admitted")
})
for (const change of ["member spelling", "child inode"]) {
  posixTest(`directory currentness refuses a late ${change} change after its version read`, async t => {
    const f = await fixture(), plan = await prepare(f), opendir = fs.opendir.bind(fs)
    let changed = false
    t.mock.method(fs, "opendir", async (file, ...args) => {
      const dir = await opendir(file, ...args), read = dir.read.bind(dir)
      dir.read = async () => {
        const result = await read()
        if (file === f.source && !changed) {
          changed = true
          const target = path.join(f.source, "task.md")
          if (change === "member spelling") {
            if (result !== null) result.name = "foreign-name.md"
          } else {
            await fs.rename(target, `${target}.old`)
            await fs.writeFile(target, "replacement")
          }
        }
        return result
      }
      return dir
    })
    await assert.rejects(plan.assertCurrent(), change === "member spelling" ? /directory members changed/u : /directory child identity changed/u)
    assert.equal(changed, true)
    await plan.close()
  })
}
posixTest("bounded real Markdown parsing rejects pathological unfinished destinations before effects", async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.source, "task.md"), "[x](".repeat(200))
  await assert.rejects(prepare(f), { code: "archive_parse" })
})
posixTest("a planner-level unsupported entity remains a refused aggregate, not a silently unchanged link", async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.root, "t/guide&unknown;.md"), "target exists")
  await fs.writeFile(path.join(f.source, "task.md"), "[Guide](../guide&unknown;.md)")
  await assert.rejects(prepare(f), /archive link plan refused: unsupported_destination/u)
})
posixTest("a table inside opaque HTML cannot lend its line-local rewrite to a different aggregate parse", async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.root, "t/track.md"), "<div>\n| Slug | State | Doing |\n| --- | --- | --- |\n| job | cancelled | [Card](job/task.md) |\n</div>\n")
  await assert.rejects(prepare(f), { code: "archive_composition" })
})
posixTest("a frozen descriptor-close error is preserved without replacing it with an attachment error", async t => {
  const f = await fixture(), open = fs.open.bind(fs), original = Object.freeze(new Error("frozen resource close failure"))
  let cleanup
  t.mock.method(fs, "open", async (file, ...args) => {
    const handle = await open(file, ...args)
    if (file === path.join(f.source, "task.md")) {
      cleanup = handle.close.bind(handle)
      handle.close = async () => { throw original }
    }
    return handle
  })
  t.after(async () => { if (cleanup) await cleanup() })
  const plan = await prepare(f)
  await assert.rejects(plan.close(), error => error === original)
})
posixTest("a later settlement error is recorded without hiding the session's original close failure", async () => {
  const f = await fixture(), { plan, opened } = await session(f), close = plan.close
  const original = new Error("owned plan close failed")
  plan.close = async () => { await close(); throw original }
  await assert.rejects(opened.close(new Error("earlier work failed")), error => error === original)
  assert.equal(plan.receipt.closeFailure, original.message)
})
for (const timing of ["before opening", "after reading"]) {
  posixTest(`original card ancestry is renewed ${timing} without adopting the new observation`, async t => {
    const f = await fixture(), target = path.join(f.source, "task.md"), lstat = fs.lstat.bind(fs)
    let routeSeen = false, targetRoutes = 0, rootReads = 0
    t.mock.method(fs, "lstat", async (file, options) => {
      if (file === target && !options?.bigint && ++targetRoutes === 2) routeSeen = true
      const stat = await lstat(file, options)
      if (routeSeen && file === f.root && options?.bigint && ++rootReads === (timing === "before opening" ? 1 : 2)) {
        if (timing === "before opening") stat.isDirectory = () => false
        else stat.ino++
      }
      return stat
    })
    await assert.rejects(invoke(f), /original card ancestry changed/u)
    await assert.rejects(fs.lstat(f.destination), { code: "ENOENT" })
  })
}
posixTest("an originally absent card cannot appear before the final completion observation", async t => {
  const f = await fixture(), target = path.join(f.source, "task.md"), lstat = fs.lstat.bind(fs)
  await fs.unlink(target)
  let inserted = false
  t.mock.method(fs, "lstat", async (file, options) => {
    try { return await lstat(file, options) } catch (error) {
      if (!inserted && file === target && options?.bigint && error.code === "ENOENT") {
        await fs.writeFile(target, "foreign newly appeared card\n"); inserted = true
      }
      throw error
    }
  })
  await assert.rejects(invoke(f), /original absent card appeared/u)
  assert.equal(await fs.readFile(target, "utf8"), "foreign newly appeared card\n")
})
test("a successful disabled Factory observation retains explicit unknown lineage fields", async () => {
  const f = await fixture(), handoff = { deadline: null, attempts: [] }
  await requestTaskFinalize({ deskRoot: f.root, env: { ...process.env, XDG_STATE_HOME: `${f.root}-absent-state` },
    identity: {}, terminalHandoff: handoff, beforeEffect: async () => {} })
  assert.equal(handoff.status, "returned")
  assert.deepEqual(handoff.attempts[0].lineage, { deskRoot: f.root, root: null, job: null, personPrefix: null })
  assert.equal(handoff.attempts[0].result, null)
})
test("a non-Error post-barrier refusal keeps the accepted helper's effects explicitly unqualified", async () => {
  const f = await fixture(), handoff = { deadline: null, attempts: [] }
  let barriers = 0
  await assert.rejects(requestTaskFinalize({ deskRoot: f.root, env: { ...process.env, XDG_STATE_HOME: `${f.root}-absent-state` },
    identity: {}, terminalHandoff: handoff, beforeEffect: async () => { if (++barriers === 2) throw "opaque post-barrier refusal" } }),
    error => {
      assert.equal(error.archiveTerminalPending, true)
      assert.equal(error.cause, "opaque post-barrier refusal")
      return true
    })
  assert.equal(handoff.status, "unknown")
  assert.equal(handoff.attempts[0].effectState, "unknown_or_partial")
  assert.equal(handoff.attempts[0].postBarrier.reason, "opaque post-barrier refusal")
})
test("an opaque IO helper failure retains its contextual diagnostic without claiming a completed handoff", async t => {
  const f = await fixture(), handoff = { deadline: null, attempts: [] }, lstat = fs.lstat.bind(fs)
  const state = `${f.root}-absent-state`, original = { code: "EACCES" }, errors = []
  t.mock.method(console, "error", (...args) => errors.push(args))
  t.mock.method(fs, "lstat", (file, ...args) => file === path.join(state, "ouroboros-skills/desk/factory")
    ? Promise.reject(original) : lstat(file, ...args))
  await requestTaskFinalize({ deskRoot: f.root, env: { ...process.env, XDG_STATE_HOME: state },
    identity: {}, terminalHandoff: handoff, beforeEffect: async () => {} })
  assert.equal(handoff.status, "failed")
  assert.equal(handoff.attempts[0].error.message,
    `desk_factory: private factory state path ${path.join(state, "ouroboros-skills/desk/factory")} could not be inspected (EACCES)`)
  assert.deepEqual(errors, [["desk_factory: finalize_request_deferred"]])
})
posixTest("unsafe initial marker ancestry retains a typed refusal after successful metadata-only source checks", async t => {
  const f = await fixture(), lstat = fs.lstat.bind(fs)
  let changed = false
  t.mock.method(fs, "lstat", async (file, options) => {
    const stat = await lstat(file, options)
    if (!changed && file === path.join(f.root, "t") && options?.bigint) {
      changed = true; stat.isDirectory = () => false
    }
    return stat
  })
  await assert.rejects(invoke(f), error => error.archiveMarkerObservation?.reason === "archive_marker_unsafe_ancestry")
  assert.equal(changed, true)
})
for (const boundary of ["metadata staging", "commit"]) {
  test(`synthetic Git response model: a foreign staged entry before ${boundary} is retained without commit`, async () => {
    const f = await fixture(), source = "t/job/task.md", destination = "t/_archive/job/task.md"
    await fs.mkdir(path.join(f.root, ".git"))
    await fs.mkdir(path.dirname(f.destination))
    const blob = "a".repeat(40), foreign = "b".repeat(40), head = "c".repeat(40)
    const index = new Map([[source, { mode: "120000", sha: blob }]])
    let stages = 0, metadata = 0, commits = 0, barriers = 0
    const selected = (file, requested) => requested.some(prefix => file === prefix || file.startsWith(`${prefix}/`))
    const spawnGit = (command, argv, options) => {
      assert.equal(command, "git")
      const args = argv.slice(2), ok = stdout => ({ status: 0, stdout, stderr: "" })
      if (args[0] === "symbolic-ref") return ok("main\n")
      if (args[0] === "rev-parse") return ok(args.includes("--show-toplevel") ? `${f.root}\n` : `${head}\n`)
      if (args[0] === "config") return ok(args.at(-1) === "core.symlinks" ? "false\n" : "true\n")
      if (args[0] === "diff" || args[0] === "ls-files" && args.includes("--others")) return ok("")
      if (args[0] === "ls-tree") return ok(selected(source, args.slice(args.indexOf("--") + 1))
        ? `120000 blob ${blob}\t${source}\0` : "")
      if (args[0] === "ls-files") return ok([...index].filter(([file]) => selected(file, args.slice(args.indexOf("--") + 1)))
        .map(([file, value]) => `${value.mode} ${value.sha} 0\t${file}\0`).join(""))
      if (args[0] === "hash-object") return ok(`${blob}\n`)
      if (args[0] === "add") {
        stages++; index.clear(); index.set(destination, { mode: "100644", sha: blob }); return ok("")
      }
      if (args[0] === "update-index") {
        metadata++
        for (const line of options.input.split("\0").filter(Boolean)) {
          const [value, file] = line.split("\t"), [mode, sha] = value.split(" ")
          index.set(file, { mode, sha })
        }
        return ok("")
      }
      if (args[0] === "commit") commits++
      assert.fail(`unadmitted synthetic Git response: ${args.join(" ")}`)
    }
    const state = await prepareArchiveState({ effectiveRoot: f.root, srcDir: f.source, archiveDir: f.destination,
      srcFile: path.join(f.source, "task.md"), spawnGit, beforeEffect: async () => {
        barriers++
        if (stages && (boundary === "metadata staging" || metadata))
          index.set(destination, { ...index.get(destination), sha: foreign })
      } })
    await state.atUse()
    await fs.rename(f.source, f.destination); await state.afterMove()
    const result = await state.publish("owned synthetic publication")
    assert.deepEqual(result, { status: "failed", reason: boundary === "metadata staging"
      ? "staged archive changed before metadata staging; outside edits retained"
      : "staged archive changed before commit; outside edits retained" })
    assert.equal(stages, 1); assert.equal(metadata, boundary === "metadata staging" ? 0 : 1)
    assert.equal(commits, 0)
    assert.equal(index.get(destination).sha, foreign)
    assert.equal(barriers, boundary === "metadata staging" ? 3 : 4)
  })
}
for (const status of ["processing", null]) {
  posixTest(`a self-referencing step reads its bound original completion status ${status ?? "unknown"} without a legacy content read`, async () => {
    const f = await fixture(), target = path.join(f.source, "task.md")
    const before = (status ? `---\nstatus: ${status}\n---\n` : "") +
      "\n## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n| --- | --- | --- | --- | --- |\n| check | - | - | pending | task:t/job |\n"
    await fs.writeFile(target, before)
    await assert.rejects(invoke(f, { input: { track: "t", slug: "job", evidence: { kind: "steps" } } }), /steps|settled|evidence/u)
    assert.equal(await fs.readFile(target, "utf8"), before)
  })
}
test("legacy archive writes freshly derived cells and invalidates the actual changed card", async () => {
  const f = await fixture(), changes = []
  await fs.mkdir(path.join(f.root, "t/peer"))
  await fs.writeFile(path.join(f.root, "t/peer/task.md"), "---\nstatus: done\n---\n")
  await fs.writeFile(path.join(f.source, "task.md"), "---\nstatus: processing\n---\n\n## Steps\n\n| Step | Depends on | Repo | State | Evidence |\n| --- | --- | --- | --- | --- |\n| check | - | - | pending | task:t/peer |\n")
  const result = await invoke(f, { input: { track: "t", slug: "job", evidence: { kind: "steps" } },
    search: { noteChange: file => changes.push(file) },
    moveArchive: async (source, destination, beforeMove) => { await beforeMove(); await fs.rename(source, destination) } })
  assert.equal(result.status, "archived")
  assert.match(await fs.readFile(path.join(f.destination, "task.md"), "utf8"), /\| delivered \| task:t\/peer \|/u)
  assert.ok(changes.includes("t/_archive/job/task.md"))
})
posixTest("a directory read acknowledged at the mutation deadline is not an unknown returned read", async t => {
  const f = await fixture(), opendir = fs.opendir.bind(fs)
  let now = Date.now(), advanced = false
  const deadline = now + 30000
  t.mock.method(fs, "opendir", async (...args) => {
    const dir = await opendir(...args), read = dir.read.bind(dir)
    dir.read = async () => { const result = await read(); now = deadline; advanced = true; return result }
    return dir
  })
  await assert.rejects(prepare(f, { deadline, evidenceDeadline: deadline + 10000, now: () => now }), error => {
    assert.equal(error.code, "archive_deadline")
    assert.equal(error.archiveAggregate.directoryReaders[0].unknownReturns, 0)
    assert.equal(error.archiveAggregate.directoryReaders[0].entriesRead, 1)
    assert.equal(error.archiveAggregate.directoryReaders[0].closed, true)
    return true
  })
  assert.equal(advanced, true)
})
for (const closeFails of [false, true]) {
  posixTest(`a refused aggregate marker open retains its original attempted effect with close failure ${closeFails}`, async t => {
    const f = await fixture(), open = fs.open.bind(fs), original = new Error("owned marker open refused")
    let cleanup
    t.mock.method(fs, "open", async (file, ...args) => {
      if (file.endsWith(".desk-archive-operation.json")) throw original
      const handle = await open(file, ...args)
      if (closeFails && file === f.root) {
        cleanup = handle.close.bind(handle)
        handle.close = async () => { throw new Error("original directory close unavailable") }
      }
      return handle
    })
    t.after(async () => { if (cleanup) await cleanup() })
    const result = await invoke(f)
    assert.equal(result.status, "archive_pending")
    assert.equal(result.path, "t/job/task.md")
    assert.equal(result.publication.placement, "source")
    assert.equal(result.publication.effects.effects[0].kind, "marker_create")
    assert.equal(result.publication.effects.effects[0].returned, false)
    if (closeFails) assert.match(result.publication.effects.closeFailure, /close unavailable/u)
    await assert.rejects(fs.lstat(f.destination), { code: "ENOENT" })
  })
}
posixTest("a directory move refusal retains unknown placement and a separate notification failure", async t => {
  const f = await fixture(), rename = fs.rename.bind(fs), original = new Error("owned rename outcome unavailable")
  t.mock.method(fs, "rename", (...args) => args[0] === f.source && args[1] === f.destination
    ? Promise.reject(original) : rename(...args))
  const result = await invoke(f, { search: { noteChange() { throw new Error("search invalidation unavailable") } } })
  assert.equal(result.status, "archive_pending")
  assert.equal(result.path, "t/_archive/job/task.md")
  assert.equal(result.publication.placement, "unknown")
  assert.equal(result.publication.effects.notificationFailure, "search invalidation unavailable")
  assert.equal(await fs.readFile(path.join(f.source, "task.md"), "utf8"), "---\nstatus: cancelled\n---\n\n[Guide](../guide.md)\n")
})
test("legacy relocation still supports a task directory without a completion card", async () => {
  const f = await fixture()
  await fs.unlink(path.join(f.source, "task.md"))
  const result = await invoke(f, { moveArchive: async (source, destination, beforeMove) => {
    await beforeMove(); await fs.rename(source, destination)
  } })
  assert.equal(result.status, "archived")
  assert.ok((await fs.lstat(f.destination)).isDirectory())
  await assert.rejects(fs.lstat(path.join(f.destination, "task.md")), { code: "ENOENT" })
})
posixTest("a frozen original read error survives secondary generation uncertainty without attaching to that frozen error", async t => {
  const f = await fixture(), target = path.join(f.source, "task.md"), open = fs.open.bind(fs)
  const original = Object.freeze(new Error("frozen original IO unavailable")), messages = []
  t.mock.method(console, "error", (...args) => messages.push(args))
  t.mock.method(fs, "open", async (file, ...args) => {
    if (file !== target) return open(file, ...args)
    await fs.rename(f.source, `${f.source}-original`)
    await fs.mkdir(f.source)
    throw original
  })
  await assert.rejects(invoke(f), error => error === original)
  assert.deepEqual(messages, [])
  assert.equal(Object.hasOwn(original, "archiveMarkerRecheck"), false)
  assert.equal(await fs.readFile(path.join(`${f.source}-original`, "task.md"), "utf8"),
    "---\nstatus: cancelled\n---\n\n[Guide](../guide.md)\n")
})
for (const [name, before, expected] of [
  ["nested image and link", "[outer ![inner](../guide.md)](../guide.md)\n",
    "[outer ![inner](../../guide.md)](../../guide.md)\n"],
  ["multiline inline destinations", "[a](\n../guide.md\n)\n[b](../guide.md)\n",
    "[a](\n../../guide.md\n)\n[b](../../guide.md)\n"],
  ["duplicate definition ownership", "[ref] [ref][]\n\n[ref]: ../guide.md\n[ref]: ../ignored.md\n",
    "[ref] [ref][]\n\n[ref]: ../../guide.md\n[ref]: ../ignored.md\n"],
  ["malformed destination before a valid link", "[bad](../guide.md\n\n[ok](../guide.md)\n",
    "[bad](../guide.md\n\n[ok](../../guide.md)\n"],
]) test(`real extractor and planner retain monotone exact destination spans for ${name}`, () => {
  const parsed = markdown.extractMarkdownLinks(before)
  let end = 0
  for (const link of parsed.links) {
    assert.ok(link.start >= end, "real destination spans must be disjoint")
    assert.equal(before.slice(link.start, link.end), link.raw)
    end = link.end
  }
  const result = linkPlan([document(before)], [{ path: "t/guide.md", type: "regular_file", ancestry: ["directory"] }])
  assert.deepEqual(result.refusals, [])
  assert.equal(result.files[0].after, expected)
  assert.equal(result.files[0].patches.length, parsed.links.length)
  for (const patch of result.files[0].patches)
    assert.equal(Buffer.from(before).subarray(patch.byteStart, patch.byteEnd).toString(), patch.raw)
})
test("an initial focus-surface failure is preserved rather than disguised as an unfinished-operation answer", async () => {
  const f = await fixture(), original = new Error("owned focus observation unavailable")
  await fs.writeFile(path.join(f.source, ".desk-archive-operation.json"), "")
  await assert.rejects(invoke(f, { statusContext: { focus: { get() { throw original } } } }), error => error === original)
})
posixTest("a secondary focus-surface failure is logged without replacing the original IO failure", async t => {
  const f = await fixture(), target = path.join(f.source, "task.md"), open = fs.open.bind(fs)
  const original = new Error("owned original read failure"), messages = []
  t.mock.method(console, "error", (...args) => messages.push(args))
  t.mock.method(fs, "open", async (file, ...args) => {
    if (file !== target) return open(file, ...args)
    await fs.writeFile(path.join(f.source, ".desk-archive-operation.json"), "")
    throw original
  })
  await assert.rejects(invoke(f, { statusContext: { focus: { get() { throw new Error("secondary focus unavailable") } } } }),
    error => error === original)
  assert.deepEqual(messages, [["desk_archive: secondary_marker_observation_result_unavailable"]])
})
posixTest("public POSIX dependency bindings select their provider without implying execution on another host", async () => {
  for (const platform of ["darwin", "linux"]) {
    const f = await fixture(), plan = await prepare(f)
    const opened = await openArchiveMoveSession({ aggregate: plan }, { platform })
    assert.equal(opened.aggregate, true)
    await opened.close(new Error("unit route observation only"))
    assert.deepEqual(plan.receipt.effects, [])
  }
})
test("archived publication renews its public effect barrier even when Git is absent", async () => {
  const f = await fixture(), file = path.join(f.source, "task.md"), before = await fs.readFile(file)
  let barriers = 0
  const publication = await prepareArchivedCardPublication({ effectiveRoot: f.root, file, before,
    spawnGit: () => { throw new Error("no Git dispatch admitted") }, beforeEffect: async () => { barriers++ } })
  await publication.assertBefore()
  assert.equal(await publication.publish(before, "owned noGit observation"), undefined)
  assert.equal(barriers, 1)
  assert.deepEqual(await fs.readFile(file), before)
})
for (const text of ["x".repeat(301), "a word ".repeat(45)]) {
  test(`public task reports cut a long ${text.includes(" ") ? "word-separated" : "unbroken"} next step at the actual cap`, async () => {
    const f = await fixture()
    await fs.writeFile(path.join(f.source, "task.md"), "---\nstatus: processing\n---\n")
    const result = await task_update({ deskRoot: f.root, input: { track: "t", slug: "job", next_step: text },
      env: { ...process.env, XDG_STATE_HOME: `${f.root}-absent-state` }, schedulePush() {} })
    const cut = text.trim().slice(0, 300), space = cut.lastIndexOf(" ")
    assert.equal(result.report_as, `Task job is at processing (not done): ${(space > 0 ? cut.slice(0, space) : cut).trimEnd()} ... (see card)`)
    assert.equal(result.next_step, text.trim())
  })
}
test("public task update warns when the actual resulting card exceeds the boot read cap", async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.source, "task.md"), "---\nstatus: processing\n---\n\n" + "x".repeat(65537))
  const result = await task_update({ deskRoot: f.root, input: { track: "t", slug: "job", next_step: "review" },
    env: { ...process.env, XDG_STATE_HOME: `${f.root}-absent-state` }, schedulePush() {} })
  assert.match(result.card_size_warning, /Boot reads only the first 64 KB/u)
  assert.ok((await fs.stat(path.join(f.source, "task.md"))).size > 65536)
})
test("a missing Git response cannot manufacture a short HEAD", async () => {
  const f = await fixture()
  assert.equal(headSha(f.root, () => null), null)
})
test("a legacy transport's terminal uncertainty remains pending and is not converted into success", async () => {
  const f = await fixture(), original = Object.assign(new Error("accepted terminal work is unqualified"), { archiveTerminalPending: true })
  const result = await invoke(f, { moveArchive: async (_source, _destination, beforeMove) => { await beforeMove(); throw original } })
  assert.equal(result.status, "archive_pending")
  assert.equal(result.publication.reason, original.message)
  assert.deepEqual(result.terminal_handoff.attempts, [])
  assert.ok((await fs.lstat(f.source)).isDirectory())
  await assert.rejects(fs.lstat(f.destination), { code: "ENOENT" })
})
for (const relative of ["ancestor", "descendant"]) {
  test(`created-directory cleanup does not remove a live ${relative} caller's directory`, async () => {
    const f = await fixture(), directory = path.join(f.root, "created/deep")
    const other = relative === "ancestor" ? path.dirname(directory) : path.join(directory, "child")
    let release, entered, fail, firstEntered
    const wait = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve })
    const firstReady = new Promise(resolve => { firstEntered = resolve })
    const blocked = new Promise(resolve => { fail = resolve }), original = new Error("first caller failed")
    const first = assert.rejects(withCreatedDirs(directory, async () => { firstEntered(); await blocked; throw original }), error => error === original)
    await firstReady
    const second = withCreatedDirs(other, async () => { entered(); await wait })
    await ready; fail(); await first
    assert.ok((await fs.stat(other)).isDirectory())
    release(); await second
  })
}
test("a created-directory cleanup refusal cannot replace the original work error", async () => {
  const f = await fixture(), directory = path.join(f.root, "cleanup-refusal"), original = new Error("work failed")
  let removals = 0
  await assert.rejects(withCreatedDirs(directory, async () => { throw original }, {
    remove: async () => { removals++; throw new Error("directory removal refused") },
  }), error => error === original)
  assert.equal(removals, 1)
  assert.ok((await fs.stat(directory)).isDirectory())
})
posixTest("a transient pre-move reader failure removes only the owned empty archive parent while retaining its marker", async t => {
  const f = await fixture(), opendir = fs.opendir.bind(fs), parent = path.dirname(f.destination)
  let injected = false
  t.mock.method(fs, "opendir", async (file, ...args) => {
    if (!injected && file === f.source && await fs.stat(parent).then(() => true, () => false)) {
      injected = true
      throw new Error("owned pre-move reader failed")
    }
    return opendir(file, ...args)
  })
  const result = await invoke(f)
  assert.equal(injected, true)
  assert.equal(result.status, "archive_pending")
  assert.equal(result.publication.placement, "source")
  assert.equal(result.publication.reason, "owned pre-move reader failed")
  await assert.rejects(fs.lstat(parent), { code: "ENOENT" })
  assert.equal(await fs.readFile(path.join(f.source, ".desk-archive-operation.json"), "utf8"), '{"state":"unfinished"}\n')
})
test("an opaque accepted Factory environment observation preserves a falsy error diagnostic", async t => {
  const f = await fixture(), env = { ...process.env }, handoff = { deadline: null, attempts: [] }, messages = []
  Object.defineProperty(env, "XDG_STATE_HOME", { get() { throw 0 } })
  t.mock.method(console, "error", (...args) => messages.push(args))
  await requestTaskFinalize({ deskRoot: f.root, env, identity: {}, terminalHandoff: handoff, beforeEffect: async () => {} })
  assert.equal(handoff.status, "failed")
  assert.equal(handoff.attempts.length, 1)
  assert.equal(handoff.attempts[0].error.message, "0")
  assert.deepEqual(messages, [["desk_factory: finalize_request_deferred"]])
})
posixTest("an unavailable terminal lineage never dispatches finalize or evaluation under an invented identity", async t => {
  const f = await fixture(), unlink = fs.unlink.bind(fs), realpath = fs.realpath.bind(fs), messages = []
  let retired = false, rootReads = 0, rejected = false
  t.mock.method(console, "error", (...args) => messages.push(args))
  t.mock.method(fs, "unlink", async file => {
    const result = await unlink(file)
    if (file === path.join(f.destination, ".desk-archive-operation.json")) retired = true
    return result
  })
  t.mock.method(fs, "realpath", async (file, ...args) => {
    if (retired && file === f.root && ++rootReads === 3) {
      rejected = true
      throw new Error("owned terminal identity observation failed")
    }
    return realpath(file, ...args)
  })
  const result = await invoke(f)
  assert.equal(rejected, true)
  assert.equal(result.status, "archived")
  assert.deepEqual(result.terminal_handoff.attempts, [])
  assert.deepEqual(messages, [["desk_factory: finalize_request_deferred"], ["desk_factory: evaluation_request_deferred"]])
})
for (const [label, failureContext, preservesPrimary] of [
  ["absent context", undefined, false],
  ["empty context", {}, false],
  ["inherited primary only", Object.create({ primary: new Error("not an explicit operation failure") }), false],
  ["frozen error primary", { primary: Object.freeze(new Error("original operation failed")) }, true],
  ["false primary", { primary: false }, true],
  ["zero primary", { primary: 0 }, true],
  ["empty-string primary", { primary: "" }, true],
  ["null primary", { primary: null }, true],
  ["undefined primary", { primary: undefined }, true],
]) {
  posixTest(`public aggregate owner settlement with ${label} attempts every owned handle once and preserves the exact primary policy`, async t => {
    const f = await fixture(), open = fs.open.bind(fs), opendir = fs.opendir.bind(fs)
    const secondary = Object.freeze(new Error("owned descriptor close response was lost")), resources = []
    t.mock.method(fs, "open", async (file, ...args) => {
      const handle = await open(file, ...args), close = handle.close.bind(handle)
      const record = { file, handle, attempts: 0, closedInFixture: false }
      resources.push(record)
      handle.close = async () => {
        record.attempts++
        await close()
        record.closedInFixture = true
        if (file === f.root) throw secondary
      }
      return handle
    })
    t.mock.method(fs, "opendir", async (file, ...args) => {
      const dir = await opendir(file, ...args), close = dir.close.bind(dir)
      const record = { file, attempts: 0, closedInFixture: false }
      resources.push(record)
      dir.close = async () => { record.attempts++; await close(); record.closedInFixture = true }
      return dir
    })
    const plan = await prepare(f), original = failureContext?.primary
    if (preservesPrimary) {
      await assert.doesNotReject(plan.close(failureContext))
      assert.equal(failureContext.primary, original)
      assert.equal(plan.receipt.closeFailure, secondary.message)
    } else await assert.rejects(plan.close(failureContext), error => error === secondary)
    assert.ok(resources.length > 3)
    assert.ok(resources.every(resource => resource.closedInFixture && resource.attempts === 1))
    const rootRecord = plan.receipt.descriptors.find(record => record.file === f.root)
    assert.equal(rootRecord.closeUnknown, true)
    assert.equal(rootRecord.closed, false, "a lost close acknowledgement must not become confirmed closure")
    assert.ok(plan.receipt.descriptors.filter(record => record !== rootRecord).every(record => record.closed))
    await plan.close()
    await plan.close({ primary: new Error("later error cannot reopen or replay settlement") })
    assert.ok(resources.every(resource => resource.attempts === 1))
    assert.deepEqual(plan.receipt.effects, [])
  })
}
posixTest("public aggregate owner settlement with a primary but no close failure never invents a secondary error", async () => {
  const f = await fixture(), plan = await prepare(f), primary = Object.freeze(new Error("original failure"))
  await plan.close({ primary })
  assert.equal(Object.hasOwn(plan.receipt, "closeFailure"), false)
  assert.ok(plan.receipt.descriptors.every(record => record.closed))
  assert.ok(plan.receipt.directoryReaders.every(record => record.closed))
  await plan.close({ primary: false })
})
