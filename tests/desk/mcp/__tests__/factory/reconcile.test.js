// `factory reconcile`: a fixture desk with dated commits, a fixture factory state folder and a fixture store, all
// under a temp folder. Every desk, card and session here is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { jobId, normalizeRemote, taskCommitRule } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { BINDING_VERSION } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import { factoryStateRoot, markDelivered, quarantine, setConsent, writeLocalFacts, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { keyedJobId, publishedFileName, serializePublished, toPublished } from "../../../../../plugins/desk/mcp/src/factory/publish.js"
import { RECONCILE_REASONS } from "../../../../../plugins/desk/mcp/src/factory/reconcile-reasons.js"
import { reconcile as reconcileOnce } from "../../../../../plugins/desk/mcp/src/factory/reconcile.js"
import { main, runReconcileCommand, SUPPORTED_COMMANDS } from "../../../../../plugins/desk/mcp/scripts/factory.js"
import { SENTINEL, STORE, scratch } from "./_session_helpers.js"

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const SINCE = "2026-09-25T00:00:00.000Z"
const UNTIL = "2026-09-26T00:00:00.000Z"
const OTHER = "acme/other"
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const blob = (n) => n.toString(16).padStart(40, "0")

function git(desk, args, date = "2026-09-20T00:00:00Z") {
  return execFileSync("git", ["-C", desk, "-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ["ignore", "pipe", "pipe"],
  })
}

function cardText({ status = "processing", updated = "2026-09-20T00:00:00.000Z", title = "Synthetic", created = "2026-09-20T00:00:00.000Z" } = {}) {
  return `---\ntitle: ${title}\nstatus: ${status}\n${created === null ? "" : `created: ${created}\n`}updated: ${updated}\n---\n\nBody ${SENTINEL}\n`
}

// A desk that is its own Git repository, with a `commit(date, files, message)` that writes files (null deletes) and commits at `date`.
async function makeDesk(desk, { remote = null } = {}) {
  git(desk, ["init", "-q", "-b", "main"])
  if (remote !== null) git(desk, ["remote", "add", "origin", remote])
  return {
    write(files) {
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(desk, file)), { recursive: true })
        writeFileSync(path.join(desk, file), content)
      }
    },
    commit(date, files, message = "work") {
      this.write(files)
      git(desk, ["add", "-A"])
      git(desk, ["commit", "-q", "-m", message], date)
    },
    mv(date, from, to, edits = {}) {
      mkdirSync(path.dirname(path.join(desk, to)), { recursive: true })
      git(desk, ["mv", from, to])
      this.write(edits)
      git(desk, ["add", "-A"])
      git(desk, ["commit", "-q", "-m", "move"], date)
    },
  }
}

// Every reason any test here sees; the last test checks the whole vocabulary was reached.
const REACHED = new Set()
function reconcile(options) {
  const result = reconcileOnce(options)
  for (const item of result.mismatches ?? []) REACHED.add(item.reason)
  return result
}

const deskRemote = (desk, remote) => remote ?? `local:${desk}`
const jobOf = (desk, track, slug, remote = null) => jobId({ deskRemote: deskRemote(desk, remote), personPrefix: "", track, slug })

// One bound session: local facts in the outbox, a marker, a log and the delivery state.
async function addSession({ base, desk, env }, n, track, slug, options = {}) {
  const {
    store = STORE, markerStore = STORE, host = "claude-code", receipt = BINDING_VERSION, delivered = true, held = null, log = true, remote = null, marker = true, status = "processing", markerOptions = {},
    agents = null, segments = null, span = null, noJobs = false, boundBy, ownActivity, focusDisagrees = false, receiptFields = {},
  } = options
  const id = sessionId(n)
  const name = `${host}-${id}.json`
  const facts = structuredClone(GOLDEN)
  facts.session.id = id
  facts.session.host = host
  const job = jobOf(desk, track, slug, remote)
  facts.jobs = [{ job, basis: ["desk_tool"], task_created_at: "2026-09-20T00:00:00.000Z", transitions: [], observed: { status, at: null }, ...(agents === null ? {} : { agents }), ...(segments === null ? {} : { segments }) }]
  if (noJobs) facts.jobs = []
  if (span !== null) Object.assign(facts.session, span)
  const root = await factoryStateRoot(env)
  if (!(await readConsent(env)).stores[store]) await setConsent(env, { store, contribute: true })
  const written = await writeLocalFacts(env, store, facts)
  assert.equal(written.written, true, JSON.stringify(written.errors))
  const slugOf = store.replace("/", "__")
  if (delivered) await markDelivered(env, store, { name, publishedBlobSha: blob(n) })
  if (held !== null) await quarantine(env, store, name, held)
  // `boundBy`: "focus", "inferred", "none" (a receipt that binds no worker 0 here) or left out (no `bound_by` at all).
  const receiptJob = {
    ...(boundBy === undefined ? {} : { bound_by: boundBy === "none" ? {} : { [job]: boundBy } }),
    ...(ownActivity === undefined ? {} : { own_activity: ownActivity, desk_root: desk }),
    ...(focusDisagrees ? { focus_disagrees: [job] } : {}),
    ...receiptFields,
  }
  if (receipt !== null) await writeStatus(env, { derivations: { [name]: { store, marker: "m", binding_version: receipt, ...receiptJob, size: 1, mtime: 1, ino: 1, dev: 1 } } })
  const logPath = path.join(base, "logs", `${n}.jsonl`)
  if (log) {
    await mkdir(path.dirname(logPath), { recursive: true })
    await writeFile(logPath, `${SENTINEL}\n`)
  }
  if (marker) {
    await writeMarker(root, { name, host, id, desk, logPath, store: markerStore, ...markerOptions })
  }
  return { name, slug: slugOf }
}

async function readConsent(env) {
  const { readConsent: read } = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  return read(env)
}

async function writeMarker(root, { name, host, id, desk, logPath, store, deskRoot = desk, endedAt = "2026-09-25T09:30:00.000Z", routing = true }) {
  await mkdir(path.join(root, "markers"), { recursive: true })
  await writeFile(path.join(root, "markers", name), JSON.stringify({
    schema_version: 1, host, session_id: id, log_path: logPath, cwd: desk, desk_root: deskRoot, end_reason: null,
    ended_at: endedAt, plugins: [], updated_at: "2026-09-25T09:30:00.000Z",
    ...(routing ? { routing: { store, source: "default", warnings: [] } } : {}),
  }))
}

// The standard desk: one seed commit, then dated work on 2026-09-25.
async function standardDesk(desk, slugs) {
  const repo = await makeDesk(desk)
  const files = {}
  for (const [track, slug, options] of slugs) files[`${track}/${slug}/task.md`] = cardText(options)
  repo.commit("2026-09-20T00:00:00Z", files, "seed")
  return repo
}

const mismatchOf = (result, slug) => result.mismatches.filter((item) => item.slug === slug)
const reasonsOf = (result, slug) => mismatchOf(result, slug).map((item) => item.reason)

test("the reason list is the fourteen codes, once each, in pipeline order", () => {
  assert.equal(RECONCILE_REASONS.length, 14)
  assert.equal(new Set(RECONCILE_REASONS).size, 14)
  assert.deepEqual([...RECONCILE_REASONS], ["not_bound", "not_opted_in", "route_changed", "held", "log_missing", "stale_binding", "focus_disagrees", "not_delivered", "quarantined", "pr_open", "card_missing", "invalid_status", "status_unobserved", "store_only"])
  assert.ok(SUPPORTED_COMMANDS.includes("reconcile"))
})

