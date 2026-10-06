// friction_add — cross-cutting (no track) vs track-local; append semantics.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { friction_add } from "../../../../../plugins/desk/mcp/src/tools/friction.js"
import { today } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { mkTempDeskRoot, exists } from "./_helpers.js"
import { osEnv } from "../_os_env.js"

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

test("friction_add (no track) writes to _meta/friction.md", async () => {
  const root = await mkTempDeskRoot()
  const result = await friction_add({
    deskRoot: root,
    input: { body: "## 2026-05-22 — onboarding hurts\n\nFoo." },
  })
  assert.equal(result.status, "added")
  assert.equal(result.path, path.join("_meta", "friction.md"))

  const filePath = path.join(root, "_meta", "friction.md")
  assert.ok(await exists(filePath))
  const content = await fs.readFile(filePath, "utf8")
  assert.match(content, /onboarding hurts/)
})

test("friction_add treats null, empty, undefined, and non-string track values as cross-cutting", async () => {
  for (const track of [null, "", undefined, 42]) {
    const root = await mkTempDeskRoot()
    const result = await friction_add({
      deskRoot: root,
      input: { track, body: `cross-cutting ${String(track)}` },
    })

    assert.equal(result.path, path.join("_meta", "friction.md"))
    assert.match(
      await fs.readFile(path.join(root, "_meta", "friction.md"), "utf8"),
      /cross-cutting/,
    )
  }
})

test("friction_add (with track) writes to <track>/_friction/<date>-<theme>.md", async () => {
  const root = await mkTempDeskRoot()
  const result = await friction_add({
    deskRoot: root,
    input: {
      track: "europe-trip",
      theme: "Visa Logistics",
      body: "## Visa friction\n\nDetails.",
    },
  })
  assert.equal(result.status, "added")
  assert.match(result.path, /^europe-trip\/_friction\/\d{4}-\d{2}-\d{2}-visa-logistics\.md$/)

  const filePath = path.join(root, result.path)
  const content = await fs.readFile(filePath, "utf8")
  assert.match(content, /Visa friction/)
})

test("friction_add appends with a separator on the second call", async () => {
  const root = await mkTempDeskRoot()
  await friction_add({
    deskRoot: root,
    input: { body: "first entry body" },
  })
  await friction_add({
    deskRoot: root,
    input: { body: "second entry body" },
  })

  const content = await fs.readFile(
    path.join(root, "_meta", "friction.md"),
    "utf8",
  )
  assert.match(content, /first entry body/)
  assert.match(content, /second entry body/)
  assert.match(content, /---/, "separator between entries")
  assert.ok(
    content.indexOf("first entry") < content.indexOf("second entry"),
    "order preserved",
  )
})

test("friction_add normalizes trailing newlines and appends to a file without one", async () => {
  const root = await mkTempDeskRoot()
  const filePath = path.join(root, "_meta", "friction.md")
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, "existing entry without newline", "utf8")

  await friction_add({
    deskRoot: root,
    input: { body: "new entry with newline\n" },
  })

  const content = await fs.readFile(filePath, "utf8")
  assert.match(content, /existing entry without newline\n\n---\n\nnew entry with newline\n$/)
})

test("friction_add defaults theme to 'untitled' if missing", async () => {
  const root = await mkTempDeskRoot()
  const result = await friction_add({
    deskRoot: root,
    input: { track: "t1", body: "Untitled friction" },
  })
  assert.match(result.path, /-untitled\.md$/)
})

test("friction_add requires a body", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(
    () => friction_add({ deskRoot: root }),
    /body.*required/,
  )
  await assert.rejects(
    () => friction_add({ deskRoot: root, input: {} }),
    /body.*required/,
  )
  await assert.rejects(
    () => friction_add({ deskRoot: root, input: { body: 123 } }),
    /body.*required/,
  )
})

// ── about: "system" — friction about the system becomes a kaizen card ────────

const URL = "https://github.com/ourostack/factory/issues/12"
const JOB = "9f2c4b1a7d3e5f60718293a4b5c6d7e8"

function cardFiler(answer) {
  const calls = []
  const fileCard = async (env, options) => {
    calls.push({ env, options })
    return answer
  }
  return { calls, fileCard }
}

