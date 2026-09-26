// The one-time tidy's own work versus another session's (M4-5 fix round 4).
//
// The tidy makes several task_move / track_rename / track_update /
// track_create calls per track and commits once, at step 7, without ever
// passing allow_dirty. Every one of those tools stages what it writes, so a
// staged change reads as the tidy's own work in progress, and only unstaged
// changes or untracked, non-ignored files read as another session's work.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_move, track_rename } from "../../src/tools/move.js"
import { task_create } from "../../src/tools/task.js"
import { track_create, track_update } from "../../src/tools/track.js"
import { mkTempDeskRoot, exists } from "./_helpers.js"

const SCOPE = "fixture track scope; not anything else"
const OTHER_SESSION = /has unstaged changes or untracked files, so another session may be working there/

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

function lines(text) {
  return text.split("\n").filter(Boolean).sort()
}

function tasksBody(rows) {
  return [
    "## Tasks",
    "",
    "| Slug | State |",
    "|------|-------|",
    ...rows.map((slug) => `| \`${slug}\` | drafting |`),
  ].join("\n")
}

/** A committed Git desk with the given tracks and tasks, and no scope line on `track-a` (the tidy's step 1 adds it). */
async function committedDesk(tracks) {
  const root = await mkTempDeskRoot()
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  for (const [track, slugs] of Object.entries(tracks)) {
    await track_create({ deskRoot: root, input: { slug: track, title: track, scope: SCOPE, body: tasksBody(slugs) } })
    for (const slug of slugs) {
      await task_create({ deskRoot: root, input: { track, slug, title: slug } })
    }
  }
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "--allow-empty", "-m", "fixture"])
  return root
}

function unstaged(root, paths = ["."]) {
  return git(root, ["diff", "--name-only", "--", ...paths]) + git(root, ["ls-files", "--others", "--exclude-standard", "--", ...paths])
}

// ── The reviewer's three sequences, in one tidy run, without allow_dirty ───

test("a scope-line write, then a rename in the same track, both go through", async () => {
  const root = await committedDesk({ "track-a": ["fix-it-now", "other-task"] })
  await track_update({ deskRoot: root, input: { slug: "track-a", frontmatter: { scope: "billing work; not payroll" } } })
  assert.equal(unstaged(root), "", "track_update staged its own write")

  const result = await task_move({ deskRoot: root, input: { track: "track-a", slug: "fix-it-now", to_slug: "invoice-retry-fix" } })
  assert.equal(result.to, path.join("track-a", "invoice-retry-fix"))
  assert.equal(unstaged(root), "", "task_move staged the moved card and the edited track.md")
})

test("two renames in the same track, back to back, both go through", async () => {
  const root = await committedDesk({ "track-a": ["task-one", "task-two"] })
  await task_move({ deskRoot: root, input: { track: "track-a", slug: "task-one", to_slug: "first-outcome" } })
  const second = await task_move({ deskRoot: root, input: { track: "track-a", slug: "task-two", to_slug: "second-outcome" } })
  assert.equal(second.to, path.join("track-a", "second-outcome"))
  const table = await fs.readFile(path.join(root, "track-a", "track.md"), "utf8")
  assert.match(table, /`first-outcome`[\s\S]*`second-outcome`/)
  assert.equal(unstaged(root), "")
})

test("a rename, then a merge into the renamed task, both go through", async () => {
  const root = await committedDesk({ "track-a": ["keeper-task", "dupe-task"] })
  await task_move({ deskRoot: root, input: { track: "track-a", slug: "keeper-task", to_slug: "kept-outcome" } })
  const merged = await task_move({ deskRoot: root, input: { track: "track-a", slug: "dupe-task", into_task: "kept-outcome" } })
  assert.match(merged.to, /^track-a\/kept-outcome\/_iterations\/\d{4}-\d{2}-\d{2}-dupe-task$/)
  assert.equal(unstaged(root), "")
})

