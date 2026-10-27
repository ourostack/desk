// The Crew workspace engine behind `scripts/crew.js`: tell whether a repository is a Crew workspace, start one in a new
// or existing repository, and join a new teammate to one. Each action is one deterministic step with a plan first:
// nothing is written until `apply`.
//
// Every Crew workspace has the same shape: the root AGENTS.md, `_meta/desks.md` (the roster), `desks/<alias>/`,
// `desks/_template/`, `_shared/landscape/` and `_shared/decisions/`. It comes in two setups that differ only in where
// the team's plugin lives: a monorepo keeps it in its own `plugins/<name>/`; a dual-repo workspace names a separate
// tooling repository in `_meta/crew.json`. Starting adds whatever of the shape is missing and deletes, moves and
// overwrites nothing: the root AGENTS.md gains one section, and a Crew file that already exists is refused. Folders
// outside the shape are listed, for the team to move into it.
//
// Every write outside a person's own desk is a shared write and lands through a pull request the writer merges at once,
// rebuilt on the new default branch when a teammate's change conflicts. A joining member's own desk is theirs alone, so
// it is pushed straight to the default branch first, and only then does the roster row that points at it land.
//
// The script works in the team's local clone, which must be clean and on the default branch in step with origin. Git
// and `gh` run as the person: the clone's own credentials, or `gh` through its credential helper.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { CREW_ROSTER_FILE, crewWorkspace, markdownTables } from "../desk/crew-roster.js"
import { CREW_CONFIG_FILE, parseCrewConfig, readCrewConfig } from "../desk/crew-config.js"

const GIT_TIMEOUT_MS = 120_000
const MERGE_TRIES = 3
const PUSH_TRIES = 3
// After a merge command that succeeded, how many times GitHub is asked whether the pull request merged, 2 s apart.
const MERGE_POLLS = 5
const TEMPLATE = "desks/_template/"
const ROSTER = CREW_ROSTER_FILE.split(path.sep).join("/")
const CONFIG = CREW_CONFIG_FILE.split(path.sep).join("/")
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/u
// What GitHub puts in a repository it creates, and nothing a team wrote: a repository holding only these can be started.
const STARTER = [/^README(\.md)?$/iu, /^LICEN[SC]E(\.\w+)?$/iu, /^\.gitignore$/u, /^\.gitattributes$/u, /^\.github\//u]
const ROSTER_COLUMNS = ["alias", "identity", "path", "repo", "worker_variant", "write_subtree"]
const FACTS = "_shared/landscape/"
const DECISIONS = "_shared/decisions/"
// The top-level folders of Crew's shape; `plugins/` belongs to it only in a monorepo.
const SHAPE = ["_meta/", "_shared/", "desks/"]

const NOT_CREW_MESSAGE = "This repository is not a Crew workspace yet. To make it one, start a crew in it with crew:start-crew, which adds Crew's layout and keeps everything already here; then teammates join it with crew:join-crew."

class Failed extends Error {
  constructor(stage, reason) {
    super(reason)
    this.stage = stage
  }
}

// The pause between asking GitHub whether a pull request merged.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const firstLine = (text) => String(text).trim().split("\n")[0]
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`

// `gh` as the person runs it, answering `{ code, stdout, stderr }`, with prompts off. Their GH_TOKEN, when set, picks
// the account, as it does for Git's credential helper below. A gh that cannot start answers a null code.
function runGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: { ...process.env, GH_PROMPT_DISABLED: "1" } })
  return { code: result.status, stdout: String(result.stdout), stderr: [result.stderr, result.error].filter(Boolean).join(" ") }
}

// Git in `cwd`. Network calls to an https origin sign in through `gh`, the way Desk's own pushes do.
function gitIn(cwd, spawnGit) {
  const run = (args, { network = false } = {}) => {
    const config = network ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : []
    const result = spawnGit("git", [...config, "-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } })
    return { ok: result.status === 0, stdout: String(result.stdout ?? "").trim(), stderr: String(result.stderr ?? "").trim() }
  }
  run.must = (args, stage, why = "", options) => {
    const result = run(args, options)
    if (!result.ok) throw new Failed(stage, `${why}${firstLine(result.stderr) || `git ${args[0]} failed`}`)
    return result.stdout
  }
  return run
}

// `owner/name` of a GitHub remote, in any spelling people use (https, scp-style, an SSH host alias such as github-emu), or null.
function githubRepo(url) {
  const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(url.trim())
  if (match === null || !/github/iu.test(match[1])) return null
  return `${match[2]}/${match[3]}`
}

function toplevel(repo, spawnGit) {
  if (typeof repo !== "string" || repo === "" || !existsSync(repo)) return null
  const top = gitIn(repo, spawnGit)(["rev-parse", "--show-toplevel"])
  return top.ok ? path.resolve(top.stdout) : null
}

const notGit = (repo) => `${repo} is not a Git clone. Clone the team's repository first, then run this again in the clone.`

function listFiles(dir, prefix = "") {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries.sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name))) {
    const rel = `${prefix}${entry.name}`
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), `${rel}/`))
    else out.push(rel)
  }
  return out
}

