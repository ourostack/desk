// task_update — frontmatter merge, body append, preservation of
// schema_version + created, refusal on missing task.

import { test, mock } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import { spawnSync } from "node:child_process"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { writeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { factoryStateRoot } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
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

// ---- boot-acceptance leftovers: an unknown top-level field is never dropped in silence ----

test("task_update accepts a top-level `status` as an alias for `frontmatter.status`", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "alias-status", title: "T" } })
  const filePath = path.join(root, "t", "alias-status", "task.md")
  await task_update({ deskRoot: root, input: { track: "t", slug: "alias-status", status: "processing" } })
  assert.equal((await readFront(filePath)).data.status, "processing")
  // Merged with other frontmatter fields rather than replacing them.
  await task_update({ deskRoot: root, input: { track: "t", slug: "alias-status", status: "validating", frontmatter: { category: "general" } } })
  const front = (await readFront(filePath)).data
  assert.equal(front.status, "validating")
  assert.equal(front.category, "general")
  // The same status in both places is fine; a different one is refused before the card is touched.
  await task_update({ deskRoot: root, input: { track: "t", slug: "alias-status", status: "paused", frontmatter: { status: "paused" } } })
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "alias-status", status: "blocked", frontmatter: { status: "paused" } } }), /`status` and `frontmatter.status` disagree/)
  assert.equal((await readFront(filePath)).data.status, "paused")
})

test("task_update treats `frontmatter.next_step` (and its other spellings) as the top-level `next_step`: it writes the body paragraph, leaves no dead key, and echoes the step", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "alias-step", title: "T", body: "Intro\n\n**Next step:** old step\n" } })
  const filePath = path.join(root, "t", "alias-step", "task.md")
  for (const [key, step] of [["next_step", "one"], ["next step", "two"], ["next-step", "three"], ["nextStep", "four"]]) {
    const result = await task_update({ deskRoot: root, input: { track: "t", slug: "alias-step", frontmatter: { [key]: step, category: "general" } } })
    assert.equal(result.next_step, step)
    const card = await readFront(filePath)
    assert.match(card.content, new RegExp(`\\*\\*Next step:\\*\\* ${step}`))
    assert.equal(Object.keys(card.data).some((name) => /next/i.test(name)), false, key)
    assert.equal(card.data.category, "general")
  }
  // The same step in both places is fine; a different one is refused before the card is touched.
  await task_update({ deskRoot: root, input: { track: "t", slug: "alias-step", next_step: "five", frontmatter: { next_step: "five" } } })
  const before = await fs.readFile(filePath, "utf8")
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "alias-step", next_step: "six", frontmatter: { next_step: "five" } } }), /`next_step` and `frontmatter.next_step` disagree/)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "alias-step", frontmatter: { next_step: "six", nextStep: "seven" } } }), /`frontmatter.next_step` and `frontmatter.nextStep` disagree/)
  assert.equal(await fs.readFile(filePath, "utf8"), before)
  // An empty step is refused as the top-level one is.
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "alias-step", frontmatter: { next_step: " " } } }), /`frontmatter.next_step` must be a non-empty string/)
  // A top-level next_step alone echoes the step too, and the frontmatter may be absent.
  assert.equal((await task_update({ deskRoot: root, input: { track: "t", slug: "alias-step", next_step: "eight" } })).next_step, "eight")
})

test("task_update matches next-step keys loosely, compares trimmed values, and names `frontmatter.<key>` when the bad value came through the alias", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "loose", title: "T", body: "**Next step:** old\n" } })
  const filePath = path.join(root, "t", "loose", "task.md")
  for (const [key, step] of [["Next step", "a"], ["NEXT_STEP", "b"], ["next", "c"], ["Next Action", "d"], ["nextaction", "e"]]) {
    assert.equal((await task_update({ deskRoot: root, input: { track: "t", slug: "loose", frontmatter: { [key]: step } } })).next_step, step, key)
  }
  assert.equal(Object.keys((await readFront(filePath)).data).some((name) => /^next/i.test(name)), false)
  // Trimmed values agree.
  assert.equal((await task_update({ deskRoot: root, input: { track: "t", slug: "loose", next_step: " f ", frontmatter: { next: "f" } } })).next_step, "f")
  const before = await fs.readFile(filePath, "utf8")
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "loose", frontmatter: { next_steps: ["x", "y"] } } }), /`frontmatter.next_steps` must be a non-empty string/)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "loose", frontmatter: { "Next step": "  " } } }), /`frontmatter.Next step` must be a non-empty string/)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "loose", next_step: ["x"], frontmatter: { next: "x" } } }), /`next_step` and `frontmatter.next` disagree/)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "loose", next_step: "g", frontmatter: { next: "h" } } }), /disagree/)
  assert.equal(await fs.readFile(filePath, "utf8"), before)
})

