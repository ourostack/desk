#!/usr/bin/env node
// The detached push worker: schedulePush (runtime/sync-worker.js) launches this script detached, off the
// calling MCP tool's own short-lived process, so a debounced push survives that process exiting before
// the debounce window elapses (ruling 1, spec.md §2 "Background push, one retry") -- see
// `runSyncPushCli`/`runPushWorker` in src/runtime/sync-worker.js for the CLI surface, the lock and the
// retry logic, and their own tests. It runs straight from the installed plugin, so it imports nothing
// outside Node's built-ins and Desk's own dependency-free modules.
import { runSyncPushCli } from "../src/runtime/sync-worker.js"

// runPushWorker and its own writers already degrade internally rather than throw (including a state-guard
// refusal under an inherited NODE_TEST_CONTEXT -- Review Focus, PR #101 fix round), but this is the detached
// worker's last line of defense: an unexpected failure here still exits cleanly, the same as `busy`/`skipped`,
// instead of an uncaught rejection's stack trace and a crash nobody set out to leave unhandled.
try {
  process.exitCode = await runSyncPushCli()
} catch (error) {
  // Every throw runSyncPushCli can reach (its own --root validation, parseSyncPushArgs) is a genuine `new Error(...)`
  // -- runPushWorker itself never throws (see its doc comment in src/runtime/sync-worker.js) -- so this reads
  // `.message` directly rather than guarding against a non-Error rejection that cannot occur through this CLI.
  process.stderr.write(`sync-push.js: ${error.message}\n`)
  process.exitCode = 1
}
