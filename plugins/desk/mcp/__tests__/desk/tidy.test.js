// The one-time tidy (M4-5): tidyStatus is the `02-tidy-desk` migration's
// Detect predicate — organization findings in this session's own desk
// subtree, and no `tidy_version: 1` in its `_meta/organization.json`.
//
// Every test runs against a fixture desk in a temporary folder; nothing here
// ever reads or writes a real desk.

import { test, after } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  ORGANIZATION_RECORD,
  TIDY_VERSION,
  organizationRecord,
  readOrganizationRecord,
  runTidyStatusCli,
  tidySafetyProblem,
  tidyStatus,
  writeOrganizationRecord,
} from "../../src/desk/tidy.js"

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const SCRIPT = path.join(mcpRoot, "scripts", "tidy-status.js")
const NOW = Date.parse("2026-09-25T00:00:00Z")
const RECENT = "2026-09-20T00:00:00Z"

const scratch = new Set()
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix = "desk-tidy-test-") {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)))
  scratch.add(dir)
  return dir
}

function write(root, rel, content) {
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function initGit(root) {
  git(root, "init", "-q")
  git(root, "config", "user.name", "Fixture Owner")
  git(root, "config", "user.email", "fixture@example.com")
}

function cleanTrack(root, prefix = "") {
  write(root, `${prefix}billing-disputes/track.md`, "---\ntitle: billing-disputes\nscope: billing disputes; not payroll\n---\n")
  write(
    root,
    `${prefix}billing-disputes/refund-flow-cleanup/task.md`,
    `---\ntitle: refund-flow-cleanup\nstatus: processing\nupdated: '${RECENT}'\n---\n`,
  )
}

function messyTrack(root, prefix = "") {
  write(root, `${prefix}inbox/track.md`, "---\ntitle: inbox\n---\n")
  write(root, `${prefix}inbox/hi-please-fix-this/task.md`, `---\ntitle: hi\nstatus: processing\nupdated: '${RECENT}'\n---\n`)
  write(root, `${prefix}scratch-notes.txt`, "stray\n")
}

function soloDesk({ messy = true, git: withGit = true } = {}) {
  const root = tempDir()
  mkdirSync(path.join(root, "_meta"), { recursive: true })
  mkdirSync(path.join(root, "_archive"), { recursive: true })
  cleanTrack(root)
  if (messy) messyTrack(root)
  if (withGit) initGit(root)
  return root
}

function crewDesk() {
  const root = tempDir()
  write(root, "_meta/desks.md", "| alias | identity |\n|---|---|\n| alice | alice |\n| bob | bob |\n")
  cleanTrack(root, "desks/alice/")
  messyTrack(root, "desks/bob/")
  initGit(root)
  return root
}

function status(root, extra = {}) {
  return tidyStatus({ root, env: {}, homeDir: tempDir(), now: NOW, ...extra })
}

function io() {
  const out = { stdout: "", stderr: "" }
  return {
    out,
    io: {
      stdout: { write: (text) => { out.stdout += text } },
      stderr: { write: (text) => { out.stderr += text } },
    },
  }
}

function cli(argv, extra = {}) {
  const captured = io()
  const code = runTidyStatusCli({ argv, env: {}, io: captured.io, homeDir: tempDir(), now: NOW, ...extra })
  return { code, ...captured.out }
}

// ── The Detect predicate ─────────────────────────────────────────────────

test("tidy is needed on a messy Git desk with no organization record", () => {
  const root = soloDesk()
  const result = status(root)
  assert.equal(result.applicable, true)
  assert.equal(result.needed, true)
  assert.equal(result.reason, "tidy needed")
  assert.equal(result.root, root)
  assert.equal(result.subtree, root)
  assert.equal(result.tidy_version, null)
  assert.deepEqual(
    [...new Set(result.findings.map((f) => f.code))].sort(),
    ["loose_file", "name_prompt_like", "track_catch_all", "track_missing_scope"],
  )
})

test("tidy is not needed on a clean desk", () => {
  const result = status(soloDesk({ messy: false }))
  assert.equal(result.applicable, true)
  assert.equal(result.needed, false)
  assert.equal(result.reason, "nothing to tidy")
  assert.deepEqual(result.findings, [])
})

test("tidy is not needed once the organization record says tidy_version 1, or later", () => {
  for (const version of [TIDY_VERSION, TIDY_VERSION + 1]) {
    const root = soloDesk()
    write(root, ORGANIZATION_RECORD, JSON.stringify({ schema_version: 1, tidy_version: version, tidied_at: RECENT }))
    const result = status(root)
    assert.equal(result.needed, false)
    assert.equal(result.reason, "already tidied")
    assert.equal(result.tidy_version, version)
    assert.ok(result.findings.length > 0, "the doctor still reports; the tidy just doesn't run again")
  }
})

test("a record without a usable tidy_version does not count as tidied", () => {
  for (const body of ["{", "null", "7", JSON.stringify({ tidy_version: "1" }), JSON.stringify({ tidy_version: 0 })]) {
    const root = soloDesk()
    write(root, ORGANIZATION_RECORD, body)
    assert.equal(status(root).needed, true, body)
  }
})

test("a desk that is not a Git repository is never tidied", () => {
  const result = status(soloDesk({ git: false }))
  assert.equal(result.applicable, false)
  assert.equal(result.needed, false)
  assert.match(result.reason, /not a Git repository/)
  assert.deepEqual(result.findings, [])
})

test("a Git probe that throws counts as not a Git repository", () => {
  const result = status(soloDesk(), {
    spawnGit: () => {
      throw new Error("git ENOENT")
    },
  })
  assert.match(result.reason, /not a Git repository/)
})

test("no bound desk means nothing to tidy", () => {
  const result = tidyStatus({ env: {}, homeDir: tempDir(), cwd: tempDir() })
  assert.deepEqual(
    { applicable: result.applicable, needed: result.needed, root: result.root, reason: result.reason },
    { applicable: false, needed: false, root: null, reason: "no desk is bound" },
  )
})

test("the desk is found the way the Desk MCP finds it, including $DESK", () => {
  const root = soloDesk()
  const result = tidyStatus({ env: { DESK: root }, homeDir: tempDir(), cwd: tempDir(), now: NOW })
  assert.equal(result.root, root)
  assert.equal(result.needed, true)
})

// ── Crew desks: only this session's own subtree ─────────────────────────────

test("on a crew desk only this session's own subtree counts: a peer's mess never fires", () => {
  const root = crewDesk()
  const alice = status(root, { person: "alice" })
  assert.equal(alice.subtree, path.join(root, "desks", "alice"))
  assert.equal(alice.needed, false)

  const bob = status(root, { env: { DESK_PERSON: "bob" } })
  assert.equal(bob.subtree, path.join(root, "desks", "bob"))
  assert.equal(bob.needed, true)
  assert.ok(bob.findings.every((f) => f.path.startsWith("desks/bob/")))
})

test("the organization record lives in this session's own subtree", () => {
  const root = crewDesk()
  write(root, "_meta/organization.json", JSON.stringify(organizationRecord()))
  assert.equal(status(root, { person: "bob" }).needed, true, "a record at the crew root is not bob's")
  write(root, `desks/bob/${ORGANIZATION_RECORD}`, JSON.stringify(organizationRecord()))
  assert.equal(status(root, { person: "bob" }).needed, false)
})

test("a crew desk with no alias is never tidied", () => {
  const result = status(crewDesk())
  assert.equal(result.applicable, false)
  assert.match(result.reason, /crew desk/)
})

test("an alias whose desk does not exist yet, or an invalid alias, is never tidied", () => {
  const root = crewDesk()
  assert.match(status(root, { person: "carol" }).reason, /does not exist yet/)
  const invalid = status(root, { person: "../bob" })
  assert.equal(invalid.applicable, false)
  assert.equal(invalid.subtree, null)
  assert.match(invalid.reason, /not a valid desk name/)
})

// ── Safety check ────────────────────────────────────────────────────────

test("tidying is safe on a quiet Git desk and waits during a merge, rebase, cherry-pick or revert", () => {
  const root = soloDesk()
  assert.equal(tidySafetyProblem(root), null)
  const gitDir = path.join(root, ".git")
  for (const [marker, what] of [
    ["MERGE_HEAD", "a merge"],
    ["rebase-merge", "a rebase"],
    ["rebase-apply", "a rebase"],
    ["CHERRY_PICK_HEAD", "a cherry-pick"],
    ["REVERT_HEAD", "a revert"],
  ]) {
    write(gitDir, marker, "")
    assert.match(tidySafetyProblem(root), new RegExp(`in the middle of ${what}`))
    rmSync(path.join(gitDir, marker), { force: true })
  }
  assert.match(tidySafetyProblem(tempDir()), /not a Git repository/)
})

// ── The record ──────────────────────────────────────────────────────────

test("the organization record has the documented shape", () => {
  const now = new Date("2026-09-25T12:00:00Z")
  assert.deepEqual(organizationRecord(now), { schema_version: 1, tidy_version: 1, tidied_at: "2026-09-25T12:00:00.000Z" })
  assert.match(organizationRecord().tidied_at, /^\d{4}-\d{2}-\d{2}T/)

  const subtree = tempDir()
  assert.equal(readOrganizationRecord(subtree), null)
  const file = writeOrganizationRecord(subtree, now)
  assert.equal(file, path.join(subtree, "_meta", "organization.json"))
  assert.equal(readFileSync(file, "utf8"), `${JSON.stringify(organizationRecord(now), null, 2)}\n`)
  assert.deepEqual(readOrganizationRecord(subtree), organizationRecord(now))
})

// ── The command line ────────────────────────────────────────────────────

test("--detect exits 0 only when the tidy is needed, and prints nothing", () => {
  const messy = soloDesk()
  assert.deepEqual(cli(["--detect", "--root", messy]), { code: 0, stdout: "", stderr: "" })
  assert.equal(cli(["--detect", "--root", soloDesk({ messy: false })]).code, 1)
  assert.equal(cli(["--detect"], { env: { DESK: messy } }).code, 0)
  assert.equal(cli(["--detect", "--root", crewDesk(), "--person", "bob"]).code, 0)
  assert.equal(cli(["--detect", "--root", path.join(messy, "missing")]).code, 1)
})

test("with no mode the status is printed as JSON", () => {
  const root = soloDesk()
  const result = cli(["--root", root])
  assert.equal(result.code, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.needed, true)
  assert.equal(parsed.subtree, root)
})

test("--report lists this session's own findings, and refuses a desk that can't be tidied", () => {
  const root = soloDesk()
  const result = cli(["--report", "--root", root])
  assert.equal(result.code, 0)
  assert.match(result.stdout, new RegExp(`^Desk: ${root}\\nThis session's own desk: ${root}\\nOrganization findings in it: \\d+\\n`))
  assert.match(result.stdout, /^ {2}track_catch_all: inbox — /m)

  const refused = cli(["--report", "--root", soloDesk({ git: false })])
  assert.equal(refused.code, 1)
  assert.match(refused.stdout, /^The desk cannot be tidied: the desk is not a Git repository/)
})

test("--safety exits 0 on a quiet desk and prints why it waits otherwise", () => {
  const root = soloDesk()
  assert.deepEqual(cli(["--safety", "--root", root]), { code: 0, stdout: "", stderr: "" })
  write(path.join(root, ".git"), "MERGE_HEAD", "")
  const waiting = cli(["--safety", "--root", root])
  assert.equal(waiting.code, 1)
  assert.match(waiting.stdout, /^The tidy waits: the desk repository is in the middle of a merge/)
})

test("--write-record writes the record in this session's own subtree and turns Detect off", () => {
  const root = crewDesk()
  const written = cli(["--write-record", "--root", root, "--person", "bob"])
  assert.equal(written.code, 0)
  assert.equal(written.stdout, `${path.join("desks", "bob", "_meta", "organization.json")}\n`)
  const record = JSON.parse(readFileSync(path.join(root, "desks", "bob", ORGANIZATION_RECORD), "utf8"))
  assert.deepEqual(record, { schema_version: 1, tidy_version: 1, tidied_at: new Date(NOW).toISOString() })
  assert.equal(cli(["--detect", "--root", root, "--person", "bob"]).code, 1)

  const now = Date.now()
  const solo = soloDesk()
  assert.equal(runTidyStatusCli({ argv: ["--write-record", "--root", solo], env: {}, io: io().io, homeDir: tempDir() }), 0)
  assert.ok(Date.parse(readOrganizationRecord(solo).tidied_at) >= now - 1000)
})

test("an unknown argument is refused with exit code 2", () => {
  const result = cli(["--tidy-everything"])
  assert.equal(result.code, 2)
  assert.equal(result.stderr, 'tidy-status: unknown argument "--tidy-everything"\n')
})

test("scripts/tidy-status.js runs the command line", () => {
  const root = soloDesk()
  const home = tempDir()
  // Keep the parent's environment (the coverage runner instruments child
  // processes through it), minus every variable that could bind a real desk.
  const env = { ...process.env, HOME: home, DESK: root }
  for (const key of ["DESK_ACTIVATION_CONFIG", "CODEX_HOME", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR", "DESK_PERSON"]) delete env[key]
  const report = execFileSync(process.execPath, [SCRIPT, "--report"], { encoding: "utf8", env, cwd: home })
  assert.match(report, /Organization findings in it: \d+/)
  const detect = spawnSync(process.execPath, [SCRIPT, "--detect", "--root", soloDesk({ messy: false })], { env, cwd: home })
  assert.equal(detect.status, 1)
})
