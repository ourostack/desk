// Desk tools only help (#623): the contract that every failing, timed-out or refusing answer from any Desk tool carries
// `route_around`, a way to finish the same job another way that keeps every guard and proves it worked. The real session
// boundary is driven in runtime/desk_session_route_around.test.js; this file pins the routes themselves, the classifier
// that decides what is a failure, and a lint that no tool can return a status nobody classified.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync, readdirSync, statSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { TOOL_NAMES } from "../../../../../plugins/desk/mcp/src/tool-names.js"
import {
  FAILING_STATUSES, SETTLED_STATUSES, TOOL_ROUTES, failureOf, routedCallTool, toolRoute, withRouteAround,
} from "../../../../../plugins/desk/mcp/src/util/tool-route.js"

const SRC = fileURLToPath(new URL("../../../../../plugins/desk/mcp/src/", import.meta.url))
const ROOT = path.join(path.sep, "desks", "shared")

const SAMPLE = {
  task_create: { track: "ops", slug: "harbor", title: "Harbor" },
  task_update: { track: "ops", slug: "harbor", note: "x" },
  task_archive: { track: "ops", slug: "harbor" },
  task_signoff: { track: "ops", slug: "harbor" },
  task_move: { track: "ops", slug: "harbor", to_track: "eng" },
  task_focus: { track: "ops", slug: "harbor" },
  track_create: { slug: "ops", scope: "s" },
  track_update: { slug: "ops" },
  track_rename: { track: "ops", to: "eng" },
  friction_add: { track: "ops", theme: "slow", about: "system" },
  lesson_add: { topic: "Keep it short", scope: "personal" },
  desk_save: { paths: ["notes.md"] },
  note_leave: { to: "sam", subject: "hi" },
  note_ack: { note: "desks/ari/_inbox/2026-11-05-sam-hi.md" },
  improvement_open: { source: "lesson", id: "x" },
  improvement_next: {},
  improvement_update: { key: "lesson--abc", claim_id: "c1" },
  desk_search: { query: "ferry" },
  desk_recall: { topic: "ferry" },
  desk_similar: { path: "ops/harbor/task.md" },
  desk_timeline: { from: "2026-11-01" },
  desk_thread: { start_path: "ops/harbor/task.md" },
  desk_reindex: {},
  desk_status: {},
  desk_doctor: {},
  desk_skill: { name: "using-desk" },
}

const CONTEXTS = {
  plain: { root: ROOT, person: "ari", stateBranch: "main" },
  solo: { root: ROOT, person: null, stateBranch: null },
  unknown_root: { root: null, person: null },
  branch: { root: ROOT, person: "ari", stateBranch: "main", code: "state_branch_mismatch" },
  write_branch: { root: ROOT, person: "ari", stateBranch: "main", code: "write_branch_detached" },
  authority: { root: ROOT, person: "ari", code: "authority_invalid" },
  identity: { root: ROOT, person: null, code: "identity_unverified" },
  headless: { root: ROOT, person: "ari", code: "headless_session" },
  hosted: { root: ROOT, person: "ari", hosted: true },
}

const READS = new Set(["desk_search", "desk_recall", "desk_similar", "desk_timeline", "desk_thread", "desk_reindex", "desk_status", "desk_doctor", "desk_skill", "task_focus"])
const PULL_REQUEST = new Set(["note_leave"])
const REPORTS = new Set(["desk_status", "desk_doctor"])

function argvs(route) {
  const out = []
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (value === null || typeof value !== "object") return
    if (Array.isArray(value.argv)) (Array.isArray(value.argv[0]) ? value.argv : [value.argv]).forEach((argv) => out.push(argv))
    Object.values(value).forEach(visit)
  }
  visit(route)
  return out
}

function routesFor(name) {
  const inputs = [{}, SAMPLE[name] ?? {}]
  if (name === "lesson_add") inputs.push({ topic: "t", scope: "team" }, { topic: "t", scope: "desk" })
  return Object.entries(CONTEXTS).flatMap(([label, ctx]) => inputs.map((input) => ({ label, ctx, input, route: toolRoute(name, input, ctx) })))
}

test("every Desk tool has a route, and nothing else does", () => {
  assert.deepEqual(Object.keys(TOOL_ROUTES).sort(), [...TOOL_NAMES].sort())
})

