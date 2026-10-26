// task_move unarchive and into_task, its dirty-tree refusals, and track_rename. The other task_move cases are in move.test.js.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_move, track_rename } from "../../../../../plugins/desk/mcp/src/tools/move.js"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { task_create, task_archive, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { track_create } from "../../../../../plugins/desk/mcp/src/tools/track.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"
import { folderHandle } from "../../../../../plugins/desk/mcp/src/desk/handles.js"
import { DONE_EVIDENCE, SCOPE, assertNoCandidateLeak, commitAll, gitLog, gitStatus, initGit, lastCommitMessage, mkTrack, tasksTableBody, trackBody } from "./_move_fixture.js"

// ── task_move: unarchive (M4-5) ──────────────────────────────────────────────

async function archivedTask(root, { track = "main-track", slug = "old-task", rows = [] } = {}) {
  await mkTrack(root, track, { rows })
  await task_create({ deskRoot: root, input: { track, slug, title: "T" } })
  await task_archive({ deskRoot: root, input: { track, slug, evidence: DONE_EVIDENCE } })
}

test("task_move unarchive moves an archived task back to a live folder and restores its missing row", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await archivedTask(root, { rows: ["other-task"] })

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true },
    schedulePush: () => {},
  })

  assert.equal(result.from, path.posix.join("main-track", "_archive", "old-task"))
  assert.equal(result.to, path.posix.join("main-track", "old-task"))
  assert.equal(await exists(path.join(root, "main-track", "_archive", "old-task")), false)
  const { data } = await readFront(path.join(root, "main-track", "old-task", "task.md"))
  assert.equal(data.track, "main-track")
  assert.equal(data.status, "done", "unarchiving never changes the status; the agent reopens it with task_update")
  const body = await trackBody(root, "main-track")
  assert.match(body, /^\| `old-task` \| done \|  \|  \|  \|$/m)
  assert.match(body, /`other-task`/)
  assert.ok(result.updated_files.includes(path.posix.join("main-track", "track.md")))
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "task_move: old-task → main-track")
})

test("task_move unarchive leaves a row that is still in the table alone", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root, { rows: ["old-task"] })
  const before = await trackBody(root, "main-track")

  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true },
  })

  assert.equal(await trackBody(root, "main-track"), before)
  assert.deepEqual(result.updated_files, [path.posix.join("main-track", "old-task", "task.md")])
})

test("task_move unarchive with a new name renames the row that is still in the table", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root, { rows: ["old-task"] })

  await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true, to_slug: "reopened-task" },
  })

  assert.ok(await exists(path.join(root, "main-track", "reopened-task", "task.md")))
  const body = await trackBody(root, "main-track")
  assert.match(body, /`reopened-task`/)
  assert.doesNotMatch(body, /`old-task`/)
})

test("task_move unarchive into another track moves the source row there", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root, { rows: ["old-task"] })
  const archived = await readFront(path.join(root, "main-track", "_archive", "old-task", "task.md"))
  assert.equal(archived.data.status, "done")
  assert.match(await trackBody(root, "main-track"), /^\| `old-task` \| done \|/m)
  await mkTrack(root, "track-b", { rows: [] })

  await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true, to_track: "track-b" },
  })

  assert.ok(await exists(path.join(root, "track-b", "old-task", "task.md")))
  assert.doesNotMatch(await trackBody(root, "main-track"), /`old-task`/)
  assert.match(await trackBody(root, "track-b"), /^\| `old-task` \| done \|/m)
  const live = await readFront(path.join(root, "track-b", "old-task", "task.md"))
  assert.equal(live.data.status, archived.data.status, "moving a terminal task does not reopen it")
  assert.deepEqual(live.data.evidence, archived.data.evidence)
})

test("task_move unarchive into another track builds a row when the source table has none", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root)
  await track_create({
    deskRoot: root,
    input: {
      slug: "track-b",
      title: "track-b",
      scope: SCOPE,
      body: ["## Tasks", "", "| Slug", "|------", "| `kept-task`"].join("\n"),
    },
  })

  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true, to_track: "track-b" },
  })

  assert.match(await trackBody(root, "track-b"), /^\| `old-task` \|$/m, "a one-column table gets just the slug")
  assert.ok(result.updated_files.includes(path.posix.join("track-b", "track.md")))
})

test("task_move unarchive leaves a track.md with no Tasks table alone", async () => {
  const root = await mkTempDeskRoot()
  await track_create({ deskRoot: root, input: { slug: "main-track", title: "main-track", scope: SCOPE } })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-task", title: "T" } })
  await task_archive({ deskRoot: root, input: { track: "main-track", slug: "old-task", evidence: DONE_EVIDENCE } })

  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true },
  })
  assert.deepEqual(result.updated_files, [path.posix.join("main-track", "old-task", "task.md")])
})

