// move — task_move (rename/relocate a task, live or archived) and
// track_rename (rename a track, updating every task card under it).
//
// Both stage moves with `git mv` semantics on a Git desk, or fall back to a
// plain rename otherwise; neither ever commits. Coverage below is written
// TDD-first per task M4-2's checklist: same-track rename, cross-track move,
// archived-task move, track rename with archived tasks, target-exists
// refusal, invalid-new-name refusal, mentions reported but not rewritten,
// and a non-Git desk working the same way.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_move, track_rename } from "../../src/tools/move.js"
import { task_create, task_archive } from "../../src/tools/task.js"
import { track_create } from "../../src/tools/track.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"

const SCOPE = "fixture track scope; not anything else"

function tasksTableBody(rows) {
  const rowLines = rows.map((slug) => `| \`${slug}\` | drafting | - | - | - |`)
  return [
    "## Scope",
    "",
    "Fixture body.",
    "",
    "## Tasks",
    "",
    "| Slug | State | Repos | Tracker link | Doing doc |",
    "|------|-------|-------|--------------|-----------|",
    ...rowLines,
  ].join("\n")
}

function initGit(root) {
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  }
  run(["init", "-q"])
  run(["config", "user.email", "test@example.com"])
  run(["config", "user.name", "Test"])
}

// The tools refuse to move a folder with unstaged changes or untracked files
// (another session may be working there), so Git tests commit their fixture
// first.
function commitAll(root) {
  for (const args of [["add", "-A"], ["commit", "-q", "--allow-empty", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
  }
}

function gitStatus(root) {
  const result = spawnSync("git", ["-C", root, "status", "--short"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function gitLog(root) {
  const result = spawnSync("git", ["-C", root, "log", "--oneline"], { encoding: "utf8" })
  return result.stdout
}

// Fix round 1, Important: no refusal may quote a candidate. Checking every
// 4-character substring is equivalent to checking every substring longer
// than 3 characters — any longer run contains a 4-character run as a prefix.
function assertNoCandidateLeak(message, candidate) {
  for (let i = 0; i <= candidate.length - 4; i += 1) {
    const chunk = candidate.slice(i, i + 4)
    assert.equal(
      message.includes(chunk),
      false,
      `error message must not leak "${chunk}" from candidate ${JSON.stringify(candidate)}: ${message}`,
    )
  }
}

async function mkTrack(root, slug, { rows = [], title } = {}) {
  await track_create({
    deskRoot: root,
    input: { slug, title: title ?? slug, scope: SCOPE, body: tasksTableBody(rows) },
  })
}

async function trackBody(root, slug) {
  const { content } = await readFront(path.join(root, slug, "track.md"))
  return content
}

// ── task_move: same-track rename ────────────────────────────────────────────

test("task_move renames a task within the same track (Git desk) and renames its tasks-table row", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "main-track", { rows: ["old-name", "other-task"] })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-name", title: "T" } })

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-name", to_slug: "new-name" },
  })

  assert.equal(result.from, path.join("main-track", "old-name"))
  assert.equal(result.to, path.join("main-track", "new-name"))
  assert.deepEqual(result.mentions, [])
  assert.ok(result.updated_files.includes(path.join("main-track", "new-name", "task.md")))
  assert.ok(result.updated_files.includes(path.join("main-track", "track.md")))

  assert.equal(await exists(path.join(root, "main-track", "old-name")), false)
  const { data } = await readFront(path.join(root, "main-track", "new-name", "task.md"))
  assert.equal(data.track, "main-track")

  const body = await trackBody(root, "main-track")
  assert.match(body, /`new-name`/)
  assert.doesNotMatch(body, /`old-name`/)
  assert.match(body, /`other-task`/, "the other row must be left alone")

  // Staged, never committed: the committed card leaves its old path in the
  // index and appears at the new one, with nothing left untracked.
  const status = gitStatus(root)
  assert.match(status, /main-track\/new-name\/task\.md/)
  assert.match(status, /^(R. main-track\/old-name\/task\.md -> |D  main-track\/old-name\/task\.md$)/m)
  assert.doesNotMatch(status, /^\?\?/m)
  assert.equal(gitLog(root).trim().split("\n").length, 1, "task_move must never commit: only the fixture commit exists")
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
  await task_move({ deskRoot: root, input: { track: "main-track", slug: "old-name", to_slug: "new-name" } })

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
  })

  assert.equal(result.from, path.join("track-a", "shared-task"))
  assert.equal(result.to, path.join("track-b", "shared-task"))
  assert.ok(result.updated_files.includes(path.join("track-b", "shared-task", "task.md")))
  assert.ok(result.updated_files.includes(path.join("track-a", "track.md")))
  assert.ok(result.updated_files.includes(path.join("track-b", "track.md")))

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
  })

  assert.equal(result.to, path.join("track-b", "new-name"))
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
  })

  assert.equal(result.to, path.join("track-b", "solo-task"))
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
  })

  assert.equal(result.updated_files.includes(path.join("track-a", "track.md")), false)
  assert.equal(result.updated_files.includes(path.join("track-b", "track.md")), false)
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
  })

  assert.ok(await exists(path.join(root, "track-b", "moving-task", "task.md")))
  assert.ok(result.updated_files.includes(path.join("track-a", "track.md")))
  assert.equal(result.updated_files.includes(path.join("track-b", "track.md")), false)
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
  })

  assert.equal(result.updated_files.includes(path.join("track-a", "track.md")), false)
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
  })

  assert.equal(result.updated_files.includes(path.join("main-track", "track.md")), false)
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
  })
  assert.equal(result.updated_files.includes(path.join("main-track", "track.md")), false)
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
  })
  assert.equal(result.updated_files.includes(path.join("main-track", "track.md")), false)
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
  })
  assert.equal(result.updated_files.includes(path.join("main-track", "track.md")), false)
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
  })
  assert.equal(result.updated_files.includes(path.join("main-track", "track.md")), false)
})

