import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { jobId } from "../../../../../../plugins/desk/mcp/src/factory/binding.js"
import { build, jobReportUrl, storePublicPlugins, storeRecords } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/build.js"
import { REASON_TEXT } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/report.js"
import { serializePublished } from "../../../../../../plugins/desk/mcp/src/factory/publish.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, "..", "fixtures")
const STORE = path.join(FIXTURES, "store")
const EXPECTED = path.join(FIXTURES, "store-expected")
const ROLLUP_STORE = path.join(FIXTURES, "rollup-store")
const ROLLUP_EXPECTED = path.join(FIXTURES, "rollup-store-expected")
const SENTINEL = "SENTINEL-STORE-FREE-TEXT"

function files(root, relative = "") {
  const current = path.join(root, relative)
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name)
    return entry.isDirectory() ? files(root, child) : [child]
  }).sort()
}

function bytesByPath(root) {
  return Object.fromEntries(files(root).map((relative) => [relative.replaceAll(path.sep, "/"), readFileSync(path.join(root, relative))]))
}

function scratch(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-factory-build-"))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("build matches every golden output byte for byte and returns exact counts", () => scratch((root) => {
  const out = path.join(root, "out")
  assert.deepEqual(build({ storeDir: STORE, outDir: out }), { jobs: 2, sessions: 4 })
  const actual = bytesByPath(out)
  const expected = bytesByPath(EXPECTED)
  assert.deepEqual(Object.keys(actual), Object.keys(expected))
  for (const relative of Object.keys(expected)) assert.equal(Buffer.compare(actual[relative], expected[relative]), 0, relative)
}))

test("build turns the golden rollup store's facts and labels into every golden output byte for byte", () => scratch((root) => {
  const out = path.join(root, "out")
  assert.deepEqual(build({ storeDir: ROLLUP_STORE, outDir: out }), { jobs: 6, sessions: 10 })
  const actual = bytesByPath(out)
  const expected = bytesByPath(ROLLUP_EXPECTED)
  assert.deepEqual(Object.keys(actual), Object.keys(expected))
  for (const relative of Object.keys(expected)) assert.equal(Buffer.compare(actual[relative], expected[relative]), 0, relative)
  assert.deepEqual(Object.keys(actual).filter((relative) => relative.startsWith("rollups/")), [
    "rollups/coverage.json", "rollups/index.md", "rollups/measures.json", "rollups/muda.json", "rollups/outcomes.json", "rollups/tool-kinds.json", "rollups/totals.json",
  ])
}))

test("build reads labels as data only: dotfiles are ignored, and malformed or unexpected entries stop the build", () => scratch((root) => {
  const store = path.join(root, "store")
  const out = path.join(root, "out")
  const reset = () => {
    rmSync(store, { recursive: true, force: true })
    cpSync(ROLLUP_STORE, store, { recursive: true })
  }
  const golden = bytesByPath(ROLLUP_EXPECTED)
  const labelsDir = path.join(store, "labels")
  const jobDir = path.join(labelsDir, "11111111111111111111111111111111")
  const labelsFile = path.join(jobDir, "10000000-0000-4000-8000-000000000001.json")

  reset()
  writeFileSync(path.join(labelsDir, ".gitkeep"), SENTINEL)
  writeFileSync(path.join(jobDir, ".notes"), SENTINEL)
  mkdirSync(path.join(labelsDir, ".hidden"))
  build({ storeDir: store, outDir: out })
  for (const [relative, bytes] of Object.entries(bytesByPath(out))) assert.equal(Buffer.compare(bytes, golden[relative]), 0, relative)

  const refusals = [
    [() => writeFileSync(labelsFile, `{"${SENTINEL}":`), "invalid_published_labels"],
    [() => {
      const value = JSON.parse(readFileSync(labelsFile, "utf8"))
      value.job = "22222222222222222222222222222222"
      writeFileSync(labelsFile, JSON.stringify(value))
    }, "invalid_published_labels"],
    [() => writeFileSync(path.join(labelsDir, "README.md"), SENTINEL), "invalid_labels_entry"],
    [() => mkdirSync(path.join(labelsDir, "not-a-job")), "invalid_labels_entry"],
    [() => writeFileSync(path.join(jobDir, "notes.txt"), SENTINEL), "invalid_labels_entry"],
    [() => mkdirSync(path.join(jobDir, "nested")), "invalid_labels_entry"],
    [() => symlinkSync(labelsFile, path.join(jobDir, "10000000-0000-4000-8000-000000000099.json")), "invalid_labels_entry"],
    [() => symlinkSync(jobDir, path.join(labelsDir, "99999999999999999999999999999999")), "invalid_labels_entry"],
    [() => {
      rmSync(labelsDir, { recursive: true })
      writeFileSync(labelsDir, SENTINEL)
    }, "labels_not_directory"],
  ]
  for (const [plant, code] of refusals) {
    reset()
    plant()
    assert.throws(() => build({ storeDir: store, outDir: out }), (error) => error.code === code && !error.message.includes(SENTINEL), code)
  }
}))

