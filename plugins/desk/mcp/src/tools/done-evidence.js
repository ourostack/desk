// What a move to `done` must prove when the task's card names code repos (`repos:`).
//
// The invented-completion finding (boot acceptance round 6): an agent that could not open its pull request wrote a
// plan, recorded `commit` evidence for a commit it made in the desk itself (it held only the card edit) and told the
// operator "Task complete". A card that names code repos is finished by code in those repos, so the evidence must
// come from them:
//   - `pr`: a pull request URL whose repository is one of the task's repos (no network call: shape and repository only);
//   - `commit`: a commit that resolves in one of the task's recorded local clones and is already contained in a
//     remote-tracking branch of that clone (pushed), never a commit in the desk;
//   - `ci_run` and `non_code` are refused: a task with code repos is not a non-code task.
// A card with no repos is unaffected here (`task.js` keeps its own per-kind shape checks for it).

import { realpathSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { expandHome } from "../util/paths.js"
import { normalizeRemote } from "../factory/binding.js"

const GIT_TIMEOUT_MS = 5000
const SHA_PREFIX = /^[0-9a-f]{7,40}/iu
const SHA_IN_URL = /\/commit\/([0-9a-f]{7,40})(?![0-9a-f])/iu
// A URL's tail may carry a sub-page (`/files`), a query or a fragment, but nothing before the identifying segments.
const TAIL = String.raw`(?:[/?#].*)?$`
const GITHUB_URL = {
  pr: new RegExp(String.raw`^https://(?:www\.)?github\.com/([^/\s?#]+)/([^/\s?#]+)/pull/\d+${TAIL}`, "iu"),
  commit: new RegExp(String.raw`^https://(?:www\.)?github\.com/([^/\s?#]+)/([^/\s?#]+)/commit/[0-9a-f]{7,40}(?![0-9a-f])${TAIL}`, "iu"),
}
// Azure DevOps: `dev.azure.com/<org>/<project>/_git/<repo>/...` or `<org>.visualstudio.com/<project>/_git/<repo>/...` (the project may be omitted when it is named like the repo).
const ADO_URL = {
  pr: new RegExp(String.raw`^https://(?:dev\.azure\.com/[^/\s?#]+|[^/\s?#.]+\.visualstudio\.com)(?:/[^/\s?#]+)?/_git/([^/\s?#]+)/pullrequest/\d+${TAIL}`, "iu"),
  commit: new RegExp(String.raw`^https://(?:dev\.azure\.com/[^/\s?#]+|[^/\s?#.]+\.visualstudio\.com)(?:/[^/\s?#]+)?/_git/([^/\s?#]+)/commit/[0-9a-f]{7,40}(?![0-9a-f])${TAIL}`, "iu"),
}
// Any other host (GitHub Enterprise and the like) is trusted only when a recorded clone has a remote on it.
const OTHER_URL = {
  pr: new RegExp(String.raw`^https://([^/\s?#]+)/(?:[^/\s?#]+/)*?([^/\s?#]+)/(?:pull|pullrequest)/\d+${TAIL}`, "iu"),
  commit: new RegExp(String.raw`^https://([^/\s?#]+)/(?:[^/\s?#]+/)*?([^/\s?#]+)/commit/[0-9a-f]{7,40}(?![0-9a-f])${TAIL}`, "iu"),
}

/**
 * The card's recorded repos as `{ name, localPath, mode }`, or `[]` when it names none (not a list, or no usable entry).
 * A bare string entry (`repos: [widgets]`) names a repo with no recorded clone, so it counts as a repo.
 */
export function recordedRepos(value) {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === "string") return entry.trim() === "" ? [] : [{ name: entry.trim(), localPath: "", mode: undefined }]
    if (entry === null || typeof entry !== "object" || typeof entry.name !== "string" || entry.name.trim() === "") return []
    return [{ name: entry.name.trim(), localPath: typeof entry.local_path === "string" ? entry.local_path.trim() : "", mode: entry.mode }]
  })
}