test("task_update refuses the whole blocker family and reports other next/block/wait keys it wrote but Desk never reads", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "family", title: "T" } })
  const filePath = path.join(root, "t", "family", "task.md")
  const before = await fs.readFile(filePath, "utf8")
  for (const key of ["blocker", "Blockers", "blocked", "blocked_by", "Blocked-On", "waiting on", "waitingOn"]) {
    await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "family", frontmatter: { [key]: ["x"] } } }), new RegExp(`\\\`frontmatter.${key}\\\` is not read[^]*\\\`body_append\\\``), key)
  }
  assert.equal(await fs.readFile(filePath, "utf8"), before)
  const plain = await task_update({ deskRoot: root, input: { track: "t", slug: "family", frontmatter: { category: "general", flavor: "x" } } })
  assert.equal(Object.hasOwn(plain, "ignored_frontmatter_keys"), false)
  const odd = await task_update({ deskRoot: root, input: { track: "t", slug: "family", frontmatter: { next_review: "soon", Blockage: "y", waits: "z", category: "c" } } })
  assert.deepEqual(odd.ignored_frontmatter_keys, ["next_review", "Blockage", "waits"])
  assert.equal((await readFront(filePath)).data.next_review, "soon")
})

test("task_update refuses `frontmatter.blocker`, which Desk would never read, and changes nothing", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "alias-blocker", title: "T" } })
  const filePath = path.join(root, "t", "alias-blocker", "task.md")
  const before = await fs.readFile(filePath, "utf8")
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "alias-blocker", frontmatter: { blocker: "waiting on keys" } } }), /`frontmatter.blocker` is not read[^]*`body_append`/)
  assert.equal(await fs.readFile(filePath, "utf8"), before)
})

test("task_update through the alias still refuses a bad status and still gates `done` on evidence", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "alias-gate", title: "T" } })
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "alias-gate", status: "finished" } }), /set in `status` or `frontmatter.status`/)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "alias-gate", status: "done" } }), /needs evidence/)
  assert.notEqual((await readFront(path.join(root, "t", "alias-gate", "task.md"))).data.status, "done")
})

test("task_update refuses an unknown top-level field, naming it and the accepted fields, and changes nothing", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "unknown-field", title: "T" } })
  const filePath = path.join(root, "t", "unknown-field", "task.md")
  const before = await fs.readFile(filePath, "utf8")
  await assert.rejects(
    task_update({ deskRoot: root, input: { track: "t", slug: "unknown-field", status: "processing", owner: "me", priority: 1 } }),
    (error) => /unknown fields `owner`, `priority`; nothing was changed/.test(error.message) && /Accepted fields: `track`, `slug`, `status`, `frontmatter`/.test(error.message) && /Example: \{"track": "t", "slug": "s", "status": "validating", "note"/.test(error.message) && !/`status`, `owner`/.test(error.message),
  )
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "unknown-field", owner: "me" } }), /unknown field `owner`;/)
  assert.equal(await fs.readFile(filePath, "utf8"), before)
})

// ── the delivery record and the sign-off packet ─────────────────────────────

const PR_EVIDENCE = { kind: "pr", ref: "https://github.com/example-org/example-repo/pull/7" }
const RECORD_ERROR = /these records are written by the task tools; to record an answer call task_signoff/
const SENTINEL = "SENTINEL-card-body-text"

test("task_update refuses signoff, flow and returns in frontmatter and writes nothing", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "no-forge", title: "T" } })
  const file = path.join(root, "t", "no-forge", "task.md")
  const before = await fs.readFile(file, "utf8")
  for (const key of ["signoff", "flow", "returns"]) {
    await assert.rejects(
      task_update({ deskRoot: root, input: { track: "t", slug: "no-forge", frontmatter: { category: "general", [key]: key === "returns" ? ["x"] : { state: "accepted" } } } }),
      RECORD_ERROR,
    )
  }
  assert.equal(await fs.readFile(file, "utf8"), before)
})

