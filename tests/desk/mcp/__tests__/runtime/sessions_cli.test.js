// `sessions.js` reads and messages this machine's agent sessions: the last messages of one, which session is this, and a send
// that counts as delivered only when the target's own history shows it.
import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { appSocket, exchange, envelope, nameOf, parentOfProcess, parseSessionsArgs, resolveSession, runSessionsCli, selfSessions, sendThroughApp, tailMessages, whoAmI } from "../../../../../plugins/desk/mcp/src/runtime/sessions-cli.js"
import { mkTempRoot } from "../_temp_roots.js"

const A = "0dc4f17b-1111-4222-8333-444455556666"
const B = "0dc4f17b-2222-4222-8333-444455556666"
const C = "9f3e0000-1111-4222-8333-444455556666"
const event = (type, content, at) => `${JSON.stringify({ type, timestamp: at, data: { content } })}\n`

async function state() {
  const root = realpathSync(await mkTempRoot("sessions-cli-"))
  const dir = path.join(root, "session-state")
  for (const [id, name] of [[A, "Babysitter"], [B, "Lane two"], [C, "Babysitter"]]) {
    mkdirSync(path.join(dir, id), { recursive: true })
    writeFileSync(path.join(dir, id, "workspace.yaml"), `id: ${id}\nname: '${name}'\n`)
    writeFileSync(path.join(dir, id, "events.jsonl"), "")
  }
  return { root, dir }
}

const capture = () => {
  const out = { stdout: "", stderr: "" }
  return { out, io: { stdout: { write: (text) => (out.stdout += text) }, stderr: { write: (text) => (out.stderr += text) } } }
}

test("tail keeps the last user and assistant messages and skips tool noise and half lines", () => {
  const text = [
    event("user.message", "start", "t1"),
    event("tool.execution_start", "ignored", "t2"),
    event("assistant.message", "   ", "t3"),
    event("assistant.message", "working", "t4"),
    "{not json\n",
    event("user.message", "x".repeat(3000), "t5"),
  ].join("")
  const messages = tailMessages(text, 3)
  assert.deepEqual(messages.map(({ role, at }) => [role, at]), [["user", "t1"], ["assistant", "t4"], ["user", "t5"]])
  assert.equal(messages[2].text.length, 2000)
  assert.deepEqual(tailMessages(text, 1).map(({ at }) => at), ["t5"])
})

test("a session is named by full id, unique id prefix or exact name, and an ambiguous name says which", async () => {
  const { dir } = await state()
  assert.equal(resolveSession(dir, A.toUpperCase()).id, A)
  assert.equal(resolveSession(dir, "0dc4f17b-1").id, A)
  assert.equal(resolveSession(dir, "lane two").id, B)
  assert.match(resolveSession(dir, "0dc4f17b").reason, /matches 2 sessions/u)
  assert.match(resolveSession(dir, "Babysitter").reason, /Babysitter \(0dc4f17b\), Babysitter \(9f3e0000\)/u)
  assert.match(resolveSession(dir, "nobody").reason, /no session on this machine/u)
  assert.equal(nameOf(dir, C), "Babysitter")
})

test("whoami finds the session whose live process is an ancestor, and uses the hint among several", async () => {
  const { dir } = await state()
  const parents = { 900: 800, 800: 700, 700: 1 }
  const self = (pid) => ({ pid, parentOf: (current) => parents[current] ?? 1, exists: existsSync, list: readdirSync })
  writeFileSync(path.join(dir, A, "inuse.800.lock"), "")
  assert.deepEqual(selfSessions(dir, self(900)), [A])
  assert.deepEqual(whoAmI(dir, null, self(900)), { ids: [A], id: A })
  assert.deepEqual(whoAmI(dir, null, self(5)), { ids: [], id: null })
  writeFileSync(path.join(dir, B, "inuse.800.lock"), "")
  appendFileSync(path.join(dir, B, "events.jsonl"), event("assistant.message", "running sessions.js send lane one hello", "t1"))
  assert.deepEqual(whoAmI(dir, null, self(900)), { ids: [A, B], id: null }, "two candidates and no hint is not a guess")
  assert.equal(whoAmI(dir, "send lane one hello", self(900)).id, B)
  assert.equal(whoAmI(dir, "never said", self(900)).id, null)
})

