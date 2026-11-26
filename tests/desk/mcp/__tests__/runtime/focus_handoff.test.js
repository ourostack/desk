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
