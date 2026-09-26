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
  identityCachePath,
  organizationRecord,
  parseDeskRegistry,
  readOrganizationRecord,
  resolvePerson,
  runTidyStatusCli,
  tidySafetyProblem,
  tidyStatus,
  uncommittedPaths,
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
  write(root, "_meta/desks.md", "# Desks\n\n| alias | identity | path |\n|---|---|---|\n| alice | alice-login | desks/alice |\n| bob | Bob-Login | desks/bob |\n| | orphan | x |\n")
  cleanTrack(root, "desks/alice/")
  messyTrack(root, "desks/bob/")
  initGit(root)
  return root
}

// The script's own view of a desk: $DESK names it, as the Desk MCP would find it.
function status(root, extra = {}) {
  return tidyStatus({ env: { DESK: root }, homeDir: tempDir(), cwd: tempDir(), now: NOW, ...extra })
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
  const code = runTidyStatusCli({ argv, env: {}, io: captured.io, homeDir: tempDir(), cwd: tempDir(), now: NOW, ...extra })
  return { code, ...captured.out }
}

const noGh = () => {
  throw new Error("gh must not be called")
}

// ── The Detect predicate ─────────────────────────────────────────────────

test("tidy is needed on a messy Git desk with no organization record", () => {
  const root = soloDesk()
  const result = status(root)
  assert.equal(result.applicable, true)
  assert.equal(result.needed, true)
  assert.equal(result.reason, "tidy needed")
  assert.equal(result.root, root)
  assert.equal(result.person, null)
  assert.equal(result.subtree, root)
  assert.equal(result.mismatch, false)
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

test("stale tasks alone never make the tidy needed, but the report still lists them", () => {
  const root = soloDesk({ messy: false })
  write(root, "billing-disputes/old-refund-audit/task.md", "---\ntitle: old-refund-audit\nstatus: processing\nupdated: '2026-07-01T00:00:00Z'\n---\n")
  const result = status(root)
  assert.deepEqual(result.findings.map((f) => f.code), ["stale_task"])
  assert.equal(result.needed, false)
  assert.equal(result.reason, "nothing to tidy")
  const report = cli(["--report"], { env: { DESK: root } })
  assert.equal(report.code, 0)
  assert.match(report.stdout, /^ {2}stale_task: billing-disputes\/old-refund-audit\/task\.md — .*\(reported only; the tidy leaves it alone\)$/m)
})

test("once the organization record says tidy_version 1 or later, the desk is not even walked", () => {
  for (const version of [TIDY_VERSION, TIDY_VERSION + 1]) {
    const root = soloDesk()
    write(root, ORGANIZATION_RECORD, JSON.stringify({ schema_version: 1, tidy_version: version, tidied_at: RECENT }))
    const result = status(root)
    assert.equal(result.needed, false)
    assert.equal(result.applicable, true)
    assert.equal(result.reason, "already tidied")
    assert.equal(result.tidy_version, version)
    assert.deepEqual(result.findings, [], "the record is read before the walk")
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

// ── The same desk the Desk tools use ────────────────────────────────────────

test("with the tools' own root and person, the tidy works on that desk and notes whether it resolves the same one", () => {
  const root = soloDesk()
  const agree = tidyStatus({ root, env: { DESK: root }, homeDir: tempDir(), cwd: tempDir(), now: NOW })
  assert.equal(agree.mismatch, false)
  assert.equal(agree.needed, true)

  const elsewhere = soloDesk({ messy: false })
  const disagree = tidyStatus({ root, env: { DESK: elsewhere }, homeDir: tempDir(), cwd: tempDir(), now: NOW })
  assert.equal(disagree.mismatch, true)
  assert.equal(disagree.root, root, "the tools' desk is the one described")
  assert.deepEqual(disagree.resolved, { root: elsewhere, person: null })
  assert.equal(disagree.needed, true)

  const unresolved = tidyStatus({ root, env: {}, homeDir: tempDir(), cwd: tempDir(), now: NOW })
  assert.equal(unresolved.mismatch, true, "a desk the script cannot find at all is a mismatch too")

  const missing = tidyStatus({ root: path.join(root, "gone"), env: { DESK: root }, homeDir: tempDir(), cwd: tempDir(), now: NOW })
  assert.equal(missing.mismatch, true, "a tools' root that no longer exists never matches")
  assert.equal(missing.needed, false)
})

test("--report stops with one line when the tools' desk or person differs from what the script resolves", () => {
  const root = crewDesk()
  const elsewhere = soloDesk()
  const otherRoot = cli(["--report", "--root", root, "--person", "bob"], { env: { DESK: elsewhere, DESK_PERSON: "bob" } })
  assert.equal(otherRoot.code, 1)
  assert.equal(otherRoot.stdout, `I left my desk untidied: the Desk tools use ${root} as bob, but the tidy found ${elsewhere} as bob.\n`)

  const person = cli(["--report", "--root", root, "--person", "bob"], { env: { DESK: root, DESK_PERSON: "alice" } })
  assert.equal(person.code, 1)
  assert.match(person.stdout, /^I left my desk untidied: the Desk tools use .* as bob, but the tidy found .* as alice\.\n$/)

  const lost = cli(["--report", "--root", root, "--person", "bob"], { env: { DESK_PERSON: "bob" } })
  assert.equal(lost.stdout, `I left my desk untidied: the Desk tools use ${root} as bob, but the tidy found no desk.\n`)

  const none = cli(["--write-record", "--root", root], { env: {}, spawnGh: noGh })
  assert.equal(none.code, 1)
  assert.match(none.stdout, /^I couldn't tell which desk in this crew workspace is mine/)

  const agree = cli(["--report", "--root", root, "--person", "bob"], { env: { DESK: root, DESK_PERSON: "bob" } })
  assert.equal(agree.code, 0)
  assert.match(agree.stdout, new RegExp(`^Desk tools: ${root} as bob\\nThis script: ${root} as bob\\nThis session's own desk: ${path.join(root, "desks", "bob")}\\n`))
})

// ── Crew desks: only this session's own subtree ─────────────────────────────

test("on a crew desk the person comes from the identity column, with DESK_PERSON as an override", () => {
  const root = crewDesk()
  const viaIdentity = status(root, { env: { DESK: root, DESK_IDENTITY: "bob-login" }, spawnGh: noGh })
  assert.equal(viaIdentity.person, "bob")
  assert.equal(viaIdentity.subtree, path.join(root, "desks", "bob"))
  assert.equal(viaIdentity.needed, true)
  assert.ok(viaIdentity.findings.every((f) => f.path.startsWith("desks/bob/")))

  const gh = []
  const viaGh = status(root, {
    spawnGh: (command, args) => {
      gh.push([command, ...args].join(" "))
      return { status: 0, stdout: "alice-login\n" }
    },
  })
  assert.deepEqual(gh, ["gh api user --jq .login"])
  assert.equal(viaGh.person, "alice")
  assert.equal(viaGh.needed, false, "alice's own desk is clean; bob's mess is bob's")

  const override = status(root, { env: { DESK: root, DESK_PERSON: "bob", DESK_IDENTITY: "alice-login" }, spawnGh: noGh })
  assert.equal(override.person, "bob")
})

test("on a crew desk where no person resolves, Detect fires so the tidy says so in one line", () => {
  const root = crewDesk()
  for (const spawnGh of [
    () => ({ status: 1, stdout: "" }),
    () => ({ status: 0, stdout: "  \n" }),
    () => ({ status: 0, stdout: "someone-else\n" }),
    () => {
      throw new Error("gh ENOENT")
    },
  ]) {
    const result = status(root, { spawnGh })
    assert.equal(result.needed, true)
    assert.equal(result.unresolved_person, true)
    assert.equal(result.applicable, false)
    assert.equal(result.subtree, null)
  }
  assert.equal(cli(["--detect"], { env: { DESK: root }, spawnGh: () => ({ status: 1, stdout: "" }) }).code, 0)
  const line = cli(["--report"], { env: { DESK: root }, spawnGh: () => ({ status: 1, stdout: "" }) })
  assert.deepEqual(line, { code: 1, stdout: "I couldn't tell which desk in this crew workspace is mine, so I left every desk as it is.\n", stderr: "" })
})

test("the gh identity is cached in Desk's state folder per desk: 24 hours when found, 1 hour when the lookup fails", () => {
  const root = crewDesk()
  const home = tempDir()
  const calls = []
  let answer = { status: 0, stdout: "Bob-Login\n" }
  const spawnGh = () => {
    calls.push(1)
    return answer
  }
  const at = (ms) => status(root, { env: { DESK: root }, homeDir: home, spawnGh, now: ms }).person
  const HOUR = 60 * 60 * 1000
  const t0 = NOW

  assert.equal(at(t0), "bob")
  const file = identityCachePath({ env: {}, homeDir: home })
  assert.equal(file, path.join(home, ".local", "state", "ouroboros-skills", "desk", "identity-cache.json"))
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { [root]: { identity: "Bob-Login", checked_at: t0 } })
  assert.equal(at(t0 + 23 * HOUR), "bob")
  assert.equal(calls.length, 1, "a found identity is reused for 24 hours")
  answer = { status: 1, stdout: "" }
  assert.equal(at(t0 + 24 * HOUR), null, "after 24 hours gh is asked again")
  assert.equal(calls.length, 2)
  assert.equal(at(t0 + 24 * HOUR + 59 * 60 * 1000), null)
  assert.equal(calls.length, 2, "a failed lookup is reused for 1 hour")
  answer = { status: 0, stdout: "alice-login\n" }
  assert.equal(at(t0 + 25 * HOUR), "alice", "after 1 hour a failed lookup is retried")
  assert.equal(calls.length, 3)
  assert.equal(at(t0 + 24 * HOUR), "alice", "an entry from the future is not trusted")
  assert.equal(calls.length, 4)

  // Keyed by desk root: another desk looks its own identity up.
  const other = crewDesk()
  status(other, { env: { DESK: other }, homeDir: home, spawnGh, now: t0 })
  assert.equal(calls.length, 5)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort(), [root, other].sort())
})

test("the identity cache honours XDG_STATE_HOME and survives a bad or unwritable cache", () => {
  const home = tempDir()
  assert.equal(identityCachePath({ env: { XDG_STATE_HOME: "~/state" }, homeDir: home }), path.join(home, "state", "ouroboros-skills", "desk", "identity-cache.json"))
  assert.match(identityCachePath({ env: {} }), /\.local\/state\/ouroboros-skills\/desk\/identity-cache\.json$/)

  const root = crewDesk()
  const state = tempDir()
  const file = identityCachePath({ env: { XDG_STATE_HOME: state }, homeDir: home })
  const spawnGh = () => ({ status: 0, stdout: "bob-login\n" })
  const person = () => status(root, { env: { DESK: root, XDG_STATE_HOME: state }, homeDir: home, spawnGh }).person
  for (const body of ["{", "[]", "null", JSON.stringify({ [root]: "bob" }), JSON.stringify({ [root]: { identity: 7, checked_at: NOW } }), JSON.stringify({ [root]: { identity: "x", checked_at: "soon" } })]) {
    write(path.dirname(file), path.basename(file), body)
    assert.equal(person(), "bob", body)
  }

  // A state folder that is a file cannot hold the cache; the lookup still works.
  const blocked = tempDir()
  write(blocked, "ouroboros-skills", "not a folder")
  assert.equal(status(root, { env: { DESK: root, XDG_STATE_HOME: blocked }, homeDir: home, spawnGh }).person, "bob")
})

test("an invalid person is treated as no person, never silently", () => {
  const root = crewDesk()
  const result = status(root, { env: { DESK: root, DESK_PERSON: "../bob" } })
  assert.equal(result.needed, true)
  assert.equal(result.unresolved_person, true)
  assert.match(result.reason, /not a valid desk name/)
})

test("the organization record lives in this session's own subtree", () => {
  const root = crewDesk()
  write(root, "_meta/organization.json", JSON.stringify(organizationRecord()))
  assert.equal(status(root, { env: { DESK: root, DESK_PERSON: "bob" } }).needed, true, "a record at the crew root is not bob's")
  write(root, `desks/bob/${ORGANIZATION_RECORD}`, JSON.stringify(organizationRecord()))
  assert.equal(status(root, { env: { DESK: root, DESK_PERSON: "bob" } }).needed, false)
})

test("a person whose desk does not exist yet is never tidied", () => {
  const root = crewDesk()
  const result = status(root, { env: { DESK: root, DESK_PERSON: "carol" } })
  assert.equal(result.needed, false)
  assert.match(result.reason, /does not exist yet/)
})

test("the registry parser reads alias and identity from the table and skips rows without an alias", () => {
  assert.deepEqual(parseDeskRegistry("# Desks\n\n| alias | identity |\n|:--|--:|\n| alex | agarcia |\n| | nobody |\n| sam |\nnot a row\n"), [
    { alias: "alex", identity: "agarcia" },
    { alias: "sam", identity: "" },
  ])
  assert.deepEqual(parseDeskRegistry("| name | login |\n|---|---|\n| a | b |\n"), [])
  assert.equal(resolvePerson(null, { env: {} }), null)
  assert.equal(resolvePerson(soloDesk(), { env: {} }), null, "a solo desk has no person and asks no one")
})

// ── Safety: in-progress Git operations and other sessions' work ─────────────────

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
    assert.equal(tidySafetyProblem(root), `the desk repository is in the middle of ${what}`)
    rmSync(path.join(gitDir, marker), { force: true })
  }
  assert.match(tidySafetyProblem(tempDir()), /not a Git repository/)
})

test("--report skips the tidy for this session with one line during a merge", () => {
  const root = soloDesk()
  write(path.join(root, ".git"), "MERGE_HEAD", "")
  assert.deepEqual(cli(["--report"], { env: { DESK: root } }), {
    code: 1,
    stdout: "I left my desk untidied for now because the desk repository is in the middle of a merge; I'll tidy it in a later session.\n",
    stderr: "",
  })
})

test("--report lists uncommitted paths, redacted, so the agent leaves those tasks alone", () => {
  const root = soloDesk()
  write(root, "billing-disputes/refund-flow-cleanup/doing.md", "in progress\n")
  write(root, ".gitignore", "ignored.log\n")
  write(root, "ignored.log", "never listed\n")
  git(root, "add", ".gitignore", "billing-disputes/track.md")
  git(root, "commit", "-q", "-m", "fixture")
  write(root, "billing-disputes/track.md", "---\ntitle: billing-disputes\nscope: changed; not payroll\n---\n")
  git(root, "mv", "billing-disputes/track.md", "billing-disputes/track-renamed.md")
  write(root, "pw-hunter2-notes.txt", "loose\n")

  const dirty = uncommittedPaths(root, root)
  assert.ok(dirty.includes("billing-disputes/track-renamed.md"), dirty.join(","))
  assert.ok(dirty.includes("billing-disputes/refund-flow-cleanup"))
  assert.ok(dirty.includes("<redacted segment>"))
  assert.ok(!dirty.some((entry) => entry.includes("ignored.log")))
  assert.ok(!dirty.some((entry) => entry.includes("track.md")), "a rename's source path is not listed twice")
  assert.ok(!JSON.stringify(dirty).includes("hunter"))

  const report = cli(["--report"], { env: { DESK: root } })
  assert.equal(report.code, 0)
  assert.match(report.stdout, new RegExp(`\\nUncommitted changes in it: ${dirty.length}\\n`))
  assert.match(report.stdout, /^ {2}billing-disputes\/refund-flow-cleanup$/m)
  assert.ok(!report.stdout.includes("hunter"))

  assert.deepEqual(uncommittedPaths(tempDir(), tempDir()), [], "outside Git there is nothing to list")
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
  assert.equal(cli(["--detect", "--root", crewDesk(), "--person", "bob"], { spawnGh: () => ({ status: 1, stdout: "" }) }).code, 0)
  assert.equal(cli(["--detect", "--root", path.join(messy, "missing")]).code, 1)
})

test("with no mode the status is printed as JSON", () => {
  const root = soloDesk()
  const result = cli([], { env: { DESK: root } })
  assert.equal(result.code, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.needed, true)
  assert.equal(parsed.subtree, root)
})

test("--report lists this session's own findings, and gives one line for a desk that can't be tidied", () => {
  const root = soloDesk()
  const result = cli(["--report", "--root", root], { env: { DESK: root } })
  assert.equal(result.code, 0)
  assert.match(result.stdout, new RegExp(`^Desk tools: ${root}\\nThis script: ${root}\\nThis session's own desk: ${root}\\nOrganization findings in it: \\d+\\n`))
  assert.match(result.stdout, /^ {2}track_catch_all: inbox — /m)

  const plain = soloDesk({ git: false })
  const refused = cli(["--report"], { env: { DESK: plain } })
  assert.deepEqual(refused, { code: 1, stdout: "I left my desk untidied: the desk is not a Git repository, so a tidy could not be undone.\n", stderr: "" })
  assert.match(cli(["--report"]).stdout, /^I left my desk untidied: no desk is bound\.\n$/)
})

test("--write-record writes the record in this session's own subtree and turns Detect off", () => {
  const root = crewDesk()
  const env = { DESK: root, DESK_PERSON: "bob" }
  const written = cli(["--write-record", "--root", root, "--person", "bob"], { env })
  assert.equal(written.code, 0)
  assert.equal(written.stdout, `${path.join("desks", "bob", "_meta", "organization.json")}\n`)
  const record = JSON.parse(readFileSync(path.join(root, "desks", "bob", ORGANIZATION_RECORD), "utf8"))
  assert.deepEqual(record, { schema_version: 1, tidy_version: 1, tidied_at: new Date(NOW).toISOString() })
  assert.equal(cli(["--detect", "--root", root, "--person", "bob"], { env }).code, 1)

  const now = Date.now()
  const solo = soloDesk()
  assert.equal(runTidyStatusCli({ argv: ["--write-record"], env: { DESK: solo }, io: io().io, homeDir: tempDir(), cwd: tempDir() }), 0)
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
  for (const key of ["DESK_ACTIVATION_CONFIG", "CODEX_HOME", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR", "DESK_PERSON", "DESK_IDENTITY"]) delete env[key]
  const report = execFileSync(process.execPath, [SCRIPT, "--report"], { encoding: "utf8", env, cwd: home })
  assert.match(report, /Organization findings in it: \d+/)
  const detect = spawnSync(process.execPath, [SCRIPT, "--detect", "--root", soloDesk({ messy: false })], { env, cwd: home })
  assert.equal(detect.status, 1)
})
