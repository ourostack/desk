// task_archive — happy path moves dir, bumps status to done (given
// evidence) or cancelled (given outcome: "cancelled"), idempotent on
// already-archived; refuses if neither source nor archive exists, and
// refuses to bump a non-terminal task to done without evidence (the
// invented-completion finding: see the "Evidence/outcome gate" section).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import {
  task_create,
  task_archive,
  task_update,
} from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { task_move } from "../../../../../plugins/desk/mcp/src/tools/move.js"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"

const DONE_EVIDENCE = { kind: "pr", ref: "https://github.com/example-org/example-repo/pull/1" }

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

// `--no-renames` keeps this deterministic across git versions and content
// sizes: without it, whether `git show` reports a moved-and-edited task.md
// as one collapsed rename or as a separate delete + add depends on git's
// own content-similarity heuristic, which an archive bump's own byte count
// (an added `evidence:` block, say) can tip either way on a small fixture
// card. The move always touches exactly the old and new paths regardless;
// this only fixes how git's own report of that renders.
function lastCommitFiles(root) {
  const result = spawnSync("git", ["-C", root, "show", "--stat", "--format=", "--name-only", "--no-renames", "HEAD"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.split("\n").filter(Boolean).sort()
}

test("task_archive moves the dir into _archive/ and marks status=done", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "Some task" },
  })
  const result = await task_archive({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE },
  })
  assert.equal(result.status, "archived")

  const srcExists = await exists(path.join(root, "t", "book-flights"))
  assert.equal(srcExists, false, "source dir should be gone")
  const archived = path.join(root, "t", "_archive", "book-flights", "task.md")
  assert.ok(await exists(archived), "archived task.md should exist")

  const { data } = await readFront(archived)
  assert.equal(data.status, "done")
  assert.equal(data.evidence.kind, DONE_EVIDENCE.kind)
  assert.equal(data.evidence.ref, DONE_EVIDENCE.ref)
  assert.equal(data.evidence.recorded_at, data.updated)
})

test("task_archive preserves an already-terminal status", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: {
      track: "t",
      slug: "book-flights",
      title: "Done already",
      status: "cancelled",
    },
  })
  await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights" } })
  const { data } = await readFront(
    path.join(root, "t", "_archive", "book-flights", "task.md"),
  )
  assert.equal(data.status, "cancelled", "terminal status preserved")
})

test("task_archive is idempotent when source already archived", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T" },
  })
  await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE } })
  const second = await task_archive({
    deskRoot: root,
    input: { track: "t", slug: "book-flights" },
  })
  assert.equal(second.status, "already_archived")
  assert.equal(
    second.path,
    path.posix.join("t", "_archive", "book-flights", "task.md"),
  )
})

test("task_archive throws when neither source nor archive exists", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      task_archive({
        deskRoot: root,
        input: { track: "ghost", slug: "phantom" },
      }),
    /does not exist/,
  )
})

test("task_archive refuses an existing archive destination while the source exists", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T" },
  })
  await fs.mkdir(path.join(root, "t", "_archive", "book-flights"), { recursive: true })

  await assert.rejects(
    task_archive({
      deskRoot: root,
      input: { track: "t", slug: "book-flights" },
    }),
    /archive destination already exists/i,
  )
})

test("task_archive requires both task identifiers", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    task_archive({ deskRoot: root }),
    /track.*slug.*required/,
  )
  await assert.rejects(
    task_archive({ deskRoot: root, input: { slug: "book-flights" } }),
    /track.*slug.*required/,
  )
  await assert.rejects(
    task_archive({ deskRoot: root, input: { track: "t" } }),
    /track.*slug.*required/,
  )
})

test("task_archive moves a task directory even when its task card is absent", async () => {
  const root = await mkTempDeskRoot()
  await fs.mkdir(path.join(root, "t", "s"), { recursive: true })

  const result = await task_archive({
    deskRoot: root,
    input: { track: "t", slug: "s" },
  })

  assert.equal(result.status, "archived")
  assert.equal(await exists(path.join(root, "t", "s")), false)
  assert.equal(await exists(path.join(root, "t", "_archive", "s")), true)
})

test("task_archive creates _archive/ dir if missing", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "fresh", slug: "task-one", title: "T" },
  })
  // No _archive dir exists yet — the tool must create it.
  await task_archive({
    deskRoot: root,
    input: { track: "fresh", slug: "task-one", evidence: DONE_EVIDENCE },
  })
  const stat = await fs.stat(path.join(root, "fresh", "_archive"))
  assert.ok(stat.isDirectory())
})

