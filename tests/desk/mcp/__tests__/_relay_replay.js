// Relay replay: runs the real `pollRelays` against recorded, sanitized GitHub data, so a relay's decision can be asked of real histories.
// `replayMerge` asks, for one recorded merged pull request, what a `merge-when-green` relay would have done at a moment; `replayDispatch`
// polls a `dispatch` relay every 30 s through a recorded window of watched-workflow runs and returns every fire.
// The fixtures are written by tests/desk/mcp/__tests__/fixtures/relays/sanitize.mjs: generic names, and every time a number of seconds.
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { pollRelays, readRelayStates } from "../../../../plugins/desk/mcp/src/runtime/relays.js"
import { mkTempRoot } from "./_temp_roots.js"

const FIXTURES = fileURLToPath(new URL("./fixtures/relays/", import.meta.url))
const BASE = Date.parse("2026-01-01T00:00:00Z")
export const loadFixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"))
const iso = (offset) => (offset === null || offset === undefined ? null : new Date(BASE + offset * 1000).toISOString())

/** A GitHub that answers each route from a function, keeps If-None-Match semantics, and records every write. */
function fakeGithub(answer) {
  const writes = []
  let reads = 0
  let notModified = 0
  const connect = async () => ({
    login: "relay-bot",
    get: async (route, { etag } = {}) => {
      reads += 1
      const body = answer(route)
      if (body === undefined) throw Object.assign(new Error(`no answer for ${route}`), { status: 404 })
      const tag = `"${createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 12)}"`
      if (etag === tag) {
        notModified += 1
        return { notModified: true }
      }
      return { body, etag: tag, next: false }
    },
    send: async (method, route, body) => {
      writes.push({ method, route, body })
      if (method === "PUT") return { ok: true, status: 200, body: { merged: true, sha: "f".repeat(40) } }
      return { ok: true, status: 204, body: {} }
    },
    quota: () => ({ remaining: 4000, limit: 5000, reset: BASE / 1000 + 86_400 * 3, at: iso(0) }),
    calls: () => ({ total: reads + writes.length, notModified }),
  })
  return { connect, writes, stats: () => ({ reads, notModified }) }
}

async function relayWorld(relay) {
  const dir = await mkTempRoot("desk-relay-replay-")
  const paths = { config: path.join(dir, "relays.json"), state: path.join(dir, "relays-state.json"), lock: path.join(dir, "relays.lock") }
  const drainFiles = { config: path.join(dir, "config.json"), state: path.join(dir, "state.json") }
  writeFileSync(paths.config, JSON.stringify({ relays: [relay] }))
  writeFileSync(drainFiles.config, JSON.stringify({ drains: [] }))
  return { paths, drainFiles, state: () => readRelayStates(paths.state)[relay.name] }
}

// ── merge-when-green ──

/** The check runs as GitHub would have listed them `at` seconds from the merge: a run not yet started is absent, one not yet finished is in progress. */
export function checksAt(pull, at, { source = "all" } = {}) {
  const wanted = source === "latest" ? new Set(pull.latest) : null
  return pull.checks
    .filter((check) => (wanted ? wanted.has(check.id) : true) && (check.started === null || check.started <= at))
    .map((check) => {
      const done = check.status === "completed" && check.completed !== null && check.completed <= at
      return { id: check.id, name: check.name, status: done ? "completed" : "in_progress", conclusion: done ? check.conclusion : null, started_at: iso(check.started), completed_at: done ? iso(check.completed) : null }
    })
}

/** The latest completed run of the main branch's workflow `at` seconds from the merge, as the runs list answers `status=completed&per_page=1`. */
function mainRunsAt(pull, at) {
  return pull.main
    .filter((run) => run.completed <= at)
    .sort((a, b) => b.created - a.created || b.id - a.id)
    .map((run) => ({ id: run.id, status: "completed", conclusion: run.conclusion, html_url: `https://github.test/runs/${run.id}` }))
}

/** The relay config the merge fixtures stand for: the real shape of the recorded relay, with the fixture's generic check names. */
export const mergeRelay = (fixture, extra = {}) => ({
  name: "replayed merge",
  type: "merge-when-green",
  repo: "o/service",
  label: "merge-when-green",
  method: "squash",
  deleteBranch: true,
  requiredChecks: fixture.requiredChecks,
  ...(fixture.requireMainWorkflowGreen ? { requireMainWorkflowGreen: "ci.yml" } : {}),
  ...(fixture.skippedPasses ? { skippedPasses: true } : {}),
  ...extra,
})

