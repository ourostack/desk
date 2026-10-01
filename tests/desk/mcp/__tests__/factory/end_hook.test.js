import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { factoryStateRoot, listMarkers, requestFinalize, setConsent } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { END, ID, SENTINEL, START, STORE, json, scratch, session } from "./_session_helpers.js"

const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/hooks/factory-end.cjs", import.meta.url))
const require = createRequire(import.meta.url)
const hook = () => {
  assert.ok(existsSync(SCRIPT), "the bounded factory end hook must exist")
  return require(SCRIPT)
}

for (const event of ["SessionEnd", "Stop", "sessionEnd", "agentStop"]) {
  test(`${event} writes a private marker, ignores content, and derives only on session end`, () => scratch(async (ctx) => {
    const claude = /^[A-Z]/u.test(event)
    const marker = await session(ctx, claude ? "claude-code" : "copilot-cli")
    const payload = claude
      ? { session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: event, reason: "prompt_input_exit", last_assistant_message: SENTINEL }
      : { sessionId: ID, cwd: ctx.desk, timestamp: Date.parse(END), ...(event === "agentStop" ? { stopReason: "end_turn", transcriptPath: "/ignored" } : { reason: "complete" }), initialPrompt: SENTINEL }
    const spawned = []
    const pluginRoot = path.join(ctx.base, ".local/agency/plugins/sessions/set/desk")
    await json(path.join(pluginRoot, "plugin.json"), { name: "desk", version: "3.2.0-alpha.42" })
    await json(path.join(path.dirname(pluginRoot), "overlay/plugin.json"), { name: "overlay", version: "1.0.0", desk: { factory: { store: "example/factory" } } })
    await json(path.join(ctx.base, ".claude/plugins/installed_plugins.json"), { version: 2, plugins: { "desk@ourostack": [{ version: "3.2.0-alpha.42", installPath: pluginRoot }] } })
    await json(path.join(ctx.base, ".claude/plugins/known_marketplaces.json"), { ourostack: { source: { source: "github", repo: "ourostack/desk" }, installLocation: path.join(ctx.base, "mkt") } })
    await json(path.join(ctx.base, "mkt/.claude-plugin/marketplace.json"), { name: "ourostack", plugins: [{ name: "desk", source: "./plugins/desk" }] })
    await json(path.join(ctx.base, ".local/agency/plugins/cache/cache_index.json"), { entries: { "copilot:github:ourostack/desk:plugins/desk@main": { dir_name: "e1" } } })
    await json(path.join(ctx.base, ".local/agency/plugins/cache/entries/e1/plugin.json"), { name: "desk", version: "3.2.0-alpha.42" })
    const result = await hook().runHook({ host: claude ? "claude" : "copilot", payload, env: ctx.env, pluginRoot, launch: async (...args) => spawned.push(args) })
    assert.equal(result, "written")
    const [saved] = await listMarkers(ctx.env)
    assert.equal(saved.log_path, marker.log_path)
    assert.equal(saved.desk_root, ctx.desk)
    assert.equal(saved.host, marker.host)
    assert.equal(saved.entrypoint, claude ? "unknown" : "launcher")
    assert.deepEqual(saved.plugins.find((p) => p.name === "desk"), { name: "desk", version: "3.2.0-alpha.42", source: "ourostack/desk" }, "the marker records where the plugin was installed from")
    assert.equal(JSON.stringify(saved).includes(SENTINEL), false)
    assert.equal(saved.ended_at === null, event === "Stop" || event === "agentStop")
    assert.equal(spawned.length, /End$/u.test(event) ? 1 : 0)
    if (spawned.length) assert.deepEqual(spawned[0][1].slice(0, 1), ["derive"])
    const root = await factoryStateRoot(ctx.env)
    const file = path.join(root, "markers", `${saved.host}-${ID}.json`)
    if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
    await hook().runHook({ host: claude ? "claude" : "copilot", payload, env: ctx.env, pluginRoot, launch: async () => {} })
    assert.equal((await listMarkers(ctx.env)).length, 1)
  }))
}

