// boot-dependencies.js + runtime-resolver.js — session-boot.js runs straight
// from an installed plugin folder, with no node_modules beside it, and must
// still load gray-matter (task cards' `repos:` lists) the way the MCP server
// gets its dependencies: from the restored runtime pack.

import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { mkTempRoot } from "../_temp_roots.js"
import { ensureBootDependencies } from "../../../../../plugins/desk/mcp/src/runtime/boot-dependencies.js"
import {
  requireFromRuntime,
  runtimeResolverFailure,
  setRuntimeResolver,
  setRuntimeResolverFailure,
} from "../../../../../plugins/desk/mcp/src/desk/runtime-resolver.js"
import { loadFrontmatterParser } from "../../../../../plugins/desk/mcp/src/desk/organization.js"
import { parseFrontmatterLite } from "../../../../../plugins/desk/mcp/src/desk/frontmatter-lite.js"

const MCP_ROOT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/", import.meta.url))

afterEach(() => setRuntimeResolver(null))

async function fakePlugin() {
  const mcpRoot = await mkTempRoot("desk-boot-deps-plugin-")
  await fs.writeFile(path.join(mcpRoot, "package.json"), JSON.stringify({ name: "x", version: "9.9.9", dependencies: {} }))
  await fs.writeFile(path.join(mcpRoot, "package-lock.json"), JSON.stringify({ name: "x", lockfileVersion: 3, packages: { "": {} } }))
  return mcpRoot
}

function fakeRequire({ resolves }) {
  return (file) => {
    const fn = (name) => ({ loadedFrom: file, name })
    fn.resolve = (name) => {
      if (!resolves(file)) throw new Error(`Cannot find module '${name}'`)
      return name
    }
    return fn
  }
}

test("runtime-resolver: requireFromRuntime throws like a failed require until a resolver is registered", () => {
  assert.throws(() => requireFromRuntime("gray-matter"), /Cannot find module 'gray-matter'/)
  setRuntimeResolver((name) => `loaded ${name}`)
  assert.equal(requireFromRuntime("gray-matter"), "loaded gray-matter")
  assert.equal(runtimeResolverFailure(), null)
  setRuntimeResolverFailure("no pack")
  assert.equal(runtimeResolverFailure(), "no pack")
  assert.throws(() => requireFromRuntime("gray-matter"), /Cannot find module/)
  setRuntimeResolver(null)
  assert.equal(runtimeResolverFailure(), null)
})

test("loadFrontmatterParser reaches gray-matter through the restored runtime dependencies when it is not beside the plugin", () => {
  const sentinel = () => ({ data: {} })
  setRuntimeResolver((name) => (name === "gray-matter" ? sentinel : null))
  // The default loader tries beside-the-plugin first (present in this repo), so
  // prove the fallback by making the first lookup fail through the seam.
  assert.equal(loadFrontmatterParser(() => requireFromRuntime("gray-matter")), sentinel)
  setRuntimeResolver(null)
  assert.equal(loadFrontmatterParser(() => requireFromRuntime("gray-matter")), parseFrontmatterLite)
})

test("ensureBootDependencies leaves everything alone when gray-matter is already installed beside the plugin", () => {
  let restored = false
  const result = ensureBootDependencies({
    mcpRoot: "/plugin/mcp",
    requireFrom: fakeRequire({ resolves: () => true }),
    restore: () => { restored = true },
  })
  assert.deepEqual(result, { source: "installed" })
  assert.equal(restored, false)
})

test("ensureBootDependencies restores the runtime pack into the runtime cache folder and registers its gray-matter", async () => {
  const mcpRoot = await fakePlugin()
  const cache = await mkTempRoot("desk-boot-deps-cache-")
  let restoreArgs = null
  const result = ensureBootDependencies({
    mcpRoot,
    env: { DESK_RUNTIME_CACHE_DIR: cache },
    platform: "linux",
    arch: "x64",
    nodeAbi: "127",
    // Resolves from the cache's node_modules only, as in an installed plugin.
    requireFrom: fakeRequire({ resolves: (file) => file.startsWith(cache) }),
    restore: (args) => { restoreArgs = args },
  })
  assert.deepEqual(result, { source: "runtime-cache", runtimeCacheDir: cache })
  assert.equal(restoreArgs.mcpRoot, mcpRoot)
  assert.equal(restoreArgs.runtimeCacheDir, cache)
  assert.equal(restoreArgs.target, "linux-x64-node-127")
  assert.equal(restoreArgs.packPaths.archivePath.includes(path.join("artifacts", "runtime-deps", "9.9.9", "linux-x64-node-127")), true)
  assert.deepEqual(requireFromRuntime("gray-matter"), { loadedFrom: path.join(cache, "node_modules", "package.json"), name: "gray-matter" })
  assert.equal(runtimeResolverFailure(), null)
})

test("ensureBootDependencies falls back to the dependency-free reader and keeps the reason when the pack cannot be restored", async () => {
  const mcpRoot = await fakePlugin()
  const result = ensureBootDependencies({
    mcpRoot,
    env: { DESK_RUNTIME_CACHE_DIR: await mkTempRoot("desk-boot-deps-cache-") },
    requireFrom: fakeRequire({ resolves: () => false }),
    restore: () => { throw new Error("no runtime pack for darwin-arm64-node-999") },
  })
  assert.equal(result.source, "none")
  assert.match(result.reason, /no runtime pack/)
  assert.match(runtimeResolverFailure(), /no runtime pack/)
  assert.equal(loadFrontmatterParser(() => requireFromRuntime("gray-matter")), parseFrontmatterLite)
})

