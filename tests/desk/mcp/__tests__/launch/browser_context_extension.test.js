import "../_isolated_env.mjs"
import { test, after } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"

const extensionUrl = new URL("../../../../../plugins/desk/browser-extension/context-engine.mjs", import.meta.url)
const helperUrl = new URL("../../../../../tools/browser-extension/extract.mjs", import.meta.url)
const A = "19a177bc-9821-4e9a-a71a-bd76cf590e61"
const B = "6c48a07f-139d-43e4-99cc-daf9c92eff6e"
const PROFILE = "a".repeat(64) // Synthetic credentials only.
const UPDATE = "b".repeat(64)
const SOURCE = "c".repeat(64)
const fixtureRoots = []
const endpoint = "ws://127.0.0.1:38123/extension/813bab60-ddcd-4bc9-858b-a1c2e9ddd92a"
const request = (method, contextId, params = {}, id = crypto.randomUUID()) =>
  ({ id, method, ...(contextId === undefined ? {} : { contextId }), params: { profileToken: PROFILE, sourceDigest: SOURCE, ...params } })
const create = (id = A, label = "worker · context kernel") => request("context.create", id, { label, relayUrl: endpoint })

function event() {
  const listeners = new Set()
  return {
    addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit: (...args) => { for (const fn of [...listeners]) fn(...args) },
    get size() { return listeners.size },
  }
}

// Chrome and WebSocket are the resource boundary. The maintained relay itself is
// real, including its asynchronous wire dispatcher and group behavior.
function fixture() {
  let nextTab = 10, nextGroup = 50
  const tabs = new Map([[1, { id: 1, windowId: 7, groupId: -1, active: true, url: "https://manual.invalid/" }]])
  const windows = new Map([[7, { id: 7, type: "normal", incognito: false, focused: false }]])
  const windowReads = []
  const groups = new Map()
  const sockets = []
  const effects = []
  const messages = []
  const hooks = {}
  const nativeCalls = [], nativePorts = []
  const debuggerBindings = new Map()
  let debuggerGeneration = 0
  const api = {
    tabs: {
      onCreated: event(), onRemoved: event(), onUpdated: event(), onDetached: event(),
      async get(id) { if (!tabs.has(id)) throw new Error("No tab"); return { ...tabs.get(id) } },
      async query(query) { return [...tabs.values()].filter(t => query.groupId === undefined || t.groupId === query.groupId).map(t => ({ ...t })) },
      async create(options) {
        effects.push(["create", options])
        await hooks.create?.()
        const tab = { id: nextTab++, groupId: -1, windowId: 7, active: false, ...options }
        tabs.set(tab.id, tab)
        api.tabs.onCreated.emit({ ...tab })
        return { ...tab }
      },
      async group({ groupId, tabIds, createProperties }) {
        if (hooks.group) await hooks.group()
        const windowId = groupId === undefined ? createProperties?.windowId ?? hooks.currentWindowId ?? 7 : groups.get(groupId)?.windowId
        if (windows.get(windowId)?.type !== "normal" ||
            tabIds.some(id => windows.get(tabs.get(id)?.windowId)?.type !== "normal"))
          throw new Error("Only normal windows support tab/group moves")
        const id = groupId ?? nextGroup++
        if (!groups.has(id)) groups.set(id, { id, windowId, title: "", color: "grey" })
        for (const tabId of tabIds) {
          if (tabs.get(tabId).windowId !== windowId) {
            const oldWindowId = tabs.get(tabId).windowId
            Object.assign(tabs.get(tabId), { windowId })
            api.tabs.onDetached.emit(tabId, { oldWindowId })
          }
          Object.assign(tabs.get(tabId), { groupId: id })
          api.tabs.onUpdated.emit(tabId, { groupId: id }, { ...tabs.get(tabId) })
        }
        effects.push(["group", id, [...tabIds]])
        return id
      },
      async remove(id) {
        await hooks.remove?.(id)
        if (!tabs.has(id)) throw new Error("No tab")
        const removed = tabs.get(id)
        tabs.delete(id)
        if (removed.groupId >= 0 && ![...tabs.values()].some(t => t.groupId === removed.groupId)) groups.delete(removed.groupId)
        if (debuggerBindings.delete(id)) api.debugger.onDetach.emit({ tabId: id }, "target_closed")
        effects.push(["remove", id])
        api.tabs.onRemoved.emit(id, { windowId: removed.windowId, isWindowClosing: false })
      },
      async update() { throw new Error("Physical activation/update is not allowed") },
      async ungroup() { throw new Error("Generic ungroup is not allowed") },
    },
    tabGroups: {
      async get(id) { if (!groups.has(id)) throw new Error("No group"); return { ...groups.get(id) } },
      async update(id, style) {
        Object.assign(groups.get(id), style)
        if (hooks.label) await hooks.label(groups.get(id))
        return { ...groups.get(id) }
      },
      async query() { throw new Error("Global title scan is not allowed") },
    },
    windows: {
      async getAll() { return [...windows.values()].map(w => ({ ...w })) },
      async get(id) {
        windowReads.push(id)
        await hooks.windowGet?.(id)
        if (!windows.has(id)) throw new Error("No window")
        return { ...windows.get(id) }
      },
      async update() { throw new Error("Physical focus is not allowed") },
      async create() { throw new Error("Window creation is not allowed") },
    },
    debugger: {
      onEvent: event(), onDetach: event(),
      async attach(target, version) {
        effects.push(["attach", target, version])
        await hooks.attach?.(target)
        debuggerBindings.set(target.tabId, { generation: ++debuggerGeneration, owner: "extension" })
      },
      async detach(target) {
        effects.push(["detach", target])
        await hooks.detach?.(target)
        debuggerBindings.delete(target.tabId)
        api.debugger.onDetach.emit(target, "canceled_by_user")
      },
      async sendCommand(target, method, params) {
        effects.push(["cdp", target, method, params])
        if (hooks.command) return hooks.command(target, method, params)
        return method === "Target.getTargetInfo" ? { targetInfo: { targetId: `target-${target.tabId}`, type: "page" } } : {}
      },
    },
    action: { async setBadgeText(params) { await hooks.badge?.(params) }, async setTitle() {}, async setBadgeBackgroundColor() {} },
    runtime: {
      id: "synthetic-owned-extension", onInstalled: event(), onStartup: event(),
      getURL: name => `chrome-extension://synthetic-owned-extension/${name}`,
      async getContexts() { return [{ documentUrl: api.runtime.getURL("token.html") }] },
      async sendMessage() { return { token: PROFILE } },
      connectNative(host) {
        assert.equal(host, "com.ourostack.desk.browser")
        nativeCalls.push(host)
        hooks.nativeConnect?.()
        const port = { onMessage: event(), onDisconnect: event(), postMessage: m => messages.push(m), disconnect() {} }
        nativePorts.push(port)
        api.port = port
        return port
      },
      reload() { effects.push(["reload"]) },
    },
    offscreen: { async createDocument() {} },
  }
  class Socket {
    static OPEN = 1
    readyState = 1
    sent = []
    constructor(url) { this.url = url; sockets.push(this); queueMicrotask(() => this.onopen?.()) }
    send(data) { this.sent.push(JSON.parse(data)) }
    close() { this.readyState = 3; this.onclose?.() }
    input(message) { this.onmessage({ data: JSON.stringify(message) }) }
    async command(method, params = []) {
      const id = crypto.randomUUID()
      this.input({ id, method, params })
      return eventually(() => this.sent.find(m => m.id === id))
    }
  }
  return { api, tabs, windows, windowReads, groups, sockets, effects, hooks, messages, Socket, debuggerBindings, nativeCalls, nativePorts }
}

const flush = () => new Promise(resolve => setImmediate(resolve))
function retryClock() {
  let now = 0, id = 0
  const tasks = new Map()
  return {
    setTimeout(fn, ms) { const key = ++id; tasks.set(key, { fn, at: now + ms }); return key },
    clearTimeout(key) { tasks.delete(key) },
    get pending() { return tasks.size },
    async advance(ms) {
      const end = now + ms
      for (let count = 0; ; ++count) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        assert.ok(count < 50, "retry scheduling must be bounded")
        now = next[1].at
        tasks.delete(next[0])
        next[1].fn()
        await flush()
      }
      now = end
      await flush()
    },
  }
}

