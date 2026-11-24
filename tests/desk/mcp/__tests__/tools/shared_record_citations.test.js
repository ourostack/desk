// A move keeps the paths that shared JSON records (`_shared/`, `pages/`) cite for a task folder pointing at it, in the same commit as the move.

import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { moveTask } from "../../../../../plugins/desk/mcp/src/tools/move.js"
import { task_create, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { track_create } from "../../../../../plugins/desk/mcp/src/tools/track.js"
import { mkTempDeskRoot } from "./_helpers.js"

const NO_PUSH = { schedulePush: () => {} }
const DONE_EVIDENCE = { kind: "pr", ref: "https://github.com/example-org/example-repo/pull/1" }
const SCOPE = "fixture track scope; not anything else"

const WEEK = JSON.stringify({ goals: [
  { evidence: ["t/book-flights/task.md", "t/book-flights/notes.md", "t/book-flights"] },
  { evidence: ["t/book-flights-two/task.md", "xt/book-flights/task.md", "t/book-flights.md"] },
] }, null, 2) + "\n"

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function write(root, rel, content) {
  const file = path.join(root, ...rel.split("/"))
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

async function desk({ gitDesk = true } = {}) {
  const root = await mkTempDeskRoot()
  if (gitDesk) {
    git(root, "init", "-q")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "user.name", "Test")
  }
  for (const track of ["t", "u"]) await track_create({ deskRoot: root, input: { slug: track, title: track, scope: SCOPE } })
  for (const slug of ["book-flights", "book-flights-two"]) await task_create({ deskRoot: root, input: { track: "t", slug, title: slug }, ...NO_PUSH })
  await write(root, "t/book-flights/notes.md", "# Notes\n")
  await write(root, "_shared/weekly/2026-w45.json", WEEK)
  await write(root, "pages/lab/exp.json", JSON.stringify({ path: "t/book-flights/task.md" }))
  if (gitDesk) {
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "fixture")
  }
  return root
}

const read = (root, rel) => fs.readFile(path.join(root, ...rel.split("/")), "utf8")

test("task_archive repoints shared records that cite the card, in the archive commit", async () => {
  const root = await desk()
  await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", status: "done", evidence: DONE_EVIDENCE }, ...NO_PUSH })
  const week = JSON.parse(await read(root, "_shared/weekly/2026-w45.json"))
  assert.deepEqual(week.goals[0].evidence, ["t/_archive/book-flights/task.md", "t/_archive/book-flights/notes.md", "t/_archive/book-flights"])
  assert.deepEqual(week.goals[1].evidence, ["t/book-flights-two/task.md", "xt/book-flights/task.md", "t/book-flights.md"])
  assert.equal(JSON.parse(await read(root, "pages/lab/exp.json")).path, "t/_archive/book-flights/task.md")
  assert.equal(git(root, "status", "--short"), "")
  assert.ok(git(root, "show", "--name-only", "--format=", "HEAD").includes("_shared/weekly/2026-w45.json"))
})

test("task_update to another track repoints the citations in the move commit and keeps other bytes", async () => {
  const root = await desk()
  const result = await moveTask({ deskRoot: root, input: { track: "t", slug: "book-flights", to_track: "u" }, ...NO_PUSH })
  assert.deepEqual(JSON.parse(await read(root, "_shared/weekly/2026-w45.json")).goals[0].evidence, ["u/book-flights/task.md", "u/book-flights/notes.md", "u/book-flights"])
  assert.ok(result.updated_files.includes("_shared/weekly/2026-w45.json"))
  assert.equal(result.citations_not_repointed, undefined)
  assert.equal(git(root, "status", "--short"), "")
})

test("a merge repoints the card citation to merged-task.md and the folder to the iteration", async () => {
  const root = await desk()
  await moveTask({ deskRoot: root, input: { track: "t", slug: "book-flights", to_track: "t", into_task: "book-flights-two" }, ...NO_PUSH })
  const [card, , folder] = JSON.parse(await read(root, "_shared/weekly/2026-w45.json")).goals[0].evidence
  assert.match(card, /^t\/book-flights-two\/_iterations\/[\d-]+-book-flights\/merged-task\.md$/u)
  assert.match(folder, /^t\/book-flights-two\/_iterations\/[\d-]+-book-flights$/u)
})

test("a record with local edits is left alone and named in citations_not_repointed", async () => {
  const root = await desk()
  await write(root, "pages/lab/exp.json", "{ \"path\": \"t/book-flights/task.md\", \"edited\": true }")
  const result = await moveTask({ deskRoot: root, input: { track: "t", slug: "book-flights", to_track: "u" }, ...NO_PUSH })
  assert.equal(result.citations_not_repointed.length, 1)
  assert.match(result.citations_not_repointed[0].file, /pages\/lab\/exp\.json$/u)
  assert.match(await read(root, "pages/lab/exp.json"), /t\/book-flights\/task\.md/u)
})

test("a desk without Git repoints citations too, and skips a JSON file that is not UTF-8", async () => {
  const root = await desk({ gitDesk: false })
  await fs.writeFile(path.join(root, "pages", "lab", "binary.json"), Buffer.from([0xff, 0xfe, 0x74, 0x2f, 0x62]))
  await moveTask({ deskRoot: root, input: { track: "t", slug: "book-flights", to_track: "u" }, ...NO_PUSH })
  assert.equal(JSON.parse(await read(root, "pages/lab/exp.json")).path, "u/book-flights/task.md")
  assert.deepEqual([...await fs.readFile(path.join(root, "pages", "lab", "binary.json"))], [0xff, 0xfe, 0x74, 0x2f, 0x62])
})

test("a desk with no _shared or pages folder moves as before", async () => {
  const root = await desk({ gitDesk: false })
  await fs.rm(path.join(root, "_shared"), { recursive: true })
  await fs.rm(path.join(root, "pages"), { recursive: true })
  const result = await moveTask({ deskRoot: root, input: { track: "t", slug: "book-flights", to_track: "u" }, ...NO_PUSH })
  assert.equal(result.citations_not_repointed, undefined)
})