test("a real commit with a bound, delivered session is no mismatch; every other class gets its reason", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, [
    ["t", "matched"], ["t", "nomarker"], ["t", "tidy"], ["t", "old-name"], ["t", "m1"], ["t", "m2"], ["t", "m3"], ["t", "m4"],
    ["t", "stale"], ["t", "routed"], ["t", "quar"], ["t", "undelivered"], ["t", "logless"], ["t", "badstatus", { status: "active" }],
    ["t", "badboth", { status: "Needs Rest" }], ["t", "noreceipt"], ["t", "quarbare"], ["t", "twosess"], ["t", "okplus"], ["t", "noroute"], ["t", "nodeskroot"], ["t", "rn-old"],
  ])
  repo.write({ "t/rn-old/doc.md": "A long enough document that a small edit keeps it recognizable as the same file.\n".repeat(20) })
  git(desk, ["add", "-A"])
  git(desk, ["commit", "-q", "-m", "doc"], "2026-09-20T00:00:00Z")
  const day = (hour) => `2026-09-25T${hour}:00:00Z`
  repo.commit(day("10"), { "t/matched/work.md": "real\n" })
  repo.commit(day("11"), { "t/nomarker/work.md": "real\n" })
  repo.commit(day("12"), { "t/tidy/task.md": cardText({ updated: "2026-09-25T12:00:00.000Z" }) }, "tidy")
  repo.mv(day("13"), "t/old-name", "t/new-name")
  repo.commit(day("14"), Object.fromEntries(["m1", "m2", "m3", "m4"].map((slug) => [`t/${slug}/work.md`, "swept\n"])), "sweep")
  for (const slug of ["stale", "routed", "quar", "undelivered", "logless", "badstatus", "badboth", "noreceipt", "quarbare", "twosess", "okplus", "noroute", "nodeskroot"]) repo.commit(day("15"), { [`t/${slug}/work.md`]: "real\n" })
  repo.mv(day("16"), "t/rn-old", "t/rn-new", { "t/rn-new/doc.md": `${"A long enough document that a small edit keeps it recognizable as the same file.\n".repeat(20)}one more line\n` })

  await addSession(context, 1, "t", "matched")
  await addSession(context, 2, "t", "stale", { receipt: 3 })
  await addSession(context, 3, "t", "routed", { store: OTHER })
  await addSession(context, 4, "t", "quar", { held: "implausible_session_span" })
  await addSession(context, 5, "t", "undelivered", { delivered: false })
  await addSession(context, 6, "t", "logless", { log: false })
  await addSession(context, 7, "t", "badstatus", { status: "processing" })
  await addSession(context, 8, "t", "badboth", { receipt: 3 })
  await addSession(context, 9, "t", "noreceipt", { receipt: null })
  const quarbare = await addSession(context, 10, "t", "quarbare", { held: "x" })
  const root = await factoryStateRoot(env)
  await writeFile(path.join(root, "quarantine", quarbare.slug, quarbare.name), JSON.stringify({ reason: "NOT A CODE!" }))
  await addSession(context, 11, "t", "twosess", { receipt: 3 })
  await addSession(context, 12, "t", "twosess", { delivered: false })
  await addSession(context, 13, "t", "twosess", { receipt: 3 })
  await addSession(context, 14, "t", "okplus", { receipt: 3 })
  await addSession(context, 15, "t", "okplus")
  await addSession(context, 16, "t", "noroute", { markerOptions: { routing: false, endedAt: null } })
  await addSession(context, 17, "t", "nodeskroot", { markerOptions: { deskRoot: null } })
  // Outbox files this report must read past: a session before the window, and entries that bind no valid job.
  const earlier = structuredClone(GOLDEN)
  earlier.session.id = sessionId(20)
  earlier.session.started_at = "2026-09-10T08:00:00.000Z"
  earlier.session.derived_through = "2026-09-10T09:00:00.000Z"
  earlier.jobs = [{ job: jobOf(desk, "t", "tidy") }, { job: "not-a-job" }, 7]
  await writeFile(path.join(root, "outbox", "ourostack__factory", `claude-code-${sessionId(20)}.json`), JSON.stringify(earlier))
  // A marker for some other desk, which is not this desk's.
  await writeMarker(root, { name: `claude-code-${sessionId(21)}.json`, host: "claude-code", id: sessionId(21), desk, logPath: "/x", store: STORE, deskRoot: "/nonexistent/other/desk" })

  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.equal(result.ok, true)
  assert.deepEqual(result.warnings, undefined)
  assert.deepEqual(reasonsOf(result, "matched"), [])
  assert.deepEqual(reasonsOf(result, "nomarker"), ["not_bound"])
  assert.equal(mismatchOf(result, "nomarker")[0].detail, "unbound_markers_0")
  assert.deepEqual(reasonsOf(result, "tidy"), [], "a card-only edit is housekeeping, not a mismatch")
  assert.deepEqual(reasonsOf(result, "new-name"), [], "a pure rename is housekeeping, and the old path folds into the renamed task")
  assert.deepEqual(reasonsOf(result, "old-name"), [])
  assert.deepEqual(reasonsOf(result, "rn-old"), [])
  for (const slug of ["m1", "m2", "m3", "m4"]) assert.deepEqual(reasonsOf(result, slug), [], "a mass commit counts for no task")
  assert.deepEqual(reasonsOf(result, "stale"), ["stale_binding"])
  assert.equal(mismatchOf(result, "stale")[0].detail, "binding_version_3")
  assert.deepEqual(reasonsOf(result, "routed"), ["route_changed"])
  assert.deepEqual(reasonsOf(result, "quar"), ["quarantined"])
  assert.equal(mismatchOf(result, "quar")[0].detail, "refused_implausible_session_span")
  assert.deepEqual(reasonsOf(result, "undelivered"), ["not_delivered"])
  assert.deepEqual(reasonsOf(result, "logless"), ["log_missing"])
  assert.deepEqual(reasonsOf(result, "badstatus"), ["invalid_status"], "an invalid status is a mismatch even when everything else matches")
  assert.deepEqual(reasonsOf(result, "badboth"), ["stale_binding", "invalid_status"], "an invalid status is reported beside any other reason")
  assert.equal(mismatchOf(result, "noreceipt")[0].detail, "binding_version_none")
  assert.deepEqual(reasonsOf(result, "quarbare"), ["quarantined"])
  assert.equal(mismatchOf(result, "quarbare")[0].detail, "refused_other", "a reason that is not a known refusal code is printed as other")
  assert.deepEqual(mismatchOf(result, "twosess").map((item) => item.reason), ["not_delivered"], "the session furthest along the pipeline explains the task")
  assert.deepEqual(reasonsOf(result, "okplus"), [], "one good session is enough")
  assert.deepEqual(reasonsOf(result, "noroute"), [], "a marker with no recorded route routes where the desk does")
  assert.deepEqual(reasonsOf(result, "nodeskroot"), ["held"])
  assert.equal(mismatchOf(result, "nodeskroot")[0].detail, "no_desk_root")
  assert.deepEqual(reasonsOf(result, "rn-new"), ["not_bound"], "a renamed folder with a real edit is real work, and its job is the birth path's")
  assert.equal(result.tasks.find((task) => task.slug === "rn-new").job, jobOf(desk, "t", "rn-old"))
  assert.equal(result.counts.tasks, result.tasks.length)
  assert.equal(result.counts.mismatched, result.mismatches.length)
  assert.equal(result.counts.matched, result.tasks.filter((task) => !result.mismatches.some((item) => item.slug === task.slug)).length)
  assert.equal(result.counts.by_reason.mechanical_only, undefined)
  assert.deepEqual(result.housekeeping_cards, ["m1", "m2", "m3", "m4", "new-name", "tidy"].map((slug) => ({ track: "t", slug })), "cards touched only by housekeeping are listed apart from the tasks")
  for (const slug of ["tidy", "new-name", "m1", "m2", "m3", "m4"]) assert.ok(!result.tasks.some((task) => task.slug === slug), `${slug} has no real work`)
  assert.ok(result.tasks.find((task) => task.slug === "matched").activity.some((item) => item.kind === "commit" && item.class === "real"))
  assert.ok(result.tasks.find((task) => task.slug === "matched").activity.some((item) => item.kind === "session"))
  assert.equal(result.desk.person, null)
  assert.deepEqual(result.window, { since: SINCE, until: UNTIL })
  for (const item of result.mismatches) assert.ok(RECONCILE_REASONS.includes(item.reason))
}))

test("an open intake pull request is pr_open, and the store having the job clears it", () => scratch(async (context) => {
  const { desk, env, base } = context
  const repo = await standardDesk(desk, [["t", "open"], ["t", "merged"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/open/work.md": "x\n", "t/merged/work.md": "x\n" })
  await addSession(context, 1, "t", "open")
  await writeStatus(env, { last_flush: { [STORE]: { at: "2026-09-25T10:00:00.000Z", result: "delivered_pr_open", pr: 7 } } })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(reasonsOf(result, "open"), ["pr_open"])
  assert.equal(mismatchOf(result, "open")[0].detail, "pr_7_unchecked", "without --store the open pull request is not checked against the store")
  const checked = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: path.join(base, "store"), env })
  assert.equal(mismatchOf(checked, "open")[0].detail, "pr_7", "with --store it is")
  await writeStatus(env, { last_flush: { [STORE]: { at: "2026-09-25T10:00:00.000Z", result: "delivered_pr_open" } } })
  assert.equal(mismatchOf(reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env }), "open")[0].detail, "pr_open")
  assert.ok(base)
}))