test("task_move unarchive refuses a task that isn't archived", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track")
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "live-task", title: "T" } })

  await assert.rejects(
    task_move({ deskRoot: root, input: { track: "main-track", slug: "live-task", unarchive: true } }),
    /no archived task to unarchive/,
  )
  assert.ok(await exists(path.join(root, "main-track", "live-task", "task.md")))
})

test("task_move unarchive refuses when the live folder already exists", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root)
  // task_create refuses a slug that exists in the archive, so the colliding live folder is written directly.
  await writeMarkdown(path.join(root, "main-track", "old-task", "task.md"), { title: "T", status: "drafting" }, "")

  await assert.rejects(
    task_move({ deskRoot: root, input: { track: "main-track", slug: "old-task", unarchive: true } }),
    /target already exists/,
  )
})

test("task_move unarchive validates a new name as usual", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root)
  await assert.rejects(
    task_move({ deskRoot: root, input: { track: "main-track", slug: "old-task", unarchive: true, to_slug: "please-reopen-it" } }),
    /invalid to_slug/,
  )
})

test("task_move refuses an unarchive flag that isn't a boolean", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root)
  await assert.rejects(
    task_move({ deskRoot: root, input: { track: "main-track", slug: "old-task", unarchive: "yes" } }),
    /`unarchive` must be true or false/,
  )
})

test("task_move with unarchive false behaves like a plain move", async () => {
  const root = await mkTempDeskRoot()
  await archivedTask(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: false, to_slug: "renamed-task" },
  })
  assert.equal(result.to, path.posix.join("main-track", "_archive", "renamed-task"))
})

// ── task_move: into_task (M4-5 duplicate merge) ──────────────────────────────

test("task_move into_task moves a duplicate into the kept task as a dated iteration folder", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["keep-task", "dup-task"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "keep-task", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "dup-task", title: "T" } })
  await fs.mkdir(path.join(root, "main-track", "dup-task", "_iterations", "2026-09-01-first-pass"), { recursive: true })
  await fs.writeFile(path.join(root, "main-track", "dup-task", "_iterations", "2026-09-01-first-pass", "doing.md"), "unique notes\n")
  const { data: before, content: beforeBody } = await readFront(path.join(root, "main-track", "dup-task", "task.md"))
  const day = new Date(before.created).toISOString().slice(0, 10)

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "dup-task", into_task: "keep-task" },
    schedulePush: () => {},
  })

  const iteration = path.posix.join("main-track", "keep-task", "_iterations", `${day}-dup-task`)
  assert.equal(result.from, path.posix.join("main-track", "dup-task"))
  assert.equal(result.to, iteration)
  assert.equal(await exists(path.join(root, "main-track", "dup-task")), false)
  assert.equal(await exists(path.join(root, iteration, "task.md")), false, "the merged card is no longer a task card")
  const { data, content } = await readFront(path.join(root, iteration, "merged-task.md"))
  assert.equal(data.merged_into, "keep-task")
  assert.equal(data.status, before.status, "merging never changes the status")
  assert.equal(content, beforeBody, "the merged card keeps its body")
  assert.equal(
    await fs.readFile(path.join(root, iteration, "_iterations", "2026-09-01-first-pass", "doing.md"), "utf8"),
    "unique notes\n",
    "nothing is deleted",
  )
  const body = await trackBody(root, "main-track")
  assert.doesNotMatch(body, /`dup-task`/)
  assert.match(body, /`keep-task`/)
  assert.deepEqual(result.updated_files, [path.posix.join(iteration, "merged-task.md"), path.posix.join("main-track", "track.md")])
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "task_move: dup-task → main-track")
})

test("task_move into_task across tracks leaves the destination table alone", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "track-a", { rows: [] })
  await mkTrack(root, "track-b", { rows: ["keep-task"] })
  await task_create({ deskRoot: root, input: { track: "track-b", slug: "keep-task", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "dup-task", title: "T" } })
  const card = path.join(root, "track-a", "dup-task", "task.md")
  await fs.writeFile(card, (await fs.readFile(card, "utf8")).replace(/^created: .*$/m, "created: 2026-03-04"))
  const before = await trackBody(root, "track-b")

  const result = await task_move({
    deskRoot: root,
    input: { track: "track-a", slug: "dup-task", to_track: "track-b", into_task: "keep-task" },
  })

  assert.equal(result.to, path.posix.join("track-b", "keep-task", "_iterations", "2026-03-04-dup-task"))
  const { data } = await readFront(path.join(root, result.to, "merged-task.md"))
  assert.equal(data.track, "track-b")
  assert.equal(await trackBody(root, "track-b"), before)
  assert.deepEqual(result.updated_files, [path.posix.join(result.to, "merged-task.md")])
})

