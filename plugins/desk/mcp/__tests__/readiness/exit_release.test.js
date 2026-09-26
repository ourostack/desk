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

  test(`${signal} with the host's own listener: release, and leave the ending to that listener`, () => {
    const proc = fakeProcess()
    const registry = createExitRelease(proc)
    const ran = []
    proc.on(signal, () => ran.push("host"))
    registry.register(() => ran.push("desk"))
    proc.emit(signal, signal)
    assert.deepEqual(ran, ["host", "desk"])
    assert.deepEqual(proc.kills, [])
    assert.equal(proc.listenerCount(signal), 1, "only the host's listener stays")
  })
}

test("the shared registry is bound to this process", () => {
  const before = process.listenerCount("beforeExit")
  const unregister = exitRelease.register(() => {})
  assert.equal(process.listenerCount("beforeExit"), before + 1)
  unregister()
  assert.equal(process.listenerCount("beforeExit"), before)
})
