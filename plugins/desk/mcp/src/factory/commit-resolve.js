// Resolves a Copilot session's `session_refs` commits in the session's own
// repository: a short SHA (7–9 hex characters in practice) to its full
// 40-hex SHA, and a full one to whether that repository has it. It also
// reports that repository's `origin`, so the deriver labels a commit with the
// session's repository only when the commit was found in that repository
// (review I2, M3-5 fix round 2).
//
// `createCommitResolver({ git, timeoutMs })` returns `resolveCommits({
// gitRoot, cwd, shas }) -> { origin, fulls }`:
//   - The repository is `gitRoot` when it is an absolute, existing
//     directory that is its repository's top level (an empty `rev-parse
//     --show-prefix`). Otherwise it is the top level of `cwd`'s repository
//     (`rev-parse --show-toplevel`), so a session started in a subdirectory
//     still resolves, in that directory's own repository. With neither,
//     nothing resolves.
//   - `origin` is `normalizeRemote(<git remote get-url origin>)`, or `null`.
//   - `fulls[i]` is the full SHA of `shas[i]` when the repository has that
//     commit, else `null`. All of them are asked in one `git cat-file
//     --batch-check`, each as `<sha>^{commit}`, so a tree or blob never
//     answers. A value must be 4–40 hex characters before it is written, so
//     it can never read as an option or smuggle a second line.
//
// Git runs through `execFileSync` with an argument array (no shell),
// `GIT_*` variables removed, no prompts and a short timeout; `cat-file`,
// `rev-parse` and `remote get-url` read no index, so a repository's own
// `core.fsmonitor` never runs. Any failure reads as "not found", never a
// throw, and nothing Git prints is kept but SHAs and the normalized origin.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"

import { normalizeRemote } from "./binding.js"
import { gitEnv } from "./desk-repo.js"

export const SHORT_SHA = /^[0-9a-fA-F]{4,40}$/u
const BATCH_LINE = /^([0-9a-f]{40}) commit \d+$/u
const DEFAULT_TIMEOUT_MS = 5_000

const isDirectory = (value) => typeof value === "string" && path.isAbsolute(value) && existsSync(value)

export function createCommitResolver({ git = "git", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const run = (root, args, input) => {
    try {
      return execFileSync(git, ["-C", root, ...args], {
        encoding: "utf8",
        env: gitEnv(),
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        input: input ?? "",
        stdio: ["pipe", "pipe", "ignore"],
      })
    } catch {
      return null
    }
  }

  function repositoryOf(gitRoot, cwd) {
    if (isDirectory(gitRoot) && run(gitRoot, ["rev-parse", "--show-prefix"])?.trim() === "") return gitRoot
    if (!isDirectory(cwd)) return null
    const top = run(cwd, ["rev-parse", "--show-toplevel"])?.trim()
    return top ? top : null
  }

  function originOf(root) {
    const url = run(root, ["remote", "get-url", "origin"])?.trim()
    return url ? normalizeRemote(url) : null
  }

  function lookUp(root, shas) {
    const asked = shas.filter((sha) => typeof sha === "string" && SHORT_SHA.test(sha))
    const found = new Map()
    if (asked.length === 0) return found
    // One output line per input line, in order; a missing line matches nothing.
    const output = run(root, ["cat-file", "--batch-check"], asked.map((sha) => `${sha}^{commit}\n`).join(""))
    const lines = output === null ? [] : output.split("\n")
    asked.forEach((sha, index) => {
      const match = BATCH_LINE.exec(lines[index])
      if (match !== null) found.set(sha, match[1])
    })
    return found
  }

  return function resolveCommits({ gitRoot = null, cwd = null, shas = [] } = {}) {
    const list = Array.isArray(shas) ? shas : []
    const root = repositoryOf(gitRoot, cwd)
    if (root === null) return { origin: null, fulls: list.map(() => null) }
    const found = lookUp(root, list)
    return { origin: originOf(root), fulls: list.map((sha) => found.get(sha) ?? null) }
  }
}