test("task_move into_task names the iteration after today when the card has no usable created date", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track")
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "keep-task", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "dup-task", title: "T" } })
  const card = path.join(root, "main-track", "dup-task", "task.md")
  await fs.writeFile(card, (await fs.readFile(card, "utf8")).replace(/^created: .*$/m, "created: not-a-date"))

  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "dup-task", into_task: "keep-task" },
  })
  assert.match(path.basename(result.to), /^\d{4}-\d{2}-\d{2}-dup-task$/)
})

test("task_move into_task refuses a task to merge into that doesn't exist", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track")
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "dup-task", title: "T" } })
  await assert.rejects(
    task_move({ deskRoot: root, input: { track: "main-track", slug: "dup-task", into_task: "missing-task" } }),
    /the task to merge into doesn't exist/,
  )
  assert.ok(await exists(path.join(root, "main-track", "dup-task", "task.md")))
})

test("task_move into_task refuses to merge a task into itself, before touching anything", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track")
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "dup-task", title: "T" } })
  await assert.rejects(
    task_move({ deskRoot: root, input: { track: "main-track", slug: "dup-task", into_task: "dup-task" } }),
    /cannot be merged into itself/,
  )
  assert.equal(await exists(path.join(root, "main-track", "dup-task", "_iterations")), false)
  assert.ok(await exists(path.join(root, "main-track", "dup-task", "task.md")))
})

test("task_move into_task refuses to_slug, unarchive and a traversal-shaped keeper", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track")
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "dup-task", title: "T" } })
  for (const extra of [{ to_slug: "other-name" }, { unarchive: true }]) {
    await assert.rejects(
      task_move({ deskRoot: root, input: { track: "main-track", slug: "dup-task", into_task: "keep-task", ...extra } }),
      /`into_task` cannot be combined/,
    )
  }
  await assert.rejects(
    task_move({ deskRoot: root, input: { track: "main-track", slug: "dup-task", into_task: "../elsewhere" } }),
    /`into_task` must be a non-empty path segment/,
  )
})

// ── Leave other sessions' work alone (M4-5 fix round 2) ────────────────────

const DIRTY = /the source has unstaged changes or untracked files, so another session may be working there; commit or finish that work first, or pass allow_dirty: true to move it anyway/

test("task_move refuses a task with uncommitted or untracked files, without quoting its name", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["pw-hunter2-task"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "clean-task", title: "T" } })
  commitAll(root)
  await fs.writeFile(path.join(root, "main-track", "clean-task", "doing.md"), "another session is writing this\n")

  const error = await task_move({ deskRoot: root, input: { track: "main-track", slug: "clean-task", to_slug: "renamed-task" } }).catch((e) => e)
  assert.match(error.message, DIRTY)
  assert.doesNotMatch(error.message, /clean-task|main-track/)
  assert.ok(await exists(path.join(root, "main-track", "clean-task", "doing.md")), "nothing moved")

  // A tracked file with unstaged edits counts too.
  commitAll(root)
  await fs.appendFile(path.join(root, "main-track", "clean-task", "doing.md"), "more\n")
  await assert.rejects(task_move({ deskRoot: root, input: { track: "main-track", slug: "clean-task", to_slug: "renamed-task" } }), DIRTY)
})

test("task_move ignores ignored files, and moves a dirty task when allow_dirty is true", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "clean-task", title: "T" } })
  await fs.writeFile(path.join(root, ".gitignore"), "*.log\n")
  commitAll(root)
  await fs.writeFile(path.join(root, "main-track", "clean-task", "run.log"), "ignored\n")
  await task_move({ deskRoot: root, input: { track: "main-track", slug: "clean-task", to_slug: "moved-task" }, schedulePush: () => {} })
  assert.ok(await exists(path.join(root, "main-track", "moved-task", "run.log")))

  commitAll(root)
  await fs.writeFile(path.join(root, "main-track", "moved-task", "doing.md"), "in progress\n")
  const result = await task_move({ deskRoot: root, input: { track: "main-track", slug: "moved-task", to_slug: "final-task", allow_dirty: true }, schedulePush: () => {} })
  assert.equal(result.to, path.posix.join("main-track", "final-task"))
  // allow_dirty sweeps the dirty file along with the move (existing `git add
  // -A` + `git mv` behavior); the move's own commit picks it up too, since it
  // is part of the moved directory, not an unrelated path (M4-6 Part 2).
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "task_move: moved-task → main-track")

  await assert.rejects(
    task_move({ deskRoot: root, input: { track: "main-track", slug: "final-task", to_slug: "other-task", allow_dirty: "yes" } }),
    /`allow_dirty` must be true or false/,
  )
})

