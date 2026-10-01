// `factory reconcile`: a fixture desk with dated commits, a fixture factory state folder and a fixture store, all
// under a temp folder. Every desk, card and session here is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { jobId, normalizeRemote, taskCommitRule } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { BINDING_VERSION } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import { factoryStateRoot, markDelivered, quarantine, setConsent, writeLocalFacts, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { keyedJobId, publishedFileName, serializePublished, toPublished } from "../../../../../plugins/desk/mcp/src/factory/publish.js"
import { RECONCILE_REASONS } from "../../../../../plugins/desk/mcp/src/factory/reconcile-reasons.js"
import { reconcile } from "../../../../../plugins/desk/mcp/src/factory/reconcile.js"
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

const deskRemote = (desk, remote) => remote ?? `local:${desk}`
const jobOf = (desk, track, slug, remote = null) => jobId({ deskRemote: deskRemote(desk, remote), personPrefix: "", track, slug })

// One bound session: local facts in the outbox, a marker, a log and the delivery state.
async function addSession({ base, desk, env }, n, track, slug, options = {}) {
  const {
    store = STORE, markerStore = STORE, host = "claude-code", receipt = BINDING_VERSION, delivered = true, held = null, log = true, remote = null, marker = true, status = "processing", markerOptions = {},
  } = options
  const id = sessionId(n)
  const name = `${host}-${id}.json`
  const facts = structuredClone(GOLDEN)
  facts.session.id = id
  facts.session.host = host
  facts.jobs = [{ job: jobOf(desk, track, slug, remote), basis: ["desk_tool"], task_created_at: "2026-09-20T00:00:00.000Z", transitions: [], observed: { status, at: null } }]
  const root = await factoryStateRoot(env)
  if (!(await readConsent(env)).stores[store]) await setConsent(env, { store, contribute: true })
  const written = await writeLocalFacts(env, store, facts)
  assert.equal(written.written, true, JSON.stringify(written.errors))
  const slugOf = store.replace("/", "__")
  if (delivered) await markDelivered(env, store, { name, publishedBlobSha: blob(n) })
  if (held !== null) await quarantine(env, store, name, held)
  if (receipt !== null) await writeStatus(env, { derivations: { [name]: { store, marker: "m", binding_version: receipt, size: 1, mtime: 1, ino: 1, dev: 1 } } })
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

test("the reason list is the thirteen codes, once each", () => {
  assert.equal(RECONCILE_REASONS.length, 13)
  assert.equal(new Set(RECONCILE_REASONS).size, 13)
  assert.deepEqual([...RECONCILE_REASONS].sort(), ["card_missing", "held", "invalid_status", "log_missing", "mechanical_only", "no_marker", "not_delivered", "not_opted_in", "pr_open", "quarantined", "route_changed", "stale_binding", "store_only"])
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
  await addSession(context, 4, "t", "quar", { held: "invalid_published" })
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
  assert.deepEqual(reasonsOf(result, "nomarker"), ["no_marker"])
  assert.deepEqual(reasonsOf(result, "tidy"), ["mechanical_only"])
  assert.deepEqual(reasonsOf(result, "new-name"), ["mechanical_only"], "a pure rename is mechanical, and the old path folds into the renamed task")
  assert.deepEqual(reasonsOf(result, "old-name"), [])
  assert.deepEqual(reasonsOf(result, "rn-old"), [])
  for (const slug of ["m1", "m2", "m3", "m4"]) assert.deepEqual(reasonsOf(result, slug), ["mechanical_only"], "a mass commit counts for no task")
  assert.deepEqual(reasonsOf(result, "stale"), ["stale_binding"])
  assert.equal(mismatchOf(result, "stale")[0].detail, "binding_version_3")
  assert.deepEqual(reasonsOf(result, "routed"), ["route_changed"])
  assert.deepEqual(reasonsOf(result, "quar"), ["quarantined"])
  assert.equal(mismatchOf(result, "quar")[0].detail, "refused_invalid_published")
  assert.deepEqual(reasonsOf(result, "undelivered"), ["not_delivered"])
  assert.deepEqual(reasonsOf(result, "logless"), ["log_missing"])
  assert.deepEqual(reasonsOf(result, "badstatus"), ["invalid_status"], "an invalid status is a mismatch even when everything else matches")
  assert.deepEqual(reasonsOf(result, "badboth"), ["stale_binding", "invalid_status"], "an invalid status is reported beside any other reason")
  assert.equal(mismatchOf(result, "noreceipt")[0].detail, "binding_version_none")
  assert.deepEqual(reasonsOf(result, "quarbare"), ["quarantined"])
  assert.equal(mismatchOf(result, "quarbare")[0].detail, "refused")
  assert.deepEqual(mismatchOf(result, "twosess").map((item) => item.reason), ["not_delivered"], "the session furthest along the pipeline explains the task")
  assert.deepEqual(reasonsOf(result, "okplus"), [], "one good session is enough")
  assert.deepEqual(reasonsOf(result, "noroute"), [], "a marker with no recorded route routes where the desk does")
  assert.deepEqual(reasonsOf(result, "nodeskroot"), ["held"])
  assert.equal(mismatchOf(result, "nodeskroot")[0].detail, "no_desk_root")
  assert.deepEqual(reasonsOf(result, "rn-new"), ["no_marker"], "a renamed folder with a real edit is real work, and its job is the birth path's")
  assert.equal(result.tasks.find((task) => task.slug === "rn-new").job, jobOf(desk, "t", "rn-old"))
  assert.equal(result.counts.tasks, result.tasks.length)
  assert.equal(result.counts.mismatched, result.mismatches.length)
  assert.equal(result.counts.matched, result.tasks.filter((task) => !result.mismatches.some((item) => item.slug === task.slug)).length)
  assert.equal(result.counts.by_reason.mechanical_only, 6)
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
  assert.equal(mismatchOf(result, "open")[0].detail, "pr_7")
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
  assert.deepEqual(reasonsOf(result, "nope"), ["not_opted_in"])
  assert.equal(mismatchOf(result, "nope")[0].detail, "store_without_consent")
  await writeFile(path.join(root, "markers", `claude-code-${sessionId(1)}.json`), JSON.stringify({
    schema_version: 1, host: "claude-code", session_id: sessionId(1), log_path: logPath, cwd: desk, desk_root: desk, end_reason: null,
    ended_at: "2026-09-25T09:30:00.000Z", plugins: [], updated_at: "2026-09-25T09:30:00.000Z",
    routing: { store: null, source: "invalid_declaration", warnings: [] },
  }))
  assert.equal(mismatchOf(reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env }), "decl")[0].reason, "held")
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
  assert.deepEqual(mismatchOf(held, "codex").map(({ reason, detail }) => ({ reason, detail })), [{ reason: "held", detail: "route_unverified" }])
  await writeMarker(root, { name: `claude-code-${sessionId(3)}.json`, host: "claude-code", id: sessionId(3), desk, logPath, store: STORE })
  const released = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(reasonsOf(released, "codex"), ["no_marker"], "no bound session, and neither marker has a problem")
  assert.equal(mismatchOf(released, "codex")[0].detail, "marker_not_bound")
}))

