// The Desk release on main: pull requests leave changelog fragments, and scripts/release-desk.cjs turns the pending
// fragments into the next alpha on every release surface and one changelog entry.

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const require = createRequire(import.meta.url)
const script = path.join(repoRoot, "scripts", "release-desk.cjs")
const release = require(script)

// NODE_OPTIONS stripped: the CLI subprocess below is a real release run against a fixture checkout, not anything
// whose own coverage this suite needs to measure, so it has no reason to inherit the coverage runner's instrumentation.
const bareEnv = { ...process.env }
delete bareEnv.NODE_OPTIONS

const readRepo = (file) => readFileSync(path.join(repoRoot, file), "utf8")
const currentDesk = JSON.parse(readRepo("plugins/desk/.claude-plugin/plugin.json")).version
const mcpVersion = JSON.parse(readRepo("plugins/desk/mcp/package.json")).version
const fragmentDir = "plugins/desk/changelog.d"

// A copy of every file a release reads or writes.
function fixture(t, version = currentDesk) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-release-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const file of [...release.DESK_VERSION_FILES, release.CHANGELOG, "plugins/desk/mcp/package.json"]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    copyFileSync(path.join(repoRoot, file), path.join(root, file))
  }
  mkdirSync(path.join(root, fragmentDir))
  writeFileSync(path.join(root, fragmentDir, "README.md"), "How to write a fragment.\n")
  if (version !== currentDesk) release.replaceVersion(root, release.DESK_VERSION_FILES, currentDesk, version)
  return root
}

function snapshot(root, relativePaths = path) {
  const files = {}
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files[relativePaths.relative(root, full).split(relativePaths.sep).join("/")] = readFileSync(full, "utf8")
    }
  }
  walk(root)
  return files
}

const fragment = (root, name, text) => writeFileSync(path.join(root, fragmentDir, name), text)

test("snapshot preservation lookups use repository-relative keys for POSIX and Windows paths", (t) => {
  const root = fixture(t)
  const marketplace = readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8")
  const mcp = readFileSync(path.join(root, "plugins/desk/mcp/package.json"), "utf8")
  for (const relativePaths of [path.posix, path.win32]) {
    // Translate the actual fixture paths too: POSIX relative() must not receive a Windows-native spelling.
    const spelling = (file) => file.split(path.sep).join(relativePaths.sep)
    const files = snapshot(root, {
      sep: relativePaths.sep,
      relative: (from, to) => relativePaths.relative(spelling(from), spelling(to)),
    })
    assert.equal(files[".claude-plugin/marketplace.json"], marketplace)
    assert.equal(files["plugins/desk/mcp/package.json"], mcp)
    assert.equal(files["plugins/desk/changelog.d/README.md"], "How to write a fragment.\n")
    assert.ok(Object.keys(files).every((key) => !key.includes("\\")), "snapshot keys must use repository separators")
  }
})

test("the next alpha follows the current one and only alphas are released", () => {
  assert.equal(release.nextAlpha("3.2.0-alpha.9"), "3.2.0-alpha.10")
  assert.throws(() => release.nextAlpha("3.2.0"), /Desk version 3\.2\.0 is not an alpha release/u)
})

test("release policy follows the current line, explicitly promotes to RC, and refuses unsupported stages and versions", () => {
  for (const [version, stage, want] of [
    ["3.2.0-alpha.333", undefined, "3.2.0-alpha.334"],
    ["3.2.0-alpha.333", "auto", "3.2.0-alpha.334"],
    ["3.2.0-alpha.333", "rc", "3.2.0-rc.1"],
    ["3.2.0-rc.1", undefined, "3.2.0-rc.2"],
    ["3.2.0-rc.9", "rc", "3.2.0-rc.10"],
    ["3.2.0-alpha.355", "stable", "3.2.0"],
    ["3.2.0-rc.4", "stable", "3.2.0"],
    ["3.2.0", undefined, "3.2.1"],
    ["3.2.0", "auto", "3.2.1"],
    ["3.2.9", "stable", "3.2.10"],
    ["3.2.0", "rc", "3.2.1-rc.1"],
  ]) assert.equal(release.nextReleaseVersion(version, stage), want)
  for (const stage of ["alpha", "ga", "", null]) {
    assert.throws(() => release.nextReleaseVersion("3.2.0-rc.1", stage), /stage/u)
  }
  for (const version of ["invalid", "3.2.0-beta.1", "3.2.0-rc.01", "03.2.0-alpha.1", "3.2.0-alpha.1+build"]) {
    assert.throws(() => release.nextReleaseVersion(version, "rc"), /version/u)
  }
})