async function eventually(read) {
  for (let i = 0; i < 100; ++i) {
    const value = read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail("Expected asynchronous relay disposition within fixture deadline")
}

async function admitOrdinary(engine, sourceDigest = SOURCE) {
  // Explicit ordinary UNKNOWN handoff at the native boundary; no constructor
  // bypass disables production admission for these existing custody scenarios.
  const transactionId = crypto.randomUUID(), challenge = "d".repeat(64)
  const captured = await engine.dispatch(request("transition.capture", undefined, { transactionId, challenge, sourceDigest }))
  assert.equal(captured.result?.admission, "held")
  const released = await engine.dispatch(request("transition.release", undefined, {
    transactionId, challenge, workerEpoch: captured.result.workerEpoch,
    witnessDigest: captured.result.witnessDigest, mode: "ordinary", sourceDigest,
  }))
  assert.equal(released.result?.released, true)
}
async function kernel(f = fixture(), options = {}) {
  const module = await import(extensionUrl)
  assert.equal(typeof module.createBrowserExtension, "function", "explicit context factory must exist")
  const engine = module.createBrowserExtension(f.api, { WebSocket: f.Socket, sourceDigest: SOURCE, ...options })
  await admitOrdinary(engine)
  return { ...f, engine }
}

// Break caught: missing-binding resume must not allocate replacement resources.
test("unknown resume fails without creating a replacement tab or group", async () => {
  const f = await kernel()
  const response = await f.engine.dispatch(request("context.resume", A))
  assert.equal(response.error?.code, "native_context_unavailable")
  assert.equal(f.tabs.size, 1)
  assert.equal(f.groups.size, 0)
})

// Break caught: invalid authority must fail before any browser effect.
test("context UUID and provider scope are discriminated before effects", async () => {
  const f = await kernel()
  for (const req of [
    create("worker"), create("default"), create(undefined, ""),
    request("profile.read", A), request("extension.reload", A, { updateToken: UPDATE }),
  ]) {
    const response = await f.engine.dispatch(req)
    assert.ok(response.error, "invalid request must be refused")
  }
  assert.deepEqual(f.effects, [])
})

// Break caught: an unsupported extraction must not silently vendor new code.
test("vendor extraction rejects unaudited regions before emitting runnable code", async () => {
  const helper = await import(helperUrl).catch(() => ({}))
  assert.equal(typeof helper.extract, "function", "audited vendor extraction must exist")
  assert.throws(() => helper.extract("//#region src/relayConnection.ts\nunsupported\n//#endregion\n"), /unsupported_vendor_source/)
})

// Break caught: copied vendor bytes or a transform drifting from its audited input.
test("audited extraction rebuilds the shipped executable and rejects a changed region", async () => {
  const { extract } = await import(helperUrl)
  const source = readFileSync(new URL("./upstream/background-0.4.mjs.txt", helperUrl), "utf8")
  const rebuilt = extract(source)
  assert.equal(rebuilt, readFileSync(new URL("./vendor/maintained.mjs", extensionUrl), "utf8"))
  assert.throws(() => extract(source.replace("this._ws = ws;", "this._ws = null;")), /unsupported_vendor_source/)
})

// Break caught: readiness before grouping, focus on first connect, or shared groups.
test("two contexts initialize actual maintained relays with distinct inactive named groups", async () => {
  const f = await kernel()
  const first = await f.engine.dispatch(create())
  assert.ok(first.result, JSON.stringify(first.error))
  const second = await f.engine.dispatch(create(B, "child · frame work"))
  assert.ok(second.result)
  assert.notEqual(first.result.groupId, second.result.groupId)
  assert.equal(f.groups.get(first.result.groupId).title, "worker · context kernel")
  assert.equal(f.groups.get(second.result.groupId).title, "child · frame work")
  assert.equal(f.tabs.get(1).active, true)
  assert.equal(f.tabs.size, 3)
  for (const [kind, options] of f.effects.filter(e => e[0] === "create")) {
    assert.equal(kind, "create")
    assert.deepEqual(options, { windowId: 7, url: "about:blank", active: false })
  }
  assert.deepEqual(f.sockets[0].sent.map(m => m.method), ["chrome.tabs.onCreated", "extension.initialized"])
  assert.equal(f.sockets[0].sent[0].params[0].groupId, first.result.groupId)
  assert.equal(f.sockets.length, 2)
})

test("invalid labels endpoints profile and source fail before allocation", async () => {
  const f = await kernel()
  for (const params of [
    { label: "" }, { label: " \n " }, { label: "x".repeat(121) }, { label: "bad\u0000label" },
    { relayUrl: "wss://remote.invalid/extension/a" }, { relayUrl: "ws://127.0.0.1:1234/not-relay" },
    { relayUrl: endpoint + "?token=synthetic" }, { relayUrl: endpoint.replace("127.0.0.1", "localhost") },
    { profileToken: "d".repeat(64) }, { sourceDigest: "d".repeat(64) },
  ]) {
    const req = create()
    Object.assign(req.params, params)
    assert.ok((await f.engine.dispatch(req)).error, "invalid creation must fail")
  }
  assert.equal(f.tabs.size, 1)
  assert.equal(f.sockets.length, 0)
})

test("duplicate handles are reserved before an asynchronous create settles", async () => {
  const f = await kernel()
  let finish
  f.hooks.create = () => new Promise(resolve => { finish = resolve })
  const pending = f.engine.dispatch(create())
  await eventually(() => finish)
  const duplicate = await f.engine.dispatch(create())
  assert.equal(duplicate.error?.code, "native_context_duplicate")
  finish()
  assert.ok((await pending).result)
  assert.equal(f.tabs.size, 2)
})

test("group or relay failure reports exact retained resources without deleting tabs", async () => {
  for (const failure of ["group", "readback", "relay"]) {
    const f = fixture()
    if (failure === "group") f.hooks.group = () => { throw new Error("synthetic failure") }
    if (failure === "readback") f.hooks.label = group => { group.title = "not confirmed" }
    const k = await kernel(f, failure === "relay" ? { openSocket: async () => { throw new Error(endpoint) } } : {})
    const response = await k.engine.dispatch(create())
    assert.ok(response.error)
    assert.deepEqual(response.error.resources.tabs.map(t => t.tabId), [10])
    assert.equal(k.tabs.has(10), true)
    assert.equal(k.effects.some(e => e[0] === "remove"), false)
    assert.equal(JSON.stringify(response).includes(endpoint), false)
    assert.equal((await k.engine.dispatch(request("context.status", A))).result.state, "unavailable")
    assert.ok((await k.engine.dispatch(request("context.resume", A))).error)
  }
})

test("maintained relay dispatch permits dependent commands in the same context concurrently", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  const socket = f.sockets[0]
  assert.ok((await socket.command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])).result)
  let resolveAwait
  f.hooks.command = async (target, method) => {
    if (method === "Runtime.evaluate") return new Promise(resolve => { resolveAwait = resolve })
    if (method === "Runtime.callFunctionOn") { resolveAwait({ result: { value: "resolved" } }); return { result: { value: "resolver" } } }
    return {}
  }
  const wait = socket.command("chrome.debugger.sendCommand", [{ tabId: 10 }, "Runtime.evaluate", { awaitPromise: true }])
  await eventually(() => resolveAwait)
  const resolve = await socket.command("chrome.debugger.sendCommand", [{ tabId: 10 }, "Runtime.callFunctionOn", {}])
  assert.equal(resolve.result.result.value, "resolver")
  assert.equal((await wait).result.result.value, "resolved")
})

test("relay creates inactive tabs and logical page selection never reaches physical activation", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  const socket = f.sockets[0]
  const child = await socket.command("chrome.tabs.create", [{ url: "https://task.invalid/", active: true, windowId: 99 }])
  assert.ok(child.result?.id)
  assert.equal(child.result.active, false)
  assert.equal(child.result.windowId, 7)
  assert.equal(child.result.groupId, f.tabs.get(10).groupId)
  await socket.command("chrome.debugger.attach", [{ tabId: child.result.id }, "1.3"])
  const selected = await socket.command("chrome.debugger.sendCommand", [{ tabId: child.result.id }, "Page.bringToFront", {}])
  assert.deepEqual(selected.result, {})
  const navigated = await socket.command("chrome.debugger.sendCommand", [{ tabId: child.result.id }, "Page.navigate", { url: "https://task.invalid/next" }])
  assert.ok(navigated.result)
  assert.equal(f.effects.some(e => e[0] === "cdp" && e[2] === "Page.bringToFront"), false)
  assert.equal(f.effects.some(e => e[0] === "cdp" && e[2] === "Page.navigate"), true)
  assert.equal(f.tabs.get(1).active, true)
})

test("foreign targets sessions and browser-global effects are refused by the real relay", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  const socket = f.sockets[0]
  await socket.command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  for (const [method, params] of [
    ["chrome.debugger.attach", [{ tabId: 1 }, "1.3"]],
    ["chrome.tabs.remove", [1]],
    ["chrome.debugger.sendCommand", [{ tabId: 1 }, "Runtime.evaluate", {}]],
    ["chrome.debugger.sendCommand", [{ targetId: "foreign" }, "Runtime.evaluate", {}]],
    ["chrome.debugger.sendCommand", [{ tabId: 10, sessionId: "foreign" }, "Runtime.evaluate", {}]],
    ...["Browser.close", "Storage.clearDataForOrigin", "Target.activateTarget", "Target.attachToTarget", "Network.clearBrowserCookies"]
      .map(method => ["chrome.debugger.sendCommand", [{ tabId: 10 }, method, {}]]),
  ]) assert.ok((await socket.command(method, params)).error, method)
  assert.equal(f.tabs.has(1), true)
  assert.equal(f.effects.some(e => e[0] === "cdp"), false)
  f.api.debugger.onEvent.emit({ tabId: 10 }, "Target.attachedToTarget", { sessionId: "owned-frame" })
  assert.ok((await socket.command("chrome.debugger.sendCommand", [{ tabId: 10, sessionId: "owned-frame" }, "Runtime.evaluate", {}])).result)
})

test("manual grouping never adopts foreign tabs and movement revokes current ownership", async () => {
  const f = await kernel()
  const made = await f.engine.dispatch(create())
  assert.ok(made.result)
  await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  const child = await f.sockets[0].command("chrome.tabs.create", [{ url: "about:blank" }])
  await f.sockets[0].command("chrome.debugger.attach", [{ tabId: child.result.id }, "1.3"])
  await f.api.tabs.group({ groupId: made.result.groupId, tabIds: [1] })
  assert.ok((await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 1 }, "1.3"])).error)
  await f.api.tabs.group({ tabIds: [10] })
  assert.ok((await f.sockets[0].command("chrome.tabs.remove", [10])).error)
  const discard = await f.engine.dispatch(request("context.discard", A))
  assert.deepEqual(discard.result?.releasedRevokedTabs, [{ tabId: 10, windowId: 7 }])
  assert.deepEqual(discard.result?.closedTabIds, [11])
  assert.equal(f.tabs.has(10), true)
  assert.equal(f.tabs.has(1), true)
})

