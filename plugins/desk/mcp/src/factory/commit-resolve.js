// Resolves a Copilot `session_refs` commit, which the host records as a
// short SHA (7–9 hex characters in practice), to its full 40-hex SHA in the
// session's own repository, so a published commit reference is exact and
// M3-4's `gitCommitTaskPaths` gets a full hash.
//
// `createCommitResolver({ git, timeoutMs })` returns `resolveCommit(gitRoot,
// shortSha) -> fullSha | null`. It runs `git -C <gitRoot> rev-parse --verify
// --quiet <short>^{commit}` through `execFileSync` with an argument array (no
// shell), `GIT_*` variables removed, no prompts and a short timeout. The
// short SHA must be 4–40 hex characters, so it can never read as an option.
// `gitRoot` must be an absolute path that exists and is its repository's top
// level (an empty `rev-parse --show-prefix`, asked once per root), so Git
// never walks up into an enclosing repository. Anything else — a missing
// directory, no Git, an unknown or ambiguous SHA, a timeout — is `null`,
// never a throw. Only the SHA is returned; nothing else Git prints is kept.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"

import { gitEnv } from "./desk-repo.js"
import { PATTERNS } from "./schema.js"

export const SHORT_SHA = /^[0-9a-fA-F]{4,40}$/u
const DEFAULT_TIMEOUT_MS = 5_000

export function createCommitResolver({ git = "git", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const run = (root, args) => {
    try {
      return execFileSync(git, ["-C", root, ...args], {
        encoding: "utf8",
        env: gitEnv(),
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      return null
    }
  }
  const topLevels = new Map()
  const isTopLevel = (root) => {
    if (!topLevels.has(root)) {
      const prefix = run(root, ["rev-parse", "--show-prefix"])
      topLevels.set(root, prefix !== null && prefix.trim() === "")
    }
    return topLevels.get(root)
  }

  return function resolveCommit(gitRoot, shortSha) {
    if (typeof shortSha !== "string" || !SHORT_SHA.test(shortSha)) return null
    if (typeof gitRoot !== "string" || !path.isAbsolute(gitRoot) || !existsSync(gitRoot) || !isTopLevel(gitRoot)) return null
    const output = run(gitRoot, ["rev-parse", "--verify", "--quiet", `${shortSha}^{commit}`])
    const full = output === null ? "" : output.trim().toLowerCase()
    return PATTERNS.commitSha.test(full) ? full : null
  }
}
