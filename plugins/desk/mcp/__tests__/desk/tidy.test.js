// The one-time tidy (M4-5): tidyStatus is the `02-tidy-desk` migration's
// Detect predicate — organization findings in this session's own desk
// subtree, and no `tidy_version: 1` in its `_meta/organization.json`.
//
// Every test runs against a fixture desk in a temporary folder; nothing here
// ever reads or writes a real desk.

import { test, after } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  CLAIM_STALE_MS,
  HOLD_MAX_MS,
  ORGANIZATION_RECORD,
  TIDY_VERSION,
  heldReason,
  identityCachePath,
  organizationRecord,
  parseDeskRegistry,
  readOrganizationRecord,
  resolvePerson,
  runTidyStatusCli,
  takeClaim,
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
    assert.match(report.stdout, new RegExp(`^Desk tools: ${root}\\nThis script: ${root}\\nThis session's own desk: ${root}\\n`))
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
  assert.equal(cli(["--write-record", "--root", root, "--claim", claimOf(report)], { env: { DESK: root }, spawnGh: noGh }).code, 0)
  assert.equal(cli(["--detect", "--root", root], { env: { DESK: root }, spawnGh: noGh }).code, 1, "once tidied, Detect stops firing")
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
  assert.deepEqual(parseDeskRegistry(HUB_REGISTRY), [], "a hub's routing registry has no crew roster")
  assert.deepEqual(parseDeskRegistry("| alias | path |\n|---|---|\n| alex | desks/alex |\n"), [], "a roster needs its identity column")
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
  const url = new URL("../../src/desk/tidy.js", import.meta.url).href
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
