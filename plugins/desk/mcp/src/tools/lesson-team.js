// lesson_add's team write: a lesson for every teammate's agents goes into the `## Lessons` section of the root AGENTS.md
// of the repository the team works in, through that repository's own contribution path, done by the tool itself.
//
// The repository is the GitHub repository of a local clone: a Crew shared workspace (the desk itself, the default there)
// or a team's code repository that is not a desk at all. The write goes through Crew's shared-write protocol
// (shared-write.js): a temporary sparse worktree that checks out only AGENTS.md and CLAUDE.md, a branch, a pull request
// merged at once, and a rebuild on the new default branch when someone else changed AGENTS.md first.

import { promises as fs, existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { today, slugify } from "../util/fm.js"
import { resolveLocalPath } from "../util/paths.js"
import { chooseAccount as chooseAccountDefault, ghRunner } from "../factory/flush.js"
import { withAmbientToken } from "../runtime/boot.js"
import { printedPart } from "../runtime/agents-md.js"
import { crewWorkspace } from "../desk/crew-roster.js"
import { SECTION, lead, lessonLine, oneLine, withLesson } from "./lesson-lines.js"
import { Failed, githubStore, pause, runGit, sharedWrite } from "./shared-write.js"

const DATE = /\b\d{4}-\d{2}-\d{2}\b/u

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

/**
 * `addTeamLesson({ deskRoot, person, topic, body, repo, source, ... })`: writes the lesson into the repository's root
 * AGENTS.md through a pull request it merges itself. Input errors throw; once the remote work starts, a failure comes
 * back as `status: "failed"` with the stage it stopped at, a pull request that did not merge as `status: "pr_open"` (its
 * branch kept), and a default branch that already holds the exact line as `status: "unchanged"`.
 */
export async function addTeamLesson({ deskRoot, person, topic, body, repo, source, spawnGit = spawnSync, gh = withAmbientToken(ghRunner(), process.env), chooseAccount = chooseAccountDefault, tmpRoot = os.tmpdir(), wait = pause }) {
  const top = repoRoot({ deskRoot, repo, spawnGit })
  const crew = path.resolve(top) === path.resolve(deskRoot) && crewWorkspace(deskRoot).crew
  if (crew && (typeof person !== "string" || person === "")) throw new Error("lesson_add: a team lesson in a shared workspace is attributed to its person, and this session has no person")
  const cited = oneLine(source, "source")
  const origin = githubStore(top, spawnGit)
  if (origin === null) throw new Error("lesson_add: a team lesson is written through a GitHub pull request, and this repository's origin is not on GitHub")
  const author = authorOf(person, top, spawnGit)
  const result = { scope: "team", repo: origin, path: "AGENTS.md", section: SECTION, in_effect: false }
  // Whether Claude Code loads the lesson, read from the checkout each build was made on.
  let claude = false
  const loaders = () => {
    result.claude_code_loads = claude
    return crew ? "every teammate's Desk session start prints it" : `Copilot CLI and Codex load it in ${result.repo}${claude ? ", and Claude Code does too, through CLAUDE.md" : "; Claude Code does not, because this repository's CLAUDE.md does not import AGENTS.md (add a line `@AGENTS.md` to it)"}`
  }
  // The line the latest build replaces, if any, kept with whether it landed while the pull request was open.
  let late = false
  let line
  const write = async (tree, rebuilt) => {
    if (!rebuilt) {
      line = `${lead(topic)} ${body} (${author}, ${today()}; ${sourceOf(tree, cited, spawnGit)})`
      result.line = line
    }
    claude = crew || claudeLoads(tree)
    const built = await writeLesson(tree, line, topic)
    if (built === null) return null
    delete result.replaces
    if (built.replaces !== undefined) result.replaces = built.replaces
    late = rebuilt
    return built
  }
  let outcome
  try {
    outcome = await sharedWrite({
      top, origin, result, write, spawnGit, gh, chooseAccount, tmpRoot, wait,
      tmpPrefix: "desk-lesson-",
      sparse: ["/AGENTS.md", "/CLAUDE.md"],
      add: ["AGENTS.md"],
      branch: `lesson/${slugify(topic).slice(0, 40)}-${Date.now().toString(36)}`,
      title: `Team lesson: ${topic}`,
      commitMessage: `Team lesson: ${topic}`,
      prBody: () => `Adds a team lesson to the ${SECTION} section of AGENTS.md, written by Desk's lesson_add.\n\n${line}`,
      closeComment: "The default branch already holds this lesson.",
    })
  } catch (error) {
    // Any failure once the remote work starts is reported, not thrown; anything else (a bug) is thrown.
    if (!(error instanceof Failed)) throw error
    const open = result.pr ? ` The pull request ${result.pr} is open, on branch ${result.branch}.` : ""
    return { ...result, status: "failed", stage: error.stage, reason: error.message, message: `Not in effect: the team write stopped at ${error.stage} (${error.message}).${open}` }
  }
  if (outcome.status === "unchanged") {
    const who = loaders()
    return { ...result, status: "unchanged", in_effect: true, message: `Already in effect: the default branch of ${result.repo} holds this exact line. ${who}.` }
  }
  if (outcome.status === "pr_open") {
    const why = outcome.reason
    return { ...result, status: "pr_open", reason: why, message: `Not in effect: the pull request ${result.pr} is open on branch ${result.branch} and has not merged (${why === "QUEUED" ? "it is queued to merge" : why}). It takes effect when it merges.` }
  }
  result.commit = outcome.commit
  const who = loaders()
  // Someone else's lesson on the same topic is gone now; say so, so it can be taken up with them.
  const owner = result.replaces === undefined ? undefined : authorOfLine(result.replaces)
  const replaced = owner === undefined || owner === author ? "" : ` It replaced ${owner}'s lesson on this topic${late ? ", merged while this pull request was open" : ""}: ${result.replaces}`
  return { ...result, status: "merged", in_effect: true, message: `In effect: merged in ${result.pr}. ${who}, from each session that starts after the merge.${replaced}` }
}