test("friction_add about system records a kaizen candidate on the desk and files nothing", async () => {
  const root = await mkTempDeskRoot()
  const { calls, fileCard } = cardFiler({ result: "filed", url: URL })
  const result = await friction_add({
    deskRoot: root,
    input: { about: "system", title: "  Shell tool calls fail often ", body: "Most tool failures are shell calls.\n", friction_class: "mcp_tool", signal: "tool_failures", evidence_jobs: [JOB] },
    fileCard,
  })
  assert.deepEqual(result, { status: "added", path: path.join("_meta", "friction.md"), kaizen: "candidate" })
  assert.equal(calls.length, 0)
  const content = await fs.readFile(path.join(root, "_meta", "friction.md"), "utf8")
  assert.equal(content, `Most tool failures are shell calls.\n\nKaizen candidate for the curator: "Shell tool calls fail often"; plugin \`desk\`, class \`mcp_tool\`, measure \`tool_failures\`, evidence jobs ${JOB}.\n`)
  await friction_add({ deskRoot: root, input: { about: "system", title: "Draft", body: "b", plugin: "superpowers", evidence_jobs: "not a list" }, fileCard })
  assert.match(await fs.readFile(path.join(root, "_meta", "friction.md"), "utf8"), /"Draft"; plugin `superpowers`, class `other`, measure not chosen, evidence jobs none yet\.\n$/u)
  assert.equal(calls.length, 0)
})

test("friction_add with file_card files the card after the desk write is ready and records the outcome", async () => {
  const root = await mkTempDeskRoot()
  const env = { HOME: root }
  const { calls, fileCard } = cardFiler({ result: "filed", store: "ourostack/factory", url: URL, visibility: "public" })
  const input = { about: "system", file_card: true, track: "t1", theme: "tools", title: "Shell tool calls fail often", body: "Most tool failures are shell calls.", plugin: "desk", friction_class: "mcp_tool", signal: "tool_failures", evidence_jobs: [JOB] }
  const result = await friction_add({ deskRoot: root, input, env, fileCard })
  assert.match(result.path, /^t1\/_friction\/\d{4}-\d{2}-\d{2}-tools\.md$/u)
  assert.deepEqual(result, { status: "filed", path: result.path, url: URL, kaizen: "filed" })
  assert.equal(calls[0].env, env)
  assert.deepEqual(calls[0].options, { deskRoot: root, title: "Shell tool calls fail often", body: "Most tool failures are shell calls.", plugin: "desk", frictionClass: "mcp_tool", signal: "tool_failures", evidenceJobs: [JOB] })
  assert.match(await fs.readFile(path.join(root, result.path), "utf8"), /Kaizen card for "Shell tool calls fail often": filed at https:\/\/github\.com\/ourostack\/factory\/issues\/12\n$/u)
  const again = cardFiler({ result: "duplicate", store: "ourostack/factory", url: URL, visibility: "public" })
  assert.deepEqual(await friction_add({ deskRoot: root, input, env, fileCard: again.fileCard }), { status: "filed", path: result.path, url: URL, kaizen: "duplicate" })
  assert.match(await fs.readFile(path.join(root, result.path), "utf8"), /already open at https:\/\/github\.com\/ourostack\/factory\/issues\/12\n$/u)
})

test("friction_add with file_card keeps the candidate on the desk with the reason when the card is not filed", async () => {
  const root = await mkTempDeskRoot()
  const { calls, fileCard } = cardFiler({ result: "route_unknown" })
  const result = await friction_add({ deskRoot: root, input: { about: "system", file_card: true, title: "A generic title", body: "The friction." }, env: {}, fileCard })
  assert.deepEqual(result, { status: "added", path: path.join("_meta", "friction.md"), kaizen: "route_unknown" })
  assert.deepEqual(calls[0].options, { deskRoot: root, title: "A generic title", body: "The friction.", plugin: "desk", frictionClass: "other", signal: null, evidenceJobs: [] })
  assert.equal(await fs.readFile(path.join(root, "_meta", "friction.md"), "utf8"), `Kaizen card for "A generic title": not filed (route_unknown); it stays a candidate.\n`)
})

test("friction_add files nothing when the desk write target cannot be prepared", async () => {
  const root = await mkTempDeskRoot()
  await fs.writeFile(path.join(root, "t1"), "a file where the track folder should be", "utf8")
  const { calls, fileCard } = cardFiler({ result: "filed", url: URL })
  await assert.rejects(() => friction_add({ deskRoot: root, input: { about: "system", file_card: true, track: "t1", title: "A title", body: "b" }, fileCard }))
  assert.equal(calls.length, 0)
})

test("friction_add about setup, or with no about, stays on the desk and files nothing", async () => {
  const root = await mkTempDeskRoot()
  const { calls, fileCard } = cardFiler({ result: "filed", url: URL })
  assert.deepEqual(await friction_add({ deskRoot: root, input: { about: "setup", body: "Local setup." }, fileCard }), { status: "added", path: path.join("_meta", "friction.md") })
  assert.equal((await friction_add({ deskRoot: root, input: { body: "Also local.", file_card: false }, fileCard })).status, "added")
  assert.equal(calls.length, 0)
})

