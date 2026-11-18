// move — task_update and track_update, continued: the same suite as move.test.js, split so no single file sets a Windows shard's time.

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


test("task_update defaults a missing input to an empty object", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => moveTask({ deskRoot: root }),
    /`track` and `slug` are required/,
  )
})

test("task_update leaves a track.md with no Tasks table alone", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await track_create({
    deskRoot: root,
    input: { slug: "main-track", title: "main-track", scope: SCOPE, body: "## Scope\n\nNo tasks table here." },
  })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })
  const before = await trackBody(root, "main-track")

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })

  assert.equal(result.updated_files.includes(path.posix.join("main-track", "track.md")), false)
  assert.equal(await trackBody(root, "main-track"), before)
})

test("task_update leaves a track.md alone when the Tasks heading has no table under it", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await track_create({
    deskRoot: root,
    input: {
      slug: "main-track",
      title: "main-track",
      scope: SCOPE,
      body: "## Tasks\n\nNothing tabular here, just prose.",
    },
  })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })
  assert.equal(result.updated_files.includes(path.posix.join("main-track", "track.md")), false)
})

test("task_update leaves a track.md alone when the Tasks heading is the last line of the body", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await track_create({
    deskRoot: root,
    input: { slug: "main-track", title: "main-track", scope: SCOPE, body: "## Scope\n\nSomething.\n\n## Tasks" },
  })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })
  assert.equal(result.updated_files.includes(path.posix.join("main-track", "track.md")), false)
})

test("task_update leaves a track.md alone when the header row has no separator row under it", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await track_create({
    deskRoot: root,
    input: {
      slug: "main-track",
      title: "main-track",
      scope: SCOPE,
      body: "## Tasks\n\n| Slug | State |",
    },
  })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })
  assert.equal(result.updated_files.includes(path.posix.join("main-track", "track.md")), false)
})

test("task_update leaves a track.md alone when the row after the header isn't a valid separator", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await track_create({
    deskRoot: root,
    input: {
      slug: "main-track",
      title: "main-track",
      scope: SCOPE,
      body: "## Tasks\n\n| Slug | State |\n| not a separator row |",
    },
  })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })
  assert.equal(result.updated_files.includes(path.posix.join("main-track", "track.md")), false)
})

// ── task_update: archived tasks ────────────────────────────────────────────────

test("task_update relocates an archived task and keeps it archived", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: [] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "old-task", title: "T" } })
  await task_archive({ deskRoot: root, input: { track: "track-a", slug: "old-task", evidence: DONE_EVIDENCE } })

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "track-a", slug: "old-task", to_track: "track-b", to_slug: "renamed-task" },
    schedulePush: () => {},
  })

  assert.equal(result.from, path.posix.join("track-a", "_archive", "old-task"))
  assert.equal(result.to, path.posix.join("track-b", "_archive", "renamed-task"))
  assert.equal(await exists(path.join(root, "track-a", "_archive", "old-task")), false)
  const { data } = await readFront(path.join(root, "track-b", "_archive", "renamed-task", "task.md"))
  assert.equal(data.track, "track-b")
  assert.equal(data.status, "done")
})

// ── task_update: refusals ─────────────────────────────────────────────────────

test("task_update moves nothing when a track card it would edit cannot be parsed, and names the card", async () => {
  for (const broken of ["main-track", "other-track"]) {
    const root = await mkTempDeskRoot()
    initGit(root)
    await mkTrack(root, "main-track", { rows: [] })
    await mkTrack(root, "other-track", { rows: [] })
    await task_create({ deskRoot: root, input: { track: "main-track", slug: "task-one", title: "T" } })
    const trackMd = path.join(root, broken, "track.md")
    const text = (await fs.readFile(trackMd, "utf8")).replace(/^---\n/u, "---\nupdated: 2026-01-01\nupdated: 2026-01-02\n")
    await fs.writeFile(trackMd, text, "utf8")
    commitAll(root)
    const card = path.join(root, "main-track", "task-one", "task.md")
    const before = await fs.readFile(card, "utf8")

    await assert.rejects(
      moveTask({ deskRoot: root, input: { track: "main-track", slug: "task-one", to_track: "other-track" }, schedulePush: () => assert.fail("nothing to push") }),
      (error) => error.message.startsWith("task_update: Fix the card, then try again: nothing was moved") && error.message.includes(trackMd) && /duplicated mapping key/u.test(error.message),
    )
    assert.equal(await fs.readFile(card, "utf8"), before)
    assert.equal(await exists(path.join(root, "other-track", "task-one")), false)
    assert.equal(await fs.readFile(trackMd, "utf8"), text)
    assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout, "")
  }
})

