// task_update — frontmatter merge, body append, preservation of
// schema_version + created, refusal on missing task.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"

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

test("task_update merges frontmatter and refreshes `updated`", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", body: "Hello" },
  })
  const filePath = path.join(root, "t", "book-flights", "task.md")
  const before = await readFront(filePath)

  // Force a small wait so `updated` will differ at second-precision.
  await new Promise((r) => setTimeout(r, 1100))

  const result = await task_update({
    deskRoot: root,
    input: {
      track: "t",
      slug: "book-flights",
      frontmatter: { status: "processing", category: "general" },
    },
  })
  assert.equal(result.status, "updated")

  const after = await readFront(filePath)
  assert.equal(after.data.status, "processing")
  assert.equal(after.data.category, "general")
  assert.equal(after.data.title, "T", "title preserved")
  assert.notEqual(after.data.updated, before.data.updated, "updated bumped")
  assert.equal(after.data.created, before.data.created, "created preserved")
  assert.equal(after.data.schema_version, 1)
})

test("task_update preserves schema_version + created even if caller overrides them", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T" },
  })
  const filePath = path.join(root, "t", "book-flights", "task.md")
  const before = await readFront(filePath)

  await task_update({
    deskRoot: root,
    input: {
      track: "t",
      slug: "book-flights",
      frontmatter: {
        schema_version: 99,
        created: "1900-01-01T00:00:00Z",
        status: "blocked",
      },
    },
  })
  const after = await readFront(filePath)
  assert.equal(after.data.schema_version, 1, "schema_version locked to 1")
  assert.equal(after.data.created, before.data.created, "created locked")
  assert.equal(after.data.status, "blocked")
})

test("task_update adds schema_version to a legacy task without inventing created", async () => {
  const root = await mkTempDeskRoot()
  const filePath = path.join(root, "t", "s", "task.md")
  await writeMarkdown(filePath, { title: "Legacy" }, "Legacy body")

  await task_update({
    deskRoot: root,
    input: { track: "t", slug: "s", frontmatter: { status: "paused" } },
  })

  const after = await readFront(filePath)
  assert.equal(after.data.schema_version, 1)
  assert.equal(after.data.created, undefined)
})

test("task_update appends to body with a blank-line separator", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", body: "Original body" },
  })
  await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", body_append: "Second paragraph" },
  })
  const { content } = await readFront(
    path.join(root, "t", "book-flights", "task.md"),
  )
  assert.match(content, /Original body/)
  assert.match(content, /Second paragraph/)
  assert.ok(
    content.indexOf("Original body") < content.indexOf("Second paragraph"),
    "appended content follows existing body",
  )
})

test("task_update appends without a separator to empty or blank-line-terminated bodies", async () => {
  const root = await mkTempDeskRoot()
  const emptyPath = path.join(root, "t", "empty", "task.md")
  const terminatedPath = path.join(root, "t", "terminated", "task.md")
  await fs.mkdir(path.dirname(emptyPath), { recursive: true })
  await fs.mkdir(path.dirname(terminatedPath), { recursive: true })
  await fs.writeFile(emptyPath, "---\ntitle: Empty\n---\n", "utf8")
  await fs.writeFile(
    terminatedPath,
    "---\ntitle: Terminated\n---\nBody\n\n",
    "utf8",
  )

  await task_update({
    deskRoot: root,
    input: { track: "t", slug: "empty", body_append: "First" },
  })
  await task_update({
    deskRoot: root,
    input: { track: "t", slug: "terminated", body_append: "Next" },
  })

  assert.match((await readFront(emptyPath)).content, /^\n?First/)
  assert.match((await readFront(terminatedPath)).content, /Body\n\nNext/)
})

test("task_update ignores an empty body append", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", body: "Original" },
  })

  await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", body_append: "" },
  })

  assert.match(
    (await readFront(path.join(root, "t", "book-flights", "task.md"))).content,
    /Original/,
  )
})

test("task_update refuses to update a missing task", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () =>
      task_update({
        deskRoot: root,
        input: { track: "nope", slug: "nada", frontmatter: { status: "paused" } },
      }),
    /does not exist/,
  )
})

test("task_update requires both task identifiers", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    task_update({ deskRoot: root }),
    /track.*slug.*required/,
  )
  await assert.rejects(
    task_update({
      deskRoot: root,
      input: { slug: "s", frontmatter: { status: "x" } },
    }),
    /track.*slug.*required/,
  )
  await assert.rejects(
    task_update({
      deskRoot: root,
      input: { track: "t", frontmatter: { status: "x" } },
    }),
    /track.*slug.*required/,
  )
})

// ── Evidence gate on `done` (the invented-completion finding) ──────────────

