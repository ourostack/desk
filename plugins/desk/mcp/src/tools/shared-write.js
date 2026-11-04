// Crew's shared-write protocol, done by a tool itself: a change to a repository the team shares lands through a pull
// request the tool opens and merges at once. lesson_add's team write (lesson-team.js) and note_leave (note.js) use it.
//
// The write never touches the clone's checkout or uses its remotes: it fetches the default branch from
// https://github.com/<owner>/<repo>.git with the chosen account (pinned past the clone's redirect rules and extra headers,
// and given the token only for that), builds the change in a temporary sparse worktree that checks out only the paths
// the caller names, pushes a branch there, opens a pull request and merges it at once. When the origin is a fork, the
// change goes to the repository it was forked from. When the merge meets a conflict (someone else changed the same files
// first) it rebuilds the change on the new default branch and tries again. It counts the change merged only when GitHub
// says the pull request is merged: a merge queue or auto-merge that only queued it leaves it open, branch and all. The
// repository's own commit hooks and signing run as for any commit, and their refusal is reported, never skipped,
// because the shared-write protocol is an ordinary pull request.

import { promises as fs, existsSync } from "node:fs"
import * as path from "node:path"
import { normalizeRemote } from "../factory/binding.js"

const GIT_TIMEOUT_MS = 60_000
const MERGE_TRIES = 3
// After a merge command that succeeded, how many times GitHub is asked whether the pull request merged, 2 s apart.
const MERGE_POLLS = 5
// The settings for the tool's own fetch and push to `remote`. Only the chosen account's token, through gh, signs in: no
// other credential helper, no extra header a CI checkout left for github.com, no SSH. The exact address is rewritten to
// itself, which outranks any shorter redirect rule (`insteadOf`, `pushInsteadOf`) the clone or the machine carries.
const route = (remote) => [
  "credential.helper=", "credential.helper=!gh auth git-credential", "protocol.ssh.allow=never",
  "http.extraheader=", "http.https://github.com/.extraheader=",
  `url.${remote}.insteadOf=${remote}`, `url.${remote}.pushInsteadOf=${remote}`,
].flatMap((setting) => ["-c", setting])
// The temporary worktree checks out only what the write reads, and never downloads large files.
const SPARSE = ["-c", "core.sparseCheckout=true", "-c", "core.sparseCheckoutCone=false"]

export function runGit(args, { cwd, spawnGit, token, config = [] }) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_LFS_SKIP_SMUDGE: "1" }
  // Only the network calls get the chosen account's token; hooks and every other Git call never see it.
  if (token !== undefined) env.GH_TOKEN = token
  const result = spawnGit("git", [...config, "-C", cwd, ...args], { windowsHide: true, encoding: "utf8", timeout: GIT_TIMEOUT_MS, env })
  return { ok: result.status === 0, stdout: String(result.stdout ?? "").trim(), stderr: String(result.stderr ?? "").trim() }
}

/** A failure once the remote work started, at `stage`: the caller reports it rather than throwing it. */
export class Failed extends Error {
  constructor(stage, reason) {
    super(reason)
    this.stage = stage
  }
}

function must(result, stage, why = "") {
  if (!result.ok) throw new Failed(stage, `${why}${result.stderr.split("\n")[0] || `${stage} failed`}`)
  return result.stdout
}

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ghText = (answer) => String(answer.stdout ?? "").trim()
const ghJson = (answer) => {
  try {
    return JSON.parse(ghText(answer))
  } catch {
    return {}
  }
}

const prState = async (gh, url, token) => ghJson(await gh(["pr", "view", url, "--json", "state,mergeable,mergeStateStatus,mergeCommit"], { token }))

/** The `owner/repo` of the clone's origin when it is on GitHub, else null. */
export function githubStore(top, spawnGit) {
  const url = runGit(["config", "--get", "remote.origin.url"], { cwd: top, spawnGit })
  const match = url.ok && url.stdout !== "" ? /^https:\/\/github\.com\/([^/]+\/[^/]+)$/u.exec(normalizeRemote(url.stdout)) : null
  return match === null ? null : match[1]
}

/**
 * `sharedWrite({ top, origin, sparse, add, branch, title, prBody, commitMessage, closeComment, write, result, tmpPrefix,
 * spawnGit, gh, chooseAccount, tmpRoot, wait })`: lands one change on the default branch of `origin` (the GitHub
 * repository of the clone at `top`) through a pull request it merges.
 *
 * `sparse` lists the paths the temporary worktree checks out (sparse-checkout patterns) and `add` the paths the commit
 * stages. `write(tree, rebuilt)` runs on a fresh checkout of the default branch: it writes the change and returns a
 * truthy value, or returns null when the default branch already holds it. It may throw `Failed` to stop. It runs again,
 * with `rebuilt` true, when someone else's change landed first. `prBody()` gives the pull request's text after the first build.
 *
 * Returns `{ status: "unchanged" }` (nothing to add, any pull request it opened closed with `closeComment`),
 * `{ status: "pr_open", reason }` (opened, not merged; its branch kept) or `{ status: "merged", commit }`. A failure
 * once the remote work started throws `Failed`, and `result` gains `repo`, `account`, `pr` and `branch` as they become
 * known, so the caller can say what is left open. The temporary worktree is always removed.
 */