test("ordinary disconnect and worker restart retain groups and never replace missing bindings", async () => {
  const f = await kernel()
  const made = await f.engine.dispatch(create())
  assert.ok(made.result)
  await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  f.sockets[0].close()
  const status = await f.engine.dispatch(request("context.status", A))
  assert.equal(status.result.state, "disconnected")
  assert.ok((await f.engine.dispatch(request("context.resume", A))).error)
  f.engine.stop()
  const restarted = await kernel(f)
  assert.equal((await restarted.engine.dispatch(request("context.resume", A))).error?.code, "native_context_unavailable")
  assert.equal(f.tabs.get(10).groupId, made.result.groupId)
  assert.equal(f.groups.get(made.result.groupId).title, "worker · context kernel")
  assert.equal(f.tabs.size, 2)
})

test("explicit discard confirms only exact current owned tabs and preserves peers", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  assert.ok((await f.engine.dispatch(create(B))).result)
  const receipt = await f.engine.dispatch(request("context.discard", A))
  assert.deepEqual(receipt.result, { contextId: A, discarded: true, closedTabIds: [10], absentTabIds: [10], releasedRevokedTabs: [] })
  assert.equal(f.tabs.has(10), false)
  assert.equal(f.tabs.has(11), true)
  assert.equal(f.tabs.has(1), true)
  assert.ok((await f.engine.dispatch(request("context.resume", B))).result)
})

test("partial discard retains exact cleanup obligations and never reports success", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  const child = await f.sockets[0].command("chrome.tabs.create", [{ url: "about:blank" }])
  assert.ok(child.result)
  f.hooks.remove = id => { if (id === 11) throw new Error("synthetic transport failure " + endpoint) }
  const response = await f.engine.dispatch(request("context.discard", A))
  assert.equal(response.error?.code, "native_discard_incomplete")
  assert.deepEqual(response.error.resources.closedTabIds, [10])
  assert.deepEqual(response.error.resources.remainingTabIds, [11])
  assert.equal(JSON.stringify(response).includes(endpoint), false)
  assert.equal(f.tabs.has(11), true)
})

test("transfer while discard awaits readback revokes close before the remove boundary", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  const get = f.api.tabs.get
  let transfer = true
  f.api.tabs.get = async id => {
    const tab = await get(id)
    if (id === 10 && transfer) {
      transfer = false
      await f.api.tabs.group({ tabIds: [10] })
    }
    return tab
  }
  const response = await f.engine.dispatch(request("context.discard", A))
  assert.ok(response.error)
  assert.equal(f.effects.some(e => e[0] === "remove"), false)
  assert.equal(f.tabs.has(10), true)
})

test("provider update requires every owner empty and matching prepared capability", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_update_effects_pending")
  assert.ok((await f.engine.dispatch(request("context.discard", A))).result)
  assert.ok((await f.engine.dispatch(request("extension.reload.commit", undefined, { updateToken: UPDATE }))).error)
  assert.ok((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).result)
  assert.equal((await f.engine.dispatch(create(B))).error?.code, "native_update_pending")
  assert.ok((await f.engine.dispatch(request("extension.reload.commit", undefined, { updateToken: "d".repeat(64) }))).error)
  const committed = await f.engine.dispatch(request("extension.reload.commit", undefined, { updateToken: UPDATE }))
  assert.equal(committed.result?.committing, true)
  assert.equal(f.effects.some(e => e[0] === "reload"), false, "native handler reloads only after posting commit receipt")
})

test("native ready and profile read preserve protocol and legacy leaseId is routing only", async () => {
  const f = await kernel()
  await f.engine.start()
  const ready = f.messages.find(m => m.event === "ready")
  assert.equal(ready.protocolVersion, 1)
  assert.equal(ready.extensionId, f.api.runtime.id)
  assert.equal(ready.sourceDigest, SOURCE)
  assert.equal(ready.profileToken, PROFILE)
  const read = await f.engine.dispatch({ id: "old-provider-read", method: "profile.read", leaseId: "profile-reader", params: {} })
  assert.equal(read.result?.profileToken, PROFILE)
  assert.equal(read.result?.extensionId, f.api.runtime.id)
  const invalid = request("extension.reload", undefined, { updateToken: UPDATE, profileToken: "d".repeat(64) })
  invalid.leaseId = "provider-update"
  assert.ok((await f.engine.dispatch(invalid)).error)
  f.engine.stop()
})

test("group readback finishes before a later page is advertised to the relay", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  let finish, newId
  const group = f.api.tabs.group
  f.api.tabs.group = async args => {
    const id = await group(args)
    await new Promise(resolve => { finish = resolve })
    return id
  }
  const pending = f.sockets[0].command("chrome.tabs.create", [{ url: "about:blank" }])
  await eventually(() => finish)
  newId = [...f.tabs.keys()].find(id => id > 10)
  assert.ok(newId)
  try {
    assert.equal(f.sockets[0].sent.some(m => m.method === "chrome.tabs.onCreated" && m.params[0].id === newId), false)
  } finally {
    finish()
    assert.ok((await pending).result)
  }
})

test("supported inactive owned-opener tabs are grouped before admission", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  const popup = await f.api.tabs.create({ windowId: 7, openerTabId: 10, url: "https://task.invalid/popup", active: false })
  await eventually(() => f.sockets[0].sent.find(m => m.method === "chrome.tabs.onCreated" && m.params[0].id === popup.id))
  assert.equal(f.tabs.get(popup.id).groupId, f.tabs.get(10).groupId)
});

// Break caught: a real app may activate its own opener child; dropping it makes
// target discovery silently incomplete even though the context still says ready.
test("active same-window owned-opener children are discovered and controlled without activation or peer adoption", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  assert.ok((await f.engine.dispatch(create(B, "peer"))).result)
  await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  const child = await f.api.tabs.create({ windowId: 7, openerTabId: 10, url: "https://other-origin.invalid/child", active: true })
  await eventually(() => f.sockets[0].sent.find(m => m.method === "chrome.tabs.onCreated" && m.params[0].id === child.id))
  assert.equal(f.tabs.get(child.id).active, true)
  assert.equal(f.tabs.get(child.id).groupId, f.tabs.get(10).groupId)
  assert.equal((await f.sockets[0].command("chrome.debugger.attach", [{ tabId: child.id }, "1.3"])).error, undefined)
  assert.equal((await f.sockets[1].command("chrome.debugger.attach", [{ tabId: child.id }, "1.3"])).error, "native_target_not_owned")
  const manual = await f.api.tabs.create({ windowId: 7, url: "https://manual.invalid/other", active: true })
  assert.equal((await f.sockets[0].command("chrome.debugger.attach", [{ tabId: manual.id }, "1.3"])).error, "native_target_not_owned")
  assert.equal(f.tabs.get(manual.id).groupId, -1)
  assert.equal((await f.engine.dispatch(request("context.status", B))).result.state, "ready")
})

// Break caught: an unsupported app-created window must be named continuity loss,
// not a ready parent-only view, an adopted foreign window or a replacement page.
test("unverified owned-opener child window retains the exact child and explicitly loses continuity without replacing pages", async () => {
  const f = await kernel()
  f.windows.set(9, { id: 9, type: "popup", incognito: false, focused: false })
  f.hooks.windowGet = async () => { throw new Error("Window readback unavailable") }
  assert.ok((await f.engine.dispatch(create())).result)
  assert.ok((await f.engine.dispatch(create(B, "peer"))).result)
  const child = await f.api.tabs.create({ windowId: 9, openerTabId: 10, url: "https://other-origin.invalid/window", active: true })
  await flush()
  const effects = f.effects.length
  const status = await f.engine.dispatch(request("context.status", A))
  assert.equal(status.result.state, "unavailable")
  assert.deepEqual(status.result.uncertainTabs, [{ tabId: child.id, windowId: 9 }])
  assert.equal((await f.engine.dispatch(request("context.resume", A))).error?.code, "native_context_unavailable")
  assert.equal((await f.engine.dispatch(request("context.discard", A))).error?.code, "native_cleanup_unconfirmed")
  assert.equal((await f.sockets[0].command("chrome.tabs.create", [{ url: "about:blank" }])).error, "native_context_unavailable")
  assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_update_effects_pending")
  assert.equal(f.effects.length, effects, "status/resume/refused cleanup creates no replacement or browser effect")
  assert.equal(f.tabs.get(child.id).groupId, -1)
  assert.equal(f.tabs.has(1), true)
  assert.equal((await f.engine.dispatch(request("context.status", B))).result.state, "ready")
})

// Break caught: the default/current window is not necessarily the selected
// anchor window; implicit grouping may move a tab and change its identity fence.
test("new anchor grouping explicitly targets its selected normal window rather than the focused peer window", async () => {
  const f = await kernel()
  f.windows.set(8, { id: 8, type: "normal", incognito: false, focused: true })
  f.hooks.currentWindowId = 8
  const created = await f.engine.dispatch(create())
  assert.equal(created.result?.state, "ready")
  assert.equal(f.tabs.get(10).windowId, 7)
  assert.equal(f.groups.get(created.result.groupId).windowId, 7)
  assert.equal(f.windows.get(8).focused, true)
})

