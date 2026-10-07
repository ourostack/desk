// The one-time tidy (M4-5): tidyStatus is the `02-tidy-desk` migration's
// Detect predicate — organization findings in this session's own desk
// subtree, and no `tidy_version: 1` in its `_meta/organization.json`.
//
// Every test runs against a fixture desk in a temporary folder; nothing here
// ever reads or writes a real desk.

import { test, after } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkFakeRealRoot } from "../_fake_real_root.js"
import {
  CLAIM_STALE_MS,
  HOLD_MAX_MS,
  ORGANIZATION_RECORD,
  TIDY_VERSION,
  heldReason,
  identityCachePath,
  organizationRecord,
  readOrganizationRecord,
  resolvePerson,
  runTidyStatusCli,
  takeClaim,
  tidySafetyProblem,
  tidyStatus,
  uncommittedPaths,
  writeOrganizationRecord,
  writeRecordProblem,
} from "../../../../../plugins/desk/mcp/src/desk/tidy.js"

// A path put into a regular expression: a Windows path holds backslashes.
const reEscape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
const noPosixBits = process.platform === "win32" ? "POSIX permission bits only: Windows has no execute-only directory or mode-000 file, so the read never fails" : false

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk/mcp")
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

// A single-owner hub: `_meta/desks.md` is a cross-desk routing registry, with
// its own "Solo desks" and "Crew desks" tables and no crew roster. Synthetic;
// only the shape (headings and columns) follows a real hub.
const HUB_REGISTRY = [
  "# Desks — this operator's desk registry",
  "",
  "## Solo desks (you own the whole desk)",
  "",
  "| desk | local path | repo | account | launch |",
  "|---|---|---|---|---|",
  "| work-desk | ~/work-desk | example-org/work-desk | example-login | desk-work |",
  "| home-desk | ~/home-desk | example/home-desk | example-home | desk-home |",
  "",
  "## Crew desks (shared; you write only your own desk)",
  "",
  "| crew | local path | repo | your alias | launch |",
  "|---|---|---|---|---|",
  "| example-crew | ~/crews/example | example-org/crew-workspace | alex | crew-example |",
  "",
  "## Notes",
  "",
  "Routing context only.",
  "",
].join("\n")

// A spoke desk: `_meta/desks.md` only points at its hub, with no table at all.
const SPOKE_POINTER = "# Desks — registry pointer (spoke desk)\n\nThe registry for this operator's desks lives in the hub desk.\n"

function registryDesk(registry, { messy = true } = {}) {
  const root = tempDir()
  write(root, "_meta/desks.md", registry)
  mkdirSync(path.join(root, "_archive"), { recursive: true })
  cleanTrack(root)
  if (messy) messyTrack(root)
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

// Background identity lookups Detect started, as [command, ...args]; none runs.
const backgrounds = []
const background = (command, args) => {
  backgrounds.push([command, ...args])
  return { unref() {} }
}

function cli(argv, extra = {}) {
  const captured = io()
  const code = runTidyStatusCli({ argv, env: {}, io: captured.io, homeDir: tempDir(), cwd: tempDir(), now: NOW, spawnBackground: background, ...extra })
  return { code, ...captured.out }
}

const claimOf = (report) => /^Tidy claim: (\S+) /mu.exec(report.stdout)[1]

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
  assert.equal(disagree.mismatch, "root")
  assert.equal(disagree.root, root, "the tools' desk is the one described")
  assert.deepEqual(disagree.resolved, { root: elsewhere, person: null })
  assert.equal(disagree.needed, true)

  const unresolved = tidyStatus({ root, env: {}, homeDir: tempDir(), cwd: tempDir(), now: NOW })
  assert.equal(unresolved.mismatch, "root", "a desk the script cannot find at all is a mismatch too")

  const missing = tidyStatus({ root: path.join(root, "gone"), env: { DESK: root }, homeDir: tempDir(), cwd: tempDir(), now: NOW })
  assert.equal(missing.mismatch, "root", "a tools' root that no longer exists never matches")
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

  const noIdentity = cli(["--report", "--root", root, "--person", "alice"], { env: { DESK: root }, spawnGh: () => ({ status: 1, stdout: "" }) })
  assert.deepEqual(noIdentity, {
    code: 1,
    stdout: "I left my desk untidied: the Desk tools name alice as this session's person, but I couldn't resolve this session's identity to a person in the crew registry.\n",
    stderr: "",
  })
  assert.equal(tidyStatus({ root, person: "alice", env: { DESK: root, DESK_IDENTITY: "nobody" }, homeDir: tempDir(), cwd: tempDir() }).mismatch, "person")

  const none = cli(["--write-record", "--root", root], { env: {}, spawnGh: noGh })
  assert.equal(none.code, 1)
  assert.match(none.stdout, /^I couldn't tell which desk in this crew workspace is mine/)

  const agree = cli(["--report", "--root", root, "--person", "bob"], { env: { DESK: root, DESK_PERSON: "bob" } })
  assert.equal(agree.code, 0)
  assert.match(agree.stdout, new RegExp(`^Desk tools: ${reEscape(root)} as bob\\nThis script: ${reEscape(root)} as bob\\nThis session's own desk: ${reEscape(path.join(root, "desks", "bob"))}\\n`))
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
  // Detect never waits on gh: a cold cache starts the lookup in the background, and Detect fires once the cache has the answer.
  const homeDir = tempDir()
  backgrounds.length = 0
  assert.deepEqual(cli(["--detect"], { env: { DESK: root }, homeDir, spawnGh: noGh }), { code: 1, stdout: "", stderr: "" })
  assert.deepEqual(backgrounds, [[process.execPath, SCRIPT, "--refresh-identity", "--root", root]])
  assert.equal(cli(["--refresh-identity", "--root", root], { homeDir, spawnGh: () => ({ status: 1, stdout: "" }) }).code, 0)
  assert.equal(cli(["--detect"], { env: { DESK: root }, homeDir, spawnGh: noGh }).code, 0)
  const line = cli(["--report"], { env: { DESK: root }, spawnGh: () => ({ status: 1, stdout: "" }) })
  assert.deepEqual(line, { code: 1, stdout: "I couldn't tell which desk in this crew workspace is mine, so I left every desk as it is.\n", stderr: "" })
})

// ── Hubs and spokes: a `_meta/desks.md` that is not a crew roster ───────────

