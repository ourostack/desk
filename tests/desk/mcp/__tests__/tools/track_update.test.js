// track_update — merge frontmatter, preserve schema_version + created,
// body append, refusal on missing track, scope validation (M4-1).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { track_create, track_update } from "../../../../../plugins/desk/mcp/src/tools/track.js"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"

const SCOPE = "billing disputes and refund flows; not payroll"

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

test("track_update merges frontmatter and refreshes `updated`", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE },
  })
  const filePath = path.join(root, "billing-disputes", "track.md")
  const before = await readFront(filePath)

  await new Promise((r) => setTimeout(r, 1100))

  const result = await track_update({
    deskRoot: root,
    input: { slug: "billing-disputes", frontmatter: { status: "closed" } },
  })
  assert.equal(result.status, "updated")

  const after = await readFront(filePath)
  assert.equal(after.data.status, "closed")
  assert.equal(after.data.title, "T")
  assert.notEqual(after.data.updated, before.data.updated)
  assert.equal(after.data.created, before.data.created)
})

test("track_update preserves schema_version + created against override", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE },
  })
  const filePath = path.join(root, "billing-disputes", "track.md")
  const before = await readFront(filePath)

  await track_update({
    deskRoot: root,
    input: {
      slug: "billing-disputes",
      frontmatter: { schema_version: 42, created: "1999-01-01T00:00:00Z" },
    },
  })
  const after = await readFront(filePath)
  assert.equal(after.data.schema_version, 1)
  assert.equal(after.data.created, before.data.created)
})

test("track_update adds schema_version to a legacy track without inventing created", async () => {
  const root = await mkTempDeskRoot()
  const filePath = path.join(root, "legacy-track", "track.md")
  await writeMarkdown(filePath, { title: "Legacy" }, "Legacy body")

  await track_update({
    deskRoot: root,
    input: { slug: "legacy-track", frontmatter: { status: "active" } },
  })

  const after = await readFront(filePath)
  assert.equal(after.data.schema_version, 1)
  assert.equal(after.data.created, undefined)
})

test("track_update appends to body", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: {
      slug: "billing-disputes",
      title: "T",
      scope: SCOPE,
      body: "## Scope\n\nOriginal.",
    },
  })
  await track_update({
    deskRoot: root,
    input: { slug: "billing-disputes", body_append: "## Update\n\nMore." },
  })
  const { content } = await readFront(path.join(root, "billing-disputes", "track.md"))
  assert.match(content, /Original\./)
  assert.match(content, /## Update/)
})

test("track_update appends without a separator to empty or blank-line-terminated bodies", async () => {
  const root = await mkTempDeskRoot()
  const emptyPath = path.join(root, "empty-track", "track.md")
  const terminatedPath = path.join(root, "terminated-track", "track.md")
  await fs.mkdir(path.dirname(emptyPath), { recursive: true })
  await fs.mkdir(path.dirname(terminatedPath), { recursive: true })
  await fs.writeFile(emptyPath, "---\ntitle: Empty\n---\n", "utf8")
  await fs.writeFile(
    terminatedPath,
    "---\ntitle: Terminated\n---\nBody\n\n",
    "utf8",
  )

  await track_update({
    deskRoot: root,
    input: { slug: "empty-track", body_append: "First" },
  })
  await track_update({
    deskRoot: root,
    input: { slug: "terminated-track", body_append: "Next" },
  })

  assert.match((await readFront(emptyPath)).content, /^\n?First/)
  assert.match((await readFront(terminatedPath)).content, /Body\n\nNext/)
})

test("track_update ignores an empty body append", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE, body: "Original" },
  })

  await track_update({
    deskRoot: root,
    input: { slug: "billing-disputes", body_append: "" },
  })

  assert.match((await readFront(path.join(root, "billing-disputes", "track.md"))).content, /Original/)
})

test("track_update refuses to update a missing track", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      track_update({
        deskRoot: root,
        input: { slug: "ghost-track", frontmatter: { status: "active" } },
      }),
    /does not exist/,
  )
})