test("ensureBootDependencies reports a restore that leaves no gray-matter behind, and a thrown non-Error", async () => {
  const mcpRoot = await fakePlugin()
  const env = { DESK_RUNTIME_CACHE_DIR: await mkTempRoot("desk-boot-deps-cache-") }
  const none = ensureBootDependencies({ mcpRoot, env, requireFrom: fakeRequire({ resolves: () => false }), restore: () => {} })
  assert.equal(none.source, "none")
  assert.match(none.reason, /Cannot find module 'gray-matter'/)
  const odd = ensureBootDependencies({
    mcpRoot,
    env,
    requireFrom: fakeRequire({ resolves: () => false }),
    restore: () => { throw "plain string" }, // eslint-disable-line no-throw-literal
  })
  assert.equal(odd.reason, "plain string")
})

test("ensureBootDependencies with its real defaults either restores the shipped pack or reports why it could not", async () => {
  // A copy of the plugin folder with no node_modules beside it, as installed.
  const pluginCopy = await mkTempRoot("desk-boot-deps-real-")
  const mcpRoot = path.join(pluginCopy, "mcp")
  await fs.cp(MCP_ROOT, mcpRoot, { recursive: true, filter: (src) => !src.split(path.sep).includes("node_modules") })
  const result = ensureBootDependencies({ mcpRoot, env: { DESK_RUNTIME_CACHE_DIR: await mkTempRoot("desk-boot-deps-real-cache-") } })
  // A host that puts gray-matter on NODE_PATH (the coverage runner does) resolves it beside the plugin; that is "installed", and nothing is restored.
  assert.match(result.source, /^(installed|runtime-cache|none)$/)
  if (result.source === "runtime-cache") {
    assert.equal(typeof requireFromRuntime("gray-matter"), "function")
  } else if (result.source === "installed") {
    assert.throws(() => requireFromRuntime("gray-matter"), /Cannot find module/)
  } else {
    assert.equal(typeof result.reason, "string")
  }
})

// The scenario this exists for: the shipped script run from an installed
// plugin folder with no node_modules beside it. Skipped on a machine the
// runtime pack does not cover (there boot falls back, and says so).
test("session-boot.js run from a plugin folder with no node_modules still parses task cards' repos lists", async (t) => {
  const abi = process.versions.modules
  const target = `${process.platform}-${process.arch}-node-${abi}`
  const packRoot = path.join(MCP_ROOT, "artifacts", "runtime-deps")
  const versions = await fs.readdir(packRoot)
  const covered = (await Promise.all(versions.map((v) => fs.stat(path.join(packRoot, v, target)).then(() => true, () => false)))).some(Boolean)
  if (!covered) return t.skip(`no shipped runtime pack for ${target}`)

  const pluginCopy = await mkTempRoot("desk-boot-plugin-")
  const mcpRoot = path.join(pluginCopy, "mcp")
  await fs.cp(MCP_ROOT, mcpRoot, { recursive: true, filter: (src) => !src.split(path.sep).includes("node_modules") })
  await fs.access(path.join(mcpRoot, "node_modules")).then(() => assert.fail("fixture must have no node_modules"), () => {})

  const desk = await mkTempRoot("desk-boot-plugin-desk-")
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  const card = (name, repos) => `---\ntitle: ${name}\nstatus: processing\ncreated: 2026-01-01\nupdated: 2026-01-02\ntrack: t\n${repos}\n---\nBody\n`
  await fs.mkdir(path.join(desk, "t", "good"), { recursive: true })
  await fs.writeFile(path.join(desk, "t", "good", "task.md"), card("Good", "repos:\n  - name: acme/widgets\n    local_path: \"\"\n    mode: remote"))
  await fs.mkdir(path.join(desk, "t", "bad"), { recursive: true })
  await fs.writeFile(path.join(desk, "t", "bad", "task.md"), card("Bad", "repos:\n  - name: acme/widgets\n    mode: sideways"))

  const home = await mkTempRoot("desk-boot-plugin-home-")
  const cacheDir = await mkTempRoot("desk-boot-plugin-cache-")
  const stdout = execFileSync(process.execPath, [path.join(mcpRoot, "scripts", "session-boot.js"), "--json"], {
    encoding: "utf8",
    cwd: desk,
    // NODE_PATH is cleared so nothing but the restored runtime pack can supply gray-matter (the coverage runner sets it).
    env: { ...process.env, HOME: home, DESK: desk, NODE_PATH: "", DESK_RUNTIME_CACHE_DIR: cacheDir, CLAUDE_PROJECT_DIR: "" },
  })
  const result = JSON.parse(stdout)
  // The runtime pack was restored into the cache folder the server would use, and that is where gray-matter came from.
  await fs.access(path.join(cacheDir, "node_modules", "gray-matter", "package.json"))
  assert.equal(result.card_parser, "gray-matter")
  assert.equal(result.pending.some((line) => line.includes("card repos: not validated")), false)
  // The bad card's repos entry is judged (it could not be without the parser).
  assert.equal(result.card_validation.some((entry) => entry.problems.some((p) => p.includes("repos[0]"))), true)
})