test("a single-owner hub whose desks.md is a routing registry is tidied at its root, with no person", () => {
  for (const registry of [HUB_REGISTRY, SPOKE_POINTER]) {
    const root = registryDesk(registry)
    const result = status(root, { spawnGh: noGh })
    assert.equal(result.unresolved_person, false)
    assert.equal(result.person, null)
    assert.equal(result.resolved.person, null)
    assert.equal(result.subtree, root)
    assert.equal(result.applicable, true)
    assert.equal(result.needed, true)
    assert.equal(result.reason, "tidy needed")
    assert.deepEqual(
      [...new Set(result.findings.map((f) => f.code))].sort(),
      ["loose_file", "name_prompt_like", "track_catch_all", "track_missing_scope"],
      "the hub's own messy track is found; none of its registry's names count as a person",
    )

    // The Desk tools bind a hub with no person (OFF mode): they agree with the script.
    const bound = tidyStatus({ root, env: { DESK: root }, homeDir: tempDir(), cwd: tempDir(), now: NOW, spawnGh: noGh })
    assert.equal(bound.mismatch, false)
    assert.equal(bound.subtree, root)

    assert.equal(cli(["--detect", "--root", root], { env: { DESK: root }, spawnGh: noGh }).code, 0)
    const report = cli(["--report", "--root", root], { env: { DESK: root }, spawnGh: noGh })
    assert.equal(report.code, 0)
    assert.match(report.stdout, new RegExp(`^Desk tools: ${reEscape(root)}\\nThis script: ${reEscape(root)}\\nThis session's own desk: ${reEscape(root)}\\n`))
    assert.doesNotMatch(report.stdout, /crew workspace/)

    const clean = registryDesk(registry, { messy: false })
    assert.equal(status(clean, { spawnGh: noGh }).needed, false, "a clean hub needs no tidy")
  }
})

// A live spoke desk's `_meta/desks.md`, verbatim (M4-7): a prose pointer to its hub with a quoted path and no table.
// On alpha.86 the tidy treated any desks.md as a crew roster, stopped with "I couldn't tell which desk in this crew
// workspace is mine" and fired again at every session start.
const LIVE_SPOKE_POINTER = [
  "# Desks — registry pointer (spoke desk)",
  "",
  "The canonical multi-desk registry — the operator's full desk list, paths/repos, and",
  "which `worker` launches each — lives once in the **hub** (`work-default`) desk:",
  "",
  "> **Canonical registry → `~/ms-desk/_meta/desks.md`**",
  "",
  "This is a *spoke* desk. If `~/ms-desk` is cloned on this machine and a question belongs",
  "to the work desk (e.g. \"what's my work status?\"), read the canonical file there. If the",
  "hub isn't present, this desk runs single-desk — correct, since there's no sibling here",
  "to route to.",
  "",
  "No table is mirrored here on purpose: one source of truth can't drift, and it keeps",
  "work/crew repo identifiers off the personal account. Add or relabel desks from the hub",
  "(the `register-desk` flow) — never hand-edit a second copy.",
  "",
].join("\n")

test("a live spoke's prose pointer in desks.md is a single desk: the tidy runs at its root and stops re-firing once recorded", () => {
  const root = registryDesk(LIVE_SPOKE_POINTER)
  const result = status(root, { spawnGh: noGh })
  assert.equal(result.unresolved_person, false)
  assert.equal(result.subtree, root)
  assert.equal(result.needed, true)
  const report = cli(["--report", "--root", root], { env: { DESK: root }, spawnGh: noGh })
  assert.equal(report.code, 0)
  assert.doesNotMatch(report.stdout, /crew workspace/)
  git(root, "add", "-A") // stand in for the tidy's own staged work — this test is about desk resolution, not step 7.
  assert.equal(cli(["--write-record", "--root", root, "--claim", claimOf(report)], { env: { DESK: root }, spawnGh: noGh }).code, 0)
  assert.equal(cli(["--detect", "--root", root], { env: { DESK: root }, spawnGh: noGh }).code, 1, "once tidied, Detect stops firing")
})

test("an empty desks.md, or one with only a heading or an empty table, is a single desk too", () => {
  for (const registry of ["", "# Desks\n", "| alias | identity |\n|---|---|\n"]) {
    const root = registryDesk(registry)
    const result = status(root, { spawnGh: noGh })
    assert.equal(result.unresolved_person, false, JSON.stringify(registry))
    assert.equal(result.subtree, root, JSON.stringify(registry))
    assert.equal(result.needed, true, JSON.stringify(registry))
  }
})

test("a desks.md the tidy cannot read, or an alias-only roster beside desks/, stops the tidy instead of tidying the crew root", () => {
  const unreadable = registryDesk(HUB_REGISTRY)
  rmSync(path.join(unreadable, "_meta", "desks.md"))
  mkdirSync(path.join(unreadable, "_meta", "desks.md"))
  const aliasOnly = registryDesk("| alias | path |\n|---|---|\n| alice | desks/alice |\n")
  cleanTrack(aliasOnly, "desks/alice/")
  for (const root of [unreadable, aliasOnly]) {
    const result = status(root, { spawnGh: noGh })
    assert.equal(result.unresolved_person, true)
    assert.equal(result.needed, true)
    assert.equal(result.applicable, false)
  }
})

