// Relays: a dispatch relay fires once per new successful run, and a merge-when-green relay merges only when every required check is green.
// A fake GitHub answers by route pattern with real ETag semantics; every config, state and lock file lives under a temporary root.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { connectGithub } from "../../../../../plugins/desk/mcp/src/runtime/drains.js"
import { runDrainsCli } from "../../../../../plugins/desk/mcp/src/runtime/drains-cli.js"
import { parseRelayConfig, pollRelays, readRelayConfig, readRelayStates, relayPaths, relayStatusLines, relaysOfPull, waitReadMs, waitingOnChecks, whyRelay } from "../../../../../plugins/desk/mcp/src/runtime/relays.js"

const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/drains.js", import.meta.url))
const NOW = Date.parse("2026-11-14T12:00:00Z")
const SECOND = 1000
const MIN = 60_000
const SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)

const DISPATCH = {
  name: "data to pages",
  type: "dispatch",
  watch: { repo: "o/data", workflow: "data.yml", branch: "main", conclusion: "success" },
  fire: { repo: "o/pages", workflow: "pages.yml", inputs: { cit_commit: "{{run.head_sha}}", delivery_id: "relay-{{run.id}}" } },
}
/** The run-by-run cases below fire on the poll that sees a head, so they settle at once; the default settle has its own tests. */
const IMMEDIATE = { ...DISPATCH, settleSeconds: 0 }
const HEAD_A = "1".repeat(40)
const HEAD_B = "2".repeat(40)
const MERGE = {
  name: "pages merge",
  type: "merge-when-green",
  repo: "o/pages",
  label: "merge-when-green",
  method: "squash",
  deleteBranch: true,
  requiredChecks: ["typecheck", "npm test (ubuntu-latest, *)"],
  requireMainWorkflowGreen: "ci.yml",
}

const run = (id, extra = {}) => ({ id, status: "completed", conclusion: "success", head_sha: `sha${id}`, head_branch: "main", html_url: `https://github.test/runs/${id}`, run_number: id, updated_at: new Date(NOW + id * SECOND).toISOString(), ...extra })
const check = (name, conclusion = "success", status = "completed") => ({ name, status, conclusion: status === "completed" ? conclusion : null })
const GREEN = [check("typecheck"), check("npm test (ubuntu-latest, 1/2)"), check("npm test (ubuntu-latest, 2/2)")]

/** A GitHub that answers by pattern, keeps If-None-Match semantics and records every read and write. */
function github() {
  const handlers = []
  const world = {
    reads: [],
    writes: [],
    notModified: 0,
    on: (method, pattern, answer) => handlers.unshift({ method, pattern, answer }),
    pull: (number, extra = {}) => world.on("GET", new RegExp(`/pulls/${number}$`, "u"), () => ({ state: "open", draft: false, mergeable: true, mergeable_state: "clean", labels: [{ name: "merge-when-green" }], title: "Fix pages", body: "Why.\r\n\r\nCo-authored-by: copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>\nCo-authored-by: Ana <ana@example.com>", head: { sha: SHA, ref: "feature/x", repo: { full_name: "o/pages" } }, base: { ref: "main", repo: { full_name: "o/pages" } }, ...extra })),
    connect: async () => ({
      login: "relay-bot",
      get: async (route, { etag } = {}) => {
        world.reads.push({ route, etag })
        const handler = handlers.find((candidate) => candidate.method === "GET" && candidate.pattern.test(route))
        if (!handler) throw Object.assign(new Error(`no answer for ${route}`), { status: 404 })
        const body = handler.answer(route)
        const tag = `"${createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 12)}"`
        if (etag === tag) {
          world.notModified += 1
          return { notModified: true }
        }
        return { body, etag: tag, next: world.more?.(route) ?? false }
      },
      send: async (method, route, body) => {
        world.writes.push({ method, route, body })
        const handler = handlers.find((candidate) => candidate.method === method && candidate.pattern.test(route))
        return handler ? handler.answer(route, body) : { ok: true, status: 204, body: {} }
      },
      quota: () => (world.noQuota ? null : world.quota) ?? { remaining: 4000, limit: 5000, reset: NOW / 1000 + 3600, at: new Date(NOW).toISOString() },
      calls: () => ({ total: world.reads.length + world.writes.length, notModified: world.notModified }),
    }),
  }
  return world
}

async function setup(relays, { drains = [] } = {}) {
  const dir = await mkTempRoot("desk-relays-")
  const paths = { config: path.join(dir, "relays.json"), state: path.join(dir, "relays-state.json"), lock: path.join(dir, "relays.lock") }
  const drainFiles = { config: path.join(dir, "config.json"), state: path.join(dir, "state.json") }
  writeFileSync(paths.config, JSON.stringify({ relays }))
  writeFileSync(drainFiles.config, JSON.stringify({ drains }))
  const world = github()
  // Each poll is a new call that reads the state file again, the way each runner start is a new process.
  const poll = (at = NOW) => pollRelays({ paths, drainFiles, connect: world.connect, now: at })
  return { dir, paths, drainFiles, world, poll, state: (name) => readRelayStates(paths.state)[name] }
}

const runsRoute = /\/repos\/o\/data\/actions\/workflows\/data\.yml\/runs\?status=success.*branch=main/u
const prWrites = (world) => world.writes.filter((write) => write.route.includes("/pulls/"))
const comments = (world) => world.writes.filter((write) => write.route.includes("/comments"))

function mergeWorld(world, { checks = GREEN, statuses = [], main = [{ id: 9, conclusion: "success", html_url: "https://github.test/runs/9" }], pr = {} } = {}) {
  world.on("GET", /\/issues\?state=open&labels=merge-when-green/u, () => [{ number: 7, pull_request: {} }, { number: 8 }])
  world.pull(7, pr)
  world.on("GET", /\/commits\/a+\/check-runs/u, () => ({ total_count: checks.length, check_runs: checks }))
  // With no statuses GitHub still answers a combined state of pending, which says nothing.
  world.on("GET", /\/commits\/a+\/status/u, () => ({ state: statuses.length === 0 ? "pending" : "failure", total_count: statuses.length, statuses }))
  world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "main" }))
  // As GitHub does, a runs list asked for with status=completed leaves out queued and in-progress runs.
  world.on("GET", /\/workflows\/ci\.yml\/runs\?branch=main/u, (route) => ({ workflow_runs: main.map((run) => ({ status: "completed", html_url: `https://github.test/runs/${run.id}`, ...run })).filter((run) => !route.includes("status=completed") || run.status === "completed") }))
  world.on("GET", /\/issues\/7\/comments/u, () => [])
  world.on("PUT", /\/pulls\/7\/merge$/u, () => ({ ok: true, status: 200, body: { merged: true, sha: MERGED_SHA } }))
  world.on("POST", /\/issues\/7\/comments$/u, () => ({ ok: true, status: 201, body: { id: 55 } }))
}

test("a relay config is validated: a bad entry is named, never dropped", () => {
  const bad = (entry, message) => assert.throws(() => parseRelayConfig(JSON.stringify({ relays: [entry] }), "relays.json"), message)
  bad({ ...DISPATCH, type: "other" }, /relays\[0\]\.type is not "dispatch" or "merge-when-green"/u)
  bad({ ...DISPATCH, fire: { repo: "o/pages", workflow: "a.yml", event: "x" } }, /exactly one of "workflow"/u)
  bad({ ...DISPATCH, fire: { repo: "o/pages", workflow: "a.yml", inputs: { a: "{{run.secret}}" } } }, /names \{\{run\.secret\}\}/u)
  bad({ ...DISPATCH, watch: { ...DISPATCH.watch, conclusion: "failure" } }, /the only conclusion that fires/u)
  bad({ ...MERGE, requiredChecks: [] }, /requiredChecks is not a non-empty list/u)
  bad({ ...MERGE, method: "fast-forward" }, /method is not "squash", "merge" or "rebase"/u)
  bad({ ...MERGE, everySeconds: 3 }, /everySeconds is not a whole number of seconds, 10 or more/u)
  const mergeless = { name: "m", type: "merge-when-green", repo: "o/r", requiredChecks: ["ci"] }
  bad("x", /relays\[0\] is not an object/u)
  bad({ ...DISPATCH, name: "" }, /\.name is not a name/u)
  bad({ ...DISPATCH, account: 5 }, /\.account is not a GitHub login/u)
  bad({ ...DISPATCH, readAccount: 5 }, /\.readAccount is not a GitHub login/u)
  bad({ ...DISPATCH, watch: { repo: "o/data" } }, /\.watch needs "repo" \(owner\/name\) and "workflow"/u)
  bad({ ...DISPATCH, watch: { ...DISPATCH.watch, branch: 5 } }, /watch\.branch is not a branch name/u)
  bad({ ...DISPATCH, fire: {} }, /\.fire needs "repo"/u)
  bad({ ...DISPATCH, fire: { repo: "o/p", workflow: "a.yml", ref: 5 } }, /fire\.ref is not a branch name/u)
  bad({ ...DISPATCH, fire: { repo: "o/p", workflow: "a.yml", inputs: "x" } }, /fire\.inputs is not an object/u)
  bad({ ...DISPATCH, fire: { repo: "o/p", workflow: "a.yml", inputs: { a: 1 } } }, /fire\.inputs\.a is not text/u)
  bad({ ...DISPATCH, fire: { repo: "o/p", event: "x", inputs: { a: "b" } } }, /inputs only goes with "workflow"/u)
  bad({ ...mergeless, repo: "nope" }, /\.repo is not "owner\/name"/u)
  bad({ ...mergeless, label: 5 }, /\.label is not a label name/u)
  bad({ ...mergeless, deleteBranch: "yes" }, /deleteBranch is not true or false/u)
  bad({ ...mergeless, requireMainWorkflowGreen: 5 }, /requireMainWorkflowGreen is not a workflow file name/u)
  assert.throws(() => parseRelayConfig("null", "relays.json"), /has no "relays" array/u)
  assert.throws(() => parseRelayConfig(JSON.stringify({ relays: [DISPATCH, DISPATCH] }), "relays.json"), /reuses the name data to pages/u)
  bad({ ...DISPATCH, settleSeconds: -1 }, /\.settleSeconds is not a whole number of seconds, from 0 to 3600/u)
  bad({ ...DISPATCH, settleSeconds: 1.5 }, /\.settleSeconds is not a whole number/u)
  bad({ ...DISPATCH, settleSeconds: 3601 }, /\.settleSeconds is not a whole number/u)
  const [loose, full] = parseRelayConfig(JSON.stringify({ relays: [{ name: " x ", type: "dispatch", account: " me ", everySeconds: 45, watch: { repo: "o/a", workflow: " a.yml " }, fire: { repo: "o/b", workflow: " b.yml ", ref: " dev " } }, { ...mergeless, label: " go ", method: "rebase", deleteBranch: false, requireMainWorkflowGreen: " ci.yml " }] }), "relays.json")
  assert.deepEqual(loose, { name: "x", type: "dispatch", account: "me", everySeconds: 45, watch: { repo: "o/a", workflow: "a.yml", conclusion: "success" }, fire: { repo: "o/b", workflow: "b.yml", ref: "dev" }, settleSeconds: 60 })
  assert.equal(parseRelayConfig(JSON.stringify({ relays: [{ ...DISPATCH, settleSeconds: 0 }] }), "relays.json")[0].settleSeconds, 0)
  assert.deepEqual(full, { name: "m", type: "merge-when-green", everySeconds: 30, repo: "o/r", label: "go", method: "rebase", deleteBranch: false, requiredChecks: ["ci"], requireMainWorkflowGreen: "ci.yml" })
  assert.throws(() => parseRelayConfig("{", "relays.json"), /is not valid JSON/u)
  const [merge] = parseRelayConfig(JSON.stringify({ relays: [mergeless] }), "relays.json")
  assert.deepEqual({ label: merge.label, method: merge.method, deleteBranch: merge.deleteBranch, everySeconds: merge.everySeconds }, { label: "merge-when-green", method: "squash", deleteBranch: true, everySeconds: 30 })
})

test("a missing relays file is no relays, and an unreadable one is an error that says what to do", async () => {
  const dir = await mkTempRoot("desk-relays-")
  assert.deepEqual(readRelayConfig(path.join(dir, "none.json")), [])
  assert.throws(() => readRelayConfig(dir), /relays config: .*cannot be read \(EISDIR\)/u)
  assert.deepEqual(readRelayStates(path.join(dir, "none.json")), {})
  writeFileSync(path.join(dir, "state.json"), "[]")
  assert.deepEqual(readRelayStates(path.join(dir, "state.json")), {})
})

test("dispatch: the first poll only records the runs that already succeeded, then each new run fires once", async () => {
  const w = await setup([IMMEDIATE])
  let runs = [run(1), run(2)]
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  w.world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "trunk" }))
  assert.deepEqual((await w.poll(NOW)).wakes, [])
  assert.deepEqual(w.world.writes, [], "runs that were already green do not fire")
  assert.deepEqual((await w.poll(NOW + 30 * SECOND)).errors, [])
  assert.deepEqual(w.world.writes, [])

  runs = [run(3), ...runs]
  await w.poll(NOW + 60 * SECOND)
  assert.equal(w.world.writes.length, 1)
  assert.deepEqual(w.world.writes[0], { method: "POST", route: "/repos/o/pages/actions/workflows/pages.yml/dispatches", body: { ref: "trunk", inputs: { cit_commit: "sha3", delivery_id: "relay-3" } } })
  await w.poll(NOW + 90 * SECOND)
  assert.equal(w.world.writes.length, 1, "the same run never fires twice")
  assert.equal(w.state("data to pages").lastFire.runId, 3)

  runs = [run(4), ...runs]
  await w.poll(NOW + 120 * SECOND)
  assert.equal(w.world.writes.length, 2)
  assert.equal(w.world.writes[1].body.inputs.cit_commit, "sha4")
})

test("dispatch: a failed run never fires, and runs that pile up between polls fire once for the newest", async () => {
  const w = await setup([{ ...IMMEDIATE, fire: { repo: "o/pages", event: "data-ready" } }])
  let runs = [run(1)]
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  await w.poll(NOW)
  runs = [run(2, { conclusion: "failure" }), run(3, { status: "in_progress", conclusion: null }), ...runs]
  await w.poll(NOW + MIN)
  assert.deepEqual(w.world.writes, [])
  runs = [run(6), run(5), run(4), ...runs]
  await w.poll(NOW + 2 * MIN)
  assert.equal(w.world.writes.length, 1)
  assert.deepEqual(w.world.writes[0], { method: "POST", route: "/repos/o/pages/dispatches", body: { event_type: "data-ready", client_payload: { relay: "data to pages", run_id: 6, run_url: "https://github.test/runs/6", head_sha: "sha6", head_branch: "main" } } })
  assert.match(relayStatusLines([DISPATCH], { [DISPATCH.name]: w.state(DISPATCH.name) }, NOW + 2 * MIN)[0], /last fired .* for run 6/u)
  assert.equal(w.state(DISPATCH.name).lastFire.runs, 3)
})

test("dispatch: a 304 costs nothing and changes nothing, across a restart too, and a new run after it still fires", async () => {
  const w = await setup([IMMEDIATE])
  let runs = [run(1)]
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  w.world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "main" }))
  await w.poll(NOW)
  assert.equal(w.world.reads[0].etag, undefined)
  await w.poll(NOW + 30 * SECOND)
  const second = w.world.reads.at(-1)
  assert.match(second.etag, /^"[0-9a-f]{12}"$/u, "the stored tag goes out as If-None-Match")
  assert.equal(w.world.notModified, 1)
  assert.equal(w.world.writes.length, 0)
  runs = [run(2), ...runs]
  await w.poll(NOW + 60 * SECOND)
  assert.equal(w.world.notModified, 1, "a changed list is a full answer")
  assert.equal(w.world.writes.length, 1)
  assert.equal(Object.values(w.state(DISPATCH.name).cache).find((entry) => Array.isArray(entry.value)).value.length, 2, "the answer's meaning is kept next to its tag")
})

test("a relay failure that carries a stable code keeps it beside its text until the next good poll", async () => {
  const w = await setup([IMMEDIATE])
  w.world.on("GET", runsRoute, () => { throw Object.assign(new Error("no token"), { code: "relay_no_token" }) })
  const failed = await w.poll(NOW)
  assert.deepEqual(failed.errors, [{ relay: DISPATCH.name, error: "no token", code: "relay_no_token" }])
  w.world.on("GET", runsRoute, () => { throw new Error("plain") })
  assert.equal("code" in (await w.poll(NOW + 10 * MIN)).errors[0], false)
  w.world.on("GET", runsRoute, () => ({ workflow_runs: [] }))
  w.world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "main" }))
  assert.deepEqual((await w.poll(NOW + 20 * MIN)).errors, [])
  assert.equal(w.state(DISPATCH.name).lastErrorCode, undefined)
})

test("dispatch: the handled runs survive a restart, so nothing fires again, and a refused fire is kept for a retry", async () => {
  const w = await setup([IMMEDIATE])
  const runs = [run(1)]
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  w.world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "main" }))
  await w.poll(NOW)
  runs.unshift(run(2))
  let refuse = true
  w.world.on("POST", /dispatches$/u, () => (refuse ? { ok: false, status: 422, body: { message: "Workflow does not have 'workflow_dispatch' trigger" } } : { ok: true, status: 204, body: {} }))
  const failed = await w.poll(NOW + MIN)
  assert.match(failed.errors[0].error, /HTTP 422 \(Workflow does not have 'workflow_dispatch' trigger\)/u)
  assert.equal(w.state(DISPATCH.name).lastFire, undefined)
  await w.poll(NOW + 2 * MIN)
  assert.equal(w.world.writes.length, 1, "a refused fire waits five minutes before it tries again")
  assert.match(w.state(DISPATCH.name).waitingOn, /^a fire GitHub refused, to be tried again after 2026-11-14T12:06:00\.000Z$/u)
  refuse = false
  await w.poll(NOW + 7 * MIN)
  assert.equal(w.world.writes.length, 2)
  assert.deepEqual((await w.poll(NOW + 8 * MIN)).errors, [])
  assert.equal(w.world.writes.length, 2)
  const again = await setup([IMMEDIATE])
  writeFileSync(again.paths.state, readFileSync(w.paths.state))
  again.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  await again.poll(NOW + 9 * MIN)
  assert.equal(again.world.writes.length, 0, "a fresh process with the saved state does not fire the handled run")
})

