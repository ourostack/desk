// organizationFindings — read-only organization checks over a desk subtree.
//
// M4-3 ruling: the doctor reports organization problems in the caller's own
// desk subtree; tidying is a later task, so this module and its tests only
// ever read a fixture desk, never mutate one.

import { test, after } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import matter from "gray-matter"
import { organizationFindings } from "../../src/desk/organization.js"

const tempRoots = new Set()
after(() => Promise.all([...tempRoots].map((root) => fs.rm(root, { recursive: true, force: true }))))

async function mkTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desk-organization-test-"))
  tempRoots.add(root)
  return root
}

async function writeCard(root, relPath, data, body = "") {
  const filePath = path.join(root, relPath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, matter.stringify(body, data), "utf8")
}

async function writeFile(root, relPath, content = "") {
  const filePath = path.join(root, relPath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, "utf8")
}

const NOW = Date.parse("2026-09-25T00:00:00Z")
const RECENT = "2026-09-20T00:00:00Z"
const STALE = "2026-08-01T00:00:00Z" // 55 days before NOW

function findByCode(findings, code) {
  return findings.filter((f) => f.code === code)
}

// ── Clean fixture ────────────────────────────────────────────────────────

test("organizationFindings reports nothing for a well-formed desk", async () => {
  const root = await mkTempRoot()
  await writeCard(
    root,
    "billing-disputes/track.md",
    { schema_version: 1, title: "billing-disputes", status: "active", scope: "billing disputes; not payroll" },
  )
  await writeCard(root, "billing-disputes/refund-flow-cleanup/task.md", {
    schema_version: 1,
    title: "refund-flow-cleanup",
    status: "processing",
    created: RECENT,
    updated: RECENT,
    track: "billing-disputes",
  })
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })

  const findings = organizationFindings(root, { now: NOW })
  assert.deepEqual(findings, [])
})

test("organizationFindings tolerates a desk root that does not exist yet", async () => {
  const root = await mkTempRoot()
  const findings = organizationFindings(path.join(root, "nope"), { now: NOW })
  assert.deepEqual(findings, [])
})

// ── One-of-each fixture ──────────────────────────────────────────────────

