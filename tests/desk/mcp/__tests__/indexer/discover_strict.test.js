import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { discover, createDiscoverCache, useForNextDiscover } from "../../../../../plugins/desk/mcp/src/indexer/discover.js"
import { directLexicalSearch } from "../../../../../plugins/desk/mcp/src/search/direct-lexical.js"
import { mkTempDeskRoot, writeFile } from "../tools/_search_helpers.js"

test("GivenUnreadableIndividualFile_WhenRecoveryIsStrict_ItRejectsWhileDefaultDiscoveryStillSkips", async (t) => {
  const deskRoot = await mkTempDeskRoot()
  await writeFile(deskRoot, "work/one/task.md", "sentinelword\n")
  const target = path.join(deskRoot, "work/one/task.md")
  const readFile = fs.readFile
  const denied = Object.assign(new Error("synthetic read refusal"), { code: "EACCES" })
  t.mock.method(fs, "readFile", async function (file, ...args) {
    if (file === target) throw denied
    return readFile.call(this, file, ...args)
  })
  assert.deepEqual(await discover(deskRoot), [])
  assert.deepEqual((await directLexicalSearch({ deskRoot, query: "sentinelword" })).results, [])
  await assert.rejects(discover(deskRoot, { strict: true }), error => error === denied)
  await assert.rejects(directLexicalSearch({ deskRoot, query: "sentinelword" }, { strict: true }), error => error === denied)
})

test("GivenCachedCorpus_WhenRecoveryIsStrict_ItRereadsFilesInsteadOfAdmittingCachedSuccess", async (t) => {
  const deskRoot = await mkTempDeskRoot()
  await writeFile(deskRoot, "work/one/task.md", "sentinelword\n")
  const target = path.join(deskRoot, "work/one/task.md")
  const cache = createDiscoverCache()
  assert.equal((await discover(deskRoot, { cache })).length, 1)
  const readFile = fs.readFile
  const denied = Object.assign(new Error("synthetic read refusal"), { code: "EPERM" })
  t.mock.method(fs, "readFile", async function (file, ...args) {
    if (file === target) throw denied
    return readFile.call(this, file, ...args)
  })
  assert.equal((await discover(deskRoot, { cache })).length, 1)
  await assert.rejects(discover(deskRoot, { cache, strict: true }), error => error === denied)
  useForNextDiscover(deskRoot, cache, new Set())
  t.after(() => useForNextDiscover(null))
  await assert.rejects(discover(deskRoot, { strict: true }), error => error === denied)
})

test("GivenMissingCorpusRoot_WhenRecoveryIsStrict_ItRejectsInsteadOfReturningEmptySuccess", async () => {
  const deskRoot = path.join(await mkTempDeskRoot(), "missing")
  assert.deepEqual(await discover(deskRoot), [])
  assert.deepEqual((await directLexicalSearch({ deskRoot, query: "sentinelword" })).results, [])
  await assert.rejects(discover(deskRoot, { strict: true }), { code: "ENOENT" })
  await assert.rejects(directLexicalSearch({ deskRoot, query: "sentinelword" }, { strict: true }), { code: "ENOENT" })
})
