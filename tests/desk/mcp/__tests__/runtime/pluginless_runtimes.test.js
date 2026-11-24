import assert from "node:assert/strict"
import { test } from "node:test"
import { runDrainsCli } from "../../../../../plugins/desk/mcp/src/runtime/drains-cli.js"
import { findPluginlessRuntimes, listProcesses, pluginlessRuntimeLines } from "../../../../../plugins/desk/mcp/src/runtime/pluginless-runtimes.js"

const RT = "/x/copilot-sdk-runtime-1/copilot-runtime"
const PS = [
  `  1756 ${RT} --server --stdio --no-auto-update --log-level debug`,
  `  7092 ${RT} --no-auto-update --plugin-dir /p/agency-plugin-a.p1/root-5/desk --server --stdio`,
  `  7093 ${RT} --log-dir /l --plugin-dir /p/agency-plugin-a.p1/root-1/crew --server --stdio`,
  `  7094 ${RT} --stdio`,
  `  5584 /u/agency copilot --copilot-path ${RT} --server --stdio`,
  "  9 /bin/bash -c something",
  "",
].join("\n")

test("a server runtime without a Desk plugin directory is found; one with it, a non-server runtime and other processes are not", () => {
  assert.deepEqual(findPluginlessRuntimes(PS), [1756, 7093])
})

test("the status lines name the runtimes and how to recover, or say all is well", () => {
  assert.match(pluginlessRuntimeLines([1756, 7093])[0], /2 Copilot server runtime\(s\) run without Desk's plugin \(pid 1756, 7093\)/u)
  assert.match(pluginlessRuntimeLines([1])[1], /resuming each affected session through Agency/u)
  assert.deepEqual(pluginlessRuntimeLines([]), ["runtimes: every Copilot server runtime has Desk's plugin"])
})

test("listProcesses reads this host's process table", () => {
  assert.equal(listProcesses("win32"), "")
  if (process.platform !== "win32") assert.match(listProcesses(), new RegExp(`\\b${process.pid}\\b`, "u"))
})

test("drains.js runtimes status prints the findings, and needs the status word", async () => {
  const out = []
  const err = []
  const io = { stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) } }
  assert.equal(await runDrainsCli({ argv: ["runtimes", "status"], script: "s", io, listProcesses: () => PS }), 0)
  assert.match(JSON.parse(out.join("")).status[0], /pid 1756, 7093/u)
  assert.equal(await runDrainsCli({ argv: ["runtimes"], script: "s", io }), 2)
  assert.match(err.join(""), /drains: .*runtimes/u)
})

test("drains.js runtimes status names process-list-failed when ps cannot run", async () => {
  const out = []
  const io = { stdout: { write: (t) => out.push(t) }, stderr: { write() {} } }
  const listProcesses = () => { throw new Error("spawn ps ENOENT") }
  assert.equal(await runDrainsCli({ argv: ["runtimes", "status", "--json"], script: "s", io, listProcesses }), 1)
  assert.equal(JSON.parse(out.join("")).error.code, "process-list-failed")
})
