// Gitignore and sensitive-path exclusion before indexing can collect document text.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { closeDb, openDb } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { discover } from "../../../../../plugins/desk/mcp/src/indexer/discover.js"
import { rebuildIndex } from "../../../../../plugins/desk/mcp/src/indexer/index.js"
import { mkTempRoot } from "../_temp_roots.js"

const SENSITIVE_ACTIVE_PATHS = Object.freeze([
  "trackA/secrets/task.md",
  "trackA/credentials/task.md",
  "trackA/private/task.md",
  "trackA/api-keys/task.md",
])
const SENSITIVE_ARCHIVED_PATHS = Object.freeze([
  "trackA/_archive/secrets/old-note.md",
  "trackA/_archive/credentials/old-note.md",
  "trackA/_archive/2026-01-private-key-rotation.md",
  "trackA/_archive/2026-01-credential-note.md",
])

async function tmpRoot(prefix = "desk-exclusions-") {
  return mkTempRoot(prefix)
}

async function writeFile(root, rel, body) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
}

function publicErrorShape(value, seen = new Set()) {
  if (value == null || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  seen.add(value)

  if (value instanceof Error) {
    const shape = { message: value.message }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === "stack" || key === "message") continue
      shape[key] = publicErrorShape(value[key], seen)
    }
    return shape
  }

  if (Array.isArray(value)) {
    return value.map((item) => publicErrorShape(item, seen))
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, publicErrorShape(item, seen)]),
  )
}

function assertPublicErrorDoesNotLeak(error) {
  const serialized = JSON.stringify(publicErrorShape(error))
  assert.doesNotMatch(serialized, /GITIGNORED_SECRET_PAYLOAD|SENSITIVE_PATH_PAYLOAD/u)
  assert.doesNotMatch(serialized, /ignored-track|secrets|credentials|api-keys|private-key/u)
}

async function loadExclusionsModule() {
  return import("../../../../../plugins/desk/mcp/src/indexer/exclusions.js")
}

test("discover excludes gitignored markdown before indexing", async () => {
  const root = await tmpRoot()
  await writeFile(root, ".gitignore", "ignored-track/\nignored-too\n*.pem\n")
  await writeFile(root, "visible-track/task-1/task.md", "# Visible\n\npublic body")
  await writeFile(root, "ignored-track/leaked-task/task.md", "# Ignored\n\nfixture secret")
  await writeFile(root, "ignored-too/leaked-task/task.md", "# Ignored\n\nfixture secret")
  await writeFile(root, "outer/ignored-track/leaked-task/task.md", "# Ignored\n\nfixture secret")
  await writeFile(root, "outer/ignored-too/leaked-task/task.md", "# Ignored\n\nfixture secret")

  const paths = (await discover(root)).map((doc) => doc.path)

  assert.equal(paths.includes("visible-track/task-1/task.md"), true)
  assert.equal(
    paths.includes("ignored-track/leaked-task/task.md"),
    false,
    "gitignored task.md files must not be discovered",
  )
  assert.equal(
    paths.includes("ignored-too/leaked-task/task.md"),
    false,
    "gitignored bare directory names must exclude descendants",
  )
  assert.equal(
    paths.includes("outer/ignored-track/leaked-task/task.md"),
    false,
    "gitignored directory patterns must exclude nested directory descendants",
  )
  assert.equal(
    paths.includes("outer/ignored-too/leaked-task/task.md"),
    false,
    "gitignored bare directory names must exclude nested directory descendants",
  )
})

test("discover fails closed when root gitignore cannot be read", async () => {
  const root = await tmpRoot()
  await writeFile(root, ".gitignore/rules", "ignored-track/**\n")

  await assert.rejects(
    () => discover(root),
    (error) => {
      assert.equal(error.code, "exclusion_rules_unavailable")
      assert.equal(error.reason, "gitignore_unreadable")
      assertPublicErrorDoesNotLeak(error)
      return true
    },
  )
})

test("loadExclusionRules fails closed on unexpected gitignore filesystem errors", async (t) => {
  const { loadExclusionRules } = await loadExclusionsModule()
  const root = await tmpRoot()

  t.mock.method(fs, "stat", async () => {
    const error = new Error("blocked")
    error.code = "EACCES"
    throw error
  })

  await assert.rejects(
    () => loadExclusionRules({ deskRoot: root }),
    (error) => {
      assert.equal(error.code, "exclusion_rules_unavailable")
      assert.equal(error.reason, "gitignore_unreadable")
      return true
    },
  )
})

test("loadExclusionRules fails closed when gitignore bytes become unreadable", async (t) => {
  const { loadExclusionRules } = await loadExclusionsModule()
  const root = await tmpRoot()
  await writeFile(root, ".gitignore", "ignored-track/**\n")

  t.mock.method(fs, "readFile", async () => {
    const error = new Error("blocked")
    error.code = "EACCES"
    throw error
  })

  await assert.rejects(
    () => loadExclusionRules({ deskRoot: root }),
    (error) => {
      assert.equal(error.code, "exclusion_rules_unavailable")
      assert.equal(error.reason, "gitignore_unreadable")
      return true
    },
  )
})

