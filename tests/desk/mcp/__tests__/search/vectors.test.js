import { test } from "node:test"
import assert from "node:assert/strict"
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
