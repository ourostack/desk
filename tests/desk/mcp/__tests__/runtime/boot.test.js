// boot.js — the one-call boot script (boot-in-one-call scope items 2, 3, 4,
// 5, 6, 8, 9, 11, 13). Real filesystem fixtures for root resolution and
// card scanning; injected fake runners (shaped like `factory/flush.js`'s
// `ghRunner`/`chooseAccount` and this module's own `commandRunner`) for
// every subprocess and network-shaped call, per `account.test.js`'s
// `fakeGh` convention — nothing here reaches a real `gh`, `jq` or network.

import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { mkTempRoot } from "../_temp_roots.js"
import {
  bootOnce as realBootOnce,
  cardProblems,
  cardValidation,
  checkAuth,
  checkPrereqs,
  detectAgentHost,
  isNoninteractive,
  ENV_TOKEN_ACCOUNT,
  commandRunner,
  openPullRequests,
  parseBootArgs,
  probeHost,
  repoStates,
  resolveTaskQuery,
  withAmbientToken,
  resolveBootRoot,
  resolvePushAccounts,
  runBootCli,
  walkTaskCards,
} from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { setRuntimeResolver, setRuntimeResolverFailure } from "../../../../../plugins/desk/mcp/src/desk/runtime-resolver.js"
import { REDACTED_SEGMENT } from "../../../../../plugins/desk/mcp/src/util/redact.js"

// Every collaborator that reaches outside the process (migration Detect
// blocks, `git fetch`, `gh pr list`) is faked unless a test says otherwise;
// the tests that exercise the real defaults call `realBootOnce` directly.
function bootOnce(options = {}) {
  return realBootOnce({
    migrationsFn: async () => [],
    repoFn: () => ({ states: [], pending: [] }),
    prFn: async () => ({ prs: [], pending: [] }),
    ...options,
  })
}

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
  // cwd is a separate, non-desk folder so this exercises env:DESK winning on
  // its own merits, not the host-project/cwd fallback resolving first because
  // cwd happened to already be the desk.
  const elsewhere = await mkTempRoot("desk-boot-envdesk-cwd-")
  const result = resolveBootRoot({ env: { DESK: root }, cwd: elsewhere, homeDir: elsewhere })
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

test("resolveBootRoot: no CLAUDE_PROJECT_DIR (a Bash-spawned boot script has none), but cwd is itself a desk workspace → resolves ready via cwd, same as an agent's shell in tidy.js", async () => {
  const root = await mkDeskWorkspace()
  const emptyHome = await mkTempRoot("desk-boot-cwd-fallback-home-")
  const result = resolveBootRoot({ env: {}, cwd: root, homeDir: emptyHome })
  assert.deepEqual(result, { status: "ready", path: root, source: "host-project", binding_path: null })
})

test("resolveBootRoot: CLAUDE_PROJECT_DIR set to a desk workspace is used over a non-desk cwd, not overridden by it", async () => {
  const root = await mkDeskWorkspace()
  const emptyHome = await mkTempRoot("desk-boot-cwd-elsewhere-home-")
  const result = resolveBootRoot({ env: { CLAUDE_PROJECT_DIR: root }, cwd: emptyHome, homeDir: emptyHome })
  assert.deepEqual(result, { status: "ready", path: root, source: "host-project", binding_path: null })
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
  const result = await checkPrereqs({ gh, jq, authOptions: NO_WAIT })
  assert.equal(result.auth.ok, false)
  assert.equal(result.auth.reason, "auth_unverified", "gh gave no reason, so the sign-in is unverified, not refused")
  assert.equal(result.auth.soft, true)
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

const NO_WAIT = { sleep: async () => {} }

test("checkPrereqs: a stale token is caught even with exit code 0; a rate limit, a timeout or a plain nonzero is only unverified", async () => {
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
  assert.equal((await checkPrereqs({ gh: stale, jq, authOptions: NO_WAIT })).auth.reason, "auth_stale")
  assert.equal((await checkPrereqs({ gh: loggedOut, jq, authOptions: NO_WAIT })).auth.reason, "auth_stale")
  const limited = (await checkPrereqs({ gh: otherFailure, jq, authOptions: NO_WAIT })).auth
  assert.deepEqual([limited.reason, limited.soft, limited.why], ["auth_unverified", true, "rate limited"])
  const slow = (await checkPrereqs({ gh: timeout, jq, authOptions: NO_WAIT })).auth
  assert.deepEqual([slow.reason, slow.soft, slow.why], ["auth_unverified", true, "timed out"])
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
  assert.equal(Object.hasOwn(result, "actions"), false)
  assert.equal(Object.hasOwn(result, "desk_export_line"), false)
  assert.equal(result.active_tasks, null)
  assert.ok(result.instructions[0].includes("first-run-bootstrap"))
})

test("bootOnce: a bound desk whose folder is missing → degraded, naming the path to restore", async () => {
  const emptyHome = await mkTempRoot("desk-boot-once-missing-")
  const missing = path.join(emptyHome, "gone")
  const { gh, jq } = okPrereqRunners()
  const result = await bootOnce({ env: { DESK: missing }, cwd: emptyHome, homeDir: emptyHome, gh, jq })
  assert.equal(result.status, "degraded")
  assert.ok(result.degraded.some((line) => line.startsWith("root:")))
  assert.ok(result.instructions.some((line) => line.includes(missing)))
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
  assert.ok(result.instructions.some((line) => line.includes("brew install gh")))
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
  assert.ok(oldGh.instructions.some((line) => line.includes("Upgrade gh")))

  const missingJq = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, syncFn, factoryStatusFn,
    gh: fixedRunner({ "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" }, "auth status": { code: 0, stdout: "", stderr: "" } }),
    jq: async () => ({ code: null, stdout: "", stderr: "", spawnError: "ENOENT" }),
  })
  assert.ok(missingJq.instructions.some((line) => line.includes("Install jq")))

  const staleAuth = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, syncFn, factoryStatusFn,
    gh: fixedRunner({
      "--version": { code: 0, stdout: "gh version 2.54.0\n", stderr: "" },
      "auth status": { code: 0, stdout: "The github.com token in oauth_token is no longer valid\n", stderr: "" },
    }),
    jq: fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } }),
  })
  assert.ok(staleAuth.instructions.some((line) => line.includes("gh auth login")))
})

const AUTH_BOOT = { factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }), syncFn: async () => ({ state: "synced" }), authOptions: NO_WAIT }
const ghWith = (auth) => async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0\n", stderr: "" }
  if (args[0] === "auth") return auth(args)
  return { code: 1, stdout: "", stderr: "unexpected call" }
}
const jqOk = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })

