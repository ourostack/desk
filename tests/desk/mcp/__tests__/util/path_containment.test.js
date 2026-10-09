import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import * as paths from "../../../../../plugins/desk/mcp/src/util/paths.js"
import { mkTempRoot } from "../_temp_roots.js"
import { NO_POSIX_MODES } from "../_platform.js"

async function makeRoot(prefix = "desk-containment-") {
  return mkTempRoot(prefix)
}

async function resolveWriteTarget(options) {
  return paths.resolveWriteTarget(options)
}

function containmentError() {
  return /write path|write target|outside|symlink|confined/i
}

test("resolveWriteTarget resolves a workspace target beneath the desk root", async () => {
  const root = await makeRoot()
  const target = await resolveWriteTarget({
    deskRoot: root,
    person: null,
    segments: ["track", "task", "task.md"],
  })
  assert.equal(target, path.join(root, "track", "task", "task.md"))
})

test("resolveWriteTarget resolves a missing person root without creating it, so a failed call leaves nothing behind", async () => {
  const root = await makeRoot()
  const target = await resolveWriteTarget({
    deskRoot: root,
    person: "ari",
    segments: ["track", "task.md"],
  })
  assert.equal(target, path.join(root, "desks", "ari", "track", "task.md"))
  await assert.rejects(fs.stat(path.join(root, "desks")), { code: "ENOENT" })
})

test("resolveWriteTarget rejects a missing segment list", async () => {
  const root = await makeRoot()
  await assert.rejects(
    resolveWriteTarget({ deskRoot: root, person: "ari" }),
    /requires at least one path segment/i,
  )
  await assert.rejects(
    resolveWriteTarget({ deskRoot: root, person: "ari", segments: [] }),
    /requires at least one path segment/i,
  )
})

const hostileSegments = [
  ["null", null],
  ["non-string", 42],
  ["empty", ""],
  ["whitespace-only", " \t "],
  ["single-dot", "."],
  ["double-dot", ".."],
  ["absolute", path.join(path.sep, "tmp", "outside")],
  ["forward-slash", "safe/child"],
  ["backslash", "safe\\child"],
  ["nested-forward-traversal", "safe/../../outside"],
  ["nested-backslash-traversal", "safe\\..\\..\\outside"],
  ["embedded-double-dot", "safe..outside"],
]

for (const [name, segment] of hostileSegments) {
  test(`resolveWriteTarget rejects a ${name} segment`, async () => {
    const root = await makeRoot()
    await assert.rejects(
      resolveWriteTarget({
        deskRoot: root,
        person: "ari",
        segments: ["track", segment, "task.md"],
      }),
      containmentError(),
    )
  })
}

test("resolveWriteTarget rejects an effective person root symlinked outside the desk", async () => {
  const root = await makeRoot()
  const outside = await makeRoot("desk-outside-")
  await fs.mkdir(path.join(root, "desks"), { recursive: true })
  await fs.symlink(outside, path.join(root, "desks", "ari"))

  await assert.rejects(
    resolveWriteTarget({
      deskRoot: root,
      person: "ari",
      segments: ["track", "task.md"],
    }),
    containmentError(),
  )
})

test("resolveWriteTarget rejects an effective person root component that is not a directory", async () => {
  const root = await makeRoot()
  await fs.mkdir(path.join(root, "desks"), { recursive: true })
  await fs.writeFile(path.join(root, "desks", "ari"), "not a directory", "utf8")

  await assert.rejects(
    resolveWriteTarget({
      deskRoot: root,
      person: "ari",
      segments: ["track", "task.md"],
    }),
    /not a directory/i,
  )
})

test("resolveWriteTarget rejects a desk root that is not a directory", async () => {
  const parent = await makeRoot()
  const root = path.join(parent, "desk-file")
  await fs.writeFile(root, "not a directory", "utf8")

  await assert.rejects(
    resolveWriteTarget({
      deskRoot: root,
      person: null,
      segments: ["track.md"],
    }),
    /^Error: desk-mcp: the desk root is not a directory$/i,
  )
})