for (const type of ["normal", "popup"]) test(`owned ${type} child-window target is read back and controlled in place without moving or regrouping it`, async () => {
  const f = await kernel()
  f.windows.set(9, { id: 9, type, incognito: false, focused: false })
  assert.ok((await f.engine.dispatch(create())).result)
  assert.ok((await f.engine.dispatch(create(B, "peer"))).result)
  await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  const child = await f.api.tabs.create({ windowId: 9, openerTabId: 10, url: "https://first-origin.invalid/child", active: true })
  await eventually(() => f.sockets[0].sent.find(m => m.method === "chrome.tabs.onCreated" && m.params[0].id === child.id))
  assert.ok(f.windowReads.includes(9), "window class must come from exact API readback")
  assert.equal(f.tabs.get(child.id).windowId, 9)
  assert.equal(f.tabs.get(child.id).groupId, -1)
  assert.equal((await f.sockets[0].command("chrome.debugger.attach", [{ tabId: child.id }, "1.3"])).error, undefined)
  await flush() // The actual maintained on-attach callback must not try illegal grouping.
  assert.equal((await f.engine.dispatch(request("context.status", A))).result.state, "ready")
  const target = await f.sockets[0].command("chrome.debugger.sendCommand", [{ tabId: child.id }, "Target.getTargetInfo"])
  f.hooks.command = async (address, method, params) => {
    if (method === "Page.navigate") {
      f.tabs.get(address.tabId).url = params.url
      f.api.tabs.onUpdated.emit(address.tabId, { url: params.url }, { ...f.tabs.get(address.tabId) })
      return { frameId: "owned-frame" }
    }
    return { targetInfo: { targetId: `target-${address.tabId}`, type: "page" } }
  }
  assert.equal((await f.sockets[0].command("chrome.debugger.sendCommand",
    [{ tabId: child.id }, "Page.navigate", { url: "https://second-origin.invalid/continued" }])).error, undefined)
  const after = await f.sockets[0].command("chrome.debugger.sendCommand", [{ tabId: child.id }, "Target.getTargetInfo"])
  assert.equal(after.result.targetInfo.targetId, target.result.targetInfo.targetId)
  assert.equal(f.tabs.get(child.id).url, "https://second-origin.invalid/continued")
  assert.equal(f.tabs.get(child.id).windowId, 9)
  assert.equal(f.tabs.get(child.id).groupId, -1)
  assert.equal(f.windows.get(9).focused, false)
  assert.equal((await f.sockets[1].command("chrome.debugger.attach", [{ tabId: child.id }, "1.3"])).error, "native_target_not_owned")
  await f.api.tabs.remove(10)
  const count = f.tabs.size
  assert.equal((await f.engine.dispatch(request("context.resume", A))).result.state, "ready")
  assert.equal((await f.engine.dispatch(request("context.label", A, { label: "continued child" }))).result.state, "ready")
  assert.equal(f.tabs.size, count, "closing the anchor never creates a replacement")
  assert.equal((await f.engine.dispatch(request("context.status", B))).result.state, "ready")
  assert.equal(f.tabs.has(1), true)
  const discarded = await f.engine.dispatch(request("context.discard", A))
  assert.deepEqual(discarded.result.closedTabIds, [child.id])
  assert.equal(f.tabs.has(child.id), false)
  assert.equal(f.tabs.has(1), true)
  assert.equal((await f.engine.dispatch(request("context.status", B))).result.state, "ready")
})

test("sequential actual relay commands preserve results and navigation failures are not swallowed", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  const socket = f.sockets[0]
  await socket.command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  let value = 0
  f.hooks.command = async () => ({ result: { value: ++value } })
  for (const expected of [1, 2, 3]) {
    const result = await socket.command("chrome.debugger.sendCommand", [{ tabId: 10 }, "Runtime.evaluate", {}])
    assert.equal(result.result.result.value, expected)
  }
  f.hooks.command = () => { throw new Error("navigation failure " + endpoint) }
  const failed = await socket.command("chrome.debugger.sendCommand", [{ tabId: 10 }, "Page.navigate", { url: "https://task.invalid/" }])
  assert.equal(failed.error, "native_browser_operation_failed")
  assert.equal(JSON.stringify(failed).includes(endpoint), false)
})

test("pending same-context CDP forbids discard and source reload without queuing its resolver", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  let finish
  f.hooks.command = () => new Promise(resolve => { finish = resolve })
  const pending = f.sockets[0].command("chrome.debugger.sendCommand", [{ tabId: 10 }, "Runtime.evaluate", { awaitPromise: true }])
  await eventually(() => finish)
  assert.equal((await f.engine.dispatch(request("context.discard", A))).error?.code, "native_context_busy")
  assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_update_effects_pending")
  finish({})
  assert.ok((await pending).result)
  assert.ok((await f.engine.dispatch(request("context.discard", A))).result)
})

test("create transport uncertainty remains a visible non-discardable cleanup obligation", async () => {
  const f = await kernel()
  f.hooks.create = () => { throw new Error("result lost " + endpoint) }
  const failed = await f.engine.dispatch(create())
  assert.equal(failed.error?.resources?.unconfirmedCreates, 1)
  const discard = await f.engine.dispatch(request("context.discard", A))
  assert.equal(discard.error?.code, "native_cleanup_unconfirmed")
  assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_update_effects_pending")
})

test("rename readback failure marks the retained binding unavailable", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  f.hooks.label = group => { group.title = "not confirmed" }
  const rename = await f.engine.dispatch(request("context.label", A, { label: "worker · new work" }))
  assert.ok(rename.error)
  assert.equal((await f.engine.dispatch(request("context.status", A))).result.state, "unavailable")
  assert.ok((await f.engine.dispatch(request("context.resume", A))).error)
})

test("transfer during Chrome remove is reported indeterminate, never an atomic-close claim", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  f.hooks.remove = async id => { await f.api.tabs.group({ tabIds: [id] }) }
  const discard = await f.engine.dispatch(request("context.discard", A))
  assert.equal(discard.error?.code, "native_context_ownership_changed")
  assert.equal(f.tabs.has(10), false, "Chrome cannot conditionally remove atomically; receipt must expose this race")
  assert.equal(discard.error.resources.revokedTabIds.includes(10), true)
})

test("native commit acknowledgment precedes reload and disconnect invalidates update capability", async () => {
  const f = await kernel()
  await f.engine.start()
  const prepared = await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))
  assert.ok(prepared.result)
  f.api.port.onDisconnect.emit()
  assert.ok((await f.engine.dispatch(request("extension.reload.commit", undefined, { updateToken: UPDATE }))).error)
  await f.engine.start()
  assert.ok((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).result)
  f.api.runtime.reload = () => {
    assert.equal(f.messages.at(-1).result.committing, true)
    f.effects.push(["reload"])
  }
  f.api.port.onMessage.emit(request("extension.reload.commit", undefined, { updateToken: UPDATE }))
  await eventually(() => f.effects.find(e => e[0] === "reload"))
  f.engine.stop()
})

test("profile reads reject explicitly crossed source binding without breaking bootstrap reads", async () => {
  const f = await kernel()
  assert.equal((await f.engine.dispatch(request("profile.read", undefined, { sourceDigest: "d".repeat(64) }))).error?.code, "native_source_mismatch")
  const read = await f.engine.dispatch({ id: "bootstrap", method: "profile.read", leaseId: "legacy-routing", params: {} })
  assert.equal(read.result?.profileToken, PROFILE)
})

test("token document keeps one-time profile binding and refuses corrupt existing storage", async () => {
  const module = await import(new URL("./token.mjs", extensionUrl)).catch(() => ({}))
  assert.equal(typeof module.readProfileToken, "function", "offscreen token boundary must be retained")
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const first = module.readProfileToken(storage, bytes => bytes.fill(10))
  assert.equal(first, "0a".repeat(32))
  assert.equal(module.readProfileToken(storage, () => { throw new Error("must not rotate") }), first)
  storage.setItem("deskBrowserProfileToken", "corrupt")
  assert.throws(() => module.readProfileToken(storage), /NATIVE_PROFILE_TOKEN_INVALID/)
})

test("stale native port cannot dispatch effects after disconnect or replacement", async () => {
  const f = await kernel()
  await f.engine.start()
  const old = f.api.port
  old.onDisconnect.emit()
  await f.engine.start()
  old.onMessage.emit(create())
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.tabs.size, 1)
  assert.ok((await f.engine.dispatch(create())).result)
  f.engine.stop()
})

test("malformed actual relay packets receive nonzero redacted error envelopes", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  const socket = f.sockets[0]
  for (const data of ["null", "[]", "false", '{"id":"malformed","method":3}', endpoint]) {
    const before = socket.sent.length
    socket.onmessage({ data })
    const response = await eventually(() => socket.sent.slice(before).find(m => m.error))
    assert.ok(response.error)
    assert.equal(JSON.stringify(response).includes(endpoint), false)
  }
})

test("normal distribution binds the new unpublished qualification publisher and executable bytes reproducibly", async () => {
  const root = new URL("./", extensionUrl)
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"))
  const publicHash = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
  assert.equal(publicHash.replace(/[0-9a-f]/gu, c => String.fromCharCode(97 + parseInt(c, 16))), "idfkhmkoaimndgacinjkjbagnnefgdel")
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.background.type, "module")
  assert.ok(manifest.permissions.includes("tabGroups"))
  const build = await import(new URL("./build.mjs", extensionUrl))
  const generated = await import(new URL("./source-digest.mjs", extensionUrl))
  assert.equal(build.computeSourceDigest(root), generated.SOURCE_DIGEST)
  const { verifyNativeDistribution } = await import("../../../../../plugins/desk/mcp/native-messaging-install.mjs")
  const verified = await verifyNativeDistribution(fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url)))
  assert.equal(verified.extensionId, "idfkhmkoaimndgacinjkjbagnnefgdel")
  assert.equal(verified.extensionSourceDigest, generated.SOURCE_DIGEST)
  const update = new URL(manifest.update_url)
  assert.equal(update.origin, "https://raw.githubusercontent.com")
  assert.match(update.pathname, /^\/ourostack\/desk\/browser-native-qualification-\d{8}\/artifacts\/browser-native\/updates\.xml$/u)
  const temp = await mkTempRoot("browser-context-integrity-")
  fixtureRoots.push(temp)
  console.log("owned kernel fixture root:", temp)
  for (const file of build.SOURCE_FILES) {
    mkdirSync(dirname(join(temp, file)), { recursive: true })
    writeFileSync(join(temp, file), readFileSync(new URL(file, root)), { flag: "w" })
  }
  assert.equal(build.computeSourceDigest(temp), generated.SOURCE_DIGEST)
  writeFileSync(join(temp, "context-engine.mjs"), "// altered executable")
  assert.notEqual(build.computeSourceDigest(temp), generated.SOURCE_DIGEST)
})