test("two builds over identical input are byte-identical", () => scratch((root) => {
  const first = path.join(root, "first")
  const second = path.join(root, "second")
  build({ storeDir: STORE, outDir: first })
  build({ storeDir: STORE, outDir: second })
  const left = bytesByPath(first)
  const right = bytesByPath(second)
  assert.deepEqual(Object.keys(left), Object.keys(right))
  for (const relative of Object.keys(left)) assert.equal(Buffer.compare(left[relative], right[relative]), 0, relative)
  build({ storeDir: STORE, outDir: first })
  const replaced = bytesByPath(first)
  for (const relative of Object.keys(left)) assert.equal(Buffer.compare(left[relative], replaced[relative]), 0, relative)
}))

test("build writes totals.json and the stable output is byte-identical across two builds", () => scratch((root) => {
  const first = path.join(root, "first")
  const second = path.join(root, "second")
  build({ storeDir: ROLLUP_STORE, outDir: first })
  build({ storeDir: ROLLUP_STORE, outDir: second })
  const left = readFileSync(path.join(first, "rollups", "totals.json"))
  assert.equal(Buffer.compare(left, readFileSync(path.join(second, "rollups", "totals.json"))), 0)
  const totals = JSON.parse(left.toString("utf8"))
  assert.equal(totals.schema, "desk.factory.rollups/1")
  assert.deepEqual(Object.keys(totals.hosts), ["claude-code", "copilot-cli"])
  assert.equal(totals.all.sessions.value, 10)
  assert.match(readFileSync(path.join(first, "README.md"), "utf8"), /rollups\/totals\.json/u)
  assert.equal(left.toString("utf8").endsWith("\n"), true)
}))

test("totals.json carries no date, time, path or contributor", () => scratch((root) => {
  const store = path.join(root, "store")
  cpSync(STORE, store, { recursive: true })
  const factPath = path.join(store, "facts", "claude-code-11111111-1111-4111-8111-111111111111.json")
  const fact = JSON.parse(readFileSync(factPath, "utf8"))
  fact.models[0].id = SENTINEL
  fact.agents[0].model = SENTINEL
  writeFileSync(factPath, JSON.stringify(fact))
  const out = path.join(root, "out")
  build({ storeDir: store, outDir: out })
  const text = readFileSync(path.join(out, "rollups", "totals.json"), "utf8")
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/u)
  assert.doesNotMatch(text, /\d{2}:\d{2}/u)
  assert.doesNotMatch(text, /\/(?:Users|home|tmp|var)\/|[A-Za-z]:\\/u)
  assert.equal(text.includes(SENTINEL), false)
  assert.doesNotMatch(text, /contributor|author|email/iu)
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["all", "hosts", "schema"])
}))