test("the crew roster, not the file, makes a crew desk: a roster after a hub-style table still counts", () => {
  const root = registryDesk(`${HUB_REGISTRY}\n## Crew roster\n\n| path | identity | alias |\n|---|---|---|\n| desks/bob | bob-login | bob |\n`)
  const unresolved = status(root, { spawnGh: () => ({ status: 1, stdout: "" }) })
  assert.equal(unresolved.unresolved_person, true)
  const bob = status(root, { env: { DESK: root, DESK_IDENTITY: "BOB-LOGIN" }, spawnGh: noGh })
  assert.equal(bob.person, "bob")
  assert.equal(bob.subtree, path.join(root, "desks", "bob"))
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
  assert.match(identityCachePath({ env: {} }), /\.local[\\/]state[\\/]ouroboros-skills[\\/]desk[\\/]identity-cache\.json$/)

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

test("under a node:test run, a real (non-temp) identity cache folder is refused -- the gh lookup still answers, but nothing is persisted", () => {
  // A folder that genuinely exists and is genuinely writable, but sits outside the OS temp directory: stands in for
  // the developer's real home, so a cache write landing here would be exactly the incident the guard exists to stop.
  const fakeReal = realpathSync(mkFakeRealRoot("desk-tidy-fake-real-"))
  try {
    const root = crewDesk()
    const spawnGh = () => ({ status: 0, stdout: "Bob-Login\n" })
    const person = resolvePerson(root, { env: {}, homeDir: fakeReal, spawnGh, now: NOW })
    assert.equal(person, "bob", "the lookup itself still answers")
    assert.equal(existsSync(path.join(fakeReal, ".local")), false, "the guard refuses before creating anything under the fake real home")
  } finally {
    rmSync(fakeReal, { recursive: true, force: true })
  }
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

test("a person resolves from the registry, a hub or solo desk has none, and a given roster is used as is", () => {
  assert.equal(resolvePerson(null, { env: {} }), null)
  assert.equal(resolvePerson(soloDesk(), { env: {} }), null, "a solo desk has no person and asks no one")
  assert.equal(resolvePerson(registryDesk(HUB_REGISTRY), { env: {}, spawnGh: noGh }), null, "a hub has no person and asks no one")
  const roster = [{ alias: "", identity: "someone" }, { alias: "cam", identity: "cam-login" }]
  assert.equal(resolvePerson(soloDesk(), { env: { DESK_IDENTITY: "cam-login" }, roster, spawnGh: noGh }), "cam", "an already parsed roster is used as given")
  assert.equal(resolvePerson(crewDesk(), { env: { DESK_IDENTITY: "bob-login" }, roster: null, spawnGh: noGh }), null, "a roster the caller found missing is not read again")
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
  assert.equal(cli(["--detect", "--root", crewDesk(), "--person", "bob"], { env: { DESK_IDENTITY: "nobody" } }).code, 0)
  assert.equal(cli(["--detect", "--root", path.join(messy, "missing")]).code, 1)
})

test("tidyStatus finds the desk from the process's own folder and home when none is given", () => {
  const root = soloDesk()
  assert.equal(tidyStatus({ env: { DESK: root } }).subtree, root)
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
  assert.match(result.stdout, new RegExp(`^Desk tools: ${reEscape(root)}\\nThis script: ${reEscape(root)}\\nThis session's own desk: ${reEscape(root)}\\nOrganization findings in it: \\d+\\n`))
  assert.match(result.stdout, /^ {2}track_catch_all: inbox \(handle track-[0-9a-f]{10}\) — .*rename with track_rename \(handle, to\)/m)
  assert.match(result.stdout, /^ {2}name_prompt_like: inbox\/hi-please-fix-this \(handle task-[0-9a-f]{10}\) — .*rename with task_move \(handle, to_slug\)/m)
  assert.match(result.stdout, /^ {2}loose_file: scratch-notes.txt — /m, "a loose entry has no handle")

  const plain = soloDesk({ git: false })
  const refused = cli(["--report"], { env: { DESK: plain } })
  assert.deepEqual(refused, { code: 1, stdout: "I left my desk untidied: the desk is not a Git repository, so a tidy could not be undone.\n", stderr: "" })
  assert.match(cli(["--report"]).stdout, /^I left my desk untidied: no desk is bound\.\n$/)
})

test("--write-record writes the record in this session's own subtree and turns Detect off", () => {
  const root = crewDesk()
  const env = { DESK: root, DESK_PERSON: "bob" }
  git(root, "add", "-A") // stand in for the tidy's own staged work — this test is about the record, not step 7.
  const written = cli(["--write-record", "--root", root, "--person", "bob"], { env })
  assert.equal(written.code, 0)
  assert.equal(written.stdout, `${path.join("desks", "bob", "_meta", "organization.json")}\n`)
  const record = JSON.parse(readFileSync(path.join(root, "desks", "bob", ORGANIZATION_RECORD), "utf8"))
  assert.deepEqual(record, { schema_version: 1, tidy_version: 1, tidied_at: new Date(NOW).toISOString() })
  assert.equal(cli(["--detect", "--root", root, "--person", "bob"], { env }).code, 1)

  const now = Date.now()
  const solo = soloDesk()
  git(solo, "add", "-A")
  assert.equal(runTidyStatusCli({ argv: ["--write-record"], env: { DESK: solo }, io: io().io, homeDir: tempDir(), cwd: tempDir() }), 0)
  assert.ok(Date.parse(readOrganizationRecord(solo).tidied_at) >= now - 1000)
})

// ── The --write-record gate: step 7's own checks, enforced in code ────────
//
// Fix round, 2026-09-28: a session that skipped step 7 (or read it and
// skipped running it) used to get the record written anyway, with the same
// exit code and shape as a real, checked tidy. `--write-record` now runs the
// same checks step 7 tells the agent to run — nothing left unstaged or
// untracked under anything this run touched, something actually staged, and
// no track this run's own staged renames moved a folder into whose task
// cards still name a different track (or none at all) — and refuses
// otherwise.
//
// Review fix round, 2026-09-28b: the clean-tree check is scoped to the top-
// level entries this run staged something under, not this session's whole
// desk, so an untouched track's own mess never blocks a correct tidy. The
// bypass check is keyed off Git's own rename detection, not "any staged path
// under a track", so a track with pre-existing bad `track:` data is never a
// candidate unless this run staged a rename of its folder, and every card
// under a candidate is checked recursively, `_archive/` included.

test("--write-record refuses when nothing at all is staged", () => {
  const root = tempDir()
  cleanTrack(root)
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  const refused = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(refused.code, 1)
  assert.match(refused.stdout, /nothing is staged/)
  assert.equal(readOrganizationRecord(root), null)
})

test("--write-record refuses when a track this run touched still has an unstaged change", () => {
  const root = tempDir()
  cleanTrack(root)
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  write(root, "billing-disputes/track.md", "---\ntitle: billing-disputes\nscope: a freshly tidied scope; not anything else\n---\n")
  git(root, "add", "billing-disputes/track.md")
  // Left over in the same track this run staged something under.
  write(
    root,
    "billing-disputes/refund-flow-cleanup/task.md",
    `---\ntitle: refund-flow-cleanup\nstatus: processing\nupdated: '${RECENT}'\nextra: unstaged\n---\n`,
  )
  const refused = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(refused.code, 1)
  assert.match(refused.stdout, /step 7/)
  assert.equal(readOrganizationRecord(root), null)
})

test("--write-record refuses when a track this run touched still has an untracked file", () => {
  const root = tempDir()
  cleanTrack(root)
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  write(root, "billing-disputes/track.md", "---\ntitle: billing-disputes\nscope: a freshly tidied scope; not anything else\n---\n")
  git(root, "add", "billing-disputes/track.md")
  write(root, "billing-disputes/_planning/notes.md", "stray notes\n")
  const refused = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(refused.code, 1)
  assert.match(refused.stdout, /step 7/)
  assert.equal(readOrganizationRecord(root), null)
})

// Review fix round, 2026-09-28b (finding 1): the clean-tree check used to
// scan this session's entire desk subtree, so an untouched track's own
// dirty or untracked file — exactly what step 7 says to leave alone —
// refused an otherwise correct, fully staged tidy elsewhere.
test("--write-record succeeds when an unrelated, untouched track has an unstaged and an untracked file", () => {
  const root = tempDir()
  cleanTrack(root)
  write(root, "unrelated-track/track.md", "---\ntitle: unrelated-track\nscope: work this run never touches; not anything else\n---\n")
  write(
    root,
    "unrelated-track/some-task/task.md",
    `---\ntitle: some-task\nstatus: processing\nupdated: '${RECENT}'\ntrack: unrelated-track\n---\n`,
  )
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  // Someone else's mess, in a track this run never stages anything under.
  write(
    root,
    "unrelated-track/some-task/task.md",
    `---\ntitle: some-task\nstatus: processing\nupdated: '${RECENT}'\ntrack: unrelated-track\nextra: someone else's edit\n---\n`,
  )
  write(root, "unrelated-track/_planning/stray-notes.md", "someone else's stray notes\n")
  write(root, "billing-disputes/track.md", "---\ntitle: billing-disputes\nscope: a freshly tidied scope; not anything else\n---\n")
  git(root, "add", "billing-disputes/track.md")
  const written = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(written.code, 0)
  assert.ok(readOrganizationRecord(root) !== null)
})

test("--write-record succeeds once everything the tidy changed under the touched track is staged and nothing is left over", () => {
  const root = tempDir()
  cleanTrack(root)
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  write(root, "billing-disputes/track.md", "---\ntitle: billing-disputes\nscope: a freshly tidied scope; not anything else\n---\n")
  git(root, "add", "billing-disputes/track.md")
  const written = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(written.code, 0)
  assert.ok(readOrganizationRecord(root) !== null)
})

test("--write-record refuses a track folder moved by a raw git mv instead of track_rename", () => {
  const root = tempDir()
  cleanTrack(root)
  write(
    root,
    "billing-disputes/refund-flow-cleanup/task.md",
    `---\ntitle: refund-flow-cleanup\nstatus: processing\nupdated: '${RECENT}'\ntrack: billing-disputes\n---\n`,
  )
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  // track_rename would rewrite `track:` on every card it moves; a raw `git
  // mv` of the folder carries the old value forward unchanged.
  git(root, "mv", "billing-disputes", "billing-issues")
  const refused = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(refused.code, 1)
  assert.match(refused.stdout, /track_rename/)
  assert.equal(readOrganizationRecord(root), null)
})

// Review fix round, 2026-09-28b (finding 2): the bypass check used to walk
// only a track's direct, non-underscore children, so a raw `git mv` of a
// track whose only work is already archived went undetected.
test("--write-record refuses a raw git mv whose only card sits under _archive", () => {
  const root = tempDir()
  write(root, "old-track/track.md", "---\ntitle: old-track\nscope: an outcome with only archived work left; not anything else\n---\n")
  write(
    root,
    "old-track/_archive/done-long-ago/task.md",
    `---\ntitle: done-long-ago\nstatus: done\ncreated: '${RECENT}'\nupdated: '${RECENT}'\ntrack: old-track\n---\n`,
  )
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  git(root, "mv", "old-track", "new-track")
  const refused = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(refused.code, 1)
  assert.match(refused.stdout, /track_rename/)
  assert.equal(readOrganizationRecord(root), null)
})

// Review fix round, 2026-09-28b (finding 3): a card with no `track:` field
// at all used to count as no evidence of a mismatch, but `track_rename`
// writes that field unconditionally on every card it finds, so its absence
// after a purported rename is exactly as telling as a wrong value.
test("--write-record refuses a raw git mv whose card has no track: field, since track_rename would have written one", () => {
  const root = tempDir()
  write(root, "old-track/track.md", "---\ntitle: old-track\nscope: an outcome track_rename never touched; not anything else\n---\n")
  write(root, "old-track/some-task/task.md", `---\ntitle: some-task\nstatus: processing\nupdated: '${RECENT}'\n---\n`)
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  git(root, "mv", "old-track", "new-track")
  const refused = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(refused.code, 1)
  assert.match(refused.stdout, /track_rename/)
  assert.equal(readOrganizationRecord(root), null)
})

test("--write-record does not flag a genuinely renamed track whose task cards already name it correctly", () => {
  const root = tempDir()
  cleanTrack(root)
  write(
    root,
    "billing-disputes/refund-flow-cleanup/task.md",
    `---\ntitle: refund-flow-cleanup\nstatus: processing\nupdated: '${RECENT}'\ntrack: billing-disputes\n---\n`,
  )
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  // What a genuine track_rename leaves behind: the folder moved, and every
  // card's track: field rewritten to the new name.
  git(root, "mv", "billing-disputes", "billing-issues")
  write(
    root,
    "billing-issues/refund-flow-cleanup/task.md",
    `---\ntitle: refund-flow-cleanup\nstatus: processing\nupdated: '${RECENT}'\ntrack: billing-issues\n---\n`,
  )
  git(root, "add", "billing-issues/refund-flow-cleanup/task.md")
  const written = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(written.code, 0)
  assert.ok(readOrganizationRecord(root) !== null)
})

// Review fix round, 2026-09-28b (finding 2, false positive): a track this
// run never staged a rename of is never a candidate, so pre-existing bad
// `track:` data sitting elsewhere never blocks a scope-line-only change.
test("--write-record does not scan a track for a bypass unless this run staged a rename of its folder", () => {
  const root = tempDir()
  write(root, "billing-disputes/track.md", "---\ntitle: billing-disputes\nscope: billing disputes; not payroll\n---\n")
  write(
    root,
    "billing-disputes/refund-flow-cleanup/task.md",
    `---\ntitle: refund-flow-cleanup\nstatus: processing\nupdated: '${RECENT}'\ntrack: some-other-track\n---\n`,
  )
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  write(root, "billing-disputes/track.md", "---\ntitle: billing-disputes\nscope: a freshly tidied scope; not anything else\n---\n")
  git(root, "add", "billing-disputes/track.md")
  const written = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(written.code, 0)
  assert.ok(readOrganizationRecord(root) !== null)
})

// Review fix round, 2026-09-28b (finding 4): the procedure's own step 5 and
// step 6 file an emptied or stale track into _archive/ with a raw git mv,
// since no track-archive tool exists yet — the one raw move the detector
// must never flag.
test("--write-record allows the procedure's own raw git mv of a track into _archive", () => {
  const root = tempDir()
  write(root, "stale-track/track.md", "---\ntitle: stale-track\nscope: an outcome with nothing left to do; not anything else\n---\n")
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  mkdirSync(path.join(root, "_archive"), { recursive: true })
  git(root, "mv", "stale-track", "_archive")
  const written = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(written.code, 0)
  assert.ok(readOrganizationRecord(root) !== null)
})

test("--write-record cannot list a candidate track's directory and finds no card to compare, so it does not flag it", { skip: noPosixBits }, () => {
  const root = tempDir()
  write(root, "old-track/track.md", "---\ntitle: old-track\nscope: an outcome whose directory listing will be blocked; not anything else\n---\n")
  write(
    root,
    "old-track/some-task/task.md",
    `---\ntitle: some-task\nstatus: processing\nupdated: '${RECENT}'\ntrack: old-track\n---\n`,
  )
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  git(root, "mv", "old-track", "new-track")
  const trackDir = path.join(root, "new-track")
  // Execute-only: track.md can still be found by its known name, but the
  // directory's own entries can't be listed — the same failure mode a racing
  // delete or a restrictive filesystem could produce, and the bypass check
  // must not crash on it.
  chmodSync(trackDir, 0o111)
  try {
    const written = cli(["--write-record"], { env: { DESK: root } })
    assert.equal(written.code, 0)
  } finally {
    chmodSync(trackDir, 0o755)
  }
})

test("--write-record refuses when a candidate track's task card can't be read, since it can't be confirmed to match", { skip: noPosixBits }, () => {
  const root = tempDir()
  // Ignored, not merely untracked: an untracked task.md would itself trip
  // the step 7 clean-tree check before the bypass check ever runs. Ignoring
  // it keeps Git out of the picture entirely, so only the bypass check's own
  // direct filesystem read sees the unreadable file.
  write(root, ".gitignore", "**/some-task/task.md\n")
  write(root, "old-track/track.md", "---\ntitle: old-track\nscope: an outcome with a card write-record can't read; not anything else\n---\n")
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  git(root, "mv", "old-track", "new-track")
  write(
    root,
    "new-track/some-task/task.md",
    `---\ntitle: some-task\nstatus: processing\nupdated: '${RECENT}'\ntrack: new-track\n---\n`,
  )
  const taskMd = path.join(root, "new-track", "some-task", "task.md")
  chmodSync(taskMd, 0o000)
  try {
    const refused = cli(["--write-record"], { env: { DESK: root } })
    assert.equal(refused.code, 1)
    assert.match(refused.stdout, /track_rename/)
    assert.equal(readOrganizationRecord(root), null)
  } finally {
    chmodSync(taskMd, 0o644)
  }
})

// Review fix round, 2026-09-28b (finding 1, Git-failure branch): when Git
// itself can't report what's staged, that's no different from nothing being
// staged — there is nothing left to record.
test("writeRecordProblem treats a failed git diff for staged paths as nothing staged", () => {
  const root = tempDir()
  cleanTrack(root)
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  write(root, "billing-disputes/track.md", "---\ntitle: billing-disputes\nscope: a freshly tidied scope; not anything else\n---\n")
  git(root, "add", "billing-disputes/track.md")
  const spawnGit = (command, args, opts) => {
    if (args.includes("--name-only")) throw new Error("simulated git failure")
    return spawnSync(command, args, opts)
  }
  assert.match(writeRecordProblem(root, root, { spawnGit }), /nothing is staged/)
})

// Review fix round, 2026-09-28b (finding 2+3, Git-failure branch): when
// Git's own rename detection can't run, that's no evidence of a bypass —
// the run is not blocked over a check that could not be made.
test("writeRecordProblem treats a failed git rename-detection as no bypass found", () => {
  const root = tempDir()
  write(root, "old-track/track.md", "---\ntitle: old-track\nscope: an outcome git's own rename detection can't be reached for; not anything else\n---\n")
  write(root, "old-track/some-task/task.md", `---\ntitle: some-task\nstatus: processing\nupdated: '${RECENT}'\ntrack: old-track\n---\n`)
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  git(root, "mv", "old-track", "new-track")
  write(root, "new-track/some-task/task.md", `---\ntitle: some-task\nstatus: processing\nupdated: '${RECENT}'\ntrack: new-track\n---\n`)
  git(root, "add", "-A")
  const spawnGit = (command, args, opts) => {
    if (args.includes("--name-status")) throw new Error("simulated git failure")
    return spawnSync(command, args, opts)
  }
  assert.equal(writeRecordProblem(root, root, { spawnGit }), null)
})

// Review fix round, 2026-09-28b (finding 2+3): a renamed top-level entry
// that isn't a track at all — a loose file filed by hand, say — is never a
// track-rename candidate, since it never has a track.md to hold a card.
test("--write-record does not treat a renamed loose top-level file as a track-rename candidate", () => {
  const root = tempDir()
  cleanTrack(root)
  write(root, "notes.txt", "stray top-level notes\n")
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  git(root, "mv", "notes.txt", "notes-renamed.txt")
  const written = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(written.code, 0)
  assert.ok(readOrganizationRecord(root) !== null)
})

test("writeRecordProblem defaults to the real git binary when no spawnGit is given", () => {
  const root = tempDir()
  cleanTrack(root)
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  write(root, "billing-disputes/track.md", "---\ntitle: billing-disputes\nscope: a freshly tidied scope; not anything else\n---\n")
  git(root, "add", "billing-disputes/track.md")
  assert.equal(writeRecordProblem(root, root), null)
})

// Review fix round, 2026-09-28b (finding 2+3): the refusal names every
// mismatched track and switches to plural phrasing once more than one turns up.
test("--write-record's bypass refusal uses plural phrasing for more than one mismatched track", () => {
  const root = tempDir()
  write(root, "old-track-a/track.md", "---\ntitle: old-track-a\nscope: first outcome moved by a raw git mv; not anything else\n---\n")
  write(root, "old-track-a/some-task/task.md", `---\ntitle: some-task\nstatus: processing\nupdated: '${RECENT}'\ntrack: old-track-a\n---\n`)
  write(root, "old-track-b/track.md", "---\ntitle: old-track-b\nscope: second outcome moved by a raw git mv; not anything else\n---\n")
  write(root, "old-track-b/some-task/task.md", `---\ntitle: some-task\nstatus: processing\nupdated: '${RECENT}'\ntrack: old-track-b\n---\n`)
  initGit(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "initial")
  git(root, "mv", "old-track-a", "new-track-a")
  git(root, "mv", "old-track-b", "new-track-b")
  const refused = cli(["--write-record"], { env: { DESK: root } })
  assert.equal(refused.code, 1)
  assert.match(refused.stdout, /new-track-a, new-track-b have a task card/)
  assert.equal(readOrganizationRecord(root), null)
})

// ── One tidy at a time, and no repeated instruction when it cannot finish ──

const iso = (ms) => new Date(ms).toISOString()
// Every claim-related file in a Git folder, and one claim generation's content.
const claimFiles = (gitDir) => readdirSync(gitDir).filter((name) => name.startsWith("desk-tidy-claim")).sort()
const claimIn = (gitDir, generation) => JSON.parse(readFileSync(path.join(gitDir, `desk-tidy-claim.${generation}.json`), "utf8"))

test("only one session tidies a desk at a time: the claim holds off a second report, Detect, the record and a deferral until it goes stale", () => {
  const root = soloDesk()
  const env = { DESK: root }
  const first = cli(["--report"], { env })
  assert.equal(first.code, 0)
  const token = claimOf(first)
  assert.match(first.stdout, new RegExp(`\\nTidy claim: ${token} \\(this session's until ${iso(NOW + CLAIM_STALE_MS)};`))

  const later = NOW + 60_000
  assert.deepEqual(cli(["--report"], { env, now: later }), {
    code: 1,
    stdout: `Another session has been tidying this desk since ${iso(NOW)}, so I left the tidy to it. If that session is this one, carry on with the steps it printed.\n`,
    stderr: "",
  })
  assert.deepEqual(cli(["--detect"], { env, now: later }), { code: 1, stdout: `held: another session has been tidying this desk since ${iso(NOW)}\n`, stderr: "" })
  const refused = `Another session has been tidying this desk since ${iso(NOW)}, so I changed nothing.\n`
  assert.deepEqual(cli(["--write-record"], { env, now: later }), { code: 1, stdout: refused, stderr: "" })
  assert.deepEqual(cli(["--defer", "busy", "--claim", "not-the-token"], { env, now: later }), { code: 1, stdout: refused, stderr: "" })
  assert.equal(readOrganizationRecord(root), null)

  // An abandoned claim goes stale, and the next session takes it over.
  const stale = NOW + CLAIM_STALE_MS
  assert.equal(cli(["--detect"], { env, now: stale }).code, 0)
  const second = cli(["--report"], { env, now: stale })
  assert.equal(second.code, 0)
  assert.notEqual(claimOf(second), token)
  git(root, "add", "-A") // stand in for the tidy's own staged work — this test is about claim rotation, not step 7.
  assert.equal(cli(["--write-record", "--claim", claimOf(second)], { env, now: stale }).code, 0)
  const gitDir = path.join(root, ".git")
  assert.deepEqual(claimFiles(gitDir), ["desk-tidy-claim.2.json"], "the takeover is the next generation, and the older one is pruned")
  assert.deepEqual(claimIn(gitDir, 2), { token: claimOf(second), claimed_at: 0 }, "the record releases the claim")
  assert.equal(cli(["--detect"], { env, now: stale }).code, 1)
})

test("releasing leaves another session's claim alone, and replaces an unreadable one", () => {
  const root = soloDesk()
  const gitDir = path.join(root, ".git")
  const env = { DESK: root }
  // Nothing to release when no session ever claimed the desk.
  assert.equal(cli(["--defer", "nothing claimed"], { env }).code, 0)
  assert.deepEqual(claimFiles(gitDir), [])
  // A stale claim of another session's stays as it is.
  writeFileSync(path.join(gitDir, "desk-tidy-claim.4.json"), JSON.stringify({ token: "theirs", claimed_at: NOW - CLAIM_STALE_MS }))
  assert.equal(cli(["--defer", "still stale", "--claim", "mine"], { env }).code, 0)
  assert.deepEqual(claimIn(gitDir, 4), { token: "theirs", claimed_at: NOW - CLAIM_STALE_MS })
  // An unreadable current claim counts as nobody's, and releasing replaces it.
  writeFileSync(path.join(gitDir, "desk-tidy-claim.5.json"), "{")
  git(root, "add", "-A") // stand in for the tidy's own staged work — this test is about claim release, not step 7.
  assert.equal(cli(["--write-record"], { env }).code, 0)
  assert.deepEqual(claimIn(gitDir, 5), { claimed_at: 0 })
})

test("a claim is exclusive: an unreadable claim is taken over, a racing session that links first wins, and no temporary file is left", () => {
  const gitDir = tempDir()
  writeFileSync(path.join(gitDir, "desk-tidy-claim.3.json"), "not json")
  assert.deepEqual(takeClaim(gitDir, { now: NOW, token: "mine" }), { token: "mine" })
  assert.deepEqual(claimFiles(gitDir), ["desk-tidy-claim.4.json"])
  assert.deepEqual(claimIn(gitDir, 4), { token: "mine", claimed_at: NOW })
  assert.deepEqual(takeClaim(gitDir, { now: NOW + 1 }), { held: { token: "mine", claimed_at: NOW } })
  assert.deepEqual(takeClaim(path.join(gitDir, "missing"), { now: NOW }), { held: { claimed_at: NOW } })
  const fresh = tempDir()
  assert.match(takeClaim(fresh, { now: NOW }).token, /^[0-9a-f-]{36}$/u)
  assert.deepEqual(claimFiles(fresh), ["desk-tidy-claim.1.json"])

  // Two sessions see the same stale claim and race for the next generation:
  // the one that links first holds it, and the other's link fails.
  const racer = { token: "racer", claimed_at: NOW }
  const stale = tempDir()
  writeFileSync(path.join(stale, "desk-tidy-claim.1.json"), JSON.stringify({ token: "gone", claimed_at: NOW - CLAIM_STALE_MS }))
  const linkedFirst = (from, to) => {
    writeFileSync(to, JSON.stringify(racer))
    linkSync(from, to)
  }
  assert.deepEqual(takeClaim(stale, { now: NOW, token: "mine", link: linkedFirst }), { held: racer })
  assert.deepEqual(claimFiles(stale), ["desk-tidy-claim.1.json", "desk-tidy-claim.2.json"])
  assert.deepEqual(claimIn(stale, 2), racer)

  // A session that started from an older view links a newer generation
  // before this one checks: this one withdraws its claim.
  const behind = tempDir()
  const overtaken = (from, to) => {
    linkSync(from, to)
    writeFileSync(path.join(behind, "desk-tidy-claim.2.json"), JSON.stringify(racer))
  }
  assert.deepEqual(takeClaim(behind, { now: NOW, token: "mine", link: overtaken }), { held: racer })
  assert.deepEqual(claimFiles(behind), ["desk-tidy-claim.2.json"])
  // A newer generation that is unreadable still wins.
  const unreadable = tempDir()
  const overtakenBadly = (from, to) => {
    linkSync(from, to)
    writeFileSync(path.join(unreadable, "desk-tidy-claim.2.json"), "{")
  }
  assert.deepEqual(takeClaim(unreadable, { now: NOW, token: "mine", link: overtakenBadly }), { held: { claimed_at: NOW } })
})

test("many sessions taking the claim at once: exactly one holds it", async () => {
  const gitDir = tempDir()
  writeFileSync(path.join(gitDir, "desk-tidy-claim.7.json"), JSON.stringify({ token: "crashed", claimed_at: NOW - CLAIM_STALE_MS }))
  const url = new URL("../../../../../plugins/desk/mcp/src/desk/tidy.js", import.meta.url).href
  const script = `import { takeClaim } from ${JSON.stringify(url)}; process.stdout.write(JSON.stringify(takeClaim(${JSON.stringify(gitDir)}, { now: ${NOW} })))`
  const runs = Array.from({ length: 12 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] })
    let out = ""
    child.stdout.on("data", (chunk) => { out += chunk })
    child.on("error", reject)
    child.on("close", () => resolve(JSON.parse(out)))
  }))
  const results = await Promise.all(runs)
  const winners = results.filter((result) => result.token !== undefined)
  assert.equal(winners.length, 1, JSON.stringify(results))
  const current = claimFiles(gitDir).filter((name) => name.endsWith(".json")).at(-1)
  assert.equal(JSON.parse(readFileSync(path.join(gitDir, current), "utf8")).token, winners[0].token)
  assert.deepEqual(claimFiles(gitDir).filter((name) => name.endsWith(".tmp")), [])
})