test("task_update refuses a bare move to `done`, leaving the card untouched, and names what to supply", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })
  const filePath = path.join(root, "t", "book-flights", "task.md")
  const before = await readFront(filePath)

  await assert.rejects(
    task_update({
      deskRoot: root,
      input: { track: "t", slug: "book-flights", frontmatter: { status: "done" } },
    }),
    /task_update: moving a task to `done` needs evidence.*evidence: \{ kind, ref \}/,
  )

  const after = await readFront(filePath)
  assert.deepEqual(after.data, before.data, "a refused done transition writes nothing")
})

test("task_update refuses `done` with a malformed evidence object, naming the bad value", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })

  await assert.rejects(
    task_update({
      deskRoot: root,
      input: {
        track: "t",
        slug: "book-flights",
        frontmatter: { status: "done" },
        evidence: { kind: "vibes", ref: "trust me" },
      },
    }),
    /task_update: `evidence` is not valid.*"kind":"vibes"/,
  )

  await assert.rejects(
    task_update({
      deskRoot: root,
      input: {
        track: "t",
        slug: "book-flights",
        frontmatter: { status: "done" },
        evidence: { kind: "pr", ref: "   " },
      },
    }),
    /task_update: `evidence` is not valid/,
    "a blank ref is not a reference",
  )
})

for (const evidence of [
  { kind: "pr", ref: "https://github.com/example-org/example-repo/pull/42" },
  { kind: "commit", ref: "a1b2c3d on origin/main" },
  { kind: "ci_run", ref: "https://ci.example.invalid/runs/9001" },
  { kind: "non_code", ref: "https://example.invalid/confirmation/abc" },
]) {
  test(`task_update accepts a move to \`done\` with ${evidence.kind} evidence, and records it on the card`, async () => {
    const root = await mkTempDeskRoot()
    await task_create({
      deskRoot: root,
      input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
    })

    const result = await task_update({
      deskRoot: root,
      input: { track: "t", slug: "book-flights", frontmatter: { status: "done" }, evidence },
    })
    assert.equal(result.status, "updated")

    const { data } = await readFront(path.join(root, "t", "book-flights", "task.md"))
    assert.equal(data.status, "done")
    assert.equal(data.evidence.kind, evidence.kind)
    assert.equal(data.evidence.ref, evidence.ref)
    assert.equal(data.evidence.recorded_at, data.updated)
  })
}

// ── Per-kind ref-shape checks (network-free, 2026-09-29 review of #106) ────
//
// `assertDoneEvidence` checks each kind's `ref` against its own shape --
// commit and non_code each accept two distinct shapes, and every kind
// refuses a ref that doesn't look like a reference at all. The loop above
// only exercises one accepted shape per kind; these two loops round that
// out to full branch coverage of `DONE_EVIDENCE_REF_CHECKS`.

for (const evidence of [
  { kind: "commit", ref: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", label: "a full 40-character sha with no repo/branch suffix" },
  { kind: "commit", ref: "https://github.com/example-org/example-repo/commit/a1b2c3d", label: "a commit URL rather than a bare sha" },
  { kind: "non_code", ref: "reports/2026-09-29-confirmation.md", label: "a desk-relative path to a file that exists in the desk" },
]) {
  test(`task_update accepts ${evidence.kind} evidence in its other checkable shape (${evidence.label})`, async () => {
    const root = await mkTempDeskRoot()
    await task_create({
      deskRoot: root,
      input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
    })
    if (evidence.kind === "non_code") {
      const proofPath = path.join(root, evidence.ref)
      await fs.mkdir(path.dirname(proofPath), { recursive: true })
      await fs.writeFile(proofPath, "confirmation\n")
    }

    const result = await task_update({
      deskRoot: root,
      input: { track: "t", slug: "book-flights", frontmatter: { status: "done" }, evidence: { kind: evidence.kind, ref: evidence.ref } },
    })
    assert.equal(result.status, "updated")

    const { data } = await readFront(path.join(root, "t", "book-flights", "task.md"))
    assert.equal(data.evidence.kind, evidence.kind)
    assert.equal(data.evidence.ref, evidence.ref)
  })
}

for (const evidence of [
  { kind: "pr", ref: "https://github.com/example-org/example-repo/issues/42", why: "an issue URL, not a pull request URL" },
  { kind: "pr", ref: "example-org/example-repo#42", why: "a shorthand reference with no URL at all" },
  { kind: "commit", ref: "abc12", why: "5 hex characters -- shorter than the 7-character minimum" },
  { kind: "commit", ref: "not-hex-at-all", why: "not a hex string" },
  { kind: "ci_run", ref: "http://ci.example.invalid/runs/9001", why: "http, not https" },
  { kind: "ci_run", ref: "ci.example.invalid/runs/9001", why: "no scheme at all" },
  { kind: "non_code", ref: "the confirmation email ari sent", why: "free text with a space, not a link or path" },
  { kind: "non_code", ref: "/etc/confirmation.txt", why: "an absolute path, machine-specific" },
  { kind: "non_code", ref: "~/confirmation.txt", why: "a tilde path, machine-specific" },
  { kind: "non_code", ref: "ftp://files.example.invalid/confirmation.txt", why: "a non-https URL scheme" },
  { kind: "non_code", ref: "C:\\Users\\ari\\confirmation.txt", why: "a Windows drive-letter path" },
]) {
  test(`task_update refuses ${evidence.kind} evidence whose ref is ${evidence.why}, naming the expected shape`, async () => {
    const root = await mkTempDeskRoot()
    await task_create({
      deskRoot: root,
      input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
    })

    await assert.rejects(
      task_update({
        deskRoot: root,
        input: { track: "t", slug: "book-flights", frontmatter: { status: "done" }, evidence: { kind: evidence.kind, ref: evidence.ref } },
      }),
      new RegExp(`task_update: \`evidence.ref\` is not a checkable ${evidence.kind} reference`),
    )
  })
}

// ── non_code containment + existence check (2026-09-29 controller check of
// a363c057) ──────────────────────────────────────────────────────────────
//
// Format alone let free text like "done" or "trustme" pass as non_code
// evidence, since a desk-relative path was never actually resolved. Now the
// tool -- which has the desk root -- resolves the ref against it and
// requires it land on something that exists, inside the desk.

test("task_update accepts non_code evidence whose ref is a desk-relative path to a directory, not just a file", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })
  await fs.mkdir(path.join(root, "reports", "confirmation-photos"), { recursive: true })

  const result = await task_update({
    deskRoot: root,
    input: {
      track: "t",
      slug: "book-flights",
      frontmatter: { status: "done" },
      evidence: { kind: "non_code", ref: "reports/confirmation-photos" },
    },
  })
  assert.equal(result.status, "updated")

  const { data } = await readFront(path.join(root, "t", "book-flights", "task.md"))
  assert.equal(data.evidence.ref, "reports/confirmation-photos")
})

