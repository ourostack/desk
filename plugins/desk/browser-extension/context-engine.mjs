import { maintainedComponents } from "./vendor/maintained.mjs"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const TOKEN = /^[a-f0-9]{64}$/u
const CONTEXT = new Set(["context.create", "context.resume", "context.status", "context.label", "context.discard"])
const PROVIDER = new Set(["profile.read", "extension.reload", "extension.reload.commit"])
const HOST = "com.ourostack.desk.browser"
const integer = value => Number.isSafeInteger(value) && value > 0
const INTERNAL = Symbol("bounded_native_error")
const fail = (code, resources) => Object.assign(new Error(code), { code, resources, [INTERNAL]: true })
const isInternal = error => error?.[INTERNAL] === true
const labelValid = label => typeof label === "string" && label.trim().length > 0 &&
  label.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(label)

function relayValid(value) {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return url.protocol === "ws:" && ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      integer(Number(url.port)) && Number(url.port) <= 65535 &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.startsWith("/extension/") && UUID.test(url.pathname.slice(11)) &&
      url.href === value
  } catch { return false }
}

function cdpAllowed(method, params) {
  if (typeof method !== "string") return false
  if (/^(Browser|SystemInfo|Tethering|Storage|DOMStorage|IndexedDB|CacheStorage|Database|ServiceWorker|Security|Extensions|Tracing)\./u.test(method)) return false
  if (method.startsWith("Target.") && !["Target.getTargetInfo", "Target.setAutoAttach"].includes(method)) return false
  if (method === "Target.getTargetInfo" && params?.targetId !== undefined) return false
  return !["Network.clearBrowserCache", "Network.clearBrowserCookies", "Network.getAllCookies", "Network.getCookies",
    "Network.setCookie", "Network.setCookies", "Network.deleteCookies"].includes(method)
}

/**
 * Native port is the trusted provider boundary, not a security principal for
 * hostile same-user processes. No PID, title, leaseId or MCP transport grants
 * ownership. `sourceDigest` is supplied by the immutable packaged bootstrap.
 */
