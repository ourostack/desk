// Handles name a task or track folder without its name, so a folder whose name
// carries a secret's value can be renamed without anyone reading the old name
// (review of #51, S1).

import { test, afterEach } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  __handleInternalsForTests,
  folderHandle,
  handleKeyPath,
  isHandle,
  resolveTaskHandle,
  resolveTrackHandle,
} from "../../src/desk/handles.js"

const ORIGINAL_STATE_HOME = process.env.XDG_STATE_HOME

afterEach(() => {
  process.env.XDG_STATE_HOME = ORIGINAL_STATE_HOME
  __handleInternalsForTests.reset()
})

function scratch(prefix) {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
}

function desk() {
  const root = scratch("desk-handles-")
  for (const rel of [
    "work/set pw hunter2/task.md",
    "work/plain-task/task.md",
    "work/_archive/old-task/task.md",
    "work/_archive/_skip/task.md",
    "work/_planning/task.md",
    "work/track.md",
    "_meta/x/task.md",
    ".hidden/x/task.md",
    "desks/alex/infra/their-task/task.md",
  ]) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), "---\nstatus: drafting\n---\n")
  }
  return root
}

test("the key file lives in Desk's state folder, never in the desk", () => {
  assert.equal(handleKeyPath({ XDG_STATE_HOME: "/state" }, "/home/a"), path.join("/state", "ouroboros-skills", "desk", "handle-key"))
  for (const env of [{}, { XDG_STATE_HOME: "relative/state" }, { XDG_STATE_HOME: 7 }]) {
    assert.equal(handleKeyPath(env, "/home/a"), path.join("/home/a", ".local", "state", "ouroboros-skills", "desk", "handle-key"))
  }
  assert.equal(handleKeyPath(), path.join(process.env.XDG_STATE_HOME, "ouroboros-skills", "desk", "handle-key"))
})

test("a handle is stable, private to this machine's key and changes when the folder moves", () => {
  process.env.XDG_STATE_HOME = scratch("desk-handles-state-")
  const root = desk()
  const first = folderHandle("task", root, path.join(root, "work", "set pw hunter2"))
  assert.ok(isHandle("task", first))
  assert.doesNotMatch(first, /hunter/)
  const key = readFileSync(handleKeyPath(), "utf8")
  assert.match(key, /^[0-9a-f]{64}\n$/u)
  if (process.platform !== "win32") assert.equal(statSync(handleKeyPath()).mode & 0o777, 0o600)

  // A fresh process reads the same key back, so the MCP server and the tidy script agree.
  __handleInternalsForTests.reset()
  assert.equal(folderHandle("task", root, path.join(root, "work", "set pw hunter2")), first)
  assert.notEqual(folderHandle("task", root, path.join(root, "work", "renamed")), first)

  // Another machine's key gives another handle for the same path.
  __handleInternalsForTests.reset()
  process.env.XDG_STATE_HOME = scratch("desk-handles-state-")
  assert.notEqual(folderHandle("task", root, path.join(root, "work", "set pw hunter2")), first)
})

test("a key that cannot be stored falls back to one key per process", () => {
  const unusable = () => {
    const state = scratch("desk-handles-bad-state-")
    const file = path.join(state, "ouroboros-skills", "desk", "handle-key")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "not a key\n")
    return state
  }
  process.env.XDG_STATE_HOME = unusable()
  const root = desk()
  const target = path.join(root, "work", "plain-task")
  const first = folderHandle("task", root, target)
  assert.equal(readFileSync(handleKeyPath(), "utf8"), "not a key\n", "an unreadable key file is never overwritten")
  process.env.XDG_STATE_HOME = unusable()
  assert.equal(folderHandle("task", root, target), first, "the per-process key is reused")
})

test("isHandle checks the shape and the kind", () => {
  assert.ok(isHandle("task", "task-0123456789"))
  assert.ok(isHandle("track", "track-abcdef0123"))
  assert.equal(isHandle("task", "track-abcdef0123"), false)
  assert.equal(isHandle("task", "task-0123"), false)
  assert.equal(isHandle("task", "task-ABCDEF0123"), false)
  assert.equal(isHandle("task", 7), false)
})

test("handles resolve live and archived tasks and tracks inside the scanned desk only", () => {
  process.env.XDG_STATE_HOME = scratch("desk-handles-state-")
  const root = desk()
  const task = (rel) => folderHandle("task", root, path.join(root, rel))
  const track = (rel) => folderHandle("track", root, path.join(root, rel))

  assert.deepEqual(resolveTaskHandle(root, root, task("work/set pw hunter2")), { track: "work", slug: "set pw hunter2" })
  assert.deepEqual(resolveTaskHandle(root, root, task("work/_archive/old-task")), { track: "work", slug: "old-task" })
  assert.equal(resolveTaskHandle(root, root, task("work/_archive/_skip")), null)
  assert.equal(resolveTaskHandle(root, root, task("work/_planning")), null)
  assert.equal(resolveTaskHandle(root, root, task("_meta/x")), null)
  assert.equal(resolveTaskHandle(root, root, task(".hidden/x")), null)
  assert.equal(resolveTaskHandle(root, root, task("desks/alex/infra/their-task")), null, "the workspace scan never walks into a crew desk")
  assert.equal(resolveTaskHandle(root, root, "task-0000000000"), null)
  assert.equal(resolveTaskHandle(root, root, track("work")), null, "a track handle is not a task handle")

  const alex = path.join(root, "desks", "alex")
  assert.deepEqual(resolveTaskHandle(root, alex, task("desks/alex/infra/their-task")), { track: "infra", slug: "their-task" })
  assert.equal(resolveTaskHandle(root, alex, task("work/plain-task")), null, "a person desk resolves only its own tasks")

  assert.equal(resolveTrackHandle(root, root, track("work")), "work")
  assert.equal(resolveTrackHandle(root, root, track("desks")), null)
  assert.equal(resolveTrackHandle(root, root, track("_meta")), null)
  assert.equal(resolveTrackHandle(root, alex, track("desks/alex/infra")), "infra")
  assert.equal(resolveTrackHandle(root, root, task("work/plain-task")), null, "a task handle is not a track handle")
  assert.equal(resolveTrackHandle(root, path.join(root, "missing"), track("work")), null)
})