test("a move to done marks the card delivered_unsigned with the delivery time", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "ship-it", title: "T" } })
  const file = path.join(root, "t", "ship-it", "task.md")
  assert.equal((await readFront(file)).data.flow.deliveries, 0)
  await task_update({ deskRoot: root, input: { track: "t", slug: "ship-it", frontmatter: { status: "done" }, evidence: PR_EVIDENCE } })
  const { data } = await readFront(file)
  assert.deepEqual(data.signoff, { state: "delivered_unsigned", at: null, reason: null })
  assert.equal(data.flow.since, "created")
  assert.equal(data.flow.reached, "done")
  assert.equal(data.flow.rev, 1)
  assert.equal(data.flow.deliveries, 1)
  assert.equal(data.flow.delivered_at, data.updated)
  assert.equal(data.flow.first_delivered_at, data.updated)
})

test("a move to done answers with the three-line packet and a note that says not to wait", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "ship-packet", title: "Fix the login page" } })
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "ship-packet", frontmatter: { status: "done" }, evidence: PR_EVIDENCE } })
  assert.equal(result.signoff, "delivered_unsigned")
  assert.deepEqual(result.signoff_packet, ["Asked: Fix the login page", `Delivered: ${PR_EVIDENCE.ref}`, "Accept or send back?"])
  assert.equal(
    result.signoff_note,
    "This task is delivered, not accepted. If the operator is in this conversation, end your reply with the three lines; do not wait for the answer and do not ask again in this session. When they answer, call task_signoff in that later turn. A subagent never calls task_signoff.",
  )
})

test("the packet carries the card title and the evidence ref and nothing from the card body", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "packet-clean", title: "Plain title", body: `## Goal\n\n${SENTINEL}\n` } })
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "packet-clean", frontmatter: { status: "done" }, evidence: PR_EVIDENCE, note: SENTINEL } })
  assert.ok(!JSON.stringify(result).includes(SENTINEL))
  assert.equal(result.signoff_packet[0], "Asked: Plain title")
  const card = await fs.readFile(path.join(root, "t", "packet-clean", "task.md"), "utf8")
  assert.ok(!/^(?:signoff|flow):[\s\S]*SENTINEL/mu.test(card.split("\n---")[0]), "nothing from the body is in the record")
})

test("the packet uses the slug when the card has no title", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "untitled-card", title: "Unique title untitled-card" } })
  const file = path.join(root, "t", "untitled-card", "task.md")
  const { data, content } = await readFront(file)
  delete data.title
  await writeMarkdown(file, data, content)
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "untitled-card", frontmatter: { status: "done" }, evidence: PR_EVIDENCE } })
  assert.equal(result.signoff_packet[0], "Asked: untitled-card")
  await task_create({ deskRoot: root, input: { track: "t", slug: "blank-title", title: "Unique title blank-title" } })
  const blank = path.join(root, "t", "blank-title", "task.md")
  const card = await readFront(blank)
  card.data.title = 42
  await writeMarkdown(blank, card.data, card.content)
  const second = await task_update({ deskRoot: root, input: { track: "t", slug: "blank-title", frontmatter: { status: "done" }, evidence: PR_EVIDENCE } })
  assert.equal(second.signoff_packet[0], "Asked: blank-title")
})

test("a failed evidence check writes no signoff", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "no-proof", title: "T" } })
  const file = path.join(root, "t", "no-proof", "task.md")
  const before = await fs.readFile(file, "utf8")
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "no-proof", frontmatter: { status: "done" } } }), /needs evidence/)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "no-proof", frontmatter: { status: "done" }, evidence: { kind: "pr", ref: "nope" } } }), /not a checkable pr reference/)
  assert.equal(await fs.readFile(file, "utf8"), before)
})

test("a legacy card moved to done gets a flow record marked adopted", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "old-card", title: "Unique title old-card" } })
  const file = path.join(root, "t", "old-card", "task.md")
  const card = await readFront(file)
  delete card.data.flow
  await writeMarkdown(file, card.data, card.content)
  await task_update({ deskRoot: root, input: { track: "t", slug: "old-card", frontmatter: { status: "done" }, evidence: PR_EVIDENCE } })
  const { data } = await readFront(file)
  assert.equal(data.flow.since, "adopted")
  assert.equal(data.flow.deliveries, 1)
  assert.equal(data.signoff.state, "delivered_unsigned")
})

