// Global test setup: every test process runs with HOME, XDG_STATE_HOME, XDG_CACHE_HOME, XDG_CONFIG_HOME, XDG_DATA_HOME and XDG_RUNTIME_DIR pointing into one temporary folder per test run, and a write under the real home fails loudly.
//
// Loaded three ways, so no test can reach the real ~/.cache or ~/.local/state:
// - `npm test` and the coverage runner preload it with `--import`, and the test runner passes that to every test file's process;
// - `_temp_roots.js` imports it, so a test file run on its own with `node --test <file>` is isolated too;
// - a process that inherits DESK_TEST_RUN_DIR from its parent reuses the parent's folder, so one run shares one folder.
//
// The write guard covers this process's own `node:fs` calls (sync, callback and promise forms). A path under the real home is refused unless it is under the OS temp folder or this repository checkout, which may themselves sit under the home.

import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

export const REAL_HOME_WRITE = "DESK_TEST_REAL_HOME_WRITE"

const realHome = process.env.DESK_TEST_REAL_HOME ?? os.userInfo().homedir
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
const originalMkdtemp = fs.mkdtempSync
const originalMkdir = fs.mkdirSync
const originalRm = fs.rmSync

let runDir = process.env.DESK_TEST_RUN_DIR
if (typeof runDir !== "string" || runDir.length === 0 || !fs.existsSync(runDir)) {
  runDir = originalMkdtemp(path.join(fs.realpathSync(os.tmpdir()), "desk-test-run-"))
  process.env.DESK_TEST_RUN_DIR = runDir
  // The process that made the folder removes it when it exits.
  process.once("exit", () => {
    try {
      originalRm(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // A child still holding a file on Windows: the OS temp folder cleans it up later.
    }
  })
}
process.env.DESK_TEST_REAL_HOME = realHome

const home = path.join(runDir, "home")
const locations = {
  HOME: home,
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_RUNTIME_DIR: path.join(runDir, "runtime"),
}
for (const [name, dir] of Object.entries(locations)) {
  originalMkdir(dir, { recursive: true, mode: 0o700 })
  process.env[name] = dir
}
// os.homedir() reads USERPROFILE on Windows.
if (process.platform === "win32") process.env.USERPROFILE = home

const allowedRoots = [...new Set([os.tmpdir(), safeRealpath(os.tmpdir()), repoRoot, safeRealpath(repoRoot), runDir])]
const homeRoots = [...new Set([realHome, safeRealpath(realHome)])]

function safeRealpath(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

function inside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Whether a write to `target` would land under the real home, outside the temp folder and this checkout. */
export function isRealHomeWrite(target) {
  let file
  if (typeof target === "string") file = target
  else if (target instanceof URL && target.protocol === "file:") file = fileURLToPath(target)
  else if (Buffer.isBuffer(target)) file = target.toString("utf8")
  else return false
  const resolved = path.resolve(file)
  return homeRoots.some((root) => inside(resolved, root)) && !allowedRoots.some((root) => inside(resolved, root))
}

function refuse(target) {
  const error = new Error(`test isolation: refused a write under the real home (${String(target)}); tests write only under their temporary folders`)
  error.code = REAL_HOME_WRITE
  return error
}

const OPEN_READ_ONLY = new Set([undefined, "r", "rs", "sr", fs.constants.O_RDONLY])
// Each write-like fs function and the argument positions that hold paths it writes.
const WRITERS = {
  appendFile: [0], chmod: [0], chown: [0], copyFile: [1], cp: [1], link: [1], lchown: [0], lutimes: [0], mkdir: [0], mkdtemp: [0],
  rename: [0, 1], rm: [0], rmdir: [0], symlink: [1], truncate: [0], unlink: [0], utimes: [0], writeFile: [0],
}

function guarded(original, positions, { callback }) {
  return function guardedFs(...args) {
    const blocked = positions.map((index) => args[index]).find(isRealHomeWrite)
    if (blocked !== undefined) {
      const error = refuse(blocked)
      const done = callback ? args.findLast((arg) => typeof arg === "function") : undefined
      if (done) {
        process.nextTick(done, error)
        return undefined
      }
      throw error
    }
    return original.apply(this, args)
  }
}

function guardedOpen(original, { callback, promise }) {
  return function guardedOpenFs(file, flags, ...rest) {
    if (!OPEN_READ_ONLY.has(typeof flags === "function" ? undefined : flags) && isRealHomeWrite(file)) {
      const error = refuse(file)
      if (promise) return Promise.reject(error)
      const done = callback ? [flags, ...rest].findLast((arg) => typeof arg === "function") : undefined
      if (done) {
        process.nextTick(done, error)
        return undefined
      }
      throw error
    }
    return original.call(this, file, flags, ...rest)
  }
}

if (!fs.__deskTestGuard) {
  for (const [name, positions] of Object.entries(WRITERS)) {
    if (typeof fs[name] === "function") fs[name] = guarded(fs[name], positions, { callback: true })
    if (typeof fs[`${name}Sync`] === "function") fs[`${name}Sync`] = guarded(fs[`${name}Sync`], positions, { callback: false })
    if (typeof fs.promises[name] === "function") {
      const original = fs.promises[name]
      fs.promises[name] = function guardedPromise(...args) {
        const blocked = positions.map((index) => args[index]).find(isRealHomeWrite)
        return blocked === undefined ? original.apply(this, args) : Promise.reject(refuse(blocked))
      }
    }
  }
  fs.open = guardedOpen(fs.open, { callback: true })
  fs.openSync = guardedOpen(fs.openSync, { callback: false })
  fs.promises.open = guardedOpen(fs.promises.open, { promise: true })
  const createWriteStream = fs.createWriteStream
  fs.createWriteStream = function guardedWriteStream(file, ...rest) {
    if (isRealHomeWrite(file)) throw refuse(file)
    return createWriteStream.call(this, file, ...rest)
  }
  Object.defineProperty(fs, "__deskTestGuard", { value: true })
  syncBuiltinESMExports()
}

export const testRun = Object.freeze({ runDir, realHome, ...locations })
