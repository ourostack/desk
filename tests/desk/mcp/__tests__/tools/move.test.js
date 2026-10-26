// move — task_move (rename/relocate a task, live or archived) and
// track_rename (rename a track, updating every task card under it).
//
// Both stage moves with `git mv` semantics on a Git desk, or fall back to a
// plain rename otherwise, then commit exactly the paths they wrote (M4-6
// Part 2). Coverage below is written TDD-first per task M4-2's checklist:
// same-track rename, cross-track move, archived-task move, track rename
// with archived tasks, target-exists refusal, invalid-new-name refusal,
// mentions reported but not rewritten, and a non-Git desk working the same
// way (no staging, no commit).
//
// Unarchiving, merging into another task, dirty-tree refusals and track_rename are in move_archive_and_rename.test.js.

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

test("task_move renames a task within the same track (Git desk) and renames its tasks-table row", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name", "other-task"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  commitAll(root)
  const result = await task_move({
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
  assert.equal(lastCommitMessage(root), "task_move: old-name → main-track")
})

test("task_move renames a task under a track that has no track.md, leaving the missing table alone", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  // No track_create call: the track folder gets no track.md at all, which
  // editTasksTable treats as "no table to maintain" rather than an error.
  await task_create({ deskRoot: root, input: { track: "lonely-track", slug: "old-name", title: "T" } })

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "lonely-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })

  assert.equal(result.to, path.posix.join("lonely-track", "new-name"))
  assert.deepEqual(result.updated_files, [path.posix.join("lonely-track", "new-name", "task.md")])
  assert.equal(await exists(path.join(root, "lonely-track", "track.md")), false)
})

test("task_move preserves every other frontmatter byte untouched: a date-only value, a long single-line scalar, quoted and unquoted values, and a note: | block", async () => {
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
  await task_move({ deskRoot: root, input: { track: "main-track", slug: "old-name", to_slug: "new-name" }, schedulePush: () => {} })

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

test("task_move updates a plain (non-backtick) slug cell too", async () => {
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
  await task_move({ deskRoot: root, input: { track: "main-track", slug: "old-name", to_slug: "new-name" }, schedulePush: () => {} })

  const body = await trackBody(root, "main-track")
  assert.match(body, /\|\s*new-name\s*\|/)
  assert.doesNotMatch(body, /\bold-name\b/)
})

// ── task_move: cross-track move ─────────────────────────────────────────────

test("task_move moves a task across tracks, keeping the slug, and moves its tasks-table row", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["shared-task"] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "shared-task", title: "T" } })

  commitAll(root)
  const result = await task_move({
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

test("task_move moves and renames simultaneously across tracks", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["old-name"] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "old-name", title: "T" } })

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "track-a", slug: "old-name", to_track: "track-b", to_slug: "new-name" },
    schedulePush: () => {},
  })

  assert.equal(result.to, path.posix.join("track-b", "new-name"))
  assert.ok(await exists(path.join(root, "track-b", "new-name", "task.md")))
  assert.match(await trackBody(root, "track-b"), /`new-name`/)
  assert.doesNotMatch(await trackBody(root, "track-a"), /`old-name`/)
})

// ── task_move: to_track validation (fix round 1, Critical) ──────────────────
//
// A moved task never creates a track implicitly: `to_track` goes through the
// same `validateTrackName` (with the same `operatorNames`) that
// `track_create`/`track_rename` already enforce, and the destination track's
// `track.md` must already exist.

test("task_move refuses a destination track that doesn't exist yet, and creates nothing", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["solo-task"] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "solo-task", title: "T" } })

  await assert.rejects(
    () =>
      task_move({
        deskRoot: root,
        input: { track: "track-a", slug: "solo-task", to_track: "brand-new" },
      }),
    /the destination track doesn't exist; create it first with track_create \(a scope line is required\)/,
  )

  assert.equal(await exists(path.join(root, "brand-new")), false, "no track.md means no implicit track")
  assert.ok(await exists(path.join(root, "track-a", "solo-task", "task.md")), "source must be untouched")
  assert.match(await trackBody(root, "track-a"), /`solo-task`/, "source table row must be untouched")
})

test("task_move refuses a catch-all destination track", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["solo-task"] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "solo-task", title: "T" } })

  await assert.rejects(
    () =>
      task_move({
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

test("task_move refuses a person-named destination track", async () => {
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
      task_move({
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

test("task_move moves into a valid, already-existing destination track", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["solo-task"] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "solo-task", title: "T" } })

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "track-a", slug: "solo-task", to_track: "track-b" },
    schedulePush: () => {},
  })

  assert.equal(result.to, path.posix.join("track-b", "solo-task"))
  assert.ok(await exists(path.join(root, "track-b", "solo-task", "task.md")))
})

