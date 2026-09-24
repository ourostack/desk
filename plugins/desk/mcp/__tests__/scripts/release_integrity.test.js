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
const script = path.join(repoRoot, "scripts", "check-release-integrity.cjs")
const checker = require(script)

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  })
}

function writeJson(root, file, value) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), JSON.stringify(value))
}

function setVersion(root, plugin, version, { marketplace = true } = {}) {
  for (const manifest of ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    writeJson(root, `plugins/${plugin}/${manifest}`, { name: plugin, version })
  }
  if (marketplace) {
    const file = path.join(root, ".claude-plugin", "marketplace.json")
    const current = JSON.parse(execFileSync("cat", [file], { encoding: "utf8" }))
    current.plugins = current.plugins.map((entry) => (entry.name === plugin ? { ...entry, version } : entry))
    writeFileSync(file, JSON.stringify(current))
  }
}

// A throwaway repository with two plugins committed as the base.
function withRepo(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "release-integrity-"))
  try {
    git(root, "init", "-q", "-b", "main")
    writeJson(root, ".claude-plugin/marketplace.json", {
      plugins: [
        { name: "alpha", source: "./plugins/alpha", version: "1.0.0-alpha.9" },
        { name: "beta", source: "./plugins/beta", version: "2.0.0" },
      ],
    })
    setVersion(root, "alpha", "1.0.0-alpha.9", { marketplace: false })
    setVersion(root, "beta", "2.0.0", { marketplace: false })
    writeJson(root, "plugins/alpha/agency.json", { name: "alpha", version: "1.0.0-alpha.9" })
    writeFileSync(path.join(root, "plugins", "alpha", "skill.md"), "one\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "base")
    git(root, "branch", "base")
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function commit(root) {
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "change")
}

test("semantic version precedence handles numeric prereleases and releases", () => {
  assert.ok(checker.compareVersions("1.0.0-alpha.10", "1.0.0-alpha.9") > 0)
  assert.ok(checker.compareVersions("1.0.0", "1.0.0-alpha.9") > 0)
  assert.ok(checker.compareVersions("1.0.0-alpha.9", "1.0.0") < 0)
  assert.ok(checker.compareVersions("1.0.0-alpha.1.2", "1.0.0-alpha.1") > 0)
  assert.ok(checker.compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0)
  assert.ok(checker.compareVersions("1.0.0-beta", "1.0.0-alpha") > 0)
  assert.ok(checker.compareVersions("1.0.0-alpha", "1.0.0-beta") < 0)
  assert.ok(checker.compareVersions("1.2.0", "1.10.0") < 0)
  assert.equal(checker.compareVersions("1.0.0+build", "1.0.0"), 0)
  assert.equal(checker.parseVersion("not.a.version"), null)
})

test("a changed plugin must carry a higher version; unchanged plugins need nothing", () => {
  withRepo((root) => {
    writeFileSync(path.join(root, "plugins", "alpha", "skill.md"), "two\n")
    commit(root)
    const problems = checker.checkReleaseIntegrity({ repoRoot: root, base: "base" })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /^alpha: files under plugins\/alpha\/ changed since base but its version 1\.0\.0-alpha\.9 is not above 1\.0\.0-alpha\.9/u)

    setVersion(root, "alpha", "1.0.0-alpha.10")
    writeJson(root, "plugins/alpha/agency.json", { name: "alpha", version: "1.0.0-alpha.10" })
    commit(root)
    assert.deepEqual(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" }), [])
  })
})

test("a lower or unparseable version is rejected", () => {
  withRepo((root) => {
    setVersion(root, "beta", "1.9.9")
    commit(root)
    assert.match(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" })[0], /^beta: .*version 1\.9\.9 is not above 2\.0\.0/u)
    setVersion(root, "beta", "latest")
    commit(root)
    assert.match(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" })[0], /^beta: .*version latest is not above 2\.0\.0/u)
  })
})

test("manifests that disagree are rejected even without a base", () => {
  withRepo((root) => {
    writeJson(root, "plugins/alpha/agency.json", { name: "alpha", version: "1.0.0-alpha.8" })
    const [problem] = checker.checkReleaseIntegrity({ repoRoot: root })
    assert.match(problem, /^alpha: manifests disagree on the version \(.*plugins\/alpha\/agency\.json=1\.0\.0-alpha\.8/u)
  })
})

test("a plugin that is new since the base needs no bump", () => {
  withRepo((root) => {
    const file = path.join(root, ".claude-plugin", "marketplace.json")
    const marketplace = JSON.parse(execFileSync("cat", [file], { encoding: "utf8" }))
    marketplace.plugins.push({ name: "gamma", source: "./plugins/gamma", version: "0.1.0" })
    writeFileSync(file, JSON.stringify(marketplace))
    setVersion(root, "gamma", "0.1.0", { marketplace: false })
    commit(root)
    assert.deepEqual(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" }), [])
  })
})

test("the base comes from DESK_RELEASE_BASE or the pull request base", () => {
  assert.equal(checker.resolveBase({ DESK_RELEASE_BASE: "origin/x", GITHUB_BASE_REF: "y" }), "origin/x")
  assert.equal(checker.resolveBase({ GITHUB_BASE_REF: "v2-alpha" }), "origin/v2-alpha")
  assert.equal(checker.resolveBase({}), null)
})

test("the CLI reports failures and successes with and without a base", () => {
  withRepo((root) => {
    const lines = []
    const sink = { log: (line) => lines.push(line), error: (line) => lines.push(line) }
    assert.equal(checker.runCli({ repoRoot: root, env: {}, ...sink }), 0)
    assert.match(lines.pop(), /no base ref/u)
    assert.equal(checker.runCli({ repoRoot: root, env: { DESK_RELEASE_BASE: "base" }, ...sink }), 0)
    assert.match(lines.pop(), /changed since base has a higher version/u)
    writeFileSync(path.join(root, "plugins", "alpha", "skill.md"), "three\n")
    commit(root)
    const gitCalls = []
    const recordingGit = (args) => {
      gitCalls.push(args[0])
      return git(root, ...args)
    }
    assert.equal(checker.runCli({ repoRoot: root, env: { DESK_RELEASE_BASE: "base" }, git: recordingGit, ...sink }), 1)
    assert.match(lines.pop(), /^Release integrity failed:\n- alpha:/u)
    assert.ok(gitCalls.includes("diff"))
  })
})

test("this repository's manifests agree, and the CLI runs with its defaults", () => {
  assert.deepEqual(checker.checkReleaseIntegrity({ repoRoot }).filter((problem) => /disagree/u.test(problem)), [])
  const output = execFileSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, DESK_RELEASE_BASE: "", GITHUB_BASE_REF: "" },
  })
  assert.match(output, /agree/u)
  const cwd = process.cwd()
  process.chdir(repoRoot)
  const original = console.log
  console.log = () => {}
  try {
    assert.deepEqual(checker.checkReleaseIntegrity(), [])
    assert.equal(checker.runCli({ env: {} }), 0)
  } finally {
    console.log = original
    process.chdir(cwd)
  }
})
