import { strict as assert } from "node:assert"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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

// A throwaway repository with two plugins committed as the base. With `fragments`, alpha is released from
// changelog fragments: its base already has a changelog.d/ folder.
function withRepo(fn, { fragments = false } = {}) {
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
    if (fragments) {
      mkdirSync(path.join(root, "plugins", "alpha", "changelog.d"))
      writeFileSync(path.join(root, "plugins", "alpha", "changelog.d", "README.md"), "How to write a fragment.\n")
    }
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

// Regression: node's default 1 MiB maxBuffer made `git diff --name-only` fail with ENOBUFS on a pull request that lists
// more file names than that (a committed node_modules), a failure unrelated to versions.
test("a change that lists more than 1 MiB of file names is judged on versions, not failed on output size", () => {
  withRepo((root) => {
    const stream = []
    for (let index = 0; index < 14000; index += 1) {
      const name = `plugins/alpha/__tests__/${"d".repeat(70)}/file-${index}.test.js`
      stream.push(`M 100644 inline ${name}\ndata 2\nx\n`)
    }
    const input = `commit refs/heads/main\ncommitter t <t@t> 1 +0000\ndata 4\nbig\nfrom refs/heads/main^0\n${stream.join("")}\n`
    execFileSync("git", ["fast-import", "--quiet", "--force"], { cwd: root, input, maxBuffer: 1 << 28 })
    git(root, "reset", "-q", "--hard", "main")
    const listed = execFileSync("git", ["diff", "--name-only", "base...HEAD", "--", "plugins/alpha"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    assert.ok(listed.length > 1024 * 1024, `the diff must exceed node's default maxBuffer, got ${listed.length}`)
    assert.deepEqual(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" }), [])
  })
})

test("a diff past the explicit limit says so instead of a bare ENOBUFS", () => {
  withRepo((root) => {
    writeFileSync(path.join(root, "plugins", "alpha", "skill.md"), "two\n")
    commit(root)
    assert.throws(
      () => checker.checkReleaseIntegrity({ repoRoot: root, base: "base", git: checker.defaultGit(root, 8) }),
      /printed more than 8 bytes.*implausibly large/u,
    )
  })
})

test("a tracked node_modules path is a problem, with or without a base, but a tracked vendor/ is not", () => {
  withRepo((root) => {
    mkdirSync(path.join(root, "node_modules"), { recursive: true })
    writeFileSync(path.join(root, "node_modules", "x"), "x\n")
    writeFileSync(path.join(root, ".gitignore"), "node_modules/\n")
    git(root, "add", ".gitignore")
    git(root, "add", "-f", "node_modules/x")
    mkdirSync(path.join(root, "plugins", "alpha", "node_modules", "deep"), { recursive: true })
    writeFileSync(path.join(root, "plugins", "alpha", "node_modules", "deep", "y"), "y\n")
    git(root, "add", "-f", "plugins/alpha/node_modules/deep/y")
    mkdirSync(path.join(root, "evals", "vendor"), { recursive: true })
    writeFileSync(path.join(root, "evals", "vendor", "ok"), "ok\n")
    git(root, "add", "evals/vendor/ok")
    git(root, "commit", "-q", "-m", "force-added dependencies")
    for (const base of [null, "base"]) {
      const problems = checker.checkReleaseIntegrity({ repoRoot: root, base })
      const found = problems.find((problem) => /node_modules/u.test(problem))
      assert.match(found, /^2 tracked path\(s\) are inside node_modules\/ \(.*node_modules\/x.*\); remove them from the commit.*gitignored/u)
      assert.doesNotMatch(found, /vendor/u)
    }
  })
})

test("a test-only change needs no release", () => {
  withRepo((root) => {
    mkdirSync(path.join(root, "plugins", "alpha", "__tests__"), { recursive: true })
    writeFileSync(path.join(root, "plugins", "alpha", "__tests__", "a.test.js"), "test\n")
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

function writeFragment(root, name, text) {
  writeFileSync(path.join(root, "plugins", "alpha", "changelog.d", name), text)
}

test("a fragment-released plugin needs a new, non-empty changelog fragment instead of a version bump", () => {
  withRepo((root) => {
    writeFileSync(path.join(root, "plugins", "alpha", "skill.md"), "two\n")
    // Rewording the folder's README is not a fragment.
    writeFragment(root, "README.md", "Reworded instructions.\n")
    commit(root)
    assert.deepEqual(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" }), [
      "alpha: files under plugins/alpha/ changed since base; add a changelog fragment, plugins/alpha/changelog.d/<short-slug>.md, that says what changed",
    ])

    writeFragment(root, "skill-wording.md", " \n\n")
    commit(root)
    assert.deepEqual(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" }), [
      "alpha: plugins/alpha/changelog.d/skill-wording.md is empty; a changelog fragment says what changed",
    ])

    // A ### heading is part of the entry; only # and ## would compete with the version heading.
    writeFragment(root, "skill-wording.md", "The skill now says two.\n\n### Details\n\nMore.\n")
    commit(root)
    assert.deepEqual(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" }), [])
  }, { fragments: true })
})

test("the pull request check refuses every added path the release would reject or leave behind", () => {
  for (const [name, addPath, expected] of [
    ["a ## heading", (root) => writeFragment(root, "doc.md", "Intro.\n\n## Heading\n"), "plugins/alpha/changelog.d/doc.md has a # or ## heading"],
    ["a # title", (root) => writeFragment(root, "doc.md", "# Title\n\nBody.\n"), "plugins/alpha/changelog.d/doc.md has a # or ## heading"],
    ["a fragment in a subfolder", (root) => {
      mkdirSync(path.join(root, "plugins", "alpha", "changelog.d", "sub"))
      writeFragment(root, "sub/doc.md", "Nested.\n")
    }, "plugins/alpha/changelog.d/sub/doc.md is not directly in plugins/alpha/changelog.d/"],
    ["a folder named like a fragment", (root) => {
      mkdirSync(path.join(root, "plugins", "alpha", "changelog.d", "dir.md"))
      writeFragment(root, "dir.md/inner.md", "Inside a folder.\n")
    }, "plugins/alpha/changelog.d/dir.md/inner.md is not directly in plugins/alpha/changelog.d/"],
    ["a file that is not Markdown", (root) => writeFragment(root, "notes.txt", "Notes.\n"), "plugins/alpha/changelog.d/notes.txt is not a changelog fragment"],
    ["a symbolic link", (root) => {
      writeFileSync(path.join(root, "plugins", "alpha", "real.md"), "Linked.\n")
      symlinkSync("../real.md", path.join(root, "plugins", "alpha", "changelog.d", "link.md"))
    }, "plugins/alpha/changelog.d/link.md is not a regular file"],
  ]) {
    withRepo((root) => {
      writeFileSync(path.join(root, "plugins", "alpha", "skill.md"), "two\n")
      addPath(root)
      commit(root)
      const problems = checker.checkReleaseIntegrity({ repoRoot: root, base: "base" })
      assert.equal(problems.length, 1, `${name}: ${problems.join("; ")}`)
      assert.ok(problems[0].startsWith(`alpha: ${expected}`), `${name}: ${problems[0]}`)
      // A valid fragment beside it does not excuse it.
      writeFragment(root, "good.md", "A good change.\n")
      commit(root)
      assert.equal(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" }).length, 1, name)
    }, { fragments: true })
  }
})

test("a pull request may not delete or change a fragment another merged change left pending", () => {
  withRepo((root) => {
    // Another change merged with its fragment, and the release has not folded it yet.
    git(root, "switch", "-q", "base")
    writeFragment(root, "other.md", "The other change.\n")
    commit(root)
    git(root, "switch", "-q", "-c", "feature")
    writeFileSync(path.join(root, "plugins", "alpha", "skill.md"), "two\n")
    writeFragment(root, "mine.md", "My change.\n")
    // Editing the folder's README stays allowed.
    writeFragment(root, "README.md", "Clearer instructions.\n")
    commit(root)
    assert.deepEqual(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" }), [])

    const pending = "alpha: plugins/alpha/changelog.d/other.md is a pending fragment from another merged change"
    writeFragment(root, "other.md", "Rewritten by someone else.\n")
    commit(root)
    const [changedProblem, ...restChanged] = checker.checkReleaseIntegrity({ repoRoot: root, base: "base" })
    assert.ok(changedProblem.startsWith(pending), changedProblem)
    assert.deepEqual(restChanged, [])

    git(root, "rm", "-q", "plugins/alpha/changelog.d/other.md")
    commit(root)
    const [deletedProblem, ...restDeleted] = checker.checkReleaseIntegrity({ repoRoot: root, base: "base" })
    assert.ok(deletedProblem.startsWith(pending), deletedProblem)
    assert.deepEqual(restDeleted, [])
  }, { fragments: true })
})

test("a fragment-released plugin keeps its version in the pull request", () => {
  withRepo((root) => {
    writeFileSync(path.join(root, "plugins", "alpha", "skill.md"), "two\n")
    writeFragment(root, "skill-wording.md", "The skill now says two.\n")
    setVersion(root, "alpha", "1.0.0-alpha.10")
    writeJson(root, "plugins/alpha/agency.json", { name: "alpha", version: "1.0.0-alpha.10" })
    commit(root)
    assert.deepEqual(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" }), [
      "alpha: its version changed from 1.0.0-alpha.9 to 1.0.0-alpha.10, but plugins/alpha/ is released from changelog fragments; leave every version surface alone, and the release workflow assigns the next version after the merge",
    ])
  }, { fragments: true })
})

test("a branch behind a release on the base is judged from where it left the base", () => {
  withRepo((root) => {
    git(root, "switch", "-q", "-c", "feature")
    writeFileSync(path.join(root, "plugins", "alpha", "skill.md"), "two\n")
    writeFragment(root, "skill-wording.md", "The skill now says two.\n")
    commit(root)
    // The release workflow ships another change on the base after the branch left it.
    git(root, "switch", "-q", "base")
    setVersion(root, "alpha", "1.0.0-alpha.10")
    writeJson(root, "plugins/alpha/agency.json", { name: "alpha", version: "1.0.0-alpha.10" })
    commit(root)
    git(root, "switch", "-q", "feature")
    assert.deepEqual(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" }), [])
  }, { fragments: true })
})

test("the pull request that introduces changelog.d/ still releases with a version bump", () => {
  withRepo((root) => {
    writeFileSync(path.join(root, "plugins", "alpha", "skill.md"), "two\n")
    mkdirSync(path.join(root, "plugins", "alpha", "changelog.d"))
    writeFragment(root, "README.md", "How to write a fragment.\n")
    commit(root)
    assert.match(checker.checkReleaseIntegrity({ repoRoot: root, base: "base" })[0], /^alpha: .*version 1\.0\.0-alpha\.9 is not above 1\.0\.0-alpha\.9/u)
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
