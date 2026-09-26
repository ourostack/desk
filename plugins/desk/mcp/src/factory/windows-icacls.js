// The factory outbox's Windows owner-only protection.
//
// The private feedback and work-ledger stores (`src/protected/store.js`)
// protect a SQLite database file on Windows with a PowerShell script that
// rewrites its NTFS DACL and reads it back to prove the result
// (`src/feedback/windows-acl.js`) — worth the machinery for one mutable file
// per store. The factory outbox is a tree of small, disposable JSON files
// under one root; `icacls.exe`, the operating system's own command-line ACL
// tool, does the same job — remove inherited rules, grant the current user
// alone full control — in one synchronous call per path, with no PowerShell
// dependency and no new async surface in an otherwise synchronous module.
//
// This module creates nothing and resolves no location; it only locks down
// a path the caller has already created.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files; this module needs `node:child_process` only.

import { execFileSync } from "node:child_process"

function defaultRunner(command, args) {
  execFileSync(command, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 20_000,
  })
}

/**
 * `protectWindowsPathSync(target, kind, { platform, env, runner })`: a no-op
 * off Windows. On `win32`, strips inherited ACL entries from `target` and
 * grants only the current user (`env.USERNAME`, else `env.USER`) full
 * control, via `icacls.exe /inheritance:r /grant:r <user>:(F)` (a directory
 * additionally gets `(OI)(CI)` so files created under it inherit the same
 * grant). `runner` is injected so tests never depend on a real Windows ACL
 * provider; it must throw on failure — `icacls` prints its own error text
 * and a non-zero exit satisfies `execFileSync`'s own throw-on-failure
 * contract, which the default runner relies on rather than parsing output.
 */
export function protectWindowsPathSync(target, kind, { platform = process.platform, env = process.env, runner = defaultRunner } = {}) {
  if (platform !== "win32") return
  const user = env.USERNAME ?? env.USER
  if (typeof user !== "string" || user.trim() === "") {
    throw new Error("desk_factory: Windows ACL protection needs USERNAME (or USER) to identify the owner")
  }
  const grant = kind === "directory" ? `${user}:(OI)(CI)(F)` : `${user}:(F)`
  runner("icacls.exe", [target, "/inheritance:r", "/grant:r", grant])
}
