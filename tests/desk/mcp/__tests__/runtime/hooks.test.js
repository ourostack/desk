// Webhooks on the Mac side: `hooks poll` turns a hook's pending events on the receiver into one wake for its session, with each
// body saved as a private file, and `hooks ack` acknowledges exactly the events a delivered wake listed. The receiver is a fake
// fetch here; hosted/test/hooks-app.test.js covers the real one. Every file lives under a temporary root.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { runDrainsCli } from "../../../../../plugins/desk/mcp/src/runtime/drains-cli.js"
import { ackHooks, createHook, deleteHook, ghToken, hookPaths, hookStatus, hookWakeMessage, listHooks, parseHookConfig, pollHooks, readHookConfig, readHookStates, UNTRUSTED } from "../../../../../plugins/desk/mcp/src/runtime/hooks.js"

const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/drains.js", import.meta.url))
const SERVER = "https://hooks.example"
const SESSION = "cfb84353-ea6b-42e2-96ba-de795561431e"
const NOW = Date.parse("2026-11-20T21:00:00Z")
const DAY = 24 * 3_600_000
const SMOKE = { name: "smoke", account: "arimendelow", session: SESSION, prompt: "Look at the smoke event." }
const ACK = ["node", "drains.js"]

let sequence = 0
const eventOf = (body, headers = { "content-type": "application/json" }, at = NOW) => ({ eventId: `${String(at + sequence).padStart(15, "0")}-${String(sequence++).padStart(6, "0")}`, receivedAt: new Date(at).toISOString(), deliveryId: null, headers, body: Buffer.from(body).toString("base64") })

/** A receiver in memory: hooks per account, keyed by the token `token-<login>`. Only arimendelow is mapped. */
function fakeReceiver({ hooks = { smoke: { verify: "standard", events: [] } }, expired = 0 } = {}) {
  const calls = []
  const state = { hooks, expired, fail: null }
  const reply = (status, body) => ({ status, text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)) })
  const fetchImpl = async (url, init) => {
    const { pathname, search } = new URL(url)
    calls.push({ method: init.method, route: `${pathname}${search}`, authorization: init.headers.Authorization, body: init.body })
    if (state.fail) return state.fail(init.method, pathname)
    if (init.headers.Authorization !== "Bearer token-arimendelow") return reply(401, { error: "GitHub user ari-work (42) has no Desk account; poll with gh auth token --user arimendelow" })
    const parts = pathname.split("/").filter(Boolean)
    if (init.method === "GET" && parts.length === 1) return reply(200, Object.entries(state.hooks).map(([name, hook]) => ({ name, verify: hook.verify, pending: hook.events.length, lastEventAt: hook.lastEventAt ?? null, lastRejection: hook.lastRejection ?? null })))
    if (init.method === "POST" && parts.length === 1) {
      const body = JSON.parse(init.body)
      state.hooks[body.name] = { verify: body.verify, events: [], secret: body.secret }
      return reply(201, { name: body.name, url: `${SERVER}/hooks/AAAAAAAAAAAAAAAAAAAAAA`, verify: body.verify, ...(body.secret ? {} : { secret: "whsec_made" }) })
    }
    const hook = state.hooks[parts[1]]
    if (!hook) return reply(404, { error: "no hook" })
    if (init.method === "DELETE" && parts.length === 2) {
      delete state.hooks[parts[1]]
      return reply(204)
    }
    if (init.method === "GET") {
      const limit = Number(new URL(url).searchParams.get("limit"))
      const answer = { events: hook.events.slice(0, limit), expired: state.expired }
      state.expired = 0
      return reply(200, answer)
    }
    const index = hook.events.findIndex((event) => event.eventId === decodeURIComponent(parts[3]))
    if (index < 0) return reply(404, { error: "no event" })
    hook.events.splice(index, 1)
    return reply(204)
  }
  return { fetchImpl, calls, state }
}

const token = (account) => `token-${account ?? "ari-work"}`

