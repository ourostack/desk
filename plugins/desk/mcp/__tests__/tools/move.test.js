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

function gitStatus(root) {
  const result = spawnSync("git", ["-C", root, "status", "--short"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function gitLog(root) {
  const result = spawnSync("git", ["-C", root, "log", "--oneline"], { encoding: "utf8" })
  return result.stdout
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

  // Staged, never committed — a brand-new (never-committed) file moves as a
  // staged add at the new path, not a detected rename, since there is no
  // committed baseline for git to diff a rename against.
  const status = gitStatus(root)
  assert.match(status, /main-track\/new-name\/task\.md/)
  assert.doesNotMatch(status, /old-name/)
  assert.equal(gitLog(root), "", "task_move must never commit")
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

  const result = await task_move({
    deskRoot: root,
    input: { track: "track-a", slug: "old-name", to_track: "track-b", to_slug: "new-name" },
  })

  assert.equal(result.to, path.join("track-b", "new-name"))
  assert.ok(await exists(path.join(root, "track-b", "new-name", "task.md")))
  assert.match(await trackBody(root, "track-b"), /`new-name`/)
  assert.doesNotMatch(await trackBody(root, "track-a"), /`old-name`/)
})

test("task_move across tracks tolerates a destination track with no track.md yet", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["solo-task"] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "solo-task", title: "T" } })

  const result = await task_move({
    deskRoot: root,
    input: { track: "track-a", slug: "solo-task", to_track: "brand-new" },
  })

  assert.ok(await exists(path.join(root, "brand-new", "solo-task", "task.md")))
  assert.ok(result.updated_files.includes(path.join("track-a", "track.md")))
  assert.equal(result.updated_files.includes(path.join("brand-new", "track.md")), false)
  assert.doesNotMatch(await trackBody(root, "track-a"), /`solo-task`/)
})

test("task_move across tracks leaves both tables alone when the source table has no row for the slug", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["unrelated-row"] })
  await mkTrack(root, "track-b", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "untracked-in-table", title: "T" } })

  const result = await task_move({
    deskRoot: root,
    input: { track: "track-a", slug: "untracked-in-table", to_track: "track-b" },
  })

  assert.equal(result.updated_files.includes(path.join("track-a", "track.md")), false)
  assert.equal(result.updated_files.includes(path.join("track-b", "track.md")), false)
  assert.match(await trackBody(root, "track-a"), /`unrelated-row`/)
  assert.doesNotMatch(await trackBody(root, "track-b"), /`untracked-in-table`/)
})

test("task_move within the same track leaves the table alone when it has no row for the slug", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "track-a", { rows: ["unrelated-row"] })
  await task_create({ deskRoot: root, input: { track: "track-a", slug: "untracked-in-table", title: "T" } })

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
      assert.equal(error.message.includes("hi-there-friend"), false)
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

// ── track_rename ─────────────────────────────────────────────────────────────

test("track_rename renames a track and rewrites track: on every live task card", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-one", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-two", title: "T" } })

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
  assert.doesNotMatch(status, /old-track/)
  assert.equal(gitLog(root), "", "track_rename must never commit")
})

test("track_rename with archived tasks rewrites both live and archived task cards", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await mkTrack(root, "old-track", { rows: [] })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "live-one", title: "T" } })
  await task_create({ deskRoot: root, input: { track: "old-track", slug: "task-gone", title: "T" } })
  await task_archive({ deskRoot: root, input: { track: "old-track", slug: "task-gone" } })

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
      assert.equal(error.message.includes("misc"), false)
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