test("a status change that is not into done writes no signoff and no packet, and moves the flow's high-water mark", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "stay-open", title: "T" } })
  const file = path.join(root, "t", "stay-open", "task.md")
  const before = (await readFront(file)).data.flow
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "stay-open", frontmatter: { status: "processing" } } })
  assert.equal(result.signoff, undefined)
  assert.equal(result.signoff_packet, undefined)
  assert.equal(result.return_recorded, undefined)
  const { data } = await readFront(file)
  assert.equal(data.signoff, undefined)
  assert.deepEqual(data.flow, { ...before, reached: "processing", rev: before.rev + 1 })
})

test("re-saving an already done card delivers nothing again and keeps the record through a task_update rewrite", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "resave", title: "T" } })
  const file = path.join(root, "t", "resave", "task.md")
  await task_update({ deskRoot: root, input: { track: "t", slug: "resave", frontmatter: { status: "done" }, evidence: PR_EVIDENCE } })
  const first = (await readFront(file)).data
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "resave", note: "later note", frontmatter: { category: "general" } } })
  assert.equal(result.signoff, undefined)
  const { data } = await readFront(file)
  assert.deepEqual(data.signoff, first.signoff)
  assert.deepEqual(data.flow, first.flow)
})

test("a rewrite by task_update keeps a returns list, a signoff and a flow as written", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "keeps-all", title: "Unique title keeps-all" } })
  const file = path.join(root, "t", "keeps-all", "task.md")
  const card = await readFront(file)
  card.data.returns = ["processing, 2026-10-05T10:00:00Z, agent_error"]
  card.data.signoff = { state: "refused", at: "2026-10-05T11:00:00Z", verified: true, reason: "defect" }
  await writeMarkdown(file, card.data, card.content)
  await task_update({ deskRoot: root, input: { track: "t", slug: "keeps-all", frontmatter: { category: "general" } } })
  const { data } = await readFront(file)
  assert.deepEqual(data.returns, ["processing, 2026-10-05T10:00:00Z, agent_error"])
  assert.deepEqual(data.signoff, { state: "refused", at: "2026-10-05T11:00:00Z", verified: true, reason: "defect" })
  assert.equal(data.flow.since, "created")
})

// ── a backwards move needs a reason ─────────────────────────────────────────

const REFUSAL = "task_update: moving this task from validating back to processing is a return and needs a reason. Repeat the call with `return_reason` set to one of agent_error (you got it wrong), changed_ask (the operator changed what they want), new_information (something nobody knew), external (something outside the task broke)."
const finalizeSpy = () => {
  const calls = []
  return { calls, finalize: async (request) => { calls.push(request) } }
}

async function validatingCard(root, slug, extra = {}) {
  await task_create({ deskRoot: root, input: { track: "t", slug, title: `Unique title ${slug}`, status: "validating", body: `${SENTINEL}\n`, ...extra } })
  return path.join(root, "t", slug, "task.md")
}

test("validating to processing without return_reason is refused, names the list, and writes nothing", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const file = await validatingCard(root, "back-no-reason")
  const before = await fs.readFile(file, "utf8")
  const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8" }).stdout
  const spy = finalizeSpy()
  const pushes = []
  await assert.rejects(
    task_update({ deskRoot: root, input: { track: "t", slug: "back-no-reason", frontmatter: { status: "processing" }, note: SENTINEL }, finalize: spy.finalize, schedulePush: (o) => pushes.push(o) }),
    (error) => error.message === REFUSAL && !error.message.includes(SENTINEL),
  )
  assert.equal(await fs.readFile(file, "utf8"), before, "the card bytes are unchanged")
  assert.equal(spy.calls.length, 0, "no finalize request")
  assert.equal(pushes.length, 0)
  assert.equal(spawnSync("git", ["-C", root, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8" }).stdout, head, "no commit")
})

test("the same move with a reason is written and the card gains a returns line", async () => {
  const root = await mkTempDeskRoot()
  const file = await validatingCard(root, "back-with-reason")
  const spy = finalizeSpy()
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "back-with-reason", frontmatter: { status: "processing" }, return_reason: "agent_error" }, finalize: spy.finalize })
  assert.equal(result.return_recorded, "validating to processing, agent_error, caught at_review")
  assert.ok(!JSON.stringify(result).includes(SENTINEL))
  const { data } = await readFront(file)
  assert.equal(data.status, "processing")
  assert.equal(data.returns.length, 1)
  assert.match(data.returns[0], /^\S+ validating processing agent_error at_review$/u)
  assert.equal(data.flow.reached, "processing")
  assert.equal(data.flow.since, "created")
})