test("a marker routed to a store with no consent is not_opted_in, and a store-less desk declaration is held", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, [["t", "nope"], ["t", "decl"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/nope/work.md": "x\n", "t/decl/work.md": "x\n" })
  const root = await factoryStateRoot(env)
  const logPath = path.join(desk, "..", "log.jsonl")
  await writeFile(logPath, SENTINEL)
  await writeMarker(root, { name: `claude-code-${sessionId(1)}.json`, host: "claude-code", id: sessionId(1), desk, logPath, store: "acme/unconsented" })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(reasonsOf(result, "nope"), ["not_bound"])
  assert.deepEqual(result.unbound_markers, [{ session: `claude-code-${sessionId(1)}`, reason: "not_opted_in", detail: "store_without_consent" }])
  await writeFile(path.join(root, "markers", `claude-code-${sessionId(1)}.json`), JSON.stringify({
    schema_version: 1, host: "claude-code", session_id: sessionId(1), log_path: logPath, cwd: desk, desk_root: desk, end_reason: null,
    ended_at: "2026-09-25T09:30:00.000Z", plugins: [], updated_at: "2026-09-25T09:30:00.000Z",
    routing: { store: null, source: "invalid_declaration", warnings: [] },
  }))
  const declared = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.equal(mismatchOf(declared, "decl")[0].reason, "not_bound")
  assert.deepEqual(declared.unbound_markers, [{ session: `claude-code-${sessionId(1)}`, reason: "held", detail: "store_unresolved" }])
}))

test("a default-routed Codex marker nothing proves is held as route_unverified; a Claude marker for the desk releases it", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, [["t", "codex"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/codex/work.md": "x\n" })
  await setConsent(env, { store: STORE, contribute: true })
  const root = await factoryStateRoot(env)
  const logPath = path.join(desk, "..", "rollout.jsonl")
  await writeFile(logPath, SENTINEL)
  await writeMarker(root, { name: `codex-cli-${sessionId(2)}.json`, host: "codex-cli", id: sessionId(2), desk, logPath, store: STORE })
  const held = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(mismatchOf(held, "codex").map(({ reason, detail }) => ({ reason, detail })), [{ reason: "not_bound", detail: "unbound_markers_1" }], "an unbound marker is never blamed on the task")
  assert.deepEqual(held.unbound_markers, [{ session: `codex-cli-${sessionId(2)}`, reason: "held", detail: "route_unverified" }])
  await writeMarker(root, { name: `claude-code-${sessionId(3)}.json`, host: "claude-code", id: sessionId(3), desk, logPath, store: STORE })
  const released = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(reasonsOf(released, "codex"), ["not_bound"], "no bound session, and neither marker has a problem")
  assert.equal(mismatchOf(released, "codex")[0].detail, "unbound_markers_2")
  assert.deepEqual(released.unbound_markers.map((item) => item.reason), [null, null])
  assert.deepEqual(released.unbound_markers.map((item) => item.detail), ["marker_not_bound", "marker_not_bound"])
}))

test("a task with no card is card_missing, a marker with a missing desk root is held, and a desk with no markers is not_bound", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, [["t", "kept"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/kept/work.md": "x\n", "t/gone/work.md": "x\n", "_friction/note.md": "not a task\n", "t/track.md": "x\n" })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(reasonsOf(result, "gone"), ["card_missing"])
  assert.deepEqual(reasonsOf(result, "kept"), ["not_bound"])
  assert.equal(mismatchOf(result, "kept")[0].detail, "unbound_markers_0")
  assert.equal(result.tasks.length, 2, "only task folders are tasks")
  const root = await factoryStateRoot(env)
  await mkdir(path.join(root, "markers"), { recursive: true })
  await writeFile(path.join(root, "markers", `claude-code-${sessionId(1)}.json`), JSON.stringify({
    schema_version: 1, host: "claude-code", session_id: sessionId(1), log_path: path.join(desk, "x.jsonl"), cwd: desk, desk_root: null, end_reason: null,
    ended_at: "2026-09-25T09:30:00.000Z", plugins: [], updated_at: "2026-09-25T09:30:00.000Z",
  }))
  assert.equal(reasonsOf(reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env }), "kept")[0], "not_bound", "a marker with no desk root is not this desk's")
}))

test("a crew desk reads desks/<alias> only", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await makeDesk(desk)
  repo.commit("2026-09-20T00:00:00Z", { "desks/ari/t/mine/task.md": cardText(), "desks/bo/t/theirs/task.md": cardText(), "t/root/task.md": cardText() }, "seed")
  repo.commit("2026-09-25T10:00:00Z", { "desks/ari/t/mine/work.md": "x\n", "desks/bo/t/theirs/work.md": "x\n", "t/root/work.md": "x\n" })
  const result = reconcile({ deskRoot: desk, personPrefix: "desks/ari", since: SINCE, until: UNTIL, env })
  assert.deepEqual(result.mismatches.map((item) => item.slug), ["mine"])
  assert.equal(result.desk.person, "ari")
  assert.equal(reconcile({ deskRoot: desk, personPrefix: "desks", since: SINCE, until: UNTIL, env }).ok, false)
}))

// A store checkout with the facts of the given local facts, published the way a flush publishes them.
function publishTo(storeDir, local, options) {
  const { published } = toPublished(local, { visibility: () => "public", storeVisibility: "public", ...options })
  mkdirSync(path.join(storeDir, "facts"), { recursive: true })
  writeFileSync(path.join(storeDir, "facts", publishedFileName(published)), serializePublished(published))
  return published
}

function localFor(n, job, { created = "2026-09-20T00:00:00.000Z" } = {}) {
  const facts = structuredClone(GOLDEN)
  facts.session.id = sessionId(n)
  facts.jobs = [{ job, basis: ["desk_tool"], task_created_at: created, transitions: [], observed: { status: "processing", at: null } }]
  return facts
}

test("a store job in the window with no desk activity is store_only; a private desk places it with the card's created plus the offset", () => scratch(async (context) => {
  const { desk, env, base } = context
  const remote = "https://github.com/acme/desk.git"
  const repo = await makeDesk(desk, { remote })
  repo.commit("2026-09-20T00:00:00Z", { "t/idle/task.md": cardText(), "t/early/task.md": cardText(), "t/busy/task.md": cardText(), "t/nocreated/task.md": cardText({ created: null }), "t/idle2/task.md": cardText() }, "seed")
  repo.commit("2026-09-25T10:00:00Z", { "t/busy/work.md": "x\n", "t/idle/task.md": cardText({ updated: "2026-09-25T10:00:00.000Z" }) })
  const root = await factoryStateRoot(env)
  await writeFile(path.join(root, "visibility.json"), JSON.stringify({ "acme/desk": { visibility: "private", checked_at: "2026-09-25T00:00:00.000Z" } }))
  const store = path.join(base, "store")
  const idle = jobOf(desk, "t", "idle", remote)
  const early = jobOf(desk, "t", "early", remote)
  const busy = jobOf(desk, "t", "busy", remote)
  publishTo(store, localFor(1, idle), { deskVisibility: "private" })
  publishTo(store, { ...localFor(2, early), session: { ...localFor(2, early).session, started_at: "2026-09-10T08:00:00.000Z", ended_at: "2026-09-10T09:30:00.000Z", derived_through: "2026-09-10T09:30:00.000Z" } }, { deskVisibility: "private" })
  publishTo(store, localFor(3, busy), { deskVisibility: "private" })
  publishTo(store, localFor(4, jobOf(desk, "t", "nocreated", remote), { created: null }), { deskVisibility: "private" })
  publishTo(store, localFor(5, busy), { deskVisibility: "private" })
  publishTo(store, localFor(6, jobOf(desk, "t", "idle2", remote)), { deskVisibility: "private" })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: store, env })
  assert.equal(result.ok, true)
  assert.deepEqual(result.warnings, undefined)
  assert.deepEqual(result.mismatches.filter((item) => item.reason === "store_only").map((item) => item.slug), ["idle", "idle2"], "a store session before the window, or with no card time to place it by, is not store_only")
  assert.equal(result.tasks.find((task) => task.slug === "idle").store.sessions, 1)
  assert.equal(result.tasks.find((task) => task.slug === "busy").store.sessions, 2)
  assert.deepEqual(reasonsOf(result, "idle"), ["store_only"], "a card-only edit is no real work, so the store's session is the only mismatch")
  assert.ok(!result.housekeeping_cards.some((card) => card.slug === "idle"), "a card listed in tasks is not listed as housekeeping")
  assert.equal(result.tasks.find((task) => task.slug === "idle2").activity.length, 0)
  assert.deepEqual(reasonsOf(result, "busy"), ["not_bound"])
  const bare = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(bare.mismatches.map((item) => item.reason), ["not_bound"], "without --store the store is not read")
  assert.deepEqual(bare.housekeeping_cards, [{ track: "t", slug: "idle" }], "the idle card is housekeeping when nothing places a store session")
  assert.deepEqual(bare.tasks[0].store, { checked: false })
}))