test("the envelope names the sender and how to reply, and an anonymous one says there is no address", () => {
  const text = envelope({ nonce: "ab12cd34", from: A, name: "Baby (sitter)", host: "mini", text: "hello", script: "/d/sessions.js" })
  assert.match(text, /^\[Message ab12cd34 from 0dc4f17b-.* \(Baby  sitter \) on mini, sent with sessions\.js send\.\]\n\nhello\n\n\[Reply only if it needs an answer/u)
  assert.match(text, /send_session_message with session_id 0dc4f17b/u)
  assert.match(text, /node "\/d\/sessions\.js" send 0dc4f17b-[0-9a-f-]+ "<your reply>"/u)
  assert.match(envelope({ nonce: "n", from: A, name: null, host: "mini", text: "hi", script: "s" }), /\(unnamed session\) on mini/u)
  assert.match(envelope({ nonce: "n", from: null, name: null, host: "mini", text: "hi", script: "s" }), /no reply address/u)
})

test("the app's socket answer decides whether a send was accepted", async () => {
  const ask = (reply) => sendThroughApp({ id: A, prompt: "p", socket: {}, newRequestId: () => "r1", send: async (_socket, messages, { keep, done }) => {
    assert.deepEqual(messages, [{ type: "send_message", session_id: A, prompt: "p", delivery_mode: "immediate", request_id: "r1" }])
    assert.ok(keep({ request_id: "r1", type: "x" }) && !keep({ request_id: "other", type: "x", session_id: B }))
    assert.equal(done({ type: reply.type }), true)
    return [reply]
  } })
  assert.deepEqual(await ask({ type: "session_message_sent" }), { accepted: true, reply: "session_message_sent", error: null })
  assert.equal((await ask({ type: "session_message_queued" })).accepted, true)
  assert.deepEqual(await ask({ type: "error", message: "session archived" }), { accepted: false, reply: "error", error: "session archived" })
  assert.equal((await ask({ type: "session_message_delivery_unknown" })).accepted, false)
})

test("a missing socket file or a dead owner reads as the app not running", async () => {
  const { root } = await state()
  const env = { COPILOT_HOME: root }
  assert.match(appSocket({ env }).reason, /not running/u)
  mkdirSync(path.join(root, "run"))
  writeFileSync(path.join(root, "run", "ws.port"), "4001\n999999999\n")
  writeFileSync(path.join(root, "run", "ws.token"), "tok\n")
  assert.match(appSocket({ env }).reason, /not running/u)
  writeFileSync(path.join(root, "run", "ws.port"), `4001\n${process.pid}\n`)
  assert.deepEqual(appSocket({ env }), { port: "4001", token: "tok" })
})

test("the command line parses, and a mistake says the fix and exits 2", async () => {
  assert.deepEqual(parseSessionsArgs(["tail", "abc", "3"]), { command: "tail", ref: "abc", count: 3 })
  assert.deepEqual(parseSessionsArgs(["send", "abc", "hello", "there", "--from", "none", "--as-user", "--wait", "5"]), { command: "send", ref: "abc", message: "hello there", from: "none", asUser: true, waitMs: 5000 })
  for (const bad of [["nope"], ["tail"], ["tail", "a", "0"], ["send", "a"], ["send", "a", "m", "--wait", "x"], ["whoami", "--from", "x"], ["send", "a", "m", "--from"], ["tail", "a", "--x"]]) {
    const parsed = parseSessionsArgs(bad)
    assert.match(parsed.error, /Fix: /u, bad.join(" "))
    assert.match(parsed.error, /friction_add/u)
  }
  const { out, io } = capture()
  assert.equal(await runSessionsCli({ argv: ["tail"], io }), 2)
  assert.match(out.stderr, /^desk: tail needs a session/u)
  assert.equal(await runSessionsCli({ argv: ["--help"], io }), 0)
  assert.match(out.stdout, /^Usage: sessions\.js whoami/u)
})

test("tail prints a session's messages as JSON, and a session that is not here says where to look", async () => {
  const { dir } = await state()
  appendFileSync(path.join(dir, A, "events.jsonl"), event("user.message", "hello", "t1") + event("assistant.message", "hi", "t2"))
  const { out, io } = capture()
  assert.equal(await runSessionsCli({ argv: ["tail", "Babysitter-nope"], io, deps: { stateDir: dir } }), 1)
  assert.match(out.stderr, /Fix: /u)
  const ok = capture()
  assert.equal(await runSessionsCli({ argv: ["tail", "0dc4f17b-1", "1"], io: ok.io, deps: { stateDir: dir } }), 0)
  const answer = JSON.parse(ok.out.stdout)
  assert.deepEqual([answer.id, answer.name, answer.messages], [A, "Babysitter", [{ at: "t2", role: "assistant", text: "hi" }]])
  const gone = capture()
  const orphan = "11111111-1111-4222-8333-444455556666"
  assert.equal(await runSessionsCli({ argv: ["tail", orphan], io: gone.io, deps: { stateDir: dir } }), 1)
  assert.match(gone.out.stderr, /on another machine or has been removed/u)
})

// The fake app appends the prompt to the target's history, as the real one does once it delivers.
function app({ dir, deliver, reply = { accepted: true, reply: "session_message_sent", error: null } }) {
  const calls = []
  return { calls, send: async ({ id, prompt }) => {
    calls.push({ id, prompt })
    if (deliver) appendFileSync(path.join(dir, id, "events.jsonl"), event("user.message", prompt, `t${calls.length}`))
    return reply
  } }
}
const sendDeps = (dir, fake, extra = {}) => ({ stateDir: dir, socket: () => ({ port: "1", token: "t" }), send: fake.send, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 1000) })(), host: "mini", nonce: () => "feedbeef", self: { pid: 5, parentOf: () => 1, exists: existsSync, list: readdirSync }, ...extra })

