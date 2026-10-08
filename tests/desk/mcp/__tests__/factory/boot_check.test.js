// The factory boot check: bounded reads of protected state and task-card
// frontmatter only, never a write. Every desk and card here is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, promises as fs, readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { factoryStateRoot, quarantine, requestFinalize, setConsent, writeLocalFacts, markDelivered } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { indexJob } from "./_index_helper.js"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { STORE, json, scratch } from "./_session_helpers.js"

const moduleUrl = new URL("../../../../../plugins/desk/mcp/src/factory/boot-check.js", import.meta.url)
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

test("a store with no consent decision adds no line: the boot script owns the consent question", () => scratch(async ({ env, desk }) => {
  const { factoryBootCheck } = await load()
  assert.equal((await load()).FACTORY_NO_CONSENT_LINE, undefined)
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] })
  await setConsent(env, { store: "acme/other", contribute: true })
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] }, "another store's decision is not this store's")
  const root = await factoryStateRoot(env)
  await fs.writeFile(path.join(root, "consent.json"), "{ not json")
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] }, "unreadable consent stays silent")
  // desk_status reads a consent file whose `stores` is not an object as unreadable, so the boot line stays silent too (review M3-11 D1).
  await fs.writeFile(path.join(root, "consent.json"), JSON.stringify({ schema_version: 1, stores: [] }))
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] }, "a malformed consent file is unreadable, as desk_status reports it")
  await fs.writeFile(path.join(root, "consent.json"), JSON.stringify({ schema_version: 1, stores: { [STORE]: { contribute: "maybe" } } }))
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW }), { jobs: [] }, "a record without a yes or no is undecided, as desk_status reports it")
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
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW, pluginScanIncomplete: true }), { jobs: [] }, "the desk's own declaration decides even when the plugin scan is incomplete")
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
  await indexJob(env, undelivered, await outboxFile(env, 1))
  const deliveredName = await outboxFile(env, 2)
  await indexJob(env, delivered, deliveredName)
  await markDelivered(env, STORE, { name: deliveredName, publishedBlobSha: "a".repeat(40) })
  const quarantinedName = await outboxFile(env, 3)
  await indexJob(env, quarantined, quarantinedName)
  await quarantine(env, STORE, quarantinedName, "date")
  await indexJob(env, missing, `claude-code-${sessionId(9)}.json`)
  await indexJob(env, open, await outboxFile(env, 4))
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

test("a job ID is computed from the resolved birth path, not the card's current path (ourostack/desk#76)", () => scratch(async ({ env, desk }) => {
  const { factoryBootCheck } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await card(path.join(desk, "alpha", "renamed-task"))
  const remote = "https://github.com/acme/desk.git"
  const birthJob = jobId({ deskRemote: remote, personPrefix: "", track: "alpha-original", slug: "renamed-task-original" })
  await requestFinalize(env, { job: birthJob, deskRoot: desk })
  const seen = []
  const resolveIdentity = ({ track, slug }) => {
    seen.push(`${track}/${slug}`)
    return { track: "alpha-original", slug: "renamed-task-original" }
  }
  assert.deepEqual(factoryBootCheck({ env, deskRoot: desk, now: NOW, readRemote: () => remote, resolveIdentity }), { jobs: [birthJob] }, "the pending finalize request filed under the birth path is found from the task's current path")
  assert.deepEqual(seen, ["alpha/renamed-task"], "the resolver is asked about the card's current track/slug")
}))

test("the finalize-repair loop shares its own deadline and clock with resolveIdentity", () => scratch(async ({ env, desk }) => {
  const { factoryBootCheck } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await card(path.join(desk, "alpha", "task"))
  const remote = "https://github.com/acme/desk.git"
  const seen = []
  const clock = () => 42
  const resolveIdentity = (options) => { seen.push(options); return { track: options.track, slug: options.slug } }
  factoryBootCheck({ env, deskRoot: desk, now: NOW, deadline: 999, clock, readRemote: () => remote, resolveIdentity })
  assert.equal(seen[0].deadline, 999, "the loop's own deadline reaches resolveIdentity")
  assert.equal(seen[0].clock, clock, "the loop's own clock reaches resolveIdentity")
}))

test("the finalize-repair loop stops at its deadline before resolving a later task's birth path", () => scratch(async ({ env, desk }) => {
  const { factoryBootCheck } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await card(path.join(desk, "alpha", "first"))
  await card(path.join(desk, "alpha", "second"))
  const remote = "https://github.com/acme/desk.git"
  const seen = []
  let now = 0
  // The first task's own resolution "spends" the whole remaining budget, so the loop's `clock() > deadline` check must catch this before the second task ever reaches resolveIdentity.
  const resolveIdentity = ({ track, slug }) => {
    seen.push(`${track}/${slug}`)
    now = 200
    return { track, slug }
  }
  assert.throws(
    () => factoryBootCheck({ env, deskRoot: desk, now: NOW, deadline: 100, clock: () => now, readRemote: () => remote, resolveIdentity }),
    { code: "boot_check_budget" },
  )
  assert.equal(seen.length, 1, "only the first task was ever asked for its birth path")
}))