async function world({ hooks = [SMOKE], server = SERVER, receiver = fakeReceiver() } = {}) {
  const dir = await mkTempRoot("desk-hooks-")
  const paths = { config: path.join(dir, "hooks.json"), state: path.join(dir, "hooks-state.json"), lock: path.join(dir, "hooks.lock"), payloads: path.join(dir, "hooks", "payloads") }
  writeFileSync(paths.config, JSON.stringify({ server, hooks }))
  const context = { paths, fetchImpl: receiver.fetchImpl, token, env: {} }
  const poll = (at = NOW) => pollHooks({ ...context, now: at, ackCommand: ACK })
  const ack = (name, events, error, at = NOW) => ackHooks({ ...context, name, events, error, now: at })
  return { dir, paths, receiver, context, poll, ack }
}

test("hookPaths keeps hooks.json, its state, lock and payloads in Desk's drains folder", () => {
  const paths = hookPaths({ env: { XDG_STATE_HOME: "/state" }, homeDir: "/home/me" })
  assert.equal(paths.config, path.join("/state", "ouroboros-skills", "desk", "drains", "hooks.json"))
  assert.equal(paths.payloads, path.join("/state", "ouroboros-skills", "desk", "drains", "hooks", "payloads"))
  assert.equal(path.basename(paths.state), "hooks-state.json")
  assert.equal(path.basename(paths.lock), "hooks.lock")
})

test("poll saves each body as a private file and prints one wake with no replaces", async () => {
  const w = await world()
  const json = eventOf('{ "alert": "disk full" }', { "content-type": "application/json", "sentry-hook-resource": "event_alert" })
  const binary = { ...eventOf(""), body: Buffer.from([0xff, 0xfe, 0x00]).toString("base64"), headers: { "content-type": "application/octet-stream" } }
  const empty = { ...eventOf(""), headers: {} }
  w.receiver.state.hooks.smoke.events.push(json, binary, empty)
  const result = await w.poll()
  assert.deepEqual(result.errors, [])
  assert.equal(result.wakes.length, 1)
  const [wake] = result.wakes
  assert.equal(wake.session, SESSION)
  assert.equal("replaces" in wake, false)
  assert.deepEqual(wake.done, [...ACK, "hooks", "ack", "--name", "smoke", "--events", [json, binary, empty].map((event) => event.eventId).join(",")])
  const dir = path.join(w.paths.payloads, "smoke")
  const jsonFile = path.join(dir, `${json.eventId}.json`)
  const binFile = path.join(dir, `${binary.eventId}.bin`)
  const emptyFile = path.join(dir, `${empty.eventId}.bin`)
  assert.equal(readFileSync(jsonFile, "utf8"), '{ "alert": "disk full" }')
  assert.deepEqual([...readFileSync(binFile)], [0xff, 0xfe, 0x00])
  assert.equal(readFileSync(emptyFile).length, 0)
  if (process.platform !== "win32") assert.equal(statSync(jsonFile).mode & 0o777, 0o600)
  const lines = wake.message.split("\n")
  assert.equal(lines[0], "Webhook smoke received 3 events (verified: standard signature). Look at the smoke event.")
  assert.equal(lines[1], `- 2026-11-20T21:00:00Z sentry-hook-resource=event_alert  ${jsonFile}`)
  assert.equal(lines[2], `- ${binary.receivedAt.replace(".000Z", "Z")} application/octet-stream  ${binFile}`)
  assert.equal(lines[3], `- ${empty.receivedAt.replace(".000Z", "Z")} no content type  ${emptyFile}`)
  assert.equal(lines.at(-1), UNTRUSTED)
  assert.ok(w.receiver.calls.every((call) => call.authorization === "Bearer token-arimendelow"), "every call reads as hooks.json's account")
})