test("auth: an offline token check that succeeds skips the online check, so a rate limit cannot fail it", async () => {
  const calls = []
  const gh = ghWith((args) => {
    calls.push(args[1])
    return args[1] === "token" ? { code: 0, stdout: "gho_secretvalue\n", stderr: "" } : { code: 1, stdout: "", stderr: "HTTP 429: rate limit exceeded" }
  })
  const result = await checkPrereqs({ gh, jq: jqOk })
  assert.deepEqual(result.auth, { ok: true })
  assert.deepEqual(calls, ["token"], "the online status call never ran")
  assert.ok(!JSON.stringify(result).includes("gho_secretvalue"), "the token is never kept")
})

test("auth: an offline check with no output is no proof of a sign-in, so the online check decides", async () => {
  const gh = ghWith((args) => (args[1] === "token" ? { code: 0 } : { code: 0, stdout: "Logged in\n", stderr: "" }))
  assert.deepEqual((await checkPrereqs({ gh, jq: jqOk })).auth, { ok: true })
})

test("auth: an offline check that timed out or could not run falls through to the online check", async () => {
  for (const offline of [{ code: null, stdout: "", stderr: "", timedOut: true }, { code: null, stdout: "", stderr: "", spawnError: "ENOENT" }, { code: 0, stdout: "tok\n", stderr: "", timedOut: true }]) {
    const gh = ghWith((args) => (args[1] === "token" ? offline : { code: 0, stdout: "Logged in\n", stderr: "" }))
    assert.deepEqual((await checkPrereqs({ gh, jq: jqOk })).auth, { ok: true })
  }
})

test("checkAuth: callable with no options, and with a custom backoff on the real timer", async () => {
  const signedIn = ghWith((args) => (args[1] === "token" ? { code: 0, stdout: "tok\n", stderr: "" } : { code: 1, stdout: "", stderr: "unused" }))
  assert.deepEqual(await checkAuth(signedIn), { ok: true })
  const flaky = ghWith((args) => (args[1] === "token" ? { code: 1, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "HTTP 429" }))
  const started = Date.now()
  const verdict = await checkAuth(flaky, { backoffMs: 20 })
  assert.equal(verdict.why, "rate limited")
  assert.ok(Date.now() - started >= 15, "it waited the backoff before the retry")
})

test("auth: a transient online failure is retried once after a backoff, and a recovery is ok", async () => {
  let statusCalls = 0
  const waits = []
  const gh = ghWith((args) => {
    if (args[1] === "token") return { code: 1, stdout: "", stderr: "no token" }
    statusCalls += 1
    return statusCalls === 1 ? { code: 1, stdout: "", stderr: "error connecting to api.github.com: dial tcp: i/o timeout" } : { code: 0, stdout: "Logged in\n", stderr: "" }
  })
  const result = await checkPrereqs({ gh, jq: jqOk, authOptions: { sleep: async (ms) => { waits.push(ms) } } })
  assert.deepEqual(result.auth, { ok: true })
  assert.equal(statusCalls, 2)
  assert.deepEqual(waits, [750])
})

test("auth: a failure that persists is a warning with its reason, never a hard stop", async () => {
  for (const [stderr, why] of [["HTTP 403: API rate limit exceeded", "rate limited"], ["dial tcp: lookup api.github.com: no such host", "network error"], ["something odd", "unrecognised gh error"]]) {
    const root = await mkDeskWorkspace()
    const gh = ghWith((args) => (args[1] === "token" ? { code: 1, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr }))
    const result = await bootOnce({ env: { DESK: root }, cwd: root, homeDir: root, gh, jq: jqOk, ...AUTH_BOOT })
    assert.ok(!result.instructions.some((line) => /Hard stop|never fall back/u.test(line)), stderr)
    assert.ok(result.pending.includes(`auth: Could not verify GitHub sign-in (${why}); continuing; pushes may fail until it clears`), result.pending.join("|"))
    assert.ok(!result.degraded.some((line) => line.startsWith("auth")))
    assert.equal(result.status, "ready")
  }
})

