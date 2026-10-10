import { test } from "node:test"
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { syncBuiltinESMExports } from "node:module"
import { claudeBindingPath, deskRelativePath, expandHome, isPathContained, loadActivationConfig, resolveActivationConfigPath, resolveDeskRoot, resolveDeskRootWithSource, resolveLocalPath, resolveStateHome, resolveWriteTarget, toDeskPath } from "../../../../../plugins/desk/mcp/src/util/paths.js"

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desk-path-coverage-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test("shared path defaults retain isolated home and explicit-config behavior", async (t) => {
  const root = await temporaryRoot(t)
  assert.equal(resolveDeskRoot(root), root)
  assert.equal(loadActivationConfig(), null)
  assert.equal(resolveActivationConfigPath({ explicit: root }), root)
  const oldConfig = process.env.DESK_ACTIVATION_CONFIG
  process.env.DESK_ACTIVATION_CONFIG = root
  try {
    assert.equal(resolveActivationConfigPath(), root)
  } finally {
    if (oldConfig === undefined) delete process.env.DESK_ACTIVATION_CONFIG
    else process.env.DESK_ACTIVATION_CONFIG = oldConfig
  }
  const oldData = process.env.CLAUDE_PLUGIN_DATA
  process.env.CLAUDE_PLUGIN_DATA = root
  try {
    assert.equal(claudeBindingPath(), path.join(root, "desk.activation.json"))
  } finally {
    if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA
    else process.env.CLAUDE_PLUGIN_DATA = oldData
  }
  assert.equal(expandHome("~"), os.homedir())
  assert.equal(expandHome("leaf"), "leaf")
  assert.equal(resolveStateHome({}), path.join(os.homedir(), ".local", "state"))
  for (const value of [undefined, "", "  ", 7]) {
    assert.equal(resolveStateHome({ HOME: root, XDG_STATE_HOME: value }), path.join(root, ".local", "state"))
  }
  assert.equal(resolveStateHome({ HOME: root, XDG_STATE_HOME: "~/state" }), path.join(root, "state"))
})

test("root resolution with omitted options uses isolated home defaults without provisioning", async (t) => {
  const home = await temporaryRoot(t)
  await fs.mkdir(path.join(home, "desk", "_meta"), { recursive: true })
  await fs.mkdir(path.join(home, "desk", "_archive"))
  const oldDesk = process.env.DESK
  delete process.env.DESK
  t.mock.method(os, "homedir", () => home)
  syncBuiltinESMExports()
  try {
    assert.deepEqual(resolveDeskRootWithSource(), {
      root: path.join(home, "desk"), source: "home_fallback",
      tried: [
        { source: "home_fallback", path: path.join(home, "desk") },
      ],
    })
  } finally {
    if (oldDesk === undefined) delete process.env.DESK
    else process.env.DESK = oldDesk
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.deepEqual(await fs.readdir(home), ["desk"])
})

test("local paths with omitted options retain the current-folder base and isolated home expansion", async (t) => {
  const home = await temporaryRoot(t)
  t.mock.method(os, "homedir", () => home)
  syncBuiltinESMExports()
  try {
    assert.equal(resolveLocalPath("repo"), path.join(process.cwd(), "repo"))
    assert.equal(resolveLocalPath("~/repo"), path.join(home, "repo"))
    assert.deepEqual(await fs.readdir(home), [], "path resolution does not provision a folder")
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test("an omitted person resolves within the existing Desk root without creating the target", async (t) => {
  const deskRoot = await temporaryRoot(t)
  assert.equal(await resolveWriteTarget({ deskRoot, segments: ["planning.md"] }), path.join(deskRoot, "planning.md"))
  assert.deepEqual(await fs.readdir(deskRoot), [])
})

test("write confinement refuses an escaping platform resolution before filesystem work", async (t) => {
  const base = await temporaryRoot(t)
  const deskRoot = path.join(base, "desk")
  await fs.mkdir(deskRoot)
  const outside = path.join(base, "escape")
  const originalResolve = path.resolve
  t.mock.method(path, "resolve", (...parts) => parts.length === 2 && parts[0] === deskRoot && parts[1] === "leaf" ? outside : originalResolve(...parts))
  const stat = t.mock.method(fs, "stat", () => assert.fail("lexical confinement must precede filesystem access"))
  syncBuiltinESMExports()
  try {
    await assert.rejects(resolveWriteTarget({ deskRoot, segments: ["leaf"] }), {
      message: "desk-mcp: write target is outside effective write root: leaf",
    })
    assert.equal(stat.mock.calls.length, 0)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.deepEqual(await fs.readdir(base), ["desk"])
  assert.deepEqual(await fs.readdir(deskRoot), [])
})

test("target realpath failures other than ENOENT are refused by relative path and code", async (t) => {
  const deskRoot = await temporaryRoot(t)
  const target = path.join(deskRoot, "task.md")
  await fs.writeFile(target, "unchanged\n")
  const failure = Object.assign(new Error("fixture target realpath denied"), { code: "EACCES" })
  const originalRealpath = fs.realpath
  const observed = []
  t.mock.method(fs, "realpath", async (candidate, ...options) => {
    observed.push(candidate)
    if (candidate === target) throw failure
    return originalRealpath(candidate, ...options)
  })
  try {
    await assert.rejects(resolveWriteTarget({ deskRoot, segments: ["task.md"] }), { message: "desk-mcp: cannot read task.md (EACCES)" })
    assert.deepEqual(observed, [deskRoot, target])
  } finally {
    t.mock.restoreAll()
  }
  assert.equal(await fs.readFile(target, "utf8"), "unchanged\n")
  assert.deepEqual(await fs.readdir(deskRoot), ["task.md"])
})

test("an error with no code is not a filesystem error and reaches the caller unchanged", async (t) => {
  const deskRoot = await temporaryRoot(t)
  const failure = new Error("fixture lstat failure with no code")
  const originalLstat = fs.lstat
  t.mock.method(fs, "lstat", async (candidate, ...options) => {
    if (candidate === path.join(deskRoot, "task.md")) throw failure
    return originalLstat(candidate, ...options)
  })
  try {
    await assert.rejects(resolveWriteTarget({ deskRoot, segments: ["task.md"] }), (error) => error === failure)
  } finally {
    t.mock.restoreAll()
  }
})

test("confinement rejects the actual win32 cross-drive relative result on any test host", (t) => {
  const relative = path.win32.relative
  const isAbsolute = path.win32.isAbsolute
  assert.equal(relative("C:\\desk", "D:\\outside"), "D:\\outside")
  t.mock.method(path, "relative", relative)
  t.mock.method(path, "isAbsolute", isAbsolute)
  syncBuiltinESMExports()
  try {
    assert.equal(isPathContained("C:\\desk", "D:\\outside"), false)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test("desk paths are spelled with / whatever the platform's separator is", () => {
  assert.equal(toDeskPath("track\\task\\task.md", "\\"), "track/task/task.md")
  assert.equal(toDeskPath("track/task/task.md", "/"), "track/task/task.md")
  assert.equal(deskRelativePath(path.join(path.sep, "desk"), path.join(path.sep, "desk", "a", "b.md")), "a/b.md")
})
