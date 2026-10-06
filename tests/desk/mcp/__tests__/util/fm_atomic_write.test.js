// writeMarkdown with `atomic`: the card is written beside itself and renamed over, and a failed write leaves no temporary file.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { mkTempDeskRoot } from "../tools/_helpers.js"

test("an atomic write replaces the file, following a symlink, and leaves nothing beside it", async () => {
  const root = await mkTempDeskRoot()
  const real = path.join(root, "real.md")
  const link = path.join(root, "link.md")
  await fs.writeFile(real, "old")
  await fs.symlink(real, link)
  await writeMarkdown(link, { a: 1 }, "body\n", { atomic: true })
  assert.match(await fs.readFile(real, "utf8"), /a: 1[\s\S]*body/u)
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
  assert.deepEqual((await fs.readdir(root)).sort(), ["link.md", "real.md"])
})

test("a failed atomic write removes its temporary file and throws", async () => {
  const root = await mkTempDeskRoot()
  const target = path.join(root, "card")
  await fs.mkdir(path.join(target, "inside"), { recursive: true })
  await assert.rejects(writeMarkdown(target, { a: 1 }, "b", { atomic: true }))
  assert.deepEqual((await fs.readdir(root)).sort(), ["card"])
})