after(() => {
  for (const root of fixtureRoots) assert.equal(existsSync(root), false, `exact owned fixture must be disposed: ${root}`)
})

test("packaged service worker starts only the owned native bootstrap, not a browser connection page", async () => {
  const f = fixture()
  const previousChrome = globalThis.chrome
  const previousSocket = globalThis.WebSocket
  try {
    globalThis.chrome = f.api
    globalThis.WebSocket = f.Socket
    const background = await import(new URL(`./background.mjs?fixture=${crypto.randomUUID()}`, extensionUrl))
    const ready = await eventually(() => f.messages.find(m => m.event === "ready"))
    assert.equal(ready.protocolVersion, 1)
    assert.equal(ready.profileToken, PROFILE)
    assert.equal(ready.sourceDigest, (await import(new URL("./source-digest.mjs", extensionUrl))).SOURCE_DIGEST)
    assert.equal(f.effects.length, 0)
    assert.equal(f.sockets.length, 0)
    background.extension.stop()
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = previousChrome
    globalThis.WebSocket = previousSocket
  }
})

test("pending presentation effects also block discard and extension-wide update", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  let finish
  f.hooks.badge = params => params.text ? new Promise(resolve => { finish = resolve }) : undefined
  await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  await eventually(() => finish)
  assert.equal((await f.engine.dispatch(request("context.discard", A))).error?.code, "native_context_busy")
  finish()
  f.hooks.badge = undefined
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok((await f.engine.dispatch(request("context.discard", A))).result)
})

test("inactive creation is confirmed and mismatched returned identities stay explicit uncertain resources", async () => {
  for (const mutation of ["active", "window"]) {
    const f = fixture(), original = f.api.tabs.create
    f.api.tabs.create = async options => {
      const tab = await original(options)
      Object.assign(f.tabs.get(tab.id), mutation === "active" ? { active: true } : { windowId: 99 })
      return { ...f.tabs.get(tab.id) }
    }
    const k = await kernel(f)
    const result = await k.engine.dispatch(create())
    assert.ok(result.error, mutation + " must not acknowledge a background connection")
    const resources = result.error.resources
    assert.ok([...resources.tabs, ...resources.uncertainTabs].some(tab => tab.tabId === 10))
    assert.equal(f.tabs.has(10), true)
  }
})

test("closed relay at first connection is unavailable, not successful readiness", async () => {
  const f = fixture()
  const k = await kernel(f, { openSocket: async url => { const socket = new f.Socket(url); socket.close(); return socket } })
  const response = await k.engine.dispatch(create())
  assert.equal(response.error?.code, "native_relay_unavailable")
  assert.equal(f.tabs.has(10), true)
})

test("untrusted API exception codes cannot expose relay capabilities in either envelope", async () => {
  const f = await kernel()
  f.api.runtime.sendMessage = async () => { throw Object.assign(new Error(endpoint), { code: endpoint }) }
  const failed = await f.engine.dispatch(create())
  assert.equal(JSON.stringify(failed).includes(endpoint), false)
  assert.equal(failed.error?.code, "native_operation_failed")
  f.api.runtime.sendMessage = async () => ({ token: PROFILE })
  assert.ok((await f.engine.dispatch(create())).result)
  await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  f.hooks.command = () => { throw Object.assign(new Error(endpoint), { code: endpoint }) }
  const command = await f.sockets[0].command("chrome.debugger.sendCommand", [{ tabId: 10 }, "Runtime.evaluate", {}])
  assert.equal(JSON.stringify(command).includes(endpoint), false)
  assert.equal(command.error, "native_browser_operation_failed")
})

test("failed later-page grouping leaves its exact tab visible and makes resume unavailable", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  f.hooks.group = () => { throw new Error("synthetic group failure") }
  assert.ok((await f.sockets[0].command("chrome.tabs.create", [{ url: "about:blank" }])).error)
  const status = await f.engine.dispatch(request("context.status", A))
  assert.equal(status.result.state, "unavailable")
  assert.deepEqual(status.result.tabs.map(tab => tab.tabId), [10, 11])
  assert.ok((await f.engine.dispatch(request("context.resume", A))).error)
  assert.equal(f.tabs.has(11), true)
})

test("browser-wide tracing cannot be authorized by an owned target", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  const trace = await f.sockets[0].command("chrome.debugger.sendCommand", [{ tabId: 10 }, "Tracing.start", {}])
  assert.equal(trace.error, "native_cdp_method_denied")
  assert.equal(f.effects.some(effect => effect[0] === "cdp"), false)
})

test("terminal stop cannot restart a factory whose ownership event listeners were disposed", async () => {
  const f = await kernel()
  f.engine.stop()
  await assert.rejects(f.engine.start(), /native_extension_stopped/)
  const read = await f.engine.dispatch(request("profile.read"))
  assert.equal(read.error?.code, "native_extension_stopped")
})

test("transfer during label update cannot acknowledge a current binding", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  f.hooks.label = async () => { await f.api.tabs.group({ tabIds: [10] }) }
  const label = await f.engine.dispatch(request("context.label", A, { label: "worker · next task" }))
  assert.equal(label.error?.code, "native_context_ownership_changed")
  assert.equal(f.tabs.has(10), true)
})

test("signed-in creation never falls back to an incognito normal window", async () => {
  const f = await kernel()
  f.api.windows.getAll = async () => [{ id: 9, type: "normal", incognito: true }, { id: 7, type: "normal", incognito: false }]
  const response = await f.engine.dispatch(create())
  assert.ok(response.result)
  assert.equal(f.effects.find(effect => effect[0] === "create")[1].windowId, 7)
  const onlyPrivate = await kernel()
  onlyPrivate.api.windows.getAll = async () => [{ id: 9, type: "normal", incognito: true }]
  const refused = await onlyPrivate.engine.dispatch(create())
  assert.equal(refused.error?.code, "native_normal_window_unavailable")
  assert.deepEqual(onlyPrivate.effects, [])
})

// K-001: a completed foreign move after a failed group is not the Chrome
// conditional-remove race. No remove may even be invoked for that tab.
test("K001 failed grouping before effect cannot leave an ungrouped tab as wildcard ownership", async () => {
  const f = await kernel()
  f.hooks.group = () => { throw new Error("group rejected before effect") }
  assert.ok((await f.engine.dispatch(create())).error)
  f.hooks.group = undefined
  const peer = await f.engine.dispatch(create(B))
  assert.ok(peer.result)
  await f.api.tabs.group({ groupId: peer.result.groupId, tabIds: [10] })
  const status = await f.engine.dispatch(request("context.status", A))
  assert.deepEqual(status.result.revokedTabIds, [10])
  const discard = await f.engine.dispatch(request("context.discard", A))
  assert.ok(discard.error)
  assert.equal(f.tabs.has(10), true)
  assert.equal(f.tabs.has(11), true)
  assert.equal(f.effects.some(effect => effect[0] === "remove"), false)
})

test("K001 rejected grouping after effect retains non-discardable unknown custody even without event rediscovery", async () => {
  const f = fixture(), group = f.api.tabs.group
  f.api.tabs.group = async args => { await group(args); throw new Error("group result lost after effect") }
  const k = await kernel(f)
  assert.ok((await k.engine.dispatch(create())).error)
  const status = await k.engine.dispatch(request("context.status", A))
  assert.equal(status.result.groupingObligations?.[0]?.state, "unknown")
  assert.equal((await k.engine.dispatch(request("context.discard", A))).error?.code, "native_cleanup_unconfirmed")
  f.api.tabs.group = group
  const peer = await k.engine.dispatch(create(B))
  assert.ok(peer.result)
  await f.api.tabs.group({ groupId: peer.result.groupId, tabIds: [10] })
  assert.ok((await k.engine.dispatch(request("context.discard", A))).error)
  assert.equal(f.tabs.has(10), true)
  assert.equal(f.effects.some(effect => effect[0] === "remove"), false)
})

test("K001 failed membership readback never authorizes discard from a later successful query", async () => {
  const f = fixture(), get = f.api.tabs.get
  let grouped = false
  const group = f.api.tabs.group
  f.api.tabs.group = async args => { const id = await group(args); grouped = true; return id }
  f.api.tabs.get = async id => {
    if (id === 10 && grouped) throw new Error("readback unavailable")
    return get(id)
  }
  const k = await kernel(f)
  assert.ok((await k.engine.dispatch(create())).error)
  f.api.tabs.get = get
  assert.equal((await k.engine.dispatch(request("context.discard", A))).error?.code, "native_cleanup_unconfirmed")
  assert.equal((await k.engine.dispatch(request("context.status", A))).result.groupingObligations?.[0]?.state, "unknown")
  assert.equal(f.tabs.has(10), true)
  assert.equal(f.effects.some(effect => effect[0] === "remove"), false)
})

