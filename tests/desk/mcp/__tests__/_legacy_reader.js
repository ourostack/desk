// The improvement-card reader as it was before the triage alarm code existed, for compatibility tests: a card the new writer saves must
// still be read by the reader an older installed plugin runs.
//
// The baseline is the source tree at `LEGACY_REVISION`, a revision whose strict writer still refuses `loop_alarm:step_stale:triage`.
// `DESK_TRIAGE_LEGACY_SOURCE` names a checkout of it that someone else provisioned (a separate worktree, never this one). Without the
// variable the helper checks the same revision out of this repository's own Git history into a temporary folder, through a private index,
// so nothing in the checkout or its index changes. A baseline that cannot be had either way throws: a compatibility test never skips.

import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mkTempRoot } from "./_temp_roots.js"

export const LEGACY_REVISION = "9505df0fbcc6d5f767a12f8b98819f612fe8370b"
export const LEGACY_SOURCE_ENV = "DESK_TRIAGE_LEGACY_SOURCE"
const MCP = ["plugins", "desk", "mcp"]
const READER = [...MCP, "src", "desk", "improvement-cards.js"]
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")

let materialized = null

async function checkOutBaseline() {
  const root = await mkTempRoot("desk-legacy-reader-")
  // A checkout another account owns (the Windows standard-user run) is refused unless a global configuration file trusts it.
  const config = path.join(root, "gitconfig")
  await fs.writeFile(config, "[safe]\n\tdirectory = *\n")
  const env = { ...process.env, GIT_INDEX_FILE: path.join(root, "index"), GIT_CONFIG_GLOBAL: config }
  const target = path.join(root, "source", ...MCP)
  await fs.mkdir(target, { recursive: true })
  const git = (args) => {
    const result = spawnSync("git", ["-C", repoRoot, ...args], { env, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`The legacy reader baseline ${LEGACY_REVISION} could not be checked out of this repository's history (git ${args[0]}: ${String(result.stderr ?? result.error).trim()}). Fetch the full history or set ${LEGACY_SOURCE_ENV} to a checkout of that revision.`)
  }
  git(["read-tree", `${LEGACY_REVISION}:${MCP.join("/")}`])
  git(["checkout-index", "-a", `--prefix=${target.split(path.sep).join("/")}/`])
  return path.join(root, "source")
}

/**
 * `legacyCards(env) -> { module, source, revision, provisioned }`: the baseline `improvement-cards.js` module, imported from the baseline
 * source tree (`source`). `provisioned` is true when `DESK_TRIAGE_LEGACY_SOURCE` supplied the tree. Throws when the variable names
 * something that is not a separate checkout holding the reader, or when the history does not hold the baseline.
 */
export async function legacyCards(env = process.env) {
  const named = env[LEGACY_SOURCE_ENV]
  const provisioned = typeof named === "string" && named.length > 0
  let source
  if (provisioned) {
    if (!path.isAbsolute(named)) throw new Error(`${LEGACY_SOURCE_ENV} must be an absolute path to a checkout of ${LEGACY_REVISION}`)
    source = await fs.realpath(named).catch(() => { throw new Error(`${LEGACY_SOURCE_ENV} names no folder: the legacy reader baseline is missing`) })
    if (source === (await fs.realpath(repoRoot))) throw new Error(`${LEGACY_SOURCE_ENV} names this checkout; the baseline must be a separate one`)
  } else {
    materialized ??= checkOutBaseline()
    source = await materialized
  }
  const file = path.join(source, ...READER)
  await fs.access(file).catch(() => { throw new Error(`the legacy reader baseline holds no ${READER.join("/")}`) })
  return { module: await import(pathToFileURL(file).href), source, revision: LEGACY_REVISION, provisioned }
}