export function createBrowserExtension(api, options = {}) {
  const { WebSocket: Socket = globalThis.WebSocket, sourceDigest, onStatus = () => {} } = options
  const bindings = new Map()
  const owners = new Map()
  // This is debugger-effect custody, not command authority. Revocation removes
  // owners immediately but cannot erase an in-flight attach/detach generation.
  const debuggerCustody = new Map()
  let nextDebuggerGeneration = 0
  const requests = new Set()
  const listeners = []
  let port, starting, tokenDocument, update, stopped = false
  let generation = 0
  let totalEffects = 0
  let removeDebuggerObserver
  let observerRetirementRequested = false

  function listen(target, fn) {
    target.addListener(fn)
    const remove = () => target.removeListener(fn)
    listeners.push(remove)
    return remove
  }
  function publish(message) {
    if (!port) return false
    try { port.postMessage(message); return true }
    catch { onStatus("native_transport_disconnected"); return false }
  }
  function projection(b) {
    return {
      contextId: b.id, state: b.state, label: b.label, groupId: b.groupId,
      tabs: [...b.tabs].map(([tabId, r]) => ({ tabId, windowId: r.windowId })),
      revokedTabIds: [...b.revoked.keys()],
      revokedTabs: [...b.revoked].map(([tabId, r]) => ({ tabId, windowId: r.windowId })),
      pendingEffects: b.pending,
      unconfirmedCreates: b.unconfirmedCreates,
      uncertainTabs: [...b.uncertainTabs.values()],
      groupingObligations: [...b.groupingObligations.values()],
      debuggerObservationActive: Boolean(removeDebuggerObserver),
      debuggerCustody: [...debuggerCustody.values()].filter(c => c.binding === b).map(c => ({
        tabId: c.tabId, windowId: c.record.windowId, generation: c.generation,
        state: c.state, revoked: c.revoked, ...(c.reason ? { reason: c.reason } : {}),
      })),
    }
  }
  function current(b, tabId, record) {
    return owners.get(tabId) === b && b.tabs.get(tabId) === record
  }
  function track(b, operation) {
    ++b.pending
    ++totalEffects
    return (async () => {
      try { return await operation() }
      catch (error) { throw isInternal(error) ? error : fail("native_browser_operation_failed") }
      finally { --b.pending; --totalEffects; retireStoppedDebuggerObserver() }
    })()
  }
  function retireStoppedDebuggerObserver() {
    if (!observerRetirementRequested || totalEffects !== 0 || !removeDebuggerObserver) return
    removeDebuggerObserver()
    removeDebuggerObserver = undefined
    // Retiring observation also retires generation evidence. Unknown custody
    // remains visible, never a map-only permission for later compensation.
    for (const custody of debuggerCustody.values()) {
      custody.externalBoundary = true
      unknownDebuggerCustody(custody, custody.reason ?? "native_debugger_observation_retired")
    }
  }
  function forgetDebuggerCustody(c) {
    if (debuggerCustody.get(c.tabId) !== c) return
    debuggerCustody.delete(c.tabId)
    c.record.attached = false
    c.record.sessions.clear()
  }
  function unknownDebuggerCustody(c, reason) {
    c.state = "unknown"
    c.reason = reason
    c.record.attached = false
    c.binding.state = "unavailable"
    publish({ event: "context.unavailable", contextId: c.binding.id, code: reason })
    return fail(reason)
  }
  function releaseDebuggerCustody(c) {
    if (c.releasePromise) return c.releasePromise
    // Admission fences every cooperative binding on this exact tab generation.
    // An observed external detach while attach was pending breaks our evidence
    // of that generation: never compensate by blindly detaching a new peer.
    const fenced = () => debuggerCustody.get(c.tabId) === c && !c.externalBoundary &&
      (!owners.has(c.tabId) || current(c.binding, c.tabId, c.record))
    if (!fenced() || c.state !== "attached")
      return Promise.reject(unknownDebuggerCustody(c, "native_debugger_generation_unconfirmed"))
    c.state = "detaching"
    c.record.attached = false
    c.releasePromise = track(c.binding, async () => {
      // No await between the final generation fence and the Chrome invocation.
      if (!fenced()) throw unknownDebuggerCustody(c, "native_debugger_generation_unconfirmed")
      try { await api.debugger.detach({ tabId: c.tabId }) }
      catch { throw unknownDebuggerCustody(c, "native_debugger_detach_unconfirmed") }
      forgetDebuggerCustody(c)
    })
    return c.releasePromise
  }
  function revoke(b, tabId) {
    const record = b.tabs.get(tabId)
    if (!record || owners.get(tabId) !== b) return
    owners.delete(tabId)
    b.tabs.delete(tabId)
    b.revoked.set(tabId, { windowId: record.windowId })
    b.state = "unavailable"
    const custody = debuggerCustody.get(tabId)
    if (custody?.binding === b && custody.record === record) {
      custody.revoked = true
      if (!custody.pendingAttach && custody.state === "attached")
        releaseDebuggerCustody(custody).catch(() => {}) // Named retained obligation is published above.
    }
    b.connection?.detachTab(tabId)
    publish({ event: "context.ownershipChanged", contextId: b.id, tabId })
  }
  async function own(b, tabId) {
    const record = b.tabs.get(tabId)
    if (!record || owners.get(tabId) !== b) throw fail("native_target_not_owned")
    if (record.groupUnknown) throw fail("native_group_custody_unknown")
    let tab
    try { tab = await api.tabs.get(tabId) }
    catch { throw fail("native_target_unavailable") }
    if (!current(b, tabId, record)) throw fail("native_context_ownership_changed")
    if (tab.id !== tabId || tab.windowId !== record.windowId ||
        (!record.grouping && tab.groupId !== record.groupId)) {
      revoke(b, tabId)
      throw fail("native_context_ownership_changed")
    }
    return { tab, record }
  }
  function admit(b, tab) {
    if (!integer(tab?.id) || tab.windowId !== b.windowId || owners.has(tab.id) || debuggerCustody.has(tab.id) ||
        !Number.isSafeInteger(tab.groupId) || tab.groupId < -1) throw fail("native_tab_admission_failed")
    b.tabs.set(tab.id, { windowId: tab.windowId, groupId: tab.groupId, grouping: false, groupUnknown: false, attached: false, sessions: new Set() })
    owners.set(tab.id, b)
  }
  function effectsAllowed(b) {
    if (stopped || update || b.mutating || !["creating", "ready"].includes(b.state)) throw fail("native_context_unavailable")
  }
  async function groupTabs(b, args) {
    const { tabIds, groupId } = args ?? {}
    if (!Array.isArray(tabIds) || tabIds.length !== 1 ||
        (groupId !== undefined && groupId !== b.groupId)) throw fail("native_target_not_owned")
    const tabId = tabIds[0]
    const { record } = await own(b, tabId)
    const obligation = { tabId, windowId: record.windowId, priorGroupId: record.groupId, state: "pending" }
    b.groupingObligations.set(tabId, obligation)
    record.grouping = true
    try {
      const id = await api.tabs.group({ tabIds: [tabId], ...(groupId === undefined ? {} : { groupId }) })
      if (!Number.isSafeInteger(id) || id < 0 || (b.groupId !== null && id !== b.groupId) || !current(b, tabId, record))
        throw fail("native_group_unconfirmed")
      b.groupId = id
      record.groupId = id
      obligation.attemptedGroupId = id
      const { tab } = await own(b, tabId)
      if (tab.groupId !== id) throw fail("native_group_unconfirmed")
      b.groupingObligations.delete(tabId)
      return id
    } catch (error) {
      record.groupUnknown = true
      obligation.state = "unknown"
      b.state = "unavailable"
      // A failed API/readback can have taken effect. Later queries or title
      // matches cannot turn this unknown custody into permission to discard.
      throw error
    } finally { record.grouping = false }
  }
  async function createTab(b, url) {
    effectsAllowed(b)
    // Ignore physical activation, window, opener and pinned overrides from the
    // relay. The provider already selected this existing normal window.
    ++b.unconfirmedCreates
    const tab = await api.tabs.create({ windowId: b.windowId, url, active: false })
    // Record the exact returned identity BEFORE subsequent fallible readbacks.
    try { admit(b, tab) }
    catch (error) {
      if (integer(tab?.id)) b.uncertainTabs.set(tab.id, { tabId: tab.id, windowId: tab.windowId })
      throw error
    }
    --b.unconfirmedCreates
    if (stopped || b.state === "unavailable") throw fail("native_context_unavailable")
    if ((await own(b, tab.id)).tab.active !== false) throw fail("native_inactive_tab_unconfirmed")
    if (b.group) await b.group._addTabToGroup(tab.id)
    return (await own(b, tab.id)).tab
  }
  async function closeTab(b, tabId) {
    const { record } = await own(b, tabId)
    if (!current(b, tabId, record)) throw fail("native_context_ownership_changed")
    // Chrome exposes no atomic "remove iff group/window still matches". There
    // is no await between final current-record check and remove invocation.
    await api.tabs.remove(tabId)
    const present = (await api.tabs.query({})).some(tab => tab.id === tabId)
    if (present) throw fail("native_close_unconfirmed")
    if (b.revoked.has(tabId)) throw fail("native_context_ownership_changed")
    if (owners.get(tabId) === b) { owners.delete(tabId); b.tabs.delete(tabId); b.closed.add(tabId) }
  }
  function scopedEvent(b, real, select) {
    const wrappers = new Map()
    return {
      addListener(fn) {
        const wrapper = (...args) => { if (select(...args)) fn(...args) }
        wrappers.set(fn, wrapper)
        real.addListener(wrapper)
      },
      removeListener(fn) { const wrapper = wrappers.get(fn); if (wrapper) real.removeListener(wrapper); wrappers.delete(fn) },
    }
  }
  function scopedApi(b) {
    const owned = tabId => owners.get(tabId) === b
    const scoped = {
      tabs: {
        get: tabId => track(b, async () => (await own(b, tabId)).tab),
        create: params => track(b, async () => {
          if (!params || typeof params.url !== "string") throw fail("native_relay_request_invalid")
          try { return await createTab(b, params.url) }
          catch (error) {
            b.state = "unavailable"
            publish({ event: "context.unavailable", contextId: b.id, code: "native_task_create_failed" })
            throw error
          }
        }),
        remove: tabId => track(b, () => {
          effectsAllowed(b)
          if (!integer(tabId)) throw fail("native_target_not_owned")
          return closeTab(b, tabId)
        }),
        group: args => track(b, () => groupTabs(b, args)),
        onCreated: scopedEvent(b, api.tabs.onCreated, tab => owned(tab.id) && !b.admitting.has(tab.id)),
        onRemoved: scopedEvent(b, api.tabs.onRemoved, id => b.closed.has(id)),
        onUpdated: scopedEvent(b, api.tabs.onUpdated, id => owned(id) && !b.tabs.get(id).grouping),
      },
      tabGroups: {
        async update(id, style) {
          if (id !== b.groupId) throw fail("native_group_not_owned")
          await api.tabGroups.update(id, style)
          const group = await api.tabGroups.get(id)
          if (group.id !== id || group.windowId !== b.windowId || group.title !== style.title || group.color !== style.color)
            throw fail("native_group_unconfirmed")
          return group
        },
      },
      action: Object.fromEntries(["setBadgeText", "setTitle", "setBadgeBackgroundColor"].map(method => [
        method, params => track(b, async () => { await own(b, params.tabId); return api.action?.[method]?.(params) }),
      ])),
      debugger: {
        attach: (target, version) => track(b, async () => {
          effectsAllowed(b)
          if (!target || Object.keys(target).some(key => key !== "tabId") || version !== "1.3") throw fail("native_target_not_owned")
          const { record } = await own(b, target.tabId)
          if (!current(b, target.tabId, record)) throw fail("native_target_not_owned")
          effectsAllowed(b)
          if (debuggerCustody.has(target.tabId)) throw fail("native_debugger_custody_busy")
          const custody = {
            binding: b, record, tabId: target.tabId, generation: ++nextDebuggerGeneration,
            state: "attaching", pendingAttach: true, revoked: false, externalBoundary: false,
          }
          debuggerCustody.set(target.tabId, custody)
          try { await api.debugger.attach({ tabId: target.tabId }, version) }
          catch { throw unknownDebuggerCustody(custody, custody.externalBoundary ?
            "native_debugger_generation_unconfirmed" : "native_debugger_attach_unconfirmed") }
          finally { custody.pendingAttach = false }
          if (custody.externalBoundary)
            throw unknownDebuggerCustody(custody, "native_debugger_generation_unconfirmed")
          custody.state = "attached"
          try {
            await own(b, target.tabId)
            if (custody.revoked || stopped || debuggerCustody.get(target.tabId) !== custody)
              throw fail("native_target_not_owned")
          } catch (error) {
            b.state = "unavailable"
            await releaseDebuggerCustody(custody)
            throw error
          }
          record.attached = true
        }),
        detach: target => track(b, async () => {
          const { record } = await own(b, target?.tabId)
          if (target?.sessionId || target?.targetId) throw fail("native_target_not_owned")
          const custody = debuggerCustody.get(target.tabId)
          if (!custody) return
          if (custody.binding !== b || custody.record !== record) throw fail("native_debugger_custody_busy")
          await releaseDebuggerCustody(custody)
        }),
        sendCommand: (target, method, params = {}) => track(b, async () => {
          effectsAllowed(b)
          if (!target || Object.keys(target).some(key => !["tabId", "sessionId"].includes(key)) || !cdpAllowed(method, params))
            throw fail("native_cdp_method_denied")
          const { record } = await own(b, target.tabId)
          if (!record.attached || (target.sessionId !== undefined && !record.sessions.has(target.sessionId)))
            throw fail("native_session_not_owned")
          // A logical selection acknowledgment, not a physical Chrome action.
          if (method === "Page.bringToFront") return {}
          const result = await api.debugger.sendCommand({ tabId: target.tabId, ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }) }, method, params)
          await own(b, target.tabId)
          return result ?? {}
        }),
        onEvent: scopedEvent(b, api.debugger.onEvent, source => owned(source.tabId) &&
          (source.sessionId === undefined || b.tabs.get(source.tabId).sessions.has(source.sessionId))),
        onDetach: scopedEvent(b, api.debugger.onDetach, source => owned(source.tabId)),
      },
    }
    return scoped
  }

  listen(api.tabs.onUpdated, (tabId, changes, tab) => {
    const b = owners.get(tabId), record = b?.tabs.get(tabId)
    if (record && (tab.windowId !== record.windowId ||
        (changes.groupId !== undefined && !record.grouping && tab.groupId !== record.groupId))) revoke(b, tabId)
  })
  if (api.tabs.onDetached) listen(api.tabs.onDetached, tabId => {
    const b = owners.get(tabId)
    if (b) revoke(b, tabId)
  })
  listen(api.tabs.onRemoved, tabId => {
    const custody = debuggerCustody.get(tabId)
    // An already settled attachment cannot survive its exact target's removal.
    // Do not erase a pending effect or unknown generation on an earlier event.
    if (custody?.state === "attached" && !custody.pendingAttach) forgetDebuggerCustody(custody)
    const b = owners.get(tabId)
    if (!b) return
    owners.delete(tabId)
    b.tabs.delete(tabId)
    b.closed.add(tabId)
  })
  listen(api.debugger.onEvent, (source, method, params) => {
    const b = owners.get(source.tabId), record = b?.tabs.get(source.tabId)
    if (!record?.attached || (source.sessionId !== undefined && !record.sessions.has(source.sessionId))) return
    if (method === "Target.attachedToTarget" && typeof params?.sessionId === "string") record.sessions.add(params.sessionId)
    if (method === "Target.detachedFromTarget") record.sessions.delete(params?.sessionId)
  })
  removeDebuggerObserver = listen(api.debugger.onDetach, source => {
    const custody = debuggerCustody.get(source.tabId)
    if (custody?.pendingAttach) {
      custody.externalBoundary = true
      custody.reason = "native_debugger_generation_unconfirmed"
    } else if (custody?.state === "attached") forgetDebuggerCustody(custody)
    // A detach API response, not this bare-tabId event, settles "detaching".
    // An unknown generation is never silently recovered from a later event.
    const b = owners.get(source.tabId), record = b?.tabs.get(source.tabId)
    if (record) { record.attached = false; record.sessions.clear() }
  })
  listen(api.tabs.onCreated, tab => {
    const b = owners.get(tab.openerTabId)
    if (!b || b.state !== "ready" || b.mutating || update || stopped || tab.active !== false ||
        tab.windowId !== b.windowId || tab.groupId !== -1 || !/^(https?:|about:blank$)/u.test(tab.url ?? "")) return
    // Supported opener admission is exact, current, same-window and inactive.
    // A foreign/manual group member without that opener is never adopted.
    try { admit(b, tab) }
    catch {
      b.state = "unavailable"
      b.uncertainTabs.set(tab.id, { tabId: tab.id, windowId: tab.windowId })
      publish({ event: "context.unavailable", contextId: b.id, code: "native_tab_admission_failed" })
      return
    }
    b.admitting.add(tab.id)
    track(b, async () => {
      await own(b, tab.openerTabId)
      await b.group._addTabToGroup(tab.id)
      b.admitting.delete(tab.id)
      b.connection.attachTab((await own(b, tab.id)).tab)
    }).catch(() => {
      b.state = "unavailable"
      publish({ event: "context.unavailable", contextId: b.id, code: "native_opener_admission_failed" })
    })
  })

  async function ensureTokenDocument() {
    if (tokenDocument) return tokenDocument
    tokenDocument = (async () => {
      const url = api.runtime.getURL("token.html")
      const contexts = await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })
      if (contexts.length === 0) await api.offscreen.createDocument({
        url: "token.html", reasons: ["LOCAL_STORAGE"],
        justification: "Bind the browser's extension storage partition to the declared Desk profile.",
      })
      else if (contexts.length !== 1 || contexts[0].documentUrl !== url) throw fail("native_token_document_invalid")
    })()
    try { await tokenDocument } finally { tokenDocument = undefined }
  }
  async function profileToken() {
    await ensureTokenDocument()
    const response = await api.runtime.sendMessage({ type: "desk-profile-token" })
    if (!TOKEN.test(response?.token ?? "")) throw fail("native_profile_token_invalid")
    return response.token
  }
  async function authorize(params) {
    if (!TOKEN.test(params.profileToken ?? "") || params.profileToken !== await profileToken()) throw fail("native_profile_mismatch")
    if (!TOKEN.test(sourceDigest ?? "") || params.sourceDigest !== sourceDigest) throw fail("native_source_mismatch")
  }
  async function openSocket(url) {
    if (options.openSocket) return options.openSocket(url)
    const socket = new Socket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(fail("native_relay_unavailable")) }, 5000)
      socket.onopen = () => { clearTimeout(timer); resolve() }
      socket.onerror = () => { clearTimeout(timer); socket.close(); reject(fail("native_relay_unavailable")) }
    })
    return socket
  }
  async function createContext(contextId, params) {
    if (bindings.has(contextId)) throw fail("native_context_duplicate")
    if (update) throw fail("native_update_pending")
    if (!labelValid(params.label) || !relayValid(params.relayUrl)) throw fail("native_context_parameters_invalid")
    const b = {
      id: contextId, label: params.label, state: "creating", groupId: null,
      tabs: new Map(), revoked: new Map(), closed: new Set(), uncertainTabs: new Map(), groupingObligations: new Map(), admitting: new Set(), pending: 0, unconfirmedCreates: 0, mutating: false,
    }
    bindings.set(contextId, b)
    try {
      await track(b, async () => {
        const windows = await api.windows.getAll({ windowTypes: ["normal"] })
        const window = windows.find(window => window.type === "normal" && window.incognito !== true && integer(window.id))
        if (!window) throw fail("native_normal_window_unavailable")
        b.windowId = window.id
        const tab = await createTab(b, "about:blank")
        const components = maintainedComponents(scopedApi(b), Socket)
        const socket = await openSocket(params.relayUrl)
        if (socket.readyState !== Socket.OPEN) { socket.close(); throw fail("native_relay_unavailable") }
        if (stopped) { socket.close(); throw fail("native_context_unavailable") }
        const connection = new components.RelayConnection(socket)
        b.connection = connection
        const style = components.uniqueGroupStyle(b.label, [...bindings.values()].filter(other => other !== b && other.group).map(other => other.group.groupStyle))
        b.group = new components.ConnectedTabGroup(connection, tab, b.label, { ...style, title: b.label }, id => owners.get(id) !== b)
        b.group.onclose = () => {
          if (b.state !== "unavailable") b.state = "disconnected"
          publish({ event: "context.disconnected", contextId: b.id })
        }
        b.group.onfailure = () => { b.state = "unavailable"; publish({ event: "context.unavailable", contextId: b.id, code: "native_group_unconfirmed" }) }
        await b.group.initialize(tab)
        if (b.state !== "creating" || socket.readyState !== Socket.OPEN) throw fail("native_relay_unavailable")
        if ((await own(b, tab.id)).tab.active !== false) throw fail("native_inactive_tab_unconfirmed")
        b.state = "ready"
      })
      return projection(b)
    } catch (error) {
      b.state = "unavailable"
      b.connection?.close("native_context_unavailable")
      throw fail(isInternal(error) ? error.code : "native_context_create_failed", projection(b))
    }
  }
  async function discard(b) {
    if (b.pending || b.mutating || b.state === "creating") throw fail("native_context_busy", projection(b))
    if ([...debuggerCustody.values()].some(c => c.binding === b && c.state !== "attached"))
      throw fail("native_debugger_cleanup_unconfirmed", projection(b))
    if (b.unconfirmedCreates || b.uncertainTabs.size || b.groupingObligations.size) throw fail("native_cleanup_unconfirmed", projection(b))
    if (b.revoked.size) throw fail("native_context_ownership_changed", projection(b))
    b.mutating = true
    const closedTabIds = [], ids = [...b.tabs.keys()]
    try {
      // Preflight every current member before any removal. Revalidate again at
      // each exact remove boundary; never close a stale candidate set.
      for (const id of ids) await own(b, id)
      for (const id of ids) {
        await closeTab(b, id)
        closedTabIds.push(id)
      }
      const present = await api.tabs.query({})
      if (ids.some(id => present.some(tab => tab.id === id)) || b.tabs.size || b.revoked.size) throw fail("native_close_unconfirmed")
      b.connection?.close("native_context_discarded")
      bindings.delete(b.id)
      return { contextId: b.id, discarded: true, closedTabIds, absentTabIds: ids }
    } catch (error) {
      b.state = "unavailable"
      throw fail((isInternal(error) && error.code === "native_context_ownership_changed") || b.revoked.size ? "native_context_ownership_changed" : "native_discard_incomplete",
        { ...projection(b), closedTabIds, remainingTabIds: [...b.tabs.keys()] })
    } finally { b.mutating = false }
  }
  async function invoke(request) {
    const { method, contextId, params = {} } = request
    if (stopped) throw fail("native_extension_stopped",
      method === "context.status" && bindings.has(contextId) ? projection(bindings.get(contextId)) : undefined)
    if (method === "profile.read") {
      const token = await profileToken()
      if (params.profileToken !== undefined && params.profileToken !== token) throw fail("native_profile_mismatch")
      if (params.sourceDigest !== undefined && params.sourceDigest !== sourceDigest) throw fail("native_source_mismatch")
      return { profileToken: token, extensionId: api.runtime.id, sourceDigest }
    }
    await authorize(params)
    if (stopped) throw fail("native_extension_stopped")
    if (PROVIDER.has(method)) {
      if (requests.size !== 1 || totalEffects || debuggerCustody.size || [...bindings.values()].some(b => b.tabs.size || b.revoked.size || b.pending || b.unconfirmedCreates || b.uncertainTabs.size || b.groupingObligations.size || b.mutating || b.state === "creating"))
        throw fail("native_update_effects_pending")
      if (!TOKEN.test(params.updateToken ?? "") || (method.endsWith(".commit") && (!update || params.updateToken !== update.token || update.committing)))
        throw fail("native_update_token_invalid")
      if (method.endsWith(".commit")) { update.committing = true; return { committing: true } }
      if (update) throw fail("native_update_pending")
      update = { token: params.updateToken, committing: false }
      return { reload: true }
    }
    if (method === "context.create") return createContext(contextId, params)
    const b = bindings.get(contextId)
    if (!b) throw fail("native_context_unavailable")
    if (method === "context.discard") return discard(b)
    for (const id of b.tabs.keys()) {
      try { await own(b, id) } catch { b.state = "unavailable" }
    }
    if (method === "context.status") return projection(b)
    if (b.state !== "ready" || b.revoked.size || b.tabs.size === 0) throw fail("native_context_unavailable", projection(b))
    if (method === "context.resume") return projection(b)
    if (!labelValid(params.label)) throw fail("native_context_parameters_invalid")
    if (b.mutating || b.pending || update) throw fail("native_context_busy")
    b.mutating = true
    try {
      await scopedApi(b).tabGroups.update(b.groupId, { ...b.group.groupStyle, title: params.label })
      if (b.state !== "ready" || b.revoked.size) throw fail("native_context_ownership_changed")
      b.label = params.label
      b.group.groupStyle.title = params.label
      return projection(b)
    } catch (error) {
      b.state = "unavailable"
      throw fail(isInternal(error) ? error.code : "native_group_unconfirmed", projection(b))
    } finally { b.mutating = false }
  }
  async function dispatch(request) {
    const id = request?.id
    if (!CONTEXT.has(request?.method) && !PROVIDER.has(request?.method))
      return { id, error: { code: "native_method_denied", message: "Unsupported native method" } }
    if (typeof id !== "string" || !ID.test(id) ||
        !request.params || typeof request.params !== "object" || Array.isArray(request.params) ||
        (CONTEXT.has(request.method) && (typeof request.contextId !== "string" || !UUID.test(request.contextId))) ||
        (PROVIDER.has(request.method) && Object.hasOwn(request, "contextId")) ||
        (request.leaseId !== undefined && (typeof request.leaseId !== "string" || !ID.test(request.leaseId))))
      return { id, error: { code: "native_request_invalid", message: "Invalid request scope" } }
    if (requests.has(id) || requests.size >= 256) return { id, error: { code: "native_request_busy", message: "Duplicate or too many native requests" } }
    requests.add(id)
    try { return { id, result: await invoke(request) } }
    catch (error) {
      const code = isInternal(error) ? error.code : "native_operation_failed"
      return { id, error: { code, message: code, ...(isInternal(error) && error.resources ? { resources: error.resources } : {}) } }
    } finally { requests.delete(id) }
  }
  async function start() {
    if (stopped) throw fail("native_extension_stopped")
    if (port) return
    if (starting) return starting
    const epoch = ++generation
    starting = (async () => {
      if (!TOKEN.test(sourceDigest ?? "")) throw fail("native_source_mismatch")
      const token = await profileToken()
      if (stopped || epoch !== generation) throw fail("native_extension_stopped")
      const connected = api.runtime.connectNative(HOST)
      port = connected
      connected.onMessage.addListener(request => {
        if (port !== connected || stopped) { onStatus("native_request_stale"); return }
        if (request?.event === "diagnostic") { onStatus("native_provider_diagnostic"); return }
        dispatch(request).then(response => {
          if (port !== connected) { onStatus("native_response_undelivered"); return }
          const sent = publish(response)
          if (sent && request.method === "extension.reload.commit" && response.result?.committing === true) api.runtime.reload()
        })
      })
      connected.onDisconnect.addListener(() => {
        // Never log native lastError: it can contain provider/credential state.
        if (port === connected) { port = undefined; update = undefined; onStatus("native_transport_disconnected") }
      })
      publish({ event: "ready", protocolVersion: 1, extensionId: api.runtime.id, sourceDigest, profileToken: token,
        browserVersion: globalThis.navigator?.userAgent?.match(/(?:Edg|Chrome)\/[\d.]+/u)?.[0],
        userAgent: globalThis.navigator?.userAgent })
    })()
    try { await starting } finally { starting = undefined }
  }
  function stop() {
    stopped = true
    ++generation
    const connected = port
    port = undefined
    update = undefined
    connected?.disconnect()
    for (const b of bindings.values()) {
      b.connection?.close("native_extension_stopped")
      for (const id of b.tabs.keys()) revoke(b, id)
    }
    for (const remove of listeners.splice(0)) {
      if (remove !== removeDebuggerObserver) remove()
    }
    // Ordinary listeners/command authority retire now; generation observation
    // outlives stop only while already-issued effects can still compensate.
    observerRetirementRequested = true
    retireStoppedDebuggerObserver()
  }
  return Object.freeze({ dispatch, start, stop })
}
