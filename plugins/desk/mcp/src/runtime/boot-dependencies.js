// Runtime dependencies for session-boot.js.
//
// The Desk MCP server never runs from the bare plugin folder: it restores the
// plugin's shipped runtime pack into a cache folder (`bootstrap.js`) and loads
// its code and node_modules from there. session-boot.js runs straight from the
// plugin folder, where no node_modules is installed, so it needs the same
// dependencies (gray-matter, to read task cards' `repos:` lists) the same way:
// this restores the same pack into the same cache folder, with the same
// atomic publication, and registers the result for the card readers.
//
// It never throws: no pack for this machine, an unwritable cache or a corrupt
// archive leave the dependency-free reader in place, and the reason is kept
// for boot's pending line.

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { restoreRuntimeDependencies, resolveRuntimeCacheDir } from "./bootstrap.js"
import { deriveRuntimeDependencyPackPaths } from "./runtime-deps.js"
import { setRuntimeResolver, setRuntimeResolverFailure } from "../desk/runtime-resolver.js"

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

/**
 * Makes gray-matter loadable for this process. Returns `{ source }`:
 * "installed" when it already resolves beside the plugin, "runtime-cache" when
 * it was restored from the runtime pack, "none" (with `reason`) otherwise.
 * Every collaborator is a test seam.
 */
export function ensureBootDependencies({
  mcpRoot,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  nodeAbi = process.versions.modules,
  restore = restoreRuntimeDependencies,
  requireFrom = (file) => createRequire(file),
} = {}) {
  try {
    requireFrom(path.join(mcpRoot, "package.json")).resolve("gray-matter")
    return { source: "installed" }
  } catch {
    // Not installed beside the plugin: restore it from the runtime pack.
  }
  try {
    const packageJson = readJson(path.join(mcpRoot, "package.json"))
    const packageLockPath = path.join(mcpRoot, "package-lock.json")
    const target = `${platform}-${arch}-node-${nodeAbi}`
    const packPaths = deriveRuntimeDependencyPackPaths({
      mcpRoot,
      packageJson,
      packageLock: readJson(packageLockPath),
      platform,
      arch,
      nodeAbi,
    })
    const runtimeCacheDir = resolveRuntimeCacheDir({
      env,
      packageJson,
      target,
      prodDependencyLockHash: path.basename(packPaths.packDir),
    })
    restore({ mcpRoot, packageJson, packageLockPath, packPaths, runtimeCacheDir, target, platform, arch, nodeAbi })
    const fromCache = requireFrom(path.join(runtimeCacheDir, "node_modules", "package.json"))
    fromCache.resolve("gray-matter")
    setRuntimeResolver((name) => fromCache(name))
    return { source: "runtime-cache", runtimeCacheDir }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    setRuntimeResolverFailure(reason)
    return { source: "none", reason }
  }
}