test("friction_add rejects malformed system friction before writing anything", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(() => friction_add({ deskRoot: root, input: { about: "other", body: "x" } }), /about/u)
  await assert.rejects(() => friction_add({ deskRoot: root, input: { about: "system", body: "x" } }), /title/u)
  await assert.rejects(() => friction_add({ deskRoot: root, input: { about: "system", title: "two\nlines", body: "x" } }), /title/u)
  await assert.rejects(() => friction_add({ deskRoot: root, input: { about: "system", title: "t", plugin: "Not A Plugin", body: "x" } }), /plugin/u)
  await assert.rejects(() => friction_add({ deskRoot: root, input: { about: "system", title: "t", plugin: 5, body: "x" } }), /plugin/u)
  await assert.rejects(() => friction_add({ deskRoot: root, input: { about: "system", title: "t", friction_class: "vibes", body: "x" } }), /friction_class/u)
  await assert.rejects(() => friction_add({ deskRoot: root, input: { about: "system", title: "t", file_card: "yes", body: "x" } }), /file_card/u)
  await assert.rejects(() => friction_add({ deskRoot: root, input: { file_card: true, body: "x" } }), /only for system/u)
  assert.equal(await exists(path.join(root, "_meta", "friction.md")), false)
})

test("friction_add with file_card uses the factory's filer by default, which files nothing without a known route", async () => {
  const root = await mkTempDeskRoot()
  const env = osEnv({ HOME: root, XDG_STATE_HOME: path.join(path.dirname(root), `${path.basename(root)}-state`) })
  const result = await friction_add({ deskRoot: root, input: { about: "system", file_card: true, title: "A generic title", body: "The friction." }, env })
  assert.equal(result.kaizen, "route_unknown")
})

// ── M4-6 Part 2: stage + commit ─────────────────────────────────────────────

test("friction_add stages and commits exactly the friction file it wrote", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const result = await friction_add({
    deskRoot: root,
    input: { body: "## 2026-05-22 — onboarding hurts\n\nFoo." },
    schedulePush: () => {},
  })
  assert.equal(result.status, "added")
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.equal(gitStatus(root), "")
  assert.equal(lastCommitMessage(root), "friction_add: desk-plugin")
  assert.deepEqual(lastCommitFiles(root), [path.join("_meta", "friction.md")])
})

test("friction_add names the commit after the given plugin for system friction", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const { calls, fileCard } = cardFiler({ result: "route_unknown" })
  const result = await friction_add({
    deskRoot: root,
    input: { about: "system", title: "A generic title", plugin: "desk-tidy", body: "The friction." },
    fileCard,
    schedulePush: () => {},
  })
  assert.equal(result.status, "added")
  assert.equal(calls.length, 0)
  assert.equal(lastCommitMessage(root), "friction_add: desk-tidy")
})

test("friction_add commits only its own file, leaving another process's staged, unrelated file untouched (TOCTOU)", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)

  // Simulates another process staging an unrelated path in the window
  // between friction_add's dirty check and its own stage/commit.
  await fs.writeFile(path.join(root, "unrelated.txt"), "another process's work\n")
  spawnSync("git", ["-C", root, "add", "--", "unrelated.txt"], { encoding: "utf8" })

  const result = await friction_add({
    deskRoot: root,
    input: { body: "## 2026-05-22 — onboarding hurts\n\nFoo." },
    schedulePush: () => {},
  })

  assert.equal(result.commit, undefined, "friction_add's own commit succeeded")
  assert.deepEqual(lastCommitFiles(root), [path.join("_meta", "friction.md")])
  const status = gitStatus(root)
  assert.match(status, /^A  unrelated\.txt$/m, "the unrelated path is still staged, not swept into this commit")
})

test("friction_add reports a commit failure without losing the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("commit")) return { status: 1, stdout: "", stderr: "commit boom" }
    return spawnSync(cmd, args, opts)
  }
  const calls = []
  const schedulePush = (opts) => calls.push(opts)
  const result = await friction_add({
    deskRoot: root,
    input: { body: "## 2026-05-22 — onboarding hurts\n\nFoo." },
    spawnGit,
    schedulePush,
  })
  assert.equal(result.status, "added", "the write itself is never lost to a commit failure")
  assert.ok(await exists(path.join(root, "_meta", "friction.md")))
  assert.deepEqual(result.commit, { status: "failed", reason: "commit boom" })
  assert.equal(calls.length, 0, "schedulePush is never called when the commit fails")
})

