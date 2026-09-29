// boot.js — the one-call boot script (boot-in-one-call scope items 2, 3, 4,
// 5, 6, 8, 9, 11, 13). Real filesystem fixtures for root resolution and
// card scanning; injected fake runners (shaped like `factory/flush.js`'s
// `ghRunner`/`chooseAccount` and this module's own `commandRunner`) for
// every subprocess and network-shaped call, per `account.test.js`'s
// `fakeGh` convention — nothing here reaches a real `gh`, `jq` or network.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

import { mkTempRoot } from "../_temp_roots.js"
import {
  bootOnce,
  cardProblems,
  cardValidation,
  checkPrereqs,
  commandRunner,
  probeHost,
  resolveBootRoot,
  resolvePushAccounts,
  runBootCli,
  walkTaskCards,
} from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { REDACTED_SEGMENT } from "../../../../../plugins/desk/mcp/src/util/redact.js"

async function mkDeskWorkspace() {
  const root = await mkTempRoot("desk-boot-root-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  return root
}

async function writeCard(root, track, slug, frontmatter, { desk = null } = {}) {
  const dir = desk === null ? path.join(root, track, slug) : path.join(root, "desks", desk, track, slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "task.md"), `---\n${frontmatter}\n---\n\nBody.\n`)
  return dir
}

const VALID_CARD = [
  "schema_version: 1",
  "title: Example task",
  "status: processing",
  "created: '2026-01-01T00:00:00Z'",
  "updated: '2026-01-02T00:00:00Z'",
  "track: example-track",
  "repos: []",
].join("\n")

// ── resolveBootRoot ──────────────────────────────────────────────────────

test("resolveBootRoot: an env:DESK pointing at a real desk workspace resolves ready", async () => {
  const root = await mkDeskWorkspace()
  const result = resolveBootRoot({ env: { DESK: root }, cwd: root, homeDir: root })
  assert.deepEqual(result, { status: "ready", path: root, source: "env:DESK", binding_path: null })
})

test("resolveBootRoot: nothing names a desk anywhere → setup_required with every path tried", async () => {
  const emptyHome = await mkTempRoot("desk-boot-empty-home-")
  const result = resolveBootRoot({ env: {}, cwd: emptyHome, homeDir: emptyHome })
  assert.equal(result.status, "setup_required")
  assert.equal(result.path, null)
  assert.ok(Array.isArray(result.tried) && result.tried.length > 0)
})

test("resolveBootRoot: env:DESK naming a missing folder → degraded, root_unavailable", async () => {
  const emptyHome = await mkTempRoot("desk-boot-missing-home-")
  const missing = path.join(emptyHome, "does-not-exist")
  const result = resolveBootRoot({ env: { DESK: missing }, cwd: emptyHome, homeDir: emptyHome })
  assert.equal(result.status, "degraded")
  assert.equal(result.reason, "DESK_ROOT_UNAVAILABLE")
  assert.equal(result.path, missing)
  assert.match(result.message, /does not exist/u)
})

test("resolveBootRoot: an unreadable activation config → degraded, activation_config_invalid", async () => {
  const emptyHome = await mkTempRoot("desk-boot-badconfig-home-")
  const result = resolveBootRoot({
    env: { DESK_ACTIVATION_CONFIG: "/wherever/desk.activation.json" },
    cwd: emptyHome,
    homeDir: emptyHome,
    readActivationConfig: () => {
      throw new Error("boom")
    },
  })
  assert.equal(result.status, "degraded")
  assert.equal(result.reason, "ACTIVATION_CONFIG_INVALID")
})

test("resolveBootRoot: a real activation config, read with the real default reader, resolves ready", async () => {
  const root = await mkDeskWorkspace()
  const configHome = await mkTempRoot("desk-boot-config-home-")
  const configPath = path.join(configHome, "desk.activation.json")
  await fs.writeFile(configPath, JSON.stringify({ schema_version: 1, desk: { root } }))
  const result = resolveBootRoot({ env: { DESK_ACTIVATION_CONFIG: configPath }, cwd: configHome, homeDir: configHome })
  assert.deepEqual(result, { status: "ready", path: root, source: "activation-config", binding_path: null })
})

test("resolveBootRoot: called bare, every default (env, cwd, homeDir) resolves through the real process — no desk at the isolated test HOME", () => {
  const result = resolveBootRoot()
  assert.equal(result.status, "setup_required")
})

test("resolveBootRoot: homeDir defaults to os.homedir() (not the real user's HOME) when env.HOME is unset", async () => {
  const emptyHome = await mkTempRoot("desk-boot-homedir-default-")
  const result = resolveBootRoot({ env: {}, cwd: emptyHome })
  assert.equal(result.status, "setup_required")
})

// ── probeHost ────────────────────────────────────────────────────────────

test("probeHost: called bare, every default (env, hostname, userInfo, cwd, platform, release, now) fires for real", () => {
  const result = probeHost()
  assert.equal(typeof result.hostname === "string" || result.hostname === null, true)
  assert.equal(typeof result.user === "string" || result.user === null, true)
  assert.equal(typeof result.cwd, "string")
  assert.equal(typeof result.platform, "string")
  assert.equal(typeof result.release, "string")
  assert.equal(new Date(result.probed_at).toISOString(), result.probed_at)
})

test("probeHost: real defaults produce a populated, ISO-stamped identity", () => {
  const result = probeHost({ env: { USER: "ari" } })
  assert.equal(result.user, "ari")
  assert.equal(typeof result.hostname, "string")
  assert.equal(typeof result.cwd, "string")
  assert.equal(typeof result.platform, "string")
  assert.equal(typeof result.release, "string")
  assert.equal(new Date(result.probed_at).toISOString(), result.probed_at)
})

test("probeHost: falls back to USERNAME, then userInfo(), when USER is unset", () => {
  assert.equal(probeHost({ env: { USERNAME: "windows-ari" } }).user, "windows-ari")
  assert.equal(probeHost({ env: {}, userInfo: () => ({ username: "from-os" }) }).user, "from-os")
})