test("task_update refuses non_code evidence whose ref escapes the desk root via \"..\", even though the target actually exists", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })
  // A sibling temp desk root, so the referenced file genuinely exists on
  // disk -- a plain existence check with no containment check would wrongly
  // accept this.
  const outside = await mkTempDeskRoot()
  await fs.writeFile(path.join(outside, "proof.md"), "not actually in this desk\n")
  const ref = path.join("..", path.basename(outside), "proof.md")

  await assert.rejects(
    task_update({
      deskRoot: root,
      input: {
        track: "t",
        slug: "book-flights",
        frontmatter: { status: "done" },
        evidence: { kind: "non_code", ref },
      },
    }),
    /task_update: `evidence\.ref` is not a checkable non_code reference.*actually present inside the desk/,
  )
})

test("task_update refuses non_code evidence whose ref names nothing that exists in the desk", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })

  await assert.rejects(
    task_update({
      deskRoot: root,
      input: {
        track: "t",
        slug: "book-flights",
        frontmatter: { status: "done" },
        evidence: { kind: "non_code", ref: "reports/does-not-exist.md" },
      },
    }),
    /task_update: `evidence\.ref` is not a checkable non_code reference.*actually present inside the desk/,
  )
})

test("task_update accepts `evidence` as a JSON string, the same tolerance `frontmatter` gets", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })

  const result = await task_update({
    deskRoot: root,
    input: {
      track: "t",
      slug: "book-flights",
      frontmatter: { status: "done" },
      evidence: JSON.stringify({ kind: "pr", ref: "https://github.com/example-org/example-repo/pull/42" }),
    },
  })
  assert.equal(result.status, "updated")
  const { data } = await readFront(path.join(root, "t", "book-flights", "task.md"))
  assert.equal(data.evidence.ref, "https://github.com/example-org/example-repo/pull/42")
})

test("task_update needs no evidence for a transition to any status other than `done`, including `cancelled`", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "processing" },
  })

  for (const status of ["blocked", "paused", "collaborating", "cancelled"]) {
    const result = await task_update({
      deskRoot: root,
      input: { track: "t", slug: "book-flights", frontmatter: { status } },
    })
    assert.equal(result.status, "updated")
  }
})

test("task_update needs no evidence to re-save an already-`done` card", async () => {
  const root = await mkTempDeskRoot()
  await task_create({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", title: "T", status: "done" },
  })

  const result = await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", body_append: "A later note." },
  })
  assert.equal(result.status, "updated")
  const { data } = await readFront(path.join(root, "t", "book-flights", "task.md"))
  assert.equal(Object.hasOwn(data, "evidence"), false, "re-saving an already-done card writes no evidence field")
})

// ── M4-6 Part 2: stage + commit ─────────────────────────────────────────────