test("every route says what to do, in steps, and how to prove it worked", () => {
  for (const name of TOOL_NAMES) {
    for (const { label, route } of routesFor(name)) {
      const where = `${name} (${label})`
      assert.equal(typeof route.summary, "string", where)
      assert.ok(route.summary.length > 20, where)
      assert.ok(Array.isArray(route.steps) && route.steps.length > 0, where)
      for (const step of route.steps) assert.equal(typeof step.step, "string", `${where}: every step says what it does`)
      assert.ok(route.readback ?? route.published_when ?? route.committed_locally_when, `${where}: a read-back proves it`)
    }
  }
})

test("routes keep every guard: no force, no hook skip, no stash, no blanket add, no override, no identity change, no hard-coded remote", () => {
  const banned = ["--force", "--force-with-lease", "--no-verify", "stash", "-A", "--all", "--hard", "reset", "clean", "user.name", "user.email", "origin", "--detach"]
  const bannedFor = { commit: ["-n", "-a", "--amend"], add: ["-f"], push: ["-f"] }
  for (const name of TOOL_NAMES) {
    for (const { label, route } of routesFor(name)) {
      for (const argv of argvs(route)) {
        if (argv[0] !== "git") continue
        const extra = Object.entries(bannedFor).flatMap(([verb, tokens]) => (argv.includes(verb) ? tokens : []))
        for (const token of [...banned, ...extra]) assert.ok(!argv.includes(token), `${name} (${label}) runs ${argv.join(" ")}`)
        assert.ok(!argv.some((token) => /github\.com|https?:/u.test(token)), `${name} (${label}) names a destination: ${argv.join(" ")}`)
      }
      assert.doesNotMatch(JSON.stringify(route), /DESK_TOOL_COMMIT/u, `${name} (${label}) never names the card guard's override`)
    }
  }
})

test("a guard's refusal hands the change to whoever may make it; the route writes nothing", () => {
  for (const name of TOOL_NAMES) {
    for (const label of ["authority", "identity", "headless"]) {
      const route = toolRoute(name, SAMPLE[name], CONTEXTS[label])
      assert.deepEqual(argvs(route), [], `${name} (${label}) runs nothing`)
      assert.match(route.summary, /never write it by hand, change identity or treat the refusal as permission/u)
    }
  }
})

test("a hosted Desk has no shell or Git, so its routes run nothing", () => {
  for (const name of TOOL_NAMES) assert.deepEqual(argvs(toolRoute(name, SAMPLE[name], CONTEXTS.hosted)), [], name)
})

test("a branch refusal never switches the shared checkout by hand: the change is made, published and read back in a temporary worktree", () => {
  for (const name of TOOL_NAMES.filter((n) => !READS.has(n))) {
    for (const label of ["branch", "write_branch"]) {
      const route = toolRoute(name, SAMPLE[name], CONTEXTS[label])
      const all = argvs(route)
      assert.ok(!all.some((argv) => argv.includes("switch") || argv.includes("checkout")), `${name} (${label})`)
      const add = all.find((argv) => argv.includes("worktree") && argv.includes("add"))
      assert.deepEqual(add?.slice(-2), [`${ROOT}.desk-route-${name}`, "main"], `${name} (${label}) works in its own worktree on the state branch`)
      assert.ok(all.filter((argv) => argv[0] === "git" && argv.includes("-C")).every((argv) => argv[2] === ROOT || argv[2].startsWith(`${ROOT}.desk-route-${name}`)), `${name} (${label}) writes only in that worktree`)
      assert.deepEqual(route.cleanup.argv, ["git", "-C", ROOT, "worktree", "remove", `${ROOT}.desk-route-${name}`], `${name} (${label}) removes only its own worktree, unforced`)
      // A push already running for the worktree pushes from it: removing the worktree before the remote has the change strands that push.
      if (route.published_when) assert.match(route.cleanup.step, /published_when passes/u, `${name} (${label}) keeps the worktree until the remote has the change`)
    }
  }
})

test("a write's route keeps 'committed here' apart from 'published to the remote'; a pull request counts only when merged", () => {
  for (const name of TOOL_NAMES.filter((n) => !READS.has(n))) {
    for (const input of name === "lesson_add" ? [{ topic: "t" }, { topic: "t", scope: "team" }] : [SAMPLE[name]]) {
      const route = toolRoute(name, input, CONTEXTS.plain)
      const where = `${name} ${JSON.stringify(input)}`
      if (PULL_REQUEST.has(name) || input.scope === "team") {
        assert.match(route.readback.expect, /only state MERGED/u, where)
        continue
      }
      assert.ok(route.committed_locally_when?.argv, `${where}: committed here`)
      assert.ok(route.published_when?.argv, `${where}: published`)
      // The push worker exits at once when a push for this root is already running, so one read-back right after it can come too early.
      assert.match(route.published_when.expect, /still (?:be )?running/u, `${where}: a push still running is waited for, not taken as a failure`)
      assert.match(route.published_when.expect, /publish step again/u, `${where}: publishing again is the safe next step`)
      assert.ok(route.steps.some((step) => Array.isArray(step.argv) && step.argv.some((token) => typeof token === "string" && token.endsWith("sync-push.js"))), `${where}: published through Desk's push worker`)
    }
  }
})