test("a held wake grows: two polls with new events between list every event once, oldest first, and ack --error keeps them", async () => {
  const w = await world()
  const first = eventOf("{}")
  w.receiver.state.hooks.smoke.events.push(first)
  const one = (await w.poll()).wakes[0]
  const kept = await w.ack("smoke", first.eventId, "held: the last wake has not reached the session")
  assert.deepEqual(kept, { ok: true, acknowledged: 0, kept: 1, reason: "kept the events; the next poll lists them again" })
  assert.equal(w.receiver.calls.filter((call) => call.method === "DELETE").length, 0)
  assert.equal(readHookStates(w.paths.state).smoke.lastError, "the wake was not delivered: held: the last wake has not reached the session")
  const second = eventOf("{}")
  w.receiver.state.hooks.smoke.events.push(second)
  const two = await w.poll()
  assert.equal(two.wakes.length, 1)
  assert.equal(two.wakes[0].done.at(-1), `${first.eventId},${second.eventId}`)
  assert.match(two.wakes[0].message, /received 2 events/u)
  assert.notEqual(two.wakes[0].message, one.message)
  assert.doesNotMatch(two.status[0], /last error/u, "a poll that worked clears the last error")
  const acked = await w.ack("smoke", `${first.eventId},${second.eventId}`)
  assert.deepEqual(acked, { ok: true, acknowledged: 2, failed: [] })
  assert.equal(w.receiver.state.hooks.smoke.events.length, 0)
  assert.deepEqual((await w.poll()).wakes, [])
  assert.equal(readHookStates(w.paths.state).smoke.lastError, undefined)
})

test("ack counts an event already gone as acknowledged and keeps a failed one in view", async () => {
  const w = await world()
  const event = eventOf("{}")
  w.receiver.state.hooks.smoke.events.push(event)
  assert.deepEqual(await w.ack("smoke", `${event.eventId},000000000000000-gone00`), { ok: true, acknowledged: 2, failed: [] })
  w.receiver.state.fail = () => ({ status: 503, text: async () => "" })
  assert.deepEqual(await w.ack("smoke", "a,b"), { ok: false, acknowledged: 0, failed: ["a", "b"] })
  w.receiver.state.fail = () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })
  }
  assert.equal((await w.ack("smoke", "c")).failed.length, 1)
  assert.equal(readHookStates(w.paths.state).smoke.lastError, "Nothing to do: the receiver kept 1 delivered event because acknowledging them got ECONNREFUSED, so the next wake lists them again")
  w.receiver.state.fail = () => {
    throw new Error("no cause")
  }
  assert.equal((await w.ack("smoke", "d,e")).failed.length, 2)
  assert.equal(readHookStates(w.paths.state).smoke.lastError, "Nothing to do: the receiver kept 2 delivered events because acknowledging them got Error, so the next wake lists them again")
  w.receiver.state.fail = () => ({ status: 503, text: async () => "" })
  await w.ack("smoke", "f")
  assert.equal(readHookStates(w.paths.state).smoke.lastError, "Nothing to do: the receiver kept 1 delivered event because acknowledging them got HTTP 503, so the next wake lists them again")
  await assert.rejects(w.ack("gone", "x"), /desk_hooks_unknown_hook/u)
})

test("a 401 names the configured account and gh auth token --user", async () => {
  const w = await world({ hooks: [{ ...SMOKE, account: "ari-work" }] })
  const result = await w.poll()
  assert.deepEqual(result.wakes, [])
  assert.equal(result.errors[0].error, "Check gh auth token --user ari-work: the receiver refused hooks.json's account ari-work when listing hooks (GitHub user ari-work (42) has no Desk account; poll with gh auth token --user arimendelow)")
})

