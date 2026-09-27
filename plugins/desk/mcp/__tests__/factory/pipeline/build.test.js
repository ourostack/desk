import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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

test("two builds over identical input are byte-identical", () => scratch((root) => {
  const first = path.join(root, "first")
  const second = path.join(root, "second")
  build({ storeDir: STORE, outDir: first })
  build({ storeDir: STORE, outDir: second })
  const left = bytesByPath(first)
  const right = bytesByPath(second)
  assert.deepEqual(Object.keys(left), Object.keys(right))
  for (const relative of Object.keys(left)) assert.equal(Buffer.compare(left[relative], right[relative]), 0, relative)
}))

test("generated output contains no date, time of day, absolute path, or planted free-text sentinel", () => scratch((root) => {
  const out = path.join(root, "out")
  build({ storeDir: STORE, outDir: out })
  for (const [relative, contents] of Object.entries(bytesByPath(out))) {
    const text = contents.toString("utf8")
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/u, relative)
    assert.doesNotMatch(text, /\d{2}:\d{2}/u, relative)
    assert.doesNotMatch(text, /\/(?:Users|home|tmp|var)\/|[A-Za-z]:\\/u, relative)
    assert.equal(text.includes(SENTINEL), false, relative)
  }
}))

test("build reads facts as data only and rejects unexpected entries, invalid bytes, symlinks, and unsafe output paths", () => scratch((root) => {
  const store = path.join(root, "store")
  cpSync(STORE, store, { recursive: true })
  const marker = path.join(root, "executed")
  const candidate = path.join(store, "facts", "candidate.js")
  writeFileSync(candidate, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`)
  assert.throws(() => build({ storeDir: store, outDir: path.join(root, "out") }), /invalid facts entry/u)
  assert.equal(existsSync(marker), false)
  rmSync(candidate)

  const fact = path.join(store, "facts", readdirSync(path.join(store, "facts")).sort()[0])
  writeFileSync(fact, "{")
  assert.throws(() => build({ storeDir: store, outDir: path.join(root, "out") }), /invalid published facts/u)
  cpSync(STORE, store, { recursive: true, force: true })

  const target = path.join(root, "outside.json")
  writeFileSync(target, readFileSync(fact))
  const link = path.join(store, "facts", "claude-code-55555555-5555-4555-8555-555555555555.json")
  symlinkSync(target, link)
  assert.equal(lstatSync(link).isSymbolicLink(), true)
  assert.throws(() => build({ storeDir: store, outDir: path.join(root, "out") }), /regular files/u)
  assert.throws(() => build({ storeDir: store, outDir: store }), /outDir/u)
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
})
