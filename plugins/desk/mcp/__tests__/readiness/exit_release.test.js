// Every normal end of a Desk process releases its readiness controllers: exit, beforeExit, SIGTERM and SIGINT. A signal Desk handles alone still ends the process the way it would have.

import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { createExitRelease, exitRelease } from "../../src/readiness/exit-release.js"

function fakeProcess() {
  const proc = new EventEmitter()
  proc.pid = 4242
  proc.kills = []
  proc.kill = (pid, signal) => { proc.kills.push([pid, signal]) }
  return proc
}

const EVENTS = ["exit", "beforeExit", "SIGTERM", "SIGINT"]
const counts = (proc) => EVENTS.map((event) => proc.listenerCount(event))

test("the listeners are installed with the first release and removed with the last", () => {
  const proc = fakeProcess()
  const registry = createExitRelease(proc)
  assert.deepEqual(counts(proc), [0, 0, 0, 0])
  const first = registry.register(() => {})
  const second = registry.register(() => {})
  assert.deepEqual(counts(proc), [1, 1, 1, 1], "one listener per event, however many controllers")
  assert.equal(registry.size(), 2)
  first()
  assert.deepEqual(counts(proc), [1, 1, 1, 1])
  second()
  assert.deepEqual(counts(proc), [0, 0, 0, 0])
  assert.equal(registry.size(), 0)
})

for (const event of ["exit", "beforeExit"]) {
  test(`${event} runs every release, and one that throws never stops the rest`, () => {
    const proc = fakeProcess()
    const registry = createExitRelease(proc)
    const ran = []
    registry.register(() => { ran.push("a"); throw new Error("boom") })
    registry.register(() => ran.push("b"))
    proc.emit(event, 0)
    assert.deepEqual(ran, ["a", "b"])
    assert.deepEqual(proc.kills, [], "no signal is raised")
  })
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} handled by Desk alone: release, remove Desk's listeners, then raise it again so the process ends as it would have`, () => {
    const proc = fakeProcess()
    const registry = createExitRelease(proc)
    const ran = []
    // A controller's release unregisters itself, which takes the listeners away before the signal is raised again.
    const unregister = registry.register(() => { ran.push(signal); unregister() })
    proc.emit(signal, signal)
    assert.deepEqual(ran, [signal])
    assert.deepEqual(counts(proc), [0, 0, 0, 0])
    assert.deepEqual(proc.kills, [[4242, signal]])
    assert.equal(registry.size(), 0)
    registry.register(() => ran.push("again"))
    assert.deepEqual(counts(proc), [1, 1, 1, 1], "a later controller installs the listeners again")
  })

  test(`${signal} with the host's own listener: keep ownership until the host actually exits`, () => {
    const proc = fakeProcess()
    const registry = createExitRelease(proc)
    const ran = []
    proc.on(signal, () => ran.push("host"))
    registry.register(() => ran.push("desk"))
    for (let cycle = 0; cycle < 2; cycle += 1) {
      proc.emit(signal, signal)
      assert.deepEqual(ran, Array(cycle + 1).fill("host"), "the host retains the live controller")
      assert.equal(registry.size(), 1)
      assert.deepEqual(counts(proc), signal === "SIGTERM" ? [1, 1, 2, 1] : [1, 1, 1, 2])
      assert.deepEqual(proc.kills, [])
    }
    proc.emit("exit", 0)
    assert.deepEqual(ran, ["host", "host", "desk"])
  })

  test(`${signal} with a one-shot host handler: keep ownership for that signal, then terminate normally on the next`, () => {
    const proc = fakeProcess()
    const registry = createExitRelease(proc)
    const ran = []
    proc.once(signal, () => ran.push("host"))
    registry.register(() => ran.push("desk"))
    proc.emit(signal, signal)
    assert.deepEqual(ran, ["host"])
    assert.equal(registry.size(), 1)
    assert.deepEqual(proc.kills, [])
    proc.emit(signal, signal)
    assert.deepEqual(ran, ["host", "desk"])
    assert.deepEqual(proc.kills, [[4242, signal]])
    assert.equal(registry.size(), 0)
  })

  test(`${signal} with a passive observer and a retaining host: keep ownership on repeated signals`, () => {
    const proc = fakeProcess()
    const registry = createExitRelease(proc)
    const ran = []
    proc.__signal_exit_emitter__ = { count: 1 }
    proc.on(signal, () => {
      if (proc.listenerCount(signal) === 1) proc.kill(proc.pid, signal)
    })
    proc.on(signal, () => ran.push("host"))
    registry.register(() => ran.push("desk"))
    for (let cycle = 0; cycle < 2; cycle += 1) {
      proc.emit(signal, signal)
      assert.deepEqual(ran, Array(cycle + 1).fill("host"))
      assert.equal(registry.size(), 1)
      assert.deepEqual(proc.kills, [])
    }
    proc.emit("exit", 0)
    assert.deepEqual(ran, ["host", "host", "desk"])
  })

  test(`${signal} with a host that exits immediately: release during exit, not before the host decides`, () => {
    const proc = fakeProcess()
    const registry = createExitRelease(proc)
    const ran = []
    proc.on(signal, () => {
      assert.equal(registry.size(), 1)
      ran.push("host")
      proc.emit("exit", 0)
    })
    registry.register(() => ran.push("desk"))
    proc.emit(signal, signal)
    assert.deepEqual(ran, ["host", "desk"])
    assert.deepEqual(proc.kills, [])
  })

  test(`${signal} does not suppress a passive exit observer installed before Desk`, () => {
    const proc = fakeProcess()
    const registry = createExitRelease(proc)
    const ran = []
    proc.__signal_exit_emitter__ = { count: 1 }
    proc.on(signal, () => {
      if (proc.listenerCount(signal) === 1) {
        ran.push("observer")
        proc.kill(proc.pid, signal)
      }
    })
    registry.register(() => ran.push("desk"))
    proc.emit(signal, signal)
    assert.deepEqual(ran, ["desk", "observer"])
    assert.deepEqual(proc.kills, [[4242, signal]], "the observer preserves normal signal termination")
    assert.equal(registry.size(), 0)
  })
}

test("the shared registry is bound to this process", () => {
  const before = process.listenerCount("beforeExit")
  const unregister = exitRelease.register(() => {})
  assert.equal(process.listenerCount("beforeExit"), before + 1)
  unregister()
  assert.equal(process.listenerCount("beforeExit"), before)
})