test("K002 late attach success after revocation detaches the exact fenced custody and preserves the peer", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  assert.ok((await f.engine.dispatch(create(B))).result)
  await f.sockets[1].command("chrome.debugger.attach", [{ tabId: 11 }, "1.3"])
  const peerGeneration = f.debuggerBindings.get(11).generation
  let finish
  f.hooks.attach = target => target.tabId === 10 ? new Promise(resolve => { finish = resolve }) : undefined
  const attaching = f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  await eventually(() => finish)
  await f.api.tabs.group({ tabIds: [10] })
  const pending = await f.engine.dispatch(request("context.status", A))
  assert.ok(pending.result.pendingEffects > 0)
  finish()
  assert.ok((await attaching).error)
  assert.equal(f.debuggerBindings.has(10), false, "late successful physical attach must not be leaked")
  assert.equal(f.debuggerBindings.get(11).generation, peerGeneration)
  assert.deepEqual(f.effects.filter(effect => effect[0] === "detach").map(effect => effect[1].tabId), [10])
  assert.equal((await f.engine.dispatch(request("context.status", A))).result.debuggerCustody?.length, 0)
})

test("K002 late attach rejection remains a named unknown obligation and fences cooperative admission", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  let finish
  f.hooks.attach = () => new Promise((resolve, reject) => { finish = () => reject(new Error("attach result unknown")) })
  const attaching = f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  await eventually(() => finish)
  await f.api.tabs.group({ tabIds: [10] })
  finish()
  assert.ok((await attaching).error)
  const status = await f.engine.dispatch(request("context.status", A))
  assert.equal(status.result.debuggerCustody?.[0]?.state, "unknown")
  assert.equal(status.result.debuggerCustody?.[0]?.reason, "native_debugger_attach_unconfirmed")
  // A Chrome-identity replay/returned existing identity is not a new admitted
  // resource. Exercise the real factory's common admission fence, not a fake
  // test-only handoff API.
  f.api.tabs.create = async () => ({ ...f.tabs.get(10) })
  const attemptedPeer = await f.engine.dispatch(create(B))
  assert.ok(attemptedPeer.error)
  assert.equal(f.effects.filter(effect => effect[0] === "attach").length, 1)
  assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_update_effects_pending")
})

test("K002 failed detach after late attach stays explicit and blocks discard and reload", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  let finish
  f.hooks.attach = () => new Promise(resolve => { finish = resolve })
  f.hooks.detach = () => { throw new Error("detach result unknown") }
  const attaching = f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  await eventually(() => finish)
  await f.api.tabs.group({ tabIds: [10] })
  finish()
  assert.ok((await attaching).error)
  assert.equal(f.debuggerBindings.has(10), true)
  const status = await f.engine.dispatch(request("context.status", A))
  assert.equal(status.result.debuggerCustody?.[0]?.state, "unknown")
  assert.equal(status.result.debuggerCustody?.[0]?.reason, "native_debugger_detach_unconfirmed")
  assert.ok((await f.engine.dispatch(request("context.discard", A))).error)
  assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_update_effects_pending")
  assert.equal(f.effects.some(effect => effect[0] === "remove"), false)
})

test("K002 observed debugger generation boundary forbids a blind late detach of a new peer", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  let finish
  f.api.debugger.attach = async target => {
    f.debuggerBindings.set(target.tabId, { owner: "old-extension", generation: 100 })
    await new Promise(resolve => { finish = resolve })
  }
  const attaching = f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  await eventually(() => finish)
  await f.api.tabs.group({ tabIds: [10] })
  f.api.debugger.onDetach.emit({ tabId: 10 }, "replaced_with_devtools")
  f.debuggerBindings.set(10, { owner: "external-peer", generation: 101 })
  finish()
  assert.ok((await attaching).error)
  assert.deepEqual(f.debuggerBindings.get(10), { owner: "external-peer", generation: 101 })
  assert.equal(f.effects.some(effect => effect[0] === "detach"), false)
  const status = await f.engine.dispatch(request("context.status", A))
  assert.equal(status.result.debuggerCustody?.[0]?.state, "unknown")
  assert.equal(status.result.debuggerCustody?.[0]?.reason, "native_debugger_generation_unconfirmed")
})

test("K002 pending detach keeps its admission fence and update barrier until settlement", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  let attachDone, detachDone
  f.hooks.attach = () => new Promise(resolve => { attachDone = resolve })
  f.hooks.detach = () => new Promise(resolve => { detachDone = resolve })
  const attaching = f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  await eventually(() => attachDone)
  await f.api.tabs.group({ tabIds: [10] })
  attachDone()
  try {
    await eventually(() => detachDone)
    const status = await f.engine.dispatch(request("context.status", A))
    assert.equal(status.result.debuggerCustody?.[0]?.state, "detaching")
    assert.ok(status.result.pendingEffects > 0)
    f.api.tabs.create = async () => ({ ...f.tabs.get(10) })
    assert.ok((await f.engine.dispatch(create(B))).error)
    assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_update_effects_pending")
  } finally {
    detachDone?.()
    await attaching
  }
  assert.equal(f.debuggerBindings.has(10), false)
})

test("K002 terminal stop also compensates a late successful attach without retaining command authority", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  let finish
  f.hooks.attach = () => new Promise(resolve => { finish = resolve })
  f.sockets[0].input({ id: "attach-before-stop", method: "chrome.debugger.attach", params: [{ tabId: 10 }, "1.3"] })
  await eventually(() => finish)
  // Observe the physical resource and request outcome directly: the closed
  // stock socket cannot deliver an acknowledgment after stop.
  f.engine.stop()
  finish()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.debuggerBindings.has(10), false)
})

test("K002 unknown custody cannot appear quiescent after the last task tab disappears", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  f.hooks.attach = () => { throw new Error("attach outcome unconfirmed") }
  assert.ok((await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])).error)
  await f.api.tabs.remove(10)
  const status = await f.engine.dispatch(request("context.status", A))
  assert.deepEqual(status.result.tabs, [])
  assert.deepEqual(status.result.revokedTabIds, [])
  assert.equal(status.result.pendingEffects, 0)
  assert.equal(status.result.debuggerCustody[0].state, "unknown")
  assert.equal((await f.engine.dispatch(request("context.discard", A))).error?.code, "native_debugger_cleanup_unconfirmed")
  assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_update_effects_pending")
})

test("K002 completed revocation between ownership await and attach invocation prevents the attach", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  const get = f.api.tabs.get
  let moved = false
  f.api.tabs.get = async id => {
    const tab = await get(id)
    if (id === 10 && !moved) {
      moved = true
      queueMicrotask(() => queueMicrotask(() => { void f.api.tabs.group({ tabIds: [10] }) }))
    }
    return tab
  }
  const attaching = await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  assert.ok(attaching.error)
  assert.equal(f.effects.some(effect => effect[0] === "attach"), false)
})

test("K002stop completed replacement after stop cannot be detached by a late successful attach", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  let finish
  f.api.debugger.attach = async target => {
    f.debuggerBindings.set(target.tabId, { owner: "old-extension", generation: 100 })
    await new Promise(resolve => { finish = resolve })
  }
  f.sockets[0].input({ id: "held-attach", method: "chrome.debugger.attach", params: [{ tabId: 10 }, "1.3"] })
  await eventually(() => finish)
  f.engine.stop()
  f.api.debugger.onDetach.emit({ tabId: 10 }, "replaced_with_devtools")
  f.debuggerBindings.set(10, { owner: "replacement", generation: 101 })
  finish()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.debuggerBindings.get(10), { owner: "replacement", generation: 101 })
  assert.equal(f.effects.some(effect => effect[0] === "detach"), false)
  assert.equal(f.api.debugger.onDetach.size, 0, "retire the custody observer after effect settlement")
  const stopped = await f.engine.dispatch(request("context.status", A))
  assert.equal(stopped.error.code, "native_extension_stopped")
  assert.ok(stopped.error.resources, "stopped status must retain a cleanup projection, not imply no obligations")
  assert.equal(stopped.error.resources.pendingEffects, 0)
  assert.equal(stopped.error.resources.debuggerObservationActive, false)
  assert.equal(stopped.error.resources.debuggerCustody[0].state, "unknown")
  assert.equal(stopped.error.resources.debuggerCustody[0].reason, "native_debugger_generation_unconfirmed")
  assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_extension_stopped")
  assert.equal(f.effects.some(effect => effect[0] === "reload"), false)
})

test("K002stop retains observer for known own compensation and retires it after settlement", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  let finish, detachDone
  f.hooks.detach = () => new Promise(resolve => { detachDone = resolve })
  f.api.debugger.attach = async target => {
    f.debuggerBindings.set(target.tabId, { owner: "old-extension", generation: 100 })
    await new Promise(resolve => { finish = resolve })
  }
  f.sockets[0].input({ id: "known-held-attach", method: "chrome.debugger.attach", params: [{ tabId: 10 }, "1.3"] })
  await eventually(() => finish)
  f.engine.stop()
  try {
    assert.equal(f.api.debugger.onDetach.size, 1, "only custody-critical observation survives stop")
    assert.equal(f.api.tabs.onCreated.size, 0, "ordinary resource listeners retire immediately")
    const pending = await f.engine.dispatch(request("context.status", A))
    assert.ok(pending.error.resources, "stopped status must expose pending cleanup without authorizing commands")
    assert.ok(pending.error.resources.pendingEffects > 0)
    assert.equal(pending.error.resources.debuggerObservationActive, true)
    finish()
    await eventually(() => detachDone)
    assert.equal(f.api.debugger.onDetach.size, 1, "detach response must also settle before observer retirement")
    const detaching = await f.engine.dispatch(request("context.status", A))
    assert.equal(detaching.error.resources.debuggerCustody[0].state, "detaching")
  } finally {
    finish()
    await new Promise(resolve => setImmediate(resolve))
    detachDone?.()
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(f.debuggerBindings.has(10), false)
  assert.deepEqual(f.effects.filter(effect => effect[0] === "detach").map(effect => effect[1].tabId), [10])
  assert.equal(f.api.debugger.onDetach.size, 0)
  const settled = await f.engine.dispatch(request("context.status", A))
  assert.equal(settled.error.resources.pendingEffects, 0)
  assert.deepEqual(settled.error.resources.debuggerCustody, [])
})