// A clone's directory: `~` against the call's home, and a relative path against the desk root (never the process's
// working directory, which differs from call to call).
function clonePath(localPath, { homeDir, deskRoot }) {
  return path.resolve(deskRoot, expandHome(localPath, homeDir))
}

function describeRepos(repos) {
  return repos.map((repo) => (repo.localPath === "" ? `${repo.name} (no local clone recorded)` : `${repo.name} (${repo.localPath})`)).join(", ")
}

function git(spawnGit, dir, args) {
  const result = spawnGit("git", ["-C", dir, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS })
  return result?.status === 0 && typeof result.stdout === "string" ? result.stdout : null
}

function lastSegments(urlPath, count) {
  return urlPath.split("/").filter((segment) => segment !== "").slice(-count).join("/").toLowerCase()
}

const isGithub = (host) => /^(www\.)?github\.com$/iu.test(host)

// The repository a PR or commit URL points at, by the host's own shape: GitHub `owner/repo`, Azure DevOps and any other
// host by the bare repo name. A URL that does not have exactly that shape names no repo (`host: ""`).
function urlRepo(ref, kind) {
  let match = GITHUB_URL[kind].exec(ref)
  if (match !== null) return { type: "github", id: `${match[1]}/${match[2]}`.toLowerCase() }
  match = ADO_URL[kind].exec(ref)
  if (match !== null) return { type: "ado", id: match[1].toLowerCase() }
  match = OTHER_URL[kind].exec(ref)
  if (match !== null && !isGithub(match[1])) return { type: "other", host: match[1].toLowerCase(), id: match[2].toLowerCase() }
  return { type: "none", id: "" }
}

// Every name a repo can be recognised by: its recorded name, plus the remotes of its local clone (an `origin` that is a
// fork and an `upstream` are both in the clone's config, so a PR opened from the fork route against the upstream, or on
// the fork itself, both match).
function repoIdentities(repos, { spawnGit, homeDir, deskRoot }) {
  const hosts = new Set()
  const github = new Set()
  const bare = new Set()
  const plainNames = new Set()
  for (const repo of repos) {
    if (repo.name.includes("/")) github.add(repo.name.toLowerCase())
    else plainNames.add(repo.name.toLowerCase())
    bare.add(lastSegments(repo.name, 1))
    if (repo.localPath === "") continue
    const listed = git(spawnGit, clonePath(repo.localPath, { homeDir, deskRoot }), ["config", "--get-regexp", "^remote\\..*\\.url$"])
    for (const line of (listed ?? "").split("\n")) {
      const url = line.trim().split(/\s+/u)[1]
      if (url === undefined) continue
      const normalized = normalizeRemote(url)
      const host = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)(\/.*|)$/u.exec(normalized)
      if (host === null) continue
      if (isGithub(host[1])) github.add(lastSegments(host[2], 2))
      else {
        bare.add(lastSegments(host[2], 1))
        hosts.add(host[1].toLowerCase())
      }
    }
  }
  return { github, bare, plainNames, hosts }
}

function matchesRepos(target, identities) {
  if (target.type === "github") return identities.github.has(target.id) || identities.plainNames.has(target.id.split("/").at(-1))
  if (target.type === "ado") return identities.bare.has(target.id)
  if (target.type === "other") return identities.hosts.has(target.host) && identities.bare.has(target.id)
  return false
}

function repoRefusal(toolName, kind, ref, repos) {
  return (
    `${toolName}: \`evidence.ref\` ${JSON.stringify(ref)} is not in this task's repos (${describeRepos(repos)}). ` +
    `Supply ${kind === "pr" ? "a PR URL" : "a commit URL"} in one of those repos; a pull request from a fork is opened against the upstream repo, so use the upstream's URL.`
  )
}