test("dispatch: the same head succeeding five times fires once, for that head, and later successes on it never fire", async () => {
  const w = await setup([DISPATCH])
  let runs = [run(1)]
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  w.world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "main" }))
  await w.poll(NOW)
  for (const id of [2, 3, 4, 5, 6]) {
    runs = [run(id, { head_sha: HEAD_A }), ...runs]
    await w.poll(NOW + (id - 1) * 30 * SECOND)
  }
  assert.equal(w.world.writes.length, 1, "the head fires once, after its settle, and not on each success")
  assert.equal(w.world.writes[0].body.inputs.cit_commit, HEAD_A)
  const state = w.state(DISPATCH.name)
  assert.deepEqual({ runId: state.lastFire.runId, headSha: state.lastFire.headSha, runs: state.lastFire.runs }, { runId: 4, headSha: HEAD_A, runs: 3 }, "it names the newest run on the head, and counts the successes it covers")
  const [relay] = readRelayConfig(w.paths.config)
  const [line] = relayStatusLines([relay], { [relay.name]: state }, NOW + 150 * SECOND)
  assert.match(line, /last fired 1m ago for run 4 on head 1111111 -> o\/pages pages\.yml, settle 60s, waiting on/u)
  assert.equal(whyRelay([relay], { [relay.name]: state }, relay.name).lastFiredHead, HEAD_A)
})

test("dispatch: a late success on a head that already fired, or was replaced by a newer head, never fires after the newer head", async () => {
  const w = await setup([{ ...DISPATCH, everySeconds: 10 }])
  let runs = [run(1)]
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  w.world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "main" }))
  await w.poll(NOW)
  const at = async (seconds, add) => {
    if (add) runs = [add, ...runs]
    await w.poll(NOW + seconds * SECOND)
  }
  await at(10, run(2, { head_sha: HEAD_A }))
  await at(20, run(3, { head_sha: HEAD_B }))
  await at(90)
  assert.deepEqual(w.world.writes.map((write) => write.body.inputs.cit_commit), [HEAD_B], "head A was replaced inside the settle")
  await at(100, run(4, { head_sha: HEAD_A }))
  await at(200, run(5, { head_sha: HEAD_B }))
  await at(400)
  assert.equal(w.world.writes.length, 1, "a later run on the replaced head, or on the fired head, fires nothing")
  await at(410, run(6, { head_sha: "3".repeat(40) }))
  await at(500)
  await at(510, run(7, { head_sha: HEAD_B }))
  await at(600)
  assert.deepEqual(w.world.writes.map((write) => write.body.inputs.cit_commit), [HEAD_B, "3".repeat(40)], "a fired head stays fired after a newer head fired")
})

test("dispatch: two heads 20 seconds apart fire once, for the newer, once the newer one has settled", async () => {
  const w = await setup([{ ...DISPATCH, everySeconds: 10 }])
  let runs = [run(1)]
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  w.world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "main" }))
  await w.poll(NOW)
  for (let at = 10; at <= 90; at += 10) {
    if (at === 10) runs = [run(2, { head_sha: HEAD_A }), ...runs]
    if (at === 30) runs = [run(3, { head_sha: HEAD_B }), ...runs]
    await w.poll(NOW + at * SECOND)
    assert.equal(w.world.writes.length, at === 90 ? 1 : 0, `at ${at}s`)
    if (at === 70) {
      const [relay] = readRelayConfig(w.paths.config)
      const states = { [relay.name]: w.state(relay.name) }
      assert.match(relayStatusLines([relay], states, NOW + at * SECOND)[0], /head 2222222 \(run 3\) pending, settle 60s, waiting on 60s with no newer/u)
      assert.deepEqual([whyRelay([relay], states, relay.name).pending.run.id, whyRelay([relay], states, relay.name).lastFiredHead], [3, null])
    }
  }
  assert.deepEqual(w.world.writes[0].body.inputs, { cit_commit: HEAD_B, delivery_id: "relay-3" }, "the older head never fires")
  assert.equal(w.state(DISPATCH.name).lastFire.runs, 2)
  assert.equal(w.state(DISPATCH.name).pending, undefined)
})

test("dispatch: an older run that is listed late does not displace the newer head that is pending", async () => {
  const w = await setup([{ ...DISPATCH, everySeconds: 10 }])
  let runs = [run(1)]
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  w.world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "main" }))
  await w.poll(NOW)
  runs = [run(3, { head_sha: HEAD_B }), ...runs]
  await w.poll(NOW + 30 * SECOND)
  runs = [run(2, { head_sha: HEAD_A }), ...runs]
  await w.poll(NOW + 40 * SECOND)
  await w.poll(NOW + 60 * SECOND)
  assert.equal(w.world.writes.length, 0, "the newer head keeps its own quiet period")
  await w.poll(NOW + 90 * SECOND)
  assert.deepEqual(w.world.writes.map((write) => write.body.inputs), [{ cit_commit: HEAD_B, delivery_id: "relay-3" }])
})

test("dispatch: a restart neither refires a fired head nor loses a fire that is still settling", async () => {
  const mocks = (world, current) => {
    world.on("GET", runsRoute, () => ({ workflow_runs: current() }))
    world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "main" }))
  }
  const w = await setup([DISPATCH])
  let runs = [run(1)]
  mocks(w.world, () => runs)
  await w.poll(NOW)
  runs = [run(2, { head_sha: HEAD_A }), ...runs]
  await w.poll(NOW + 30 * SECOND)
  const restarted = await setup([DISPATCH])
  writeFileSync(restarted.paths.state, readFileSync(w.paths.state))
  mocks(restarted.world, () => runs)
  await restarted.poll(NOW + 60 * SECOND)
  assert.equal(restarted.world.writes.length, 0, "the pending fire is still settling after the restart")
  await restarted.poll(NOW + 90 * SECOND)
  assert.equal(restarted.world.writes.length, 1, "and it fires once the settle has passed")
  const again = await setup([DISPATCH])
  writeFileSync(again.paths.state, readFileSync(restarted.paths.state))
  mocks(again.world, () => runs)
  await again.poll(NOW + 3 * MIN)
  await again.poll(NOW + 4 * MIN)
  assert.equal(again.world.writes.length, 0, "a fired head does not fire again after a restart")
  assert.equal(again.state(DISPATCH.name).lastFire.headSha, HEAD_A)
})

test("a relay polls about every 30 seconds, never twice as often, and pauses when the quota is nearly spent", async () => {
  const w = await setup([DISPATCH], { drains: [{ repo: "o/data", session: "s", account: "acct" }, { repo: "o/other", session: "s", account: "acct" }] })
  w.world.on("GET", runsRoute, () => ({ workflow_runs: [run(1)] }))
  await w.poll(NOW)
  await w.poll(NOW + 10 * SECOND)
  assert.equal(w.world.reads.length, 1)
  await w.poll(NOW + 26 * SECOND)
  assert.equal(w.world.reads.length, 2, "a runner that jitters a few seconds early still polls")
  await w.poll(NOW + 56 * SECOND)
  assert.equal(w.world.reads.length, 3)
  w.world.quota = { remaining: 20, limit: 5000, reset: NOW / 1000 + 3600, at: new Date(NOW + 56 * SECOND).toISOString() }
  await w.poll(NOW + 90 * SECOND)
  const held = await w.poll(NOW + 2 * MIN)
  assert.equal(w.world.reads.length, 4, "the quota reading from the last poll holds the next one")
  assert.match(held.status.join("\n"), /held: 20\/5000 calls left, paused until/u)
  w.world.quota = null
  writeFileSync(w.drainFiles.state, JSON.stringify({ "o/data": { quota: { remaining: 4000, limit: 5000, reset: NOW / 1000 + 3600, at: new Date(NOW + 3 * MIN).toISOString() } } }))
  await w.poll(NOW + 3 * MIN)
  assert.equal(w.world.reads.length, 5, "a fresher reading from the issue drains of the same account lifts the hold")
  writeFileSync(w.drainFiles.state, JSON.stringify({ "o/data": { quota: { remaining: 10, limit: 5000, reset: NOW / 1000 + 3600, at: new Date(NOW + 4 * MIN).toISOString() } } }))
  await w.poll(NOW + 4 * MIN)
  assert.equal(w.world.reads.length, 5, "and a low one from them holds this relay")
})

test("an account comes from the relay, else from the drains config of its repository", async () => {
  const seen = []
  const w = await setup([DISPATCH, { ...MERGE, name: "own", account: "mine" }], { drains: [{ repo: "o/data", session: "s", account: "work" }] })
  w.world.on("GET", /.*/u, () => ({ workflow_runs: [], check_runs: [], total_count: 0 }))
  const connect = async (account, options) => { seen.push([account, options.login]); return w.world.connect() }
  await pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: NOW })
  assert.deepEqual(seen.sort(), [["mine", "mine"], ["work", "work"]])
})

test("waitingOnChecks names every required check that is missing, pending or not green", () => {
  assert.deepEqual(waitingOnChecks(["typecheck", "npm test (ubuntu-latest, *)"], GREEN), [])
  assert.deepEqual(waitingOnChecks(["typecheck"], [check("typecheck", null, "in_progress")]), ["typecheck: typecheck in_progress"])
  assert.deepEqual(waitingOnChecks(["typecheck"], [check("typecheck", "skipped")]), ["typecheck: typecheck skipped"])
  assert.deepEqual(waitingOnChecks(["visual proof"], GREEN), ["visual proof: not started"])
  assert.deepEqual(waitingOnChecks(["npm test (ubuntu-latest, *)"], [check("npm test (ubuntu-latest, 1/2)"), check("npm test (ubuntu-latest, 2/2)", "failure")]), ["npm test (ubuntu-latest, *): 1 of 2 not green (npm test (ubuntu-latest, 2/2) failure)"])
  assert.deepEqual(waitingOnChecks(["a.b"], [check("axb")]), ["a.b: not started"], "only * is a wildcard")
})

test("waitingOnChecks: a check that is not required blocks while it failed or runs, and a skipped one that nothing requires does not", () => {
  const verdict = (runs, statuses) => waitingOnChecks(["typecheck"], [check("typecheck"), ...runs], false, statuses)
  assert.deepEqual(verdict([check("weekly-page", "failure")]), ["1 other check on the head not green (weekly-page failure)"])
  assert.deepEqual(verdict([check("weekly-page", null, "in_progress")]), ["1 other check on the head not green (weekly-page in_progress)"])
  assert.deepEqual(verdict([check("weekly-page", null, "queued"), check("docs", "cancelled")]), ["1 other check on the head not green (weekly-page queued)"])
  assert.deepEqual(verdict([check("docs", "cancelled")]), [], "a cancelled check that is not required does not hold")
  for (const conclusion of ["timed_out", "action_required", "stale", "startup_failure"]) assert.equal(verdict([check("weekly-page", conclusion)]).length, 1, conclusion)
  assert.deepEqual(verdict([check("weekly-page", "skipped"), check("docs", "neutral"), check("lint")]), [])
  assert.deepEqual(waitingOnChecks(["typecheck"], [check("typecheck"), check("weekly-page", "skipped")], true), [])
})

test("waitingOnChecks: a failed attempt superseded by a green rerun of a check that is not required does not block, and a newer failed one does", () => {
  const attempt = (id, conclusion, startedAt) => ({ id, name: "weekly-page", status: "completed", conclusion, started_at: startedAt })
  const rest = [check("typecheck")]
  assert.deepEqual(waitingOnChecks(["typecheck"], [attempt(1, "failure", "2026-11-14T20:42:38Z"), attempt(2, "success", "2026-11-14T20:47:21Z"), ...rest]), [])
  assert.deepEqual(waitingOnChecks(["typecheck"], [attempt(1, "success", "2026-11-14T20:42:38Z"), attempt(2, "failure", "2026-11-14T20:47:21Z"), ...rest]), ["1 other check on the head not green (weekly-page failure)"])
})

test("waitingOnChecks: every commit status on the head must be success, a pending one counts as running, and a required name can be a status context", () => {
  const verdict = (statuses, required = ["typecheck"]) => waitingOnChecks(required, [check("typecheck")], false, statuses)
  assert.deepEqual(verdict([{ context: "ci/legacy", state: "success" }]), [])
  assert.deepEqual(verdict([{ context: "ci/legacy", state: "failure" }]), ["1 other check on the head not green (ci/legacy failure)"])
  assert.deepEqual(verdict([{ context: "ci/legacy", state: "error" }]), ["1 other check on the head not green (ci/legacy failure)"])
  assert.deepEqual(verdict([{ context: "ci/legacy", state: "pending" }]), ["1 other check on the head not green (ci/legacy in_progress)"])
  assert.deepEqual(verdict([{ context: "ci/legacy", state: "success" }], ["typecheck", "ci/*"]), [])
  assert.deepEqual(verdict([{ context: "ci/legacy", state: "pending" }], ["typecheck", "ci/*"]), ["ci/*: ci/legacy in_progress"])
  assert.deepEqual(waitingOnChecks(["typecheck"], [check("ci/legacy", "failure"), check("typecheck")], false, [{ context: "ci/legacy", state: "success" }]), ["1 other check on the head not green (ci/legacy failure)"], "a status does not hide a failed check run of the same name")
})

test("waitingOnChecks judges the newest attempt of a check, and a plain list with no attempt times takes its later entry", () => {
  assert.deepEqual(waitingOnChecks(["x"], [check("x", "failure"), check("x")]), [])
  assert.deepEqual(waitingOnChecks(["x"], [check("x"), check("x", "failure")]), ["x: x failure"])
})

test("waitingOnChecks with skippedPasses: skipped and neutral pass, while every other conclusion, a pending check and a missing one still hold", () => {
  const verdict = (runs) => waitingOnChecks(["typecheck", "shard-*"], runs, true)
  assert.deepEqual(verdict([check("typecheck", "skipped"), check("shard-1", "neutral"), check("shard-2")]), [])
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"]) {
    assert.deepEqual(verdict([check("typecheck", conclusion), check("shard-1")]), [`typecheck: typecheck ${conclusion}`])
  }
  assert.deepEqual(verdict([check("typecheck", null, "in_progress"), check("shard-1")]), ["typecheck: typecheck in_progress"])
  assert.deepEqual(verdict([check("shard-1")]), ["typecheck: not started"])
  assert.deepEqual(verdict([check("typecheck", "skipped"), check("shard-1", "skipped"), check("shard-2", "failure")]), ["shard-*: 1 of 2 not green (shard-2 failure)"])
})

test("waitingOnChecks: a matrix job skipped under its unexpanded template name satisfies the pattern that starts like it, as a skipped check", () => {
  const TEMPLATE = "npm test (${{ matrix.os }}, ${{ matrix.shard }}/${{ strategy.job-total }})"
  const required = ["npm test (ubuntu-latest, *)"]
  assert.deepEqual(waitingOnChecks(required, [check(TEMPLATE, "skipped")], true), [])
  assert.deepEqual(waitingOnChecks(required, [check(TEMPLATE, "skipped")]), [`npm test (ubuntu-latest, *): ${TEMPLATE} skipped`], "without skippedPasses a skipped check still holds")
  assert.deepEqual(waitingOnChecks(required, [check(TEMPLATE, "failure")], true), ["npm test (ubuntu-latest, *): not started", `1 other check on the head not green (${TEMPLATE} failure)`], "only a skipped template matches, so a failed one still holds")
  assert.deepEqual(waitingOnChecks(required, [check(TEMPLATE, "success")], true), ["npm test (ubuntu-latest, *): not started"], "only a skipped template matches")
  assert.deepEqual(waitingOnChecks(["lint (*)"], [check(TEMPLATE, "skipped")], true), ["lint (*): not started"], "a different prefix does not match")
})

test("waitingOnChecks: a skipped template next to the expanded matrix jobs is ignored, whatever skippedPasses says", () => {
  const TEMPLATE = "npm test (${{ matrix.os }}, ${{ matrix.shard }}/${{ strategy.job-total }})"
  const required = ["npm test (ubuntu-latest, *)"]
  const ran = [check(TEMPLATE, "skipped"), check("npm test (ubuntu-latest, 1/2)"), check("npm test (ubuntu-latest, 2/2)")]
  assert.deepEqual(waitingOnChecks(required, ran), [])
  assert.deepEqual(waitingOnChecks(required, ran, true), [])
  assert.deepEqual(waitingOnChecks(required, [check(TEMPLATE, "skipped"), check("npm test (ubuntu-latest, 1/2)", "failure"), check("npm test (ubuntu-latest, 2/2)")]), ["npm test (ubuntu-latest, *): 1 of 2 not green (npm test (ubuntu-latest, 1/2) failure)"])
})