test("resolveJobIdentity's own deadline overrun inside the finalize-repair loop is the check's budget error, not a silently skipped task", () => scratch(async ({ env, desk }) => {
  const { factoryBootCheck } = await load()
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await card(path.join(desk, "alpha", "slow"))
  const remote = "https://github.com/acme/desk.git"
  const resolveIdentity = () => { throw Object.assign(new Error("git_deadline"), { code: "git_deadline" }) }
  assert.throws(
    () => factoryBootCheck({ env, deskRoot: desk, now: NOW, deadline: Infinity, clock: () => 0, readRemote: () => remote, resolveIdentity }),
    { code: "boot_check_budget" },
    "a single task's own git_deadline is an overrun of the whole check, never just that one task's",
  )
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
  await indexJob(env, job, name)
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
  assert.deepEqual(factoryBootCheck({ deskRoot: desk }), { jobs: [] }, "the default environment is this process's")
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
  const { labelsBootCheck: labels } = await load()
  const labelsBootCheck = (options) => { const { count, quarantined } = labels(options); return { count, quarantined } }
  assert.deepEqual(labelsBootCheck(), { count: 0, quarantined: 0 })
  assert.deepEqual(labelsBootCheck({}), { count: 0, quarantined: 0 })
  assert.deepEqual(labelsBootCheck({ env }), { count: 0, quarantined: 0 })
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const { requestEvaluation } = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  await requestEvaluation(env, { job: "9f2c4b1a7d3e5f60718293a4b5c6d7e8", deskRoot: desk })
  assert.deepEqual(labelsBootCheck({ env }), { count: 1, quarantined: 0 })
}))

test("labelsBootCheck reports quarantined labels, and a request whose every session is held back is not counted as waiting", () => scratch(async ({ env, desk }) => {
  const { labelsBootCheck: labels } = await load()
  const labelsBootCheck = (options) => { const { count, quarantined } = labels(options); return { count, quarantined } }
  const { requestEvaluation } = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  const OTHER_STORE = "ourostack/other"
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await setConsent(env, { store: OTHER_STORE, contribute: true, account: "contributor" })
  const root = await factoryStateRoot(env)
  const [held, partly, unindexed, broken, old] = ["a1", "b2", "c3", "d4", "e5"].map((prefix) => prefix.repeat(16))
  const labelsKey = (job, n) => `labels/${job}/${sessionId(n)}.json`
  const facts = (n) => `claude-code-${sessionId(n)}.json`
  // `held`: both sessions held back, one in each contributing store.
  await indexJob(env, held, facts(1))
  await indexJob(env, held, facts(2))
  await quarantine(env, STORE, labelsKey(held, 1), "facts_quarantined", { facts: facts(1) })
  await quarantine(env, OTHER_STORE, labelsKey(held, 2), "facts_quarantined", { facts: facts(2) })
  await requestEvaluation(env, { job: held, deskRoot: desk })
  // `partly`: one session of two held back; still waiting.
  await indexJob(env, partly, facts(3))
  await indexJob(env, partly, "not an outbox name")
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
}))

test("labelsBootCheck does not report a job whose only quarantined labels were withdrawn as job_unbound", () => scratch(async ({ env }) => {
  const { labelsBootCheck: labels } = await load()
  const quarantined = (options) => labels(options).quarantined
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const root = await factoryStateRoot(env)
  const [withdrawn, mixed, unread] = ["a1", "b2", "c3"].map((prefix) => prefix.repeat(16))
  const labelsKey = (job, n) => `labels/${job}/${sessionId(n)}.json`
  // `withdrawn`: every record is a withdrawal the flush made on purpose, which clears itself if the session binds the job again.
  await quarantine(env, STORE, labelsKey(withdrawn, 1), "job_unbound")
  await quarantine(env, STORE, labelsKey(withdrawn, 2), "job_unbound")
  assert.equal(quarantined({ env, now: NOW }), 0)
  // `mixed`: one withdrawal and one refusal; the refusal is still reported.
  await quarantine(env, STORE, labelsKey(mixed, 3), "job_unbound")
  await quarantine(env, STORE, labelsKey(mixed, 4), "facts_quarantined", { facts: `claude-code-${sessionId(4)}.json` })
  assert.equal(quarantined({ env, now: NOW }), 1)
  // `unread`: a record that does not read is not known to be a withdrawal, so it is reported.
  await quarantine(env, STORE, labelsKey(unread, 5), "job_unbound")
  await fs.writeFile(path.join(root, "quarantine", "ourostack__factory", labelsKey(unread, 5)), "not json")
  assert.equal(quarantined({ env, now: NOW }), 2)
}))

