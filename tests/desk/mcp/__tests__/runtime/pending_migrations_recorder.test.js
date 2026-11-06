import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { runBlock } from "../../../../../plugins/desk/mcp/src/runtime/pending-migrations.js"
import { createMigrationRecorder, MIGRATION_RECORDER_MARKER } from "./_migration_recorder.js"
import { collectMigrationRecorder } from "../../../../../.github/scripts/migration-recorder.mjs"

const source = "printf 'pure fake: this source is never executed\\n'"
const hash = (value) => createHash("sha256").update(value).digest("hex")
const flush = () => new Promise((resolve) => setImmediate(resolve))

function fakeProcess(role) {
  const child = new EventEmitter()
  Object.assign(child, {
    pid: `PURE-FAKE:${role}`,
    stdin: new PassThrough({ autoDestroy: false }),
    stdout: new PassThrough({ autoDestroy: false }),
    stderr: new PassThrough({ autoDestroy: false }),
    kill: () => true,
  })
  return child
}

const schedules = [
  "helper-pending-child-closed",
  "helper-success-one-eof-pending",
  "helper-before-child",
  "child-before-helper",
  "both-late-after-rejection",
]

test("PURE-FAKE migration recorder calibrated schedules", async (parent) => {
  let stopped = false
  for (const schedule of schedules) {
    await parent.test(`PURE-FAKE migration recorder: ${schedule}`, async (t) => {
      try {
        t.mock.timers.enable({ apis: ["setTimeout"] })
        let virtualMs = 0
        const advance = (ms) => { virtualMs += ms; t.mock.timers.tick(ms) }
        const diagnostics = []
        const recorder = createMigrationRecorder({
          context: "run-block",
          cases: [{ label: "descendant-timeout", source }],
          now: () => virtualMs,
          diagnostic: (line) => { diagnostics.push(line); t.diagnostic(line) },
        })
        t.after(() => recorder.dispose())
        const child = fakeProcess("child")
        const helper = fakeProcess("helper")
        const childEmit = child.emit
        const helperEmit = helper.emit
        const childDestroy = child.stdout.destroy
        const helperDestroy = helper.stdout.destroy
        const beforeListeners = child.eventNames().map((name) => [name, child.listenerCount(name)])
        let ownedSource
        let spawnCalls = 0
        let helperCalls = 0
        let callbackReturn
        const callbackReceiver = { role: "callback-receiver" }
        const env = { PURE_FAKE_SECRET: "must-not-appear-in-recorder-output" }
        const cwd = process.cwd()
        const options = {
          env, cwd, timeoutMs: 200, platform: "win32", bash: "PURE-FAKE-BASH",
          spawn: function (command, args, settings) {
            assert.equal(this, undefined)
            spawnCalls++
            assert.equal(command, "PURE-FAKE-BASH")
            assert.equal(args[0], "-c")
            assert.ok(args[1].startsWith(". '") && args[1].endsWith("'"))
            ownedSource = args[1].slice(3, -1).replaceAll("'\\''", "'")
            assert.equal(readFileSync(ownedSource, "utf8"), source)
            assert.equal(settings.env, env)
            assert.equal(settings.cwd, cwd)
            assert.deepEqual(settings.stdio, ["ignore", "pipe", "pipe"])
            assert.equal(settings.detached, false)
            assert.equal(settings.windowsHide, true)
            return child
          },
          execFile: function (command, args, settings, callback) {
            assert.equal(this, undefined)
            helperCalls++
            assert.ok(path.win32.isAbsolute(command))
            assert.equal(path.win32.basename(command).toLowerCase(), "taskkill.exe")
            assert.deepEqual(args, ["/PID", child.pid, "/T", "/F"])
            assert.deepEqual(settings, {
              timeout: 1000, killSignal: "SIGKILL", maxBuffer: 16_384, encoding: "utf8", windowsHide: true,
            })
            helper.stdout.resume()
            helper.stderr.resume()
            helper.once("close", () => { callbackReturn = callback.call(callbackReceiver, null, "", "") })
            return helper
          },
        }
        let originalPromise
        const receiver = { role: "run-receiver" }
        const recordedRun = recorder.wrapRunBlock(function (block, settings) {
          assert.equal(this, receiver)
          assert.equal(block, source)
          for (const [key, value] of Object.entries(options)) {
            if (key !== "spawn" && key !== "execFile") assert.equal(settings[key], value, key)
          }
          originalPromise = runBlock(block, settings)
          return originalPromise
        })
        const promise = recordedRun.call(receiver, source, options)
        assert.equal(promise, originalPromise, "observation must return the original Promise")
        let settlements = 0
        let value
        let error
        const settled = promise.then(
          (result) => { settlements++; value = result },
          (failure) => { settlements++; error = failure },
        )
        child.emit("spawn")
        child.stdout.write("controlled output\n")
        child.stderr.write("controlled error\n")
        advance(199)
        assert.equal(helperCalls, 0)
        advance(1)
        assert.equal(helperCalls, 1)
        helper.emit("spawn")
        await flush()
        assert.equal(settlements, 0)

        const finishChild = async () => {
          child.stdout.end()
          child.stderr.end()
          child.emit("exit", null, "SIGKILL")
          await flush()
          child.emit("close", null, "SIGKILL")
        }
        const finishHelper = async () => {
          helper.stdout.end()
          helper.stderr.end()
          helper.emit("exit", 0, null)
          await flush()
          helper.emit("close", 0, null)
        }
        const succeeds = schedule === "helper-before-child" || schedule === "child-before-helper"
        if (schedule === "helper-pending-child-closed" || schedule === "child-before-helper") await finishChild()
        if (schedule === "helper-success-one-eof-pending") {
          child.stdout.end()
          child.emit("exit", null, "SIGKILL")
          await finishHelper()
        }
        if (schedule === "helper-before-child") await finishHelper()
        await flush()
        assert.equal(settlements, 0, "one completed side must not settle runBlock")
        if (succeeds) {
          advance(100)
          if (schedule === "helper-before-child") await finishChild()
          else await finishHelper()
        } else {
          advance(1000)
        }
        await settled
        await flush()
        assert.equal(spawnCalls, 1)
        assert.equal(helperCalls, 1)
        assert.equal(settlements, 1)
        if (succeeds) {
          assert.equal(error, undefined)
          assert.deepEqual(value, {
            status: null, stdout: "controlled output\n", stderr: "controlled error\n", timedOut: true, unavailable: false,
          })
          assert.equal(callbackReturn, undefined)
        } else {
          assert.equal(value, undefined)
          assert.equal(error.message, "Migration termination failed for PID PURE-FAKE:child; tree cleanup UNQUALIFIED: tree operation or output close exceeded 1000 ms")
        }
        assert.equal(existsSync(path.dirname(ownedSource)), false, "production finally must remove its actual owned source")
        assert.equal(child.emit, childEmit)
        assert.equal(helper.emit, helperEmit)
        assert.equal(child.stdout.destroy, childDestroy)
        assert.equal(helper.stdout.destroy, helperDestroy)
        assert.deepEqual(child.eventNames().map((name) => [name, child.listenerCount(name)]), beforeListeners)
        const report = recorder.report()
        assert.equal(report.qualification, "QUALIFIED")
        const beforeDestroy = report.events.find((event) => event.event === "destroy-entry")
        if (schedule === "helper-pending-child-closed") {
          assert.equal(beforeDestroy.facts.child.closeObserved, true)
          assert.equal(beforeDestroy.facts.child.stdout.endObserved, true)
          assert.equal(beforeDestroy.facts.child.stderr.endObserved, true)
          assert.equal(beforeDestroy.facts.helper.callbackObserved, false)
        } else if (schedule === "helper-success-one-eof-pending") {
          assert.equal(beforeDestroy.facts.helper.callbackObserved, true)
          assert.equal(beforeDestroy.facts.child.exitObserved, true)
          assert.equal(beforeDestroy.facts.child.closeObserved, false)
          assert.equal(beforeDestroy.facts.child.stdout.endObserved, true)
          assert.equal(beforeDestroy.facts.child.stderr.endObserved, false)
        } else if (schedule === "both-late-after-rejection") {
          assert.equal(beforeDestroy.facts.helper.callbackObserved, false)
          assert.equal(beforeDestroy.facts.child.exitObserved, false)
          assert.equal(beforeDestroy.facts.child.closeObserved, false)
          assert.equal(beforeDestroy.facts.child.stdout.endObserved, false)
          assert.equal(beforeDestroy.facts.child.stderr.endObserved, false)
        } else {
          assert.equal(beforeDestroy, undefined, "normal EOF/close must not be manufactured by observer destruction")
        }
        assert.ok(report.events.some((event) => event.event === "source-after-promise" && event.present === false))
        const eventCount = report.events.length
        if (!succeeds) {
          await finishChild()
          await finishHelper()
        }
        advance(100_000)
        await flush()
        assert.equal(settlements, 1)
        assert.equal(helperCalls, 1, "late delivery must not restart termination")
        assert.equal(recorder.report().events.length, eventCount, "released observers must not resurrect on late events")
        recorder.publish()
        assert.equal(diagnostics.length, 1)
        assert.ok(diagnostics[0].startsWith(MIGRATION_RECORDER_MARKER))
        const encoded = JSON.stringify(report)
        assert.ok(!encoded.includes(env.PURE_FAKE_SECRET))
        assert.ok(!encoded.includes(source))
        assert.ok(!encoded.includes(cwd))
        assert.ok(!encoded.includes(ownedSource))
        assert.ok(!encoded.includes("controlled output"))
        assert.ok(!encoded.includes("controlled error"))
        assert.ok(Buffer.byteLength(encoded) <= 32_768)
        assert.equal(report.events.find((event) => event.event === "case").sourceSha256, hash(source))
        assert.ok(report.events.every((event, index, events) => index === 0 || event.ms >= events[index - 1].ms))

        // The budget seam cannot observe the helper; sequence plus source disambiguates identical blocks.
        const budget = createMigrationRecorder({
          context: "budget",
          cases: [{ label: "01-slow-detect:detect", source }, { label: "02-slow-check:detect", source }],
          diagnostic: () => {},
        })
        const budgetReceiver = { role: "spawn-receiver" }
        const budgetSettings = { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
        const budgetArgs = ["-c", source]
        const budgetChild = fakeProcess("budget")
        const nextBudgetChild = fakeProcess("next-budget")
        let budgetCalls = 0
        const injectedSpawn = budget.wrapSpawn(function (...args) {
          assert.equal(this, budgetReceiver)
          assert.equal(args[0], "PURE-FAKE-BASH")
          assert.equal(args[1], budgetArgs)
          assert.equal(args[2], budgetSettings)
          return budgetCalls++ === 0 ? budgetChild : nextBudgetChild
        })
        assert.equal(injectedSpawn.call(budgetReceiver, "PURE-FAKE-BASH", budgetArgs, budgetSettings), budgetChild)
        budgetChild.stdout.destroy()
        const budgetSnapshot = budget.report().events.find((event) => event.event === "destroy-entry")
        assert.equal(budgetSnapshot.facts.helper, "UNOBSERVED")
        assert.equal(budgetSnapshot.case, "01-slow-detect:detect")
        assert.equal(injectedSpawn.call(budgetReceiver, "PURE-FAKE-BASH", budgetArgs, budgetSettings), nextBudgetChild)
        assert.deepEqual(budget.report().events.filter((event) => event.event === "case").map((event) => event.case), ["01-slow-detect:detect", "02-slow-check:detect"])
        const originalError = new Error("pure fake original error")
        const rejected = Promise.reject(originalError)
        assert.equal(budget.observe(rejected), rejected)
        await assert.rejects(rejected, (failure) => failure === originalError)
        await flush()
        assert.equal(budget.report().qualification, "QUALIFIED")
        assert.equal(budgetChild.emit, childEmit)
        assert.equal(nextBudgetChild.emit, childEmit)
        const custody = collectMigrationRecorder(
          `# ${MIGRATION_RECORDER_MARKER}${JSON.stringify(report)}\n# ${MIGRATION_RECORDER_MARKER}${JSON.stringify(budget.report())}\n`,
          "runtime/pending_migrations.test.js",
        )
        assert.equal(custody.qualification, "QUALIFIED", JSON.stringify(custody.issues))
        const limited = createMigrationRecorder({ context: "budget", cases: [{ label: "01-slow-detect:detect", source }], diagnostic: () => {}, maxEvents: 2 })
        const overflowChild = fakeProcess("overflow")
        const overflowSpawn = limited.wrapSpawn(() => overflowChild)
        assert.equal(overflowSpawn("PURE-FAKE-BASH", budgetArgs, budgetSettings), overflowChild)
        assert.equal(limited.report().qualification, "UNQUALIFIED")
        assert.ok(limited.report().events.some((event) => event.event === "overflow"))
        assert.ok(Buffer.byteLength(JSON.stringify(limited.report())) <= 32_768)
        limited.dispose()
        if (schedule === "both-late-after-rejection") {
          const passthrough = createMigrationRecorder({
            context: "run-block", cases: [{ label: "exit-output", source }], diagnostic: () => {},
          })
          const transportReceiver = { role: "transport-receiver" }
          const token = { role: "callback-return" }
          const callbackError = new Error("pure fake callback error")
          const childArgs = ["-c", source]
          const helperArgs = ["/PID", "PURE-FAKE:passthrough", "/T", "/F"]
          const helperSettings = { timeout: 1000, killSignal: "SIGKILL", maxBuffer: 16_384, encoding: "utf8", windowsHide: true }
          const process = fakeProcess("passthrough-child")
          const termination = fakeProcess("passthrough-helper")
          const originalValue = { role: "original-value" }
          const originalResult = Promise.resolve(originalValue)
          const wrapped = passthrough.wrapRunBlock(function (block, settings) {
            assert.equal(this, receiver)
            assert.equal(block, source)
            assert.equal(settings.spawn.call(transportReceiver, "PURE-FAKE-BASH", childArgs, budgetSettings), process)
            const callback = function (...args) {
              assert.equal(this, callbackReceiver)
              assert.equal(args[0], callbackError)
              assert.equal(args[1], childArgs)
              assert.equal(args[2], helperArgs)
              return token
            }
            assert.equal(settings.execFile.call(transportReceiver, "PURE-FAKE-HELPER", helperArgs, helperSettings, callback), termination)
            return originalResult
          })
          const result = wrapped.call(receiver, source, {
            timeoutMs: 200,
            spawn: function (command, args, settings) {
              assert.equal(this, transportReceiver)
              assert.equal(command, "PURE-FAKE-BASH")
              assert.equal(args, childArgs)
              assert.equal(settings, budgetSettings)
              return process
            },
            execFile: function (command, args, settings, callback) {
              assert.equal(this, transportReceiver)
              assert.equal(command, "PURE-FAKE-HELPER")
              assert.equal(args, helperArgs)
              assert.equal(settings, helperSettings)
              assert.equal(callback.call(callbackReceiver, callbackError, childArgs, helperArgs), token)
              return termination
            },
          })
          assert.equal(result, originalResult)
          assert.equal(await result, originalValue)
          await flush()
          assert.equal(passthrough.report().qualification, "QUALIFIED")
          assert.equal(process.emit, childEmit)
          assert.equal(termination.emit, helperEmit)
          const pendingRecorder = createMigrationRecorder({
            context: "budget",
            cases: [{ label: "01-slow-detect:detect", source }, { label: "02-slow-check:detect", source }],
            diagnostic: () => {},
          })
          const pendingChildren = [fakeProcess("first-detect"), fakeProcess("later-safety")]
          let pendingCalls = 0
          let pendingPromise
          const pendingValue = [{ state: "pure-fake" }]
          const recordedPending = pendingRecorder.wrapPendingMigrations(function (settings) {
            assert.equal(this, receiver)
            assert.equal(settings.cwd, cwd)
            assert.equal(settings.budgetMs, 30_000)
            assert.equal(settings.blockLimitMs, 1_500)
            settings.spawn("PURE-FAKE-BASH", budgetArgs, budgetSettings)
            pendingPromise = Promise.resolve().then(() => {
              settings.spawn("PURE-FAKE-BASH", budgetArgs, budgetSettings)
              return pendingValue
            })
            return pendingPromise
          })
          const pendingResult = recordedPending.call(receiver, {
            cwd, budgetMs: 30_000, blockLimitMs: 1_500, spawn: () => pendingChildren[pendingCalls++],
          })
          assert.equal(pendingResult, pendingPromise)
          assert.equal(await pendingResult, pendingValue)
          await flush()
          assert.equal(pendingCalls, 2)
          assert.equal(pendingRecorder.report().events.filter((event) => event.event === "source-after-promise").length, 2)
          assert.equal(pendingRecorder.report().events.filter((event) => event.event === "observer-release").length, 2)
          for (const pendingChild of pendingChildren) assert.equal(pendingChild.emit, childEmit)
        }
      } catch (error) {
        stopped = true
        throw error
      }
    })
    if (stopped) break
  }
})