test("task_move treats a failing git diff or git ls-files as unstaged work", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "clean-task", title: "T" } })
  commitAll(root)
  for (const failing of ["diff", "ls-files"]) {
    const spawnGit = (cmd, args, opts) => (args.includes(failing) ? { status: 128, stdout: "", stderr: "boom" } : spawnSync(cmd, args, opts))
    await assert.rejects(task_move({ deskRoot: root, input: { track: "main-track", slug: "clean-task", to_slug: "moved-task" }, spawnGit }), DIRTY)
  }
})

test("task_move refuses to edit a track.md that holds another session's uncommitted changes, unless allow_dirty", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["clean-task"] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "clean-task", title: "T" } })
  commitAll(root)
  await fs.appendFile(path.join(root, "track-b", "track.md"), "\nA line another session is writing.\n")

  const error = await task_move({ deskRoot: root, input: { track: "track-a", slug: "clean-task", to_track: "track-b" } }).catch((e) => e)
  assert.equal(
    error.message,
    "task_move: a track.md this move would edit has unstaged changes or untracked files, so another session may be working there; commit or finish that work first, or pass allow_dirty: true to move it anyway",
  )
  assert.ok(await exists(path.join(root, "track-a", "clean-task", "task.md")), "nothing moved")

  // The source track's table counts too.
  await fs.appendFile(path.join(root, "track-a", "track.md"), "\nAnother edit.\n")
  await assert.rejects(task_move({ deskRoot: root, input: { track: "track-a", slug: "clean-task", to_slug: "renamed-task" } }), /a track\.md this move would edit has unstaged changes or untracked files/)

  const result = await task_move({ deskRoot: root, input: { track: "track-a", slug: "clean-task", to_track: "track-b", allow_dirty: true }, schedulePush: () => {} })
  assert.equal(result.to, path.posix.join("track-b", "clean-task"))
})

test("task_move into_task refuses to hide a live task inside a done one, and merges a done one into a live one", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  for (const slug of ["done-task", "live-task", "other-live-task"]) {
    await task_create({ deskRoot: root, input: { track: "main-track", slug, title: "T" } })
  }
  const done = path.join(root, "main-track", "done-task", "task.md")
  await fs.writeFile(done, (await fs.readFile(done, "utf8")).replace(/^status: .*$/m, "status: done"))
  commitAll(root)

  await assert.rejects(
    task_move({ deskRoot: root, input: { track: "main-track", slug: "live-task", into_task: "done-task" } }),
    /^Error: task_move: this task is still live but the task to merge into is done or cancelled; keep the live task \(merge the finished one into it instead\) or skip the merge$/,
  )
  assert.ok(await exists(path.join(root, "main-track", "live-task", "task.md")), "the live task stays where it is")

  const kept = await task_move({ deskRoot: root, input: { track: "main-track", slug: "done-task", into_task: "live-task" }, schedulePush: () => {} })
  assert.match(kept.to, /^main-track\/live-task\/_iterations\/\d{4}-\d{2}-\d{2}-done-task$/)
  commitAll(root)
  const both = await task_move({ deskRoot: root, input: { track: "main-track", slug: "other-live-task", into_task: "live-task" }, schedulePush: () => {} })
  assert.match(both.to, /other-live-task$/, "two live tasks for one job can still be merged")
})

test("track_rename refuses a track with uncommitted work unless allow_dirty is true", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-one", title: "T" } })
  commitAll(root)
  await fs.writeFile(path.join(root, "old-track", "task-one", "doing.md"), "in progress\n")

  const error = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" } }).catch((e) => e)
  assert.match(error.message, /^track_rename: the source has unstaged changes or untracked files, so another session may be working there/)
  assert.doesNotMatch(error.message, /old-track|task-one/)
  assert.ok(await exists(path.join(root, "old-track", "track.md")))

  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track", allow_dirty: true }, schedulePush: () => {} })
  assert.equal(result.to, "new-track")
  await assert.rejects(track_rename({ deskRoot: root, input: { track: "new-track", to: "newer-track", allow_dirty: 1 } }), /`allow_dirty` must be true or false/)
})

// ── track_rename ─────────────────────────────────────────────────────────────

