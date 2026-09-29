// track_create — happy path + duplicate refusal + optional fields +
// name/scope validation (M4-1).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { track_create } from "../../../../../plugins/desk/mcp/src/tools/track.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"

const SCOPE = "europe trip planning and bookings; not day-to-day expenses"

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

function lastCommitMessage(root) {
  const result = spawnSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function lastCommitFiles(root) {
  const result = spawnSync("git", ["-C", root, "show", "--stat", "--format=", "--name-only", "HEAD"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.split("\n").filter(Boolean).sort()
}

test("track_create writes a v1 track.md with required + default fields", async () => {
  const root = await mkTempDeskRoot()
  const result = await track_create({
    deskRoot: root,
    input: { slug: "europe-trip", title: "Europe trip 2026", scope: SCOPE },
  })
  assert.equal(result.status, "created")
  assert.equal(result.path, path.join("europe-trip", "track.md"))

  const filePath = path.join(root, "europe-trip", "track.md")
  assert.ok(await exists(filePath))

  const { data } = await readFront(filePath)
  assert.equal(data.schema_version, 1)
  assert.equal(data.title, "Europe trip 2026")
  assert.equal(data.status, "active")
  assert.equal(data.scope, SCOPE)
  assert.ok(data.created)
  assert.equal(data.created, data.updated)
})

test("track_create refuses to overwrite an existing track", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: { slug: "first-track", title: "first", scope: SCOPE },
  })
  await assert.rejects(
    () =>
      track_create({
        deskRoot: root,
        input: { slug: "first-track", title: "second", scope: SCOPE },
      }),
    /already exists/,
  )
})

test("track_create accepts optional predecessor + planning fields", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: {
      slug: "successor-track",
      title: "Successor track",
      status: "active",
      scope: SCOPE,
      predecessor: { slug: "old", title: "Old track", status: "closed" },
      planning: "./_planning/planning.md",
      body: "## Scope\n\nDoing stuff.",
    },
  })
  const filePath = path.join(root, "successor-track", "track.md")
  const { data, content } = await readFront(filePath)
  assert.deepEqual(data.predecessor, {
    slug: "old",
    title: "Old track",
    status: "closed",
  })
  assert.equal(data.planning, "./_planning/planning.md")
  assert.match(content, /## Scope/)
})

test("track_create rejects missing required fields", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => track_create({ deskRoot: root }),
    /slug.*required/,
  )
  await assert.rejects(
    () => track_create({ deskRoot: root, input: { title: "x" } }),
    /slug.*required/,
  )
  await assert.rejects(
    () => track_create({ deskRoot: root, input: { slug: "billing-disputes" } }),
    /title.*required/,
  )
  await assert.rejects(
    () =>
      track_create({
        deskRoot: root,
        input: { slug: "billing-disputes", title: 123 },
      }),
    /title.*required/,
  )
})

// ── M4-1: name validation ────────────────────────────────────────────────

test("track_create accepts well-formed outcome names", async () => {
  const root = await mkTempDeskRoot()
  for (const slug of ["factory-slice-1", "oauth-login-p0-fix"]) {
    const result = await track_create({
      deskRoot: root,
      input: { slug, title: "Title", scope: SCOPE },
    })
    assert.equal(result.status, "created")
  }
})

test("track_create rejects a prompt-copied name", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      track_create({
        deskRoot: root,
        input: { slug: "hi-ssh-into-host", title: "Title", scope: SCOPE },
      }),
    /invalid slug/,
  )
})

test("track_create rejects a name with a credential-like word without echoing it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      track_create({
        deskRoot: root,
        input: { slug: "setup-user-root-pw-alpine", title: "Title", scope: SCOPE },
      }),
    (err) => {
      assert.match(err.message, /secret's value/)
      assert.equal(err.message.includes("setup-user-root-pw-alpine"), false)
      return true
    },
  )
})

test("track_create rejects a 7-word name", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      track_create({
        deskRoot: root,
        input: {
          slug: "one-two-three-four-five-six-seven",
          title: "Title",
          scope: SCOPE,
        },
      }),
    /invalid slug/,
  )
})

test("track_create rejects a catch-all track name", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      track_create({
        deskRoot: root,
        input: { slug: "misc", title: "Title", scope: SCOPE },
      }),
    /invalid slug/,
  )
})

