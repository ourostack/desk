import { createBrowserExtension } from "./context-engine.mjs"
import { SOURCE_DIGEST } from "./source-digest.mjs"

// Local, bounded policy, not operator configuration or an MV3 wake guarantee.
const RETRY_DELAYS_MS = Object.freeze([0, 250, 1000])
const BURST_DEADLINE_MS = 5000

export function createBackground(api, { timers = globalThis, onStatus = code => {
  if (!["native_transport_connected", "native_transport_confirmed", "native_extension_stopped"].includes(code)) console.error(code)
}, ...options } = {}) {
  let terminal = false, connected = false, active = false, inFlight = false
  let attempt = 0, epoch = 0, retryTimer, deadlineTimer

  function finish(unavailable = false) {
    active = false
    if (retryTimer !== undefined) timers.clearTimeout(retryTimer)
    if (deadlineTimer !== undefined) timers.clearTimeout(deadlineTimer)
    retryTimer = deadlineTimer = undefined
    if (unavailable) onStatus("native_host_unavailable")
  }
  function schedule() {
    if (terminal || connected || !active || inFlight || retryTimer !== undefined) return
    if (attempt === RETRY_DELAYS_MS.length) { finish(true); return }
    const current = epoch
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined
      if (terminal || connected || !active || current !== epoch) return
      ++attempt
      inFlight = true
      Promise.resolve().then(() => engine.start()).catch(() => {
        // Fixed exhaustion status, never native exception/credential output.
      }).finally(() => {
        inFlight = false
        schedule()
      })
    }, RETRY_DELAYS_MS[attempt])
  }
  function begin(resetBudget) {
    if (terminal || connected || active) return
    active = true
    if (resetBudget) attempt = 0
    const current = ++epoch
    deadlineTimer = timers.setTimeout(() => {
      if (active && epoch === current) finish(true)
    }, BURST_DEADLINE_MS)
    schedule()
  }
  function start() { begin(true) }
  const engine = createBrowserExtension(api, {
    ...options, sourceDigest: options.sourceDigest ?? SOURCE_DIGEST,
    onStatus(code) {
      if (code === "native_transport_connected") { connected = true; finish() }
      else if (code === "native_transport_confirmed") { connected = true; attempt = 0; finish() }
      else if (code === "native_transport_disconnected") { connected = false; start() }
      else if (code === "native_transport_failed") { connected = false; begin(false) }
      else if (code === "native_extension_stopped") {
        terminal = true
        connected = false
        finish()
        api.runtime.onInstalled.removeListener(installed)
        api.runtime.onStartup.removeListener(startup)
      }
      onStatus(code)
    },
  })
  function installed(details) { engine.observeActivation("installed", details); start() }
  function startup() { engine.observeActivation("startup"); start() }
  api.runtime.onInstalled.addListener(installed)
  api.runtime.onStartup.addListener(startup)
  start()
  return engine
}

export const extension = typeof chrome === "undefined" ? undefined : createBackground(chrome)