test("waitingOnChecks: a matrix job cancelled before it expanded is ignored when its shards ran, and a real failure or a lone cancelled template still holds", () => {
  const TEMPLATE = "site (${{ matrix.shard }})"
  const shards = [check("site (1/2)"), check("site (2/2)")]
  assert.deepEqual(waitingOnChecks([], [check(TEMPLATE, "cancelled"), ...shards]), [])
  assert.deepEqual(waitingOnChecks(["site (*"], [check(TEMPLATE, "cancelled"), ...shards]), [])
  assert.deepEqual(waitingOnChecks([], [check(TEMPLATE, "cancelled"), check("site (1/2)", "failure"), check("site (2/2)")]), ["1 other check on the head not green (site (1/2) failure)"])
  assert.deepEqual(waitingOnChecks([], [check(TEMPLATE, "cancelled")]), [])
  assert.deepEqual(waitingOnChecks([], [check(TEMPLATE, "failure"), ...shards]), [`1 other check on the head not green (${TEMPLATE} failure)`])
  assert.deepEqual(waitingOnChecks([], [check("lint (${{ matrix.x }})", "cancelled"), ...shards]), [], "a cancelled check that is not required does not hold")
})

test("merge-when-green: main's cancelled runs are skipped and the latest completed run that was not cancelled is judged", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world, { main: [{ id: 11, conclusion: "cancelled" }, { id: 10, conclusion: "cancelled" }, { id: 9, conclusion: "success" }] })
  assert.deepEqual((await w.poll()).errors, [])
  assert.deepEqual(prWrites(w.world).map((write) => write.method), ["PUT"])
  const red = await setup([MERGE])
  mergeWorld(red.world, { main: [{ id: 11, conclusion: "cancelled" }, { id: 9, conclusion: "failure" }] })
  await red.poll()
  assert.deepEqual(prWrites(red.world), [])
  assert.deepEqual(red.state("pages merge").prs["7"].waitingOn, ["main's latest completed ci.yml run 9 (https://github.test/runs/9) is failure"])
})

test("skippedPasses is true or false on a merge relay, and anything else is named", () => {
  const merge = (extra) => parseRelayConfig(JSON.stringify({ relays: [{ ...MERGE, ...extra }] }), "relays.json")[0]
  assert.equal(merge({ skippedPasses: true }).skippedPasses, true)
  assert.throws(() => merge({ skippedPasses: "yes" }), /relays\[0\]\.skippedPasses is not true or false/u)
  assert.throws(() => merge({ updateBehind: "yes" }), /relays\[0\]\.updateBehind is not true or false/u)
})

test("merge-when-green: with skippedPasses a skipped or neutral check merges, and a cancelled one still holds the pull request", async () => {
  const passing = await setup([{ ...MERGE, skippedPasses: true }])
  mergeWorld(passing.world, { checks: [check("typecheck", "skipped"), check("npm test (ubuntu-latest, 1/2)", "neutral"), check("npm test (ubuntu-latest, 2/2)")] })
  assert.deepEqual((await passing.poll()).errors, [])
  assert.deepEqual(prWrites(passing.world).map((write) => write.method), ["PUT"])

  const held = await setup([{ ...MERGE, skippedPasses: true }])
  mergeWorld(held.world, { checks: [check("typecheck", "skipped"), check("npm test (ubuntu-latest, 1/2)", "cancelled"), check("npm test (ubuntu-latest, 2/2)")] })
  await held.poll()
  assert.deepEqual(prWrites(held.world), [])
  assert.match(comments(held.world)[0].body.body, /npm test \(ubuntu-latest, \*\): 1 of 2 not green \(npm test \(ubuntu-latest, 1\/2\) cancelled\)/u)
})

test("merge-when-green: with every check green and main green it squash-merges at the checked head, deletes the branch and comments once", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world)
  const polled = await w.poll()
  assert.deepEqual(polled.errors, [])
  assert.deepEqual(prWrites(w.world), [{ method: "PUT", route: "/repos/o/pages/pulls/7/merge", body: { merge_method: "squash", sha: SHA, commit_title: "Fix pages (#7)", commit_message: "Why.\n\nCo-authored-by: Ana <ana@example.com>" } }])
  assert.deepEqual(w.world.writes.filter((write) => write.method === "DELETE").map((write) => write.route), ["/repos/o/pages/git/refs/heads/feature/x"])
  assert.equal(comments(w.world).length, 1)
  assert.equal(comments(w.world)[0].method, "POST")
  assert.match(comments(w.world)[0].body.body, /^<!-- desk-relay-status:pages merge -->\n\*\*merge-when-green\*\* merged this \(squash, head `aaaaaaa`, now `bbbbbbb`\)\. Every check and status on the head was green and main's latest completed ci\.yml run 9 \(https:\/\/github\.test\/runs\/9\) was green; the branch is deleted\./u)
  assert.equal(w.state("pages merge").lastMerge.number, 7)
  assert.match(relayStatusLines([MERGE], { "pages merge": w.state("pages merge") }, NOW)[0], /last merged #7/u)
  assert.equal(JSON.stringify(w.world.writes).match(/admin|bypass|auto_merge/iu), null, "no bypass of any kind is ever sent")
})

test("merge-when-green: a merge commit gets a title and the body without AI trailers, and a rebase sends no message", async () => {
  const merged = await setup([{ ...MERGE, method: "merge" }])
  mergeWorld(merged.world)
  await merged.poll()
  assert.deepEqual(prWrites(merged.world)[0].body, { merge_method: "merge", sha: SHA, commit_title: "Merge pull request #7 from feature/x", commit_message: "Why.\n\nCo-authored-by: Ana <ana@example.com>" })
  const rebased = await setup([{ ...MERGE, method: "rebase" }])
  mergeWorld(rebased.world)
  await rebased.poll()
  assert.deepEqual(prWrites(rebased.world)[0].body, { merge_method: "rebase", sha: SHA })
})

test("merge-when-green: a matrix job skipped under its template name lets skippedPasses merge, and holds the merge without it", async () => {
  const TEMPLATE = "npm test (${{ matrix.os }}, ${{ matrix.shard }}/${{ strategy.job-total }})"
  const passing = await setup([{ ...MERGE, skippedPasses: true }])
  mergeWorld(passing.world, { checks: [check("typecheck"), check(TEMPLATE, "skipped")] })
  assert.deepEqual((await passing.poll()).errors, [])
  assert.deepEqual(prWrites(passing.world).map((write) => write.method), ["PUT"])

  const held = await setup([MERGE])
  mergeWorld(held.world, { checks: [check("typecheck"), check(TEMPLATE, "skipped")] })
  await held.poll()
  assert.deepEqual(prWrites(held.world), [])
})

test("merge-when-green: it never merges while a required check is missing, pending or failed, and keeps one status comment it edits", async () => {
  const w = await setup([MERGE])
  let checks = [check("typecheck", null, "in_progress"), check("npm test (ubuntu-latest, 1/2)")]
  mergeWorld(w.world)
  w.world.on("GET", /\/commits\/a+\/check-runs/u, () => ({ total_count: checks.length, check_runs: checks }))
  await w.poll(NOW)
  assert.deepEqual(prWrites(w.world), [])
  assert.deepEqual(comments(w.world).map((write) => write.method), ["POST"])
  assert.match(comments(w.world)[0].body.body, /Waiting on:\n- typecheck: typecheck in_progress\n\nThis comment is edited as that changes\.$/u)
  assert.match(relayStatusLines([MERGE], { "pages merge": w.state("pages merge") }, NOW)[0], /#7 waiting on typecheck: typecheck in_progress/u)

  checks = [check("typecheck", "failure"), check("npm test (ubuntu-latest, 1/2)")]
  await w.poll(NOW + 3 * MIN)
  assert.equal(comments(w.world).length, 1, "a progress edit waits ten minutes")
  checks = [check("typecheck"), check("npm test (ubuntu-latest, 1/2)"), check("npm test (ubuntu-latest, 2/2)", null, "queued")]
  await w.poll(NOW + 11 * MIN)
  assert.deepEqual(comments(w.world).map((write) => write.method), ["POST", "PATCH"], "it edits the same comment")
  assert.equal(comments(w.world)[1].route, "/repos/o/pages/issues/comments/55")
  assert.deepEqual(prWrites(w.world), [])

  checks = []
  await w.poll(NOW + 14 * MIN)
  assert.deepEqual(prWrites(w.world), [], "checks that have not started are missing, not green")
  checks = GREEN
  await w.poll(NOW + 17 * MIN)
  assert.equal(prWrites(w.world).length, 1)
  assert.equal(comments(w.world).at(-1).method, "PATCH", "the merge result replaces the waiting text")
  assert.equal(w.world.writes.filter((write) => write.method === "POST").length, 1)
})

test("merge-when-green: a red or missing main run, a draft, a conflict and branch rules each hold the merge back and say why", async () => {
  const why = async (at, setupWorld) => {
    const fresh = await setup([MERGE])
    mergeWorld(fresh.world, setupWorld)
    await fresh.poll(at)
    assert.deepEqual(prWrites(fresh.world), [])
    return fresh.state("pages merge").prs["7"].waitingOn.join("; ")
  }
  assert.equal(await why(NOW, { main: [{ id: 9, conclusion: "failure" }] }), "main's latest completed ci.yml run 9 (https://github.test/runs/9) is failure")
  assert.equal(await why(NOW, { main: [{ id: 9, conclusion: "cancelled" }] }), "main has no completed ci.yml run that was not cancelled yet")
  assert.equal(await why(NOW, { main: [{ id: 9, conclusion: "failure" }], pr: { base: { ref: "stack", repo: { full_name: "o/pages" } } } }), "main's latest completed ci.yml run 9 (https://github.test/runs/9) is failure", "a pull request into another branch still waits on the default branch")
  assert.equal(await why(NOW, { main: [] }), "main has no completed ci.yml run that was not cancelled yet")
  assert.equal(await why(NOW, { pr: { draft: true } }), "it is a draft")
  assert.equal(await why(NOW, { pr: { mergeable: false, mergeable_state: "dirty" } }), "it has merge conflicts")
  assert.equal(await why(NOW, { pr: { mergeable_state: "behind" } }), "it is behind main")
  assert.equal(await why(NOW, { pr: { mergeable_state: "blocked" } }), "GitHub reports it as blocked, so the branch rules do not let it merge")
  assert.equal(await why(NOW, { pr: { labels: [] } }), "the merge-when-green label is gone")
})

const STRICT = { requiredWorkflows: ["ci"], advisoryJobs: ["budget"], advisoryWorkflows: ["resource"], requireCurrentBase: true }
const STRICT_RELAY = { ...MERGE, strict: STRICT }
const job = (name, conclusion = "success", status = "completed") => ({ name, status, conclusion: status === "completed" ? conclusion : null })

/** A strict world: the ci workflow's jobs, a resource workflow, and where the head stands against main. */
function strictWorld(world, { jobs = [job("typecheck"), job("npm test (ubuntu-latest, 1/2)"), job("budget")], resourceJobs = [job("resource-macos")], compare = "ahead", ciStatus = "completed", checks = GREEN, runs = null, jobsTotal = null } = {}) {
  mergeWorld(world, { checks })
  world.on("GET", /\/actions\/runs\?head_sha=a+/u, () => ({ total_count: 2, workflow_runs: runs ?? [{ id: 100, workflow_id: 1, name: "ci", path: ".github/workflows/ci.yml", status: "completed", conclusion: "failure", run_number: 3 }, { id: 101, workflow_id: 1, name: "ci", path: ".github/workflows/ci.yml", status: ciStatus, conclusion: ciStatus === "completed" ? "failure" : null, run_number: 5 }, { id: 99, workflow_id: 1, name: "ci", path: ".github/workflows/ci.yml", status: "completed", conclusion: "failure", run_number: 4 }, { id: 102, workflow_id: 2, name: "resource", path: ".github/workflows/resource.yml", status: "completed", conclusion: "failure", run_number: 2 }] }))
  world.on("GET", /\/actions\/runs\/101\/jobs/u, () => ({ total_count: jobsTotal ?? jobs.length, jobs }))
  world.on("GET", /\/actions\/runs\/102\/jobs/u, () => ({ total_count: resourceJobs.length, jobs: resourceJobs }))
  world.on("GET", /\/compare\/main\.\.\.a+/u, () => ({ status: compare }))
  world.on("PUT", /\/pulls\/7\/update-branch$/u, () => ({ ok: true, status: 202, body: { message: "Updating pull request branch." } }))
}

test("strict: a green current head merges, naming advisory jobs that are red as warnings it does not judge", async () => {
  const w = await setup([STRICT_RELAY])
  strictWorld(w.world, { jobs: [job("typecheck"), job("npm test (ubuntu-latest, 1/2)"), job("budget", "failure")], checks: [...GREEN, check("budget", "failure"), check("resource-macos", "failure")] })
  const polled = await w.poll()
  assert.deepEqual(polled.errors, [])
  assert.equal(prWrites(w.world).length, 1)
  assert.equal(w.world.writes.some((write) => write.route.endsWith("/update-branch")), false)
  assert.match(comments(w.world)[0].body.body, /Every job of ci on the head finished green and the head contained main.*Advisory, not judged: ci job budget failure \(advisory\); budget failure \(advisory\); resource-macos failure \(advisory\)\./su)
})

test("strict: requireCurrentBase false merges a green head that is behind, in parallel, with no update and no queue", async () => {
  const w = await setup([{ ...STRICT_RELAY, strict: { ...STRICT, requireCurrentBase: false, serial: false } }])
  strictWorld(w.world, { compare: "behind" })
  w.world.pull(7, { mergeable_state: "behind" })
  const polled = await w.poll()
  assert.deepEqual(polled.errors, [])
  assert.equal(prWrites(w.world).length, 1)
  assert.equal(w.world.writes.some((write) => write.route.endsWith("/update-branch")), false)
})

test("strict: a job an advisory workflow shares a name with a required job of ci stays judged", async () => {
  const w = await setup([STRICT_RELAY])
  strictWorld(w.world, { jobs: [job("typecheck", "failure"), job("budget")], resourceJobs: [job("typecheck", "failure")], checks: [check("typecheck", "failure"), check("npm test (ubuntu-latest, 1/2)")] })
  await w.poll()
  assert.deepEqual(prWrites(w.world), [])
  assert.deepEqual(w.state("pages merge").prs["7"].waitingOn.slice(0, 1), ["ci job typecheck finished failure"])
})

test("strict: a red or pending job of the required workflow holds the merge and the status names it", async () => {
  const red = await setup([STRICT_RELAY])
  strictWorld(red.world, { jobs: [job("typecheck", "failure"), job("budget")] })
  await red.poll()
  assert.deepEqual(prWrites(red.world), [])
  assert.deepEqual(red.state("pages merge").prs["7"].waitingOn, ["ci job typecheck finished failure"])

  const pending = await setup([STRICT_RELAY])
  strictWorld(pending.world, { jobs: [job("typecheck"), job("npm test (ubuntu-latest, 1/2)", null, "in_progress")], ciStatus: "in_progress" })
  await pending.poll()
  assert.deepEqual(prWrites(pending.world), [])
  assert.deepEqual(pending.state("pages merge").prs["7"].waitingOn, ["ci job npm test (ubuntu-latest, 1/2) to finish (in_progress)"])
  assert.match(relayStatusLines([STRICT_RELAY], { "pages merge": pending.state("pages merge") }, NOW)[0], /#7 waiting on ci job npm test/u)

  const unstarted = await setup([STRICT_RELAY])
  strictWorld(unstarted.world, { jobs: [job("typecheck")], ciStatus: "in_progress" })
  await unstarted.poll()
  assert.deepEqual(unstarted.state("pages merge").prs["7"].waitingOn, ["ci to finish (more of its jobs have not started)"])
})

test("strict: a head behind main is updated once with its expected head, never merged, and then waits for ci on the new head", async () => {
  const w = await setup([STRICT_RELAY])
  strictWorld(w.world, { compare: "behind" })
  await w.poll(NOW)
  assert.deepEqual(prWrites(w.world), [{ method: "PUT", route: "/repos/o/pages/pulls/7/update-branch", body: { expected_head_sha: SHA } }])
  assert.match(w.state("pages merge").prs["7"].waitingOn[0], /^updated branch to main; waiting for GitHub to publish the new head/u)
  await w.poll(NOW + 5 * MIN)
  assert.equal(prWrites(w.world).length, 1, "the same head is not updated twice")

  const NEW = "c".repeat(40)
  w.world.pull(7, { head: { sha: NEW, ref: "feature/x", repo: { full_name: "o/pages" } } })
  w.world.on("GET", /\/compare\/main\.\.\.c+/u, () => ({ status: "ahead" }))
  w.world.on("GET", /\/actions\/runs\?head_sha=c+/u, () => ({ total_count: 1, workflow_runs: [{ id: 103, workflow_id: 1, name: "ci", path: ".github/workflows/ci.yml", status: "in_progress", conclusion: null, run_number: 6 }] }))
  w.world.on("GET", /\/commits\/c+\/check-runs/u, () => ({ total_count: 0, check_runs: [] }))
  w.world.on("GET", /\/commits\/c+\/status/u, () => ({ state: "pending", total_count: 0, statuses: [] }))
  w.world.on("GET", /\/actions\/runs\/103\/jobs/u, () => ({ total_count: 1, jobs: [job("typecheck", null, "in_progress")] }))
  assert.deepEqual((await w.poll(NOW + 10 * MIN)).errors, [])
  assert.equal(prWrites(w.world).length, 1)
  assert.deepEqual(w.state("pages merge").prs["7"].waitingOn.slice(0, 2), [`updated branch to main (the head was ${SHA.slice(0, 7)}); waiting for ci on the new head`, "ci job typecheck to finish (in_progress)"])
})

test("strict: pull requests are served in arrival order, and only the oldest behind head is updated while the others queue", async () => {
  const w = await setup([STRICT_RELAY])
  strictWorld(w.world, { compare: "behind" })
  w.world.on("GET", /\/issues\?state=open&labels=merge-when-green/u, () => [{ number: 9, pull_request: {} }, { number: 7, pull_request: {} }])
  w.world.pull(9)
  w.world.on("PUT", /\/pulls\/9\/update-branch$/u, () => ({ ok: true, status: 202, body: { message: "Updating pull request branch." } }))
  await w.poll(NOW)
  assert.deepEqual(prWrites(w.world).map((write) => write.route), ["/repos/o/pages/pulls/7/update-branch"])
  assert.match(w.state("pages merge").prs["9"].waitingOn[0], /^queued behind #7: /u)
  assert.match(w.state("pages merge").prs["7"].waitingOn[0], /^updated branch to main/u)
})

test("strict: a conflict from update-branch is reported once and not retried for that head", async () => {
  const w = await setup([STRICT_RELAY])
  strictWorld(w.world, { compare: "diverged" })
  w.world.on("PUT", /\/pulls\/7\/update-branch$/u, () => ({ ok: false, status: 422, body: { message: "merge conflict between base and head" } }))
  await w.poll(NOW)
  await w.poll(NOW + 5 * MIN)
  assert.equal(prWrites(w.world).length, 1)
  assert.match(w.state("pages merge").prs["7"].waitingOn[0], /could not update the branch to main \(merge conflict between base and head\)/u)
})

test("strict: a pull request GitHub's branch rules call behind is updated too, and a head already current is not", async () => {
  const behind = await setup([STRICT_RELAY])
  strictWorld(behind.world, { compare: "behind" })
  behind.world.pull(7, { mergeable_state: "behind" })
  await behind.poll()
  assert.equal(prWrites(behind.world).length, 1)
  const current = await setup([STRICT_RELAY])
  strictWorld(current.world, { compare: "identical" })
  await current.poll()
  assert.equal(current.world.writes.some((write) => write.route.endsWith("/update-branch")), false)
})

test("strict: edge cases: no ci run yet, no jobs, a long job list, advisory jobs still running or skipped, and no currency check", async () => {
  const none = await setup([STRICT_RELAY])
  strictWorld(none.world, { runs: [] })
  await none.poll()
  assert.deepEqual(none.state("pages merge").prs["7"].waitingOn, ["ci has not started on this head"])

  const empty = await setup([STRICT_RELAY])
  strictWorld(empty.world, { jobs: [] })
  await empty.poll()
  assert.deepEqual(empty.state("pages merge").prs["7"].waitingOn, ["ci finished failure with no job to judge"])

  const long = await setup([STRICT_RELAY])
  strictWorld(long.world, { jobsTotal: 150 })
  await long.poll()
  assert.equal(long.world.reads.some((read) => read.route.includes("/runs/101/jobs") && read.route.endsWith("&page=2")), true)

  const lenient = await setup([{ ...STRICT_RELAY, skippedPasses: true, strict: { ...STRICT, requireCurrentBase: false } }])
  strictWorld(lenient.world, { compare: "behind", jobs: [job("typecheck"), job("e2e", "skipped"), job("budget", null, "in_progress")], checks: [...GREEN, check("budget", null, "in_progress")] })
  await lenient.poll()
  assert.equal(lenient.world.writes.some((write) => write.route.endsWith("/update-branch")), false, "without requireCurrentBase the head is not compared or updated")
  assert.equal(prWrites(lenient.world).length, 1)
  assert.match(comments(lenient.world)[0].body.body, /finished green, and every other check/u)
  assert.match(comments(lenient.world)[0].body.body, /ci job budget in_progress \(advisory\)/u)

  const refused = await setup([STRICT_RELAY])
  strictWorld(refused.world, { compare: "behind" })
  refused.world.on("PUT", /\/pulls\/7\/update-branch$/u, () => ({ ok: false, status: 500, body: {} }))
  await refused.poll()
  assert.match(refused.state("pages merge").prs["7"].waitingOn[0], /could not update the branch to main \(HTTP 500\)/u)
})

test("a strict block is validated: bad or unknown fields fail loudly", () => {
  const bad = (strict, message) => assert.throws(() => parseRelayConfig(JSON.stringify({ relays: [{ ...MERGE, strict }] }), "relays.json"), message)
  bad("ci", /strict is not an object/u)
  bad({}, /strict\.requiredWorkflows is not a non-empty list/u)
  bad({ requiredWorkflows: ["ci"], advisoryJob: ["x"] }, /strict\.advisoryJob is not a strict field/u)
  bad({ requiredWorkflows: ["ci"], serial: "no" }, /strict\.serial is not true or false/u)
  bad({ requiredWorkflows: ["ci"], advisoryJobs: "x" }, /advisoryJobs is not a list of names/u)
  bad({ requiredWorkflows: ["ci"], advisoryWorkflows: [5] }, /advisoryWorkflows is not a list of names/u)
  bad({ requiredWorkflows: ["ci"], requireCurrentBase: "yes" }, /requireCurrentBase is not true or false/u)
  const [parsed] = parseRelayConfig(JSON.stringify({ relays: [{ ...MERGE, strict: { requiredWorkflows: [" ci "] } }] }), "relays.json")
  assert.deepEqual(parsed.strict, { requiredWorkflows: ["ci"], advisoryJobs: [], advisoryWorkflows: [], requireCurrentBase: true, serial: true })
})

test("merge-when-green: a queued or in-progress main run is not judged, so the latest completed green one counts and is named", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world, { main: [{ id: 11, status: "queued", conclusion: null }, { id: 10, status: "in_progress", conclusion: null }, { id: 9, conclusion: "success" }] })
  assert.deepEqual((await w.poll()).errors, [])
  assert.deepEqual(prWrites(w.world).map((write) => write.method), ["PUT"])
  assert.match(comments(w.world)[0].body.body, /main's latest completed ci\.yml run 9 \(https:\/\/github\.test\/runs\/9\) was green/u)
})

test("merge-when-green: a red latest completed main run holds the merge back and names that run, even with a queued run newer than it", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world, { main: [{ id: 11, status: "queued", conclusion: null }, { id: 9, conclusion: "failure" }] })
  await w.poll()
  assert.deepEqual(prWrites(w.world), [])
  assert.deepEqual(w.state("pages merge").prs["7"].waitingOn, ["main's latest completed ci.yml run 9 (https://github.test/runs/9) is failure"])
})