function codeRepoUsage(toolName, repos) {
  return (
    `This task's card names code repos (${describeRepos(repos)}), so it is finished by code in them. ` +
    `Pass \`evidence: { kind: "pr", ref: "<the pull request's URL>" }\` for a pull request in one of those repos, or ` +
    `\`evidence: { kind: "commit", ref: "<sha>" }\` for a commit that exists in a recorded clone and is already pushed (a remote-tracking branch contains it). ` +
    `A commit in the desk itself does not count, and neither does a plan or notes file. If the work cannot be delivered yet (no way to open the pull request, no push access), ` +
    `do not mark the task done: leave it \`blocked\` or \`collaborating\` and say what is missing.`
  )
}

function sameDirectory(a, b) {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

function checkCommit({ toolName, evidence, repos, deskRoot, spawnGit, homeDir }) {
  const ref = evidence.ref.trim()
  const isUrl = ref.startsWith("https://")
  if (isUrl && !matchesRepos(urlRepo(ref, "commit"), repoIdentities(repos, { spawnGit, homeDir, deskRoot }))) {
    throw new Error(repoRefusal(toolName, "commit", evidence.ref, repos))
  }
  const sha = (isUrl ? SHA_IN_URL : SHA_PREFIX).exec(ref)[isUrl ? 1 : 0]
  const clones = repos.filter((repo) => repo.localPath !== "").map((repo) => ({ repo, dir: clonePath(repo.localPath, { homeDir, deskRoot }) }))
  if (clones.length === 0) {
    throw new Error(
      `${toolName}: commit evidence needs a local clone to check, and none of this task's repos (${describeRepos(repos)}) records one. ` +
        "Supply a pull request URL instead (`evidence: { kind: \"pr\", ref: \"<URL>\" }`), or record the clone's `local_path` on the card first.",
    )
  }
  let unpushed = null
  for (const { repo, dir } of clones) {
    if (sameDirectory(dir, deskRoot)) continue
    if (git(spawnGit, dir, ["cat-file", "-e", `${sha}^{commit}`]) === null) continue
    const pushed = git(spawnGit, dir, ["for-each-ref", "--contains", sha, "--count=1", "--format=%(refname)", "refs/remotes"])
    if (pushed !== null && pushed.trim() !== "") return
    unpushed ??= repo
  }
  if (unpushed !== null) {
    throw new Error(
      `${toolName}: commit ${sha} exists in ${unpushed.name} (${unpushed.localPath}) but no remote-tracking branch contains it, so it is not pushed. ` +
        "If the commit was pushed or merged elsewhere (a squash-merged PR's commit reaches the default branch only after a fetch), run `git fetch` in that clone and repeat this call. " +
        "Otherwise push the branch (`git push`, which also updates the remote-tracking branch), then repeat; or supply the pull request URL.",
    )
  }
  throw new Error(
    `${toolName}: commit ${sha} does not resolve in any of this task's repo clones (${describeRepos(repos)}). ` +
      "If the commit is on the remote (for example a squash-merged PR), run `git fetch` in the recorded clone first and repeat this call. " +
      "A commit made in the desk, or in a repo the card does not list, does not count. Supply a commit from one of those repos that is pushed, or the pull request URL.",
  )
}

/**
 * Throws, naming exactly what to supply, unless `evidence` (already shape-checked by `task.js`) is acceptable for a
 * card that records `repos`. Does nothing when the card records none. `spawnGit` and `homeDir` are test seams.
 */
export function assertCodeRepoEvidence({ toolName, evidence, repos, deskRoot, spawnGit = spawnSync, homeDir = os.homedir() }) {
  if (repos.length === 0) return
  if (evidence.kind === "non_code" || evidence.kind === "ci_run") {
    throw new Error(`${toolName}: \`${evidence.kind}\` evidence cannot complete a task that names code repos. ${codeRepoUsage(toolName, repos)}`)
  }
  if (evidence.kind === "pr") {
    const identities = repoIdentities(repos, { spawnGit, homeDir, deskRoot })
    if (!matchesRepos(urlRepo(evidence.ref.trim(), "pr"), identities)) throw new Error(repoRefusal(toolName, "pr", evidence.ref, repos))
    return
  }
  checkCommit({ toolName, evidence, repos, deskRoot, spawnGit, homeDir })
}