test("stable releases the plain version from an alpha or RC with or without fragments, and auto after it moves to the next patch", (t) => {
  for (const from of ["3.2.0-alpha.333", "3.2.0-rc.2"]) {
    const root = fixture(t, from)
    const result = release.releaseDesk({ root, date: "2026-10-25", stage: "stable" })
    assert.deepEqual(result, { released: true, from, to: "3.2.0", fragments: [] })
    for (const file of release.DESK_VERSION_FILES) {
      const text = readFileSync(path.join(root, file), "utf8")
      assert.doesNotMatch(text, release.versionToken(from), file)
      assert.match(text, release.versionToken("3.2.0"), file)
    }
    assert.match(readFileSync(path.join(root, release.CHANGELOG), "utf8"), /^# desk plugin — changelog\n\n## 3\.2\.0 — 2026-10-25\n\n\S/u)
    assert.deepEqual(release.releaseDesk({ root, date: "2026-10-25", stage: "stable" }), { released: false, fragments: [] })
    assert.deepEqual(release.releaseDesk({ root, date: "2026-10-25" }), { released: false, fragments: [] })
    fragment(root, "after-stable.md", "A fix after stable.\n")
    assert.deepEqual(release.releaseDesk({ root, date: "2026-10-26" }), {
      released: true, from: "3.2.0", to: "3.2.1", fragments: [`${fragmentDir}/after-stable.md`],
    })
    assert.match(readFileSync(path.join(root, release.CHANGELOG), "utf8"), /^# desk plugin — changelog\n\n## 3\.2\.1 — 2026-10-26\n\nA fix after stable\./u)
  }
  const root = fixture(t, "3.2.0-rc.2")
  fragment(root, "last-fix.md", "A last fix.\n")
  assert.equal(release.releaseDesk({ root, date: "2026-10-25", stage: "stable" }).to, "3.2.0")
})

test("empty alpha promotion couples every Desk surface, leaves other plugins and MCP alone, and repeated RC dispatch is inert", (t) => {
  const root = fixture(t, "3.2.0-alpha.333")
  const before = snapshot(root)
  const result = release.releaseDesk({ root, date: "2026-10-20", stage: "rc" })
  assert.deepEqual(result, { released: true, from: "3.2.0-alpha.333", to: "3.2.0-rc.1", fragments: [] })
  for (const file of release.DESK_VERSION_FILES) {
    const text = readFileSync(path.join(root, file), "utf8")
    assert.doesNotMatch(text, release.versionToken("3.2.0-alpha.333"), file)
    assert.match(text, release.versionToken("3.2.0-rc.1"), file)
  }
  const marketplace = (text) => JSON.parse(text).plugins.filter((plugin) => plugin.name !== "desk")
  assert.deepEqual(marketplace(readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8")), marketplace(before[".claude-plugin/marketplace.json"]))
  assert.equal(readFileSync(path.join(root, "plugins/desk/mcp/package.json"), "utf8"), before["plugins/desk/mcp/package.json"])
  assert.match(readFileSync(path.join(root, release.CHANGELOG), "utf8"), /^# desk plugin — changelog\n\n## 3\.2\.0-rc\.1 — 2026-10-20\n\n\S/u)
  const promoted = snapshot(root)
  for (const stage of ["rc", "auto"]) {
    assert.deepEqual(release.releaseDesk({ root, date: "2026-10-21", stage }), { released: false, fragments: [] })
    assert.deepEqual(snapshot(root), promoted)
  }
  fragment(root, "rc-fix.md", "A candidate fix.\n")
  assert.deepEqual(release.releaseDesk({ root, date: "2026-10-21" }), {
    released: true, from: "3.2.0-rc.1", to: "3.2.0-rc.2", fragments: [`${fragmentDir}/rc-fix.md`],
  })
  fragment(root, "another-fix.md", "Another candidate fix.\n")
  assert.equal(release.releaseDesk({ root, date: "2026-10-21", stage: "rc" }).to, "3.2.0-rc.3")
})

test("RC promotion refuses malformed or stale surfaces and invalid stages without any write, even without fragments", (t) => {
  for (const [breakFixture, stage, pattern] of [
    [() => {}, "alpha", /stage/u],
    [(root) => writeFileSync(path.join(root, "plugins/desk/.claude-plugin/plugin.json"), '{"version":"invalid"}'), "rc", /version/u],
    [(root) => writeFileSync(path.join(root, "plugins/desk/agency.json"), "{}\n"), "rc", /stale/u],
    [(root) => writeFileSync(path.join(root, "plugins/desk/agency.json"), "{}\n"), "stable", /stale/u],
    [(root) => writeFileSync(path.join(root, "plugins/desk/agency.json"), '{"version":"3.2.0-alpha.333"'), "rc", /JSON/u],
    [(root) => writeFileSync(path.join(root, release.CHANGELOG), "# Broken\n"), "rc", /title/u],
  ]) {
    const root = fixture(t, "3.2.0-alpha.333")
    breakFixture(root)
    const before = snapshot(root)
    assert.throws(() => release.releaseDesk({ root, date: "2026-10-20", stage }), pattern)
    assert.deepEqual(snapshot(root), before)
  }
  const root = fixture(t, "3.2.0-beta.1")
  const before = snapshot(root)
  assert.throws(() => release.releaseDesk({ root, date: "2026-10-20", stage: "stable" }), /version/u)
  assert.deepEqual(snapshot(root), before)
})

test("a stale coupling-date surface refuses RC promotion before writing any version", (t) => {
  const root = fixture(t, "3.2.0-alpha.333")
  const file = path.join(root, "tests/desk/mcp/__tests__/release/release_coupling.test.js")
  writeFileSync(file, readFileSync(file, "utf8").replace(/const expectedReleaseDate = "[^"]*"/u, 'const staleReleaseDate = "2026-10-19"'))
  const before = snapshot(root)
  assert.throws(() => release.releaseDesk({ root, date: "2026-10-20", stage: "rc" }), /expectedReleaseDate.*stale/u)
  assert.deepEqual(snapshot(root), before)
})

test("with no pending fragment nothing is released and nothing changes", (t) => {
  const root = fixture(t)
  fragment(root, "notes.txt", "not a fragment\n")
  const before = snapshot(root)
  assert.deepEqual(release.releaseDesk({ root, date: "2026-10-01" }), { released: false, fragments: [] })
  assert.deepEqual(snapshot(root), before)
  rmSync(path.join(root, fragmentDir), { recursive: true })
  assert.deepEqual(release.pendingFragments(root), [])
})

test("pending fragments become the next alpha on every surface and one changelog entry", (t) => {
  const root = fixture(t)
  const previousChangelog = readFileSync(path.join(root, release.CHANGELOG), "utf8")
  fragment(root, "zebra-fix.md", "The zebra fix.\n\nIts second paragraph.\n")
  fragment(root, "alpha-feature.md", "\nThe alpha feature, with a [link](docs/x.md).\n")
  fragment(root, "notes.txt", "not a fragment\n")
  const next = release.nextReleaseVersion(currentDesk)

  const result = release.releaseDesk({ root, date: "2026-10-01" })
  assert.deepEqual(result, {
    released: true,
    from: currentDesk,
    to: next,
    fragments: [`${fragmentDir}/alpha-feature.md`, `${fragmentDir}/zebra-fix.md`],
  })
  for (const file of release.DESK_VERSION_FILES) {
    const text = readFileSync(path.join(root, file), "utf8")
    assert.doesNotMatch(text, release.versionToken(currentDesk), file)
    assert.match(text, release.versionToken(next), file)
  }
  assert.match(readFileSync(path.join(root, "tests/desk/mcp/__tests__/release/release_coupling.test.js"), "utf8"), /const expectedReleaseDate = "2026-10-01"/u)
  assert.equal(
    readFileSync(path.join(root, release.CHANGELOG), "utf8"),
    `# desk plugin — changelog\n\n## ${next} — 2026-10-01\n\nThe alpha feature, with a [link](docs/x.md).\n\nThe zebra fix.\n\nIts second paragraph.\n\nShips \`desk-mcp@${mcpVersion}\`.\n\n${previousChangelog.slice(release.CHANGELOG_HEADER.length)}`,
  )
  // The folded fragments are gone; the folder's README and anything that is not a fragment stay.
  assert.deepEqual(readdirSync(path.join(root, fragmentDir)).sort(), ["README.md", "notes.txt"])
  assert.deepEqual(release.releaseDesk({ root, date: "2026-10-01" }), { released: false, fragments: [] })
})

// Git conflicts on changes to neighbouring lines. When the version sat right above a description, every release made
// an open pull request that edits that description conflict (#486 was rebased three times).
test("a release merges cleanly with a pull request that edits any description on a release surface", (t) => {
  const root = fixture(t)
  const base = Object.fromEntries(release.DESK_VERSION_FILES.map((file) => [file, readFileSync(path.join(root, file), "utf8")]))
  fragment(root, "change.md", "A change.\n")
  release.releaseDesk({ root, date: "2026-10-01" })
  const work = mkdtempSync(path.join(tmpdir(), "desk-release-merge-"))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  let edited = 0
  for (const file of release.DESK_VERSION_FILES.filter((name) => name.endsWith(".json"))) {
    const ours = base[file].replace(/^(\s*"description": ")/gmu, (match) => { edited += 1; return `${match}Edited. ` })
    const sides = { base: base[file], ours, theirs: readFileSync(path.join(root, file), "utf8") }
    for (const [name, text] of Object.entries(sides)) writeFileSync(path.join(work, name), text)
    const merged = spawnSync("git", ["merge-file", "-p", path.join(work, "ours"), path.join(work, "base"), path.join(work, "theirs")], { encoding: "utf8" })
    assert.equal(merged.status, 0, `${file}: a release bump conflicts with a description edit; keep the version line away from description lines\n${merged.stdout}`)
    if (ours !== base[file]) assert.match(merged.stdout, /"description": "Edited\. /u, file)
    assert.equal(JSON.parse(merged.stdout).version ?? null, JSON.parse(sides.theirs).version ?? null, file)
  }
  assert.ok(edited >= 3, "the plugin manifests and the marketplace have descriptions to edit")
})

test("a bad fragment, date or changelog stops the release before any file changes, and a stale surface list stops it loudly", (t) => {
  for (const [breakFixture, date, pattern] of [
    [(root) => fragment(root, "empty.md", " \n\n"), "2026-10-01", /changelog\.d\/empty\.md is empty/u],
    [(root) => fragment(root, "heading.md", "Intro.\n\n## 9.9.9 — someday\n"), "2026-10-01", /heading\.md has a # or ## heading/u],
    [(root) => fragment(root, "title.md", "# Title\n"), "2026-10-01", /title\.md has a # or ## heading/u],
    [(root) => writeFileSync(path.join(root, release.CHANGELOG), "# Changes\n"), "2026-10-01", /CHANGELOG\.md must begin with its title/u],
    [() => {}, "October 1st", /the release date must be YYYY-MM-DD: October 1st/u],
    [(root) => mkdirSync(path.join(root, fragmentDir, "dir.md")), "2026-10-01", /changelog\.d\/dir\.md is not a regular file/u],
  ]) {
    const root = fixture(t)
    fragment(root, "good.md", "A good change.\n")
    breakFixture(root)
    const before = snapshot(root)
    assert.throws(() => release.releaseDesk({ root, date }), pattern)
    assert.deepEqual(snapshot(root), before)
  }
  // A stale surface list is found before any surface is rewritten, so no file is left half released.
  const root = fixture(t)
  fragment(root, "good.md", "A good change.\n")
  writeFileSync(path.join(root, "plugins/desk/agency.json"), "{}\n")
  const before = snapshot(root)
  assert.throws(() => release.releaseDesk({ root, date: "2026-10-01" }), /plugins\/desk\/agency\.json does not name version .*; the release surface list is stale/u)
  assert.deepEqual(snapshot(root), before)
})

test("one fragment rule serves the release and the pull request check", (t) => {
  const root = fixture(t)
  const problem = (file, dir) => release.fragmentProblem(root, file, dir)
  fragment(root, "good.md", "A change.\n\n### Details\n")
  assert.equal(problem(`${fragmentDir}/good.md`), null)
  assert.match(problem(`${fragmentDir}/README.md`), /README\.md is not a changelog fragment/u)
  assert.match(problem(`${fragmentDir}/missing.md`), /missing\.md is not a regular file/u)
  assert.match(problem(`${fragmentDir}/sub/good.md`), /is not directly in plugins\/desk\/changelog\.d\//u)
  assert.match(problem("plugins/other/changelog.d/good.md"), /is not directly in plugins\/desk\/changelog\.d\//u)
  mkdirSync(path.join(root, "plugins/other/changelog.d"), { recursive: true })
  writeFileSync(path.join(root, "plugins/other/changelog.d/good.md"), "Another plugin's change.\n")
  assert.equal(problem("plugins/other/changelog.d/good.md", "plugins/other/changelog.d"), null)
})

test("the CLI takes --date and --root, prints the result and reports errors on stderr", (t) => {
  assert.throws(() => release.parseArgs(["--bogus", "x"]), /unknown or incomplete argument: --bogus/u)
  assert.throws(() => release.parseArgs(["--date"]), /unknown or incomplete argument: --date/u)
  const defaults = release.parseArgs([])
  assert.match(defaults.date, /^\d{4}-\d{2}-\d{2}$/u)
  assert.equal(defaults.root, repoRoot)

  const root = fixture(t)
  let output = ""
  assert.equal(release.main(["--root", root, "--date", "2026-10-02"], { stdout: { write: (text) => { output += text } } }), 0)
  assert.deepEqual(JSON.parse(output), { released: false, fragments: [] })

  fragment(root, "cli.md", "Released from the command line.\n")
  const success = spawnSync(process.execPath, [script, "--root", root, "--date", "2026-10-02"], { encoding: "utf8", env: bareEnv })
  assert.equal(success.status, 0, success.stderr)
  assert.equal(JSON.parse(success.stdout).to, release.nextReleaseVersion(currentDesk))
  const failure = spawnSync(process.execPath, [script, "--root", root, "--date", "tomorrow"], { encoding: "utf8", env: bareEnv })
  assert.equal(failure.status, 1)
  assert.match(failure.stderr, /the release date must be YYYY-MM-DD: tomorrow/u)
  // The repository's own fragments folder keeps its instructions, and a real checkout has nothing to release by default here.
  assert.ok(existsSync(path.join(repoRoot, fragmentDir, "README.md")))
})

test("CLI stage defaults to auto, promotes with rc, and rejects invalid stage without writes", (t) => {
  assert.equal(release.parseArgs([]).stage, "auto")
  const root = fixture(t, "3.2.0-alpha.333")
  const run = (stage) => spawnSync(process.execPath, [script, "--root", root, "--date", "2026-10-20", "--stage", stage], { encoding: "utf8", env: bareEnv })
  const before = snapshot(root)
  const invalid = run("alpha")
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /stage/u)
  assert.deepEqual(snapshot(root), before)
  const promoted = run("rc")
  assert.equal(promoted.status, 0, promoted.stderr)
  assert.equal(JSON.parse(promoted.stdout).to, "3.2.0-rc.1")
  assert.deepEqual(JSON.parse(run("rc").stdout), { released: false, fragments: [] })
})

const releaseWorkflow = () => {
  const text = readRepo(".github/workflows/desk-release.yml")
  return { text, workflow: require("js-yaml").load(text) }
}
const stepNamed = (job, name) => {
  const found = job.steps.find((step) => step.name === name)
  assert.ok(found, `missing step: ${name}`)
  return found
}

test("manual release stage is a choice defaulting to auto and survives both concurrent-main handoffs", () => {
  const { workflow } = releaseWorkflow()
  const input = { ...workflow.on.workflow_dispatch.inputs.stage }
  delete input.description
  assert.deepEqual(input, {
    type: "choice", options: ["auto", "rc", "stable"], default: "auto", required: true,
  })
  const build = stepNamed(workflow.jobs.build, "Build and check the release")
  const push = stepNamed(workflow.jobs.push, "Verify and push the release")
  const expression = "${{ github.event_name == 'workflow_dispatch' && inputs.stage || 'auto' }}"
  assert.equal(build.env.RELEASE_STAGE, expression)
  assert.equal(push.env.RELEASE_STAGE, expression)
  const handoffs = push.run.split("\n").filter((line) => line.includes("gh workflow run desk-release.yml"))
  assert.equal(handoffs.length, 2)
  for (const line of handoffs) {
    for (const stage of ["auto", "rc", "stable"]) {
      const result = spawnSync("bash", ["-c", `gh() { printf '%s\\n' "$@"; }\n${line}`], {
        encoding: "utf8", env: { ...bareEnv, RELEASE_STAGE: stage, GITHUB_REPOSITORY: "fixture/desk" },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(result.stdout.trim().split("\n"), [
        "workflow", "run", "desk-release.yml", "--repo", "fixture/desk", "--ref", "main", "-f", `stage=${stage}`,
      ])
    }
  }
})

test("build stage validation and release invocation promote controlled fixtures without running destructive build cleanup", (t) => {
  const text = sharedScript()
  // Execute only argument parsing and the actual staging command; never the helper's git/cleanup lifecycle on this Mac.
  const preflight = text.slice(text.indexOf("set -euo pipefail"), text.indexOf('test -z "$(git status'))
  const invocation = text.split("\n").find((line) => line.startsWith("node scripts/release-desk.cjs "))
  assert.ok(invocation)
  const root = fixture(t, "3.2.0-alpha.333")
  mkdirSync(path.join(root, "scripts"))
  copyFileSync(script, path.join(root, "scripts/release-desk.cjs"))
  const run = (...args) => spawnSync("bash", ["-c", `${preflight}\nrelease_json="$RELEASE_JSON"\n${invocation}`, "fixture", ...args], {
    cwd: root, encoding: "utf8", env: { ...bareEnv, RELEASE_JSON: path.join(root, "release.json") },
  })
  const before = snapshot(root)
  const invalid = run("--stage", "alpha")
  assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr)
  assert.match(invalid.stderr, /stage/u)
  assert.deepEqual(snapshot(root), before)
  for (const args of [["--stage"], ["--unknown"], ["--dry-run", "extra"]]) {
    assert.equal(run(...args).status, 2, args.join(" "))
    assert.deepEqual(snapshot(root), before)
  }
  assert.equal(run().status, 0)
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "release.json"), "utf8")), { released: false, fragments: [] })
  assert.equal(run("--stage", "rc").status, 0)
  assert.equal(JSON.parse(readFileSync(path.join(root, "release.json"), "utf8")).to, "3.2.0-rc.1")
  assert.equal(run("--stage", "rc", "--dry-run").status, 0)
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "release.json"), "utf8")), { released: false, fragments: [] })
})

function sharedScript() {
  return readFileSync(path.join(repoRoot, "scripts", "build-and-check-release.sh"), "utf8")
}

test("release setup installs all committed dependency sets before running native acceptance", () => {
  const { workflow } = releaseWorkflow()
  const setup = workflow.jobs.build.steps
  const acceptance = setup.findIndex(step => step.name === "Build and check the release")
  const dependencySteps = setup.slice(0, acceptance).filter(step => step.run?.startsWith("npm ci"))
  const installed = []
  for (const step of dependencySteps) {
    const result = spawnSync("node", ["-e",
      `const args = process.argv.slice(1); const prefix = args.indexOf("--prefix");
       console.log(JSON.stringify({ command: args[0], root: prefix < 0 ? process.env.FIXTURE_CWD : args[prefix + 1] }));`,
      ...step.run.split(/\s+/u).slice(1)], {
      encoding: "utf8", env: { ...bareEnv, FIXTURE_CWD: step["working-directory"] ?? "." },
    })
    assert.equal(result.status, 0, result.stderr)
    installed.push(JSON.parse(result.stdout))
  }
  assert.deepEqual(installed, [
    { command: "ci", root: "plugins/desk/mcp" },
  ], "the actual release job must establish native dependencies before acceptance, just like the PR dry run")
})

test("the shared release queue retains pending RC intent without allowing concurrent releases", () => {
  const { workflow } = releaseWorkflow()
  // GitHub's queue:max contract (verified 2026-10-20): one running run, up to 100 pending;
  // FIFO by entry into the waiting group, not dispatch time; excess arrivals are canceled.
  // Test our emitted workflow configuration, not a mock implementation of GitHub's scheduler.
  assert.deepEqual(workflow.concurrency, { group: "desk-release", "cancel-in-progress": false, queue: "max" })
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.concurrency, undefined, "stage-specific/job-level groups must not bypass the shared workflow lock")
  }
})

test("the release workflow runs on main one at a time and daily, checks the release, pushes it and reports a failure", () => {
  const { text, workflow } = releaseWorkflow()
  assert.deepEqual(workflow.on.push, { branches: ["main"], paths: ["plugins/desk/changelog.d/**"] })
  assert.ok("workflow_dispatch" in workflow.on)
  assert.match(workflow.on.schedule[0].cron, /\S/u)
  assert.deepEqual(workflow.permissions, {})
  assert.deepEqual(workflow.concurrency, { group: "desk-release", "cancel-in-progress": false, queue: "max" })
  assert.deepEqual(Object.keys(workflow.jobs), ["build", "push", "announce", "report"])
  // The release's own push builds and pushes nothing, but still marks and reports, so a marking failure in the pushing run is retried.
  const buildJob = workflow.jobs.build
  assert.equal(buildJob.if, undefined, "the build job always runs, so the marking and the report that need it run too")
  assert.equal(buildJob.env.SELF_PUSH, "${{ github.event_name == 'push' && github.event.head_commit.author.email == '41898282+github-actions[bot]@users.noreply.github.com' && startsWith(github.event.head_commit.message, 'Release Desk ') }}")
  for (const step of buildJob.steps) {
    if (step.name === "Skip the release's own push") assert.equal(step.if, "env.SELF_PUSH == 'true'")
    else if (step.name === "Hand the checked release commit to the push job") assert.equal(step.if, "steps.release.outputs.released == 'true'")
    else assert.equal(step.if, "env.SELF_PUSH != 'true'", step.name)
  }
  assert.match(sharedScript(), /user\.email="41898282\+github-actions\[bot\]@users\.noreply\.github\.com"[\s\S]*commit --quiet --message "Release Desk \$version"/u, "the skip names the author and subject the release commit really has")
  assert.equal(workflow.jobs.push.if, "needs.build.outputs.released == 'true'", "a skipped build pushes nothing")
  assert.match(workflow.jobs.announce.if, /^always\(\) && needs\.build\.result == 'success' && \(needs\.push\.result == 'success' \|\| needs\.push\.result == 'skipped'\)/u, "marking runs when the build was skipped")
  assert.doesNotMatch(workflow.jobs.report.if, /needs\.build\.result != 'skipped'/u, "the report runs on the release's own push")
  const build = stepNamed(workflow.jobs.build, "Build and check the release").run
  assert.match(build, /scripts\/build-and-check-release\.sh --stage "\$RELEASE_STAGE"$/mu)
  assert.match(sharedScript(), /node scripts\/release-desk\.cjs --date/u)
  assert.match(sharedScript(), /node scripts\/check-release-integrity\.cjs/u)
  const report = workflow.jobs.report
  assert.deepEqual(report.needs, ["build", "push", "announce"])
  assert.deepEqual(report.permissions, { issues: "write" })
  assert.equal(stepNamed(report, "Report the failed release").if, "needs.build.result == 'failure' || needs.push.result == 'failure' || needs.announce.result == 'failure'")
  assert.match(stepNamed(report, "Report the failed release").run, /gh issue create --repo "\$GITHUB_REPOSITORY" --title "\$ISSUE_TITLE"/u)
  // A run that handed its release to a new run leaves the issue open: its fragments are still pending.
  assert.match(stepNamed(report, "Close the release issue after a successful run").if, /needs\.push\.outputs\.handed_off != 'true'/u)
  // A published release whose pull requests were not marked is a failure too: the done-gate would refuse them, and the issue is how the agent hears.
  assert.match(stepNamed(report, "Close the release issue after a successful run").if, /needs\.announce\.result == 'success' \|\| needs\.announce\.result == 'skipped'/u)
  assert.doesNotMatch(text, /pull_request/u, "the release never runs for an unmerged pull request")
  assert.doesNotMatch(text, /--force/u, "a release never overwrites main")
})

test("the release workflow checks every release surface in a read-only job and pushes the checked commit from a job that runs no dependency or repository code", () => {
  const { workflow } = releaseWorkflow()
  const { build, push, report } = workflow.jobs
  // Steps in one job share a runner, so the job that installs dependencies holds only a read token.
  assert.deepEqual(build.permissions, { contents: "read" })
  assert.deepEqual(push.permissions, { contents: "write", actions: "write" })
  assert.doesNotMatch(JSON.stringify(build), /github\.token|secrets\./u, "the build job never receives a write credential")
  for (const job of [build, push]) assert.equal(stepNamed(job, "Check out main").with["persist-credentials"], false)
  // The release and the pull request dry run run the same script, so the checks below are the checks of both.
  assert.match(stepNamed(build, "Build and check the release").run, /scripts\/build-and-check-release\.sh --stage "\$RELEASE_STAGE"$/mu)
  const checks = sharedScript()
  for (const check of ["check-release-integrity", "validate-skills", "test-desk-docs", "test-desk-host-manifests", "test-desk-generated-artifacts", "test-desk-contracts"]) {
    assert.match(checks, new RegExp(check, "u"), check)
  }
  for (const folder of ["release", "activation", "artifacts", "docs", "scripts", "launch"]) {
    assert.match(checks, new RegExp(`^patterns=\\(.*\\b${folder}\\b.*\\)$`, "mu"), folder)
  }
  assert.match(stepNamed(build, "Build and check the release").run, /git bundle create "\$RUNNER_TEMP\/desk-release\/release\.bundle" refs\/heads\/main "\^\$base"/u)
  assert.match(checks, /output "released=true" "summary=\$summary" "sha=\$sha" "base=\$base"/u)
  // The push job uses only actions and git: no npm, no node and no script from the repository.
  assert.equal(push.needs, "build")
  assert.equal(push.if, "needs.build.outputs.released == 'true'")
  for (const step of push.steps) {
    assert.ok(step.uses === undefined || /^actions\/(checkout|download-artifact)@v4$/u.test(step.uses), step.uses)
    assert.doesNotMatch(step.run ?? "", /\bnpm\b|\bnode\b|\bnpx\b|\b(?:ba)?sh scripts\/|\.\/[\w./-]+/u, step.name)
  }
  const verify = stepNamed(push, "Verify and push the release")
  assert.equal(verify.env.SHA, "${{ needs.build.outputs.sha }}")
  assert.match(verify.run, /\[ "\$\(git rev-list --parents -n 1 "\$SHA"\)" = "\$SHA \$BASE" \]/u, "the pushed commit is one commit on the base build checked")
  assert.match(verify.run, /git diff --no-renames --name-status "\$BASE" "\$SHA"/u, "the pushed commit changes only release surfaces and fragments")
  assert.match(verify.run, /git -c core\.hooksPath=\/dev\/null push --porcelain --no-verify origin "\$SHA:refs\/heads\/main"/u, "the push sends the recorded commit with hooks disabled")
  assert.doesNotMatch(verify.run, /HEAD:main/u)
  assert.match(verify.run, /::add-mask::\$credential/u)
  assert.match(verify.run, /grep -qE \$'\^!\\t\[0-9a-f\]\{40\}:refs\/heads\/main\\t.*\(fetch first\|non-fast-forward\)/u, "only git's porcelain refusal line for main counts as main having moved")
  assert.match(verify.run, /non-fast-forward[\s\S]*gh workflow run desk-release\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f stage="\$RELEASE_STAGE"\n\s*echo "handed_off=true"/u, "a refusal because main moved starts a release on the new main")
  // The allowlist is read, not run, from the release script, so it can never drift from the surfaces the release bumps.
  const release = require(script)
  const allowed = [...verify.run.matchAll(/sed -n '([^']+)' scripts\/release-desk\.cjs/gu)]
  assert.equal(allowed.length, 1)
  const listed = spawnSync("sed", ["-n", allowed[0][1], path.join(repoRoot, "scripts", "release-desk.cjs")], { encoding: "utf8" }).stdout.trim().split("\n")
  assert.deepEqual(listed.sort(), [...release.DESK_VERSION_FILES, release.CHANGELOG].sort())
  assert.equal(report.permissions.issues, "write")
})

test("the release workflow marks every released pull request that lacks the mark, once, even on a run with nothing to release", () => {
  const { workflow } = releaseWorkflow()
  const { announce } = workflow.jobs
  assert.deepEqual(announce.needs, ["build", "push"])
  assert.match(announce.if, /needs\.build\.result == 'success'/u)
  assert.doesNotMatch(announce.if, /outputs\.released/u, "a run with nothing to release still catches up")
  assert.match(announce.if, /needs\.push\.outputs\.handed_off != 'true'/u)
  assert.deepEqual(announce.permissions, { contents: "read", issues: "write", "pull-requests": "write" })
  assert.doesNotMatch(JSON.stringify(announce), /secrets\.|DEPLOY_KEY|\bnpm\b|\bnode\b/u, "marking holds no deploy key and runs no dependency or repository code")
  const checkout = stepNamed(announce, "Check out main")
  assert.equal(checkout.with["persist-credentials"], false)
  assert.equal(checkout.with["fetch-depth"], 0)
  const run = stepNamed(announce, "Comment on and label every released pull request that lacks the label").run
  assert.match(run, /--search "-label:\$LABEL merged:>=\$since"/u, "only recent pull requests")
  assert.match(run, /since="\$\{MARK_SINCE:-\$\(date -u -d '30 days ago' \+%F\)\}"/u)
  assert.match(run, /--author='\^github-actions\\\[bot\\\] <41898282\\\+github-actions\\\[bot\\\]@users\\\.noreply\\\.github\\\.com>\$'/u, "the bot's exact author")
  assert.match(run, /--grep='\^Release Desk \[0-9\]'/u, "the carrying release is found by its subject")
  assert.match(run, /grep -qxF -- "\$body"/u, "a rerun does not comment twice")
  assert.equal(announce.env.LABEL, "released")
  // The issue stays open until marking has succeeded.
  assert.match(stepNamed(workflow.jobs.report, "Close the release issue after a successful run").if, /needs\.announce\.result == 'success'/u)
})

// Runs the marking step for real against a scratch history and a fake gh.
function markingRun({ commentsOn = {}, mark }) {
  const { workflow } = releaseWorkflow()
  const run = stepNamed(workflow.jobs.announce, "Comment on and label every released pull request that lacks the label").run
  const dir = mkdtempSync(path.join(tmpdir(), "announce-"))
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })
  git("init", "-q", "-b", "main")
  const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"
  const commit = (name, message, email = "u@example.com") => spawnSync("git", ["-C", dir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "--allow-empty", "-m", message], { encoding: "utf8" })
  const shaOf = {}
  for (const [name, message] of mark.history) {
    if (name === "bot") commit("github-actions[bot]", message, BOT_EMAIL)
    else if (name === "spoof") commit("github-actions[bot]", message)
    else commit("Dev", message)
    shaOf[message] = git("rev-parse", "HEAD").stdout.trim()
  }
  const bin = path.join(dir, "bin")
  mkdirSync(bin)
  const ghLog = path.join(dir, "gh.log")
  const listing = mark.unlabeled.map(([number, message]) => `echo "${number} ${shaOf[message]}"`).join("\n")
  const commentCases = Object.entries(commentsOn).map(([number, body]) => `  *"/issues/${number}/comments"*"--jq"*) echo "${body}" ;;`).join("\n")
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh
echo "$*" >> "${ghLog}"
case "$*" in
  "pr list"*) ${listing || ":"} ;;
${commentCases}
esac
${mark.failOn ? `case "$*" in *"${mark.failOn}"*) exit 1 ;; esac` : ""}
`, { mode: 0o755 })
  const env = { ...process.env, RUNNER_TEMP: dir, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", GITHUB_STEP_SUMMARY: path.join(dir, "summary"), LABEL: "released", MARK_SINCE: "2026-09-06" }
  const result = spawnSync("bash", ["-c", run], { cwd: dir, env, encoding: "utf8" })
  const calls = existsSync(ghLog) ? readFileSync(ghLog, "utf8") : ""
  rmSync(dir, { recursive: true, force: true })
  return { result, calls }
}
const HISTORY = [["bot", "Release Desk 3.2.0-alpha.1"], ["dev", "first (#10)"], ["dev", "second (#11)"], ["bot", "Release Desk 3.2.0-alpha.2"], ["dev", "third (#12)"], ["bot", "Release Desk 3.2.0-alpha.3"], ["spoof", "Release Desk 3.2.0-alpha.9 by a person using the bot name (#13)"], ["bot", "Not a release (#15)\n\nRelease Desk 3.2.0-alpha.8 only in the body"], ["bot", "Release Desk 3.2.0-alpha.1; rm -rf"], ["dev", "unreleased (#14)"]]

test("actual workflow catch-up marks RC-carried PRs with their first bot release and rejects spoofed or inexact RC subjects", () => {
  const mark = {
    history: [
      ["dev", "carried by first RC (#20)"],
      ["spoof", "Release Desk 3.2.0-rc.90"],
      ["bot", "Release Desk 3.2.0-rc.91 trailing text"],
      ["bot", "Not a release\n\nRelease Desk 3.2.0-rc.92"],
      ["bot", "Release Desk 3.2.0-rc.1"],
      ["dev", "carried by next RC (#21)"],
      ["bot", "Release Desk 3.2.0-rc.2"],
      ["dev", "not released (#22)"],
      ["spoof", "Release Desk 3.2.0-rc.93"],
      ["bot", "Release Desk 3.2.0-rc.94 trailing text"],
      ["bot", "Not another release\n\nRelease Desk 3.2.0-rc.95"],
    ],
    unlabeled: [[20, "carried by first RC (#20)"], [21, "carried by next RC (#21)"], [22, "not released (#22)"]],
  }
  const { result, calls } = markingRun({ mark })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const lines = calls.trim().split("\n")
  for (const [number, version] of [[20, "3.2.0-rc.1"], [21, "3.2.0-rc.2"]]) {
    assert.ok(lines.includes(`api --method POST repos/o/r/issues/${number}/comments --field body=Released in Desk ${version}`), calls)
    assert.ok(lines.includes(`api --method POST repos/o/r/issues/${number}/labels --raw-field labels[]=released`), calls)
  }
  assert.doesNotMatch(calls, /issues\/22\/(comments|labels)/u)
  assert.doesNotMatch(calls, /body=Released in Desk 3\.2\.0-rc\.9[0-5]/u)
  const repeated = markingRun({ mark, commentsOn: { 20: "Released in Desk 3.2.0-rc.1", 21: "Released in Desk 3.2.0-rc.2" } })
  assert.equal(repeated.result.status, 0, repeated.result.stdout + repeated.result.stderr)
  assert.doesNotMatch(repeated.calls, /--method POST repos\/o\/r\/issues\/2[01]\/comments/u)
  for (const number of [20, 21]) {
    assert.ok(repeated.calls.includes(`api --method POST repos/o/r/issues/${number}/labels --raw-field labels[]=released`), repeated.calls)
  }
})

test("marking accepts a plain stable version subject and still rejects lookalikes", () => {
  const mark = {
    history: [
      ["dev", "stable carried (#30)"],
      ["spoof", "Release Desk 3.2.0"],
      ["bot", "Release Desk 3.2.0 trailing text"],
      ["bot", "Release Desk 3.2.0"],
      ["dev", "after stable (#31)"],
      ["bot", "Release Desk 3.2.1"],
    ],
    unlabeled: [[30, "stable carried (#30)"], [31, "after stable (#31)"]],
  }
  const { result, calls } = markingRun({ mark })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const lines = calls.trim().split("\n")
  for (const [number, version] of [[30, "3.2.0"], [31, "3.2.1"]]) {
    assert.ok(lines.includes(`api --method POST repos/o/r/issues/${number}/comments --field body=Released in Desk ${version}`), calls)
  }
})

test("marking labels each unlabeled released pull request with the first release after it, and skips unreleased ones", () => {
  const { result, calls } = markingRun({ mark: { history: HISTORY, unlabeled: [[10, "first (#10)"], [11, "second (#11)"], [12, "third (#12)"], [14, "unreleased (#14)"], [13, "Release Desk 3.2.0-alpha.9 by a person using the bot name (#13)"]] } })
  assert.equal(result.status, 0, result.stderr)
  assert.match(calls, /label create released --repo o\/r /u)
  for (const [number, version] of [[10, "alpha.2"], [11, "alpha.2"], [12, "alpha.3"]]) {
    assert.match(calls, new RegExp(`--method POST repos/o/r/issues/${number}/comments --field body=Released in Desk 3\\.2\\.0-${version.replace(".", "\\.")}`, "u"), `#${number}`)
    assert.match(calls, new RegExp(`--method POST repos/o/r/issues/${number}/labels --raw-field labels\\[\\]=released`, "u"), `#${number}`)
  }
  // #13 sits after the last release by a person's commit that merely quotes a release subject; #14 is after it too.
  assert.doesNotMatch(calls, /issues\/1[34]\/(comments|labels)/u)
})