test("loadExclusionRules surfaces unexpected directory scan errors", async (t) => {
  const { loadExclusionRules } = await loadExclusionsModule()
  const root = await tmpRoot()

  t.mock.method(fs, "readdir", async () => {
    const error = new Error("blocked")
    error.code = "EACCES"
    throw error
  })

  await assert.rejects(
    () => loadExclusionRules({ deskRoot: root }),
    (error) => error.code === "EACCES" && error.message === "blocked",
  )
})

test("discover excludes sensitive active and archived paths", async () => {
  const root = await tmpRoot()
  await writeFile(root, "trackA/task-1/task.md", "# Visible\n\npublic body")
  await writeFile(root, "trackA/_archive/old-note.md", "# Archive\n\npublic history")
  for (const rel of [...SENSITIVE_ACTIVE_PATHS, ...SENSITIVE_ARCHIVED_PATHS]) {
    await writeFile(root, rel, "# Sensitive\n\nfixture secret")
  }

  const paths = (await discover(root)).map((doc) => doc.path)

  assert.equal(paths.includes("trackA/task-1/task.md"), true)
  assert.equal(paths.includes("trackA/_archive/old-note.md"), true)
  for (const rel of SENSITIVE_ACTIVE_PATHS) {
    assert.equal(paths.includes(rel), false, "sensitive active paths must not be discovered")
  }
  for (const rel of SENSITIVE_ARCHIVED_PATHS) {
    assert.equal(
      paths.includes(rel),
      false,
      "sensitive archived paths must remain excluded despite archive indexing",
    )
  }
})

test("discover applies nested gitignore files and negated rules", async () => {
  const root = await tmpRoot()
  await writeFile(
    root,
    ".gitignore",
    "root-ignored/\n/anchored-ignored\n!root-ignored/reincluded/task.md\n!public/task.md\n",
  )
  await writeFile(
    root,
    "trackA/.gitignore",
    "local-ignored/\n!local-ignored/reincluded/task.md\n",
  )
  await writeFile(root, "trackA/visible/task.md", "# Visible\n\npublic body")
  await writeFile(root, "root-ignored/private/task.md", "# Root ignored\n\nfixture secret")
  await writeFile(root, "anchored-ignored/leaked/task.md", "# Anchored ignored\n\nfixture secret")
  await writeFile(root, "root-ignored/reincluded/task.md", "# Root reinclude\n\npublic body")
  await writeFile(root, "public/task.md", "# Public\n\npublic body")
  await writeFile(root, "trackA/local-ignored/private/task.md", "# Local ignored\n\nfixture secret")
  await writeFile(root, "trackA/local-ignored/reincluded/task.md", "# Local reinclude\n\npublic body")

  const paths = (await discover(root)).map((doc) => doc.path)

  assert.equal(paths.includes("trackA/visible/task.md"), true)
  assert.equal(paths.includes("public/task.md"), true)
  assert.equal(paths.includes("root-ignored/private/task.md"), false)
  assert.equal(paths.includes("anchored-ignored/leaked/task.md"), false)
  assert.equal(paths.includes("trackA/local-ignored/private/task.md"), false)
  assert.equal(paths.includes("root-ignored/reincluded/task.md"), true)
  assert.equal(paths.includes("trackA/local-ignored/reincluded/task.md"), true)
})

test("discover excludes symlink and hidden docs while preserving person and shared docs", async () => {
  const root = await tmpRoot()
  await writeFile(root, "trackA/task-1/task.md", "# Visible\n\npublic body")
  await writeFile(root, ".hidden/task.md", "# Hidden dir\n\nfixture secret")
  await writeFile(root, "trackA/_archive/.hidden.md", "# Hidden archive\n\nfixture secret")
  await writeFile(root, "_shared/.hidden.md", "# Hidden shared\n\nfixture secret")
  await writeFile(root, "desks/ari/trackP/task-3/task.md", "# Person\n\npublic body")
  await writeFile(root, "_shared/landscape/glossary.md", "# Shared\n\npublic body")

  let symlinkCreated = false
  try {
    await fs.mkdir(path.join(root, "trackA", "symlink-task"), { recursive: true })
    await fs.symlink(
      path.join(root, "trackA", "task-1", "task.md"),
      path.join(root, "trackA", "symlink-task", "task.md"),
    )
    symlinkCreated = true
  } catch {
    // Some filesystems disallow symlinks; hidden/person/shared coverage still runs.
  }

  const docs = await discover(root)
  const byPath = Object.fromEntries(docs.map((doc) => [doc.path, doc]))

  assert.ok(byPath["trackA/task-1/task.md"])
  assert.equal(byPath[".hidden/task.md"], undefined)
  assert.equal(byPath["trackA/_archive/.hidden.md"], undefined)
  assert.equal(byPath["_shared/.hidden.md"], undefined)
  if (symlinkCreated) {
    assert.equal(byPath["trackA/symlink-task/task.md"], undefined)
  }
  assert.equal(byPath["desks/ari/trackP/task-3/task.md"].kind, "task")
  assert.equal(byPath["desks/ari/trackP/task-3/task.md"].track, "trackP")
  assert.equal(byPath["desks/ari/trackP/task-3/task.md"].task_slug, "task-3")
  assert.equal(byPath["_shared/landscape/glossary.md"].kind, "shared")
  assert.equal(byPath["_shared/landscape/glossary.md"].track, null)
})