async function buildOneOfEachFixture() {
  const root = await mkTempRoot()

  // track_missing_scope: valid name, valid tasks, but no `scope` in track.md.
  await writeCard(root, "no-scope-track/track.md", {
    schema_version: 1,
    title: "no-scope-track",
    status: "active",
  })
  await writeCard(root, "no-scope-track/keep-things-tidy/task.md", {
    schema_version: 1,
    title: "keep-things-tidy",
    status: "processing",
    created: RECENT,
    updated: RECENT,
    track: "no-scope-track",
  })

  // track_person_name: track named after an operator alias.
  await writeCard(root, "ari-mendelow/track.md", {
    schema_version: 1,
    title: "ari-mendelow",
    status: "active",
    scope: "a track that should not be named after a person; not anything else",
  })
  await writeCard(root, "ari-mendelow/some-real-outcome/task.md", {
    schema_version: 1,
    title: "some-real-outcome",
    status: "processing",
    created: RECENT,
    updated: RECENT,
    track: "ari-mendelow",
  })

  // track_catch_all: track named a catch-all.
  await writeCard(root, "inbox/track.md", {
    schema_version: 1,
    title: "inbox",
    status: "active",
    scope: "a catch-all track; not a real outcome",
  })
  await writeCard(root, "inbox/some-real-outcome/task.md", {
    schema_version: 1,
    title: "some-real-outcome",
    status: "processing",
    created: RECENT,
    updated: RECENT,
    track: "inbox",
  })

  // track_empty: valid track, no live or archived tasks.
  await writeCard(root, "no-tasks-yet/track.md", {
    schema_version: 1,
    title: "no-tasks-yet",
    status: "active",
    scope: "an outcome that has no tasks filed under it yet; not anything else",
  })

  // A normal, well-formed track to hold the task-level findings.
  await writeCard(root, "normal-track/track.md", {
    schema_version: 1,
    title: "normal-track",
    status: "active",
    scope: "a normal track holding the task-level findings; not anything else",
  })

  // name_prompt_like: task slug starts with a greeting.
  await writeCard(root, "normal-track/hi-please-fix-this/task.md", {
    schema_version: 1,
    title: "hi-please-fix-this",
    status: "processing",
    created: RECENT,
    updated: RECENT,
    track: "normal-track",
  })

  // name_credential_like: task slug carries a secret-shaped token.
  await writeCard(root, "normal-track/rotate-a1b2c3d4e5f6a7b8c9d0/task.md", {
    schema_version: 1,
    title: "rotate-a1b2c3d4e5f6a7b8c9d0",
    status: "processing",
    created: RECENT,
    updated: RECENT,
    track: "normal-track",
  })

  // name_shape: task slug is a single word.
  await writeCard(root, "normal-track/oneword/task.md", {
    schema_version: 1,
    title: "oneword",
    status: "processing",
    created: RECENT,
    updated: RECENT,
    track: "normal-track",
  })

  // stale_task: non-terminal, `updated` more than 30 days old.
  await writeCard(root, "normal-track/aging-cleanup-effort/task.md", {
    schema_version: 1,
    title: "aging-cleanup-effort",
    status: "processing",
    created: STALE,
    updated: STALE,
    track: "normal-track",
  })

  // A terminal task with the same old `updated` — must NOT be stale_task.
  await writeCard(root, "normal-track/finished-long-ago/task.md", {
    schema_version: 1,
    title: "finished-long-ago",
    status: "done",
    created: STALE,
    updated: STALE,
    track: "normal-track",
  })

  // duplicate_job: two live task cards reference the same PR URL — one in
  // frontmatter `artifacts`, the other in the body's first lines.
  await writeCard(
    root,
    "normal-track/ship-the-refactor/task.md",
    {
      schema_version: 1,
      title: "ship-the-refactor",
      status: "validating",
      created: RECENT,
      updated: RECENT,
      track: "normal-track",
      artifacts: ["https://github.com/ourostack/desk/pull/4242"],
    },
  )
  await writeCard(
    root,
    "normal-track/land-the-same-refactor/task.md",
    {
      schema_version: 1,
      title: "land-the-same-refactor",
      status: "validating",
      created: RECENT,
      updated: RECENT,
      track: "normal-track",
    },
    "Delivery ref: https://github.com/ourostack/desk/pull/4242\n",
  )

  // loose_file at desk root and at a track root.
  await writeFile(root, "scratch-notes.txt", "stray notes\n")
  await writeFile(root, "normal-track/stray-draft.md", "not a task card\n")

  // Allowed desk-root loose entries — must never be reported.
  await writeFile(root, "AGENTS.md", "# Agents\n")
  await writeFile(root, "README.md", "# Readme\n")
  await writeFile(root, ".gitignore", "*.log\n")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })

  return root
}

test("organizationFindings surfaces one of each finding code from a messy fixture desk", async () => {
  const root = await buildOneOfEachFixture()
  const findings = organizationFindings(root, {
    now: NOW,
    operatorNames: ["ari-mendelow"],
  })

  const codes = new Set(findings.map((f) => f.code))
  for (const expected of [
    "track_missing_scope",
    "track_person_name",
    "track_catch_all",
    "track_empty",
    "name_prompt_like",
    "name_credential_like",
    "name_shape",
    "loose_file",
    "duplicate_job",
    "stale_task",
  ]) {
    assert.ok(codes.has(expected), `expected a ${expected} finding, got codes: ${[...codes].join(", ")}`)
  }

  for (const finding of findings) {
    assert.equal(typeof finding.code, "string")
    assert.equal(typeof finding.path, "string")
    assert.equal(typeof finding.hint, "string")
    assert.ok(finding.hint.length > 0)
  }
})

test("track_missing_scope points at the track.md that lacks a scope line", async () => {
  const root = await buildOneOfEachFixture()
  const findings = organizationFindings(root, { now: NOW, operatorNames: ["ari-mendelow"] })
  const [finding] = findByCode(findings, "track_missing_scope")
  assert.equal(finding.path, "no-scope-track/track.md")
})

