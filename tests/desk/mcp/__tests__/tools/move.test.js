// move — task_update (rename/relocate a task, live or archived) and
// track_update (rename a track, updating every task card under it).
//
// Both stage moves with `git mv` semantics on a Git desk, or fall back to a
// plain rename otherwise, then commit exactly the paths they wrote (M4-6
// Part 2). Coverage below is written TDD-first per task M4-2's checklist:
// same-track rename, cross-track move, archived-task move, track rename
// with archived tasks, target-exists refusal, invalid-new-name refusal,
// mentions reported but not rewritten, and a non-Git desk working the same
// way (no staging, no commit).
//
// Unarchiving, merging into another task, dirty-tree refusals and track_update are in move_archive_and_rename.test.js.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { moveTask, renameTrack } from "../../../../../plugins/desk/mcp/src/tools/move.js"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { task_create, task_archive, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { track_create } from "../../../../../plugins/desk/mcp/src/tools/track.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"
import { folderHandle } from "../../../../../plugins/desk/mcp/src/desk/handles.js"
import { DONE_EVIDENCE, SCOPE, assertNoCandidateLeak, commitAll, gitLog, gitStatus, initGit, lastCommitMessage, mkTrack, tasksTableBody, trackBody } from "./_move_fixture.js"
import { assertNextFirst, notCommitted, routedPaths } from "./_route_around.js"


test("task_update renames a task within the same track (Git desk) and renames its tasks-table row", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name", "other-task"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })

  assert.equal(result.from, path.posix.join("main-track", "old-name"))
  assert.equal(result.to, path.posix.join("main-track", "new-name"))
  assert.deepEqual(result.mentions, [])
  assert.ok(result.updated_files.includes(path.posix.join("main-track", "new-name", "task.md")))
  assert.ok(result.updated_files.includes(path.posix.join("main-track", "track.md")))

  assert.equal(await exists(path.join(root, "main-track", "old-name")), false)
  const { data } = await readFront(path.join(root, "main-track", "new-name", "task.md"))
  assert.equal(data.track, "main-track")

  const body = await trackBody(root, "main-track")
  assert.match(body, /`new-name`/)
  assert.doesNotMatch(body, /`old-name`/)
  assert.match(body, /`other-task`/, "the other row must be left alone")

  // Staged and committed (M4-6 Part 2): the tree is clean afterward, and the
  // new commit names the tool and the move.
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "task_update: old-name → main-track")
})

test("task_update renames a task under a track that has no track.md, leaving the missing table alone", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  // No track_create call: the track folder gets no track.md at all, which
  // editTasksTable treats as "no table to maintain" rather than an error.
  await task_create({ deskRoot: root, input: { track: "lonely-track", slug: "old-name", title: "T" } })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "lonely-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })

  assert.equal(result.to, path.posix.join("lonely-track", "new-name"))
  assert.deepEqual(result.updated_files, [path.posix.join("lonely-track", "new-name", "task.md")])
  assert.equal(await exists(path.join(root, "lonely-track", "track.md")), false)
})

test("task_update preserves every other frontmatter byte untouched: a date-only value, a long single-line scalar, quoted and unquoted values, and a note: | block", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })
  const filePath = path.join(root, "main-track", "old-name", "task.md")
  const handWritten = [
    "---",
    "schema_version: 1",
    "title: T",
    "track: main-track",
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
  await moveTask({ deskRoot: root, input: { track: "main-track", slug: "old-name", to_slug: "new-name" }, schedulePush: () => {} })

  const raw = await fs.readFile(path.join(root, "main-track", "new-name", "task.md"), "utf8")
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

test("task_update updates a plain (non-backtick) slug cell too", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await track_create({
    deskRoot: root,
    input: {
      slug: "main-track",
      title: "main-track",
      scope: SCOPE,
      body: [
        "## Tasks",
        "",
        "| Slug | State |",
        "|------|-------|",
        "| old-name | drafting |",
      ].join("\n"),
    },
  })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  commitAll(root)
  await moveTask({ deskRoot: root, input: { track: "main-track", slug: "old-name", to_slug: "new-name" }, schedulePush: () => {} })

  const body = await trackBody(root, "main-track")
  assert.match(body, /\|\s*new-name\s*\|/)
  assert.doesNotMatch(body, /\bold-name\b/)
})

// ── task_update: cross-track move ─────────────────────────────────────────────

test("task_update moves a task across tracks, keeping the slug, and moves its tasks-table row", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["shared-task"] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "shared-task", title: "T" } })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "track-a", slug: "shared-task", to_track: "track-b" },
    schedulePush: () => {},
  })

  assert.equal(result.from, path.posix.join("track-a", "shared-task"))
  assert.equal(result.to, path.posix.join("track-b", "shared-task"))
  assert.ok(result.updated_files.includes(path.posix.join("track-b", "shared-task", "task.md")))
  assert.ok(result.updated_files.includes(path.posix.join("track-a", "track.md")))
  assert.ok(result.updated_files.includes(path.posix.join("track-b", "track.md")))

  const { data } = await readFront(path.join(root, "track-b", "shared-task", "task.md"))
  assert.equal(data.track, "track-b")

  assert.doesNotMatch(await trackBody(root, "track-a"), /`shared-task`/)
  assert.match(await trackBody(root, "track-b"), /`shared-task`/)
})