test("merge-when-green: a red main does not hold a head that holds main and is green on every job that failed there; anything else still waits", async () => {
  const mainJobs = [{ name: "typecheck", status: "completed", conclusion: "failure" }, { name: "lint", status: "completed", conclusion: "success" }]
  const run = async ({ compare = "ahead", jobs = mainJobs, checks = GREEN, pr = {} } = {}) => {
    const w = await setup([MERGE])
    mergeWorld(w.world, { checks, pr, main: [{ id: 9, conclusion: "failure" }] })
    w.world.on("GET", /\/compare\/[^/]+\.\.\.a+/u, () => ({ status: compare }))
    w.world.on("GET", /\/actions\/runs\/9\/jobs/u, () => ({ total_count: jobs.length, jobs }))
    await w.poll()
    return w
  }
  const healed = await run()
  assert.deepEqual(prWrites(healed.world).map((write) => write.method), ["PUT"])
  assert.match(comments(healed.world)[0].body.body, /was red, the head held main and was green on every job that failed there \(typecheck\)/u)
  const rerun = await run({ checks: [...GREEN.slice(1), { ...check("typecheck", "failure"), id: 1 }, { ...check("typecheck"), id: 3 }, { ...check("typecheck", "failure"), id: 2 }] })
  assert.deepEqual(prWrites(rerun.world).map((write) => write.method), ["PUT"], "the newest check run of a name decides")
  assert.deepEqual(prWrites((await run({ checks: [...GREEN.slice(1), { ...check("typecheck"), id: 1 }, { ...check("typecheck", "failure"), id: 2 }] })).world), [], "a newer failing run of the job holds it")
  for (const held of [
    await run({ compare: "behind" }),
    await run({ compare: "diverged" }),
    await run({ pr: { base: { ref: "release" } } }),
    await run({ jobs: [] }),
    await run({ jobs: [{ name: "e2e", status: "completed", conclusion: "failure" }] }),
  ]) {
    assert.deepEqual(prWrites(held.world), [])
    assert.match(held.state("pages merge").prs["7"].waitingOn[0], /^main's latest completed ci\.yml run 9 .* is failure$/u)
  }
})

test("merge-when-green: a job that failed on main and never ran on the head is dispatched once; it merges when the dispatched run is green, and holds with a reason when it cannot run or is red", async () => {
  const mainJobs = [{ name: "smoke", status: "completed", conclusion: "failure" }]
  const dispatches = (w) => w.world.writes.filter((write) => /\/workflows\/ci\.yml\/dispatches$/u.test(write.route))
  const run = async ({ checks = GREEN, dispatch = () => ({ ok: true, status: 204, body: {} }) } = {}) => {
    const w = await setup([MERGE])
    mergeWorld(w.world, { checks, main: [{ id: 9, conclusion: "failure" }] })
    w.world.on("GET", /\/compare\/[^/]+\.\.\.a+/u, () => ({ status: "ahead" }))
    w.world.on("GET", /\/actions\/runs\/9\/jobs/u, () => ({ total_count: 1, jobs: mainJobs }))
    w.world.on("POST", /\/workflows\/ci\.yml\/dispatches$/u, dispatch)
    await w.poll()
    return w
  }
  const dispatched = await run()
  assert.equal(dispatches(dispatched).length, 1)
  assert.equal(dispatches(dispatched)[0].body.ref, "feature/x")
  assert.deepEqual(prWrites(dispatched.world), [])
  assert.match(dispatched.state("pages merge").prs["7"].waitingOn[1], /smoke failed on main but have not run on this head; dispatched ci\.yml on `feature\/x` and waiting for it/u)
  dispatched.world.writes.length = 0
  await dispatched.poll(NOW + 1800_000)
  assert.equal(dispatches(dispatched).length, 0, "once per head, even while the run has not appeared yet")
  dispatched.world.on("GET", /\/commits\/a+\/check-runs/u, () => ({ total_count: 2, check_runs: [...GREEN, { ...check("smoke"), id: 50 }] }))
  await dispatched.poll(NOW + 3600_000)
  assert.equal(dispatches(dispatched).length, 0, "once per head")
  assert.deepEqual(prWrites(dispatched.world).map((write) => write.method), ["PUT"], "the dispatched run's green job heals main's red")
  assert.match(comments(dispatched.world)[0].body.body, /green on every job that failed there \(smoke\)/u)

  const noTrigger = await run({ dispatch: () => ({ ok: false, status: 422, body: { message: "Workflow does not have 'workflow_dispatch' trigger" } }) })
  assert.deepEqual(prWrites(noTrigger.world), [])
  assert.match(noTrigger.state("pages merge").prs["7"].waitingOn[1], /smoke failed on main but never ran on this head, and ci\.yml has no `workflow_dispatch` trigger.*Add `workflow_dispatch:` under `on:`/u)

  const refused = await run({ dispatch: () => ({ ok: false, status: 403, body: { message: "Resource not accessible" } }) })
  assert.match(refused.state("pages merge").prs["7"].waitingOn[1], /dispatching ci\.yml answered HTTP 403 \(Resource not accessible\)/u)
  const other422 = await run({ dispatch: () => ({ ok: false, status: 422, body: { message: "No ref found" } }) })
  assert.match(other422.state("pages merge").prs["7"].waitingOn[1], /answered HTTP 422 \(No ref found\)/u)

  const fork = await setup([MERGE])
  mergeWorld(fork.world, { main: [{ id: 9, conclusion: "failure" }], pr: { head: { sha: SHA, ref: "x", repo: { full_name: "someone/pages" } } } })
  fork.world.on("GET", /\/compare\/[^/]+\.\.\.a+/u, () => ({ status: "ahead" }))
  fork.world.on("GET", /\/actions\/runs\/9\/jobs/u, () => ({ total_count: 1, jobs: mainJobs }))
  await fork.poll()
  assert.equal(dispatches(fork).length, 0)
  assert.match(fork.state("pages merge").prs["7"].waitingOn[1], /its branch is in a fork/u)

  const pending = await run({ checks: [...GREEN, check("smoke", null, "in_progress")] })
  assert.equal(dispatches(pending).length, 0, "a job already running on the head is waited for, not dispatched")

  const red = await run({ checks: [...GREEN, check("smoke", "failure")] })
  assert.equal(dispatches(red).length, 0)
  assert.deepEqual(prWrites(red.world), [])
  assert.equal(red.state("pages merge").prs["7"].waitingOn.length, 2)
})

test("merge-when-green: Tandem's red main (push-only jobs failed, none on the PR head) is dispatched, waited for, and the fix merges once the dispatched run is green", async () => {
  const pushOnly = ["smoke, compose, new chat, setup (macos-latest)", "smoke, compose (windows-latest)", "npm test (macos-latest, 1/1)", "test (windows-latest)", "test (macos-latest)"]
  const w = await setup([MERGE])
  mergeWorld(w.world, { main: [{ id: 44509870089, conclusion: "failure" }] })
  w.world.on("GET", /\/compare\/[^/]+\.\.\.a+/u, () => ({ status: "ahead" }))
  w.world.on("GET", /\/actions\/runs\/44509870089\/jobs/u, () => ({ total_count: 6, jobs: [{ name: "engine", status: "completed", conclusion: "success" }, ...pushOnly.map((name) => ({ name, status: "completed", conclusion: "failure" }))] }))
  w.world.on("POST", /\/workflows\/ci\.yml\/dispatches$/u, () => ({ ok: true, status: 204, body: {} }))
  await w.poll()
  const dispatches = () => w.world.writes.filter((write) => /\/workflows\/ci\.yml\/dispatches$/u.test(write.route))
  assert.deepEqual(dispatches().map((write) => write.body), [{ ref: "feature/x" }])
  assert.deepEqual(prWrites(w.world), [], "held while the dispatched run has not finished")
  assert.match(w.state("pages merge").prs["7"].waitingOn[1], /^smoke, compose, new chat, setup \(macos-latest\), smoke, compose \(windows-latest\), npm test \(macos-latest, 1\/1\), test \(windows-latest\), test \(macos-latest\) failed on main but have not run on this head; dispatched ci\.yml on `feature\/x`/u)

  w.world.on("GET", /\/commits\/a+\/check-runs/u, () => ({ total_count: 6, check_runs: [...GREEN, ...pushOnly.map((name, index) => ({ ...check(name), id: 100 + index }))] }))
  await w.poll(NOW + 3600_000)
  assert.equal(dispatches().length, 1, "dispatched once for the head")
  assert.deepEqual(prWrites(w.world).map((write) => write.method), ["PUT"])
  assert.match(comments(w.world).at(-1).body.body, /green on every job that failed there \(smoke, compose, new chat, setup \(macos-latest\), smoke, compose \(windows-latest\), npm test \(macos-latest, 1\/1\), test \(windows-latest\), test \(macos-latest\)\)/u)
})

test("merge-when-green: a failed or unfinished check that is not required, or a failed commit status, holds the merge", async () => {
  const cases = [
    { checks: [...GREEN, check("weekly-page", "failure")], waiting: "weekly-page failure" },
    { checks: [...GREEN, check("weekly-page", null, "in_progress")], waiting: "weekly-page in_progress" },
    { checks: [...GREEN, check("weekly-page", null, "queued")], waiting: "weekly-page queued" },
    { checks: GREEN, statuses: [{ context: "ci/legacy", state: "failure" }], waiting: "ci/legacy failure" },
    { checks: GREEN, statuses: [{ context: "ci/legacy", state: "pending" }], waiting: "ci/legacy in_progress" },
  ]
  for (const { checks, statuses, waiting } of cases) {
    const w = await setup([MERGE])
    mergeWorld(w.world, { checks, statuses })
    await w.poll()
    assert.deepEqual(prWrites(w.world), [], waiting)
    assert.match(w.state("pages merge").prs["7"].waitingOn.join(" "), new RegExp(`other check on the head not green \\(${waiting}\\)`, "u"))
  }
  const green = await setup([MERGE])
  mergeWorld(green.world, { checks: [...GREEN, check("weekly-page", "skipped")], statuses: [{ context: "ci/legacy", state: "success" }] })
  await green.poll()
  assert.deepEqual(prWrites(green.world).map((write) => write.method), ["PUT"])
})

test("merge-when-green: more than one page of commit statuses is read in full, so a failed one on a later page holds the merge", async () => {
  const w = await setup([{ ...MERGE, requireMainWorkflowGreen: undefined }])
  const many = Array.from({ length: 120 }, (_, index) => ({ context: `ci/${index}`, state: index === 110 ? "failure" : "success" }))
  mergeWorld(w.world)
  w.world.on("GET", /\/commits\/a+\/status\?per_page=100$/u, () => ({ state: "failure", total_count: 120, statuses: many.slice(0, 100) }))
  w.world.on("GET", /\/commits\/a+\/status\?per_page=100&page=2$/u, () => ({ state: "failure", total_count: 120, statuses: many.slice(100) }))
  await w.poll()
  assert.deepEqual(prWrites(w.world), [])
  assert.match(w.state("pages merge").prs["7"].waitingOn.join(" "), /ci\/110 failure/u)
  assert.equal(Object.keys(w.state("pages merge").cache).some((route) => route.includes("/status")), false)
})

test("merge-when-green: a check rerun green counts by its newest attempt, and a newer failed attempt still holds the merge", async () => {
  const attempt = (id, conclusion, startedAt) => ({ id, name: "visual proof", status: "completed", conclusion, started_at: startedAt })
  const VISUAL = { ...MERGE, requiredChecks: ["visual proof"] }
  const rerun = await setup([VISUAL])
  mergeWorld(rerun.world, { checks: [attempt(3, "success", "2026-11-14T20:48:24Z"), attempt(1, "failure", "2026-11-14T20:42:38Z"), attempt(2, "failure", "2026-11-14T20:47:21Z")] })
  assert.deepEqual((await rerun.poll()).errors, [])
  assert.deepEqual(prWrites(rerun.world).map((write) => write.method), ["PUT"])

  const newer = await setup([VISUAL])
  mergeWorld(newer.world, { checks: [attempt(3, "success", "2026-11-14T20:48:24Z"), attempt(4, "failure", "2026-11-14T20:50:00Z")] })
  await newer.poll()
  assert.deepEqual(prWrites(newer.world), [])
  assert.deepEqual(newer.state("pages merge").prs["7"].waitingOn, ["visual proof: visual proof failure"])
})

test("merge-when-green: a check read cached before attempts carried ids is read again, not judged from its superseded failure", async () => {
  const w = await setup([{ ...MERGE, requiredChecks: ["visual proof"], requireMainWorkflowGreen: undefined }])
  const checks = [{ id: 2, name: "visual proof", status: "completed", conclusion: "success", started_at: "2026-11-14T20:48:24Z" }, { id: 1, name: "visual proof", status: "completed", conclusion: "failure", started_at: "2026-11-14T20:42:38Z" }]
  mergeWorld(w.world, { checks })
  const route = `/repos/o/pages/commits/${SHA}/check-runs?per_page=100`
  const etag = `"${createHash("sha1").update(JSON.stringify({ total_count: checks.length, check_runs: checks })).digest("hex").slice(0, 12)}"`
  const legacy = { runs: [{ name: "visual proof", status: "completed", conclusion: "failure" }], volatile: false }
  writeFileSync(w.paths.state, JSON.stringify({ "pages merge": { type: "merge-when-green", cache: { [route]: { etag, value: legacy } }, history: [], prs: {} } }))
  assert.deepEqual((await w.poll()).errors, [])
  assert.deepEqual(prWrites(w.world).map((write) => write.method), ["PUT"])
})

test("merge-when-green: an unknown mergeability does not hold a green head; the merge is attempted, and a 405 retries on the next poll", async () => {
  const unknown = { mergeable: null, mergeable_state: "unknown" }
  const ok = await setup([MERGE])
  mergeWorld(ok.world, { pr: unknown })
  await ok.poll(NOW)
  assert.equal(ok.state("pages merge").prs["7"].status, "merged")

  const w = await setup([MERGE])
  mergeWorld(w.world, { pr: unknown })
  let answers = 0
  w.world.on("PUT", /\/pulls\/7\/merge$/u, () => (++answers === 1 ? { ok: false, status: 405, body: { message: "Pull Request is not mergeable" } } : { ok: true, status: 200, body: { sha: "m1", merged: true } }))
  assert.deepEqual((await w.poll(NOW)).errors, [])
  assert.match(w.state("pages merge").prs["7"].waitingOn[0], /still working out whether it merges cleanly/u)
  await w.poll(NOW + 30_000)
  assert.equal(w.state("pages merge").prs["7"].status, "merged")
  assert.equal(answers, 2)

  const conflict = await setup([MERGE])
  mergeWorld(conflict.world, { pr: unknown })
  conflict.world.on("PUT", /\/pulls\/7\/merge$/u, () => ({ ok: false, status: 405, body: { message: "Pull Request is not mergeable" } }))
  await conflict.poll(NOW)
  mergeWorld(conflict.world, { pr: { mergeable: false, mergeable_state: "dirty" } })
  await conflict.poll(NOW + 30_000)
  assert.equal(conflict.state("pages merge").prs["7"].waitingOn[0], "it has merge conflicts")
})

test("merge-when-green: .github/merge-checks.json on the base replaces the configured checks, and a required check that has not reported is missing", async () => {
  const file = (required) => ({ content: Buffer.from(JSON.stringify({ required })).toString("base64"), encoding: "base64" })
  const withFile = async (required, checks) => {
    const w = await setup([MERGE])
    mergeWorld(w.world, { checks })
    w.world.on("GET", /\/contents\/\.github\/merge-checks\.json\?ref=main$/u, () => file(required))
    await w.poll(NOW)
    return w
  }
  // Only the file's list counts: the configured typecheck is absent and a red check the file does not name is ignored.
  const merged = await withFile(["ci checks"], [check("ci checks"), check("attribution", "cancelled")])
  assert.equal(merged.state("pages merge").prs["7"].status, "merged")
  for (const conclusion of ["failure", "timed_out"]) {
    const red = await withFile(["ci checks"], [check("ci checks"), check("test (3)", conclusion)])
    assert.deepEqual(prWrites(red.world), [], "a red check the list does not name still holds the head")
    assert.match(red.state("pages merge").prs["7"].waitingOn[0], /1 other check on the head not green \(test \(3\)/u)
  }
  const two = await withFile(["ci checks"], [check("ci checks"), check("test (1)", "failure"), check("test (2)", "failure")])
  assert.match(two.state("pages merge").prs["7"].waitingOn[0], /2 other checks on the head not green/u)
  const running = await withFile(["ci checks"], [check("ci checks"), check("shard-1", null, "in_progress"), check("shard-2", null, "queued")])
  assert.deepEqual(prWrites(running.world), [], "required is green but other checks are still running")
  assert.match(running.state("pages merge").prs["7"].waitingOn[0], /2 other checks on the head not green/u)
  const finished = await withFile(["ci checks"], [check("ci checks"), check("shard-1"), check("shard-2", "skipped"), check("shard-3", "cancelled")])
  assert.equal(finished.state("pages merge").prs["7"].status, "merged", "finished, skipped and cancelled checks do not hold")
  const missing = await withFile(["ci checks"], [check("typecheck")])
  assert.deepEqual(prWrites(missing.world), [])
  assert.equal(missing.state("pages merge").prs["7"].waitingOn[0], "ci checks: not started")
  const broken = await setup([MERGE])
  mergeWorld(broken.world, { checks: [check("ci checks")] })
  broken.world.on("GET", /\/contents\/\.github\/merge-checks\.json/u, () => ({ content: Buffer.from("{not json").toString("base64") }))
  await broken.poll(NOW)
  assert.match(broken.state("pages merge").prs["7"].waitingOn[0], /^typecheck: not started/u, "an unreadable file is as good as none")
  const notAList = await setup([MERGE])
  mergeWorld(notAList.world, { checks: [check("ci checks")] })
  notAList.world.on("GET", /\/contents\/\.github\/merge-checks\.json/u, () => file("ci checks"))
  await notAList.poll(NOW)
  assert.match(notAList.state("pages merge").prs["7"].waitingOn[0], /^typecheck: not started/u, "a required that is not a list is no list")
  const down = await setup([MERGE])
  mergeWorld(down.world, { checks: [check("ci checks")] })
  down.world.on("GET", /\/contents\/\.github\/merge-checks\.json/u, () => { throw Object.assign(new Error("boom"), { status: 500 }) })
  await down.poll(NOW)
  assert.deepEqual(prWrites(down.world), [], "a failed read of the file never falls back to a looser list")
  const absent = await setup([MERGE])
  mergeWorld(absent.world, { checks: [check("ci checks")] })
  await absent.poll(NOW)
  assert.match(absent.state("pages merge").prs["7"].waitingOn[0], /^typecheck: not started/u, "without the file the configured checks apply")
})

test("merge-when-green: a refused merge is reported, not repeated for five minutes, and tried again at once for a new head", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world)
  w.world.on("PUT", /\/pulls\/7\/merge$/u, () => ({ ok: false, status: 405, body: { message: "Base branch was modified" } }))
  const first = await w.poll(NOW)
  assert.match(first.errors[0].error, /#7: .*HTTP 405 \(Base branch was modified\)/u)
  await w.poll(NOW + MIN)
  assert.equal(prWrites(w.world).length, 1)
  assert.match(w.state("pages merge").prs["7"].waitingOn[0], /^GitHub refused the merge \(Base branch was modified\); trying again after /u)
  await w.poll(NOW + 6 * MIN)
  assert.equal(prWrites(w.world).length, 2)
})

test("merge-when-green: after a restart nothing merges twice, and a status comment is found again by its marker", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world, { checks: [check("typecheck", null, "queued")] })
  await w.poll(NOW)
  assert.equal(comments(w.world).length, 1)
  writeFileSync(w.paths.state, "{}")
  w.world.on("GET", /\/issues\/7\/comments/u, () => [{ id: 55, body: `<!-- desk-relay-status:pages merge -->\nold`, user: { login: "Relay-Bot" } }, { id: 56, body: "<!-- desk-relay-status:other -->", user: { login: "relay-bot" } }])
  await w.poll(NOW + 10 * MIN)
  assert.deepEqual(comments(w.world).map((write) => `${write.method} ${write.route.split("/").at(-1)}`), ["POST comments", "PATCH 55"], "the marked comment is edited, not duplicated")

  mergeWorld(w.world)
  await w.poll(NOW + 20 * MIN)
  assert.equal(prWrites(w.world).length, 1)
  w.world.on("GET", /\/issues\?state=open&labels=merge-when-green/u, () => [])
  await w.poll(NOW + 30 * MIN)
  await w.poll(NOW + 40 * MIN)
  assert.equal(prWrites(w.world).length, 1, "the merged pull request is closed and never merged again")
  assert.equal(w.state("pages merge").prs["7"].status, "merged")
})