test("a return in the task before any review is recorded as caught in the task", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "back-to-drafting", title: "T", status: "processing" } })
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "back-to-drafting", frontmatter: { status: "drafting" }, return_reason: "changed_ask" }, finalize: async () => {} })
  assert.equal(result.return_recorded, "processing to drafting, changed_ask, caught in_task")
})

test("reopening a done task needs a reason and removes its signoff", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "reopen", title: "T" } })
  const file = path.join(root, "t", "reopen", "task.md")
  await task_update({ deskRoot: root, input: { track: "t", slug: "reopen", frontmatter: { status: "done" }, evidence: PR_EVIDENCE } })
  assert.equal((await readFront(file)).data.signoff.state, "delivered_unsigned")
  const before = await fs.readFile(file, "utf8")
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "reopen", frontmatter: { status: "processing" } }, finalize: async () => {} }), /moving this task from done back to processing is a return and needs a reason/)
  assert.equal(await fs.readFile(file, "utf8"), before)
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "reopen", frontmatter: { status: "processing" }, return_reason: "new_information" }, finalize: async () => {} })
  assert.equal(result.return_recorded, "done to processing, new_information, caught after_delivery")
  const { data } = await readFront(file)
  assert.equal(data.signoff, undefined)
  assert.match(data.returns[0], / done processing new_information after_delivery$/u)
  assert.equal(data.flow.reached, "processing")
  assert.equal(data.flow.deliveries, 1, "the delivery count stays")
  assert.equal(data.evidence, undefined, "the proof of a delivery sent back no longer says the task is done")
})

test("the side-state route still needs a reason", async () => {
  const root = await mkTempDeskRoot()
  const file = await validatingCard(root, "side-route")
  const pause = await task_update({ deskRoot: root, input: { track: "t", slug: "side-route", frontmatter: { status: "paused" } }, finalize: async () => {} })
  assert.equal(pause.return_recorded, undefined, "pausing is not a return")
  const before = await fs.readFile(file, "utf8")
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "side-route", frontmatter: { status: "processing" } }, finalize: async () => {} }), /from paused back to processing is a return and needs a reason/)
  assert.equal(await fs.readFile(file, "utf8"), before)
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "side-route", frontmatter: { status: "processing" }, return_reason: "external" }, finalize: async () => {} })
  assert.equal(result.return_recorded, "paused to processing, external, caught at_review")
  const again = await task_update({ deskRoot: root, input: { track: "t", slug: "side-route", frontmatter: { status: "paused" } }, finalize: async () => {} })
  assert.equal(again.return_recorded, undefined)
  const second = await task_update({ deskRoot: root, input: { track: "t", slug: "side-route", frontmatter: { status: "processing" } }, finalize: async () => {} })
  assert.equal(second.return_recorded, undefined, "a return is recorded once: the mark was reset to processing")
  assert.equal((await readFront(file)).data.returns.length, 1)
})

test("the top-level status field is a return too: refused without a reason, recorded with one", async () => {
  const root = await mkTempDeskRoot()
  const file = await validatingCard(root, "alias-return")
  const before = await fs.readFile(file, "utf8")
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "alias-return", status: "processing" }, finalize: async () => {} }), (error) => error.message === REFUSAL)
  assert.equal(await fs.readFile(file, "utf8"), before)
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "alias-return", status: "processing", return_reason: "agent_error" }, finalize: async () => {} })
  assert.equal(result.return_recorded, "validating to processing, agent_error, caught at_review")
  const { data } = await readFront(file)
  assert.equal(data.status, "processing")
  assert.match(data.returns[0], /^\S+ validating processing agent_error at_review$/u)
})

