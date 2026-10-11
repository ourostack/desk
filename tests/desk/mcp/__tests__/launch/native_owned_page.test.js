import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { mcpRoot } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
test("current MCP default initializer export binds the supported frozen Page API", async t => {
  const module = require(path.join(mcpRoot, "scripts/native-owned-page.cjs"))
  const originalLease = process.env.DESK_NATIVE_LEASE_ID
  const originalOwner = process.env.DESK_BROWSER_OWNER
  process.env.DESK_NATIVE_LEASE_ID = "current-mcp-lease"
  process.env.DESK_BROWSER_OWNER = "current MCP owner"
  t.after(() => {
    if (originalLease === undefined) delete process.env.DESK_NATIVE_LEASE_ID
    else process.env.DESK_NATIVE_LEASE_ID = originalLease
    if (originalOwner === undefined) delete process.env.DESK_BROWSER_OWNER
    else process.env.DESK_BROWSER_OWNER = originalOwner
  })
  const context = {}
  const page = { context: () => context, evaluate: async () => "current-mcp-lease:101" }
  const { default: initializer } = module
  await initializer({ page })
  assert.equal(Object.isFrozen(page.deskBrowserOwner), true)
  assert.equal(typeof page.deskBrowserOwner.labelTask, "function")
  assert.equal(typeof page.deskBrowserOwner.peers, "function")
})
const file = path.join(mcpRoot, "scripts/native-owned-page.cjs")

test("native public page helper is frozen and owner-scoped without private Playwright access", async () => {
  const { createPageInitializer } = require(file)
  const calls = []
  const page = { evaluate: async () => "lease-a:101" }
  const initialize = createPageInitializer({
    leaseId: "lease-a", owner: "test-owner",
    request: async (operation, payload) => { calls.push({ operation, payload }); return { title: "Desk | test-owner | work" } },
  })
  await initialize({ page })
  assert.equal(Object.isFrozen(page.deskBrowserOwner), true)
  assert.equal(Object.getOwnPropertyDescriptor(page, "deskBrowserOwner").writable, false)
  await page.deskBrowserOwner.labelTask("work")
  assert.deepEqual(calls, [{ operation: "purpose", payload: { leaseId: "lease-a", owner: "test-owner", targetId: "lease-a:101", work: "work" } }])
  await initialize({ page })
  assert.equal(calls.length, 1)
})

test("native page helper refuses conflicting helper and foreign target", async () => {
  const { createPageInitializer } = require(file)
  const initialize = createPageInitializer({ leaseId: "lease-a", owner: "owner", request: async () => { throw new Error("must not dispatch") } })
  await assert.rejects(initialize({ page: { deskBrowserOwner: {}, evaluate: async () => "lease-a:101" } }), /browser_owner_page_api_conflict/u)
  await assert.rejects(initialize({ page: { evaluate: async () => "foreign-lease:101" } }), /browser_owner_target_mismatch/u)
})

test("native public purpose contract preserves null and refuses empty or overlong work", async () => {
  const { createPageInitializer } = require(file)
  const calls = []
  const page = { evaluate: async () => "lease-a:101" }
  await createPageInitializer({ leaseId: "lease-a", owner: "owner", request: async (operation, payload) => { calls.push({ operation, payload }); return {} } })({ page })
  for (const work of ["", " ", "a".repeat(161), "bad\nwork", 4]) await assert.rejects(page.deskBrowserOwner.labelTask(work), /browser_owner_work_invalid/u)
  await page.deskBrowserOwner.labelTask(null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.work, null)
})

test("native peer inspection is explicit and read-only with bounded formats", async () => {
  const { createPageInitializer } = require(file)
  const calls = []
  const page = { evaluate: async () => "lease-a:101" }
  await createPageInitializer({
    leaseId: "lease-a", owner: "owner",
    request: async (operation, payload) => { calls.push({ operation, payload }); return {} },
  })({ page })
  await page.deskBrowserOwner.peers()
  await page.deskBrowserOwner.peek({ leaseId: "lease-b", targetId: "lease-b:102", format: "snapshot" })
  assert.equal(calls[0].operation, "peers")
  assert.deepEqual(calls[1], { operation: "peek", payload: {
    leaseId: "lease-a", owner: "owner", peerLeaseId: "lease-b", targetId: "lease-b:102", format: "snapshot",
  } })
  await assert.rejects(page.deskBrowserOwner.peek({ leaseId: "lease-b", targetId: "lease-b:102", format: "evaluate" }), /browser_owner_peek_invalid/u)
})