// Codex SessionEnd stdin: openai/codex 60947e2 codex-rs/hooks/src/schema.rs#L512-L523.
async function codexRollout(ctx, { parent } = {}) {
  const file = path.join(ctx.base, ".codex", "sessions", "2026", "09", "26", `rollout-2026-09-26T08-00-00-${ID}.jsonl`)
  const payload = { id: ID, timestamp: START, cwd: ctx.desk, cli_version: "0.130.0", source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "cli", ...(parent ? { parent_thread_id: parent } : {}) }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify({ timestamp: START, type: "session_meta", payload })}\n${JSON.stringify({ timestamp: END, type: "event_msg", payload: { type: "user_message", message: SENTINEL } })}\n`)
  return file
}
const codexPayload = (ctx, file, extra = {}) => ({ session_id: ID, transcript_path: file, cwd: ctx.desk, hook_event_name: "SessionEnd", reason: "other", ...extra })

test("a Codex SessionEnd writes exactly one root marker, only records it, and never carries content", () => scratch(async (ctx) => {
  const file = await codexRollout(ctx)
  const payload = codexPayload(ctx, file, { last_assistant_message: SENTINEL })
  const run = () => hook().runHook({ host: "codex", payload, env: ctx.env, launch: async () => assert.fail("the Codex hook must not derive or launch anything") })
  assert.equal(await run(), "written")
  assert.equal(await run(), "written")
  const markers = await listMarkers(ctx.env)
  assert.equal(markers.length, 1)
  const [saved] = markers
  assert.equal(saved.host, "codex-cli")
  assert.equal(saved.session_id, ID)
  assert.equal(saved.log_path, file)
  assert.equal(saved.desk_root, ctx.desk)
  assert.equal(saved.entrypoint, "unknown")
  assert.deepEqual(saved.plugins, [])
  assert.equal(saved.end_reason, "other")
  assert.notEqual(saved.ended_at, null)
  assert.equal(JSON.stringify(saved).includes(SENTINEL), false)
  const root = await factoryStateRoot(ctx.env)
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(root, "markers", `codex-cli-${ID}.json`))).mode & 0o777, 0o600)
}))

test("a Codex marker waits for consent: the sweep derives nothing and queues nothing without it, and queues once with it", () => scratch(async (ctx) => {
  const file = await codexRollout(ctx)
  await hook().runHook({ host: "codex", payload: codexPayload(ctx, file), env: ctx.env, launch: async () => {} })
  const [marker] = await listMarkers(ctx.env)
  const { deriveMarker } = await import("../../../../../plugins/desk/mcp/src/factory/derive-run.js")
  assert.equal((await deriveMarker(ctx.env, marker, { quietMs: 0, requireStored: true })).result, "not_opted_in")
  const root = await factoryStateRoot(ctx.env)
  assert.equal(existsSync(path.join(root, "outbox")), false)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.equal((await deriveMarker(ctx.env, marker, { quietMs: 0, requireStored: true })).result, "written")
  assert.equal(existsSync(path.join(root, "outbox", STORE.replace("/", "__"), `codex-cli-${ID}.json`)), true)
}))

test("a Codex child thread never writes a marker, whether the payload or the rollout names a parent", () => scratch(async (ctx) => {
  const parent = "0199a1b0-aaaa-7000-8000-000000000001"
  const root = await codexRollout(ctx)
  const first = codexPayload(ctx, root, { parent_thread_id: parent })
  const second = codexPayload(ctx, root, { source: { subagent: { thread_spawn: { parent_thread_id: parent } } } })
  const child = await codexRollout(ctx, { parent })
  for (const payload of [first, second, codexPayload(ctx, child)]) {
    assert.equal(await hook().runHook({ host: "codex", payload, env: ctx.env, launch: async () => assert.fail("must not launch") }), "invalid")
  }
  assert.equal((await listMarkers(ctx.env)).length, 0)
}))

test("Codex payloads that are not a root SessionEnd with a rollout path never write", () => scratch(async (ctx) => {
  const file = await codexRollout(ctx)
  const good = codexPayload(ctx, file)
  for (const payload of [{ ...good, hook_event_name: "Stop" }, { ...good, transcript_path: null }, { ...good, transcript_path: "relative.jsonl" }, { ...good, session_id: "../x" }, { ...good, cwd: "relative" }]) {
    assert.equal(await hook().runHook({ host: "codex", payload, env: ctx.env, launch: async () => assert.fail("must not launch") }), "invalid")
  }
  assert.equal((await listMarkers(ctx.env)).length, 0)
  // An unreadable rollout is not provably a child; the marker is still recorded and the sweep reports it missing.
  assert.equal(await hook().runHook({ host: "codex", payload: { ...good, transcript_path: path.join(ctx.base, "missing.jsonl") }, env: ctx.env, launch: async () => {} }), "written")
}))

test("stdin is byte bounded, malformed input and stalled input finish silently", async () => {
  const { readInput } = hook()
  assert.deepEqual(await readInput(Readable.from(['{"ok":true}'])), { ok: true })
  for (const input of ["{", "null", "[]", "1", "x".repeat(1024 * 1024 + 1)]) {
    assert.equal(await readInput(Readable.from([input])), null)
  }
  assert.equal(await readInput(new Readable({ read() {} }), 10), null)
})

test("malformed and oversized CLI stdin exits zero with no output within two seconds", () => scratch(async ({ env }) => {
  hook()
  for (const input of ["{", JSON.stringify({ initialPrompt: SENTINEL.repeat(25000) })]) {
    const start = performance.now()
    const result = spawnSync(process.execPath, [SCRIPT, "copilot"], { env, input, encoding: "utf8", timeout: 2000 })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    assert.ok(performance.now() - start < 2000)
  }
}))

test("stop starts the advertised finalize command for each pending request and leaves the request for finalize to clear", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const job = "1".repeat(32)
  await requestFinalize(ctx.env, { job, deskRoot: ctx.desk })
  const calls = []
  const options = { host: "claude", payload: { session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: "Stop" }, env: ctx.env, launch: async (...args) => calls.push(args) }
  await hook().runHook({ ...options, supportsFinalize: false })
  assert.deepEqual(calls, [])
  await hook().runHook(options)
  assert.deepEqual(calls[0][1], ["finalize", "--job", job])
  assert.equal((await fs.readdir(path.join(await factoryStateRoot(ctx.env), "finalize"))).length, 1)
}))

test("invalid identifiers, events and paths never write or launch", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const base = { session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: "Stop" }
  for (const payload of [null, [], {}, { ...base, session_id: "../escape" }, { ...base, transcript_path: "relative" }, { ...base, cwd: "/bad\0path" }, { ...base, hook_event_name: "SessionStart" }]) {
    assert.equal(await hook().runHook({ host: "claude", payload, env: ctx.env, launch: async () => assert.fail("must not launch") }), "invalid")
  }
  assert.equal((await listMarkers(ctx.env)).length, 0)
}))

// The hosts kill a hook that outlives its declared timeout, so the smallest timeout any host manifest declares for this hook is the bound a real exit must meet.
const HOST_TIMEOUT_MS = Math.min(...(() => {
  const plugin = path.resolve(path.dirname(SCRIPT), "..")
  const claude = JSON.parse(readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8")).hooks
  const copilot = JSON.parse(readFileSync(path.join(plugin, "hooks", "copilot-hooks.json"), "utf8")).hooks
  const seconds = [
    ...Object.values(claude).flat().flatMap((group) => group.hooks).filter((entry) => entry.command.includes("factory-end.cjs")).map((entry) => entry.timeout),
    ...Object.values(copilot).flat().filter((entry) => entry.bash.includes("factory-end.cjs")).map((entry) => entry.timeoutSec),
  ]
  assert.ok(seconds.length >= 4 && seconds.every((value) => Number.isFinite(value) && value > 0), "every host declares a timeout for the end hook")
  return seconds.map((value) => value * 1000)
})())
// factory-end.cjs gives its worker 1500 ms from the moment the hook process has read its input, then kills it and relies on the retained marker. Only an exit at least that late can have been cut short.
const HOOK_WORKER_DEADLINE_MS = 1500
// A detached derivation of this two-line log takes well under a second on an idle machine; the wait watches for its output and gives a loaded machine ample room.
const DERIVATION_WAIT_MS = 30000

test("two real end-hook exits leave detached derivation running to completion, with no host profile writes", (t) => scratch(async (ctx) => {
  hook()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: "ourostack/factory", contribute: true })
  const root = await factoryStateRoot(ctx.env)
  const file = path.join(root, "outbox/ourostack__factory", `claude-code-${ID}.json`)
  const env = { ...ctx.env, NODE_OPTIONS: "" }
  for (const at of [END, "2026-09-26T08:02:00.000Z"]) {
    await fs.appendFile(marker.log_path, `${JSON.stringify({ type: "assistant", sessionId: ID, timestamp: at, message: { content: [] } })}\n`)
    const old = new Date(Date.now() - 60000)
    await fs.utimes(marker.log_path, old, old)
    const input = JSON.stringify({ session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: "SessionEnd", reason: "prompt_input_exit" })
    const started = performance.now()
    const result = spawnSync(process.execPath, [SCRIPT, "claude"], { env, encoding: "utf8", timeout: HOST_TIMEOUT_MS, input })
    const elapsed = performance.now() - started
    t.diagnostic(`native synthetic end hook exited in ${Math.round(elapsed)} ms (host timeout ${HOST_TIMEOUT_MS} ms)`)
    assert.equal(result.status, 0)
    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    assert.ok(elapsed < HOST_TIMEOUT_MS, `the end hook took ${Math.round(elapsed)} ms, past the ${HOST_TIMEOUT_MS} ms a host allows`)
    if (elapsed >= HOOK_WORKER_DEADLINE_MS) {
      // On a loaded machine the hook's own deadline may have stopped its worker before it launched derivation, which is the designed outcome: the marker is kept for a retry. Deliver the same end event through the worker entry point, the code the hook runs, so the detached derivation is still exercised.
      t.diagnostic("the hook reached its worker deadline; the end event was delivered again through the worker entry point")
      const retry = spawnSync(process.execPath, [SCRIPT, "claude", "--factory-worker"], { env, encoding: "utf8", timeout: DERIVATION_WAIT_MS, input })
      assert.equal(retry.status, 0)
      assert.equal(retry.stdout, "")
    }
    const waited = performance.now()
    const deadline = Date.now() + DERIVATION_WAIT_MS
    let facts
    do {
      try { facts = JSON.parse(await fs.readFile(file, "utf8")) } catch (error) { if (error.code !== "ENOENT") throw error }
      if (facts?.session.derived_through === at) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    t.diagnostic(`detached derivation reached ${at} ${Math.round(performance.now() - waited)} ms after the hook exited`)
    assert.equal(facts?.session.derived_through, at)
  }
}))

test("an incomplete sibling scan holds routing instead of silently selecting the public default", () => scratch(async (ctx) => {
  const marker = await session(ctx, "copilot-cli")
  const pluginRoot = path.join(ctx.base, "plugins/desk")
  await fs.mkdir(pluginRoot, { recursive: true })
  for (let n = 0; n < 66; n++) await fs.mkdir(path.join(ctx.base, "plugins", `plugin-${n}`))
  assert.equal(await hook().runHook({ host: "copilot", payload: { sessionId: ID, cwd: ctx.desk, stopReason: "end_turn" }, env: ctx.env, pluginRoot }), "written")
  const [saved] = await listMarkers(ctx.env)
  assert.equal(saved.routing.store, null)
  assert.equal(saved.routing.source, "invalid_declaration")
  assert.equal(saved.log_path, marker.log_path)
}))

test("stop refuses a symlinked finalize directory rather than starting another directory's jobs", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const root = await factoryStateRoot(ctx.env)
  const outside = path.join(ctx.base, "outside")
  await json(path.join(outside, `${"1".repeat(32)}.json`), {})
  await fs.symlink(outside, path.join(root, "finalize"), process.platform === "win32" ? "junction" : "dir")
  const calls = []
  assert.equal(await hook().runHook({ host: "claude", payload: { session_id: ID, transcript_path: marker.log_path, cwd: ctx.desk, hook_event_name: "Stop" }, env: ctx.env, supportsFinalize: true, launch: async (...args) => calls.push(args) }), "unavailable")
  assert.deepEqual(calls, [])
  assert.equal((await listMarkers(ctx.env)).length, 1)
}))

// ---------------------------------------------------------------------------
// Install sources: where each plugin came from, never guessed.
// ---------------------------------------------------------------------------

async function scanFor(ctx, host, pluginRoot, extra = {}) {
  const { readSmallText } = await import("../../../../../plugins/desk/mcp/src/factory/marker.js")
  const { PATTERNS } = await import("../../../../../plugins/desk/mcp/src/factory/schema.js")
  return hook().metadata({ host, pluginRoot, home: ctx.base, env: ctx.env, readSmallText, PATTERNS, ...extra })
}

test("Claude plugins take their source only from a GitHub marketplace whose cached manifest lists them", () => scratch(async (ctx) => {
  const dir = (name) => path.join(ctx.base, "installed", name)
  const record = (name, version = "1.0.0") => [{ version, installPath: dir(name) }]
  await json(path.join(ctx.base, ".claude/plugins/installed_plugins.json"), { version: 2, plugins: {
    "desk@ourostack": record("desk"),
    "ext@ourostack": record("ext"),
    "urlsrc@ourostack": record("urlsrc"),
    "dup@ourostack": record("dup"),
    "escape@ourostack": record("escape"),
    "unlisted@ourostack": record("unlisted"),
    "secret-tool@team": record("secret-tool"),
    "hub@official": record("hub"),
    "folder@local-dir": record("folder"),
    "lost@forgotten": record("lost"),
    "odd@weird": record("odd"),
    "bare": record("bare"),
    "proto@__proto__": record("proto"),
    "twice@ourostack": [{ version: "1.0.0", installPath: dir("twice") }, { version: "1.0.0", installPath: dir("twice2") }],
  } })
  const at = (name) => path.join(ctx.base, "marketplaces", name)
  await json(path.join(ctx.base, ".claude/plugins/known_marketplaces.json"), {
    ourostack: { source: { source: "github", repo: "ourostack/desk" }, installLocation: at("ourostack") },
    // A reused marketplace name, now pointing at a public repository that never listed the plugin.
    team: { source: { source: "github", repo: "pub/team-marketplace" }, installLocation: at("team") },
    official: { source: { source: "github", repo: "anthropics/claude-plugins-official" } },
    "local-dir": { source: { source: "directory", path: "/somewhere" }, installLocation: at("local-dir") },
    weird: { source: { source: "github", repo: `${SENTINEL} not/a repo` }, installLocation: at("weird") },
  })
  await json(path.join(at("ourostack"), ".claude-plugin/marketplace.json"), { name: "ourostack", plugins: [
    { name: "desk", source: "./plugins/desk" },
    { name: "twice", source: "./plugins/twice" },
    { name: "ext", source: { source: "github", repo: "pub/ext" } },
    { name: "urlsrc", source: { source: "url", url: "https://example.invalid/private.git" } },
    { name: "dup", source: "./plugins/dup" },
    { name: "dup", source: { source: "github", repo: "pub/other" } },
    { name: "escape", source: "./../elsewhere" },
    { source: "./plugins/nameless" },
  ] })
  await json(path.join(at("team"), ".claude-plugin/marketplace.json"), { name: "team", plugins: [{ name: "other-tool", source: "./plugins/other-tool" }] })
  await json(path.join(at("local-dir"), ".claude-plugin/marketplace.json"), { name: "local-dir", plugins: [{ name: "folder", source: "./folder" }] })
  const { plugins } = await scanFor(ctx, "claude", dir("desk"))
  assert.deepEqual(Object.fromEntries(plugins.map((plugin) => [plugin.name, plugin.source])), {
    desk: "ourostack/desk", // a relative path inside a public GitHub marketplace
    ext: "pub/ext", // the listing's own GitHub repository
    urlsrc: null, // listed, but hosted somewhere that is not a GitHub repository
    dup: null, // listed twice with different sources
    escape: null, // a relative path that leaves the marketplace
    unlisted: null, // installed from the marketplace, but its manifest does not list it
    "secret-tool": null, // the marketplace name was re-pointed at a repository that never listed it
    hub: null, // no cached manifest to check
    folder: null, // not a GitHub marketplace
    lost: null,
    odd: null,
    bare: null,
    proto: null,
    twice: "ourostack/desk",
  })
  const skipped = await scanFor(ctx, "claude", dir("desk"), { sources: false })
  assert.ok(skipped.plugins.every((plugin) => plugin.source === null), "a caller that needs only folders skips the lookup")
  assert.equal(skipped.dirs.length, 15)
  const late = await scanFor(ctx, "claude", dir("desk"), { sourceDeadline: 0 })
  assert.ok(late.plugins.every((plugin) => plugin.source === null), "past the source budget nothing is named")
  assert.equal(late.plugins.length, 14, "and every plugin is still recorded")
  assert.equal(late.incomplete, false)

  await json(path.join(at("ourostack"), ".claude-plugin/marketplace.json"), { plugins: Array.from({ length: 257 }, (_, index) => ({ name: index === 0 ? "desk" : `p${index}`, source: "./x" })) })
  assert.equal((await scanFor(ctx, "claude", dir("desk"))).plugins[0].source, null, "an oversized manifest lists nothing for certain")
  for (const manifest of [{ plugins: "desk" }, [], "not json"]) {
    await fs.writeFile(path.join(at("ourostack"), ".claude-plugin/marketplace.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest))
    assert.equal((await scanFor(ctx, "claude", dir("desk"))).plugins[0].source, null, JSON.stringify(manifest))
  }
  for (const broken of ["not json", "[]", JSON.stringify({ ourostack: null }), JSON.stringify({ ourostack: { source: "github" } }), JSON.stringify({ ourostack: { source: { source: "github", repo: "ourostack/desk" }, installLocation: "relative/path" } })]) {
    await fs.writeFile(path.join(ctx.base, ".claude/plugins/known_marketplaces.json"), broken)
    const scan = await scanFor(ctx, "claude", dir("desk"))
    assert.ok(scan.plugins.every((plugin) => plugin.source === null), broken)
    assert.equal(scan.incomplete, false, "an unreadable marketplace list never holds routing")
  }
  await fs.rm(path.join(ctx.base, ".claude/plugins/known_marketplaces.json"))
  assert.equal((await scanFor(ctx, "claude", dir("desk"))).plugins[0].source, null)
}))

async function agencyFixture(ctx, plugins, entries, manifests) {
  const sessionDir = path.join(ctx.base, ".local/agency/plugins/sessions/s1")
  const cache = path.join(ctx.base, ".local/agency/plugins/cache")
  for (const [name, version] of Object.entries(plugins)) await json(path.join(sessionDir, name, "plugin.json"), { name, version })
  await json(path.join(cache, "cache_index.json"), { entries })
  for (const [file, value] of Object.entries(manifests)) await json(path.join(cache, "entries", file), value)
  return { root: path.join(sessionDir, Object.keys(plugins)[0]), cache }
}

const sourcesOf = (scan) => Object.fromEntries(scan.plugins.map((plugin) => [plugin.name, plugin.source]))

test("Copilot under Agency names a source only from a complete scan with every entry at the exact version from one GitHub repository", () => scratch(async (ctx) => {
  const plugins = { desk: "3.2.0-alpha.65", pwf: "2.0.0", "work-suite": "1.1.0", superpowers: "6.3.0", teams: "1.0.0", named: "4.0.0", foo: "9.9.9", bar: "1.0.0" }
  const entries = {
    "copilot:github:ourostack/desk:plugins/desk@v2": { dir_name: "a" },
    "copilot:github:ourostack/ouroboros-skills:plugins/desk@v1": { dir_name: "b" },
    "claude:github:teams-org/workflows:plugins/pwf@v2": { dir_name: "c" },
    "copilot:github:ourostack/desk:plugins/superpowers@v2": { dir_name: "d" },
    "copilot:github:ourostack/ouroboros-skills:plugins/superpowers@v1": { dir_name: "e" },
    "copilot:github:ourostack/ouroboros-skills:plugins/work-suite@v1": { dir_name: "f" },
    "copilot:ado:org/project/repo:plugins/teams@v1": { dir_name: "g" },
    "copilot:github:someone/named:plugins/named@v1": { dir_name: "h" },
    // The reviewer's first probe: a private foo from Azure DevOps beside a public foo at another version.
    "copilot:ado:contoso/secret/repo:plugins/foo@v1": { dir_name: "i" },
    "copilot:github:pub/tools:plugins/foo@v1": { dir_name: "j" },
    // The same name and version from a public GitHub repository and from somewhere else.
    "copilot:github:pub/tools:plugins/bar@v1": { dir_name: "k" },
    [`copilot:${SENTINEL}:plugins/bar@v1`]: { dir_name: "l" },
  }
  const { root, cache } = await agencyFixture(ctx, plugins, entries, {
    "a/plugin.json": { name: "desk", version: "3.2.0-alpha.65" },
    "b/plugin.json": { name: "desk", version: "3.2.0-alpha.9" },
    "c/agency.json": { name: "pwf" },
    "d/plugin.json": { name: "superpowers", version: "6.3.0" },
    "e/plugin.json": { name: "superpowers", version: "6.3.0" },
    "f/plugin.json": { name: "work-suite", version: "1.0.0" },
    "g/plugin.json": { name: "teams", version: "1.0.0" },
    "h/agency.json": { name: "named", version: 4 },
    "i/plugin.json": { name: "foo", version: "9.9.9" },
    "j/plugin.json": { name: "foo", version: "1.0.0" },
    "k/plugin.json": { name: "bar", version: "1.0.0" },
    "l/plugin.json": { name: "bar", version: "1.0.0" },
  })
  assert.deepEqual(sourcesOf(await scanFor(ctx, "copilot", root)), {
    desk: "ourostack/desk", // two repositories, told apart by the exact version
    pwf: null, // no version in the cache, so no exact match
    "work-suite": null, // no entry at this version, and a name alone never matches
    superpowers: null, // the same name and version from two repositories
    teams: null, // not a GitHub source
    named: null, // no string version in the cache
    foo: null, // the private entry at this version is not GitHub, and the public one is another version
    bar: null, // the same version also comes from a source that is not GitHub
  })
  const skipped = await scanFor(ctx, "copilot", root, { sources: false })
  assert.ok(skipped.plugins.every((plugin) => plugin.source === null))

  // An entry whose folder cannot be read or is refused could be any plugin, so the index names nothing.
  for (const bad of [{ dir_name: "../../../outside" }, { dir_name: ".." }, null, { dir_name: "missing" }]) {
    await json(path.join(cache, "cache_index.json"), { entries: { ...entries, "copilot:github:someone/x:plugins/x@v1": bad } })
    assert.equal(sourcesOf(await scanFor(ctx, "copilot", root)).desk, null, JSON.stringify(bad))
  }
  for (const broken of ["not json", JSON.stringify({ entries: [] }), JSON.stringify({})]) {
    await fs.writeFile(path.join(cache, "cache_index.json"), broken)
    const scan = await scanFor(ctx, "copilot", root)
    assert.ok(scan.plugins.every((plugin) => plugin.source === null), broken)
    assert.equal(scan.incomplete, false)
  }
  await json(path.join(cache, "cache_index.json"), { entries })
  const late = await scanFor(ctx, "copilot", root, { deadline: 0 })
  assert.equal(late.timedOut, true)
  assert.deepEqual(late.plugins, [], "a scan past its deadline reads no cache entries and names no plugin")
}))

test("Copilot under Agency names nothing when the scan is cut short by the entry cap or the source budget", () => scratch(async (ctx) => {
  // The reviewer's second probe: a private GitHub foo listed after 300 other entries, with a public foo within the first 256.
  const entries = { "copilot:github:pub/tools:plugins/foo@v1": { dir_name: "pub" } }
  const manifests = { "pub/plugin.json": { name: "foo", version: "1.0.0" } }
  for (let index = 0; index < 300; index += 1) {
    entries[`copilot:github:pub/filler${index}:plugins/f@v1`] = { dir_name: `f${index}` }
    manifests[`f${index}/plugin.json`] = { name: `filler${index}`, version: "1.0.0" }
  }
  entries["copilot:github:secret/internal:plugins/foo@v1"] = { dir_name: "secret" }
  manifests["secret/plugin.json"] = { name: "foo", version: "2.0.0" }
  const { root, cache } = await agencyFixture(ctx, { foo: "2.0.0", desk: "1.0.0" }, entries, manifests)
  assert.deepEqual(sourcesOf(await scanFor(ctx, "copilot", root)), { foo: null, desk: null }, "past the entry cap nothing is named")

  // Within the cap, a source budget that runs out mid-scan names nothing either, and every plugin is still recorded.
  const small = { "copilot:github:ourostack/desk:plugins/desk@v1": { dir_name: "d" }, "copilot:github:pub/tools:plugins/foo@v1": { dir_name: "pub" } }
  await json(path.join(cache, "cache_index.json"), { entries: small })
  await json(path.join(cache, "entries/d/plugin.json"), { name: "desk", version: "1.0.0" })
  await json(path.join(cache, "entries/pub/plugin.json"), { name: "foo", version: "2.0.0" })
  assert.deepEqual(sourcesOf(await scanFor(ctx, "copilot", root)), { foo: "pub/tools", desk: "ourostack/desk" }, "the same cache, fully read, names both")
  const { readSmallText } = await import("../../../../../plugins/desk/mcp/src/factory/marker.js")
  const { PATTERNS } = await import("../../../../../plugins/desk/mcp/src/factory/schema.js")
  let reads = 0
  const slow = (file, limit) => {
    // Each cached manifest takes longer than the whole source budget.
    if (file.includes(`${path.sep}entries${path.sep}`)) {
      reads += 1
      const until = performance.now() + 400
      while (performance.now() < until) { /* a slow disk */ }
    }
    return readSmallText(file, limit)
  }
  const cut = hook().metadata({ host: "copilot", pluginRoot: root, home: ctx.base, env: ctx.env, readSmallText: slow, PATTERNS, sourceDeadline: performance.now() + 200 })
  assert.ok(reads >= 1 && reads < 4, "the scan stopped after the budget ran out")
  assert.deepEqual(sourcesOf(cut), { foo: null, desk: null })
  assert.equal(cut.incomplete, false, "a short source budget never holds routing")
}))

test("plain Copilot takes a plugin's source from its install record's GitHub marketplace", () => scratch(async (ctx) => {
  const home = ctx.env.COPILOT_HOME
  const folder = path.join(home, "installed-plugins/ourostack")
  for (const [name, version] of Object.entries({ desk: "3.2.0-alpha.65", mine: "1.0.0", twin: "1.0.0", stale: "2.0.0", gitsrc: "1.0.0", nowhere: "1.0.0" })) {
    await json(path.join(folder, name, "plugin.json"), { name, version })
  }
  const installed = [
    { name: "desk", marketplace: "ourostack", version: "3.2.0-alpha.65" },
    { name: "mine", marketplace: "private-mkt", version: "1.0.0" },
    { name: "twin", marketplace: "ourostack", version: "1.0.0" },
    { name: "twin", marketplace: "private-mkt", version: "1.0.0" },
    { name: "stale", marketplace: "ourostack", version: "1.0.0" },
    { name: "gitsrc", marketplace: "git-mkt", version: "1.0.0" },
    { name: "nowhere", marketplace: "unknown-mkt", version: "1.0.0" },
    "not an object",
  ]
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(path.join(home, "config.json"), `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify({ installedPlugins: installed })}\n`)
  await json(path.join(home, "settings.json"), { extraKnownMarketplaces: {
    ourostack: { source: { source: "github", repo: "ourostack/desk" } },
    "private-mkt": { source: { source: "github", repo: `${SENTINEL} bad` } },
    "git-mkt": { source: { source: "git", url: "https://example.invalid/x.git" } },
  } })
  assert.deepEqual(sourcesOf(await scanFor(ctx, "copilot", path.join(folder, "desk"))), {
    desk: "ourostack/desk",
    mine: null, // its marketplace does not name a GitHub repository
    twin: null, // two install records at this version
    stale: null, // no install record at this version
    gitsrc: null, // a marketplace that is not on GitHub
    nowhere: null, // a marketplace settings.json does not know
  })
  assert.ok((await scanFor(ctx, "copilot", path.join(folder, "desk"), { sourceDeadline: 0 })).plugins.every((plugin) => plugin.source === null))
  for (const [file, text] of [["config.json", "{broken"], ["config.json", JSON.stringify({ installedPlugins: Array.from({ length: 257 }, () => installed[0]) })], ["settings.json", "[]"]]) {
    const saved = await fs.readFile(path.join(home, file), "utf8")
    await fs.writeFile(path.join(home, file), text)
    assert.equal(sourcesOf(await scanFor(ctx, "copilot", path.join(folder, "desk"))).desk, null, `${file}: ${text.slice(0, 20)}`)
    await fs.writeFile(path.join(home, file), saved)
  }
}))
