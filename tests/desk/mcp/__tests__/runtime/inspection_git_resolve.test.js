import assert from "node:assert/strict"
import test from "node:test"

import { resolveInspectionGit } from "../../../../../plugins/desk/mcp/src/runtime/git-inspection.js"

const trusted = (expected) => (file) => file === expected

test("Git inspection finds Git in a standard Windows location and never searches PATH", () => {
  const ignored = "/candidate-only"
  assert.equal(resolveInspectionGit({ platform: "win32", env: { ProgramFiles: "C:\\Trusted", "ProgramFiles(x86)": "C:\\Alternate", PATH: ignored }, accessible: trusted("C:\\Alternate\\Git\\cmd\\git.exe") }), "C:\\Alternate\\Git\\cmd\\git.exe")
  assert.throws(() => resolveInspectionGit({ platform: "win32", env: { ProgramFiles: "/missing-trusted-location" } }), /trusted Git is unavailable/u)
  assert.throws(() => resolveInspectionGit({ platform: "win32", env: {}, accessible: () => false }), /trusted Git is unavailable/u)
  assert.throws(() => resolveInspectionGit({ platform: "linux", accessible: () => false }), /trusted Git is unavailable/u)
})

test("Windows environment names are matched without regard to case, with an exact-case name winning", () => {
  assert.equal(resolveInspectionGit({ platform: "win32", env: { PROGRAMFILES: "C:\\Program Files" }, accessible: trusted("C:\\Program Files\\Git\\cmd\\git.exe") }), "C:\\Program Files\\Git\\cmd\\git.exe")
  assert.equal(resolveInspectionGit({ platform: "win32", env: { "PROGRAMFILES(X86)": "C:\\Program Files (x86)" }, accessible: trusted("C:\\Program Files (x86)\\Git\\cmd\\git.exe") }), "C:\\Program Files (x86)\\Git\\cmd\\git.exe")
  assert.equal(resolveInspectionGit({ platform: "win32", env: { ProgramFiles: "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files" }, accessible: trusted("C:\\Program Files\\Git\\cmd\\git.exe") }), "C:\\Program Files\\Git\\cmd\\git.exe")
  assert.equal(resolveInspectionGit({ platform: "win32", env: { programfiles: "C:\\Other", ProgramFiles: "C:\\Trusted" }, accessible: (file) => file.endsWith("git.exe") }), "C:\\Trusted\\Git\\cmd\\git.exe")
})

test("outside Windows only the fixed system paths are candidates and the environment is not read", () => {
  assert.equal(resolveInspectionGit({ platform: "darwin", env: { PROGRAMFILES: "C:\\Program Files" }, accessible: trusted("/usr/bin/git") }), "/usr/bin/git")
})