test("track_rename renames a track and rewrites track: on every live task card", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-one", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-two", title: "T" } })

  commitAll(root)
  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" }, schedulePush: () => {} })

  assert.equal(result.from, "old-track")
  assert.equal(result.to, "new-track")
  assert.equal(await exists(path.join(root, "old-track")), false)
  assert.ok(await exists(path.join(root, "new-track", "track.md")))

  for (const slug of ["task-one", "task-two"]) {
    const { data } = await readFront(path.join(root, "new-track", slug, "task.md"))
    assert.equal(data.track, "new-track")
  }
  assert.deepEqual(
    result.updated_files.sort(),
    [path.posix.join("new-track", "task-one", "task.md"), path.posix.join("new-track", "task-two", "task.md")].sort(),
  )

  // Staged and committed (M4-6 Part 2): the tree is clean afterward, and the
  // new commit names the tool and the rename.
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "track_rename: old-track → new-track")
})

test("track_rename preserves every other frontmatter byte untouched: a date-only value, a long single-line scalar, quoted and unquoted values, and a note: | block", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-one", title: "T" } })
  const filePath = path.join(root, "old-track", "task-one", "task.md")
  const handWritten = [
    "---",
    "schema_version: 1",
    "title: T",
    "track: old-track",
    "status: drafting",
    "created: 2026-05-26",
    "requester: \"ari\"",
    "reviewer: ari",
    "purpose: A long single-line scalar describing the task in one uninterrupted run of prose, with no wrapping at all.",
    "note: |",
    "  first literal line",
    "  second literal line",
    "updated: \"2026-09-20T10:00:00Z\"",
    "---",
    "",
    "# T",
    "",
    "Body text.",
    "",
  ].join("\n")
  await fs.writeFile(filePath, handWritten, "utf8")

  commitAll(root)
  await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" }, schedulePush: () => {} })

  const raw = await fs.readFile(path.join(root, "new-track", "task-one", "task.md"), "utf8")
  assert.match(raw, /\ncreated: 2026-05-26\n/u, "the date-only created value is untouched")
  assert.match(raw, /\nrequester: "ari"\n/u, "the quoted requester value is untouched")
  assert.match(raw, /\nreviewer: ari\n/u, "the unquoted reviewer value is untouched")
  assert.match(
    raw,
    /\npurpose: A long single-line scalar describing the task in one uninterrupted run of prose, with no wrapping at all\.\n/u,
    "the long single-line purpose scalar is untouched",
  )
  assert.match(raw, /\nnote: \|\n {2}first literal line\n {2}second literal line\n/u, "the note: | block is untouched")
  assert.doesNotMatch(raw, /updated: "2026-09-20T10:00:00Z"/u, "updated is refreshed")
})

test("track_rename with archived tasks rewrites both live and archived task cards", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "live-one", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-gone", title: "T" } })
  await task_archive({ deskRoot: root, input: { track: "old-track", slug: "task-gone", evidence: DONE_EVIDENCE } })

  commitAll(root)
  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" }, schedulePush: () => {} })

  const { data: liveData } = await readFront(path.join(root, "new-track", "live-one", "task.md"))
  assert.equal(liveData.track, "new-track")
  const { data: archivedData } = await readFront(
    path.join(root, "new-track", "_archive", "task-gone", "task.md"),
  )
  assert.equal(archivedData.track, "new-track")
  assert.equal(archivedData.status, "done")

  assert.deepEqual(
    result.updated_files.sort(),
    [
      path.posix.join("new-track", "live-one", "task.md"),
      path.posix.join("new-track", "_archive", "task-gone", "task.md"),
    ].sort(),
  )
})

test("track_rename works on a track with no tasks", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })

  commitAll(root)
  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" }, schedulePush: () => {} })
  assert.deepEqual(result.updated_files, [])
  assert.ok(await exists(path.join(root, "new-track", "track.md")))
})

test("track_rename renames nothing when a task card's frontmatter cannot be patched, and names the card", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "good-task", title: "T" } })
  const goodCard = path.join(root, "old-track", "good-task", "task.md")
  const good = await fs.readFile(goodCard, "utf8")
  const brokenCard = path.join(root, "old-track", "z-broken-task", "task.md")
  const broken = "---\ntitle: T\ntrack: old-track\ntrack: duplicate\nstatus: drafting\n---\nbody\n"
  await fs.mkdir(path.dirname(brokenCard), { recursive: true })
  await fs.writeFile(brokenCard, broken, "utf8")
  commitAll(root)
  const head = () => spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout
  const before = head()

  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" }, schedulePush: () => assert.fail("nothing to push") }),
      (error) => error.message.startsWith("track_rename: nothing was renamed") && error.message.includes(brokenCard) && /duplicated mapping key/u.test(error.message),
    )
  }
  assert.equal(await exists(path.join(root, "new-track")), false)
  assert.equal(await fs.readFile(goodCard, "utf8"), good)
  assert.equal(await fs.readFile(brokenCard, "utf8"), broken)
  assert.equal(head(), before)
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout, "")
})

