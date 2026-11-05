import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import Database from "better-sqlite3"
import { createSearchEngine } from "../../../../../plugins/desk/mcp/src/search/engine.js"
import { searchRouter } from "../../../../../plugins/desk/mcp/src/search/files-router.js"
import { mkTempDeskRoot, writeFile } from "../tools/_search_helpers.js"

async function fixture(t) {
  const deskRoot = await mkTempDeskRoot()
  await writeFile(deskRoot, "work/one/task.md", "---\nstatus: processing\nupdated: 2026-10-29\n---\nseedword\n")
  let closed = false
  const engine = createSearchEngine({
    deskRoot, semantic: "unsupported",
    watch: () => ({ on() {}, close() { closed = true } }),
    cleanup: () => ({ removed: false, bytes: 0 }),
  })
  t.after(async () => {
    await engine.close()
    assert.equal(closed, true)
  })
  await engine.reindex()
  await engine.settled()
  let fault = null
  let beforeFault = () => {}
  const prepare = Database.prototype.prepare
  t.mock.method(Database.prototype, "prepare", function (sql, ...args) {
    // This statement belongs to the engine's index transaction, not the direct corpus.
    if (fault && sql === "SELECT id, path, hash FROM docs") {
      beforeFault()
      throw fault
    }
    return prepare.call(this, sql, ...args)
  })
  return {
    deskRoot, engine, router: searchRouter(engine),
    fail(code, onFault = () => {}) {
      beforeFault = onFault
      fault = Object.assign(new Error(`injected index failure: ${code}`), { code })
      engine.noteChange("work/one/task.md")
      return fault
    },
    restore() { fault = null },
  }
}

test("GivenWarmIndex_WhenItsTransactionFails_SearchReadsFreshFilesAndRestoresIndexTwice", async (t) => {
  const { deskRoot, engine, router, fail, restore } = await fixture(t)
  const now = Date.parse("2026-10-30T12:00:00Z")
  for (const token of ["freshmapleone", "freshmapletwo"]) {
    const body = `---\nstatus: processing\nupdated: 2026-10-29\n---\n${token}\n`
    await writeFile(deskRoot, "work/one/task.md", body)
    fail("SQLITE_IOERR")
    const result = await router.lexical({ deskRoot, kind: "lexical", query: token, now })
    assert.deepEqual(result.results.map(row => [row.path, row.status]), [["work/one/task.md", "processing"]])
    assert.equal(result.search_mode, "lexical")
    assert.ok(result.results[0].snippet.includes(token))
    assert.equal(await fs.readFile(path.join(deskRoot, "work/one/task.md"), "utf8"), body)
    assert.deepEqual(engine.searchStatus(), {
      state: "index_unavailable", lexical_backend: "files", index_error: "SQLITE_IOERR",
      message: "The search index is unavailable; exact-word searches read current files.",
    })
    restore()
    const indexed = await router.lexical({ deskRoot, kind: "lexical", query: token, now })
    assert.deepEqual(indexed.results, result.results)
    assert.equal(engine.searchStatus().state, "exact_words_only")
    assert.equal(engine.searchStatus().index_error, undefined)
  }
})

test("GivenRecoverableIndexFailures_WhenTimelineRuns_RecoveryPreservesFiltersAndLimits", async (t) => {
  const { deskRoot, router, fail } = await fixture(t)
  await writeFile(deskRoot, "work/two/task.md", "---\nstatus: blocked\nupdated: 2026-10-30\n---\nseedword\n")
  for (const code of ["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_IOERR_READ"]) {
    fail(code)
    const result = await router.lexical({
      deskRoot, kind: "timeline", query: "seedword", from: "2026-10-30", to: "2026-10-31",
      scope: "active", limit: 1,
    })
    assert.deepEqual(result.results.map(row => row.path), ["work/two/task.md"])
  }
})

test("GivenIndexFailure_WhenRequestNamesAnotherRoot_RecoveryStaysInBoundDesk", async (t) => {
  const { router, fail } = await fixture(t)
  const otherRoot = await mkTempDeskRoot()
  await writeFile(otherRoot, "other/task.md", "seedword\n")
  fail("SQLITE_IOERR")
  const result = await router.lexical({ deskRoot: otherRoot, query: "seedword" })
  assert.deepEqual(result.results.map(row => row.path), ["work/one/task.md"])
})