test("generated output contains no date, time of day, absolute path, or planted free-text sentinel", () => scratch((root) => {
  // The sentinel is planted where the build actually reads: a schema-valid
  // model ID inside a facts file, an ignored dotfile under facts/, and the
  // store README. None of them may reach the reports.
  const store = path.join(root, "store")
  cpSync(STORE, store, { recursive: true })
  const factPath = path.join(store, "facts", "claude-code-11111111-1111-4111-8111-111111111111.json")
  const fact = JSON.parse(readFileSync(factPath, "utf8"))
  fact.models[0].id = SENTINEL
  fact.agents[0].model = SENTINEL
  writeFileSync(factPath, JSON.stringify(fact))
  writeFileSync(path.join(store, "facts", ".gitkeep"), SENTINEL)
  assert.ok(readFileSync(path.join(store, "README.md"), "utf8").includes(SENTINEL))
  const out = path.join(root, "out")
  assert.deepEqual(build({ storeDir: store, outDir: out }), { jobs: 2, sessions: 4 })
  // The rollup store adds labels, whose evaluator model is a free token.
  const rollupStore = path.join(root, "rollup-store")
  cpSync(ROLLUP_STORE, rollupStore, { recursive: true })
  const labelsPath = path.join(rollupStore, "labels", "11111111111111111111111111111111", "10000000-0000-4000-8000-000000000001.json")
  const labels = JSON.parse(readFileSync(labelsPath, "utf8"))
  labels.evaluator.model = SENTINEL
  writeFileSync(labelsPath, JSON.stringify(labels))
  assert.ok(readFileSync(path.join(rollupStore, "README.md"), "utf8").includes(SENTINEL))
  const rollupOut = path.join(root, "rollup-out")
  assert.deepEqual(build({ storeDir: rollupStore, outDir: rollupOut }), { jobs: 6, sessions: 10 })
  const outputs = [...Object.entries(bytesByPath(out)), ...Object.entries(bytesByPath(rollupOut)).map(([relative, contents]) => [`rollup/${relative}`, contents])]
  // The new pages and the totals are among the files checked, not only the old ones.
  for (const required of ["README.md", "index.md", "rollups/index.md", "rollups/totals.json", "rollup/rollups/totals.json", "rollup/rollups/index.md"]) assert.ok(outputs.some(([relative]) => relative === required), required)
  assert.ok(outputs.some(([relative, contents]) => relative.endsWith(".md") && contents.toString("utf8").includes("- Tokens: ")))
  for (const [relative, contents] of outputs) {
    const text = contents.toString("utf8")
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/u, relative)
    assert.doesNotMatch(text, /\d{2}:\d{2}/u, relative)
    assert.doesNotMatch(text, /\/(?:Users|home|tmp|var)\/|[A-Za-z]:\\/u, relative)
    assert.equal(text.includes(SENTINEL), false, relative)
  }
}))

test("a store with no facts directory, or only dotfiles in it, publishes an empty index", () => scratch((root) => {
  const store = path.join(root, "store")
  mkdirSync(store)
  const out = path.join(root, "out")
  assert.deepEqual(build({ storeDir: store, outDir: out }), { jobs: 0, sessions: 0 })
  const empty = bytesByPath(out)
  assert.deepEqual(Object.keys(empty), ["README.md", "index.md", "rollups/coverage.json", "rollups/index.md", "rollups/measures.json", "rollups/muda.json", "rollups/outcomes.json", "rollups/tool-kinds.json", "rollups/totals.json"])
  assert.match(empty["index.md"].toString("utf8"), /No job has published facts yet\./u)
  assert.match(empty["rollups/index.md"].toString("utf8"), /No job has published facts yet\./u)
  assert.equal(JSON.parse(empty["rollups/coverage.json"]).jobs, 0)

  mkdirSync(path.join(store, "facts"))
  writeFileSync(path.join(store, "facts", ".gitkeep"), "")
  mkdirSync(path.join(store, "facts", ".hidden"))
  assert.deepEqual(build({ storeDir: store, outDir: out }), { jobs: 0, sessions: 0 })
  assert.equal(Buffer.compare(bytesByPath(out)["index.md"], empty["index.md"]), 0)
  mkdirSync(path.join(store, "labels"))
  writeFileSync(path.join(store, "labels", ".gitkeep"), "")
  build({ storeDir: store, outDir: out })
  for (const [relative, bytes] of Object.entries(bytesByPath(out))) assert.equal(Buffer.compare(bytes, empty[relative]), 0, relative)
}))

