// Shared scaffolding for the private-state tests (Windows ACL, factory outbox, retired private feedback).
//
// Every test gets its own temp desk root plus its own private state home so
// no test ever touches the developer's real feedback store.

// Imported first so a test file run on its own (`node --test <file>`, not
// through `npm test`) starts from the temporary HOME and XDG folders and the
// real-home write guard too, before `useHome`/`useStateHome` below narrow
// further to that one test's own fixture.
import "../_isolated_env.mjs"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

import { assertWindowsAclAvailable } from "../../../../../plugins/desk/mcp/src/factory/windows-acl.js"

export async function mkFeedbackFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "desk-feedback-"))
  const deskRoot = path.join(base, "workspace")
  const stateHome = path.join(base, "state")
  await fs.mkdir(deskRoot, { recursive: true })
  return { base, deskRoot, stateHome }
}

export async function writePosixNodeProvider(providerPath, body) {
  // Keep the required .exe launch path, but give Node's loader a recognized payload extension.
  await fs.writeFile(`${providerPath}.cjs`, `${body}\n`)
  // The stand-in runs the test's own Node by absolute path, not whatever `node` PATH finds first (on a developer machine that can be a version-manager shim or an older Node). It keeps the caller's NODE_OPTIONS, which posix_provider_fixture.test.js requires.
  await fs.writeFile(providerPath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$0.cjs" "$@"\n`, { mode: 0o755 })
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function useStateHome(stateHome) {
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  return () => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
  }
}

export function useHome(home) {
  const previousHome = process.env.HOME
  const previousStateHome = process.env.XDG_STATE_HOME
  delete process.env.XDG_STATE_HOME
  process.env.HOME = home
  return () => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousStateHome !== undefined) process.env.XDG_STATE_HOME = previousStateHome
  }
}

export async function cleanup(base) {
  await fs.rm(base, { recursive: true, force: true })
}

/**
 * Reads a real path's NTFS security descriptor back through the real
 * Windows PowerShell provider `protectWindowsPaths` itself uses (native
 * Windows only). `program` is PowerShell reading `$request` (parsed from
 * `input`); its result is round-tripped through `ConvertTo-Json`.
 */
export function nativeProbe(program, input) {
  const prefix = "$ErrorActionPreference='Stop';" +
    "$env:PSModulePath=Join-Path $PSHOME 'Modules';" +
    "[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false);" +
    "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);" +
    "$request=[Console]::In.ReadToEnd()|ConvertFrom-Json;"
  return JSON.parse(execFileSync(
    assertWindowsAclAvailable(),
    ["-NoProfile", "-NonInteractive", "-Command", prefix + program],
    { input: JSON.stringify(input), encoding: "utf8", windowsHide: true, timeout: 20000 },
  ))
}