test("send is delivered only when the nonce shows in the target's history, and says what to do when it does not", async () => {
  const { dir } = await state()
  const fake = app({ dir, deliver: true })
  const run = capture()
  assert.equal(await runSessionsCli({ argv: ["send", "lane two", "check the build", "--from", A], script: "/d/sessions.js", io: run.io, deps: sendDeps(dir, fake) }), 0)
  const result = JSON.parse(run.out.stdout)
  assert.deepEqual([result.to, result.from, result.nonce, result.accepted, result.delivered], [B, A, "feedbeef", true, true])
  assert.match(fake.calls[0].prompt, /^\[Message feedbeef from 0dc4f17b-.* \(Babysitter\) on mini, sent with sessions\.js send\.\]\n\ncheck the build\n\n\[Reply only/u)

  const silent = app({ dir, deliver: false })
  const late = capture()
  assert.equal(await runSessionsCli({ argv: ["send", B, "again", "--from", "none", "--wait", "3"], io: late.io, deps: sendDeps(dir, silent, { nonce: () => "00000000" }) }), 0)
  const pending = JSON.parse(late.out.stdout)
  assert.deepEqual([pending.accepted, pending.delivered, pending.from], [true, false, null])
  assert.match(pending.note, /Read it with sessions\.js tail .* before sending again/u)
  assert.match(silent.calls[0].prompt, /no reply address/u)
})

test("--as-user sends the words alone and is delivered when exactly that text is a new user message", async () => {
  const { dir } = await state()
  appendFileSync(path.join(dir, B, "events.jsonl"), event("user.message", "same words", "old"))
  const fake = app({ dir, deliver: true })
  const run = capture()
  assert.equal(await runSessionsCli({ argv: ["send", B, "same words", "--as-user"], io: run.io, deps: sendDeps(dir, fake) }), 0)
  assert.equal(fake.calls[0].prompt, "same words")
  const result = JSON.parse(run.out.stdout)
  assert.deepEqual([result.nonce, result.delivered], [null, true], "an older identical message does not count")
})

test("a refused or unreachable send is a failure with the code that files a bug", async () => {
  const { dir } = await state()
  const refused = capture()
  assert.equal(await runSessionsCli({ argv: ["send", B, "hi", "--from", "none"], io: refused.io, deps: sendDeps(dir, app({ dir, deliver: false, reply: { accepted: false, reply: "error", error: "session archived" } })) }), 1)
  assert.match(refused.out.stderr, /session archived.*sessions_send_refused/u)
  const noApp = capture()
  const deps = sendDeps(dir, app({ dir, deliver: false }), { socket: () => ({ reason: "the app has not written its local socket files, so it is not running" }) })
  assert.equal(await runSessionsCli({ argv: ["send", B, "hi", "--from", "none"], io: noApp.io, deps }), 1)
  assert.match(noApp.out.stderr, /so it is not running.*sessions_app_socket/u)
  const nobody = capture()
  assert.equal(await runSessionsCli({ argv: ["send", "nobody", "hi"], io: nobody.io, deps: sendDeps(dir, app({ dir, deliver: false })) }), 1)
  assert.match(nobody.out.stderr, /sessions_target/u)
})

// A WebSocket that answers from a script: `script(sent)` returns the events to deliver after the open, each a string, an Error or a function.
function fakeWebSocket(script) {
  return class FakeWebSocket {
    constructor(url) {
      this.url = url
      this.handlers = {}
      this.closed = false
      FakeWebSocket.last = this
      queueMicrotask(() => this.handlers.open?.({}))
    }
    addEventListener(name, handler) {
      this.handlers[name] = handler
    }
    send(text) {
      for (const event of script(JSON.parse(text))) setTimeout(() => (event === "error" ? this.handlers.error?.({}) : this.handlers.message?.({ data: event })), 0)
    }
    close() {
      this.closed = true
      if (FakeWebSocket.closeThrows) throw new Error("already closed")
    }
  }
}

test("the app exchange sends the request, keeps only its own replies and stops at the first final one", async () => {
  const WS = fakeWebSocket(({ request_id }) => ["not json", JSON.stringify({ type: "noise", request_id: "other" }), JSON.stringify({ type: "session_message_queued", request_id }), JSON.stringify({ type: "session_message_sent", request_id })])
  const reply = await exchange({ port: "4001", token: "a b" }, [{ type: "send_message", request_id: "r9" }], {
    keep: (message) => message.request_id === "r9", done: (message) => message.type === "session_message_queued", waitMs: 2000,
  }, WS)
  assert.deepEqual(reply.map(({ type }) => type), ["session_message_queued"])
  assert.equal(WS.last.url, "ws://127.0.0.1:4001/?token=a%20b&observer=1")
  assert.equal(WS.last.closed, true)
  WS.closeThrows = true
  const again = await exchange({ port: "1", token: "t" }, [{ request_id: "r" }], { keep: () => true, done: () => true, waitMs: 2000 }, WS)
  assert.equal(again.length, 1, "a socket that is already closed does not break the answer")
})

test("a socket error or silence ends the exchange with what it has", async () => {
  const broken = fakeWebSocket(() => ["error"])
  assert.deepEqual(await exchange({ port: "1", token: "t" }, [{}], { keep: () => true, done: () => false, waitMs: 2000 }, broken), [{ type: "socket_error" }])
  const silent = fakeWebSocket(() => [])
  assert.deepEqual(await exchange({ port: "1", token: "t" }, [{}], { keep: () => true, done: () => false, waitMs: 20 }, silent), [])
})

test("send goes through the real defaults: the app socket files, the WebSocket and the waiting between looks", async () => {
  const { root, dir } = await state()
  mkdirSync(path.join(root, "run"))
  writeFileSync(path.join(root, "run", "ws.port"), `4001\n${process.pid}\n`)
  writeFileSync(path.join(root, "run", "ws.token"), "tok\n")
  const original = globalThis.WebSocket
  globalThis.WebSocket = fakeWebSocket(({ request_id }) => [JSON.stringify({ type: "session_message_sent", request_id })])
  try {
    const run = capture()
    // The fake app does not write the history, so the message is accepted but never seen; the default clock and sleep run out the wait.
    const code = await runSessionsCli({ argv: ["send", B, "hello there friend", "--from", "none", "--wait", "1"], io: run.io, env: { COPILOT_HOME: root } })
    assert.equal(code, 0, run.out.stderr)
    const result = JSON.parse(run.out.stdout)
    assert.deepEqual([result.to, result.accepted, result.delivered], [B, true, false])
    assert.ok(typeof dir === "string")
  } finally {
    globalThis.WebSocket = original
  }
})

test("whoami says it cannot walk processes on Windows, and anything else resolves nothing quietly", async () => {
  const { dir } = await state()
  const win = capture()
  assert.equal(await runSessionsCli({ argv: ["whoami"], io: win.io, deps: { stateDir: dir, platform: "win32" } }), 1)
  assert.match(win.out.stderr, /sessions_whoami_platform/u)
  const here = capture()
  assert.equal(await runSessionsCli({ argv: ["whoami", "--hint", "x"], io: here.io, deps: { stateDir: dir, platform: "linux", self: { pid: 5, parentOf: () => 1, exists: existsSync, list: readdirSync } } }), 0)
  assert.deepEqual(JSON.parse(here.out.stdout), { ids: [], id: null })
})

test("a missing session-state folder is named, and the sessions.js script runs end to end", async () => {
  const { root, dir } = await state()
  const nowhere = path.join(root, "nowhere")
  assert.match(resolveSession(nowhere, "abcdef").reason, /no session-state folder/u)
  assert.deepEqual(selfSessions(nowhere, { pid: 5, parentOf: () => 1, exists: existsSync, list: readdirSync }), [])
  assert.equal(nameOf(nowhere, A), null)
  appendFileSync(path.join(dir, A, "events.jsonl"), event("user.message", "from the script", "t1"))
  const script = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/sessions.js", import.meta.url))
  const run = (...argv) => spawnSync(process.execPath, [script, ...argv], { encoding: "utf8", env: { ...process.env, COPILOT_HOME: root } })
  assert.match(run("--help").stdout, /^Usage: sessions\.js whoami/u)
  assert.equal(JSON.parse(run("tail", "0dc4f17b-1").stdout).messages[0].text, "from the script")
  assert.equal(run("whoami", "--hint", "nothing like it").status, process.platform === "win32" ? 1 : 0)
  const send = run("send", A, "hello there friend", "--from", "none")
  assert.equal(send.status, 1)
  assert.match(send.stderr, /sessions_app_socket/u)
})

test("the helpers cope with what a real machine leaves lying around", async () => {
  const { root, dir } = await state()
  assert.ok(process.platform === "win32" || parentOfProcess(process.pid) > 1)
  assert.equal(parentOfProcess(1, () => ({ stdout: null })), 0, "a machine without ps says no parent")
  const bare = "22222222-1111-4222-8333-444455556666"
  const empty = "33333333-1111-4222-8333-444455556666"
  mkdirSync(path.join(dir, bare))
  writeFileSync(path.join(dir, bare, "workspace.yaml"), "id: x\n")
  mkdirSync(path.join(dir, empty))
  writeFileSync(path.join(dir, empty, "workspace.yaml"), "name: ''\n")
  assert.equal(nameOf(dir, bare), null)
  assert.equal(nameOf(dir, empty), null)
  assert.equal(resolveSession(dir, "22222222").id, bare, "an unnamed session is found by id")
  mkdirSync(path.join(dir, "22222222-9999-4222-8333-444455556666"))
  assert.match(resolveSession(dir, "22222222").reason, /unnamed \(22222222\), unnamed \(22222222\)/u)
  assert.deepEqual(tailMessages(`${JSON.stringify({ type: "user.message", timestamp: "t1" })}\n${JSON.stringify({ type: "user.message", timestamp: "t2", data: {} })}\n${JSON.stringify({ type: "user.message", timestamp: "t3", data: null })}\n`, 5).map(({ at, text }) => [at, text]), [["t1", ""], ["t2", ""], ["t3", ""]])
  writeFileSync(path.join(dir, bare, "inuse.800.lock"), "")
  writeFileSync(path.join(dir, A, "inuse.800.lock"), "")
  appendFileSync(path.join(dir, A, "events.jsonl"), event("user.message", "marker text", "t1"))
  assert.equal(whoAmI(dir, "marker text", { pid: 800, parentOf: () => 1, exists: existsSync, list: readdirSync }).id, A, "a candidate with no history is skipped")
  assert.match(appSocket({ env: {}, home: root }).reason, /not running/u)
})

test("the app's replies are filtered to this session, and an empty answer is not an acceptance", async () => {
  let filters
  const ask = (replies) => sendThroughApp({ id: A, prompt: "p", socket: {}, newRequestId: () => "r1", send: async (_s, _m, options) => { filters = options; return replies } })
  assert.deepEqual(await ask([]), { accepted: false, reply: "no reply", error: null })
  assert.equal(filters.keep({ session_id: A, type: "session_message_delivery_unknown" }), true)
  assert.equal(filters.keep({ session_id: B, type: "session_message_sent" }), false)
  assert.equal(filters.keep({ session_id: A, type: "other" }), false)
  assert.equal(filters.keep({ type: "socket_error" }), true)
})

test("a refusal without a reason from the app, and a target with no history yet, are both reported plainly", async () => {
  const { dir } = await state()
  const orphan = "44444444-1111-4222-8333-444455556666"
  const refused = capture()
  assert.equal(await runSessionsCli({ argv: ["send", orphan, "hi there", "--from", "none"], io: refused.io, deps: sendDeps(dir, { send: async () => ({ accepted: false, reply: "error", error: null }) }) }), 1)
  assert.match(refused.out.stderr, /the app answered error; the session may be archived/u)
  const quiet = capture()
  assert.equal(await runSessionsCli({ argv: ["send", orphan, "hi there", "--from", "none", "--wait", "0"], io: quiet.io, deps: sendDeps(dir, { send: async () => ({ accepted: true, reply: "session_message_queued", error: null }) }) }), 0)
  assert.equal(JSON.parse(quiet.out.stdout).delivered, false)
  const home = capture()
  assert.equal(await runSessionsCli({ argv: ["tail", "nobody"], env: {}, io: home.io }), 1)
})

test("without --from the sender is the session this process runs in, and whoami works without a hint", async () => {
  const { dir } = await state()
  writeFileSync(path.join(dir, A, "inuse.5.lock"), "")
  const fake = app({ dir, deliver: true })
  const run = capture()
  assert.equal(await runSessionsCli({ argv: ["send", B, "no sender given here"], io: run.io, deps: sendDeps(dir, fake) }), 0)
  assert.equal(JSON.parse(run.out.stdout).from, A)
  const who = capture()
  assert.equal(await runSessionsCli({ argv: ["whoami"], io: who.io, deps: sendDeps(dir, fake, { platform: "linux" }) }), 0)
  assert.deepEqual(JSON.parse(who.out.stdout), { ids: [A], id: A })
})
