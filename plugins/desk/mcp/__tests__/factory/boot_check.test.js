// The factory boot check: bounded reads of protected state and task-card
// frontmatter only, never a write. Every desk and card here is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, promises as fs, readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { factoryStateRoot, quarantine, requestFinalize, setConsent, updateJobsIndex, writeLocalFacts, markDelivered } from "../../src/factory/outbox.js"
import { jobId } from "../../src/factory/binding.js"
import { STORE, json, scratch } from "./_session_helpers.js"

const moduleUrl = new URL("../../src/factory/boot-check.js", import.meta.url)
async function load() {
  assert.ok(existsSync(moduleUrl), "the factory boot check must exist")
  return import(moduleUrl)
}

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const NOW = Date.parse("2026-09-27T12:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()

async function card(folder, { status = "done", updated = iso(NOW - DAY), extra = "" } = {}) {
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, "task.md"), `---\ntitle: Synthetic\nstatus: ${status}\nupdated: ${updated}\n${extra}---\n\nBody\n`)
}

async function jobOf(desk, track, slug, personPrefix = "") {
  return jobId({ deskRemote: `local:${await fs.realpath(desk)}`, personPrefix, track, slug })
}

async function outboxFile(env, n) {
  const facts = structuredClone(GOLDEN)
  facts.session.id = sessionId(n)
  const written = await writeLocalFacts(env, STORE, facts)
  assert.equal(written.written, true)
  return written.name
}

test("a store with no consent decision asks the agent to ask the operator once, in exactly the approved words", () => scratch(async ({ env, desk }) => {
  const { factoryBootCheck, FACTORY_NO_CONSENT_LINE } = await load()
  assert.equal(FACTORY_NO_CONSENT_LINE, "Factory: this desk hasn't decided whether to contribute measurement data; ask the operator once (desk:session-start)")
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { line: FACTORY_NO_CONSENT_LINE })
  await setConsent(env, { store: "acme/other", contribute: true })
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { line: FACTORY_NO_CONSENT_LINE }, "another store's decision is not this store's")
  const root = await factoryStateRoot(env)
  await fs.writeFile(path.join(root, "consent.json"), "{ not json")
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] }, "unreadable consent stays silent")
  // desk_status reads a consent file whose `stores` is not an object as unreadable, so the boot line stays silent too (review M3-11 D1).
  await fs.writeFile(path.join(root, "consent.json"), JSON.stringify({ schema_version: 1, stores: [] }))
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] }, "a malformed consent file is unreadable, as desk_status reports it")
  await fs.writeFile(path.join(root, "consent.json"), JSON.stringify({ schema_version: 1, stores: { [STORE]: { contribute: "maybe" } } }))
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { line: FACTORY_NO_CONSENT_LINE }, "a record without a yes or no is undecided, as desk_status reports it")
}))

test("the check never creates or changes factory state", () => scratch(async ({ env, desk, base }) => {
  const { factoryBootCheck } = await load()
  factoryBootCheck({ env, deskRoot: desk, now: NOW })
  assert.equal(existsSync(path.join(base, "state")), false)
}))

test("a declined store, an invalid declaration, an unbound desk and an incomplete plugin scan are silent", () => scratch(async ({ env, desk }) => {
  const { factoryBootCheck } = await load()
  assert.deepEqual(factoryBootCheck({ env, deskRoot: null, now: NOW }), { jobs: [] })
  assert.deepEqual(factoryBootCheck({ env, deskRoot: "relative", now: NOW }), { jobs: [] })
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW, pluginScanIncomplete: true }), { jobs: [] })
  await setConsent(env, { store: STORE, contribute: false })
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] })
  await json(path.join(desk, "_meta", "factory.json"), { schema_version: 1, store: "not a store" })
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] })
  await json(path.join(desk, "_meta", "factory.json"), { schema_version: 1, store: "acme/declared" })
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW, pluginScanIncomplete: true }).line, "Factory: this desk hasn't decided whether to contribute measurement data; ask the operator once (desk:session-start)", "the desk's own declaration decides even when the plugin scan is incomplete")
}))

