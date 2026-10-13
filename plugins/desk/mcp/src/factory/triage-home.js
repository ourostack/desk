// Where the triage runner's code is loaded from. The runner, its custody and the owned catalog server need packages
// (`gray-matter`, the MCP SDK) that an installed plugin copy does not carry: Desk restores them into the runtime pack
// and runs the MCP server from that pack's source mirror. This module imports nothing outside `node:` built-ins, so the
// loop worker and `factory.js` can load it from the plugin copy, and it answers where the runner can be imported from:
//
//   - this source root, when its packages resolve here (a checkout, the test suite, a source mirror);
//   - otherwise the source mirror that `prepareRuntime` (the same function the MCP server uses) admits for this exact
//     source, next to its restored packages.
//
// A failure is a quiet code, never a throw: `runtime_unavailable` (no pack or mirror could be prepared) or
// `runtime_unloadable` (the modules were found but did not load).

import { existsSync } from "node:fs"
import { userInfo } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const OWN_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const PACKAGES = Object.freeze(["gray-matter", "@modelcontextprotocol/sdk"])
const MODULES = Object.freeze({ runner: "src/factory/triage-runner.js", custody: "src/factory/triage-custody.js", qualify: "src/factory/triage-qualify.js" })

/**
 * The improvement card the loop opens or reuses while restore reports `stale` / `engine_unpinned`: its source and id only. The
 * title is the loop's card table's, since the card writer refuses a supplied title.
 */
export const TRIAGE_ENGINE_CARD = Object.freeze({
  source: "loop_alarm",
  id: "triage_engine_unpinned",
})

// The node_modules folders ESM resolution walks from `from` (never NODE_PATH, which ESM imports ignore).
function nodeModulesPackage(from, name) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "node_modules", name, "package.json"))) return
    if (dir === path.dirname(dir)) throw new Error(`${name} does not resolve`)
  }
}

/** `packagesResolve(root, resolve)`: whether every package the runner needs resolves from `root` as an ES module import would. */
export function packagesResolve(root, resolve = nodeModulesPackage) {
  try {
    for (const name of PACKAGES) resolve(root, name)
    return true
  } catch {
    return false
  }
}

// The runtime cache is chosen from the account's home alone: an ambient
// DESK_RUNTIME_CACHE_DIR or XDG_CACHE_HOME never selects the pack the runner loads from.
/** `prepareSourceMirror({ mcpRoot }, { load, homedir }) -> path`: the admitted source mirror for exactly this source, as the MCP server prepares it. */
export async function prepareSourceMirror({ mcpRoot }, { load = (url) => import(url), homedir = () => userInfo().homedir } = {}) {
  const { prepareRuntime, hashCurrentSource } = await load(pathToFileURL(path.join(mcpRoot, "src", "runtime", "bootstrap.js")).href)
  return prepareRuntime({ mcpRoot, env: { HOME: homedir() }, sourceIdentity: `sha256:${hashCurrentSource(mcpRoot)}` }).sourceMirrorPath
}

/**
 * `triageRuntimeRoot(seams) -> { state: "found", root } | { state: "unavailable", reason: "runtime_unavailable" }`: the source
 * root the runner loads from. `seams` (`ownRoot`, `resolve`, `prepare`) are test seams.
 */
export async function triageRuntimeRoot({ ownRoot = OWN_ROOT, resolve, prepare = prepareSourceMirror } = {}) {
  if (packagesResolve(ownRoot, resolve)) return { state: "found", root: ownRoot }
  try {
    const prepared = await prepare({ mcpRoot: ownRoot })
    const mirror = typeof prepared === "string" && path.isAbsolute(prepared) ? path.join(prepared, path.sep) : null
    if (mirror !== null && packagesResolve(mirror, resolve)) return { state: "found", root: mirror }
  } catch {
    // Reported as unavailable below.
  }
  return { state: "unavailable", reason: "runtime_unavailable" }
}

/**
 * `importTriageRunner(env, seams) -> { state: "loaded", root, runner, custody, qualify } | { state: "unavailable", reason }`: the runner,
 * custody and qualification modules from the root `triageRuntimeRoot` finds. Never throws.
 */
// `env` is part of the contract for callers; the runtime is chosen from the account's home alone.
export async function importTriageRunner(env, { load = (url) => import(url), ...seams } = {}) {
  const found = await triageRuntimeRoot(seams)
  if (found.state !== "found") return found
  try {
    const [runner, custody, qualify] = await Promise.all(Object.values(MODULES).map((file) => load(pathToFileURL(path.join(found.root, file)).href)))
    return { state: "loaded", root: found.root, runner, custody, qualify }
  } catch {
    return { state: "unavailable", reason: "runtime_unloadable" }
  }
}