test("GivenRecoveredFiles_WhenNextReadIsDenied_DiagnosticsDoNotReuseSuccess", async (t) => {
  const { deskRoot, engine, router, fail } = await fixture(t)
  fail("SQLITE_IOERR")
  await router.lexical({ deskRoot, query: "seedword" })
  const readdir = fs.readdir
  const denied = Object.assign(new Error("synthetic filesystem refusal"), { code: "EACCES" })
  t.mock.method(fs, "readdir", async function (root, ...args) {
    if (root === deskRoot) throw denied
    return readdir.call(this, root, ...args)
  })
  await assert.rejects(router.lexical({ deskRoot, query: "seedword" }), actual => actual === denied)
  assert.equal(engine.searchStatus().lexical_backend, "unavailable")
})

test("GivenIndexFailure_WhenFilesAreAddedOrDeleted_RecoveryUsesCurrentCorpusAndFilters", async (t) => {
  const { deskRoot, router, fail } = await fixture(t)
  await fs.unlink(path.join(deskRoot, "work/one/task.md"))
  await writeFile(deskRoot, "work/new/task.md", "---\nstatus: blocked\n---\nseedword\n")
  fail("SQLITE_IOERR")
  const result = await router.lexical({ deskRoot, query: "seedword", filters: { status: "blocked" }, limit: 1 })
  assert.deepEqual(result.results.map(row => row.path), ["work/new/task.md"])
  assert.deepEqual((await router.lexical({ deskRoot, query: "absentword" })).results, [])
  assert.deepEqual((await router.lexical({ deskRoot, query: "" })).results, [])
})

test("GivenDeniedOrUnknownFailure_WhenSearchRuns_ItDoesNotFallBack", async (t) => {
  const { deskRoot, router, fail } = await fixture(t)
  for (const code of ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "SQLITE_AUTH", "SQLITE_PERM", "SQLITE_READONLY", "SQLITE_ERROR", "permission_denied", "artifact_tombstone_ledger_invalid"]) {
    const error = fail(code)
    await assert.rejects(router.lexical({ deskRoot, query: "seedword" }), actual => actual === error)
  }
})

test("GivenIndexFailure_WhenRequestNeedsUnsupportedSemantics_ItDoesNotFallBack", async (t) => {
  const { deskRoot, engine, router, fail } = await fixture(t)
  for (const kind of ["thread", "unsupported"]) {
    const error = fail("SQLITE_IOERR")
    await assert.rejects(router.lexical({ deskRoot, kind, query: "seedword", start_path: "work/one/task.md" }), actual => actual === error)
  }
  for (const request of [{ kind: "similar", path: "work/one/task.md" }, { kind: "recall", topic: "seedword" }]) {
    const error = fail("SQLITE_IOERR")
    await assert.rejects(engine.semantic(request), actual => actual === error)
  }
  const error = fail("SQLITE_IOERR")
  await assert.rejects(engine.reindex(), actual => actual === error)
})

test("GivenIndexFailure_WhenFallbackCannotReadFilesystem_ItDoesNotReturnEmptySuccess", async (t) => {
  const { deskRoot, router, fail } = await fixture(t)
  fail("SQLITE_IOERR")
  const readdir = fs.readdir
  const denied = Object.assign(new Error("synthetic filesystem refusal"), { code: "EACCES" })
  let reads = 0
  t.mock.method(fs, "readdir", async function (root, ...args) {
    if (root === deskRoot && ++reads > 1) throw denied
    return readdir.call(this, root, ...args)
  })
  await assert.rejects(router.lexical({ deskRoot, query: "seedword" }), actual => actual === denied)
})

test("GivenIndexFailure_WhenFallbackIsAborted_ItDoesNotReturnResults", async (t) => {
  const { deskRoot, router, fail } = await fixture(t)
  fail("SQLITE_IOERR")
  await assert.rejects(router.lexical({ deskRoot, query: "seedword", signal: AbortSignal.abort() }), { name: "AbortError" })
})

