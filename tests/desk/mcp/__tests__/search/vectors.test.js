import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { openVectorStore, vectorsDbPath } from "../../../../../plugins/desk/mcp/src/search/vectors.js"
import { mkTempRoot } from "../_temp_roots.js"

test("vectors are kept by text hash and model, survive reopening, and the first write wins", async () => {
  const stateDir = path.join(await mkTempRoot("desk-vectors-"), ".state")
  assert.equal(vectorsDbPath(stateDir), path.join(stateDir, "desk-vectors.sqlite"))
  const store = openVectorStore(stateDir, "model-a")
  store.save([["hash-1", new Float32Array([1, 0])], ["hash-2", new Float32Array([0, 1])]])
  store.save([["hash-1", new Float32Array([5, 5])]])
  store.close()
  const reopened = openVectorStore(stateDir, "model-a")
  assert.deepEqual([...reopened.vectors.keys()].sort(), ["hash-1", "hash-2"])
  assert.deepEqual([...reopened.vectors.get("hash-1")], [1, 0])
  reopened.close()
  const other = openVectorStore(stateDir, "model-b")
  assert.equal(other.vectors.size, 0)
  other.close()
})

test("a damaged vectors file is moved aside and a fresh one is started; other open failures are thrown", async () => {
  const stateDir = path.join(await mkTempRoot("desk-vectors-corrupt-"), ".state")
  mkdirSync(stateDir, { recursive: true })
  const file = vectorsDbPath(stateDir)
  writeFileSync(file, "this is not a database, it is long enough to have a header".repeat(20))
  writeFileSync(`${file}-wal`, "")
  const store = openVectorStore(stateDir, "model-a", { now: () => 7 })
  assert.equal(store.vectors.size, 0)
  store.save([["hash-1", new Float32Array([1, 0])]])
  store.close()
  assert.match(readFileSync(`${file}.corrupt-7`, "utf8"), /not a database/u)
  assert.equal(existsSync(`${file}.corrupt-7-wal`), true)
  const again = openVectorStore(stateDir, "model-a")
  assert.equal(again.vectors.size, 1)
  again.close()

  const blocked = path.join(await mkTempRoot("desk-vectors-dir-"), ".state")
  mkdirSync(vectorsDbPath(blocked), { recursive: true })
  assert.throws(() => openVectorStore(blocked, "model-a"), (error) => error.code !== "SQLITE_NOTADB")
})