test("K002stop rejected attach retains unknown custody without claiming quiescence", async () => {
  for (const replacement of [false, true]) {
    const f = await kernel()
    assert.ok((await f.engine.dispatch(create())).result)
    let rejectAttach
    f.api.debugger.attach = async target => {
      f.debuggerBindings.set(target.tabId, { owner: "old-extension", generation: 100 })
      await new Promise((resolve, reject) => { rejectAttach = reject })
    }
    f.sockets[0].input({ id: "rejected-held-attach", method: "chrome.debugger.attach", params: [{ tabId: 10 }, "1.3"] })
    await eventually(() => rejectAttach)
    f.engine.stop()
    if (replacement) {
      f.api.debugger.onDetach.emit({ tabId: 10 }, "replaced_with_devtools")
      f.debuggerBindings.set(10, { owner: "replacement", generation: 101 })
    }
    rejectAttach(new Error("attach disposition unconfirmed"))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.effects.some(effect => effect[0] === "detach"), false)
    assert.equal(f.debuggerBindings.get(10).generation, replacement ? 101 : 100)
    const stopped = await f.engine.dispatch(request("context.status", A))
    assert.equal(stopped.error.code, "native_extension_stopped")
    assert.ok(stopped.error.resources, "a rejected late attach must remain a visible cleanup obligation")
    assert.equal(stopped.error.resources.pendingEffects, 0)
    assert.equal(stopped.error.resources.debuggerCustody[0].state, "unknown")
    assert.equal(stopped.error.resources.debuggerCustody[0].reason,
      replacement ? "native_debugger_generation_unconfirmed" : "native_debugger_attach_unconfirmed")
    assert.equal(stopped.error.resources.debuggerObservationActive, false)
    assert.equal(f.api.debugger.onDetach.size, 0)
    assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_extension_stopped")
  }
})

test("K002stop without pending effects retires its observer immediately and remains terminal", async () => {
  const f = await kernel()
  f.engine.stop()
  assert.equal(f.api.debugger.onDetach.size, 0)
  f.engine.stop()
  assert.equal(f.api.debugger.onDetach.size, 0)
  await assert.rejects(f.engine.start(), /native_extension_stopped/)
})

// Amendment A: exercise the actual old/new automatic entry, not a mocked
// lifecycle controller. Moving timer time never opens a native host/browser.
test("producer A automatic native reconnect preserves the existing tab group and relay through two losses", async () => {
  const f = fixture(), clock = retryClock()
  const saved = { chrome: globalThis.chrome, WebSocket: globalThis.WebSocket, setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout, error: console.error }
  let background
  try {
    globalThis.chrome = f.api
    globalThis.WebSocket = f.Socket
    globalThis.setTimeout = (...args) => clock.setTimeout(...args)
    globalThis.clearTimeout = key => clock.clearTimeout(key)
    console.error = () => {}
    background = await import(new URL(`./background.mjs?retry-fixture=${crypto.randomUUID()}`, extensionUrl))
    await flush()
    await clock.advance(0)
    assert.equal(f.nativePorts.length, 1)
    const digest = (await import(new URL("./source-digest.mjs", extensionUrl))).SOURCE_DIGEST
    await admitOrdinary(background.extension, digest)
    const req = create()
    req.params.sourceDigest = digest
    const made = await background.extension.dispatch(req)
    assert.ok(made.result)
    for (const expected of [2, 3]) {
      f.api.port.onDisconnect.emit()
      await clock.advance(0)
      assert.equal(f.nativePorts.length, expected, "native loss must trigger an automatic retry burst")
      const status = await background.extension.dispatch({ ...request("context.status", A), params: { profileToken: PROFILE, sourceDigest: digest } })
      assert.equal(status.result.groupId, made.result.groupId)
      assert.deepEqual(status.result.tabs, [{ tabId: 10, windowId: 7 }])
      assert.equal(f.sockets.length, 1)
      assert.equal(f.tabs.size, 2)
    }
    assert.equal(clock.pending, 0)
  } finally {
    background?.extension.stop()
    globalThis.chrome = saved.chrome
    globalThis.WebSocket = saved.WebSocket
    globalThis.setTimeout = saved.setTimeout
    globalThis.clearTimeout = saved.clearTimeout
    console.error = saved.error
  }
})

test("producer A known manual transfer is released not absent and discard closes only remaining current tabs", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  assert.ok((await f.sockets[0].command("chrome.tabs.create", [{ url: "about:blank" }])).result)
  const peer = await f.engine.dispatch(create(B))
  assert.ok(peer.result)
  await f.api.tabs.group({ groupId: peer.result.groupId, tabIds: [10] })
  const status = await f.engine.dispatch(request("context.status", A))
  assert.deepEqual(status.result.releasedRevokedTabs, [{ tabId: 10, windowId: 7 }])
  assert.deepEqual(status.result.unknownRevokedTabs, [])
  assert.ok((await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])).error)
  const discarded = await f.engine.dispatch(request("context.discard", A))
  assert.deepEqual(discarded.result, {
    contextId: A, discarded: true, closedTabIds: [11], absentTabIds: [11],
    releasedRevokedTabs: [{ tabId: 10, windowId: 7 }],
  })
  assert.equal(f.tabs.has(10), true)
  assert.equal(f.tabs.has(12), true)
  assert.equal(f.tabs.has(1), true)
  assert.ok((await f.engine.dispatch(request("context.resume", B))).result)
  assert.ok((await f.engine.dispatch(request("context.discard", B))).result)
  assert.ok((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).result)
  assert.equal(f.tabs.has(10), true, "local quiescence is not physical absence of released peer tabs")
})

async function backgroundKernel(f = fixture()) {
  const clock = retryClock(), statuses = []
  const module = await import(new URL("./background.mjs", extensionUrl))
  assert.equal(typeof module.createBackground, "function", "background lifecycle must expose its injected resource seam")
  const engine = module.createBackground(f.api, {
    sourceDigest: SOURCE, WebSocket: f.Socket, timers: clock, onStatus: code => statuses.push(code),
  })
  return { ...f, clock, statuses, engine }
}

test("producer A retry exhaustion is bounded per burst and overlapping wake events coalesce", async () => {
  const f = fixture()
  f.hooks.nativeConnect = () => { throw new Error("synthetic native failure") }
  const b = await backgroundKernel(f)
  try {
    b.api.runtime.onInstalled.emit()
    b.api.runtime.onStartup.emit()
    await b.clock.advance(100000)
    assert.equal(b.nativeCalls.length, 3)
    assert.equal(b.statuses.filter(code => code === "native_host_unavailable").length, 1)
    assert.equal(b.clock.pending, 0)
    await b.clock.advance(100000)
    assert.equal(b.nativeCalls.length, 3, "exhaustion must not install an indefinite watchdog")
    b.api.runtime.onStartup.emit()
    b.api.runtime.onStartup.emit()
    b.api.runtime.onInstalled.emit()
    await b.clock.advance(100000)
    assert.equal(b.nativeCalls.length, 6, "a later ordinary event may start one new bounded burst")
    assert.equal(b.statuses.filter(code => code === "native_host_unavailable").length, 2)
    assert.equal(b.tabs.size, 1)
    assert.equal(b.sockets.length, 0)
  } finally { b.engine.stop() }
  b.api.runtime.onStartup.emit()
  await b.clock.advance(100000)
  assert.equal(b.nativeCalls.length, 6)
  assert.equal(b.clock.pending, 0)
})

test("producer A retry deadline remains single-flight across exhaustion and a later event", async () => {
  const f = fixture()
  let finish, reads = 0
  f.api.runtime.sendMessage = () => {
    ++reads
    return new Promise(resolve => { finish = () => resolve({ token: PROFILE }) })
  }
  const b = await backgroundKernel(f)
  try {
    await b.clock.advance(0)
    assert.equal(reads, 1)
    b.api.runtime.onStartup.emit()
    b.api.runtime.onInstalled.emit()
    await b.clock.advance(5000)
    assert.equal(b.statuses.filter(code => code === "native_host_unavailable").length, 1)
    assert.equal(reads, 1)
    b.api.runtime.onStartup.emit()
    await b.clock.advance(0)
    assert.equal(reads, 1, "a new burst must not overlap an unresolved earlier start")
    finish()
    await flush()
    assert.equal(b.nativeCalls.length, 1)
    assert.equal(b.clock.pending, 0)
    assert.equal(b.tabs.size, 1)
  } finally { b.engine.stop(); finish?.(); await flush() }
})

test("producer A terminal stop cancels a queued retry and a held native start", async () => {
  for (const held of [false, true]) {
    const f = fixture()
    let finish
    if (held) f.api.runtime.sendMessage = () => new Promise(resolve => { finish = () => resolve({ token: PROFILE }) })
    else f.hooks.nativeConnect = () => { throw new Error("synthetic failure") }
    const b = await backgroundKernel(f)
    await b.clock.advance(0)
    b.engine.stop()
    finish?.()
    await flush()
    const calls = b.nativeCalls.length
    b.api.runtime.onStartup.emit()
    b.api.runtime.onInstalled.emit()
    await b.clock.advance(100000)
    assert.equal(b.nativeCalls.length, calls)
    assert.equal(b.clock.pending, 0)
    assert.equal(b.api.runtime.onStartup.size, 0)
    await assert.rejects(b.engine.start(), /native_extension_stopped/)
  }
})

