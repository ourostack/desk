import { test, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { inspectDeskMutation, withDeskMutation } from "../../../../../plugins/desk/mcp/src/util/desk-mutation.js"
import { mkTempDeskRoot } from "./_helpers.js"

const ownedRoots = new Set()
after(async () => {
  for (const root of ownedRoots) await assert.rejects(fs.lstat(root), { code: "ENOENT" })
})

test("review residual: owner exit is diagnosed but cannot authorize recovery of unknown child custody", async () => {
  const root = await mkTempDeskRoot()
  ownedRoots.add(root)
  const module = pathToFileURL(path.resolve(import.meta.dirname, "../../../../../plugins/desk/mcp/src/util/desk-mutation.js"))
  const script = `import {withDeskMutation} from ${JSON.stringify(String(module))};await withDeskMutation(${JSON.stringify(root)},()=>process.exit(0))`
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 })
  assert.equal(child.status, 0, child.stderr)
  const file = path.join(root, ".desk-mutation.lock")
  const before = await fs.readFile(file, "utf8")
  const record = JSON.parse(before)
  assert.equal(record.pid, child.pid)
  assert.ok(record.start)
  assert.ok(record.token)
  const owner = await inspectDeskMutation(root)
  assert.ok(["ended_children_unqualified", "pid_reused", "unknown"].includes(owner.state))
  await assert.rejects(withDeskMutation(root, () => assert.fail("an ended PID is not child-closure authority")),
    (error) => error.code === "desk_mutation_busy" && error.owner_state !== "live")
  assert.equal(await fs.readFile(file, "utf8"), before)
})
