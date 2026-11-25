// Synthetic released-consumer fixture for #1711: the released Desk's pollDrains against a fake GitHub (no live account, no store).
// Run: node consumer-1711.mjs <extracted-release-root>
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = process.argv[2]
const version = JSON.parse(readFileSync(path.join(root, "plugins/desk/.claude-plugin/plugin.json"), "utf8")).version
const { ackWake, pollDrains, readDrainStates, DRAIN_STATUS_MARKER } = await import(pathToFileURL(path.join(root, "plugins/desk/mcp/src/runtime/drains.js")).href)

const NOW = Date.parse("2026-11-13T06:00:00Z")
const DRAIN = { repo: "acme/widgets", session: "58fbd57e-e371-4169-b013-2f413ab4a046", account: "maintainer" }
const BOT = "github-actions[bot]"
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z")
const T0 = "2026-11-13T01:00:00Z"
const LONG_AGO = Date.parse("2026-01-01T00:00:00Z")
const botEdit = (id, at) => ({ id, editedAt: at, deletedAt: null, editor: { type: "Bot", login: BOT } })
const personEdit = (id, at) => ({ id, editedAt: at, deletedAt: null, editor: { type: "User", login: "ari" } })
const lifecycle = (event, created_at, actor, extra = {}) => ({ id: 1, event, created_at, ...(actor ? { actor: { login: actor } } : {}), ...extra })

const roots = []
async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "consumer-1711-"))
  roots.push(dir)
  const paths = { config: path.join(dir, "config.json"), state: path.join(dir, "state.json"), lock: path.join(dir, "poll.lock") }
  writeFileSync(paths.config, JSON.stringify({ drains: [DRAIN] }))
  const w = { dir, paths, sent: [], issues: [{ number: 1, title: "Health", updated_at: T0, body: "health: 0" }], hist: { count: 3, extra: [] }, comments: [], events: [], timeline: [], reads: 0 }
  const at = (i) => (i < w.hist.count ? botEdit(`o${i}`, iso(LONG_AGO + i * 1000)) : w.hist.extra[i - w.hist.count])
  w.api = {
    login: "maintainer",
    openIssues: async () => w.issues,
    changedIssues: async () => ({ issues: w.issues, etag: '"t"' }),
    comments: async () => w.comments,
    issueEvents: async () => w.events,
    timeline: async () => w.timeline,
    pull: async () => ({}),
    graphqlQuota: () => ({ limit: 5000, remaining: 5000, reset: Math.floor(NOW / 1000) + 3600, at: iso(NOW) }),
    graphqlCost: () => 1,
    editPage: async (_repo, number, { backward = false } = {}) => {
      w.reads += 1
      const total = w.hist.count + w.hist.extra.length
      const edits = Array.from({ length: total }, (_, i) => at(i))
      return { updatedAt: w.issues[0].updated_at, total, edits: backward ? edits.reverse() : edits, hasMore: false, cursor: "c0" }
    },
  }
  w.poll = async (when = NOW) => {
    const out = await pollDrains({ paths, connect: async () => w.api, now: when, ackCommand: ["node", "drains.js"] })
    for (const wake of out.wakes) {
      w.sent.push(wake.message)
      ackWake({ paths, repo: wake.repo, wake: wake.id, now: when })
    }
    return out
  }
  w.change = (when, edit) => {
    if (edit) w.hist.extra.push(edit)
    w.issues[0] = { ...w.issues[0], updated_at: iso(when), body: `health: ${when}` }
  }
  w.state = () => readDrainStates(paths.state)[DRAIN.repo]
  return w
}

// A baseline poll, then a bot rewrites the body at NOW+6 min, then `extra` news is added before the second poll.
async function afterBotEdit(news = () => {}) {
  const w = await setup()
  await w.poll()
  w.change(NOW + 360_000, botEdit("n1", iso(NOW + 360_000)))
  news(w)
  await w.poll(NOW + 360_000)
  return w
}

const results = {}
// A check's own temporary roots are removed when it passes; when it fails they are kept and named for diagnosis.
const check = async (name, fn) => {
  const before = roots.length
  try {
    await fn()
  } catch (error) {
    console.error(`kept for diagnosis (check "${name}" failed): ${roots.slice(before).join(", ")}`)
    throw error
  }
  for (const dir of roots.splice(before)) rmSync(dir, { recursive: true, force: true })
  results[name] = "ok"
}