test("a write's route commits by exact path and starts by reading back, so a change that already landed is not made twice", () => {
  for (const name of TOOL_NAMES.filter((n) => !READS.has(n) && !PULL_REQUEST.has(n) && n !== "lesson_add")) {
    const route = toolRoute(name, SAMPLE[name], CONTEXTS.plain)
    assert.match(route.steps[0].step, /^Read back first/u, name)
    for (const argv of argvs(route).filter((a) => a[0] === "git" && (a.includes("add") || a.includes("commit")))) {
      assert.ok(argv.includes("--"), `${name}: ${argv.join(" ")} names its paths`)
    }
  }
})

test("a live task card is changed through Desk's validated local recovery, once, with the arguments on stdin", () => {
  for (const name of ["task_create", "task_update", "task_archive", "task_signoff", "desk_save"]) {
    const route = toolRoute(name, SAMPLE[name], CONTEXTS.plain)
    const run = route.steps.find((step) => Array.isArray(step.argv) && step.argv.some((token) => typeof token === "string" && token.endsWith("local-recovery.js")))
    assert.ok(run, name)
    assert.deepEqual(run.argv.slice(2, 6), ["--root", ROOT, "--operation", name === "task_signoff" ? "task_update" : name])
    assert.deepEqual(run.argv.slice(6), ["--person", "ari"])
    assert.equal(typeof run.stdin, "string")
    assert.match(run.step, /never send it twice blind/u)
  }
})

test("a route never names a person or a path it was not given", () => {
  const route = toolRoute("track_update", { slug: "../../etc" }, { root: ROOT, person: "../x" })
  assert.ok(argvs(route).every((argv) => !argv.some((token) => typeof token === "string" && token.includes(".."))), JSON.stringify(argvs(route)))
  assert.match(JSON.stringify(route), /<slug>/u)
})

// ---- the lint: no tool can return a status nobody classified -------------------------------------------------------

function sources(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? sources(full) : entry.endsWith(".js") ? [full] : []
  })
}

test("every status a tool, the search, the card library or the session can return is classified as failing or settled", () => {
  const failing = new Set(FAILING_STATUSES)
  assert.deepEqual(SETTLED_STATUSES.filter((status) => failing.has(status)), [], "no status is both")
  const known = new Set([...FAILING_STATUSES, ...SETTLED_STATUSES])
  const files = [
    ...["tools", "search", "desk"].flatMap((dir) => sources(path.join(SRC, dir))),
    ...["desk-session.js", "hosted.js", "diagnostic-server.js"].map((file) => path.join(SRC, "runtime", file)),
  ]
  const unclassified = []
  for (const file of files) {
    for (const [, status] of readFileSync(file, "utf8").matchAll(/\bstatus:\s*"([a-z_]+)"/gu)) {
      if (!known.has(status)) unclassified.push(`${path.relative(SRC, file)}: ${status}`)
    }
  }
  assert.deepEqual(unclassified, [], "add each to FAILING_STATUSES or SETTLED_STATUSES in util/tool-route.js")
})

// ---- what counts as a failure ---------------------------------------------------------------------------------------

