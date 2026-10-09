// Shared ownership registry for fixture roots created under the OS temp dir.
//
// Test files own the fixtures they create. A file's fixtures must stay on disk
// for the whole file — per-test `finally` blocks and `t.after()` hooks read them
// during teardown — so removal happens once, in a file-level `after()` hook.
//
// Ownership is exact: only roots handed out by `mkTempRoot` are removed. Nothing
// is matched by prefix, name pattern, or age, so a same-prefix directory this
// file did not create is never touched.

// Imported first so a test file run on its own also gets the temporary HOME and XDG folders and the real-home write guard.
import "./_isolated_env.mjs"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after } from "node:test"
import { controllerRecords, processAlive, waitForProcessesGone } from "./runtime/_controller_exit.js"
import { readProcessStart } from "../../../../plugins/desk/mcp/src/readiness/process-start.js"

const ownedRoots = new Set()
// Readiness controller children seen under an owned root, by PID. A controller deletes its owner.json as it shuts down, before its process is gone, so they are noted while the session is alive and teardown waits for them.
const knownControllers = new Map()

const remember = (records) => {
  for (const record of records) knownControllers.set(record.pid, record)
}

// A recorded PID names the controller only while the process now holding it started when the record says. A reused PID, or one that is gone, needs no wait. A start time that is unknown on either side cannot rule the process out, so it is waited for. Teardown never signals a process: a session that leaves its controller running must end it itself (an in-process session starts its controller ephemeral), and a controller that outlives the wait fails the test naming its PID.
async function stillTheController(record, startOf) {
  if (!processAlive(record.pid)) return false
  if (record.processStart === null) return true
  const current = await startOf(record.pid)
  return current === null || current === record.processStart
}

/**
 * Remove `roots` once every readiness controller under them, and every one in `known`, has exited. Controllers outlive their sessions and hold the derived index open, and Windows refuses to delete a file a process holds. The wait has a bounded deadline and a failure that names the PIDs. The delete retries are unchanged; the roots are still removed when the wait fails, and every failure is thrown, the wait's first.
 */
export async function removeRootsAfterControllers(roots, known = knownControllers, { waitForGone = waitForProcessesGone, remove = (root) => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }), startOf = readProcessStart } = {}) {
  const records = new Map([...(known instanceof Map ? known : [...known].map((pid) => [pid, { pid, processStart: null, parentPid: null }])), ...controllerRecords(roots).map((record) => [record.pid, record])])
  const running = []
  for (const record of records.values()) if (await stillTheController(record, startOf)) running.push(record)
  let waitError
  try {
    await waitForGone(running.map((record) => record.pid))
  } catch (error) {
    waitError = error
  }
  // Retries cover Windows, where a just-exited child can keep a fixture file busy (EBUSY) for a moment.
  const removals = await Promise.allSettled(roots.map(remove))
  const failures = [waitError, ...removals.map((result) => result.reason)].filter((error) => error !== undefined)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, failures.map((error) => error.message).join("; and "))
}

after(() => removeRootsAfterControllers([...ownedRoots]))

/**
 * Note the readiness controller children now running under the owned roots that contain any of `hints` (a session's cwd and home), and return their PIDs.
 * Call it while the session is alive; a session helper calls it as the session closes, so no test has to.
 */
export function recordControllers(...hints) {
  const within = (root, hint) => typeof hint === "string" && hint !== "" && (path.resolve(hint) === root || path.resolve(hint).startsWith(root + path.sep))
  const roots = [...ownedRoots].filter((root) => hints.some((hint) => within(root, hint)))
  const records = controllerRecords(roots)
  remember(records)
  return [...new Set(records.map((record) => record.pid))]
}

/** Like recordControllers, but throws when none is running: for a test that expects a controller, so a session that never started one cannot pass by waiting for nothing. */
export function requireControllers(...hints) {
  const pids = recordControllers(...hints)
  if (pids.length === 0) throw new Error(`no readiness controller is recorded under ${hints.filter(Boolean).join(", ")}; the session never started one, so there is nothing to wait for`)
  return pids
}

/** Create a fixture root under the OS temp dir and own it until the test file ends. */
export async function mkTempRoot(prefix) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), prefix))
  ownedRoots.add(root)
  return root
}