test("friction_add reports a staging failure without losing the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("add")) return { status: 1, stdout: "", stderr: "add boom" }
    return spawnSync(cmd, args, opts)
  }
  const result = await friction_add({
    deskRoot: root,
    input: { body: "## 2026-05-22 — onboarding hurts\n\nFoo." },
    spawnGit,
  })
  assert.equal(result.status, "added", "the write itself is never lost to a staging failure")
  assert.deepEqual(result.commit, { status: "failed", reason: "add boom" }, "a stage failure is reported, not swallowed as a silent success")
  assert.ok(await exists(path.join(root, "_meta", "friction.md")))
})

test("friction_add appends to an existing file and commits again", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await friction_add({ deskRoot: root, input: { body: "First entry." }, schedulePush: () => {} })
  const result = await friction_add({ deskRoot: root, input: { body: "Second entry." }, schedulePush: () => {} })

  assert.equal(result.commit, undefined)
  assert.equal(gitStatus(root), "")
  const content = await fs.readFile(path.join(root, "_meta", "friction.md"), "utf8")
  assert.match(content, /First entry\.[\s\S]*Second entry\./)
})

test("friction_add skips staging and committing when the file held unstaged changes before the write", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  await friction_add({ deskRoot: root, input: { body: "First entry." }, schedulePush: () => {} })
  const filePath = path.join(root, "_meta", "friction.md")

  // Another session's unstaged edit to this same file, in place before
  // friction_add appends.
  await fs.appendFile(filePath, "\nanother session's note\n")

  const calls = []
  const schedulePush = (opts) => calls.push(opts)
  const result = await friction_add({ deskRoot: root, input: { body: "Second entry." }, schedulePush })

  assert.equal(result.status, "added", "the write always happens")
  assert.equal(result.commit, undefined, "no commit attempted when the file was already dirty")
  const content = await fs.readFile(filePath, "utf8")
  assert.match(content, /Second entry\./)
  assert.match(gitStatus(root), /_meta\/friction\.md/, "the file is left as an uncommitted change")
  assert.equal(calls.length, 0, "schedulePush is never called when the commit is skipped")
})

test("friction_add skips staging and committing silently on a non-Git desk", async () => {
  const root = await mkTempDeskRoot()
  const calls = []
  const schedulePush = (opts) => calls.push(opts)
  const result = await friction_add({
    deskRoot: root,
    input: { body: "## 2026-05-22 — onboarding hurts\n\nFoo." },
    schedulePush,
  })
  assert.equal(result.status, "added")
  assert.equal(result.commit, undefined)
  assert.equal(calls.length, 0, "schedulePush is never called on a non-Git desk")
})

test("friction_add retries with an underscore-prefixed slug when a same-named file has a different identity", async () => {
  const root = await mkTempDeskRoot()
  const date = today()
  const collidingPath = path.join(root, "t1", "_friction", `${date}-tools.md`)
  await fs.mkdir(path.dirname(collidingPath), { recursive: true })
  await fs.writeFile(collidingPath, "An unrelated legacy file, no identity comment.\n", "utf8")

  const result = await friction_add({ deskRoot: root, input: { track: "t1", theme: "tools", body: "New entry." } })

  assert.equal(result.path, path.join("t1", "_friction", `${date}-_tools.md`))
  assert.match(await fs.readFile(path.join(root, result.path), "utf8"), /New entry\./)
})

test("friction_add stages and commits a track-local friction file", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const result = await friction_add({
    deskRoot: root,
    input: { track: "t1", theme: "tools", body: "Track-local friction." },
    schedulePush: () => {},
  })
  assert.equal(result.status, "added")
  assert.match(result.path, /^t1\/_friction\/\d{4}-\d{2}-\d{2}-tools\.md$/u)
  assert.equal(gitStatus(root), "")
  assert.deepEqual(lastCommitFiles(root), [result.path.split(path.sep).join("/")])
})

// ── M4-6 Part 3: schedule push ──────────────────────────────────────────────

test("friction_add schedules a push exactly once with the desk root after a successful, silent commit", async () => {
  const root = await mkTempDeskRoot()
  initGit(root)
  const calls = []
  const schedulePush = (opts) => calls.push(opts)
  const result = await friction_add({
    deskRoot: root,
    input: { body: "## 2026-05-22 — onboarding hurts\n\nFoo." },
    schedulePush,
  })
  assert.equal(result.commit, undefined, "no commit field on a normal, silent success")
  assert.deepEqual(calls, [{ root }])
})