test("task_archive's status bump preserves every other frontmatter byte untouched: a date-only value, a long single-line scalar, quoted and unquoted values, and a note: | block", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "byte-preserve", title: "Byte preserve" },
  })
  const filePath = path.join(root, "t", "byte-preserve", "task.md")
  const handWritten = [
    "---",
    "schema_version: 1",
    "title: Byte preserve",
    "track: t",
    "status: processing",
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
    "# Byte preserve",
    "",
    "Body text.",
    "",
  ].join("\n")
  await fs.writeFile(filePath, handWritten, "utf8")

  await task_archive({ deskRoot: root, input: { track: "t", slug: "byte-preserve", evidence: DONE_EVIDENCE } })

  const archivedPath = path.join(root, "t", "_archive", "byte-preserve", "task.md")
  const raw = await fs.readFile(archivedPath, "utf8")
  assert.match(raw, /\nstatus: done\n/u, "status is bumped to done")
  assert.doesNotMatch(raw, /updated: "2026-09-20T10:00:00Z"/u, "updated is refreshed")
  assert.match(raw, /\ncreated: 2026-05-26\n/u, "the date-only created value is untouched")
  assert.match(raw, /\nrequester: "ari"\n/u, "the quoted requester value is untouched")
  assert.match(raw, /\nreviewer: ari\n/u, "the unquoted reviewer value is untouched")
  assert.match(
    raw,
    /\npurpose: A long single-line scalar describing the task in one uninterrupted run of prose, with no wrapping at all\.\n/u,
    "the long single-line purpose scalar is untouched",
  )
  assert.match(raw, /\nnote: \|\n {2}first literal line\n {2}second literal line\n/u, "the note: | block is untouched")
})

// ── M4-6 Part 2: stage + commit ─────────────────────────────────────────────

test("task_archive stages and commits exactly the moved paths", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" }, schedulePush: () => {} })

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE }, schedulePush: () => {} })

  assert.equal(result.status, "archived")
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "task_archive: t/book-flights")
  assert.deepEqual(
    lastCommitFiles(root),
    [path.posix.join("t", "_archive", "book-flights", "task.md"), path.posix.join("t", "book-flights", "task.md")].sort(),
  )
})

test("task_archive calls schedulePush exactly once with { root: deskRoot } on a successful commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" }, schedulePush: () => {} })

  const calls = []
  const result = await task_archive({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE },
    schedulePush: (opts) => calls.push(opts),
  })

  assert.equal(result.status, "archived")
  assert.deepEqual(calls, [{ root }], "schedulePush is called exactly once, with the desk root")
})

test("task_archive commits only its own paths, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" }, schedulePush: () => {} })

  // Simulates another process staging an unrelated path in the window
  // between task_archive's move and its own stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE }, schedulePush: () => {} })

  assert.equal(result.commit, undefined, "task_archive's own commit succeeded")
  assert.deepEqual(
    lastCommitFiles(root),
    [path.posix.join("t", "_archive", "book-flights", "task.md"), path.posix.join("t", "book-flights", "task.md")].sort(),
  )
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

test("task_archive reports a commit failure without losing the move", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" }, schedulePush: () => {} })
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  const calls = []
  const result = await task_archive({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE },
    spawnGit,
    schedulePush: (opts) => calls.push(opts),
  })

  assert.equal(result.status, "archived", "the move itself is never lost to a commit failure")
  assert.ok(await exists(path.join(root, "t", "_archive", "book-flights", "task.md")))
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
  assert.equal(calls.length, 0, "schedulePush is never called when the commit fails")
})

test("task_archive reports a staging failure without losing the move", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" }, schedulePush: () => {} })
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("add")) return { status: 1, stdout: "", stderr: "add boom" }
    return spawnSync(cmd, args, opts)
  }

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE }, spawnGit })

  assert.equal(result.status, "archived", "the move itself is never lost to a staging failure")
  assert.deepEqual(result.commit, { status: "failed", reason: "add boom" }, "a stage failure is reported, not swallowed as a silent success")
  assert.ok(await exists(path.join(root, "t", "_archive", "book-flights", "task.md")))
})