test("announce failed on one release, the next release succeeds: the earlier release's pull requests are marked with their own version", () => {
  // Alpha.2's marking failed (nothing was labeled). A later run, after alpha.3, still finds #10 and #11 unlabeled and marks them alpha.2.
  const failed = markingRun({ mark: { history: HISTORY, unlabeled: [[10, "first (#10)"]], failOn: "/issues/10/labels" } })
  assert.notEqual(failed.result.status, 0, "a failed label call fails the job, so the issue stays open")
  const caught = markingRun({ mark: { history: HISTORY, unlabeled: [[10, "first (#10)"], [11, "second (#11)"]] } })
  assert.equal(caught.result.status, 0, caught.result.stderr)
  assert.match(caught.calls, /issues\/10\/comments --field body=Released in Desk 3\.2\.0-alpha\.2/u)
  assert.match(caught.calls, /issues\/11\/labels/u)
})

test("marking is safe to repeat: an existing comment is not repeated, and nothing to mark is a clean run", () => {
  const { result, calls } = markingRun({ commentsOn: { 10: "Released in Desk 3.2.0-alpha.2" }, mark: { history: HISTORY, unlabeled: [[10, "first (#10)"]] } })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(calls, /--method POST repos\/o\/r\/issues\/10\/comments/u)
  assert.match(calls, /--method POST repos\/o\/r\/issues\/10\/labels/u)
  const none = markingRun({ mark: { history: HISTORY, unlabeled: [] } })
  assert.equal(none.result.status, 0, none.result.stderr)
  assert.doesNotMatch(none.calls, /POST|label create/u)
})