test("task_update stages and commits exactly the task.md it updated", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })

  const result = await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", frontmatter: { status: "processing" } },
    schedulePush: () => {},
  })

  assert.equal(result.status, "updated")
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "task_update: t/book-flights")
  assert.deepEqual(lastCommitFiles(root), [path.join("t", "book-flights", "task.md")])
})

test("task_update calls schedulePush exactly once with { root: deskRoot } on a successful commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })

  const calls = []
  const result = await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", frontmatter: { status: "processing" } },
    schedulePush: (opts) => calls.push(opts),
  })

  assert.equal(result.status, "updated")
  assert.deepEqual(calls, [{ root }], "schedulePush is called exactly once, with the desk root")
})

test("task_update commits only its own file, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })

  // Simulates another process staging an unrelated path in the window
  // between task_update's dirty check and its own stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", frontmatter: { status: "processing" } },
    schedulePush: () => {},
  })

  assert.equal(result.commit, undefined, "task_update's own commit succeeded")
  assert.deepEqual(lastCommitFiles(root), [path.join("t", "book-flights", "task.md")])
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

test("task_update reports a commit failure without losing the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }

  const calls = []
  const result = await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", frontmatter: { status: "processing" } },
    spawnGit,
    schedulePush: (opts) => calls.push(opts),
  })

  assert.equal(result.status, "updated", "the write itself is never lost to a commit failure")
  const { data } = await readFront(path.join(root, "t", "book-flights", "task.md"))
  assert.equal(data.status, "processing")
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
  assert.equal(calls.length, 0, "schedulePush is never called when the commit fails")
})

test("task_update skips staging and committing when the file held unstaged changes before the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })
  const filePath = path.join(root, "t", "book-flights", "task.md")

  // Another session's unstaged edit to this same file, in place before
  // task_update writes.
  await fs.appendFile(filePath, "\nanother session's note\n")

  const calls = []
  const result = await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", frontmatter: { status: "processing" } },
    schedulePush: (opts) => calls.push(opts),
  })

  assert.equal(result.status, "updated", "the write always happens")
  assert.equal(result.commit, undefined, "no commit attempted when the file was already dirty")
  const { data } = await readFront(filePath)
  assert.equal(data.status, "processing")
  assert.match(gitStatus(root), /t\/book-flights\/task\.md/, "the file is left as an uncommitted change")
  assert.equal(calls.length, 0, "schedulePush is never called when staging was skipped for a pre-existing dirty file")
})

// A real `.git/index.lock`, held the way a concurrent Git command (or a
// crashed one) would hold it, must fail `git add` for real, not through a
// mocked `spawnGit` — proving the fix against genuine git behavior
// (independent review, fix round).
test("task_update reports a real staging failure without losing the write, when .git/index.lock is genuinely held", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T" }, schedulePush: () => {} })

  const lockPath = path.join(root, ".git", "index.lock")
  await fs.writeFile(lockPath, "")
  try {
    const result = await task_update({
      deskRoot: root,
      input: { track: "t", slug: "book-flights", frontmatter: { status: "processing" } },
    })

    assert.equal(result.status, "updated", "the write itself is never lost to a genuinely held lock")
    const { data } = await readFront(path.join(root, "t", "book-flights", "task.md"))
    assert.equal(data.status, "processing", "the frontmatter merge is on disk despite the lock")
    assert.equal(result.commit.status, "failed", "a real `git add` failure is reported, not swallowed as a silent success")
    assert.match(result.commit.reason, /index\.lock/)
  } finally {
    await fs.rm(lockPath, { force: true })
  }
})

test("task_update rejects a frontmatter status outside the eight states and leaves the card alone", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "guard-status", title: "T" } })
  const file = path.join(root, "t", "guard-status", "task.md")
  const before = await fs.readFile(file, "utf8")
  for (const status of ["IN_PROGRESS", "needs_review", "Active", null, 7]) {
    await assert.rejects(
      task_update({ deskRoot: root, input: { track: "t", slug: "guard-status", frontmatter: { status } } }),
      (error) => /^task_update: invalid status /.test(error.message) && error.message.includes(JSON.stringify(status)) && /drafting, processing, validating, collaborating, paused, blocked, done, cancelled/.test(error.message),
    )
  }
  assert.equal(await fs.readFile(file, "utf8"), before)
})

test("task_update validates status only when the key is present", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "keep-status", title: "T" } })
  await task_update({ deskRoot: root, input: { track: "t", slug: "keep-status", frontmatter: { category: "general" } } })
  await task_update({ deskRoot: root, input: { track: "t", slug: "keep-status" } })
  await task_update({ deskRoot: root, input: { track: "t", slug: "keep-status", frontmatter: { status: "processing" } } })
  assert.equal((await readFront(path.join(root, "t", "keep-status", "task.md"))).data.status, "processing")
})