test("a store job the desk does not know is store_only with no track or slug, placed by this machine's local facts", () => scratch(async (context) => {
  const { desk, env, base } = context
  const remote = "https://github.com/acme/desk.git"
  const repo = await makeDesk(desk, { remote })
  repo.commit("2026-09-20T00:00:00Z", { "t/known/task.md": cardText() }, "seed")
  const root = await factoryStateRoot(env)
  await writeFile(path.join(root, "visibility.json"), JSON.stringify({ "ACME/Desk": { visibility: "internal", checked_at: "2026-09-25T00:00:00.000Z" } }))
  const stranger = "00000000000000000000000000000001"
  await setConsent(env, { store: STORE, contribute: true })
  const local = localFor(9, stranger)
  assert.equal((await writeLocalFacts(env, STORE, local)).written, true)
  const store = path.join(base, "store")
  publishTo(store, local, { deskVisibility: "private" })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: store, env })
  assert.deepEqual(result.mismatches.map(({ track, slug, job, reason }) => ({ track, slug, job, reason })), [{ track: null, slug: null, job: stranger, reason: "store_only" }])
}))

test("a private desk prints the plain id of a store job it cannot map, which is public in the store", () => scratch(async (context) => {
  const { desk, env, base } = context
  const repo = await makeDesk(desk, { remote: "https://github.com/acme/desk.git" })
  repo.commit("2026-09-20T00:00:00Z", { "t/known/task.md": cardText() }, "seed")
  const root = await factoryStateRoot(env)
  await writeFile(path.join(root, "visibility.json"), JSON.stringify({ "acme/desk": { visibility: "private", checked_at: "2026-09-25T00:00:00.000Z" } }))
  await setConsent(env, { store: STORE, contribute: true })
  assert.equal((await writeLocalFacts(env, STORE, localFor(9, "00000000000000000000000000000001"))).written, true)
  const store = path.join(base, "store")
  const other = "00000000000000000000000000000002"
  publishTo(store, localFor(9, other), { deskVisibility: "private" })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: store, env })
  assert.deepEqual(result.mismatches.map(({ track, slug, job, reason }) => ({ track, slug, job, reason })), [{ track: null, slug: null, job: other, reason: "store_only" }])
}))

test("a public desk's keyed store job matches its local job, and the secret never appears", () => scratch(async (context) => {
  const { desk, env, base } = context
  const remote = "https://github.com/acme/public-desk.git"
  const repo = await makeDesk(desk, { remote })
  repo.commit("2026-09-20T00:00:00Z", { "t/shared/task.md": cardText(), "t/quiet/task.md": cardText(), "t/tidy/task.md": cardText() }, "seed")
  repo.commit("2026-09-25T10:00:00Z", { "t/shared/work.md": "x\n", "t/tidy/task.md": cardText({ updated: "2026-09-25T10:00:00.000Z" }) })
  const root = await factoryStateRoot(env)
  const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 7 + 11) % 256))
  writeFileSync(path.join(root, "machine-secret"), secret)
  chmodSync(path.join(root, "machine-secret"), 0o600)
  await writeFile(path.join(root, "visibility.json"), JSON.stringify({ "acme/public-desk": { visibility: "public", checked_at: "2026-09-25T00:00:00.000Z" } }))
  await addSession(context, 1, "t", "shared", { remote })
  const plain = jobOf(desk, "t", "shared", remote)
  const quiet = jobOf(desk, "t", "quiet", remote)
  const store = path.join(base, "store")
  const published = publishTo(store, localFor(1, plain), { deskVisibility: "public", machineSecret: new Uint8Array(secret) })
  assert.equal(published.jobs[0].job, keyedJobId(plain, new Uint8Array(secret)))
  // Another machine's session of an idle task: keyed, with no timing, and nothing here to place it by.
  publishTo(store, localFor(2, quiet), { deskVisibility: "public", machineSecret: new Uint8Array(secret) })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: store, env })
  assert.equal(result.tasks.find((task) => task.slug === "shared").store.sessions, 1)
  assert.deepEqual(reasonsOf(result, "shared"), [])
  assert.deepEqual(reasonsOf(result, "quiet"), [], "a keyed job with no timing and no local facts cannot be placed in the window")
  const text = JSON.stringify(result)
  assert.ok(!text.includes(secret.toString("hex")) && !text.includes(secret.toString("base64")) && !text.includes(keyedJobId(plain, new Uint8Array(secret))), "neither the secret nor a keyed ID is printed")
  // Without the secret, the keyed IDs cannot be compared, which is a warning and not a failure.
  writeFileSync(path.join(root, "machine-secret"), Buffer.alloc(3))
  const blind = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: store, env })
  assert.deepEqual(blind.warnings, ["machine_secret_unavailable"])
  assert.deepEqual(blind.tasks.find((task) => task.slug === "shared").store, { checked: true, sessions: null })
}))

test("a store checkout that is missing or holds a bad file warns and still reports", () => scratch(async (context) => {
  const { desk, env, base } = context
  const repo = await makeDesk(desk, { remote: "https://github.com/acme/desk.git" })
  repo.commit("2026-09-20T00:00:00Z", { "t/a/task.md": cardText() }, "seed")
  const root = await factoryStateRoot(env)
  await writeFile(path.join(root, "visibility.json"), JSON.stringify({ "acme/desk": { visibility: "private", checked_at: "2026-09-25T00:00:00.000Z" } }))
  const missing = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: path.join(base, "nostore"), env })
  assert.deepEqual(missing.warnings, ["store_facts_missing"])
  mkdirSync(path.join(base, "store", "facts"), { recursive: true })
  writeFileSync(path.join(base, "store", "facts", "claude-code-bad.json"), "{ not json")
  const bad = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: path.join(base, "store"), env })
  assert.deepEqual(bad.warnings, ["store_file_unreadable"])
  rmSync(path.join(base, "store", "facts", "claude-code-bad.json"))
  mkdirSync(path.join(base, "store", "facts", "claude-code-folder.json"))
  assert.deepEqual(reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: path.join(base, "store"), env }).warnings, ["store_file_unreadable"], "a folder named like a facts file is unreadable too")
}))

test("bad arguments return ok:false with a usage error, and the command exits 1", async () => {
  const good = ["--desk", "/tmp/desk", "--since", SINCE, "--until", UNTIL]
  const cases = [
    [],
    ["--desk", "/tmp/desk", "--since", SINCE],
    ["--desk", "relative/desk", "--since", SINCE, "--until", UNTIL],
    ["--desk", "/tmp/desk", "--since", "yesterday", "--until", UNTIL],
    ["--desk", "/tmp/desk", "--since", "2026-09-25", "--until", UNTIL],
    ["--desk", "/tmp/desk", "--since", UNTIL, "--until", SINCE],
    ["--desk", "/tmp/desk", "--since", SINCE, "--until", SINCE],
    [...good, "--wat", "1"],
    [...good, "--store", ""],
    [...good, "--desk", "/tmp/other"],
    [...good, "--store"],
  ]
  for (const argv of cases) {
    const result = await runReconcileCommand({ argv, env: {} })
    assert.equal(result.ok, false, JSON.stringify(argv))
    assert.equal(typeof result.error, "string")
  }
  const written = []
  const code = await main({ argv: ["reconcile", "--desk", "relative"], env: {}, write: (text) => written.push(text), logError: () => {} })
  assert.equal(code, 1)
  assert.equal(JSON.parse(written.join("")).ok, false)
  assert.equal((await runReconcileCommand({ argv: ["--desk", "/nonexistent-desk-folder", "--since", SINCE, "--until", UNTIL], env: {} })).ok, false)
})