test("track_rename still renames a track whose card has invalid YAML in a field it does not patch", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  const card = path.join(root, "old-track", "odd-task", "task.md")
  await fs.mkdir(path.dirname(card), { recursive: true })
  await fs.writeFile(card, "---\ntitle: a\ntitle: b\ntrack: old-track\nstatus: drafting\n---\nbody\n", "utf8")
  commitAll(root)

  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" }, schedulePush: () => {} })
  assert.deepEqual(result.updated_files, [path.posix.join("new-track", "odd-task", "task.md")])
  assert.match(await fs.readFile(path.join(root, "new-track", "odd-task", "task.md"), "utf8"), /^---\ntitle: a\ntitle: b\ntrack: new-track\n/u)
})

test("track_rename refuses when the target already exists", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await mkTrack(root, "new-track", { rows: [] })

  await assert.rejects(
    () => track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" } }),
    /already exists/,
  )
  assert.ok(await exists(path.join(root, "old-track")), "source must be untouched on refusal")
})

test("track_rename refuses an invalid new name and never echoes the candidate", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })

  await assert.rejects(
    () => track_rename({ deskRoot: root, input: { track: "old-track", to: "misc" } }),
    (error) => {
      assert.match(error.message, /invalid to/)
      assertNoCandidateLeak(error.message, "misc")
      return true
    },
  )
  assert.ok(await exists(path.join(root, "old-track")), "source must be untouched on refusal")
})

test("track_rename refuses a name after the desk's own git identity", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const result = spawnSync("git", ["-C", root, "config", "user.name", "Ari Mendelow"], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  await mkTrack(root, "old-track", { rows: [] })

  await assert.rejects(
    () => track_rename({ deskRoot: root, input: { track: "old-track", to: "ari-mendelow" } }),
    /invalid to/,
  )
})

test("track_rename throws when the track does not exist", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => track_rename({ deskRoot: root, input: { track: "ghost", to: "somewhere-new" } }),
    /does not exist/,
  )
})

test("track_rename requires track and to", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => track_rename({ deskRoot: root, input: { to: "somewhere-new" } }),
    /`track` is required, or `handle` in its place/,
  )
  await assert.rejects(
    () => track_rename({ deskRoot: root, input: { track: "main-track" } }),
    /`to` is required, with `track` or `handle`/,
  )
})

test("track_rename rejects a traversal-shaped source track without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => track_rename({ deskRoot: root, input: { track: "../evil", to: "somewhere-new" } }),
    (error) => {
      assert.match(error.message, /`track` must be a non-empty path segment/)
      assertNoCandidateLeak(error.message, "../evil")
      return true
    },
  )
})

test("track_rename defaults a missing input to an empty object", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => track_rename({ deskRoot: root }),
    /`to` is required/,
  )
})

test("track_rename reports mentions elsewhere but never rewrites them", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  const notePath = path.join(root, "_meta", "notes.md")
  const noteText = "See old-track for the plan.\n"
  await fs.writeFile(notePath, noteText, "utf8")

  commitAll(root)
  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" }, schedulePush: () => {} })
  assert.deepEqual(result.mentions, [path.posix.join("_meta", "notes.md")])
  assert.equal(await fs.readFile(notePath, "utf8"), noteText)
})

test("track_rename findTaskCards skips node_modules/.git/.state under the moved track", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await fs.mkdir(path.join(root, "old-track", "node_modules", "pkg"), { recursive: true })
  await fs.writeFile(
    path.join(root, "old-track", "node_modules", "pkg", "task.md"),
    "---\ntitle: decoy\n---\nnot a real task card",
    "utf8",
  )

  commitAll(root)
  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" }, schedulePush: () => {} })
  assert.deepEqual(result.updated_files, [])
})

test("track_rename reports a commit failure without losing the rename", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })

  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  commitAll(root)
  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" }, spawnGit })

  assert.equal(result.to, "new-track", "the rename itself is never lost to a commit failure")
  assert.ok(await exists(path.join(root, "new-track", "track.md")))
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
})

