import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import * as path from "node:path"
import { mcpRoot } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const pageModule = require(path.join(mcpRoot, "scripts", "real-profile-page.cjs"))
const { createPageInitializer } = pageModule

function fixture() {
  const owner = "Desk owned page test"
  const events = []
  const tabs = new Map()
  const context = new EventEmitter()
  context.list = []
  context.pages = () => context.list.filter(p => !p.closed)
  context.waitForEvent = (name, options) => new Promise(resolve => {
    const listen = p => {
      if (options?.predicate && !options.predicate(p)) return
      context.removeListener(name, listen)
      resolve(p)
    }
    context.on(name, listen)
  })
  context.connectionOwner = owner
  context.connectionCount = 1
  context.markerValue = null
  context.creationDelta = 0
  let next = 100
  let initializer
  function page(url, id = ++next) {
    const p = new EventEmitter()
    p.context = () => context
    p.url = () => url
    p.isClosed = () => !!p.closed
    p.waitForURL = async (expected) => assert.equal(p.url(), expected)
    const tab = { id, index: context.list.length, windowId: 10, groupId: 20, active: false, title: "owned", url }
    const sandbox = { document: { title: "owned", body: { textContent: "" } } }
    sandbox.chrome = {
      tabs: {
        getCurrent: async () => ({ ...tab, id: tab.id + (url.includes("#desk-owner-control-") ? context.creationDelta : 0) }),
        get: async (id) => {
          if (context.getError) throw new Error(context.getError)
          if (context.removed && context.postRemoveError) throw new Error(context.postRemoveError)
          if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`)
          return { ...tabs.get(id).tab, groupId: context.cleanupGroupId ?? tabs.get(id).tab.groupId }
        },
        remove: async id => {
          events.push({ remove: id })
          if (context.keepRemovedAlive) return
          tabs.get(id).closed = true
          tabs.delete(id)
          context.removed = true
        },
        create: async (options) => {
          events.push({ create: options })
          if (context.concurrentPopup) {
            const popup = page("about:blank")
            context.emit("page", popup)
          }
          const created = page(options.url)
          created.tab.windowId = options.windowId
          created.tab.groupId = -1
          context.emit("page", created)
          created.initializing = initializer({ page: created })
          if (context.createFailsAfterAction) throw new Error("creation result lost")
          return { ...created.tab }
        },
        group: async ({ groupId, tabIds }) => { for (const id of tabIds) tabs.get(id).tab.groupId = groupId },
      },
      runtime: { sendMessage: async () => ({ connections: Array.from({ length: context.connectionCount }, (_, index) => ({ id: index + 1, clientName: context.connectionOwner, connectedTabIds: [...tabs.keys()] })) }) },
      debugger: { sendCommand: async ({ tabId }, method, params) => {
        events.push({ tabId, method, params })
        if (method === "Runtime.evaluate") return { result: { value: context.markerValue ?? runInNewContext(params.expression, tabs.get(tabId).sandbox) } }
        assert.equal(method, "Emulation.setFocusEmulationEnabled")
        return {}
      } },
    }
    p.evaluate = async (fn, arg) => {
      const code = fn.toString()
      const bindings = {}
      // Istanbul's closure is normally local to the Node module; keep its real
      // counters reachable when the same callback executes in our browser VM.
      for (const name of new Set(code.match(/\bcov_[A-Za-z0-9_]+(?=\()/gu) ?? [])) {
        bindings[name] = () => globalThis.__coverage__[path.join(mcpRoot, "scripts", "real-profile-page.cjs")]
      }
      return runInNewContext(`(${code})(arg)`, { ...sandbox, ...bindings, arg, globalThis: sandbox })
    }
    p.tab = tab
    p.sandbox = sandbox
    context.list.push(p)
    tabs.set(id, p)
    return p
  }
  initializer = createPageInitializer(owner)
  const root = page("chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html?mcpRelayUrl=own", 1)
  return { owner, root, context, events, page, initializer, tabs }
}

test("owned page preparation creates one inactive exact-window control page and focuses only the requesting renderer", async () => {
  const f = fixture()
  await f.initializer({ page: f.root })
  const created = f.events.find(e => e.create).create
  assert.equal(created.windowId, 10)
  assert.equal(created.active, false)
  assert.match(created.url, /^chrome-extension:\/\/mmlmfjhmonkocbjadbfplnigmagldckm\/connect.html#desk-owner-control-/u)
  const task = f.page("about:blank")
  await f.initializer({ page: task })
  const focus = f.events.filter(e => e.method === "Emulation.setFocusEmulationEnabled")
  assert.deepEqual(focus.map(e => e.tabId), [1, task.tab.id])
  assert.equal(f.events.filter(e => e.create).length, 1)
  assert.equal(Object.keys(task.sandbox).some(k => k.startsWith("__desk_owner_")), false)
  assert.equal(f.events.some(e => e.method === "Target.activateTarget" || e.method === "Page.bringToFront"), false)
})

test("concurrent owned pages share control initialization without selecting or focusing any window", async () => {
  const f = fixture()
  const preparing = f.initializer({ page: f.root })
  const a = f.page("about:blank")
  const b = f.page("about:blank")
  await Promise.all([preparing, f.initializer({ page: a }), f.initializer({ page: b })])
  assert.equal(f.events.filter(e => e.create).length, 1)
  assert.deepEqual(f.events.filter(e => e.method === "Emulation.setFocusEmulationEnabled").map(e => e.tabId).sort((a, b) => a - b), [1, a.tab.id, b.tab.id].sort((a, b) => a - b))
})

test("an unrelated own popup cannot steal the pending control-page event", async () => {
  const f = fixture()
  f.context.concurrentPopup = true
  await f.initializer({ page: f.root })
  assert.equal(f.events.filter(e => e.create).length, 1)
  assert.deepEqual(f.events.filter(e => e.method === "Emulation.setFocusEmulationEnabled").map(e => e.tabId), [1])
})

test("unowned bootstrap, missing identity, changed group, or a missing control page refuse renderer mutation", async () => {
  const f = fixture()
  await assert.rejects(createPageInitializer(null)({ page: f.root }), /browser_owner_identity_missing/u)
  await assert.rejects(createPageInitializer("")({ page: f.root }), /browser_owner_identity_missing/u)
  await assert.rejects(createPageInitializer(f.owner)({ page: f.page("https://example.test") }), /browser_owner_bridge_missing/u)
  await f.initializer({ page: f.root })
  const task = f.page("about:blank")
  task.tab.groupId = 99
  await assert.rejects(f.initializer({ page: task }), /browser_owner_target_mismatch/u)
  assert.equal(f.events.some(e => e.method === "Emulation.setFocusEmulationEnabled" && e.tabId === task.tab.id), false)
  const control = f.context.list.find(p => p.url().includes("#desk-owner-control-"))
  control.closed = true
  await assert.rejects(f.initializer({ page: f.page("about:blank") }), /browser_owner_control_missing/u)
})

test("an unsupported renderer command propagates the error and removes the target marker", async () => {
  const f = fixture()
  await f.initializer({ page: f.root })
  const task = f.page("about:blank")
  const control = f.context.list.find(p => p.url().includes("#desk-owner-control-"))
  const send = control.sandbox.chrome.debugger.sendCommand
  control.sandbox.chrome.debugger.sendCommand = async (...args) => {
    if (args[1] === "Emulation.setFocusEmulationEnabled") throw new Error("Not allowed")
    return send(...args)
  }
  await assert.rejects(f.initializer({ page: task }), /Not allowed/u)
  assert.equal(Object.keys(task.sandbox).some(k => k.startsWith("__desk_owner_")), false)
})

test("connection and control identity conflicts cannot initialize or focus a page", async () => {
  for (const change of [
    f => { f.context.connectionCount = 0 },
    f => { f.context.connectionCount = 2 },
    f => { f.context.connectionOwner = "foreign" },
    f => { f.root.tab.groupId = -1 },
    f => { f.context.creationDelta = 1 },
  ]) {
    const f = fixture()
    change(f)
    await assert.rejects(f.initializer({ page: f.root }), /browser_owner_(connection|control)_mismatch/u)
    assert.equal(f.events.some(e => e.method === "Emulation.setFocusEmulationEnabled"), false)
  }
})

test("marker ambiguity, target scope changes, or a removed owner refuse without redirecting", async () => {
  for (const change of [
    f => { f.context.markerValue = false },
    f => { f.context.markerValue = true },
    f => { f.context.connectionOwner = "foreign" },
    f => { f.context.connectionCount = 2 },
    (f, page) => { page.tab.windowId = 99 },
    (f, page) => { page.tab.groupId = 99 },
  ]) {
    const f = fixture()
    await f.initializer({ page: f.root })
    const p = f.page("about:blank")
    change(f, p)
    await assert.rejects(f.initializer({ page: p }), /browser_owner_(connection_mismatch|target_ambiguous|target_mismatch)/u)
    assert.equal(f.events.some(e => e.method === "Emulation.setFocusEmulationEnabled" && e.tabId === p.tab.id), false)
    assert.equal(Object.keys(p.sandbox).some(k => k.startsWith("__desk_owner_")), false)
  }
})

test("the control itself needs no renderer mutation and a closed context releases its initialization state", async () => {
  const f = fixture()
  await f.initializer({ page: f.root })
  const control = f.context.list.find(p => p.url().includes("#desk-owner-control-"))
  const before = f.events.length
  await f.initializer({ page: control })
  assert.equal(f.events.length, before)
  f.context.emit("close")
  await assert.rejects(f.initializer({ page: f.page("about:blank") }), /browser_owner_bridge_missing/u)
  await assert.rejects(pageModule.default({ page: f.root }), /browser_owner_identity_missing/u)
})

test("a page that closes during renderer preparation is not evaluated again", async () => {
  const f = fixture()
  await f.initializer({ page: f.root })
  const p = f.page("about:blank")
  const control = f.context.list.find(page => page.url().includes("#desk-owner-control-"))
  const send = control.sandbox.chrome.debugger.sendCommand
  control.sandbox.chrome.debugger.sendCommand = async (...args) => {
    if (args[1] === "Emulation.setFocusEmulationEnabled") {
      p.closed = true
      throw new Error("target closed")
    }
    return send(...args)
  }
  await assert.rejects(f.initializer({ page: p }), /target closed/u)
})

test("failed control initialization removes only its exact created tab before allowing a same-context retry", async () => {
  const f = fixture()
  f.context.creationDelta = 1
  await assert.rejects(f.initializer({ page: f.root }), /browser_owner_control_mismatch/u)
  assert.deepEqual(f.events.filter(e => e.remove).map(e => e.remove), [101])
  assert.equal(f.root.closed, undefined)
  f.context.creationDelta = 0
  await f.initializer({ page: f.root })
  assert.equal(f.events.filter(e => e.create).length, 2)
})

test("an unknown control-creation outcome is retained rather than replayed into a second tab", async () => {
  const f = fixture()
  f.context.createFailsAfterAction = true
  await assert.rejects(f.initializer({ page: f.root }), /creation result lost/u)
  await assert.rejects(f.initializer({ page: f.root }), /creation result lost/u)
  assert.equal(f.events.filter(e => e.create).length, 1)
  assert.equal(f.events.filter(e => e.remove).length, 0)
})

test("a navigated control page refuses later initialization rather than borrowing another extension page", async () => {
  const f = fixture()
  await f.initializer({ page: f.root })
  const control = f.context.list.find(p => p.url().includes("#desk-owner-control-"))
  control.url = () => "https://example.test"
  await assert.rejects(f.initializer({ page: f.page("about:blank") }), /browser_owner_control_missing/u)
  assert.equal(f.events.filter(e => e.create).length, 1)
})

test("permission failures during exact control cleanup retain the failed context without replay", async () => {
  const f = fixture()
  f.context.creationDelta = 1
  f.context.getError = "Not allowed"
  await assert.rejects(f.initializer({ page: f.root }), /browser_owner_control_cleanup_unverified/u)
  f.context.getError = null
  await assert.rejects(f.initializer({ page: f.root }), /browser_owner_control_cleanup_unverified/u)
  assert.equal(f.events.filter(e => e.create).length, 1)
  assert.equal(f.events.filter(e => e.remove).length, 0)
})

test("a control tab that remains after removal keeps initialization non-ready", async () => {
  const f = fixture()
  f.context.creationDelta = 1
  f.context.keepRemovedAlive = true
  await assert.rejects(f.initializer({ page: f.root }), /browser_owner_control_mismatch/u)
  await assert.rejects(f.initializer({ page: f.root }), /browser_owner_control_mismatch/u)
  assert.equal(f.events.filter(e => e.create).length, 1)
  assert.equal(f.events.filter(e => e.remove).length, 1)
})

test("already-absent control targets are not removed again and permit safe reinitialization", async () => {
  const f = fixture()
  f.context.creationDelta = 1
  f.context.getError = "No tab with id: 101"
  await assert.rejects(f.initializer({ page: f.root }), /browser_owner_control_mismatch/u)
  assert.equal(f.events.filter(e => e.remove).length, 0)
  f.context.creationDelta = 0
  f.context.getError = null
  await f.initializer({ page: f.root })
  assert.equal(f.events.filter(e => e.create).length, 2)
})

test("changed control ownership and unreadable post-removal state remain cleanup refusals", async () => {
  for (const change of [
    f => { f.context.cleanupGroupId = 99 },
    f => { f.context.postRemoveError = "Not allowed" },
  ]) {
    const f = fixture()
    f.context.creationDelta = 1
    change(f)
    await assert.rejects(f.initializer({ page: f.root }), /browser_owner_control_cleanup_unverified/u)
    await assert.rejects(f.initializer({ page: f.root }), /browser_owner_control_cleanup_unverified/u)
    assert.equal(f.events.filter(e => e.create).length, 1)
  }
})
