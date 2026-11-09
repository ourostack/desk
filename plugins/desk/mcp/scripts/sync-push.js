#!/usr/bin/env node
// The detached push worker: schedulePush (runtime/sync-worker.js) launches this script detached, off the
// calling MCP tool's own short-lived process, so a debounced push survives that process exiting before
// the debounce window elapses (ruling 1, spec.md §2 "Background push, one retry") -- see
// `runSyncPushCli`/`runPushWorker` in src/runtime/sync-worker.js for the CLI surface, the lock and the
// retry logic, and their own tests. It runs straight from the installed plugin, so it imports nothing
// outside Node's built-ins and Desk's own dependency-free modules.

// runPushWorker and its own writers already degrade internally rather than throw (including a state-guard
// refusal under an inherited NODE_TEST_CONTEXT -- Review Focus, PR #101 fix round), but this is the detached
// worker's last line of defense: an unexpected failure here still exits cleanly, the same as `busy`/`skipped`,
// instead of an uncaught rejection's stack trace and a crash nobody set out to leave unhandled.
try {
  const native = process.argv.indexOf("--native-owner")
  const watchdog = process.argv.indexOf("--native-watchdog")
  const publication = process.argv.indexOf("--publication")
  const producer = process.argv.indexOf("--producer-gate1")
  const executor = process.argv.indexOf("--producer-gate1-executor")
  const saveExecutor = process.argv.indexOf("--producer-save-executor")
  if (producer !== -1) {
    const { runProducerGate1Worker } = await import("../src/runtime/producer-state.js")
    await runProducerGate1Worker({ id: process.argv[producer + 1], root: process.argv[process.argv.indexOf("--root") + 1] })
  } else if (saveExecutor !== -1) {
    const { runProducerSaveExecutor } = await import("../src/runtime/producer-state.js")
    await runProducerSaveExecutor({ socket: process.argv[saveExecutor + 1] })
  } else if (executor !== -1) {
    const { runProducerGate1Executor } = await import("../src/runtime/producer-state.js")
    await runProducerGate1Executor({ socket: process.argv[executor + 1] })
  } else if (publication !== -1) {
    const root = process.argv.indexOf("--root")
    if (root === -1 || !process.argv[root + 1] || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(process.argv[publication + 1] ?? "")) {
      throw new Error("sync-push.js: invalid publication grant")
    }
    const { runPublicationWorker } = await import("../src/runtime/publication-state.js")
    await runPublicationWorker({ root: process.argv[root + 1], id: process.argv[publication + 1] })
  } else if (watchdog !== -1) {
    const { runNativeWatchdogCli } = await import("../src/runtime/recovery-state.js")
    process.exitCode = await runNativeWatchdogCli({ token: process.argv[watchdog + 1] })
  } else if (native !== -1) {
    const { runNativeOwnerCli } = await import("../src/runtime/recovery-state.js")
    process.exitCode = await runNativeOwnerCli({ token: process.argv[native + 1] })
  } else {
    const { runSyncPushCli } = await import("../src/runtime/sync-worker.js")
    process.exitCode = await runSyncPushCli()
  }
} catch (error) {
  // Every throw runSyncPushCli can reach (its own --root validation, parseSyncPushArgs) is a genuine `new Error(...)`
  // -- runPushWorker itself never throws (see its doc comment in src/runtime/sync-worker.js) -- so this reads
  // `.message` directly rather than guarding against a non-Error rejection that cannot occur through this CLI.
  process.stderr.write(`sync-push.js: ${error.message}\n`)
  process.exitCode = 1
}
