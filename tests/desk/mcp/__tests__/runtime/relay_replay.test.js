// Relay replay: the real relays decide on recorded, sanitized GitHub data, and the answers are held to what the histories show.
// merge-large and merge-small are the final heads of recently merged pull requests of two repositories (checks with every attempt,
// and the main branch's completed runs); dispatch-pushed and dispatch-chained are a day of the watched workflow's runs for two relays.
// The fixtures and the tools that make them live in ./../fixtures/relays; see its README.
import assert from "node:assert/strict"
import { test } from "node:test"
import { checksAt, loadFixture, mergeRelay, replayDispatch, replayMerge } from "../_relay_replay.js"

const BAD = new Set(["failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"])

const decisions = async (fixture, options) => Promise.all(fixture.pulls.map(async (pull) => ({ pull, ...(await replayMerge(fixture, pull, options)) })))

test("merge replay, large repository: 31 of 40 merge, and each of the 9 held back waits for the main branch's red run", async () => {
  const fixture = loadFixture("merge-large.json")
  const results = await decisions(fixture)
  assert.equal(results.length, 40)
  const merges = results.filter((result) => result.merge)
  const held = results.filter((result) => !result.merge)
  assert.equal(merges.length, 31)
  for (const result of held) assert.match(result.waiting.join(" "), /main's latest completed ci\.yml run \d+ .* is failure/u, `${result.pull.name} waits for an unexpected reason: ${result.waiting}`)
  assert.equal(held.length, 9)
  assert.equal(held.filter((result) => /main's latest completed/u.test(result.waiting.join(" "))).length, 9)
  assert.equal(held.filter((result) => /visual proof failure/u.test(result.waiting.join(" "))).length, 1)
  assert.deepEqual(results.filter((result) => result.error), [])
})

test("merge replay, small repository: all 20 pull requests that merged green are merged by the relay", async () => {
  const fixture = loadFixture("merge-small.json")
  const results = await decisions(fixture)
  assert.deepEqual(results.filter((result) => !result.merge).map((result) => [result.pull.name, result.waiting]), [])
})

test("merge replay: an attempt superseded by a rerun does not hold a pull request, and the head's list as GitHub returns it gives the same answer", async () => {
  for (const name of ["merge-large.json", "merge-small.json"]) {
    const fixture = loadFixture(name)
    const superseded = fixture.pulls.filter((pull) => pull.checks.some((check) => BAD.has(check.conclusion)))
    assert.ok(superseded.length >= 4, `${name} has pull requests with failed attempts`)
    for (const pull of fixture.pulls) {
      const all = await replayMerge(fixture, pull)
      const latest = await replayMerge(fixture, pull, { source: "latest" })
      assert.equal(latest.merge, all.merge, `${name} ${pull.name}`)
    }
  }
})

test("merge replay, safety: the relay never merges while a required check's newest attempt is failed, cancelled or unfinished", async () => {
  for (const name of ["merge-large.json", "merge-small.json"]) {
    const fixture = loadFixture(name)
    const patterns = fixture.requiredChecks.map((required) => new RegExp(`^${required.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u"))
    for (const pull of fixture.pulls) {
      const first = Math.min(...pull.checks.map((check) => check.started ?? 0))
      for (let at = first; at <= 0; at += 60) {
        const checks = checksAt(pull, at)
        const newest = new Map()
        for (const check of checks) if (!newest.has(check.name) || check.started_at > newest.get(check.name).started_at || (check.started_at === newest.get(check.name).started_at && check.id > newest.get(check.name).id)) newest.set(check.name, check)
        const unsafe = [...newest.values()].filter((check) => patterns.some((pattern) => pattern.test(check.name)) && (check.status !== "completed" || BAD.has(check.conclusion)))
        if (unsafe.length === 0) continue
        const decision = await replayMerge(fixture, pull, { at })
        assert.equal(decision.merge, false, `${name} ${pull.name} at ${at}s would merge with ${unsafe.map((check) => `${check.name} ${check.conclusion ?? check.status}`)}`)
      }
    }
  }
})

test("merge replay: a matrix job skipped before it expanded does not hold a pull request whose matrix did run, with or without skippedPasses", async () => {
  const fixture = loadFixture("merge-large.json")
  const relay = mergeRelay(fixture, { skippedPasses: false, requireMainWorkflowGreen: undefined })
  const results = await Promise.all(fixture.pulls.map(async (pull) => ({ pull, ...(await replayMerge(fixture, pull, { relay })) })))
  const merged = results.filter((result) => result.merge)
  assert.equal(merged.length, 34)
  // A pull request whose checks were all skipped by path filters still waits without skippedPasses: a skip passes only when asked.
  for (const result of results.filter((entry) => !entry.merge)) assert.match(result.waiting.join(" "), /skipped|visual proof failure/u)
})

test("dispatch replay: a day of pushed runs fires once per head, after the settle", async () => {
  const fixture = loadFixture("dispatch-pushed.json")
  const { fires, errors } = await replayDispatch(fixture)
  assert.deepEqual(errors, [])
  assert.equal(fires.length, 36)
  assert.equal(new Set(fires.map((fire) => fire.head)).size, fires.length)
  const firstSuccess = new Map()
  for (const run of fixture.runs) if (run.conclusion === "success" && !firstSuccess.has(run.head)) firstSuccess.set(run.head, run.completed)
  for (const fire of fires) assert.ok(fire.at >= firstSuccess.get(fire.head) + fixture.settleSeconds, `${fire.head} fired at ${fire.at}, before it had settled`)
})

test("dispatch replay: a head that a newer head replaces inside the settle never fires, and every other head fires once", async () => {
  const fixture = loadFixture("dispatch-chained.json")
  const { fires } = await replayDispatch(fixture)
  assert.equal(new Set(fires.map((fire) => fire.head)).size, fires.length)
  const succeeded = new Set(fixture.runs.filter((run) => run.conclusion === "success" && run.completed >= 0).map((run) => run.head))
  const fired = new Set(fires.map((fire) => fire.head))
  const skipped = [...succeeded].filter((head) => !fired.has(head))
  assert.equal(fires.length, 68)
  assert.equal(skipped.length, 2)
})

test("dispatch replay: a second run on a head that finishes after the next head has fired does not fire the old head again", async () => {
  for (const name of ["dispatch-pushed.json", "dispatch-chained.json"]) {
    const fixture = loadFixture(name)
    const first = new Map()
    for (const run of fixture.runs) if (run.conclusion === "success" && !first.has(run.head)) first.set(run.head, run)
    // The recorded days show a second event's run on half the heads, a few minutes after the first; here every head gets one, seven minutes late.
    const repeats = [...first.values()].map((run, index) => ({ id: 10_000 + index, head: run.head, attempt: 1, status: "completed", conclusion: "success", created: run.completed + 60, completed: run.completed + 420 }))
    const plain = await replayDispatch(fixture)
    const { fires } = await replayDispatch({ ...fixture, runs: [...fixture.runs, ...repeats] })
    assert.deepEqual(fires.map((fire) => fire.head), plain.fires.map((fire) => fire.head), `${name}: a repeat run changed which heads fire`)
  }
})
