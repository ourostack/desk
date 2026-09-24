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
    "github:ourostack/ouroboros-skills:plugins/superpowers@v2-alpha",
    "github:ourostack/ouroboros-skills:plugins/desk",
    "github:teams-microsoft/teams-approvals-mcp:.",
    "github:someone/else",
    "npm:left-pad",
    42,
  ]) {
    assert.equal(checker.dependencyProblem(spec), null, String(spec))
  }
})

test("exact commits, forks, other branches and malformed specs are rejected", () => {
  assert.match(checker.dependencyProblem("github:ourostack/ouroboros-skills:plugins/desk@d89126223a4e08b07b8e4e8d738c15b92a6c597f"), /pins exact commit/u)
  assert.match(checker.dependencyProblem("github:shared-internal-tools/ms-desk:plugins/ms-desk@4597a49"), /pins exact commit/u)
  assert.match(checker.dependencyProblem("github:arimendelow/ouroboros-skills:plugins/desk@v2-alpha"), /points at a fork \(arimendelow\)/u)
  assert.match(checker.dependencyProblem("github:ourostack/ouroboros-skills:plugins/desk@user/ari/feature"), /not a release channel/u)
  assert.match(checker.dependencyProblem("github:not-a-repo"), /is not a github:/u)
  assert.deepEqual(checker.parseGithubDependency("github:o/r"), { owner: "o", repo: "r", path: "", ref: null })
})

test("the checker reports every offending manifest entry", () => {
  withPlugins({
    good: { dependencies: ["github:ourostack/ouroboros-skills:plugins/desk@v2-alpha"] },
    pinned: { dependencies: ["github:ourostack/ouroboros-skills:plugins/desk@0123456789abcdef"] },
    empty: {},
    nomanifest: null,
  }, (root) => {
    assert.deepEqual(checker.checkDependencyChannels({ repoRoot: root }), [
      "plugins/pinned/agency.json: github:ourostack/ouroboros-skills:plugins/desk@0123456789abcdef pins exact commit 0123456789abcdef; track a release channel (v2-alpha) instead",
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