test("merge-when-green: a pull request from a fork keeps its branch, and one that is not labelled is left alone", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world, { pr: { head: { sha: SHA, ref: "x", repo: { full_name: "someone/pages" } } } })
  await w.poll()
  assert.equal(prWrites(w.world).length, 1)
  assert.deepEqual(w.world.writes.filter((write) => write.method === "DELETE"), [])
  const idle = await setup([MERGE])
  idle.world.on("GET", /\/issues\?state=open&labels=/u, () => [{ number: 3 }])
  await idle.poll()
  assert.deepEqual(idle.world.writes, [])
  assert.equal(idle.world.reads.length, 1)
})

test("merge-when-green: more than one page of check runs is read in full every poll", async () => {
  const w = await setup([{ ...MERGE, requiredChecks: ["shard-*"], requireMainWorkflowGreen: undefined }])
  const many = Array.from({ length: 120 }, (_, index) => check(`shard-${index}`))
  mergeWorld(w.world)
  w.world.on("GET", /\/commits\/a+\/check-runs\?per_page=100$/u, () => ({ total_count: 120, check_runs: many.slice(0, 100) }))
  w.world.on("GET", /\/commits\/a+\/check-runs\?per_page=100&page=2$/u, () => ({ total_count: 120, check_runs: many.slice(100) }))
  await w.poll()
  assert.equal(prWrites(w.world).length, 1)
  assert.equal(Object.keys(w.state("pages merge").cache).some((route) => route.includes("check-runs")), false)
})

test("merge-checks.json: a check running on a later page of more than 100 check runs holds the head, and a commit status still pending holds it", async () => {
  const file = { content: Buffer.from(JSON.stringify({ required: ["ci checks"] })).toString("base64"), encoding: "base64" }
  for (const [late, merges] of [[check("shard-109", null, "in_progress"), false], [check("shard-109"), true]]) {
    const w = await setup([MERGE])
    const many = [check("ci checks"), ...Array.from({ length: 118 }, (_, index) => check(`shard-${index}`)), late]
    mergeWorld(w.world)
    w.world.on("GET", /\/contents\/\.github\/merge-checks\.json\?ref=main$/u, () => file)
    w.world.on("GET", /\/commits\/a+\/check-runs\?per_page=100$/u, () => ({ total_count: 120, check_runs: many.slice(0, 100) }))
    w.world.on("GET", /\/commits\/a+\/check-runs\?per_page=100&page=2$/u, () => ({ total_count: 120, check_runs: many.slice(100) }))
    await w.poll(NOW)
    assert.equal(prWrites(w.world).length > 0, merges)
  }
  const pending = await setup([MERGE])
  mergeWorld(pending.world, { checks: [check("ci checks")] })
  pending.world.on("GET", /\/contents\/\.github\/merge-checks\.json\?ref=main$/u, () => file)
  pending.world.on("GET", /\/commits\/a+\/status/u, () => ({ state: "pending", total_count: 1, statuses: [{ context: "legacy/ci", state: "pending" }] }))
  await pending.poll(NOW)
  assert.deepEqual(prWrites(pending.world), [])
})

test("drains status shows each relay, and why answers for a relay name and for a pull request", async () => {
  const dir = await mkTempRoot("desk-relays-cli-")
  const env = { XDG_STATE_HOME: dir }
  const files = relayPaths({ env })
  const { mkdirSync } = await import("node:fs")
  mkdirSync(path.dirname(files.config), { recursive: true })
  writeFileSync(files.config, JSON.stringify({ relays: [DISPATCH, MERGE] }))
  const w = github()
  mergeWorld(w, { checks: [check("typecheck", null, "queued")] })
  w.on("GET", runsRoute, () => ({ workflow_runs: [run(1)] }))
  const cli = async (argv) => {
    const out = []
    const err = []
    const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } }
    const code = await runDrainsCli({ argv, script: SCRIPT, io, env, now: () => NOW, connect: w.connect })
    return { code, out: out.join(""), err: err.join("") }
  }
  const polled = await cli(["relays", "poll"])
  assert.equal(polled.code, 0, polled.err)
  assert.deepEqual(JSON.parse(polled.out).wakes, [])
  const status = JSON.parse((await cli(["status"])).out).status.join("\n")
  assert.match(status, /relay data to pages \(dispatch\) o\/data data\.yml -> o\/pages: polled 0s ago, never fired, settle 60s, waiting on the next successful data\.yml run on main/u)
  assert.match(status, /relay pages merge \(merge-when-green\) o\/pages: polled 0s ago, never merged, #7 waiting on typecheck: typecheck queued/u)
  const byName = JSON.parse((await cli(["why", "--relay", "pages merge"])).out)
  assert.equal(byName.type, "merge-when-green")
  assert.equal(byName.history[0].event, "waiting")
  assert.equal(JSON.parse((await cli(["why", "--relay", "nothing"])).out).note.includes("no relay"), true)
  const byPull = JSON.parse((await cli(["why", "o/pages#7"])).out)
  assert.equal(byPull.relays[0].relay, "pages merge")
  assert.equal(byPull.relays[0].pull.status, "waiting")
  assert.equal((await cli(["relays"])).code, 2)
})

test("send answers a refused write instead of throwing, and counts it", async () => {
  const sent = []
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method, body: init.body })
    return { ok: false, status: 405, headers: new Headers(), json: async () => (init.method === "PUT" ? { message: "no" } : Promise.reject(new Error("no body"))) }
  }
  const api = await connectGithub("work", { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl, login: "work" })
  assert.deepEqual(await api.send("PUT", "/repos/o/r/pulls/1/merge", { merge_method: "squash", sha: SHA }), { ok: false, status: 405, body: { message: "no" } })
  assert.deepEqual(sent, [{ url: "https://api.github.com/repos/o/r/pulls/1/merge", method: "PUT", body: JSON.stringify({ merge_method: "squash", sha: SHA }) }])
  assert.equal(api.calls().total, 1)
  sent.length = 0
  await api.send("DELETE", "/repos/o/r/git/refs/heads/x")
  assert.deepEqual(sent, [{ url: "https://api.github.com/repos/o/r/git/refs/heads/x", method: "DELETE", body: undefined }])
})

test("a relay that cannot reach GitHub records why, still prints its status, and a broken drains config does not stop it", async () => {
  const w = await setup([DISPATCH, MERGE])
  writeFileSync(w.drainFiles.config, "{")
  writeFileSync(w.drainFiles.state, "{")
  const polled = await pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect: async () => { throw new Error("Sign in the GitHub CLI: no token") }, now: NOW })
  assert.deepEqual(polled.errors.map((entry) => entry.relay), ["data to pages", "pages merge"])
  assert.equal(polled.calls, 0)
  assert.match(polled.status[1], /pages merge .*: polled 0s ago, never merged, no labelled pull request, last error: Sign in the GitHub CLI/u)
  assert.equal(w.state("data to pages").lastOkAt, undefined)
})

test("relay status lines: never polled, hours since the last poll, and a relay whose state is gone", () => {
  assert.deepEqual(relayStatusLines([DISPATCH], {}, NOW), ["relay data to pages (dispatch): not polled yet"])
  const states = { "data to pages": { lastPollAt: new Date(NOW - 3 * 3_600_000).toISOString(), waitingOn: "the next one", lastFire: { at: new Date(NOW - 2 * MIN).toISOString(), runId: 4, target: "o/pages pages.yml" } } }
  const [relay] = parseRelayConfig(JSON.stringify({ relays: [DISPATCH] }), "relays.json")
  assert.match(relayStatusLines([relay], states, NOW)[0], /polled 3h ago, last fired 2m ago for run 4 -> o\/pages pages\.yml, settle 60s, waiting on the next one$/u)
  assert.equal(whyRelay([MERGE], {}, "pages merge").waiting, null)
  assert.match(whyRelay([MERGE], {}, "other").note, /no relay is configured as other/u)
  assert.deepEqual(relaysOfPull([MERGE], {}, "o/pages", 7), [])
  assert.deepEqual(relaysOfPull([MERGE, DISPATCH], { "pages merge": { prs: {}, history: [{ number: 7, event: "refused" }, { number: 8, event: "merged" }] } }, "o/pages", 7), [{ relay: "pages merge", pull: undefined, history: [{ number: 7, event: "refused" }] }])
})

