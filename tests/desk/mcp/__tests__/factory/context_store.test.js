import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { runValidatePrCommand } from "../../../../../plugins/desk/mcp/scripts/factory.js"
import { build } from "../../../../../plugins/desk/mcp/src/factory/pipeline/build.js"
import { validatePr } from "../../../../../plugins/desk/mcp/src/factory/pipeline/validate-pr.js"
import { contextFacts, contextRecord, reviewContext, CONTEXT_JOB } from "./_context_fixture.js"

const bytes = (value) => `${JSON.stringify(value)}\n`
function change(facts = contextFacts()) {
  return {
    path: `context/${CONTEXT_JOB}.json`, status: "added", bytes: bytes(contextRecord(facts)),
    facts: [{ path: `facts/${facts.session.host}-${facts.session.id}.json`, bytes: bytes(facts) }],
  }
}
function store() {
  const root = mkdtempSync(join(tmpdir(), "desk-context-store-"))
  const facts = contextFacts()
  mkdirSync(join(root, "facts"))
  mkdirSync(join(root, "context"))
  writeFileSync(join(root, "facts", `${facts.session.host}-${facts.session.id}.json`), bytes(facts))
  return { root, facts, out: join(root, "reports"), contextFile: join(root, "context", `${CONTEXT_JOB}.json`) }
}
const report = (out) => JSON.parse(readFileSync(join(out, "jobs", `${CONTEXT_JOB}.json`), "utf8"))

test("a trusted intake accepts reviewed context only against its actual bound facts", () => {
  assert.deepEqual(validatePr({ changes: [change()], trustedMaintainer: true }), { ok: true, errors: [] })
})

test("numeric contribution authority alone does not authorize arbitrary public prose", () => {
  const result = validatePr({ changes: [change()], trustedMaintainer: false })
  assert.ok(result.errors.some((entry) => entry.code === "context_authority"))
})

test("context intake errors have their own family without changing numeric error codes", () => {
  const wrong = change()
  wrong.path = `context/${"f".repeat(32)}.json`
  assert.deepEqual(validatePr({ changes: [wrong], trustedMaintainer: true }).errors, [{ code: "context_job_mismatch", path: wrong.path }])
  const removed = { path: wrong.path, status: "removed" }
  assert.deepEqual(validatePr({ changes: [removed] }).errors, [{ code: "context_removal", path: wrong.path }])
})

test("intake rejects stale sources, absent facts, path mismatches and modified downgrades", () => {
  const stale = change()
  const updated = contextFacts()
  updated.intervals[0].end_ms += 1
  stale.facts[0].bytes = bytes(updated)
  const missing = change()
  missing.facts = []
  const wrong = change()
  wrong.path = `context/${"f".repeat(32)}.json`
  const modified = change()
  modified.status = "modified"
  for (const [input, code] of [[stale, "context_source_changed"], [missing, "context_facts_missing"], [wrong, "context_job_mismatch"], [modified, "context_previous_missing"]]) {
    const result = validatePr({ changes: [input], trustedMaintainer: true })
    assert.ok(result.errors.some((entry) => entry.code === code), JSON.stringify(result))
  }
})

test("context intake refuses unreadable predecessor records and malformed or mismatched source entries", () => {
  const original = change()
  const modified = { ...original, status: "modified", previousBytes: "{}\n" }
  assert.ok(validatePr({ changes: [modified], trustedMaintainer: true }).errors.some((entry) => entry.code === "context_previous_invalid"))
  const noFacts = { ...original, facts: undefined }
  assert.ok(validatePr({ changes: [noFacts], trustedMaintainer: true }).errors.some((entry) => entry.code === "context_type"))
  for (const item of [
    null, { path: null }, { path: "SENTINEL.json" },
    { ...original.facts[0], bytes: "{}\n" },
    { ...original.facts[0], path: "facts/copilot-cli-3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60.json" },
    { ...original.facts[0], path: "facts/claude-code-22bc1234-1234-4abc-8abc-123456789abc.json" },
  ]) {
    const result = validatePr({ changes: [{ ...original, facts: [item] }], trustedMaintainer: true })
    assert.ok(result.errors.some((entry) => entry.code === "context_facts_invalid"), JSON.stringify(result))
    assert.equal(JSON.stringify(result).includes("SENTINEL"), false)
  }
})