test("task_archive skips staging and committing silently on a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" } })
  const calls = []
  const result = await task_archive({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE },
    schedulePush: (opts) => calls.push(opts),
  })
  assert.equal(result.status, "archived")
  assert.equal(result.commit, undefined)
  assert.equal(calls.length, 0, "schedulePush is never called on a non-Git desk")
})

test("already_archived stages and commits nothing", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "Some task" }, schedulePush: () => {} })
  await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE }, schedulePush: () => {} })

  const before = lastCommitMessage(root)
  const calls = []
  const result = await task_archive({
    deskRoot: root,
    input: { track: "t", slug: "book-flights" },
    schedulePush: (opts) => calls.push(opts),
  })

  assert.equal(result.status, "already_archived")
  assert.equal(result.commit, undefined)
  assert.equal(lastCommitMessage(root), before, "nothing changed, so nothing was committed")
  assert.equal(gitStatus(root), "")
  assert.equal(calls.length, 0, "schedulePush is never called on the idempotent already_archived path")
})

// ── Evidence/outcome gate on the archive bump (the invented-completion finding) ──

test("task_archive refuses to archive a non-terminal task with neither evidence nor outcome, moving nothing", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })

  await assert.rejects(
    task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights" } }),
    /task_archive: moving a task to `done` needs evidence.*evidence: \{ kind, ref \}/,
  )

  assert.equal(await exists(path.join(root, "t", "book-flights")), true, "the source directory is untouched")
  assert.equal(await exists(path.join(root, "t", "_archive", "book-flights")), false, "nothing was archived")
})

test("task_archive refuses `evidence` and `outcome` together, moving nothing", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })

  await assert.rejects(
    task_archive({
      deskRoot: root,
      input: { track: "t", slug: "book-flights", evidence: DONE_EVIDENCE, outcome: "cancelled" },
    }),
    /task_archive: pass either `evidence`.*or `outcome: "cancelled"`.*not both/,
  )

  assert.equal(await exists(path.join(root, "t", "book-flights")), true, "the source directory is untouched")
})

test("task_archive refuses an `outcome` other than \"cancelled\", naming the bad value", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })

  await assert.rejects(
    task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights", outcome: "abandoned" } }),
    /task_archive: `outcome`, when given, must be "cancelled" \(got "abandoned"\)/,
  )

  assert.equal(await exists(path.join(root, "t", "book-flights")), true, "the source directory is untouched")
})

test('task_archive accepts `outcome: "cancelled"` for a non-terminal task, archiving it as cancelled with no evidence recorded', async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })

  const result = await task_archive({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", outcome: "cancelled" },
  })
  assert.equal(result.status, "archived")

  const { data } = await readFront(path.join(root, "t", "_archive", "book-flights", "task.md"))
  assert.equal(data.status, "cancelled")
  assert.equal(data.evidence, undefined, "an outcome: cancelled archive records no evidence")
})

test("task_archive archives an already-`done` task with no evidence or outcome, unchanged", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "done" },
  })

  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "book-flights" } })
  assert.equal(result.status, "archived")

  const { data } = await readFront(path.join(root, "t", "_archive", "book-flights", "task.md"))
  assert.equal(data.status, "done")
})

test("task_archive refuses malformed `evidence` the same way task_update does, moving nothing", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })

  await assert.rejects(
    task_archive({
      deskRoot: root,
      input: { track: "t", slug: "book-flights", evidence: { kind: "vibes", ref: "trust me" } },
    }),
    /task_archive: `evidence` is not valid.*"kind":"vibes"/,
  )

  assert.equal(await exists(path.join(root, "t", "book-flights")), true, "the source directory is untouched")
})

test("task_archive's evidence is shape-checked per kind, the same as task_update's, moving nothing on a bad ref", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })

  await assert.rejects(
    task_archive({
      deskRoot: root,
      input: { track: "t", slug: "book-flights", evidence: { kind: "pr", ref: "not a url" } },
    }),
    /task_archive: `evidence\.ref` is not a checkable pr reference.*PR URL/,
  )

  assert.equal(await exists(path.join(root, "t", "book-flights")), true, "the source directory is untouched")
})

// ── the delivery record and the sign-off packet ─────────────────────────────

