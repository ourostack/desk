// A one-at-a-time lock file under the factory state folder, shared by the evaluator step and the loop worker.
//
// The file `<state>/locks/<name>` is created exclusively and holds `{ pid, token, started_at, ...record }`: the
// holder's own process id, a random token and the time it started. A second taker finds the file and gets `null`
// (the caller answers `busy`). A lock is taken over only when the process recorded in it is not alive, or when the
// lock is older than the outer age (6 hours, which covers a recycled process id); a record that cannot be read, or
// names no usable process id, is held until the outer age. Only one caller can win a takeover: it needs the
// exclusive guard file `<lock>.takeover` and re-reads the lock while holding it. The liveness check is an
// existence probe of that one recorded id through an injected seam (default: signal 0, which delivers nothing); it
// never matches by name, and nothing here ever signals a process, including the child ids a record may hold.
// Release removes the file only while it still holds the holder's own token.

import { randomBytes } from "node:crypto"
import { promises as fsp } from "node:fs"
import * as path from "node:path"

const GUARD_STALE_MS = 30 * 60 * 1000
// A lock is taken over when its recorded process is gone, or past this age, which covers a recycled process id.
export const LOCK_OUTER_AGE_MS = 6 * 60 * 60 * 1000
const MAX_CHILDREN = 64

/** An existence probe of one process id: signal 0 delivers nothing. A process that may not be signalled exists. */
export function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

// How old a file is, in milliseconds on `clock`, or `null` when it cannot be read.
async function ageOf(file, clock) {
  try {
    return clock() - (await fsp.stat(file)).mtimeMs
  } catch {
    return null
  }
}

const guardIsStale = async (file, clock) => (await ageOf(file, clock)) > GUARD_STALE_MS

// The lock is stale when its recorded process is gone, or when it is past the outer age. A record that cannot
// be read, or names no usable process id, is held until the outer age.
async function lockIsStale(file, alive, clock) {
  const age = await ageOf(file, clock)
  if (age === null) return false
  if (age > LOCK_OUTER_AGE_MS) return true
  let pid = null
  try {
    pid = JSON.parse(await fsp.readFile(file, "utf8")).pid
  } catch {
    // Unreadable: held.
  }
  return Number.isSafeInteger(pid) && pid > 0 && !alive(pid)
}

async function takeOver(file, alive, clock) {
  const guard = `${file}.takeover`
  try {
    await (await fsp.open(guard, "wx", 0o600)).close()
  } catch {
    // Another caller is taking over, or an earlier one died holding the guard: clear an old guard, wait a step.
    if (await guardIsStale(guard, clock)) await fsp.rm(guard, { force: true })
    return false
  }
  try {
    const stale = await lockIsStale(file, alive, clock)
    if (stale) await fsp.rm(file, { force: true })
    return stale
  } finally {
    // Whatever went wrong above, the guard never stays behind.
    await fsp.rm(guard, { force: true })
  }
}

/**
 * `takeLock(root, { name, alive, clock, record }) -> { file, token } | null`. `null` means another holder has it.
 * `record` is extra fields for the file (the worker adds `children: []`); `pid`, `token` and `started_at` are the lock's own.
 */
export async function takeLock(root, { name, alive = processAlive, clock = Date.now, record = {} }) {
  const dir = path.join(root, "locks")
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, name)
  const token = randomBytes(16).toString("hex")
  while (true) {
    try {
      const handle = await fsp.open(file, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ ...record, pid: process.pid, token, started_at: new Date().toISOString() }))
      } finally {
        await handle.close()
      }
      return { file, token }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (!(await lockIsStale(file, alive, clock)) || !(await takeOver(file, alive, clock))) return null
    }
  }
}

/** Removes the lock only while it still holds the holder's own token. */
export async function releaseLock({ file, token }) {
  let held = null
  try {
    held = JSON.parse(await fsp.readFile(file, "utf8")).token
  } catch {
    // Missing or unreadable: not ours to remove.
  }
  if (held === token) await fsp.rm(file, { force: true })
}

/**
 * `trackChild(lock, pid, started)`: adds (`started` true) or removes a child process id in the lock's `children`, only while the file
 * still holds the holder's token. It records ids and signals nothing. Never rejects: a lock that cannot be updated just does not list the id.
 */
export async function trackChild(lock, pid, started) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  await rewrite(lock, (record) => {
    const others = (Array.isArray(record.children) ? record.children : []).filter((child) => child !== pid)
    return { ...record, children: (started ? [...others, pid] : others).slice(-MAX_CHILDREN) }
  })
}

/** `touchLock({ file, token })`: rewrites the lock unchanged, so its modification time is now, only while it still holds the holder's own token. */
export async function touchLock(lock) {
  await rewrite(lock, (record) => record)
}

// Replaces the lock's record with `change(record)` through a temporary file, only while it holds `token`; bookkeeping only, so nothing throws.
async function rewrite({ file, token }, change) {
  try {
    const record = JSON.parse(await fsp.readFile(file, "utf8"))
    if (record.token !== token) return
    const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`
    await fsp.writeFile(temporary, JSON.stringify(change(record)), { mode: 0o600 })
    await fsp.rename(temporary, file)
  } catch {
    // Bookkeeping only.
  }
}