test("task_move across tracks leaves both tables alone when the source table has no row for the slug", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["unrelated-row"] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "untracked-in-table", title: "T" } })

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "track-a", slug: "untracked-in-table", to_track: "track-b" },
    schedulePush: () => {},
  })

  assert.equal(result.updated_files.includes(path.posix.join("track-a", "track.md")), false)
  assert.equal(result.updated_files.includes(path.posix.join("track-b", "track.md")), false)
  assert.match(await trackBody(root, "track-a"), /`unrelated-row`/)
  assert.doesNotMatch(await trackBody(root, "track-b"), /`untracked-in-table`/)
})

test("task_move across tracks leaves the destination table alone when it exists but has no Tasks table", async () => {
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
  const result = await task_move({
    deskRoot: root,
    input: { track: "track-a", slug: "moving-task", to_track: "track-b" },
    schedulePush: () => {},
  })

  assert.ok(await exists(path.join(root, "track-b", "moving-task", "task.md")))
  assert.ok(result.updated_files.includes(path.posix.join("track-a", "track.md")))
  assert.equal(result.updated_files.includes(path.posix.join("track-b", "track.md")), false)
  assert.equal(await trackBody(root, "track-b"), before)
})

test("task_move within the same track leaves the table alone when it has no row for the slug", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["unrelated-row"] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "untracked-in-table", title: "T" } })

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "track-a", slug: "untracked-in-table", to_slug: "still-untracked" },
    schedulePush: () => {},
  })

  assert.equal(result.updated_files.includes(path.posix.join("track-a", "track.md")), false)
  assert.match(await trackBody(root, "track-a"), /`unrelated-row`/)
  assert.doesNotMatch(await trackBody(root, "track-a"), /still-untracked/)
})

test("task_move defaults a missing input to an empty object", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => task_move({ deskRoot: root }),
    /`track` and `slug` are required/,
  )
})

test("task_move leaves a track.md with no Tasks table alone", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await track_create({
    deskRoot: root,
    input: { slug: "main-track", title: "main-track", scope: SCOPE, body: "## Scope\n\nNo tasks table here." },
  })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })
  const before = await trackBody(root, "main-track")

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })

  assert.equal(result.updated_files.includes(path.posix.join("main-track", "track.md")), false)
  assert.equal(await trackBody(root, "main-track"), before)
})

test("task_move leaves a track.md alone when the Tasks heading has no table under it", async () => {
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
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })
  assert.equal(result.updated_files.includes(path.posix.join("main-track", "track.md")), false)
})

test("task_move leaves a track.md alone when the Tasks heading is the last line of the body", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await track_create({
    deskRoot: root,
    input: { slug: "main-track", title: "main-track", scope: SCOPE, body: "## Scope\n\nSomething.\n\n## Tasks" },
  })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })
  assert.equal(result.updated_files.includes(path.posix.join("main-track", "track.md")), false)
})

test("task_move leaves a track.md alone when the header row has no separator row under it", async () => {
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
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })
  assert.equal(result.updated_files.includes(path.posix.join("main-track", "track.md")), false)
})

test("task_move leaves a track.md alone when the row after the header isn't a valid separator", async () => {
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
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })
  assert.equal(result.updated_files.includes(path.posix.join("main-track", "track.md")), false)
})

// ── task_move: archived tasks ────────────────────────────────────────────────

test("task_move relocates an archived task and keeps it archived", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: [] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "old-task", title: "T" } })
  await task_archive({ deskRoot: root, input: { track: "track-a", slug: "old-task", evidence: DONE_EVIDENCE } })

  commitAll(root)
  const result = await task_move({
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

// ── task_move: refusals ─────────────────────────────────────────────────────

test("task_move moves nothing when a track card it would edit cannot be parsed, and names the card", async () => {
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
      task_move({ deskRoot: root, input: { track: "main-track", slug: "task-one", to_track: "other-track" }, schedulePush: () => assert.fail("nothing to push") }),
      (error) => error.message.startsWith("task_move: nothing was moved") && error.message.includes(trackMd) && /duplicated mapping key/u.test(error.message),
    )
    assert.equal(await fs.readFile(card, "utf8"), before)
    assert.equal(await exists(path.join(root, "other-track", "task-one")), false)
    assert.equal(await fs.readFile(trackMd, "utf8"), text)
    assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout, "")
  }
})

