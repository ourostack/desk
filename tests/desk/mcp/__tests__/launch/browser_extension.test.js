import test from "node:test"
import assert from "node:assert/strict"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"
import path from "node:path"

const extensionUrl = new URL("../../../../../plugins/desk/browser-extension/background.js", import.meta.url)
const token = "a".repeat(64)
const extensionId = "bcejpajaingepdloiolbmbaflecgifbe"

function event() {
  const listeners = new Set()
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args) } }
}

function fixture() {
  let next = 1
  const calls = []
  const tabs = new Map()
  const windows = new Map()
  const sent = []
  const port = { onMessage: event(), onDisconnect: event(), postMessage: value => sent.push(value), disconnect() { this.onDisconnect.emit() } }
  let contexts = []
  const chrome = {
    runtime: {
      id: extensionId,
      onStartup: event(), onInstalled: event(), onMessage: event(),
      getURL: file => `chrome-extension://${extensionId}/${file}`,
      getContexts: async () => contexts,
      sendMessage: async () => ({ token }),
      connectNative: name => { calls.push({ method: "connectNative", params: name }); return port },
      lastError: undefined,
    },
    offscreen: { createDocument: async params => {
      calls.push({ method: "offscreen.createDocument", params })
      contexts = [{ documentUrl: chrome.runtime.getURL("token.html") }]
    } },
    windows: {
      create: async params => {
        calls.push({ method: "windows.create", params })
        const id = next++
        const tab = { id: next++, windowId: id, active: true, url: params.url, title: "" }
        tabs.set(tab.id, tab)
        const value = { id, focused: params.focused, tabs: [tab] }
        windows.set(id, value)
        return value
      },
    },
    tabs: {
      onCreated: event(), onRemoved: event(),
      create: async params => {
        calls.push({ method: "tabs.create", params })
        if (!windows.has(params.windowId)) throw new Error("unknown window")
        const tab = { ...params, id: next++, title: "page" }
        tabs.set(tab.id, tab)
        return tab
      },
      get: async id => {
        const value = tabs.get(id)
        if (!value) throw new Error("No tab with id")
        return { ...value }
      },
      update: async (id, params) => {
        calls.push({ method: "tabs.update", params: { id, ...params } })
        const tab = await chrome.tabs.get(id)
        Object.assign(tab, params)
        if (params.url?.includes("/control.html#")) {
          const { owner, work } = JSON.parse(decodeURIComponent(params.url.split("#")[1]))
          tab.title = `Desk | ${owner}${work === null ? "" : ` | ${work}`}`
        }
        tabs.set(id, tab)
        return tab
      },
      remove: async id => {
        calls.push({ method: "tabs.remove", params: id })
        if (!tabs.delete(id)) throw new Error("No tab with id")
        chrome.tabs.onRemoved.emit(id, {})
      },
    },
    debugger: {
      onEvent: event(), onDetach: event(),
      getTargets: async () => [...tabs.values()].map(tab => ({ id: `target-${tab.id}`, tabId: tab.id, type: "page", url: tab.url, title: tab.title })),
      attach: async (target, version) => calls.push({ method: "debugger.attach", params: { target, version } }),
      detach: async target => calls.push({ method: "debugger.detach", params: target }),
      sendCommand: async (target, method, params) => {
        calls.push({ method: "debugger.sendCommand", params: { target, method, params } })
        return { value: "ok" }
      },
    },
  }
  return { chrome, calls, tabs, windows, sent, port }
}

async function setup() {
  const { createBrowserExtension } = await import(extensionUrl)
  const fake = fixture()
  const extension = createBrowserExtension(fake.chrome)
  const bound = await extension.dispatch({
    id: "bind", leaseId: "lease-a", method: "lease.bind",
    params: { profileToken: token, owner: "test-owner", work: "test-work", transportGeneration: "host-a" },
  })
  assert.equal(bound.error, undefined)
  return { ...fake, extension }
}

async function create(extension, id = "create", leaseId = "lease-a") {
  return extension.dispatch({ id, leaseId, method: "target.create", params: { marker: `marker-${id}` } })
}

test("first owner window is unfocused with selected control and background task pages", async () => {
  const { extension, calls, tabs } = await setup()
  const first = await create(extension)
  assert.equal(first.error, undefined)
  const later = await create(extension, "later")
  assert.equal(later.error, undefined)
  const window = calls.find(call => call.method === "windows.create").params
  assert.equal(window.focused, false)
  const taskCalls = calls.filter(call => call.method === "tabs.create")
  assert.equal(taskCalls.length, 2)
  assert.equal(taskCalls[0].params.windowId, first.result.windowId)
  assert.equal(taskCalls[1].params.windowId, first.result.windowId)
  assert.equal(taskCalls.every(call => call.params.active === false), true)
  assert.equal(tabs.get(first.result.controlTabId).active, true)
  assert.equal(tabs.get(first.result.controlTabId).title, "Desk | test-owner | test-work")
  assert.equal(calls.some(call => call.params.focused === true || call.params.active === true), false)
})