test("auth: real 'not logged in' output still hard-stops, naming what gh said and the fix", async () => {
  const root = await mkDeskWorkspace()
  const gh = ghWith((args) => (args[1] === "token" ? { code: 1, stdout: "", stderr: "no oauth token found for github.com" } : { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n" }))
  const result = await bootOnce({ env: { DESK: root }, cwd: root, homeDir: root, gh, jq: jqOk, ...AUTH_BOOT })
  const stop = result.instructions.find((line) => line.startsWith("Hard stop"))
  assert.match(stop, /gh auth login --hostname github\.com\b.*gh said: You are not logged into any GitHub hosts/u)
  assert.ok(result.degraded.includes("auth: auth_stale"))
})

test("auth: concurrent boots against a gh that rate limits or fails transiently never hard-stop", async () => {
  const roots = await Promise.all(Array.from({ length: 24 }, () => mkDeskWorkspace()))
  let seq = 0
  const gh = ghWith((args) => {
    if (args[1] === "token") return { code: 1, stdout: "", stderr: "" }
    seq += 1
    return seq % 3 === 0 ? { code: null, stdout: "", stderr: "", timedOut: true } : { code: 1, stdout: "", stderr: seq % 3 === 1 ? "HTTP 429: rate limit exceeded" : "connection reset by peer" }
  })
  const results = await Promise.all(roots.map((root) => bootOnce({ env: { DESK: root }, cwd: root, homeDir: root, gh, jq: jqOk, ...AUTH_BOOT })))
  assert.equal(results.length, 24)
  for (const result of results) {
    assert.ok(!result.instructions.some((line) => /Hard stop|never fall back/u.test(line)))
    assert.notEqual(result.status, "degraded")
    assert.ok(result.pending.some((line) => line.startsWith("auth: Could not verify GitHub sign-in")), "every boot says it could not verify the sign-in")
  }
  assert.ok(results.some((result) => result.pending.some((line) => line.includes("(rate limited)"))))
  assert.ok(results.some((result) => result.pending.some((line) => line.includes("(network error)"))))
})

test("auth: the worst case, a slow GitHub on every attempt, takes no longer than the one 8 s call it replaced", async () => {
  const asked = []
  const waits = []
  const gh = ghWith(() => ({ code: null, stdout: "", stderr: "", timedOut: true }))
  const runner = async (args, options) => { asked.push(options.timeoutMs); return gh(args) }
  const verdict = await checkAuth(runner, { sleep: async (ms) => { waits.push(ms) } })
  assert.equal(verdict.why, "timed out")
  assert.equal(asked.length, 3, "offline, online, one retry")
  assert.ok(asked.reduce((total, ms) => total + ms, 0) + waits.reduce((total, ms) => total + ms, 0) <= 8000, `${asked} + ${waits}`)
})

test("auth: a token GitHub revoked, or a bad GH_TOKEN, passes the offline check and then shows as a warning from the pull-request lookup, once", async () => {
  const deadline = Date.now() + 60000
  const runner = async () => ({ code: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)\n" })
  const { prs, pending } = await openPullRequests({ stores: ["acme/a", "acme/b"], runner, now: Date.now, deadline })
  assert.deepEqual(prs, [])
  assert.equal(pending.length, 1, "said once, not per repo")
  assert.match(pending[0], /^auth: GitHub rejected the sign-in gh uses \(gh said: gh: Bad credentials \(HTTP 401\)\); pushes will fail until you run `gh auth login --hostname github\.com`, or unset or replace GH_TOKEN if it is set$/u)
  const limited = await openPullRequests({ stores: ["acme/a"], runner: async () => ({ code: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded" }), now: Date.now, deadline })
  assert.deepEqual(limited.pending, [], "a rate limit is not a rejected token")
})

test("auth: a stored token rejected while the push routes were checked is a warning naming the account and the fix", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "push-task", VALID_CARD.replace("repos: []", "repos:\n  - name: acme/widgets\n    local_path: \"\"\n    mode: remote"))
  const gh = fakeGhRunner({ accounts: [{ login: "ari", active: true }], repos: { ari: 401 } })
  const result = await healthyBoot(root, { gh })
  assert.ok(result.pending.includes("auth: GitHub rejected the stored sign-in for ari; pushes as ari will fail until you run `gh auth login --hostname github.com`"), result.pending.join("|"))
  assert.ok(!result.instructions.some((line) => /Hard stop/u.test(line)))
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
  const action = result.instructions.find((line) => line.includes("track-a/corrupted-task/task.md"))
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
  const action = result.instructions.find((line) => line.includes("desks/alex/track-a/crew-task/task.md"))
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
  const result = await realBootOnce()
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
  const action = result.instructions.find((line) => line.startsWith("Do not push acme/widgets"))
  assert.ok(action && action.includes("track-a/push-task"))
})

test("bootOnce: sync states surface as instructions — unresolved degrades and points at git status, quarantined stays ready and notes the review", async () => {
  const root = await mkDeskWorkspace()
  const { gh, jq } = okPrereqRunners()
  const factoryStatusFn = () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] })

  const unresolved = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, factoryStatusFn,
    syncFn: async () => ({ state: "unresolved", diagnostic: "Desk problem: ...", reason: "conflict" }),
  })
  assert.equal(unresolved.status, "degraded")
  assert.ok(unresolved.degraded.some((line) => line.includes("unresolved")))
  assert.ok(unresolved.instructions.some((line) => line.includes("git status")))

  const quarantined = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, factoryStatusFn,
    syncFn: async () => ({ state: "quarantined", quarantinedPaths: ["stray.txt"] }),
  })
  assert.equal(quarantined.status, "ready")
  assert.ok(quarantined.instructions.some((line) => line.includes("moved stray untracked paths")))

  const unresolvedNoReason = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, factoryStatusFn,
    syncFn: async () => ({ state: "unresolved" }),
  })
  assert.ok(unresolvedNoReason.degraded.some((line) => line === "sync: unresolved"))

  const quarantinedNoPaths = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, factoryStatusFn,
    syncFn: async () => ({ state: "quarantined" }),
  })
  assert.ok(quarantinedNoPaths.instructions.some((line) => line.includes("moved stray untracked paths")))
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
    const viaEnvHome = await realBootOnce({
      env: { DESK: root, HOME: root, PATH: "/nonexistent-bin" },
      cwd: root,
      migrationsFn: async () => [],
      syncFn: async () => ({ state: "synced" }),
      factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    })
    assert.equal(viaEnvHome.status, "degraded")
    assert.ok(viaEnvHome.degraded.some((line) => line.includes("gh_missing")))
    assert.ok(viaEnvHome.degraded.some((line) => line.includes("jq_missing")))

    const viaOsHomedir = await realBootOnce({
      env: { DESK: root, PATH: "/nonexistent-bin" },
      cwd: root,
      migrationsFn: async () => [],
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
  const code = await runBootCli({ argv: ["--json"], env: {}, io, bootFn: async () => ({ boot_complete: true, status: "ready" }) })
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
    const code = await runBootCli({ argv: ["--json"], bootFn: async () => ({ boot_complete: true, status: "ready" }) })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(written), { boot_complete: true, status: "ready" })
  } finally {
    process.stdout.write = originalWrite
  }
})

test("runBootCli: bootFn defaults to the real bootOnce — no desk at the isolated test HOME, so it still exits 0", async () => {
  const originalPath = process.env.PATH
  let written = ""
  const io = { stdout: { write: (text) => { written += text } } }
  process.env.PATH = "/nonexistent-bin"
  try {
    const code = await runBootCli({ argv: ["--json"], io })
    assert.equal(code, 0)
    const result = JSON.parse(written)
    assert.equal(result.boot_complete, true)
  } finally {
    process.env.PATH = originalPath
  }
})

