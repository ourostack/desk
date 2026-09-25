// track_create — happy path + duplicate refusal + optional fields +
// name/scope validation (M4-1).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { track_create } from "../../src/tools/track.js"
import { mkTempDeskRoot, readFront, exists } from "./_helpers.js"

const SCOPE = "europe trip planning and bookings; not day-to-day expenses"

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
      assert.match(err.message, /credential-like/)
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