test("probeHost: a throwing hostname() or userInfo() degrades to null rather than throwing", () => {
  const result = probeHost({
    env: {},
    hostname: () => {
      throw new Error("no hostname")
    },
    userInfo: () => {
      throw new Error("no passwd entry")
    },
  })
  assert.equal(result.hostname, null)
  assert.equal(result.user, null)
})

// ── commandRunner ────────────────────────────────────────────────────────

function fakeChild({ onClose, onError, chunks = [] } = {}) {
  const listeners = { stdout: [], stderr: [] }
  const child = {
    stdout: { on: (event, fn) => { if (event === "data") listeners.stdout.push(fn) } },
    stderr: { on: (event, fn) => { if (event === "data") listeners.stderr.push(fn) } },
    on: (event, fn) => {
      if (event === "close" && onClose !== undefined) setImmediate(() => fn(onClose))
      if (event === "error" && onError !== undefined) setImmediate(() => fn(onError))
    },
    kill() { child.killed = true },
  }
  setImmediate(() => chunks.forEach(([stream, text]) => listeners[stream].forEach((fn) => fn(Buffer.from(text)))))
  return child
}

test("commandRunner: a clean exit reports code, stdout and stderr", async () => {
  const spawn = () => fakeChild({ onClose: 0, chunks: [["stdout", "1.7\n"], ["stderr", ""]] })
  const result = await commandRunner("jq", { spawn })(["--version"], { timeoutMs: 1000 })
  assert.deepEqual(result, { code: 0, stdout: "1.7\n", stderr: "" })
})

test("commandRunner: a spawn error reports spawnError, never throws", async () => {
  const spawn = () => fakeChild({ onError: Object.assign(new Error("nope"), { code: "ENOENT" }) })
  const result = await commandRunner("jq", { spawn })(["--version"], { timeoutMs: 1000 })
  assert.deepEqual(result, { code: null, stdout: "", stderr: "", spawnError: "ENOENT" })
})

test("commandRunner: a child that never closes is killed at the timeout", async () => {
  const spawn = () => fakeChild()
  const result = await commandRunner("jq", { spawn })(["--version"], { timeoutMs: 20 })
  assert.equal(result.timedOut, true)
  assert.equal(result.code, null)
})

test("commandRunner: output past maxOutput is dropped rather than buffered forever", async () => {
  const spawn = () => fakeChild({ onClose: 0, chunks: [["stdout", "abc"], ["stdout", "defgh"]] })
  const result = await commandRunner("jq", { spawn, maxOutput: 3 })(["--version"], { timeoutMs: 1000 })
  assert.equal(result.stdout, "abc")
})

test("commandRunner: a spawn error with no .code falls back to a generic spawn_failed reason", async () => {
  const spawn = () => fakeChild({ onError: new Error("mystery failure") })
  const result = await commandRunner("jq", { spawn })(["--version"], { timeoutMs: 1000 })
  assert.equal(result.spawnError, "spawn_failed")
})

test("commandRunner: a child that both errors and closes only resolves once, from whichever fires first", async () => {
  let closeFn
  let errorFn
  const child = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (event, fn) => {
      if (event === "close") closeFn = fn
      if (event === "error") errorFn = fn
    },
    kill() { child.killed = true },
  }
  const spawn = () => child
  const resultPromise = commandRunner("jq", { spawn })(["--version"], { timeoutMs: 1000 })
  errorFn(Object.assign(new Error("first"), { code: "ENOENT" }))
  closeFn(0)
  const result = await resultPromise
  assert.deepEqual(result, { code: null, stdout: "", stderr: "", spawnError: "ENOENT" })
})

test("commandRunner: called with no options object at all, on a command that cannot exist, still resolves rather than hanging or throwing", async () => {
  const run = commandRunner("desk-boot-test-definitely-not-a-real-binary")
  const result = await run(["--version"])
  assert.equal(result.spawnError, "ENOENT")
})

// ── checkPrereqs ─────────────────────────────────────────────────────────

function fixedRunner(byArgs) {
  return async (args) => {
    const key = args.join(" ")
    const match = Object.entries(byArgs).find(([prefix]) => key.startsWith(prefix))
    return match ? match[1] : { code: 1, stdout: "", stderr: "unexpected call" }
  }
}