test("a finished job with an undelivered outbox file or a pending finalize request gets a finalize repair", () => scratch(async ({ env, desk }) => {
  const { factoryBootCheck } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] }, "no finished cards")
  await card(path.join(desk, "alpha", "undelivered"))
  await card(path.join(desk, "alpha", "delivered"))
  await card(path.join(desk, "alpha", "quarantined"))
  await card(path.join(desk, "alpha", "requested"), { status: "cancelled" })
  await card(path.join(desk, "alpha", "nothing"))
  await card(path.join(desk, "alpha", "missing-file"))
  await card(path.join(desk, "alpha", "open"), { status: "processing" })
  const undelivered = await jobOf(desk, "alpha", "undelivered")
  const delivered = await jobOf(desk, "alpha", "delivered")
  const quarantined = await jobOf(desk, "alpha", "quarantined")
  const requested = await jobOf(desk, "alpha", "requested")
  const missing = await jobOf(desk, "alpha", "missing-file")
  const open = await jobOf(desk, "alpha", "open")
  await updateJobsIndex(env, undelivered, await outboxFile(env, 1))
  const deliveredName = await outboxFile(env, 2)
  await updateJobsIndex(env, delivered, deliveredName)
  await markDelivered(env, STORE, { name: deliveredName, publishedBlobSha: "a".repeat(40) })
  const quarantinedName = await outboxFile(env, 3)
  await updateJobsIndex(env, quarantined, quarantinedName)
  await quarantine(env, STORE, quarantinedName, "date")
  await updateJobsIndex(env, missing, `claude-code-${sessionId(9)}.json`)
  await updateJobsIndex(env, open, await outboxFile(env, 4))
  await requestFinalize(env, { job: requested, deskRoot: desk })
  await requestFinalize(env, { job: open, deskRoot: desk })
  const result = factoryBootCheck({ env, deskRoot: desk, now: NOW })
  assert.deepEqual(result, { jobs: [undelivered, requested, open].sort() }, "every pending request counts, even one whose card was reopened")
}))

test("cards are read only in the desk layout: tracks, their archives, archived tracks and a person's own desk", () => scratch(async ({ env, desk }) => {
  const { factoryBootCheck, finishedTasks } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await card(path.join(desk, "alpha", "_archive", "archived-task"))
  await card(path.join(desk, "_archive", "old-track", "task-in-archived-track"))
  await card(path.join(desk, "_archive", "old-track", "_archive", "doubly-archived"))
  await card(path.join(desk, "_archive", "_hidden", "skipped"))
  await card(path.join(desk, "desks", "sam", "beta", "person-task"))
  await card(path.join(desk, "_meta", "not-a-track"))
  await card(path.join(desk, ".hidden", "not-a-track"))
  await card(path.join(desk, "alpha", "_template"))
  const tasks = finishedTasks({ deskRoot: desk, now: NOW }).map(({ track, slug }) => `${track}/${slug}`).sort()
  assert.deepEqual(tasks, ["alpha/archived-task", "old-track/doubly-archived", "old-track/task-in-archived-track"])
  const person = finishedTasks({ deskRoot: desk, personPrefix: "desks/sam", now: NOW }).map(({ track, slug }) => `${track}/${slug}`)
  assert.deepEqual(person, ["beta/person-task"])
  const job = await jobOf(desk, "beta", "person-task", "desks/sam")
  await requestFinalize(env, { job, deskRoot: desk })
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, personPrefix: "desks/sam", now: NOW }), { jobs: [job] })
  assert.throws(() => finishedTasks({ deskRoot: desk, personPrefix: "../escape", now: NOW }), /personPrefix/u)
}))

