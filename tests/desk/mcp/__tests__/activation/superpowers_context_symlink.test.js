import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isEntrypoint } from "../../../../../plugins/desk/mcp/src/activation/superpowers-context.js"

const real = fileURLToPath(new URL("../../../../../plugins/desk/mcp/src/activation/superpowers-context.js", import.meta.url))

async function linked(t) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "context-link-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const link = path.join(dir, "context-link.js")
  await fs.symlink(real, link)
  return link
}

test("the context CLI reports its diagnostic when started through a symlink instead of exiting silently", async (t) => {
  const link = await linked(t)
  const result = spawnSync(process.execPath, [link, "--desk-root", "/desk"], { encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /^Superpowers context: taskPath is required: pass --task-path <desk>\/<track>\/<task>, the task's folder .* for example \/desk\/<track>\/<task>\n$/u)
})

test("isEntrypoint compares real paths, and is false for no argv entry, a missing file or another module", async (t) => {
  const link = await linked(t)
  assert.equal(isEntrypoint(link, new URL(`file://${real}`).href), true)
  assert.equal(isEntrypoint(real, new URL(`file://${real}`).href), true)
  assert.equal(isEntrypoint("", new URL(`file://${real}`).href), false, "no argv entry")
  assert.equal(isEntrypoint(undefined, new URL(`file://${real}`).href), false, "the default argv entry is the test runner, not this module")
  assert.equal(isEntrypoint("/no/such/entry.js", new URL(`file://${real}`).href), false)
  assert.equal(isEntrypoint(link, new URL("file:///no/such/module.js").href), false)
  assert.equal(isEntrypoint(fileURLToPath(import.meta.url), new URL(`file://${real}`).href), false)
})
