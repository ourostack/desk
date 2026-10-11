import test from "node:test"
import assert from "node:assert/strict"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"
import path from "node:path"
import { pathToFileURL } from "node:url"

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
      get: async id => {
        const value = windows.get(id)
        if (!value) throw new Error("unknown window")
        return { ...value, left: 10, top: 20, width: 800, height: 600, state: "normal" }
      },
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

test("native startup disconnect reports classified codes without exposing Chrome error text or touching peer resources", async () => {
  const { createBrowserExtension } = await import(extensionUrl)
  for (const [message, expected] of [
    ["Specified native messaging host not found.", "NATIVE_HOST_NOT_FOUND"],
    ["Access to the specified native messaging host is forbidden.", "NATIVE_HOST_FORBIDDEN"],
    ["Native host has exited.", "NATIVE_HOST_EXITED"],
    ["Failed to start native messaging host.", "NATIVE_HOST_START_FAILED"],
    ["Invalid native messaging host name specified.", "NATIVE_HOST_NAME_INVALID"],
    ["Error when communicating with the native messaging host.", "NATIVE_HOST_IO_FAILED"],
    ["Private host /private/account chrome-extension://private/" + token, "NATIVE_HOST_ERROR_UNKNOWN"],
    [undefined, "NATIVE_TRANSPORT_DISCONNECTED"],
  ]) {
    const fake = fixture()
    const statuses = []
    const extension = createBrowserExtension(fake.chrome, { onStatus: code => statuses.push(code) })
    await extension.start()
    const callsBefore = structuredClone(fake.calls)
    const sentBefore = structuredClone(fake.sent)
    fake.chrome.runtime.lastError = message === undefined ? undefined : { message }
    try {
      fake.port.onDisconnect.emit()
      assert.deepEqual(statuses, [expected])
      assert.deepEqual(fake.calls, callsBefore, "diagnosis must not mutate or inspect any browser resource")
      assert.deepEqual(fake.sent, sentBefore, "raw diagnostic text must not enter native messages")
      assert.equal(JSON.stringify(statuses).includes(token), false)
      assert.equal(fake.tabs.size, 0)
      assert.equal(fake.windows.size, 0)
    } finally {
      extension.stop()
    }
  }
})

test("host startup diagnostic events have no authority even with forged request fields", async () => {
  const { createBrowserExtension } = await import(extensionUrl)
  const fake = fixture(), statuses = []
  const extension = createBrowserExtension(fake.chrome, { onStatus: code => statuses.push(code) })
  await extension.start()
  const calls = structuredClone(fake.calls), sent = structuredClone(fake.sent)
  try {
    fake.port.onMessage.emit({ event: "diagnostic", code: "NATIVE_ANCESTRY_MISMATCH", id: "forged",
      leaseId: "peer", method: "target.create", params: { owner: "private", marker: token } })
    fake.port.onMessage.emit({ event: "diagnostic", code: "PRIVATE_" + token.toUpperCase() })
    fake.port.onMessage.emit({ event: "diagnostic", code: "INVALID_NATIVE_CONTEXT" })
    fake.port.onMessage.emit({ event: "diagnostic", code: "ENOENT" })
    fake.port.onMessage.emit({ event: "diagnostic", code: "LEVEL_IO_ERROR" })
    fake.port.onMessage.emit({ event: "diagnostic", code: "EPERM", stage: "provider", syscall: "listen" })
    fake.port.onMessage.emit({ event: "diagnostic", code: "EPERM", stage: "/private/" + token, syscall: "open/" + token })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(statuses, ["NATIVE_ANCESTRY_MISMATCH", "NATIVE_HOST_ERROR_UNKNOWN",
      "INVALID_NATIVE_CONTEXT", "ENOENT", "LEVEL_IO_ERROR", "EPERM [provider/listen]", "EPERM"])
    assert.deepEqual(fake.calls, calls)
    assert.deepEqual(fake.sent, sent, "a diagnostic cannot resolve any request or send an RPC response")
    assert.equal(fake.tabs.size, 0)
    assert.equal(fake.windows.size, 0)
  } finally { extension.stop() }
})

