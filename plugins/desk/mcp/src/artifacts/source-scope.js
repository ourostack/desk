import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_SCOPE_CONFIG_PATH = path.resolve(
  MODULE_DIR,
  "..",
  "..",
  "config",
  "artifact-source-scope.json",
)
const SOURCE_SCOPE_CONFIG = JSON.parse(readFileSync(SOURCE_SCOPE_CONFIG_PATH, "utf8"))

export const ARTIFACT_SOURCE_SCOPE_PATHS = Object.freeze([
  ...SOURCE_SCOPE_CONFIG.source_paths,
])

export function artifactSourceScopeHash(
  mcpRoot,
  readFile = readFileSync,
) {
  const hash = createHash("sha256")
  for (const repoPath of ARTIFACT_SOURCE_SCOPE_PATHS) {
    const relFromMcp = repoPath.replace(/^plugins\/desk\/mcp\//u, "")
    hash.update(`${repoPath}\0`)
    hash.update(readFile(path.join(mcpRoot, relFromMcp)))
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}
