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
  assert.match(readFileSync(path.join(root, "tests/desk/mcp/__tests__/release/release_coupling.test.js"), "utf8"), /const expectedReleaseDate = "2026-10-01"/u)
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
  const success = spawnSync(process.execPath, [script, "--root", root, "--date", "2026-10-02"], { encoding: "utf8", env: bareEnv })
  assert.equal(success.status, 0, success.stderr)
  assert.equal(JSON.parse(success.stdout).to, release.nextAlpha(currentDesk))
  const failure = spawnSync(process.execPath, [script, "--root", root, "--date", "tomorrow"], { encoding: "utf8", env: bareEnv })
  assert.equal(failure.status, 1)
  assert.match(failure.stderr, /the release date must be YYYY-MM-DD: tomorrow/u)
  // The repository's own fragments folder keeps its instructions, and a real checkout has nothing to release by default here.
  assert.ok(existsSync(path.join(repoRoot, fragmentDir, "README.md")))
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

test("the release workflow runs on main one at a time and daily, checks the release, pushes it and reports a failure", () => {
  const { text, workflow } = releaseWorkflow()
  assert.deepEqual(workflow.on.push, { branches: ["main"], paths: ["plugins/desk/changelog.d/**"] })
  assert.ok("workflow_dispatch" in workflow.on)
  assert.match(workflow.on.schedule[0].cron, /\S/u)
  assert.deepEqual(workflow.permissions, {})
  assert.deepEqual(workflow.concurrency, { group: "desk-release", "cancel-in-progress": false })
  assert.deepEqual(Object.keys(workflow.jobs), ["build", "push", "report"])
  const build = stepNamed(workflow.jobs.build, "Build and check the release").run
  assert.match(build, /node scripts\/release-desk\.cjs --date/u)
  assert.match(build, /node scripts\/check-release-integrity\.cjs/u)
  assert.match(build, /"__tests__\/release\/\*\*\/\*\.test\.js"/u)
  const report = workflow.jobs.report
  assert.deepEqual(report.needs, ["build", "push"])
  assert.deepEqual(report.permissions, { issues: "write" })
  assert.equal(stepNamed(report, "Report the failed release").if, "needs.build.result == 'failure' || needs.push.result == 'failure'")
  assert.match(stepNamed(report, "Report the failed release").run, /gh issue create --repo "\$GITHUB_REPOSITORY" --title "\$ISSUE_TITLE"/u)
  // A run that handed its release to a new run leaves the issue open: its fragments are still pending.
  assert.match(stepNamed(report, "Close the release issue after a successful run").if, /needs\.push\.outputs\.handed_off != 'true'/u)
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
  const checks = stepNamed(build, "Build and check the release").run
  for (const check of ["check-release-integrity", "validate-skills", "test-desk-docs", "test-desk-host-manifests", "test-desk-generated-artifacts", "test-desk-contracts"]) {
    assert.match(checks, new RegExp(check, "u"), check)
  }
  for (const folder of ["release", "activation", "artifacts", "docs", "scripts"]) {
    assert.ok(checks.includes(`"../../../tests/desk/mcp/__tests__/${folder}/**/*.test.js"`), folder)
  }
  assert.match(checks, /git bundle create "\$RUNNER_TEMP\/desk-release\/release\.bundle" refs\/heads\/main "\^\$base"/u)
  assert.match(checks, /echo "sha=\$sha"; echo "base=\$base"/u)
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
  assert.match(verify.run, /non-fast-forward[\s\S]*gh workflow run desk-release\.yml --repo "\$GITHUB_REPOSITORY" --ref main\n\s*echo "handed_off=true"/u, "a refusal because main moved starts a release on the new main")
  // The allowlist is read, not run, from the release script, so it can never drift from the surfaces the release bumps.
  const release = require(script)
  const allowed = [...verify.run.matchAll(/sed -n '([^']+)' scripts\/release-desk\.cjs/gu)]
  assert.equal(allowed.length, 1)
  const listed = spawnSync("sed", ["-n", allowed[0][1], path.join(repoRoot, "scripts", "release-desk.cjs")], { encoding: "utf8" }).stdout.trim().split("\n")
  assert.deepEqual(listed.sort(), [...release.DESK_VERSION_FILES, release.CHANGELOG].sort())
  assert.equal(report.permissions.issues, "write")
})
