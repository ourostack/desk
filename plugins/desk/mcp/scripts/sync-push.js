#!/usr/bin/env node
// The detached push worker: schedulePush (runtime/sync-worker.js) launches this script detached, off the
// calling MCP tool's own short-lived process, so a debounced push survives that process exiting before
// the debounce window elapses (ruling 1, spec.md §2 "Background push, one retry") -- see
// `runSyncPushCli`/`runPushWorker` in src/runtime/sync-worker.js for the CLI surface, the lock and the
// retry logic, and their own tests. It runs straight from the installed plugin, so it imports nothing
// outside Node's built-ins and Desk's own dependency-free modules.
import { runSyncPushCli } from "../src/runtime/sync-worker.js"

process.exitCode = await runSyncPushCli()