test("track_update requires a slug", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    track_update({ deskRoot: root }),
    /slug.*required/,
  )
  await assert.rejects(
    track_update({
      deskRoot: root,
      input: { frontmatter: { status: "active" } },
    }),
    /slug.*required/,
  )
})

// ── M4-1: scope validation ──────────────────────────────────────────────

test("track_update sets a well-formed scope", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE },
  })
  const newScope = "refund disputes only; not chargebacks"
  await track_update({
    deskRoot: root,
    input: { slug: "billing-disputes", frontmatter: { scope: newScope } },
  })
  const { data } = await readFront(path.join(root, "billing-disputes", "track.md"))
  assert.equal(data.scope, newScope)
})

test("track_update rejects an invalid scope and leaves the file untouched", async () => {
  const root = await mkTempDeskRoot()
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE },
  })
  const before = await readFront(path.join(root, "billing-disputes", "track.md"))

  await assert.rejects(
    () =>
      track_update({
        deskRoot: root,
        input: {
          slug: "billing-disputes",
          frontmatter: { scope: "line one\nline two" },
        },
      }),
    /single line/,
  )

  const after = await readFront(path.join(root, "billing-disputes", "track.md"))
  assert.deepEqual(after.data, before.data)
})

test("track_update leaves an existing badly named track's scope alone when scope isn't in the update", async () => {
  // The slug itself is never re-validated by track_update (only creation
  // and renaming validate names) — a track created before these rules
  // existed still updates fine as long as the update doesn't touch scope.
  const root = await mkTempDeskRoot()
  const filePath = path.join(root, "misc", "track.md")
  await writeMarkdown(filePath, { title: "Misc", status: "active" }, "")

  const result = await track_update({
    deskRoot: root,
    input: { slug: "misc", frontmatter: { status: "closed" } },
  })
  assert.equal(result.status, "updated")
  const { data } = await readFront(filePath)
  assert.equal(data.status, "closed")
})

// ── M4-6 Part 2: stage + commit ─────────────────────────────────────────────

test("track_update stages and commits exactly the track.md it updated", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE },
  })

  const result = await track_update({
    deskRoot: root,
    input: { slug: "billing-disputes", frontmatter: { status: "closed" } },
  })

  assert.equal(result.status, "updated")
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "track_update: billing-disputes")
  assert.deepEqual(lastCommitFiles(root), [path.join("billing-disputes", "track.md")])
})

test("track_update commits only its own file, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE },
  })

  // Simulates another process staging an unrelated path in the window
  // between track_update's dirty check and its own stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await track_update({
    deskRoot: root,
    input: { slug: "billing-disputes", frontmatter: { status: "closed" } },
  })

  assert.equal(result.commit, undefined, "track_update's own commit succeeded")
  assert.deepEqual(lastCommitFiles(root), [path.join("billing-disputes", "track.md")])
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

test("track_update reports a commit failure without losing the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE },
  })
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  const result = await track_update({
    deskRoot: root,
    input: { slug: "billing-disputes", frontmatter: { status: "closed" } },
    spawnGit,
  })

  assert.equal(result.status, "updated", "the write itself is never lost to a commit failure")
  const { data } = await readFront(path.join(root, "billing-disputes", "track.md"))
  assert.equal(data.status, "closed")
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
})

test("track_update skips staging and committing when the file held unstaged changes before the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await track_create({
    deskRoot: root,
    input: { slug: "billing-disputes", title: "T", scope: SCOPE },
  })
  const filePath = path.join(root, "billing-disputes", "track.md")

  // Another session's unstaged edit to this same file, in place before
  // track_update writes.
  await fs.appendFile(filePath, "\nanother session's note\n")

  const result = await track_update({
    deskRoot: root,
    input: { slug: "billing-disputes", frontmatter: { status: "closed" } },
  })

  assert.equal(result.status, "updated", "the write always happens")
  assert.equal(result.commit, undefined, "no commit attempted when the file was already dirty")
  const { data } = await readFront(filePath)
  assert.equal(data.status, "closed")
  assert.match(gitStatus(root), /billing-disputes\/track\.md/, "the file is left as an uncommitted change")
})
