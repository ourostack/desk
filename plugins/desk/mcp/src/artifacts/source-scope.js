import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import * as path from "node:path"

export const ARTIFACT_SOURCE_SCOPE_PATHS = Object.freeze([
  "plugins/desk/mcp/src/indexer/chunk.js",
  "plugins/desk/mcp/src/indexer/index.js",
  "plugins/desk/mcp/src/indexer/spec.js",
  "plugins/desk/mcp/src/indexer/vector-packs.js",
  "plugins/desk/mcp/src/snapshots/manifest.js",
  "plugins/desk/mcp/src/snapshots/restore.js",
  "plugins/desk/mcp/src/artifacts/artifact-scripts.js",
  "plugins/desk/mcp/src/artifacts/policy.js",
  "plugins/desk/mcp/src/artifacts/source-scope.js",
  "plugins/desk/mcp/scripts/build-vector-pack.js",
  "plugins/desk/mcp/scripts/build-snapshot.js",
  "plugins/desk/mcp/scripts/verify-snapshot.js",
  "plugins/desk/mcp/scripts/validate-artifacts.js",
  "plugins/desk/mcp/src/db/schema.sql",
  "plugins/desk/mcp/package.json",
  "plugins/desk/mcp/package-lock.json",
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