test("the command runs end to end, accepts offset times and prints one JSON value with exit 0 even when mismatches exist", () => scratch(async (context) => {
  const { desk, env, base } = context
  const repo = await standardDesk(desk, [["t", "lonely"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/lonely/work.md": "x\n" })
  const written = []
  const code = await main({ argv: ["reconcile", "--desk", desk, "--since", "2026-09-25T02:00:00+02:00", "--until", UNTIL, "--store", path.join(base, "store")], env, write: (text) => written.push(text), logError: () => {} })
  assert.equal(code, 0)
  const output = JSON.parse(written.join(""))
  assert.equal(output.ok, true)
  assert.equal(output.window.since, SINCE)
  assert.deepEqual(output.mismatches.map((item) => item.reason), ["not_bound"])
  assert.deepEqual(output.warnings, ["machine_secret_unavailable", "store_facts_missing"], "a desk with no known-private remote needs the secret to compare keyed IDs")
}))

test("Git missing or failing is a warning, never a throw; so is a desk that is not a repository", () => scratch(async (context) => {
  const { desk, env, base } = context
  const repo = await standardDesk(desk, [["t", "a"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/a/work.md": "x\n" })
  const missing = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env, git: path.join(base, "no-such-git") })
  assert.equal(missing.ok, true)
  assert.ok(missing.warnings.includes("git_log_failed"))
  assert.deepEqual(missing.mismatches, [])
  const failing = path.join(base, "failing-git")
  writeFileSync(failing, "#!/bin/sh\nexit 3\n")
  chmodSync(failing, 0o755)
  assert.ok(reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env, git: failing }).warnings.includes("git_log_failed"))
  const plain = path.join(base, "plain")
  mkdirSync(plain)
  const notRepo = reconcile({ deskRoot: plain, since: SINCE, until: UNTIL, env })
  assert.equal(notRepo.ok, true)
  assert.ok(notRepo.warnings.includes("git_log_failed"))
}))

test("a git that dies partway, or prints nonsense, gives what parsed and no throw", () => scratch(async (context) => {
  const { desk, env, base } = context
  await standardDesk(desk, [["t", "a"]])
  const odd = path.join(base, "odd-git")
  writeFileSync(odd, "#!/bin/sh\nprintf 'garbage'\nprintf '\\036nothex\\0037\\0'\nprintf '\\036%s\\0372026-09-25T10:00:00Z\\0\\nM\\0t/a/work.md\\0' 0123456789abcdef0123456789abcdef01234567\n")
  chmodSync(odd, 0o755)
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env, git: odd })
  assert.equal(result.ok, true)
  assert.deepEqual(result.mismatches.map((item) => item.reason), ["not_bound"])
}))

test("bad local state files are warnings, not failures", () => scratch(async (context) => {
  const { desk, env, base } = context
  const repo = await standardDesk(desk, [["t", "a"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/a/work.md": "x\n" })
  const root = await factoryStateRoot(env)
  const junk = "{ not json"
  await writeFile(path.join(root, "consent.json"), junk)
  await writeFile(path.join(root, "status.json"), junk)
  await writeFile(path.join(root, "visibility.json"), junk)
  await mkdir(path.join(root, "delivered"), { recursive: true })
  await writeFile(path.join(root, "delivered", "ourostack__factory.json"), junk)
  await mkdir(path.join(root, "outbox", "ourostack__factory"), { recursive: true })
  await writeFile(path.join(root, "outbox", "ourostack__factory", `claude-code-${sessionId(1)}.json`), junk)
  // The same file kept in retracted-copies is one file, read once.
  await mkdir(path.join(root, "retracted-copies", "ourostack__factory"), { recursive: true })
  await writeFile(path.join(root, "retracted-copies", "ourostack__factory", `claude-code-${sessionId(1)}.json`), junk)
  await mkdir(path.join(root, "markers"), { recursive: true })
  await writeFile(path.join(root, "markers", `claude-code-${sessionId(2)}.json`), junk)
  await writeFile(path.join(root, "markers", "notes.txt"), "ignored")
  const store = path.join(base, "store")
  mkdirSync(path.join(store, "facts"), { recursive: true })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: store, env })
  assert.equal(result.ok, true)
  assert.deepEqual(result.mismatches.map((item) => item.reason), ["not_bound"])
  assert.deepEqual([...result.warnings].sort(), ["consent_unreadable", "machine_secret_unavailable", "marker_unreadable", "outbox_file_unreadable", "status_unreadable", "visibility_unreadable"])
  // A delivery record that cannot be read warns the moment a session needs it.
  const now = await addBoundSession(context)
  assert.ok(now.warnings.includes("delivered_unreadable"))
}))

async function addBoundSession(context) {
  const { desk, env } = context
  const root = await factoryStateRoot(env)
  await writeFile(path.join(root, "consent.json"), JSON.stringify({ schema_version: 1, stores: { [STORE]: { contribute: true, account: "a", intake_id: "0123456789abcdef" } } }))
  await writeFile(path.join(root, "status.json"), JSON.stringify({ last_flush: {}, derivations: { [`claude-code-${sessionId(3)}.json`]: { binding_version: BINDING_VERSION } } }))
  const facts = structuredClone(GOLDEN)
  facts.session.id = sessionId(3)
  facts.jobs = [{ job: jobOf(desk, "t", "a"), basis: ["desk_tool"], task_created_at: null, transitions: [], observed: null }]
  await writeFile(path.join(root, "outbox", "ourostack__factory", `claude-code-${sessionId(3)}.json`), JSON.stringify(facts))
  return reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
}

test("no prompt text, log content or secret appears in the output", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, [["t", "a"], ["t", "b"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/a/work.md": `${SENTINEL}\n`, "t/b/work.md": "x\n" }, SENTINEL)
  await addSession(context, 1, "t", "a")
  const root = await factoryStateRoot(env)
  writeFileSync(path.join(root, "machine-secret"), Buffer.from(SENTINEL.padEnd(32, "!")))
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  const text = JSON.stringify(result)
  assert.ok(text.length > 100)
  assert.ok(!text.includes("PRIVATE") && !text.includes("SENTINEL") && !text.includes("must never persist"))
  assert.ok(!text.includes("machine-secret"))
  assert.deepEqual(Object.keys(result).sort(), ["counts", "desk", "housekeeping_cards", "mismatches", "ok", "sessions", "tasks", "unbound_markers", "window"])
  assert.deepEqual(Object.keys(result.desk), ["person"], "the desk is named by its person alias, never by its path")
}))

test("a task with no bound session is always not_bound; the desk's unbound markers are listed with their own reasons, inside the window only", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, [["t", "orphan"], ["t", "fine"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/orphan/work.md": "x\n", "t/fine/work.md": "x\n" })
  await addSession(context, 1, "t", "fine", { store: OTHER, markerStore: OTHER })
  await setConsent(env, { store: STORE, contribute: true })
  const root = await factoryStateRoot(env)
  const logPath = path.join(desk, "..", "orphan.jsonl")
  await writeFile(logPath, SENTINEL)
  const marker = (n, store, log = logPath, extra = {}) => writeMarker(root, { name: `claude-code-${sessionId(n)}.json`, host: "claude-code", id: sessionId(n), desk, logPath: log, store, ...extra })
  await marker(2, STORE, path.join(desk, "..", "missing.jsonl"))
  await marker(3, "acme/unconsented")
  await marker(4, STORE, path.join(desk, "..", "also-missing.jsonl"))
  await writeMarker(root, { name: `claude-code-${sessionId(5)}.json`, host: "claude-code", id: sessionId(5), desk, logPath: path.join(desk, "..", "open.jsonl"), store: STORE, endedAt: null })
  // A marker's file name must be its own session's.
  await writeFile(path.join(root, "markers", `claude-code-${sessionId(6)}.json`), readFileSync(path.join(root, "markers", `claude-code-${sessionId(4)}.json`)))
  // Markers outside the window do not count: one from after the window, one from before it, and one exactly at its end.
  await marker(7, "acme/unconsented", logPath, { endedAt: "2026-09-27T00:00:00.000Z" })
  await marker(8, "acme/unconsented", logPath, { endedAt: "2026-09-01T00:00:00.000Z" })
  await marker(9, STORE, logPath, { endedAt: UNTIL })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(mismatchOf(result, "orphan").map(({ reason, detail }) => ({ reason, detail })), [{ reason: "not_bound", detail: "unbound_markers_5" }])
  assert.deepEqual(reasonsOf(result, "fine"), [])
  assert.deepEqual(result.unbound_markers, [
    { session: `claude-code-${sessionId(2)}`, reason: "log_missing", detail: "log_absent" },
    { session: `claude-code-${sessionId(3)}`, reason: "not_opted_in", detail: "store_without_consent" },
    { session: `claude-code-${sessionId(4)}`, reason: "log_missing", detail: "log_absent" },
    { session: `claude-code-${sessionId(5)}`, reason: "log_missing", detail: "log_absent" },
    { session: `claude-code-${sessionId(9)}`, reason: null, detail: "marker_not_bound" },
  ])
  assert.equal(result.counts.by_reason.not_bound, 1, "counts stay task-based")
}))

test("planted sentinels in state files, store files, quarantine records and markers never reach the output", () => scratch(async (context) => {
  const { desk, env, base } = context
  const repo = await standardDesk(desk, [["t", "a"], ["t", "q"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/a/work.md": "x\n", "t/q/work.md": "x\n" })
  const quarantined = await addSession(context, 1, "t", "q", { held: "invalid" })
  const root = await factoryStateRoot(env)
  const planted = `${SENTINEL} ${"private_prompt_must_never_persist"}`
  const forms = [SENTINEL, "PRIVATE", "must never persist", "must_never_persist"]
  const clean = (result, label) => {
    const text = JSON.stringify(result)
    for (const form of forms) assert.ok(!text.includes(form), `${label}: ${form}`)
    return result
  }
  // A quarantine record whose reason is the sentinel, and a marker file that carries it.
  await writeFile(path.join(root, "quarantine", quarantined.slug, quarantined.name), JSON.stringify({ reason: planted, at: planted }))
  await writeFile(path.join(root, "markers", `claude-code-${sessionId(2)}.json`), `{ ${planted}`)
  await writeMarker(root, { name: `claude-code-${sessionId(3)}.json`, host: "claude-code", id: sessionId(3), desk, logPath: path.join(base, `${planted}.jsonl`), store: STORE })
  const store = path.join(base, "store")
  mkdirSync(path.join(store, "facts"), { recursive: true })
  writeFileSync(path.join(store, "facts", "claude-code-bad.json"), `{ ${planted}`)
  writeFileSync(path.join(root, "machine-secret"), Buffer.from(planted.padEnd(32, "!")))
  const first = clean(reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: store, env }), "quarantine")
  assert.equal(mismatchOf(first, "q")[0].detail, "refused_other")
  assert.ok(first.warnings.includes("store_file_unreadable") && first.warnings.includes("marker_unreadable"))
  assert.ok(first.unbound_markers.length > 0)
  // Corrupt state files, each holding the sentinel.
  for (const file of ["status.json", "consent.json", "visibility.json"]) await writeFile(path.join(root, file), `{ ${planted}`)
  await writeFile(path.join(root, "delivered", `${quarantined.slug}.json`), `{ ${planted}`)
  const second = clean(reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: store, env }), "state")
  for (const code of ["consent_unreadable", "status_unreadable", "visibility_unreadable"]) assert.ok(second.warnings.includes(code), code)
}))