test("only done or cancelled cards updated within 30 days count, whatever the frontmatter spelling", () => scratch(async ({ desk }) => {
  const { finishedTasks } = await load()
  await card(path.join(desk, "t", "iso"), { updated: iso(NOW - 29 * DAY) })
  await card(path.join(desk, "t", "quoted"), { updated: `'${iso(NOW - DAY)}'`, status: "'done'" })
  await card(path.join(desk, "t", "double-quoted"), { updated: `"${iso(NOW - DAY)}"`, status: "\"cancelled\"" })
  await card(path.join(desk, "t", "commented"), { updated: `${iso(NOW - DAY)} # when`, status: "done # finished" })
  await card(path.join(desk, "t", "bare-date"), { updated: "2026-09-20" })
  await card(path.join(desk, "t", "old"), { updated: iso(NOW - 31 * DAY) })
  await card(path.join(desk, "t", "future"), { updated: iso(NOW + 31 * DAY) })
  await card(path.join(desk, "t", "unparseable"), { updated: "last tuesday" })
  await card(path.join(desk, "t", "open"), { status: "blocked" })
  await card(path.join(desk, "t", "duplicate"), { status: "processing", extra: "status: done\n" })
  await fs.mkdir(path.join(desk, "t", "no-frontmatter"), { recursive: true })
  await fs.writeFile(path.join(desk, "t", "no-frontmatter", "task.md"), "status: done\n")
  await fs.mkdir(path.join(desk, "t", "late-status"), { recursive: true })
  await fs.writeFile(path.join(desk, "t", "late-status", "task.md"), `---\n${"note: x\n".repeat(45)}status: done\nupdated: ${iso(NOW)}\n---\n`)
  await fs.mkdir(path.join(desk, "t", "linked"), { recursive: true })
  await fs.symlink(path.join(desk, "t", "iso", "task.md"), path.join(desk, "t", "linked", "task.md"))
  await fs.mkdir(path.join(desk, "t", "directory-card", "task.md"), { recursive: true })
  await fs.mkdir(path.join(desk, "t", "no-card"), { recursive: true })
  const tasks = finishedTasks({ deskRoot: desk, now: NOW }).map(({ slug }) => slug).sort()
  assert.deepEqual(tasks, ["bare-date", "commented", "double-quoted", "iso", "quoted"])
}))

test("the check stops at its deadline", () => scratch(async ({ env, desk }) => {
  const { factoryBootCheck } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await card(path.join(desk, "alpha", "one"))
  let now = 0
  assert.throws(() => factoryBootCheck({ env, deskRoot: desk, now: NOW, deadline: 10, clock: () => { now += 20; return now } }), { code: "boot_check_budget" })
  const cutOff = () => { throw Object.assign(new Error("git_deadline"), { code: "git_deadline" }) }
  assert.throws(() => factoryBootCheck({ env, deskRoot: desk, now: NOW, deadline: Infinity, clock: () => 0, readRemote: cutOff }), { code: "boot_check_budget" }, "a remote read cut off by the deadline is an overrun, never a desk without a remote")
  const seen = []
  factoryBootCheck({ env, deskRoot: desk, now: NOW, deadline: 99, clock: () => 0, readRemote: (options) => { seen.push(options); return null } })
  assert.equal(seen[0].deadline, 99, "the remote read shares the check's own deadline")
}))

test("a desk with a known remote computes the task tools' job IDs, and a folder the job ID refuses is skipped", () => scratch(async ({ env, desk }) => {
  const { factoryBootCheck } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await card(path.join(desk, "alpha", "remote-task"))
  const remote = "https://github.com/acme/desk.git"
  const job = jobId({ deskRemote: remote, personPrefix: "", track: "alpha", slug: "remote-task" })
  await requestFinalize(env, { job, deskRoot: desk })
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW, readRemote: () => remote }), { jobs: [job] })
  await card(path.join(desk, "alpha", "bad\\name"))
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW, readRemote: () => remote }), { jobs: [job] })
}))

test("at most eight jobs, sorted, and a hundred cards stay within the check's budget", () => scratch(async ({ env, desk }) => {
  const { factoryBootCheck, MAX_FINALIZE_JOBS } = await load()
  assert.equal(MAX_FINALIZE_JOBS, 8)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const jobs = []
  for (let n = 0; n < 100; n += 1) {
    const slug = `task-${String(n).padStart(3, "0")}`
    await card(path.join(desk, `track-${n % 5}`, slug), { extra: `summary: ${"x".repeat(200)}\n` })
    const job = await jobOf(desk, `track-${n % 5}`, slug)
    jobs.push(job)
    await requestFinalize(env, { job, deskRoot: desk })
  }
  let best = Infinity
  let result
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now()
    // The remote read is one constant Git call, not per card; this measures what grows with the desk.
    result = factoryBootCheck({ env, deskRoot: desk, deadline: performance.now() + 100, readRemote: () => null })
    best = Math.min(best, performance.now() - started)
  }
  assert.deepEqual(result.jobs, [...jobs].sort().slice(0, 8))
  assert.ok(best < 100, `100 cards took ${best} ms`)
}))