test("runBootCli: bootOnce itself throwing still produces one complete, degraded JSON result", async () => {
  let written = ""
  const io = { stdout: { write: (text) => { written += text } } }
  const code = await runBootCli({
    argv: ["--json"],
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

// ── Token-only hosts (GH_TOKEN, no keyring login) ────────────────────────

test("checkPrereqs: the auth check uses its own ambient-env runner, so a GH_TOKEN-only host is healthy", async () => {
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const stripped = fixedRunner({
    "--version": { code: 0, stdout: VERSION_OK, stderr: "" },
    "auth status": { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts\n" },
  })
  const ambient = fixedRunner({ "auth status": { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account GH_TOKEN (GH_TOKEN)\n", stderr: "" } })
  assert.equal((await checkPrereqs({ gh: stripped, jq })).auth.reason, "auth_stale")
  assert.equal((await checkPrereqs({ gh: stripped, jq, ghAuth: ambient })).auth.ok, true)
})

test("withAmbientToken: without a token in the environment the runner is returned untouched", () => {
  const runner = async () => ({ code: 0, stdout: "", stderr: "" })
  assert.equal(withAmbientToken(runner, {}), runner)
  assert.equal(withAmbientToken(runner, { GH_TOKEN: "   " }), runner)
})

test("withAmbientToken: a token-only host answers as one account, env-token, whose token is the ambient one", async () => {
  const noAccounts = async () => ({ code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts\n" })
  for (const env of [{ GH_TOKEN: "ghp_abc" }, { GITHUB_TOKEN: "ghp_abc" }]) {
    const runner = withAmbientToken(noAccounts, env)
    const status = await runner(["auth", "status", "--hostname", "github.com"])
    assert.match(status.stdout, new RegExp(`Logged in to github.com account ${ENV_TOKEN_ACCOUNT}`, "u"))
    assert.equal((await runner(["auth", "token", "--user", ENV_TOKEN_ACCOUNT])).stdout.trim(), "ghp_abc")
  }
})

test("withAmbientToken: accounts gh itself lists, and other calls, pass through unchanged", async () => {
  const listed = async (args) => (args[0] === "auth" && args[1] === "status"
    ? { code: 0, stdout: "  ✓ Logged in to github.com account ari (keyring)\n", stderr: "" }
    : { code: 0, stdout: `other:${args.join(" ")}`, stderr: "" })
  const runner = withAmbientToken(listed, { GH_TOKEN: "ghp_abc" })
  assert.match((await runner(["auth", "status"])).stdout, /account ari/u)
  assert.equal((await runner(["auth", "token", "--user", "ari"])).stdout, "other:auth token --user ari")
  assert.equal((await runner(["api", "x"])).stdout, "other:api x")
})

test("bootOnce: a host signed in only through GH_TOKEN is not auth_stale, and its one account can push", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "push-task", VALID_CARD.replace("repos: []", "repos:\n  - name: acme/widgets\n    local_path: \"\"\n    mode: remote"))
  // The factory runner strips ambient tokens, so it sees no keyring login at all.
  const gh = async (args, { token } = {}) => {
    if (args[0] === "--version") return { code: 0, stdout: VERSION_OK, stderr: "" }
    if (args[0] === "auth" && args[1] === "status") return { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts\n" }
    if (args[0] === "api") return { code: 0, stdout: JSON.stringify(token === "ghp_abc" ? PUBLIC_PUSH : {}), stderr: "" }
    return { code: 1, stdout: "", stderr: "unexpected call" }
  }
  const ghAuth = fixedRunner({ "auth status": { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account someone (GH_TOKEN)\n", stderr: "" } })
  const jq = fixedRunner({ "--version": { code: 0, stdout: "jq-1.7\n", stderr: "" } })
  const result = await bootOnce({
    env: { DESK: root, GH_TOKEN: "ghp_abc" }, cwd: root, homeDir: root, gh, ghAuth, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
  assert.equal(result.status, "ready", JSON.stringify(result.degraded))
  assert.equal(result.prereqs.auth.ok, true)
  assert.equal(result.push_accounts[0].result, "account_found")
  assert.equal(result.push_accounts[0].account, ENV_TOKEN_ACCOUNT)
})

// ── Card validation: Date timestamps and the dependency-free parser ──────

test("cardProblems: unquoted timestamps (parsed as Dates) are valid; an invalid Date is reported", () => {
  const card = { schema_version: 1, title: "T", status: "processing", created: new Date("2026-01-01T00:00:00Z"), updated: new Date("2026-01-02T00:00:00Z"), track: "t", repos: [] }
  assert.deepEqual(cardProblems(card), [])
  const bad = cardProblems({ ...card, updated: new Date("nope") })
  assert.deepEqual(bad, ["`updated` is not a parseable timestamp"])
})

test("cardProblems: with nested:false (no gray-matter), repos is not judged", () => {
  const card = { schema_version: 1, title: "T", status: "processing", created: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z", track: "t", repos: null }
  assert.deepEqual(cardProblems(card, { nested: false }), [])
  assert.deepEqual(cardProblems(card), ["`repos` is missing or not a list"])
})

test("card validation reads a card with unquoted timestamps and a repos list as healthy, end to end", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "unquoted", VALID_CARD.replace("'2026-01-01T00:00:00Z'", "2026-01-01T00:00:00Z").replace("'2026-01-02T00:00:00Z'", "2026-01-02T00:00:00Z").replace("repos: []", "repos:\n  - name: acme/widgets\n    local_path: \"\"\n    mode: remote"))
  assert.deepEqual(cardValidation(root), [])
})

test("bootOnce: without gray-matter the repos lists are not validated, and the result says so instead of flagging every card", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "open-task", VALID_CARD)
  const { gh, jq } = okPrereqRunners()
  const lite = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, nestedCards: false,
    walkFn: () => [{ track: "track-a", slug: "open-task", desk: null, file: path.join(root, "track-a", "open-task", "task.md"), data: { title: "T", status: "processing", created: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z", track: "t", repos: null } }],
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
  assert.equal(lite.status, "ready")
  assert.equal(lite.card_parser, "lite")
  assert.deepEqual(lite.card_validation, [])
  assert.ok(lite.pending.some((line) => line.startsWith("card repos: not validated")))
})

test("bootOnce: when restoring the runtime dependencies failed, the not-validated line says why", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "open-task", VALID_CARD)
  const { gh, jq } = okPrereqRunners()
  setRuntimeResolverFailure("no runtime pack for linux-x64-node-999")
  try {
    const lite = await bootOnce({
      env: { DESK: root }, cwd: root, homeDir: root, gh, jq, nestedCards: false,
      walkFn: () => [],
      syncFn: async () => ({ state: "synced" }),
      factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    })
    assert.ok(lite.pending.some((line) => line.startsWith("card repos: not validated") && line.includes("restoring the runtime dependencies failed: no runtime pack for linux-x64-node-999")))
  } finally {
    setRuntimeResolver(null)
  }
})

// ── detectAgentHost, parseBootArgs ───────────────────────────────────────

test("detectAgentHost: names the covered host from its own variables, unknown otherwise", () => {
  assert.equal(detectAgentHost({ CLAUDE_PLUGIN_ROOT: "/x" }), "claude")
  assert.equal(detectAgentHost({ CODEX_HOME: "/x" }), "codex")
  assert.equal(detectAgentHost({ COPILOT_CLI: "1" }), "copilot")
  assert.equal(detectAgentHost({}), "unknown")
  // A Copilot session started from a Claude Code shell inherits CLAUDECODE; Copilot's own session id wins.
  assert.equal(detectAgentHost({ CLAUDECODE: "1", COPILOT_AGENT_SESSION_ID: "s" }), "copilot")
  assert.equal(detectAgentHost({ CLAUDECODE: "1" }), "claude")
})

test("parseBootArgs: --task takes the next argument; a missing or blank value is no task", () => {
  assert.deepEqual(parseBootArgs([]), { taskQuery: null, json: false })
  assert.deepEqual(parseBootArgs(["--task", "faster-desk"]), { taskQuery: "faster-desk", json: false })
  assert.deepEqual(parseBootArgs(["--task"]), { taskQuery: null, json: false })
  assert.deepEqual(parseBootArgs(["--task", "  "]), { taskQuery: null, json: false })
  assert.deepEqual(parseBootArgs(["--json", "--task", "x"]), { taskQuery: "x", json: true })
})

test("runBootCli: --task reaches bootOnce as taskQuery", async () => {
  let seen = null
  const io = { stdout: { write: () => {} } }
  await runBootCli({ argv: ["--task", "x/y"], env: {}, io, bootFn: async (options) => { seen = options; return {} } })
  assert.equal(seen.taskQuery, "x/y")
})

// ── resolveTaskQuery ─────────────────────────────────────────────────────

async function taskFixture() {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "faster-desk-flow", VALID_CARD.replace("Example task", "Faster desk PR flow"))
  await writeCard(root, "track-a", "faster-builds", VALID_CARD.replace("Example task", "Faster builds"))
  await writeCard(root, "track-b", "old-one", VALID_CARD.replace("status: processing", "status: done"))
  await writeCard(root, "track-b", "untitled", VALID_CARD.replace("title: Example task\n", ""))
  await writeCard(root, "track-d", "no-status", VALID_CARD.replace("status: processing\n", ""))
  await writeCard(root, "track-c", "crew-one", VALID_CARD, { desk: "alex" })
  return { root, cards: walkTaskCards(root) }
}

test("resolveTaskQuery: an exact slug, track/slug, title or handle resolves one open task with its card path", async () => {
  const { root, cards } = await taskFixture()
  const bySlug = resolveTaskQuery("faster-desk-flow", cards, root)
  assert.equal(bySlug.status, "resolved")
  assert.equal(bySlug.task.card, "track-a/faster-desk-flow/task.md")
  assert.equal(resolveTaskQuery("TRACK-A/faster-builds", cards, root).task.slug, "faster-builds")
  assert.equal(resolveTaskQuery("Faster desk PR flow", cards, root).task.slug, "faster-desk-flow")
  assert.equal(resolveTaskQuery(bySlug.task.handle, cards, root).task.slug, "faster-desk-flow")
  const crew = resolveTaskQuery("crew-one", cards, root)
  assert.equal(crew.task.card, "desks/alex/track-c/crew-one/task.md")
  assert.equal(crew.task.desk, "alex")
})

test("resolveTaskQuery: a unique substring resolves; several are ambiguous; none, blank and finished tasks are not found", async () => {
  const { root, cards } = await taskFixture()
  assert.equal(resolveTaskQuery("desk-flow", cards, root).task.slug, "faster-desk-flow")
  const ambiguous = resolveTaskQuery("faster", cards, root)
  assert.equal(ambiguous.status, "ambiguous")
  assert.equal(ambiguous.candidates.length, 2)
  assert.equal(resolveTaskQuery("nothing-like-this", cards, root).status, "not_found")
  assert.equal(resolveTaskQuery("  ", cards, root).status, "not_found")
  assert.equal(resolveTaskQuery("old-one", cards, root).status, "not_found")
  assert.equal(resolveTaskQuery("untitled", cards, root).task.title, null)
  assert.equal(resolveTaskQuery("no-status", cards, root).task.status, null)
})

// ── repoStates, openPullRequests ─────────────────────────────────────────

test("repoStates: fetches and reports branch and dirty state for each local repo of an open task, skipping everything else", () => {
  const calls = []
  const spawnGit = (cmd, args) => {
    calls.push(args.join(" "))
    if (args.includes("fetch")) return { status: args[1] === "/clones/stale" ? 1 : 0, stdout: "" }
    if (args[1] === "/clones/gone") return { status: 128, stdout: "" }
    if (args[1] === "/clones/empty") return { status: 0, stdout: "" }
    return { status: 0, stdout: args[1] === "/clones/dirty" ? "## feature...origin/feature\n M file\n" : "## main...origin/main\n" }
  }
  const open = (repos) => ({ track: "t", slug: "s", desk: null, data: { status: "processing", repos } })
  const local = (name, dir) => ({ name, local_path: dir, mode: "local" })
  const cards = [
    open([local("clean", "/clones/clean"), local("dirty", "/clones/dirty"), local("stale", "/clones/stale"), local("gone", "/clones/gone"), local("empty", "/clones/empty")]),
    open([{ name: "remote-only", local_path: "", mode: "remote" }, { name: "no-path", mode: "local" }, null]),
    { track: "t", slug: "done", desk: null, data: { status: "done", repos: [local("finished", "/clones/clean")] } },
    { track: "t", slug: "no-repos", desk: null, data: { status: "processing" } },
  ]
  const { states, pending } = repoStates({ cards, spawnGit, now: () => 0, deadline: 60000 })
  assert.deepEqual(pending, [])
  assert.equal(states.find((state) => state.repo === "gone").local_path, "/clones/gone")
  assert.deepEqual(states.map((state) => [state.repo, state.present, state.branch, state.dirty, state.fetched]), [
    ["clean", true, "main", false, true],
    ["dirty", true, "feature", true, true],
    ["stale", true, "main", false, false],
    ["gone", false, undefined, undefined, undefined],
    ["empty", true, null, false, true],
  ])
  assert.ok(calls.includes("-C /clones/clean fetch --quiet origin"))
})

test("repoStates: a repo past the wall-clock deadline is pending, not fetched", () => {
  const cards = [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: "late", local_path: "/clones/late", mode: "local" }] } }]
  const spawnGit = () => assert.fail("must not run git past the deadline")
  const { states, pending } = repoStates({ cards, spawnGit, now: () => 100, deadline: 101 })
  assert.deepEqual(states, [])
  assert.match(pending[0], /repo state for late \(t\/s\): boot_budget_exceeded/u)
})

test("repoStates: the real git defaults read a real clone's branch and dirty state", async () => {
  const dir = await mkTempRoot("desk-boot-real-clone-")
  spawnSync("git", ["init", "-q", "-b", "main", dir])
  const cards = [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos: [{ name: "real", local_path: dir, mode: "local" }] } }]
  const { states } = repoStates({ cards, now: Date.now, deadline: Date.now() + 60000 })
  assert.equal(states[0].present, true)
  assert.equal(states[0].branch, "main")
  assert.equal(states[0].fetched, false)
})

test("openPullRequests: lists each store's open pull requests, and reports a slow store as pending", async () => {
  const runner = async (args) => {
    const store = args[3]
    if (store === "a/slow") return { code: null, stdout: "", stderr: "", timedOut: true }
    if (store === "a/err") return { code: 1, stdout: "", stderr: "boom" }
    if (store === "a/junk") return { code: 0, stdout: "not json", stderr: "" }
    if (store === "a/obj") return { code: 0, stdout: "{}", stderr: "" }
    return { code: 0, stdout: JSON.stringify([{ number: 7, title: "Fix it", url: "https://x/7", isDraft: true, reviewDecision: "APPROVED" }, { number: 8, url: "https://x/8" }]), stderr: "" }
  }
  const { prs, pending } = await openPullRequests({ stores: ["a/ok", "a/slow", "a/err", "a/junk", "a/obj"], runner, now: () => 0, deadline: 60000 })
  assert.deepEqual(prs, [
    { store: "a/ok", number: 7, title: "Fix it", url: "https://x/7", draft: true, review: "APPROVED" },
    { store: "a/ok", number: 8, title: "", url: "https://x/8", draft: false, review: null },
  ])
  assert.deepEqual(pending, ["open pull requests for a/slow: timeout"])
})

test("openPullRequests: past the deadline nothing is asked", async () => {
  const { prs, pending } = await openPullRequests({ stores: ["a/late"], runner: () => assert.fail("no call"), now: () => 100, deadline: 101 })
  assert.deepEqual(prs, [])
  assert.deepEqual(pending, ["open pull requests for a/late: boot_budget_exceeded"])
})

// ── bootOnce: migrations, named task, instructions, budget ───────────────

function healthyBoot(root, extra = {}) {
  const { gh, jq } = okPrereqRunners()
  return bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    ...extra,
  })
}

test("bootOnce: the tool-loading line names the tools the host really exposes (Copilot: desk-<name>, Claude Code: mcp__plugin_desk_desk__<name>)", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "open-task", VALID_CARD)
  const lineFor = async (env) => (await healthyBoot(root, { env: { DESK: root, ...env } })).instructions.find((line) => /defers tools|named `desk-<name>`/u.test(line))
  const copilot = await lineFor({ COPILOT_AGENT_SESSION_ID: "s" })
  assert.match(copilot, /`desk-task_update`/u)
  assert.doesNotMatch(copilot, /ToolSearch|mcp__plugin_desk_desk__/u)
  const claude = await lineFor({ CLAUDECODE: "1" })
  assert.match(claude, /ToolSearch `select:mcp__plugin_desk_desk__task_update/u)
  assert.doesNotMatch(claude, /desk-task_update/u)
})

test("bootOnce: a healthy boot lists instructions (export line, MCP check, status block) and the covered hosts", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "open-task", VALID_CARD)
  const result = await healthyBoot(root)
  assert.deepEqual(result.covers_hosts, ["claude", "copilot", "codex"])
  assert.ok(result.instructions.some((line) => line.includes(`Use the absolute path ${root} for the desk`) && !line.includes("export DESK=")))
  // The old ceremony is gone: no "confirm desk_status" step and no "read AGENTS.md" step (the text carries AGENTS.md itself).
  assert.ok(result.instructions.some((line) => line.startsWith("If your host defers tools") && line.includes("ToolSearch `select:") && line.includes("mcp__plugin_desk_desk__task_update")))
  assert.ok(!result.instructions.some((line) => /Confirm this session can call/u.test(line)))
  assert.ok(result.instructions.some((line) => line.startsWith("No task was named")))
  // Plain text names the printed section; the structured instructions keep the field names.
  assert.ok(result.instructions.some((line) => /active_tasks, open_prs and repo_states/u.test(line)))
  const printed = formatBootText(result)
  assert.match(printed, /No task was named: report every task under "Active tasks" above/u)
  assert.doesNotMatch(printed, /active_tasks, open_prs|repo_states/u)
  await fs.writeFile(path.join(root, "AGENTS.md"), "rules\n")
  const withAgents = await healthyBoot(root)
  assert.ok(!withAgents.instructions.some((line) => /AGENTS\.md/u.test(line)))
  assert.deepEqual(withAgents.agents_md, { path: path.join(root, "AGENTS.md"), text: "rules\n", truncated: false, bytes: 6, shownBytes: 6 })
  assert.match(result.instructions.at(-1), /hosts/u)
  assert.equal(result.task, null)
  const claude = await healthyBoot(root, { env: { DESK: root, CLAUDECODE: "1" } })
  assert.match(claude.instructions.at(-1), /looks like claude/u)
})

test("bootOnce: --task resolves the named task, hands off to session-resumption, and asks for a Host-line update only when the host differs", async () => {
  const root = await mkDeskWorkspace()
  const dir = await writeCard(root, "track-a", "open-task", VALID_CARD)
  const same = await healthyBoot(root, { taskQuery: "open-task" })
  assert.equal(same.task.status, "resolved")
  assert.equal(same.task.host_line_changed, false)
  assert.ok(same.instructions.some((line) => line.includes("desk:session-resumption") && line.includes("track-a/open-task/task.md")))
  assert.ok(!same.instructions.some((line) => line.includes("Host line")))
  await fs.writeFile(path.join(dir, "task.md"), `---\n${VALID_CARD}\n---\n\nHost: \`other-machine\` / user: \`x\`\n`)
  const changed = await healthyBoot(root, { taskQuery: "open-task" })
  assert.equal(changed.task.host_line_changed, true)
  assert.ok(changed.instructions.some((line) => line.includes("Host line names a different host")))
  await fs.writeFile(path.join(dir, "task.md"), `---\n${VALID_CARD}\n---\n\nHost: \`${changed.host.hostname}\` / user: \`x\`\n`)
  assert.equal((await healthyBoot(root, { taskQuery: "open-task" })).task.host_line_changed, false)
  const unreadable = await healthyBoot(root, { taskQuery: "open-task", walkFn: () => [{ track: "track-a", slug: "open-task", desk: null, file: path.join(dir, "missing.md"), data: { status: "processing" } }] })
  assert.equal(unreadable.task.host_line_changed, false)
})

test("bootOnce: the named task's missing local clone becomes an instruction; another task's missing clone does not", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "open-task", VALID_CARD)
  const states = [
    { track: "track-a", slug: "open-task", repo: "acme/widgets", local_path: "~/code/widgets", present: false },
    { track: "track-a", slug: "open-task", repo: "present-one", local_path: "~/code/p", present: true },
    { track: "track-a", slug: "other-task", repo: "elsewhere", local_path: "~/code/e", present: false },
  ]
  const result = await healthyBoot(root, { taskQuery: "open-task", repoFn: () => ({ states, pending: [] }) })
  const lines = result.instructions.filter((line) => line.includes("is not at its recorded path"))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /acme\/widgets.*~\/code\/widgets.*gh repo clone/u)
})

