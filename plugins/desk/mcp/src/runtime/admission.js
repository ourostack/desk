// The background admission state machine.
//
// Desk answers the MCP handshake first. Everything that can fail (root resolution, activation, the runtime pack, write authority, the state branch and the readiness controller) runs afterwards, as attempts of this machine. Its state is `admitting` until the first attempt settles, then `ready` or `degraded:<code>`.
//
// A degraded machine retries on its own: after 1, 2, 5, 10 and 30 s, then every 60 s. `refresh()` (called on every desk_status, on a .git/HEAD change and before a gated tool) retries at once. A ready machine re-checks its controller every 60 s, and `degrade()` lets a caller report a loss (for example a controller that stopped answering), which starts re-admission at once. No state ever needs a restart, and the tool list never changes.

export const ADMISSION_BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10000, 30000])
export const ADMISSION_STEADY_MS = 60000

/** The wait before retry number `failures` (1-based). */
export function admissionRetryDelay(failures) {
  return ADMISSION_BACKOFF_MS[failures - 1] ?? ADMISSION_STEADY_MS
}

const defaultTimers = {
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (timer) => clearTimeout(timer),
}

/**
 * `attempt(context)` runs one admission attempt. It may update `context` as it goes, so tools can use what is already admitted (for example the runtime and root) while the rest is still running. It resolves with an outcome: `{ state: "ready", repair? }` or `{ state: "degraded", code, fix, summary, blockers?, diagnostic?, repair? }`. A thrown error becomes `degraded:admission_exception`.
 * `check(context)` (optional) runs every 60 s while ready and resolves with an outcome or null when all is well.
 * `onTransition(snapshot)` fires whenever the state, code or repair changes.
 */
export function createAdmission({
  attempt,
  check = null,
  onTransition = () => {},
  timers = defaultTimers,
  now = Date.now,
  context = {},
}) {
  let current = {
    state: "admitting",
    code: null,
    fix: null,
    summary: "Desk is starting: the handshake is complete and admission is running in the background.",
    repair: null,
    blockers: [],
    diagnostic: null,
    attempts: 0,
    failures: 0,
    since: new Date(now()).toISOString(),
    next_retry_at: null,
  }
  let running = null
  let timer = null
  let disposed = false

  function schedule(ms, work) {
    if (timer !== null) timers.clearTimeout(timer)
    timer = timers.setTimeout(() => {
      timer = null
      work()
    }, ms)
    current = { ...current, next_retry_at: new Date(now() + ms).toISOString() }
  }

  function settle(outcome) {
    const previous = current
    const ready = outcome.state === "ready"
    const failures = ready ? 0 : previous.failures + 1
    current = {
      state: ready ? "ready" : `degraded:${outcome.code}`,
      code: ready ? null : outcome.code,
      fix: ready ? null : outcome.fix ?? null,
      summary: outcome.summary ?? (ready ? "Desk is admitted: reads and writes are available." : null),
      // A repair is reported until a later attempt makes one of its own.
      repair: outcome.repair ?? previous.repair,
      blockers: outcome.blockers ?? [],
      diagnostic: outcome.diagnostic ?? null,
      attempts: previous.attempts + 1,
      failures,
      since: previous.state === (ready ? "ready" : `degraded:${outcome.code}`) ? previous.since : new Date(now()).toISOString(),
      next_retry_at: null,
    }
    if (!disposed) {
      if (ready) {
        if (check !== null) schedule(ADMISSION_STEADY_MS, runCheck)
      } else {
        schedule(admissionRetryDelay(failures), run)
      }
    }
    if (previous.state !== current.state || previous.code !== current.code || previous.repair !== current.repair) {
      onTransition(snapshot())
    }
    return current
  }

  function run() {
    if (disposed) return Promise.resolve(snapshot())
    if (running) return running
    if (timer !== null) {
      timers.clearTimeout(timer)
      timer = null
    }
    running = Promise.resolve()
      .then(() => attempt(context))
      .catch((error) => exceptionOutcome(error))
      .then((outcome) => {
        running = null
        settle(outcome)
        return snapshot()
      })
    return running
  }

  function runCheck() {
    return Promise.resolve()
      .then(() => check(context))
      .catch((error) => exceptionOutcome(error))
      .then((outcome) => {
        if (outcome) degrade(outcome)
        else if (!disposed && current.state === "ready") schedule(ADMISSION_STEADY_MS, runCheck)
      })
  }

  function degrade(outcome) {
    if (disposed) return Promise.resolve(snapshot())
    settle({ ...outcome, state: "degraded" })
    // Re-admission starts at once; if it fails, the backoff continues from the failure count.
    return run()
  }

  // Report a failure without re-admitting at once: the state shows it, and the next attempt comes on the backoff (or on desk_status).
  function fail(outcome) {
    if (disposed) return snapshot()
    return settle({ ...outcome, state: "degraded" }) && snapshot()
  }

  /** Run an attempt now unless one is running (then join it), and wait for it at most `waitMs`. A ready machine answers at once unless `force` asks for a fresh check. */
  async function refresh({ waitMs = 3000, force = false } = {}) {
    if (!force && current.state === "ready" && !running) return snapshot()
    const attemptDone = run()
    let waitTimer = null
    const timeout = new Promise((resolve) => {
      waitTimer = timers.setTimeout(resolve, waitMs)
    })
    await Promise.race([attemptDone, timeout])
    timers.clearTimeout(waitTimer)
    return snapshot()
  }

  /** Wait until no attempt is running (at most `waitMs`). */
  async function idle({ waitMs = 10000 } = {}) {
    if (!running) return snapshot()
    return refresh({ waitMs })
  }

  function snapshot() {
    return { ...current, blockers: [...current.blockers] }
  }

  return {
    context,
    start: run,
    refresh,
    idle,
    degrade,
    fail,
    snapshot,
    get running() {
      return running !== null
    },
    dispose() {
      disposed = true
      if (timer !== null) timers.clearTimeout(timer)
      timer = null
    },
  }
}

export function exceptionOutcome(error) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    state: "degraded",
    code: "admission_exception",
    summary: `Desk hit an unexpected error while admitting: ${message}`,
    fix: "Desk retries admission in the background (after 1, 2, 5, 10 and 30 s, then every 60 s); call desk_status to retry now. If the same message persists, fix the cause it names, or run desk_doctor and report it.",
    diagnostic: {
      observed: {
        name: error instanceof Error ? error.name : "unknown",
        message,
        ...(typeof error?.code === "string" ? { failure_code: error.code } : {}),
      },
    },
  }
}
