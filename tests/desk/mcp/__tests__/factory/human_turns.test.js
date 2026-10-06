// The human-turn vocabulary and its accumulator: size classes, the basis and window of each turn, the limit, and the rule that no text is ever held.

import { test } from "node:test"
import { strict as assert } from "node:assert"

import { sizeClass, createHumanTurns } from "../../../../../plugins/desk/mcp/src/factory/derive-common.js"
import { ENUMS, LIMITS, validateLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/schema.js"

const T0 = Date.parse("2026-10-05T10:00:00.000Z")
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString()

test("sizeClass puts 0, 20, 21, 200, 201, 1000, 1001, 5000 and 5001 characters in the right classes", () => {
  const table = [[0, "none"], [1, "xs"], [20, "xs"], [21, "s"], [200, "s"], [201, "m"], [1000, "m"], [1001, "l"], [5000, "l"], [5001, "xl"]]
  for (const [chars, expected] of table) assert.equal(sizeClass(chars), expected, String(chars))
  for (const [, name] of table) assert.ok(ENUMS.sizeClass.includes(name))
})

test("the first prompt has basis first and a null window", () => {
  const acc = createHumanTurns()
  acc.prompt(iso(0), 600)
  assert.deepEqual(acc.finish([]), [{ at: iso(0), basis: "first", window_ms: null, prompt_class: "m", output_class: "none" }])
})

test("a prompt after a stop has the gap from the stop as its window", () => {
  const acc = createHumanTurns()
  acc.prompt(iso(0), 5)
  acc.addReply(4000)
  acc.agentStopped(iso(10000))
  acc.prompt(iso(13000), 5)
  const [, second] = acc.finish([])
  assert.deepEqual(second, { at: iso(13000), basis: "after_stop", window_ms: 3000, prompt_class: "xs", output_class: "l" })
})

test("a prompt with no stop since the last one is mid_turn with the time since that prompt", () => {
  const acc = createHumanTurns()
  acc.prompt(iso(0), 5)
  acc.addReply(300)
  acc.prompt(iso(90000), 16)
  const [, second] = acc.finish([])
  assert.deepEqual(second, { at: iso(90000), basis: "mid_turn", window_ms: 90000, prompt_class: "xs", output_class: "m" })
})

test("a stop before the first prompt does not make it after_stop, and a stop is used once", () => {
  const acc = createHumanTurns()
  acc.agentStopped(iso(-5000))
  acc.prompt(iso(0), 5)
  acc.prompt(iso(4000), 30)
  const [first, second] = acc.finish([])
  assert.equal(first.basis, "first")
  assert.deepEqual([second.basis, second.window_ms], ["mid_turn", 4000])
})

test("reply text is summed between prompts and cleared at each prompt", () => {
  const acc = createHumanTurns()
  acc.prompt(iso(0), 1)
  acc.addReply(10)
  acc.addReply(15)
  acc.prompt(iso(1000), 1)
  acc.prompt(iso(2000), 1)
  const classes = acc.finish([]).map((turn) => turn.output_class)
  assert.deepEqual(classes, ["none", "s", "none"])
})

test("the list is cut at the limit and the field is flagged capped", () => {
  const acc = createHumanTurns({ limit: 3 })
  for (let index = 0; index < 5; index += 1) acc.prompt(iso(index * 1000), 1)
  const unavailable = []
  const turns = acc.finish(unavailable)
  assert.equal(turns.length, 3)
  assert.deepEqual(unavailable, [{ field: "human_turns", reason: "capped" }])
  const fine = createHumanTurns({ limit: 3 })
  for (let index = 0; index < 3; index += 1) fine.prompt(iso(index * 1000), 1)
  const none = []
  fine.finish(none)
  assert.deepEqual(none, [])
  assert.equal(LIMITS.humanTurns, 1000)
  assert.equal(createHumanTurns().finish([]).length, 0)
})

test("a negative window is never written, and a window is always a whole number", () => {
  const mid = createHumanTurns()
  mid.prompt(iso(5000), 1)
  mid.prompt(iso(5000), 1)
  const fractional = createHumanTurns()
  fractional.prompt("2026-10-05T10:00:00.000Z", 1)
  fractional.prompt("2026-10-05T10:00:01.999Z", 1)
  for (const acc of [mid, fractional]) {
    const [, second] = acc.finish([])
    assert.ok(Number.isInteger(second.window_ms) && second.window_ms >= 0, String(second.window_ms))
  }
})

test("a stop recorded after the next prompt (clock skew) gives no made-up zero: the turn is dropped and the list flagged", () => {
  const stopped = createHumanTurns()
  stopped.prompt(iso(0), 1)
  stopped.agentStopped(iso(5000))
  stopped.prompt(iso(2000), 1)
  stopped.agentStopped(iso(6000))
  stopped.prompt(iso(9000), 1)
  const unavailable = []
  const turns = stopped.finish(unavailable)
  assert.deepEqual(turns.map((turn) => [turn.basis, turn.window_ms]), [["first", null], ["after_stop", 3000]], "the skewed turn is gone; the next one still measures from its own stop")
  assert.deepEqual(unavailable, [{ field: "human_turns", reason: "source_unreadable" }])
})

test("the accumulator refuses a string, a fraction or a negative number for a size, and a bad time", () => {
  const acc = createHumanTurns()
  for (const bad of ["please read this", 1.5, -1, Number.NaN, undefined, null, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => acc.prompt(iso(0), bad), TypeError)
    assert.throws(() => acc.addReply(bad), TypeError)
  }
  for (const bad of ["not a time", 5, undefined]) {
    assert.throws(() => acc.prompt(bad, 1), TypeError)
    assert.throws(() => acc.agentStopped(bad), TypeError)
  }
  assert.deepEqual(acc.finish([]), [])
})

test("a very large reply total stays a safe size and classes xl", () => {
  const acc = createHumanTurns()
  acc.addReply(Number.MAX_SAFE_INTEGER)
  acc.addReply(Number.MAX_SAFE_INTEGER)
  acc.prompt(iso(0), 1)
  assert.equal(acc.finish([])[0].output_class, "xl")
})

test("an entry holds only the five keys and no text", () => {
  const acc = createHumanTurns()
  acc.prompt(iso(0), 3)
  assert.deepEqual(Object.keys(acc.finish([])[0]), ["at", "basis", "window_ms", "prompt_class", "output_class"])
})

test("accumulated turns pass the local facts schema (see schema.test.js for the golden)", async () => {
  const { readFileSync } = await import("node:fs")
  const golden = JSON.parse(readFileSync(new URL("./fixtures/local-golden.json", import.meta.url), "utf8"))
  const acc = createHumanTurns()
  acc.prompt(iso(0), 50)
  acc.agentStopped(iso(1000))
  acc.prompt(iso(9000), 5000)
  assert.deepEqual(validateLocalFacts({ ...golden, human_turns: acc.finish([]) }), { ok: true, errors: [] })
})

test("sizeClass throws on anything but a safe non-negative integer", () => {
  for (const bad of [Number.NaN, undefined, null, "12", -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => sizeClass(bad), TypeError, String(bad))
  }
  assert.equal(sizeClass(Number.MAX_SAFE_INTEGER), "xl")
})

test("a prompt earlier than the last kept turn is dropped, its reply and stop are still cleared, and the field is flagged source_unreadable", () => {
  const acc = createHumanTurns()
  acc.prompt(iso(5000), 1)
  acc.addReply(300)
  acc.agentStopped(iso(5500))
  acc.prompt(iso(1000), 1)
  acc.prompt(iso(7000), 1)
  const unavailable = []
  const turns = acc.finish(unavailable)
  assert.deepEqual(turns.map((turn) => [turn.at, turn.basis, turn.window_ms, turn.output_class]), [
    [iso(5000), "first", null, "none"],
    [iso(7000), "mid_turn", 2000, "none"],
  ])
  assert.deepEqual(unavailable, [{ field: "human_turns", reason: "source_unreadable" }])
})

test("an equal-time prompt is kept and a list in order carries no flag", () => {
  const acc = createHumanTurns()
  acc.prompt(iso(0), 1)
  acc.prompt(iso(0), 1)
  const unavailable = []
  assert.equal(acc.finish(unavailable).length, 2)
  assert.deepEqual(unavailable, [])
})

test("a skewed prompt past the limit is dropped too and capped is flagged beside it", () => {
  const acc = createHumanTurns({ limit: 1 })
  acc.prompt(iso(5000), 1)
  acc.prompt(iso(6000), 1)
  acc.prompt(iso(1000), 1)
  const unavailable = []
  assert.equal(acc.finish(unavailable).length, 1)
  assert.deepEqual(unavailable, [{ field: "human_turns", reason: "capped" }, { field: "human_turns", reason: "source_unreadable" }])
})

test("producer against schema: whatever the accumulator emits passes the local facts schema", async () => {
  const { readFileSync } = await import("node:fs")
  const golden = JSON.parse(readFileSync(new URL("./fixtures/local-golden.json", import.meta.url), "utf8"))
  const scripts = [
    [[5000, 1], [1000, 1], [7000, 1]],
    [[0, 1], [0, 1], [0, 1]],
    [[0, 10], [3000, 300], [9000, 6000], [9500, 0]],
    [[9000, 1], [8000, 1], [7000, 1], [9000, 1], [10000, 1]],
  ]
  for (const script of scripts) {
    for (const withStops of [false, true]) {
      const acc = createHumanTurns()
      for (const [offset, chars] of script) {
        acc.addReply(chars)
        if (withStops) acc.agentStopped(iso(offset - 500))
        acc.prompt(iso(offset), chars)
      }
      const unavailable = []
      const human_turns = acc.finish(unavailable)
      assert.deepEqual(validateLocalFacts({ ...golden, human_turns, unavailable }), { ok: true, errors: [] }, JSON.stringify(script))
    }
  }
})