test("listing and reading failures are errors per hook, and the other hooks still poll", async () => {
  const receiver = fakeReceiver({ hooks: { smoke: { verify: "none", events: [eventOf("{}")] }, other: { verify: "standard", events: [] } } })
  const w = await world({ receiver, hooks: [SMOKE, { ...SMOKE, name: "missing" }, { ...SMOKE, name: "broken", account: "no-token" }] })
  const tokens = (account) => {
    if (account === "no-token") throw Object.assign(new Error("Sign the GitHub CLI in as no-token"), { code: "desk_hooks_no_github_token" })
    return token(account)
  }
  const result = await pollHooks({ ...w.context, token: tokens, now: NOW, ackCommand: ACK })
  assert.equal(result.wakes.length, 1)
  assert.match(result.wakes[0].message, /^Webhook smoke received 1 event \(not signed\)\./u)
  assert.deepEqual(result.errors.map((entry) => entry.name), ["missing", "broken"])
  assert.match(result.errors[0].error, /^Make it with hooks create missing: hooks.json routes missing but the receiver at https:\/\/hooks.example has no hook/u)
  assert.equal(result.errors[1].error, "Try again on the next poll: Sign the GitHub CLI in as no-token")
  assert.ok(result.status.includes("hook other on the receiver as arimendelow is not routed: add it to hooks.json or delete it with hooks delete other"))
})

test("a receiver that is down, or refuses a read, leaves the events for the next poll", async () => {
  const w = await world()
  w.receiver.state.fail = () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } })
  }
  assert.equal((await w.poll()).errors[0].error, "Try again on the next poll: the receiver at https://hooks.example did not answer (ENOTFOUND)")
  w.receiver.state.fail = () => {
    throw new TypeError("bad")
  }
  assert.match((await w.poll()).errors[0].error, /did not answer \(TypeError\)/u)
  w.receiver.state.fail = () => ({ status: 502, text: async () => "<html>bad gateway</html>" })
  assert.equal((await w.poll()).errors[0].error, "Try again on the next poll: the receiver answered HTTP 502 when listing hooks (<html>bad gateway</html>)")
  w.receiver.state.fail = (method, pathname) => (pathname === "/hooks" ? { status: 200, text: async () => JSON.stringify([{ name: "smoke", verify: "standard", pending: 1, lastEventAt: null, lastRejection: null }]) } : { status: 500, text: async () => "" })
  assert.equal((await w.poll()).errors[0].error, "Try again on the next poll: the receiver answered HTTP 500 when reading smoke (HTTP 500)")
  w.receiver.state.fail = (method, pathname) => {
    if (pathname === "/hooks") return { status: 200, text: async () => JSON.stringify([{ name: "smoke", verify: "standard", pending: 1 }]) }
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } })
  }
  assert.equal((await w.poll()).errors[0].error, "Try again on the next poll: reading smoke from https://hooks.example failed (ECONNRESET)")
  w.receiver.state.fail = (method, pathname) => {
    if (pathname === "/hooks") return { status: 200, text: async () => JSON.stringify([{ name: "smoke", verify: "standard", pending: 1 }]) }
    throw new Error("no cause")
  }
  assert.match((await w.poll()).errors[0].error, /failed \(Error\)$/u)
})

test("expired events are named in the wake and kept in status", async () => {
  const receiver = fakeReceiver({ expired: 2 })
  const w = await world({ receiver })
  receiver.state.hooks.smoke.events.push(eventOf("{}"))
  const result = await w.poll()
  assert.match(result.wakes[0].message, /\n2 older events expired unread after 7 days\.\n/u)
  assert.match(result.status[0], /, 2 expired unread, the last under 1m ago/u)
  receiver.state.expired = 1
  assert.deepEqual((await w.poll()).wakes.length, 1)
  assert.match((await w.poll()).status[0], /3 expired unread/u)
  assert.match(hookWakeMessage({ hook: SMOKE, verify: "github", events: [eventOf("{}")], files: ["f"], expired: 1 }), /1 older event expired unread/u)
})