test("a store_only row for a keyed job this desk cannot map prints job null, never the keyed id", () => scratch(async (context) => {
  const { desk, env, base } = context
  const remote = "https://github.com/acme/public-desk.git"
  const repo = await makeDesk(desk, { remote })
  repo.commit("2026-09-20T00:00:00Z", { "t/known/task.md": cardText() }, "seed")
  const root = await factoryStateRoot(env)
  const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 5 + 3) % 256))
  writeFileSync(path.join(root, "machine-secret"), secret)
  chmodSync(path.join(root, "machine-secret"), 0o600)
  await writeFile(path.join(root, "visibility.json"), JSON.stringify({ "acme/public-desk": { visibility: "public", checked_at: "2026-09-25T00:00:00.000Z" } }))
  await setConsent(env, { store: STORE, contribute: true })
  // This machine has facts for session 9 (placing it in the window) under one job; the store holds the session under another, keyed.
  assert.equal((await writeLocalFacts(env, STORE, localFor(9, "00000000000000000000000000000001"))).written, true)
  const store = path.join(base, "store")
  const stranger = "00000000000000000000000000000002"
  const published = publishTo(store, localFor(9, stranger), { deskVisibility: "public", machineSecret: new Uint8Array(secret) })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: store, env })
  assert.deepEqual(result.mismatches.map(({ track, slug, job, reason }) => ({ track, slug, job, reason })), [{ track: null, slug: null, job: null, reason: "store_only" }])
  assert.ok(!JSON.stringify(result).includes(published.jobs[0].job))
}))

test("an unexpected failure is a result, not a throw", () => scratch(async ({ desk }) => {
  const repo = await standardDesk(desk, [["t", "a"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/a/work.md": "x\n" })
  assert.deepEqual(reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env: null }), { ok: false, error: "reconcile: unexpected failure" })
}))

test("the commit rule is the binder's: housekeeping drops, a sweep binds nothing, and the verdict says which", () => {
  const rule = taskCommitRule({ alias: null, isCardHousekeeping: (sha, file) => file === "t/tidy/task.md" })
  assert.deepEqual(rule("s", ["t/a/task.md", "t/tidy/task.md", "_meta/x.md", 7, "t/a/doc.md"]), {
    tasks: [{ track: "t", slug: "a", bare: false }], real: [{ track: "t", slug: "a", bare: false }],
    touched: [{ track: "t", slug: "a", bare: false }, { track: "t", slug: "tidy", bare: true }], mass: false,
  })
  const sweep = rule("s", ["t/a/x.md", "t/b/x.md", "t/c/x.md", "t/d/x.md"])
  assert.deepEqual(sweep.tasks, [])
  assert.equal(sweep.real.length, 4)
  assert.equal(sweep.mass, true)
  assert.equal(rule("s", ["t/a/x.md", "t/b/x.md", "t/c/x.md", "t/tidy/task.md"]).mass, false, "a housekeeping card does not count toward a sweep")
  assert.ok(normalizeRemote("https://github.com/acme/desk.git"))
})

test("a session whose marker now routes to another store is route_changed, never not_delivered or delivered, read as the flush reads routes", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, [["t", "moved"], ["t", "movedsent"], ["t", "stays"], ["t", "pruned"]])
  for (const slug of ["moved", "movedsent", "stays", "pruned"]) repo.commit("2026-09-25T15:00:00Z", { [`t/${slug}/work.md`]: "real\n" })
  // The markers were written now, as a hook writes them, so they say where each session routes today.
  await addSession(context, 30, "t", "moved", { delivered: false, markerStore: OTHER })
  await addSession(context, 31, "t", "movedsent", { markerStore: OTHER })
  await addSession(context, 32, "t", "stays")
  // Delivered to OTHER under a marker past the 30 days that names STORE: the marker says nothing new, so the session stays in OTHER's
  // outbox and the older pipeline check names the store it was delivered to.
  await addSession(context, 33, "t", "pruned", { store: OTHER })
  const root = await factoryStateRoot(env)
  for (const [n, at] of [[30, Date.now()], [31, Date.now()], [32, Date.now()], [33, Date.now() - 40 * 24 * 60 * 60 * 1000]]) {
    const file = path.join(root, "markers", `claude-code-${sessionId(n)}.json`)
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), updated_at: new Date(at).toISOString() }))
  }
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(reasonsOf(result, "moved"), ["route_changed"])
  assert.equal(mismatchOf(result, "moved")[0].detail, "routes_elsewhere")
  assert.deepEqual(reasonsOf(result, "movedsent"), ["route_changed"])
  assert.deepEqual(reasonsOf(result, "stays"), [])
  assert.deepEqual(reasonsOf(result, "pruned"), ["route_changed"])
  assert.equal(mismatchOf(result, "pruned")[0].detail, "delivered_to_other_store")
}))

test("a tombstoned session routes elsewhere, a stale copy and a stalled retraction are route_changed too, and an unreadable retracting file reads as none", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, [["t", "tomb"], ["t", "stalecopy"], ["t", "stall"], ["t", "elsewhere"]])
  for (const slug of ["tomb", "stalecopy", "stall", "elsewhere"]) repo.commit("2026-09-25T15:00:00Z", { [`t/${slug}/work.md`]: "real\n" })
  const tomb = await addSession(context, 40, "t", "tomb", { delivered: false })
  const stale = await addSession(context, 41, "t", "stalecopy", { delivered: false })
  const stall = await addSession(context, 42, "t", "stall", { delivered: false })
  await addSession(context, 43, "t", "elsewhere", { store: OTHER, markerStore: OTHER })
  const root = await factoryStateRoot(env)
  // Every marker is past the 30 days, so it says nothing new.
  for (const n of [40, 41, 42, 43]) {
    const file = path.join(root, "markers", `claude-code-${sessionId(n)}.json`)
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), updated_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() }))
  }
  await writeStatus(env, { derivations: { [stale.name]: { store: STORE, route: OTHER, binding_version: BINDING_VERSION } } })
  mkdirSync(path.join(root, "retracting"), { recursive: true })
  writeFileSync(path.join(root, "retracting", `${tomb.slug}.json`), JSON.stringify({ [tomb.name]: { path: `facts/${tomb.name}`, blob: blob(40), done: true }, [stall.name]: { path: `facts/${stall.name}`, blob: blob(42) } }))
  writeFileSync(path.join(root, "retracting", `${OTHER.replace("/", "__")}.json`), "{ not json")
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(mismatchOf(result, "tomb").map(({ reason, detail }) => [reason, detail]), [["route_changed", "routes_elsewhere"]])
  assert.deepEqual(mismatchOf(result, "stalecopy").map(({ reason, detail }) => [reason, detail]), [["route_changed", "stale_copy"]])
  assert.deepEqual(mismatchOf(result, "stall").map(({ reason, detail }) => [reason, detail]), [["route_changed", "retraction_stalled"]])
  assert.deepEqual(reasonsOf(result, "elsewhere"), [])
}))