test("a new track, then a re-file into it, then a track rename, all go through", async () => {
  const root = await committedDesk({ "old-bucket": ["loose-job"], "track-a": ["kept-task"] })
  await track_create({ deskRoot: root, input: { slug: "billing-work", title: "Billing", scope: SCOPE, body: tasksBody([]) } })
  assert.equal(unstaged(root), "", "track_create staged the new track.md")
  const moved = await task_move({ deskRoot: root, input: { track: "old-bucket", slug: "loose-job", to_track: "billing-work" } })
  assert.equal(moved.to, path.join("billing-work", "loose-job"))
  await task_move({ deskRoot: root, input: { track: "track-a", slug: "kept-task", to_slug: "kept-outcome" } })
  const renamed = await track_rename({ deskRoot: root, input: { track: "track-a", to: "invoice-work" } })
  assert.equal(renamed.to, "invoice-work")
  assert.equal(unstaged(root), "", "track_rename staged the rewritten task cards")
})

// ── Another session's work is still refused ─────────────────────────────────

test("another session's unstaged edit to a track.md is still refused, even after the tidy staged its own edit there", async () => {
  const root = await committedDesk({ "track-a": ["task-one", "task-two"] })
  await task_move({ deskRoot: root, input: { track: "track-a", slug: "task-one", to_slug: "first-outcome" } })
  await fs.appendFile(path.join(root, "track-a", "track.md"), "\nA line another session is writing.\n")

  const error = await task_move({ deskRoot: root, input: { track: "track-a", slug: "task-two", to_slug: "second-outcome" } }).catch((e) => e)
  assert.equal(
    error.message,
    "task_move: a track.md this move would edit has unstaged changes or untracked files, so another session may be working there; commit or finish that work first, or pass allow_dirty: true to move it anyway",
  )
  assert.ok(await exists(path.join(root, "track-a", "task-two", "task.md")), "nothing moved")
})

test("another session's untracked file in a task folder is still refused, even in a track the tidy is working in", async () => {
  const root = await committedDesk({ "track-a": ["task-one", "busy-task"] })
  await task_move({ deskRoot: root, input: { track: "track-a", slug: "task-one", to_slug: "first-outcome" } })
  await fs.writeFile(path.join(root, "track-a", "busy-task", "doing.md"), "another session is writing this\n")

  await assert.rejects(
    task_move({ deskRoot: root, input: { track: "track-a", slug: "busy-task", to_slug: "busy-outcome" } }),
    /^Error: task_move: the source has unstaged changes or untracked files, so another session may be working there/,
  )
  await assert.rejects(track_rename({ deskRoot: root, input: { track: "track-a", to: "invoice-work" } }), OTHER_SESSION)
})

test("track_update never stages another session's unstaged edit, so the move tools still refuse that track", async () => {
  const root = await committedDesk({ "track-a": ["task-one"] })
  await fs.appendFile(path.join(root, "track-a", "track.md"), "\nA line another session is writing.\n")
  await track_update({ deskRoot: root, input: { slug: "track-a", frontmatter: { scope: "billing work; not payroll" } } })
  assert.deepEqual(lines(git(root, ["diff", "--name-only"])), ["track-a/track.md"], "left unstaged")
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "", "nothing staged")
  await assert.rejects(task_move({ deskRoot: root, input: { track: "track-a", slug: "task-one", to_slug: "first-outcome" } }), OTHER_SESSION)
})

test("track_update leaves an untracked track.md unstaged", async () => {
  const root = await committedDesk({})
  await fs.mkdir(path.join(root, "track-a"))
  await fs.writeFile(path.join(root, "track-a", "track.md"), "---\ntitle: A\n---\n")
  await track_update({ deskRoot: root, input: { slug: "track-a", body_append: "Notes." } })
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "")
})

// ── Staging failures ────────────────────────────────────────────────────────

test("the track tools write anyway when git add fails, and leave the file unstaged", async () => {
  const root = await committedDesk({ "track-a": [] })
  const spawnGit = (cmd, args, opts) => (args.includes("add") ? { status: 1, stdout: "", stderr: "boom" } : spawnSync(cmd, args, opts))
  await track_update({ deskRoot: root, input: { slug: "track-a", body_append: "Notes." }, spawnGit })
  await track_create({ deskRoot: root, input: { slug: "billing-work", title: "B", scope: SCOPE }, spawnGit })
  assert.match(await fs.readFile(path.join(root, "track-a", "track.md"), "utf8"), /Notes\./)
  assert.ok(await exists(path.join(root, "billing-work", "track.md")))
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "")
})