test("checkPrereqs: gh and jq both fresh and auth healthy → all ok", async () => {
  const gh = fixedRunner({
    "--version": { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" },
    "auth status": { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n", stderr: "" },
  })
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const result = await checkPrereqs({ gh, jq })
  assert.deepEqual(result, { gh: { ok: true, version: "2.54.0" }, jq: { ok: true }, auth: { ok: true } })
})

test("checkPrereqs: gh --version succeeding with no stdout at all is unparseable, not a thrown error", async () => {
  const gh = fixedRunner({ "--version": { code: 0 }, "auth status": { code: 0, stdout: "", stderr: "" } })
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const result = await checkPrereqs({ gh, jq })
  assert.equal(result.gh.reason, "gh_version_unparseable")
})

test("checkPrereqs: a nonzero gh or jq exit with neither stdout nor stderr defined still produces a trimmed, empty detail", async () => {
  const jqBad = fixedRunner({ "--version": { code: 1 } })
  const ghGood = fixedRunner({ "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" }, "auth status": { code: 0, stdout: "", stderr: "" } })
  const jqResult = await checkPrereqs({ gh: ghGood, jq: jqBad })
  assert.equal(jqResult.jq.detail, "")

  const ghBad = fixedRunner({ "--version": { code: 1 }, "auth status": { code: 0, stdout: "", stderr: "" } })
  const jqGood = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const ghResult = await checkPrereqs({ gh: ghBad, jq: jqGood })
  assert.equal(ghResult.gh.detail, "")
})

test("checkPrereqs: gh below the 2.40 floor is too old; gh at or above 2.40 is fine", async () => {
  const below = fixedRunner({ "--version": { code: 0, stdout: "gh version 2.39.9\n", stderr: "" }, "auth status": { code: 0, stdout: "", stderr: "" } })
  const atFloor = fixedRunner({ "--version": { code: 0, stdout: "gh version 2.40.0\n", stderr: "" }, "auth status": { code: 0, stdout: "", stderr: "" } })
  const newerMajor = fixedRunner({ "--version": { code: 0, stdout: "gh version 3.0.0\n", stderr: "" }, "auth status": { code: 0, stdout: "", stderr: "" } })
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  assert.equal((await checkPrereqs({ gh: below, jq })).gh.reason, "gh_too_old")
  assert.equal((await checkPrereqs({ gh: atFloor, jq })).gh.ok, true)
  assert.equal((await checkPrereqs({ gh: newerMajor, jq })).gh.ok, true)
})

test("checkPrereqs: a missing gh binary reports gh_missing on both the gh and auth checks", async () => {
  const gh = async () => ({ code: null, stdout: "", stderr: "", spawnError: "ENOENT" })
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const result = await checkPrereqs({ gh, jq })
  assert.equal(result.gh.reason, "gh_missing")
  assert.equal(result.auth.reason, "gh_missing")
})

test("checkPrereqs: gh --version timing out, exiting nonzero, or printing unparseable text", async () => {
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const timeout = fixedRunner({ "--version": { code: null, stdout: "", stderr: "", timedOut: true }, "auth status": { code: 0, stdout: "", stderr: "" } })
  const nonzero = fixedRunner({ "--version": { code: 1, stdout: "", stderr: "broken pipe" }, "auth status": { code: 0, stdout: "", stderr: "" } })
  const garbled = fixedRunner({ "--version": { code: 0, stdout: "not a version string\n", stderr: "" }, "auth status": { code: 0, stdout: "", stderr: "" } })
  assert.equal((await checkPrereqs({ gh: timeout, jq })).gh.reason, "gh_timeout")
  assert.equal((await checkPrereqs({ gh: nonzero, jq })).gh.reason, "gh_error")
  assert.equal((await checkPrereqs({ gh: garbled, jq })).gh.reason, "gh_version_unparseable")
})

test("checkPrereqs: jq missing, timing out, or exiting nonzero", async () => {
  const gh = fixedRunner({ "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" }, "auth status": { code: 0, stdout: "", stderr: "" } })
  const missing = async () => ({ code: null, stdout: "", stderr: "", spawnError: "ENOENT" })
  const timeout = async () => ({ code: null, stdout: "", stderr: "", timedOut: true })
  const nonzero = async () => ({ code: 1, stdout: "", stderr: "parse error" })
  assert.equal((await checkPrereqs({ gh, jq: missing })).jq.reason, "jq_missing")
  assert.equal((await checkPrereqs({ gh, jq: timeout })).jq.reason, "jq_timeout")
  assert.equal((await checkPrereqs({ gh, jq: nonzero })).jq.reason, "jq_error")
})

test("checkPrereqs: a nonzero gh or jq exit with empty stderr falls back to stdout for the detail", async () => {
  const jqBad = fixedRunner({ "--version": { code: 1, stdout: "jq: parse error at line 1\n", stderr: "" } })
  const ghGood = fixedRunner({ "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" }, "auth status": { code: 0, stdout: "", stderr: "" } })
  const jqResult = await checkPrereqs({ gh: ghGood, jq: jqBad })
  assert.equal(jqResult.jq.detail, "jq: parse error at line 1")

  const ghBad = fixedRunner({ "--version": { code: 1, stdout: "gh: something broke\n", stderr: "" }, "auth status": { code: 0, stdout: "", stderr: "" } })
  const jqGood = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const ghResult = await checkPrereqs({ gh: ghBad, jq: jqGood })
  assert.equal(ghResult.gh.detail, "gh: something broke")
})

test("checkPrereqs: an auth-status result missing stdout and stderr entirely is still read without throwing", async () => {
  const gh = fixedRunner({ "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" }, "auth status": { code: 1 } })
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const result = await checkPrereqs({ gh, jq })
  assert.equal(result.auth.ok, false)
  assert.equal(result.auth.reason, "auth_error")
})

test("checkPrereqs: called bare, the real gh and jq runners report missing binaries off an empty PATH", async () => {
  const originalPath = process.env.PATH
  process.env.PATH = "/nonexistent-bin"
  try {
    const result = await checkPrereqs()
    assert.equal(result.gh.reason, "gh_missing")
    assert.equal(result.jq.reason, "jq_missing")
    assert.equal(result.auth.reason, "gh_missing")
  } finally {
    process.env.PATH = originalPath
  }
})

test("checkPrereqs: a stale token is caught even with exit code 0; a plain nonzero without the phrase is auth_error", async () => {
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const stale = fixedRunner({
    "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" },
    "auth status": { code: 0, stdout: "The github.com token in oauth_token is no longer valid\n", stderr: "" },
  })
  const loggedOut = fixedRunner({
    "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" },
    "auth status": { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts\n" },
  })
  const otherFailure = fixedRunner({
    "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" },
    "auth status": { code: 1, stdout: "", stderr: "rate limited\n" },
  })
  const timeout = fixedRunner({ "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" }, "auth status": { code: null, stdout: "", stderr: "", timedOut: true } })
  assert.equal((await checkPrereqs({ gh: stale, jq })).auth.reason, "auth_stale")
  assert.equal((await checkPrereqs({ gh: loggedOut, jq })).auth.reason, "auth_stale")
  assert.equal((await checkPrereqs({ gh: otherFailure, jq })).auth.reason, "auth_error")
  assert.equal((await checkPrereqs({ gh: timeout, jq })).auth.reason, "auth_timeout")
})

