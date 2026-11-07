// The pull request's fail-fast pass parses every changed file and runs the changed test files that fit its time budget; the coverage
// shards still run everything, so the pass may leave a slow file to them but must never be the only place a file is checked.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", ".github", "scripts")
const { plan, changedFiles, parseErrors, BUDGET_SECONDS, PER_FILE_SECONDS } = await import(pathToFileURL(path.join(scripts, "quick-checks.mjs")).href)

const table = { defaultSeconds: 8, files: { "a/slow.test.js": PER_FILE_SECONDS + 1, "a/quick.test.js": 1, "b/mid.test.js": 50 } }
const always = () => true

test("changed JavaScript, JSON and YAML files are parsed, and files that no longer exist are not", () => {
  const changed = ["plugins/desk/mcp/src/a.js", "scripts/b.cjs", "x/c.mjs", "d.json", ".github/workflows/e.yml", "f.yaml", "README.md", "gone.js"]
  const { parse } = plan(changed, table, (file) => file !== "gone.js")
  assert.deepEqual(parse.js, ["plugins/desk/mcp/src/a.js", "scripts/b.cjs", "x/c.mjs"])
  assert.deepEqual(parse.json, ["d.json"])
  assert.deepEqual(parse.yaml, [".github/workflows/e.yml", "f.yaml"])
})

test("only changed Desk unit test files run, and a file over the per-file limit is left to the shards", () => {
  const changed = ["tests/desk/mcp/__tests__/a/slow.test.js", "tests/desk/mcp/__tests__/a/quick.test.js", "tests/desk/mcp/__tests__/_isolated_env.mjs", "evals/offline/__tests__/x.test.mjs", "plugins/desk/mcp/src/a.test.js"]
  const { run, deferred } = plan(changed, table, always)
  assert.deepEqual(run, ["a/quick.test.js"])
  assert.deepEqual(deferred, ["a/slow.test.js"])
})

test("the budget runs the lightest files first and defers the rest", () => {
  const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`t/f${String(i).padStart(2, "0")}.test.js`, 50]))
  const { run, deferred } = plan(Object.keys(files).map((file) => `tests/desk/mcp/__tests__/${file}`), { defaultSeconds: 8, files }, always)
  assert.equal(run.length, Math.floor(BUDGET_SECONDS / 50))
  assert.equal(run.length + deferred.length, 20)
  // A file the table does not list weighs the default and still runs.
  assert.deepEqual(plan(["tests/desk/mcp/__tests__/new.test.js"], table, always).run, ["new.test.js"])
})

test("no usable base or a failed diff gives no file list, and a diff lists added and modified files", () => {
  const git = (diff) => (args) => (args[0] === "cat-file" ? { status: 0 } : diff)
  assert.equal(changedFiles(""), null)
  assert.equal(changedFiles("0000000000000000000000000000000000000000"), null)
  assert.equal(changedFiles("base", () => ({ status: 128 })), null)
  assert.equal(changedFiles("base", git({ status: 1, stdout: "" })), null)
  assert.deepEqual(changedFiles("base", git({ status: 0, stdout: "a.js\nb.json\n" })), ["a.js", "b.json"])
})

test("the command line with no base checks nothing and passes", () => {
  const result = spawnSync(process.execPath, [path.join(scripts, "quick-checks.mjs"), ""], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /No usable base/u)
})

test("a file that does not parse is named, and files that parse are not", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-quick-checks-"))
  try {
    const files = { "good.mjs": "export const a = 1\n", "bad.mjs": "export const = 1\n", "good.json": "{}", "bad.json": "{", "good.yml": "a: 1\n", "bad.yml": "a: [1\n" }
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body)
    const errors = parseErrors({ js: ["good.mjs", "bad.mjs"], json: ["good.json", "bad.json"], yaml: ["good.yml", "bad.yml"] }, dir)
    assert.deepEqual(errors.map((error) => error.split(":")[0]), ["bad.mjs", "bad.json", "bad.yml"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the command line passes when nothing changed since the base", () => {
  const repo = path.resolve(scripts, "..", "..")
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()
  const result = spawnSync(process.execPath, [path.join(scripts, "quick-checks.mjs"), head], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /No changed test file to run here/u)
})