test("bootOnce: an ambiguous or unknown --task is reported in instructions, not guessed", async () => {
  const { root } = await taskFixture()
  const ambiguous = await healthyBoot(root, { taskQuery: "faster" })
  assert.equal(ambiguous.task.status, "ambiguous")
  assert.ok(ambiguous.instructions.some((line) => line.includes("more than one open task")))
  const missing = await healthyBoot(root, { taskQuery: "zzz-none" })
  assert.equal(missing.task.status, "not_found")
  assert.ok(missing.instructions.some((line) => line.includes("matches no open task")))
})

test("bootOnce: migrations run first; a pending one that needs a restart stops boot before the desk is touched", async () => {
  const root = await mkDeskWorkspace()
  let synced = false
  const result = await healthyBoot(root, {
    migrationsFn: async () => [{ id: "01-move", state: "restart", description: "moves the desk" }],
    syncFn: async () => { synced = true; return { state: "synced" } },
  })
  assert.equal(synced, false)
  assert.equal(result.status, "degraded")
  assert.deepEqual(result.migrations, [{ id: "01-move", state: "restart" }])
  assert.match(result.instructions[0], /01-move is pending/u)
  assert.ok(result.degraded.some((line) => line.includes("needs a restart")))
  const cannotRun = await healthyBoot(root, { migrationsFn: async () => [{ id: "03-x", state: "run", reason: "its Migrate failed" }] })
  assert.ok(cannotRun.degraded.some((line) => line.includes("its Migrate failed")))
})