test("extension build verifies executed-source identity across every shipped source file", async () => {
  const { mkdir, writeFile, copyFile, readFile } = await import("node:fs/promises")
  const { createRequire } = await import("node:module")
  const require = createRequire(import.meta.url)
  const root = await mkTempRoot("extension-source-build-")
  const scripts = path.join(root, "mcp/scripts")
  const extension = path.join(root, "browser-extension")
  await mkdir(scripts, { recursive: true })
  await mkdir(extension)
  await mkdir(path.join(root, "browser-context-broker/src"), { recursive: true })
  await writeFile(path.join(root, "browser-context-broker/src/markers.mjs"), "export const marker = 1;\n")
  await writeFile(path.join(extension, "manifest.json"), '{"version":"1"}')
  await writeFile(path.join(extension, "background.js"), "export const background = 1;\n")
  await copyFile(path.join(mcpRoot, "scripts/build-browser-extension.cjs"), path.join(scripts, "build-browser-extension.cjs"))
  const builder = require(path.join(scripts, "build-browser-extension.cjs"))
  builder.run([])
  assert.match(await readFile(path.join(extension, "source-digest.js"), "utf8"), /export const SOURCE_DIGEST = "[a-f0-9]{64}";/u)
  builder.run(["--verify"])
  await writeFile(path.join(extension, "background.js"), "export const background = 2;\n")
  assert.throws(() => builder.run(["--verify"]), /browser_extension_generated_source_mismatch/u)
})

test("native restoration distinguishes a missing control page from a mismatched lease marker", async () => {
  const { extension, tabs } = await setup()
  const first = await create(extension)
  const params = {
    profileToken: token, owner: "test-owner", work: "test-work", transportGeneration: "host-b",
    windowId: first.result.controlWindowId, controlTabId: first.result.controlTabId, controlMarker: first.result.controlMarker,
    targetTabs: [{ tabId: first.result.tabId, windowId: first.result.windowId }],
  }
  const original = tabs.get(first.result.controlTabId).url
  tabs.get(first.result.controlTabId).url = "about:blank"
  const missing = await extension.dispatch({ id: "restore-page", leaseId: "lease-a", method: "lease.restore", params })
  assert.equal(missing.error.code, "NATIVE_CONTROL_URL_MISMATCH")
  const label = JSON.parse(decodeURIComponent(original.split("#")[1]))
  tabs.get(first.result.controlTabId).url = original.split("#")[0] + "#" + encodeURIComponent(JSON.stringify({ ...label, marker: "foreign" }))
  const wrong = await extension.dispatch({ id: "restore-marker", leaseId: "lease-a", method: "lease.restore", params })
  assert.equal(wrong.error.code, "NATIVE_CONTROL_MISMATCH")
  tabs.get(first.result.controlTabId).url = original.split("#")[0] + "#not-json"
  const invalid = await extension.dispatch({ id: "restore-label", leaseId: "lease-a", method: "lease.restore", params })
  assert.equal(invalid.error.code, "NATIVE_CONTROL_LABEL_INVALID")
  tabs.get(first.result.controlTabId).url = "chrome-extension://invalid/"
  const unavailable = await extension.dispatch({ id: "restore-invalid-extension", leaseId: "lease-a", method: "lease.restore", params })
  assert.equal(unavailable.error.code, "NATIVE_CONTROL_URL_MISMATCH")
  for (const [url, code] of [
    ["chrome-error://chromewebdata/", "NATIVE_CONTROL_URL_MISMATCH"],
    ["https://fixture.example/", "NATIVE_CONTROL_URL_MISMATCH"],
    ["edge://newtab/", "NATIVE_CONTROL_URL_MISMATCH"],
    ["chrome-extension://" + extensionId + "/", "NATIVE_CONTROL_URL_MISMATCH"],
  ]) {
    tabs.get(first.result.controlTabId).url = url
    const result = await extension.dispatch({ id: "restore-shape-" + code, leaseId: "lease-a", method: "lease.restore", params })
    assert.equal(result.error.code, code)
  }
})



test("native ready identifies the executed extension build before provider attachment", async () => {
  const { extension, sent } = await setup()
  await extension.start()
  assert.match(sent.find(message => message.event === "ready").sourceDigest, /^[a-f0-9]{64}$/u)
  extension.stop()
})

