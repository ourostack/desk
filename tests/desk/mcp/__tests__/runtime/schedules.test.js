// Schedules: a prompt due to a session every N minutes, coalesced so a busy or absent session is never replayed missed runs.
// Every config, state and lock file lives under a temporary root.
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { runDrainsCli } from "../../../../../plugins/desk/mcp/src/runtime/drains-cli.js"
import { ackSchedule, parseScheduleConfig, pollSchedules, readScheduleStates, schedulePaths } from "../../../../../plugins/desk/mcp/src/runtime/schedules.js"

const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/drains.js", import.meta.url))
const SESSION = "cfb84353-ea6b-42e2-96ba-de795561431e"
const NOW = Date.parse("2026-11-14T12:00:00Z")
const MIN = 60_000
const WATCHDOG = { name: "watchdog", session: SESSION, prompt: "Watchdog: check the lanes.", everyMinutes: 60 }

async function world(schedules = [WATCHDOG]) {
  const dir = await mkTempRoot("desk-schedules-")
  const paths = { config: path.join(dir, "schedules.json"), state: path.join(dir, "schedules-state.json"), lock: path.join(dir, "schedule.lock") }
  writeFileSync(paths.config, JSON.stringify({ schedules }))
  const poll = (at) => pollSchedules({ paths, now: at, ackCommand: ["node", "drains.js"] })
  const ack = (name, wake, at, error) => ackSchedule({ paths, name, wake, error, now: at })
  return { dir, paths, poll, ack }
}

test("a new schedule first runs one interval after it is first seen", async () => {
  const w = await world()
  assert.deepEqual((await w.poll(NOW)).wakes, [])
  assert.deepEqual((await w.poll(NOW + 59 * MIN)).wakes, [])
  assert.equal((await w.poll(NOW + 60 * MIN)).wakes.length, 1)
})

test("three missed intervals send one prompt, and the next run counts from the delivery", async () => {
  const w = await world()
  await w.poll(NOW)
  const late = NOW + 3 * 60 * MIN + 5 * MIN
  const first = await w.poll(late)
  assert.equal(first.wakes.length, 1)
  const [wake] = first.wakes
  assert.deepEqual({ session: wake.session, message: wake.message, replaces: wake.replaces }, { session: SESSION, message: WATCHDOG.prompt, replaces: WATCHDOG.prompt })
  assert.deepEqual(wake.done.slice(0, 5), ["node", "drains.js", "schedule", "ack", "--name"])
  w.ack("watchdog", wake.id, late)
  assert.deepEqual((await w.poll(late + 59 * MIN)).wakes, [])
  assert.equal((await w.poll(late + 60 * MIN)).wakes.length, 1)
})

test("a prompt the runner holds stays one wake with one id, however long it waits, and sends nothing new", async () => {
  const w = await world()
  await w.poll(NOW)
  const due = NOW + 60 * MIN
  const first = (await w.poll(due)).wakes[0]
  w.ack("watchdog", first.id, due, "held: the wake sent 20 min ago has not reached the session yet")
  const again = await w.poll(due + 5 * 60 * MIN)
  assert.deepEqual(again.wakes.map((wake) => wake.id), [first.id])
  assert.match(again.errors[0].error, /was not delivered: held/u)
  assert.match(again.status.at(-1), /due now, last error: the prompt was not delivered: held/u)
  w.ack("watchdog", first.id, due + 5 * 60 * MIN)
  assert.deepEqual((await w.poll(due + 5 * 60 * MIN + 30 * MIN)).wakes, [])
})

test("a wake that is not the one offered last is ignored, and an edited prompt is a new wake that withdraws the old text", async () => {
  const w = await world()
  await w.poll(NOW)
  const first = (await w.poll(NOW + 60 * MIN)).wakes[0]
  writeFileSync(w.paths.config, JSON.stringify({ schedules: [{ ...WATCHDOG, prompt: "Watchdog v2." }] }))
  const second = (await w.poll(NOW + 61 * MIN)).wakes[0]
  assert.notEqual(second.id, first.id)
  assert.equal(second.replaces, "Watchdog v2.")
  assert.equal(w.ack("watchdog", first.id, NOW + 62 * MIN).changed, false)
  assert.equal(readScheduleStates(w.paths.state).watchdog.offered, second.id)
  assert.equal(w.ack("watchdog", second.id, NOW + 62 * MIN).changed, true)
})

test("a changed interval counts from now, and a dropped schedule loses its state", async () => {
  const w = await world([WATCHDOG, { ...WATCHDOG, name: "other", prompt: "Other." }])
  await w.poll(NOW)
  writeFileSync(w.paths.config, JSON.stringify({ schedules: [{ ...WATCHDOG, everyMinutes: 10 }] }))
  const out = await w.poll(NOW + 30 * MIN)
  assert.deepEqual(out.wakes, [])
  assert.deepEqual(Object.keys(readScheduleStates(w.paths.state)), ["watchdog"])
  assert.equal((await w.poll(NOW + 40 * MIN)).wakes.length, 1)
})

test("status shows each schedule's last sent time and next run", async () => {
  const w = await world()
  assert.match((await w.poll(NOW)).status[0], /^schedule watchdog -> cfb84353: every 60m, never sent, next run in 60m \(2026-11-14T13:00:00.000Z\)$/u)
  const due = NOW + 60 * MIN
  const wake = (await w.poll(due)).wakes[0]
  w.ack("watchdog", wake.id, due)
  assert.match((await w.poll(due + 10 * MIN)).status[0], /last sent 10m ago, next run in 50m \(2026-11-14T14:00:00.000Z\)$/u)
})

