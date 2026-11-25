// Synthetic released-consumer fixture: runs the exact released Desk checkout's drains.js against a fake GitHub.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = process.argv[2]
const version = JSON.parse(readFileSync(path.join(root, "plugins/desk/plugin.json"), "utf8")).version
const { connectGithub, pollDrain, DRAIN_STATUS_MARKER } = await import(pathToFileURL(path.join(root, "plugins/desk/mcp/src/runtime/drains.js")).href)
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const connect = (answers) => {
  const asked = []
  const fetchImpl = async (url) => { asked.push(url); return answers.shift() ?? reply({}, 599) }
  return connectGithub("maintainer", { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl, login: "maintainer" }).then((api) => ({ api, asked }))
}
const results = {}
const check = async (name, fn) => { await fn(); results[name] = "ok" }

await check("REST 502 twice -> server error, asked twice, no auth words", async () => {
  const { api, asked } = await connect([reply({}, 502), reply({}, 502)])
  await assert.rejects(api.openIssues("o/r"), (e) => e.code === "drains_github_server_error" && !/gh auth/u.test(e.message))
  assert.equal(asked.length, 2)
})
await check("REST 502 then OK recovers", async () => {
  const { api, asked } = await connect([reply({}, 502), reply([])])
  assert.deepEqual(await api.openIssues("o/r"), [])
  assert.equal(asked.length, 2)
})
await check("GraphQL 503 twice -> server error", async () => {
  const { api, asked } = await connect([reply({}, 503), reply({}, 503)])
  await assert.rejects(api.editPage("o/r", 1), (e) => e.code === "drains_github_server_error")
  assert.equal(asked.length, 2)
})
await check("REST 401 -> auth advice, once", async () => {
  const { api, asked } = await connect([reply({}, 401)])
  await assert.rejects(api.openIssues("o/r"), (e) => e.code === "drains_check_gh_auth_status_then" && /Check gh auth status/u.test(e.message))
  assert.equal(asked.length, 1)
})
await check("GraphQL 401 -> auth advice, once", async () => {
  const { api, asked } = await connect([reply({}, 401)])
  await assert.rejects(api.editPage("o/r", 1), (e) => e.code === "drains_check_gh_auth_status_then")
  assert.equal(asked.length, 1)
})
for (const status of [403, 404, 422]) {
  await check(`REST ${status} -> non-credential refusal, once`, async () => {
    const { api, asked } = await connect([reply({}, status)])
    await assert.rejects(api.openIssues("o/r"), (e) => e.code === "drains_github_refused" && !/gh auth/u.test(e.message))
    assert.equal(asked.length, 1)
  })
}
await check("GraphQL errors payload -> non-credential", async () => {
  const { api } = await connect([reply({ errors: [{ message: "boom" }] })])
  await assert.rejects(api.editPage("o/r", 1), (e) => e.code === "drains_graphql_failed" && !/gh auth/u.test(e.message))
})
await check("seeded poll then persistent 502: seen, pending events and markers preserved, no new wake", async () => {
  assert.equal(DRAIN_STATUS_MARKER, "<!-- ouro-drain-status -->")
  const issue = { number: 1, title: "t", state: "open", updated_at: "2026-11-13T05:00:00Z", created_at: "2026-11-13T04:00:00Z", user: { login: "someone" }, body: "b", labels: [], assignees: [], comments: 0 }
  let mode = "ok"
  const asked = []
  const fetchImpl = async (url) => {
    asked.push([mode, String(url)])
    if (mode === "502") return reply({}, 502)
    return reply(/\/issues\?/u.test(String(url)) ? [issue] : [])
  }
  const api = await connectGithub("maintainer", { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl, login: "maintainer" })
  const drain = { repo: "acme/widgets", session: "58fbd57e-e371-4169-b013-2f413ab4a046", account: "maintainer" }
  const states = {}
  const t0 = Date.parse("2026-11-13T06:00:00Z")
  await pollDrain(drain, states, { connect: async () => api, now: t0 })
  assert.equal(states[drain.repo].seeded, true, "the baseline poll seeds")
  const state = states[drain.repo]
  assert.ok(Object.keys(state.seen).length > 0, "the baseline poll recorded what it saw")
  state.pending = [{ number: 7, title: "waiting", why: "new issue", seenAt: "2026-11-13T05:30:00Z", state: "open" }]
  const keep = () => JSON.stringify({ seen: state.seen, pending: state.pending, seeded: state.seeded, lastWakeCount: state.lastWakeCount ?? null })
  const before = keep()
  mode = "502"
  const calls = asked.length
  await pollDrain(drain, states, { connect: async () => api, now: t0 + 360_000 })
  assert.equal(keep(), before, "seen and pending are exactly as they were")
  assert.equal(state.lastErrorCode, "drains_github_server_error")
  assert.equal(asked.slice(calls).length, 2, "the failed read was asked exactly twice")
  assert.equal(state.pending.length, 1, "no new wake was added")
})
console.log(JSON.stringify({ version, results }, null, 1))