test("context replacements cannot downgrade either the evaluator or its independent privacy reviewer", () => {
  const facts = contextFacts()
  const current = contextRecord(facts)
  for (const field of ["evaluator", "reviewer"]) {
    const previous = contextRecord(facts)
    if (field === "evaluator") {
      previous.evaluator.plugin_version = "3.2.0-alpha.2"
      reviewContext(previous)
    } else previous.privacy.reviewer.plugin_version = "3.2.0-alpha.2"
    const result = validatePr({ changes: [{
      ...change(facts), status: "modified", bytes: bytes(current), previousBytes: bytes(previous),
    }], trustedMaintainer: true })
    assert.ok(result.errors.some((entry) => entry.code === "context_evaluator_downgrade"), JSON.stringify(result))
  }
  const machine = contextRecord(facts)
  Object.assign(machine, { state: "unavailable", heading: null, events: [],
    coverage: { state: "unavailable", reasons: ["not_recorded"], omitted_events: 0 } })
  reviewContext(machine)
  Object.assign(machine.privacy, { verdict: "not_required", reviewer: null })
  for (const [before, after] of [[current, current], [machine, current], [current, machine], [machine, machine]]) {
    assert.deepEqual(validatePr({ changes: [{
      ...change(facts), status: "modified", bytes: bytes(after), previousBytes: bytes(before),
    }], trustedMaintainer: true }), { ok: true, errors: [] })
  }
})

test("build publishes a checked context in JSON and readable Markdown without changing formulas", () => {
  const { root, facts, out, contextFile } = store()
  build({ storeDir: root, outDir: out })
  const before = report(out)
  assert.equal(before.context, undefined)
  writeFileSync(contextFile, bytes(contextRecord(facts)))
  build({ storeDir: root, outDir: out })
  const after = report(out)
  assert.equal(after.context.state, "published")
  assert.equal(after.context.record.heading, "Restore the device connection")
  assert.deepEqual(after.formulas, before.formulas)
  assert.deepEqual(after.clocks, before.clocks)
  const markdown = readFileSync(join(out, "jobs", `${CONTEXT_JOB}.md`), "utf8")
  assert.ok(markdown.includes("Tested the connection and recorded the observed behavior."))
})

test("build withholds old prose when source facts change instead of presenting it as current", () => {
  const { root, facts, out, contextFile } = store()
  writeFileSync(contextFile, bytes(contextRecord(facts)))
  facts.intervals[0].end_ms += 1
  writeFileSync(join(root, "facts", `${facts.session.host}-${facts.session.id}.json`), bytes(facts))
  build({ storeDir: root, outDir: out })
  assert.deepEqual(report(out).context, { state: "unavailable", reason: "source_changed", record: null })
  assert.equal(readFileSync(join(out, "jobs", `${CONTEXT_JOB}.md`), "utf8").includes("Tested the connection"), false)
})

test("checked reports distinguish withheld and unavailable explanations without inventing prose", () => {
  for (const state of ["withheld", "unavailable"]) {
    const { root, facts, out, contextFile } = store()
    const value = contextRecord(facts)
    Object.assign(value, { state, heading: null, events: [],
      coverage: { state: "unavailable", reasons: [state === "withheld" ? "withheld" : "not_recorded"], omitted_events: 0 } })
    writeFileSync(contextFile, bytes(reviewContext(value)))
    build({ storeDir: root, outDir: out })
    assert.equal(report(out).context.state, state)
    const markdown = readFileSync(join(out, "jobs", `${CONTEXT_JOB}.md`), "utf8")
    assert.ok(markdown.includes(state === "withheld" ? "withheld for privacy" : "explanation is not recorded"))
    assert.equal(markdown.includes("Restore the device"), false)
  }
})

test("checked report context retains prerequisite, optional resumption and explicit partial coverage", () => {
  for (const resumption of [null, "Retesting resumed after the software update."]) {
    const { root, facts, out, contextFile } = store()
    const value = contextRecord(facts)
    value.heading = null
    value.events.push({
      ...structuredClone(value.events[0]), id: "1123456789abcdef", kind: "waiting", lean: "waiting",
      explanation: "Retesting waited for the required software update.", reason: "The software update was required.",
      prerequisite: "Install the required software update.", resumption,
      evidence: [{ ...value.events[0].evidence[0], range: [250000, 600000] }],
    }, {
      ...structuredClone(value.events[0]), id: "2123456789abcdef", kind: "result", lean: "value",
      explanation: "Verified the device connection.", evidence: [{ ...value.events[0].evidence[0], range: [605000, 1200000] }],
    })
    value.coverage = { state: "partial", reasons: ["omitted"], omitted_events: 1 }
    writeFileSync(contextFile, bytes(reviewContext(value)))
    build({ storeDir: root, outDir: out })
    const markdown = readFileSync(join(out, "jobs", `${CONTEXT_JOB}.md`), "utf8")
    assert.ok(markdown.includes("Waiting (high confidence)"))
    assert.ok(markdown.includes("Result (high confidence)"))
    assert.ok(markdown.includes("Reason: The software update was required. Prerequisite: Install the required software update."))
    assert.equal(markdown.includes("Resumption:"), resumption !== null)
    assert.ok(markdown.includes("1 events omitted. Unexplained time remains unexplained."))
  }
})