test("a return_reason on a forward move or an unchanged status is refused in one sentence that says to drop it", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "no-spray", title: "T" } })
  const file = path.join(root, "t", "no-spray", "task.md")
  const before = await fs.readFile(file, "utf8")
  const spy = finalizeSpy()
  const dropIt = /^Error: task_update: `return_reason` is only for moving a task back; this call is not a return, so drop it\.$/u
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "no-spray", frontmatter: { status: "processing" }, return_reason: "agent_error" }, finalize: spy.finalize }), dropIt)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "no-spray", note: "x", return_reason: "agent_error" }, finalize: spy.finalize }), dropIt)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "no-spray", frontmatter: { status: "processing" }, return_reason: "bogus" }, finalize: spy.finalize }), dropIt)
  assert.equal(await fs.readFile(file, "utf8"), before)
  assert.equal(spy.calls.length, 0)
})

test("an unknown return_reason names the four values and writes nothing", async () => {
  const root = await mkTempDeskRoot()
  const file = await validatingCard(root, "bad-reason")
  const before = await fs.readFile(file, "utf8")
  for (const bad of ["oops", 7, ""]) {
    await assert.rejects(
      task_update({ deskRoot: root, input: { track: "t", slug: "bad-reason", frontmatter: { status: "processing" }, return_reason: bad }, finalize: async () => {} }),
      /^Error: task_update: `return_reason` must be one of agent_error, changed_ask, new_information, external\.$/u,
    )
  }
  assert.equal(await fs.readFile(file, "utf8"), before)
})

test("a pre-existing card with no flow record moving backwards still needs a reason", async () => {
  const root = await mkTempDeskRoot()
  const file = await validatingCard(root, "old-validating")
  const card = await readFront(file)
  delete card.data.flow
  await writeMarkdown(file, card.data, card.content)
  const before = await fs.readFile(file, "utf8")
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "old-validating", frontmatter: { status: "processing" } }, finalize: async () => {} }), /needs a reason/)
  assert.equal(await fs.readFile(file, "utf8"), before)
  await task_update({ deskRoot: root, input: { track: "t", slug: "old-validating", frontmatter: { status: "processing" }, return_reason: "agent_error" }, finalize: async () => {} })
  const { data } = await readFront(file)
  assert.equal(data.flow.since, "adopted")
  assert.equal(data.returns.length, 1)
})

test("a card with an unreadable status moves forward without a record error", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "no-status", title: "Unique title no-status" } })
  const file = path.join(root, "t", "no-status", "task.md")
  const card = await readFront(file)
  delete card.data.status
  await writeMarkdown(file, card.data, card.content)
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "no-status", frontmatter: { status: "processing" } }, finalize: async () => {} })
  assert.equal(result.return_recorded, undefined)
  assert.equal((await readFront(file)).data.flow.reached, "processing")
})

test("a return asks the factory to re-derive the job's sessions", async () => {
  const root = await mkTempDeskRoot()
  await validatingCard(root, "re-derive")
  const spy = finalizeSpy()
  await task_update({ deskRoot: root, input: { track: "t", slug: "re-derive", frontmatter: { status: "processing" }, return_reason: "agent_error" }, finalize: spy.finalize })
  assert.equal(spy.calls.length, 1)
  assert.match(spy.calls[0].identity.job, /^[0-9a-f]+$/u)
  assert.equal(spy.calls[0].identity.track, "t")
  assert.equal(spy.calls[0].identity.slug, "re-derive")
  await task_update({ deskRoot: root, input: { track: "t", slug: "re-derive", note: "plain note" }, finalize: spy.finalize })
  await task_update({ deskRoot: root, input: { track: "t", slug: "re-derive", frontmatter: { status: "validating" } }, finalize: spy.finalize })
  assert.equal(spy.calls.length, 1, "only a recorded return asks")
})

test("done to cancelled is a return and asks the factory once, through the terminal sync", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "done-to-cancelled", title: "T" } })
  await task_update({ deskRoot: root, input: { track: "t", slug: "done-to-cancelled", frontmatter: { status: "done" }, evidence: PR_EVIDENCE } })
  const spy = finalizeSpy()
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "done-to-cancelled", frontmatter: { status: "cancelled" } }, finalize: spy.finalize }), /from done back to cancelled is a return and needs a reason/)
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "done-to-cancelled", frontmatter: { status: "cancelled" }, return_reason: "changed_ask" }, finalize: spy.finalize })
  assert.equal(result.return_recorded, "done to cancelled, changed_ask, caught after_delivery")
  assert.equal(spy.calls.length, 0, "the terminal sync already requested it")
})

