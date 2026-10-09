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
import { controllerPids, waitForProcessesGone } from "./runtime/_controller_exit.js"

const ownedRoots = new Set()
// Readiness controller children seen under an owned root. A controller deletes its owner.json as it shuts down, before its process is gone, so the PIDs are noted while the session is alive and teardown waits for them.
const knownControllers = new Set()

/**
 * Remove `roots` once every readiness controller under them, and every PID in `known`, has exited. Controllers outlive their sessions and hold the derived index open, and Windows refuses to delete a file a process holds. The wait has a bounded deadline and a failure that names the PIDs. The delete retries are unchanged; the roots are still removed when the wait fails, and the failure is then thrown.
 */
export async function removeRootsAfterControllers(roots, known = knownControllers, { waitForGone = waitForProcessesGone, remove = (root) => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } = {}) {
  const pids = new Set([...known, ...controllerPids(roots)])
  let waitError
  try {
    await waitForGone([...pids])
  } catch (error) {
    waitError = error
  }
  // Retries cover Windows, where a just-exited child can keep a fixture file busy (EBUSY) for a moment.
  await Promise.all(roots.map(remove))
  if (waitError) throw waitError
}

after(() => removeRootsAfterControllers([...ownedRoots], knownControllers))

/**
 * Note the readiness controller children now running under the owned roots that contain any of `hints` (a session's cwd and home), and return their PIDs.
 * Call it while the session is alive; a session helper calls it as the session closes, so no test has to.
 */
export function recordControllers(...hints) {
  const within = (root, hint) => typeof hint === "string" && hint !== "" && (path.resolve(hint) === root || path.resolve(hint).startsWith(root + path.sep))
  const roots = [...ownedRoots].filter((root) => hints.some((hint) => within(root, hint)))
  const pids = controllerPids(roots)
  for (const pid of pids) knownControllers.add(pid)
  return pids
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