test("payload files older than 7 days are removed, and empty folders with them", async () => {
  const w = await world()
  const old = path.join(w.paths.payloads, "gone", "old.json")
  const fresh = path.join(w.paths.payloads, "smoke", "fresh.json")
  mkdirSync(path.dirname(old), { recursive: true })
  mkdirSync(path.dirname(fresh), { recursive: true })
  writeFileSync(old, "{}")
  writeFileSync(fresh, "{}")
  writeFileSync(path.join(w.paths.payloads, "stray-file"), "not a folder")
  const eightDaysAgo = (NOW - 8 * DAY) / 1000
  utimesSync(old, eightDaysAgo, eightDaysAgo)
  utimesSync(fresh, NOW / 1000, NOW / 1000)
  await w.poll()
  assert.equal(existsSync(path.dirname(old)), false)
  assert.deepEqual(readdirSync(path.dirname(fresh)), ["fresh.json"])
})

test("status says how each hook stands, read from the receiver", async () => {
  const receiver = fakeReceiver({
    hooks: {
      smoke: { verify: "standard", events: [eventOf("{}")], lastEventAt: new Date(NOW - 20_000).toISOString(), lastRejection: { reason: "signature does not match", at: new Date(NOW - 3 * 3_600_000).toISOString() } },
      quiet: { verify: "standard", events: [] },
      old: { verify: "standard", events: [], lastEventAt: new Date(NOW - 3 * DAY).toISOString() },
      recent: { verify: "standard", events: [], lastEventAt: new Date(NOW - 5 * 60_000).toISOString() },
    },
  })
  const w = await world({ receiver, hooks: ["smoke", "quiet", "old", "recent"].map((name) => ({ ...SMOKE, name })) })
  const lines = await hookStatus({ ...w.context, now: NOW })
  assert.deepEqual(lines, [
    "hook smoke -> cfb84353 as arimendelow, 1 pending, last event under 1m ago, last refused 3h ago: signature does not match",
    "hook quiet -> cfb84353 as arimendelow, 0 pending, no event yet",
    "hook old -> cfb84353 as arimendelow, 0 pending, last event 3d ago",
    "hook recent -> cfb84353 as arimendelow, 0 pending, last event 5m ago",
  ])
  receiver.state.fail = () => ({ status: 401, text: async () => "" })
  assert.deepEqual(await hookStatus({ ...w.context, now: NOW }), [...["smoke", "quiet", "old", "recent"].map((name) => `hook ${name} -> cfb84353 as arimendelow`), "arimendelow: Check gh auth token --user arimendelow: the receiver refused hooks.json's account arimendelow when listing hooks (HTTP 401)"])
})

test("create sends the sender's secret only for presets that need one, and prints the address and any made secret", async () => {
  const w = await world()
  const made = await createHook({ ...w.context, name: "made", verify: "standard" })
  assert.deepEqual(made, { name: "made", url: `${SERVER}/hooks/AAAAAAAAAAAAAAAAAAAAAA`, verify: "standard", secret: "whsec_made" })
  const sentry = await createHook({ ...w.context, name: "sentry", verify: "sentry", secret: "from-sentry\n" })
  assert.equal(sentry.secret, undefined)
  assert.equal(w.receiver.state.hooks.sentry.secret, "from-sentry")
  await assert.rejects(createHook({ ...w.context, name: "Bad", verify: "standard" }), /desk_hooks_bad_name/u)
  await assert.rejects(createHook({ ...w.context, name: "s", verify: "stripe" }), /hooks create s --verify stripe --secret-stdin/u)
  await assert.rejects(createHook({ ...w.context, name: "s", verify: "github", secret: "x" }), /without --secret-stdin/u)
  assert.equal(readdirSync(w.dir).some((name) => readFileSync(path.join(w.dir, name), "utf8").includes("whsec_made")), false, "the secret is written nowhere")
})