test("bootOnce: agent-work, unchecked and ran migrations become instructions while boot continues", async () => {
  const root = await mkDeskWorkspace()
  const result = await healthyBoot(root, {
    migrationsFn: async () => [
      { id: "02-tidy", state: "agent_work" },
      { id: "04-slow", state: "unchecked" },
      { id: "05-done", state: "ran", report: "moved it", announce: "Tell them." },
    ],
  })
  assert.equal(result.status, "ready")
  assert.ok(result.pending.includes("migration 04-slow: not checked in time"))
  assert.ok(result.instructions.some((line) => line.startsWith("02-tidy is pending")))
  assert.ok(result.instructions.some((line) => line.startsWith("05-done ran at startup")))
})

test("bootOnce: a migration check that throws degrades only itself", async () => {
  const root = await mkDeskWorkspace()
  const result = await healthyBoot(root, { migrationsFn: async () => { throw new Error("registry down") } })
  assert.ok(result.degraded.includes("migrations: registry down"))
  assert.equal(result.active_tasks.task_count, 0)
})

test("bootOnce: setup_required and a missing bound desk each come back with their own instruction", async () => {
  const emptyHome = await mkTempRoot("desk-boot-instr-home-")
  const setup = await bootOnce({ env: {}, cwd: emptyHome, homeDir: emptyHome })
  assert.equal(setup.status, "setup_required")
  assert.match(setup.instructions[0], /first run, not an outage/u)
  const missing = await bootOnce({ env: { DESK: path.join(emptyHome, "gone") }, cwd: emptyHome, homeDir: emptyHome })
  assert.equal(missing.status, "degraded")
  assert.match(missing.instructions[0], /Never use a different desk to work around this/u)
})

