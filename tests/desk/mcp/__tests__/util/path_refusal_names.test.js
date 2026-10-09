import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { EFFECTIVE_ROOT_MISSING, resolveWriteTarget } from "../../../../../plugins/desk/mcp/src/util/paths.js"
import { findCard } from "../../../../../plugins/desk/mcp/src/tools/task-focus.js"
import { mkTempRoot } from "../_temp_roots.js"
import { NO_POSIX_MODES } from "../_platform.js"

// Every refusal names the path the caller asked for relative to the desk root, with forward slashes, and never an absolute path: a caller on the
// hosted desk has no filesystem, and a relative path can go straight back to desk_save or a task tool.

async function refusalOf(options, root) {
  let failure
  try {
    await resolveWriteTarget(options)
  } catch (error) {
    failure = error
  }
  assert.ok(failure, "expected a refusal")
  assertNoAbsolutePath(failure.message, root)
  return failure.message
}

function assertNoAbsolutePath(message, ...roots) {
  for (const root of roots) {
    assert.equal(message.includes(root), false, `${message} holds ${root}`)
    assert.equal(message.includes(root.replaceAll("\\", "/")), false, `${message} holds ${root}`)
  }
  assert.equal(message.includes("\\"), false, `${message} uses a backslash`)
  assert.doesNotMatch(message, /(?:^|[\s:'"(])(?:\/|[A-Za-z]:)[^\s]*\//u, `${message} holds an absolute path`)
}

async function scene() {
  const root = await mkTempRoot("desk-refusal-")
  const outside = await mkTempRoot("desk-refusal-outside-")
  return { root, outside }
}

test("a path under a file is refused by its desk-relative path, at any depth and under a person", async () => {
  const { root } = await scene()
  await fs.mkdir(path.join(root, "desks", "ari", "dir"), { recursive: true })
  await fs.writeFile(path.join(root, "desks", "ari", "dir", "file.md"), "x")
  await fs.writeFile(path.join(root, "README.md"), "x")
  assert.equal(await refusalOf({ deskRoot: root, segments: ["README.md", "sub", "x.md"] }, root), "desk-mcp: write target runs under a file, not a folder: README.md")
  assert.equal(
    await refusalOf({ deskRoot: root, person: "ari", segments: ["dir", "file.md", "x.md"] }, root),
    "desk-mcp: write target runs under a file, not a folder: desks/ari/dir/file.md",
  )
})

test("a link out of the desk is refused by the link's desk-relative path, never where it leads", { skip: NO_POSIX_MODES }, async () => {
  const { root, outside } = await scene()
  await fs.mkdir(path.join(root, "track"))
  await fs.symlink(outside, path.join(root, "track", "link"))
  await fs.writeFile(path.join(outside, "secret.md"), "x")
  await fs.symlink(path.join(outside, "secret.md"), path.join(root, "leaf.md"))
  assert.equal(
    await refusalOf({ deskRoot: root, segments: ["track", "link", "task.md"] }, root),
    "desk-mcp: track/link resolves outside the desk (via a symbolic link)",
  )
  assert.equal(await refusalOf({ deskRoot: root, segments: ["leaf.md"] }, root), "desk-mcp: leaf.md resolves outside the desk (via a symbolic link)")
  const message = await refusalOf({ deskRoot: root, segments: ["track", "link", "task.md"] }, outside)
  assert.equal(message.includes(path.basename(outside)), false)
})

test("a link that leaves the person folder for another folder of the desk says so, and still names no absolute path", { skip: NO_POSIX_MODES }, async () => {
  const { root } = await scene()
  await fs.mkdir(path.join(root, "desks", "ari"), { recursive: true })
  await fs.mkdir(path.join(root, "desks", "bo", "track"), { recursive: true })
  await fs.symlink(path.join(root, "desks", "bo", "track"), path.join(root, "desks", "ari", "track"))
  assert.equal(
    await refusalOf({ deskRoot: root, person: "ari", segments: ["track", "task.md"] }, root),
    "desk-mcp: desks/ari/track resolves outside effective write root (via a symbolic link)",
  )
})

test("a person folder that is a link, a file or missing is named by its desk-relative path", { skip: NO_POSIX_MODES }, async () => {
  const { root, outside } = await scene()
  await fs.mkdir(path.join(root, "desks"))
  await fs.symlink(outside, path.join(root, "desks", "linked"))
  await fs.writeFile(path.join(root, "desks", "filed"), "x")
  assert.equal(
    await refusalOf({ deskRoot: root, person: "linked", segments: ["t", "task.md"] }, root),
    "desk-mcp: effective write root resolves outside its canonical person path: desks/linked",
  )
  assert.equal(
    await refusalOf({ deskRoot: root, person: "filed", segments: ["t", "task.md"] }, root),
    "desk-mcp: effective write root component is not a directory: desks/filed",
  )
  assert.equal(
    await refusalOf({ deskRoot: root, person: "gone", segments: ["t", "task.md"], createPersonRoot: false }, root),
    `${EFFECTIVE_ROOT_MISSING}: desks/gone`,
  )
})

test("a broken link is named by its desk-relative path, not where it pointed", { skip: NO_POSIX_MODES }, async () => {
  const { root, outside } = await scene()
  await fs.mkdir(path.join(root, "track"))
  await fs.symlink(path.join(outside, "missing.md"), path.join(root, "track", "task.md"))
  assert.equal(await refusalOf({ deskRoot: root, segments: ["track", "task.md"] }, root), "desk-mcp: broken symlink in write target: track/task.md")
  assertNoAbsolutePath(await refusalOf({ deskRoot: root, segments: ["track", "task.md"] }, root), outside)
})

test("a desk root that is missing or is a file is refused as the desk root, without its path", async () => {
  const { root } = await scene()
  const missing = path.join(root, "nowhere")
  const file = path.join(root, "a-file")
  await fs.writeFile(file, "x")
  assert.equal(await refusalOf({ deskRoot: missing, segments: ["t.md"] }, root), "desk-mcp: the desk root does not exist")
  assert.equal(await refusalOf({ deskRoot: file, segments: ["t.md"] }, root), "desk-mcp: the desk root is not a directory")
})

test("a desk root that cannot be read is refused as the desk root, with its error code and no path", { skip: NO_POSIX_MODES }, async () => {
  const { root } = await scene()
  const closed = path.join(root, "closed")
  await fs.mkdir(path.join(closed, "desk"), { recursive: true })
  await fs.chmod(closed, 0o000)
  try {
    assert.equal(
      await refusalOf({ deskRoot: path.join(closed, "desk"), segments: ["t.md"] }, root),
      "desk-mcp: cannot read the desk root (EACCES: permission denied)",
    )
  } finally {
    await fs.chmod(closed, 0o700)
  }
})

test("a symbolic link loop is refused by its desk-relative path with ELOOP, and so is a folder that cannot be read", { skip: NO_POSIX_MODES }, async () => {
  const { root } = await scene()
  await fs.mkdir(path.join(root, "t"))
  await fs.symlink("b", path.join(root, "t", "a"))
  await fs.symlink("a", path.join(root, "t", "b"))
  assert.equal(
    await refusalOf({ deskRoot: root, segments: ["t", "a", "x.md"] }, root),
    "desk-mcp: cannot read t/a (ELOOP: too many symbolic links encountered)",
  )
  await fs.mkdir(path.join(root, "closed", "inner"), { recursive: true })
  await fs.symlink(path.join(root, "closed", "inner", "gone"), path.join(root, "t", "dangling"))
  await fs.chmod(path.join(root, "closed"), 0o000)
  try {
    assert.equal(
      await refusalOf({ deskRoot: root, segments: ["t", "dangling", "x.md"] }, root),
      "desk-mcp: cannot read t/dangling (EACCES: permission denied)",
    )
    assert.equal(
      await refusalOf({ deskRoot: root, segments: ["closed", "inner", "x.md"] }, root),
      "desk-mcp: cannot read closed/inner (EACCES: permission denied)",
    )
  } finally {
    await fs.chmod(path.join(root, "closed"), 0o700)
  }
})

test("a link whose target cannot be inspected is refused by the link's desk-relative path", { skip: NO_POSIX_MODES }, async (t) => {
  const { root } = await scene()
  await fs.mkdir(path.join(root, "real"))
  await fs.symlink(path.join(root, "real"), path.join(root, "dirlink"))
  const stat = fs.stat
  t.mock.method(fs, "stat", async (candidate, ...rest) => {
    if (candidate === path.join(root, "real")) throw Object.assign(new Error(`EIO: i/o error, stat '${candidate}'`), { code: "EIO" })
    return stat(candidate, ...rest)
  })
  try {
    assert.equal(await refusalOf({ deskRoot: root, segments: ["dirlink", "x.md"] }, root), "desk-mcp: cannot read dirlink (EIO: i/o error)")
  } finally {
    t.mock.restoreAll()
  }
})

test("task_focus still reads a missing person folder as a missing card through the shared constant", async () => {
  const { root } = await scene()
  assert.equal(await findCard({ deskRoot: root, person: "gone", track: "t", slug: "s" }), null)
})