test("task_move surfaces a git add failure while staging its edits", async () => {
  const root = await committedDesk({ "track-a": ["task-one"] })
  const spawnGit = (cmd, args, opts) =>
    args.includes("add") && !args.includes("-A") ? { status: 1, stdout: "", stderr: "boom" } : spawnSync(cmd, args, opts)
  await assert.rejects(
    task_move({ deskRoot: root, input: { track: "track-a", slug: "task-one", to_slug: "first-outcome" }, spawnGit }),
    /^Error: desk-mcp: git add failed staging the move's edits: boom$/,
  )
})

// ── Step 7 commits exactly the tidy's changes ───────────────────────────────

test("step 7's git commit -- <tidy paths> commits exactly the tidy's changes and leaves other sessions' work as it was", async () => {
  const root = await committedDesk({
    "track-a": ["keeper-task", "dupe-task", "fix-it-now"],
    "old-bucket": ["loose-job"],
    "busy-track": ["busy-task"],
    "other-track": ["other-task"],
  })
  // Another session: an unstaged edit in busy-track, and staged work in other-track.
  await fs.appendFile(path.join(root, "busy-track", "busy-task", "task.md"), "\nIn progress.\n")
  await fs.writeFile(path.join(root, "other-track", "other-task", "doing.md"), "staged elsewhere\n")
  git(root, ["add", "--", "other-track/other-task/doing.md"])

  // The tidy, steps 1-5, never passing allow_dirty.
  await track_update({ deskRoot: root, input: { slug: "track-a", frontmatter: { scope: "billing work; not payroll" } } })
  await task_move({ deskRoot: root, input: { track: "track-a", slug: "fix-it-now", to_slug: "invoice-retry-fix" } })
  await task_move({ deskRoot: root, input: { track: "track-a", slug: "keeper-task", to_slug: "kept-outcome" } })
  await task_move({ deskRoot: root, input: { track: "track-a", slug: "dupe-task", into_task: "kept-outcome" } })
  await track_create({ deskRoot: root, input: { slug: "billing-work", title: "Billing", scope: SCOPE, body: tasksBody([]) } })
  await task_move({ deskRoot: root, input: { track: "old-bucket", slug: "loose-job", to_track: "billing-work" } })
  await track_rename({ deskRoot: root, input: { track: "track-a", to: "invoice-work" } })
  await fs.mkdir(path.join(root, "_archive"))
  git(root, ["mv", "old-bucket", "_archive/old-bucket"])

  // Step 7's check: nothing unstaged or untracked under the tidy paths.
  const tidyPaths = ["track-a", "invoice-work", "old-bucket", "billing-work", "_archive"]
  assert.equal(unstaged(root, tidyPaths), "")
  const stagedBefore = lines(git(root, ["diff", "--cached", "--name-only", "--no-renames"]))
  git(root, ["commit", "-q", "-m", "tidy", "--", ...tidyPaths])

  const committed = lines(git(root, ["show", "--name-only", "--format=", "--no-renames", "HEAD"]))
  assert.deepEqual(committed, stagedBefore.filter((file) => file !== "other-track/other-task/doing.md"))
  assert.ok(committed.every((file) => tidyPaths.some((p) => file.startsWith(`${p}/`))))
  assert.ok(committed.some((file) => /^invoice-work\/kept-outcome\/_iterations\/\d{4}-\d{2}-\d{2}-dupe-task\/merged-task\.md$/.test(file)))
  assert.ok(committed.includes("track-a/track.md") && committed.includes("invoice-work/track.md"))
  assert.ok(committed.includes("_archive/old-bucket/track.md") && committed.includes("billing-work/loose-job/task.md"))

  // Other sessions' work is exactly as it was: staged stays staged, unstaged stays unstaged.
  assert.deepEqual(lines(git(root, ["diff", "--cached", "--name-only"])), ["other-track/other-task/doing.md"])
  assert.deepEqual(lines(git(root, ["diff", "--name-only"])), ["busy-track/busy-task/task.md"])
})
