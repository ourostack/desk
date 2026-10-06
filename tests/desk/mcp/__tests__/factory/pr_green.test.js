// The merged-with-green-checks reader, against an in-memory GitHub on the runner shape. No network.

import { test } from "node:test"
import assert from "node:assert/strict"

import { githubReader } from "../../../../../plugins/desk/mcp/src/factory/release-version.js"
import { mergedWithGreenChecks, MAX_CALLS } from "../../../../../plugins/desk/mcp/src/factory/pr-green.js"
import { httpError } from "./_fake_release_github.js"

const PR = "https://github.com/ourostack/desk/pull/12"
const SHA = "a".repeat(40)
const ok = (json) => ({ code: 0, stdout: JSON.stringify(json), stderr: "" })

const HEAD = "b".repeat(40)
const NONE = { total_count: 0, check_runs: [] }

function world({ pull = { merged_at: "2026-10-01T00:00:00Z", merge_commit_sha: SHA, head: { sha: HEAD } }, headRuns = null, headStatus = { state: "pending", total_count: 0 }, runs = { total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] }, status = { state: "success", total_count: 0 } } = {}) {
  const routes = []
  const runner = async (args) => {
    const route = args.find((arg) => /^repos\//u.test(arg))
    routes.push(route)
    if (/\/pulls\/\d+$/u.test(route)) return typeof pull === "function" ? pull() : ok(pull)
    if (route.includes(`/commits/${HEAD}/check-runs`) && headRuns !== null) return ok(headRuns)
    if (route.includes(`/commits/${HEAD}/status`)) return ok(headStatus)
    if (/\/check-runs\?/u.test(route)) return typeof runs === "function" ? runs() : ok(runs)
    if (/\/status$/u.test(route)) return typeof status === "function" ? status() : ok(status)
    return httpError(404)
  }
  return { client: githubReader({ runner, token: "t" }), routes }
}
const read = (w, over = {}) => mergedWithGreenChecks({ countermeasure: PR, client: w.client, ...over })

test("merged with every check green is merged_green, in three calls", async () => {
  const w = world()
  assert.deepEqual(await read(w), { state: "merged_green" })
  assert.equal(w.routes.length, 3)
  assert.equal(MAX_CALLS, 5)
})

test("neutral and skipped runs and a green combined status count as green", async () => {
  const w = world({ runs: { total_count: 2, check_runs: [{ status: "completed", conclusion: "neutral" }, { status: "completed", conclusion: "skipped" }] }, status: { state: "success", total_count: 2 } })
  assert.deepEqual(await read(w), { state: "merged_green" })
})

test("a status alone, with no check run, can be green", async () => {
  const w = world({ runs: { total_count: 0, check_runs: [] }, status: { state: "success", total_count: 1 } })
  assert.deepEqual(await read(w), { state: "merged_green" })
})

test("an unmerged pull request is not_merged and reads nothing more", async () => {
  const w = world({ pull: { merged_at: null, merge_commit_sha: null } })
  assert.deepEqual(await read(w), { state: "not_merged" })
  assert.equal(w.routes.length, 1)
  assert.deepEqual(await read(world({ pull: { merge_commit_sha: null } })), { state: "not_merged" })
})

test("a failed, running or missing check, a failing status, or no check at all is merged_not_green", async () => {
  const cases = [
    { runs: { total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }] } },
    { runs: { total_count: 1, check_runs: [{ status: "in_progress", conclusion: null }] } },
    { status: { state: "failure", total_count: 1 } },
    { status: { state: "pending", total_count: 1 } },
    { runs: { total_count: 0, check_runs: [] } },
  ]
  for (const over of cases) assert.deepEqual(await read(world(over)), { state: "merged_not_green" }, JSON.stringify(over))
})

test("every failure is unavailable with one stable reason, never not merged", async () => {
  assert.deepEqual(await mergedWithGreenChecks({ countermeasure: "not a url", client: world().client }), { state: "unavailable", reason: "countermeasure_unparsed" })
  assert.deepEqual(await read(world({ pull: () => httpError(404) })), { state: "unavailable", reason: "http_404" })
  assert.deepEqual(await read(world({ pull: [] })), { state: "unavailable", reason: "unexpected_answer" })
  assert.deepEqual(await read(world({ pull: { merged_at: "x", merge_commit_sha: "nothex" } })), { state: "unavailable", reason: "unexpected_answer" })
  assert.deepEqual(await read(world({ runs: { total_count: 1 } })), { state: "unavailable", reason: "unexpected_answer" })
  assert.deepEqual(await read(world({ runs: { total_count: 1, check_runs: [null] } })), { state: "unavailable", reason: "unexpected_answer" })
  assert.deepEqual(await read(world({ runs: { total_count: 101, check_runs: [{ status: "completed", conclusion: "success" }] } })), { state: "unavailable", reason: "too_many_checks" })
  assert.deepEqual(await read(world({ status: { state: 1 } })), { state: "unavailable", reason: "unexpected_answer" })
  assert.deepEqual(await read(world({ status: () => httpError(500) })), { state: "unavailable", reason: "http_500" })
  assert.deepEqual(await read(world(), { maxCalls: 2 }), { state: "unavailable", reason: "call_budget" })
  const odd = { get: async () => { throw new Error("boom") } }
  assert.deepEqual(await mergedWithGreenChecks({ countermeasure: PR, client: odd }), { state: "unavailable", reason: "lookup_failed" })
})

test("a merge commit with no checks falls back to the checks on the pull request's head commit", async () => {
  const green = world({ runs: NONE, headRuns: { total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] } })
  assert.deepEqual(await read(green), { state: "merged_green" })
  assert.equal(green.routes.length, 5)
  const red = world({ runs: NONE, headRuns: { total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }] } })
  assert.deepEqual(await read(red), { state: "merged_not_green" })
  const running = world({ runs: NONE, headRuns: { total_count: 1, check_runs: [{ status: "in_progress", conclusion: null }] } })
  assert.deepEqual(await read(running), { state: "merged_not_green" })
  assert.deepEqual(await read(world({ runs: NONE, headRuns: NONE })), { state: "merged_not_green" })
  const bySt = world({ runs: NONE, headRuns: NONE, headStatus: { state: "success", total_count: 1 } })
  assert.deepEqual(await read(bySt), { state: "merged_green" })
  // the merge commit's own checks win when it has any
  const own = world({ runs: { total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }] }, headRuns: { total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] } })
  assert.deepEqual(await read(own), { state: "merged_not_green" })
  assert.equal(own.routes.length, 3)
  // a pull request that names no head commit has no fallback
  assert.deepEqual(await read(world({ runs: NONE, pull: { merged_at: "x", merge_commit_sha: SHA } })), { state: "merged_not_green" })
  assert.deepEqual(await read(world({ runs: NONE, pull: { merged_at: "x", merge_commit_sha: SHA, head: { sha: "nothex" } } })), { state: "unavailable", reason: "unexpected_answer" })
})