// ── cardProblems ─────────────────────────────────────────────────────────

test("cardProblems: a healthy card has no problems", () => {
  assert.deepEqual(cardProblems({
    title: "Example", status: "processing", created: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z", track: "example", repos: [],
  }), [])
});

test("cardProblems: frontmatter that is not a YAML mapping", () => {
  assert.deepEqual(cardProblems(null), ["frontmatter did not parse as a YAML mapping"])
  assert.deepEqual(cardProblems([1, 2]), ["frontmatter did not parse as a YAML mapping"])
  assert.deepEqual(cardProblems("nope"), ["frontmatter did not parse as a YAML mapping"])
})

test("cardProblems: an empty object is missing every required field and repos", () => {
  const problems = cardProblems({})
  assert.equal(problems.length, 6)
  for (const field of ["title", "status", "created", "updated", "track"]) {
    assert.ok(problems.some((message) => message.includes(`\`${field}\``)), field)
  }
  assert.ok(problems.includes("`repos` is missing or not a list"))
})

test("cardProblems: a numeric-string-keyed object where a list was expected names the field once, without a duplicate 'missing' message", () => {
  const problems = cardProblems({
    title: "Example", status: "processing", created: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z", track: "example",
    repos: { 0: { name: "a/b", local_path: "~/a", mode: "local" }, 1: { name: "c/d", local_path: "~/c", mode: "local" } },
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /`repos` is an object with numeric-string keys \(0, 1\)/u)
})

test("cardProblems: the numeric-key check generalizes to any field, not just repos", () => {
  const problems = cardProblems({
    title: "Example", status: "processing", created: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z",
    track: { 0: "a", 1: "b" },
    repos: [],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /`track` is an object with numeric-string keys/u)
})

test("cardProblems: an unrecognized status and unparseable timestamps", () => {
  const problems = cardProblems({ title: "Example", status: "in-flight", created: "not a date", updated: "2026-01-02T00:00:00Z", track: "example", repos: [] })
  assert.ok(problems.some((message) => message.includes("`status: in-flight`")))
  assert.ok(problems.some((message) => message.includes("`created` is not a parseable timestamp")))
})

test("cardProblems: malformed repos[] entries", () => {
  const problems = cardProblems({
    title: "Example", status: "processing", created: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z", track: "example",
    repos: [null, { name: "a/b" }, { name: 1, local_path: "~/a", mode: "worktree" }],
  })
  assert.ok(problems.includes("repos[0] is not an object"))
  assert.ok(problems.some((message) => message.includes("repos[1].local_path")))
  assert.ok(problems.some((message) => message.includes("repos[1].mode")))
  assert.ok(problems.some((message) => message.includes("repos[2].name")))
  assert.ok(problems.some((message) => message.includes('repos[2].mode is "worktree"')))
})

// ── walkTaskCards / cardValidation ──────────────────────────────────────

test("walkTaskCards: scans tracks and desks/<alias> subtrees, skipping _ and . folders, including terminal-status cards", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "open-task", VALID_CARD)
  await writeCard(root, "track-a", "done-task", VALID_CARD.replace("status: processing", "status: done"))
  await writeCard(root, "_archive", "old-task", VALID_CARD)
  await fs.mkdir(path.join(root, "track-a", ".hidden"), { recursive: true })
  await writeCard(root, "track-b", "crew-task", VALID_CARD, { desk: "alex" })
  await fs.mkdir(path.join(root, "track-a", "empty-dir"), { recursive: true })
  await fs.mkdir(path.join(root, "track-a", "garbled-yaml"), { recursive: true })
  await fs.writeFile(path.join(root, "track-a", "garbled-yaml", "task.md"), "---\ntitle: [oops\n---\n")

  const cards = walkTaskCards(root)
  const bySlug = Object.fromEntries(cards.map((card) => [card.slug, card]))
  assert.ok(bySlug["open-task"])
  assert.ok(bySlug["done-task"], "terminal-status cards are still walked for validation")
  assert.equal(bySlug["old-task"], undefined, "_archive is skipped")
  assert.equal(cards.some((card) => card.slug === ".hidden"), false)
  const crew = cards.find((card) => card.slug === "crew-task")
  assert.equal(crew.desk, "alex")
  assert.equal(bySlug["empty-dir"], undefined, "a task-slug folder with no task.md is silently skipped")
  assert.deepEqual(bySlug["garbled-yaml"].data, {}, "frontmatter that fails to parse at all reads as an empty object, not a thrown error")
})

test("cardValidation: only reports cards with problems, redacts secret-like names, and gives a stable handle", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "healthy-task", VALID_CARD)
  await writeCard(root, "track-a", "ghp_1234567890abcdef1234", "title: Broken\nstatus: not-a-status\n")

  const results = cardValidation(root)
  assert.equal(results.length, 1)
  assert.equal(results[0].track, "track-a")
  assert.equal(results[0].slug, REDACTED_SEGMENT, "a credential-like slug is redacted, never echoed")
  assert.match(results[0].handle, /^task-[0-9a-f]{10}$/u)
  assert.ok(results[0].problems.length > 0)
})

test("cardValidation: a crew-workspace (desk-set) card's problems are labeled with its desk alias", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "crew-task", "title: Broken\nstatus: not-a-status\n", { desk: "alex" })

  const results = cardValidation(root)
  assert.equal(results.length, 1)
  assert.equal(results[0].desk, "alex")
})

// ── resolvePushAccounts ──────────────────────────────────────────────────

const VERSION_OK = "gh version 2.54.0\n"

