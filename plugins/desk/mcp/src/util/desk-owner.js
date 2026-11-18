// Which desk owns a repository, a track or a path, for operators who keep more than one desk on a machine
// (a personal desk and a work desk). Desks are found by their home-folder names, classified by their Git
// remote's owner, and matched to a session's repository by that repository's owner.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isDeskWorkspace } from "./paths.js"

const DESK_FOLDERS = Object.freeze(["personal-desk", "ms-desk", "desk", "worker-workspace"])
// Repository owners that are the operator's own, besides the owner of the personal desk's remote.
const PERSONAL_REPO_OWNERS = Object.freeze(["ourostack"])
// Microsoft organizations, besides the owner of the work desk's remote.
const WORK_REPO_OWNERS = Object.freeze(["microsoft", "gim-home", "teams-microsoft", "shared-internal-tools", "azure", "office"])

/** `owner` and `repo` of a Git remote URL (https or scp style), or null. */
export function parseRemote(url) {
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^/]+\/|(?:[^@/]*@)?[^:/]+:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(String(url ?? "").trim())
  return match === null ? null : { owner: match[1], repo: match[2] }
}

function originOf(folder, spawn) {
  if (!folder || !existsSync(folder)) return null
  const run = spawn(
    "git",
    ["-C", folder, "config", "--get", "remote.origin.url"],
    { encoding: "utf8", timeout: 2000, windowsHide: true },
  )
  return run.status === 0 ? parseRemote(run.stdout) : null
}

/** The owner of the repository checked out at `folder`, lower-cased, or null. */
export function repoOwnerOf(folder, spawn = spawnSync) {
  return originOf(folder, spawn)?.owner.toLowerCase() ?? null
}

/** Every desk workspace in the operator's home folder: `{ root, name, owner, kind }`; `kind` is "work", "personal" or "unknown". */
export function knownDesks({ homeDir = os.homedir(), spawn = spawnSync } = {}) {
  return DESK_FOLDERS
    .map((folder) => path.join(homeDir, folder))
    .filter((root) => isDeskWorkspace(root))
    .map((root) => {
      const remote = originOf(root, spawn)
      const owner = remote?.owner.toLowerCase() ?? null
      return { root, name: remote === null ? path.basename(root) : `${remote.owner}/${remote.repo}`, owner, kind: deskKind(owner, root) }
    })
}

function deskKind(owner, root) {
  if (owner !== null && owner.endsWith("_microsoft")) return "work"
  if (owner !== null) return "personal"
  return path.basename(root) === "ms-desk" ? "work" : "unknown"
}

/** The one desk whose kind matches the repository owner, or null when the owner or the match is not clear. */
export function deskForRepoOwner(repoOwner, { homeDir = os.homedir(), spawn = spawnSync } = {}) {
  if (!repoOwner) return null
  const desks = knownDesks({ homeDir, spawn })
  const personalOwners = new Set([...PERSONAL_REPO_OWNERS, ...desks.filter((d) => d.kind === "personal" && d.owner).map((d) => d.owner)])
  const workOwners = new Set([...WORK_REPO_OWNERS, ...desks.filter((d) => d.kind === "work" && d.owner).flatMap((d) => [d.owner, d.owner.replace(/_microsoft$/u, "")])])
  const kind = personalOwners.has(repoOwner) ? "personal" : workOwners.has(repoOwner) ? "work" : null
  if (kind === null) return null
  const matches = desks.filter((d) => d.kind === kind)
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
  const top = String(rel).split(/[\\/]/u).find((part) => part !== "" && part !== ".")
  if (!top || top === ".." || existsSync(path.join(deskRoot, top))) return null
  const here = path.resolve(deskRoot)
  return knownDesks({ homeDir, spawn }).find((desk) => path.resolve(desk.root) !== here && existsSync(path.join(desk.root, top))) ?? null
}

/** The desk, other than `deskRoot`, that contains the absolute path `target`, or null. */
export function otherDeskContaining(deskRoot, target, { homeDir = os.homedir(), spawn = spawnSync } = {}) {
  const here = path.resolve(deskRoot)
  return knownDesks({ homeDir, spawn }).find((desk) => {
    const root = path.resolve(desk.root)
    return root !== here && (target === root || target.startsWith(root + path.sep))
  }) ?? null
}
