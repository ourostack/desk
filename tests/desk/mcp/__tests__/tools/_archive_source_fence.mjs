// This file's owned-FS tests never delegate subprocesses, including in the normal CI runner.
import childProcess, { exec, execSync, execFile, execFileSync, spawn, spawnSync, fork } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"

const methods = ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]
const replacements = Object.fromEntries(methods.map(name => [name, () => {
  throw Object.assign(new Error(`Archive source test forbids child_process.${name}`), { code: "DESK_SOURCE_NATIVE_FORBIDDEN" })
}]))
replacements.spawnSync = command => {
  if (command !== "git") throw Object.assign(new Error("Archive source test forbids subprocess dispatch"),
    { code: "DESK_SOURCE_NATIVE_FORBIDDEN" })
  return { status: 128, signal: null, stdout: "", stderr: "fatal: not a git repository: synthetic source-test seam" }
}
for (const name of methods) childProcess[name] = replacements[name]
syncBuiltinESMExports()
const named = { exec, execSync, execFile, execFileSync, spawn, spawnSync, fork }
for (const name of methods) {
  if (childProcess[name] !== replacements[name] || named[name] !== replacements[name])
    throw new Error(`Archive source fence builtin export mismatch: ${name}`)
}
export const archiveFencedExecFileSync = replacements.execFileSync