/** What the relay would do with a recorded pull request `at` seconds from its merge (default: at the merge). `merge` is true when it would have merged. */
export async function replayMerge(fixture, pull, { at = 0, source = "all", relay = mergeRelay(fixture) } = {}) {
  const world = await relayWorld(relay)
  const sha = "a".repeat(40)
  const github = fakeGithub((route) => {
    if (route.includes("/issues?state=open&labels=")) return [{ number: 1, pull_request: {} }]
    if (/\/pulls\/1$/u.test(route)) return { state: "open", draft: false, mergeable: true, mergeable_state: "clean", labels: [{ name: relay.label }], head: { sha, ref: "feature/x", repo: { full_name: relay.repo } }, base: { ref: "main", repo: { full_name: relay.repo } } }
    if (route.includes("/check-runs")) {
      const runs = checksAt(pull, at, { source })
      return { total_count: runs.length, check_runs: runs }
    }
    if (/\/repos\/[^/]+\/[^/]+$/u.test(route)) return { default_branch: "main" }
    if (route.includes("/actions/workflows/")) return { workflow_runs: mainRunsAt(pull, at) }
    if (route.includes("/comments")) return []
    return undefined
  })
  await pollRelays({ paths: world.paths, drainFiles: world.drainFiles, connect: github.connect, now: BASE + at * 1000 })
  const state = world.state()
  const merged = github.writes.some((write) => write.method === "PUT" && write.route.endsWith("/merge"))
  return { merge: merged, waiting: state.prs[1]?.waitingOn ?? [], error: state.lastError }
}

// ── dispatch ──

/** Polls a dispatch relay every `pollSeconds` through the fixture's window, and returns each fire as `{ at, head, run }`. */
export async function replayDispatch(fixture, { relay, pollSeconds = 30, tailSeconds } = {}) {
  const config = relay ?? { name: "replayed dispatch", type: "dispatch", watch: { repo: "o/watched", workflow: "watched.yml", branch: "main", conclusion: "success" }, fire: { repo: "o/target", workflow: "target.yml", inputs: { head: "{{run.head_sha}}" } }, settleSeconds: fixture.settleSeconds }
  const world = await relayWorld(config)
  let at = 0
  const github = fakeGithub((route) => {
    if (route.includes("/actions/workflows/") && route.includes("/runs?status=success")) {
      return {
        workflow_runs: fixture.runs
          .filter((run) => run.status === "completed" && run.conclusion === "success" && run.completed <= at)
          .sort((a, b) => b.created - a.created || b.id - a.id)
          .slice(0, 30)
          .map((run) => ({ id: run.id, head_sha: run.head, head_branch: "main", html_url: `https://github.test/runs/${run.id}`, run_number: run.id, status: "completed", conclusion: "success" })),
      }
    }
    if (/\/repos\/[^/]+\/[^/]+$/u.test(route)) return { default_branch: "main" }
    return undefined
  })
  const fires = []
  const last = fixture.windowSeconds + (tailSeconds ?? fixture.settleSeconds + 120)
  // The poll before the window seeds the relay with the runs that had already succeeded.
  // A poll that sees no new run and no settle running changes nothing, so only the polls from a run's completion until its settle has passed are made.
  const quiet = (now) => now > -pollSeconds && !fixture.runs.some((run) => run.completed !== null && run.completed <= now && run.completed > now - (config.settleSeconds ?? 60) - 2 * pollSeconds)
  for (at = -pollSeconds; at <= last; at += pollSeconds) {
    if (quiet(at)) continue
    const before = github.writes.length
    await pollRelays({ paths: world.paths, drainFiles: world.drainFiles, connect: github.connect, now: BASE + at * 1000 })
    for (const write of github.writes.slice(before)) if (write.route.endsWith("/dispatches")) fires.push({ at, head: write.body.inputs?.head ?? write.body.client_payload?.head_sha })
  }
  return { fires, errors: world.state().lastError ? [world.state().lastError] : [], stats: github.stats() }
}
