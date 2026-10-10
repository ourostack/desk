// desk_save `files` — a client with no filesystem (claude.ai, through hosted Desk) hands desk_save the file contents, and desk_save writes and
// commits them. Every entry is checked before any byte is written: a refused call writes nothing.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import * as os from "node:os"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { desk_save } from "../../../../plugins/desk/mcp/src/tools/desk-save.js"
import { TOOL_INPUT_SCHEMAS } from "../../../../plugins/desk/mcp/src/tool-schemas.js"
import { mkTempDeskRoot, exists } from "./tools/_helpers.js"

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function gitDesk() {
  const root = await mkTempDeskRoot()
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  await fs.writeFile(path.join(root, "README.md"), "Desk.\n", "utf8")
  git(root, ["add", "README.md"])
  git(root, ["commit", "-q", "-m", "init"])
  return root
}

const save = (root, input, extra = {}) => desk_save({ deskRoot: root, input, schedulePush: () => {}, ...extra })
const lastCommitFiles = (root) => git(root, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean).sort()
const committedContent = (root, rel) => git(root, ["show", `HEAD:${rel}`])
const GOOD = { path: "track/task/notes/good.md", content: "Good.\n" }

test("desk_save writes and commits a new file from `files` with its exact content", async () => {
  const root = await gitDesk()
  const content = "# Notes\n\nLine with unicode: café ✓\n"
  const result = await save(root, { files: [{ path: "track/task/notes/a.md", content }], message: "save notes" })
  assert.equal(result.status, "committed")
  assert.deepEqual(lastCommitFiles(root), ["track/task/notes/a.md"])
  assert.equal(committedContent(root, "track/task/notes/a.md"), content)
  assert.equal(await fs.readFile(path.join(root, "track/task/notes/a.md"), "utf8"), content)
  assert.equal(git(root, ["status", "--short"]), "")
})

test("desk_save reports its commit as desk_commit with desk_pushed false and a note", async () => {
  const root = await gitDesk()
  const result = await save(root, { files: [{ path: "track/task/notes/b.md", content: "B.\n" }], message: "save b" })
  assert.equal(result.status, "committed")
  assert.equal(result.desk_commit, git(root, ["rev-parse", "--short", "HEAD"]).trim())
  assert.equal(result.desk_pushed, false)
  assert.match(result.desk_note, /pushing them in the background/u)
  assert.match(result.desk_commit_note, /new hash/u)
})

test("desk_save leaves desk_commit out when Git cannot name the commit", async () => {
  const root = await gitDesk()
  const spawnGit = (cmd, args, opts) => args.includes("rev-parse") && args.includes("--short") ? { status: 1, stdout: "" } : spawnSync(cmd, args, opts)
  const result = await save(root, { files: [{ path: "track/task/notes/c.md", content: "C.\n" }], message: "save c" }, { spawnGit })
  assert.equal(result.status, "committed")
  assert.equal(result.desk_commit, undefined)
  assert.equal(result.desk_commit_note, undefined)
  assert.equal(result.desk_pushed, false)
})

test("desk_save overwrites an existing non-card file from `files`", async () => {
  const root = await gitDesk()
  await fs.mkdir(path.join(root, "track/task"), { recursive: true })
  await fs.writeFile(path.join(root, "track/task/planning.md"), "Old.\n", "utf8")
  git(root, ["add", "track/task/planning.md"])
  git(root, ["commit", "-q", "-m", "old"])
  const result = await save(root, { files: [{ path: "track/task/planning.md", content: "New.\n" }], message: "update plan" })
  assert.equal(result.status, "committed")
  assert.equal(committedContent(root, "track/task/planning.md"), "New.\n")
})

test("desk_save commits `paths` and `files` together in one commit", async () => {
  const root = await gitDesk()
  await fs.writeFile(path.join(root, "hand.md"), "By hand.\n", "utf8")
  const before = git(root, ["rev-list", "--count", "HEAD"]).trim()
  const result = await save(root, { paths: ["hand.md"], files: [{ path: "remote/sent.md", content: "Sent.\n" }], message: "both" })
  assert.equal(result.status, "committed")
  assert.equal(Number(git(root, ["rev-list", "--count", "HEAD"]).trim()), Number(before) + 1)
  assert.deepEqual(lastCommitFiles(root), ["hand.md", "remote/sent.md"])
})

test("desk_save accepts `files` sent as a JSON string", async () => {
  const root = await gitDesk()
  const result = await save(root, { files: JSON.stringify([{ path: "s.md", content: "S.\n" }]), message: "string" })
  assert.equal(result.status, "committed")
  assert.equal(committedContent(root, "s.md"), "S.\n")
})

test("desk_save writes `files` inside the person prefix on a crew desk", async () => {
  const root = await gitDesk()
  const result = await save(root, { files: [{ path: "desks/ari/notes.md", content: "Mine.\n" }], message: "crew" }, { person: "ari" })
  assert.equal(result.status, "committed")
  assert.equal(committedContent(root, "desks/ari/notes.md"), "Mine.\n")
})

test("desk_save requires `paths` or `files`", async () => {
  const root = await gitDesk()
  await assert.rejects(save(root, { message: "nothing" }), /^Error: desk_save: /u)
})

// Each refusal: the error starts with `desk_save: ` and names the offending path, and the good entry listed before it is not written.
async function assertRefused(root, bad, { input = {}, extra = {}, names = bad.path, good = GOOD } = {}) {
  const head = git(root, ["rev-parse", "HEAD"]).trim()
  await assert.rejects(save(root, { files: [good, bad], message: "refuse", ...input }, extra), (error) => {
    assert.match(error.message, /^desk_save: /u)
    if (names) assert.ok(error.message.includes(names), `error names ${names}: ${error.message}`)
    return true
  })
  assert.equal(await exists(path.join(root, good.path)), false, `${good.path} was written before the refusal of ${bad.path}`)
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head)
}

