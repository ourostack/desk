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

const readRepo = (file) => readFileSync(path.join(repoRoot, file), "utf8")
const currentDesk = JSON.parse(readRepo("plugins/desk/.claude-plugin/plugin.json")).version
const mcpVersion = JSON.parse(readRepo("plugins/desk/mcp/package.json")).version
const fragmentDir = "plugins/desk/changelog.d"

// A copy of every file a release reads or writes.
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-release-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const file of [...release.DESK_VERSION_FILES, release.CHANGELOG, "plugins/desk/mcp/package.json"]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    copyFileSync(path.join(repoRoot, file), path.join(root, file))
  }
  mkdirSync(path.join(root, fragmentDir))
  writeFileSync(path.join(root, fragmentDir, "README.md"), "How to write a fragment.\n")
  return root
}

function snapshot(root) {
  const files = {}
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files[path.relative(root, full)] = readFileSync(full, "utf8")
    }
  }
  walk(root)
  return files
}

const fragment = (root, name, text) => writeFileSync(path.join(root, fragmentDir, name), text)

test("the next alpha follows the current one and only alphas are released", () => {
  assert.equal(release.nextAlpha("3.2.0-alpha.9"), "3.2.0-alpha.10")
  assert.throws(() => release.nextAlpha("3.2.0"), /Desk version 3\.2\.0 is not an alpha release/u)
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
  const next = release.nextAlpha(currentDesk)

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
  assert.match(readFileSync(path.join(root, "plugins/desk/mcp/__tests__/release/release_coupling.test.js"), "utf8"), /const expectedReleaseDate = "2026-10-01"/u)
  assert.equal(
    readFileSync(path.join(root, release.CHANGELOG), "utf8"),
    `# desk plugin — changelog\n\n## ${next} — 2026-10-01\n\nThe alpha feature, with a [link](docs/x.md).\n\nThe zebra fix.\n\nIts second paragraph.\n\nShips \`desk-mcp@${mcpVersion}\`.\n\n${previousChangelog.slice(release.CHANGELOG_HEADER.length)}`,
  )
  // The folded fragments are gone; the folder's README and anything that is not a fragment stay.
  assert.deepEqual(readdirSync(path.join(root, fragmentDir)).sort(), ["README.md", "notes.txt"])
  assert.deepEqual(release.releaseDesk({ root, date: "2026-10-01" }), { released: false, fragments: [] })
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
  const success = spawnSync(process.execPath, [script, "--root", root, "--date", "2026-10-02"], { encoding: "utf8" })
  assert.equal(success.status, 0, success.stderr)
  assert.equal(JSON.parse(success.stdout).to, release.nextAlpha(currentDesk))
  const failure = spawnSync(process.execPath, [script, "--root", root, "--date", "tomorrow"], { encoding: "utf8" })
  assert.equal(failure.status, 1)
  assert.match(failure.stderr, /the release date must be YYYY-MM-DD: tomorrow/u)
  // The repository's own fragments folder keeps its instructions, and a real checkout has nothing to release by default here.
  assert.ok(existsSync(path.join(repoRoot, fragmentDir, "README.md")))
})

test("the release workflow runs on main one at a time and daily, checks the release, pushes it and reports a failure", () => {
  const workflow = readRepo(".github/workflows/desk-release.yml")
  for (const required of [
    /\n {2}push:\n {4}branches:\n {6}- main\n {4}paths:\n {6}- "plugins\/desk\/changelog\.d\/\*\*"\n/u,
    /\n {2}workflow_dispatch:\n/u,
    /\npermissions: \{\}\n/u,
    /\nconcurrency:\n {2}group: desk-release\n {2}cancel-in-progress: false\n/u,
    /\n {6}contents: write\n/u,
    /node scripts\/release-desk\.cjs --date/u,
    /node scripts\/check-release-integrity\.cjs/u,
    /"__tests__\/release\/\*\*\/\*\.test\.js"/u,
    /git push --quiet origin HEAD:main 2>&1/u,
    /\n {2}schedule:\n {4}- cron: "[^"]+"\n/u,
    /\n {6}issues: write\n/u,
    /\n {6}- name: Report the failed release\n {8}if: failure\(\)\n/u,
    /gh issue create --repo "\$GITHUB_REPOSITORY" --title "\$ISSUE_TITLE"/u,
    /\n {6}- name: Close the release issue after a successful run\n {8}if: success\(\)\n/u,
  ]) {
    assert.match(workflow, required)
  }
  assert.doesNotMatch(workflow, /pull_request/u, "the release never runs for an unmerged pull request")
  assert.doesNotMatch(workflow, /--force/u, "a release never overwrites main")
})

test("the release workflow keeps its write token away from installs and checks, and checks every release surface", () => {
  const workflow = readRepo(".github/workflows/desk-release.yml")
  // Each step's text, without the comment lines that introduce the step after it.
  const steps = workflow.split(/\n(?= {6}- name: )/u).map((text) => text.split("\n").filter((line) => !/^ *#/u.test(line)).join("\n"))
  const step = (name) => {
    const found = steps.find((text) => text.startsWith(`      - name: ${name}\n`))
    assert.ok(found, `missing step: ${name}`)
    return found
  }
  assert.match(step("Check out main"), /\n {10}persist-credentials: false\n/u, "no write credential stays in .git/config")
  // Only the push step and the issue steps receive the token; the install and the release checks never do.
  for (const text of steps) {
    if (!/github\.token/u.test(text)) continue
    assert.match(text, /^ {6}- name: (Push the release to main|Report the failed release|Close the release issue after a successful run)\n/u, text.split("\n")[0])
  }
  assert.doesNotMatch(step("Install Desk MCP dependencies"), /env:|token/iu)
  const build = step("Build and check the release")
  assert.doesNotMatch(build, /env:|token|git push/iu)
  for (const check of ["check-release-integrity", "validate-skills", "test-desk-docs", "test-desk-host-manifests", "test-desk-generated-artifacts", "test-desk-contracts"]) {
    assert.match(build, new RegExp(`${check}`, "u"), check)
  }
  for (const folder of ["release", "activation", "artifacts", "docs", "scripts"]) {
    assert.ok(build.includes(`"__tests__/${folder}/**/*.test.js"`), folder)
  }
  const push = step("Push the release to main")
  assert.match(push, /if: steps\.release\.outputs\.released == 'true'/u)
  assert.match(push, /GIT_CONFIG_VALUE_0="AUTHORIZATION: basic \$credential" git push --quiet origin HEAD:main 2>&1/u)
  assert.match(push, /::add-mask::\$credential/u)
  assert.match(push, /grep -qE 'fetch first\|non-fast-forward'[\s\S]*gh workflow run desk-release\.yml --repo "\$GITHUB_REPOSITORY" --ref main/u, "a refusal because main moved starts a release on the new main")
  assert.match(workflow, /\n {6}actions: write\n/u)
})
