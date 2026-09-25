import { strict as assert } from "node:assert"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const require = createRequire(import.meta.url)
const script = path.join(repoRoot, "scripts", "check-dependency-channels.cjs")
const checker = require(script)

function withPlugins(manifests, fn) {
  const root = mkdtempSync(path.join(tmpdir(), "dependency-channels-"))
  try {
    for (const [plugin, manifest] of Object.entries(manifests)) {
      mkdirSync(path.join(root, "plugins", plugin), { recursive: true })
      if (manifest !== null) {
        writeFileSync(path.join(root, "plugins", plugin, "agency.json"), JSON.stringify(manifest))
      }
    }
    writeFileSync(path.join(root, "plugins", "README.md"), "not a plugin directory\n")
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("this repository's plugin dependencies track release channels", () => {
  assert.deepEqual(checker.checkDependencyChannels({ repoRoot }), [])
})

test("dependencies may name a release channel or no ref at all", () => {
  for (const spec of [
    "github:ourostack/desk:plugins/superpowers@main",
    "github:ourostack/desk:plugins/desk",
    "github:example-org/example-mcp:.",
    "github:someone/else",
    "npm:left-pad",
    42,
  ]) {
    assert.equal(checker.dependencyProblem(spec), null, String(spec))
  }
})

test("exact commits, forks, other branches and malformed specs are rejected", () => {
  assert.match(checker.dependencyProblem("github:ourostack/desk:plugins/desk@d89126223a4e08b07b8e4e8d738c15b92a6c597f"), /pins exact commit/u)
  assert.match(checker.dependencyProblem("github:example-org/example-overlay:plugins/example-overlay@4597a49"), /pins exact commit/u)
  assert.match(checker.dependencyProblem("github:arimendelow/desk:plugins/desk@main"), /points at a fork \(arimendelow\)/u)
  assert.match(checker.dependencyProblem("github:ourostack/desk:plugins/desk@user/ari/feature"), /not a release channel/u)
  assert.match(checker.dependencyProblem("github:not-a-repo"), /is not a github:/u)
  assert.deepEqual(checker.parseGithubDependency("github:o/r"), { owner: "o", repo: "r", path: "", ref: null })
})

test("main is the only release channel and ouroboros-skills coordinates have moved", () => {
  assert.equal(checker.dependencyProblem("github:ourostack/desk:plugins/plain-language@main"), null)
  assert.match(checker.dependencyProblem("github:ourostack/desk:plugins/plain-language@v2-alpha"), /not a release channel/u)
  assert.match(checker.dependencyProblem("github:ourostack/ouroboros-skills:plugins/desk@v2-alpha"), /moved to ourostack\/desk/u)
  assert.match(checker.dependencyProblem("github:ourostack/ouroboros-skills:plugins/desk"), /moved to ourostack\/desk/u)
  assert.match(checker.dependencyProblem("github:arimendelow/ouroboros-skills:plugins/desk@main"), /moved to ourostack\/desk/u)
  assert.equal(checker.dependencyProblem("github:ourostack/ouroboros-skills:plugins/crew@v2-alpha"), "moved to ourostack/desk; use github:ourostack/desk:plugins/crew@main")
  assert.equal(checker.dependencyProblem("github:ourostack/ouroboros-skills@v2-alpha"), "moved to ourostack/desk; use github:ourostack/desk@main")
  assert.deepEqual(checker.RELEASE_CHANNELS, ["main"])
})

test("repositories named like built-in object properties are ordinary repositories", () => {
  for (const repo of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.equal(checker.dependencyProblem(`github:someone/${repo}:plugins/x@main`), null, repo)
    assert.match(checker.dependencyProblem(`github:someone/${repo}:plugins/x@v2-alpha`), /tracks v2-alpha, which is not a release channel \(main\)/u, repo)
  }
})

test("the checker reports every offending manifest entry", () => {
  withPlugins({
    good: { dependencies: ["github:ourostack/desk:plugins/desk@main"] },
    pinned: { dependencies: ["github:ourostack/desk:plugins/desk@0123456789abcdef"] },
    empty: {},
    nomanifest: null,
  }, (root) => {
    assert.deepEqual(checker.checkDependencyChannels({ repoRoot: root }), [
      "plugins/pinned/agency.json: github:ourostack/desk:plugins/desk@0123456789abcdef pins exact commit 0123456789abcdef; track a release channel (main) instead",
    ])
    const logs = []
    assert.equal(checker.runCli({ repoRoot: root, log: (line) => logs.push(line), error: (line) => logs.push(line) }), 1)
    assert.match(logs.join("\n"), /must track a release channel branch/u)
  })
  withPlugins({ good: { dependencies: [] } }, (root) => {
    const logs = []
    assert.equal(checker.runCli({ repoRoot: root, log: (line) => logs.push(line) }), 0)
    assert.deepEqual(logs, ["Plugin dependencies track release channels."])
  })
})

test("the CLI exits zero on this repository and uses its defaults", () => {
  const output = execFileSync(process.execPath, [script], { cwd: repoRoot, encoding: "utf8", env: process.env })
  assert.match(output, /track release channels/u)
  const cwd = process.cwd()
  process.chdir(repoRoot)
  try {
    assert.deepEqual(checker.checkDependencyChannels(), [])
    const original = console.log
    console.log = () => {}
    try {
      assert.equal(checker.runCli(), 0)
    } finally {
      console.log = original
    }
  } finally {
    process.chdir(cwd)
  }
})
