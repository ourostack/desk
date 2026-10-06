// On the transition to `done`, the task tools write `factory_report: <link>`
// into the card when the desk's resolved store has consent and the desk is
// known to be private; any other contributing desk's card records why in
// `factory_report_unavailable`, and a later task_update fills the link in once
// it can be named. The link is the one `factory.js job-link` prints; done never
// waits for delivery, and a card without consent gets neither field. Every
// desk is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import matter from "gray-matter"

import { task_archive, task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { factoryStateRoot, listFinalizeRequests, readMachineSecret, setConsent } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { jobReportUrl } from "../../../../../plugins/desk/mcp/src/factory/pipeline/build.js"
import { STORE, json, scratch } from "./_session_helpers.js"

const OTHER = "example-org/team-factory"
const REMOTE = "https://github.com/example-user/example-desk.git"

// task_update's evidence gate (the invented-completion finding) only fires on the
// transition into `done`; fixture calls that move a task to `done` carry
// this so they still exercise the report-link path they're actually
// testing, not the evidence gate itself. `task_archive`'s own implicit
// bump to `done` is unaffected and needs none of this.
const DONE_EVIDENCE = { kind: "pr", ref: "https://github.com/example-org/example-repo/pull/1" }

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

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" })

/** Make the desk a Git repository whose origin is a GitHub repository (pushes go to a local bare repository), with `answer` cached as its visibility. */
async function githubDesk(base, desk, env, answer = "private") {
  const bare = path.join(base, "origin.git")
  git(base, "init", "-q", "--bare", bare)
  git(desk, "init", "-q", "-b", "main")
  git(desk, "config", "user.email", "test@example.invalid")
  git(desk, "config", "user.name", "Test")
  git(desk, "config", "commit.gpgsign", "false")
  git(desk, "remote", "add", "origin", REMOTE)
  git(desk, "config", "remote.origin.pushurl", bare)
  await visibility(env, answer)
}

async function visibility(env, answer) {
  const file = path.join(await factoryStateRoot(env), "visibility.json")
  if (answer === null) return fs.rm(file, { force: true })
  return fs.writeFile(file, JSON.stringify({ "example-user/example-desk": { visibility: answer, checked_at: new Date().toISOString() } }))
}

// A private desk's store publishes its plain job ID, and its card links exactly that.
function expectedLink({ store = STORE, personPrefix = "", slug = "finished-work" } = {}) {
  return jobReportUrl({ store, job: jobId({ deskRemote: REMOTE, personPrefix, track: "track", slug }) })
}

/** Consent for `store`, and the machine secret a first flush would have created: it must make no difference to the link. */
async function contribute(env, store = STORE) {
  await setConsent(env, { store, contribute: true, account: "example-user" })
  await readMachineSecret(env)
}

const done = (desk, env, slug = "finished-work", extra = {}) => task_update({ deskRoot: desk, env, ...extra, input: { track: "track", slug, frontmatter: { status: "done" }, evidence: DONE_EVIDENCE } })

test("done with consent on a private desk writes the deterministic report link, and still queues the finalize request", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await contribute(env)
  await githubDesk(base, desk, env)
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture", status: "processing" } })
  const result = await done(desk, env)
  const data = await card(desk, "track/finished-work/task.md")
  assert.equal(data.status, "done")
  assert.equal(data.factory_report, expectedLink())
  assert.equal(Object.hasOwn(data, "factory_report_unavailable"), false)
  assert.equal(Object.hasOwn(result, "factory_report_unavailable"), false)
  assert.equal((await listFinalizeRequests(env)).length, 1, "done starts delivery and does not wait for it")
}))

for (const [label, prepare] of [
  ["no decision", async () => {}],
  ["a declined store", async (env) => setConsent(env, { store: STORE, contribute: false })],
]) {
  test(`done with ${label} writes neither link field and reports no reason`, () => scratch(async ({ base, desk, env: scratchEnv }) => {
    const env = await hostEnv(base, scratchEnv)
    await prepare(env)
    await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
    const result = await done(desk, env)
    const data = await card(desk, "track/finished-work/task.md")
    assert.equal(data.status, "done")
    assert.equal(Object.hasOwn(data, "factory_report"), false)
    assert.equal(Object.hasOwn(data, "factory_report_unavailable"), false)
    assert.equal(Object.hasOwn(result, "factory_report_unavailable"), false)
  }))
}

