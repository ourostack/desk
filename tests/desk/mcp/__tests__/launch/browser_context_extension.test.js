import "../_isolated_env.mjs"
import { test, after } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
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
  const groups = new Map()
  const sockets = []
  const effects = []
  const messages = []
  const hooks = {}
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
      async group({ groupId, tabIds }) {
        if (hooks.group) await hooks.group()
        const id = groupId ?? nextGroup++
        if (!groups.has(id)) groups.set(id, { id, windowId: 7, title: "", color: "grey" })
        for (const tabId of tabIds) {
          Object.assign(tabs.get(tabId), { groupId: id })
          api.tabs.onUpdated.emit(tabId, { groupId: id }, { ...tabs.get(tabId) })
        }
        effects.push(["group", id, [...tabIds]])
        return id
      },
      async remove(id) {
        await hooks.remove?.(id)
        if (!tabs.has(id)) throw new Error("No tab")
        tabs.delete(id)
        effects.push(["remove", id])
        api.tabs.onRemoved.emit(id, { windowId: 7, isWindowClosing: false })
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
      async getAll() { return [{ id: 7, type: "normal" }] },
      async update() { throw new Error("Physical focus is not allowed") },
      async create() { throw new Error("Window creation is not allowed") },
    },
    debugger: {
      onEvent: event(), onDetach: event(),
      async attach(target, version) { effects.push(["attach", target, version]); await hooks.attach?.(target) },
      async detach(target) { effects.push(["detach", target]); api.debugger.onDetach.emit(target, "canceled_by_user") },
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
        const port = { onMessage: event(), onDisconnect: event(), postMessage: m => messages.push(m), disconnect() {} }
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
  return { api, tabs, groups, sockets, effects, hooks, messages, Socket }
}

async function eventually(read) {
  for (let i = 0; i < 100; ++i) {
    const value = read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail("Expected asynchronous relay disposition within fixture deadline")
}

async function kernel(f = fixture(), options = {}) {
  const module = await import(extensionUrl)
  assert.equal(typeof module.createBrowserExtension, "function", "explicit context factory must exist")
  return { ...f, engine: module.createBrowserExtension(f.api, { WebSocket: f.Socket, sourceDigest: "c".repeat(64), ...options }) }
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
  assert.equal(discard.error?.code, "native_context_ownership_changed")
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
  assert.deepEqual(receipt.result, { contextId: A, discarded: true, closedTabIds: [10], absentTabIds: [10] })
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

test("supported inactive owned-opener tabs are grouped before admission; active/manual tabs are not adopted", async () => {
  const f = await kernel()
  assert.ok((await f.engine.dispatch(create())).result)
  await f.sockets[0].command("chrome.debugger.attach", [{ tabId: 10 }, "1.3"])
  const popup = await f.api.tabs.create({ windowId: 7, openerTabId: 10, url: "https://task.invalid/popup", active: false })
  await eventually(() => f.sockets[0].sent.find(m => m.method === "chrome.tabs.onCreated" && m.params[0].id === popup.id))
  assert.equal(f.tabs.get(popup.id).groupId, f.tabs.get(10).groupId)
  const active = await f.api.tabs.create({ windowId: 7, openerTabId: 10, url: "https://task.invalid/user-popup", active: true })
  assert.ok((await f.sockets[0].command("chrome.debugger.attach", [{ tabId: active.id }, "1.3"])).error)
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

test("distribution keeps enrolled identity and executable bytes attest reproducibly", async () => {
  const root = new URL("./", extensionUrl)
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"))
  const publicHash = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
  assert.equal(publicHash.replace(/[0-9a-f]/gu, c => String.fromCharCode(97 + parseInt(c, 16))), "bcejpajaingepdloiolbmbaflecgifbe")
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.background.type, "module")
  assert.ok(manifest.permissions.includes("tabGroups"))
  const build = await import(new URL("./build.mjs", extensionUrl))
  const generated = await import(new URL("./source-digest.mjs", extensionUrl))
  assert.equal(build.computeSourceDigest(root), generated.SOURCE_DIGEST)
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
