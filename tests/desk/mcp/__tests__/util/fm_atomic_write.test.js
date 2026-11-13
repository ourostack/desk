// writeMarkdown with `atomic`: the card is written beside itself and renamed over (retried while something holds it, never written in place), and a failed write leaves no temporary file.

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

// Windows refuses a rename over a card another writer is renaming over. Standing in for it: a rename onto a card that is mid-rename gets EPERM.
function refuseOverlappingRenames() {
  const { rename } = fs
  const renaming = new Set()
  fs.rename = async (from, to) => {
    if (renaming.has(to)) throw Object.assign(new Error("held"), { code: "EPERM" })
    renaming.add(to)
    try {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return await rename(from, to)
    } finally {
      renaming.delete(to)
    }
  }
  return () => { fs.rename = rename }
}

test("concurrent writes of different lengths never write the card in place, and leave one whole card", async () => {
  const root = await mkTempDeskRoot()
  const file = path.join(await fs.realpath(root), "card.md")
  await fs.writeFile(file, "old")
  const { writeFile } = fs
  const inPlace = []
  const restore = refuseOverlappingRenames()
  fs.writeFile = async (target, ...rest) => {
    if (target === file) inPlace.push(target)
    return writeFile(target, ...rest)
  }
  try {
    await Promise.all(Array.from({ length: 30 }, (_, index) => writeMarkdown(file, { n: index * 11 }, `body ${"x".repeat(index)}${index}\n`, { atomic: true })))
  } finally {
    fs.writeFile = writeFile
    restore()
  }
  assert.deepEqual(inPlace, [])
  assert.match(await fs.readFile(file, "utf8"), /^---\n'?n'?: \d+\n---\n\nbody (x*)\d+\n$/u)
  assert.deepEqual(await fs.readdir(root), ["card.md"])
})

test("a rename refused because the card is held open is retried until it goes through, and any other failure surfaces even when cleanup fails too", async () => {
  const root = await mkTempDeskRoot()
  const file = path.join(await fs.realpath(root), "card.md")
  await fs.writeFile(file, "old")
  const { rename, rm, writeFile } = fs
  const inPlace = []
  try {
    fs.writeFile = async (target, ...rest) => {
      if (target === file) inPlace.push(target)
      return writeFile(target, ...rest)
    }
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
      let refusals = 3
      fs.rename = async (from, to) => {
        if (refusals-- > 0) throw Object.assign(new Error("held"), { code })
        return rename(from, to)
      }
      await writeMarkdown(file, { code }, "retried\n", { atomic: true })
      assert.match(await fs.readFile(file, "utf8"), new RegExp(`code: ${code}[\\s\\S]*retried`, "u"))
    }
    assert.deepEqual(inPlace, [])
    assert.deepEqual(await fs.readdir(root), ["card.md"])
    fs.rename = async () => { throw Object.assign(new Error("disk on fire"), { code: "EIO" }) }
    fs.rm = async () => { throw new Error("cleanup failed") }
    await assert.rejects(writeMarkdown(file, { a: 1 }, "b", { atomic: true }), /disk on fire/u)
  } finally {
    fs.rename = rename
    fs.rm = rm
    fs.writeFile = writeFile
  }
})

test("a card held open past every retry keeps its old text and leaves no temporary file", async () => {
  const root = await mkTempDeskRoot()
  const file = path.join(root, "card.md")
  await fs.writeFile(file, "old")
  const { rename } = fs
  fs.rename = async () => { throw Object.assign(new Error("held"), { code: "EPERM" }) }
  try {
    await assert.rejects(writeMarkdown(file, { a: 1 }, "b", { atomic: true }), /held/u)
  } finally {
    fs.rename = rename
  }
  assert.equal(await fs.readFile(file, "utf8"), "old")
  assert.deepEqual(await fs.readdir(root), ["card.md"])
})
