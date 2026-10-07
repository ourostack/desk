// writeMarkdown with `atomic`: the card is written beside itself and renamed over, and a failed write leaves no temporary file.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { mkTempDeskRoot } from "../tools/_helpers.js"
import { NO_POSIX_MODES } from "../_platform.js"

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

test("many concurrent atomic writes to one card all succeed and leave one whole card", async () => {
  const root = await mkTempDeskRoot()
  const file = path.join(root, "card.md")
  await fs.writeFile(file, "old")
  await Promise.all(Array.from({ length: 30 }, (_, index) => writeMarkdown(file, { n: index }, `body ${index}\n`, { atomic: true })))
  assert.match(await fs.readFile(file, "utf8"), /^---\n'?n'?: \d+\n---\n\nbody \d+\n$/u)
  assert.deepEqual(await fs.readdir(root), ["card.md"])
})

test("an atomic write keeps the card's file mode", { skip: NO_POSIX_MODES }, async () => {
  const root = await mkTempDeskRoot()
  const file = path.join(root, "card.md")
  await fs.writeFile(file, "old")
  await fs.chmod(file, 0o640)
  await writeMarkdown(file, { a: 1 }, "b", { atomic: true })
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640)
})

test("a rename refused because the card is held open falls back to writing it in place, and any other failure surfaces even when cleanup fails too", async () => {
  const root = await mkTempDeskRoot()
  const file = path.join(root, "card.md")
  await fs.writeFile(file, "old")
  const { rename, rm } = fs
  try {
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
      fs.rename = async () => { throw Object.assign(new Error("held"), { code }) }
      await writeMarkdown(file, { code }, "fallback\n", { atomic: true })
      assert.match(await fs.readFile(file, "utf8"), new RegExp(`code: ${code}[\\s\\S]*fallback`, "u"))
    }
    assert.deepEqual(await fs.readdir(root), ["card.md"])
    fs.rename = async () => { throw Object.assign(new Error("disk on fire"), { code: "EIO" }) }
    fs.rm = async () => { throw new Error("cleanup failed") }
    await assert.rejects(writeMarkdown(file, { a: 1 }, "b", { atomic: true }), /disk on fire/u)
  } finally {
    fs.rename = rename
    fs.rm = rm
  }
})
