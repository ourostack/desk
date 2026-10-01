// task_update moves a task's row in the track card's Tasks table when its status changes, in the documented format only.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { setTaskState } from "../../../../../plugins/desk/mcp/src/tools/track-row.js"
import { mkTempDeskRoot } from "./_helpers.js"

const TABLE = [
  "## Tasks",
  "",
  "| Slug | State | Repos | Tracker link | Doing doc |",
  "|------|-------|-------|--------------|-----------|",
  "| `api-validation-layer` | drafting | OrderService (local) | | `x/doing.md` |",
  "| `other-task` | processing | | | |",
  "",
  "## Ordering",
].join("\n")

test("setTaskState rewrites only the State cell of the task's row", () => {
  const next = setTaskState(TABLE, "api-validation-layer", "validating")
  assert.equal(next, TABLE.replace("| `api-validation-layer` | drafting |", "| `api-validation-layer` | validating |"))
  assert.equal(setTaskState(TABLE, "other-task", "done"), TABLE.replace("| `other-task` | processing |", "| `other-task` | done |"))
})

test("setTaskState leaves a card alone when there is no documented table, row, change or usable line", () => {
  assert.equal(setTaskState("no table here\n", "a", "done"), null)
  assert.equal(setTaskState(TABLE, "missing-task", "done"), null, "no row for the slug")
  assert.equal(setTaskState(TABLE, "api-validation-layer", "drafting"), null, "already says it")
  assert.equal(setTaskState("| Slug | State |\n| a | b |\n", "a", "done"), null, "a header with no separator row is not a table")
  assert.equal(setTaskState("| Name | Status |\n|---|---|\n| a | b |\n", "a", "done"), null, "other column names are not the documented table")
  assert.equal(setTaskState("```\n| Slug | State |\n|---|---|\n| a | b |\n```\n", "a", "done"), null, "a table inside a code fence is an example")
  assert.equal(setTaskState("| Slug | State |\n|---|---|\n| a |\n", "a", "done"), null, "a short row has no State cell")
  assert.equal(setTaskState("| Slug | State |\n|---|---|\n\n| a | b |\n", "a", "done"), null, "a table ends at a blank line")
  assert.equal(setTaskState("| Slug | State |", "a", "done"), null, "a header on the last line has no separator after it")
})

test("setTaskState handles bare slugs, indented rows, no trailing pipe, a second column order and CRLF", () => {
  assert.equal(setTaskState("| State | Slug |\n|---|---|\n| drafting | a |\n", "a", "done"), "| State | Slug |\n|---|---|\n| done | a |\n")
  assert.equal(setTaskState("  | Slug | State\n  |---|---\n  | a | drafting\n", "a", "done"), "  | Slug | State\n  |---|---\n  | a | done \n")
  assert.equal(setTaskState("| Slug | State |\r\n|---|---|\r\n| a | b |\r\n", "a", "done"), "| Slug | State |\r\n|---|---|\r\n| a | done |\r\n")
})

function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function trackDesk({ useGit = false } = {}) {
  const root = await mkTempDeskRoot()
  await fs.mkdir(path.join(root, "t"), { recursive: true })
  await fs.writeFile(path.join(root, "t", "track.md"), `---\ntitle: T\nscope: "x; not y"\nstatus: active\n---\n\n${TABLE.replace("api-validation-layer", "ship-it")}\n`)
  if (useGit) {
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "user.name", "T")
  }
  await task_create({ deskRoot: root, input: { track: "t", slug: "ship-it", title: "Ship it", status: "drafting" } })
  if (useGit) {
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "seed")
  }
  return root
}

const moveTo = (root, status, extra = {}) => task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", frontmatter: { status }, ...extra } })
const trackText = (root) => fs.readFile(path.join(root, "t", "track.md"), "utf8")

test("task_update moves the task's row in the track card when its status changes, and not when it does not", async () => {
  const root = await trackDesk()
  await moveTo(root, "processing")
  assert.match(await trackText(root), /\| `ship-it` \| processing \|/u)
  await task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", note: "progress" } })
  assert.match(await trackText(root), /\| `ship-it` \| processing \|/u)
})

test("on a git desk the row change is committed with the card, and a track card with unstaged edits is left alone", async () => {
  const root = await trackDesk({ useGit: true })
  await moveTo(root, "processing")
  assert.match(await trackText(root), /\| `ship-it` \| processing \|/u)
  assert.equal(git(root, "status", "--porcelain"), "", "both files committed")
  assert.match(git(root, "show", "--stat", "--format=%s", "HEAD"), /task_update: t\/ship-it[\s\S]*t\/ship-it\/task\.md[\s\S]*t\/track\.md/u)
  await fs.appendFile(path.join(root, "t", "track.md"), "\nhand edit\n")
  await moveTo(root, "validating")
  assert.match(await trackText(root), /\| `ship-it` \| processing \|/u, "someone's unstaged edit of the track card is not touched")
})

test("a task with no track card, or a track card with no table, still updates", async () => {
  const root = await trackDesk()
  await fs.writeFile(path.join(root, "t", "track.md"), "---\ntitle: T\n---\n\nNo table.\n")
  assert.equal((await moveTo(root, "processing")).status, "updated")
  await fs.rm(path.join(root, "t", "track.md"))
  assert.equal((await moveTo(root, "validating")).status, "updated")
})