test("a tidy that stops is held with its reason until the state that stopped it changes", () => {
  // Git mid-merge: held until the merge ends.
  const merging = soloDesk()
  write(path.join(merging, ".git"), "MERGE_HEAD", "")
  assert.equal(cli(["--report"], { env: { DESK: merging } }).code, 1)
  assert.deepEqual(cli(["--detect"], { env: { DESK: merging } }), { code: 1, stdout: "held: the desk repository is in the middle of a merge\n", stderr: "" })
  rmSync(path.join(merging, ".git", "MERGE_HEAD"))
  assert.deepEqual(cli(["--detect"], { env: { DESK: merging } }), { code: 0, stdout: "", stderr: "" })

  // No person resolves on a crew desk: held until the identity or the roster changes.
  const crew = crewDesk()
  const nobody = { DESK: crew, DESK_IDENTITY: "nobody" }
  assert.equal(cli(["--report"], { env: nobody }).code, 1)
  assert.deepEqual(cli(["--detect"], { env: nobody }), { code: 1, stdout: "held: no person in this crew workspace's roster matches this session\n", stderr: "" })
  assert.equal(cli(["--detect"], { env: nobody, now: NOW + HOLD_MAX_MS }).code, 0, "a hold lapses after HOLD_MAX_MS")
  assert.equal(cli(["--detect"], { env: nobody, now: NOW - 1 }).code, 0, "a hold from the future does not count")
  write(crew, "_meta/desks.md", `${readFileSync(path.join(crew, "_meta/desks.md"), "utf8")}| carol | carol-login | desks/carol |\n`)
  assert.equal(cli(["--detect"], { env: nobody }).code, 0, "a changed roster lifts the hold")
  assert.equal(cli(["--report"], { env: nobody }).code, 1)
  assert.equal(cli(["--detect"], { env: nobody }).code, 1)
  assert.equal(cli(["--detect"], { env: { DESK: crew, DESK_IDENTITY: "Bob-Login" } }).code, 0, "a person resolving lifts the hold")

  // The tools and the script disagree about the person.
  const bob = { DESK: crew, DESK_IDENTITY: "alice-login" }
  assert.equal(cli(["--report", "--root", crew, "--person", "bob"], { env: bob }).code, 1)
  assert.deepEqual(cli(["--detect"], { env: bob }).code, 1)
  assert.equal(cli(["--detect", "--root", crew, "--person", "bob"], { env: bob }).stdout, "held: the Desk tools and the tidy resolve different desks\n")
  assert.equal(cli(["--report", "--root", crew, "--person", "bob"], { env: { DESK: crew, DESK_IDENTITY: "nobody" } }).code, 1)
  assert.equal(cli(["--detect", "--root", crew, "--person", "bob"], { env: { DESK: crew, DESK_IDENTITY: "nobody" } }).stdout, "held: the Desk tools' person does not match this session's identity\n")
})