test("deliberate extension reload requires exact profile and replies before disconnecting", async () => {
  const { extension, chrome, port, sent, calls } = await setup()
  let reloadCount = 0
  const updateToken = "c".repeat(64)
  let complete
  const reloaded = new Promise(resolve => { complete = resolve })
  chrome.runtime.reload = () => {
    reloadCount++
    complete()
  }
  await extension.start()
  const refused = await extension.dispatch({
    id: "wrong-reload", leaseId: "provider-update", method: "extension.reload",
    params: { profileToken: "b".repeat(64), updateToken },
  })
  assert.equal(refused.error.code, "NATIVE_PROFILE_MISMATCH")
  const ready = await extension.dispatch({
    id: "reload-probe", leaseId: "provider-update", method: "extension.reload", params: { profileToken: token, updateToken },
  })
  assert.equal(ready.result?.reload, true)
  port.onMessage.emit({ id: "reload-port", leaseId: "provider-update", method: "extension.reload", params: { profileToken: token, updateToken } })
  await new Promise(setImmediate)
  assert.equal(reloadCount, 0, "native preparation reply must reach the provider before it requests disconnect")
  port.onMessage.emit({ id: "reload-commit", leaseId: "provider-update", method: "extension.reload.commit", params: { profileToken: token, updateToken } })
  await reloaded
  assert.equal(sent.at(-1).id, "reload-commit")
  assert.equal(sent.at(-1).result.committing, true)
  assert.equal(calls.some(call => call.method === "windows.create" || call.method === "tabs.remove"), false)
  extension.stop()
})