test("task_update refuses when the target already exists", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "task-one", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "task-two", title: "T" } })

  await assert.rejects(
    () => moveTask({ deskRoot: root, input: { track: "main-track", slug: "task-one", to_slug: "task-two" } }),
    /already exists/,
  )
  assert.ok(await exists(path.join(root, "main-track", "task-one")), "source must be untouched on refusal")
})

test("task_update refuses an invalid to_slug and never echoes the candidate", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  await assert.rejects(
    () =>
      moveTask({
        deskRoot: root,
        input: { track: "main-track", slug: "old-name", to_slug: "hi-there-friend" },
      }),
    (error) => {
      assert.match(error.message, /invalid to_slug/)
      assertNoCandidateLeak(error.message, "hi-there-friend")
      return true
    },
  )
  assert.ok(await exists(path.join(root, "main-track", "old-name")), "source must be untouched on refusal")
})

test("task_update throws when neither a live nor an archived task exists", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => moveTask({ deskRoot: root, input: { track: "ghost", slug: "phantom" } }),
    /does not exist/,
  )
})

test("task_update requires track and slug", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => moveTask({ deskRoot: root, input: { slug: "s" } }),
    /`track` and `slug` are required/,
  )
  await assert.rejects(
    () => moveTask({ deskRoot: root, input: { track: "main-track" } }),
    /`track` and `slug` are required/,
  )
})

// ── task_update: traversal-shaped input (fix round 1, Important) ─────────────
//
// No refusal may ever quote a candidate, including a path-segment error —
// `track`/`slug` are guarded up front, before any path-resolution code
// (`resolveWriteTarget`/`validateWriteSegment`, whose message is allowed to
// quote) ever sees them. Each condition of the shared guard is exercised
// once via `track`; the remaining tests confirm every field that reaches it
// is actually wired up.

test("task_update rejects a non-string track without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => moveTask({ deskRoot: root, input: { track: 42, slug: "old-name" } }),
    (error) => {
      assert.match(error.message, /`track` must be a non-empty path segment/)
      return true
    },
  )
})

test("task_update rejects an empty track without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => moveTask({ deskRoot: root, input: { track: "   ", slug: "old-name" } }),
    /`track` must be a non-empty path segment/,
  )
})

test("task_update rejects a track containing a forward slash without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => moveTask({ deskRoot: root, input: { track: "foo/bar", slug: "old-name" } }),
    (error) => {
      assert.match(error.message, /`track` must be a non-empty path segment/)
      assertNoCandidateLeak(error.message, "foo/bar")
      return true
    },
  )
})

test("task_update rejects a track containing a backslash without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => moveTask({ deskRoot: root, input: { track: "foo\\bar", slug: "old-name" } }),
    (error) => {
      assert.match(error.message, /`track` must be a non-empty path segment/)
      assertNoCandidateLeak(error.message, "foo\\bar")
      return true
    },
  )
})

test("task_update rejects a traversal-shaped source track without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => moveTask({ deskRoot: root, input: { track: "../evil", slug: "old-name" } }),
    (error) => {
      assert.match(error.message, /`track` must be a non-empty path segment/)
      assertNoCandidateLeak(error.message, "../evil")
      return true
    },
  )
})

test("task_update rejects a traversal-shaped source slug without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => moveTask({ deskRoot: root, input: { track: "main-track", slug: "../evil" } }),
    (error) => {
      assert.match(error.message, /`slug` must be a non-empty path segment/)
      assertNoCandidateLeak(error.message, "../evil")
      return true
    },
  )
})

test("task_update rejects a traversal-shaped to_track without quoting it", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["solo-task"] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "solo-task", title: "T" } })

  await assert.rejects(
    () =>
      moveTask({
        deskRoot: root,
        input: { track: "track-a", slug: "solo-task", to_track: "../evil" },
      }),
    (error) => {
      assert.match(error.message, /invalid to_track/)
      assertNoCandidateLeak(error.message, "../evil")
      return true
    },
  )
  assert.ok(await exists(path.join(root, "track-a", "solo-task", "task.md")))
})

// ── task_update: mentions ─────────────────────────────────────────────────────

test("task_update reports mentions elsewhere but never rewrites them", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  const notePath = path.join(root, "_meta", "notes.md")
  const noteText = "See main-track/old-name/task.md for context.\n"
  await fs.writeFile(notePath, noteText, "utf8")
  const unrelatedNotePath = path.join(root, "_meta", "unrelated.md")
  await fs.writeFile(unrelatedNotePath, "Nothing to see here.\n", "utf8")
  const nonMarkdownPath = path.join(root, "_meta", "data.json")
  await fs.writeFile(nonMarkdownPath, '{"track":"main-track/old-name"}', "utf8")

  commitAll(root)
  const result = await moveTask({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })

  assert.deepEqual(result.mentions, [path.posix.join("_meta", "notes.md")])
  assert.equal(await fs.readFile(notePath, "utf8"), noteText, "mentions are reported, never rewritten")
})