test("purpose clearing keeps owner label and never selects a tab", async () => {
  const { extension, tabs } = await setup()
  const first = await create(extension)
  const changed = await extension.dispatch({ id: "purpose", leaseId: "lease-a", method: "purpose.set", params: { work: null } })
  assert.equal(changed.result.title, "Desk | test-owner")
  assert.equal(tabs.get(first.result.controlTabId).active, true)
})

for (const profileToken of [undefined, "", "b".repeat(64)]) {
  test("missing or wrong profile binding refuses before creating any window", async () => {
    const { createBrowserExtension } = await import(extensionUrl)
    const { chrome, calls } = fixture()
    const extension = createBrowserExtension(chrome)
    const result = await extension.dispatch({
      id: "bind", leaseId: "lease-a", method: "lease.bind",
      params: { profileToken, owner: "owner", work: null, transportGeneration: "generation" },
    })
    assert.equal(result.error.code, "NATIVE_PROFILE_MISMATCH")
    assert.equal(calls.some(call => call.method === "windows.create"), false)
  })
}

for (const method of ["chrome.windows.update", "__proto__", "constructor", "no.such.method"]) {
  test("unsupported dispatch is denied without Chrome API access", async () => {
    const { createBrowserExtension } = await import(extensionUrl)
    const { chrome, calls } = fixture()
    const extension = createBrowserExtension(chrome)
    const result = await extension.dispatch({ id: "forbidden", leaseId: "lease-a", method, params: { focused: true } })
    assert.equal(result.error.code, "NATIVE_METHOD_DENIED")
    assert.equal(calls.length, 0)
  })
}

test("foreign lease cannot attach or close another owner's tab", async () => {
  const { extension, calls } = await setup()
  const first = await create(extension)
  await extension.dispatch({ id: "bind-b", leaseId: "lease-b", method: "lease.bind", params: { profileToken: token, owner: "other-owner", work: null, transportGeneration: "host-a" } })
  const count = calls.length
  for (const method of ["target.attach", "target.close", "target.command"]) {
    const result = await extension.dispatch({ id: method, leaseId: "lease-b", method, params: { tabId: first.result.tabId, method: "Runtime.evaluate", params: {} } })
    assert.equal(result.error.code, "NATIVE_TARGET_NOT_OWNED")
  }
  assert.equal(calls.length, count)
})

test("tab moved out of recorded window cannot receive input or cleanup", async () => {
  const { extension, tabs, calls } = await setup()
  const first = await create(extension)
  tabs.get(first.result.tabId).windowId = 999
  const count = calls.length
  const result = await extension.dispatch({ id: "input", leaseId: "lease-a", method: "target.command", params: { tabId: first.result.tabId, method: "Input.dispatchMouseEvent", params: {} } })
  assert.equal(result.error.code, "NATIVE_WINDOW_MISMATCH")
  assert.equal(calls.length, count)
})

test("native startup uses normal native messaging and one serialized hidden token document", async () => {
  const { createBrowserExtension } = await import(extensionUrl)
  const { chrome, calls, sent } = fixture()
  const extension = createBrowserExtension(chrome)
  await Promise.all([extension.ensureTokenDocument(), extension.ensureTokenDocument()])
  assert.equal(calls.filter(call => call.method === "offscreen.createDocument").length, 1)
  assert.deepEqual(calls.find(call => call.method === "offscreen.createDocument").params.reasons, ["LOCAL_STORAGE"])
  await extension.start()
  assert.equal(calls.find(call => call.method === "connectNative").params, "com.ourostack.desk.browser")
  assert.equal(sent[0].event, "ready")
  assert.equal(sent[0].profileToken, token)
  assert.equal(calls.some(call => call.method === "windows.create"), false)
  extension.stop()
})

test("hidden token reader reuses profile-local token and refuses corrupt stored value", async () => {
  const { readProfileToken } = await import(new URL("token.js", extensionUrl))
  const store = new Map()
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  const generated = readProfileToken(storage, bytes => { bytes.fill(0xab); return bytes })
  assert.equal(generated, "ab".repeat(32))
  assert.equal(store.get("deskBrowserProfileToken"), generated)
  assert.equal(readProfileToken(storage, () => { throw new Error("must not regenerate"); }), generated)
  store.set("deskBrowserProfileToken", "corrupt")
  assert.throws(() => readProfileToken(storage), /NATIVE_PROFILE_TOKEN_INVALID/u)
})

test("explicit extension storage identity is passed to temporary-copy reader without changing defaults", async () => {
  const real = (await import(path.join(mcpRoot, "web-real-profile.cjs"))).default
  const root = await mkTempRoot("native-token-storage-")
  const { mkdir, writeFile } = await import("node:fs/promises")
  await mkdir(path.join(root, "profile", "Local Storage", "leveldb"), { recursive: true })
  await writeFile(path.join(root, "profile", "Local Storage", "leveldb", "fixture"), "")
  let readKey
  const level = { ClassicLevel: class {
    iterator() {
      let returned = false
      return {
        next: async () => returned ? undefined : (returned = true, [readKey = Buffer.from(`_chrome-extension://${extensionId}\0\x01deskBrowserProfileToken`, "latin1"), Buffer.concat([Buffer.from([1]), Buffer.from(token)])]),
        close: async () => {},
      }
    }
    close() { return Promise.resolve() }
  } }
  assert.equal(await real.readExtensionToken(path.join(root, "profile"), { level, tmpdir: root, extensionId, tokenKey: "deskBrowserProfileToken" }), token)
  assert.ok(readKey)
})