const tracked = (git) => git(["ls-files"]).stdout.split("\n").filter(Boolean)

// The top-level entries of tracked files that are not what GitHub creates: what makes a repository "already has content".
function teamContent(files) {
  const tops = new Set()
  for (const file of files) {
    if (STARTER.some((pattern) => pattern.test(file))) continue
    const slash = file.indexOf("/")
    tops.add(slash === -1 ? file : `${file.slice(0, slash)}/`)
  }
  return [...tops].sort()
}

function inRepoPlugin(top, base) {
  for (const name of listPluginFolders(path.join(top, "plugins"))) {
    return { repo: null, path: `plugins/${name}`, plugin: name, ref: base, marketplace: null }
  }
  return null
}

function listPluginFolders(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && (existsSync(path.join(dir, entry.name, "plugin.json")) || existsSync(path.join(dir, entry.name, ".claude-plugin", "plugin.json"))))
    .map((entry) => entry.name)
    .sort()
}

// How a member gets the team's tooling: the install commands for each host, or why there is nothing to install.
function installFor(tooling, origin) {
  if (tooling.repo !== null) {
    if (tooling.plugin === null) return { install: null, message: `The team's tooling repository ${tooling.repo} declares no plugin yet, so there is nothing to install. Read it at https://github.com/${tooling.repo}.` }
    const claude = tooling.marketplace === null ? null : [`claude plugin marketplace add ${tooling.repo}`, `claude plugin install ${tooling.plugin}@${tooling.marketplace}`]
    return { install: { copilot: `agency plugin install github:${tooling.repo}${tooling.path === "" ? "" : `:${tooling.path}`}@${tooling.ref} --engine copilot`, claude }, message: `Install the team's tooling, plugin ${tooling.plugin} from ${tooling.repo}.` }
  }
  if (origin === null) return { install: null, message: `The team's tooling is ${tooling.path} inside this workspace; this clone's origin is not on GitHub, so install it from the clone.` }
  return { install: { copilot: `agency plugin install github:${origin}:${tooling.path}@${tooling.ref} --engine copilot`, claude: null }, message: `Install the team's tooling, plugin ${tooling.plugin} from ${tooling.path} in this workspace.` }
}

function currentBranch(git) {
  const branch = git(["symbolic-ref", "--short", "HEAD"])
  return branch.ok ? branch.stdout : null
}