function fakeGhRunner({ accounts, repos }) {
  return async (args, { token } = {}) => {
    if (args[0] === "--version") return { code: 0, stdout: VERSION_OK, stderr: "" }
    if (args[0] === "auth" && args[1] === "status") {
      const block = ({ login, active }) => `  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: ${active}\n`
      return { code: 0, stdout: `github.com\n${accounts.map(block).join("\n")}`, stderr: "" }
    }
    if (args[0] === "auth" && args[1] === "token") {
      return { code: 0, stdout: `token-${args[3]}\n`, stderr: "" }
    }
    if (args[0] === "api") {
      const login = typeof token === "string" ? token.replace(/^token-/u, "") : null
      const answer = repos[login]
      if (typeof answer === "number") return { code: 1, stdout: "{}", stderr: `gh: Not Found (HTTP ${answer})\n` }
      return { code: 0, stdout: JSON.stringify(answer), stderr: "" }
    }
    return { code: 1, stdout: "", stderr: "unexpected call" }
  }
}

const PUBLIC_PUSH = { full_name: "acme/widgets", private: false, allow_forking: true, default_branch: "main", permissions: { push: true, pull: true } }

test("resolvePushAccounts: a remote-mode repo with a real owner/repo slug resolves an account", async () => {
  const cards = [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: "acme/widgets", local_path: "", mode: "remote" }] } }]
  const runner = fakeGhRunner({ accounts: [{ login: "ari", active: true }], repos: { ari: PUBLIC_PUSH } })
  const results = await resolvePushAccounts({ root: "/desk", cards, runner })
  assert.equal(results.length, 1)
  assert.equal(results[0].store, "acme/widgets")
  assert.equal(results[0].result, "account_found")
  assert.equal(results[0].account, "ari")
})

test("resolvePushAccounts: a remote-mode name with no slash, and a local-mode repo with no usable clone, are reported without a network call", async () => {
  const missingLocal = path.join(await mkTempRoot("desk-boot-no-clone-"), "does-not-exist")
  const cards = [{
    track: "t", slug: "s", desk: null,
    data: {
      status: "processing",
      repos: [
        { name: "greenhouse-dashboard", local_path: "", mode: "remote" },
        { name: "watering-schedule-api", local_path: missingLocal, mode: "local" },
      ],
    },
  }]
  const runner = async () => {
    throw new Error("must not be called")
  }
  const results = await resolvePushAccounts({ root: "/desk", cards, runner })
  assert.equal(results.length, 2)
  assert.ok(results.every((entry) => entry.result === "not_a_github_repo"))
})

test("resolvePushAccounts: a local-mode repo's own git remote is read and normalized into a store", async () => {
  const origin = await mkTempRoot("desk-boot-origin-")
  spawnSync("git", ["init", "--bare", "-q"], { cwd: origin })
  const clone = await mkTempRoot("desk-boot-clone-")
  spawnSync("git", ["clone", "-q", origin, "."], { cwd: clone })
  spawnSync("git", ["remote", "set-url", "origin", "git@github.com:Acme/Widgets.git"], { cwd: clone })

  const cards = [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: "widgets", local_path: clone, mode: "local" }] } }]
  const runner = fakeGhRunner({ accounts: [{ login: "ari", active: true }], repos: { ari: { ...PUBLIC_PUSH, full_name: "acme/widgets" } } })
  const results = await resolvePushAccounts({ root: "/desk", cards, runner })
  assert.equal(results.length, 1)
  assert.equal(results[0].store, "acme/widgets")
  assert.equal(results[0].result, "account_found")
})

test("resolvePushAccounts: a local-mode repo with a blank local_path is reported without touching git", async () => {
  const cards = [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: "widgets", local_path: "  ", mode: "local" }] } }]
  const runner = async () => {
    throw new Error("must not be called")
  }
  const spawnGit = () => {
    throw new Error("git must not be called")
  }
  const results = await resolvePushAccounts({ root: "/desk", cards, runner, spawnGit })
  assert.deepEqual(results, [{ track: "t", slug: "s", repo: "widgets", result: "not_a_github_repo" }])
})

test("resolvePushAccounts: a local-mode repo whose remote is configured but blank is reported without a network call", async () => {
  const cards = [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: "widgets", local_path: "/clone", mode: "local" }] } }]
  const runner = async () => {
    throw new Error("must not be called")
  }
  const spawnGit = () => ({ status: 0, stdout: "  \n" })
  const results = await resolvePushAccounts({ root: "/desk", cards, runner, spawnGit })
  assert.deepEqual(results, [{ track: "t", slug: "s", repo: "widgets", result: "not_a_github_repo" }])
})

test("resolvePushAccounts: a local-mode repo whose remote points somewhere other than github.com is not a github repo", async () => {
  const cards = [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: "widgets", local_path: "/clone", mode: "local" }] } }]
  const spawnGit = () => ({ status: 0, stdout: "git@gitlab.com:acme/widgets.git\n" })
  const runner = async () => {
    throw new Error("must not be called")
  }
  const results = await resolvePushAccounts({ root: "/desk", cards, runner, spawnGit })
  assert.deepEqual(results, [{ track: "t", slug: "s", repo: "widgets", result: "not_a_github_repo" }])
})

test("resolvePushAccounts: a repo entry with a non-string name is labeled with a null repo, not a thrown error", async () => {
  const cards = [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: 42, local_path: "", mode: "remote" }] } }]
  const runner = async () => {
    throw new Error("must not be called")
  }
  const results = await resolvePushAccounts({ root: "/desk", cards, runner })
  assert.deepEqual(results, [{ track: "t", slug: "s", repo: null, result: "not_a_github_repo" }])
})

test("resolvePushAccounts: a crew-workspace (desk-set) task labels its entries with the desk alias", async () => {
  const cards = [{ track: "t", slug: "s", desk: "alex", data: { status: "processing", repos: [{ name: "acme/widgets", local_path: "", mode: "remote" }] } }]
  const runner = fakeGhRunner({ accounts: [{ login: "ari", active: true }], repos: { ari: PUBLIC_PUSH } })
  const results = await resolvePushAccounts({ root: "/desk", cards, runner })
  assert.equal(results.length, 1)
  assert.equal(results[0].desk, "alex")
  assert.equal(results[0].result, "account_found")
})