test("pull request CI dry-runs auto, RC and stable through the full shared helper, and the CI gate waits for both", () => {
  const tests = require("js-yaml").load(readRepo(".github/workflows/desk-mcp-tests.yml"))
  const job = tests.jobs["release-dry-run"]
  assert.deepEqual(job.strategy, { "fail-fast": false, matrix: { stage: ["auto", "rc", "stable"] } })
  assert.equal(job.name, "Release dry run (${{ matrix.stage }})")
  assert.equal(job["timeout-minutes"], 15)
  assert.deepEqual(job.permissions, { contents: "read" })
  assert.equal(job["continue-on-error"], undefined)
  assert.equal(job.if, undefined)
  const step = stepNamed(job, "Build and check the release without keeping it")
  assert.equal(step.env.RELEASE_STAGE, "${{ matrix.stage }}")
  for (const stage of job.strategy.matrix.stage) {
    // Capture the real workflow shell command's arguments only; the destructive full helper runs in CI, not here.
    const result = spawnSync("bash", ["-c", `scripts/build-and-check-release.sh() { printf '%s\\n' "$@"; }\n${step.run}`], {
      encoding: "utf8", env: { ...bareEnv, RELEASE_STAGE: stage },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split("\n"), ["--dry-run", "--stage", stage])
  }
  assert.deepEqual(tests.jobs["ci-gate"].needs, [
    "blackbox", "browser", "desk-mcp-coverage-shards",
    "offline-eval-tests", "release-dry-run", "desk-mcp-tests", "desk-runtime-packs",
    "desk-native-windows", "unused-code",
  ])
  assert.equal(tests.jobs["ci-gate"].name, "CI gate")
  assert.equal(tests.jobs["ci-gate"].if, "${{ always() }}")
  const release = stepNamed(releaseWorkflow().workflow.jobs.build, "Build and check the release").run
  assert.match(release, /scripts\/build-and-check-release\.sh --stage "\$RELEASE_STAGE"$/mu)
  assert.doesNotMatch(release, /--dry-run/u)
})

test("the shared release script fails a test step that matches no file or runs no test", () => {
  const text = sharedScript()
  assert.match(text, /matches no test file/u)
  assert.match(text, /\[ "\$\{ran:-0\}" -gt 0 \]/u)
})

// Runs the real script in a temporary repository whose release scripts are stubs, so the dry run's own behaviour is exercised.
function dryRunRepo({ tests }) {
  const root = mkdtempSync(path.join(tmpdir(), "dry-run-"))
  const put = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  put("scripts/build-and-check-release.sh", readRepo("scripts/build-and-check-release.sh"))
  put("scripts/release-desk.cjs", `const fs = require("node:fs"); const dir = "plugins/desk/changelog.d";
const found = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "README.md") : [];
if (found.length) { for (const n of found) fs.rmSync(dir + "/" + n); fs.writeFileSync("plugins/desk/released.txt", "x"); }
console.log(JSON.stringify({ released: found.length > 0, to: "9.9.9-alpha.1", fragments: found.map((n) => dir + "/" + n) }));\n`)
  for (const name of ["check-release-integrity", "validate-skills", "test-desk-docs", "test-desk-host-manifests", "test-desk-generated-artifacts", "test-desk-contracts"]) put(`scripts/${name}.cjs`, "")
  put(".claude-plugin/marketplace.json", "{}\n")
  put("plugins/desk/changelog.d/README.md", "readme\n")
  put("plugins/desk/mcp/package.json", "{}\n")
  put("tests/desk/mcp/__tests__/_isolated_env.mjs", "")
  for (const name of ["release", "activation", "artifacts", "docs", "scripts", "launch"]) put(`tests/desk/mcp/__tests__/${name}/a.test.js`, tests)
  const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" })
  git("init", "-q", "-b", "main")
  git("add", "--all")
  git("commit", "-q", "-m", "start")
  return { root, git, head: () => git("rev-parse", "HEAD").stdout.trim() }
}
const runDryRun = (repo) => spawnSync("bash", ["scripts/build-and-check-release.sh", "--dry-run"], { cwd: repo.root, encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")) })

test("a dry run with no fragment pending still folds and checks a throwaway fragment, then restores the tree", () => {
  const repo = dryRunRepo({ tests: 'require("node:test")("t", () => {})\n' })
  const before = repo.head()
  const result = runDryRun(repo)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /builds and passes every check/u)
  assert.equal(repo.head(), before)
  assert.equal(repo.git("status", "--porcelain").stdout, "")
  assert.equal(repo.git("branch", "--show-current").stdout.trim(), "main")
  rmSync(repo.root, { recursive: true, force: true })
})

test("a dry run whose release tests are all skipped fails, because only passing tests count", () => {
  const repo = dryRunRepo({ tests: 'require("node:test")("t", { skip: true }, () => {})\n' })
  const result = runDryRun(repo)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout + result.stderr, /passed 0 tests/u)
  assert.equal(repo.git("status", "--porcelain").stdout, "")
  rmSync(repo.root, { recursive: true, force: true })
})