test("discover keeps ordinary archive recall while excluding archived sensitive paths", async () => {
  const root = await tmpRoot()
  await writeFile(root, "trackA/_archive/old-note.md", "# Archive\n\npublic history")
  await writeFile(root, "trackA/_archive/private-key-rotation.md", "# Old key\n\nfixture secret")

  const paths = (await discover(root)).map((doc) => doc.path)

  assert.equal(paths.includes("trackA/_archive/old-note.md"), true)
  assert.equal(
    paths.includes("trackA/_archive/private-key-rotation.md"),
    false,
    "archive indexing must not override sensitive-path exclusion",
  )
})

test("rebuildIndex never stores excluded document text", async () => {
  const root = await tmpRoot()
  await writeFile(root, ".gitignore", "ignored-track/**\n")
  await writeFile(root, "visible-track/task-1/task.md", "# Visible\n\npublic text")
  await writeFile(root, "ignored-track/leaked-task/task.md", "# Ignored\n\nGITIGNORED_SECRET_PAYLOAD")
  await writeFile(root, "visible-track/secrets/task.md", "# Sensitive\n\nSENSITIVE_PATH_PAYLOAD")

  const db = openDb(root, { dbPath: ":memory:" })
  try {
    const summary = await rebuildIndex(root, { db })
    assert.equal(summary.docs_indexed, 1)
    const rows = db.prepare("SELECT path FROM docs ORDER BY path").all()
    assert.deepEqual(rows.map((row) => row.path), ["visible-track/task-1/task.md"])
    const chunks = db.prepare("SELECT text FROM chunks ORDER BY id").all()
    assert.equal(
      chunks.some((row) => /GITIGNORED_SECRET_PAYLOAD|SENSITIVE_PATH_PAYLOAD/u.test(row.text)),
      false,
      "excluded document text must not be stored in chunks",
    )
  } finally {
    closeDb(db)
  }
})
test("exclusion helpers cover path globs", async () => {
  const {
    exclusionForPath,
    hasGitignoreNegation,
    loadExclusionRules,
  } = await loadExclusionsModule()
  const root = await tmpRoot()
  await writeFile(
    root,
    ".gitignore",
    "# comments ignored\n!\n!negations-covered-later\ntrackA/*.md\n*.pem\n",
  )

  const rules = await loadExclusionRules({ deskRoot: root })

  assert.deepEqual(await loadExclusionRules({}), { gitignore: [] })
  assert.deepEqual(await loadExclusionRules({ deskRoot: path.join(root, "missing") }), { gitignore: [] })
  assert.equal(hasGitignoreNegation({}), false)
  assert.equal(hasGitignoreNegation({ gitignore: ["!ignored-track/"] }), true)
  assert.equal(
    exclusionForPath("ignored-track/task.md", {
      gitignore: ["!ignored-track/"],
    }).excluded,
    false,
  )
  assert.equal(
    exclusionForPath("visible-track/task-1/task.md", {
      gitignore: [null, { baseDir: "trackA", negated: true }, { pattern: null }],
    }).excluded,
    false,
  )
  assert.equal(exclusionForPath(null, rules).excluded, false)
  assert.equal(exclusionForPath("visible-track/task-1/task.md").excluded, false)
  assert.equal(exclusionForPath("/trackA/task.md", rules).reason, "gitignore")
  assert.equal(exclusionForPath("cert.pem", rules).reason, "gitignore")
  assert.equal(
    exclusionForPath("outer/ignored-track/leaked-task/task.md", {
      gitignore: ["ignored-track/"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("outer/ignored-too/leaked-task/task.md", {
      gitignore: ["ignored-too"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("top/ignored-track", {
      gitignore: ["top/ignored-track/"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("top/ignored-track/leaked-task/task.md", {
      gitignore: ["top/ignored-track/"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("other/ignored-track/leaked-task/task.md", {
      gitignore: ["top/ignored-track/"],
    }).excluded,
    false,
  )
  assert.equal(
    exclusionForPath("ignored-track/leaked-task/task.md", {
      gitignore: ["ignored-track/"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("ignored-track", {
      gitignore: ["ignored-track/**"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("ignored-track/leaked-task/task.md", {
      gitignore: ["ignored-track/**"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("other-track/leaked-task/task.md", {
      gitignore: ["ignored-track/**"],
    }).excluded,
    false,
  )
  assert.equal(
    exclusionForPath("other-track/leaked-task/task.md", {
      gitignore: ["ignored-too"],
    }).excluded,
    false,
  )
  assert.equal(exclusionForPath("trackA/deep/task.md", rules).excluded, false)
})