test("build reads facts as data only and rejects unexpected entries, invalid bytes, symlinks, and unsafe output paths", () => scratch((root) => {
  const store = path.join(root, "store")
  cpSync(STORE, store, { recursive: true })
  const marker = path.join(root, "executed")
  const candidate = path.join(store, "facts", "candidate.js")
  writeFileSync(candidate, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`)
  assert.throws(() => build({ storeDir: store, outDir: path.join(root, "out") }), { code: "invalid_facts_entry", message: /factory build: invalid_facts_entry/u })
  assert.equal(existsSync(marker), false)
  rmSync(candidate)
  writeFileSync(path.join(store, "facts", "notes.txt"), "maintainer notes")
  assert.throws(() => build({ storeDir: store, outDir: path.join(root, "out") }), { code: "invalid_facts_entry" })
  rmSync(path.join(store, "facts", "notes.txt"))
  mkdirSync(path.join(store, "facts", "nested"))
  assert.throws(() => build({ storeDir: store, outDir: path.join(root, "out") }), { code: "facts_entry_not_regular_file" })
  rmSync(path.join(store, "facts", "nested"), { recursive: true })

  const fact = path.join(store, "facts", readdirSync(path.join(store, "facts")).sort()[0])
  writeFileSync(fact, "{")
  assert.throws(() => build({ storeDir: store, outDir: path.join(root, "out") }), { code: "invalid_published_facts" })
  cpSync(STORE, store, { recursive: true, force: true })

  const target = path.join(root, "outside.json")
  writeFileSync(target, readFileSync(fact))
  const link = path.join(store, "facts", "claude-code-55555555-5555-4555-8555-555555555555.json")
  symlinkSync(target, link)
  assert.equal(lstatSync(link).isSymbolicLink(), true)
  assert.throws(() => build({ storeDir: store, outDir: path.join(root, "out") }), { code: "facts_entry_not_regular_file", message: /regular files/u })
  assert.throws(() => build({ storeDir: store, outDir: store }), /outDir/u)
  assert.throws(() => build({ storeDir: store, outDir: root }), /outDir/u)

  rmSync(link)
  const outLink = path.join(root, "out-link")
  symlinkSync(path.join(root, "elsewhere"), outLink)
  assert.throws(() => build({ storeDir: store, outDir: outLink }), /outDir must not be a symlink/u)

  const storeFile = path.join(root, "store-file")
  writeFileSync(storeFile, "not a directory")
  assert.throws(() => build({ storeDir: storeFile, outDir: path.join(root, "unused") }), /store must be a real directory/u)
  const factsFileStore = path.join(root, "facts-file-store")
  mkdirSync(factsFileStore)
  writeFileSync(path.join(factsFileStore, "facts"), "not a directory")
  assert.throws(() => build({ storeDir: factsFileStore, outDir: path.join(root, "unused") }), { code: "facts_not_directory" })
  assert.throws(() => build({ storeDir: store, outDir: null }), /storeDir and outDir/u)
}))

test("jobReportUrl names a published job ID and refuses anything that is not 32 lowercase hex, or a store that is not owner/repo", () => {
  assert.equal(jobReportUrl({ store: "ourostack/factory", job: jobId({ deskRemote: "git@github.com:OuroStack/Desk.git", personPrefix: "", track: "factory", slug: "store-pipeline" }) }), "https://github.com/ourostack/factory/blob/reports/jobs/3e7101c7c7d8774223be31b99495dd7f.md")
  for (const store of ["not a store", null]) assert.throws(() => jobReportUrl({ store, job: "a".repeat(32) }), /store must be owner\/repo/u)
  assert.equal(jobReportUrl({ store: "ourostack/factory", job: "a".repeat(32) }), `https://github.com/ourostack/factory/blob/reports/jobs/${"a".repeat(32)}.md`)
  for (const job of [null, "A".repeat(32), "a".repeat(31), "../secret"]) assert.throws(() => jobReportUrl({ store: "ourostack/factory", job }), /job must be 32 lowercase hex/u)
})

test("storeRecords gives every job's rollup record exactly as the build reads the store", () => {
  const records = storeRecords(ROLLUP_STORE)
  assert.deepEqual(records.map((record) => record.job), ["1", "2", "3", "4", "5", "6"].map((digit) => digit.repeat(32)))
  assert.deepEqual(records[0].plugins, { desk: { min: "3.1.0", max: "3.1.0" } })
  assert.throws(() => storeRecords(5), /storeDir must be a path/u)
  assert.throws(() => storeRecords(path.join(ROLLUP_STORE, "facts", readdirSync(path.join(ROLLUP_STORE, "facts"))[0])), /store must be a real directory/u)
})

test("storePublicPlugins names only plugins that facts carrying the private-plugin count publish", () => scratch((root) => {
  const store = path.join(root, "store")
  cpSync(ROLLUP_STORE, store, { recursive: true })
  assert.deepEqual(storePublicPlugins(store), [], "facts from before the rule name no plugin as public")
  const names = readdirSync(path.join(store, "facts")).sort()
  const ruled = path.join(store, "facts", names[0])
  const value = JSON.parse(readFileSync(ruled, "utf8"))
  value.refs.private.plugins = 2
  value.plugins = [{ name: "superpowers", version: "6.4.1" }, ...value.plugins]
  writeFileSync(ruled, serializePublished(value))
  const legacy = path.join(store, "facts", names[1])
  const old = JSON.parse(readFileSync(legacy, "utf8"))
  old.plugins = [...old.plugins, { name: "ms-desk", version: "2.29.11" }]
  writeFileSync(legacy, serializePublished(old))
  assert.deepEqual(storePublicPlugins(store), ["desk", "superpowers"])
  assert.throws(() => storePublicPlugins(5), /storeDir must be a path/u)
  assert.throws(() => storePublicPlugins(ruled), /store must be a real directory/u)
}))

test("a store mixing legacy and per-worker files builds and legacy numbers are unchanged", () => scratch((root) => {
  const store = path.join(root, "store")
  cpSync(STORE, store, { recursive: true })
  const base = JSON.parse(readFileSync(path.join(STORE, "facts", "copilot-cli-22222222-2222-4222-8222-222222222222.json"), "utf8"))
  const split = { ...structuredClone(base), session: { ...base.session, id: "55555555-5555-4555-8555-555555555555" } }
  split.refs.prs = [{ repo: "ourostack/desk", number: 8, agent: 0 }]
  split.jobs = [
    { job: "cccccccccccccccccccccccccccccccc", agents: [0], basis: ["desk_tool"], session_offset_ms: 0, transitions: [], observed: { status: "processing", offset_ms: null } },
    { job: "dddddddddddddddddddddddddddddddd", agents: [1], basis: ["spawn_brief"], session_offset_ms: 0, transitions: [], observed: { status: "processing", offset_ms: null } },
  ]
  writeFileSync(path.join(store, "facts", `copilot-cli-${split.session.id}.json`), serializePublished(split))
  const out = path.join(root, "out")
  assert.deepEqual(build({ storeDir: store, outDir: out }), { jobs: 4, sessions: 5 })
  const actual = bytesByPath(out)
  const expected = bytesByPath(EXPECTED)
  for (const job of ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]) {
    for (const extension of ["json", "md"]) {
      const relative = `jobs/${job}.${extension}`
      assert.equal(Buffer.compare(actual[relative], expected[relative]), 0, relative)
    }
  }
  const first = JSON.parse(actual["jobs/cccccccccccccccccccccccccccccccc.json"])
  const second = JSON.parse(actual["jobs/dddddddddddddddddddddddddddddddd.json"])
  // Worker 0 is active over [0,6000] (turn 0-5000, tool 1000-6000) and worker 1
  // over [2000,8000] (subagent). The two jobs each get their own 6000 ms; the
  // session's whole union is 8000 ms, and the 4000 ms both workers overlap is
  // legitimately credited to each job.
  assert.equal(first.formulas.active_time_ms.value, 6000)
  assert.equal(second.formulas.active_time_ms.value, 6000)
}))

const CLOSED_JOB = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const OPEN_JOB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const FIRST_FACTS = "claude-code-11111111-1111-4111-8111-111111111111.json"

function withOutcomes(store, outcomes) {
  const factPath = path.join(store, "facts", FIRST_FACTS)
  const fact = JSON.parse(readFileSync(factPath, "utf8"))
  fact.outcomes = outcomes
  writeFileSync(factPath, serializePublished(fact))
}

test("the build writes rollups/outcomes.json and the job file carries the signoff formula with a state", () => scratch((root) => {
  const store = path.join(root, "store")
  cpSync(STORE, store, { recursive: true })
  withOutcomes(store, [
    { job: CLOSED_JOB, rev: 4, state: "accepted", verified: true, reason: null, deliveries: 1, wait: { class: "lt_1d", censored: false } },
    { job: "cccccccccccccccccccccccccccccccc", rev: 1, state: "delivered_unsigned", verified: null, reason: null, deliveries: 1, wait: { class: "lt_7d", censored: true } },
  ])
  const out = path.join(root, "out")
  build({ storeDir: store, outDir: out })
  const rollup = JSON.parse(readFileSync(path.join(out, "rollups", "outcomes.json"), "utf8"))
  assert.equal(rollup.schema, "desk.factory.rollups/1")
  assert.equal(rollup.signoff.recorded, true)
  assert.equal(rollup.signoff.jobs, 2)
  assert.equal(rollup.signoff.accepted, 1)
  assert.equal(rollup.signoff.delivered_unsigned, 1)
  assert.equal(rollup.signoff.jobs_without_work_record, 1)
  assert.equal(rollup.signoff.no_record, 1)
  assert.deepEqual(rollup.signoff.waits.unsigned, { lt_1h: 0, lt_1d: 0, lt_7d: 1, ge_7d: 0 })
  assert.equal(rollup.first_pass_yield.state, "unavailable")
  assert.deepEqual(rollup.first_pass_yield.reasons, ["no_delivered_jobs"])
  assert.equal(rollup.rework.state, "unavailable")
  const job = JSON.parse(readFileSync(path.join(out, "jobs", `${CLOSED_JOB}.json`), "utf8"))
  assert.deepEqual(job.formulas.signoff, { class: "declared", value: "accepted", verified: true, reason: null, wait: { class: "lt_1d", censored: false }, state: "measured", reasons: [] })
  assert.equal(job.timeline.outcome.rev, 4)
  const open = JSON.parse(readFileSync(path.join(out, "jobs", `${OPEN_JOB}.json`), "utf8"))
  assert.equal(open.formulas.signoff.state, "unavailable")
  assert.equal(open.timeline.outcome, null)
  assert.match(readFileSync(path.join(out, "jobs", `${CLOSED_JOB}.md`), "utf8"), /- Sign-off: accepted, waited under 1 day\./u)
  const page = readFileSync(path.join(out, "rollups", "index.md"), "utf8")
  assert.match(page, /## Sign-off/u)
  assert.match(page, /Accepted \(recorded by the agent on the operator.s word\): 1\./u)
}))

test("a store with no outcomes at all builds, and every sign-off count is absent or not recorded, never zero accepted", () => scratch((root) => {
  const out = path.join(root, "out")
  build({ storeDir: STORE, outDir: out })
  const rollup = JSON.parse(readFileSync(path.join(out, "rollups", "outcomes.json"), "utf8"))
  assert.deepEqual(rollup.signoff, { recorded: false })
  const page = readFileSync(path.join(out, "rollups", "index.md"), "utf8")
  assert.match(page, /Sign-off: not recorded in any session of this store\./u)
  assert.doesNotMatch(page, /Accepted \(verified\)|accepted but unverified/u)
  assert.match(readFileSync(path.join(out, "jobs", `${CLOSED_JOB}.md`), "utf8"), /- Sign-off: not recorded\./u)
}))

test("outcome output carries no planted free text, and an outcome entry with free text stops the build without echoing it", () => scratch((root) => {
  const store = path.join(root, "store")
  cpSync(STORE, store, { recursive: true })
  const entry = { job: CLOSED_JOB, rev: 1, state: "refused", verified: true, reason: "defect", deliveries: 1, wait: { class: "lt_1h", censored: false } }
  withOutcomes(store, [entry])
  const out = path.join(root, "out")
  build({ storeDir: store, outDir: out })
  for (const relative of ["rollups/outcomes.json", "rollups/index.md", `jobs/${CLOSED_JOB}.json`, `jobs/${CLOSED_JOB}.md`]) {
    const text = readFileSync(path.join(out, relative), "utf8")
    assert.equal(text.includes(SENTINEL), false, relative)
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}|\/(?:Users|home|tmp|var)\//u, relative)
  }
  for (const planted of [{ ...entry, reason: SENTINEL }, { ...entry, [SENTINEL]: true }, { ...entry, job: SENTINEL }, { ...entry, wait: { class: SENTINEL, censored: false } }]) {
    const factPath = path.join(store, "facts", FIRST_FACTS)
    const fact = JSON.parse(readFileSync(factPath, "utf8"))
    fact.outcomes = [planted]
    writeFileSync(factPath, JSON.stringify(fact))
    assert.throws(() => build({ storeDir: store, outDir: out }), (error) => error.code === "invalid_published_facts" && !error.message.includes(SENTINEL))
  }
}))

test("the build publishes first-pass yield with what it counted and what it left out, and the page says so", () => scratch((root) => {
  const store = path.join(root, "store")
  cpSync(STORE, store, { recursive: true })
  const returns = [{ reason: "agent_error", caught: "after_delivery", counts: true, refusal: "defect", refusal_verified: true }]
  withOutcomes(store, [
    { job: CLOSED_JOB, rev: 4, state: "refused", verified: true, reason: "defect", deliveries: 1, wait: { class: "lt_1d", censored: false }, since: "created", returns },
    { job: OPEN_JOB, rev: 2, state: "delivered_unsigned", verified: null, reason: null, deliveries: 1, wait: { class: "lt_1h", censored: true }, since: "created", returns: [] },
    { job: "cccccccccccccccccccccccccccccccc", rev: 1, state: "accepted", verified: true, reason: null, deliveries: 1, wait: null, since: "adopted" },
  ])
  const out = path.join(root, "out")
  build({ storeDir: store, outDir: out })
  const rollup = JSON.parse(readFileSync(path.join(out, "rollups", "outcomes.json"), "utf8"))
  assert.deepEqual(Object.keys(rollup), ["attention", "first_pass_yield", "groupings", "rework", "schema", "signoff"])
  assert.deepEqual(rollup.first_pass_yield, {
    state: "partial", value: 0.5, reasons: ["awaiting_signoff"], n: 1, N: 2, passed: 1, returned: 1, awaiting_signoff: 1, changed_ask_only: 0,
    excluded: [{ reason: "history_not_recorded", jobs: 1 }],
  })
  assert.equal(rollup.rework.state, "partial")
  assert.deepEqual(rollup.rework.reason_check, { state: "partial", compared: 1, disagree: 0, reasons: ["history_not_recorded"] })
  const page = readFileSync(path.join(out, "rollups", "index.md"), "utf8")
  assert.match(page, /at most 1 of 2 delivered jobs passed first time \(upper bound 50\.00%/u)
  assert.match(page, /Left out of the count: 1 job \(the task card does not record what was sent back\)\./u)
  const job = JSON.parse(readFileSync(path.join(out, "jobs", `${CLOSED_JOB}.json`), "utf8"))
  assert.equal(job.formulas.first_pass_yield.value, 0)
  assert.deepEqual(job.formulas.rework.value, { in_task: 0, at_review: 0, after_delivery: 1 })
}))

test("built pages and the README say what each host cannot record, with no raw reason identifier", () => scratch((root) => {
  const out = path.join(root, "out")
  build({ storeDir: ROLLUP_STORE, outDir: out })
  const pages = bytesByPath(out)
  const readme = pages["README.md"].toString("utf8")
  assert.match(readme, /rollups\/totals\.json/u)
  assert.match(readme, /Cost in money is not measured/u)
  for (const relative of Object.keys(pages).filter((name) => name.endsWith(".md"))) {
    const text = pages[relative].toString("utf8")
    assert.doesNotMatch(text, /\b(host_does_not_record|host_records_partly|field_absent|worker_split|open_job|job_offsets_unavailable|not_collected_in_slice_1)\b/u, relative)
    assert.equal(text.includes("a reason this report has no words for yet"), false, relative)
    for (const line of text.split("\n").filter((entry) => entry.startsWith("- Public pull requests"))) {
      assert.match(line, /public commits: (?:\d+ \((?:measured|partial: [^)]*)\)|not recorded \([^)]*\))/u, relative)
    }
  }
}))