test("hasContributingStore reads consent without creating anything", () => scratch(async ({ env, base }) => {
  const { hasContributingStore, factoryStateDir } = await load()
  assert.equal(hasContributingStore(env), false)
  assert.equal(existsSync(path.join(base, "state")), false)
  assert.equal(factoryStateDir(env), path.join(base, "state", "ouroboros-skills", "desk", "factory"))
  assert.equal(factoryStateDir({ HOME: base, XDG_STATE_HOME: "~/xdg" }), path.join(base, "xdg", "ouroboros-skills", "desk", "factory"))
  assert.equal(factoryStateDir({ HOME: base }), path.join(base, ".local", "state", "ouroboros-skills", "desk", "factory"))
  await setConsent(env, { store: STORE, contribute: false })
  assert.equal(hasContributingStore(env), false)
  await setConsent(env, { store: "acme/other", contribute: true })
  assert.equal(hasContributingStore(env), true)
  await fs.writeFile(path.join(await factoryStateRoot(env), "consent.json"), "[]")
  assert.equal(hasContributingStore(env), false)
  assert.equal(factoryStateDir({ HOME: "", XDG_STATE_HOME: " " }), path.join(os.homedir(), ".local", "state", "ouroboros-skills", "desk", "factory"))
}))

test("unsafe state files are never followed: a symlinked consent is silent, and an unreadable index or delivery record reads as empty", () => scratch(async ({ env, desk, base }) => {
  const { factoryBootCheck, finishedTasks, hasContributingStore } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await card(path.join(desk, "alpha", "one"))
  const job = await jobOf(desk, "alpha", "one")
  const name = await outboxFile(env, 1)
  await updateJobsIndex(env, job, name)
  await markDelivered(env, STORE, { name, publishedBlobSha: "a".repeat(40) })
  const root = await factoryStateRoot(env)
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] })
  const delivered = path.join(root, "delivered", "ourostack__factory.json")
  await fs.rename(delivered, path.join(base, "delivered.json"))
  await fs.symlink(path.join(base, "delivered.json"), delivered)
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [job] }, "an unreadable delivery record reads as nothing delivered")
  const index = path.join(root, "jobs-index.json")
  await fs.rename(index, path.join(base, "index.json"))
  await fs.symlink(path.join(base, "index.json"), index)
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] }, "an unreadable index reads as empty")
  const consent = path.join(root, "consent.json")
  await fs.rename(consent, path.join(base, "consent.json"))
  await fs.symlink(path.join(base, "consent.json"), consent)
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] })
  assert.equal(hasContributingStore(env), false)
  assert.equal(hasContributingStore(), false)
  assert.deepEqual(factoryBootCheck({ deskRoot: desk }).line, "Factory: this desk hasn't decided whether to contribute measurement data; ask the operator once (desk:session-start)", "the default environment is this process's")
  assert.deepEqual(finishedTasks({ deskRoot: desk, now: NOW }).map(({ slug }) => slug), ["one"])
  const recentDesk = path.join(base, "recent-desk")
  await card(path.join(recentDesk, "alpha", "today"), { updated: new Date().toISOString() })
  assert.deepEqual(finishedTasks({ deskRoot: recentDesk }).map(({ slug }) => slug), ["today"], "the default clock is now")
}))

test("a crew person's finished job is found through its pending request even when DESK_PERSON is not set", () => scratch(async ({ env, base }) => {
  const { factoryBootCheck } = await load()
  const crew = path.join(base, "crew")
  await fs.mkdir(path.join(crew, "_meta"), { recursive: true })
  await card(path.join(crew, "desks", "sam", "beta", "shipped"))
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const job = await jobOf(crew, "beta", "shipped", "desks/sam")
  await requestFinalize(env, { job, deskRoot: crew })
  assert.deepEqual(factoryBootCheck({ env, deskRoot: crew, now: NOW }), { jobs: [job] })
}))