test("a session whose desk declaration is invalid is frozen: held as store_unresolved, never a stale copy", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, [["t", "broken"]])
  repo.commit("2026-09-25T15:00:00Z", { "t/broken/work.md": "real\n" })
  const session = await addSession(context, 50, "t", "broken", { delivered: false })
  // Its last known route is the other store, so a readable route would make it stale here; the desk's declaration is unreadable.
  await writeStatus(env, { derivations: { [session.name]: { store: STORE, route: OTHER, binding_version: BINDING_VERSION } } })
  mkdirSync(path.join(desk, "_meta"), { recursive: true })
  writeFileSync(path.join(desk, "_meta", "factory.json"), "{ not json")
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(mismatchOf(result, "broken").map(({ reason, detail }) => [reason, detail]), [["held", "store_unresolved"]])
}))

// ---- declared focus: real work, tidy housekeeping, story ----

const HOUR = 3600000
const DAY = 24 * HOUR
const FIVE_DAYS = { started_at: "2026-09-23T08:00:00.000Z", ended_at: "2026-09-28T08:00:00.000Z", derived_through: "2026-09-28T08:00:00.000Z" }
const sessionName = (n) => `claude-code-${sessionId(n)}`

test("tidy commits are housekeeping by trailer or subject; the subject is matched and never printed", () => scratch(async ({ desk, env }) => {
  const repo = await standardDesk(desk, ["tidy", "rv1", "rv2", "trailer", "real", "lookalike", "falsy", "both"].map((slug) => ["t", slug]))
  const day = (hour) => `2026-09-25T${hour}:00:00Z`
  repo.commit(day("10"), { "t/tidy/doc.md": "x\n" }, `Tidy desk ${SENTINEL}`)
  repo.commit(day("11"), { "t/rv1/doc.md": "x\n" }, "Revert the desk tidy")
  repo.commit(day("12"), { "t/rv2/doc.md": "x\n" }, 'Revert "Tidy desk cards"')
  repo.commit(day("13"), { "t/trailer/doc.md": "x\n" }, "cleanup\n\nDesk-Tidy: true")
  repo.commit(day("14"), { "t/real/doc.md": "x\n" }, "Add the doc")
  repo.commit(day("15"), { "t/lookalike/doc.md": "x\n" }, "Tidying the doc")
  repo.commit(day("16"), { "t/falsy/doc.md": "x\n" }, "edit\n\nDesk-Tidy: false")
  repo.commit(day("17"), { "t/both/doc.md": "x\n" }, "Tidy desk again")
  repo.commit(day("18"), { "t/both/more.md": "y\n" }, "Write more")
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(result.housekeeping_cards.map((card) => card.slug), ["rv1", "rv2", "tidy", "trailer"])
  assert.deepEqual(result.tasks.map((task) => task.slug), ["both", "falsy", "lookalike", "real"], "a card with one real commit among tidy ones is real work")
  assert.ok(!JSON.stringify(result).includes("SENTINEL") && !JSON.stringify(result).includes("PRIVATE"))
}))

test("a real commit made inside another task's session own_activity is mentioned, not a mismatch; one nobody's own_activity covers is not_bound", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, ["main", "other", "partial", "orphan", "ghost", "late", "abroad", "junk", "foreign", "foreign2", "foreign3", "junkowner"].map((slug) => ["t", slug]))
  repo.commit("2026-09-25T08:30:00Z", { "t/other/work.md": "x\n", "t/partial/work.md": "x\n" })
  repo.commit("2026-09-25T12:00:00Z", { "t/partial/more.md": "x\n", "t/orphan/work.md": "x\n" })
  repo.commit("2026-09-25T08:40:00Z", { "t/main/work.md": "x\n" })
  repo.commit("2026-09-25T09:10:00Z", { "t/ghost/work.md": "x\n" })
  repo.commit("2026-09-25T09:20:00Z", { "t/late/work.md": "x\n" })
  await addSession(context, 1, "t", "main", { boundBy: "focus", ownActivity: [[0, 3000000]] })
  // A session that bound no task owns the time of ghost's commit: it is not "another task's" session.
  await addSession(context, 2, "t", "ghost", { noJobs: true, ownActivity: [[3300000, 5400000]] })
  // A session whose receipt has no own_activity claims no commit.
  await addSession(context, 3, "t", "late", { boundBy: "focus" })
  // Another desk's session, and a session whose own_activity is not a list of spans, own nothing here.
  repo.commit("2026-09-25T08:52:00Z", { "t/abroad/work.md": "x\n", "t/junk/work.md": "x\n" })
  await addSession(context, 4, "t", "foreign", { boundBy: "focus", ownActivity: [[0, 5400000]], receiptFields: { desk_root: "/nonexistent/other/desk" } })
  await addSession(context, 5, "t", "foreign2", { boundBy: "focus", ownActivity: [[0, 5400000]], receiptFields: { desk_root: 7 } })
  await addSession(context, 6, "t", "foreign3", { boundBy: "focus", receiptFields: { own_activity: [[0, 5400000]] } })
  await addSession(context, 7, "t", "junkowner", { boundBy: "focus", ownActivity: ["x", [0], [null, 5], [0, "y"]] })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(reasonsOf(result, "abroad"), ["not_bound"], "another desk's sessions, and a receipt with no desk, own nothing")
  assert.deepEqual(reasonsOf(result, "junk"), ["not_bound"], "malformed spans own nothing")
  assert.deepEqual(reasonsOf(result, "other"), [], "mentioned is a count, not a mismatch")
  assert.deepEqual(reasonsOf(result, "main"), [])
  assert.deepEqual(reasonsOf(result, "late"), [])
  assert.deepEqual(reasonsOf(result, "partial"), ["not_bound"], "one commit nobody owns is enough")
  assert.deepEqual(reasonsOf(result, "orphan"), ["not_bound"])
  assert.deepEqual(reasonsOf(result, "ghost"), ["not_bound"], "a session bound to nothing mentions nothing")
  assert.equal(result.counts.mentioned, 2, "other's commit, and partial's first one")
  assert.ok(result.tasks.some((task) => task.slug === "other"), "a task with only mentioned commits is still real work")
}))

test("placement uses a job's segments: a five-day session places the task on the day its segments cover", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, ["day1", "day2", "whole"].map((slug) => ["t", slug]))
  void repo
  // The session runs 09-23 08:00 to 09-28 08:00. day1 is held 09-24 08:00-09:00, day2 on 09-25 08:00-09:00, and a subagent-only job has no segments.
  await addSession(context, 1, "t", "day1", { span: FIVE_DAYS, agents: [0], segments: [{ start_ms: DAY, end_ms: DAY + HOUR }], boundBy: "focus" })
  await addSession(context, 2, "t", "day2", { span: FIVE_DAYS, agents: [0], segments: [{ start_ms: 2 * DAY, end_ms: 2 * DAY + HOUR }], boundBy: "focus" })
  await addSession(context, 3, "t", "whole", { span: FIVE_DAYS, agents: [1], boundBy: "none" })
  const slugs = (since, until) => reconcile({ deskRoot: desk, since, until, env }).tasks.map((task) => task.slug)
  assert.deepEqual(slugs("2026-09-25T00:00:00.000Z", "2026-09-26T00:00:00.000Z"), ["day2", "whole"])
  assert.deepEqual(slugs("2026-09-24T00:00:00.000Z", "2026-09-25T00:00:00.000Z"), ["day1", "whole"])
  assert.deepEqual(slugs("2026-09-27T00:00:00.000Z", "2026-09-27T12:00:00.000Z"), ["whole"], "with no segments the whole span places the job")
}))