test("the agent defers a tidy it cannot finish, and it returns once the desk's commit or uncommitted changes differ", () => {
  const root = soloDesk()
  const env = { DESK: root }
  const token = claimOf(cli(["--report"], { env }))
  assert.deepEqual(cli(["--defer", "tidy paths hold\nanother session's changes", "--claim", token], { env }), {
    code: 0,
    stdout: "The tidy is on hold: tidy paths hold another session's changes. Session start names it until this desk's latest commit or its uncommitted changes differ, and then the tidy runs again.\n",
    stderr: "",
  })
  assert.deepEqual(claimIn(path.join(root, ".git"), 1), { token, claimed_at: 0 }, "deferring releases the claim")
  assert.deepEqual(cli(["--detect"], { env }), { code: 1, stdout: "held: tidy paths hold another session's changes\n", stderr: "" })
  write(root, "another-loose-file.txt", "new\n")
  assert.equal(cli(["--detect"], { env }).code, 0)

  // A new report lifts any hold, and a malformed hold is ignored.
  assert.equal(cli(["--defer", "again"], { env }).code, 0)
  assert.equal(cli(["--detect"], { env }).code, 1)
  const again = cli(["--report"], { env })
  assert.equal(again.code, 0)
  assert.throws(() => readFileSync(path.join(root, ".git", "desk-tidy-hold.json")), { code: "ENOENT" })
  for (const hold of [{ kind: "later", reason: "x", held_at: NOW }, { kind: "agent", reason: " ", held_at: NOW }, { kind: "agent", reason: "x" }, []]) {
    writeFileSync(path.join(root, ".git", "desk-tidy-hold.json"), JSON.stringify(hold))
    assert.equal(heldReason(status(root), { now: NOW + CLAIM_STALE_MS }), null)
  }
  assert.equal(heldReason({ root: tempDir() }), null, "outside Git nothing is held")
})

