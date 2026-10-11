import { controlTitle } from "./control.js"
import { markerTargetUrl } from "./markers.js"

const HOST = "com.ourostack.desk.browser"
const METHODS = new Set([
  "profile.read", "lease.bind", "lease.restore", "lease.unbind",
  "target.create", "target.attach", "target.detach", "target.command",
  "target.close", "target.readback", "target.admit", "purpose.set",
])
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const TOKEN = /^[a-f0-9]{64}$/u
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function refusal(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function integer(value) {
  return Number.isSafeInteger(value) && value > 0
}

export function createBrowserExtension(api, { onStatus = code => console.error(code) } = {}) {
  const leases = new Map()
  const requests = new Set()
  const operations = new Map()
  let tokenDocument
  let port
  let starting
  let stopped = false
  let retryTimer
  let retryMs = 1000

  async function ensureTokenDocument() {
    if (tokenDocument) return tokenDocument
    tokenDocument = (async () => {
      const url = api.runtime.getURL("token.html")
      const contexts = await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })
      if (contexts.length === 0) {
        await api.offscreen.createDocument({
          url: "token.html", reasons: ["LOCAL_STORAGE"],
          justification: "Bind the browser's extension storage partition to the declared Desk profile.",
        })
      } else if (contexts.length !== 1 || contexts[0].documentUrl !== url) {
        throw refusal("NATIVE_TOKEN_DOCUMENT_INVALID", "The extension token document is ambiguous")
      }
    })()
    const pending = tokenDocument
    try {
      await pending
    } finally {
      if (tokenDocument === pending) tokenDocument = undefined
    }
  }

  async function profileToken() {
    await ensureTokenDocument()
    const response = await api.runtime.sendMessage({ type: "desk-profile-token" })
    if (!TOKEN.test(response?.token ?? "")) {
      throw refusal("NATIVE_PROFILE_TOKEN_INVALID", "The extension's profile token is unavailable")
    }
    return response.token
  }

  function leaseFor(id) {
    const lease = leases.get(id)
    if (!lease) throw refusal("NATIVE_LEASE_NOT_BOUND", "Native lease is not bound")
    return lease
  }

  async function ownTab(lease, tabId, allowControl = false) {
    const record = lease.tabs.get(tabId)
    if (!record || (!allowControl && tabId === lease.controlTabId)) {
      throw refusal("NATIVE_TARGET_NOT_OWNED", "The target is not a task page of this lease")
    }
    const tab = await api.tabs.get(tabId)
    if (tab.windowId !== record.windowId) {
      throw refusal("NATIVE_WINDOW_MISMATCH", "The owned tab no longer belongs to its recorded window")
    }
    return tab
  }

  function controlUrl(lease) {
    return api.runtime.getURL("control.html") + "#" + encodeURIComponent(JSON.stringify({
      owner: lease.owner, work: lease.work, leaseId: lease.id, marker: lease.controlMarker,
    }))
  }

  async function labelControl(lease) {
    await ownTab(lease, lease.controlTabId, true)
    const url = controlUrl(lease)
    await api.tabs.update(lease.controlTabId, { url })
    const expected = controlTitle(lease)
    for (let attempt = 0; attempt < 60; attempt++) {
      const tab = await ownTab(lease, lease.controlTabId, true)
      if (tab.url === url && tab.title === expected) return expected
      await delay(50)
    }
    throw refusal("NATIVE_CONTROL_UNREADY", "The exact owner control did not confirm its label")
  }

  async function targetInfo(tabId) {
    const targets = (await api.debugger.getTargets()).filter(target => target.tabId === tabId)
    if (targets.length !== 1 || typeof targets[0].id !== "string" || !targets[0].id) {
      throw refusal("NATIVE_TARGET_UNREADY", "The owned Chrome tab has no unique debug target")
    }
    return targets[0]
  }

  async function restore(lease, params) {
    if (!integer(params.windowId) || !integer(params.controlTabId) ||
        typeof params.controlMarker !== "string" || !params.controlMarker ||
        !Array.isArray(params.targetTabs) || params.targetTabs.length > 50) {
      throw refusal("NATIVE_ROUTING_INVALID", "Restoration requires exact recorded native routing")
    }
    const control = await api.tabs.get(params.controlTabId)
    let label
    try {
      const url = new URL(control.url)
      if (url.origin + url.pathname !== api.runtime.getURL("control.html")) throw new Error("wrong control origin")
      label = JSON.parse(decodeURIComponent(url.hash.slice(1)))
    } catch {
      throw refusal("NATIVE_CONTROL_MISMATCH", "The recorded owner control cannot be verified")
    }
    if (control.windowId !== params.windowId || label.leaseId !== lease.id || label.marker !== params.controlMarker) {
      throw refusal("NATIVE_CONTROL_MISMATCH", "The recorded owner control belongs to a different lease")
    }
    const records = new Map([[control.id, { tabId: control.id, windowId: control.windowId, control: true }]])
    for (const record of params.targetTabs) {
      if (!integer(record.tabId) || !integer(record.windowId) || records.has(record.tabId)) {
        throw refusal("NATIVE_ROUTING_INVALID", "Native restoration contains duplicate or invalid Chrome identities")
      }
      const tab = await api.tabs.get(record.tabId)
      if (tab.windowId !== record.windowId) throw refusal("NATIVE_WINDOW_MISMATCH", "Recorded task routing has changed")
      records.set(record.tabId, { ...record, sessions: new Set(), attached: false })
    }
    lease.windowId = params.windowId
    lease.controlTabId = params.controlTabId
    lease.controlMarker = params.controlMarker
    lease.tabs = records
    return { windowId: lease.windowId, controlTabId: lease.controlTabId }
  }

  async function invoke(request) {
    const { method, leaseId, params = {} } = request
    if (method === "profile.read") return { profileToken: await profileToken(), extensionId: api.runtime.id }
    if (method === "lease.bind" || method === "lease.restore") {
      if (!TOKEN.test(params.profileToken ?? "") || params.profileToken !== await profileToken()) {
        throw refusal("NATIVE_PROFILE_MISMATCH", "Native lease does not match the extension profile")
      }
      controlTitle(params)
      if (typeof params.transportGeneration !== "string" || !ID.test(params.transportGeneration)) {
        throw refusal("NATIVE_GENERATION_INVALID", "Native transport generation is required")
      }
      if (leases.has(leaseId)) {
        throw refusal("NATIVE_LEASE_ALREADY_BOUND", "Native lease is already bound; explicit restoration is required")
      }
      const lease = {
        id: leaseId, owner: params.owner, work: params.work, transportGeneration: params.transportGeneration,
        tabs: new Map(), creates: new Map(),
      }
      const result = method === "lease.restore" ? await restore(lease, params) : { bound: true }
      leases.set(leaseId, lease)
      return result
    }
    const lease = leaseFor(leaseId)
    if (method === "target.create") {
      if (typeof params.marker !== "string" || !ID.test(params.marker)) {
        throw refusal("NATIVE_MARKER_INVALID", "Target creation requires the broker's recorded marker")
      }
      const markerUrl = markerTargetUrl(params.marker)
      if (params.markerUrl !== undefined && params.markerUrl !== markerUrl) {
        throw refusal("NATIVE_MARKER_INVALID", "Native marker URL does not match its recorded marker identity")
      }
      if (lease.creates.has(params.marker) || Array.from(lease.creates.values()).some(value => value.pending)) {
        throw refusal("NATIVE_CREATE_PENDING", "An earlier create has been dispatched and needs exact reconciliation")
      }
      lease.creates.set(params.marker, { pending: true })
      if (lease.controlTabId === undefined) {
        lease.controlMarker = params.marker
        const window = await api.windows.create({ url: controlUrl(lease), focused: false, type: "normal" })
        if (!integer(window.id) || window.tabs?.length !== 1 || !integer(window.tabs[0].id)) {
          throw refusal("NATIVE_CREATE_INDETERMINATE", "Native window creation did not return exact Chrome identities")
        }
        lease.windowId = window.id
        lease.controlTabId = window.tabs[0].id
        lease.tabs.set(lease.controlTabId, { tabId: lease.controlTabId, windowId: window.id, control: true })
        await labelControl(lease)
      }
      await ownTab(lease, lease.controlTabId, true)
      const tab = await api.tabs.create({ windowId: lease.windowId, active: false, url: markerUrl })
      if (!integer(tab.id) || tab.windowId !== lease.windowId) {
        throw refusal("NATIVE_CREATE_INDETERMINATE", "Native tab creation did not return exact owner-window routing")
      }
      lease.tabs.set(tab.id, { tabId: tab.id, windowId: tab.windowId, sessions: new Set(), attached: false })
      const target = await targetInfo(tab.id)
      const control = await targetInfo(lease.controlTabId)
      const result = {
        tabId: tab.id, targetId: target.id, windowId: tab.windowId, controlTabId: lease.controlTabId,
        controlTargetId: control.id, controlMarker: lease.controlMarker, markerUrl,
      }
      lease.creates.set(params.marker, result)
      return result
    }
    if (method === "purpose.set") {
      controlTitle({ owner: lease.owner, work: params.work })
      lease.work = params.work
      return { title: await labelControl(lease) }
    }
    if (method === "target.readback") {
      const tabs = []
      for (const record of lease.tabs.values()) {
        const tab = await ownTab(lease, record.tabId, true)
        tabs.push({ tabId: tab.id, windowId: tab.windowId, control: Boolean(record.control), targetId: (await targetInfo(tab.id)).id, url: tab.url, title: tab.title })
      }
      const windows = []
      for (const id of new Set(tabs.map(tab => tab.windowId))) {
        const window = await api.windows.get(id)
        if (window.id !== id) throw refusal("NATIVE_WINDOW_MISMATCH", "Owned window readback returned a different identity")
        windows.push({ id, left: window.left, top: window.top, width: window.width, height: window.height, state: window.state })
      }
      return { windowId: lease.windowId, controlTabId: lease.controlTabId, controlMarker: lease.controlMarker, tabs, windows }
    }
    if (method === "lease.unbind") {
      if (lease.tabs.size !== 0 || Array.from(lease.creates.values()).some(value => value.pending)) {
        throw refusal("NATIVE_LEASE_NOT_EMPTY", "Native lease still has recorded targets or unknown creates")
      }
      leases.delete(leaseId)
      return { unbound: true }
    }
    if (method === "target.admit") {
      await ownTab(lease, params.openerTabId)
      const tab = await api.tabs.get(params.tabId)
      if (tab.openerTabId !== params.openerTabId || !integer(tab.id) || !integer(tab.windowId)) {
        throw refusal("NATIVE_POPUP_NOT_OWNED", "A popup requires an exact owned Chrome opener")
      }
      lease.tabs.set(tab.id, { tabId: tab.id, windowId: tab.windowId, sessions: new Set(), attached: false })
      return { tabId: tab.id, windowId: tab.windowId, targetId: (await targetInfo(tab.id)).id }
    }
    const tab = await ownTab(lease, params.tabId, method === "target.close")
    const record = lease.tabs.get(tab.id)
    if (method === "target.close") {
      if (tab.id === lease.controlTabId && lease.tabs.size !== 1) {
        throw refusal("NATIVE_CONTROL_CLOSE_ORDER", "Close exact task targets before the owner control")
      }
      await api.tabs.remove(tab.id)
      for (let attempt = 0; attempt < 20; attempt++) {
        const present = (await api.debugger.getTargets()).some(target => target.tabId === tab.id)
        if (!present) return { closed: true, tabId: tab.id }
        await delay(50)
      }
      throw refusal("NATIVE_CLOSE_UNCONFIRMED", "The exact native target is still present after close")
    }
    if (method === "target.attach") {
      if (!record.attached) {
        await api.debugger.attach({ tabId: tab.id }, "1.3")
        record.attached = true
      }
      return { targetId: (await targetInfo(tab.id)).id }
    }
    if (method === "target.detach") {
      if (record.attached) await api.debugger.detach({ tabId: tab.id })
      record.attached = false
      record.sessions.clear()
      return { detached: true }
    }
    if (method === "target.command") {
      if (typeof params.method !== "string" || /^(Browser|SystemInfo|Tethering|Storage|DOMStorage|IndexedDB|CacheStorage|Database|ServiceWorker)\./u.test(params.method) ||
          (params.method.startsWith("Target.") && params.method !== "Target.setAutoAttach") ||
          ["Page.bringToFront", "Target.activateTarget", "Target.createTarget", "Target.closeTarget", "Target.attachToBrowserTarget",
            "Network.clearBrowserCache", "Network.clearBrowserCookies", "Network.getAllCookies", "Network.getCookies",
            "Network.setCookie", "Network.setCookies", "Network.deleteCookies"].includes(params.method)) {
        throw refusal("NATIVE_METHOD_DENIED", "Native transport cannot dispatch browser-global or activation commands")
      }
      if (!record.attached || (params.sessionId !== undefined && !record.sessions.has(params.sessionId))) {
        throw refusal("NATIVE_SESSION_NOT_OWNED", "Debugger session is not attached to this exact owned tab")
      }
      const target = { tabId: tab.id }
      if (params.sessionId !== undefined) target.sessionId = params.sessionId
      return await api.debugger.sendCommand(target, params.method, params.params ?? {}) ?? {}
    }
    throw refusal("NATIVE_METHOD_DENIED", "Native method is not supported")
  }

  async function dispatch(request) {
    const id = request?.id
    if (!METHODS.has(request?.method)) return { id, error: { code: "NATIVE_METHOD_DENIED", message: "Native method is not supported" } }
    if (typeof id !== "string" || !ID.test(id) || typeof request.leaseId !== "string" || !ID.test(request.leaseId) ||
        (request.params !== undefined && (request.params === null || typeof request.params !== "object" || Array.isArray(request.params)))) {
      return { id, error: { code: "NATIVE_REQUEST_INVALID", message: "Native request identity or parameters are invalid" } }
    }
    if (requests.has(id) || requests.size >= 256) {
      return { id, error: { code: "NATIVE_REQUEST_BUSY", message: "Native request is duplicate or the queue is full" } }
    }
    requests.add(id)
    try {
      const previous = operations.get(request.leaseId) ?? Promise.resolve()
      const operation = previous.then(() => invoke(request))
      const completion = operation.then(() => undefined, () => undefined)
      operations.set(request.leaseId, completion)
      completion.then(() => {
        if (operations.get(request.leaseId) === completion) operations.delete(request.leaseId)
      })
      return { id, result: await operation }
    } catch (error) {
      return { id, error: { code: error.code ?? "NATIVE_OPERATION_FAILED", message: error.code ? error.message : "Chrome did not confirm the requested operation" } }
    } finally {
      requests.delete(id)
    }
  }

  function publish(message) {
    if (!port) return
    try {
      port.postMessage(message)
    } catch {
      onStatus("NATIVE_TRANSPORT_DISCONNECTED")
    }
  }

  api.tabs.onRemoved.addListener(tabId => {
    for (const lease of leases.values()) {
      if (!lease.tabs.delete(tabId)) continue
      if (tabId === lease.controlTabId) {
        lease.controlTabId = undefined
        lease.windowId = undefined
      }
      publish({ event: "target.closed", leaseId: lease.id, tabId })
    }
  })
  api.tabs.onCreated.addListener(tab => {
    for (const lease of leases.values()) {
      if (tab.openerTabId && lease.tabs.has(tab.openerTabId) && tab.openerTabId !== lease.controlTabId) {
        publish({ event: "target.popup", leaseId: lease.id, tabId: tab.id, windowId: tab.windowId, openerTabId: tab.openerTabId })
      }
    }
  })
  api.debugger.onEvent.addListener((source, method, params) => {
    for (const lease of leases.values()) {
      const record = lease.tabs.get(source.tabId)
      if (!record?.attached || (source.sessionId && !record.sessions.has(source.sessionId))) continue
      if (method === "Target.attachedToTarget" && typeof params?.sessionId === "string") record.sessions.add(params.sessionId)
      if (method === "Target.detachedFromTarget") record.sessions.delete(params?.sessionId)
      ownTab(lease, source.tabId).then(() => publish({ event: "cdp", leaseId: lease.id, tabId: source.tabId, sessionId: source.sessionId, method, params }),
        () => publish({ event: "target.routingLost", leaseId: lease.id, tabId: source.tabId }))
    }
  })
  api.debugger.onDetach.addListener((source, reason) => {
    for (const lease of leases.values()) {
      const record = lease.tabs.get(source.tabId)
      if (!record) continue
      record.attached = false
      record.sessions?.clear()
      publish({ event: "target.detached", leaseId: lease.id, tabId: source.tabId, reason })
    }
  })

  function retry() {
    if (stopped || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      start().catch(() => {
        onStatus("NATIVE_HOST_UNAVAILABLE")
        retry()
      })
    }, retryMs)
    retryTimer.unref?.()
    retryMs = Math.min(30000, retryMs * 2)
  }

  async function start() {
    if (port) return
    if (starting) return starting
    stopped = false
    starting = (async () => {
      const token = await profileToken()
      const connected = api.runtime.connectNative(HOST)
      port = connected
      connected.onMessage.addListener(request => {
        dispatch(request).then(response => {
          if (port === connected) publish(response)
          else onStatus("NATIVE_RESPONSE_UNDELIVERED")
        })
      })
      connected.onDisconnect.addListener(() => {
        void api.runtime.lastError
        if (port === connected) port = undefined
        if (!stopped) onStatus("NATIVE_TRANSPORT_DISCONNECTED")
        retry()
      })
      publish({ event: "ready", protocolVersion: 1, extensionId: api.runtime.id, profileToken: token })
      retryMs = 1000
    })()
    try {
      await starting
    } finally {
      starting = undefined
    }
  }

  function stop() {
    stopped = true
    clearTimeout(retryTimer)
    retryTimer = undefined
    const connected = port
    port = undefined
    connected?.disconnect()
  }

  return Object.freeze({ dispatch, start, stop, ensureTokenDocument })
}

if (typeof chrome !== "undefined") {
  const extension = createBrowserExtension(chrome)
  const start = () => extension.start().catch(() => console.error("NATIVE_HOST_UNAVAILABLE"))
  chrome.runtime.onInstalled.addListener(start)
  chrome.runtime.onStartup.addListener(start)
  start()
}