test("each task's story lists its sessions by start with active time clipped to the job's segments, and how each was bound", () => scratch(async (context) => {
  const { desk, env } = context
  await standardDesk(desk, [["t", "tale"]])
  // Session 2 starts at 07:00 and holds every interval; session 1 starts at 08:00 and holds only its first five minutes of worker 0.
  await addSession(context, 1, "t", "tale", { agents: [0], segments: [{ start_ms: 0, end_ms: 300000 }], boundBy: "focus" })
  await addSession(context, 2, "t", "tale", { span: { started_at: "2026-09-25T07:00:00.000Z" }, boundBy: "inferred" })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  const task = result.tasks.find((item) => item.slug === "tale")
  assert.deepEqual(task.story, [
    { session: sessionName(2), start: "2026-09-25T07:00:00.000Z", active_ms: 844000, bound_by: "inferred" },
    { session: sessionName(1), start: "2026-09-25T08:00:00.000Z", active_ms: 249000, bound_by: "focus" },
  ])
  assert.deepEqual(reasonsOf(result, "tale"), [])
  // Facts a file can no longer be read as intervals and segments give no active time, which is not zero.
  const root = await factoryStateRoot(env)
  const file = path.join(root, "outbox", "ourostack__factory", `${sessionName(1)}.json`)
  const facts = JSON.parse(readFileSync(file, "utf8"))
  facts.jobs[0].segments = "garbled"
  writeFileSync(file, JSON.stringify(facts))
  const garbled = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.equal(garbled.tasks.find((item) => item.slug === "tale").story.find((entry) => entry.session === sessionName(1)).active_ms, null)
}))

test("bound_by is reported per story entry: focus, inferred, subagent only, and not recorded where the receipt cannot say", () => scratch(async (context) => {
  const { desk, env } = context
  await standardDesk(desk, ["f", "i", "s", "old", "bare", "odd"].map((slug) => ["t", slug]))
  await addSession(context, 1, "t", "f", { boundBy: "focus" })
  await addSession(context, 2, "t", "i", { boundBy: "inferred" })
  await addSession(context, 3, "t", "s", { boundBy: "none" })
  await addSession(context, 4, "t", "old", { receipt: 4 })
  await addSession(context, 5, "t", "bare", {})
  await addSession(context, 6, "t", "odd", { boundBy: "bogus" })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  const by = (slug) => result.tasks.find((task) => task.slug === slug).story.map((entry) => entry.bound_by)
  assert.deepEqual(["f", "i", "s", "old", "bare", "odd"].map(by), [["focus"], ["inferred"], ["subagent_only"], ["not_recorded"], ["not_recorded"], ["not_recorded"]])
  assert.deepEqual(result.counts.bound_by, { focus: 1, inferred: 1, subagent_only: 1, not_recorded: 3 })
  assert.equal(Object.values(result.counts.bound_by).reduce((a, b) => a + b, 0), result.tasks.flatMap((task) => task.story).length, "the counts sum to the story entries")
}))

test("the receipt's two measures are reported per session and as totals; a receipt without them says not recorded, never zero", () => scratch(async (context) => {
  const { desk, env } = context
  await standardDesk(desk, ["a", "b", "c", "d", "e"].map((slug) => ["t", slug]))
  await addSession(context, 1, "t", "a", { boundBy: "focus", receiptFields: { segments_capped_ms: 5000, repo_unresolved: 2 } })
  await addSession(context, 2, "t", "b", { boundBy: "focus", receiptFields: { segments_capped_ms: 0, repo_unresolved: 0 } })
  await addSession(context, 3, "t", "c", { boundBy: "focus" })
  await addSession(context, 4, "t", "d", { boundBy: "focus", receiptFields: { segments_capped_ms: -1, repo_unresolved: "3" } })
  await addSession(context, 5, "t", "e", { boundBy: "focus", receiptFields: { segments_capped_ms: 7, repo_unresolved: 1.5 } })
  await addSession(context, 6, "t", "e", { receipt: null })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  const pick = ({ session, segments_capped_ms, repository_evidence_unavailable }) => [session, segments_capped_ms, repository_evidence_unavailable]
  assert.deepEqual(result.sessions.map(pick), [
    [sessionName(1), 5000, 2], [sessionName(2), 0, 0], [sessionName(3), "not_recorded", "not_recorded"],
    [sessionName(4), "not_recorded", "not_recorded"], [sessionName(5), 7, "not_recorded"], [sessionName(6), "not_recorded", "not_recorded"],
  ])
  assert.equal(result.sessions[0].start, "2026-09-25T08:00:00.000Z")
  assert.deepEqual(result.counts.segments_capped_ms, { total: 5007, recorded: 3, not_recorded: 3 })
  assert.deepEqual(result.counts.repository_evidence_unavailable, { total: 2, recorded: 2, not_recorded: 4 })
  const none = reconcile({ deskRoot: desk, since: "2026-09-01T00:00:00.000Z", until: "2026-09-02T00:00:00.000Z", env })
  assert.deepEqual(none.counts.segments_capped_ms, { total: null, recorded: 0, not_recorded: 0 }, "no sessions means no measurement, not zero")
}))

test("focus_disagrees is copied from the receipt", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, [["t", "split"], ["t", "fine"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/split/work.md": "x\n", "t/fine/work.md": "x\n" })
  await addSession(context, 1, "t", "split", { boundBy: "focus", focusDisagrees: true })
  await addSession(context, 2, "t", "fine", { boundBy: "focus" })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(mismatchOf(result, "split").map(({ reason, detail }) => ({ reason, detail })), [{ reason: "focus_disagrees", detail: "declared_stretch_without_own_events" }])
  assert.deepEqual(reasonsOf(result, "fine"), [])
}))

test("status_unobserved fires when the card's status differs from the latest the store observed, and clears when the store catches up", () => scratch(async (context) => {
  const { desk, env, base } = context
  const remote = "https://github.com/acme/desk.git"
  const repo = await makeDesk(desk, { remote })
  repo.commit("2026-09-20T00:00:00Z", { "t/s/task.md": cardText(), "t/bad/task.md": cardText({ status: "active" }), "t/quiet/task.md": cardText({ status: "done" }), "t/loc/task.md": cardText({ status: "done" }) }, "seed")
  repo.commit("2026-09-25T10:00:00Z", { "t/s/task.md": cardText({ status: "done", updated: "2026-09-25T10:00:00.000Z" }), "t/s/work.md": "x\n", "t/bad/work.md": "x\n", "t/quiet/work.md": "x\n" })
  repo.commit("2026-09-25T10:30:00Z", { "t/loc/work.md": "x\n" })
  const root = await factoryStateRoot(env)
  await writeFile(path.join(root, "visibility.json"), JSON.stringify({ "acme/desk": { visibility: "private", checked_at: "2026-09-25T00:00:00.000Z" } }))
  const store = path.join(base, "store")
  const observed = (n, slug, status, start) => {
    const facts = localFor(n, jobOf(desk, "t", slug, remote))
    facts.jobs[0].observed = status === null ? null : { status, at: null }
    facts.session.started_at = start
    return facts
  }
  publishTo(store, observed(1, "s", "processing", "2026-09-25T08:00:00.000Z"), { deskVisibility: "private" })
  publishTo(store, observed(2, "bad", "processing", "2026-09-25T08:00:00.000Z"), { deskVisibility: "private" })
  publishTo(store, observed(3, "quiet", null, "2026-09-25T08:00:00.000Z"), { deskVisibility: "private" })
  // This machine's own session of loc is the latest observation (it is placed); another machine's, with nothing to place it by, is not.
  await addSession(context, 5, "t", "loc", { remote, status: "done" })
  publishTo(store, observed(5, "loc", "done", "2026-09-25T08:00:00.000Z"), { deskVisibility: "private" })
  const unplaced = localFor(6, jobOf(desk, "t", "loc", remote), { created: null })
  unplaced.jobs[0].observed = { status: "processing", at: null }
  publishTo(store, unplaced, { deskVisibility: "private" })
  const fires = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: store, env })
  assert.ok(!reasonsOf(fires, "loc").includes("status_unobserved"), "the placed observation is the latest, however the files are ordered")
  assert.deepEqual(mismatchOf(fires, "s").map(({ reason, detail }) => ({ reason, detail })), [{ reason: "not_bound", detail: "unbound_markers_0" }, { reason: "status_unobserved", detail: "card_status_not_in_store" }])
  assert.ok(!reasonsOf(fires, "bad").includes("status_unobserved"), "an invalid status is already invalid_status")
  assert.ok(!reasonsOf(fires, "quiet").includes("status_unobserved"), "a store that observed nothing gives nothing to compare")
  assert.ok(!reasonsOf(reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env }), "s").includes("status_unobserved"), "without --store there is no store to compare")
  // A later session of the job observes the card's status: the latest observation wins, so it clears.
  publishTo(store, observed(4, "s", "done", "2026-09-25T09:00:00.000Z"), { deskVisibility: "private" })
  assert.ok(!reasonsOf(reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: store, env }), "s").includes("status_unobserved"))
}))

test("every reason in the fixed vocabulary was reached by a test above", () => {
  assert.deepEqual(RECONCILE_REASONS.filter((reason) => !REACHED.has(reason)), [])
})
