// naming.js — validateName, validateTrackName, validateScope, operatorNames.
//
// M4-1 ruling: lowercase kebab-case, 2-6 words, <=48 chars, rejecting
// prompt-like first words, credential-like words/tokens, IPv4-looking runs;
// track names additionally reject catch-all and person names; track.md
// gains a required one-line `scope:`. Existing (possibly bad) names are
// never rejected on read — only creation and renaming call these.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { after } from "node:test"
import {
  validateName,
  validateTrackName,
  validateScope,
  operatorNames,
  describeNameRejection,
} from "../../src/desk/naming.js"

const tempRoots = new Set()
after(() => Promise.all([...tempRoots].map((root) => fs.rm(root, { recursive: true, force: true }))))

async function mkTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desk-naming-test-"))
  tempRoots.add(root)
  return root
}

// ── validateName: accepted ──────────────────────────────────────────────

test("validateName accepts a well-formed 2-word outcome name", () => {
  assert.deepEqual(validateName("factory-slice-1"), { ok: true })
})

test("validateName accepts a 4-word outcome name", () => {
  assert.deepEqual(validateName("oauth-login-p0-fix"), { ok: true })
})

test("validateName accepts the 6-word upper bound", () => {
  const result = validateName("one-two-three-four-five-six")
  assert.equal(result.ok, true)
})

// ── validateName: shape ─────────────────────────────────────────────────

test("validateName rejects a single word as shape", () => {
  const result = validateName("misc")
  assert.equal(result.ok, false)
  assert.equal(result.code, "shape")
  assert.match(result.hint, /2.6/)
})

test("validateName rejects a 7-word name as shape", () => {
  const result = validateName("one-two-three-four-five-six-seven")
  assert.equal(result.ok, false)
  assert.equal(result.code, "shape")
})

test("validateName rejects uppercase characters as shape", () => {
  assert.equal(validateName("OAuth-Login-Fix").code, "shape")
})

test("validateName rejects non-string/empty input as shape", () => {
  assert.equal(validateName(undefined).code, "shape")
  assert.equal(validateName("").code, "shape")
  assert.equal(validateName("   ").code, "shape")
  assert.equal(validateName(42).code, "shape")
})

test("validateName rejects internal punctuation as shape", () => {
  assert.equal(validateName("oauth_login_fix").code, "shape")
  assert.equal(validateName("oauth login fix").code, "shape")
})

// ── validateName: too_long ──────────────────────────────────────────────

test("validateName rejects a shape-valid name over 48 characters as too_long", () => {
  const longName = "aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaa"
  assert.equal(longName.length, 52)
  const result = validateName(longName)
  assert.equal(result.code, "too_long")
  assert.match(result.hint, /48/)
})

test("validateName accepts a name at exactly 48 characters", () => {
  const name = "aaaaaaaa-aaaaaaa-aaaaaaa-aaaaaaa-aaaaaaa-aaaaaaa"
  assert.equal(name.length, 48)
  assert.deepEqual(validateName(name), { ok: true })
})

// ── validateName: prompt_like ───────────────────────────────────────────

test("validateName rejects a greeting-led name as prompt_like", () => {
  const result = validateName("hi-ssh-into-host")
  assert.equal(result.ok, false)
  assert.equal(result.code, "prompt_like")
})

test("validateName rejects a request-led name as prompt_like", () => {
  const result = validateName("hello-please-do-a-deep-dive")
  assert.equal(result.ok, false)
  assert.equal(result.code, "prompt_like")
})

test("validateName rejects every word in the greeting/request blocklist as a first word", () => {
  const blocked = [
    "hi",
    "hello",
    "hey",
    "please",
    "can",
    "could",
    "would",
    "lets",
    "help",
    "i",
    "we",
  ]
  for (const first of blocked) {
    const result = validateName(`${first}-do-the-thing`)
    assert.equal(result.code, "prompt_like", `expected ${first} to be prompt_like`)
  }
})

test("validateName rejects the let-s contraction split as prompt_like", () => {
  const result = validateName("let-s-ship-this")
  assert.equal(result.code, "prompt_like")
})

test("validateName does not flag a blocked word when it isn't first", () => {
  const result = validateName("deploy-can-we-ship")
  assert.equal(result.ok, true)
})