test("resolveWriteTarget rejects an intermediate person-path symlink outside the effective root", async () => {
  const root = await makeRoot()
  const outside = await makeRoot("desk-outside-")
  await fs.mkdir(path.join(root, "desks", "ari"), { recursive: true })
  await fs.symlink(outside, path.join(root, "desks", "ari", "track"))

  await assert.rejects(
    resolveWriteTarget({
      deskRoot: root,
      person: "ari",
      segments: ["track", "task", "task.md"],
    }),
    containmentError(),
  )
})

test("resolveWriteTarget rejects an intermediate workspace-path symlink outside the desk root", async () => {
  const root = await makeRoot()
  const outside = await makeRoot("desk-outside-")
  await fs.symlink(outside, path.join(root, "track"))

  await assert.rejects(
    resolveWriteTarget({
      deskRoot: root,
      person: null,
      segments: ["track", "task", "task.md"],
    }),
    containmentError(),
  )
})

test("resolveWriteTarget rejects an existing final target symlinked outside the effective root", async () => {
  const root = await makeRoot()
  const outside = await makeRoot("desk-outside-")
  const outsideFile = path.join(outside, "task.md")
  await fs.writeFile(outsideFile, "outside", "utf8")
  const targetDir = path.join(root, "desks", "ari", "track", "task")
  await fs.mkdir(targetDir, { recursive: true })
  await fs.symlink(outsideFile, path.join(targetDir, "task.md"))

  await assert.rejects(
    resolveWriteTarget({
      deskRoot: root,
      person: "ari",
      segments: ["track", "task", "task.md"],
    }),
    containmentError(),
  )
})

test("resolveWriteTarget rejects a broken final symlink", async () => {
  const root = await makeRoot()
  const outside = await makeRoot("desk-outside-")
  const targetDir = path.join(root, "desks", "ari", "track", "task")
  await fs.mkdir(targetDir, { recursive: true })
  await fs.symlink(
    path.join(outside, "missing-task.md"),
    path.join(targetDir, "task.md"),
  )

  await assert.rejects(
    resolveWriteTarget({
      deskRoot: root,
      person: "ari",
      segments: ["track", "task", "task.md"],
    }),
    containmentError(),
  )
})

test("resolveWriteTarget permits an existing symlink that remains inside the effective root", async () => {
  const root = await makeRoot()
  const personRoot = path.join(root, "desks", "ari")
  const realTrack = path.join(personRoot, "real-track")
  await fs.mkdir(realTrack, { recursive: true })
  await fs.symlink(realTrack, path.join(personRoot, "track"))

  const target = await resolveWriteTarget({
    deskRoot: root,
    person: "ari",
    segments: ["track", "task.md"],
  })
  assert.equal(target, path.join(personRoot, "track", "task.md"))
})

test("resolveWriteTarget treats the effective root itself as contained", async () => {
  const root = await makeRoot()
  const personRoot = path.join(root, "desks", "ari")
  await fs.mkdir(personRoot, { recursive: true })
  await fs.symlink(personRoot, path.join(personRoot, "track"))

  const target = await resolveWriteTarget({
    deskRoot: root,
    person: "ari",
    segments: ["track", "task.md"],
  })
  assert.equal(target, path.join(personRoot, "track", "task.md"))
})

test("resolveWriteTarget rejects a symlink to the effective root parent", async () => {
  const root = await makeRoot()
  const personRoot = path.join(root, "desks", "ari")
  await fs.mkdir(personRoot, { recursive: true })
  await fs.symlink(path.dirname(personRoot), path.join(personRoot, "track"))

  await assert.rejects(
    resolveWriteTarget({
      deskRoot: root,
      person: "ari",
      segments: ["track", "task.md"],
    }),
    containmentError(),
  )
})