test("owner control and each task use separate unfocused popup windows", async () => {
  const { extension, calls, tabs } = await setup()
  const first = await create(extension)
  assert.equal(first.error, undefined)
  const later = await create(extension, "later")
  assert.equal(later.error, undefined)
  const windows = calls.filter(call => call.method === "windows.create")
  assert.equal(windows.length, 3)
  assert.equal(windows.every(call => call.params.focused === false && call.params.type === "popup"), true)
  const taskCalls = calls.filter(call => call.method === "tabs.create")
  assert.equal(taskCalls.length, 0, "popup targets must not escape into a normal fallback window")
  assert.equal(first.result.controlWindowId, later.result.controlWindowId)
  assert.equal(first.result.controlTabId, later.result.controlTabId)
  assert.notEqual(first.result.windowId, first.result.controlWindowId)
  assert.notEqual(later.result.windowId, first.result.windowId)
  assert.equal(tabs.get(first.result.tabId).windowId, first.result.windowId)
  assert.equal(tabs.get(later.result.tabId).windowId, later.result.windowId)
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
  const real = (await import(pathToFileURL(path.join(mcpRoot, "web-real-profile.cjs")).href)).default
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
  assert.equal(calls.filter(call => call.method === "windows.create").length, 3)
  assert.equal(results[0].result.controlWindowId, results[1].result.controlWindowId)
  assert.notEqual(results[0].result.windowId, results[1].result.windowId)
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

test("unknown task popup create remains pending without a normal-window fallback", async () => {
  const { extension, chrome, calls } = await setup()
  const initial = await create(extension)
  assert.equal(initial.error, undefined)
  const createWindow = chrome.windows.create
  chrome.windows.create = async params => {
    await createWindow(params)
    return { id: 500, tabs: [] }
  }
  const failed = await create(extension, "lost-task-window")
  assert.equal(failed.error.code, "NATIVE_CREATE_INDETERMINATE")
  const count = calls.filter(call => call.method === "windows.create").length
  const retry = await create(extension, "new-marker-after-loss")
  assert.equal(retry.error.code, "NATIVE_CREATE_PENDING")
  assert.equal(calls.filter(call => call.method === "windows.create").length, count)
  assert.equal(calls.some(call => call.method === "tabs.create"), false)
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
  const listing = { textContent: "" }
  const document = { title: "", getElementById: id => id === "owner" ? heading : listing }
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

test("control projects exact owned work windows on readback without changing page titles", async () => {
  const { extension, tabs, calls } = await setup()
  const first = await create(extension)
  const second = await create(extension, "listing-second")
  tabs.get(first.result.tabId).title = "<img src=x onerror=alert(1)>"
  tabs.get(second.result.tabId).title = "<img src=x onerror=alert(1)>"
  const read = () => extension.dispatch({ id: "listing-read", leaseId: "lease-a", method: "target.readback" })
  await read()
  const label = JSON.parse(decodeURIComponent(tabs.get(first.result.controlTabId).url.split("#")[1]))
  assert.deepEqual(label.targets, [
    { tabId: first.result.tabId, windowId: first.result.windowId, title: "<img src=x onerror=alert(1)>" },
    { tabId: second.result.tabId, windowId: second.result.windowId, title: "<img src=x onerror=alert(1)>" },
  ])
  const changes = calls.filter(call => call.method === "tabs.update").length
  await read()
  assert.equal(calls.filter(call => call.method === "tabs.update").length, changes, "unchanged projection must not renavigate control")
  await extension.dispatch({ id: "listing-close", leaseId: "lease-a", method: "target.close", params: { tabId: first.result.tabId } })
  await read()
  const remaining = JSON.parse(decodeURIComponent(tabs.get(first.result.controlTabId).url.split("#")[1]))
  assert.deepEqual(remaining.targets, [label.targets[1]])
  assert.equal(tabs.get(second.result.tabId).title, "<img src=x onerror=alert(1)>")
})

test("control renders hostile and duplicate titles literally with their exact window identities", async () => {
  const keys = ["document", "location", "addEventListener"]
  const old = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const heading = { textContent: "" }, listing = { textContent: "" }
  const document = { title: "", getElementById: id => id === "owner" ? heading : listing }
  const targets = [
    { tabId: 11, windowId: 101, title: "<script>owned?</script>" },
    { tabId: 12, windowId: 102, title: "<script>owned?</script>" },
    { tabId: 13, windowId: 103, title: "" },
  ]
  const location = { hash: "#" + encodeURIComponent(JSON.stringify({ owner: "owner", work: null, targets })) }
  try {
    Object.defineProperty(globalThis, "document", { value: document, configurable: true })
    Object.defineProperty(globalThis, "location", { value: location, configurable: true })
    Object.defineProperty(globalThis, "addEventListener", { value: () => {}, configurable: true })
    await import(new URL("control.js?literal-window-list-test", extensionUrl))
    assert.equal(document.title, "Desk | owner")
    assert.equal(listing.textContent, "Window 101 | Tab 11 | <script>owned?</script>\nWindow 102 | Tab 12 | <script>owned?</script>\nWindow 103 | Tab 13 | Untitled")
    assert.equal(Object.hasOwn(listing, "innerHTML"), false)
  } finally {
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})

test("invalid control window projection refuses instead of rendering arbitrary identities", async () => {
  const old = new Map(["document", "location", "addEventListener", "console"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const owner = { textContent: "" }, listing = { textContent: "unchanged" }, errors = []
  const document = { title: "", getElementById: id => id === "owner" ? owner : listing }
  let changed
  const location = { hash: "#" + encodeURIComponent(JSON.stringify({ owner: "owner", work: null, targets: [] })) }
  try {
    Object.defineProperty(globalThis, "document", { value: document, configurable: true })
    Object.defineProperty(globalThis, "location", { value: location, configurable: true })
    Object.defineProperty(globalThis, "addEventListener", { value: (_, handler) => { changed = handler }, configurable: true })
    Object.defineProperty(globalThis, "console", { value: { error: error => errors.push(error) }, configurable: true })
    await import(new URL("control.js?invalid-window-projection-test", extensionUrl))
    for (const targets of [{}, [{ tabId: 1, windowId: "2", title: "page" }],
      [{ tabId: -1, windowId: 2, title: "page" }], [{ tabId: 1, windowId: -2, title: "page" }],
      [{ tabId: 1, windowId: 2, title: "a".repeat(241) }], Array.from({ length: 51 }, () => ({ tabId: 1, windowId: 2, title: "page" }))]) {
      listing.textContent = "unchanged"
      location.hash = "#" + encodeURIComponent(JSON.stringify({ owner: "owner", work: null, targets }))
      changed()
      assert.equal(document.title, "Desk | invalid ownership label")
      assert.equal(listing.textContent, "unchanged")
    }
    assert.equal(errors.length, 6)
  } finally {
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})

test("recorded broker marker URL is used before original-page navigation", async () => {
  const { extension, tabs } = await setup()
  const marker = "encoded-marker"
  const markerUrl = "data:text/html," + encodeURIComponent('<!doctype html><meta charset="utf-8"><title>Desk target marker</title><meta name="desk-target-marker" content="encoded-marker">')
  const result = await extension.dispatch({ id: "marker-url", leaseId: "lease-a", method: "target.create", params: { marker, markerUrl } })
  assert.equal(result.error, undefined)
  assert.equal(tabs.get(result.result.tabId).url, markerUrl)
})

test("native readback reports bounds only for exact recorded windows", async () => {
  const { extension } = await setup()
  const first = await create(extension)
  const result = await extension.dispatch({ id: "read", leaseId: "lease-a", method: "target.readback", params: {} })
  assert.deepEqual(result.result.windows, [
    { id: first.result.controlWindowId, left: 10, top: 20, width: 800, height: 600, state: "normal" },
    { id: first.result.windowId, left: 10, top: 20, width: 800, height: 600, state: "normal" },
  ])
})

test("close success requires exact target absence rather than API return alone", async () => {
  const { extension, chrome } = await setup()
  const first = await create(extension)
  chrome.tabs.remove = async () => {}
  const result = await extension.dispatch({ id: "close-unconfirmed", leaseId: "lease-a", method: "target.close", params: { tabId: first.result.tabId } })
  assert.equal(result.error.code, "NATIVE_CLOSE_UNCONFIRMED")
})

test("native host reconnect restores only exact prior control and recorded Chrome tabs", async () => {
  const { extension, calls } = await setup()
  const first = await create(extension)
  const later = await create(extension, "restore-later")
  await extension.dispatch({ id: "initial-attach", leaseId: "lease-a", method: "target.attach", params: { tabId: first.result.tabId } })
  const count = calls.filter(call => call.method === "windows.create").length
  const restored = await extension.dispatch({ id: "restore", leaseId: "lease-a", method: "lease.restore", params: {
    profileToken: token, owner: "test-owner", work: "test-work", transportGeneration: "host-b",
    windowId: first.result.controlWindowId, controlTabId: first.result.controlTabId, controlMarker: first.result.controlMarker,
    targetTabs: [
      { tabId: first.result.tabId, windowId: first.result.windowId },
      { tabId: later.result.tabId, windowId: later.result.windowId },
    ],
  } })
  assert.equal(restored.error, undefined)
  assert.equal(restored.result.controlTabId, first.result.controlTabId)
  assert.equal(calls.filter(call => call.method === "windows.create").length, count)
  assert.equal(calls.filter(call => call.method === "debugger.detach").length, 1,
    "the lost transport's enabled domains must detach before a new logical client requests fresh contexts")
  await extension.dispatch({ id: "restored-attach", leaseId: "lease-a", method: "target.attach", params: { tabId: first.result.tabId } })
  assert.equal(calls.filter(call => call.method === "debugger.attach").length, 2)
})

test("native debugger events preserve Chrome ordering across asynchronous owned-tab validation", async () => {
  const { extension, chrome, sent } = await setup()
  const first = await create(extension)
  await extension.dispatch({ id: "attach-order", leaseId: "lease-a", method: "target.attach", params: { tabId: first.result.tabId } })
  await extension.start()
  const originalGet = chrome.tabs.get
  let reads = 0
  let finish
  const held = new Promise(resolve => { finish = resolve })
  chrome.tabs.get = async id => {
    if (++reads === 1) await held
    return originalGet(id)
  }
  chrome.debugger.onEvent.emit({ tabId: first.result.tabId }, "Runtime.executionContextsCleared", {})
  chrome.debugger.onEvent.emit({ tabId: first.result.tabId }, "Runtime.executionContextCreated", { context: { id: 42 } })
  await new Promise(setImmediate)
  const early = sent.filter(message => message.event === "cdp")
  finish()
  for (let attempt = 0; attempt < 20 && sent.filter(message => message.event === "cdp").length < 2; attempt++) {
    await new Promise(setImmediate)
  }
  assert.equal(early.length, 0, "later context may not overtake the earlier invalidation")
  assert.deepEqual(sent.filter(message => message.event === "cdp").map(message => message.method),
    ["Runtime.executionContextsCleared", "Runtime.executionContextCreated"])
  extension.stop()
})
