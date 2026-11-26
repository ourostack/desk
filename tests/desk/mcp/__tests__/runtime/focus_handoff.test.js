// The server's end of the idle proxy's focus handoff: a private channel, a token, no MCP surface.

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { serveFocusHandoff } from "../../../../../plugins/desk/mcp/src/runtime/focus-handoff.js"

const flush = () => new Promise((resolve) => setImmediate(resolve))

function harness({ restoreFocus, focusSnapshot } = {}) {
  const channel = new EventEmitter()
  channel.sent = []
  channel.send = (message, done) => { channel.sent.push(message); done?.() }
  const kicks = []
  const session = {
    focusSnapshot: focusSnapshot ?? (() => ({ declared: true, task: null, scope: "s" })),
    restoreFocus: restoreFocus ?? (async () => ({ outcome: "restored" })),
  }
  const stop = serveFocusHandoff({ channel, token: "tok", session, kick: () => kicks.push(1) })
  const post = (message) => channel.emit("message", { desk: "focus-handoff", v: 1, token: "tok", ...message })
  return { channel, kicks, post, stop }
}

test("it says hello, answers a snapshot and a restore, and starts admission before restoring", async () => {
  const h = harness()
  assert.deepEqual(h.channel.sent[0], { desk: "focus-handoff", v: 1, token: "tok", op: "hello" })
  h.post({ op: "snapshot", id: 1 })
  assert.deepEqual(h.channel.sent[1], { desk: "focus-handoff", v: 1, token: "tok", op: "snapshot-result", id: 1, snapshot: { declared: true, task: null, scope: "s" } })
  h.post({ op: "restore", id: 2, budgetMs: 2000, snapshot: { declared: false } })
  await flush()
  assert.equal(h.kicks.length, 1)
  assert.equal(h.channel.sent[2].op, "restore-result")
  assert.equal(h.channel.sent[2].outcome, "restored")
})

test("messages with another token, shape or version are ignored", async () => {
  const h = harness()
  h.channel.emit("message", { desk: "focus-handoff", v: 1, token: "other", op: "snapshot", id: 1 })
  h.channel.emit("message", { desk: "focus-handoff", v: 2, token: "tok", op: "snapshot", id: 2 })
  h.channel.emit("message", { desk: "other", v: 1, token: "tok", op: "snapshot", id: 3 })
  h.channel.emit("message", { desk: "focus-handoff", v: 1, token: "tok", op: "nope" })
  h.channel.emit("message", "text")
  h.channel.emit("message", null)
  await flush()
  assert.equal(h.channel.sent.length, 1)
  assert.equal(h.kicks.length, 0)
})

test("a snapshot or restore that throws answers without crashing; an abort or disconnect cancels in-flight work and its late answer is dropped", async () => {
  const signals = []
  const h = harness({ focusSnapshot: () => { throw new Error("x") }, restoreFocus: (_request, { signal }) => new Promise((resolve) => { signals.push([signal, resolve]) }) })
  h.post({ op: "snapshot", id: 1 })
  assert.equal(h.channel.sent[1].snapshot, null)
  h.post({ op: "restore", id: 5, budgetMs: 10, snapshot: { declared: false } })
  await flush()
  h.post({ op: "abort", id: 5 })
  assert.equal(signals[0][0].aborted, true)
  signals[0][1]({ outcome: "restored" })
  await flush()
  assert.equal(h.channel.sent.filter((m) => m.op === "restore-result").length, 0)
  h.post({ op: "restore", id: 6, budgetMs: 10, snapshot: { declared: false } })
  await flush()
  h.channel.emit("disconnect")
  assert.equal(signals[1][0].aborted, true)
})

test("a failing restore replies unknown, teardown removes only its own listeners, and a channel without send is left alone", async () => {
  const h = harness({ restoreFocus: async () => { throw new Error("x") } })
  const other = () => {}
  h.channel.on("message", other)
  h.post({ op: "restore", id: 1, budgetMs: 10, snapshot: { declared: false } })
  await flush()
  assert.equal(h.channel.sent[1].outcome, "unknown")
  h.stop()
  assert.equal(h.channel.listeners("message").length, 1)
  assert.equal(h.channel.listeners("message")[0], other)
  const bare = new EventEmitter()
  const noop = serveFocusHandoff({ channel: bare, token: "tok", session: {}, kick: () => {} })
  assert.equal(bare.listenerCount("message"), 0)
  noop()
  assert.equal(serveFocusHandoff({ channel: harness().channel, token: "", session: {}, kick: () => {} }).constructor, Function)
})

test("a disconnect aborts in-flight work, a send on a closed channel is tolerated, a missing outcome is unknown, and a channel with only removeListener tears down", async () => {
  const signals = []
  const h = harness({ restoreFocus: (_request, { signal }) => new Promise(() => { signals.push(signal) }) })
  h.post({ op: "restore", id: 1, budgetMs: 10, snapshot: { declared: false } })
  await flush()
  h.channel.emit("disconnect")
  assert.equal(signals[0].aborted, true)

  const sent = []
  const closed = new EventEmitter()
  closed.send = (message) => { sent.push(message); throw new Error("closed") }
  closed.off = undefined
  const stop = serveFocusHandoff({ channel: closed, token: "tok", session: { restoreFocus: async () => null }, kick: () => {} })
  closed.emit("message", { desk: "focus-handoff", v: 1, token: "tok", op: "restore", id: 9, budgetMs: 10, snapshot: { declared: false } })
  await flush()
  assert.deepEqual(sent.map((m) => m.op), ["hello", "restore-result"])
  assert.equal(sent[1].outcome, "unknown")
  stop()
  assert.equal(closed.listenerCount("message"), 0)
})

test("stopping the endpoint aborts restores still running and answers nothing for them", async () => {
  let signal
  const h = harness({ restoreFocus: (request, options) => { signal = options.signal; return new Promise(() => {}) } })
  h.post({ op: "restore", id: 7, budgetMs: 2000, snapshot: { declared: false } })
  await flush()
  h.stop()
  assert.equal(signal.aborted, true)
  assert.equal(h.channel.sent.filter((message) => message.op === "restore-result").length, 0)
})

test("an abort for a restore nobody is running is ignored", async () => {
  const h = harness()
  h.post({ op: "abort", id: 99 })
  await flush()
  assert.equal(h.channel.sent.length, 1)
})

test("an abort for a restore that is running stops it", async () => {
  let signal
  const h = harness({ restoreFocus: (request, options) => { signal = options.signal; return new Promise(() => {}) } })
  h.post({ op: "restore", id: 5, budgetMs: 2000, snapshot: { declared: false } })
  await flush()
  h.post({ op: "abort", id: 5 })
  assert.equal(signal.aborted, true)
})

test("an abort or teardown that arrives before the deferred restore starts reaches the session as an already-aborted signal and is never answered", async () => {
  for (const cancel of [(h) => h.post({ op: "abort", id: 4 }), (h) => h.stop()]) {
    const seen = []
    const h = harness({ restoreFocus: async (_request, { signal }) => { seen.push(signal.aborted); return { outcome: "restored" } } })
    h.post({ op: "restore", id: 4, budgetMs: 2000, snapshot: { declared: false } })
    cancel(h)
    await flush()
    assert.deepEqual(seen, [true], "the session sees the cancellation when it starts")
    assert.equal(h.channel.sent.some((message) => message.op === "restore-result"), false)
  }
})