test("resolveWriteTarget refuses non-missing filesystem errors by relative path", { skip: NO_POSIX_MODES }, async () => {
  const root = await makeRoot()
  const blocked = path.join(root, "blocked")
  await fs.mkdir(blocked)
  await fs.chmod(blocked, 0o000)

  try {
    await assert.rejects(
      resolveWriteTarget({
        deskRoot: root,
        person: null,
        segments: ["blocked", "task.md"],
      }),
      { message: "desk-mcp: cannot read blocked/task.md (EACCES: permission denied)" },
    )
  } finally {
    await fs.chmod(blocked, 0o700)
  }
})

test("resolveWriteTarget refuses a path that runs under a file, at depth 1 and 2, and names the file relative to the desk", async () => {
  const root = await makeRoot()
  await fs.writeFile(path.join(root, "README.md"), "# readme\n")
  await assert.rejects(
    resolveWriteTarget({ deskRoot: root, person: null, segments: ["README.md", "x.md"] }),
    (error) => !error.code && error.message.includes("runs under a file, not a folder") && error.message.endsWith(": README.md"),
  )
  await assert.rejects(
    resolveWriteTarget({ deskRoot: root, person: null, segments: ["README.md", "sub", "x.md"] }),
    (error) => !error.code && error.message.endsWith(": README.md"),
  )
  await fs.mkdir(path.join(root, "dir"))
  await fs.writeFile(path.join(root, "dir", "file.md"), "x")
  await assert.rejects(
    resolveWriteTarget({ deskRoot: root, person: null, segments: ["dir", "file.md", "x.md"] }),
    (error) => !error.code && error.message.endsWith(": dir/file.md"),
  )
  await assert.rejects(
    resolveWriteTarget({ deskRoot: root, person: null, segments: ["dir", "file.md", "a", "x.md"] }),
    /runs under a file/u,
  )
})

test("resolveWriteTarget still allows a missing folder, an existing folder and an existing file as the last segment", async () => {
  const root = await makeRoot()
  await fs.mkdir(path.join(root, "dir"))
  await fs.writeFile(path.join(root, "dir", "file.md"), "x")
  assert.equal(await resolveWriteTarget({ deskRoot: root, person: null, segments: ["missing", "deeper", "x.md"] }), path.join(root, "missing", "deeper", "x.md"))
  assert.equal(await resolveWriteTarget({ deskRoot: root, person: null, segments: ["dir", "new", "x.md"] }), path.join(root, "dir", "new", "x.md"))
  assert.equal(await resolveWriteTarget({ deskRoot: root, person: null, segments: ["dir", "file.md"] }), path.join(root, "dir", "file.md"))
  assert.equal(await resolveWriteTarget({ deskRoot: root, person: null, segments: ["dir"] }), path.join(root, "dir"))
})

test("resolveWriteTarget refuses a person-scoped path that runs under a file", async () => {
  const root = await makeRoot()
  await fs.mkdir(path.join(root, "desks", "ari"), { recursive: true })
  await fs.writeFile(path.join(root, "desks", "ari", "notes.md"), "x")
  await assert.rejects(
    resolveWriteTarget({ deskRoot: root, person: "ari", segments: ["notes.md", "x.md"] }),
    /runs under a file, not a folder/u,
  )
})

test("resolveWriteTarget judges a link in the middle by what it leads to", { skip: NO_POSIX_MODES }, async () => {
  const root = await makeRoot()
  await fs.mkdir(path.join(root, "real"))
  await fs.writeFile(path.join(root, "real", "file.md"), "x")
  await fs.symlink(path.join(root, "real"), path.join(root, "dirlink"))
  await fs.symlink(path.join(root, "real", "file.md"), path.join(root, "filelink"))
  assert.equal(await resolveWriteTarget({ deskRoot: root, person: null, segments: ["dirlink", "x.md"] }), path.join(root, "dirlink", "x.md"))
  await assert.rejects(
    resolveWriteTarget({ deskRoot: root, person: null, segments: ["filelink", "x.md"] }),
    /runs under a file/u,
  )
})