test("track_person_name flags a track named after a known operator alias", async () => {
  const root = await buildOneOfEachFixture()
  const findings = organizationFindings(root, { now: NOW, operatorNames: ["ari-mendelow"] })
  const [finding] = findByCode(findings, "track_person_name")
  assert.equal(finding.path, "ari-mendelow")
})

test("track_catch_all flags a catch-all track name", async () => {
  const root = await buildOneOfEachFixture()
  const findings = organizationFindings(root, { now: NOW, operatorNames: ["ari-mendelow"] })
  const [finding] = findByCode(findings, "track_catch_all")
  assert.equal(finding.path, "inbox")
})

test("track_empty flags a track with no live or archived tasks", async () => {
  const root = await buildOneOfEachFixture()
  const findings = organizationFindings(root, { now: NOW, operatorNames: ["ari-mendelow"] })
  const [finding] = findByCode(findings, "track_empty")
  assert.equal(finding.path, "no-tasks-yet")
})

test("name_credential_like redacts the offending segment instead of echoing it", async () => {
  const root = await buildOneOfEachFixture()
  const findings = organizationFindings(root, { now: NOW, operatorNames: ["ari-mendelow"] })
  const [finding] = findByCode(findings, "name_credential_like")
  assert.equal(finding.path, "normal-track/<redacted segment>")
  assert.doesNotMatch(finding.path, /a1b2c3d4e5f6a7b8c9d0/)
  assert.doesNotMatch(finding.hint, /a1b2c3d4e5f6a7b8c9d0/)
  for (const f of findings) {
    assert.doesNotMatch(f.path, /a1b2c3d4e5f6a7b8c9d0/)
    assert.doesNotMatch(f.hint, /a1b2c3d4e5f6a7b8c9d0/)
  }
})

test("name_prompt_like and name_shape point at the offending task directory", async () => {
  const root = await buildOneOfEachFixture()
  const findings = organizationFindings(root, { now: NOW, operatorNames: ["ari-mendelow"] })
  assert.ok(findByCode(findings, "name_prompt_like").some((f) => f.path === "normal-track/hi-please-fix-this"))
  assert.ok(findByCode(findings, "name_shape").some((f) => f.path === "normal-track/oneword"))
})

test("stale_task flags only the non-terminal aging task, never the terminal one", async () => {
  const root = await buildOneOfEachFixture()
  const findings = organizationFindings(root, { now: NOW, operatorNames: ["ari-mendelow"] })
  const stale = findByCode(findings, "stale_task")
  assert.ok(stale.some((f) => f.path === "normal-track/aging-cleanup-effort/task.md"))
  assert.ok(!stale.some((f) => f.path === "normal-track/finished-long-ago/task.md"))
})

test("duplicate_job flags both cards that share a pull request URL", async () => {
  const root = await buildOneOfEachFixture()
  const findings = organizationFindings(root, { now: NOW, operatorNames: ["ari-mendelow"] })
  const dup = findByCode(findings, "duplicate_job")
  const paths = dup.map((f) => f.path).sort()
  assert.deepEqual(paths, [
    "normal-track/land-the-same-refactor/task.md",
    "normal-track/ship-the-refactor/task.md",
  ])
})

test("loose_file flags both a desk-root stray file and a track-root stray file", async () => {
  const root = await buildOneOfEachFixture()
  const findings = organizationFindings(root, { now: NOW, operatorNames: ["ari-mendelow"] })
  const loose = findByCode(findings, "loose_file").map((f) => f.path)
  assert.ok(loose.includes("scratch-notes.txt"))
  assert.ok(loose.includes("normal-track/stray-draft.md"))
})

test("loose_file never flags the desk-root allow-list", async () => {
  const root = await buildOneOfEachFixture()
  const findings = organizationFindings(root, { now: NOW, operatorNames: ["ari-mendelow"] })
  const loose = findByCode(findings, "loose_file").map((f) => f.path)
  assert.ok(!loose.includes("AGENTS.md"))
  assert.ok(!loose.includes("README.md"))
  assert.ok(!loose.includes(".gitignore"))
})