test("andonBootCheck returns the recorded open andon issues of each contributing store", () => scratch(async ({ env }) => {
  const { andonBootCheck } = await load()
  assert.deepEqual(andonBootCheck({ env }), [])
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await setConsent(env, { store: "acme/declined", contribute: false, account: "contributor" })
  await setConsent(env, { store: "acme/work", contribute: true, account: "worker" })
  // No status yet: nothing.
  assert.deepEqual(andonBootCheck({ env }), [])
  const root = await factoryStateRoot(env)
  const issue = (number) => ({ number, title: `Andon: desk 3.4.0 tool_failures other` })
  await fs.writeFile(path.join(root, "status.json"), JSON.stringify({
    last_flush: {},
    andon: {
      [STORE]: { checked_at: iso(NOW), issues: [issue(12), { number: 0 }, "x", issue(15)] },
      "acme/declined": { checked_at: iso(NOW), issues: [issue(3)] },
      "acme/work": { checked_at: iso(NOW), issues: [] },
    },
  }))
  assert.deepEqual(andonBootCheck({ env }), [{ store: STORE, issues: [issue(12), issue(15)] }])
  // A malformed record, a malformed andon map or unreadable status gives nothing.
  await fs.writeFile(path.join(root, "status.json"), JSON.stringify({ last_flush: {}, andon: { [STORE]: { issues: "no" }, "acme/work": null } }))
  assert.deepEqual(andonBootCheck({ env }), [])
  await fs.writeFile(path.join(root, "status.json"), JSON.stringify({ last_flush: {}, andon: [] }))
  assert.deepEqual(andonBootCheck({ env }), [])
  await fs.writeFile(path.join(root, "status.json"), "{ not json")
  assert.deepEqual(andonBootCheck({ env }), [])
}))

test("andonUnknown names every contributing store whose andon state is not known, so the boot line is never silent about it", () => scratch(async ({ env }) => {
  const { andonUnknown, andonUnknownLine, ANDON_STALE_MS } = await load()
  assert.deepEqual(andonUnknown({ env, now: NOW }), [], "no contributing store: nothing to know")
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await setConsent(env, { store: "acme/declined", contribute: false, account: "contributor" })
  const root = await factoryStateRoot(env)
  const status = (andon) => fs.writeFile(path.join(root, "status.json"), JSON.stringify({ last_flush: {}, andon }))
  const unknown = () => andonUnknown({ env, now: NOW })
  // Reproduction r4b: no record, an unreadable status.json and a nine-month-old record each read as unknown, never as clear.
  assert.deepEqual(unknown(), [{ store: STORE, since: null, code: "not_refreshed" }], "no status.json yet")
  await fs.writeFile(path.join(root, "status.json"), "{not json")
  assert.deepEqual(unknown(), [{ store: STORE, since: null, code: "status_unreadable" }])
  await status({ [STORE]: { checked_at: iso(NOW - 270 * DAY), issues: [] } })
  assert.deepEqual(unknown(), [{ store: STORE, since: iso(NOW - 270 * DAY), code: "stale" }])
  // Variants: fresh is known; just inside and just past the 72 hours; a misshapen record or map; a future stamp; a failure before and after the last success.
  await status({ [STORE]: { checked_at: iso(NOW - 60000), issues: [] } })
  assert.deepEqual(unknown(), [])
  await status({ [STORE]: { checked_at: iso(NOW - ANDON_STALE_MS), issues: [] } })
  assert.deepEqual(unknown(), [])
  await status({ [STORE]: { checked_at: iso(NOW - ANDON_STALE_MS - 1), issues: [] } })
  assert.equal(unknown()[0].code, "stale")
  await status({ [STORE]: "x" })
  assert.equal(unknown()[0].code, "not_refreshed")
  await fs.writeFile(path.join(root, "status.json"), JSON.stringify({ last_flush: {}, andon: [] }))
  assert.equal(unknown()[0].code, "not_refreshed")
  await status({ [STORE]: { checked_at: iso(NOW + 4 * 60000), issues: [] } })
  assert.deepEqual(unknown(), [], "within the five-minute skew")
  await status({ [STORE]: { checked_at: iso(NOW + 60 * 60000), issues: [] } })
  assert.deepEqual(unknown(), [{ store: STORE, since: null, code: "future_dated" }])
  await status({ [STORE]: { checked_at: iso(NOW - 60000), issues: [], failure: "auth_failed", failed_at: iso(NOW - 120000) } })
  assert.deepEqual(unknown(), [], "a failure before the last success is over")
  await status({ [STORE]: { checked_at: iso(NOW - 60000), issues: [], failure: "auth_failed", failed_at: iso(NOW - 1000) } })
  assert.deepEqual(unknown(), [{ store: STORE, since: iso(NOW - 60000), code: "auth_failed" }])
  await status({ [STORE]: { failure: "config_missing", failed_at: iso(NOW - 1000) } })
  assert.deepEqual(unknown(), [{ store: STORE, since: null, code: "config_missing" }])
  await status({ [STORE]: { failure: "Not A Code", failed_at: iso(NOW - 1000) } })
  assert.deepEqual(unknown(), [{ store: STORE, since: null, code: "not_refreshed" }], "a failure that is not a code is not repeated")
  await status({ [STORE]: { checked_at: iso(NOW - 60000), failure: "auth_failed", failed_at: "garbage" } })
  assert.deepEqual(unknown(), [])
  // The default clock is the real one.
  await status({ [STORE]: { checked_at: new Date().toISOString(), issues: [] } })
  assert.deepEqual(andonUnknown({ env }), [])
  assert.equal(andonUnknownLine({ store: STORE, since: null, code: "not_refreshed" }), "Factory: andon state unknown for ourostack/factory (never refreshed) (not_refreshed)")
  assert.equal(andonUnknownLine({ store: STORE, since: "2026-01-01T00:00:00.000Z", code: "stale" }), "Factory: andon state unknown for ourostack/factory since 2026-01-01 (stale)")
  // Review finding 12: a consent file that cannot be read hides which stores contribute; that is said, never read as none.
  await fs.writeFile(path.join(root, "consent.json"), "{broken")
  assert.deepEqual(andonUnknown({ env, now: NOW }), [{ store: null, since: null, code: "consent_unreadable" }])
  assert.equal(andonUnknownLine(andonUnknown({ env, now: NOW })[0]), "Factory: andon state unknown (consent_unreadable): consent.json cannot be read, so the stores this machine contributes to are unknown")
}))