test("a hold that cannot be written only means Detect fires again, and Detect survives a background lookup that cannot start", () => {
  const root = soloDesk()
  mkdirSync(path.join(root, ".git", "desk-tidy-hold.json"))
  write(path.join(root, ".git"), "MERGE_HEAD", "")
  assert.equal(cli(["--report"], { env: { DESK: root } }).code, 1)
  assert.equal(cli(["--detect"], { env: { DESK: root } }).code, 0)

  const crew = crewDesk()
  const failing = () => {
    throw new Error("spawn EAGAIN")
  }
  assert.deepEqual(cli(["--detect"], { env: { DESK: crew }, spawnBackground: failing }), { code: 1, stdout: "", stderr: "" })
})

// An agent's Bash shell has no CLAUDE_PROJECT_DIR (M4-7 live rerun): the tidy
// resolved no desk there, stopped, and wrote a hold whose fingerprint recorded
// that; the session-start hook, which has CLAUDE_PROJECT_DIR, resolved the desk,
// saw another fingerprint and fired again at every start.
test("an agent's shell resolves the desk from its working folder, so a hold it writes is honored at session start", () => {
  const crew = crewDesk()
  const home = tempDir()
  const shell = { env: { DESK_IDENTITY: "nobody" }, cwd: crew, homeDir: home }
  const hook = { env: { CLAUDE_PROJECT_DIR: crew, DESK_IDENTITY: "nobody" }, cwd: home, homeDir: home }

  // Both environments resolve the same desk and person, with no mismatch.
  const fromShell = tidyStatus({ root: crew, ...shell, now: NOW })
  const fromHook = tidyStatus({ root: crew, ...hook, now: NOW })
  assert.equal(fromShell.resolved.root, realpathSync(crew))
  assert.deepEqual(fromShell.resolved, fromHook.resolved)
  assert.equal(fromShell.mismatch, false)
  assert.equal(fromHook.mismatch, false)

  // The shell's report stops (no person resolves) and writes the hold; the hook's
  // Detect reads the same fingerprint and reports it held instead of pending.
  assert.equal(cli(["--report", "--root", crew], shell).code, 1)
  const hold = JSON.parse(readFileSync(path.join(crew, ".git", "desk-tidy-hold.json"), "utf8"))
  assert.equal(hold.reason, "no person in this crew workspace's roster matches this session")
  assert.deepEqual(cli(["--detect"], hook), { code: 1, stdout: `held: ${hold.reason}\n`, stderr: "" })
  assert.deepEqual(cli(["--detect", "--root", crew], shell), { code: 1, stdout: `held: ${hold.reason}\n`, stderr: "" })

  // A working folder counts only when it is a desk, and only when the host names
  // no project.
  assert.equal(tidyStatus({ ...shell, cwd: home, now: NOW }).resolved.root, null)
  assert.equal(tidyStatus({ env: { CLAUDE_PROJECT_DIR: home, DESK_IDENTITY: "nobody" }, cwd: crew, homeDir: home, now: NOW }).resolved.root, null)

  // A personal desk tidies from the shell: the report prints the steps and a claim.
  const solo = soloDesk()
  const report = cli(["--report", "--root", solo], { env: {}, cwd: solo, homeDir: home })
  assert.equal(report.code, 0, report.stdout)
  assert.match(report.stdout, /^Tidy claim: /mu)
})

