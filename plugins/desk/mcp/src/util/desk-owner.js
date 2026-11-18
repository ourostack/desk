// Which desk owns a repository, a track or a path, for operators who keep more than one desk on a machine
// (a personal desk and a work desk). Desks are found by their home-folder names and matched to a session's
// repository by that repository's owner. Each desk declares the owners it serves in `_meta/desk.json`
// (`{"repo_owners": ["acme"]}`), besides the owner of its own Git remote; Desk itself names no organization.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isDeskWorkspace } from "./paths.js"

const DESK_FOLDERS = Object.freeze(["personal-desk", "ms-desk", "desk", "worker-workspace"])
/** `owner` and `repo` of a Git remote URL (https or scp style), or null. */
function parseRemote(url) {
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^/]+\/|(?:[^@/]*@)?[^:/]+:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(url.trim())
  return match === null ? null : { owner: match[1], repo: match[2] }
}

function originOf(folder, spawn) {
  const run = spawn(
    "git",
    ["-C", folder, "config", "--get", "remote.origin.url"],
    { encoding: "utf8", timeout: 5000, windowsHide: true },
  )
  return run.status === 0 ? parseRemote(run.stdout) : null
}

/** The owner of the repository checked out at `folder`, lower-cased, or null. */
export function repoOwnerOf(folder, spawn = spawnSync) {
  return originOf(folder, spawn)?.owner.toLowerCase() ?? null
}

function declaredOwners(root) {
  try {
    const owners = JSON.parse(readFileSync(path.join(root, "_meta", "desk.json"), "utf8")).repo_owners
    return Array.isArray(owners) ? owners.map((o) => String(o).toLowerCase()) : []
  } catch {
    return []
  }
}

/** Every desk workspace in the operator's home folder: `{ root, name, owners }`; `owners` are the repository owners it serves. */
function knownDesks({ homeDir, spawn }) {
  return DESK_FOLDERS
    .map((folder) => path.join(homeDir, folder))
    .filter((root) => isDeskWorkspace(root))
    .map((root) => {
      const remote = originOf(root, spawn)
      const own = remote === null ? [] : [remote.owner.toLowerCase()]
      return { root, name: remote === null ? path.basename(root) : `${remote.owner}/${remote.repo}`, owners: [...own, ...declaredOwners(root)] }
    })
}

/** The one desk that serves the repository owner, or null when the owner or the match is not clear. */
export function deskForRepoOwner(repoOwner, { homeDir, spawn = spawnSync }) {
  if (!repoOwner) return null
  const matches = knownDesks({ homeDir, spawn }).filter((d) => d.owners.includes(repoOwner))
  return matches.length === 1 ? matches[0] : null
}

/** `{ root, name }` for a desk root: what a read tool tells the caller it searched. */
export function describeDesk(root, spawn = spawnSync) {
  const remote = originOf(root, spawn)
  return { root, name: remote === null ? path.basename(root) : `${remote.owner}/${remote.repo}` }
}

/**
 * The other desk that owns `rel` when this desk does not hold its top-level folder (the track) but another desk does, or null.
 * `rel` is relative to `deskRoot`.
 */
export function otherDeskOwning(deskRoot, rel, { homeDir = os.homedir(), spawn = spawnSync } = {}) {
  const top = rel.split(path.sep)[0]
  if (existsSync(path.join(deskRoot, top))) return null
  const here = path.resolve(deskRoot)
  return knownDesks({ homeDir, spawn }).find((desk) => path.resolve(desk.root) !== here && existsSync(path.join(desk.root, top))) ?? null
}

/** The desk, other than `deskRoot`, that contains the absolute path `target`, or null. */
export function otherDeskContaining(deskRoot, target, { homeDir = os.homedir(), spawn = spawnSync } = {}) {
  const here = path.resolve(deskRoot)
  return knownDesks({ homeDir, spawn }).find((desk) => {
    const root = path.resolve(desk.root)
    return root !== here && target.startsWith(root + path.sep)
  }) ?? null
}

/** The desk, other than `deskRoot`, that holds the card `track/slug` (live only), or null. */
export function otherDeskHoldingCard(deskRoot, track, slug, { homeDir = os.homedir(), spawn = spawnSync } = {}) {
  const here = path.resolve(deskRoot)
  return knownDesks({ homeDir, spawn }).find((desk) => path.resolve(desk.root) !== here
    && existsSync(path.join(desk.root, track, slug, "task.md"))) ?? null
}