test("resolvePushAccounts: two tasks sharing a store make one call, not two", async () => {
  const cards = [
    { track: "t1", slug: "s1", desk: null, data: { status: "processing", repos: [{ name: "acme/widgets", local_path: "", mode: "remote" }] } },
    { track: "t2", slug: "s2", desk: null, data: { status: "collaborating", repos: [{ name: "acme/widgets", local_path: "", mode: "remote" }] } },
  ]
  let calls = 0
  const inner = fakeGhRunner({ accounts: [{ login: "ari", active: true }], repos: { ari: PUBLIC_PUSH } })
  const runner = async (args, opts) => {
    if (args[0] === "auth" && args[1] === "status") calls += 1
    return inner(args, opts)
  }
  const results = await resolvePushAccounts({ root: "/desk", cards, runner })
  assert.equal(results.length, 2)
  assert.equal(calls, 1, "the second task's identical store reuses the first result")
})

test("resolvePushAccounts: a terminal-status task's repos are not checked", async () => {
  const cards = [{ track: "t", slug: "s", desk: null, data: { status: "done", repos: [{ name: "acme/widgets", local_path: "", mode: "remote" }] } }]
  const runner = async () => {
    throw new Error("must not be called")
  }
  const results = await resolvePushAccounts({ root: "/desk", cards, runner })
  assert.deepEqual(results, [])
})

test("resolvePushAccounts: a null or non-object repos[] entry is skipped rather than crashing the scan", async () => {
  const cards = [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [null, "not-an-object"] } }]
  const runner = async () => {
    throw new Error("must not be called")
  }
  const results = await resolvePushAccounts({ root: "/desk", cards, runner })
  assert.deepEqual(results, [])
})

test("resolvePushAccounts: no account able to deliver is reported by name, and a store past the deadline is reported pending instead of blocking", async () => {
  const cards = [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: "acme/widgets", local_path: "", mode: "remote" }] } }]
  const runner = fakeGhRunner({ accounts: [{ login: "ari", active: true }], repos: { ari: 404 } })
  const refused = await resolvePushAccounts({ root: "/desk", cards, runner })
  assert.equal(refused[0].result, "no_account_can_deliver")

  const pending = await resolvePushAccounts({ root: "/desk", cards, runner, deadlineMs: 1 })
  assert.equal(pending[0].result, "pending")
  assert.equal(pending[0].reason, "boot_budget_exceeded")
})

// ── bootOnce ──────────────────────────────────────────────────────────────

function okPrereqRunners() {
  return {
    gh: fixedRunner({ "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" }, "auth status": { code: 0, stdout: "", stderr: "" } }),
    jq: fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } }),
  }
}

test("bootOnce: no desk anywhere → setup_required, with a concrete first-run action and every other field empty", async () => {
  const emptyHome = await mkTempRoot("desk-boot-once-empty-")
  const { gh, jq } = okPrereqRunners()
  const result = await bootOnce({ env: {}, cwd: emptyHome, homeDir: emptyHome, gh, jq })
  assert.equal(result.boot_complete, true)
  assert.equal(result.status, "setup_required")
  assert.equal(result.desk_export_line, null)
  assert.equal(result.active_tasks, null)
  assert.ok(result.actions[0].includes("first-run-bootstrap"))
})

test("bootOnce: a bound desk whose folder is missing → degraded, naming the path to restore", async () => {
  const emptyHome = await mkTempRoot("desk-boot-once-missing-")
  const missing = path.join(emptyHome, "gone")
  const { gh, jq } = okPrereqRunners()
  const result = await bootOnce({ env: { DESK: missing }, cwd: emptyHome, homeDir: emptyHome, gh, jq })
  assert.equal(result.status, "degraded")
  assert.ok(result.degraded.some((line) => line.startsWith("root:")))
  assert.ok(result.actions.some((line) => line.includes(missing)))
})

test("bootOnce: a healthy desk with no problems boots ready, with the export line and every field populated", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "open-task", VALID_CARD)
  const { gh, jq } = okPrereqRunners()
  const result = await bootOnce({
    env: { DESK: root },
    cwd: root,
    homeDir: root,
    gh,
    jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
  assert.equal(result.status, "ready")
  assert.deepEqual(result.degraded, [])
  assert.equal(result.desk_export_line, `export DESK=${root}`)
  assert.equal(result.active_tasks.task_count, 1)
  assert.deepEqual(result.card_validation, [])
  assert.deepEqual(result.push_accounts, [])
  assert.equal(result.sync.state, "synced")
})

test("bootOnce: a failing prereq degrades status and names a concrete remediation", async () => {
  const root = await mkDeskWorkspace()
  const gh = async () => ({ code: null, stdout: "", stderr: "", spawnError: "ENOENT" })
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const result = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
  assert.equal(result.status, "degraded")
  assert.ok(result.degraded.some((line) => line.includes("gh_missing")))
  assert.ok(result.actions.some((line) => line.includes("brew install gh")))
})

test("bootOnce: a timed-out prereq is pending, not degraded, and does not flip status by itself", async () => {
  const root = await mkDeskWorkspace()
  const gh = fixedRunner({ "--version": { code: null, stdout: "", stderr: "", timedOut: true }, "auth status": { code: 0, stdout: "", stderr: "" } })
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const result = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
  assert.equal(result.status, "ready")
  assert.ok(result.pending.some((line) => line.includes("gh_timeout")))
})

