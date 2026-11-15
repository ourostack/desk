// Where a file Desk saved under a task's `handoffs/` folder will be readable by anyone: its repository URL.
//
// A session that hands work on writes the artifact into `<track>/<slug>/handoffs/` with desk_save and names the URL, never
// a path in its own session folder or the temp folder. The URL resolves once the push lands on the branch it names.

import { spawnSync } from "node:child_process"

const HANDOFFS = /(?:^|\/)handoffs\//u

/** True when the desk-relative `rel` is inside a `handoffs/` folder. */
export const isHandoffPath = (rel) => HANDOFFS.test(rel.replaceAll("\\", "/"))

function git(root, args, spawnGit) {
  const result = spawnGit("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, timeout: 5000 })
  return result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : ""
}

/** The `https://<host>/<owner>/<repo>/blob/<branch>/<path>` of desk-relative `rel`, or undefined when the desk has no GitHub-style origin. Never throws. */
export function handoffReference(root, rel, spawnGit = spawnSync) {
  try {
    const remote = git(root, ["config", "--get", "remote.origin.url"], spawnGit)
    const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(remote)
    if (match === null) return undefined
    const current = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], spawnGit)
    const tracked = current === "" ? "" : git(root, ["config", `branch.${current}.merge`], spawnGit).replace(/^refs\/heads\//u, "")
    const head = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], spawnGit).replace(/^origin\//u, "")
    const branch = tracked !== "" ? tracked : head !== "" ? head : "main"
    const prefix = git(root, ["rev-parse", "--show-prefix"], spawnGit)
    const file = `${prefix}${rel.replaceAll("\\", "/")}`.split("/").map(encodeURIComponent).join("/")
    return `https://${match[1]}/${match[2]}/${match[3]}/blob/${branch.split("/").map(encodeURIComponent).join("/")}/${file}`
  } catch {
    return undefined
  }
}