test("list and delete act as hooks.json's one account, or --account, or the GitHub CLI's active one", async () => {
  const w = await world()
  assert.deepEqual((await listHooks(w.context)).map((hook) => hook.name), ["smoke"])
  assert.deepEqual(await deleteHook({ ...w.context, name: "smoke" }), { deleted: "smoke" })
  await assert.rejects(deleteHook({ ...w.context, name: "smoke" }), /answered HTTP 404 when DELETE \/hooks\/smoke \(no hook\)/u)
  await assert.rejects(listHooks({ ...w.context, account: "ari-work" }), /Check gh auth token --user ari-work/u)
  // Two accounts in hooks.json and no --account: the GitHub CLI's active account, named as such when refused.
  writeFileSync(w.paths.config, JSON.stringify({ server: SERVER, hooks: [SMOKE, { ...SMOKE, name: "b", account: "other" }] }))
  await assert.rejects(listHooks(w.context), /refused hooks.json's account the GitHub CLI's active account/u)
  // No server anywhere, then one passed in.
  writeFileSync(w.paths.config, JSON.stringify({ hooks: [] }))
  await assert.rejects(listHooks(w.context), /desk_hooks_no_server/u)
  assert.deepEqual(await listHooks({ ...w.context, account: "arimendelow", server: `${SERVER}/` }), [])
})

test("hooks.json is checked entry by entry, and a missing file means no hooks", async () => {
  const bad = (raw, pattern, env = {}) => assert.throws(() => parseHookConfig(typeof raw === "string" ? raw : JSON.stringify(raw), "hooks.json", env), pattern)
  bad("{", /is not valid JSON/u)
  bad({}, /has no "hooks" array/u)
  bad({ server: "http://plain", hooks: [] }, /not an https origin/u)
  bad({ server: SERVER, hooks: [null] }, /hooks\[0\] is not an object/u)
  bad({ server: SERVER, hooks: [[]] }, /hooks\[0\] is not an object/u)
  bad({ server: SERVER, hooks: [{ ...SMOKE, name: "Bad Name" }] }, /hooks\[0\].name/u)
  bad({ server: SERVER, hooks: [{ ...SMOKE, account: " " }] }, /hooks\[0\].account/u)
  bad({ server: SERVER, hooks: [{ ...SMOKE, session: undefined }] }, /hooks\[0\].session/u)
  bad({ server: SERVER, hooks: [{ ...SMOKE, prompt: 3 }] }, /hooks\[0\].prompt/u)
  bad({ server: SERVER, hooks: [SMOKE, SMOKE] }, /hooks\[1\] repeats the name smoke/u)
  bad({ hooks: [SMOKE] }, /lists hooks but has no "server"/u)
  assert.equal(parseHookConfig(JSON.stringify({ hooks: [SMOKE] }), "hooks.json", { DESK_HOOKS_URL: `${SERVER}/` }).server, SERVER)
  assert.deepEqual(parseHookConfig(JSON.stringify({ server: ` ${SERVER}/ `, hooks: [{ ...SMOKE, account: " arimendelow ", session: ` ${SESSION} ` }] }), "hooks.json"), { server: SERVER, hooks: [SMOKE] })
  const dir = await mkTempRoot("desk-hooks-config-")
  assert.deepEqual(readHookConfig(path.join(dir, "absent.json"), {}), { server: null, hooks: [] })
  assert.deepEqual(readHookConfig(path.join(dir, "absent.json"), { DESK_HOOKS_URL: SERVER }), { server: SERVER, hooks: [] })
  assert.throws(() => readHookConfig(dir, {}), /desk_hooks_config_unreadable/u)
  writeFileSync(path.join(dir, "state.json"), "[1]")
  assert.deepEqual(readHookStates(path.join(dir, "state.json")), {})
  writeFileSync(path.join(dir, "state.json"), "null")
  assert.deepEqual(readHookStates(path.join(dir, "state.json")), {})
})