test("dispatch: a fire with a ref and no inputs, and an event GitHub refuses, are both reported exactly", async () => {
  const bare = { name: "bare", type: "dispatch", watch: { repo: "o/data", workflow: "data.yml" }, fire: { repo: "o/pages", workflow: "pages.yml", ref: "dev" }, settleSeconds: 0 }
  const event = { ...IMMEDIATE, name: "event", fire: { repo: "o/pages", event: "data-ready" } }
  const w = await setup([bare, event])
  let runs = [run(1)]
  w.world.on("GET", /data\.yml\/runs\?status=success&per_page=30&exclude_pull_requests=true$/u, () => ({ workflow_runs: runs }))
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  w.world.on("POST", /\/dispatches$/u, (route) => (route.includes("/workflows/") ? { ok: true, status: 204, body: {} } : { ok: false, status: 404, body: {} }))
  await w.poll(NOW)
  runs = [run(2), ...runs]
  const polled = await w.poll(NOW + MIN)
  assert.deepEqual(w.world.writes[0].body, { ref: "dev" })
  assert.match(polled.errors[0].error, /^Check that the relay's account can send the data-ready event in o\/pages, then try again: GitHub answered HTTP 404$/u)
  assert.equal(polled.errors.length, 1)
})

test("merge-when-green: the status comment recovers when its comment is gone and reports when it cannot be written", async () => {
  const w = await setup([MERGE])
  let checks = [check("typecheck", null, "queued")]
  mergeWorld(w.world)
  w.world.on("GET", /\/commits\/a+\/check-runs/u, () => ({ total_count: checks.length, check_runs: checks }))
  await w.poll(NOW)
  checks = [check("typecheck", null, "in_progress")]
  w.world.on("PATCH", /comments\/55$/u, () => ({ ok: false, status: 404, body: {} }))
  await w.poll(NOW + 11 * MIN)
  assert.deepEqual(comments(w.world).map((write) => write.method), ["POST", "PATCH", "POST"], "a deleted comment is written again")
  checks = [check("typecheck", null, "pending")]
  w.world.on("PATCH", /comments\/55$/u, () => ({ ok: false, status: 500, body: { message: "boom" } }))
  assert.match((await w.poll(NOW + 22 * MIN)).errors[0].error, /#7: Check that the relay's account can edit its status comment in o\/pages, then try again: GitHub answered HTTP 500 \(boom\)/u)
  const fresh = await setup([MERGE])
  mergeWorld(fresh.world, { checks: [] })
  fresh.world.on("POST", /\/comments$/u, () => ({ ok: false, status: 403, body: {} }))
  assert.match((await fresh.poll(NOW)).errors[0].error, /can comment on the pull request in o\/pages, then try again: GitHub answered HTTP 403$/u)
  assert.deepEqual(prWrites(fresh.world), [])
})

test("merge-when-green: the branch is deleted only for a same-repository branch, and a failed delete never undoes the merge", async () => {
  const outcome = async (pr, deleteResult, relay = MERGE) => {
    const w = await setup([relay])
    mergeWorld(w.world, { pr })
    w.world.on("DELETE", /refs/u, () => deleteResult)
    const polled = await w.poll()
    assert.deepEqual(polled.errors, [])
    assert.equal(w.state(relay.name).prs["7"].status, "merged")
    return { deletes: w.world.writes.filter((write) => write.method === "DELETE").length, text: comments(w.world).at(-1).body.body }
  }
  assert.match((await outcome({}, { ok: false, status: 422, body: {} })).text, /the branch is deleted\.$/u, "already gone counts as deleted")
  assert.doesNotMatch((await outcome({}, { ok: false, status: 500, body: {} })).text, /deleted/u)
  assert.deepEqual(await outcome({ head: { sha: SHA, ref: "x", repo: null } }, { ok: true }).then(({ deletes }) => deletes), 0)
  assert.equal((await outcome({ head: { sha: SHA, ref: "main", repo: { full_name: "O/Pages" } } }, { ok: true })).deletes, 0, "never the base branch, and repository names compare without case")
  assert.equal((await outcome({}, { ok: true }, { ...MERGE, deleteBranch: false })).deletes, 0)
  const w = await setup([MERGE])
  mergeWorld(w.world)
  w.world.send = undefined
  const connect = w.world.connect
  const throwing = async () => ({ ...(await connect()), send: async (method, route, body) => { if (method === "DELETE") throw new Error("network"); return { ok: true, status: method === "PUT" ? 200 : 201, body: method === "PUT" ? { merged: true, sha: MERGED_SHA } : { id: 5 } } } })
  assert.deepEqual((await pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect: throwing, now: NOW })).errors, [])
  assert.equal(w.state("pages merge").prs["7"].status, "merged")
})

test("merge-when-green: a closed or unlabelled pull request is dropped, merged records are kept to twenty, and an unchanged poll is free", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world, { pr: { state: "closed" } })
  await w.poll(NOW)
  assert.deepEqual(w.world.writes, [])
  assert.deepEqual(w.state("pages merge").prs, {})
  mergeWorld(w.world, { checks: [check("typecheck", null, "queued")] })
  await w.poll(NOW + MIN)
  const before = w.world.writes.length
  await w.poll(NOW + 2 * MIN)
  assert.equal(w.world.writes.length, before, "nothing changed, so nothing is written")
  assert.ok(w.world.notModified >= 3, "the list, the pull request and the checks answer 304")
  const saved = readRelayStates(w.paths.state)
  for (let number = 100; number < 122; number++) saved["pages merge"].prs[number] = { status: "merged", at: new Date(NOW + number * SECOND).toISOString() }
  writeFileSync(w.paths.state, JSON.stringify(saved))
  w.world.on("GET", /\/issues\?state=open&labels=merge-when-green/u, () => [])
  await w.poll(NOW + 3 * MIN)
  assert.deepEqual(Object.keys(w.state("pages merge").prs).sort(), Array.from({ length: 20 }, (_, index) => String(102 + index)))
})

test("merge-when-green: a refusal with no message is reported by its status, and a long wait names the first three checks and counts the rest", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world)
  w.world.on("PUT", /\/merge$/u, () => ({ ok: false, status: 409, body: {} }))
  await w.poll(NOW)
  assert.equal(w.state("pages merge").history.at(-1).reason, "HTTP 409")
  assert.match(waitingOnChecks(["t*"], ["t1", "t2", "t3", "t4", "t5"].map((name) => check(name, null, "queued")))[0], /t\*: 5 of 5 not green \(t1 queued, t2 queued, t3 queued, and 2 more\)$/u)
})

test("merge-when-green: a second poll with the same status leaves its comment alone", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world, { checks: [check("typecheck", null, "queued")] })
  await w.poll(NOW)
  await w.poll(NOW + 10 * MIN)
  assert.equal(comments(w.world).length, 1)
})

test("the command line runs relays with flags, prints their status, and fails with the reason when the config is wrong", async () => {
  const dir = await mkTempRoot("desk-relays-cli-")
  const config = path.join(dir, "mine.json")
  const state = path.join(dir, "mine-state.json")
  writeFileSync(config, JSON.stringify({ relays: [DISPATCH] }))
  const w = github()
  w.on("GET", runsRoute, () => ({ workflow_runs: [run(1)] }))
  const cli = async (argv) => {
    const out = []
    const err = []
    const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } }
    const code = await runDrainsCli({ argv, script: SCRIPT, io, env: { XDG_STATE_HOME: path.join(dir, "xdg") }, now: () => NOW, connect: w.connect })
    return { code, out: out.join(""), err: err.join("") }
  }
  assert.equal((await cli(["relays", "poll", "--config", config, "--state", state])).code, 0)
  const status = JSON.parse((await cli(["relays", "status", "--config", config, "--state", state])).out)
  assert.match(status.status[1], /^relay data to pages \(dispatch\) .*never fired/u)
  writeFileSync(path.join(dir, "xdg", "ouroboros-skills", "desk", "drains", "relays.json"), "{")
  assert.match(JSON.parse((await cli(["status"])).out).status.at(-1), /^relays: .*relays config: .* is not valid JSON/u, "a bad relays file shows on the drains' status instead of hiding it")
  writeFileSync(config, "{")
  const failed = await cli(["relays", "poll", "--config", config, "--state", state])
  assert.equal(failed.code, 1)
  assert.match(failed.err, /relays config: .* is not valid JSON/u)
})

test("merge-when-green: its status comment is found on a later page of comments, and a search that finds none stops after five pages", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world, { checks: [check("typecheck", null, "queued")] })
  w.world.more = (route) => !route.includes("page=3")
  w.world.on("GET", /\/issues\/7\/comments\?per_page=100&page=2$/u, () => [{ id: 77, body: "<!-- desk-relay-status:pages merge -->\nold", user: { login: "relay-bot" } }])
  w.world.on("GET", /\/issues\/7\/comments\?per_page=100&page=1$/u, () => [])
  await w.poll(NOW)
  assert.deepEqual(comments(w.world).map((write) => `${write.method} ${write.route.split("/").at(-1)}`), ["PATCH 77"])
  const none = await setup([MERGE])
  mergeWorld(none.world, { checks: [check("typecheck", null, "queued")] })
  none.world.more = () => true
  none.world.on("GET", /\/issues\/7\/comments\?/u, () => [])
  await none.poll(NOW)
  assert.equal(none.world.reads.filter((read) => read.route.includes("/comments")).length, 5)
  assert.deepEqual(comments(none.world).map((write) => write.method), ["POST"])
})

test("a relay with no account uses the signed-in account that can reach its repository, and remembers it", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world)
  const asked = []
  const connect = async (account) => {
    const api = await w.world.connect()
    return { ...api, get: async (route, options) => { asked.push([account, route]); if (account === "wrong" && /^\/repos\/o\/pages$/u.test(route)) throw Object.assign(new Error("403"), { status: 403 }); return api.get(route, options) } }
  }
  const poll = (at) => pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: at, signedIn: () => ["wrong", "right"] })
  const first = await poll(NOW)
  assert.deepEqual(first.errors, [])
  assert.equal(w.state("pages merge").resolvedAccount, "right")
  assert.deepEqual(asked.filter(([, route]) => route === "/repos/o/pages").map(([account]) => account), ["wrong", "right", "right"])
  asked.length = 0
  await poll(NOW + 10 * MIN)
  assert.ok(!asked.some(([account]) => account === "wrong"), "the remembered account is used without probing again")
})

test("a relay with no account that no signed-in account can reach reports a message naming it", async () => {
  const w = await setup([MERGE])
  const connect = async () => ({ ...(await w.world.connect()), get: async () => { throw Object.assign(new Error("403"), { status: 403 }) } })
  const polled = await pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: NOW, signedIn: () => ["a", "b"] })
  assert.match(polled.errors[0].error, /^Set "account" on relay pages merge in relays\.json: none of the signed-in GitHub accounts \(a, b\) can reach o\/pages$/u)
})

test("a remembered account that GitHub starts refusing is chosen again", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world)
  let refuse = false
  const connect = async (account) => {
    const api = await w.world.connect()
    return { ...api, get: async (route, options) => { if (refuse && account === "old") throw Object.assign(new Error("Check gh auth status: HTTP 403"), { status: 403 }); return api.get(route, options) } }
  }
  const poll = (at, list) => pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: at, signedIn: () => list })
  await poll(NOW, ["old", "new"])
  assert.equal(w.state("pages merge").resolvedAccount, "old")
  refuse = true
  await poll(NOW + 10 * MIN, ["old", "new"])
  assert.equal(w.state("pages merge").resolvedAccount, undefined)
  await poll(NOW + 20 * MIN, ["old", "new"])
  assert.equal(w.state("pages merge").resolvedAccount, "new")
})

test("a relay with no account uses the CLI's active account when the signed-in accounts cannot be read", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world)
  const polled = await pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect: w.world.connect, now: NOW, signedIn: () => { throw new Error("gh is not installed") } })
  assert.deepEqual(polled.errors, [])
  assert.equal(w.state("pages merge").resolvedAccount, undefined)
})

// ── What a poll costs: a 304 is free, so only a changed answer, a write or a first read counts against the account's quota ──

const reads = (w) => w.world.reads.length
const countedSince = async (w, at) => (await w.poll(at)).spent

test("cost: an idle merge relay and an idle dispatch relay read once per poll and spend nothing counted once their tags are held", async () => {
  const w = await setup([IMMEDIATE, MERGE])
  w.world.on("GET", runsRoute, () => ({ workflow_runs: [run(1)] }))
  w.world.on("GET", /\/issues\?state=open&labels=merge-when-green/u, () => [])
  const first = await w.poll(NOW)
  assert.equal(first.spent, 2, "the first poll reads each list in full")
  const before = reads(w)
  assert.equal(await countedSince(w, NOW + 30 * SECOND), 0)
  assert.equal(reads(w) - before, 2, "one conditional read per relay")
  assert.equal(w.state(MERGE.name).lastPoll.free, 1)
})

test("cost: an idle dispatch relay with a 15 s interval backs off to at least two minutes, and a new run brings it back", async () => {
  const w = await setup([{ ...IMMEDIATE, everySeconds: 15 }])
  let runs = [run(1)]
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  for (let n = 0; n < 21; n++) await w.poll(NOW + n * 15 * SECOND)
  const before = reads(w)
  await w.poll(NOW + 21 * 15 * SECOND)
  assert.equal(reads(w), before, "15 s after going quiet is too soon")
  await w.poll(NOW + 20 * 15 * SECOND + 2 * MIN)
  assert.equal(reads(w) - before, 1)
  runs = [run(2, { head_sha: HEAD_B }), run(1)]
  await w.poll(NOW + 20 * 15 * SECOND + 4 * MIN)
  assert.equal(w.state(IMMEDIATE.name).idlePolls, 0)
})

test("cost: a dispatch relay with backOffWhenIdle false keeps its 15 s interval however long it is idle, so a new run fires within one poll", async () => {
  const w = await setup([{ ...IMMEDIATE, everySeconds: 15, backOffWhenIdle: false }])
  let runs = [run(1)]
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  w.world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "main" }))
  w.world.on("POST", /\/dispatches$/u, () => ({ ok: true, status: 204, body: {} }))
  for (let n = 0; n < 60; n++) await w.poll(NOW + n * 15 * SECOND)
  assert.equal(reads(w), 60, "an idle relay that doesn't back off reads on every 15 s poll")
  runs = [run(2, { head_sha: HEAD_B }), run(1)]
  await w.poll(NOW + 60 * 15 * SECOND)
  assert.equal(w.state(IMMEDIATE.name).lastFire?.headSha, HEAD_B)
})

test("config: backOffWhenIdle is true or false", () => {
  assert.throws(() => parseRelayConfig(JSON.stringify({ relays: [{ ...IMMEDIATE, backOffWhenIdle: "no" }] }), "relays.json"), /backOffWhenIdle is not true or false/u)
})

test("a relay reads through its readAccount and writes through its account, and its status shows the last full hour's calls", async () => {
  const w = await setup([{ ...IMMEDIATE, account: "work", readAccount: "personal" }])
  let runs = [run(1)]
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  w.world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "main" }))
  w.world.on("POST", /\/dispatches$/u, () => ({ ok: true, status: 204, body: {} }))
  const used = []
  const connect = async (account, options) => {
    const api = await w.world.connect(account, options)
    return { ...api, get: (...args) => (used.push(["get", account]), api.get(...args)), send: (...args) => (used.push(["send", account]), api.send(...args)) }
  }
  const poll = (at) => pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: at })
  await poll(NOW)
  runs = [run(2, { head_sha: HEAD_B }), run(1)]
  await poll(NOW + 2 * MIN)
  assert.ok(used.some(([kind]) => kind === "send"), `the relay fired: ${w.state(IMMEDIATE.name).lastError}`)
  assert.deepEqual([...new Set(used.filter(([kind]) => kind === "get").map(([, account]) => account))], ["personal"])
  assert.deepEqual([...new Set(used.filter(([kind]) => kind === "send").map(([, account]) => account))], ["work"])
  await poll(NOW + 120 * MIN)
  await poll(NOW + 120 * MIN + 2 * MIN)
  const lines = relayStatusLines(readRelayConfig(w.paths.config), readRelayStates(w.paths.state), NOW + 120 * MIN + 2 * MIN)
  assert.match(lines[0], /last full hour \d+ counted calls \(\d+ free\)/u)
})

test("cost: a labelled pull request whose checks keep changing is read every 30 to 60 s, not on every poll", async () => {
  const w = await setup([MERGE])
  let queued = 1
  mergeWorld(w.world)
  w.world.on("GET", /\/commits\/a+\/check-runs/u, () => ({ total_count: 1, check_runs: [check("typecheck", null, "queued"), ...Array.from({ length: queued }, (_, n) => check(`other ${n}`, null, "in_progress"))] }))
  const spend = []
  for (let at = 0; at <= 10 * MIN; at += 30 * SECOND) {
    queued += 1
    spend.push((await w.poll(NOW + at)).spent)
  }
  const total = spend.reduce((sum, value) => sum + value, 0)
  assert.ok(total <= 55, `ten minutes of churning CI cost ${total} counted calls; reading every poll costs about 75`)
  assert.ok(spend.filter((value) => value === 0).length >= 6, "polls between reads cost nothing")
  assert.equal(w.world.writes.filter((write) => write.method === "PUT").length, 0)
})

test("cost: a skipped read keeps the tags, so the next read of an unchanged pull request is free, and a green head still merges on the read that sees it", async () => {
  const w = await setup([MERGE])
  mergeWorld(w.world, { checks: [{ ...check("typecheck", null, "queued"), id: 1, started_at: "2026-11-14T11:00:00Z" }] })
  await w.poll(NOW)
  await w.poll(NOW + 30 * SECOND)
  assert.equal(await countedSince(w, NOW + 5 * MIN), 1, "every answer is unchanged, so every read is a 304, except the 404 for a merge-checks.json the base does not have, asked again every five minutes")
  mergeWorld(w.world)
  await w.poll(NOW + 5 * MIN + 30 * SECOND)
  assert.equal(w.world.writes.filter((write) => write.method === "PUT").length, 0, "inside the interval it is not read yet")
  await w.poll(NOW + 12 * MIN)
  assert.equal(w.world.writes.filter((write) => write.method === "PUT").length, 1)
})