for (const bad of ["../x.md", "/abs.md", ".git/hooks/post-commit", ".GIT/config", "sub/.git/config", ".state/x", ".github/workflows/x.yml", ".GitHub/Workflows/x.yml", "track/task/task.md", "track/task/TASK.md", "a/./../../x.md", "a\\..\\..\\x.md", "bad\0name.md", "", "*.md", "notes?.md", "a[b].md", ":(top)x.md"]) {
  test(`desk_save refuses \`files\` path ${JSON.stringify(bad)} and writes nothing`, async () => {
    const root = await gitDesk()
    await assertRefused(root, { path: bad, content: "x" }, { names: bad.includes("\0") || bad === "" ? null : bad })
    if (bad === "../x.md") assert.equal(await exists(path.join(root, "..", "x.md")), false)
  })
}

test("desk_save refuses a file over 1 MiB and writes nothing", async () => {
  const root = await gitDesk()
  await assertRefused(root, { path: "big.md", content: "x".repeat(2 * 1024 * 1024) })
})

test("desk_save accepts a file of exactly 1 MiB", async () => {
  const root = await gitDesk()
  const result = await save(root, { files: [{ path: "edge.md", content: "x".repeat(1024 * 1024) }], message: "edge" })
  assert.equal(result.status, "committed")
})

test("desk_save refuses `files` with tidy: true and writes nothing", async () => {
  const root = await gitDesk()
  await assertRefused(root, { path: "other.md", content: "x" }, { input: { tidy: true, paths: ["README.md"] }, names: null })
})

test("desk_save refuses a `files` path through a committed symlink to outside the desk", async () => {
  const root = await gitDesk()
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "desk-outside-"))
  try {
    await fs.symlink(outside, path.join(root, "link"))
    git(root, ["add", "link"])
    git(root, ["commit", "-q", "-m", "link"])
    await assertRefused(root, { path: "link/sub/x.md", content: "escape" })
    assert.deepEqual(await fs.readdir(outside), [])
  } finally {
    await fs.rm(outside, { recursive: true, force: true })
  }
})

test("desk_save refuses a `files` path through a symlink inside the desk that leads into .git", async () => {
  const root = await gitDesk()
  await fs.symlink(".git", path.join(root, "innocent"))
  await assertRefused(root, { path: "innocent/hooks/post-commit", content: "#!/bin/sh\n" })
  assert.equal(await exists(path.join(root, ".git/hooks/post-commit")), false)
})

test("desk_save refuses a `files` path through a symlink that leads to a live task card", async () => {
  const root = await gitDesk()
  await fs.mkdir(path.join(root, "track/task"), { recursive: true })
  await fs.symlink("track/task", path.join(root, "alias"))
  await assertRefused(root, { path: "alias/task.md", content: "---\nstatus: done\n---\n" })
})

test("desk_save refuses a `files` target that is an existing symlink", async () => {
  const root = await gitDesk()
  await fs.writeFile(path.join(root, "real.md"), "Real.\n", "utf8")
  await fs.symlink("real.md", path.join(root, "pointer.md"))
  await assertRefused(root, { path: "pointer.md", content: "Through.\n" })
  assert.equal(await fs.readFile(path.join(root, "real.md"), "utf8"), "Real.\n")
})

test("desk_save refuses a `files` path outside the person prefix on a crew desk", async () => {
  const root = await gitDesk()
  await assertRefused(root, { path: "desks/bob/notes.md", content: "Not mine.\n" }, { extra: { person: "ari" }, good: { path: "desks/ari/good.md", content: "Mine.\n" } })
})

test("desk_save refuses a `files` path whose parent is a file, or whose target is a folder", async () => {
  const root = await gitDesk()
  // Windows reports ENOENT, not ENOTDIR, under a file; resolveWriteTarget's refusal reads the same on every platform and names the file relative to the desk.
  for (const bad of ["README.md/x.md", "README.md/sub/x.md"]) {
    await assertRefused(root, { path: bad, content: "x" })
    await assert.rejects(save(root, { files: [{ path: bad, content: "x" }], message: "refuse" }), /cannot write README\.md\/(sub\/)?x\.md: desk-mcp: write target runs under a file, not a folder: README\.md$/u)
  }
  await fs.mkdir(path.join(root, "folder"))
  await assertRefused(root, { path: "folder", content: "x" })
})

test("desk_save refuses a `files` path through a symbolic link loop", async () => {
  const root = await gitDesk()
  await fs.symlink("loop", path.join(root, "loop"))
  await assertRefused(root, { path: "loop/x.md", content: "x" })
})

test("desk_save refuses malformed `files` entries", async () => {
  const root = await gitDesk()
  for (const files of ["not json", [], [{ path: "a.md" }], [{ path: "a.md", content: 3 }], [{ path: 4, content: "x" }], ["a.md"], [{ path: "a.md", content: "x" }, { path: "a.md", content: "y" }]]) {
    await assert.rejects(save(root, { files, message: "bad" }), /^Error: desk_save: /u, JSON.stringify(files))
  }
  assert.equal(await exists(path.join(root, "a.md")), false)
})

test("the desk_save schema declares `files` and requires only `message`", () => {
  const schema = TOOL_INPUT_SCHEMAS.desk_save
  assert.deepEqual(schema.required, ["message"])
  assert.equal(schema.properties.files.type, "array")
  assert.deepEqual(schema.properties.files.items.required, ["path", "content"])
})