test("a task with no card is card_missing, a marker with a missing desk root is held, and a desk with no markers is no_marker", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, [["t", "kept"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/kept/work.md": "x\n", "t/gone/work.md": "x\n", "_friction/note.md": "not a task\n", "t/track.md": "x\n" })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(reasonsOf(result, "gone"), ["card_missing"])
  assert.deepEqual(reasonsOf(result, "kept"), ["no_marker"])
  assert.equal(mismatchOf(result, "kept")[0].detail, "no_session_or_marker")
  assert.equal(result.tasks.length, 2, "only task folders are tasks")
  const root = await factoryStateRoot(env)
  await mkdir(path.join(root, "markers"), { recursive: true })
  await writeFile(path.join(root, "markers", `claude-code-${sessionId(1)}.json`), JSON.stringify({
    schema_version: 1, host: "claude-code", session_id: sessionId(1), log_path: path.join(desk, "x.jsonl"), cwd: desk, desk_root: null, end_reason: null,
    ended_at: "2026-09-25T09:30:00.000Z", plugins: [], updated_at: "2026-09-25T09:30:00.000Z",
  }))
  assert.equal(reasonsOf(reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env }), "kept")[0], "no_marker", "a marker with no desk root is not this desk's")
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
  assert.deepEqual(reasonsOf(result, "idle"), ["mechanical_only", "store_only"])
  assert.equal(result.tasks.find((task) => task.slug === "idle2").activity.length, 0)
  assert.deepEqual(reasonsOf(result, "busy"), ["no_marker"])
  const bare = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(bare.mismatches.map((item) => item.reason), ["no_marker", "mechanical_only"], "without --store the store is not read")
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
  assert.deepEqual(output.mismatches.map((item) => item.reason), ["no_marker"])
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
  assert.deepEqual(result.mismatches.map((item) => item.reason), ["no_marker"])
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
  await mkdir(path.join(root, "markers"), { recursive: true })
  await writeFile(path.join(root, "markers", `claude-code-${sessionId(2)}.json`), junk)
  await writeFile(path.join(root, "markers", "notes.txt"), "ignored")
  const store = path.join(base, "store")
  mkdirSync(path.join(store, "facts"), { recursive: true })
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, storeDir: store, env })
  assert.equal(result.ok, true)
  assert.deepEqual(result.mismatches.map((item) => item.reason), ["no_marker"])
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
  assert.deepEqual(Object.keys(result).sort(), ["counts", "desk", "mismatches", "ok", "tasks", "window"])
}))

test("a task with no bound session is blamed on the desk's unbound markers in pipeline order, and markers that have facts are left out", () => scratch(async (context) => {
  const { desk, env } = context
  const repo = await standardDesk(desk, [["t", "orphan"], ["t", "fine"]])
  repo.commit("2026-09-25T10:00:00Z", { "t/orphan/work.md": "x\n", "t/fine/work.md": "x\n" })
  await addSession(context, 1, "t", "fine", { store: OTHER, markerStore: OTHER })
  const root = await factoryStateRoot(env)
  const logPath = path.join(desk, "..", "orphan.jsonl")
  await writeFile(logPath, SENTINEL)
  const marker = (n, store, log = logPath) => writeMarker(root, { name: `claude-code-${sessionId(n)}.json`, host: "claude-code", id: sessionId(n), desk, logPath: log, store })
  await marker(2, STORE, path.join(desk, "..", "missing.jsonl"))
  await marker(3, "acme/unconsented")
  await marker(4, STORE, path.join(desk, "..", "also-missing.jsonl"))
  await writeMarker(root, { name: `claude-code-${sessionId(5)}.json`, host: "claude-code", id: sessionId(5), desk, logPath: path.join(desk, "..", "open.jsonl"), store: STORE, endedAt: null })
  // A marker's file name must be its own session's.
  await writeFile(path.join(root, "markers", `claude-code-${sessionId(6)}.json`), readFileSync(path.join(root, "markers", `claude-code-${sessionId(4)}.json`)))
  const result = reconcile({ deskRoot: desk, since: SINCE, until: UNTIL, env })
  assert.deepEqual(mismatchOf(result, "orphan").map((item) => item.reason), ["not_opted_in"])
  assert.deepEqual(reasonsOf(result, "fine"), [])
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