test("track_create rejects a track named after the desk's own git identity", async () => {
  const root = await mkTempDeskRoot()
  const { execFileSync } = await import("node:child_process")
  execFileSync("git", ["init", "-q", root])
  execFileSync("git", ["-C", root, "config", "user.name", "Ari Mendelow"])
  await assert.rejects(
    () =>
      track_create({
        deskRoot: root,
        input: { slug: "ari-mendelow", title: "Title", scope: SCOPE },
      }),
    /invalid slug/,
  )
})

// ── M4-1: scope validation ──────────────────────────────────────────────

test("track_create requires a scope", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      track_create({
        deskRoot: root,
        input: { slug: "billing-disputes", title: "Title" },
      }),
    /scope.*<what belongs>.*not <what doesn't>/,
  )
})

test("track_create rejects a multiline scope", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      track_create({
        deskRoot: root,
        input: {
          slug: "billing-disputes",
          title: "Title",
          scope: "line one\nline two",
        },
      }),
    /single line/,
  )
})

test("track_create rejects a scope over 240 characters", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      track_create({
        deskRoot: root,
        input: {
          slug: "billing-disputes",
          title: "Title",
          scope: "a".repeat(241),
        },
      }),
    /240/,
  )
})

// ── M4-6 Part 2: stage + commit ─────────────────────────────────────────────

test("track_create stages and commits exactly the track.md it wrote", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const result = await track_create({
    deskRoot: root,
    input: { slug: "europe-trip", title: "Europe trip 2026", scope: SCOPE },
    schedulePush: () => {},
  })
  assert.equal(result.status, "created")
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "track_create: europe-trip")
  assert.deepEqual(lastCommitFiles(root), [path.join("europe-trip", "track.md")])
})

test("track_create commits only its own file, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)

  // Simulates another process staging an unrelated path in the window
  // between track_create's write and its own stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await track_create({
    deskRoot: root,
    input: { slug: "europe-trip", title: "Europe trip 2026", scope: SCOPE },
    schedulePush: () => {},
  })

  assert.equal(result.commit, undefined, "track_create's own commit succeeded")
  assert.deepEqual(lastCommitFiles(root), [path.join("europe-trip", "track.md")])
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

test("track_create reports a commit failure without losing the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }
  const calls = []
  const schedulePush = (opts) => calls.push(opts)
  const result = await track_create({
    deskRoot: root,
    input: { slug: "europe-trip", title: "Europe trip 2026", scope: SCOPE },
    spawnGit,
    schedulePush,
  })
  assert.equal(result.status, "created", "the write itself is never lost to a commit failure")
  assert.ok(await exists(path.join(root, "europe-trip", "track.md")))
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
  assert.deepEqual(calls, [], "a push is never scheduled when the commit itself failed")
})

test("track_create reports a staging failure without losing the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("add")) return { status: 1, stdout: "", stderr: "add boom" }
    return spawnSync(cmd, args, opts)
  }
  const result = await track_create({
    deskRoot: root,
    input: { slug: "europe-trip", title: "Europe trip 2026", scope: SCOPE },
    spawnGit,
  })
  assert.equal(result.status, "created", "the write itself is never lost to a staging failure")
  assert.deepEqual(result.commit, { status: "failed", reason: "add boom" }, "a stage failure is reported, not swallowed as a silent success")
  assert.ok(await exists(path.join(root, "europe-trip", "track.md")))
})

test("track_create skips staging and committing silently on a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  const calls = []
  const schedulePush = (opts) => calls.push(opts)
  const result = await track_create({
    deskRoot: root,
    input: { slug: "europe-trip", title: "Europe trip 2026", scope: SCOPE },
    schedulePush,
  })
  assert.equal(result.status, "created")
  assert.equal(result.commit, undefined)
  assert.deepEqual(calls, [], "a push is never scheduled on a non-Git desk")
})

// ── M4-6 Part 3: schedule push ──────────────────────────────────────────────

test("track_create schedules a push exactly once after a successful, silent commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const calls = []
  const schedulePush = (opts) => calls.push(opts)
  const result = await track_create({
    deskRoot: root,
    input: { slug: "europe-trip", title: "Europe trip 2026", scope: SCOPE },
    schedulePush,
  })
  assert.equal(result.status, "created")
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.deepEqual(calls, [{ root }])
})