// ── Crew isolation ───────────────────────────────────────────────────────

test("organizationFindings never reports a peer's messy desk in a crew workspace", async () => {
  const root = await mkTempRoot()

  // Alice: messy — catch-all track name, no scope.
  await writeCard(root, "desks/alice/inbox/track.md", {
    schema_version: 1,
    title: "inbox",
    status: "active",
  })
  await writeFile(root, "desks/alice/stray.txt", "loose\n")

  // Bob: clean.
  await writeCard(root, "desks/bob/billing-disputes/track.md", {
    schema_version: 1,
    title: "billing-disputes",
    status: "active",
    scope: "billing disputes and refund flows; not payroll",
  })
  await writeCard(root, "desks/bob/billing-disputes/refund-flow-cleanup/task.md", {
    schema_version: 1,
    title: "refund-flow-cleanup",
    status: "processing",
    created: RECENT,
    updated: RECENT,
    track: "billing-disputes",
  })

  const bobFindings = organizationFindings(root, {
    now: NOW,
    personPrefix: path.join(root, "desks", "bob"),
  })
  assert.deepEqual(bobFindings, [])

  const aliceFindings = organizationFindings(root, {
    now: NOW,
    personPrefix: path.join(root, "desks", "alice"),
  })
  assert.ok(aliceFindings.some((f) => f.code === "track_catch_all"))
  assert.ok(aliceFindings.some((f) => f.code === "loose_file"))
  // Alice's scan must never mention Bob's paths.
  assert.ok(!aliceFindings.some((f) => f.path.includes("bob")))
})

test("organizationFindings never recurses into a nested desks/ container", async () => {
  const root = await mkTempRoot()
  await writeCard(root, "desks/carol/track.md", {
    schema_version: 1,
    title: "carol",
    status: "active",
  })
  const findings = organizationFindings(root, { now: NOW })
  assert.ok(!findings.some((f) => f.path.startsWith("desks/")))
})

// ── Defaults and remaining edge cases ───────────────────────────────────

test("organizationFindings defaults now/personPrefix/operatorNames when called with no options at all", async () => {
  const root = await mkTempRoot()
  const findings = organizationFindings(root)
  assert.deepEqual(findings, [])
})

