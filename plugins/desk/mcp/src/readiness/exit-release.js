// Release this process's readiness controllers whenever the process ends normally, so a root is never left with an owner record and socket file that name a process that has gone.
//
// A Desk session ends when the host closes stdin (Desk then exits), on SIGTERM or SIGINT, or when nothing is left to run. Each of these runs the registered releases synchronously: `exit` and `beforeExit` directly, and a signal before the process ends. A release removes only files that are still this process's own (controller-server.js checks the owner record's PID, start time and token).
//
// A signal Desk handles alone keeps its usual meaning: after the releases, Desk removes its own listeners and raises the signal again, so the process ends the way it would have without them. An active host signal handler may keep the process running, so its controllers retain ownership and their exit hooks until the host actually exits or closes them.

const EVENTS = ["exit", "beforeExit"]
const SIGNALS = ["SIGTERM", "SIGINT"]

/** A registry of release callbacks bound to `proc`'s end events. `register(release)` returns a function that removes it. */
export function createExitRelease(proc = process) {
  const releases = new Set()
  const listeners = new Map()

  function releaseAll() {
    for (const release of [...releases]) {
      try {
        release()
      } catch {
        // One release that fails never stops the others, and never stops the process from ending.
      }
    }
  }

  function uninstall() {
    for (const [event, listener] of listeners) proc.removeListener(event, listener)
    listeners.clear()
  }

  function install() {
    for (const event of EVENTS) listeners.set(event, releaseAll)
    for (const signal of SIGNALS) {
      listeners.set(signal, () => {
        // Counted first: a release that unregisters the last controller removes this listener too.
        const listenerCount = proc.listenerCount(signal)
        const alone = listenerCount === 1
        // signal-exit v3 shares its passive observer count across copies; every other listener may retain the host.
        const passiveObservers = proc.__signal_exit_emitter__?.count ?? 0
        if (!alone && listenerCount !== passiveObservers + 1) return
        releaseAll()
        releases.clear()
        uninstall()
        if (alone) proc.kill(proc.pid, signal)
      })
    }
    for (const [event, listener] of listeners) {
      // Passive exit observers must see Desk's listener removed before deciding whether to re-raise the signal.
      if (SIGNALS.includes(event)) proc.prependListener(event, listener)
      else proc.on(event, listener)
    }
  }

  return {
    register(release) {
      if (releases.size === 0 && listeners.size === 0) install()
      releases.add(release)
      return () => {
        releases.delete(release)
        if (releases.size === 0) uninstall()
      }
    },
    size: () => releases.size,
  }
}

export const exitRelease = createExitRelease()