test("task_move refuses when the target already exists", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "task-one", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "task-two", title: "T" } })

  await assert.rejects(
    () => task_move({ deskRoot: root, input: { track: "main-track", slug: "task-one", to_slug: "task-two" } }),
    /already exists/,
  )
  assert.ok(await exists(path.join(root, "main-track", "task-one")), "source must be untouched on refusal")
})

test("task_move refuses an invalid to_slug and never echoes the candidate", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  await assert.rejects(
    () =>
      task_move({
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

test("task_move throws when neither a live nor an archived task exists", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => task_move({ deskRoot: root, input: { track: "ghost", slug: "phantom" } }),
    /does not exist/,
  )
})

test("task_move requires track and slug", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => task_move({ deskRoot: root, input: { slug: "s" } }),
    /`track` and `slug` are required/,
  )
  await assert.rejects(
    () => task_move({ deskRoot: root, input: { track: "main-track" } }),
    /`track` and `slug` are required/,
  )
})

// ── task_move: traversal-shaped input (fix round 1, Important) ─────────────
//
// No refusal may ever quote a candidate, including a path-segment error —
// `track`/`slug` are guarded up front, before any path-resolution code
// (`resolveWriteTarget`/`validateWriteSegment`, whose message is allowed to
// quote) ever sees them. Each condition of the shared guard is exercised
// once via `track`; the remaining tests confirm every field that reaches it
// is actually wired up.

test("task_move rejects a non-string track without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => task_move({ deskRoot: root, input: { track: 42, slug: "old-name" } }),
    (error) => {
      assert.match(error.message, /`track` must be a non-empty path segment/)
      return true
    },
  )
})

test("task_move rejects an empty track without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => task_move({ deskRoot: root, input: { track: "   ", slug: "old-name" } }),
    /`track` must be a non-empty path segment/,
  )
})

test("task_move rejects a track containing a forward slash without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => task_move({ deskRoot: root, input: { track: "foo/bar", slug: "old-name" } }),
    (error) => {
      assert.match(error.message, /`track` must be a non-empty path segment/)
      assertNoCandidateLeak(error.message, "foo/bar")
      return true
    },
  )
})

test("task_move rejects a track containing a backslash without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => task_move({ deskRoot: root, input: { track: "foo\\bar", slug: "old-name" } }),
    (error) => {
      assert.match(error.message, /`track` must be a non-empty path segment/)
      assertNoCandidateLeak(error.message, "foo\\bar")
      return true
    },
  )
})

test("task_move rejects a traversal-shaped source track without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => task_move({ deskRoot: root, input: { track: "../evil", slug: "old-name" } }),
    (error) => {
      assert.match(error.message, /`track` must be a non-empty path segment/)
      assertNoCandidateLeak(error.message, "../evil")
      return true
    },
  )
})

test("task_move rejects a traversal-shaped source slug without quoting it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => task_move({ deskRoot: root, input: { track: "main-track", slug: "../evil" } }),
    (error) => {
      assert.match(error.message, /`slug` must be a non-empty path segment/)
      assertNoCandidateLeak(error.message, "../evil")
      return true
    },
  )
})

test("task_move rejects a traversal-shaped to_track without quoting it", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["solo-task"] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "solo-task", title: "T" } })

  await assert.rejects(
    () =>
      task_move({
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

// ── task_move: mentions ─────────────────────────────────────────────────────

test("task_move reports mentions elsewhere but never rewrites them", async () => {
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
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })

  assert.deepEqual(result.mentions, [path.posix.join("_meta", "notes.md")])
  assert.equal(await fs.readFile(notePath, "utf8"), noteText, "mentions are reported, never rewritten")
})

test("task_move mentions scan skips node_modules/.git/.state directories", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true })
  await fs.writeFile(
    path.join(root, "node_modules", "pkg", "note.md"),
    "t/old-name lives in node_modules and must not be scanned\n",
    "utf8",
  )

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })
  assert.deepEqual(result.mentions, [])
})

// ── task_move: non-Git desk ──────────────────────────────────────────────────

test("task_move works on a non-Git desk via a plain rename", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
  })

  assert.equal(result.to, path.posix.join("main-track", "new-name"))
  assert.equal(await exists(path.join(root, "main-track", "old-name")), false)
  assert.ok(await exists(path.join(root, "main-track", "new-name", "task.md")))
  assert.match(await trackBody(root, "main-track"), /`new-name`/)
})