async function buildEdgeCaseFixture() {
  const root = await mkTempRoot()

  // A directory at the desk root with no track.md — loose_file (directory).
  await writeFile(root, "not-a-track/notes.txt", "just a folder\n")

  // A dangling symlink at the desk root — neither a file nor a directory.
  await fs.symlink("/does/not/exist", path.join(root, "broken-desk-link"))

  await writeCard(root, "edge-case-track/track.md", {
    schema_version: 1,
    title: "edge-case-track",
    status: "active",
    scope: "exercises the remaining organization branches; not anything else",
  })

  // A dotfile at a track root — allowed, never loose_file.
  await writeFile(root, "edge-case-track/.taskkeep", "")

  // A directory at a track root with no task.md — loose_file (directory).
  await writeFile(root, "edge-case-track/not-a-task/notes.txt", "just a folder\n")

  // An underscore folder at a track root that isn't _archive — allowed, skipped.
  await writeFile(root, "edge-case-track/_planning/notes.md", "cross-repo plan\n")

  // A dangling symlink at a track root.
  await fs.symlink("/does/not/exist", path.join(root, "edge-case-track", "broken-track-link"))

  // _archive/ holding: a real archived task, a stray file (not a directory),
  // and an archived-looking directory with no task.md.
  await writeCard(root, "edge-case-track/_archive/retired-outcome/task.md", {
    schema_version: 1,
    title: "retired-outcome",
    status: "done",
    created: STALE,
    updated: STALE,
    track: "edge-case-track",
  })
  await writeFile(root, "edge-case-track/_archive/README.md", "not a task\n")
  await fs.mkdir(path.join(root, "edge-case-track", "_archive", "empty-archived-dir"), { recursive: true })

  // A non-terminal task with no `updated` at all — the type guard must skip it.
  await writeCard(root, "edge-case-track/no-updated-field/task.md", {
    schema_version: 1,
    title: "no-updated-field",
    status: "processing",
    created: RECENT,
    track: "edge-case-track",
  })

  // A non-terminal task whose `updated` doesn't parse as a date.
  await writeCard(root, "edge-case-track/bad-updated-date/task.md", {
    schema_version: 1,
    title: "bad-updated-date",
    status: "processing",
    created: RECENT,
    updated: "not-a-real-date",
    track: "edge-case-track",
  })

  // A live task whose PR URL nobody else references.
  await writeCard(root, "edge-case-track/lonely-pr-reference/task.md", {
    schema_version: 1,
    title: "lonely-pr-reference",
    status: "validating",
    created: RECENT,
    updated: RECENT,
    track: "edge-case-track",
    artifacts: ["https://github.com/ourostack/desk/pull/1"],
  })

  // A live task whose task.md exists but can't be read.
  await writeCard(root, "edge-case-track/unreadable-task/task.md", {
    schema_version: 1,
    title: "unreadable-task",
    status: "processing",
    created: RECENT,
    updated: RECENT,
    track: "edge-case-track",
  })
  await fs.chmod(path.join(root, "edge-case-track", "unreadable-task", "task.md"), 0o000)

  // A track with only an archived task (no live tasks) — must NOT be track_empty.
  await writeCard(root, "archive-only-track/track.md", {
    schema_version: 1,
    title: "archive-only-track",
    status: "active",
    scope: "holds only an archived task; not anything else",
  })
  await writeCard(root, "archive-only-track/_archive/done-long-ago/task.md", {
    schema_version: 1,
    title: "done-long-ago",
    status: "done",
    created: STALE,
    updated: STALE,
    track: "archive-only-track",
  })

  // A track whose track.md exists but can't be read.
  await writeCard(root, "unreadable-track/track.md", {
    schema_version: 1,
    title: "unreadable-track",
    status: "active",
    scope: "will be made unreadable; not anything else",
  })
  await fs.chmod(path.join(root, "unreadable-track", "track.md"), 0o000)

  return root
}

test("organizationFindings tolerates dangling symlinks, unreadable cards, and empty archive entries", async () => {
  const root = await buildEdgeCaseFixture()
  const findings = organizationFindings(root, { now: NOW })

  const loose = findByCode(findings, "loose_file").map((f) => f.path)
  assert.ok(loose.includes("not-a-track"))
  assert.ok(loose.includes("edge-case-track/not-a-task"))
  assert.ok(!loose.includes("edge-case-track/_planning"))
  assert.ok(!loose.includes("edge-case-track/.taskkeep"))
  assert.ok(!loose.some((p) => p.includes("broken-desk-link") || p.includes("broken-track-link")))

  // The archived task under edge-case-track is real and done — no stale_task.
  assert.ok(!findByCode(findings, "stale_task").some((f) => f.path.includes("retired-outcome")))

  // The type-guard and unparsable-date tasks never produce stale_task.
  assert.ok(!findByCode(findings, "stale_task").some((f) => f.path.includes("no-updated-field")))
  assert.ok(!findByCode(findings, "stale_task").some((f) => f.path.includes("bad-updated-date")))

  // A PR URL referenced by only one card is never duplicate_job.
  assert.ok(!findByCode(findings, "duplicate_job").some((f) => f.path.includes("lonely-pr-reference")))

  // An archive-only track is not empty; the unreadable track (no tasks at
  // all) legitimately is.
  const emptyTracks = findByCode(findings, "track_empty").map((f) => f.path)
  assert.ok(!emptyTracks.includes("archive-only-track"))
  assert.ok(emptyTracks.includes("unreadable-track"))

  // Every finding is still well-formed even with an unreadable card in the mix.
  for (const finding of findings) {
    assert.equal(typeof finding.code, "string")
    assert.equal(typeof finding.path, "string")
    assert.equal(typeof finding.hint, "string")
  }
})