test("task_archive that finishes a task marks it delivered_unsigned and answers with the packet", async () => {
  const root = await mkTempDeskRoot()
  const SENTINEL = "SENTINEL-card-body-text"
  await task_create({ deskRoot: root, input: { track: "t", slug: "finish-me", title: "Write the report", body: `${SENTINEL}\n` } })
  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "finish-me", evidence: DONE_EVIDENCE } })
  assert.equal(result.signoff, "delivered_unsigned")
  assert.deepEqual(result.signoff_packet, ["Asked: Write the report", `Delivered: ${DONE_EVIDENCE.ref}`, "Accept or send back?"])
  assert.match(result.signoff_note, /^This task is delivered, not accepted\./)
  assert.ok(!JSON.stringify(result).includes(SENTINEL))
  const file = path.join(root, "t", "_archive", "finish-me", "task.md")
  const { data } = await readFront(file)
  assert.deepEqual(data.signoff, { state: "delivered_unsigned", at: null, reason: null })
  assert.equal(data.flow.since, "created")
  assert.equal(data.flow.rev, 1)
  assert.equal(data.flow.deliveries, 1)
  assert.equal(data.flow.delivered_at, data.updated)
  assert.equal(data.flow.first_delivered_at, data.updated)
  assert.equal(data.flow.first_validating_at, data.updated)
  assert.equal(data.evidence.ref, DONE_EVIDENCE.ref)
})

test("task_archive of a legacy card with no flow marks it adopted and keeps a returns list", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "legacy-finish", title: "Unique title legacy-finish" } })
  const file = path.join(root, "t", "legacy-finish", "task.md")
  const card = await readFront(file)
  delete card.data.flow
  card.data.returns = ["processing, 2026-10-05T10:00:00Z, agent_error"]
  await writeMarkdown(file, card.data, card.content)
  await task_archive({ deskRoot: root, input: { track: "t", slug: "legacy-finish", evidence: DONE_EVIDENCE } })
  const { data } = await readFront(path.join(root, "t", "_archive", "legacy-finish", "task.md"))
  assert.equal(data.flow.since, "adopted")
  assert.equal(data.flow.deliveries, 1)
  assert.deepEqual(data.returns, ["processing, 2026-10-05T10:00:00Z, agent_error"])
})

test("task_archive of a task cancelled writes no signoff", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "drop-me", title: "T" } })
  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "drop-me", outcome: "cancelled" } })
  assert.equal(result.signoff, undefined)
  assert.equal(result.signoff_packet, undefined)
  const { data } = await readFront(path.join(root, "t", "_archive", "drop-me", "task.md"))
  assert.equal(data.status, "cancelled")
  assert.equal(data.signoff, undefined)
  assert.equal(data.flow.deliveries, 0)
})

test("task_archive of a card already done adds no delivery and keeps its record byte for byte", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "kept-record", title: "T" } })
  await task_update({ deskRoot: root, input: { track: "t", slug: "kept-record", frontmatter: { status: "done" }, evidence: DONE_EVIDENCE } })
  const before = (await readFront(path.join(root, "t", "kept-record", "task.md"))).data
  const result = await task_archive({ deskRoot: root, input: { track: "t", slug: "kept-record" } })
  assert.equal(result.signoff, undefined)
  const { data } = await readFront(path.join(root, "t", "_archive", "kept-record", "task.md"))
  assert.deepEqual(data.signoff, before.signoff)
  assert.deepEqual(data.flow, before.flow)
})

test("task_archive without evidence writes no signoff", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "no-proof", title: "T" } })
  await assert.rejects(task_archive({ deskRoot: root, input: { track: "t", slug: "no-proof" } }), /needs evidence/)
  const { data } = await readFront(path.join(root, "t", "no-proof", "task.md"))
  assert.equal(data.signoff, undefined)
})

test("task_archive with outcome cancelled on a card already done is not a move out of done: the card stays done and keeps its record", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "done-then-cancel", title: "T" } })
  await task_update({ deskRoot: root, input: { track: "t", slug: "done-then-cancel", frontmatter: { status: "done" }, evidence: DONE_EVIDENCE } })
  const before = await readFront(path.join(root, "t", "done-then-cancel", "task.md"))
  await task_archive({ deskRoot: root, input: { track: "t", slug: "done-then-cancel", outcome: "cancelled" } })
  const { data } = await readFront(path.join(root, "t", "_archive", "done-then-cancel", "task.md"))
  assert.equal(data.status, "done")
  assert.deepEqual(data.signoff, before.data.signoff)
  assert.deepEqual(data.flow, before.data.flow)
  assert.equal(data.returns, undefined)
})