test("validateName does not flag a name that starts with let but isn't the let-s contraction", () => {
  const result = validateName("let-it-ride")
  assert.equal(result.ok, true)
})

// ── validateName: credential_like ───────────────────────────────────────

test("validateName rejects setup-user-root-pw-alpine as credential_like", () => {
  const result = validateName("setup-user-root-pw-alpine")
  assert.equal(result.ok, false)
  assert.equal(result.code, "credential_like")
})

test("validateName rejects an IPv4-looking run as credential_like", () => {
  const result = validateName("connect-100-73-66-84")
  assert.equal(result.ok, false)
  assert.equal(result.code, "credential_like")
})

test("validateName does not treat an out-of-range numeric run as IPv4-looking", () => {
  const result = validateName("connect-999-999-999-999")
  assert.equal(result.ok, true)
})

test("validateName rejects a long hex-looking word as credential_like", () => {
  const result = validateName("deploy-a1b2c3d4e5f6a7b8c9d0")
  assert.equal(result.ok, false)
  assert.equal(result.code, "credential_like")
})

test("validateName rejects a long mixed alnum token word as credential_like", () => {
  const result = validateName("deploy-x9k2m7q1p4z8r3n6")
  assert.equal(result.code, "credential_like")
})

test("validateName never echoes the credential-like word back in the hint", () => {
  const token = "a1b2c3d4e5f6a7b8c9d0"
  const result = validateName(`deploy-${token}`)
  assert.equal(result.hint.includes(token), false)
})

test("validateName does not flag a long pure-alphabetic word as credential_like", () => {
  const result = validateName("internationalization-effort")
  assert.equal(result.ok, true)
})

test("validateName rejects each standalone credential word", () => {
  for (const word of ["pw", "pwd", "pass", "passwd", "password", "token", "secret", "apikey"]) {
    const result = validateName(`fix-${word}-issue`)
    assert.equal(result.code, "credential_like", `expected ${word} to be credential_like`)
  }
})

test("validateName rejects an api-key word pair", () => {
  assert.equal(validateName("rotate-api-key").code, "credential_like")
})

test("validateName rejects a user-root word pair", () => {
  assert.equal(validateName("setup-user-root-vm").code, "credential_like")
})

test("validateName rejects key followed by another word even without api", () => {
  assert.equal(validateName("store-key-safely").code, "credential_like")
})

test("validateName does not flag a trailing standalone key", () => {
  // "key" is only credential-like when it is *followed* by another word
  // (a qualifier ahead of whatever it's a key for) or paired with "api" —
  // as the very last word on its own it reads as an ordinary noun.
  const result = validateName("find-the-key")
  assert.equal(result.ok, true)
})

// ── describeNameRejection ───────────────────────────────────────────────

test("describeNameRejection quotes the candidate name for a non-credential rejection", () => {
  const result = validateName("hi-ssh-into-host")
  const message = describeNameRejection("hi-ssh-into-host", result)
  assert.match(message, /"hi-ssh-into-host"/)
})

test("describeNameRejection never echoes a credential-like candidate", () => {
  const token = "a1b2c3d4e5f6a7b8c9d0"
  const name = `deploy-${token}`
  const result = validateName(name)
  const message = describeNameRejection(name, result)
  assert.equal(message.includes(token), false)
  assert.equal(message.includes(name), false)
})

// ── validateTrackName ───────────────────────────────────────────────────

test("validateTrackName rejects a catch-all track name", () => {
  const result = validateTrackName("misc", { operatorNames: [] })
  assert.equal(result.ok, false)
  assert.equal(result.code, "catch_all")
})

test("validateTrackName rejects every catch-all name", () => {
  const names = ["misc", "general", "other", "stuff", "inbox", "todo", "notes", "random", "scratch"]
  for (const name of names) {
    assert.equal(validateTrackName(name, { operatorNames: [] }).code, "catch_all", name)
  }
})

