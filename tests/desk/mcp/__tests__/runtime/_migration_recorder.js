import { spawn as spawnChild, execFile as execFileChild } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { MIGRATION_RECORDER_MARKER, RECORDER_MAX_BYTES, RECORDER_MAX_EVENTS } from "../../../../../.github/scripts/migration-recorder.mjs"

export { MIGRATION_RECORDER_MARKER }
const hash = (value) => createHash("sha256").update(value).digest("hex")
const streamFacts = () => ({ endObserved: false, closeObserved: false })
const processFacts = () => ({ spawnObserved: false, exitObserved: false, closeObserved: false, stdout: streamFacts(), stderr: streamFacts() })

// Each instance belongs to one test. No data listeners, global logger changes, extra timers or native operations.
export function createMigrationRecorder({ context, cases, diagnostic, now = () => performance.now(), maxEvents = RECORDER_MAX_EVENTS }) {
  const started = now()
  const events = []
  const calls = []
  const environments = new Map()
  const directories = new Map()
  const identity = (registry, value) => {
    if (!registry.has(value)) registry.set(value, registry.size + 1)
    return registry.get(value)
  }
  let next = 0
  let bytes = 0
  let qualification = "QUALIFIED"
  let reason = null
  let overflow = false
  let published = false
  const record = (label, event, details = {}) => {
    if (overflow) return
    const elapsed = now() - started
    const previous = events.at(-1)?.ms ?? 0
    if (!Number.isFinite(elapsed) || elapsed < previous) {
      qualification = "UNQUALIFIED"
      reason ??= "clock-invalid"
    }
    const entry = { n: events.length + 1, ms: Number.isFinite(elapsed) && elapsed >= previous ? elapsed : previous, case: label, event, ...details }
    const size = Buffer.byteLength(JSON.stringify(entry))
    if (events.length >= maxEvents - 1 || bytes + size > RECORDER_MAX_BYTES - 1024) {
      qualification = "UNQUALIFIED"
      reason = events.length >= maxEvents - 1 ? "event-limit" : "byte-limit"
      events.push({ n: events.length + 1, ms: entry.ms, case: "context", event: "overflow", reason })
      overflow = true
      return
    }
    events.push(entry)
    bytes += size + 1
  }
  const unqualified = (label, why) => {
    qualification = "UNQUALIFIED"
    reason ??= why
    record(label, "unqualified", { reason: why })
  }
  const makeCall = (block, options, helperObserved) => {
    const spec = cases[next++]
    const label = spec?.label ?? "context"
    if (spec === undefined) unqualified(label, "unexpected-case")
    const facts = {
      child: processFacts(),
      helper: helperObserved ? { ...processFacts(), entryObserved: false, returnObserved: false, callbackObserved: false, callbackReturnedObserved: false } : "UNOBSERVED",
    }
    const call = { label, facts, restorers: [], source: undefined, temporary: false }
    calls.push(call)
    call.sourceSeen = (text) => {
      const sourceSha256 = hash(text)
      const sourceMatched = spec?.source === undefined ? "UNOBSERVED" : sourceSha256 === hash(spec.source)
      record(label, "case", {
        sourceSha256, sourceMatched, timeoutMs: options?.timeoutMs ?? "UNOBSERVED",
      })
      if (sourceMatched === false) unqualified(label, "source-mismatch")
    }
    if (block !== undefined) call.sourceSeen(block)
    const patch = (object, key, wrapper) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      const original = object[key]
      try {
        Object.defineProperty(object, key, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: wrapper(original) })
        call.restorers.push(() => {
          if (descriptor === undefined) delete object[key]
          else Object.defineProperty(object, key, descriptor)
        })
      } catch {
        unqualified(label, "unpatchable-handle")
      }
    }
    const watch = (child, role) => {
      patch(child, "emit", (emit) => function (event, ...args) {
        if (event === "spawn" || event === "exit" || event === "close") {
          facts[role][`${event}Observed`] = true
          record(label, `${role}-${event}`)
        }
        return Reflect.apply(emit, this, [event, ...args])
      })
      for (const stream of ["stdout", "stderr"]) {
        patch(child[stream], "emit", (emit) => function (event, ...args) {
          if (event === "end" || event === "close") {
            facts[role][stream][`${event}Observed`] = true
            record(label, `${role}-${stream}-${event}`)
          }
          return Reflect.apply(emit, this, [event, ...args])
        })
        patch(child[stream], "destroy", (destroy) => function (...args) {
          record(label, "destroy-entry", { stream: `${role}.${stream}`, facts: JSON.parse(JSON.stringify(facts)) })
          return Reflect.apply(destroy, this, args)
        })
      }
      return child
    }
    call.spawn = (spawn) => function (...args) {
      const [command, argv, settings] = args
      record(label, "spawn-entry", {
        commandSha256: hash(command), argsSha256: hash(JSON.stringify(argv)),
        options: {
          detached: settings.detached, stdio: [...settings.stdio], windowsHide: settings.windowsHide,
          envIdentity: identity(environments, settings.env), cwdIdentity: identity(directories, settings.cwd),
        },
      })
      call.temporary = settings.detached === false
      if (call.temporary) {
        if (argv[0] === "-c" && argv[1].startsWith(". '") && argv[1].endsWith("'")) {
          call.source = argv[1].slice(3, -1).replaceAll("'\\''", "'")
          if (path.basename(call.source) === "block.sh" && path.basename(path.dirname(call.source)).startsWith("desk-migration-")) {
            try {
              const text = readFileSync(call.source, "utf8")
              if (block === undefined) call.sourceSeen(text)
              else if (hash(text) !== hash(block)) unqualified(label, "source-mismatch")
            } catch {
              unqualified(label, "source-unreadable")
            }
          } else unqualified(label, "unexpected-source-path")
        } else unqualified(label, "unexpected-source-command")
      } else if (block === undefined) call.sourceSeen(argv[1])
      let child
      try { child = Reflect.apply(spawn, this, args) } catch (error) {
        record(label, "transport-throw", { operation: "spawn" })
        throw error
      }
      record(label, "spawn-return")
      return watch(child, "child")
    }
    call.execFile = (execFile) => function (...args) {
      const [command, argv, settings, callback] = args
      facts.helper.entryObserved = true
      record(label, "helper-entry", {
        commandSha256: hash(command), argsSha256: hash(JSON.stringify(argv)),
        options: { timeoutMs: settings.timeout, killSignal: settings.killSignal, maxBuffer: settings.maxBuffer, encoding: settings.encoding, windowsHide: settings.windowsHide },
      })
      const observedCallback = function (...values) {
        if (call.released) return Reflect.apply(callback, this, values)
        facts.helper.callbackObserved = true
        record(label, "helper-callback", { success: values[0] === null })
        let returned
        try { returned = Reflect.apply(callback, this, values) } catch (error) {
          record(label, "transport-throw", { operation: "callback" })
          throw error
        }
        facts.helper.callbackReturnedObserved = true
        record(label, "helper-callback-return")
        return returned
      }
      let helper
      try { helper = Reflect.apply(execFile, this, [command, argv, settings, observedCallback]) } catch (error) {
        record(label, "transport-throw", { operation: "exec-file" })
        throw error
      }
      facts.helper.returnObserved = true
      record(label, "helper-return")
      return watch(helper, "helper")
    }
    call.dispose = () => {
      call.released = true
      if (call.restorers.length === 0) return
      for (const restore of call.restorers.reverse()) restore()
      call.restorers = []
      record(label, "observer-release")
    }
    return call
  }
  const report = () => ({ version: 1, context, qualification, reason, events: events.map((event) => ({ ...event })) })
  const publish = () => {
    if (published) return
    published = true
    diagnostic(MIGRATION_RECORDER_MARKER + JSON.stringify(report()))
  }
  const observe = (promise, observedCalls, boundary) => {
    const finish = (outcome) => {
      record("context", "promise-settled", { outcome, boundary })
      for (const call of observedCalls) {
        record(call.label, "source-after-promise", {
          boundary, present: !call.temporary ? "NOT_APPLICABLE" : call.source === undefined ? "UNOBSERVED" : existsSync(path.dirname(call.source)),
        })
        call.dispose()
      }
      if (outcome === "rejected") publish()
    }
    promise.then(() => finish("fulfilled"), () => finish("rejected"))
    return promise
  }
  const wrapSpawn = (spawn) => function (...args) {
    const call = makeCall(undefined, undefined, false)
    return Reflect.apply(call.spawn(spawn), this, args)
  }
  return {
    wrapRunBlock: (run) => function (block, options) {
      const call = makeCall(block, options, true)
      let promise
      try {
        promise = Reflect.apply(run, this, [block, { ...options, spawn: call.spawn(options.spawn ?? spawnChild), execFile: call.execFile(options.execFile ?? execFileChild) }])
      } catch (error) {
        record(call.label, "transport-throw", { operation: "run-block" })
        call.dispose()
        publish()
        throw error
      }
      return observe(promise, [call], "block")
    },
    wrapPendingMigrations: (pending) => function (options) {
      record("context", "budget-options", { budgetMs: options.budgetMs, blockLimitMs: options.blockLimitMs })
      const promise = Reflect.apply(pending, this, [{ ...options, spawn: wrapSpawn(options.spawn ?? spawnChild) }])
      return observe(promise, calls, "context")
    },
    wrapSpawn,
    observe: (promise) => observe(promise, calls, "context"),
    dispose: () => { for (const call of calls) call.dispose() },
    report,
    publish,
  }
}