// --- the attention headline in the built files (task E8) -----------------------

const COPILOT_FACTS = "copilot-cli-22222222-2222-4222-8222-222222222222.json"
const turnOf = (at_ms) => ({ at_ms, basis: "after_stop", window_ms: 3000, prompt_class: "xs", output_class: "none" })

// Rewrites one facts file as `/2` with a list of human turns and, optionally, a flag on the field.
function withTurns(store, file, turns, flags = []) {
  const factPath = path.join(store, "facts", file)
  const fact = JSON.parse(readFileSync(factPath, "utf8"))
  fact.schema = "desk.factory.published/2"
  fact.human_turns = turns
  fact.unavailable = [...fact.unavailable, ...flags.map((reason) => ({ field: "human_turns", reason }))]
  writeFileSync(factPath, serializePublished(fact))
}

const outcomeFile = (out) => JSON.parse(readFileSync(path.join(out, "rollups", "outcomes.json"), "utf8"))

test("the build publishes the attention headline, its companions and the plugin version groups, and the page prints them", () => scratch((root) => {
  const store = path.join(root, "store")
  cpSync(STORE, store, { recursive: true })
  // The old-format Copilot sessions of the store are from before the record: they are outside the period and leave the headline measured.
  withOutcomes(store, [{ job: CLOSED_JOB, rev: 4, state: "accepted", verified: true, reason: null, deliveries: 1, wait: null }])
  withTurns(store, FIRST_FACTS, [turnOf(1000), turnOf(2000)])
  const out = path.join(root, "out")
  build({ storeDir: store, outDir: out })
  const { attention, groupings } = outcomeFile(out)
  assert.deepEqual(attention.headline, { state: "measured", value: 6000, reasons: [], n: 1, N: 1, numerator_ms: 6000, accepted_outcomes: 1 })
  assert.equal(attention.human_turns, 2)
  assert.deepEqual(attention.sessions, { in_period: 1, complete: 1 })
  assert.equal(attention.est_ms.attributed + attention.est_ms.unattributed + attention.est_ms.unplaced, 6000)
  assert.equal(attention.method.version, 1)
  // The groups use exactly the plugin version keys the job rollups use.
  const measures = JSON.parse(readFileSync(path.join(out, "rollups", "measures.json"), "utf8"))
  assert.deepEqual(Object.keys(groupings.plugin_version).sort(), Object.keys(measures.groupings.plugin_version).sort())
  const sum = (pick) => Object.values(groupings.plugin_version).reduce((total, group) => total + (pick(group) ?? 0), 0)
  assert.equal(sum((group) => group.attention.headline.numerator_ms), attention.headline.numerator_ms)
  assert.equal(sum((group) => group.signoff.accepted), 1)
  const page = readFileSync(path.join(out, "rollups", "index.md"), "utf8")
  assert.match(page, /- Human attention per accepted outcome: about 6 seconds \(an estimate, method version 1; measured\)\./u)
  const job = readFileSync(path.join(out, "jobs", `${CLOSED_JOB}.md`), "utf8")
  assert.match(job, /- Human attention: /u)
}))