test("validateTrackName rejects a track named after an operator alias", () => {
  const result = validateTrackName("arimendelow", {
    operatorNames: ["arimendelow", "ari-mendelow"],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, "person")
})

test("validateTrackName matches operator names case-insensitively", () => {
  const result = validateTrackName("Arimendelow", { operatorNames: ["arimendelow"] })
  assert.equal(result.code, "person")
})

test("validateTrackName defaults operatorNames to empty and still runs base rules", () => {
  const result = validateTrackName("hi-there-team")
  assert.equal(result.code, "prompt_like")
})

test("validateTrackName falls through to base validateName rules for an ordinary name", () => {
  assert.deepEqual(validateTrackName("billing-disputes", { operatorNames: ["ari"] }), { ok: true })
})

test("validateTrackName still rejects a shape-invalid name that is not catch-all or person", () => {
  const result = validateTrackName("oneword", { operatorNames: [] })
  assert.equal(result.code, "shape")
})

test("validateTrackName falls through to validateName for a non-string/empty candidate", () => {
  assert.equal(validateTrackName(undefined, { operatorNames: ["ari"] }).code, "shape")
  assert.equal(validateTrackName("", { operatorNames: ["ari"] }).code, "shape")
  assert.equal(validateTrackName("   ", { operatorNames: ["ari"] }).code, "shape")
})

test("validateTrackName tolerates an explicitly null operatorNames", () => {
  const result = validateTrackName("billing-disputes", { operatorNames: null })
  assert.deepEqual(result, { ok: true })
})

// ── validateScope ────────────────────────────────────────────────────────

test("validateScope accepts a well-formed one-line scope", () => {
  const result = validateScope("billing disputes and refund flows; not payroll")
  assert.deepEqual(result, { ok: true })
})

test("validateScope rejects a missing scope", () => {
  assert.equal(validateScope(undefined).code, "missing")
  assert.equal(validateScope(null).code, "missing")
  assert.equal(validateScope("").code, "missing")
  assert.equal(validateScope("   ").code, "missing")
})

test("validateScope rejects a multiline scope", () => {
  const result = validateScope("line one\nline two")
  assert.equal(result.code, "multiline")
})

test("validateScope rejects a scope over 240 characters", () => {
  const scope = "a".repeat(241)
  const result = validateScope(scope)
  assert.equal(result.code, "too_long")
})

test("validateScope accepts a scope at exactly 240 characters", () => {
  const scope = "a".repeat(240)
  assert.deepEqual(validateScope(scope), { ok: true })
})

// ── operatorNames ────────────────────────────────────────────────────────

// The real environment's global `git config user.name` leaks into a plain
// `spawnSync` call even outside a repo, so any test that wants "no git
// identity" has to neutralize git via the injectable seam rather than rely
// on the machine having no global user.name set.
const noGitIdentity = { spawnGitConfig: () => ({ status: 1, stdout: "" }) }

test("operatorNames returns an empty array for a desk with no registry and no git identity", async () => {
  const root = await mkTempRoot()
  const names = operatorNames(root, noGitIdentity)
  assert.deepEqual(names, [])
})

test("operatorNames reads alias and identity columns from _meta/desks.md", async () => {
  const root = await mkTempRoot()
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.writeFile(
    path.join(root, "_meta", "desks.md"),
    [
      "# Desks",
      "",
      "| alias | identity | path | repo | worker_variant | write_subtree |",
      "|-------|----------|------|------|----------------|---------------|",
      "| alex  | agarcia_corp  | desks/alex | example-org/crew-workspace | crew | desks/alex |",
      "| bob   | bsmith   | desks/bob  | example-org/crew-workspace | crew | desks/bob |",
      "",
    ].join("\n"),
    "utf8",
  )
  const names = operatorNames(root)
  assert.ok(names.includes("alex"))
  assert.ok(names.includes("agarcia-corp"))
  assert.ok(names.includes("bob"))
  assert.ok(names.includes("bsmith"))
})

test("operatorNames tolerates a desks.md with no alias/identity columns", async () => {
  const root = await mkTempRoot()
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.writeFile(
    path.join(root, "_meta", "desks.md"),
    ["| foo | bar |", "|-----|-----|", "| x | y |"].join("\n"),
    "utf8",
  )
  assert.deepEqual(operatorNames(root, noGitIdentity), [])
})

test("operatorNames tolerates an unreadable desks.md (directory in its place)", async () => {
  const root = await mkTempRoot()
  await fs.mkdir(path.join(root, "_meta", "desks.md"), { recursive: true })
  assert.deepEqual(operatorNames(root, noGitIdentity), [])
})

test("operatorNames includes the desk's git config user.name, kebab-cased", async () => {
  const root = await mkTempRoot()
  execFileSync("git", ["init", "-q", root])
  execFileSync("git", ["-C", root, "config", "user.name", "Ari Mendelow"])
  execFileSync("git", ["-C", root, "config", "user.email", "ari@example.com"])
  const names = operatorNames(root)
  assert.ok(names.includes("ari-mendelow"), names.join(","))
})

test("operatorNames dedupes and kebab-cases across registry and git identity", async () => {
  const root = await mkTempRoot()
  execFileSync("git", ["init", "-q", root])
  execFileSync("git", ["-C", root, "config", "user.name", "Ari Mendelow"])
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.writeFile(
    path.join(root, "_meta", "desks.md"),
    [
      "| alias | identity |",
      "|-------|----------|",
      "| Ari Mendelow | ari |",
    ].join("\n"),
    "utf8",
  )
  const names = operatorNames(root)
  assert.equal(names.filter((n) => n === "ari-mendelow").length, 1)
})

test("operatorNames returns [] when git config has no user.name set", async () => {
  const root = await mkTempRoot()
  execFileSync("git", ["init", "-q", root])
  const names = operatorNames(root, noGitIdentity)
  assert.deepEqual(names, [])
})

test("operatorNames tolerates a desk root that is not a git repository at all", async () => {
  const root = await mkTempRoot()
  const names = operatorNames(root, noGitIdentity)
  assert.deepEqual(names, [])
})

test("operatorNames tolerates a table row that doesn't end in a trailing pipe", async () => {
  const root = await mkTempRoot()
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.writeFile(
    path.join(root, "_meta", "desks.md"),
    ["| alias | identity", "|-------|----------", "| edge-case | edge-id"].join("\n"),
    "utf8",
  )
  const names = operatorNames(root)
  assert.ok(names.includes("edge-case"))
  assert.ok(names.includes("edge-id"))
})

test("operatorNames skips a blank alias cell but keeps a populated identity cell", async () => {
  const root = await mkTempRoot()
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.writeFile(
    path.join(root, "_meta", "desks.md"),
    ["| alias | identity |", "|-------|----------|", "|  | somebody |"].join("\n"),
    "utf8",
  )
  const names = operatorNames(root, noGitIdentity)
  assert.deepEqual(names, ["somebody"])
})

test("operatorNames drops a registry cell that kebab-cases to nothing", async () => {
  const root = await mkTempRoot()
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.writeFile(
    path.join(root, "_meta", "desks.md"),
    ["| alias | identity |", "|-------|----------|", "| *** | valid-person |"].join("\n"),
    "utf8",
  )
  const names = operatorNames(root, noGitIdentity)
  assert.deepEqual(names, ["valid-person"])
})

test("operatorNames ignores non-table lines interspersed in desks.md", async () => {
  const root = await mkTempRoot()
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.writeFile(
    path.join(root, "_meta", "desks.md"),
    [
      "# Desks",
      "",
      "Some prose that is not a table row.",
      "| alias | identity |",
      "|-------|----------|",
      "| alex | agarcia |",
    ].join("\n"),
    "utf8",
  )
  const names = operatorNames(root)
  assert.ok(names.includes("alex"))
})

test("operatorNames tolerates a spawn that throws (git binary unavailable)", async () => {
  const root = await mkTempRoot()
  const names = operatorNames(root, {
    spawnGitConfig: () => {
      throw new Error("spawn git ENOENT")
    },
  })
  assert.deepEqual(names, [])
})

test("operatorNames tolerates a spawn result with no output at all", async () => {
  const root = await mkTempRoot()
  const names = operatorNames(root, {
    spawnGitConfig: () => null,
  })
  assert.deepEqual(names, [])
})

test("operatorNames tolerates a spawn result with status 0 but empty stdout", async () => {
  const root = await mkTempRoot()
  const names = operatorNames(root, {
    spawnGitConfig: () => ({ status: 0, stdout: "" }),
  })
  assert.deepEqual(names, [])
})

test("operatorNames uses an injected spawn for the happy path too", async () => {
  const root = await mkTempRoot()
  const names = operatorNames(root, {
    spawnGitConfig: () => ({ status: 0, stdout: "Injected Name\n" }),
  })
  assert.deepEqual(names, ["injected-name"])
})
