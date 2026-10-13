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
  const context = { newPage: async () => { throw new Error("not requested") } }
  const page = { context: () => context, evaluate: async () => "current-mcp-lease:101" }
  const { default: initializer } = module
  await initializer({ page })
  assert.equal(Object.isFrozen(page.deskBrowserOwner), true)
  assert.equal(typeof page.deskBrowserOwner.labelTask, "function")
  assert.equal(typeof page.deskBrowserOwner.peers, "function")
})
const file = path.join(mcpRoot, "scripts/native-owned-page.cjs")

test("owned newPage waits for one shared initializer before returning a navigable Page", async () => {
  const { createPageInitializer } = require(file)
  let resolveProof
  const proof = new Promise(resolve => { resolveProof = resolve })
  let reads = 0
  const child = { evaluate: async () => { reads++; return proof } }
  const context = { newPage: async () => child }
  const page = { evaluate: async () => "lease-a:101", context: () => context }
  const initialize = createPageInitializer({ leaseId: "lease-a", owner: "owner", request: async () => ({}) })
  await initialize({ page })
  assert.equal(typeof page.deskBrowserOwner.newPage, "function")
  let returned = false
  const creating = page.deskBrowserOwner.newPage().then(value => { returned = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  const concurrent = initialize({ page: child })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(returned, false)
  assert.equal(reads, 1, "MCP and explicit creation share the same proof operation")
  resolveProof("lease-a:102")
  assert.equal(await creating, child)
  await concurrent
  assert.equal(Object.isFrozen(child.deskBrowserOwner), true)
})

test("raw owned context newPage also waits for the shared proof before handing off", async () => {
  const { createPageInitializer } = require(file)
  let resolveProof
  const proof = new Promise(resolve => { resolveProof = resolve })
  const child = { evaluate: async () => proof }
  const options = { viewport: { width: 800, height: 600 } }
  let received, receiver
  const context = { async newPage(value) { receiver = this; received = value; return child } }
  const page = { evaluate: async () => "lease-a:101", context: () => context }
  const initialize = createPageInitializer({ leaseId: "lease-a", owner: "owner", request: async () => ({}) })
  await initialize({ page })
  let handedOff = false
  const operation = context.newPage(options).then(value => { handedOff = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(handedOff, false)
  resolveProof("lease-a:102")
  assert.equal(await operation, child)
  assert.equal(receiver, context)
  assert.equal(received, options)
  assert.equal(Object.isFrozen(child.deskBrowserOwner), true)
})

test("owned context refuses an incompatible newPage method before renderer proof", async () => {
  const { createPageInitializer } = require(file)
  const context = {}
  Object.defineProperty(context, "newPage", { value: async () => {}, configurable: false })
  let reads = 0
  const page = { context: () => context, evaluate: async () => { reads++; return "lease-a:101" } }
  const initialize = createPageInitializer({ leaseId: "lease-a", owner: "owner", request: async () => ({}) })
  await assert.rejects(async () => initialize({ page }), /browser_owner_new_page_api_conflict/u)
  assert.equal(reads, 0)
})

test("owned newPage propagates foreign target and initialization errors without replay", async () => {
  const { createPageInitializer } = require(file)
  let child = { evaluate: async () => "foreign:102" }, creates = 0
  const context = {
    newPage: async () => { creates++; return child },
  }
  const page = { evaluate: async () => "lease-a:101", context: () => context }
  await createPageInitializer({ leaseId: "lease-a", owner: "owner", request: async () => ({}) })({ page })
  await assert.rejects(page.deskBrowserOwner.newPage(), /browser_owner_target_mismatch/u)
  child = { evaluate: async () => { throw new Error("exact-proof-failed") } }
  await assert.rejects(page.deskBrowserOwner.newPage(), /exact-proof-failed/u)
  assert.equal(creates, 2)
})

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

test("a page that is too busy to prove ownership never fails the browser call and retries later", async t => {
  const module = require(path.join(mcpRoot, "scripts/native-owned-page.cjs"))
  const saved = [process.env.DESK_NATIVE_LEASE_ID, process.env.DESK_BROWSER_OWNER]
  process.env.DESK_NATIVE_LEASE_ID = "busy-lease"
  process.env.DESK_BROWSER_OWNER = "busy owner"
  t.after(() => {
    for (const [key, value] of [["DESK_NATIVE_LEASE_ID", saved[0]], ["DESK_BROWSER_OWNER", saved[1]]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const context = { newPage: async () => { throw new Error("not requested") } }
  let busy = true
  const page = { context: () => context, evaluate: async () => { if (busy) throw new Error("Execution context was destroyed"); return "busy-lease:7" } }
  await module.default({ page })
  assert.equal(page.deskBrowserOwner, undefined)
  busy = false
  await module.default({ page })
  assert.equal(Object.isFrozen(page.deskBrowserOwner), true)
})

test("a failed ownership proof is retried on the next call instead of cached", async () => {
  const { createPageInitializer } = require(file)
  let fail = true
  const page = { evaluate: async () => { if (fail) throw new Error("navigating"); return "lease-a:101" } }
  const initialize = createPageInitializer({ leaseId: "lease-a", owner: "owner", request: async () => ({}) })
  await assert.rejects(initialize({ page }), /navigating/u)
  fail = false
  await initialize({ page })
  assert.equal(Object.isFrozen(page.deskBrowserOwner), true)
})
