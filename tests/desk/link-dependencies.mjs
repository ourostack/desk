// The Desk tests live under tests/desk, outside the shipped plugin folder, so hosts that copy or download plugins/desk never fetch them. tests/desk/<package> mirrors plugins/desk/<package>.
//
// A test imports its package's dependencies (better-sqlite3, ws, ...) by bare name, and Node resolves a bare name from the importing file's own folder upward. This module links tests/desk/<package>/node_modules to the installed plugins/desk/<package>/node_modules, so those imports resolve to the one installed copy. Importing it is enough: the MCP test setup (`_isolated_env.mjs`) imports it and the browser context broker's `npm test` preloads it.
//
// The link is a directory junction on Windows, which needs no privilege, and a symbolic link elsewhere. It is ignored by Git and recreated when missing or pointing somewhere else. A package without installed dependencies gets no link.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const testsRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testsRoot, "..", "..")

export const TEST_PACKAGES = Object.freeze(["mcp", "browser-context-broker"])

/** Links tests/desk/<name>/node_modules to plugins/desk/<name>/node_modules; returns the link path, or null when the package has no installed dependencies. */
export function linkDependencies(name, { root = repoRoot, fsOps = fs } = {}) {
  const target = path.join(root, "plugins", "desk", name, "node_modules")
  const link = path.join(root, "tests", "desk", name, "node_modules")
  if (!fsOps.existsSync(target)) return null
  let current = null
  try {
    current = fsOps.readlinkSync(link)
  } catch {
    current = null
  }
  if (current !== null && path.resolve(path.dirname(link), current) === target) return link
  if (current !== null) fsOps.rmSync(link, { force: true })
  try {
    fsOps.symlinkSync(target, link, "junction")
  } catch (error) {
    // Another test process made the same link first.
    if (error?.code !== "EEXIST") throw error
  }
  return link
}

for (const name of TEST_PACKAGES) linkDependencies(name)