test("track_rename commits only its own paths, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  commitAll(root)

  // Simulates another process staging an unrelated path in the window
  // between track_rename's own dirty check and its stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" }, schedulePush: () => {} })

  assert.equal(result.to, "new-track")
  assert.equal(result.commit, undefined, "the rename's own commit succeeded")
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

// ── track_rename: push scheduling ────────────────────────────────────────────
//
// Same contract as task_move's (see above): a real push is scheduled through
// the injectable `schedulePush` seam, never the real, spawning default,
// exactly once, keyed on the plain top-level `deskRoot`, and only after a
// successful commit on a Git desk.

test("track_rename schedules a push exactly once, keyed on the plain deskRoot, after a successful commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  commitAll(root)

  const calls = []
  const result = await track_rename({
    deskRoot: root,
    input: { track: "old-track", to: "new-track" },
    schedulePush: (opts) => calls.push(opts),
  })

  assert.equal(result.to, "new-track")
  assert.deepEqual(calls, [{ root }])
})

test("track_rename never schedules a push on a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "old-track", { rows: [] })

  const calls = []
  await track_rename({
    deskRoot: root,
    input: { track: "old-track", to: "new-track" },
    schedulePush: (opts) => calls.push(opts),
  })

  assert.deepEqual(calls, [])
})

test("track_rename never schedules a push when the commit fails", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })

  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  commitAll(root)
  const calls = []
  const result = await track_rename({
    deskRoot: root,
    input: { track: "old-track", to: "new-track" },
    spawnGit,
    schedulePush: (opts) => calls.push(opts),
  })

  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
  assert.deepEqual(calls, [])
})

// ── track_rename: non-Git desk + person scoping ──────────────────────────────

test("track_rename works on a non-Git desk via a plain rename", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "old-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-one", title: "T" } })

  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" } })
  assert.equal(result.to, "new-track")
  const { data } = await readFront(path.join(root, "new-track", "task-one", "task.md"))
  assert.equal(data.track, "new-track")
})

test("track_rename honors the --person write prefix", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    person: "ari",
    input: { slug: "old-track", title: "old-track", scope: SCOPE },
  })

  const result = await track_rename({
    deskRoot: root,
    person: "ari",
    input: { track: "old-track", to: "new-track" },
  })
  assert.equal(result.to, path.posix.join("desks", "ari", "new-track"))
  assert.ok(await exists(path.join(root, "desks", "ari", "new-track", "track.md")))
})

// ── Handles (review of #51, S1) ────────────────────────────────────────────
//
// A folder whose name carries a secret's value is renamed by its handle, and
// neither the result nor an error ever shows the old name.

const SECRET_SLUG = "set pw hunter2"

async function deskWithSecretTask() {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  const dir = path.join(root, "main-track", SECRET_SLUG)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "task.md"), "---\ntitle: T\nstatus: drafting\ntrack: main-track\n---\nsee main-track/set pw hunter2\n")
  await fs.writeFile(path.join(root, "main-track", "notes.md"), "old home: main-track/set pw hunter2\n")
  commitAll(root)
  return { root, handle: folderHandle("task", root, dir) }
}

test("task_move renames a task by its handle and never shows the old name", async () => {
  const { root, handle } = await deskWithSecretTask()
  const result = await task_move({ deskRoot: root, input: { handle, to_slug: "restore-root-access" }, schedulePush: () => {} })
  assert.doesNotMatch(JSON.stringify(result), /hunter/)
  assert.equal(result.from, "main-track/<redacted segment>")
  assert.equal(result.to, "main-track/restore-root-access")
  assert.deepEqual(result.mentions, ["main-track/notes.md"])
  assert.equal(await exists(path.join(root, "main-track", "restore-root-access", "task.md")), true)
  assert.equal(await exists(path.join(root, "main-track", SECRET_SLUG)), false)
})