test("allTasks lists every readable card, live and archived, with no status or age filter, under the person prefix", () => scratch(async ({ desk }) => {
  const { allTasks } = await load()
  await card(path.join(desk, "live", "one"), { status: "active", updated: iso(NOW - 400 * DAY) })
  await card(path.join(desk, "live", "_archive", "two"), { status: "done", extra: "factory_report_unavailable: visibility_not_known\n" })
  await card(path.join(desk, "_archive", "gone", "three"), { status: "cancelled", extra: `factory_report: >-\n  https://github.com/ourostack/factory/blob/reports/jobs/${"ab".repeat(16)}.md\n` })
  await card(path.join(desk, "live", "inline"), { extra: `factory_report: https://github.com/ourostack/factory/blob/reports/jobs/${"cd".repeat(16)}.md\n` })
  await card(path.join(desk, "live", "quoted"), { extra: `factory_report: "https://github.com/ourostack/factory/blob/reports/jobs/${"ef".repeat(16)}.md"\n` })
  await card(path.join(desk, "live", "odd"), { extra: "factory_report: https://example.test/not-a-report\n" })
  await card(path.join(desk, "_archive", "gone", "_archive", "four"), { status: "drafting" })
  await card(path.join(desk, "desks", "bo", "theirs", "five"))
  await card(path.join(desk, "_meta", "ignored"))
  await fs.mkdir(path.join(desk, "live", "empty"), { recursive: true })
  await fs.mkdir(path.join(desk, "live", "bare"), { recursive: true })
  await fs.writeFile(path.join(desk, "live", "bare", "task.md"), "no frontmatter\n")
  const found = allTasks({ deskRoot: desk }).map(({ track, slug, archived, status }) => `${track}/${slug} ${archived} ${status}`).sort()
  assert.deepEqual(found, ["gone/four true drafting", "gone/three true cancelled", "live/bare false null", "live/inline false done", "live/odd false done", "live/one false active", "live/quoted false done", "live/two true done"])
  assert.deepEqual(allTasks({ deskRoot: desk }).filter((task) => task.report_job !== null).map(({ slug, report_job }) => `${slug} ${report_job}`).sort(), [`inline ${"cd".repeat(16)}`, `quoted ${"ef".repeat(16)}`, `three ${"ab".repeat(16)}`])
  assert.equal(allTasks({ deskRoot: desk })[0].updated !== undefined, true)
  assert.deepEqual(allTasks({ deskRoot: desk }).filter((task) => task.report_unavailable !== null).map(({ slug, report_unavailable }) => `${slug} ${report_unavailable}`), ["two visibility_not_known"])
  assert.deepEqual(allTasks({ deskRoot: desk, personPrefix: "desks/bo" }).map(({ track, slug }) => `${track}/${slug}`), ["theirs/five"])
  assert.throws(() => allTasks({ deskRoot: desk, personPrefix: "bo" }), /personPrefix/)
}))