test("bootOnce: every other named prereq remediation — an old gh, a missing jq, a stale token", async () => {
  const root = await mkDeskWorkspace()
  const factoryStatusFn = () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] })
  const syncFn = async () => ({ state: "synced" })

  const oldGh = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, syncFn, factoryStatusFn,
    gh: fixedRunner({ "--version": { code: 0, stdout: "gh version 2.10.0\n", stderr: "" }, "auth status": { code: 0, stdout: "", stderr: "" } }),
    jq: fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } }),
  })
  assert.ok(oldGh.actions.some((line) => line.includes("Upgrade gh")))

  const missingJq = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, syncFn, factoryStatusFn,
    gh: fixedRunner({ "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" }, "auth status": { code: 0, stdout: "", stderr: "" } }),
    jq: async () => ({ code: null, stdout: "", stderr: "", spawnError: "ENOENT" }),
  })
  assert.ok(missingJq.actions.some((line) => line.includes("Install jq")))

  const staleAuth = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, syncFn, factoryStatusFn,
    gh: fixedRunner({
      "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" },
      "auth status": { code: 0, stdout: "The github.com token in oauth_token is no longer valid\n", stderr: "" },
    }),
    jq: fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } }),
  })
  assert.ok(staleAuth.actions.some((line) => line.includes("gh auth login")))
})

test("bootOnce: a corrupted task card degrades status and names the task, file location and handle in one action", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "corrupted-task", "title: Broken\nrepos:\n  0:\n    name: a/b\n  1:\n    name: c/d\n")
  const { gh, jq } = okPrereqRunners()
  const result = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
  assert.equal(result.status, "degraded")
  assert.equal(result.card_validation.length, 1)
  const action = result.actions.find((line) => line.includes("track-a/corrupted-task/task.md"))
  assert.ok(action, "the action names the track, slug and file")
  assert.ok(action.includes(result.card_validation[0].handle))
})

test("bootOnce: a crew-workspace (desk-set) corrupted card is located under desks/<alias>/..., and a resolved push account for it is not treated as a problem", async () => {
  const root = await mkDeskWorkspace()
  const crewCard = VALID_CARD
    .replace("status: processing", "status: not-a-status")
    .replace("repos: []", "repos:\n  - name: acme/widgets\n    local_path: \"\"\n    mode: remote")
  await writeCard(root, "track-a", "crew-task", crewCard, { desk: "alex" })
  const gh = fakeGhRunner({ accounts: [{ login: "ari", active: true }], repos: { ari: PUBLIC_PUSH } })
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const result = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
  assert.equal(result.status, "degraded")
  const action = result.actions.find((line) => line.includes("desks/alex/track-a/crew-task/task.md"))
  assert.ok(action, "the action names the crew-workspace location")
  assert.equal(result.push_accounts.length, 1)
  assert.equal(result.push_accounts[0].result, "account_found")
  assert.equal(result.push_accounts[0].desk, "alex")
  assert.ok(
    result.degraded.every((line) => !line.startsWith("push account:")),
    "a resolved push account is never itself reported as a problem",
  )
})

test("bootOnce: two or more corrupted task cards are summarized in the plural", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "corrupted-one", "title: Broken\nstatus: not-a-status\n")
  await writeCard(root, "track-a", "corrupted-two", "title: Also broken\nstatus: also-not-a-status\n")
  const { gh, jq } = okPrereqRunners()
  const result = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
  assert.equal(result.card_validation.length, 2)
  assert.ok(result.degraded.some((line) => line === "2 task cards with corrupted frontmatter"))
})

test("bootOnce: called fully bare — no desk at the isolated test HOME resolves setup_required without touching gh, jq or the network", async () => {
  const result = await bootOnce()
  assert.equal(result.boot_complete, true)
  assert.equal(result.status, "setup_required")
})

test("bootOnce: a repo no signed-in account can push degrades status and tells the agent not to push", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "push-task", VALID_CARD.replace("repos: []", "repos:\n  - name: acme/widgets\n    local_path: \"\"\n    mode: remote"))
  const gh = fakeGhRunner({ accounts: [{ login: "ari", active: true }], repos: { ari: 404 } })
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const result = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
  assert.equal(result.status, "degraded")
  assert.ok(result.degraded.some((line) => line.includes("acme/widgets")))
  const action = result.actions.find((line) => line.includes("cannot be pushed"))
  assert.ok(action && action.includes("track-a/push-task"))
})

test("bootOnce: sync states surface as actions — unresolved degrades and points at git status, quarantined stays ready and notes the review", async () => {
  const root = await mkDeskWorkspace()
  const { gh, jq } = okPrereqRunners()
  const factoryStatusFn = () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] })

  const unresolved = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, factoryStatusFn,
    syncFn: async () => ({ state: "unresolved", diagnostic: "Desk problem: ...", reason: "conflict" }),
  })
  assert.equal(unresolved.status, "degraded")
  assert.ok(unresolved.degraded.some((line) => line.includes("unresolved")))
  assert.ok(unresolved.actions.some((line) => line.includes("git status")))

  const quarantined = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, factoryStatusFn,
    syncFn: async () => ({ state: "quarantined", quarantinedPaths: ["stray.txt"] }),
  })
  assert.equal(quarantined.status, "ready")
  assert.ok(quarantined.actions.some((line) => line.includes("quarantined 1 stray path")))

  const unresolvedNoReason = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, factoryStatusFn,
    syncFn: async () => ({ state: "unresolved" }),
  })
  assert.ok(unresolvedNoReason.degraded.some((line) => line === "sync: unresolved"))

  const quarantinedNoPaths = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, factoryStatusFn,
    syncFn: async () => ({ state: "quarantined" }),
  })
  assert.ok(quarantinedNoPaths.actions.some((line) => line.includes("quarantined 0 stray path")))
})

test("bootOnce: each step's own failure degrades only that part, never the whole call", async () => {
  const root = await mkDeskWorkspace()
  const { gh, jq } = okPrereqRunners()
  const result = await bootOnce({
    env: { DESK: root },
    cwd: root,
    homeDir: root,
    gh,
    jq,
    syncFn: async () => {
      throw new Error("sync exploded")
    },
    activeTasksFn: () => {
      throw new Error("active tasks exploded")
    },
    walkFn: () => {
      throw new Error("walk exploded")
    },
    factoryStatusFn: () => {
      throw new Error("factory exploded")
    },
  })
  assert.equal(result.boot_complete, true)
  assert.equal(result.status, "degraded")
  assert.ok(result.degraded.some((line) => line.startsWith("sync:")))
  assert.ok(result.degraded.some((line) => line.startsWith("active_tasks:")))
  assert.ok(result.degraded.some((line) => line.startsWith("card_validation:")))
  assert.ok(result.degraded.some((line) => line.startsWith("factory:")))
  assert.equal(result.sync, null)
  assert.equal(result.active_tasks, null)
  assert.equal(result.factory, null)
})

