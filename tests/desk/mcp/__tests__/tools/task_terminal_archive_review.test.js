import { test, after } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"

const target = { track: "t", slug: "finish-work" }
const active = "t/finish-work/task.md"
const archived = "t/_archive/finish-work/task.md"
const schedulePush = () => {}
const ownedRoots = new Set()
async function ownedRoot() {
  const root = await fs.realpath(await mkTempDeskRoot())
  ownedRoots.add(root)
  return root
}
// The imported fixture registry's earlier file-level hook owns deletion.
// Independently read back each exact path after its normal teardown.
after(async () => {
  for (const root of ownedRoots) await assert.rejects(fs.lstat(root), { code: "ENOENT" })
})
function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
async function fixture({ gitDesk = false } = {}) {
  const root = await ownedRoot()
  await task_create({ deskRoot: root, input: { ...target, title: "Fixture", status: "processing" }, schedulePush })
  if (gitDesk) {
    git(root, "init", "-q")
    git(root, "config", "user.name", "Test")
    git(root, "config", "user.email", "test@example.com")
    git(root, "add", "--", active)
    git(root, "commit", "-qm", "fixture")
  }
  return root
}

test("review: archive-parent replacement after the prepared write cannot move the card outside the desk", async (t) => {
  const root = await fixture()
  const other = await ownedRoot()
  const rename = fs.rename.bind(fs)
  let replaced = false
  t.mock.method(fs, "rename", async (from, to) => {
    const result = await rename(from, to)
    if (to === path.join(root, active)) {
      await fs.symlink(other, path.join(root, "t/_archive"), process.platform === "win32" ? "junction" : "dir")
      replaced = true
    }
    return result
  })
  await assert.rejects(task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush }),
    (error) => error.phase === "written_active" && error.path === active)
  assert.equal(replaced, true)
  assert.equal((await readFront(path.join(root, active))).data.status, "cancelled")
  assert.deepEqual(await fs.readdir(other), [])
})

test("review: a filesystem-absent destination occupied in HEAD/index refuses before the card write", async () => {
  const root = await fixture({ gitDesk: true })
  const destination = path.dirname(path.join(root, archived))
  await fs.mkdir(destination, { recursive: true })
  await fs.writeFile(path.join(root, archived), "---\nstatus: done\ntitle: Prior archive\n---\nDifferent history\n")
  git(root, "add", "--", archived)
  git(root, "commit", "-qm", "prior archive")
  await fs.rename(destination, path.join(root, "owned-backup"))
  const before = await fs.readFile(path.join(root, active), "utf8")
  const head = git(root, "rev-parse", "HEAD")
  const status = git(root, "status", "--porcelain")
  await assert.rejects(task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush }), /destination.*(HEAD|index|occup)/i)
  assert.equal(await fs.readFile(path.join(root, active), "utf8"), before)
  assert.equal(git(root, "rev-parse", "HEAD"), head)
  assert.equal(git(root, "status", "--porcelain"), status)
  assert.match(git(root, "show", `HEAD:${archived}`), /Different history/)
})

test("review: clean CRLF text uses Git's destination clean representation without changing worktree bytes", async () => {
  const root = await fixture({ gitDesk: true })
  await fs.writeFile(path.join(root, ".gitattributes"), "*.txt text\n")
  await fs.writeFile(path.join(root, "t/finish-work/proof.txt"), "one\r\ntwo\r\n")
  git(root, "add", "--", ".gitattributes", "t/finish-work/proof.txt")
  git(root, "commit", "-qm", "clean CRLF fixture")
  assert.equal(git(root, "status", "--porcelain"), "")
  const before = Number(git(root, "rev-list", "--count", "HEAD"))
  const result = await task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush })
  assert.equal(result.path, archived)
  assert.equal(Number(git(root, "rev-list", "--count", "HEAD")), before + 1)
  assert.equal(await fs.readFile(path.join(root, "t/_archive/finish-work/proof.txt"), "utf8"), "one\r\ntwo\r\n")
  assert.equal(git(root, "show", "HEAD:t/_archive/finish-work/proof.txt"), "one\ntwo")
  assert.equal(git(root, "status", "--porcelain"), "")
})