test("ghToken asks the GitHub CLI for the named account's token without the environment's tokens", () => {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, env: options.env })
    return { status: 0, stdout: "gho_abc\n" }
  }
  assert.equal(ghToken("arimendelow", { spawn, env: { GH_TOKEN: "leak", PATH: "/bin" } }), "gho_abc")
  assert.deepEqual(calls[0].args, ["auth", "token", "--hostname", "github.com", "--user", "arimendelow"])
  assert.equal(calls[0].env.GH_TOKEN, undefined)
  assert.match(calls[0].env.PATH, /^\/opt\/homebrew\/bin:\/usr\/local\/bin:\/bin$/u)
  assert.throws(() => ghToken(undefined, { spawn: () => ({ status: 1, stdout: "" }), env: {} }), /Sign the GitHub CLI in as an account Desk maps .* gh auth token gave no token/u)
  assert.throws(() => ghToken("x", { spawn: () => ({ status: 0 }), env: {} }), /gh auth token --user x gave no token/u)
  // The real GitHub CLI, asked for an account no machine has signed in: no token, never a guess. Nothing is printed.
  assert.throws(() => ghToken("desk-hooks-no-such-account-7f3a", { env: { PATH: process.env.PATH, HOME: "/nonexistent-desk-hooks-home" } }), /desk-hooks-no-such-account-7f3a gave no token/u)
})

test("the drains CLI runs every hooks command against the files it is given", async () => {
  const w = await world()
  const event = eventOf("{}")
  w.receiver.state.hooks.smoke.events.push(event)
  const run = async (argv, stdin) => {
    let stdout = ""
    let stderr = ""
    const io = { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, ...(stdin === undefined ? {} : { stdin: [stdin] }) }
    const code = await runDrainsCli({ argv, script: SCRIPT, env: { XDG_STATE_HOME: path.join(w.dir, "state") }, io, now: () => NOW, fetchHooks: w.receiver.fetchImpl, hookToken: token })
    return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) : null }
  }
  const files = ["--config", w.paths.config, "--state", w.paths.state]
  const polled = await run(["hooks", "poll", ...files, "--json"])
  assert.equal(polled.code, 0, polled.stderr)
  const done = polled.json.wakes[0].done
  assert.deepEqual(done.slice(-10), ["hooks", "ack", "--name", "smoke", "--events", event.eventId, "--config", w.paths.config, "--state", w.paths.state])
  const acked = await run([...done.slice(2), "--json"])
  assert.equal(acked.code, 0, acked.stderr)
  assert.equal(acked.json.acknowledged, 1)
  const status = await run(["hooks", "status", ...files, "--json"])
  assert.match(status.json.status[1], /^hook smoke -> cfb84353 as arimendelow, 0 pending/u)
  const created = await run(["hooks", "create", "linear", "--verify", "linear", "--secret-stdin", "--config", w.paths.config, "--json"], "lin_secret\n")
  assert.equal(created.code, 0, created.stderr)
  assert.equal(w.receiver.state.hooks.linear.secret, "lin_secret")
  const plain = await run(["hooks", "create", "plain", "--config", w.paths.config, "--json"])
  assert.equal(plain.json.secret, "whsec_made")
  const listed = await run(["hooks", "list", "--config", w.paths.config, "--json"])
  assert.deepEqual(listed.json.map((hook) => hook.name), ["smoke", "linear", "plain"])
  const deleted = await run(["hooks", "delete", "plain", "--config", w.paths.config, "--account", "arimendelow", "--server", SERVER, "--json"])
  assert.deepEqual(deleted.json, { deleted: "plain" })
  // Without --config and --state, the default files under the drains folder.
  const defaults = await run(["hooks", "poll", "--json"])
  assert.equal(defaults.code, 0, defaults.stderr)
  assert.deepEqual(defaults.json.wakes, [])
  const kept = await run(["hooks", "ack", "--name", "smoke", "--events", "x", "--error", "held", ...files, "--json"])
  assert.equal(kept.json.kept, 1)
})

test("an event id the receiver would never make is refused before it becomes a file name", async () => {
  const w = await world()
  w.receiver.state.hooks.smoke.events.push({ ...eventOf("{}"), eventId: "../../escape" })
  const result = await w.poll()
  assert.deepEqual(result.wakes, [])
  assert.equal(result.errors[0].error, 'Check the receiver at https://hooks.example: it sent smoke an event id that is not one it makes ("../../escape"), so no event was saved')
  assert.equal(existsSync(w.paths.payloads), false)
})
