import { controlTitle } from "./control.js"
import { markerTargetUrl } from "./markers.js"
import { SOURCE_DIGEST } from "./source-digest.js"

const HOST = "com.ourostack.desk.browser"
const METHODS = new Set([
  "profile.read", "extension.reload", "extension.reload.commit", "lease.bind", "lease.restore", "lease.unbind",
  "target.create", "target.attach", "target.detach", "target.command",
  "target.close", "target.readback", "target.admit", "purpose.set",
])
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const TOKEN = /^[a-f0-9]{64}$/u
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const NATIVE_ERRORS = new Map([
  ["Specified native messaging host not found.", "NATIVE_HOST_NOT_FOUND"],
  ["Access to the specified native messaging host is forbidden.", "NATIVE_HOST_FORBIDDEN"],
  ["Native host has exited.", "NATIVE_HOST_EXITED"],
  ["Failed to start native messaging host.", "NATIVE_HOST_START_FAILED"],
  ["Invalid native messaging host name specified.", "NATIVE_HOST_NAME_INVALID"],
  ["Error when communicating with the native messaging host.", "NATIVE_HOST_IO_FAILED"],
])
const NATIVE_DIAGNOSTICS = new Set([
  "NATIVE_HOST_FAILED", "NATIVE_PROVIDER_START_FAILED", "NATIVE_PROFILE_MISMATCH", "NATIVE_PROFILE_TOKEN_UNAVAILABLE",
  "NATIVE_ANCESTRY_MISMATCH", "NATIVE_ANCESTRY_INVALID", "NATIVE_ANCESTRY_UNSUPPORTED",
  "NATIVE_ORIGIN_REFUSED", "NATIVE_PROTOCOL_MISMATCH", "NATIVE_EXTENSION_SOURCE_MISMATCH",
  "NATIVE_BROWSER_VERSION_UNSUPPORTED", "NATIVE_TRANSPORT_CLOSED",
  "INVALID_NATIVE_CONTEXT", "INVALID_NATIVE_TRANSPORT", "INVALID_STATE_DIRECTORY", "INSECURE_STATE_DIRECTORY",
  "INVALID_REGISTRY", "BROKER_LOCK_TIMEOUT", "STALE_BROKER_LOCK", "INVALID_LOCK_NAME",
  "ENOENT", "EACCES", "EPERM", "ENOTDIR", "EIO", "EEXIST", "EADDRINUSE",
  "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED",
  "LEVEL_DATABASE_NOT_OPEN", "LEVEL_LOCKED", "LEVEL_IO_ERROR", "LEVEL_CORRUPTION",
])
const DIAGNOSTIC_STAGES = new Set(["native-ancestry", "profile-token", "provider"])
const DIAGNOSTIC_SYSCALLS = new Set(["open", "read", "write", "copyfile", "mkdir", "listen", "unlink", "rename", "stat", "lstat", "scandir", "rmdir"])

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
  let pendingReloadToken

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
      targets: lease.targetProjection ?? [],
    }))
  }

  async function labelControl(lease) {
    await ownTab(lease, lease.controlTabId, true)
    const url = controlUrl(lease)
    const expected = controlTitle(lease)
    const current = await ownTab(lease, lease.controlTabId, true)
    if (current.url === url && current.title === expected) return expected
    try {
      await api.tabs.update(lease.controlTabId, { url })
    } catch (error) {
      const reason = String(error.message ?? "").replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, "<redacted-url>")
        .replace(/[a-f0-9]{32,}/giu, "<redacted>").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 240)
      throw refusal("NATIVE_CONTROL_NAVIGATION_FAILED", reason)
    }
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

  async function restore(lease, params, previous) {
    if (!integer(params.windowId) || !integer(params.controlTabId) ||
        typeof params.controlMarker !== "string" || !params.controlMarker ||
        !Array.isArray(params.targetTabs) || params.targetTabs.length > 50) {
      throw refusal("NATIVE_ROUTING_INVALID", "Restoration requires exact recorded native routing")
    }
    const control = await api.tabs.get(params.controlTabId)
    if (control.windowId !== params.windowId) {
      throw refusal("NATIVE_CONTROL_MISMATCH", "The recorded owner control moved from its exact window")
    }
    let label
    let url
    try {
      url = new URL(control.url)
      if (url.protocol + "//" + url.host + url.pathname !== api.runtime.getURL("control.html")) throw new Error("wrong control origin")
    } catch {
      throw refusal("NATIVE_CONTROL_URL_MISMATCH", "The recorded owner control page URL cannot be verified")
    }
    try {
      label = JSON.parse(decodeURIComponent(url.hash.slice(1)))
    } catch {
      throw refusal("NATIVE_CONTROL_LABEL_INVALID", "The recorded owner control page label cannot be decoded")
    }
    if (label.leaseId !== lease.id || label.marker !== params.controlMarker) {
      throw refusal("NATIVE_CONTROL_MISMATCH", "The recorded owner control belongs to a different lease")
    }
    const records = new Map([[control.id, { tabId: control.id, windowId: control.windowId, control: true }]])
    const projection = []
    for (const record of params.targetTabs) {
      if (!integer(record.tabId) || !integer(record.windowId) || records.has(record.tabId)) {
        throw refusal("NATIVE_ROUTING_INVALID", "Native restoration contains duplicate or invalid Chrome identities")
      }
      const tab = await api.tabs.get(record.tabId)
      if (tab.windowId !== record.windowId) throw refusal("NATIVE_WINDOW_MISMATCH", "Recorded task routing has changed")
      projection.push({ tabId: tab.id, windowId: tab.windowId, title: String(tab.title ?? "").slice(0, 240) })
      const prior = previous?.tabs.get(record.tabId)
      records.set(record.tabId, { ...record, sessions: new Set(), attached: false,
        detachPrior: Boolean(prior?.attached && prior.windowId === record.windowId) })
    }
    for (const record of records.values()) {
      if (!record.detachPrior) continue
      await api.debugger.detach({ tabId: record.tabId })
      delete record.detachPrior
    }
    lease.windowId = params.windowId
    lease.controlTabId = params.controlTabId
    lease.controlMarker = params.controlMarker
    lease.tabs = records
    lease.targetProjection = projection
    return { windowId: lease.windowId, controlTabId: lease.controlTabId }
  }

  async function invoke(request) {
    const { method, leaseId, params = {} } = request
    if (method === "extension.reload" || method === "extension.reload.commit") {
      if (leaseId !== "provider-update" || !TOKEN.test(params.profileToken ?? "") ||
          params.profileToken !== await profileToken()) {
        throw refusal("NATIVE_PROFILE_MISMATCH", "Deliberate reload requires the exact native profile")
      }
      if (requests.size !== 1 || [...leases.values()].some(lease =>
        lease.tabs.size !== 0 || [...lease.creates.values()].some(create => create.pending))) {
        throw refusal("NATIVE_UPDATE_EFFECTS_PENDING", "Exact native effects must settle before extension reload")
      }
      if (!TOKEN.test(params.updateToken ?? "") ||
          (method === "extension.reload.commit" && params.updateToken !== pendingReloadToken)) {
        throw refusal("NATIVE_UPDATE_TOKEN_INVALID", "Reload commit must match its exact prepared update")
      }
      if (method === "extension.reload.commit") {
        pendingReloadToken = undefined
        return { committing: true }
      }
      pendingReloadToken = params.updateToken
      return { reload: true }
    }
    if (method === "profile.read") return { profileToken: await profileToken(), extensionId: api.runtime.id }
    if (method === "lease.bind" || method === "lease.restore") {
      if (!TOKEN.test(params.profileToken ?? "") || params.profileToken !== await profileToken()) {
        throw refusal("NATIVE_PROFILE_MISMATCH", "Native lease does not match the extension profile")
      }
      controlTitle(params)
      if (typeof params.transportGeneration !== "string" || !ID.test(params.transportGeneration)) {
        throw refusal("NATIVE_GENERATION_INVALID", "Native transport generation is required")
      }
      if (leases.has(leaseId) && method !== "lease.restore") {
        throw refusal("NATIVE_LEASE_ALREADY_BOUND", "Native lease is already bound; explicit restoration is required")
      }
      const lease = {
        id: leaseId, owner: params.owner, work: params.work, transportGeneration: params.transportGeneration,
        tabs: new Map(), creates: new Map(),
      }
      const previous = leases.get(leaseId)
      if (previous && Array.from(previous.creates.values()).some(value => value.pending)) {
        throw refusal("NATIVE_CREATE_PENDING", "Exact create reconciliation is required before native restoration")
      }
      let result
      try {
        result = method === "lease.restore" ? await restore(lease, params, previous) : { bound: true }
      } catch (error) {
        if (error.code) throw error
        const reason = String(error.message ?? "").replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, "<redacted-url>")
          .replace(/[a-f0-9]{32,}/giu, "<redacted>").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 240)
        throw refusal("NATIVE_CONTROL_RESTORATION_FAILED", reason)
      }
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
        const window = await api.windows.create({ url: controlUrl(lease), focused: false, type: "popup" })
        if (!integer(window.id) || window.tabs?.length !== 1 || !integer(window.tabs[0].id)) {
          throw refusal("NATIVE_CREATE_INDETERMINATE", "Native window creation did not return exact Chrome identities")
        }
        lease.windowId = window.id
        lease.controlTabId = window.tabs[0].id
        lease.tabs.set(lease.controlTabId, { tabId: lease.controlTabId, windowId: window.id, control: true })
        await labelControl(lease)
      }
      await ownTab(lease, lease.controlTabId, true)
      const window = await api.windows.create({ url: markerUrl, focused: false, type: "popup" })
      const tab = window?.tabs?.[0]
      if (!integer(window?.id) || window.tabs?.length !== 1 || !integer(tab?.id) ||
          tab.windowId !== window.id || window.id === lease.windowId) {
        throw refusal("NATIVE_CREATE_INDETERMINATE", "Native task window creation did not return exact independent routing")
      }
      lease.tabs.set(tab.id, { tabId: tab.id, windowId: tab.windowId, sessions: new Set(), attached: false })
      let markerReady = false
      for (let attempt = 0; attempt < 60; attempt++) {
        const current = await ownTab(lease, tab.id)
        if (current.url === markerUrl && current.status === "complete" && current.title === "Desk target marker") {
          markerReady = true
          break
        }
        await delay(50)
      }
      if (!markerReady) {
        throw refusal("NATIVE_TARGET_UNREADY", "The exact recorded task marker did not confirm document readiness")
      }
      const target = await targetInfo(tab.id)
      const control = await targetInfo(lease.controlTabId)
      const result = {
        tabId: tab.id, targetId: target.id, windowId: tab.windowId, controlWindowId: lease.windowId, controlTabId: lease.controlTabId,
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
      if (lease.controlTabId !== undefined) {
        lease.targetProjection = tabs.filter(tab => !tab.control).map(tab => ({
          tabId: tab.tabId, windowId: tab.windowId, title: String(tab.title ?? "").slice(0, 240),
        }))
        await labelControl(lease)
        const control = tabs.find(tab => tab.control)
        if (control) {
          const fresh = await ownTab(lease, lease.controlTabId, true)
          control.url = fresh.url
          control.title = fresh.title
        }
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
      record.eventProcessing = (record.eventProcessing ?? Promise.resolve()).then(() =>
        ownTab(lease, source.tabId)).then(() =>
        publish({ event: "cdp", leaseId: lease.id, tabId: source.tabId, sessionId: source.sessionId, method, params }),
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
        if (request?.event === "diagnostic") {
          const context = [DIAGNOSTIC_STAGES.has(request.stage) ? request.stage : null,
            DIAGNOSTIC_SYSCALLS.has(request.syscall) ? request.syscall : null].filter(Boolean)
          const code = NATIVE_DIAGNOSTICS.has(request.code) ? request.code : "NATIVE_HOST_ERROR_UNKNOWN"
          onStatus(code + (context.length ? " [" + context.join("/") + "]" : ""))
          return
        }
        dispatch(request).then(response => {
          if (port === connected) {
            publish(response)
            if (request.method === "extension.reload.commit" && response.result?.committing === true) api.runtime.reload()
          }
          else onStatus("NATIVE_RESPONSE_UNDELIVERED")
        })
      })
      connected.onDisconnect.addListener(() => {
        const error = api.runtime.lastError
        const code = error ? NATIVE_ERRORS.get(error.message) ?? "NATIVE_HOST_ERROR_UNKNOWN" : "NATIVE_TRANSPORT_DISCONNECTED"
        if (port === connected) port = undefined
        pendingReloadToken = undefined
        if (!stopped) onStatus(code)
        retry()
      })
      publish({ event: "ready", protocolVersion: 1, extensionId: api.runtime.id, sourceDigest: SOURCE_DIGEST, profileToken: token,
        browserVersion: typeof navigator === "undefined" ? undefined : navigator.userAgent.match(/(?:Edg|Chrome)\/[\d.]+/u)?.[0],
        userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent })
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