test("a move into validating sets the first review point once", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "first-review", title: "T" } })
  const file = path.join(root, "t", "first-review", "task.md")
  assert.equal((await readFront(file)).data.flow.first_validating_at, null)
  await task_update({ deskRoot: root, input: { track: "t", slug: "first-review", frontmatter: { status: "validating" } } })
  const first = (await readFront(file)).data.flow
  assert.equal(first.reached, "validating")
  assert.equal(typeof first.first_validating_at, "string")
  await task_update({ deskRoot: root, input: { track: "t", slug: "first-review", frontmatter: { status: "processing" }, return_reason: "agent_error" }, finalize: async () => {} })
  await task_update({ deskRoot: root, input: { track: "t", slug: "first-review", frontmatter: { status: "validating" } } })
  assert.equal((await readFront(file)).data.flow.first_validating_at, first.first_validating_at, "the first review point stays")
})

test("the return answer and the card line carry codes only, never text from the card", async () => {
  const root = await mkTempDeskRoot()
  const file = await validatingCard(root, "codes-only")
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "codes-only", frontmatter: { status: "processing" }, return_reason: "agent_error", note: SENTINEL }, finalize: async () => {} })
  const raw = await fs.readFile(file, "utf8")
  const frontmatterOnly = raw.split("\n---")[0]
  assert.ok(!frontmatterOnly.includes(SENTINEL))
  assert.ok(!JSON.stringify(result).includes(SENTINEL))
  assert.ok(!JSON.stringify(result).includes(root), "no absolute path in the answer")
})

test("a title with a newline gives a packet of three one-line strings, cut to 120 characters", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "two-line-title", title: "First line\nSecond line that must not split the packet" } })
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "two-line-title", frontmatter: { status: "done" }, evidence: PR_EVIDENCE } })
  assert.deepEqual(result.signoff_packet, ["Asked: First line", `Delivered: ${PR_EVIDENCE.ref}`, "Accept or send back?"])
  assert.ok(result.signoff_packet.every((line) => !line.includes("\n")))
  await task_create({ deskRoot: root, input: { track: "t", slug: "long-title", title: `${"x".repeat(150)}\nmore` } })
  const long = await task_update({ deskRoot: root, input: { track: "t", slug: "long-title", frontmatter: { status: "done" }, evidence: PR_EVIDENCE } })
  assert.equal(long.signoff_packet[0], `Asked: ${"x".repeat(120)}`)
  await task_create({ deskRoot: root, input: { track: "t", slug: "blank-first-line", title: "\n  Real title" } })
  const blankFirst = await task_update({ deskRoot: root, input: { track: "t", slug: "blank-first-line", frontmatter: { status: "done" }, evidence: PR_EVIDENCE } })
  assert.equal(blankFirst.signoff_packet[0], "Asked: Real title")
})

test("a commit that fails after a delivery leaves the status and the record written together", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await task_create({ deskRoot: root, input: { track: "t", slug: "commit-fails", title: "T" }, schedulePush: () => {} })
  const spawnGit = (cmd, args, opts) => (args.includes("commit") ? { status: 1, stdout: "", stderr: "commit boom" } : spawnSync(cmd, args, opts))
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "commit-fails", frontmatter: { status: "done" }, evidence: PR_EVIDENCE }, spawnGit, schedulePush: () => {} })
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
  assert.equal(result.signoff, "delivered_unsigned")
  const { data } = await readFront(path.join(root, "t", "commit-fails", "task.md"))
  assert.equal(data.status, "done")
  assert.equal(data.signoff.state, "delivered_unsigned")
  assert.equal(data.flow.deliveries, 1)
})

test("every side state and back is refused without a reason after review, and one reason records one return", async () => {
  const root = await mkTempDeskRoot()
  for (const side of ["collaborating", "blocked", "cancelled"]) {
    const file = await validatingCard(root, `side-${side}`)
    await task_update({ deskRoot: root, input: { track: "t", slug: `side-${side}`, frontmatter: { status: side } }, finalize: async () => {} })
    const before = await fs.readFile(file, "utf8")
    await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: `side-${side}`, frontmatter: { status: "processing" } }, finalize: async () => {} }), /needs a reason/)
    assert.equal(await fs.readFile(file, "utf8"), before)
    const result = await task_update({ deskRoot: root, input: { track: "t", slug: `side-${side}`, frontmatter: { status: "processing" }, return_reason: "external" }, finalize: async () => {} })
    assert.equal(result.return_recorded, `${side} to processing, external, caught at_review`)
  }
})

