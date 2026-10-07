// Hook children that load Desk's MCP code run in a Node that satisfies the
// MCP's engines range, found by the MCP bootstrap's own selection, never
// simply in the Node the host put first on PATH (Milestone 3a ruling 5).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { promises as fs } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"

const require = createRequire(import.meta.url)
const { compatibleNode, hookProbe, PROBE_BUDGET_MS } = require("../../../../../plugins/desk/hooks/compatible-node.cjs")
const { launch: launchWorker } = require("../../../../../plugins/desk/hooks/lib/factory-end.cjs")
const bootstrap = require("../../../../../plugins/desk/mcp/bootstrap.cjs")

const MCP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk/mcp")
const OLD = { path: "/old/node", version: "v16.20.2", abi: "93" }

// A fake `node` (a POSIX sh script) that answers the bootstrap's version probe.
function fakeNode(file, version, abi) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "-e" ]; then printf 'v${version} ${abi}'; exit 0; fi\nexit 0\n`)
  chmodSync(file, 0o755)
  return file
}

test("a running Node that satisfies the MCP's range is used as it is, with no search", () => {
  const current = { path: "/current/node", version: process.version, abi: process.versions.modules }
  const result = compatibleNode({ current, select: () => { throw new Error("no search when the running Node fits") } })
  assert.deepEqual(result, { node: "/current/node", range: bootstrap.readPackage(MCP_ROOT).range })
  assert.equal(compatibleNode().node, process.execPath, "the defaults describe this process")
})

test("a plain >= floor is checked without loading the bootstrap; any other range uses the bootstrap's own check", async () => {
  const root = await mkTempRoot("desk-compatible-range-")
  const noSearch = () => { throw new Error("no search when the running Node fits") }
  const range = async (engines) => {
    const dir = await fs.mkdtemp(path.join(root, "mcp-"))
    if (engines !== undefined) await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ engines: { node: engines } }))
    return dir
  }
  const at = (version) => ({ path: `/node/${version}`, version, abi: "127" })
  assert.equal(compatibleNode({ mcpRoot: await range(">=20.1.0"), current: at("v20.1.0"), select: noSearch }).node, "/node/v20.1.0")
  assert.equal(compatibleNode({ mcpRoot: await range(">= 20.1.0"), current: at("v22.0.0"), select: noSearch }).node, "/node/v22.0.0")
  const tooOld = { node: null, range: ">=20.1.0" }
  assert.deepEqual(compatibleNode({ mcpRoot: await range(">=20.1.0"), current: at("v20.0.9"), select: () => tooOld }), { node: null, range: ">=20.1.0" })
  assert.deepEqual(compatibleNode({ mcpRoot: await range("^22.0.0 || >=24.0.0"), current: at("v22.5.0"), select: noSearch }), { node: "/node/v22.5.0", range: "^22.0.0 || >=24.0.0" })
  assert.equal(compatibleNode({ mcpRoot: await range("^22.0.0 || >=24.0.0"), current: at("v23.1.0"), select: () => tooOld }).node, null)
  assert.deepEqual(compatibleNode({ mcpRoot: await range(undefined), current: at("v22.0.0"), select: noSearch }), { node: "/node/v22.0.0", range: ">=20.0.0" }, "no package.json: the bootstrap's default range")
})

test("an old running Node searches with the bootstrap's selection and a hook-sized probe budget", () => {
  const calls = []
  const select = (options) => { calls.push(options); return { node: { path: "/nvm/v22/bin/node" }, range: ">=20.0.0" } }
  assert.equal(compatibleNode({ env: { HOME: "/home/a", DESK_NODE_SYSTEM_PREFIX: "/fixture" }, current: OLD, select }).node, "/nvm/v22/bin/node")
  assert.equal(calls[0].probeBudgetMs, PROBE_BUDGET_MS)
  assert.equal(typeof calls[0].probe, "function", "the hook's own probe, which trusts version-named install folders")
  assert.ok(PROBE_BUDGET_MS <= 250, "a probe blocks the hook, so the hook keeps its budget small")
  assert.equal(calls[0].homeDir, "/home/a")
  assert.equal(calls[0].systemPrefix, "/fixture")
  assert.equal(calls[0].current, OLD)

  compatibleNode({ env: { USERPROFILE: "C:\\Users\\a" }, current: OLD, select })
  assert.equal(calls[1].homeDir, "C:\\Users\\a")
  assert.equal(calls[1].systemPrefix, "")
  compatibleNode({ env: {}, current: OLD, select, probeBudgetMs: 3000 })
  assert.equal(typeof calls[2].homeDir, "string")
  assert.equal(calls[2].probeBudgetMs, 3000, "a caller nothing waits on may probe for longer")

  assert.deepEqual(compatibleNode({ env: {}, current: OLD, select: () => ({ node: null, range: ">=20.0.0" }) }).node, null)
})

test("the real selection finds an installed compatible Node and finds none on a bare machine", { skip: process.platform === "win32" && "the fake Node is a POSIX script" }, async () => {
  const root = await mkTempRoot("desk-compatible-node-")
  const env = { PATH: "", HOME: path.join(root, "home"), DESK_NODE_SYSTEM_PREFIX: path.join(root, "sysroot") }
  assert.equal(compatibleNode({ env, current: OLD }).node, null)
  const installed = fakeNode(path.join(root, "home", ".nvm", "versions", "node", "v22.9.0", "bin", "node"), "22.9.0", "127")
  assert.equal(compatibleNode({ env, current: OLD }).node, installed)

  // A Node on PATH whose folder does not name its version is probed; one that does is trusted without running it.
  const unversioned = fakeNode(path.join(root, "bin", "node"), "24.1.0", "137")
  // Generous timeouts: a loaded machine can take seconds to start even a shell script.
  const probe = hookProbe({})
  assert.deepEqual(probe(unversioned, 30_000), { version: "24.1.0", abi: "137" })
  assert.deepEqual(probe(installed, 30_000), { version: "22.9.0", abi: null })
  assert.equal(probe(path.join(root, "missing", "node"), 30_000), null, "a missing Node is neither trusted nor run")
  await fs.rm(unversioned)
  assert.deepEqual(probe(unversioned, 30_000), { version: "24.1.0", abi: "137" }, "one selection probes a Node once")
})

test("the bootstrap's selection honours a smaller probe budget", { skip: process.platform === "win32" && "the fake Node is a POSIX script" }, async () => {
  const root = await mkTempRoot("desk-compatible-budget-")
  const budgets = []
  fakeNode(path.join(root, "odd-bin", "node"), "x", "y")
  bootstrap.selectNode({
    env: { PATH: path.join(root, "odd-bin") },
    platform: "linux",
    arch: "x64",
    homeDir: path.join(root, "home"),
    mcpRoot: path.join(root, "mcp"),
    current: OLD,
    systemPrefix: path.join(root, "sysroot"),
    probeBudgetMs: 40,
    probe: (file, timeoutMs) => { budgets.push(timeoutMs); return null },
  })
  assert.equal(budgets.length, 1)
  assert.ok(budgets[0] > 0 && budgets[0] <= 40, String(budgets[0]))
})

test("the factory hook starts its worker only in a compatible Node, and starts nothing without one", async () => {
  const root = await mkTempRoot("desk-compatible-factory-")
  const proof = path.join(root, "ran.txt")
  const script = path.join(root, "worker.cjs")
  await fs.writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(proof)}, process.execPath + " " + process.argv.slice(2).join(" "))\n`)
  const resolved = []
  assert.equal(await launchWorker(script, ["derive"], process.env, (options) => { resolved.push(options.env); return { node: null, range: ">=20.0.0" } }), undefined)
  assert.deepEqual(resolved, [process.env])
  await launchWorker(script, ["derive"], process.env, () => ({ node: process.execPath, range: ">=20.0.0" }))
  const deadline = Date.now() + 10_000
  let ran = null
  while (ran === null && Date.now() < deadline) {
    try { ran = await fs.readFile(proof, "utf8") } catch { await new Promise((resolve) => setTimeout(resolve, 25)) }
  }
  assert.equal(ran, `${process.execPath} derive`)
  await assert.rejects(launchWorker(script, [], process.env, () => ({ node: path.join(root, "missing-node"), range: ">=20.0.0" })), { code: "ENOENT" })
})
