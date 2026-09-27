import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { build, jobLink } from "../../../src/factory/pipeline/build.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, "..", "fixtures")
const STORE = path.join(FIXTURES, "store")
const EXPECTED = path.join(FIXTURES, "store-expected")
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

test("build ignores labels, even malformed ones, until the reports consume them", () => scratch((root) => {
  const store = path.join(root, "store")
  const out = path.join(root, "out")
  cpSync(STORE, store, { recursive: true })
  assert.equal(existsSync(path.join(store, "labels", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "11111111-1111-4111-8111-111111111111.json")), true)
  mkdirSync(path.join(store, "labels", "nested", "deeper"), { recursive: true })
  writeFileSync(path.join(store, "labels", "nested", "deeper", "junk.json"), `{"${SENTINEL}":`)
  writeFileSync(path.join(store, "labels", SENTINEL), SENTINEL)
  assert.deepEqual(build({ storeDir: store, outDir: out }), { jobs: 2, sessions: 4 })
  const actual = bytesByPath(out)
  const expected = bytesByPath(EXPECTED)
  assert.deepEqual(Object.keys(actual), Object.keys(expected))
  for (const relative of Object.keys(expected)) assert.equal(Buffer.compare(actual[relative], expected[relative]), 0, relative)
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
  for (const [relative, contents] of Object.entries(bytesByPath(out))) {
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
  assert.deepEqual(Object.keys(empty), ["README.md", "index.md"])
  assert.match(empty["index.md"].toString("utf8"), /No job has published facts yet\./u)

  mkdirSync(path.join(store, "facts"))
  writeFileSync(path.join(store, "facts", ".gitkeep"), "")
  mkdirSync(path.join(store, "facts", ".hidden"))
  assert.deepEqual(build({ storeDir: store, outDir: out }), { jobs: 0, sessions: 0 })
  assert.equal(Buffer.compare(bytesByPath(out)["index.md"], empty["index.md"]), 0)
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

test("jobLink reuses the accepted job identity and validates the public store name", () => {
  assert.equal(jobLink({
    store: "ourostack/factory",
    deskRemote: "git@github.com:OuroStack/Desk.git",
    personPrefix: "",
    track: "factory",
    slug: "store-pipeline",
  }), "https://github.com/ourostack/factory/blob/reports/jobs/3e7101c7c7d8774223be31b99495dd7f.md")
  assert.throws(() => jobLink({ store: "not a store", deskRemote: "https://github.com/ourostack/desk", personPrefix: "", track: "factory", slug: "store-pipeline" }), /store/u)
  assert.throws(() => jobLink({ store: null, deskRemote: "https://github.com/ourostack/desk", personPrefix: "", track: "factory", slug: "store-pipeline" }), /store/u)
})