test("bootOnce: prereq, sync, card and push-account problems each become one plain instruction", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "bad-card", "title: broken")
  await writeCard(root, "track-a", "push-task", VALID_CARD.replace("repos: []", "repos:\n  - name: acme/widgets\n    local_path: \"\"\n    mode: remote"))
  const gh = fakeGhRunner({ accounts: [{ login: "ari", active: true }], repos: { ari: 404 } })
  const ghAuth = fixedRunner({ "auth status": { code: null, stdout: "", stderr: "", timedOut: true } })
  const jq = fixedRunner({ "--version": { code: null, stdout: "", stderr: "", spawnError: "ENOENT" } })
  const result = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, ghAuth, jq,
    syncFn: async () => ({ state: "unresolved" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
  })
  const text = result.instructions.join("\n")
  assert.match(text, /Hard stop: Install jq/u)
  assert.doesNotMatch(text, /auth_timeout/u)
  assert.match(text, /git sync is unresolved/u)
  assert.match(text, /Fix the frontmatter of track-a\/bad-card\/task\.md/u)
  assert.match(text, /Do not push acme\/widgets/u)
  const quarantined = await healthyBoot(root, { syncFn: async () => ({ state: "quarantined" }) })
  assert.ok(quarantined.instructions.some((line) => line.includes("Sync moved stray untracked paths")))
})

const UNDECIDED = () => ({ store: "ourostack/factory-intake", source: "x", consent: "undecided", stores: [], warnings: [] })

test("isNoninteractive: headless Claude Code, an unattended session and CI runners are noninteractive; everything else is not", () => {
  assert.equal(isNoninteractive({ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }), true)
  assert.equal(isNoninteractive({ CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "0" }), true)
  assert.equal(isNoninteractive({ CI: "true" }), true)
  assert.equal(isNoninteractive({ GITHUB_ACTIONS: "1" }), true)
  assert.equal(isNoninteractive({ CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1" }), false)
  assert.equal(isNoninteractive({ CI: "false" }), false)
  assert.equal(isNoninteractive({}), false)
})

test("bootOnce: undecided factory consent, interactive, is raised only after the work, as one short line, never first", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "open-task", VALID_CARD)
  const result = await healthyBoot(root, { taskQuery: "open-task", factoryStatusFn: UNDECIDED })
  const text = result.instructions.join("\n")
  assert.match(text, /never comes before the work the operator asked for, and never instead of it: do that work first/u)
  assert.match(text, /at most once, as one short line at the end of your reply/u)
  assert.match(text, /factory\.js account --store ourostack\/factory-intake/u)
  assert.match(text, /consent --store ourostack\/factory-intake --contribute yes --account <login>/u)
  assert.match(text, /Contribute\? \(yes or no\)/u)
  const handoff = result.instructions.findIndex((line) => line.includes("desk:session-resumption"))
  const consent = result.instructions.findIndex((line) => line.startsWith("Factory consent is undecided"))
  assert.ok(handoff !== -1 && consent > handoff, "the resume hand-off comes before any consent instruction")
})

test("bootOnce: the text boot gives undecided factory consent as one short line last, pointing at the script; --json keeps the long instructions", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "open-task", VALID_CARD)
  const result = await healthyBoot(root, { factoryStatusFn: UNDECIDED })
  const plain = result.text_instructions
  assert.equal(plain.filter((line) => /[Ff]actory consent/u.test(line)).length, 1, "one consent line in the text boot")
  assert.match(plain.at(-1), /^Factory consent is undecided for ourostack\/factory-intake\. Only after the operator's work is done, and only if they are in the conversation, end your reply with one line: "Desk can contribute measurement data about your finished tasks to ourostack\/factory-intake; want the details\?" Ask nothing else and ask once\. If they say yes, follow "Factory consent" in .*skills.session-start.details\.md; the script is `node [^`]*mcp.scripts.factory\.js`\.$/u)
  assert.doesNotMatch(plain.join("\n"), /consent --store|Contribute\? \(yes or no\)|account_found/u, "the script is behind the pointer")
  assert.ok(result.instructions.some((line) => /consent --store ourostack\/factory-intake --contribute yes/u.test(line)), "--json keeps the script")
  const printed = formatBootText(result)
  assert.equal(printed.split("Factory consent is undecided").length, 2)
  const decided = await healthyBoot(root)
  assert.ok(!decided.text_instructions.some((line) => /[Ff]actory consent/u.test(line)))
})