test("task_archive that finishes a card paused after review goes through the same record move as task_update", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "paused-finish", title: "T", status: "validating" } })
  await task_update({ deskRoot: root, input: { track: "t", slug: "paused-finish", frontmatter: { status: "paused" } } })
  await task_archive({ deskRoot: root, input: { track: "t", slug: "paused-finish", evidence: DONE_EVIDENCE } })
  const { data } = await readFront(path.join(root, "t", "_archive", "paused-finish", "task.md"))
  assert.equal(data.flow.reached, "done")
  assert.equal(data.flow.deliveries, 1)
  assert.equal(typeof data.flow.first_validating_at, "string")
  assert.equal(data.returns, undefined)
})

// ── archive, bring back, move back: the same reason rule as task_update ─────

async function archivedValidating(root, slug, { withFlow }) {
  await task_create({ deskRoot: root, input: { track: "t", slug, title: `Unique title ${slug}`, status: "validating" } })
  const file = path.join(root, "t", slug, "task.md")
  if (!withFlow) {
    const card = await readFront(file)
    delete card.data.flow
    await writeMarkdown(file, card.data, card.content)
  }
}
const unarchive = (root, slug) => task_move({ deskRoot: root, input: { track: "t", slug, unarchive: true } })
const back = (root, slug, extra = {}) => task_update({ deskRoot: root, input: { track: "t", slug, frontmatter: { status: "processing" }, ...extra }, finalize: async () => {} })

for (const withFlow of [true, false]) {
  test(`a validating card (${withFlow ? "with" : "without"} a flow record) cancelled by archive, brought back and moved to processing needs a reason`, async () => {
    const root = await mkTempDeskRoot()
    const slug = `cancel-back-${withFlow}`
    await archivedValidating(root, slug, { withFlow })
    await task_archive({ deskRoot: root, input: { track: "t", slug, outcome: "cancelled" } })
    assert.equal((await readFront(path.join(root, "t", "_archive", slug, "task.md"))).data.flow.reached, "validating")
    await unarchive(root, slug)
    const file = path.join(root, "t", slug, "task.md")
    const before = await fs.readFile(file, "utf8")
    await assert.rejects(back(root, slug), /from cancelled back to processing is a return and needs a reason/)
    assert.equal(await fs.readFile(file, "utf8"), before)
    const result = await back(root, slug, { return_reason: "changed_ask" })
    assert.equal(result.return_recorded, "cancelled to processing, changed_ask, caught at_review")
    assert.equal((await readFront(file)).data.returns.length, 1)
  })
}

test("a validating card delivered by archive, brought back and moved to processing needs a reason and records one return after delivery", async () => {
  const root = await mkTempDeskRoot()
  await archivedValidating(root, "deliver-back", { withFlow: true })
  await task_archive({ deskRoot: root, input: { track: "t", slug: "deliver-back", evidence: DONE_EVIDENCE } })
  await unarchive(root, "deliver-back")
  const file = path.join(root, "t", "deliver-back", "task.md")
  const before = await fs.readFile(file, "utf8")
  await assert.rejects(back(root, "deliver-back"), /from done back to processing is a return and needs a reason/)
  assert.equal(await fs.readFile(file, "utf8"), before)
  const result = await back(root, "deliver-back", { return_reason: "new_information" })
  assert.equal(result.return_recorded, "done to processing, new_information, caught after_delivery")
  assert.equal((await readFront(file)).data.returns.length, 1)
})

test("task_archive refuses to cancel a hand-damaged card whose record cannot move, before the folder moves, in words an agent can act on", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "damaged", title: "Damaged" } })
  const file = path.join(root, "t", "damaged", "task.md")
  await task_update({ deskRoot: root, input: { track: "t", slug: "damaged", frontmatter: { status: "done" }, evidence: DONE_EVIDENCE } })
  // A hand edit past the card guard: the status is no longer one of the statuses, and the record says the task reached done.
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/^status: done$/mu, "status: weird"))
  await assert.rejects(
    task_archive({ deskRoot: root, input: { track: "t", slug: "damaged", outcome: "cancelled" } }),
    /^Error: task_archive: nothing was moved\. This card's status is not one Desk knows, so Desk took the last status in the card's record as where the task moves from, and that move is refused \(this move sends work back and needs a return reason\)\. Set the card's status with task_update first/u,
  )
  assert.ok(await exists(file), "the live folder is where it was")
  assert.equal(await exists(path.join(root, "t", "_archive", "damaged")), false)
})