test("only the transition to done writes the link: cancelled and later edits of a done card with no reason do not", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await task_create({ deskRoot: desk, input: { track: "track", slug: "cancelled-work", title: "fixture" } })
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture", status: "done" } })
  await contribute(env)
  await task_update({ deskRoot: desk, env, input: { track: "track", slug: "cancelled-work", frontmatter: { status: "cancelled" } } })
  await task_update({ deskRoot: desk, env, input: { track: "track", slug: "finished-work", body_append: "Evidence." } })
  for (const slug of ["cancelled-work", "finished-work"]) {
    const data = await card(desk, `track/${slug}/task.md`)
    assert.equal(Object.hasOwn(data, "factory_report"), false)
    assert.equal(Object.hasOwn(data, "factory_report_unavailable"), false)
  }
}))

test("a crew desk's link carries the person prefix, and archiving an open task writes it too", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await contribute(env)
  await githubDesk(base, desk, env)
  await task_create({ deskRoot: desk, person: "alice", input: { track: "track", slug: "finished-work", title: "fixture", status: "validating" } })
  await done(desk, env, "finished-work", { person: "alice" })
  assert.equal((await card(desk, "desks/alice/track/finished-work/task.md")).factory_report, expectedLink({ personPrefix: "desks/alice" }))
  await task_create({ deskRoot: desk, input: { track: "track", slug: "archived-work", title: "fixture", status: "processing" } })
  const result = await task_archive({ deskRoot: desk, env, input: { track: "track", slug: "archived-work", evidence: DONE_EVIDENCE } })
  assert.equal(result.status, "archived")
  assert.equal(Object.hasOwn(result, "factory_report_unavailable"), false)
  const archived = await card(desk, "track/_archive/archived-work/task.md")
  assert.equal(archived.status, "done")
  assert.equal(archived.factory_report, expectedLink({ slug: "archived-work" }))
}))

test("the desk's declared store decides the link; an invalid declaration writes none and never fails the update", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await contribute(env, OTHER)
  await githubDesk(base, desk, env)
  await json(path.join(desk, "_meta", "factory.json"), { schema_version: 1, store: OTHER })
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
  await done(desk, env)
  assert.equal((await card(desk, "track/finished-work/task.md")).factory_report, expectedLink({ store: OTHER }))
  await json(path.join(desk, "_meta", "factory.json"), { schema_version: 1, store: OTHER, extra: true })
  await task_create({ deskRoot: desk, input: { track: "track", slug: "held-work", title: "fixture" } })
  assert.equal((await done(desk, env, "held-work")).status, "updated")
  assert.equal(Object.hasOwn(await card(desk, "track/held-work/task.md"), "factory_report"), false)
}))

test("unreadable factory state never fails done and writes no link", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await fs.mkdir(env.XDG_STATE_HOME, { recursive: true })
  await fs.writeFile(path.join(env.XDG_STATE_HOME, "ouroboros-skills"), "unsafe")
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture" } })
  assert.equal((await done(desk, env)).status, "updated")
  assert.equal(Object.hasOwn(await card(desk, "track/finished-work/task.md"), "factory_report"), false)
}))

test("a task whose job has no identity gets no link and records why, and done still succeeds", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await contribute(env)
  await task_create({ deskRoot: desk, input: { track: "_scratch", slug: "finished-work", title: "fixture" } })
  const result = await task_update({ deskRoot: desk, env, input: { track: "_scratch", slug: "finished-work", frontmatter: { status: "done" }, evidence: DONE_EVIDENCE } })
  assert.equal(result.status, "updated")
  assert.equal(result.factory_report_unavailable, "job_identity_unavailable")
  const data = await card(desk, "_scratch/finished-work/task.md")
  assert.equal(Object.hasOwn(data, "factory_report"), false)
  assert.equal(data.factory_report_unavailable, "job_identity_unavailable")
}))