test("a bad entry is an error naming it, never dropped", () => {
  const bad = (entry) => () => parseScheduleConfig(JSON.stringify({ schedules: [entry] }), "schedules.json")
  assert.throws(bad({ prompt: "p", everyMinutes: 5 }), /schedules\[0\]\.session is not a session id/u)
  assert.throws(bad({ session: "s", everyMinutes: 5 }), /schedules\[0\]\.prompt/u)
  assert.throws(bad({ session: "s", prompt: "p", everyMinutes: 0.5 }), /everyMinutes is not a whole number/u)
  assert.throws(() => parseScheduleConfig(JSON.stringify({ schedules: [{ session: "s", prompt: "a", everyMinutes: 1 }, { session: "s", prompt: "b", everyMinutes: 1 }] }), "f"), /reuses the name s/u)
  assert.throws(() => parseScheduleConfig("{", "f"), /is not valid JSON/u)
  assert.throws(() => parseScheduleConfig("{}", "f"), /no "schedules" array/u)
  assert.equal(parseScheduleConfig(JSON.stringify({ schedules: [{ session: " s ", prompt: "p", everyMinutes: 3 }] }), "f")[0].name, "s")
})

test("schedulePaths keeps its files beside the drains', under the state folder", () => {
  assert.equal(schedulePaths({ env: { XDG_STATE_HOME: "/state" } }).config, "/state/ouroboros-skills/desk/drains/schedules.json")
})

function cli(argv, extra = {}) {
  const out = []
  const err = []
  const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } }
  return runDrainsCli({ argv, script: SCRIPT, io, ...extra }).then((code) => ({ code, out: out.join(""), err: err.join("") }))
}

test("schedule poll, ack and status run through the command line with the state passed as a flag", async () => {
  const w = await world()
  const env = { XDG_STATE_HOME: path.join(w.dir, "xdg") }
  const flags = ["--config", w.paths.config, "--state", w.paths.state]
  assert.equal((await cli(["schedule", "poll", ...flags], { now: () => NOW, env })).code, 0)
  const polled = await cli(["schedule", "poll", ...flags], { now: () => NOW + 60 * MIN, env })
  const [wake] = JSON.parse(polled.out).wakes
  assert.deepEqual(wake.done.slice(-6), ["--name", "watchdog", "--wake", wake.id, "--state", w.paths.state])
  const acked = await cli(["schedule", "ack", "--name", "watchdog", "--wake", wake.id, "--state", w.paths.state], { now: () => NOW + 61 * MIN, env })
  assert.equal(JSON.parse(acked.out).changed, true)
  const status = await cli(["schedule", "status", ...flags], { now: () => NOW + 62 * MIN, env })
  assert.match(JSON.parse(status.out).status.at(-1), /last sent 1m ago, next run in 59m/u)
  for (const bad of [["schedule"], ["schedule", "nope"], ["schedule", "ack", "--name", "x"]]) assert.equal((await cli(bad, { env })).code, 2, bad.join(" "))
})

test("a config that cannot be read or is invalid fails the command with the reason and sends nothing", async () => {
  const w = await world()
  const env = { XDG_STATE_HOME: path.join(w.dir, "xdg") }
  const unreadable = await cli(["schedule", "status", "--config", w.dir], { env })
  assert.equal(unreadable.code, 1)
  assert.match(unreadable.err, /cannot be read \(EISDIR\)/u)
  writeFileSync(w.paths.config, "{")
  const invalid = await cli(["schedule", "poll", "--config", w.paths.config, "--state", w.paths.state], { env })
  assert.equal(invalid.code, 1)
  assert.match(invalid.err, /is not valid JSON/u)
})

test("a schedule with no config file has nothing to send, and an object that is not a schedule is rejected", async () => {
  const w = await world()
  assert.throws(() => parseScheduleConfig(JSON.stringify({ schedules: ["x"] }), "f"), /schedules\[0\] is not an object/u)
  assert.throws(() => parseScheduleConfig(JSON.stringify({ schedules: [{ session: "s", prompt: "p", everyMinutes: 1, name: " " }] }), "f"), /name is not a name/u)
  const out = await pollSchedules({ paths: { ...w.paths, config: path.join(w.dir, "missing.json") }, now: NOW, ackCommand: ["node"] })
  assert.deepEqual(out.wakes, [])
  assert.deepEqual(ackSchedule({ paths: w.paths, name: "none", wake: "x", now: NOW }).changed, false)
})

test("status reads in minutes and hours, a first poll has not run yet, and unreadable state starts over", async () => {
  const w = await world([{ ...WATCHDOG, everyMinutes: 180 }])
  const env = { XDG_STATE_HOME: path.join(w.dir, "xdg") }
  const flags = ["--config", w.paths.config, "--state", w.paths.state]
  assert.match(JSON.parse((await cli(["schedule", "status", ...flags], { now: () => NOW, env })).out).status.at(-1), /every 180m, not polled yet$/u)
  writeFileSync(w.paths.state, "[]")
  assert.match((await w.poll(NOW)).status[0], /next run in 3h /u)
  const wake = (await w.poll(NOW + 180 * MIN)).wakes[0]
  w.ack("watchdog", wake.id, NOW + 180 * MIN)
  assert.match((await w.poll(NOW + 180 * MIN)).status[0], /last sent under 1m ago/u)
  writeFileSync(w.paths.config, JSON.stringify({ schedules: [{ ...WATCHDOG, everyMinutes: 30 }] }))
  assert.match((await w.poll(NOW + 190 * MIN)).status[0], /last sent 10m ago, next run in 30m/u)
  assert.deepEqual(JSON.parse((await cli(["schedule", "poll"], { now: () => NOW, env })).out).wakes, [])
})
