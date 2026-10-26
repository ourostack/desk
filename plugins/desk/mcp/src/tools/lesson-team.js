// lesson_add's team write: a lesson for every teammate's agents goes into the `## Lessons` section of the root AGENTS.md
// of the repository the team works in, through that repository's own contribution path, done by the tool itself.
//
// The repository is any local clone with a GitHub `origin`: a Crew shared workspace (the desk itself, the default there)
// or a team's code repository that is not a desk at all. The write never touches the clone's checkout: it fetches the
// default branch, builds the change in a temporary worktree, pushes a branch with a signed-in account that can push,
// opens a pull request and merges it at once. When the merge meets a conflict (someone else changed AGENTS.md first) it
// rebuilds the change on the new default branch and tries again. The reply says what happened: merged (with the merge
// commit), or the pull request left open and why, so nothing is claimed in effect that is not.

import { promises as fs, existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { today, slugify } from "../util/fm.js"
import { resolveLocalPath } from "../util/paths.js"
import { normalizeRemote } from "../factory/binding.js"
import { chooseAccount as chooseAccountDefault, ghRunner } from "../factory/flush.js"
import { withAmbientToken } from "../runtime/boot.js"
import { crewWorkspace } from "../desk/crew-roster.js"
import { SECTION, byteSize, lead, lessonLine, oneLine, refuseOverCap, withLesson } from "./lesson-lines.js"

const GIT_TIMEOUT_MS = 60_000
const MERGE_TRIES = 3
const DATE = /\b\d{4}-\d{2}-\d{2}\b/u
const DECISIONS = path.join("_shared", "decisions")
const CREDENTIALS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]

