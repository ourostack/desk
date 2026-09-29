// task_create — happy path, refusal on duplicate, optional runtime fields,
// name validation (M4-1).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_create } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"

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

test("task_create writes a v1 task.md with required + default fields", async () => {
  const root = await mkTempDeskRoot()
  const result = await task_create({
    deskRoot: root,
    input: {
      track: "europe-trip",
      slug: "book-flights",
      title: "Book the Paris flights",
    },
  })

  assert.equal(result.status, "created")
  assert.equal(result.path, path.join("europe-trip", "book-flights", "task.md"))

  const filePath = path.join(root, "europe-trip", "book-flights", "task.md")
  assert.ok(await exists(filePath), "task.md should exist on disk")

  const { data } = await readFront(filePath)
  assert.equal(data.schema_version, 1)
  assert.equal(data.title, "Book the Paris flights")
  assert.equal(data.status, "drafting")
  assert.equal(data.track, "europe-trip")
  assert.ok(data.created, "created should be set")
  assert.equal(data.created, data.updated, "created and updated match at create time")
  assert.match(data.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test("task_create refuses to overwrite an existing task", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "trip-planning", slug: "book-hotel", title: "first" },
  })
  await assert.rejects(
    () =>
      task_create({
        deskRoot: root,
        input: { track: "trip-planning", slug: "book-hotel", title: "second" },
      }),
    /already exists/,
  )
})

test("task_create accepts optional runtime fields and passes them through", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: {
      track: "infra",
      slug: "reminder-x",
      title: "Reminder",
      status: "scheduled",
      category: "reminder",
      cadence: "30m",
      requester: "ari",
      artifacts: ["https://example.com/pr/1"],
      body: "Reminder body",
    },
  })
  const filePath = path.join(root, "infra", "reminder-x", "task.md")
  const { data, content } = await readFront(filePath)
  assert.equal(data.status, "scheduled")
  assert.equal(data.category, "reminder")
  assert.equal(data.cadence, "30m")
  assert.equal(data.requester, "ari")
  assert.deepEqual(data.artifacts, ["https://example.com/pr/1"])
  assert.match(content, /Reminder body/)
})

test("task_create keeps the initiated_by and origin_note start-task sends (review of #51, S3)", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "infra", slug: "flaky-login-test", title: "T", initiated_by: "agent", origin_note: "spawned from the login investigation" },
  })
  const { data } = await readFront(path.join(root, "infra", "flaky-login-test", "task.md"))
  assert.equal(data.initiated_by, "agent")
  assert.equal(data.origin_note, "spawned from the login investigation")
})

test("task_create rejects missing required fields", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => task_create({ deskRoot: root }),
    /track.*required/,
  )
  await assert.rejects(
    () => task_create({ deskRoot: root, input: { slug: "x", title: "y" } }),
    /track.*required/,
  )
  await assert.rejects(
    () => task_create({ deskRoot: root, input: { track: "x", title: "y" } }),
    /slug.*required/,
  )
  await assert.rejects(
    () => task_create({ deskRoot: root, input: { track: "x", slug: "y" } }),
    /title.*required/,
  )
  await assert.rejects(
    () =>
      task_create({
        deskRoot: root,
        input: { track: "x", slug: "y", title: 123 },
      }),
    /title.*required/,
  )
})

// ── M4-1: name validation ────────────────────────────────────────────────

test("task_create accepts well-formed outcome names", async () => {
  const root = await mkTempDeskRoot()
  for (const slug of ["factory-slice-1", "oauth-login-p0-fix"]) {
    const result = await task_create({
      deskRoot: root,
      input: { track: "engineering", slug, title: "Title" },
    })
    assert.equal(result.status, "created")
  }
})

test("task_create rejects a prompt-copied name", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      task_create({
        deskRoot: root,
        input: { track: "engineering", slug: "hello-please-do-a-deep-dive", title: "Title" },
      }),
    /invalid slug/,
  )
})