test("--defer needs a reason and --refresh-identity needs a root", () => {
  assert.deepEqual(cli(["--defer"]), { code: 2, stdout: "", stderr: "tidy-status: --defer needs a one-line reason\n" })
  assert.deepEqual(cli(["--refresh-identity"]), { code: 2, stdout: "", stderr: "tidy-status: --refresh-identity needs --root\n" })
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

// ── The desk's pre-commit hook comes with the tidy (round 12) ─────────────

test("a tidy report installs the desk's pre-commit hook; a tidy that stops early does not", () => {
  const root = soloDesk()
  const calls = []
  const report = cli(["--report", "--root", root], { env: { DESK: root }, spawnGh: noGh, installGuard: (guardRoot, options) => calls.push([guardRoot, typeof options.spawnGit]) })
  assert.equal(report.code, 0)
  assert.deepEqual(calls, [[root, "function"]])
  const plain = soloDesk({ git: false })
  const none = []
  assert.equal(cli(["--report", "--root", plain], { env: { DESK: plain }, spawnGh: noGh, installGuard: (guardRoot) => none.push(guardRoot) }).code, 1)
  assert.deepEqual(none, [])
})

test("a tidy report really writes the hook into the desk's hooks folder", () => {
  const root = soloDesk()
  const report = cli(["--report", "--root", root], { env: { DESK: root }, spawnGh: noGh })
  assert.equal(report.code, 0)
  assert.match(readFileSync(path.join(root, ".git", "hooks", "pre-commit"), "utf8"), /desk-card-commit-guard/u)
})