test("a Copilot session in the period makes the built headline partial, and the page says why in words", () => scratch((root) => {
  const store = path.join(root, "store")
  cpSync(STORE, store, { recursive: true })
  withOutcomes(store, [{ job: CLOSED_JOB, rev: 4, state: "accepted", verified: true, reason: null, deliveries: 1, wait: null }])
  withTurns(store, FIRST_FACTS, [turnOf(1000)])
  withTurns(store, COPILOT_FACTS, [turnOf(1000)], ["host_records_partly"])
  const out = path.join(root, "out")
  build({ storeDir: store, outDir: out })
  const { attention } = outcomeFile(out)
  assert.equal(attention.headline.state, "partial")
  assert.deepEqual(attention.headline.reasons, ["host_records_partly", "turns_not_recorded"])
  // The other, old-format Copilot sessions are outside the period.
  assert.deepEqual(attention.sessions, { in_period: 2, complete: 1 })
  const page = readFileSync(path.join(out, "rollups", "index.md"), "utf8")
  assert.match(page, /partial, so a lower bound: .*a host records the human's turns only in part/u)
  assert.doesNotMatch(page, /host_records_partly|turns_not_recorded/u)
}))

test("a store with no accepted outcome says so, and the attention file carries only counts and codes", () => scratch((root) => {
  const out = path.join(root, "out")
  build({ storeDir: STORE, outDir: out })
  const { attention, groupings } = outcomeFile(out)
  assert.deepEqual(attention.headline, { state: "unavailable", reasons: ["no_accepted_outcomes", "no_turn_records"], n: 0, N: 0, accepted_outcomes: 0 })
  // Every session of the store is from an old-format file, so none is in the period, and nothing is published as a zero.
  assert.deepEqual(attention.sessions, { in_period: 0, complete: 0 })
  assert.equal(Object.hasOwn(attention, "human_turns"), false)
  assert.equal(Object.hasOwn(attention.headline, "numerator_ms"), false)
  assert.match(readFileSync(path.join(out, "rollups", "index.md"), "utf8"), /- Human attention per accepted outcome: no accepted outcomes yet, and no human attention is recorded in the period/u)
  const strings = []
  const visit = (value, key) => {
    if (typeof value === "string") strings.push([key, value])
    else if (Array.isArray(value)) value.forEach((entry) => visit(entry, key))
    else if (value !== null && typeof value === "object") for (const [name, child] of Object.entries(value)) visit(child, name)
  }
  visit({ attention, groupings })
  for (const [key, value] of strings) {
    if (key === "reasons" || key === "reason") assert.ok(Object.hasOwn(REASON_TEXT, value), `${value} has words`)
    else assert.ok(["state"].includes(key) && ["measured", "partial", "unavailable"].includes(value), `${key} holds only a state or a reason`)
  }
  assert.ok(!JSON.stringify({ attention, groupings }).includes(SENTINEL))
}))