test("GivenIndexFailure_WhenIndividualRecoveryFileReadOrStatFails_ItRejectsWithoutSuccessDiagnostics", async (t) => {
  const { deskRoot, engine, router, fail, restore } = await fixture(t)
  const target = path.join(deskRoot, "work/one/task.md")
  let recovering = false
  let operation
  let sourceError
  for (const method of ["readFile", "stat"]) {
    const original = fs[method]
    t.mock.method(fs, method, async function (file, ...args) {
      if (recovering && method === operation && file === target) throw sourceError
      return original.call(this, file, ...args)
    })
  }
  for (operation of ["readFile", "stat"]) {
    for (const code of ["EACCES", "EPERM", "EIO", "ENOENT", undefined]) {
      await t.test(`${operation} ${code ?? "unknown error"}`, async () => {
        recovering = false
        sourceError = Object.assign(new Error(`synthetic individual-file ${operation} failure`), { code })
        fail("SQLITE_IOERR", () => { recovering = true })
        await assert.rejects(router.lexical({ deskRoot, query: "seedword", strict: false }), error => error === sourceError)
        assert.equal(engine.searchStatus().lexical_backend, "unavailable")
        recovering = false
        restore()
        const result = await router.lexical({ deskRoot, query: "seedword" })
        assert.deepEqual(result.results.map(row => row.path), ["work/one/task.md"])
        assert.equal(engine.searchStatus().state, "exact_words_only")
      })
    }
  }
})

test("GivenIndexFailure_WhenCancelledDuringIndividualRecoveryReadOrStat_ItRejectsWithoutSuccessDiagnostics", async (t) => {
  const { deskRoot, engine, router, fail } = await fixture(t)
  const target = path.join(deskRoot, "work/one/task.md")
  let recovering = false
  let operation
  let controller
  for (const method of ["readFile", "stat"]) {
    const original = fs[method]
    t.mock.method(fs, method, async function (file, ...args) {
      const result = await original.call(this, file, ...args)
      if (recovering && method === operation && file === target) controller.abort()
      return result
    })
  }
  for (operation of ["readFile", "stat"]) {
    await t.test(operation, async () => {
      recovering = false
      controller = new AbortController()
      fail("SQLITE_IOERR", () => { recovering = true })
      await assert.rejects(router.lexical({ deskRoot, query: "seedword", signal: controller.signal }), { name: "AbortError" })
      assert.equal(engine.searchStatus().lexical_backend, "unavailable")
    })
  }
})

test("GivenIndexFailure_WhenFilesAreExcludedOrRedacted_RecoveryKeepsPolicy", async (t) => {
  const { deskRoot, router, fail } = await fixture(t)
  const pluginRoot = await mkTempDeskRoot()
  const outsideRoot = await mkTempDeskRoot()
  await writeFile(deskRoot, ".gitignore", "hidden/\n")
  await writeFile(deskRoot, "hidden/task.md", "seedword\n")
  await writeFile(deskRoot, "redacted/task.md", "seedword private\n")
  await writeFile(outsideRoot, "task.md", "seedword outside\n")
  await fs.symlink(outsideRoot, path.join(deskRoot, "linked"), process.platform === "win32" ? "junction" : "dir")
  await writeFile(pluginRoot, "artifacts/tombstones/tombstones.jsonl", JSON.stringify({
    schema_version: 1, document_path: "redacted/task.md",
    document_hash: `sha256:${createHash("sha256").update("seedword private\n").digest("hex")}`,
    reason: "redacted", redacted_at: "2026-10-30T00:00:00Z",
    effective_from: "2026-10-30T00:00:00Z", artifact_rotation_id: "fixture", actor: "fixture",
  }) + "\n")
  const previous = process.env.DESK_PLUGIN_ROOT
  process.env.DESK_PLUGIN_ROOT = pluginRoot
  t.after(() => {
    if (previous === undefined) delete process.env.DESK_PLUGIN_ROOT
    else process.env.DESK_PLUGIN_ROOT = previous
  })
  fail("SQLITE_IOERR")
  const result = await router.lexical({ deskRoot, query: "seedword" })
  assert.deepEqual(result.results.map(row => row.path), ["work/one/task.md"])
  await writeFile(pluginRoot, "artifacts/tombstones/tombstones.jsonl", "invalid ledger")
  await assert.rejects(router.lexical({ deskRoot, query: "seedword" }), { code: "artifact_tombstone_ledger_invalid" })
})

