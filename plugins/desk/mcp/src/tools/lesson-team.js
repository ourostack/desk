// lesson_add's team write: a lesson for every teammate's agents goes into the `## Lessons` section of the root AGENTS.md
// of the repository the team works in, through that repository's own contribution path, done by the tool itself.
//
// The repository is the GitHub repository of a local clone: a Crew shared workspace (the desk itself, the default there)
// or a team's code repository that is not a desk at all. When the clone's origin is a fork, the lesson goes to the
// repository it was forked from. The write never touches the clone's checkout or uses its remotes: it fetches the
// default branch from https://github.com/<owner>/<repo>.git with the chosen account (pinned past the clone's redirect
// rules and extra headers, and given the token only for that), builds the change in a temporary sparse worktree that
// checks out only AGENTS.md and CLAUDE.md, pushes a branch there, opens a pull request and merges it at once. When the merge meets a conflict (someone
// else changed AGENTS.md first) it rebuilds the change on the new default branch and tries again. It counts the lesson
// merged only when GitHub says the pull request is merged: a merge queue or auto-merge that only queued it leaves it
// open, branch and all. The repository's own commit hooks and signing run as for any commit, and their refusal is
// reported, never skipped, because Crew's shared-write protocol is an ordinary pull request.

import { promises as fs, existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { today, slugify } from "../util/fm.js"
import { resolveLocalPath } from "../util/paths.js"
import { normalizeRemote } from "../factory/binding.js"
import { chooseAccount as chooseAccountDefault, ghRunner } from "../factory/flush.js"
import { withAmbientToken } from "../runtime/boot.js"
import { printedPart } from "../runtime/agents-md.js"
import { crewWorkspace } from "../desk/crew-roster.js"
import { SECTION, lead, lessonLine, oneLine, withLesson } from "./lesson-lines.js"

const GIT_TIMEOUT_MS = 60_000
const MERGE_TRIES = 3
// After a merge command that succeeded, how many times GitHub is asked whether the pull request merged, 2 s apart.
const MERGE_POLLS = 5
const DATE = /\b\d{4}-\d{2}-\d{2}\b/u
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

function runGit(args, { cwd, spawnGit, token, config = [] }) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_LFS_SKIP_SMUDGE: "1" }
  // Only the network calls get the chosen account's token; hooks and every other Git call never see it.
  if (token !== undefined) env.GH_TOKEN = token
  const result = spawnGit("git", [...config, "-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env })
  return { ok: result.status === 0, stdout: String(result.stdout ?? "").trim(), stderr: String(result.stderr ?? "").trim() }
}

class Failed extends Error {
  constructor(stage, reason) {
    super(reason)
    this.stage = stage
  }
}

function must(result, stage, why = "") {
  if (!result.ok) throw new Failed(stage, `${why}${result.stderr.split("\n")[0] || `${stage} failed`}`)
  return result.stdout
}

/** The clone the lesson goes to: `repo` when given, else the desk itself when it is a shared workspace. */
function repoRoot({ deskRoot, repo, spawnGit }) {
  if (repo === undefined || repo === null) {
    if (crewWorkspace(deskRoot).crew) return deskRoot
    throw new Error("lesson_add: a team lesson needs `repo`, the path of your local clone of the team's repository (this desk is not a shared workspace)")
  }
  const dir = resolveLocalPath(oneLine(repo, "repo"), { deskRoot })
  const top = runGit(["rev-parse", "--show-toplevel"], { cwd: dir, spawnGit })
  if (!top.ok) throw new Error(`lesson_add: \`repo\` is not a Git clone: ${dir}`)
  return path.resolve(top.stdout)
}

/**
 * Where the lesson came from, checked against the default branch checked out in `tree` (which holds only AGENTS.md and
 * CLAUDE.md, so the check reads Git's objects). A team decision lives in the repository's decision records, so where the
 * default branch keeps `_shared/decisions/`, `source` must name one of its files. Elsewhere it names who said it, where
 * and when, with the date as YYYY-MM-DD.
 */
function sourceOf(tree, source, spawnGit) {
  const kind = (rel) => runGit(["cat-file", "-t", `HEAD:${rel}`], { cwd: tree, spawnGit }).stdout
  if (kind("_shared/decisions") === "tree") {
    const rel = path.posix.normalize(source.replace(/\\/gu, "/"))
    if (!rel.startsWith("_shared/decisions/") || kind(rel) !== "blob") {
      throw new Failed("source", "this repository keeps team decisions in _shared/decisions/ on its default branch, so `source` must be the path of the decision record there that this lesson comes from (record and merge the decision first)")
    }
    return rel
  }
  if (!DATE.test(source)) throw new Failed("source", "`source` must say who said this, where and when, with the date as YYYY-MM-DD (for example \"Ari in the team channel, 2026-10-26\")")
  return source
}

function githubStore(top, spawnGit) {
  const url = runGit(["config", "--get", "remote.origin.url"], { cwd: top, spawnGit })
  const match = url.ok && url.stdout !== "" ? /^https:\/\/github\.com\/([^/]+\/[^/]+)$/u.exec(normalizeRemote(url.stdout)) : null
  if (match === null) throw new Error("lesson_add: a team lesson is written through a GitHub pull request, and this repository's origin is not on GitHub")
  return match[1]
}

/** Who the lesson is attributed to: the session's person, else the clone's Git user name. */
function authorOf(person, top, spawnGit) {
  if (typeof person === "string" && person.trim() !== "") return person.trim()
  const name = runGit(["config", "--get", "user.name"], { cwd: top, spawnGit })
  if (name.ok && name.stdout !== "") return name.stdout
  throw new Error("lesson_add: a team lesson is attributed to its person, and this session has no person and the clone has no Git user name")
}

// Claude Code reads CLAUDE.md, not AGENTS.md; it reads AGENTS.md only when CLAUDE.md imports it (`@AGENTS.md`) or is a
// link to it. Copilot CLI and Codex read AGENTS.md themselves.
function claudeLoads(dir) {
  const file = path.join(dir, "CLAUDE.md")
  try {
    if (lstatSync(file).isSymbolicLink()) return path.basename(readlinkSync(file)) === "AGENTS.md"
    return /(?:^|\s)@(?:\.\/)?AGENTS\.md\b/mu.test(readFileSync(file, "utf8"))
  } catch {
    return false
  }
}

// The lesson written on top of the default branch as it is now. Null when that branch already holds this exact line.
async function writeLesson(tree, line, topic) {
  const file = path.join(tree, "AGENTS.md")
  const current = existsSync(file) ? await fs.readFile(file, "utf8") : ""
  const { text, replaced } = withLesson(current, line, topic)
  if (text === current) return null
  if (!printedPart(text).includes(line)) throw new Failed("size", "the lesson would fall after the first 16 KB of the repository's AGENTS.md, which is what Desk's session start prints; shorten that file first")
  await fs.writeFile(file, text, "utf8")
  return { replaces: replaced ? lessonLine(current, topic) : undefined }
}

// Who wrote a lesson line, from its attribution "(<who>, <date>; <source>)".
const authorOfLine = (line) => /\(([^,()]+), \d{4}-\d{2}-\d{2}; /u.exec(line)?.[1].trim()

const ghText = (answer) => String(answer.stdout ?? "").trim()
const ghJson = (answer) => {
  try {
    return JSON.parse(ghText(answer))
  } catch {
    return {}
  }
}

const prState = async (gh, url, token) => ghJson(await gh(["pr", "view", url, "--json", "state,mergeable,mergeStateStatus,mergeCommit"], { token }))

/**
 * `addTeamLesson({ deskRoot, person, topic, body, repo, source, ... })`: writes the lesson into the repository's root
 * AGENTS.md through a pull request it merges itself. Input errors throw; once the remote work starts, a failure comes
 * back as `status: "failed"` with the stage it stopped at, a pull request that did not merge as `status: "pr_open"` (its
 * branch kept), and a default branch that already holds the exact line as `status: "unchanged"`.
 */
export async function addTeamLesson({ deskRoot, person, topic, body, repo, source, spawnGit = spawnSync, gh = withAmbientToken(ghRunner(), process.env), chooseAccount = chooseAccountDefault, tmpRoot = os.tmpdir(), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const top = repoRoot({ deskRoot, repo, spawnGit })
  const crew = path.resolve(top) === path.resolve(deskRoot) && crewWorkspace(deskRoot).crew
  if (crew && (typeof person !== "string" || person === "")) throw new Error("lesson_add: a team lesson in a shared workspace is attributed to its person, and this session has no person")
  const cited = oneLine(source, "source")
  const origin = githubStore(top, spawnGit)
  const author = authorOf(person, top, spawnGit)
  const result = { scope: "team", repo: origin, path: "AGENTS.md", section: SECTION, in_effect: false }
  const tmp = await fs.mkdtemp(path.join(tmpRoot, "desk-lesson-"))
  const tree = path.join(tmp, "tree")
  // Any failure once the remote work starts is reported, not thrown; anything else (a bug) is thrown.
  const failed = (error) => {
    if (!(error instanceof Failed)) throw error
    const open = result.pr ? ` The pull request ${result.pr} is open, on branch ${result.branch}.` : ""
    return { ...result, status: "failed", stage: error.stage, reason: error.message, message: `Not in effect: the team write stopped at ${error.stage} (${error.message}).${open}` }
  }
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
    return await (async () => {
      let store = origin
      let { account, token } = await access(store)
      let info = await about(store, token)
      // A fork's lesson belongs in the repository the team works in, the one it was forked from.
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
      const unpush = (branch) => runGit(["push", "--quiet", remote, "--delete", branch], { cwd: top, token, spawnGit, config: route(remote) })
      network(["fetch", "--quiet", remote, info.base], top, "fetch")
      must(runGit(["worktree", "add", "--quiet", "--no-checkout", "--detach", tree, "FETCH_HEAD"], { cwd: top, spawnGit }), "worktree")
      // The worktree's own sparse-checkout file, so the clone's configuration is left as it was.
      const sparse = path.resolve(tree, git(["rev-parse", "--git-path", "info/sparse-checkout"], "worktree"))
      await fs.mkdir(path.dirname(sparse), { recursive: true })
      await fs.writeFile(sparse, "/AGENTS.md\n/CLAUDE.md\n", "utf8")
      git(["reset", "--quiet", "--hard", "HEAD"], "worktree")
      const line = `${lead(topic)} ${body} (${author}, ${today()}; ${sourceOf(tree, cited, spawnGit)})`
      result.line = line
      const loaders = () => {
        const claude = crew || claudeLoads(tree)
        result.claude_code_loads = claude
        return crew ? "every teammate's Desk session start prints it" : `Copilot CLI and Codex load it in ${store}${claude ? ", and Claude Code does too, through CLAUDE.md" : "; Claude Code does not, because this repository's CLAUDE.md does not import AGENTS.md (add a line `@AGENTS.md` to it)"}`
      }
      // Commit and push one build; the repository's hooks and signing apply, and their refusal is reported.
      const publish = (branch) => {
        git(["add", "AGENTS.md"], "commit")
        git(["commit", "--quiet", "-m", `Team lesson: ${topic}`], "commit", "the commit was refused (this repository's commit hooks or signing): ")
        network(["push", "--quiet", "--force", remote, `HEAD:refs/heads/${branch}`], tree, "push", "the push was refused: ")
      }
      // The line this build replaces, if any, kept with whether it landed while the pull request was open.
      let late = false
      const replacing = (built, rebuilt) => {
        delete result.replaces
        if (built.replaces !== undefined) result.replaces = built.replaces
        late = rebuilt
      }
      const built = await writeLesson(tree, line, topic)
      if (built === null) {
        const who = loaders()
        return { ...result, status: "unchanged", in_effect: true, message: `Already in effect: the default branch of ${store} holds this exact line. ${who}.` }
      }
      replacing(built, false)
      const branch = `lesson/${slugify(topic).slice(0, 40)}-${Date.now().toString(36)}`
      publish(branch)
      const prBody = `Adds a team lesson to the ${SECTION} section of AGENTS.md, written by Desk's lesson_add.\n\n${line}`
      const created = await gh(["pr", "create", "--repo", store, "--base", info.base, "--head", branch, "--title", `Team lesson: ${topic}`, "--body", prBody], { token })
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
          const rebuilt = await writeLesson(tree, line, topic)
          if (rebuilt === null) {
            // Someone else merged this exact line first: this pull request has nothing left to add.
            await gh(["pr", "close", url, "--comment", "The default branch already holds this lesson."], { token })
            unpush(branch)
            delete result.pr
            delete result.branch
            const who = loaders()
            return { ...result, status: "unchanged", in_effect: true, message: `Already in effect: the default branch of ${store} holds this exact line. ${who}.` }
          }
          replacing(rebuilt, true)
          publish(branch)
        } else if (state.mergeable === "UNKNOWN") await wait(2000)
        else break
      }
      if (state.state !== "MERGED") {
        const why = state.mergeStateStatus ?? "unknown"
        return { ...result, status: "pr_open", reason: why, message: `Not in effect: the pull request ${url} is open on branch ${branch} and has not merged (${why === "QUEUED" ? "it is queued to merge" : why}). It takes effect when it merges.` }
      }
      unpush(branch)
      delete result.branch
      result.commit = state.mergeCommit?.oid ?? null
      const who = loaders()
      // Someone else's lesson on the same topic is gone now; say so, so it can be taken up with them.
      const owner = result.replaces === undefined ? undefined : authorOfLine(result.replaces)
      const replaced = owner === undefined || owner === author ? "" : ` It replaced ${owner}'s lesson on this topic${late ? ", merged while this pull request was open" : ""}: ${result.replaces}`
      return { ...result, status: "merged", in_effect: true, message: `In effect: merged in ${url}. ${who}, from each session that starts after the merge.${replaced}` }
    })().catch(failed)
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