test("bootOnce: the text boot folds the rules into short closing wording, drops the host list, and keeps the tool hint", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "open-task", VALID_CARD)
  const result = await healthyBoot(root, { env: { DESK: root, COPILOT_AGENT_SESSION_ID: "s" } })
  const plain = result.text_instructions
  assert.ok(plain.length < result.instructions.length, "fewer instructions in the text boot")
  assert.match(plain[0], new RegExp(`^Use ${root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} as the desk path in every command and tool call`, "u"))
  assert.ok(plain.some((line) => /`desk-task_update`/u.test(line)), "the host's tool names stay")
  assert.ok(!plain.some((line) => /hosts/u.test(line)))
  assert.match(plain.at(-1), /^In every reply: if the next step needs something that is not on this machine .* say what is missing and stop, and never recreate or simulate it; .* say 'done' only for a task whose status is done; do not print Desk skill step headings\.$/u)
})

test("bootOnce: undecided factory consent in a noninteractive session emits no consent instruction at all", async () => {
  const root = await mkDeskWorkspace()
  const result = await healthyBoot(root, { env: { DESK: root, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, factoryStatusFn: UNDECIDED })
  assert.ok(!result.instructions.some((line) => /[Ff]actory consent|consent --store/u.test(line)))
})

test("bootOnce: a sync that outlives the budget is pending, not a hang", async () => {
  const root = await mkDeskWorkspace()
  const result = await healthyBoot(root, { budgetMs: 30, syncFn: () => new Promise(() => {}) })
  assert.ok(result.pending.includes("sync: boot_budget_exceeded"))
  assert.equal(result.sync, null)
})

test("bootOnce: a repo-state or open-PR step that throws degrades only itself; found PRs and repo states reach the result", async () => {
  const root = await mkDeskWorkspace()
  const broken = await healthyBoot(root, { repoFn: () => { throw new Error("git gone") }, prFn: async () => { throw new Error("gh gone") } })
  assert.ok(broken.degraded.includes("repo_states: git gone"))
  assert.ok(broken.degraded.includes("open_prs: gh gone"))
  const found = await healthyBoot(root, {
    repoFn: () => ({ states: [{ repo: "r", branch: "main" }], pending: ["late"] }),
    prFn: async () => ({ prs: [{ number: 1 }], pending: ["also late"] }),
  })
  assert.deepEqual(found.repo_states, [{ repo: "r", branch: "main" }])
  assert.deepEqual(found.open_prs, [{ number: 1 }])
  assert.ok(found.pending.includes("late") && found.pending.includes("also late"))
})

test("bootOnce: open-PR lookup is asked only for the GitHub repos the push-account step resolved", async () => {
  const root = await mkDeskWorkspace()
  await writeCard(root, "track-a", "push-task", VALID_CARD.replace("repos: []", "repos:\n  - name: acme/widgets\n    local_path: \"\"\n    mode: remote\n  - name: not-github\n    local_path: \"\"\n    mode: remote"))
  let asked = null
  const gh = fakeGhRunner({ accounts: [{ login: "ari", active: true }], repos: { ari: PUBLIC_PUSH } })
  await healthyBoot(root, { gh, prFn: async ({ stores }) => { asked = stores; return { prs: [], pending: [] } } })
  assert.deepEqual(asked, ["acme/widgets"])
})

// ---------------------------------------------------------------------------
// scripts/session-boot.js — the one-line CLI entry point itself, run for
// real as a subprocess (the same pattern scripts/session-sync.js's own test
// uses). Pointed at an empty HOME with every root-naming env var cleared, it
// settles into "setup_required" immediately — bootOnce's own early return
// means no gh, jq, sync or network call ever fires — so this is a fast,
// side-effect-free way to exercise the actual shipped file's own single
// statement.
// ---------------------------------------------------------------------------

test("scripts/session-boot.js runs the command line for real, as a subprocess", async () => {
  const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-boot.js", import.meta.url))
  const emptyHome = await mkTempRoot("desk-boot-script-home-")
  const stdout = execFileSync(process.execPath, [SCRIPT, "--json"], {
    encoding: "utf8",
    cwd: emptyHome,
    env: {
      ...process.env,
      HOME: emptyHome,
      DESK: "",
      CLAUDE_PROJECT_DIR: "",
      DESK_ACTIVATION_CONFIG: "",
      CODEX_HOME: "",
      CLAUDE_PLUGIN_DATA: "",
    },
  })
  const result = JSON.parse(stdout)
  assert.equal(result.boot_complete, true)
  assert.equal(result.status, "setup_required")
})

test("a relative local_path resolves against the desk root in repoStates and resolvePushAccounts, after ~ expansion", async () => {
  const deskRoot = await mkTempRoot("desk-boot-rel-root-")
  const seen = []
  const spawnGit = (cmd, args) => {
    seen.push(args[1])
    return { status: 0, stdout: args.includes("config") ? "https://github.com/acme/widgets.git\n" : "## main...origin/main\n" }
  }
  const repos = [{ name: "w", local_path: "clones/w", mode: "local" }, { name: "h", local_path: "~/h", mode: "local" }]
  const cards = [{ track: "t", slug: "s", desk: null, data: { status: "processing", repos } }]
  repoStates({ cards, root: deskRoot, spawnGit, homeDir: "/home/x", now: () => 0, deadline: 60000 })
  assert.deepEqual([...new Set(seen)], [path.join(deskRoot, "clones/w"), "/home/x/h"])
  seen.length = 0
  const runner = async () => ({ code: 1, stdout: "", stderr: "" })
  await resolvePushAccounts({ root: deskRoot, cards, runner, spawnGit, homeDir: "/home/x" })
  assert.deepEqual([...new Set(seen)], [path.join(deskRoot, "clones/w"), "/home/x/h"])
})