test("task_create rejects a name with a credential-like token without echoing it", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      task_create({
        deskRoot: root,
        input: {
          track: "engineering",
          slug: "deploy-a1b2c3d4e5f6a7b8c9d0",
          title: "Title",
        },
      }),
    (err) => {
      assert.match(err.message, /secret's value/)
      assert.equal(err.message.includes("a1b2c3d4e5f6a7b8c9d0"), false)
      return true
    },
  )
})

test("task_create rejects an IPv4-looking name", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      task_create({
        deskRoot: root,
        input: { track: "engineering", slug: "connect-100-73-66-84", title: "Title" },
      }),
    /invalid slug/,
  )
})

test("task_create rejects a 7-word name as shape", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      task_create({
        deskRoot: root,
        input: {
          track: "engineering",
          slug: "one-two-three-four-five-six-seven",
          title: "Title",
        },
      }),
    /invalid slug/,
  )
})

test("reading (updating) an existing badly named task still works — only creation validates", async () => {
  const root = await mkTempDeskRoot()
  const { writeMarkdown } = await import("../../../../../plugins/desk/mcp/src/util/fm.js")
  const { task_update } = await import("../../../../../plugins/desk/mcp/src/tools/task.js")
  const filePath = path.join(root, "engineering", "hi-do-the-thing", "task.md")
  await writeMarkdown(
    filePath,
    { schema_version: 1, title: "Old", status: "drafting", track: "engineering" },
    "",
  )

  const result = await task_update({
    deskRoot: root,
    input: { track: "engineering", slug: "hi-do-the-thing", frontmatter: { status: "doing" } },
  })
  assert.equal(result.status, "updated")
  const { data } = await readFront(filePath)
  assert.equal(data.status, "doing")
})

// ── M4-6 Part 2: stage + commit ─────────────────────────────────────────────

test("task_create stages and commits exactly the task.md it wrote", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const result = await task_create({
    deskRoot: root,
    input: { track: "europe-trip", slug: "book-flights", title: "Book the Paris flights" },
  })
  assert.equal(result.status, "created")
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "task_create: europe-trip/book-flights")
  assert.deepEqual(lastCommitFiles(root), [path.join("europe-trip", "book-flights", "task.md")])
})

test("task_create commits only its own file, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)

  // Simulates another process staging an unrelated path in the window
  // between task_create's write and its own stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await task_create({
    deskRoot: root,
    input: { track: "europe-trip", slug: "book-flights", title: "Book the Paris flights" },
  })

  assert.equal(result.commit, undefined, "task_create's own commit succeeded")
  assert.deepEqual(lastCommitFiles(root), [path.join("europe-trip", "book-flights", "task.md")])
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

test("task_create reports a commit failure without losing the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }
  const result = await task_create({
    deskRoot: root,
    input: { track: "europe-trip", slug: "book-flights", title: "Book the Paris flights" },
    spawnGit,
  })
  assert.equal(result.status, "created", "the write itself is never lost to a commit failure")
  assert.ok(await exists(path.join(root, "europe-trip", "book-flights", "task.md")))
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
})

test("task_create reports a staging failure without losing the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("add")) return { status: 1, stdout: "", stderr: "add boom" }
    return spawnSync(cmd, args, opts)
  }
  const result = await task_create({
    deskRoot: root,
    input: { track: "europe-trip", slug: "book-flights", title: "Book the Paris flights" },
    spawnGit,
  })
  assert.equal(result.status, "created", "the write itself is never lost to a staging failure")
  assert.deepEqual(result.commit, { status: "failed", reason: "add boom" }, "a stage failure is reported, not swallowed as a silent success")
  assert.ok(await exists(path.join(root, "europe-trip", "book-flights", "task.md")))
})

test("task_create skips staging and committing silently on a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  const result = await task_create({
    deskRoot: root,
    input: { track: "europe-trip", slug: "book-flights", title: "Book the Paris flights" },
  })
  assert.equal(result.status, "created")
  assert.equal(result.commit, undefined)
})
