// On the transition to `done`, the task tools write `factory_report: <jobLink>`
// into the card when the desk's resolved store has consent. The link is the
// one `factory.js job-link` prints; done never waits for delivery, and a card
// without consent is written exactly as before. Every desk is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import matter from "gray-matter"

import { task_archive, task_create, task_update } from "../../src/tools/task.js"
import { listFinalizeRequests, setConsent } from "../../src/factory/outbox.js"
import { jobLink } from "../../src/factory/pipeline/build.js"
import { STORE, json, scratch } from "./_session_helpers.js"

const OTHER = "example-org/team-factory"

/** The scratch env with the host plugin set pinned to Desk alone, so routing never depends on the machine running the tests. */
async function hostEnv(base, env) {
  const desk = path.join(base, "installed", "desk")
  await json(path.join(desk, "plugin.json"), { name: "desk", version: "3.2.0" })
  const result = { ...env, DESK_PLUGIN_ROOT: desk }
  delete result.CLAUDE_PLUGIN_ROOT
  return result
}

async function card(desk, relative) {
  return matter(await fs.readFile(path.join(desk, relative), "utf8")).data
}

async function expectedLink(desk, { store = STORE, personPrefix = "", slug = "finished-work" } = {}) {
  return jobLink({ store, deskRemote: `local:${await fs.realpath(desk)}`, personPrefix, track: "track", slug })
}

test("done with consent writes the deterministic report link, and still queues the finalize request", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await setConsent(env, { store: STORE, contribute: true, account: "example-user" })
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture", status: "processing" } })
  await task_update({ deskRoot: desk, env, input: { track: "track", slug: "finished-work", frontmatter: { status: "done" } } })
  const data = await card(desk, "track/finished-work/task.md")
  assert.equal(data.status, "done")
  assert.equal(data.factory_report, await expectedLink(desk))
  assert.equal((await listFinalizeRequests(env)).length, 1, "done starts delivery and does not wait for it")
}))

for (const [label, prepare] of [
  ["no decision", async () => {}],
  ["a declined store", async (env) => setConsent(env, { store: STORE, contribute: false })],
]) {
  test(`done with ${label} writes the card exactly as before`, () => scratch(async ({ base, desk, env: scratchEnv }) => {
    const env = await hostEnv(base, scratchEnv)
    await prepare(env)
    await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
    await task_update({ deskRoot: desk, env, input: { track: "track", slug: "finished-work", frontmatter: { status: "done" } } })
    const data = await card(desk, "track/finished-work/task.md")
    assert.equal(data.status, "done")
    assert.equal(Object.hasOwn(data, "factory_report"), false)
  }))
}

test("only the transition to done writes the link: cancelled and later edits of a done card do not", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await task_create({ deskRoot: desk, input: { track: "track", slug: "cancelled-work", title: "fixture" } })
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture", status: "done" } })
  await setConsent(env, { store: STORE, contribute: true, account: "example-user" })
  await task_update({ deskRoot: desk, env, input: { track: "track", slug: "cancelled-work", frontmatter: { status: "cancelled" } } })
  await task_update({ deskRoot: desk, env, input: { track: "track", slug: "finished-work", body_append: "Evidence." } })
  assert.equal(Object.hasOwn(await card(desk, "track/cancelled-work/task.md"), "factory_report"), false)
  assert.equal(Object.hasOwn(await card(desk, "track/finished-work/task.md"), "factory_report"), false)
}))

test("a crew desk's link carries the person prefix, and archiving an open task writes it too", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await setConsent(env, { store: STORE, contribute: true, account: "example-user" })
  await task_create({ deskRoot: desk, person: "alice", input: { track: "track", slug: "finished-work", title: "fixture", status: "validating" } })
  await task_update({ deskRoot: desk, env, person: "alice", input: { track: "track", slug: "finished-work", frontmatter: { status: "done" } } })
  assert.equal((await card(desk, "desks/alice/track/finished-work/task.md")).factory_report, await expectedLink(desk, { personPrefix: "desks/alice" }))
  await task_create({ deskRoot: desk, input: { track: "track", slug: "archived-work", title: "fixture", status: "processing" } })
  assert.equal((await task_archive({ deskRoot: desk, env, input: { track: "track", slug: "archived-work" } })).status, "archived")
  const archived = await card(desk, "track/_archive/archived-work/task.md")
  assert.equal(archived.status, "done")
  assert.equal(archived.factory_report, await expectedLink(desk, { slug: "archived-work" }))
}))

test("the desk's declared store decides the link; an invalid declaration writes none and never fails the update", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await setConsent(env, { store: OTHER, contribute: true, account: "example-user" })
  await json(path.join(desk, "_meta", "factory.json"), { schema_version: 1, store: OTHER })
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
  await task_update({ deskRoot: desk, env, input: { track: "track", slug: "finished-work", frontmatter: { status: "done" } } })
  assert.equal((await card(desk, "track/finished-work/task.md")).factory_report, await expectedLink(desk, { store: OTHER }))
  await json(path.join(desk, "_meta", "factory.json"), { schema_version: 1, store: OTHER, extra: true })
  await task_create({ deskRoot: desk, input: { track: "track", slug: "held-work", title: "fixture" } })
  assert.equal((await task_update({ deskRoot: desk, env, input: { track: "track", slug: "held-work", frontmatter: { status: "done" } } })).status, "updated")
  assert.equal(Object.hasOwn(await card(desk, "track/held-work/task.md"), "factory_report"), false)
}))

test("unreadable factory state never fails done and writes no link", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await fs.mkdir(env.XDG_STATE_HOME, { recursive: true })
  await fs.writeFile(path.join(env.XDG_STATE_HOME, "ouroboros-skills"), "unsafe")
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
  assert.equal((await task_update({ deskRoot: desk, env, input: { track: "track", slug: "finished-work", frontmatter: { status: "done" } } })).status, "updated")
  assert.equal(Object.hasOwn(await card(desk, "track/finished-work/task.md"), "factory_report"), false)
}))

test("a task whose job has no identity gets no link, and done still succeeds", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await setConsent(env, { store: STORE, contribute: true, account: "example-user" })
  await task_create({ deskRoot: desk, input: { track: "_scratch", slug: "finished-work", title: "fixture" } })
  assert.equal((await task_update({ deskRoot: desk, env, input: { track: "_scratch", slug: "finished-work", frontmatter: { status: "done" } } })).status, "updated")
  assert.equal(Object.hasOwn(await card(desk, "_scratch/finished-work/task.md"), "factory_report"), false)
}))