test("cost: a merge relay with nothing labelled stretches its interval, and goes back to it as soon as something is labelled", async () => {
  const w = await setup([{ ...MERGE, everySeconds: 30 }])
  let labelled = []
  mergeWorld(w.world)
  w.world.on("GET", /\/issues\?state=open&labels=merge-when-green/u, () => labelled)
  for (let n = 0; n < 20; n++) await w.poll(NOW + n * 30 * SECOND)
  const before = reads(w)
  await w.poll(NOW + 20 * 30 * SECOND)
  assert.equal(reads(w), before, "30 s after the last poll is too soon once the relay has gone quiet")
  await w.poll(NOW + 21 * 30 * SECOND)
  await w.poll(NOW + 22 * 30 * SECOND)
  assert.equal(reads(w), before, "a minute is too soon: an idle relay waits at least two minutes")
  await w.poll(NOW + 23 * 30 * SECOND)
  assert.equal(reads(w) - before, 1, "two minutes is not")
  labelled = [{ number: 7, pull_request: {} }]
  await w.poll(NOW + 28 * 30 * SECOND)
  await w.poll(NOW + 29 * 30 * SECOND)
  assert.equal(w.state(MERGE.name).idlePolls, 0)
})

test("updateBehind: a red head that is behind main is updated once; a pending, green or current head is left alone", async () => {
  const relay = { ...MERGE, updateBehind: true }
  const redChecks = [check("typecheck", "failure"), check("npm test (ubuntu-latest, 1/2)"), check("npm test (ubuntu-latest, 2/2)")]
  const red = await setup([relay])
  mergeWorld(red.world, { checks: redChecks })
  red.world.on("GET", /\/compare\/main\.\.\.a+/u, () => ({ status: "behind" }))
  red.world.on("PUT", /\/pulls\/7\/update-branch$/u, () => ({ ok: true, status: 202, body: { message: "Updating pull request branch." } }))
  await red.poll(NOW)
  assert.deepEqual(prWrites(red.world), [{ method: "PUT", route: "/repos/o/pages/pulls/7/update-branch", body: { expected_head_sha: SHA } }])
  await red.poll(NOW + 5 * MIN)
  assert.equal(prWrites(red.world).length, 1, "the same head is not updated twice")

  for (const [why, checks, compare] of [["pending", [check("typecheck", null, "in_progress")], "behind"], ["green", GREEN, "behind"], ["current", redChecks, "ahead"]]) {
    const w = await setup([relay])
    mergeWorld(w.world, { checks })
    w.world.on("GET", /\/compare\/main\.\.\.a+/u, () => ({ status: compare }))
    w.world.on("PUT", /\/pulls\/7\/update-branch$/u, () => ({ ok: true, status: 202, body: {} }))
    await w.poll(NOW)
    assert.ok(!prWrites(w.world).some((write) => write.route.endsWith("/update-branch")), `a ${why} head is not updated`)
  }
})

// ── Account probes: a relay with no account asks each signed-in account for its repository, and a refusal is not asked again at every poll ──

/** The real client over a fake `gh` token read and a fake GitHub, so the traffic counted is the HTTP the default client really sends. */
async function probeWorld(relays = [IMMEDIATE]) {
  const w = await setup(relays)
  const tokens = { a: "fake-token-a-1", b: "fake-token-b-1" }
  const answers = { a: { status: 403 }, b: { status: 403 } }
  const http = []
  const clock = { at: NOW }
  const keyringBusy = new Set()
  const spawn = (_command, args) => {
    const who = args[args.indexOf("--user") + 1]
    return keyringBusy.has(who) ? { status: 1, stdout: "", stderr: "keyring is busy" } : { status: 0, stdout: `${tokens[who]}\n` }
  }
  const fetchImpl = async (url, init) => {
    const who = Object.keys(tokens).find((name) => init.headers.Authorization === `Bearer ${tokens[name]}`)
    http.push({ who, url: new URL(url).pathname })
    const { status, headers = {}, takes = 0, body = "" } = answers[who]
    clock.at += takes
    return { status, ok: status < 400, headers: { get: (name) => headers[name.toLowerCase()] ?? null, has: (name) => name.toLowerCase() in headers }, json: async () => ({ workflow_runs: [] }), text: async () => body }
  }
  const connect = (account, options) => connectGithub(account, { ...options, spawn, fetchImpl, pauseMs: 0, clock: () => clock.at, env: { PATH: "/bin", MS_DESK_QUOTA: "off" } })
  const poll = (at) => pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: at, signedIn: () => ["a", "b"] })
  return { ...w, tokens, answers, http, clock, keyringBusy, poll, probes: () => http.filter((call) => call.url === "/repos/o/data").length }
}

test("probes: two refused accounts are asked once, then again only when the relay's idle pace has passed", async () => {
  const p = await probeWorld()
  const lastPolls = []
  for (const at of [0, 30, 60, 90]) {
    const polled = await p.poll(NOW + at * SECOND)
    lastPolls.push(p.state("data to pages").lastPollAt)
    assert.match(polled.errors[0].error, /none of the signed-in GitHub accounts \(a, b\) can reach o\/data and o\/pages/u)
    assert.equal(polled.errors[0].code, "relays_set_account_on_relay")
    assert.equal(p.probes(), 2, `after +${at}s`)
  }
  assert.deepEqual(lastPolls, Array(4).fill(new Date(NOW).toISOString()), "a skipped probe is not a poll")
  assert.match(relayStatusLines(readRelayConfig(p.paths.config), { "data to pages": p.state("data to pages") }, NOW + 90 * SECOND)[0], /next account check in 30s/u)
  await p.poll(NOW + 120 * SECOND)
  assert.equal(p.probes(), 4)
  assert.ok(!readFileSync(p.paths.state, "utf8").includes("fake-token"), "no token is kept in the state")
})

test("probes: a relay that opts out of backing off asks its refused accounts at its own interval", async () => {
  const p = await probeWorld([{ ...IMMEDIATE, backOffWhenIdle: false }])
  for (const at of [0, 30, 60, 90]) await p.poll(NOW + at * SECOND)
  assert.equal(p.probes(), 8)
})

test("probes: a refreshed token for one login, or a changed relay, is asked again at once, and an unchanged account is not", async () => {
  const p = await probeWorld()
  await p.poll(NOW)
  p.tokens.a = "fake-token-a-2"
  await p.poll(NOW + 30 * SECOND)
  assert.deepEqual(p.http.map((call) => call.who), ["a", "b", "a"])
  writeFileSync(p.paths.config, JSON.stringify({ relays: [{ ...IMMEDIATE, settleSeconds: 1 }] }))
  await p.poll(NOW + 60 * SECOND)
  assert.equal(p.probes(), 5)
})

test("probes: access granted remotely is found when the pace has passed, and the relay then polls normally", async () => {
  const p = await probeWorld()
  await p.poll(NOW)
  p.answers.b = { status: 200 }
  assert.equal((await p.poll(NOW + 60 * SECOND)).errors.length, 1)
  assert.equal(p.probes(), 2)
  const polled = await p.poll(NOW + 120 * SECOND)
  assert.deepEqual(polled.errors, [])
  assert.equal(p.state("data to pages").resolvedAccount, "b")
  assert.equal(p.state("data to pages").probes, undefined)
})

test("probes: a server error or a rate limit is never remembered as a refusal, and a reachable account after it is still chosen", async () => {
  const p = await probeWorld()
  p.answers.a = { status: 500 }
  p.answers.b = { status: 200 }
  assert.deepEqual((await p.poll(NOW)).errors, [])
  assert.equal(p.state("data to pages").resolvedAccount, "b")
  const q = await probeWorld()
  q.answers.a = { status: 500 }
  const first = await q.poll(NOW)
  assert.equal(first.errors[0].code, "drains_github_server_error")
  await q.poll(NOW + 30 * SECOND)
  assert.equal(q.http.filter((call) => call.who === "a").length, 4, "a server error is asked again at the configured interval")
})

test("probes: a provider's Retry-After holds only that account's probe", async () => {
  const p = await probeWorld()
  p.answers.a = { status: 429, headers: { "retry-after": "90" } }
  p.answers.b = { status: 404 }
  await p.poll(NOW)
  await p.poll(NOW + 30 * SECOND)
  await p.poll(NOW + 60 * SECOND)
  assert.equal(p.http.filter((call) => call.who === "a" && call.url === "/repos/o/data").length, 1)
  p.answers.a = { status: 200 }
  assert.deepEqual((await p.poll(NOW + 90 * SECOND)).errors, [])
  assert.equal(p.state("data to pages").resolvedAccount, "a")
})

test("probes: a Retry-After holds exactly that long, however long the rest of the pool's window is, and counts from the answer's arrival", async () => {
  const p = await probeWorld()
  p.answers.a = { status: 429, headers: { "retry-after": "90", "x-ratelimit-remaining": "4000", "x-ratelimit-reset": String((NOW + 3600 * SECOND) / 1000) } }
  p.answers.b = { status: 404 }
  const first = await p.poll(NOW)
  assert.ok(!/hourly API limit is used up/u.test(first.errors[0].error), "a healthy pool is not told its hourly limit is used up")
  assert.match(first.errors[0].error, /asked to wait 90s/u)
  const asked = () => p.http.filter((call) => call.who === "a" && call.url === "/repos/o/data").length
  await p.poll(NOW + 89_999)
  assert.equal(asked(), 1, "no send before GitHub's not-before time")
  p.answers.a = { status: 200 }
  await p.poll(NOW + 90 * SECOND)
  assert.equal(asked(), 2, "sent at the exact deadline, not an hour later")
})

test("probes: a slow answer counts its Retry-After from when it arrived, not from when the poll began", async () => {
  const p = await probeWorld()
  p.answers.a = { status: 429, headers: { "retry-after": "90" }, takes: 20 * SECOND }
  p.answers.b = { status: 404 }
  await p.poll(NOW)
  p.answers.a = { status: 200 }
  await p.poll(NOW + 109_999)
  assert.equal(p.http.filter((call) => call.who === "a" && call.url === "/repos/o/data").length, 1)
  await p.poll(NOW + 110 * SECOND)
  assert.equal(p.http.filter((call) => call.who === "a" && call.url === "/repos/o/data").length, 2)
})

test("probes: a primary quota reset with no Retry-After holds until the reset, without the cadence slack", async () => {
  const p = await probeWorld()
  p.answers.a = { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 600 * SECOND) / 1000) } }
  p.answers.b = { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 3600 * SECOND) / 1000) } }
  await p.poll(NOW)
  p.answers.a = { status: 200 }
  await p.poll(NOW + 599_999)
  assert.equal(p.http.filter((call) => call.who === "a" && call.url === "/repos/o/data").length, 1)
  await p.poll(NOW + 600 * SECOND)
  assert.equal(p.http.filter((call) => call.who === "a" && call.url === "/repos/o/data").length, 2)
})

test("probes: a timeout or another failure that is not a refusal of access is never remembered as 'set account', and keeps its own error", async () => {
  const p = await probeWorld()
  p.answers.a = { status: 408 }
  p.answers.b = { status: 422 }
  const first = await p.poll(NOW)
  assert.equal(first.errors[0].code, "drains_github_refused")
  assert.ok(!/Set "account"/u.test(first.errors[0].error))
  await p.poll(NOW + 30 * SECOND)
  assert.equal(p.probes(), 4, "asked again at the configured interval")
  p.answers.a = { status: 200 }
  assert.deepEqual((await p.poll(NOW + 60 * SECOND)).errors, [])
})

test("probes: a first account whose token read gave no answer does not hide a reachable second, and is read again next poll", async () => {
  const p = await probeWorld()
  p.keyringBusy.add("a")
  p.answers.b = { status: 200 }
  assert.deepEqual((await p.poll(NOW)).errors, [])
  assert.equal(p.state("data to pages").resolvedAccount, "b")
  assert.ok(!p.http.some((call) => call.who === "a"))
  const q = await probeWorld()
  q.keyringBusy.add("a")
  const polled = await q.poll(NOW)
  assert.equal(polled.errors[0].code, "drains_github_cli_token_unavailable")
  assert.equal(q.state("data to pages").probes?.["a o/data"], undefined)
})

test("probes: an exhausted primary quota with a Retry-After as well holds until its reset, not the shorter Retry-After", async () => {
  const p = await probeWorld()
  p.answers.a = { status: 429, headers: { "retry-after": "90", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 3600 * SECOND) / 1000) } }
  p.answers.b = { status: 404 }
  const first = await p.poll(NOW)
  assert.match(first.errors[0].error, /hourly API limit is used up/u)
  p.answers.a = { status: 200 }
  const asked = () => p.http.filter((call) => call.who === "a" && call.url === "/repos/o/data").length
  await p.poll(NOW + 90 * SECOND)
  assert.equal(asked(), 1)
  await p.poll(NOW + 3600 * SECOND)
  assert.equal(asked(), 2)
})

for (const [status, body] of [[429, ""], [403, "You have exceeded a secondary rate limit"]]) {
  test(`probes: a healthy-pool ${status} with no Retry-After is not a used-up hourly pool and is not held until the unrelated reset`, async () => {
    const p = await probeWorld()
    const healthy = { status, body, headers: { "x-ratelimit-remaining": "4000", "x-ratelimit-reset": String((NOW + 3600 * SECOND) / 1000) } }
    p.answers.a = healthy
    p.answers.b = healthy
    const first = await p.poll(NOW)
    assert.ok(!/hourly API limit is used up|13:00:00/u.test(first.errors[0].error), first.errors[0].error)
    assert.equal(p.state("data to pages").probes?.["a o/data"], undefined, "no memo-hold for an unknown deadline")
    await p.poll(NOW + 30 * SECOND)
    assert.equal(p.probes(), 4, "asked again at the configured interval")
  })
}

for (const [label, rejection] of [["nothing", undefined], ["null", null], ["an empty object", {}], ["an object with only a code", { code: "x" }]]) {
  test(`probes: a probe that rejects with ${label} is a visible failure, never an accessible account`, async () => {
    const w = await setup([IMMEDIATE])
    const connect = async () => ({ get: async () => Promise.reject(rejection), calls: () => ({ total: 0 }), credentialEpoch: "e" })
    const polled = await pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: NOW, signedIn: () => ["a", "b"] })
    assert.equal(polled.errors.length, 1)
    assert.ok(polled.errors[0].error.length > 0)
    assert.equal(w.state("data to pages").resolvedAccount, undefined)
    assert.ok(w.state("data to pages").lastError.length > 0)
    if (rejection?.code) assert.equal(polled.errors[0].code, "x", "a structured code is kept")
  })
}

test("probes: a structured 403 rate limit keeps its decision fields, so it is not cached as 'set account' and holds until its deadline", async () => {
  const w = await setup([IMMEDIATE])
  const calls = []
  const connect = async () => ({ get: async (url) => { calls.push(url); throw { status: 403, rateLimited: true, message: "slow down", retryAfterMs: 90_000, receivedAt: NOW } }, calls: () => ({ total: 0 }), credentialEpoch: "e" })
  const polled = await pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: NOW, signedIn: () => ["a"] })
  assert.notEqual(polled.errors[0].code, "relays_set_account_on_relay")
  const held = Object.values(w.state("data to pages").probes)[0]
  assert.equal(held.outcome, "transient")
  assert.equal(Date.parse(held.retryAt), NOW + 90_000)
})

for (const [label, rejection] of [["nothing", undefined], ["null", null], ["an empty object", {}]]) {
  test(`probes: a connection that rejects with ${label} is a visible failure, never an account selection`, async () => {
    const w = await setup([IMMEDIATE])
    const connect = async () => Promise.reject(rejection)
    const polled = await pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: NOW, signedIn: () => ["a"] })
    assert.equal(polled.errors.length, 1)
    assert.ok(polled.errors[0].error.length > 0)
    assert.equal(w.state("data to pages").resolvedAccount, undefined)
  })
}

for (const [label, rejection, expected] of [["a string", "plain failure", /plain failure/u], ["an object with a message", { message: "object failure" }, /object failure/u]]) {
  test(`probes: a probe that rejects with ${label} keeps that message as the visible failure`, async () => {
    const w = await setup([IMMEDIATE])
    const connect = async () => ({ get: async () => Promise.reject(rejection), calls: () => ({ total: 0 }), credentialEpoch: "e" })
    const polled = await pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: NOW, signedIn: () => ["a"] })
    assert.match(polled.errors[0].error, expected)
  })
}

test("probes: a structured rate limit without a receipt time counts its Retry-After from the poll", async () => {
  const w = await setup([IMMEDIATE])
  const connect = async () => ({ get: async () => { throw { status: 429, rateLimited: true, message: "slow", retryAfterMs: 60_000 } }, calls: () => ({ total: 0 }), credentialEpoch: "e" })
  await pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: NOW, signedIn: () => ["a"] })
  assert.equal(Date.parse(Object.values(w.state("data to pages").probes)[0].retryAt), NOW + 60_000)
})

test("probes: an account with no token, whether it fails at connection or at the probe, is a denial", async () => {
  const noToken = () => Object.assign(new Error("sign in"), { code: "drains_sign_in_the_github_cli" })
  for (const connect of [async () => { throw noToken() }, async () => ({ get: async () => { throw noToken() }, calls: () => ({ total: 0 }), credentialEpoch: "e" })]) {
    const w = await setup([IMMEDIATE])
    const polled = await pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: NOW, signedIn: () => ["a"] })
    assert.equal(polled.errors[0].code, "relays_set_account_on_relay")
  }
})

test("probes: two relays reading the same repository share one probe per account", async () => {
  const w = await setup([IMMEDIATE, { ...IMMEDIATE, name: "second" }])
  const asked = []
  const connect = async () => ({ get: async (url) => { asked.push(url); throw { status: 404, message: "gone" } }, calls: () => ({ total: 0 }), credentialEpoch: "e" })
  await pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: NOW, signedIn: () => ["a"] })
  assert.equal(asked.filter((url) => url === "/repos/o/data").length, 1)
})