// ── task_move: archived tasks ────────────────────────────────────────────────

test("task_move relocates an archived task and keeps it archived", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: [] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "old-task", title: "T" } })
  await task_archive({ deskRoot: root, input: { track: "track-a", slug: "old-task" } })

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "track-a", slug: "old-task", to_track: "track-b", to_slug: "renamed-task" },
  })

  assert.equal(result.from, path.join("track-a", "_archive", "old-task"))
  assert.equal(result.to, path.join("track-b", "_archive", "renamed-task"))
  assert.equal(await exists(path.join(root, "track-a", "_archive", "old-task")), false)
  const { data } = await readFront(path.join(root, "track-b", "_archive", "renamed-task", "task.md"))
  assert.equal(data.track, "track-b")
  assert.equal(data.status, "done")
})

// ── task_move: refusals ─────────────────────────────────────────────────────

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
  })

  assert.deepEqual(result.mentions, [path.join("_meta", "notes.md")])
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

  assert.equal(result.to, path.join("main-track", "new-name"))
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

  assert.equal(result.to, path.join("desks", "ari", "main-track", "new-name"))
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
  assert.equal(result.to, path.join("main-track", "new-name"))
  assert.ok(await exists(path.join(root, "main-track", "new-name", "task.md")))
})

// ── task_move: unarchive (M4-5) ──────────────────────────────────────────────

async function archivedTask(root, { track = "main-track", slug = "old-task", rows = [] } = {}) {
  await mkTrack(root, track, { rows })
  await task_create({ deskRoot: root, input: { track, slug, title: "T" } })
  await task_archive({ deskRoot: root, input: { track, slug } })
}

test("task_move unarchive moves an archived task back to a live folder and restores its missing row", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await archivedTask(root, { rows: ["other-task"] })

  commitAll(root)
  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true },
  })

  assert.equal(result.from, path.join("main-track", "_archive", "old-task"))
  assert.equal(result.to, path.join("main-track", "old-task"))
  assert.equal(await exists(path.join(root, "main-track", "_archive", "old-task")), false)
  const { data } = await readFront(path.join(root, "main-track", "old-task", "task.md"))
  assert.equal(data.track, "main-track")
  assert.equal(data.status, "done", "unarchiving never changes the status; the agent reopens it with task_update")
  const body = await trackBody(root, "main-track")
  assert.match(body, /^\| `old-task` \| done \|  \|  \|  \|$/m)
  assert.match(body, /`other-task`/)
  assert.ok(result.updated_files.includes(path.join("main-track", "track.md")))
  assert.match(gitStatus(root), /main-track\/old-task\/task\.md/)
  assert.equal(gitLog(root).trim().split("\n").length, 1, "task_move must never commit: only the fixture commit exists")
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
  assert.deepEqual(result.updated_files, [path.join("main-track", "old-task", "task.md")])
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
  await mkTrack(root, "track-b", { rows: [] })

  await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true, to_track: "track-b" },
  })

  assert.ok(await exists(path.join(root, "track-b", "old-task", "task.md")))
  assert.doesNotMatch(await trackBody(root, "main-track"), /`old-task`/)
  assert.match(await trackBody(root, "track-b"), /^\| `old-task` \| drafting \|/m)
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
  assert.ok(result.updated_files.includes(path.join("track-b", "track.md")))
})