// ── task_move: person scoping ────────────────────────────────────────────────

test("task_move honors the --person write prefix", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    person: "ari",
    input: { slug: "main-track", title: "main-track", scope: SCOPE, body: tasksTableBody(["old-name"]) },
  })
  await task_create({
    deskRoot: root,
    person: "ari",
    input: { track: "main-track", slug: "old-name", title: "T" },
  })

  const result = await task_move({
    deskRoot: root,
    person: "ari",
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
  })

  assert.equal(result.to, path.posix.join("desks", "ari", "main-track", "new-name"))
  assert.ok(await exists(path.join(root, "desks", "ari", "main-track", "new-name", "task.md")))
})

// ── task_move: injected git-plumbing failures (coverage of defensive paths) ──

test("task_move surfaces a git add failure", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const spawnGit = (cmd, args, opts) => {
    if (args.includes("add")) return { status: 1, stdout: "", stderr: "boom" }
    return spawnSync(cmd, args, opts)
  }

  commitAll(root)
  await assert.rejects(
    () =>
      task_move({
        deskRoot: root,
        input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
        spawnGit,
      }),
    /git add failed/,
  )
})

test("task_move surfaces a git mv failure", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const spawnGit = (cmd, args, opts) => {
    if (args.includes("mv")) return { status: 1, stdout: "", stderr: "boom" }
    return spawnSync(cmd, args, opts)
  }

  commitAll(root)
  await assert.rejects(
    () =>
      task_move({
        deskRoot: root,
        input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
        spawnGit,
      }),
    /git mv failed/,
  )
})

test("task_move surfaces a git add failure staging its own table edits", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  // movePath's own `git add -A -- <dir>` (source staging, ahead of `git mv`)
  // must still succeed; only stageWrites' plain `git add -- <files>` (for the
  // rewritten track.md table) fails here.
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("add") && !args.includes("-A")) return { status: 1, stdout: "", stderr: "table add boom" }
    return spawnSync(cmd, args, opts)
  }

  commitAll(root)
  await assert.rejects(
    () =>
      task_move({
        deskRoot: root,
        input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
        spawnGit,
      }),
    /git add failed staging the move's edits/,
  )
})

test("task_move reports a commit failure without losing the move", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    spawnGit,
  })

  assert.equal(result.to, path.posix.join("main-track", "new-name"), "the move itself is never lost to a commit failure")
  assert.ok(await exists(path.join(root, "main-track", "new-name", "task.md")))
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
})

test("task_move commits only its own paths, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })
  commitAll(root)

  // Simulates another process staging an unrelated path in the window
  // between task_move's own dirty check and its stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: () => {},
  })

  assert.equal(result.to, path.posix.join("main-track", "new-name"))
  assert.equal(result.commit, undefined, "the move's own commit succeeded")
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

test("task_move treats a spawnGit throw as a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const spawnGit = () => {
    throw new Error("git ENOENT")
  }

  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    spawnGit,
  })
  assert.equal(result.to, path.posix.join("main-track", "new-name"))
  assert.ok(await exists(path.join(root, "main-track", "new-name", "task.md")))
})

// ── task_move: push scheduling ───────────────────────────────────────────────
//
// After a successful, silent commit, task_move schedules a background push
// through the injectable `schedulePush` seam (never the real, spawning
// default in runtime/sync-worker.js — a test that reaches this code path
// without overriding it would fire a real detached process). It must run
// exactly once, keyed on the tool's own top-level `deskRoot` (never
// `effectiveRoot` or the moved directory), and only when the desk is a Git
// repo and the commit didn't fail.

test("task_move schedules a push exactly once, keyed on the plain deskRoot, after a successful commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })
  commitAll(root)

  const calls = []
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: (opts) => calls.push(opts),
  })

  assert.equal(result.to, path.posix.join("main-track", "new-name"))
  assert.deepEqual(calls, [{ root }])
})

test("task_move never schedules a push on a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const calls = []
  await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    schedulePush: (opts) => calls.push(opts),
  })

  assert.deepEqual(calls, [])
})

test("task_move never schedules a push when the commit fails", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  commitAll(root)
  const calls = []
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
    spawnGit,
    schedulePush: (opts) => calls.push(opts),
  })

  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
  assert.deepEqual(calls, [])
})