test("failureOf: a failure nested under a success-looking status still fails; a legitimate 'no' does not", () => {
  const table = [
    ["desk_save", { status: "nothing_to_commit", commit: { status: "failed", reason: "timeout" } }, undefined, true],
    ["desk_save", { status: "nothing_to_commit" }, undefined, false],
    ["lesson_add", { status: "written", commit: { status: "unknown" } }, undefined, true],
    ["lesson_add", { status: "routed", in_effect: false }, undefined, false],
    ["lesson_add", { status: "pr_open" }, undefined, false],
    ["improvement_open", { status: "ok", commit: "commit_failed" }, undefined, true],
    ["improvement_open", { status: "ok", commit: "commit_unknown" }, undefined, true],
    ["improvement_open", { status: "ok", commit: "committed" }, undefined, false],
    ["improvement_next", { status: "none_open" }, undefined, false],
    ["improvement_next", { status: "claim_held" }, undefined, true],
    ["improvement_next", { status: "lock_busy" }, undefined, true],
    ["desk_thread", { error: "not_indexed" }, undefined, true],
    ["desk_search", { status: "error", code: "search_starting" }, undefined, true],
    ["task_archive", { status: "archive_pending", publication: { status: "unknown" } }, undefined, true],
    ["task_archive", { status: "archived", publication: { status: "pending" } }, undefined, true],
    ["task_archive", { status: "archived", publication: { status: "published" } }, undefined, false],
    ["note_leave", { status: "failed" }, undefined, true],
    ["task_update", { status: "refused", code: "headless_session" }, undefined, true],
    ["desk_status", { status: "degraded" }, undefined, false],
    ["desk_status", { status: "degraded" }, true, true],
    ["desk_doctor", { state: "ready" }, undefined, false],
    ["task_create", null, true, true],
    ["task_create", null, undefined, false],
  ]
  for (const [name, payload, isError, expected] of table) assert.equal(failureOf(name, payload, isError), expected, `${name} ${JSON.stringify(payload)} isError=${isError}`)
})

// ---- the boundary: every failure shape of every tool leaves with a route ---------------------------------------------

const answer = (payload, extra = {}) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], ...extra })
const parsed = (result) => JSON.parse(result.content[0].text)

test("every failure shape of every tool leaves with route_around; answers that are not failures leave unchanged", () => {
  const ctx = CONTEXTS.plain
  for (const name of TOOL_NAMES) {
    const input = SAMPLE[name]
    const expected = toolRoute(name, input, ctx)
    const shapes = [
      answer({ status: "refused", code: "admitting", summary: "Desk is still admitting." }, { isError: true }),
      answer({ status: "degraded", code: "tool_exception", summary: `${name} failed unexpectedly.` }, { isError: true }),
      answer({ status: "failed", message: "boom" }),
      answer({ status: "written", commit: { status: "failed", reason: "stage_failed" } }),
      answer({ status: "not_implemented", tool: name }),
    ]
    // desk_status and desk_doctor report the session's state, degraded or not; only an error from the call itself fails them.
    for (const shape of REPORTS.has(name) ? shapes.filter((s) => s.isError) : shapes) {
      const routed = withRouteAround(name, input, shape, ctx)
      assert.deepEqual(parsed(routed).route_around, expected, `${name} ${shape.content[0].text}`)
      assert.equal(routed.isError, shape.isError, "isError is never changed")
    }
    const text = withRouteAround(name, input, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true }, ctx)
    assert.equal(text.content[0].text, `Unknown tool: ${name}`, "a text answer keeps its text")
    assert.deepEqual(JSON.parse(text.content[1].text).route_around, expected, `${name}: a text answer gets the route as a second item`)

    const own = { kept: true }
    const carried = answer({ status: "written", commit: { status: "failed", reason: "timeout", route_around: own } })
    assert.equal(withRouteAround(name, input, carried, ctx), carried, `${name}: a route the tool built itself is kept as is`)
    for (const fine of [answer({ status: "ok" }), answer({ status: "none_open" }), answer({ status: "routed", in_effect: false })]) {
      assert.equal(withRouteAround(name, input, fine, ctx), fine, `${name}: ${fine.content[0].text} is an answer`)
    }
  }
})

test("a pretty-printed answer stays pretty; the route is added beside its fields", () => {
  const result = { content: [{ type: "text", text: JSON.stringify({ status: "refused", code: "admitting" }, null, 2) }], isError: true }
  const routed = withRouteAround("desk_search", { query: "x" }, result, CONTEXTS.plain)
  assert.match(routed.content[0].text, /\n {2}"route_around": \{/u)
  assert.equal(parsed(routed).code, "admitting")
})

test("routedCallTool keeps a synchronous answer synchronous and routes an asynchronous one", async () => {
  const failing = answer({ status: "refused", code: "admitting" }, { isError: true })
  const sync = routedCallTool(() => failing, () => CONTEXTS.plain)({ name: "desk_search", input: {} })
  assert.equal(typeof sync.then, "undefined")
  assert.ok(parsed(sync).route_around)
  const later = await routedCallTool(async () => failing, () => CONTEXTS.plain)({ name: "desk_search", input: {} })
  assert.ok(parsed(later).route_around)
})