test("task_move unarchive leaves a track.md with no Tasks table alone", async () => {
  const root = await mkTempDeskRoot()
  await track_create({ deskRoot: root, input: { slug: "main-track", title: "main-track", scope: SCOPE } })
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-task", title: "T" } })
  await task_archive({ deskRoot: root, input: { track: "main-track", slug: "old-task" } })

  const result = await task_move({
    deskRoot: root,
    input: { track: "main-track", slug: "old-task", unarchive: true },
  })
  assert.deepEqual(result.updated_files, [path.join("main-track", "old-task", "task.md")])
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
  await task_create({ deskRoot: root, input: { track: "main-track", slug: "old-task", title: "T" } })

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
  assert.equal(result.to, path.join("main-track", "_archive", "renamed-task"))
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
  })

  const iteration = path.join("main-track", "keep-task", "_iterations", `${day}-dup-task`)
  assert.equal(result.from, path.join("main-track", "dup-task"))
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
  assert.deepEqual(result.updated_files, [path.join(iteration, "merged-task.md"), path.join("main-track", "track.md")])
  assert.equal(gitLog(root).trim().split("\n").length, 1, "task_move must never commit: only the fixture commit exists")
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

  assert.equal(result.to, path.join("track-b", "keep-task", "_iterations", "2026-03-04-dup-task"))
  const { data } = await readFront(path.join(root, result.to, "merged-task.md"))
  assert.equal(data.track, "track-b")
  assert.equal(await trackBody(root, "track-b"), before)
  assert.deepEqual(result.updated_files, [path.join(result.to, "merged-task.md")])
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
  await task_move({ deskRoot: root, input: { track: "main-track", slug: "clean-task", to_slug: "moved-task" } })
  assert.ok(await exists(path.join(root, "main-track", "moved-task", "run.log")))

  commitAll(root)
  await fs.writeFile(path.join(root, "main-track", "moved-task", "doing.md"), "in progress\n")
  const result = await task_move({ deskRoot: root, input: { track: "main-track", slug: "moved-task", to_slug: "final-task", allow_dirty: true } })
  assert.equal(result.to, path.join("main-track", "final-task"))
  assert.match(gitStatus(root), /main-track\/final-task\/doing\.md/)

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

  const result = await task_move({ deskRoot: root, input: { track: "track-a", slug: "clean-task", to_track: "track-b", allow_dirty: true } })
  assert.equal(result.to, path.join("track-b", "clean-task"))
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

  const kept = await task_move({ deskRoot: root, input: { track: "main-track", slug: "done-task", into_task: "live-task" } })
  assert.match(kept.to, /^main-track\/live-task\/_iterations\/\d{4}-\d{2}-\d{2}-done-task$/)
  commitAll(root)
  const both = await task_move({ deskRoot: root, input: { track: "main-track", slug: "other-live-task", into_task: "live-task" } })
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

  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track", allow_dirty: true } })
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
  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" } })

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
    [path.join("new-track", "task-one", "task.md"), path.join("new-track", "task-two", "task.md")].sort(),
  )

  const status = gitStatus(root)
  assert.match(status, /new-track\/task-one\/task\.md/)
  assert.match(status, /new-track\/task-two\/task\.md/)
  assert.match(status, /^R  old-track\/track\.md -> new-track\/track\.md$/m, "staged as a rename of the committed track")
  assert.doesNotMatch(status, /^\?\?/m)
  assert.equal(gitLog(root).trim().split("\n").length, 1, "track_rename must never commit: only the fixture commit exists")
})

test("track_rename with archived tasks rewrites both live and archived task cards", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "live-one", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-gone", title: "T" } })
  await task_archive({ deskRoot: root, input: { track: "old-track", slug: "task-gone" } })

  commitAll(root)
  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" } })

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
      path.join("new-track", "live-one", "task.md"),
      path.join("new-track", "_archive", "task-gone", "task.md"),
    ].sort(),
  )
})

test("track_rename works on a track with no tasks", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })

  commitAll(root)
  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" } })
  assert.deepEqual(result.updated_files, [])
  assert.ok(await exists(path.join(root, "new-track", "track.md")))
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
    /`track` and `to` are required/,
  )
  await assert.rejects(
    () => track_rename({ deskRoot: root, input: { track: "main-track" } }),
    /`track` and `to` are required/,
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
    /`track` and `to` are required/,
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
  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" } })
  assert.deepEqual(result.mentions, [path.join("_meta", "notes.md")])
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
  const result = await track_rename({ deskRoot: root, input: { track: "old-track", to: "new-track" } })
  assert.deepEqual(result.updated_files, [])
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
  assert.equal(result.to, path.join("desks", "ari", "new-track"))
  assert.ok(await exists(path.join(root, "desks", "ari", "new-track", "track.md")))
})