await check("bot-only body edit after a baseline wakes nobody and advances the baseline", async () => {
  const w = await afterBotEdit()
  assert.deepEqual(w.sent, [])
  assert.equal(w.state().seen[1].updatedAt, iso(NOW + 360_000))
  assert.ok(w.reads > 0, "the edit history was read")
})
await check("repeated bot edits every six minutes stay quiet", async () => {
  const w = await afterBotEdit()
  for (let i = 2; i <= 6; i += 1) {
    w.change(NOW + i * 360_000, botEdit(`n${i}`, iso(NOW + i * 360_000)))
    await w.poll(NOW + i * 360_000)
  }
  assert.deepEqual(w.sent, [])
})
await check("a person's body edit wakes once", async () => {
  const w = await setup()
  await w.poll()
  w.change(NOW + 360_000, personEdit("p1", iso(NOW + 360_000)))
  await w.poll(NOW + 360_000)
  assert.equal(w.sent.length, 1)
})
await check("a person's edit followed by a bot's still wakes", async () => {
  const w = await setup()
  await w.poll()
  w.hist.extra.push(personEdit("p1", iso(NOW + 300_000)))
  w.change(NOW + 360_000, botEdit("b1", iso(NOW + 360_000)))
  await w.poll(NOW + 360_000)
  assert.equal(w.sent.length, 1)
})
await check("a bot's body edit does not hide a person's comment", async () => {
  const w = await afterBotEdit((x) => { x.comments = [{ id: 7, body: "please look", updated_at: iso(NOW + 300_000), user: { login: "ari", type: "User" } }] })
  assert.match(w.sent[0], /comment 7 by ari/u)
})
await check("a bot's body edit does not hide an outside label", async () => {
  const w = await afterBotEdit((x) => { x.events = [{ id: 1, event: "labeled", created_at: iso(NOW + 300_000), label: { name: "bug" }, actor: { login: "ari" } }] })
  assert.match(w.sent[0], /labeled bug/u)
})
await check("a bot's body edit does not hide a reopen", async () => {
  const w = await afterBotEdit((x) => { x.events = [lifecycle("reopened", iso(NOW + 300_000), "ari")] })
  assert.match(w.sent[0], /reopened/u)
})
await check("a bot's body edit does not hide a cross-reference", async () => {
  const w = await afterBotEdit((x) => { x.timeline = [{ event: "cross-referenced", created_at: iso(NOW + 300_000), source: { issue: { number: 9, repository_url: "https://api.github.com/repos/acme/other" } } }] })
  assert.match(w.sent[0], /cross-reference from acme\/other#9/u)
})
await check("an external assignment wakes", async () => {
  const w = await afterBotEdit((x) => { x.events = [lifecycle("assigned", iso(NOW + 300_000), "ari", { assignee: { login: "dev" } })] })
  assert.match(w.sent[0], /assigned dev/u)
})
await check("an external unassignment wakes", async () => {
  const w = await afterBotEdit((x) => { x.events = [lifecycle("unassigned", iso(NOW + 300_000), "ari", { assignee: { login: "dev" } })] })
  assert.match(w.sent[0], /unassigned dev/u)
})
await check("an assignment made as the issue was opened is not news", async () => {
  const w = await afterBotEdit((x) => {
    x.issues[0] = { ...x.issues[0], created_at: iso(NOW + 299_000) }
    x.events = [lifecycle("assigned", iso(NOW + 300_000), "ari", { assignee: { login: "dev" } })]
  })
  assert.deepEqual(w.sent, [])
})
await check("the drain's own marked comment after a bot edit wakes nobody", async () => {
  const w = await afterBotEdit((x) => { x.comments = [{ id: 8, body: `Triaged.\n${DRAIN_STATUS_MARKER}`, updated_at: iso(NOW + 300_000), user: { login: "maintainer" } }] })
  assert.deepEqual(w.sent, [])
})
await check("a failing edit-history read is not a wake and not an auth/network wake", async () => {
  const w = await setup()
  await w.poll()
  w.change(NOW + 360_000, botEdit("n1", iso(NOW + 360_000)))
  w.api.editPage = async () => { throw Object.assign(new Error("Wait for the next poll: GitHub's edit history was not readable"), { code: "drains_graphql_failed" }) }
  const out = await w.poll(NOW + 360_000)
  assert.deepEqual(w.sent, [])
  assert.ok(out.errors.length >= 1)
})

console.log(JSON.stringify({ version, results }, null, 1))
