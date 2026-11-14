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
import { parseRelayConfig, pollRelays, readRelayConfig, readRelayStates, relayPaths, relayStatusLines, relaysOfPull, waitingOnChecks, whyRelay } from "../../../../../plugins/desk/mcp/src/runtime/relays.js"

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
const GREEN = [check("typecheck"), check("npm test (ubuntu-latest, 1/2)"), check("npm test (ubuntu-latest, 2/2)"), check("unrelated", "failure")]

/** A GitHub that answers by pattern, keeps If-None-Match semantics and records every read and write. */
function github() {
  const handlers = []
  const world = {
    reads: [],
    writes: [],
    notModified: 0,
    on: (method, pattern, answer) => handlers.unshift({ method, pattern, answer }),
    pull: (number, extra = {}) => world.on("GET", new RegExp(`/pulls/${number}$`, "u"), () => ({ state: "open", draft: false, mergeable: true, mergeable_state: "clean", labels: [{ name: "merge-when-green" }], head: { sha: SHA, ref: "feature/x", repo: { full_name: "o/pages" } }, base: { ref: "main", repo: { full_name: "o/pages" } }, ...extra })),
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

function mergeWorld(world, { checks = GREEN, main = [{ id: 9, conclusion: "success", html_url: "https://github.test/runs/9" }], pr = {} } = {}) {
  world.on("GET", /\/issues\?state=open&labels=merge-when-green/u, () => [{ number: 7, pull_request: {} }, { number: 8 }])
  world.pull(7, pr)
  world.on("GET", /\/commits\/a+\/check-runs/u, () => ({ total_count: checks.length, check_runs: checks }))
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
  const [loose, full] = parseRelayConfig(JSON.stringify({ relays: [{ name: " x ", type: "dispatch", account: " me ", everySeconds: 45, watch: { repo: "o/a", workflow: " a.yml " }, fire: { repo: "o/b", workflow: " b.yml ", ref: " dev " } }, { ...mergeless, label: " go ", method: "rebase", deleteBranch: false, requireMainWorkflowGreen: " ci.yml " }] }), "relays.json")
  assert.deepEqual(loose, { name: "x", type: "dispatch", account: "me", everySeconds: 45, watch: { repo: "o/a", workflow: "a.yml", conclusion: "success" }, fire: { repo: "o/b", workflow: "b.yml", ref: "dev" } })
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
  const w = await setup([DISPATCH])
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
  const w = await setup([{ ...DISPATCH, fire: { repo: "o/pages", event: "data-ready" } }])
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
  const w = await setup([DISPATCH])
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

test("dispatch: the handled runs survive a restart, so nothing fires again, and a refused fire is kept for a retry", async () => {
  const w = await setup([DISPATCH])
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
  const again = await setup([DISPATCH])
  writeFileSync(again.paths.state, readFileSync(w.paths.state))
  again.world.on("GET", runsRoute, () => ({ workflow_runs: runs }))
  await again.poll(NOW + 9 * MIN)
  assert.equal(again.world.writes.length, 0, "a fresh process with the saved state does not fire the handled run")
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

test("skippedPasses is true or false on a merge relay, and anything else is named", () => {
  const merge = (extra) => parseRelayConfig(JSON.stringify({ relays: [{ ...MERGE, ...extra }] }), "relays.json")[0]
  assert.equal(merge({ skippedPasses: true }).skippedPasses, true)
  assert.throws(() => merge({ skippedPasses: "yes" }), /relays\[0\]\.skippedPasses is not true or false/u)
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
  assert.deepEqual(prWrites(w.world), [{ method: "PUT", route: "/repos/o/pages/pulls/7/merge", body: { merge_method: "squash", sha: SHA } }])
  assert.deepEqual(w.world.writes.filter((write) => write.method === "DELETE").map((write) => write.route), ["/repos/o/pages/git/refs/heads/feature/x"])
  assert.equal(comments(w.world).length, 1)
  assert.equal(comments(w.world)[0].method, "POST")
  assert.match(comments(w.world)[0].body.body, /^<!-- desk-relay-status:pages merge -->\n\*\*merge-when-green\*\* merged this \(squash, head `aaaaaaa`, now `bbbbbbb`\)\. Every required check on the head was green and main's latest completed ci\.yml run 9 \(https:\/\/github\.test\/runs\/9\) was green; the branch is deleted\./u)
  assert.equal(w.state("pages merge").lastMerge.number, 7)
  assert.match(relayStatusLines([MERGE], { "pages merge": w.state("pages merge") }, NOW)[0], /last merged #7/u)
  assert.equal(JSON.stringify(w.world.writes).match(/admin|bypass|auto_merge/iu), null, "no bypass of any kind is ever sent")
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
  await w.poll(NOW + MIN)
  assert.equal(comments(w.world).length, 1, "a progress edit waits two minutes")
  checks = [check("typecheck"), check("npm test (ubuntu-latest, 1/2)"), check("npm test (ubuntu-latest, 2/2)", null, "queued")]
  await w.poll(NOW + 3 * MIN)
  assert.deepEqual(comments(w.world).map((write) => write.method), ["POST", "PATCH"], "it edits the same comment")
  assert.equal(comments(w.world)[1].route, "/repos/o/pages/issues/comments/55")
  assert.deepEqual(prWrites(w.world), [])

  checks = []
  await w.poll(NOW + 6 * MIN)
  assert.deepEqual(prWrites(w.world), [], "checks that have not started are missing, not green")
  checks = GREEN
  await w.poll(NOW + 9 * MIN)
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
  assert.equal(await why(NOW, { main: [{ id: 9, conclusion: "cancelled" }] }), "main's latest completed ci.yml run 9 (https://github.test/runs/9) is cancelled")
  assert.equal(await why(NOW, { main: [{ id: 9, conclusion: "failure" }], pr: { base: { ref: "stack", repo: { full_name: "o/pages" } } } }), "main's latest completed ci.yml run 9 (https://github.test/runs/9) is failure", "a pull request into another branch still waits on the default branch")
  assert.equal(await why(NOW, { main: [] }), "main has no completed ci.yml run yet")
  assert.equal(await why(NOW, { pr: { draft: true } }), "it is a draft")
  assert.equal(await why(NOW, { pr: { mergeable: false, mergeable_state: "dirty" } }), "it has merge conflicts")
  assert.equal(await why(NOW, { pr: { mergeable: null, mergeable_state: "unknown" } }), "GitHub has not yet worked out whether it merges cleanly")
  assert.equal(await why(NOW, { pr: { mergeable_state: "behind" } }), "it is behind main")
  assert.equal(await why(NOW, { pr: { mergeable_state: "blocked" } }), "GitHub reports it as blocked, so the branch rules do not let it merge")
  assert.equal(await why(NOW, { pr: { labels: [] } }), "the merge-when-green label is gone")
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
  assert.match(status, /relay data to pages \(dispatch\) o\/data data\.yml -> o\/pages: polled 0s ago, never fired, waiting on the next successful data\.yml run on main/u)
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
  assert.match(relayStatusLines([DISPATCH], states, NOW)[0], /polled 3h ago, last fired 2m ago for run 4 -> o\/pages pages\.yml, waiting on the next one$/u)
  assert.equal(whyRelay([MERGE], {}, "pages merge").waiting, null)
  assert.match(whyRelay([MERGE], {}, "other").note, /no relay is configured as other/u)
  assert.deepEqual(relaysOfPull([MERGE], {}, "o/pages", 7), [])
  assert.deepEqual(relaysOfPull([MERGE, DISPATCH], { "pages merge": { prs: {}, history: [{ number: 7, event: "refused" }, { number: 8, event: "merged" }] } }, "o/pages", 7), [{ relay: "pages merge", pull: undefined, history: [{ number: 7, event: "refused" }] }])
})

test("dispatch: a fire with a ref and no inputs, and an event GitHub refuses, are both reported exactly", async () => {
  const bare = { name: "bare", type: "dispatch", watch: { repo: "o/data", workflow: "data.yml" }, fire: { repo: "o/pages", workflow: "pages.yml", ref: "dev" } }
  const event = { ...DISPATCH, name: "event", fire: { repo: "o/pages", event: "data-ready" } }
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
  await w.poll(NOW + 3 * MIN)
  assert.deepEqual(comments(w.world).map((write) => write.method), ["POST", "PATCH", "POST"], "a deleted comment is written again")
  checks = [check("typecheck", null, "pending")]
  w.world.on("PATCH", /comments\/55$/u, () => ({ ok: false, status: 500, body: { message: "boom" } }))
  assert.match((await w.poll(NOW + 6 * MIN)).errors[0].error, /#7: Check that the relay's account can edit its status comment in o\/pages, then try again: GitHub answered HTTP 500 \(boom\)/u)
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
