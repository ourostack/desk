import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { withCreatedDirs } from "../../../../../plugins/desk/mcp/src/util/created-dirs.js"
import { mkTempDeskRoot, exists } from "../tools/_helpers.js"

for (const uncertainIsParent of [true, false]) {
  test(`created-directory retention follows current ${uncertainIsParent ? "descendant" : "ancestor"} users, not unrelated users`, async () => {
    const root = await mkTempDeskRoot(), parent = path.join(root, "parent"), child = path.join(parent, "child")
    const unrelated = path.join(root, "unrelated")
    const pending = []
    async function held(directory, cleanup) {
      let entered, release
      const started = new Promise(resolve => { entered = resolve })
      const wait = new Promise(resolve => { release = resolve })
      const promise = withCreatedDirs(directory, async () => {
        entered()
        await wait
        throw new Error("controlled")
      }, { shouldCleanup: () => cleanup })
      const rejected = assert.rejects(promise, /controlled/)
      pending.push(rejected)
      await started
      return { release, rejected }
    }
    const p = await held(parent, !uncertainIsParent)
    const c = await held(child, uncertainIsParent)
    const other = await held(unrelated, true)
    const uncertain = uncertainIsParent ? p : c, ordinary = uncertainIsParent ? c : p
    uncertain.release()
    await uncertain.rejected
    ordinary.release()
    other.release()
    await Promise.all(pending)
    assert.equal(await exists(parent), true)
    assert.equal(await exists(child), true)
    assert.equal(await exists(unrelated), false)
    await fs.rename(parent, path.join(root, "retained"))
    await assert.rejects(withCreatedDirs(child, async () => { throw new Error("fresh") }), /fresh/)
    assert.equal(await exists(parent), false)
  })
}