test("a desk not known private gets no link, never any job ID, and its card and the tool result say why", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await contribute(env)
  // A desk with no GitHub remote is never known private.
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture", status: "processing" } })
  const result = await done(desk, env)
  assert.equal(result.factory_report_unavailable, "desk_not_private")
  const data = await card(desk, "track/finished-work/task.md")
  assert.equal(Object.hasOwn(data, "factory_report"), false)
  assert.equal(data.factory_report_unavailable, "desk_not_private")
  assert.doesNotMatch(await fs.readFile(path.join(desk, "track/finished-work/task.md"), "utf8"), /[0-9a-f]{32}/u, "the card names no job ID at all")
  // task_archive's own bump to done records the reason the same way.
  await task_create({ deskRoot: desk, input: { track: "track", slug: "archived-work", title: "fixture", status: "processing" } })
  const archived = await task_archive({ deskRoot: desk, env, input: { track: "track", slug: "archived-work", evidence: DONE_EVIDENCE } })
  assert.equal(archived.factory_report_unavailable, "desk_not_private")
  assert.equal((await card(desk, "track/_archive/archived-work/task.md")).factory_report_unavailable, "desk_not_private")
}))

test("a missing link is filled on a later update once it can be named, and the reason is kept current until then", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  await contribute(env)
  await githubDesk(base, desk, env, null)
  await task_create({ deskRoot: desk, input: { track: "track", slug: "finished-work", title: "fixture", status: "processing" } })
  assert.equal((await done(desk, env)).factory_report_unavailable, "visibility_not_known")
  const file = "track/finished-work/task.md"
  assert.equal((await card(desk, file)).factory_report_unavailable, "visibility_not_known")

  await visibility(env, "public")
  const still = await task_update({ deskRoot: desk, env, input: { track: "track", slug: "finished-work", body_append: "A later note." } })
  assert.equal(still.factory_report_unavailable, "desk_not_private", "the reason follows the newest answer")
  assert.equal((await card(desk, file)).factory_report_unavailable, "desk_not_private")

  await visibility(env, "private")
  const filled = await task_update({ deskRoot: desk, env, input: { track: "track", slug: "finished-work", body_append: "Another note." } })
  assert.equal(filled.factory_report, expectedLink(), "the result says the link was filled in")
  assert.equal(Object.hasOwn(filled, "factory_report_unavailable"), false)
  const data = await card(desk, file)
  assert.equal(data.factory_report, expectedLink())
  assert.equal(Object.hasOwn(data, "factory_report_unavailable"), false, "the reason goes once the link is written")

  // Once linked, a later edit asks nothing again.
  await visibility(env, "public")
  const later = await task_update({ deskRoot: desk, env, input: { track: "track", slug: "finished-work", body_append: "A third note." } })
  assert.equal(Object.hasOwn(later, "factory_report"), false)
  assert.equal((await card(desk, file)).factory_report, expectedLink())
}))

test("a newer answer never leaves an older link on the card: no link, a reason or no factory each remove it", () => scratch(async ({ base, desk, env: scratchEnv }) => {
  const env = await hostEnv(base, scratchEnv)
  const OLD = "https://github.com/ourostack/factory/blob/reports/jobs/00000000000000000000000000000000.md"
  const withOldLink = async (slug) => {
    await task_create({ deskRoot: desk, input: { track: "track", slug, title: "fixture", status: "processing" } })
    const file = path.join(desk, "track", slug, "task.md")
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/^status: processing$/mu, `status: processing\nfactory_report: ${OLD}`))
    assert.equal((await card(desk, `track/${slug}/task.md`)).factory_report, OLD)
  }
  // No factory: neither field stays.
  await withOldLink("no-factory")
  await done(desk, env, "no-factory")
  assert.equal(Object.hasOwn(await card(desk, "track/no-factory/task.md"), "factory_report"), false)
  // A desk not known private: the reason replaces the older link, on task_update and on task_archive's bump.
  await contribute(env)
  await withOldLink("public-work")
  await done(desk, env, "public-work")
  const updated = await card(desk, "track/public-work/task.md")
  assert.equal(Object.hasOwn(updated, "factory_report"), false)
  assert.equal(updated.factory_report_unavailable, "desk_not_private")
  await withOldLink("archived-work")
  await task_archive({ deskRoot: desk, env, input: { track: "track", slug: "archived-work", evidence: DONE_EVIDENCE } })
  const archived = await card(desk, "track/_archive/archived-work/task.md")
  assert.equal(Object.hasOwn(archived, "factory_report"), false)
  assert.equal(archived.factory_report_unavailable, "desk_not_private")
}))
