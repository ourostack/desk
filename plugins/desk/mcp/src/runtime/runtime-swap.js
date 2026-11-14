// Keeps a long-running Desk server current. A host keeps one MCP server per project folder for days and routes every new chat to
// it, so the release the server loaded when it started (src/runtime/newest-release.js) goes stale. This watcher checks the
// `release` channel on a call, in the background, prepares the newer runtime beside the serving one, and hands it to the caller,
// which swaps it in between calls. A call already running finishes on the code it started with.
//
// Nothing here blocks a call or throws: a check or load that fails leaves the serving runtime in place and records why, so
// `desk_status` and the browser's replies can say so (`runtime.refresh`).

/** At most one check this often, however many calls arrive. */
export const REFRESH_INTERVAL_MS = 10 * 60 * 1000
/** `desk_status` is how an agent asks "is Desk current?", so it may check this often. */
const STATUS_REFRESH_INTERVAL_MS = 30 * 1000

const SWITCH = "DESK_RUNTIME_REFRESH"

const short = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 120)

/** Why refreshing is off, or null. `DESK_RUNTIME_REFRESH=0` turns it off; `DESK_RUNTIME_REFRESH_MINUTES` sets the interval. */
function refreshSwitch(env) {
  return String(env[SWITCH] ?? "").trim() === "0" ? `${SWITCH}=0` : null
}

export function refreshIntervalMs(env) {
  const minutes = Number(env.DESK_RUNTIME_REFRESH_MINUTES)
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60 * 1000) : REFRESH_INTERVAL_MS
}

/**
 * `prepare({ running })` finds out whether a newer release exists and, if so, has it loaded: it resolves to one of
 * - `{ state: "not_applicable", reason }`: this install does not follow the release channel
 * - `{ state: "current", latest }`
 * - `{ state: "failed", latest, reason }`: a fetch or load that did not finish; the serving runtime stays
 * - `{ state: "ready", latest, loaded }`: `loaded` is what the caller swaps in (`{ runtimeServer, runtimeStatus }`)
 */
export function createRuntimeRefresher({ prepare, env = process.env, now = Date.now, intervalMs = refreshIntervalMs(env), log = () => {} }) {
  const disabled = refreshSwitch(env)
  let checking = null
  let checkedAt = null
  let startedAt = null
  let pending = null
  let outcome = disabled === null ? { state: "idle" } : { state: "not_applicable", reason: disabled }
  let swap = null

  const iso = () => new Date(now()).toISOString()

  async function check(running) {
    try {
      const result = await prepare({ running })
      checkedAt = iso()
      if (result.state === "ready") {
        pending = { loaded: result.loaded, latest: result.latest }
        outcome = { state: "ready_to_swap", latest: result.latest }
      } else {
        outcome = { state: result.state, latest: result.latest, reason: result.reason }
      }
    } catch (error) {
      checkedAt = iso()
      outcome = { state: "failed", reason: `the check threw (${short(error)})` }
    }
    if (outcome.state === "failed") log(`runtime refresh failed: ${outcome.reason}; the serving runtime stays`)
  }

  return {
    /** Starts a background check when none is running and the last one is older than the interval (`soon`: the shorter one for a caller asking whether Desk is current). Returns whether one started. */
    poke({ running, soon = false } = {}) {
      if (disabled !== null || checking !== null || pending !== null) return false
      if (startedAt !== null && now() - startedAt < (soon ? Math.min(intervalMs, STATUS_REFRESH_INTERVAL_MS) : intervalMs)) return false
      startedAt = now()
      outcome = { ...outcome, state: "checking" }
      checking = check(running).finally(() => { checking = null })
      return true
    },
    /** The prepared runtime, once; the caller swaps it in and then calls `swapped`. */
    take() {
      const taken = pending
      pending = null
      return taken
    },
    /** A prepared runtime that could not be swapped in (the caller refused or failed): the serving one stays, and the next check retries. */
    abandoned(reason, latest) {
      outcome = { state: "failed", latest, reason }
      startedAt = null
      log(`runtime refresh failed: ${reason}; the serving runtime stays`)
    },
    swapped({ from, to }) {
      swap = { swapped_at: iso(), from }
      outcome = { state: "swapped", latest: to }
    },
    /** True while a prepared runtime waits for the next call to swap it in. */
    get ready() { return pending !== null },
    /** Resolves when the running check, if any, is done. */
    idle() { return checking ?? Promise.resolve() },
    /** What `runtime` reports about refreshing: the last check, and the last swap (`swapped_at`, `from`). */
    describe() {
      return {
        refresh: { ...outcome, ...(checkedAt === null ? {} : { checked_at: checkedAt }) },
        ...(swap === null ? {} : { swapped_at: swap.swapped_at, from: swap.from }),
      }
    },
  }
}
