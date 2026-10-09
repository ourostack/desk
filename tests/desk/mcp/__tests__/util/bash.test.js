// resolveBash: on Windows, Git for Windows' bash wins over the WSL relay that sits first on PATH.
import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveBash } from "../../../../../plugins/desk/mcp/src/util/bash.js"

const RELAY = "C:\\Windows\\System32\\bash.exe"
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe"
const resolve = (env, present) => resolveBash({ platform: "win32", env, exists: (file) => present.includes(file) })

test("off Windows it is plain bash", () => {
  assert.equal(resolveBash({ platform: "linux", env: {}, exists: () => assert.fail("no lookup") }), "bash")
  assert.equal(typeof resolveBash(), "string")
})

test("the WSL relay first on PATH loses to the bash beside the git on PATH", () => {
  const env = { PATH: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd" }
  assert.equal(resolve(env, [RELAY, "C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\bash.exe"]), "C:\\Program Files\\Git\\bin\\bash.exe")
})

test("a Git for Windows install is found with no git on PATH, from any of its usual folders", () => {
  assert.equal(resolve({ PATH: "C:\\Windows\\System32", ProgramFiles: "C:\\Program Files" }, [RELAY, GIT_BASH]), GIT_BASH)
  assert.equal(resolve({ ProgramW6432: "D:\\PF" }, ["D:\\PF\\Git\\bin\\bash.exe"]), "D:\\PF\\Git\\bin\\bash.exe")
  assert.equal(resolve({ "ProgramFiles(x86)": "C:\\PF86" }, ["C:\\PF86\\Git\\bin\\bash.exe"]), "C:\\PF86\\Git\\bin\\bash.exe")
  assert.equal(resolve({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, ["C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"]), "C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe")
})

test("with no environment variables at all, the standard Program Files folders on the system drive are checked", () => {
  assert.equal(resolve({}, ["C:\\Program Files\\Git\\bin\\bash.exe"]), "C:\\Program Files\\Git\\bin\\bash.exe")
  assert.equal(resolve({ SystemDrive: "D:" }, ["D:\\Program Files (x86)\\Git\\bin\\bash.exe"]), "D:\\Program Files (x86)\\Git\\bin\\bash.exe")
})

test("the git usr/bin bash is the second choice, and another bash on PATH comes after the installs", () => {
  assert.equal(resolve({ Path: "C:\\G\\cmd" }, ["C:\\G\\cmd\\git.exe", "C:\\G\\usr\\bin\\bash.exe"]), "C:\\G\\usr\\bin\\bash.exe")
  assert.equal(resolve({ PATH: "C:\\msys\\usr\\bin;;" }, ["C:\\msys\\usr\\bin\\bash.exe"]), "C:\\msys\\usr\\bin\\bash.exe")
})

test("only the WSL relay (System32, Sysnative or WindowsApps) or nothing at all gives null, never plain bash", () => {
  const env = { PATH: "C:\\Windows\\System32;C:\\Windows\\Sysnative;C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps" }
  assert.equal(resolve(env, [RELAY, "C:\\Windows\\Sysnative\\bash.exe", "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe"]), null)
  assert.equal(resolve({}, []), null)
})