test("overlapping first creates share exactly one owner window", async () => {
  const { extension, calls } = await setup()
  const results = await Promise.all([create(extension, "one"), create(extension, "two")])
  assert.equal(results.every(result => result.error === undefined), true)
  assert.equal(calls.filter(call => call.method === "windows.create").length, 1)
  assert.equal(results[0].result.windowId, results[1].result.windowId)
})

test("unknown initial create cannot be bypassed with a new marker", async () => {
  const { extension, chrome, calls } = await setup()
  chrome.windows.create = async params => {
    calls.push({ method: "windows.create", params })
    throw new Error("response lost after dispatch")
  }
  assert.equal((await create(extension, "unknown")).error.code, "NATIVE_OPERATION_FAILED")
  const retried = await create(extension, "new-marker")
  assert.equal(retried.error.code, "NATIVE_CREATE_PENDING")
  assert.equal(calls.filter(call => call.method === "windows.create").length, 1)
  const unbind = await extension.dispatch({ id: "unbind", leaseId: "lease-a", method: "lease.unbind", params: {} })
  assert.equal(unbind.error.code, "NATIVE_LEASE_NOT_EMPTY")
})

test("task tabs must close before control and the same lease can reopen", async () => {
  const { extension, calls } = await setup()
  const first = await create(extension)
  const early = await extension.dispatch({ id: "early", leaseId: "lease-a", method: "target.close", params: { tabId: first.result.controlTabId } })
  assert.equal(early.error.code, "NATIVE_CONTROL_CLOSE_ORDER")
  await extension.dispatch({ id: "task-close", leaseId: "lease-a", method: "target.close", params: { tabId: first.result.tabId } })
  await extension.dispatch({ id: "control-close", leaseId: "lease-a", method: "target.close", params: { tabId: first.result.controlTabId } })
  const reopened = await create(extension, "reopen")
  assert.equal(reopened.error, undefined)
  assert.notEqual(reopened.result.windowId, first.result.windowId)
  assert.deepEqual(calls.filter(call => call.method === "tabs.remove").map(call => call.params), [first.result.tabId, first.result.controlTabId])
})

test("only emitted child sessions can receive flattened debugger commands", async () => {
  const { extension, chrome, calls } = await setup()
  const first = await create(extension)
  await extension.dispatch({ id: "attach", leaseId: "lease-a", method: "target.attach", params: { tabId: first.result.tabId } })
  const params = { tabId: first.result.tabId, method: "Runtime.enable", sessionId: "child-one" }
  assert.equal((await extension.dispatch({ id: "foreign-child", leaseId: "lease-a", method: "target.command", params })).error.code, "NATIVE_SESSION_NOT_OWNED")
  chrome.debugger.onEvent.emit({ tabId: first.result.tabId }, "Target.attachedToTarget", { sessionId: "child-one", targetInfo: { type: "iframe" } })
  assert.equal((await extension.dispatch({ id: "owned-child", leaseId: "lease-a", method: "target.command", params })).error, undefined)
  assert.equal(calls.find(call => call.method === "debugger.sendCommand").params.target.sessionId, "child-one")
})

test("token document disappearance is rechecked instead of caching setup forever", async () => {
  const { createBrowserExtension } = await import(extensionUrl)
  const { chrome, calls } = fixture()
  const extension = createBrowserExtension(chrome)
  await extension.ensureTokenDocument()
  chrome.runtime.getContexts = async () => []
  await extension.ensureTokenDocument()
  assert.equal(calls.filter(call => call.method === "offscreen.createDocument").length, 2)
})

test("control title follows a same-document purpose hash update without reloading", async () => {
  const old = new Map(["document", "location", "addEventListener"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const heading = { textContent: "" }
  const document = { title: "", getElementById: () => heading }
  const location = { hash: "#" + encodeURIComponent(JSON.stringify({ owner: "owner", work: "work" })) }
  let changed
  try {
    Object.defineProperty(globalThis, "document", { value: document, configurable: true })
    Object.defineProperty(globalThis, "location", { value: location, configurable: true })
    Object.defineProperty(globalThis, "addEventListener", { value: (event, handler) => { if (event === "hashchange") changed = handler }, configurable: true })
    await import(new URL("control.js?purpose-transition-test", extensionUrl))
    assert.equal(document.title, "Desk | owner | work")
    location.hash = "#" + encodeURIComponent(JSON.stringify({ owner: "owner", work: null }))
    changed?.()
    assert.equal(document.title, "Desk | owner")
    assert.equal(heading.textContent, "Desk | owner")
  } finally {
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