test("bootOnce: a push-account step that itself throws degrades only push_accounts, never the whole call", async () => {
  const root = await mkDeskWorkspace()
  const { gh, jq } = okPrereqRunners()
  const brokenCard = {
    track: "t", slug: "s", desk: null,
    data: {
      status: "processing",
      get repos() {
        throw new Error("frontmatter read exploded")
      },
    },
  }
  const result = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    walkFn: () => [brokenCard],
  })
  assert.equal(result.status, "degraded")
  assert.ok(result.degraded.some((line) => line.startsWith("push_accounts:")))
  assert.deepEqual(result.push_accounts, [])
})

test("bootOnce: a push-account store past the wall-clock budget is pending; a gh-missing account answer is degraded by name", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "pending-push-task", VALID_CARD.replace("repos: []", "repos:\n  - name: acme/widgets\n    local_path: \"\"\n    mode: remote"))
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })

  const pending = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, jq, budgetMs: 0,
    gh: okPrereqRunners().gh,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
  assert.deepEqual(pending.push_accounts, [{ track: "track-a", slug: "pending-push-task", repo: "acme/widgets", store: "acme/widgets", result: "pending", reason: "boot_budget_exceeded" }])
  assert.ok(pending.pending.some((line) => line.includes("acme/widgets")))
  assert.equal(pending.status, "ready", "a pending push-account check alone does not degrade status")

  const ghMissing = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, jq,
    gh: async () => ({ code: null, stdout: "", stderr: "", spawnError: "ENOENT" }),
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
  assert.equal(ghMissing.status, "degraded")
  assert.ok(ghMissing.degraded.some((line) => line.includes("push account: acme/widgets") && line.includes("gh_missing")))
})

test("bootOnce: homeDir, gh and jq default to their real implementations when omitted", async () => {
  const root = await mkDeskWorkspace()
  const originalPath = process.env.PATH
  process.env.PATH = "/nonexistent-bin"
  try {
    // `gh`'s real default (`ghRunner({ env })`) threads bootOnce's own
    // `env` param into the child's spawn env, unlike `jq`'s real default
    // (`commandRunner("jq")`), which reads live `process.env` directly. An
    // `env` object with no `PATH` key at all — as opposed to one where
    // `PATH` is set to a directory with nothing in it — lets a spawned
    // child fall back to the OS's own default program search path, which
    // on some hosts still finds a real `gh` binary outside `process.env`.
    // Both must be pinned to the same nonexistent directory for `gh` and
    // `jq` to fail the same deterministic way regardless of host.
    const viaEnvHome = await bootOnce({
      env: { DESK: root, HOME: root, PATH: "/nonexistent-bin" },
      cwd: root,
      syncFn: async () => ({ state: "synced" }),
      factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    })
    assert.equal(viaEnvHome.status, "degraded")
    assert.ok(viaEnvHome.degraded.some((line) => line.includes("gh_missing")))
    assert.ok(viaEnvHome.degraded.some((line) => line.includes("jq_missing")))

    const viaOsHomedir = await bootOnce({
      env: { DESK: root, PATH: "/nonexistent-bin" },
      cwd: root,
      syncFn: async () => ({ state: "synced" }),
      factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    })
    assert.equal(viaOsHomedir.status, "degraded")
    assert.ok(viaOsHomedir.degraded.some((line) => line.includes("gh_missing")))
  } finally {
    process.env.PATH = originalPath
  }
})

// ── runBootCli ───────────────────────────────────────────────────────────

test("runBootCli: writes one line of JSON and always exits 0", async () => {
  let written = ""
  const io = { stdout: { write: (text) => { written += text } } }
  const code = await runBootCli({ env: {}, io, bootFn: async () => ({ boot_complete: true, status: "ready" }) })
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(written), { boot_complete: true, status: "ready" })
})

test("runBootCli: env and io default to the real process when omitted, writing through the real stdout", async () => {
  const originalWrite = process.stdout.write
  let written = ""
  process.stdout.write = (text) => {
    written += text
    return true
  }
  try {
    const code = await runBootCli({ bootFn: async () => ({ boot_complete: true, status: "ready" }) })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(written), { boot_complete: true, status: "ready" })
  } finally {
    process.stdout.write = originalWrite
  }
})

test("runBootCli: called fully bare, bootFn defaults to the real bootOnce — no desk at the isolated test HOME, so it still exits 0", async () => {
  const originalWrite = process.stdout.write
  const originalPath = process.env.PATH
  let written = ""
  process.stdout.write = (text) => {
    written += text
    return true
  }
  process.env.PATH = "/nonexistent-bin"
  try {
    const code = await runBootCli()
    assert.equal(code, 0)
    const result = JSON.parse(written)
    assert.equal(result.boot_complete, true)
  } finally {
    process.stdout.write = originalWrite
    process.env.PATH = originalPath
  }
})

test("runBootCli: bootOnce itself throwing still produces one complete, degraded JSON result", async () => {
  let written = ""
  const io = { stdout: { write: (text) => { written += text } } }
  const code = await runBootCli({
    env: {},
    io,
    bootFn: async () => {
      throw new Error("totally unexpected")
    },
  })
  assert.equal(code, 0)
  const result = JSON.parse(written)
  assert.equal(result.boot_complete, true)
  assert.equal(result.status, "degraded")
  assert.ok(result.degraded[0].includes("totally unexpected"))
})