export async function sharedWrite({ top, origin, sparse, add, branch, title, prBody, commitMessage, closeComment, write, result, tmpPrefix, spawnGit, gh, chooseAccount, tmpRoot, wait }) {
  const tmp = await fs.mkdtemp(path.join(tmpRoot, tmpPrefix))
  const tree = path.join(tmp, "tree")
  // A signed-in account that can push to `store`, and its token.
  const access = async (store) => {
    const chosen = await chooseAccount({ store, runner: gh })
    if (chosen.result !== "account_found" || chosen.route !== "direct") throw new Failed("account", `no signed-in GitHub account can push to ${store} (${chosen.result === "account_found" ? "only through a fork" : chosen.result})`)
    const answer = await gh(["auth", "token", "--user", chosen.account])
    const token = ghText(answer)
    if (answer.code !== 0 || token === "") throw new Failed("account", `gh has no token for ${chosen.account}`)
    return { account: chosen.account, token }
  }
  const about = async (store, token) => {
    const info = ghJson(await gh(["api", `repos/${store}`, "--jq", "{base: .default_branch, parent: .parent.full_name}"], { token }))
    if (typeof info.base !== "string" || info.base === "") throw new Failed("default_branch", `could not read the default branch of ${store}`)
    return info
  }
  try {
    let store = origin
    let { account, token } = await access(store)
    let info = await about(store, token)
    // A fork's change belongs in the repository the team works in, the one it was forked from.
    if (typeof info.parent === "string" && info.parent !== "") {
      store = info.parent
      ;({ account, token } = await access(store))
      info = await about(store, token)
    }
    result.repo = store
    result.account = account
    const remote = `https://github.com/${store}.git`
    const network = (args, cwd, stage, why) => must(runGit(args, { cwd, token, spawnGit, config: route(remote) }), stage, why)
    const git = (args, stage, why) => must(runGit(args, { cwd: tree, spawnGit, config: SPARSE }), stage, why)
    const unpush = (name) => runGit(["push", "--quiet", remote, "--delete", name], { cwd: top, token, spawnGit, config: route(remote) })
    network(["fetch", "--quiet", remote, info.base], top, "fetch")
    must(runGit(["worktree", "add", "--quiet", "--no-checkout", "--detach", tree, "FETCH_HEAD"], { cwd: top, spawnGit }), "worktree")
    // The worktree's own sparse-checkout file, so the clone's configuration is left as it was.
    const sparseFile = path.resolve(tree, git(["rev-parse", "--git-path", "info/sparse-checkout"], "worktree"))
    await fs.mkdir(path.dirname(sparseFile), { recursive: true })
    await fs.writeFile(sparseFile, sparse.map((pattern) => `${pattern}\n`).join(""), "utf8")
    git(["reset", "--quiet", "--hard", "HEAD"], "worktree")
    // Commit and push one build; the repository's hooks and signing apply, and their refusal is reported.
    const publish = () => {
      git(["add", "--", ...add], "commit")
      git(["commit", "--quiet", "-m", commitMessage], "commit", "the commit was refused (this repository's commit hooks or signing): ")
      network(["push", "--quiet", "--force", remote, `HEAD:refs/heads/${branch}`], tree, "push", "the push was refused: ")
    }
    if ((await write(tree, false)) === null) return { status: "unchanged" }
    publish()
    const created = await gh(["pr", "create", "--repo", store, "--base", info.base, "--head", branch, "--title", title, "--body", prBody()], { token })
    const url = ghText(created).split("\n").pop()
    if (created.code !== 0 || !/^https:\/\/github\.com\//u.test(url)) {
      // Nothing should point at a branch no pull request uses.
      unpush(branch)
      throw new Failed("pull_request", `could not open the pull request: ${String(created.stderr ?? "").trim().split("\n")[0]}`)
    }
    result.pr = url
    result.branch = branch
    let state = {}
    for (let attempt = 1; ; attempt += 1) {
      const answer = await gh(["pr", "merge", url, "--squash"], { token })
      state = await prState(gh, url, token)
      // A merge command that succeeded may only have queued the pull request (a merge queue, auto-merge): only GitHub's
      // own state says it merged.
      for (let poll = 0; answer.code === 0 && state.state !== "MERGED" && poll < MERGE_POLLS; poll += 1) {
        await wait(2000)
        state = await prState(gh, url, token)
      }
      if (state.state === "MERGED" || answer.code === 0 || attempt === MERGE_TRIES) {
        if (state.state !== "MERGED" && answer.code === 0) state = { ...state, mergeStateStatus: "QUEUED" }
        break
      }
      // Someone changed the default branch first: build the change again on top of theirs. GitHub not having worked out
      // mergeability yet is a wait, not a failure.
      if (state.mergeable === "CONFLICTING") {
        // FETCH_HEAD belongs to the worktree that fetched, so the rebuild fetches in its own.
        network(["fetch", "--quiet", remote, info.base], tree, "fetch")
        git(["reset", "--quiet", "--hard", "FETCH_HEAD"], "reset")
        if ((await write(tree, true)) === null) {
          // Someone else merged this exact change first: this pull request has nothing left to add.
          await gh(["pr", "close", url, "--comment", closeComment], { token })
          unpush(branch)
          delete result.pr
          delete result.branch
          return { status: "unchanged" }
        }
        publish()
      } else if (state.mergeable === "UNKNOWN") await wait(2000)
      else break
    }
    if (state.state !== "MERGED") return { status: "pr_open", reason: state.mergeStateStatus ?? "unknown" }
    unpush(branch)
    delete result.branch
    return { status: "merged", commit: state.mergeCommit?.oid ?? null }
  } finally {
    // Clean-up never replaces the result: a folder Windows still holds open is left for the system's temp clean-up.
    const quietly = async (step) => {
      try {
        await step()
      } catch {
        // Left behind; nothing depends on it.
      }
    }
    await quietly(() => existsSync(tree) && runGit(["worktree", "remove", "--force", tree], { cwd: top, spawnGit }))
    await quietly(() => fs.rm(tmp, { recursive: true, force: true }))
    await quietly(() => runGit(["worktree", "prune"], { cwd: top, spawnGit }))
  }
}
