// friction_add — cross-cutting (no track) vs track-local; append semantics.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { friction_add } from "../../src/tools/friction.js"
import { mkTempDeskRoot, exists } from "./_helpers.js"

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

test("friction_add about system files a kaizen card and keeps only its URL on the desk", async () => {
  const root = await mkTempDeskRoot()
  const env = { HOME: root }
  const { calls, fileCard } = cardFiler({ result: "filed", store: "ourostack/factory", url: URL })
  const result = await friction_add({
    deskRoot: root,
    input: { about: "system", title: "Shell tool calls fail often", body: "Most tool failures are shell calls.", signal: "tool_failures", evidence_jobs: [JOB] },
    env,
    fileCard,
  })
  assert.deepEqual(result, { status: "filed", url: URL, path: path.join("_meta", "friction.md") })
  assert.equal(calls[0].env, env)
  assert.deepEqual(calls[0].options, { deskRoot: root, title: "Shell tool calls fail often", body: "Most tool failures are shell calls.", signal: "tool_failures", evidenceJobs: [JOB] })
  const content = await fs.readFile(path.join(root, "_meta", "friction.md"), "utf8")
  assert.equal(content, `Filed as a kaizen card: ${URL}\n`)
})

test("friction_add about system keeps the entry on the desk with the reason when the card is not filed", async () => {
  const root = await mkTempDeskRoot()
  const { calls, fileCard } = cardFiler({ result: "not_opted_in", store: "ourostack/factory" })
  const result = await friction_add({
    deskRoot: root,
    input: { about: "system", track: "t1", theme: "tools", title: "A generic title", body: "The friction." },
    env: {},
    fileCard,
  })
  assert.equal(result.status, "added")
  assert.equal(result.kaizen, "not_opted_in")
  assert.match(result.path, /^t1\/_friction\/\d{4}-\d{2}-\d{2}-tools\.md$/)
  assert.deepEqual(calls[0].options, { deskRoot: root, title: "A generic title", body: "The friction.", signal: null, evidenceJobs: [] })
  const content = await fs.readFile(path.join(root, result.path), "utf8")
  assert.match(content, /The friction\.\n\nNot filed as a kaizen card yet \(not_opted_in\)\. Title: A generic title\n$/)
})

test("friction_add about setup, or with no about, stays on the desk and files nothing", async () => {
  const root = await mkTempDeskRoot()
  const { calls, fileCard } = cardFiler({ result: "filed", url: URL })
  assert.equal((await friction_add({ deskRoot: root, input: { about: "setup", body: "Local setup." }, fileCard })).status, "added")
  assert.equal((await friction_add({ deskRoot: root, input: { body: "Also local." }, fileCard })).status, "added")
  assert.equal(calls.length, 0)
})

test("friction_add rejects an unknown about, or system friction with no title", async () => {
  const root = await mkTempDeskRoot()
  await assert.rejects(() => friction_add({ deskRoot: root, input: { about: "other", body: "x" } }), /about/u)
  await assert.rejects(() => friction_add({ deskRoot: root, input: { about: "system", body: "x" } }), /title/u)
  assert.equal(await exists(path.join(root, "_meta", "friction.md")), false)
})

test("friction_add about system uses the factory's filer by default, which files nothing without consent", async () => {
  const root = await mkTempDeskRoot()
  const env = { HOME: root, XDG_STATE_HOME: path.join(root, ".state") }
  const result = await friction_add({ deskRoot: root, input: { about: "system", title: "A generic title", body: "The friction." }, env })
  assert.equal(result.kaizen, "not_opted_in")
})