for (const mode of ["staged deletion", "index-only addition"]) {
  test(`review: filesystem-absent destination refuses ${mode} without consuming outside edits`, async () => {
    const root = await fixture({ gitDesk: true })
    const destination = path.dirname(path.join(root, archived))
    await fs.mkdir(destination, { recursive: true })
    await fs.writeFile(path.join(root, archived), "Prior owned archive\n")
    git(root, "add", "--", archived)
    if (mode === "staged deletion") git(root, "commit", "-qm", "prior archive")
    await fs.rename(destination, path.join(root, "owned-backup"))
    if (mode === "staged deletion") git(root, "add", "--", archived)
    const before = await fs.readFile(path.join(root, active))
    const head = git(root, "rev-parse", "HEAD")
    const status = git(root, "status", "--porcelain")
    await assert.rejects(task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush }), /destination.*(HEAD|index|occup)/i)
    assert.deepEqual(await fs.readFile(path.join(root, active)), before)
    assert.equal(git(root, "rev-parse", "HEAD"), head)
    assert.equal(git(root, "status", "--porcelain"), status)
  })
}

test("review: a task-local attribute policy refuses before the canonical write", async () => {
  const root = await fixture({ gitDesk: true })
  await fs.writeFile(path.join(root, "t/finish-work/.gitattributes"), "*.txt text\n")
  git(root, "add", "--", "t/finish-work/.gitattributes")
  git(root, "commit", "-qm", "task-local attributes")
  const before = await fs.readFile(path.join(root, active))
  const head = git(root, "rev-parse", "HEAD")
  await assert.rejects(task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush }), /task-local .gitattributes.*inherited attribute policy/)
  assert.deepEqual(await fs.readFile(path.join(root, active)), before)
  assert.equal(await exists(path.join(root, archived)), false)
  assert.equal(git(root, "rev-parse", "HEAD"), head)
  assert.equal(git(root, "status", "--porcelain"), "")
})

test("review: destination attributes, not source attributes, determine admitted Git bytes", async () => {
  const root = await fixture({ gitDesk: true })
  await fs.mkdir(path.join(root, "t/_archive"), { recursive: true })
  await fs.writeFile(path.join(root, ".gitattributes"), "*.txt text\n")
  await fs.writeFile(path.join(root, "t/_archive/.gitattributes"), "*.txt -text\n")
  await fs.writeFile(path.join(root, "t/finish-work/proof.txt"), "one\r\ntwo\r\n")
  git(root, "add", "--", ".gitattributes", "t/_archive/.gitattributes", "t/finish-work/proof.txt")
  git(root, "commit", "-qm", "destination attributes")
  await task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush })
  assert.equal(git(root, "show", "HEAD:t/_archive/finish-work/proof.txt"), "one\r\ntwo")
  assert.equal(git(root, "status", "--porcelain"), "")
})

test("review: a late external parent swap reports qualified outside placement without publication", async (t) => {
  const root = await fixture({ gitDesk: true })
  const head = git(root, "rev-parse", "HEAD")
  const other = await ownedRoot()
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, "rename", async (from, to) => {
    if (from === path.join(root, "t/finish-work")) {
      await rename(path.join(root, "t/_archive"), path.join(root, "owned-old-parent"))
      await fs.symlink(other, path.join(root, "t/_archive"), process.platform === "win32" ? "junction" : "dir")
    }
    return rename(from, to)
  })
  await assert.rejects(task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush }),
    (error) => error.phase === "relocated_outside_boundary" && error.committed === null &&
      error.toJSON().actual_path === path.join(other, "finish-work/task.md"))
  assert.equal(await exists(path.join(root, active)), false)
  assert.equal((await readFront(path.join(other, "finish-work/task.md"))).data.status, "cancelled")
  assert.equal(git(root, "rev-parse", "HEAD"), head)
})

test("review: externally moved ancestry reports unknown placement, not a fictional actual path", async (t) => {
  const root = await fixture()
  const rename = fs.rename.bind(fs)
  t.mock.method(fs, "rename", async (from, to) => {
    const result = await rename(from, to)
    if (from === path.join(root, "t/finish-work")) await rename(path.join(root, "t/_archive"), path.join(root, "owned-moved-parent"))
    return result
  })
  await assert.rejects(task_update({ deskRoot: root, input: { ...target, status: "cancelled" }, schedulePush }),
    (error) => error.phase === "placement_uncertain" && error.path === null && error.toJSON().last_known_path === active)
  assert.equal((await readFront(path.join(root, "owned-moved-parent/finish-work/task.md"))).data.status, "cancelled")
})