test("task_update moves and renames simultaneously across tracks", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["old-name"] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "old-name", title: "T" } })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "track-a", slug: "old-name", to_track: "track-b", to_slug: "new-name" },
    schedulePush: () => {},
  })

  assert.equal(result.to, path.posix.join("track-b", "new-name"))
  assert.ok(await exists(path.join(root, "track-b", "new-name", "task.md")))
  assert.match(await trackBody(root, "track-b"), /`new-name`/)
  assert.doesNotMatch(await trackBody(root, "track-a"), /`old-name`/)
})

// ── task_update: to_track validation (fix round 1, Critical) ──────────────────
//
// A moved task never creates a track implicitly: `to_track` goes through the
// same `validateTrackName` (with the same `operatorNames`) that
// `track_create`/`track_update` already enforce, and the destination track's
// `track.md` must already exist.

test("task_update refuses a destination track that doesn't exist yet, and creates nothing", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["solo-task"] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "solo-task", title: "T" } })

  await assert.rejects(
    () =>
      moveTask({
        deskRoot: root,
        input: { track: "track-a", slug: "solo-task", to_track: "brand-new" },
      }),
    /the destination track doesn't exist; create it first with track_create \(a scope line is required\)/,
  )

  assert.equal(await exists(path.join(root, "brand-new")), false, "no track.md means no implicit track")
  assert.ok(await exists(path.join(root, "track-a", "solo-task", "task.md")), "source must be untouched")
  assert.match(await trackBody(root, "track-a"), /`solo-task`/, "source table row must be untouched")
})

test("task_update refuses a catch-all destination track", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["solo-task"] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "solo-task", title: "T" } })

  await assert.rejects(
    () =>
      moveTask({
        deskRoot: root,
        input: { track: "track-a", slug: "solo-task", to_track: "misc" },
      }),
    (error) => {
      assert.match(error.message, /invalid to_track/)
      assertNoCandidateLeak(error.message, "misc")
      return true
    },
  )
  assert.equal(await exists(path.join(root, "misc")), false)
  assert.ok(await exists(path.join(root, "track-a", "solo-task", "task.md")))
})

test("task_update refuses a person-named destination track", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const configured = spawnSync("git", ["-C", root, "config", "user.name", "Ari Mendelow"], {
    encoding: "utf8",
  })
  assert.equal(configured.status, 0, configured.stderr)
  await mkTrack(root, "track-a", { rows: ["solo-task"] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "solo-task", title: "T" } })

  await assert.rejects(
    () =>
      moveTask({
        deskRoot: root,
        input: { track: "track-a", slug: "solo-task", to_track: "ari-mendelow" },
      }),
    (error) => {
      assert.match(error.message, /invalid to_track/)
      assertNoCandidateLeak(error.message, "ari-mendelow")
      return true
    },
  )
  assert.equal(await exists(path.join(root, "ari-mendelow")), false)
})

test("task_update moves into a valid, already-existing destination track", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["solo-task"] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "solo-task", title: "T" } })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "track-a", slug: "solo-task", to_track: "track-b" },
    schedulePush: () => {},
  })

  assert.equal(result.to, path.posix.join("track-b", "solo-task"))
  assert.ok(await exists(path.join(root, "track-b", "solo-task", "task.md")))
})

test("task_update across tracks leaves both tables alone when the source table has no row for the slug", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["unrelated-row"] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "untracked-in-table", title: "T" } })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "track-a", slug: "untracked-in-table", to_track: "track-b" },
    schedulePush: () => {},
  })

  assert.equal(result.updated_files.includes(path.posix.join("track-a", "track.md")), false)
  assert.equal(result.updated_files.includes(path.posix.join("track-b", "track.md")), false)
  assert.match(await trackBody(root, "track-a"), /`unrelated-row`/)
  assert.doesNotMatch(await trackBody(root, "track-b"), /`untracked-in-table`/)
})

test("task_update across tracks leaves the destination table alone when it exists but has no Tasks table", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["moving-task"] })
  await track_create({
    deskRoot: root,
    input: { slug: "track-b", title: "track-b", scope: SCOPE, body: "## Scope\n\nNo tasks table here." },
  })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "moving-task", title: "T" } })
  const before = await trackBody(root, "track-b")

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "track-a", slug: "moving-task", to_track: "track-b" },
    schedulePush: () => {},
  })

  assert.ok(await exists(path.join(root, "track-b", "moving-task", "task.md")))
  assert.ok(result.updated_files.includes(path.posix.join("track-a", "track.md")))
  assert.equal(result.updated_files.includes(path.posix.join("track-b", "track.md")), false)
  assert.equal(await trackBody(root, "track-b"), before)
})

test("task_update within the same track leaves the table alone when it has no row for the slug", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["unrelated-row"] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "untracked-in-table", title: "T" } })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "track-a", slug: "untracked-in-table", to_slug: "still-untracked" },
    schedulePush: () => {},
  })

  assert.equal(result.updated_files.includes(path.posix.join("track-a", "track.md")), false)
  assert.match(await trackBody(root, "track-a"), /`unrelated-row`/)
  assert.doesNotMatch(await trackBody(root, "track-a"), /still-untracked/)
})