test("labelsBootCheck counts retained evaluation requests only for a contributing store, with or without options", () => scratch(async ({ env, desk }) => {
  const { labelsBootCheck, labelsLine } = await load()
  assert.deepEqual(labelsBootCheck(), { count: 0, quarantined: 0 })
  assert.deepEqual(labelsBootCheck({}), { count: 0, quarantined: 0 })
  assert.deepEqual(labelsBootCheck({ env }), { count: 0, quarantined: 0 })
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const { requestEvaluation } = await import("../../src/factory/outbox.js")
  await requestEvaluation(env, { job: "9f2c4b1a7d3e5f60718293a4b5c6d7e8", deskRoot: desk })
  assert.deepEqual(labelsBootCheck({ env }), { count: 1, quarantined: 0 })
  assert.equal(labelsLine(1), "Factory: 1 finished tasks have no waste labels yet; run the evaluator for them in the background")
}))

test("labelsBootCheck reports quarantined labels, and a request whose every session is held back is not counted as waiting", () => scratch(async ({ env, desk }) => {
  const { labelsBootCheck, labelsQuarantinedLine } = await load()
  const { requestEvaluation } = await import("../../src/factory/outbox.js")
  const OTHER_STORE = "ourostack/other"
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await setConsent(env, { store: OTHER_STORE, contribute: true, account: "contributor" })
  const root = await factoryStateRoot(env)
  const [held, partly, unindexed, broken, old] = ["a1", "b2", "c3", "d4", "e5"].map((prefix) => prefix.repeat(16))
  const labelsKey = (job, n) => `labels/${job}/${sessionId(n)}.json`
  const facts = (n) => `claude-code-${sessionId(n)}.json`
  // `held`: both sessions held back, one in each contributing store.
  await updateJobsIndex(env, held, facts(1))
  await updateJobsIndex(env, held, facts(2))
  await quarantine(env, STORE, labelsKey(held, 1), "facts_quarantined", { facts: facts(1) })
  await quarantine(env, OTHER_STORE, labelsKey(held, 2), "facts_quarantined", { facts: facts(2) })
  await requestEvaluation(env, { job: held, deskRoot: desk })
  // `partly`: one session of two held back; still waiting.
  await updateJobsIndex(env, partly, facts(3))
  await updateJobsIndex(env, partly, "not an outbox name")
  await quarantine(env, STORE, labelsKey(partly, 3), "facts_quarantined", { facts: facts(3) })
  await requestEvaluation(env, { job: partly, deskRoot: desk })
  // `unindexed`: a request with no sessions in the index is waiting.
  await requestEvaluation(env, { job: unindexed, deskRoot: desk })
  // `broken`: a labels quarantine folder with only a stray file and no records is not a quarantined job.
  await fs.mkdir(path.join(root, "quarantine", "ourostack__factory", "labels", broken), { recursive: true })
  await fs.writeFile(path.join(root, "quarantine", "ourostack__factory", "labels", broken, "notes.txt"), "x")
  await fs.writeFile(path.join(root, "quarantine", "ourostack__factory", "labels", "not-a-job"), "x")
  // `old`: quarantined more than 30 days ago, no longer reported.
  await quarantine(env, STORE, labelsKey(old, 5), "too_large")
  const past = new Date(NOW - 40 * DAY)
  await fs.utimes(path.join(root, "quarantine", "ourostack__factory", "labels", old), past, past)

  assert.deepEqual(labelsBootCheck({ env, now: NOW }), { count: 2, quarantined: 2 })
  // Without an index to consult, nothing is held back and every request waits.
  await fs.writeFile(path.join(root, "jobs-index.json"), "not json")
  assert.deepEqual(labelsBootCheck({ env, now: NOW }), { count: 3, quarantined: 2 })
  assert.equal(labelsQuarantinedLine(2), "Factory: 2 finished tasks have quarantined waste labels that will not be delivered; tell the operator (desk:session-start)")
}))