test("GivenRecoveredIndex_WhenRestorationCannotReadUnchangedFiles_ItDoesNotClaimRestoration", async (t) => {
  const { deskRoot, engine, router, fail, restore } = await fixture(t)
  const target = path.join(deskRoot, "work/one/task.md")
  for (const method of ["readFile", "stat"]) {
    await t.test(method, async (st) => {
      fail("SQLITE_IOERR")
      await router.lexical({ query: "seedword" })
      restore()
      const original = fs[method]
      const denied = Object.assign(new Error(`synthetic restoration ${method} refusal`), { code: "EACCES" })
      const mock = st.mock.method(fs, method, async function (file, ...args) {
        if (file === target) throw denied
        return original.call(this, file, ...args)
      })
      await assert.rejects(router.lexical({ query: "seedword" }), error => error === denied)
      assert.equal(engine.searchStatus().state, "index_unavailable")
      assert.equal(engine.searchStatus().lexical_backend, "unavailable")
      mock.mock.restore()
      assert.deepEqual((await router.lexical({ query: "seedword" })).results.map(row => row.path), ["work/one/task.md"])
      assert.equal(engine.searchStatus().state, "exact_words_only")
    })
  }
})

test("GivenRecoveryAddsFiles_WhenRestoredIndexChangesAgain_ItKeepsTheCompleteCorpus", async (t) => {
  const { deskRoot, engine, router, fail, restore } = await fixture(t)
  await writeFile(deskRoot, "work/two/task.md", "seedword\n")
  fail("SQLITE_IOERR")
  await router.lexical({ query: "seedword" })
  restore()
  assert.deepEqual((await router.lexical({ query: "seedword" })).results.map(row => row.path).sort(),
    ["work/one/task.md", "work/two/task.md"])
  await writeFile(deskRoot, "work/one/task.md", "seedword changed\n")
  engine.noteChange("work/one/task.md")
  assert.deepEqual((await router.lexical({ query: "seedword" })).results.map(row => row.path).sort(),
    ["work/one/task.md", "work/two/task.md"])
})

test("GivenOverlappingRecovery_WhenNewerFilesReadFails_OlderSuccessCannotReplaceItsDiagnostics", async (t) => {
  const { deskRoot, engine, router, fail } = await fixture(t)
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let reached
  const waiting = new Promise(resolve => { reached = resolve })
  t.after(() => release())
  const readFile = fs.readFile
  const featured = path.join(deskRoot, "_meta/featured.md")
  const target = path.join(deskRoot, "work/one/task.md")
  const denied = Object.assign(new Error("synthetic newer read refusal"), { code: "EACCES" })
  let deny = false
  t.mock.method(fs, "readFile", async function (file, ...args) {
    if (file === featured) {
      reached()
      await blocked
    }
    if (deny && file === target) throw denied
    return readFile.call(this, file, ...args)
  })
  fail("SQLITE_IOERR")
  const older = router.lexical({ query: "seedword" })
  await waiting
  deny = true
  await assert.rejects(router.lexical({ query: "seedword" }), error => error === denied)
  assert.equal(engine.searchStatus().lexical_backend, "unavailable")
  release()
  assert.deepEqual((await older).results.map(row => row.path), ["work/one/task.md"])
  assert.equal(engine.searchStatus().lexical_backend, "unavailable")
})

test("GivenRecovery_WhenAbortedDuringFinalRankingRead_ItDoesNotAdmitResults", async (t) => {
  const { deskRoot, engine, router, fail } = await fixture(t)
  const controller = new AbortController()
  const readFile = fs.readFile
  const featured = path.join(deskRoot, "_meta/featured.md")
  t.mock.method(fs, "readFile", async function (file, ...args) {
    if (file === featured) controller.abort()
    return readFile.call(this, file, ...args)
  })
  fail("SQLITE_IOERR")
  await assert.rejects(router.lexical({ query: "seedword", signal: controller.signal }), { name: "AbortError" })
  assert.equal(engine.searchStatus().lexical_backend, "unavailable")
})