// ── Conditional reads: a validator belongs to the reading credential, and a 304 with nothing stored is never an empty answer ──

const RUNS = /\/actions\/workflows\/data\.yml\/runs\?/u

/**
 * The real client over a fake `gh` token read and a fake GitHub that keeps If-None-Match semantics for the watched runs, so the
 * Authorization and If-None-Match headers asserted are the ones the default client really sends. The relay writes as `writer` and reads as `reader`.
 */
async function cacheWorld({ relay = { ...IMMEDIATE, account: "writer", readAccount: "reader" } } = {}) {
  const w = await setup([relay])
  const tokens = { writer: "fake-token-w-1", reader: "fake-token-r-1", other: "fake-token-o-1" }
  const http = []
  const server = { etag: '"v1"', runs: [run(1)], defaultBranch: "main", always304: 0 }
  const spawn = (_command, args) => ({ status: 0, stdout: `${tokens[args[args.indexOf("--user") + 1]]}\n` })
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search
    const who = Object.keys(tokens).find((name) => init.headers.Authorization === `Bearer ${tokens[name]}`)
    http.push({ who, method: init.method ?? "GET", path, ifNoneMatch: init.headers["If-None-Match"] })
    const common = { headers: { get: (name) => (name.toLowerCase() === "etag" ? server.etag : null), has: () => false }, text: async () => "" }
    if (init.method === "POST") return { ...common, status: 204, ok: true, json: async () => ({}) }
    if (server.always304 > 0 && (server.always304-- > 0)) return { ...common, status: 304, ok: false, json: async () => ({}) }
    if (path.startsWith("/repos/o/pages")) {
      const etag = `"b-${JSON.stringify(server.defaultBranch)}"`
      const headers = { get: (name) => (name.toLowerCase() === "etag" ? etag : null), has: () => false }
      return init.headers["If-None-Match"] === etag ? { ...common, headers, status: 304, ok: false, json: async () => ({}) } : { ...common, headers, status: 200, ok: true, json: async () => ({ default_branch: server.defaultBranch }) }
    }
    if (init.headers["If-None-Match"] === server.etag) return { ...common, status: 304, ok: false, json: async () => ({}) }
    return { ...common, status: 200, ok: true, json: async () => ({ workflow_runs: server.runs }) }
  }
  const connect = (account, options) => connectGithub(account, { ...options, spawn, fetchImpl, pauseMs: 0, env: { PATH: "/bin", MS_DESK_QUOTA: "off" } })
  const poll = (at) => pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: at })
  const runReads = () => http.filter((call) => RUNS.test(call.path))
  const edit = (change) => {
    const states = readRelayStates(w.paths.state)
    change(states[relay.name])
    writeFileSync(w.paths.state, JSON.stringify(states))
  }
  return { ...w, tokens, http, server, poll, runReads, edit, relay }
}

test("conditional cache: an unchanged answer is a free 304 read by the reader, a changed one is read and acted on by the writer", async () => {
  const c = await cacheWorld()
  await c.poll(NOW)
  await c.poll(NOW + MIN)
  assert.deepEqual(c.runReads().map((call) => [call.who, call.ifNoneMatch]), [["reader", undefined], ["reader", '"v1"']])
  assert.deepEqual(c.http.filter((call) => call.method === "POST"), [])
  c.server.etag = '"v2"'
  c.server.runs = [run(1), run(2)]
  await c.poll(NOW + 2 * MIN)
  assert.deepEqual(c.runReads().at(-1), { who: "reader", method: "GET", path: c.runReads().at(-1).path, ifNoneMatch: '"v1"' })
  assert.deepEqual(c.http.filter((call) => call.method === "POST").map((call) => call.who), ["writer"])
  assert.equal(c.state(c.relay.name).cache[c.runReads()[0].path.replace("https://api.github.com", "")].epoch.length, 64)
})

test("conditional cache: a changed read account, or a refreshed token of the same login, sends no validator and reuses no body", async () => {
  const c = await cacheWorld()
  await c.poll(NOW)
  writeFileSync(c.paths.config, JSON.stringify({ relays: [{ ...c.relay, readAccount: "other" }] }))
  await c.poll(NOW + MIN)
  assert.deepEqual(c.runReads().at(-1).who, "other")
  assert.equal(c.runReads().at(-1).ifNoneMatch, undefined, "the old account's validator is not sent to another account")
  await c.poll(NOW + 2 * MIN)
  assert.equal(c.runReads().at(-1).ifNoneMatch, '"v1"', "the new account then has its own")
  c.tokens.other = "fake-token-o-2"
  await c.poll(NOW + 3 * MIN)
  assert.equal(c.runReads().at(-1).ifNoneMatch, undefined, "the same login with a new credential is a new epoch")
})

test("conditional cache: the write client's credential never keys the reader's entry", async () => {
  const c = await cacheWorld()
  await c.poll(NOW)
  c.tokens.writer = "fake-token-w-2"
  await c.poll(NOW + MIN)
  assert.equal(c.runReads().at(-1).ifNoneMatch, '"v1"')
})

test("conditional cache: an entry with no stored body, no ETag or no epoch is read in full instead of failing on a 304", async () => {
  for (const [why, damage] of [["no body", (entry) => delete entry.value], ["no etag", (entry) => delete entry.etag], ["a legacy entry with no epoch", (entry) => delete entry.epoch]]) {
    const c = await cacheWorld()
    await c.poll(NOW)
    c.edit((state) => Object.values(state.cache).forEach(damage))
    const polled = await c.poll(NOW + MIN)
    assert.deepEqual(polled.errors, [], why)
    assert.equal(c.runReads().at(-1).ifNoneMatch, undefined, why)
    assert.equal(c.runReads().length, 2, why)
  }
})

test("conditional cache: a 304 to a read that sent no validator is read once more, and a second 304 is a visible failure that moves nothing", async () => {
  const recovered = await cacheWorld()
  recovered.server.always304 = 1
  const polled = await recovered.poll(NOW)
  assert.deepEqual(polled.errors, [])
  assert.deepEqual(recovered.runReads().map((call) => call.ifNoneMatch), [undefined, undefined])
  assert.equal(recovered.state(recovered.relay.name).seeded, true)

  const c = await cacheWorld()
  c.server.always304 = 99
  const failed = await c.poll(NOW)
  assert.equal(failed.errors[0].code, "relays_unexpected_304")
  assert.match(failed.errors[0].error, /304 Not Modified .*no ETag was sent/u)
  assert.equal(c.runReads().length, 2, "exactly one retry")
  assert.deepEqual(c.runReads().map((call) => call.ifNoneMatch), [undefined, undefined])
  assert.equal(c.state(c.relay.name).seeded, undefined, "the first poll's work marker is not advanced")
  assert.equal(c.state(c.relay.name).lastErrorCode, "relays_unexpected_304")
})

test("conditional cache: a stored falsey value is reused by a 304, not read again", async () => {
  for (const value of ["", null, false, 0]) {
    const c = await cacheWorld({ relay: { ...IMMEDIATE, account: "writer", readAccount: "reader" } })
    c.server.defaultBranch = value
    await c.poll(NOW)
    c.server.etag = '"v2"'
    c.server.runs = [run(1), run(2)]
    await c.poll(NOW + MIN)
    c.server.etag = '"v3"'
    c.server.runs = [run(1), run(2), run(3)]
    const polled = await c.poll(NOW + 2 * MIN)
    const branchReads = c.http.filter((call) => call.path === "/repos/o/pages")
    assert.deepEqual(polled.errors, [], String(value))
    assert.equal(branchReads.length, 2, `${String(value)}: read in full, then once more as a 304`)
    assert.ok(branchReads[1].ifNoneMatch, String(value))
    assert.equal(c.http.filter((call) => call.method === "POST").length, 2, String(value))
  }
})

test("conditional cache: a client with no epoch of its own reuses only entries that have none, and its entries carry none", async () => {
  const w = await setup([IMMEDIATE])
  w.world.on("GET", runsRoute, () => ({ workflow_runs: [run(1)] }))
  await w.poll(NOW)
  const stored = Object.values(w.state(IMMEDIATE.name).cache)[0]
  assert.equal("epoch" in stored, false)
  await w.poll(NOW + MIN)
  assert.equal(w.world.reads.at(-1).etag, stored.etag)
  assert.equal(w.world.notModified, 1)
  const states = readRelayStates(w.paths.state)
  Object.values(states[IMMEDIATE.name].cache).forEach((entry) => (entry.epoch = "e".repeat(64)))
  writeFileSync(w.paths.state, JSON.stringify(states))
  await w.poll(NOW + 2 * MIN)
  assert.equal(w.world.reads.at(-1).etag, undefined, "an entry of an identified credential is not offered to an unidentified client")
})

/** The real client for a merge relay: the fake GitHub's handlers answer behind a fake fetch, which records who asked and with which validator. */
async function mergeCacheWorld(options = {}) {
  const w = await setup([{ ...MERGE, requireMainWorkflowGreen: undefined, account: "writer", readAccount: "reader", ...options }])
  const tokens = { writer: "fake-token-w-1", reader: "fake-token-r-1" }
  const http = []
  const fake = await w.world.connect()
  const spawn = (_command, args) => ({ status: 0, stdout: `${tokens[args[args.indexOf("--user") + 1]]}\n` })
  const fetchImpl = async (url, init) => {
    const { pathname, search } = new URL(url)
    const route = pathname + search
    const who = Object.keys(tokens).find((name) => init.headers.Authorization === `Bearer ${tokens[name]}`)
    const method = init.method ?? "GET"
    http.push({ who, method, route, ifNoneMatch: init.headers["If-None-Match"] })
    const headers = (etag) => ({ get: (name) => (name.toLowerCase() === "etag" ? etag ?? null : null), has: () => false })
    if (method !== "GET") {
      const answer = await fake.send(method, route, init.body ? JSON.parse(init.body) : undefined)
      return { status: answer.status, ok: answer.ok, headers: headers(), json: async () => answer.body, text: async () => "" }
    }
    try {
      const answer = await fake.get(route, { etag: init.headers["If-None-Match"] })
      if (answer.notModified) return { status: 304, ok: false, headers: headers(), json: async () => ({}), text: async () => "" }
      return { status: 200, ok: true, headers: headers(answer.etag), json: async () => answer.body, text: async () => "" }
    } catch (error) {
      return { status: error.status ?? 500, ok: false, headers: headers(), json: async () => ({}), text: async () => "" }
    }
  }
  const connect = (account, opts) => connectGithub(account, { ...opts, spawn, fetchImpl, pauseMs: 0, env: { PATH: "/bin", MS_DESK_QUOTA: "off" } })
  const poll = (at) => pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: at })
  const checkReads = () => http.filter((call) => call.method === "GET" && call.route.includes("/check-runs"))
  return { ...w, http, poll, checkReads }
}

test("conditional cache: a check-runs entry with no stored body is dropped and read in full on the real merge path", async () => {
  for (const [why, damage] of [["no body", (entry) => delete entry.value], ["no runs list", (entry) => (entry.value = {})], ["another credential", (entry) => (entry.epoch = "f".repeat(64))]]) {
    const c = await mergeCacheWorld()
    mergeWorld(c.world, { checks: [{ ...check("typecheck", null, "queued"), id: 1, started_at: "2026-11-14T11:00:00Z" }] })
    await c.poll(NOW)
    const states = readRelayStates(c.paths.state)
    Object.entries(states["pages merge"].cache).filter(([route]) => route.includes("/check-runs")).forEach(([, entry]) => damage(entry))
    writeFileSync(c.paths.state, JSON.stringify(states))
    const polled = await c.poll(NOW + 12 * MIN)
    assert.deepEqual(polled.errors, [], why)
    assert.equal(c.checkReads().length, 2, why)
    assert.equal(c.checkReads()[1].ifNoneMatch, undefined, why)
    assert.equal(c.checkReads()[1].who, "reader", why)
  }
})

test("conditional cache: every page of check runs and statuses is read by the reader, never by the writing account", async () => {
  const c = await mergeCacheWorld({ requiredChecks: ["shard-*"] })
  const many = Array.from({ length: 120 }, (_, index) => check(`shard-${index}`))
  const statuses = Array.from({ length: 120 }, (_, index) => ({ context: `legacy/${index}`, state: "success" }))
  mergeWorld(c.world)
  c.world.on("GET", /\/commits\/a+\/check-runs\?per_page=100$/u, () => ({ total_count: 120, check_runs: many.slice(0, 100) }))
  c.world.on("GET", /\/commits\/a+\/check-runs\?per_page=100&page=2$/u, () => ({ total_count: 120, check_runs: many.slice(100) }))
  c.world.on("GET", /\/commits\/a+\/status\?per_page=100$/u, () => ({ state: "success", total_count: 120, statuses: statuses.slice(0, 100) }))
  c.world.on("GET", /\/commits\/a+\/status\?per_page=100&page=2$/u, () => ({ state: "success", total_count: 120, statuses: statuses.slice(100) }))
  await c.poll(NOW)
  const paged = c.http.filter((call) => call.route.includes("page=2"))
  assert.equal(paged.length, 2)
  const checkCalls = c.http.filter((call) => /\/(check-runs|status)\?/u.test(call.route))
  assert.equal(checkCalls.length, 4, "both pages of both lists")
  assert.deepEqual(checkCalls.map((call) => call.who), ["reader", "reader", "reader", "reader"])
  const writes = c.http.filter((call) => call.method !== "GET")
  assert.ok(writes.some((call) => call.method === "PUT" && call.route.endsWith("/merge")))
  assert.deepEqual(writes.filter((call) => call.who !== "writer"), [])
})

test("waitReadMs: a pull request waiting only on a push is read every 5 minutes at most, one waiting on checks every minute", () => {
  const first = Date.parse("2026-11-14T12:00:00Z")
  const later = first + 60 * 60_000
  assert.equal(waitReadMs({ firstReadAt: new Date(first).toISOString(), waitingOn: ["it has merge conflicts"] }, later), 300_000)
  assert.equal(waitReadMs({ firstReadAt: new Date(first).toISOString(), waitingOn: ["it is a draft"] }, first + 60_000), 30_000)
  assert.equal(waitReadMs({ firstReadAt: new Date(first).toISOString(), waitingOn: ["typecheck: typecheck in_progress"] }, later), 60_000)
})

// ── Spend display: a read held locally under the quota floor sends nothing, so it is not a counted call ──

async function spendWorld(rate, answer) {
  const w = await setup([{ ...IMMEDIATE, account: "ari" }])
  const { mkdirSync } = await import("node:fs")
  const quotaDir = path.join(w.dir, "gh-quota")
  mkdirSync(quotaDir)
  writeFileSync(path.join(quotaDir, "personal.rate"), `${rate} ${Math.floor(Date.now() / 1000) + 3600} 5000 ${Math.floor(Date.now() / 1000)}\n`)
  const sent = []
  const fetchImpl = async (url) => {
    sent.push(new URL(url).pathname)
    return answer()
  }
  const connect = (account, options) => connectGithub(account, { ...options, spawn: () => ({ status: 0, stdout: "fake-token-1\n" }), fetchImpl, pauseMs: 0, env: { PATH: "/bin", MS_DESK_QUOTA_DIR: quotaDir } })
  const poll = (at) => pollRelays({ paths: w.paths, drainFiles: w.drainFiles, connect, now: at })
  return { ...w, sent, poll }
}
const reply = (status, headers = {}) => ({ status, ok: status < 400, headers: { get: (name) => headers[name.toLowerCase()] ?? null, has: (name) => name.toLowerCase() in headers }, json: async () => ({ workflow_runs: [] }), text: async () => "" })

test("spend: a read held under the quota floor sent nothing, so the poll spent 0, the state counts 0 and the status says so", async () => {
  const w = await spendWorld(100, () => reply(200))
  const polled = await w.poll(NOW)
  assert.deepEqual(w.sent, [], "the hold is local: no request left")
  assert.equal(polled.errors[0].code, "drains_rate_limited")
  assert.equal(polled.spent, 0)
  assert.equal(w.state("data to pages").lastPoll.counted, 0)
  assert.equal(w.state("data to pages").spend.counted, 0)
  assert.doesNotMatch(relayStatusLines(readRelayConfig(w.paths.config), { "data to pages": w.state("data to pages") }, NOW).join("\n"), /spent 1 counted/u)
})

test("spend: a real HTTP 429 and a network failure each still count as one call", async () => {
  for (const answer of [() => reply(429, { "retry-after": "60" }), () => { throw new Error("socket hang up") }]) {
    const w = await spendWorld(4000, answer)
    const polled = await w.poll(NOW)
    assert.ok(w.sent.length >= 1, "the request was sent")
    assert.equal(polled.errors.length, 1)
    assert.equal(polled.spent, 1)
    assert.equal(w.state("data to pages").spend.counted, 1)
  }
})

test("spend: a 304 is free and a fired write is one counted call, as before", async () => {
  const w = await setup([IMMEDIATE])
  let runs = [run(1)]
  w.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  w.world.on("GET", /\/repos\/o\/pages$/u, () => ({ default_branch: "trunk" }))
  await w.poll(NOW)
  assert.equal((await w.poll(NOW + 30 * SECOND)).spent, 0, "an unchanged read is a free 304")
  assert.equal(w.state("data to pages").lastPoll.free, 1)
  runs = [run(2), ...runs]
  const fired = await w.poll(NOW + 60 * SECOND)
  assert.equal(w.world.writes.length, 1)
  assert.equal(fired.spent, 3, "the changed runs read, the default-branch read and the dispatch write each count")
})