function runGit(args, { cwd, token, spawnGit }) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }
  if (token !== undefined) env.GH_TOKEN = token
  const result = spawnGit("git", [...CREDENTIALS, "-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env })
  return { ok: result.status === 0, stdout: String(result.stdout ?? "").trim(), stderr: String(result.stderr ?? "").trim() }
}

class Failed extends Error {
  constructor(stage, reason) {
    super(reason)
    this.stage = stage
  }
}

function must(result, stage) {
  if (!result.ok) throw new Failed(stage, result.stderr.split("\n")[0] || `${stage} failed`)
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
 * Where the lesson came from. A team decision lives in the workspace's decision records, so where the repository keeps
 * `_shared/decisions/`, `source` must name one of its files. Elsewhere it names who said it, where and when, with the
 * date as YYYY-MM-DD.
 */
function sourceOf(top, value) {
  const source = oneLine(value, "source")
  if (existsSync(path.join(top, DECISIONS))) {
    const rel = source.replace(/\\/gu, "/")
    const file = path.resolve(top, rel)
    if (!rel.startsWith("_shared/decisions/") || !file.startsWith(path.join(top, DECISIONS) + path.sep) || !existsSync(file) || !lstatSync(file).isFile()) {
      throw new Error("lesson_add: this repository keeps team decisions in _shared/decisions/, so `source` must be the path of the decision record this lesson comes from (record the decision there first)")
    }
    return rel
  }
  if (!DATE.test(source)) throw new Error("lesson_add: `source` must say who said this, where and when, with the date as YYYY-MM-DD (for example \"Ari in the team channel, 2026-10-26\")")
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

// One attempt: the lesson written on top of the default branch as it is now, committed, and pushed as `branch`.
async function buildOnBase({ top, tree, base, branch, line, topic, token, spawnGit, first }) {
  must(runGit(["fetch", "--quiet", "origin", base], { cwd: top, token, spawnGit }), "fetch")
  if (first) must(runGit(["worktree", "add", "--quiet", "--detach", tree, `origin/${base}`], { cwd: top, spawnGit }), "worktree")
  else must(runGit(["reset", "--quiet", "--hard", `origin/${base}`], { cwd: tree, spawnGit }), "reset")
  const file = path.join(tree, "AGENTS.md")
  const current = existsSync(file) ? await fs.readFile(file, "utf8") : ""
  const { text, replaced } = withLesson(current, line, topic)
  refuseOverCap(byteSize(text), "the repository's AGENTS.md")
  await fs.writeFile(file, text, "utf8")
  must(runGit(["add", "AGENTS.md"], { cwd: tree, spawnGit }), "commit")
  must(runGit(["commit", "--quiet", "-m", `Team lesson: ${topic}`], { cwd: tree, spawnGit }), "commit")
  must(runGit(["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`], { cwd: tree, token, spawnGit }), "push")
  return { replaced, replaces: replaced ? lessonLine(current, topic) : undefined }
}

const ghText = (answer) => String(answer.stdout ?? "").trim()

async function prState(gh, url, token) {
  const view = await gh(["pr", "view", url, "--json", "state,mergeable,mergeStateStatus,mergeCommit"], { token })
  try {
    return JSON.parse(ghText(view))
  } catch {
    return {}
  }
}

/**
 * `addTeamLesson({ deskRoot, person, topic, body, repo, source, ... })`: writes the lesson into the repository's root
 * AGENTS.md through a pull request it merges itself. Input errors throw; once the remote work starts, a failure comes
 * back as `status: "failed"` with the stage it stopped at, and an open pull request as `status: "pr_open"`.
 */
export async function addTeamLesson({ deskRoot, person, topic, body, repo, source, spawnGit = spawnSync, gh = withAmbientToken(ghRunner(), process.env), chooseAccount = chooseAccountDefault, tmpRoot = os.tmpdir(), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const top = repoRoot({ deskRoot, repo, spawnGit })
  const crew = path.resolve(top) === path.resolve(deskRoot) && crewWorkspace(deskRoot).crew
  if (crew && (typeof person !== "string" || person === "")) throw new Error("lesson_add: a team lesson in a shared workspace is attributed to its person, and this session has no person")
  const cited = sourceOf(top, source)
  const store = githubStore(top, spawnGit)
  const line = `${lead(topic)} ${body} (${authorOf(person, top, spawnGit)}, ${today()}; ${cited})`
  const result = { scope: "team", repo: store, path: "AGENTS.md", section: SECTION, line, in_effect: false }
  const tmp = await fs.mkdtemp(path.join(tmpRoot, "desk-lesson-"))
  const tree = path.join(tmp, "tree")
  // Any failure once the remote work starts is reported, not thrown; anything else (a bug, an over-size file) is thrown.
  const failed = (error) => {
    if (!(error instanceof Failed)) throw error
    return { ...result, status: "failed", stage: error.stage, reason: error.message, message: `Not in effect: the team write stopped at ${error.stage} (${error.message}).${result.pr ? ` The pull request ${result.pr} is open.` : ""}` }
  }
  try {
    return await (async () => {
      const chosen = await chooseAccount({ store, runner: gh })
      if (chosen.result !== "account_found" || chosen.route !== "direct") throw new Failed("account", `no signed-in GitHub account can push to ${store} (${chosen.result === "account_found" ? "only through a fork" : chosen.result})`)
      const tokenAnswer = await gh(["auth", "token", "--user", chosen.account])
      const token = ghText(tokenAnswer)
      if (tokenAnswer.code !== 0 || token === "") throw new Failed("account", `gh has no token for ${chosen.account}`)
      const baseAnswer = await gh(["api", `repos/${store}`, "--jq", ".default_branch"], { token })
      const base = ghText(baseAnswer)
      if (baseAnswer.code !== 0 || base === "") throw new Failed("default_branch", `could not read the default branch of ${store}`)
      const branch = `lesson/${slugify(topic).slice(0, 40)}-${Date.now().toString(36)}`
      const built = await buildOnBase({ top, tree, base, branch, line, topic, token, spawnGit, first: true })
      if (built.replaced) result.replaces = built.replaces
      result.account = chosen.account
      const title = `Team lesson: ${topic}`
      const prBody = `Adds a team lesson to the ${SECTION} section of AGENTS.md, written by Desk's lesson_add.\n\n${line}`
      const created = await gh(["pr", "create", "--repo", store, "--base", base, "--head", branch, "--title", title, "--body", prBody], { token })
      const url = ghText(created).split("\n").pop()
      if (created.code !== 0 || !/^https:\/\/github\.com\//u.test(url)) throw new Failed("pull_request", `could not open the pull request: ${String(created.stderr ?? "").trim().split("\n")[0]}`)
      result.pr = url
      let state = {}
      let merged = false
      for (let attempt = 1; ; attempt += 1) {
        const answer = await gh(["pr", "merge", url, "--squash"], { token })
        state = await prState(gh, url, token)
        merged = answer.code === 0 || state.state === "MERGED"
        if (merged || attempt === MERGE_TRIES) break
        // Someone changed the default branch first: build the change again on top of theirs. GitHub not having worked out
        // mergeability yet is a wait, not a failure.
        if (state.mergeable === "CONFLICTING") await buildOnBase({ top, tree, base, branch, line, topic, token, spawnGit, first: false })
        else if (state.mergeable === "UNKNOWN") await wait(2000)
        else break
      }
      if (!merged) {
        return { ...result, status: "pr_open", reason: state.mergeStateStatus ?? "unknown", message: `Not in effect: the pull request ${url} is open and could not be merged now (${state.mergeStateStatus ?? "unknown"}). It takes effect when it merges.` }
      }
      runGit(["push", "--quiet", "origin", "--delete", branch], { cwd: top, token, spawnGit })
      result.commit = state.mergeCommit?.oid ?? null
      const claude = claudeLoads(tree)
      const loaders = crew ? "every teammate's Desk session start prints it" : `Copilot CLI and Codex load it in ${store}${claude ? ", and Claude Code does too, through CLAUDE.md" : "; Claude Code does not, because this repository's CLAUDE.md does not import AGENTS.md (add a line `@AGENTS.md` to it)"}`
      return { ...result, status: "merged", in_effect: true, claude_code_loads: crew || claude, message: `In effect: merged in ${url}. ${loaders}, from each session that starts after the merge.` }
    })().catch(failed)
  } finally {
    if (existsSync(tree)) runGit(["worktree", "remove", "--force", tree], { cwd: top, spawnGit })
    await fs.rm(tmp, { recursive: true, force: true })
  }
}