test("task_move by handle refuses a stale handle, a mixed call and a clash without naming the folder", async () => {
  const { root, handle } = await deskWithSecretTask()
  await assert.rejects(() => task_move({ deskRoot: root, input: { handle: "task-0000000000", to_slug: "x-y" } }), /no task in this session's desk has that handle/)
  await assert.rejects(() => task_move({ deskRoot: root, input: { handle, track: "main-track", to_slug: "x-y" } }), /pass `handle` or `track` and `slug`, not both/)
  await assert.rejects(() => task_move({ deskRoot: root, input: { handle, slug: "a", to_slug: "x-y" } }), /not both/)
  await assert.rejects(
    () => task_move({ deskRoot: root, input: { handle } }),
    (error) => {
      assert.match(error.message, /target already exists at main-track\/<redacted segment>/)
      assert.doesNotMatch(error.message, /hunter/)
      return true
    },
  )
  await assert.rejects(
    () => task_move({ deskRoot: root, input: { track: "main-track", slug: "set pw hunter3", to_slug: "x-y" } }),
    (error) => {
      assert.match(error.message, /task does not exist at main-track\/<redacted segment>/)
      return true
    },
  )
})

test("track_rename renames a track by its handle and never shows the old name", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await fs.mkdir(path.join(root, "pw-hunter2-track", "some-task"), { recursive: true })
  await fs.writeFile(path.join(root, "pw-hunter2-track", "track.md"), `---\ntitle: T\nscope: ${SCOPE}\n---\n`)
  await fs.writeFile(path.join(root, "pw-hunter2-track", "some-task", "task.md"), "---\ntitle: T\nstatus: drafting\ntrack: pw-hunter2-track\n---\n")
  commitAll(root)
  const handle = folderHandle("track", root, path.join(root, "pw-hunter2-track"))

  await assert.rejects(() => track_rename({ deskRoot: root, input: { handle: "track-0000000000", to: "access-work" } }), /no track in this session's desk has that handle/)
  await assert.rejects(() => track_rename({ deskRoot: root, input: { handle, track: "pw-hunter2-track", to: "access-work" } }), /pass `handle` or `track`, not both/)

  const result = await track_rename({ deskRoot: root, input: { handle, to: "access-work" }, schedulePush: () => {} })
  assert.doesNotMatch(JSON.stringify(result), /hunter/)
  assert.equal(result.from, "<redacted segment>")
  assert.deepEqual(result.updated_files, ["access-work/some-task/task.md"])
  assert.equal((await readFront(path.join(root, "access-work", "some-task", "task.md"))).data.track, "access-work")
})

test("track_rename errors show a credential-like track name redacted", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => track_rename({ deskRoot: root, input: { track: "pw-hunter2-track", to: "access-work" } }),
    (error) => {
      assert.equal(error.message, "track_rename: track does not exist at <redacted segment>")
      return true
    },
  )
  await mkTrack(root, "access-work", { rows: [] })
  await mkTrack(root, "other-track", { rows: [] })
  await assert.rejects(() => track_rename({ deskRoot: root, input: { track: "other-track", to: "access-work" } }), /target already exists at access-work/)
})

test("task_move into_task whose git mv fails leaves no empty _iterations folder behind", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["keep-task", "dup-task"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "keep-task", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "dup-task", title: "T" } })
  commitAll(root)
  const failMv = (command, args, options) => (args.includes("mv") ? { status: 1, stdout: "", stderr: "mv refused" } : spawnSync(command, args, options))
  await assert.rejects(task_move({ deskRoot: root, input: { track: "main-track", slug: "dup-task", into_task: "keep-task" }, spawnGit: failMv, schedulePush: () => {} }), /git mv failed/u)
  await assert.rejects(fs.stat(path.join(root, "main-track", "keep-task", "_iterations")), { code: "ENOENT" })
})

// ── the outcome record survives every card rewrite ──────────────────────────

test("task_move and track_rename keep signoff, flow and returns exactly as written", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "Unique title for the record test" } })
  await task_update({ deskRoot: root, input: { track: "main-track", slug: "old-name", frontmatter: { status: "done" }, evidence: DONE_EVIDENCE } })
  const file = path.join(root, "main-track", "old-name", "task.md")
  const card = await readFront(file)
  card.data.returns = ["processing, 2026-10-05T10:00:00Z, agent_error"]
  await writeMarkdown(file, card.data, card.content)
  const keep = (data) => ({ signoff: data.signoff, flow: data.flow, returns: data.returns })
  const before = keep((await readFront(file)).data)
  assert.equal(before.signoff.state, "delivered_unsigned")

  await task_move({ deskRoot: root, input: { track: "main-track", slug: "old-name", to_slug: "new-name" }, schedulePush: () => {} })
  assert.deepEqual(keep((await readFront(path.join(root, "main-track", "new-name", "task.md"))).data), before)

  await track_rename({ deskRoot: root, input: { track: "main-track", to: "renamed-track" }, schedulePush: () => {} })
  assert.deepEqual(keep((await readFront(path.join(root, "renamed-track", "new-name", "task.md"))).data), before)

  await task_archive({ deskRoot: root, input: { track: "renamed-track", slug: "new-name" } })
  const archived = path.join(root, "renamed-track", "_archive", "new-name", "task.md")
  assert.deepEqual(keep((await readFront(archived)).data), before)

  await task_move({ deskRoot: root, input: { track: "renamed-track", slug: "new-name", to_slug: "again" }, schedulePush: () => {} })
  assert.deepEqual(keep((await readFront(path.join(root, "renamed-track", "_archive", "again", "task.md"))).data), before)
})
