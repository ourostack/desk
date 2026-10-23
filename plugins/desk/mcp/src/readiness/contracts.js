// The contracts a readiness controller is identified by. Sessions on one root elect one controller only when these match.
// Dependency-free, so the session can derive a root's controller identity before the runtime pack is restored.

import * as path from "node:path"

// The folder the runtime bootstrap mirrors Desk's source into: `<runtime cache>/source-mirror/<sha256 of the source>`.
const SOURCE_MIRROR_DIR = "source-mirror"
const SOURCE_DIGEST = /^[0-9a-f]{16,128}$/u

/**
 * The Desk build a runtime loaded from `mcpRoot` is: the content digest that names its source mirror. Null outside a mirror (tests and development runs load the source folder directly), where every session on a root keeps sharing one controller as before.
 */
export function sourceMirrorBuild(mcpRoot) {
  if (typeof mcpRoot !== "string" || mcpRoot.length === 0) return null
  const resolved = path.resolve(mcpRoot)
  const digest = path.basename(resolved)
  return path.basename(path.dirname(resolved)) === SOURCE_MIRROR_DIR && SOURCE_DIGEST.test(digest) ? digest : null
}

// `build` is part of the identity so that a session running a newer Desk never joins a controller an older build started: that controller may refuse the newer semantic contract and leave search waiting. Each build elects its own controller, and an older one is left alone until its own sessions end.
export function readinessContracts(policy, { build = null } = {}) {
  return {
    protocolVersion: 1,
    lexicalContract: {
      schema: 1,
      chunker: "markdown-v1",
      normalization: "unicode-v1",
      policy: {
        lexical: policy.lexical,
      },
    },
    build,
  }
}