test("producer A failed ready publication retries without treating a stale native port as connected", async () => {
  const f = fixture(), connect = f.api.runtime.connectNative
  f.api.runtime.connectNative = host => {
    const port = connect(host)
    if (f.nativeCalls.length === 1) port.postMessage = () => { throw new Error(endpoint) }
    return port
  }
  const b = await backgroundKernel(f)
  try {
    await b.clock.advance(2000)
    assert.equal(b.nativeCalls.length, 2)
    assert.equal(b.messages.filter(message => message.event === "ready").length, 1)
    assert.equal(b.clock.pending, 0)
    b.nativePorts[0].onDisconnect.emit()
    await b.clock.advance(100000)
    assert.equal(b.nativeCalls.length, 2)
    assert.equal(JSON.stringify(b.statuses).includes(endpoint), false)
  } finally { b.engine.stop() }
})

test("producer A relay loss is retained unavailable and never invokes native retry or page replacement", async () => {
  const b = await backgroundKernel()
  try {
    await b.clock.advance(0)
    await admitOrdinary(b.engine)
    const made = await b.engine.dispatch(create())
    assert.ok(made.result)
    b.sockets[0].close()
    await b.clock.advance(100000)
    assert.equal(b.nativeCalls.length, 1)
    assert.equal((await b.engine.dispatch(request("context.status", A))).result.state, "disconnected")
    assert.ok((await b.engine.dispatch(request("context.resume", A))).error)
    assert.equal(b.tabs.get(10).groupId, made.result.groupId)
    assert.equal(b.tabs.size, 2)
    assert.equal(b.sockets.length, 1)
  } finally { b.engine.stop() }
})

test("producer A pending exact detach stays unknown and retains transport until affirmative release", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  let finish
  f.hooks.detach = () => new Promise(resolve => { finish = resolve })
  await f.api.tabs.group({ tabIds: [10] })
  await eventually(() => finish)
  try {
    const status = await f.engine.dispatch(request("context.status", A))
    assert.deepEqual(status.result.releasedRevokedTabs, [])
    assert.deepEqual(status.result.unknownRevokedTabs, [{ tabId: 10, windowId: 7 }])
    assert.equal(f.sockets[0].readyState, 1, "own transport must not retire before detach settles")
    assert.ok((await f.engine.dispatch(request("context.discard", A))).error)
  } finally { finish(); await flush() }
  const status = await f.engine.dispatch(request("context.status", A))
  assert.deepEqual(status.result.releasedRevokedTabs, [{ tabId: 10, windowId: 7 }])
  assert.deepEqual(status.result.debuggerCustody, [])
  const receipt = await f.engine.dispatch(request("context.discard", A))
  assert.deepEqual(receipt.result, {
    contextId: A, discarded: true, closedTabIds: [], absentTabIds: [],
    releasedRevokedTabs: [{ tabId: 10, windowId: 7 }],
  })
  assert.equal(f.tabs.has(10), true)
  assert.ok((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).result)
})

test("producer A unknown grouping and debugger generations never receive release amnesty", async () => {
  for (const failure of ["group", "attach", "detach", "generation"]) {
    const f = await kernel()
    if (failure === "group") f.hooks.group = () => { throw new Error("unknown grouping effect") }
    const made = await f.engine.dispatch(create())
    if (failure === "group") assert.ok(made.error)
    else {
      assert.ok(made.result)
      if (failure === "attach") f.hooks.attach = () => { throw new Error("unknown attach effect") }
      await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
      if (failure === "detach") f.hooks.detach = () => { throw new Error("unknown detach effect") }
      if (failure === "generation") {
        // Existing reviewed pending-generation fixture covers replacement101;
        // stop additionally must not turn its retained task tabs into released peers.
        f.engine.stop()
        const stopped = await f.engine.dispatch(request("context.status", A))
        assert.deepEqual(stopped.error.resources.releasedRevokedTabs, [])
        continue
      }
    }
    f.hooks.group = undefined
    await f.api.tabs.group({ tabIds: [10] })
    await flush()
    const status = await f.engine.dispatch(request("context.status", A))
    assert.deepEqual(status.result.releasedRevokedTabs, [])
    assert.deepEqual(status.result.unknownRevokedTabs, [{ tabId: 10, windowId: 7 }])
    assert.equal(f.sockets[0].readyState, 1, "unknown custody must not trigger automatic relay retirement")
    assert.ok((await f.engine.dispatch(request("context.discard", A))).error)
    assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_update_effects_pending")
    assert.equal(f.tabs.has(10), true)
  }
})

test("producer A unknown command or close effects block release and empty-map update", async () => {
  for (const operation of ["command", "close"]) {
    const f = await kernel()
    assert.ok((await f.engine.dispatch(create())).result)
    if (operation === "command") {
      await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
      const child = await f.sockets[0].command("chrome.tabs.create", [{ url: "about:blank" }])
      await f.sockets[0].command("chrome.debugger.attach", [{ tabId: child.result.id }, "1.3"])
      f.hooks.command = async () => {
        await f.api.tabs.group({ tabIds: [10] })
        throw new Error("command outcome unknown")
      }
      assert.ok((await f.sockets[0].command("chrome.debugger.sendCommand", [{ tabId: 10 }, "Runtime.evaluate", {}])).error)
    } else {
      const remove = f.api.tabs.remove
      f.api.tabs.remove = async id => { await remove(id); throw new Error("close response lost") }
      assert.ok((await f.engine.dispatch(request("context.discard", A))).error)
    }
    const status = await f.engine.dispatch(request("context.status", A))
    assert.equal(status.result.pendingEffects, 0)
    assert.deepEqual(status.result.releasedRevokedTabs, [])
    assert.equal(status.result.effectObligations?.[0]?.state, "unknown")
    assert.ok((await f.engine.dispatch(request("context.discard", A))).error)
    assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_update_effects_pending")
  }
})

test("producer A local update accepts an affirmatively released revocation without inferring peer absence", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  await f.api.tabs.group({ tabIds: [10] })
  const status = await f.engine.dispatch(request("context.status", A))
  assert.deepEqual(status.result.releasedRevokedTabs, [{ tabId: 10, windowId: 7 }])
  assert.deepEqual(status.result.tabs, [])
  const update = await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))
  assert.deepEqual(update.result, { reload: true })
  assert.equal(f.tabs.has(10), true)
  assert.equal(f.effects.some(effect => effect[0] === "remove"), false)
  const receipt = await f.engine.dispatch(request("context.discard", A))
  assert.deepEqual(receipt.result.releasedRevokedTabs, [{ tabId: 10, windowId: 7 }])
  assert.deepEqual(receipt.result.absentTabIds, [])
})

test("producer A an unknown create prevents release after all current tabs and pending counts disappear", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  let failCreate
  f.hooks.create = () => new Promise((resolve, reject) => { failCreate = () => reject(new Error("unknown create")) })
  const creating = f.sockets[0].command("chrome.tabs.create", [{ url: "about:blank" }])
  await eventually(() => failCreate)
  await f.api.tabs.group({ tabIds: [10] })
  failCreate()
  assert.ok((await creating).error)
  const status = await f.engine.dispatch(request("context.status", A))
  assert.deepEqual(status.result.tabs, [])
  assert.equal(status.result.pendingEffects, 0)
  assert.equal(status.result.unconfirmedCreates, 1)
  assert.deepEqual(status.result.releasedRevokedTabs, [])
  assert.deepEqual(status.result.unknownRevokedTabs, [{ tabId: 10, windowId: 7 }])
  assert.ok((await f.engine.dispatch(request("context.discard", A))).error)
  assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_update_effects_pending")
})

test("producer A unsettled opener admission is a named obligation even after all known tabs disappear", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  const get = f.api.tabs.get
  f.api.tabs.get = async id => { if (id === 10) throw new Error("opener readback unknown"); return get(id) }
  const child = await f.api.tabs.create({ openerTabId: 10, windowId: 7, active: false, url: "https://task.invalid/child" })
  await flush()
  await f.api.tabs.remove(10)
  await f.api.tabs.remove(child.id)
  assert.equal((await f.engine.dispatch(request("extension.reload", undefined, { updateToken: UPDATE }))).error?.code, "native_update_effects_pending")
  const status = await f.engine.dispatch(request("context.status", A))
  assert.deepEqual(status.result.tabs, [])
  assert.equal(status.result.pendingEffects, 0)
  assert.deepEqual(status.result.admittingTabIds, [11])
  assert.equal((await f.engine.dispatch(request("context.discard", A))).error?.code, "native_cleanup_unconfirmed")
})

test("producer A asynchronously failed native ports consume one bounded budget rather than restarting forever", async () => {
  const b = await backgroundKernel()
  try {
    await b.clock.advance(0)
    for (let failed = 0; failed < 3; ++failed) {
      b.api.port.onMessage.emit({ event: "diagnostic", code: "synthetic-provider-refusal" })
      await flush()
      b.api.runtime.lastError = { message: endpoint } // Synthetic; must never be logged.
      b.api.port.onDisconnect.emit()
      delete b.api.runtime.lastError
      await b.clock.advance(100000)
    }
    assert.equal(b.nativeCalls.length, 3, "a posted ready frame is not proof an asynchronously failing host started")
    assert.equal(b.statuses.filter(code => code === "native_host_unavailable").length, 1)
    assert.equal(b.clock.pending, 0)
    assert.equal(JSON.stringify(b.statuses).includes(endpoint), false)
    b.api.runtime.onStartup.emit()
    await b.clock.advance(0)
    assert.equal(b.nativeCalls.length, 4)
    b.api.port.onMessage.emit(request("profile.read"))
    await flush()
    b.api.runtime.lastError = { message: "synthetic host exit after real native traffic" }
    b.api.port.onDisconnect.emit()
    delete b.api.runtime.lastError
    await b.clock.advance(0)
    assert.equal(b.nativeCalls.length, 5, "confirmed native traffic permits a fresh failure burst")
  } finally { b.engine.stop() }
})