test("the build refuses a non-directory context root, unexpected entry names and mismatched job identity", () => {
  const notDirectory = store()
  renameSync(join(notDirectory.root, "context"), join(notDirectory.root, "context-preserved"))
  writeFileSync(join(notDirectory.root, "context"), "not a directory")
  assert.throws(() => build({ storeDir: notDirectory.root, outDir: notDirectory.out }), { code: "context_not_directory" })
  const unexpected = store()
  writeFileSync(join(unexpected.root, "context", "notes.json"), bytes(contextRecord(unexpected.facts)))
  assert.throws(() => build({ storeDir: unexpected.root, outDir: unexpected.out }), { code: "invalid_context_entry" })
  const mismatch = store()
  const value = contextRecord(mismatch.facts)
  value.job = "f".repeat(32)
  writeFileSync(mismatch.contextFile, bytes(reviewContext(value)))
  assert.throws(() => build({ storeDir: mismatch.root, outDir: mismatch.out }), { code: "invalid_published_context" })
})

test("invalid or linked context entries fail the build without echoing their content", () => {
  const { root, facts, out, contextFile } = store()
  const value = contextRecord(facts)
  value.heading = "SENTINEL@example.com"
  writeFileSync(contextFile, bytes(value))
  assert.throws(() => build({ storeDir: root, outDir: out }), (error) => error.code === "invalid_published_context" && !error.message.includes("SENTINEL"))
  const linked = store()
  const target = join(linked.root, "source.json")
  writeFileSync(target, bytes(contextRecord(linked.facts)))
  symlinkSync(target, linked.contextFile)
  assert.throws(() => build({ storeDir: linked.root, outDir: linked.out }), { code: "invalid_context_entry" })
})

test("the CLI checks context against the merged tree, not its branch's earlier facts", async () => {
  const { root, facts, contextFile } = store()
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "-q", "-b", "main")
  git("config", "user.email", "16390116+arimendelow@users.noreply.github.com")
  git("config", "user.name", "Context Test")
  git("config", "commit.gpgsign", "false")
  git("add", "facts")
  git("commit", "-qm", "base facts")
  const base = git("rev-parse", "HEAD")
  git("switch", "-qc", "candidate")
  writeFileSync(contextFile, bytes(contextRecord(facts)))
  git("add", "context")
  git("commit", "-qm", "context")
  const head = git("rev-parse", "HEAD")
  const validate = (tip, association = "OWNER") => runValidatePrCommand({ cwd: root, argv: ["--base", tip, "--head", head, "--author-association", association] })
  assert.deepEqual(await validate(base), { ok: true, errors: [], maintenance: false })
  assert.equal((await validate(base, "NONE")).ok, false)
  git("switch", "-q", "main")
  const additional = contextFacts()
  additional.session.id = "22bc1234-1234-4abc-8abc-123456789abc"
  writeFileSync(join(root, "facts", `${additional.session.host}-${additional.session.id}.json`), bytes(additional))
  git("add", "facts")
  git("commit", "-qm", "another machine contributes a session for the same job")
  const incomplete = await validate(git("rev-parse", "HEAD"))
  assert.equal(incomplete.maintenance, false)
  assert.ok(incomplete.errors.some((entry) => entry.code === "context_source_set_changed"), JSON.stringify(incomplete))
  facts.intervals[0].end_ms += 1
  writeFileSync(join(root, "facts", `${facts.session.host}-${facts.session.id}.json`), bytes(facts))
  git("add", "facts")
  git("commit", "-qm", "new source")
  const refused = await validate(git("rev-parse", "HEAD"))
  assert.equal(refused.maintenance, false)
  assert.ok(refused.errors.some((entry) => entry.code === "context_source_changed"))
  const linked = contextRecord(facts)
  linked.state = "unavailable"
  linked.heading = null
  linked.events = []
  linked.sources = []
  linked.coverage = { state: "unavailable", reasons: ["not_recorded"], omitted_events: 0 }
  const linkBase = git("rev-parse", "HEAD")
  mkdirSync(join(root, "context"), { recursive: true })
  writeFileSync(contextFile, JSON.stringify(reviewContext(linked)))
  const linkBlob = git("hash-object", "-w", contextFile)
  git("update-index", "--add", "--cacheinfo", `120000,${linkBlob},context/${CONTEXT_JOB}.json`)
  git("commit", "-qm", "nonregular context")
  const mode = await runValidatePrCommand({ cwd: root, argv: ["--base", linkBase, "--head", git("rev-parse", "HEAD"), "--author-association", "OWNER"] })
  assert.ok(mode.errors.some((entry) => entry.code === "context_not_regular"))
})