test("a recorded return raises rev by one", async () => {
  const root = await mkTempDeskRoot()
  const file = await validatingCard(root, "rev-rises")
  const before = (await readFront(file)).data.flow.rev
  await task_update({ deskRoot: root, input: { track: "t", slug: "rev-rises", frontmatter: { status: "processing" }, return_reason: "agent_error" }, finalize: async () => {} })
  assert.equal((await readFront(file)).data.flow.rev, before + 1)
})

test("a card with an unreadable status is judged from the furthest status it reached", async () => {
  const root = await mkTempDeskRoot()
  const file = await validatingCard(root, "damaged-status")
  const card = await readFront(file)
  card.data.status = "weird"
  await writeMarkdown(file, card.data, card.content)
  const before = await fs.readFile(file, "utf8")
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "damaged-status", frontmatter: { status: "drafting" } }, finalize: async () => {} }), /from validating back to drafting is a return and needs a reason/)
  assert.equal(await fs.readFile(file, "utf8"), before)
})

test("returns_damaged is a record key and cannot be set through frontmatter", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "no-damage", title: "T" } })
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "no-damage", frontmatter: { returns_damaged: 3 } } }), RECORD_ERROR)
})

test("a card with an unreadable status and no flow record is read as moving from drafting", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "damaged-no-flow", title: "Unique title damaged-no-flow" } })
  const file = path.join(root, "t", "damaged-no-flow", "task.md")
  const card = await readFront(file)
  card.data.status = "weird"
  delete card.data.flow
  await writeMarkdown(file, card.data, card.content)
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "damaged-no-flow", frontmatter: { status: "drafting" } }, finalize: async () => {} })
  assert.equal(result.return_recorded, undefined)
})

// The job identity cannot be resolved: the desk's real path fails to resolve inside the job lookup only, with the factory state present so both requests run.
async function withUnresolvableJob(run) {
  const root = await mkTempDeskRoot()
  const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "desk-task-job-null-"))
  const env = { ...process.env, XDG_STATE_HOME: stateHome }
  try {
    await factoryStateRoot(env)
    const real = fs.realpath
    const failing = mock.method(fs, "realpath", async (target, ...rest) => {
      if (target === root && new Error().stack.includes("taskJob")) throw new Error("SENTINEL-realpath-failure")
      return real(target, ...rest)
    })
    try {
      return await run({ root, env })
    } finally {
      failing.mock.restore()
    }
  } finally {
    await fs.rm(stateHome, { recursive: true, force: true })
  }
}

test("a delivery whose job identity cannot be resolved still succeeds, and both requests log their own deferred message", async (t) => {
  await withUnresolvableJob(async ({ root, env }) => {
    await task_create({ deskRoot: root, input: { track: "t", slug: "no-job", title: "Unique title no-job" } })
    const messages = []
    t.mock.method(console, "error", (message) => messages.push(message))
    const result = await task_update({ deskRoot: root, env, input: { track: "t", slug: "no-job", frontmatter: { status: "done" }, evidence: PR_EVIDENCE } })
    assert.equal(result.status, "updated")
    assert.deepEqual(messages, ["desk_factory: finalize_request_deferred", "desk_factory: evaluation_request_deferred"])
    assert.ok(!messages.join("\n").includes("SENTINEL"))
  })
})

test("a return whose job identity cannot be resolved hands the finalize request no identity, and the return is still recorded", async () => {
  await withUnresolvableJob(async ({ root, env }) => {
    await task_create({ deskRoot: root, input: { track: "t", slug: "no-job-return", title: "Unique title no-job-return", status: "validating" } })
    const spy = finalizeSpy()
    const result = await task_update({ deskRoot: root, env, input: { track: "t", slug: "no-job-return", frontmatter: { status: "processing" }, return_reason: "agent_error" }, finalize: spy.finalize })
    assert.equal(result.return_recorded, "validating to processing, agent_error, caught at_review")
    assert.equal(spy.calls.length, 1)
    assert.equal(spy.calls[0].identity, null)
  })
})