function workspaceFacts(top, spawnGit) {
  const git = gitIn(top, spawnGit)
  const url = git(["config", "--get", "remote.origin.url"])
  const origin = url.ok ? githubRepo(url.stdout) : null
  const remoteHead = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  const base = remoteHead.ok ? remoteHead.stdout.replace(/^origin\//u, "") : currentBranch(git)
  return { git, origin, base, hasOrigin: url.ok, originUrl: url.stdout }
}

const deskOf = (alias) => `desks/${alias}`

/**
 * crewStatus({ repo, identity? }) -> { state: "not_git" | "not_crew" | "crew", ... }
 *
 * For a Crew workspace: its origin (`owner/name` or null), default branch, setup ("monorepo" or "dual-repo"), the
 * team's tooling with its install commands, the merge workflow, roster aliases, whether the desk template exists, and,
 * given `identity`, the member it names (`{ alias, desk }`) or null.
 */
export async function crewStatus({ repo, identity, spawnGit = spawnSync }) {
  const top = toplevel(repo, spawnGit)
  if (top === null) return { state: "not_git", repo, message: notGit(repo) }
  const workspace = crewWorkspace(top)
  const { origin, base } = workspaceFacts(top, spawnGit)
  if (!workspace.crew) return { state: "not_crew", repo: top, message: NOT_CREW_MESSAGE }
  const config = readCrewConfig(top)
  const declared = config.tooling ?? inRepoPlugin(top, base)
  const tooling = declared === null ? null : { ...declared, ...installFor(declared, origin) }
  const rows = workspace.roster.filter((row) => row.alias !== "")
  const aliases = rows.map((row) => row.alias)
  let member
  let about = ""
  if (typeof identity === "string" && identity.trim() !== "") {
    const row = rows.find((candidate) => candidate.identity.toLowerCase() === identity.trim().toLowerCase())
    member = row === undefined ? null : { alias: row.alias, desk: deskOf(row.alias) }
    about = row === undefined ? ` ${identity.trim()} has no roster row yet; join with crew:join-crew.` : ` ${row.identity} is on the roster as ${row.alias}.`
  }
  const desks = aliases.length === 0 ? "no desks yet" : `${plural(aliases.length, "desk")} (${aliases.join(", ")})`
  return {
    state: "crew",
    repo: top,
    origin,
    base,
    setup: config.setup,
    tooling,
    merge_workflow: config.shared_writes.merge_workflow,
    roster: aliases,
    template: listFiles(path.join(top, ...TEMPLATE.split("/"))).length > 0,
    member,
    problems: config.problems,
    message: `This is a Crew workspace with ${desks}.${about}`,
  }
}

// ── Content Crew adds ────────────────────────────────────────────────────────────────────────────────────────────

const TEMPLATE_FILES = {
  "AGENTS.md": "# {{alias}}'s desk\n\nThis is {{alias}}'s own desk in this Crew workspace. Agents working for {{alias}} read the root `AGENTS.md` first, then this file. Personal preferences and lessons for {{alias}}'s agents go here; a lesson for the whole team goes in the root `AGENTS.md`.\n",
  "README.md": "# {{alias}}\n\n{{alias}}'s working desk: tracks, tasks and notes. Everything here is {{alias}}'s own view unless it says otherwise.\n",
  "_meta/friction.md": "# Friction\n\nWhat got in the way of {{alias}}'s agents, one dated entry each.\n",
}

const HOME_README = {
  facts: "# Team facts\n\nExternally true, team-neutral facts, each with its source and the date it was checked. One person's view belongs in their own desk, attributed to them.\n",
  decisions: "# Team decisions\n\nWhat the team actually agreed, one file per decision, each naming who agreed it and when. Until the team agrees something, \"no team decision yet\" is the honest answer.\n",
}

const rosterHeader = () => `| ${ROSTER_COLUMNS.join(" | ")} |\n|${ROSTER_COLUMNS.map(() => "---").join("|")}|\n`
const rosterFile = () => `# Desks\n\nEach row binds one person's account to their own desk in \`desks/\`. Crew's join-crew adds a row for a new teammate once their desk is in place.\n\n${rosterHeader()}`

function rosterRow(header, { alias, identity, origin }) {
  const values = { alias, identity, path: deskOf(alias), repo: origin ?? "", worker_variant: "crew", write_subtree: deskOf(alias) }
  return `| ${header.map((column) => values[column] ?? "").join(" | ")} |`
}

// `_meta/desks.md` with the row added at the end of the roster table; the text around the table is kept as it is.
function withRosterRow(current, member) {
  if (current === null) return `${rosterFile()}${rosterRow(ROSTER_COLUMNS, member)}\n`
  const lines = current.split("\n")
  const table = markdownTables(current).find((candidate) => candidate.header.includes("alias") && candidate.header.includes("identity"))
  if (table === undefined) return `${current.replace(/\n*$/u, "\n")}\n${rosterHeader()}${rosterRow(ROSTER_COLUMNS, member)}\n`
  const start = lines.findIndex((line) => {
    const trimmed = line.trim()
    return trimmed.startsWith("|") && trimmed.toLowerCase().includes("alias") && trimmed.toLowerCase().includes("identity")
  })
  let end = start
  while (end + 1 < lines.length && lines[end + 1].trim().startsWith("|")) end += 1
  lines.splice(end + 1, 0, rosterRow(table.header, member))
  return lines.join("\n")
}

const quoted = (items) => items.map((item) => `\`${item}\``).join(", ")

function crewSection({ tooling, mergeWorkflow, outside }) {
  const lines = [
    "## Crew workspace",
    "",
    "This repository is also a Crew shared workspace. Each teammate's agents keep their own working state in `desks/<alias>/`; everything outside a person's own desk is shared. `_meta/desks.md` binds each person's account to their desk, and `_meta/crew.json` holds Crew's settings.",
    "",
    `- **Team facts** go in \`${FACTS}\`: externally true, team-neutral material, each with its source and the date it was checked.`,
    `- **Agreed team decisions** go in \`${DECISIONS}\`: only what the team actually agreed, with who agreed it and when. One person's view stays in their own desk, attributed to them.`,
  ]
  if (tooling?.repo) lines.push(`- **Team tooling**: the team's plugin lives in the separate [${tooling.repo}](https://github.com/${tooling.repo}) repository, not in this one.`)
  else if (tooling?.path) lines.push(`- **Team tooling**: the team's plugin is in \`${tooling.path}/\`.`)
  lines.push(`- **Shared writes** (anything outside your own desk) land through a pull request that the writer merges at once; the pull request serializes concurrent writes and is not a review.${mergeWorkflow ? ` This repository's own merge workflow is \`${mergeWorkflow}\`.` : ""}`)
  if (outside.length > 0) lines.push(`- **Not yet in Crew's shape**: ${quoted(outside)}. Their content is being moved into the folders above with the team (Crew's \`start-crew\` says how); until then, read it where it is.`)
  lines.push("- **To join**, a new teammate's agent runs Crew's `join-crew`, which adds their desk and then their roster row.")
  return `${lines.join("\n")}\n`
}

function startAgents() {
  return "# Agents in this workspace\n\nRead the README first. This file holds the team's conventions and lessons for every teammate's agents.\n"
}

function startReadme(team) {
  return `# ${team}\n\nThis repository is the team's shared workspace. Start with \`AGENTS.md\`. Team facts are in \`${FACTS}\`, agreed decisions in \`${DECISIONS}\`, and each teammate's own desk in \`desks/<alias>/\`.\n`
}

const render = (text, { alias, identity }) => text.replaceAll("{{alias}}", alias).replaceAll("{{identity}}", identity)

function validIdentity(identity) {
  return typeof identity === "string" && identity.trim() !== "" && identity.length <= 100 && !/[|\r\n]/u.test(identity)
}

function aliasProblem(alias) {
  if (typeof alias !== "string" || alias === "") return "an alias is required"
  if (!ALIAS.test(alias)) return `${JSON.stringify(alias)} is not a valid alias: use lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit`
  return null
}

function findMergeWorkflow(top) {
  const dir = path.join(top, ".github", "workflows")
  for (const name of listFiles(dir)) {
    if (!/\.ya?ml$/u.test(name)) continue
    if (/\bgh\s+pr\s+merge\b/u.test(readFileSync(path.join(dir, name), "utf8"))) return `.github/workflows/${name}`
  }
  return null
}

const exists = (top, rel) => {
  try {
    lstatSync(path.join(top, ...rel.split("/")))
    return true
  } catch {
    return false
  }
}

function writeFiles(top, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(top, ...rel.split("/"))
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

// ── Landing a change ─────────────────────────────────────────────────────────────────────────────────────────────

// Checks the clone can take a write and brings it up to date with origin. Returns how the change can land.
function prepareCheckout(git) {
  if (git(["status", "--porcelain"]).stdout !== "") return { refused: "has uncommitted changes; commit or stash them first, then run this again" }
  const url = git(["config", "--get", "remote.origin.url"])
  const branch = currentBranch(git)
  if (!url.ok) return { mode: "local", branch }
  const head = git(["ls-remote", "--symref", "origin", "HEAD"], { network: true })
  if (!head.ok) throw new Failed("fetch", `could not reach origin: ${firstLine(head.stderr)}`)
  const named = /^ref: refs\/heads\/(\S+)\s+HEAD$/mu.exec(head.stdout)?.[1] ?? branch
  // A repository with no commits yet has no branch for a pull request to merge into.
  if (!/^[0-9a-f]{40,}\s+HEAD$/mu.test(head.stdout)) return { mode: "first", branch: named }
  const base = named
  if (branch !== base) return { refused: `is on ${branch ?? "a detached HEAD"}, not the default branch ${base}; switch to ${base} first` }
  git.must(["fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], "fetch", "", { network: true })
  if (!git(["merge-base", "--is-ancestor", "HEAD", `origin/${base}`]).ok) return { refused: `has commits that are not on origin/${base}; push or drop them first` }
  git.must(["merge", "--quiet", "--ff-only", `origin/${base}`], "fetch")
  return { mode: "remote", base }
}

function commitAll(git, paths, message) {
  git.must(["add", "--", ...paths], "commit")
  git.must(["commit", "--quiet", "-m", message], "commit", "the commit was refused (this repository's commit hooks or signing): ")
}

// Puts the clone back on `base` at `ref`, dropping only what this run wrote.
function restore(git, base, ref, paths, branch) {
  git(["reset", "--quiet", "--hard"])
  if (paths.length > 0) git(["clean", "-fdq", "--", ...paths])
  if (branch !== undefined) {
    git(["switch", "--quiet", base])
    git(["branch", "-D", branch])
  }
  git(["reset", "--quiet", "--hard", ref])
}

const ghText = (answer) => String(answer.stdout).trim()
const ghJson = (answer) => {
  try {
    return JSON.parse(ghText(answer))
  } catch {
    return {}
  }
}

// Commits what `write` writes and pushes it to the default branch; when the branch moved, rebuilds on it and pushes again.
async function landByPush({ git, base, write, message }) {
  const start = git(["rev-parse", "HEAD"]).stdout
  let paths = []
  try {
    let pushed
    for (let attempt = 1; attempt <= PUSH_TRIES; attempt += 1) {
      if (attempt > 1) {
        git.must(["fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], "fetch", "", { network: true })
        git.must(["reset", "--quiet", "--hard", `origin/${base}`], "reset")
      }
      paths = write()
      commitAll(git, paths, message)
      pushed = git(["push", "--quiet", "origin", `HEAD:refs/heads/${base}`], { network: true })
      if (pushed.ok) return { commit: git(["rev-parse", "HEAD"]).stdout }
    }
    throw new Failed("push", `the push was refused: ${firstLine(pushed.stderr)}`)
  } catch (error) {
    restore(git, base, start, paths)
    throw error
  }
}

// Lands what `write` writes through a pull request merged at once, the shared-path protocol.
async function landByPullRequest({ git, base, origin, write, message, branch, gh, wait, result }) {
  if (origin === null) throw new Failed("pull_request", "this workspace's shared writes land through a GitHub pull request, and this clone's origin is not on GitHub")
  const start = git(["rev-parse", "HEAD"]).stdout
  let paths = []
  let pushed = false
  const unpush = () => git(["push", "--quiet", "origin", "--delete", branch], { network: true })
  try {
    git.must(["switch", "--quiet", "-c", branch], "branch")
    paths = write()
    commitAll(git, paths, message)
    git.must(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], "push", "the push was refused: ", { network: true })
    pushed = true
    const body = `${message}.\n\nOpened by Crew's crew.js. It is merged at once: a pull request to a shared path here serializes concurrent writes and is not a review.`
    const created = await gh(["pr", "create", "--repo", origin, "--base", base, "--head", branch, "--title", message, "--body", body])
    const url = ghText(created).split("\n").pop()
    if (created.code !== 0 || !/^https:\/\/github\.com\//u.test(url)) throw new Failed("pull_request", `could not open the pull request: ${firstLine(created.stderr)}`)
    result.pr = url
    let state = {}
    for (let attempt = 1; ; attempt += 1) {
      const answer = await gh(["pr", "merge", url, "--squash"])
      state = ghJson(await gh(["pr", "view", url, "--json", "state,mergeable,mergeStateStatus,mergeCommit"]))
      // A merge command that succeeded may only have queued the pull request: only GitHub's own state says it merged.
      for (let poll = 0; answer.code === 0 && state.state !== "MERGED" && poll < MERGE_POLLS; poll += 1) {
        await wait(2000)
        state = ghJson(await gh(["pr", "view", url, "--json", "state,mergeable,mergeStateStatus,mergeCommit"]))
      }
      if (state.state === "MERGED" || answer.code === 0 || attempt === MERGE_TRIES) {
        if (state.state !== "MERGED" && answer.code === 0) state = { ...state, mergeStateStatus: "QUEUED" }
        break
      }
      if (state.mergeable === "CONFLICTING") {
        // A teammate changed the default branch first: build the change again on top of theirs.
        git.must(["fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], "fetch", "", { network: true })
        git.must(["reset", "--quiet", "--hard", `origin/${base}`], "reset")
        paths = write()
        commitAll(git, paths, message)
        git.must(["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`], "push", "the push was refused: ", { network: true })
      } else if (state.mergeable === "UNKNOWN") await wait(2000)
      else break
    }
    git.must(["switch", "--quiet", base], "branch")
    git(["branch", "-D", branch])
    if (state.state !== "MERGED") {
      result.branch = branch
      return { open: state.mergeStateStatus ?? "unknown" }
    }
    git.must(["fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], "fetch", "", { network: true })
    git.must(["merge", "--quiet", "--ff-only", `origin/${base}`], "fetch")
    unpush()
    return { commit: state.mergeCommit?.oid ?? git(["rev-parse", "HEAD"]).stdout }
  } catch (error) {
    if (pushed && result.pr === undefined) unpush()
    restore(git, base, start, paths, currentBranch(git) === base ? undefined : branch)
    throw error
  }
}

function failedResult(result, error, extra = "") {
  if (!(error instanceof Failed)) throw error
  const open = result.pr ? ` The pull request ${result.pr} is open.` : ""
  return { ...result, state: "failed", stage: error.stage, reason: error.message, message: `Not in effect: the shared write stopped at ${error.stage} (${error.message}).${open}${extra}` }
}

function openResult(result, landed, mergeWorkflow, lead) {
  const why = landed.open === "QUEUED" ? "it is queued to merge" : landed.open
  const workflow = mergeWorkflow ? ` This repository's merge workflow is ${mergeWorkflow}.` : ""
  return { ...result, state: "pr_open", message: `${lead}the pull request ${result.pr} is open on branch ${result.branch} and has not merged (${why}).${workflow} It takes effect when it merges.` }
}

// ── start ────────────────────────────────────────────────────────────────────────────────────────────────────────

function declarationFor({ tooling, mergeWorkflow }) {
  const declaration = { schema_version: 1 }
  const given = Object.fromEntries(Object.entries(tooling ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== ""))
  if (Object.keys(given).length > 0) declaration.tooling = given
  if (mergeWorkflow) declaration.shared_writes = { merge_workflow: mergeWorkflow }
  return declaration
}

/**
 * startWorkspace({ repo, apply?, tooling?, mergeWorkflow?, founder?: { alias, identity }, team? }) -> { state, changes, ... }
 *
 * Adds Crew's shape to a new or existing repository; `tooling.repo` makes it dual-repo. `state`: "plan" (nothing
 * written), "published" (landed on the default branch), "committed" (a clone with no origin), "pr_open",
 * "already_crew", "refused" (before any write) or "failed" (with `stage`).
 */
export async function startWorkspace({ repo, apply = false, tooling, mergeWorkflow, founder, team, spawnGit = spawnSync, gh = runGh, wait = sleep, now = Date.now }) {
  const action = "start"
  const refuse = (message) => ({ action, state: "refused", repo, message: `Nothing was written: ${message}.` })
  const top = toplevel(repo, spawnGit)
  if (top === null) return { action, state: "refused", repo, message: notGit(repo) }
  if (crewWorkspace(top).crew) return { action, state: "already_crew", repo: top, changes: [], message: "This repository is already a Crew workspace; nothing to change. Teammates join it with crew:join-crew." }
  const git = gitIn(top, spawnGit)
  const workflow = mergeWorkflow ?? findMergeWorkflow(top)
  const declaration = declarationFor({ tooling, mergeWorkflow: workflow })
  const parsed = parseCrewConfig(JSON.stringify(declaration))
  if (parsed.problems.length > 0) return refuse(parsed.problems.join("; "))
  if (founder !== undefined) {
    const problem = aliasProblem(founder.alias)
    if (problem !== null) return refuse(problem)
    if (!validIdentity(founder.identity)) return refuse(`${JSON.stringify(founder.identity)} is not a valid identity`)
  }

  // Every file Crew adds, by repository-relative path.
  const files = {}
  if (!exists(top, FACTS)) files[`${FACTS}README.md`] = HOME_README.facts
  if (!exists(top, DECISIONS)) files[`${DECISIONS}README.md`] = HOME_README.decisions
  if (!exists(top, "README.md")) files["README.md"] = startReadme(team ?? path.basename(top))
  files[CONFIG] = `${JSON.stringify(declaration, null, 2)}\n`
  for (const [rel, content] of Object.entries(TEMPLATE_FILES)) files[`${TEMPLATE}${rel}`] = content
  if (founder !== undefined) {
    for (const [rel, content] of Object.entries(TEMPLATE_FILES)) files[`${deskOf(founder.alias)}/${rel}`] = render(content, founder)
  }
  const conflicts = [...Object.keys(files), ROSTER].filter((rel) => exists(top, rel)).sort()
  if (conflicts.length > 0) return refuse(`${conflicts.join(", ")} already exists, and starting a crew never overwrites a file`)

  const agentsExists = exists(top, "AGENTS.md")
  const changes = [{ path: "AGENTS.md", change: agentsExists ? "append" : "add" }, { path: ROSTER, change: "add" }, ...Object.keys(files).map((rel) => ({ path: rel, change: "add" }))]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
  const shape = parsed.setup === "dual-repo" ? SHAPE : [...SHAPE, "plugins/"]
  const outside = teamContent(tracked(git)).filter((entry) => entry.endsWith("/") && !shape.includes(entry))
  const result = { action, repo: top, setup: parsed.setup, changes, outside, declaration: { tooling: parsed.tooling, shared_writes: parsed.shared_writes } }
  if (!apply) {
    const added = changes.filter((change) => change.change === "add").length
    const appended = agentsExists ? " and appends a section to AGENTS.md" : ""
    const loose = outside.length > 0 ? ` These top-level folders are outside Crew's shape, and nothing in them is moved: ${outside.join(", ")}. Move their content into the shape with the team afterwards.` : ""
    return { ...result, state: "plan", message: `Plan only: nothing was written. Starting a ${parsed.setup} crew adds ${plural(added, "file")}${appended}.${loose} Run again with --apply to make the change.` }
  }

  const { origin } = workspaceFacts(top, spawnGit)
  const write = () => {
    // Rebuilt on a newer default branch, the change still never overwrites a file a teammate added meanwhile.
    const appeared = [...Object.keys(files), ROSTER].filter((rel) => exists(top, rel))
    if (appeared.length > 0) throw new Failed("rebuild", `${appeared.join(", ")} appeared on the default branch meanwhile, and starting a crew never overwrites a file`)
    const current = agentsExists ? readFileSync(path.join(top, "AGENTS.md"), "utf8") : startAgents()
    const separator = current.endsWith("\n") ? "\n" : "\n\n"
    // A monorepo names the plugin it already holds in plugins/.
    const section = crewSection({ tooling: parsed.tooling ?? inRepoPlugin(top, "main"), mergeWorkflow: workflow, outside })
    const roster = founder === undefined ? rosterFile() : withRosterRow(null, { ...founder, origin })
    writeFiles(top, { ...files, "AGENTS.md": `${current}${separator}${section}`, [ROSTER]: roster })
    return changes.map((change) => change.path)
  }
  const message = "Crew: start this Crew workspace"
  try {
    const checkout = prepareCheckout(git)
    if (checkout.refused) return refuse(`this clone ${checkout.refused}`)
    if (checkout.mode === "local") {
      commitAll(git, write(), message)
      return { ...result, state: "committed", commit: git(["rev-parse", "HEAD"]).stdout, message: `Started: committed on ${checkout.branch}. This clone has no origin, so nothing was pushed; add the team's GitHub repository as origin and push ${checkout.branch}.` }
    }
    if (checkout.mode === "first") {
      commitAll(git, write(), message)
      git.must(["push", "--quiet", "origin", `HEAD:refs/heads/${checkout.branch}`], "push", "the push was refused: ", { network: true })
      return { ...result, state: "published", commit: git(["rev-parse", "HEAD"]).stdout, message: `Started: this repository is now a ${parsed.setup} Crew workspace. The repository had no commits for a pull request to merge into, so the first commit was pushed straight to ${checkout.branch}.` }
    }
    const landed = await landByPullRequest({ git, base: checkout.base, origin, write, message, branch: `crew/start-${now().toString(36)}`, gh, wait, result })
    if (landed.open !== undefined) return openResult(result, landed, workflow, "Not in effect yet: ")
    return { ...result, state: "published", commit: landed.commit, message: `Started: this repository is now a ${parsed.setup} Crew workspace. The change merged in ${result.pr}. Teammates join it with crew:join-crew.` }
  } catch (error) {
    return failedResult(result, error)
  }
}

// ── join ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * joinWorkspace({ repo, identity, alias, apply? }) -> { state, ... }
 *
 * `state`: "plan", "joined", "member" (the identity already has a row; nothing written), "pr_open" (the desk is pushed
 * and the roster row waits in an open pull request), "not_crew", "refused" or "failed" (with `stage`).
 */
export async function joinWorkspace({ repo, identity, alias, apply = false, spawnGit = spawnSync, gh = runGh, wait = sleep, now = Date.now }) {
  const refuse = (message) => ({ action: "join", state: "refused", repo, identity, alias, message: `Nothing was written: ${message}.` })
  const status = await crewStatus({ repo, identity, spawnGit })
  if (status.state !== "crew") return { action: "join", ...status }
  if (!validIdentity(identity)) return refuse("an identity is required: the stable account login this member signs in with, with no | or line break")
  if (status.member !== null) {
    return { action: "join", state: "member", repo: status.repo, identity, alias: status.member.alias, desk: status.member.desk, tooling: status.tooling, message: `${identity} is already on the roster as ${status.member.alias}; nothing to add. Desk sessions in this clone find that desk from the roster.` }
  }
  const problem = aliasProblem(alias)
  if (problem !== null) return refuse(problem)
  const top = status.repo
  const owner = crewWorkspace(top).roster.find((row) => row.alias === alias)
  if (owner !== undefined) return refuse(`the alias ${alias} belongs to ${owner.identity}; choose another alias`)
  const template = listFiles(path.join(top, ...TEMPLATE.split("/")))
  if (template.length === 0) return refuse(`${TEMPLATE} is missing or empty, so there is no desk to copy; the workspace needs a complete template first`)
  const desk = deskOf(alias)
  const files = template.map((rel) => `${desk}/${rel}`)
  const resumed = exists(top, desk)
  if (resumed && !files.every((rel) => exists(top, rel))) return refuse(`${desk}/ already exists and does not match the template; it may be someone else's`)
  const member = { alias, identity, origin: status.origin }
  const roster = exists(top, ROSTER) ? readFileSync(path.join(top, ...ROSTER.split("/")), "utf8") : null
  const header = markdownTables(roster ?? "").find((table) => table.header.includes("alias") && table.header.includes("identity"))?.header ?? ROSTER_COLUMNS
  const result = { action: "join", repo: top, identity, alias, desk, files, row: rosterRow(header, member), tooling: status.tooling }
  if (!apply) {
    const deskPart = resumed ? `${desk}/ is already in place, so joining adds` : `Joining adds ${desk}/ (${plural(files.length, "file")}) and then`
    return { ...result, state: "plan", message: `Plan only: nothing was written. ${deskPart} the roster row for ${identity}. Run again with --apply to make the change.` }
  }
  const git = gitIn(top, spawnGit)
  const toolingNote = status.tooling === null ? "" : ` ${status.tooling.message}`
  let deskPushed = resumed
  try {
    const checkout = prepareCheckout(git)
    if (checkout.refused) return refuse(`this clone ${checkout.refused}`)
    if (checkout.mode !== "remote") return refuse("this clone has no origin with a default branch to push the desk to")
    if (!resumed) {
      const writeDesk = () => {
        writeFiles(top, Object.fromEntries(template.map((rel) => [`${desk}/${rel}`, render(readFileSync(path.join(top, ...TEMPLATE.split("/"), ...rel.split("/")), "utf8"), member)])))
        return [`${desk}/`]
      }
      // The member's own desk: they are its only writer, so it goes straight to the default branch.
      await landByPush({ git, base: checkout.base, write: writeDesk, message: `Crew: add ${alias}'s desk` })
      deskPushed = true
    }
    const writeRow = () => {
      const current = exists(top, ROSTER) ? readFileSync(path.join(top, ...ROSTER.split("/")), "utf8") : null
      writeFiles(top, { [ROSTER]: withRosterRow(current, member) })
      return [ROSTER]
    }
    const landed = await landByPullRequest({ git, base: checkout.base, origin: status.origin, write: writeRow, message: `Crew: add ${alias} to the roster`, branch: `crew/join-${alias}-${now().toString(36)}`, gh, wait, result })
    if (resumed) result.resumed = true
    if (landed.open !== undefined) return openResult(result, landed, status.merge_workflow, `Not joined yet: ${desk}/ is pushed, and `)
    return { ...result, state: "joined", commit: landed.commit, message: `Joined: ${identity} is on the roster as ${alias}, with an own desk at ${desk}/. The roster row merged in ${result.pr}. Desk sessions in this clone find that desk from the roster.${toolingNote}` }
  } catch (error) {
    return failedResult(result, error, deskPushed ? ` ${desk}/ is pushed; run join again to add the roster row.` : "")
  }
}
