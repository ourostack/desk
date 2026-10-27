// The Crew workspace engine behind `scripts/crew.js`: tell whether a repository is a Crew workspace, start one in a new
// or existing repository, and join a new teammate to one. Each action is one deterministic step with a plan first:
// nothing is written until `apply`.
//
// Every Crew workspace has the same shape: the root AGENTS.md, `_meta/desks.md` (the desk list; `ROSTER` and "roster
// row" in this code), `desks/<alias>/`, `desks/_template/`, `_shared/landscape/`, `_shared/decisions/`, and the team's
// roster of people, the file `people` in `_meta/crew.json` names (`people.js`). It comes in two setups that differ
// only in where the team's plugin lives: a monorepo keeps it in its own `plugins/<name>/`; a dual-repo workspace names
// a separate tooling repository in `_meta/crew.json`. Starting adds whatever of the shape is missing and deletes, moves and
// overwrites nothing: the root AGENTS.md gains one section, and a Crew file that already exists is refused. Folders
// outside the shape are listed, for the team to move into it.
//
// Every write outside a person's own desk is a shared write. It lands through a pull request the script merges itself,
// as Desk's lesson_add does for a team lesson, so it never depends on a team's own workflow to merge it. When a
// teammate's change conflicts, the change is rebuilt on the new default branch and checked again: a roster row never
// gives one alias or one identity two rows, and a file a teammate added is never overwritten. Run again after a pull
// request was left open, the script reuses that pull request. A joining member's own desk is theirs alone, so it is
// pushed straight to the default branch first, with their identity in the commit, and only then does the roster row
// that points at it land.
//
// The script works in the team's local clone, which must be clean and on the default branch in step with origin. For
// a clone of a GitHub repository it signs in as the signed-in gh account that can push to it (never simply the active
// one), and reaches https://github.com/<owner>/<name> with that account's token, whatever remote spelling the clone uses.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { CREW_ROSTER_FILE, crewWorkspace, markdownTables } from "../desk/crew-roster.js"
import { CREW_CONFIG_FILE, parseCrewConfig, readCrewConfig } from "../desk/crew-config.js"
import { ghRunner, signedInAccounts } from "../factory/flush.js"
import { memberMessage, memberSourceLabel, resolveMember } from "../desk/crew-member.js"
import { listedIn, mergePeople, normalized, peopleQuestions, starterRoster, toLf } from "./people.js"
import { resolveActivationConfigPath, resolveDeskRootWithSource } from "../util/paths.js"

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
// The line that records, in a desk's commit and a join's pull request, whose desk it is.
const IDENTITY_TRAILER = "Crew-Identity"
// The account name an ambient GH_TOKEN stands for when gh has no account signed in, as in Desk's own boot.
const ENV_TOKEN_ACCOUNT = "env-token"
// Agency fetches a plugin locator again on every install instead of keeping a stale copy of the team's plugin.
const AGENCY_FLAGS = "--engine copilot --cache-policy auto --cache-ttl 0"

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
const sameIdentity = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase()

// `gh` as Desk's own shared writes run it: prompts off, ambient tokens stripped, a token given per call. As at Desk's
// boot, an ambient GH_TOKEN or GITHUB_TOKEN counts as one signed-in account when gh itself has none.
function personGh(env = process.env) {
  const runner = ghRunner({ env })
  const token = (env.GH_TOKEN || env.GITHUB_TOKEN || "").trim()
  return async (args, options) => {
    if (token !== "" && args[0] === "auth" && args[1] === "token" && args[3] === ENV_TOKEN_ACCOUNT) return { code: 0, stdout: `${token}\n`, stderr: "" }
    const result = await runner(args, options)
    if (token === "" || args[0] !== "auth" || args[1] !== "status" || signedInAccounts(`${result.stdout}\n${result.stderr}`).length > 0) return result
    return { code: 0, stdout: `github.com\n  ✓ Logged in to github.com account ${ENV_TOKEN_ACCOUNT} (environment token)\n  - Active account: true\n`, stderr: "" }
  }
}

// Git's settings for a network call to `remote` with a chosen account: only that account's token, through gh, signs in
// (no other credential helper, no extra header, no SSH), and the exact address is rewritten to itself, which outranks
// any shorter redirect rule the clone or the machine carries. The same settings as lesson_add's team write.
const route = (remote) => [
  "credential.helper=", "credential.helper=!gh auth git-credential", "protocol.ssh.allow=never",
  "http.extraheader=", "http.https://github.com/.extraheader=",
  `url.${remote}.insteadOf=${remote}`, `url.${remote}.pushInsteadOf=${remote}`,
].flatMap((setting) => ["-c", setting])

// Git in `cwd`. Network calls go to `git.remote`: the clone's origin with its own credentials until `git.connect` names
// a GitHub address and the token to reach it with.
function gitIn(cwd, spawnGit) {
  let link = { remote: "origin", token: undefined, config: [] }
  const run = (args, { network = false, raw = false } = {}) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }
    if (network && link.token !== undefined) env.GH_TOKEN = link.token
    const result = spawnGit("git", [...(network ? link.config : []), "-C", cwd, ...args], { windowsHide: true, encoding: "utf8", timeout: GIT_TIMEOUT_MS, env })
    const stdout = String(result.stdout ?? "")
    return { ok: result.status === 0, stdout: raw ? stdout : stdout.trim(), stderr: String(result.stderr ?? "").trim() }
  }
  run.must = (args, stage, why = "", options) => {
    const result = run(args, options)
    if (!result.ok) throw new Failed(stage, `${why}${firstLine(result.stderr) || `git ${args[0]} failed`}`)
    return result.stdout
  }
  run.connect = (next) => {
    link = next
  }
  Object.defineProperty(run, "remote", { get: () => link.remote })
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

const hasManifest = (dir) => existsSync(path.join(dir, "plugin.json")) || existsSync(path.join(dir, ".claude-plugin", "plugin.json"))

function listPluginFolders(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((entry) => entry.isDirectory() && hasManifest(path.join(dir, entry.name))).map((entry) => entry.name).sort()
}

// A monorepo's plugin, found in its plugins/ folder when _meta/crew.json does not name it: the only plugin there, none
// (null), or, when there are several, none chosen and the names of all of them, since which is the team's is not
// something to guess.
function inRepoPlugin(top, base) {
  const names = listPluginFolders(path.join(top, "plugins"))
  if (names.length === 0) return null
  if (names.length > 1) return { repo: null, path: null, plugin: null, ref: base, marketplace: null, several: names }
  return { repo: null, path: `plugins/${names[0]}`, plugin: names[0], ref: base, marketplace: null }
}

const quoted = (items) => items.map((item) => `\`${item}\``).join(", ")
const severalMessage = (names) => `This workspace has several plugins in plugins/ (${names.join(", ")}), and _meta/crew.json does not say which one is the team's, so none is installed. Ask the team which one it is; it is recorded as tooling.path and tooling.plugin in _meta/crew.json.`

// How a member gets the team's tooling: the install commands for each host, or why there is nothing to install.
function installFor(tooling, origin) {
  if (tooling.several) return { install: null, message: severalMessage(tooling.several) }
  if (tooling.repo !== null) {
    if (tooling.plugin === null) return { install: null, message: `The team's tooling repository ${tooling.repo} declares no plugin yet, so there is nothing to install. Read it at https://github.com/${tooling.repo}.` }
    const claude = tooling.marketplace === null ? null : [`claude plugin marketplace add ${tooling.repo}`, `claude plugin install ${tooling.plugin}@${tooling.marketplace}`]
    return { install: { copilot: `agency plugin install github:${tooling.repo}${tooling.path === "" ? "" : `:${tooling.path}`}@${tooling.ref} ${AGENCY_FLAGS}`, claude }, message: `Install the team's tooling, plugin ${tooling.plugin} from ${tooling.repo}.` }
  }
  if (origin === null) return { install: null, message: `The team's tooling is ${tooling.path} inside this workspace; this clone's origin is not on GitHub, so install it from the clone.` }
  return { install: { copilot: `agency plugin install github:${origin}:${tooling.path}@${tooling.ref} ${AGENCY_FLAGS}`, claude: null }, message: `Install the team's tooling, plugin ${tooling.plugin} from ${tooling.path} in this workspace.` }
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
  return { git, origin, base, hasOrigin: url.ok }
}

const deskOf = (alias) => `desks/${alias}`

/**
 * crewStatus({ repo, identity? }) -> { state: "not_git" | "not_crew" | "crew", ... }
 *
 * For a Crew workspace: its origin (`owner/name` or null), default branch, setup ("monorepo" or "dual-repo"), the
 * team's tooling with its install commands, the desk list's aliases (`roster`), whether the desk template exists, and,
 * given `identity`, the member it names (`{ alias, desk }`) or null. `people` is the team's roster: its `path`, whether
 * it `exists`, whether it `listed` the member (null without `identity` or without a desk-list row), the interview
 * `questions` (`questions_from`: "roster" or "crew"), when it is missing, Crew's `starter` to create it from, and
 * `problem` when its path leads outside the clone through a symbolic link (it is then never read).
 */
export async function crewStatus({ repo, identity, spawnGit = spawnSync, session = false, env = process.env, memberFn = resolveMember }) {
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
    const row = rows.find((candidate) => sameIdentity(candidate.identity, identity))
    member = row === undefined ? null : { alias: row.alias, desk: deskOf(row.alias) }
    about = row === undefined ? ` ${identity.trim()} has no desk-list row yet; join with crew:join-crew.` : ` ${row.identity} is on the desk list as ${row.alias}.`
  }
  const people = peopleIn(top, config.people, member ? [member.alias, identity] : null)
  const desks = aliases.length === 0 ? "no desks yet" : `${plural(aliases.length, "desk")} (${aliases.join(", ")})`
  const binding = session ? await sessionIn(top, { identity, member, env, memberFn }) : undefined
  return {
    state: "crew",
    repo: top,
    origin,
    base,
    setup: config.setup,
    tooling,
    roster: aliases,
    template: listFiles(path.join(top, ...TEMPLATE.split("/"))).length > 0,
    member,
    people,
    ...(binding === undefined ? {} : { session: binding }),
    problems: config.problems,
    message: `This is a Crew workspace with ${desks}.${about}${binding === undefined ? "" : ` ${binding.message}`}`,
  }
}

// The team's roster at `rel` in the clone at `top`, as `crewStatus` reports it; `names` are the member's alias and
// identity, or null when there is no member to look for.
function peopleIn(top, rel, names) {
  let text = null
  const outside = leadsOutside(top, rel)
  try {
    text = outside ? null : readFileSync(path.join(top, ...rel.split("/")), "utf8")
  } catch {
    text = null
  }
  const { questions, from } = peopleQuestions(text)
  return {
    path: rel,
    ...(outside ? { problem: outsideMessage([rel]) } : {}),
    exists: text !== null,
    listed: names === null ? null : text !== null && listedIn(text, names),
    questions,
    questions_from: from,
    ...(text === null ? { starter: starterRoster() } : {}),
  }
}

/**
 * What a Desk session started in the clone at `top` binds, from Desk's own resolvers with the real environment: the root
 * the host would bind with this clone as its project folder (`util/paths.js`), and the person it writes as
 * (`desk/crew-member.js`, which may ask GitHub when several signed-in accounts are on the roster). `ready` is true when
 * the root is this clone and the person is `identity`'s roster alias (any person when no identity is given): the
 * member's next session is set up. This is the activation check a join can run in the same session.
 */
async function sessionIn(top, { identity, member, env, memberFn }) {
  let bound
  let here = false
  try {
    bound = resolveDeskRootWithSource({ env, activationConfigPath: resolveActivationConfigPath({ env }), hostProjectRoot: top, cwd: top, homeDir: env.HOME || os.homedir() })
    // The resolver returns only a folder that exists, so both resolve to their real paths.
    here = realpathSync(bound.root) === realpathSync(top)
  } catch {
    bound = { root: null, source: null }
  }
  const found = here ? await memberFn({ deskRoot: top, env }) : null
  const person = found?.person ?? null
  const expected = identity === undefined || identity === null || String(identity).trim() === "" ? undefined : member?.alias ?? null
  const ready = here && person !== null && (expected === undefined || person === expected)
  let message
  if (!here) message = `A Desk session started in this clone would bind ${bound.root ?? "no desk"} (${bound.source ?? "nothing found"}), not this clone.`
  else if (person === null) message = memberMessage(found)
  else if (!ready) message = `A Desk session started in this clone writes as ${person} (${memberSourceLabel(found)}), not as ${expected ?? `${identity}, who has no desk-list row`}.`
  else message = `A Desk session started in this clone binds it and writes to desks/${person}/ (${memberSourceLabel(found)}).`
  return {
    ready,
    root: bound.root,
    root_source: bound.source,
    person,
    person_source: found?.source ?? null,
    identity: found?.identity ?? null,
    write_path: person === null ? null : `desks/${person}`,
    message,
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

// The line ending a file already uses, so text added to it keeps that ending.
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n")
const withEol = (text, eol) => (eol === "\n" ? text : text.replace(/\r?\n/gu, eol))

const rosterHeader = () => `| ${ROSTER_COLUMNS.join(" | ")} |\n|${ROSTER_COLUMNS.map(() => "---").join("|")}|\n`
const rosterFile = () => `# Desks\n\nEach row binds one person's account to their own desk in \`desks/\`. Crew's join-crew adds a row for a new teammate once their desk is in place.\n\n${rosterHeader()}`

function rosterRow(header, { alias, identity, origin }) {
  const values = { alias, identity, path: deskOf(alias), repo: origin ?? "", worker_variant: "crew", write_subtree: deskOf(alias) }
  return `| ${header.map((column) => values[column] ?? "").join(" | ")} |`
}

// `_meta/desks.md` with the row added at the end of the roster table; the text around the table, and its line ending,
// are kept as they are.
function withRosterRow(current, member) {
  if (current === null) return `${rosterFile()}${rosterRow(ROSTER_COLUMNS, member)}\n`
  const eol = eolOf(current)
  const lines = current.split("\n")
  const table = markdownTables(current).find((candidate) => candidate.header.includes("alias") && candidate.header.includes("identity"))
  if (table === undefined) return `${current.replace(/(?:\r?\n)*$/u, eol)}${eol}${withEol(rosterHeader(), eol)}${rosterRow(ROSTER_COLUMNS, member)}${eol}`
  const start = lines.findIndex((line) => {
    const trimmed = line.trim()
    return trimmed.startsWith("|") && trimmed.toLowerCase().includes("alias") && trimmed.toLowerCase().includes("identity")
  })
  let end = start
  while (end + 1 < lines.length && lines[end + 1].trim().startsWith("|")) end += 1
  lines.splice(end + 1, 0, `${rosterRow(table.header, member)}${eol === "\r\n" ? "\r" : ""}`)
  return lines.join("\n")
}

function crewSection({ tooling, outside, people }) {
  const lines = [
    "## Crew workspace",
    "",
    "This repository is also a Crew shared workspace. Each teammate's agents keep their own working state in `desks/<alias>/`; everything outside a person's own desk is shared. `_meta/desks.md`, the desk list, binds each person's account to their desk, and `_meta/crew.json` holds Crew's settings.",
    "",
    `- **Team facts** go in \`${FACTS}\`: externally true, team-neutral material, each with its source and the date it was checked.`,
    `- **Agreed team decisions** go in \`${DECISIONS}\`: only what the team actually agreed, with who agreed it and when. One person's view stays in their own desk, attributed to them.`,
    `- **The team's roster** is \`${people}\`: everyone the team works with, teammates and contacts, and what is worth knowing about them. When a person comes up in your work, add or update their entry; Crew's \`crew:roster\` skill says how.`,
  ]
  if (tooling?.repo) lines.push(`- **Team tooling**: the team's plugin lives in the separate [${tooling.repo}](https://github.com/${tooling.repo}) repository, not in this one.`)
  else if (tooling?.path) lines.push(`- **Team tooling**: the team's plugin is in \`${tooling.path}/\`.`)
  lines.push("- **Shared writes** (anything outside your own desk) land through a pull request that the writer merges at once; the pull request serializes concurrent writes and is not a review.")
  if (outside.length > 0) lines.push(`- **Not yet in Crew's shape**: ${quoted(outside)}. Their content stays where it is until the team decides to move it into the folders above (Crew's \`start-crew\` says how); until then, read it where it is.`)
  lines.push("- **To join**, a new teammate's agent runs Crew's `join-crew`, which asks them a few questions, adds their desk, then their roster entry and their desk-list row.")
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

const exists = (top, rel) => {
  try {
    lstatSync(path.join(top, ...rel.split("/")))
    return true
  } catch {
    return false
  }
}

// Whether `rel` in the clone at `top` leads outside it, or into its .git folder, through a symbolic link: the path is
// itself a link, or the nearest part of it that exists resolves elsewhere. Crew reads and writes only inside the clone.
function leadsOutside(top, rel) {
  const target = path.join(top, ...rel.split("/"))
  let at = target
  for (;;) {
    let stat = null
    try {
      stat = lstatSync(at)
    } catch {
      at = path.dirname(at)
      continue
    }
    if (at === target && stat.isSymbolicLink()) return true
    break
  }
  try {
    const root = realpathSync(top)
    const real = realpathSync(at)
    return !(real === root || real.startsWith(`${root}${path.sep}`)) || path.relative(root, real).split(path.sep)[0].toLowerCase() === ".git"
  } catch {
    // A link to nothing.
    return true
  }
}

const outsideMessage = (paths) => `Crew writes only inside this clone, and a symbolic link leads outside it at ${paths.join(", ")}; ask the teammate who added the link to replace it with a real folder or file`

// The name a top-level file has in this clone, compared without case (a repository may hold \`readme.md\` or
// \`Agents.md\`), or null. On a case-sensitive file system the exact name wins.
function rootName(top, name) {
  const entries = readdirSync(top)
  if (entries.includes(name)) return name
  return entries.find((entry) => entry.toLowerCase() === name.toLowerCase()) ?? null
}

// Whether a file Crew would add is already there: a top-level one in any case.
const present = (top, rel) => (rel.includes("/") ? exists(top, rel) : rootName(top, rel) !== null)

// Writes `files` and adds to `created` each folder it had to make, outermost first, so a failure can remove them.
function writeFiles(top, files, created) {
  const outside = Object.keys(files).filter((rel) => leadsOutside(top, rel))
  if (outside.length > 0) throw new Failed("outside", outsideMessage(outside))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(top, ...rel.split("/"))
    const made = mkdirSync(path.dirname(abs), { recursive: true })
    if (made !== undefined) created.add(path.relative(top, made).split(path.sep).join("/"))
    writeFileSync(abs, content)
  }
}

// ── Signing in ───────────────────────────────────────────────────────────────────────────────────────────────────

async function tokenOf(gh, account) {
  const answer = await gh(["auth", "token", "--user", account])
  const token = String(answer.stdout).trim()
  return answer.code === 0 && token !== "" ? token : null
}

const NOT_SEEN = /\(HTTP 40[34]\)/u

// The login GitHub says `token` belongs to, for an ambient token that gh lists under a placeholder name; the
// placeholder when GitHub does not say. Pull requests are listed and matched by this login.
async function tokenLogin(gh, token) {
  const me = ghJson(await gh(["api", "user"], { token }))
  return typeof me.login === "string" && me.login !== "" ? me.login : ENV_TOKEN_ACCOUNT
}

// Every account signed in to gh, asked about `store` with its own token, the active account first: whether it sees the
// repository and may push to it. The same choice as Desk's `chooseAccount`, which lesson_add uses, without that
// function's limit to the owner names Desk's factory records allow: an Enterprise Managed Users login has an underscore.
async function accountsFor(store, gh) {
  const status = await gh(["auth", "status", "--hostname", "github.com"])
  if (status.code === null) return { why: "gh is not installed or could not start" }
  const accounts = []
  for (const listed of signedInAccounts(`${status.stdout}\n${status.stderr}`)) {
    const token = await tokenOf(gh, listed)
    if (token === null) {
      accounts.push({ account: listed, why: "its token failed; sign it in again with gh auth login" })
      continue
    }
    const account = listed === ENV_TOKEN_ACCOUNT ? await tokenLogin(gh, token) : listed
    const answer = await gh(["api", `repos/${store}`], { token })
    if (answer.code !== 0 && !NOT_SEEN.test(String(answer.stderr))) {
      accounts.push({ account, why: `GitHub could not be asked: ${firstLine(answer.stderr) || "no answer"}` })
      continue
    }
    const info = ghJson(answer)
    accounts.push({ account, token, seen: answer.code === 0, push: answer.code === 0 && info?.permissions?.push === true })
  }
  if (accounts.length === 0) return { why: "no gh account is signed in" }
  return { accounts }
}

// Why none of the accounts will do: the first account's trouble, when one had trouble.
const troubleOf = (accounts) => accounts.find((entry) => entry.why !== undefined)?.why

// The signed-in account that can push to `store`, and its token.
async function writerFor(store, gh) {
  const { accounts, why } = await accountsFor(store, gh)
  const writer = accounts?.find((entry) => entry.push)
  if (writer === undefined) throw new Failed("account", `no signed-in GitHub account can push to ${store} (${why ?? troubleOf(accounts) ?? "none of them has write access to it"}). Sign in to gh as an account with write access to it (gh auth login), then run this again`)
  return writer
}

// Whether a GitHub link to the workspace can be made: the clone's origin is a GitHub repository.
async function connectTo(git, origin, { gh, result }) {
  if (origin === null) return undefined
  const { account, token } = await writerFor(origin, gh)
  result.account = account
  const remote = `https://github.com/${origin}.git`
  git.connect({ remote, token, config: route(remote) })
  return (args) => gh(args, { token })
}

// ── The tooling a start records ──────────────────────────────────────────────────────────────────────────────────

const contentOf = async (hub, repo, file, ref) => {
  const answer = await hub(["api", `repos/${repo}/contents/${file}?ref=${encodeURIComponent(ref)}`])
  if (answer.code !== 0) return null
  try {
    const json = JSON.parse(String(answer.stdout))
    return json?.type === "file" ? json : null
  } catch {
    return null
  }
}

// Why the tooling repository a dual-repo start names cannot be installed from as declared, or null when it can.
async function toolingRepoProblem(tooling, gh) {
  const { repo, plugin, marketplace, ref } = tooling
  const { accounts, why } = await accountsFor(repo, gh)
  const reader = accounts?.find((entry) => entry.seen)
  if (reader === undefined) {
    const trouble = why ?? troubleOf(accounts)
    if (trouble !== undefined) return `could not check the tooling repository ${repo} (${trouble})`
    return `the tooling repository ${repo} does not exist, or no signed-in gh account can see it. Create it on GitHub first (private is fine, with read access for the whole team), or correct --tooling-repo, then run start again`
  }
  if (plugin === null) return null
  const hub = (args) => gh(args, { token: reader.token })
  const where = tooling.path === "" ? "" : `${tooling.path}/`
  const manifests = [`${where}plugin.json`, `${where}.claude-plugin/plugin.json`]
  const found = []
  for (const file of manifests) if ((await contentOf(hub, repo, file, ref)) !== null) found.push(file)
  if (found.length === 0) return `${repo} has no plugin at ${where === "" ? "its root" : where} on ${ref}: add ${manifests[0]} (for Copilot through Agency) and ${manifests[1]} (for Claude Code) there, or correct --tooling-path and --tooling-ref, then run start again`
  if (marketplace === null) return null
  const file = await contentOf(hub, repo, ".claude-plugin/marketplace.json", ref)
  let listed = null
  try {
    listed = JSON.parse(Buffer.from(String(file?.content ?? ""), "base64").toString("utf8"))
  } catch {
    listed = null
  }
  const plugins = Array.isArray(listed?.plugins) ? listed.plugins : []
  if (listed?.name !== marketplace || !plugins.some((entry) => entry?.name === plugin)) {
    return `${repo} has no .claude-plugin/marketplace.json on ${ref} named ${marketplace} that lists the plugin ${plugin}: add one, or leave out --tooling-marketplace (Claude Code then has no install command), then run start again`
  }
  return null
}

// ── Landing a change ─────────────────────────────────────────────────────────────────────────────────────────────

// Whether the remote has any commit, and the branch its HEAD names.
function remoteHead(git) {
  const head = git(["ls-remote", "--symref", git.remote, "HEAD"], { network: true })
  if (!head.ok) throw new Failed("fetch", `could not reach origin: ${firstLine(head.stderr)}`)
  return { empty: !/^[0-9a-f]{40,}\s+HEAD$/mu.test(head.stdout), named: /^ref: refs\/heads\/(\S+)\s+HEAD$/mu.exec(head.stdout)?.[1] }
}

const fetchBase = (git, base) => git.must(["fetch", "--quiet", git.remote, `+refs/heads/${base}:refs/remotes/origin/${base}`], "fetch", "", { network: true })

// Checks the clone can take a write, signs in (`connect`), and brings the clone up to date with origin. Returns how
// the change can land.
async function prepareCheckout(git, connect, people) {
  if (git(["status", "--porcelain"]).stdout !== "") return { refused: "has uncommitted changes; commit or stash them first, then run this again" }
  const url = git(["config", "--get", "remote.origin.url"])
  const branch = currentBranch(git)
  if (!url.ok) return { mode: "local", branch }
  const hub = await connect()
  const { empty, named = branch } = remoteHead(git)
  // A repository with no commits yet has no branch for a pull request to merge into.
  if (empty) return { mode: "first", branch: named, hub }
  const base = named
  if (branch !== base) return { refused: `is on ${branch ?? "a detached HEAD"}, not the default branch ${base}; switch to ${base} first` }
  fetchBase(git, base)
  // A clone with no commit (a first push GitHub took although its answer was lost) simply takes origin's branch.
  const born = git(["rev-parse", "--verify", "--quiet", "HEAD"]).ok
  if (born && !git(["merge-base", "--is-ancestor", "HEAD", `origin/${base}`]).ok) {
    if (people !== undefined && committedPeople(git, base, people)) return { refused: committedMessage(people, base) }
    return { refused: `has commits that are not on origin/${base}; push or drop them first` }
  }
  git.must(["merge", "--quiet", "--ff-only", `origin/${base}`], "fetch")
  return { mode: "remote", base, hub }
}

// Whether the clone's commits that are not on origin/<base> change only the team's roster `rel`: an agent committed
// the entry. Crew lands it from the uncommitted change, never by a push straight to the shared branch.
function committedPeople(git, base, rel) {
  const ahead = splitZ(git(["diff", "--name-only", "-z", `origin/${base}...HEAD`], { raw: true }).stdout)
  return ahead.length > 0 && ahead.every((file) => file === rel)
}

const committedMessage = (rel, base) => `has the change to the team's roster ${rel} committed, and Crew lands it from the uncommitted change; undo the commit and keep the change with git reset --soft origin/${base}, then run this again`

function commitAll(git, paths, message) {
  git.must(["add", "--", ...paths], "commit")
  git.must(["commit", "--quiet", "-m", message], "commit", "the commit was refused (this repository's commit hooks or signing): ")
}

// Puts the clone back on `base` at `ref` (or with no commit at all when `ref` is null), dropping only what this run
// wrote: its files and the folders it made.
function restore(git, base, ref, paths, folders, branch) {
  git(["reset", "--quiet", "--hard"])
  if (branch !== undefined) {
    git(["switch", "--quiet", base])
    git(["branch", "-D", branch])
  }
  if (ref === null) {
    git(["update-ref", "-d", "HEAD"])
    git(["read-tree", "--empty"])
  } else git(["reset", "--quiet", "--hard", ref])
  // The outermost folders first, on their own: Git keeps a folder it is asked to clean together with something inside it.
  const outermost = [...folders].filter((folder) => ![...folders].some((other) => folder.startsWith(`${other}/`)))
  if (outermost.length > 0) git(["clean", "-fdq", "--", ...outermost])
  if (paths.length > 0) git(["clean", "-fdq", "--", ...paths])
}

const ghText = (answer) => String(answer.stdout).trim()
const ghJson = (answer) => {
  try {
    return JSON.parse(ghText(answer))
  } catch {
    return {}
  }
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

// The identities a pull request body names on lines of their own.
const identityLines = (body) => [...String(body).matchAll(new RegExp(`^[ \\t]*${IDENTITY_TRAILER}:[ \\t]*(\\S.*?)[ \\t]*$`, "gmu"))].map((match) => match[1])

/**
 * The open pull request an earlier run of this script left behind, or undefined. Only one that is certainly this
 * run's own work is reused, because it is then merged as it is: opened by `account`, from a branch in this repository
 * (not a fork) named by `branch`, aimed at `base`, naming `identity` on a line of its own when one is given, and
 * changing exactly `paths`. Anyone else's pull request is left alone.
 */
async function openPullRequest(hub, origin, { account, base, branch, identity, paths }) {
  const answer = await hub(["pr", "list", "--repo", origin, "--state", "open", "--author", account, "--json", "url,headRefName,body,author,isCrossRepository,baseRefName,files", "--limit", "100"])
  if (answer.code !== 0) throw new Failed("pull_request", `could not list the open pull requests: ${firstLine(answer.stderr)}`)
  const list = ghJson(answer)
  const wanted = [...paths].sort().join("\n")
  const filesOf = (pr) => (Array.isArray(pr?.files) ? pr.files.map((file) => String(file?.path)).sort().join("\n") : null)
  const found = (Array.isArray(list) ? list : []).find(
    (pr) =>
      sameIdentity(pr?.author?.login, account) &&
      pr?.isCrossRepository === false &&
      pr?.baseRefName === base &&
      branch.test(String(pr?.headRefName)) &&
      (identity === undefined || identityLines(pr?.body).some((named) => sameIdentity(named, identity))) &&
      filesOf(pr) === wanted,
  )
  return found === undefined ? undefined : { url: found.url, branch: found.headRefName }
}

// The commit origin's branch `name` points at, or "" when origin has no such branch.
function remoteBranch(git, name) {
  const seen = git(["ls-remote", "--heads", git.remote, `refs/heads/${name}`], { network: true })
  if (!seen.ok) throw new Failed("fetch", `could not reach origin: ${firstLine(seen.stderr)}`)
  return seen.stdout.split(/\s/u)[0]
}

// A branch name `prefix<stamp>` that no branch on origin has yet, counting the stamp up from `stamp`.
function freeBranch(git, prefix, stamp) {
  for (let next = stamp; ; next += 1) {
    const name = `${prefix}${next.toString(36)}`
    if (remoteBranch(git, name) === "") return name
  }
}

const MERGE_METHODS = [
  ["--squash", "squashMergeAllowed"],
  ["--merge", "mergeCommitAllowed"],
  ["--rebase", "rebaseMergeAllowed"],
]

// The `gh pr merge` flag for a merge method `origin` allows: squash first, then a merge commit, then rebase.
async function mergeMethod(hub, origin) {
  const answer = await hub(["repo", "view", origin, "--json", MERGE_METHODS.map(([, field]) => field).join(",")])
  if (answer.code !== 0) throw new Failed("pull_request", `could not read which merge methods ${origin} allows: ${firstLine(answer.stderr)}`)
  const allowed = ghJson(answer)
  const method = MERGE_METHODS.find(([, field]) => allowed[field] === true)
  if (method === undefined) throw new Failed("pull_request", `${origin} allows no merge method gh can use (squash, merge commit or rebase)`)
  return method[0]
}

// Commits what `write` writes and pushes it to the default branch; when the branch moved, rebuilds on it and pushes
// again. `write` returns the paths it wrote, or null when the default branch needs nothing from it.
async function landByPush({ git, base, write, message, created }) {
  const start = git(["rev-parse", "HEAD"]).stdout
  let paths = []
  try {
    let pushed
    for (let attempt = 1; attempt <= PUSH_TRIES; attempt += 1) {
      if (attempt > 1) {
        fetchBase(git, base)
        git.must(["reset", "--quiet", "--hard", `origin/${base}`], "reset")
      }
      paths = write()
      if (paths === null) return { unchanged: true }
      commitAll(git, paths, message)
      pushed = git(["push", "--quiet", git.remote, `HEAD:refs/heads/${base}`], { network: true })
      if (pushed.ok) return { commit: git(["rev-parse", "HEAD"]).stdout }
    }
    throw new Failed("push", `the push was refused: ${firstLine(pushed.stderr)}`)
  } catch (error) {
    restore(git, base, start, paths, created)
    throw error
  }
}

const prView = async (hub, url) => ghJson(await hub(["pr", "view", url, "--json", "state,mergeable,mergeStateStatus,mergeCommit"]))

/**
 * Lands what `write` writes through a pull request merged at once, the shared-path protocol, or reuses the open pull
 * request `reuse` names. `write` returns the paths it wrote, or null when the default branch already has what it
 * would add; it throws a Failed when a teammate's change makes the write wrong. On a conflict it runs again on the new
 * default branch; a rebuild with nothing left to add, or that fails, closes the pull request.
 */
async function landByPullRequest({ git, base, origin, write, message, body, prefix, stamp, hub, wait, result, reuse, created }) {
  if (origin === null) throw new Failed("pull_request", "this workspace's shared writes land through a GitHub pull request, and this clone's origin is not on GitHub")
  const start = git(["rev-parse", "HEAD"]).stdout
  const method = await mergeMethod(hub, origin)
  const name = reuse?.branch ?? freeBranch(git, prefix, stamp)
  let paths = []
  let pushed = false
  const unpush = () => git(["push", "--quiet", git.remote, "--delete", name], { network: true })
  const back = () => {
    git.must(["switch", "--quiet", base], "branch")
    git(["branch", "-D", name])
  }
  // The pull request has nothing left to do: close it and its branch.
  const abandon = async (why) => {
    await hub(["pr", "close", result.pr, "--comment", why])
    unpush()
    delete result.pr
  }
  // The commit this run pushed for the pull request: what the default branch must hold once it merged.
  let ours = null
  // Builds the change again from `write` on the default branch as GitHub has it now and force-pushes it to the pull
  // request's branch, leased to what that branch holds now, so the pull request carries exactly this run's commit
  // whatever was pushed onto it before. False when the default branch already has the change: the pull request closes.
  const rebuild = async () => {
    fetchBase(git, base)
    git.must(["reset", "--quiet", "--hard", `origin/${base}`], "reset")
    let rebuilt
    try {
      rebuilt = write()
    } catch (error) {
      await abandon(`Closed by Crew's crew.js: ${error.message}.`)
      throw error
    }
    if (rebuilt === null) {
      await abandon("Closed by Crew's crew.js: the default branch already has this change.")
      back()
      return false
    }
    paths = rebuilt
    commitAll(git, paths, message)
    const lease = remoteBranch(git, name)
    git.must(["push", "--quiet", `--force-with-lease=refs/heads/${name}:${lease}`, git.remote, `HEAD:refs/heads/${name}`], "push", "the push was refused: ", { network: true })
    pushed = true
    ours = git(["rev-parse", "HEAD"]).stdout
    return true
  }
  try {
    git.must(["switch", "--quiet", "-c", name], "branch")
    if (reuse === undefined) {
      paths = write()
      if (paths === null) {
        back()
        return { unchanged: true }
      }
      commitAll(git, paths, message)
      git.must(["push", "--quiet", git.remote, `HEAD:refs/heads/${name}`], "push", "the push was refused: ", { network: true })
      pushed = true
      ours = git(["rev-parse", "HEAD"]).stdout
      const opened = await hub(["pr", "create", "--repo", origin, "--base", base, "--head", name, "--title", message, "--body", body])
      const url = ghText(opened).split("\n").pop()
      if (opened.code !== 0 || !/^https:\/\/github\.com\//u.test(url)) throw new Failed("pull_request", `could not open the pull request: ${firstLine(opened.stderr)}`)
      result.pr = url
    } else {
      // An earlier run's own pull request: merged only once it holds this run's write, never as it stands.
      result.pr = reuse.url
      result.reused = true
      if (!(await rebuild())) return { unchanged: true }
    }
    let state = {}
    let refusal = ""
    for (let attempt = 1; ; attempt += 1) {
      const answer = await hub(["pr", "merge", result.pr, method])
      refusal = answer.code === 0 ? "" : firstLine(answer.stderr)
      state = await prView(hub, result.pr)
      // A merge command that succeeded may only have queued the pull request: only GitHub's own state says it merged.
      for (let poll = 0; answer.code === 0 && state.state !== "MERGED" && poll < MERGE_POLLS; poll += 1) {
        await wait(2000)
        state = await prView(hub, result.pr)
      }
      if (state.state === "MERGED" || answer.code === 0 || attempt === MERGE_TRIES) {
        if (state.state !== "MERGED" && answer.code === 0) state = { ...state, mergeStateStatus: "QUEUED" }
        break
      }
      if (state.mergeable === "CONFLICTING" || state.mergeStateStatus === "BEHIND") {
        // A teammate changed the default branch first: build the change again on top of theirs, checked again.
        if (!(await rebuild())) return { unchanged: true }
      } else if (state.mergeable === "UNKNOWN") await wait(2000)
      else break
    }
    back()
    if (state.state !== "MERGED") {
      result.branch = name
      return { open: state.mergeStateStatus ?? "unknown", refusal }
    }
    unpush()
    const commit = state.mergeCommit?.oid ?? null
    // GitHub merged it: a fetch that fails now leaves the change in effect, unconfirmed by this clone.
    const fetched = git(["fetch", "--quiet", git.remote, `+refs/heads/${base}:refs/remotes/origin/${base}`], { network: true })
    if (!fetched.ok) return { commit, unfetched: firstLine(fetched.stderr) }
    git.must(["merge", "--quiet", "--ff-only", `origin/${base}`], "fetch")
    return { commit: commit ?? git(["rev-parse", "HEAD"]).stdout, ours }
  } catch (error) {
    if (pushed && result.pr === undefined) unpush()
    restore(git, base, start, paths, created, currentBranch(git) === base ? undefined : name)
    throw error
  }
}

function failedResult(result, error, extra = "") {
  if (!(error instanceof Failed)) throw error
  const open = result.pr ? ` The pull request ${result.pr} is open.` : ""
  return { ...result, state: "failed", stage: error.stage, reason: error.message, message: `Not in effect: the shared write stopped at ${error.stage} (${error.message}).${open}${extra}` }
}

// GitHub reports the pull request merged, yet the default branch, read back, does not hold `missing` (`what`, in plain
// words); `next` is the person's next step.
const notConfirmed = (result, base, missing, what, next) => ({ ...result, state: "failed", stage: "verify", reason: `${base} does not hold ${missing.join(", ")}`, message: `Not confirmed: GitHub says the pull request ${result.pr} merged, but the team's ${base} branch does not have ${what}. ${next}` })

// GitHub merged the pull request, and this clone could not fetch the default branch to read it back; Git's own words
// go in `reason`, not in the message a person reads.
const unconfirmedResult = (result, landed, state, done, next) => ({ ...result, state, confirmed: false, commit: landed.commit, reason: landed.unfetched, message: `${done}: GitHub merged the pull request ${result.pr}, so the change is in effect. This computer could not download it afterwards to double-check, probably a brief network problem. Next: once the network is back, update this copy of the workspace and check its status. ${next}` })

// A pull request left open, with GitHub's reason in plain words and the next step.
function openResult(result, landed, base, lead) {
  const reasons = {
    QUEUED: "it is queued to merge, and takes effect when GitHub merges it",
    BLOCKED: `GitHub's rules for ${base} block merging it (a required review, a required check or a merge restriction). Someone allowed to merge into ${base} merges it; for Crew's writes to land at once, the team lets its members merge Crew's crew/ pull requests`,
  }
  const why = reasons[landed.open] ?? `GitHub reports ${landed.open}`
  const said = landed.refusal ? ` GitHub said: ${landed.refusal.replace(/\.$/u, "")}.` : ""
  return { ...result, state: "pr_open", reason: landed.open, message: `${lead}the pull request ${result.pr} is open on branch ${result.branch} and has not merged: ${why}.${said} Running the same command again reuses this pull request and tries to merge it again; it never opens a second one.` }
}

// ── start ────────────────────────────────────────────────────────────────────────────────────────────────────────

function declarationFor({ tooling, people }) {
  const declaration = { schema_version: 1 }
  const given = Object.fromEntries(Object.entries(tooling ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== ""))
  if (Object.keys(given).length > 0) declaration.tooling = given
  if (people !== undefined) declaration.people = people
  return declaration
}

// A clone that already holds a Crew workspace whose origin has no commits: a start whose first push never happened.
// A rerun pushes it; any other Crew workspace has nothing to start.
const alreadyCrew = (action, top) => ({ action, state: "already_crew", repo: top, changes: [], message: "This repository is already a Crew workspace; nothing to change. Teammates join it with crew:join-crew." })

async function finishStart({ action, top, git, apply, connect, result, origin }) {
  const already = alreadyCrew(action, top)
  // A clone that ever fetched a commit from its origin has a remote-tracking branch: that origin is not empty.
  const fetched = git(["for-each-ref", "--count=1", "refs/remotes/origin/"]).stdout !== ""
  if (fetched || !git(["config", "--get", "remote.origin.url"]).ok || !git(["rev-parse", "--verify", "--quiet", "HEAD"]).ok) return already
  try {
    await connect()
    const { empty, named = currentBranch(git) } = remoteHead(git)
    if (!empty) {
      // Origin has commits: this start is on GitHub only if origin's branch holds it. Fetched without a
      // remote-tracking branch, so a rerun asks again.
      git.must(["fetch", "--quiet", git.remote, `refs/heads/${named}`], "fetch", "could not fetch from origin: ", { network: true })
      if (git(["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]).ok) return already
      return { ...result, state: "refused", changes: [], message: `Nothing was pushed: this clone holds a Crew workspace that is not on GitHub, and ${origin}'s ${named} already has commits this clone does not share (GitHub's "Add a README" option makes one). Create the GitHub repository empty and run start again, or clone it and run start in that clone.` }
    }
    if (!apply) return { ...result, state: "plan", changes: [], message: `Plan only: nothing was written. This clone already holds a Crew workspace that is not on GitHub yet: its origin has no commits. Run again with --apply to push it to ${named}.` }
    git.must(["push", "--quiet", git.remote, `HEAD:refs/heads/${named}`], "push", "the push was refused: ", { network: true })
    return { ...result, state: "published", changes: [], commit: git(["rev-parse", "HEAD"]).stdout, message: `Started: this clone's Crew workspace, which was not on GitHub yet, is pushed to ${named}. Teammates join it with crew:join-crew.` }
  } catch (error) {
    return failedResult(result, error)
  }
}

/**
 * startWorkspace({ repo, apply?, tooling?, people?, founder?: { alias, identity }, team? }) -> { state, changes, ... }
 *
 * Adds Crew's shape to a new or existing repository; `tooling.repo` makes it dual-repo, and that repository must exist
 * and hold what is declared. `people` is the team's roster (by default `_shared/landscape/roster.md`): recorded in
 * `_meta/crew.json`, left byte-identical when it exists, and created from Crew's starter when it does not. `state`: "plan" (nothing written), "published" (landed on the default branch),
 * "committed" (a clone with no origin), "pr_open", "already_crew", "refused" (before any write) or "failed" (with
 * `stage`; the clone is put back as it was).
 */
export async function startWorkspace({ repo, apply = false, tooling, people, founder, team, spawnGit = spawnSync, gh = personGh(), wait = sleep, now = Date.now }) {
  const action = "start"
  const refuse = (message) => ({ action, state: "refused", repo, message: `Nothing was written: ${message}.` })
  const top = toplevel(repo, spawnGit)
  if (top === null) return { action, state: "refused", repo, message: notGit(repo) }
  const { git, origin, base } = workspaceFacts(top, spawnGit)
  const declaration = declarationFor({ tooling, people })
  const parsed = parseCrewConfig(JSON.stringify(declaration))
  // Recorded as Crew reads it back: a path in `/` form, the default when none was given.
  declaration.people = parsed.people
  const result = { action, repo: top, setup: parsed.setup, declaration: { tooling: parsed.tooling, people: parsed.people } }
  const connect = () => connectTo(git, origin, { gh, result })
  if (crewWorkspace(top).crew) return finishStart({ action, top, git, apply, connect, result, origin })
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
  if (rootName(top, "README.md") === null) files["README.md"] = startReadme(team ?? path.basename(top))
  files[CONFIG] = `${JSON.stringify(declaration, null, 2)}\n`
  for (const [rel, content] of Object.entries(TEMPLATE_FILES)) files[`${TEMPLATE}${rel}`] = content
  // A roster the team already keeps is used as it is; only a missing one is created.
  const keptPeople = present(top, parsed.people)
  if (!keptPeople) files[parsed.people] = starterRoster()
  if (founder !== undefined) {
    for (const [rel, content] of Object.entries(TEMPLATE_FILES)) files[`${deskOf(founder.alias)}/${rel}`] = render(content, founder)
  }
  const conflicts = [...Object.keys(files), ROSTER].filter((rel) => present(top, rel)).sort()
  if (conflicts.length > 0) return refuse(`${conflicts.join(", ")} already exists, and starting a crew never overwrites a file`)
  const linked = [...new Set([...Object.keys(files), ROSTER, parsed.people])].filter((rel) => leadsOutside(top, rel))
  if (linked.length > 0) return refuse(outsideMessage(linked))
  if (keptPeople && !git(["ls-files", "--error-unmatch", "--", parsed.people]).ok) return refuse(`${parsed.people} is in this folder but not committed, so teammates' clones would not have it; commit it first, or name another file with --people`)

  // Where the team's plugin is: the tooling repository must hold what is declared; a monorepo's plugin must be there.
  let plugin = parsed.tooling
  if (parsed.setup === "dual-repo") {
    const problem = await toolingRepoProblem(parsed.tooling, gh)
    if (problem !== null) return refuse(problem)
  } else if (plugin !== null) {
    if (plugin.plugin !== null && !hasManifest(path.join(top, ...plugin.path.split("/")))) return refuse(`${plugin.path}/ in this repository has no plugin.json or .claude-plugin/plugin.json; add the plugin there first, or correct --tooling-path`)
  } else {
    plugin = inRepoPlugin(top, base)
    if (plugin?.several) return refuse(`this repository has several plugins in plugins/ (${plugin.several.join(", ")}); name the team's with --tooling-path plugins/<name> --tooling-plugin <name>`)
  }

  const agentsAtPlan = rootName(top, "AGENTS.md")
  const changes = [{ path: agentsAtPlan ?? "AGENTS.md", change: agentsAtPlan === null ? "add" : "append" }, { path: ROSTER, change: "add" }, ...Object.keys(files).map((rel) => ({ path: rel, change: "add" }))]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
  const shape = parsed.setup === "dual-repo" ? SHAPE : [...SHAPE, "plugins/"]
  const outside = teamContent(tracked(git)).filter((entry) => entry.endsWith("/") && !shape.includes(entry))
  Object.assign(result, { changes, outside, people: { path: parsed.people, change: keptPeople ? "keep" : "add" } })
  if (!apply) {
    const added = changes.filter((change) => change.change === "add").length
    const appended = agentsAtPlan === null ? "" : ` and appends a section to ${agentsAtPlan}`
    const roster = keptPeople ? ` The team's roster is the existing ${parsed.people}, left as it is.` : ` The team's roster is a new ${parsed.people}, from Crew's starter.`
    const loose = outside.length > 0 ? ` These top-level folders are outside Crew's shape, and nothing in them is moved: ${outside.join(", ")}. Move their content into the shape with the team afterwards.` : ""
    return { ...result, state: "plan", message: `Plan only: nothing was written. Starting a ${parsed.setup} crew adds ${plural(added, "file")}${appended}.${roster}${loose} Run again with --apply to make the change.` }
  }

  const created = new Set()
  const section = (eol) => withEol(crewSection({ tooling: plugin, outside, people: parsed.people }), eol)
  let written = {}
  const write = () => {
    // Rebuilt on a newer default branch, the change still never overwrites a file a teammate added meanwhile, and
    // appends to an AGENTS.md a teammate added rather than replacing it.
    const appeared = [...Object.keys(files), ROSTER].filter((rel) => present(top, rel))
    if (appeared.length > 0) throw new Failed("rebuild", `${appeared.join(", ")} appeared on the default branch meanwhile, and starting a crew never overwrites a file`)
    const agents = rootName(top, "AGENTS.md")
    const current = agents === null ? startAgents() : readFileSync(path.join(top, agents), "utf8")
    const eol = eolOf(current)
    const separator = current.endsWith("\n") ? eol : `${eol}${eol}`
    const roster = founder === undefined ? rosterFile() : withRosterRow(null, { ...founder, origin })
    written = { ...files, [agents ?? "AGENTS.md"]: `${current}${separator}${section(eol)}`, [ROSTER]: roster }
    writeFiles(top, written, created)
    return Object.keys(written).sort()
  }
  // What the fetched default branch lacks of this run's commit `ours`: every file the start wrote, compared as Git
  // stores it (a clone that converts line endings shows other bytes than GitHub holds).
  const blob = (ref, rel) => git(["rev-parse", "--verify", "--quiet", `${ref}:${rel}`]).stdout
  const notHeld = (ours, held) =>
    Object.keys(written)
      .sort()
      .flatMap((rel) => {
        const there = blob(held, rel)
        if (there === "") return [rel]
        return there === blob(ours, rel) ? [] : [`${rel} as this run wrote it`]
      })
  const message = "Crew: start this Crew workspace"
  try {
    const checkout = await prepareCheckout(git, connect)
    if (checkout.refused) return refuse(`this clone ${checkout.refused}`)
    if (checkout.mode === "local" || checkout.mode === "first") {
      // No pull request is possible: commit here, and push to an empty repository. A failure takes the commit back.
      const before = git(["rev-parse", "--verify", "--quiet", "HEAD"])
      let paths = []
      try {
        paths = write()
        commitAll(git, paths, message)
        if (checkout.mode === "first") git.must(["push", "--quiet", git.remote, `HEAD:refs/heads/${checkout.branch}`], "push", "the push was refused: ", { network: true })
      } catch (error) {
        restore(git, checkout.branch, before.ok ? before.stdout : null, paths, created)
        throw error
      }
      const commit = git(["rev-parse", "HEAD"]).stdout
      if (checkout.mode === "local") return { ...result, state: "committed", commit, message: `Started: committed on ${checkout.branch}. This clone has no origin, so nothing was pushed; add the team's GitHub repository as origin, then run start again to push it.` }
      return { ...result, state: "published", commit, message: `Started: this repository is now a ${parsed.setup} Crew workspace. The repository had no commits for a pull request to merge into, so the first commit was pushed straight to ${checkout.branch}. Teammates join it with crew:join-crew.` }
    }
    // Brought up to date, the clone may show the workspace is already on GitHub (a start whose answer was lost).
    if (crewWorkspace(top).crew) return alreadyCrew(action, top)
    const reuse = origin === null ? undefined : await openPullRequest(checkout.hub, origin, { account: result.account, base: checkout.base, branch: /^crew\/start-[0-9a-z]+$/u, paths: changes.map((change) => change.path) })
    const body = `${message}.\n\nOpened by Crew's crew.js. It is merged at once: a pull request to a shared path here serializes concurrent writes and is not a review.`
    const landed = await landByPullRequest({ git, base: checkout.base, origin, write, message, body, prefix: "crew/start-", stamp: now(), hub: checkout.hub, wait, result, reuse, created })
    if (landed.open !== undefined) return openResult(result, landed, checkout.base, "Not in effect yet: ")
    const next = "Teammates join it with crew:join-crew."
    if (landed.unfetched !== undefined) return unconfirmedResult(result, landed, "published", "Started", next)
    const missing = notHeld(landed.ours, `origin/${checkout.base}`)
    if (missing.length > 0) return notConfirmed(result, checkout.base, missing, "what this start wrote", "Someone may have changed it since. Next: check what the workspace holds now before starting it again.")
    return { ...result, state: "published", commit: landed.commit, message: `Started: this repository is now a ${parsed.setup} Crew workspace. The change merged in ${result.pr}. ${next}` }
  } catch (error) {
    return failedResult(result, error)
  }
}

// ── The team's roster ────────────────────────────────────────────────────────────────────────────────────────────

const splitZ = (text) => text.split("\0").filter(Boolean)

// The roster as the clone's HEAD holds it (as Git stores it), or null when HEAD has no such file.
function headPeople(git, rel) {
  const blob = git(["cat-file", "blob", `HEAD:${rel}`], { raw: true })
  return blob.ok ? blob.stdout : null
}

// Where a roster change waits while a run lands it, in the clone's own Git folder, so a run that fails or is stopped
// partway never loses it. It goes once the change has landed or is back in the clone.
const keptFile = (git, top) => path.resolve(top, git(["rev-parse", "--git-path", "crew-roster-edit.json"]).stdout)

// The change an earlier run kept at `file`: `{ path, base, ours, eol }`, null when there is none, or `{ unreadable }`.
function readKept(file) {
  if (!existsSync(file)) return null
  try {
    const kept = JSON.parse(readFileSync(file, "utf8"))
    if (typeof Object(kept).ours !== "string") throw new Error("no change in it")
    return kept
  } catch {
    return { unreadable: true }
  }
}

const BOM = "\uFEFF"

/**
 * The member's change to the team's roster at `rel`, the only uncommitted change a join or a roster update takes:
 * `{ edit, from, file, replaces }`. `edit` is null when there is none, or `{ base, ours, eol }` (`base`: the file the
 * change was made on, null when there was none; `ours`: the changed file; both with LF line endings; `eol`: the
 * changed file's own line ending). `from` says where it is: "clone" (uncommitted in the clone) or "kept" (kept at
 * `file` by an earlier run that did not land it). An uncommitted change replaces a kept one (`replaces`). `{ refused }`
 * when anything else is uncommitted, or the change cannot be read.
 */
function pendingPeople(git, top, rel) {
  const changed = [...new Set([
    ...splitZ(git(["diff", "--name-only", "--no-renames", "-z", "HEAD"], { raw: true }).stdout),
    ...splitZ(git(["ls-files", "--others", "--exclude-standard", "-z"], { raw: true }).stdout),
  ])].sort()
  const other = changed.filter((file) => file !== rel)
  if (other.length > 0) return { refused: `has uncommitted changes outside the team's roster ${rel} (${other.join(", ")}); commit or stash them first, then run this again` }
  const file = keptFile(git, top)
  const kept = readKept(file)
  if (kept !== null && kept.unreadable) return { refused: `keeps an earlier change to the team's roster at ${file} that Crew cannot read; copy what is still needed from it into ${rel}, move it out of the way, then run this again` }
  if (kept !== null && kept.path !== rel) return { refused: `keeps an earlier change to ${kept.path} at ${file}, but the team's roster is now ${rel}; copy what is still needed from it into ${rel}, move it out of the way, then run this again` }
  if (changed.length === 0) return { edit: kept === null ? null : { base: kept.base, ours: kept.ours, eol: kept.eol }, from: kept === null ? null : "kept", file, replaces: false }
  if (!exists(top, rel)) return { refused: `has the team's roster ${rel} deleted, and Crew never removes it; restore it (git checkout -- ${rel}), then run this again` }
  const text = readFileSync(path.join(top, ...rel.split("/")), "utf8")
  // Windows PowerShell 5.1 saves UTF-16, which reads as UTF-8 with a NUL in every other byte.
  if (text.includes("\0")) return { refused: `has the team's roster ${rel} saved as something other than UTF-8 text; save it again as UTF-8, then run this again` }
  const base = headPeople(git, rel)
  // A byte-order mark an editor added, where the file had none, is not part of the change.
  const ours = text.startsWith(BOM) && !String(base).startsWith(BOM) ? text.slice(1) : text
  return { edit: { base: base === null ? null : normalized(base), ours: normalized(ours), eol: eolOf(text) }, from: "clone", file, replaces: kept !== null }
}

// Keeps the member's roster change at `pending.file`, then takes it out of the clone, which the run's own commits
// need clean.
function holdEdit(git, top, rel, pending) {
  writeFileSync(pending.file, JSON.stringify({ path: rel, ...pending.edit }))
  if (pending.from === "kept") return
  git(["reset", "--quiet", "--", rel])
  if (pending.edit.base === null) unlinkSync(path.join(top, ...rel.split("/")))
  else git.must(["checkout", "--", rel], "people")
}

// The roster change landed, or is back in the clone: nothing is kept any more.
const release = (pending) => rmSync(pending.file, { force: true })

// What the roster `theirs` (the file on the default branch, or null when it has none) becomes with `change` on top:
// `{ text }` (null when it already has the change), `{ conflict: true }` or `{ error }`. A roster that was missing
// when the change was made was Crew's starter, so two people creating it at once both land.
function withPeopleChange(change, theirs, spawnGit) {
  if (theirs === null) return change.base === null ? { text: change.ours } : { conflict: true }
  const merged = mergePeople({ base: change.base ?? starterRoster(), ours: change.ours, theirs, spawnGit })
  return merged.text === normalized(theirs) ? { text: null } : merged
}

// Writes `change` onto the clone's roster for a shared write, in the file's own line ending, and returns the paths it
// wrote ([] when the default branch already has the change). A change that does not merge stops at stage `people`.
function writePeople(top, rel, change, spawnGit, created) {
  if (leadsOutside(top, rel)) throw new Failed("outside", outsideMessage([rel]))
  const file = path.join(top, ...rel.split("/"))
  const raw = existsSync(file) ? readFileSync(file, "utf8") : null
  const merged = withPeopleChange(change, raw, spawnGit)
  if (merged.conflict) throw new Failed("people", `a teammate changed the same entry of the team's roster ${rel} first`)
  if (merged.error !== undefined) throw new Failed("people", `the team's roster ${rel} could not be merged: ${merged.error}`)
  if (merged.text === null) return []
  writeFiles(top, { [rel]: withEol(merged.text, raw === null ? change.eol : eolOf(raw)) }, created)
  return [rel]
}

// Puts the member's roster change back in the clone after a run that did not land it, carried onto the clone's
// current commit, so a rerun merges it against the file it now sits on and never undoes a teammate's change. A change
// that no longer merges there stays kept, and the note returned says where and what a rerun does.
function putBack(git, top, rel, pending, spawnGit, action) {
  const merged = leadsOutside(top, rel) ? {} : withPeopleChange(pending.edit, headPeople(git, rel), spawnGit)
  if (merged.text === undefined) return ` The change to the team's roster could not be put back in ${rel} as it is now; it is kept at ${pending.file}, and running ${action} --apply again lands it, or says what to do if it still does not merge.`
  if (merged.text !== null) writeFiles(top, { [rel]: withEol(merged.text, pending.edit.eol) }, new Set())
  release(pending)
  return ""
}

// What to do after a roster change a teammate's change conflicts with. The clone is left clean on the default branch
// as GitHub has it, so the roster is read again as it is now; the change stays kept until a new one replaces it.
const peopleNext = (rel, action, pending) => ` Next: read the team's roster ${rel} again as it is now, write the entry again in it${pending.edit === null ? "" : ` (what was written before is kept at ${pending.file})`}, and run ${action} --apply again; it adds only what is missing.`

function peopleFailure(git, base, error) {
  if (error.stage !== "people") return false
  git(["merge", "--quiet", "--ff-only", `origin/${base}`])
  return true
}

const peopleChangeKind = (pending, change) => (pending.edit === null ? (change === null ? "none" : "starter") : pending.edit.base === null ? "create" : "edit")

// The roster change as a plan shows it: what kind of change, where it is (`from`), Git's diff of an uncommitted edit,
// and `kept`, the file holding a change an earlier run kept.
function describePeople(git, rel, pending, change) {
  const kind = peopleChangeKind(pending, change)
  return {
    path: rel,
    change: kind,
    ...(pending.edit === null ? {} : { from: pending.from }),
    ...(kind === "edit" && pending.from === "clone" ? { diff: git(["diff", "HEAD", "--", rel], { raw: true }).stdout } : {}),
    ...(pending.from === "kept" || pending.replaces ? { kept: pending.file } : {}),
  }
}

// The plan's words for a change an earlier run kept.
const keptNote = (people) => (people.kept === undefined ? "" : people.from === "kept" ? ` The change is the one an earlier run kept at ${people.kept}.` : ` It replaces the change an earlier run kept at ${people.kept}.`)

// How a run ends for the member's roster change: "landed" (it is in), "kept" (a teammate's change conflicted; it stays
// kept for the next run) or "open" (it did not land; it goes back in the clone).
function settlePeople(outcome, held, { git, top, rel, pending, spawnGit, action }) {
  if (pending.edit === null) return outcome
  if (held === "landed") release(pending)
  if (held !== "open") return outcome
  const note = putBack(git, top, rel, pending, spawnGit, action)
  return note === "" ? outcome : { ...outcome, message: `${outcome.message}${note}` }
}

// ── join ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// Who a desk was added for, from the identity line in the commits that added its files: their identities, or none.
function deskOwners(git, desk) {
  const log = git(["log", "--diff-filter=A", "--format=%B", "--", `${desk}/`])
  return [...log.stdout.matchAll(new RegExp(`^${IDENTITY_TRAILER}:[ \\t]*(\\S.*)$`, "gmu"))].map((match) => match[1].trim())
}

// Why `desk`, already on the default branch with no desk-list row, is not this identity's to resume; or null.
function deskClaimProblem(git, desk, identity) {
  const owners = deskOwners(git, desk)
  if (owners.some((owner) => sameIdentity(owner, identity))) return null
  if (owners.length > 0) return `${desk}/ is already on the default branch, added for ${owners[0]}, whose desk-list row has not landed; choose another alias`
  return `${desk}/ is already on the default branch with no desk-list row, and nothing records whose it is; choose another alias`
}

// `current` (a desk file, or undefined when the template has none) with the member's own words added at its end.
function withNote(current, note) {
  if (current === undefined) return `${note}\n`
  const eol = eolOf(current)
  return `${current}${current.endsWith("\n") ? eol : `${eol}${eol}`}${withEol(note, eol)}${eol}`
}

// The member's own words for their desk: `[[desk file, text]]`, or a refusal for a file that cannot be read or is empty.
function readNotes({ about, preferences }) {
  const notes = []
  for (const [flag, file, target] of [["--about", about, "README.md"], ["--preferences", preferences, "AGENTS.md"]]) {
    if (file === undefined) continue
    let text = ""
    try {
      text = toLf(readFileSync(file, "utf8")).replace(/^\uFEFF/u, "").trim()
    } catch {
      text = ""
    }
    if (text === "") return { refused: `${flag} ${file} cannot be read or is empty` }
    // Windows PowerShell 5.1's `>` and Out-File save UTF-16, which reads as UTF-8 with a NUL in every other byte.
    if (text.includes("\0")) return { refused: `${flag} ${file} is not UTF-8 text; write it again as UTF-8 (an agent's own file tool does), then run this again` }
    notes.push([target, text])
  }
  return { notes }
}

/**
 * joinWorkspace({ repo, identity, alias, apply?, about?, preferences? }) -> { state, ... }
 *
 * `about` and `preferences` are Markdown files outside the clone, added to the new desk's README.md (who they are) and
 * AGENTS.md (how they like their agent to work) before its first push. An uncommitted change to the team's roster (the
 * agent's entry for the newcomer) is the only uncommitted change the clone may hold; it lands in the same pull request
 * as the desk-list row, merged three ways with what teammates changed meanwhile (`mergePeople`). A change an earlier
 * run kept (`pendingPeople`) lands the same way. A workspace with no roster file yet gets Crew's starter in that pull
 * request.
 *
 * `state`: "plan", "joined", "member" (the identity already has a row; nothing written), "pr_open" (the desk is pushed
 * and the row waits in an open pull request), "not_crew", "refused" or "failed" (with `stage`; at `people`, a
 * teammate changed the same roster entry first; at `outside`, a symbolic link leads a write outside the clone).
 */
export async function joinWorkspace({ repo, identity, alias, apply = false, about, preferences, spawnGit = spawnSync, gh = personGh(), wait = sleep, now = Date.now }) {
  const refuse = (message) => ({ action: "join", state: "refused", repo, identity, alias, message: `Nothing was written: ${message}.` })
  const status = await crewStatus({ repo, identity, spawnGit })
  if (status.state !== "crew") return { action: "join", ...status }
  if (!validIdentity(identity)) return refuse("an identity is required: the stable account login this member signs in with, with no | or line break")
  // An identity already on the desk list joins nothing; a roster change in the clone is theirs to land with `roster`.
  const memberResult = (row, extra, unlanded) => ({ action: "join", state: "member", repo: status.repo, identity, alias: row.alias, desk: deskOf(row.alias), tooling: status.tooling, message: `${identity} is already on the desk list as ${row.alias}; nothing to add.${extra}${unlanded.edit === null ? "" : ` The change to the team's roster ${status.people.path} has not landed: land it with crew.js roster --apply.`} A Desk session started in this clone writes to ${deskOf(row.alias)}/ while gh is signed in as ${identity}; Desk checks this before it reports the join as done.` })
  if (status.member !== null) {
    const unlanded = pendingPeople(gitIn(status.repo, spawnGit), status.repo, status.people.path)
    return memberResult(status.member, "", unlanded.refused === undefined ? unlanded : { edit: null })
  }
  const problem = aliasProblem(alias)
  if (problem !== null) return refuse(problem)
  const { notes, refused } = readNotes({ about, preferences })
  if (refused !== undefined) return refuse(refused)
  const top = status.repo
  const git = gitIn(top, spawnGit)
  // Who holds what on the desk list now: this identity's row, or another identity's row for the alias.
  const holders = () => {
    const { crew, roster: rows } = crewWorkspace(top)
    if (!crew) throw new Failed("roster", "the default branch on GitHub is no longer a Crew workspace: its desk list and desks/ are gone")
    return { mine: rows.find((row) => row.alias !== "" && sameIdentity(row.identity, identity)), other: rows.find((row) => row.alias === alias && !sameIdentity(row.identity, identity)) }
  }
  const taken = (row) => `the alias ${alias} belongs to ${row.identity}; choose another alias`
  if (holders().other !== undefined) return refuse(taken(holders().other))
  const template = listFiles(path.join(top, ...TEMPLATE.split("/")))
  if (template.length === 0) return refuse(`${TEMPLATE} is missing or empty, so there is no desk to copy; the workspace needs a complete template first`)
  const desk = deskOf(alias)
  const files = template.map((rel) => `${desk}/${rel}`)
  const deskProblem = () => {
    if (!files.every((rel) => exists(top, rel))) return `${desk}/ already exists and does not match the template; it may be someone else's`
    return deskClaimProblem(git, desk, identity)
  }
  const people = status.people.path
  const linked = [people, desk, ROSTER].filter((rel) => leadsOutside(top, rel))
  if (linked.length > 0) return refuse(outsideMessage(linked))
  const resumed = exists(top, desk)
  if (resumed && deskProblem() !== null) return refuse(deskProblem())
  const pending = pendingPeople(git, top, people)
  if (pending.refused !== undefined) return refuse(`this clone ${pending.refused}`)
  // The roster change: the agent's edit, or Crew's starter when the workspace has no roster file yet.
  const change = pending.edit ?? (status.people.exists ? null : { base: null, ours: starterRoster(), eol: "\n" })
  const member = { alias, identity, origin: status.origin }
  const roster = exists(top, ROSTER) ? readFileSync(path.join(top, ...ROSTER.split("/")), "utf8") : null
  const header = markdownTables(roster ?? "").find((table) => table.header.includes("alias") && table.header.includes("identity"))?.header ?? ROSTER_COLUMNS
  const answers = resumed ? [] : notes.map(([target]) => `${desk}/${target}`)
  const result = { action: "join", repo: top, identity, alias, desk, files, answers, row: rosterRow(header, member), people: describePeople(git, people, pending, change), tooling: status.tooling }
  if (!apply) {
    const deskPart = resumed ? `${desk}/ is already in place, so joining adds` : `Joining adds ${desk}/ (${plural(files.length, "file")}) and then`
    const peoplePart = {
      none: ` The team's roster ${people} has no change in this clone, so it will not list ${identity} yet.`,
      starter: ` The team's roster ${people} does not exist yet; it is created from Crew's starter, with no entry for ${identity} yet.`,
      create: ` The team's roster ${people} is created as this clone has it, in the same pull request as the row.`,
      edit: ` The change to the team's roster ${people} lands in the same pull request as the row.`,
    }[result.people.change] + keptNote(result.people)
    const notesPart = notes.length === 0 ? "" : answers.length === 0 ? ` ${desk}/ is already pushed, so --about and --preferences are not added to it again.` : ` What they told us goes into ${answers.join(" and ")}.`
    return { ...result, state: "plan", message: `Plan only: nothing was written. ${deskPart} the desk-list row for ${identity}.${peoplePart}${notesPart} Run again with --apply to make the change.` }
  }
  const toolingNote = status.tooling === null ? "" : ` ${status.tooling.message}`
  const created = new Set()
  let deskPushed = false
  let checkout
  // What becomes of the roster change: see `settlePeople`.
  let held = "open"
  const outcome = await (async () => {
    try {
      if (pending.edit !== null) holdEdit(git, top, people, pending)
      checkout = await prepareCheckout(git, () => connectTo(git, status.origin, { gh, result }), people)
      if (checkout.refused) return refuse(`this clone ${checkout.refused}`)
      if (checkout.mode !== "remote") return refuse("this clone has no origin with a default branch to push the desk to")
      // The clone is now the default branch as it is: someone may have joined, or taken the alias or the desk, meanwhile.
      const now0 = holders()
      if (now0.mine !== undefined) return memberResult(now0.mine, "", pending)
      if (now0.other !== undefined) return refuse(taken(now0.other))
      if (exists(top, desk) && deskProblem() !== null) return refuse(deskProblem())
      deskPushed = exists(top, desk)
      if (!deskPushed) {
        const writeDesk = () => {
          // Rebuilt after a teammate's push: the same desk pushed from this identity's other machine is reused.
          if (exists(top, desk)) {
            const claim = deskProblem()
            if (claim !== null) throw new Failed("desk", claim)
            return null
          }
          const deskFiles = Object.fromEntries(template.map((rel) => [`${desk}/${rel}`, render(readFileSync(path.join(top, ...TEMPLATE.split("/"), ...rel.split("/")), "utf8"), member)]))
          for (const [target, note] of notes) deskFiles[`${desk}/${target}`] = withNote(deskFiles[`${desk}/${target}`], note)
          writeFiles(top, deskFiles, created)
          return [`${desk}/`]
        }
        // The member's own desk: they are its only writer, so it goes straight to the default branch.
        await landByPush({ git, base: checkout.base, write: writeDesk, message: `Crew: add ${alias}'s desk\n\n${IDENTITY_TRAILER}: ${identity}`, created })
        deskPushed = true
      }
      let mine
      const writeRow = () => {
        const now1 = holders()
        if (now1.mine !== undefined) {
          mine = now1.mine
          return null
        }
        if (now1.other !== undefined) throw new Failed("alias", `${taken(now1.other)}. ${desk}/ is pushed and unused`)
        const current = exists(top, ROSTER) ? readFileSync(path.join(top, ...ROSTER.split("/")), "utf8") : null
        writeFiles(top, { [ROSTER]: withRosterRow(current, member) }, created)
        return [ROSTER, ...(change === null ? [] : writePeople(top, people, change, spawnGit, created))]
      }
      const mark = `${IDENTITY_TRAILER}: ${identity}`
      const prefix = `crew/join-${alias}-`
      const reuse = await openPullRequest(checkout.hub, status.origin, { account: result.account, base: checkout.base, branch: new RegExp(`^${escaped(prefix)}[0-9a-z]+$`, "u"), identity, paths: change === null ? [ROSTER] : [ROSTER, people] })
      const message = `Crew: add ${alias} to the team`
      const body = `${message}: the desk-list row${change === null ? "" : " and the team's roster"}.\n\nOpened by Crew's crew.js. It is merged at once: a pull request to a shared path here serializes concurrent writes and is not a review.\n\n${mark}`
      const landed = await landByPullRequest({ git, base: checkout.base, origin: status.origin, write: writeRow, message, body, prefix, stamp: now(), hub: checkout.hub, wait, result, reuse, created })
      if (resumed) result.resumed = true
      if (landed.unchanged) {
        const unused = mine.alias === alias ? "" : ` It joined as ${mine.alias} from another machine meanwhile, so ${desk}/ is unused.`
        return memberResult(mine, unused, pending)
      }
      if (landed.open !== undefined) return openResult(result, landed, checkout.base, `Not joined yet: ${desk}/ is pushed, and `)
      held = "landed"
      const next = `A Desk session started in this clone writes to ${desk}/ while gh is signed in as ${identity}; Desk checks this before it reports the join as done.${toolingNote}`
      if (landed.unfetched !== undefined) return unconfirmedResult(result, landed, "joined", "Joined", next)
      // Read back: the default branch must now hold this identity's row under this alias, and the whole desk.
      const missing = [
        [holders().mine?.alias !== alias, `the desk-list row for ${identity} as ${alias}`, "desk-list row"],
        [!files.every((rel) => exists(top, rel)), `${desk}/`, "desk"],
      ].filter(([gone]) => gone)
      if (missing.length > 0) return notConfirmed(result, checkout.base, missing.map(([, item]) => item), `${identity}'s ${missing.map(([, , plain]) => plain).join(" and ")}`, "Next: run the same join again; it adds only what is missing.")
      result.people.listed = exists(top, people) && listedIn(readFileSync(path.join(top, ...people.split("/")), "utf8"), [alias, identity])
      const listedNote = result.people.listed ? ` The team's roster ${people} lists them.` : ` The team's roster ${people} does not list them yet.`
      return { ...result, state: "joined", commit: landed.commit, message: `Joined: ${identity} is on the desk list as ${alias}, with an own desk at ${desk}/. The desk-list row merged in ${result.pr}.${listedNote} ${next}` }
    } catch (error) {
      if (held === "open" && peopleFailure(git, checkout?.base, error)) held = "kept"
      const pushed = deskPushed && error.stage !== "alias" ? ` ${desk}/ is pushed; run join again to add the desk-list row.` : ""
      return failedResult(result, error, `${pushed}${error.stage === "people" ? peopleNext(people, "join", pending) : ""}`)
    }
  })()
  return settlePeople(outcome, held, { git, top, rel: people, pending, spawnGit, action: "join" })
}

// ── roster ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * updateRoster({ repo, identity, apply? }) -> { state, ... }
 *
 * Lands the clone's uncommitted change to the team's roster, a member's edit (a contact who came up in the work, or
 * their own entry), or the change an earlier run kept, through a pull request merged at once, merged three ways with
 * what teammates changed meanwhile. Only a member on the desk list changes it; a newcomer's entry lands with their
 * join. `state`: "plan", "updated", "unchanged" (nothing to land), "pr_open", "not_crew", "refused" or "failed" (with
 * `stage`; at `people`, a teammate changed the same entry first, and the clone is left on the default branch as it is
 * now; at `outside`, a symbolic link leads the roster outside the clone).
 */
export async function updateRoster({ repo, identity, apply = false, spawnGit = spawnSync, gh = personGh(), wait = sleep, now = Date.now }) {
  const action = "roster"
  const status = await crewStatus({ repo, identity, spawnGit })
  if (status.state !== "crew") return { action, ...status }
  const refuse = (message) => ({ action, state: "refused", repo: status.repo, identity, message: `Nothing was written: ${message}.` })
  if (!validIdentity(identity)) return refuse("an identity is required: the stable account login this member signs in with, with no | or line break")
  if (status.member === null) return refuse(`${identity} is not on the desk list, and the team's roster is changed by a teammate who is; join first with crew:join-crew, which adds the newcomer's own entry`)
  const top = status.repo
  const people = status.people.path
  const { alias } = status.member
  const git = gitIn(top, spawnGit)
  if (leadsOutside(top, people)) return refuse(outsideMessage([people]))
  const pending = pendingPeople(git, top, people)
  if (pending.refused !== undefined) return refuse(`this clone ${pending.refused}`)
  const result = { action, repo: top, identity, alias, people: describePeople(git, people, pending, pending.edit) }
  if (pending.edit === null && committedPeople(git, status.base, people)) return refuse(`this clone ${committedMessage(people, status.base)}`)
  if (pending.edit === null) return { ...result, state: "unchanged", message: `Nothing to land: the team's roster ${people} has no change in this clone, and no earlier run kept one. Edit it first, then run this again.` }
  if (!apply) return { ...result, state: "plan", message: `Plan only: nothing was written. The change to the team's roster ${people} lands through a pull request merged at once.${keptNote(result.people)} Run again with --apply to make the change.` }
  const created = new Set()
  let checkout
  let held = "open"
  const outcome = await (async () => {
    try {
      holdEdit(git, top, people, pending)
      checkout = await prepareCheckout(git, () => connectTo(git, status.origin, { gh, result }), people)
      if (checkout.refused) return refuse(`this clone ${checkout.refused}`)
      if (checkout.mode !== "remote") return refuse("this clone has no origin with a default branch to land the change on")
      const write = () => {
        const written = writePeople(top, people, pending.edit, spawnGit, created)
        return written.length === 0 ? null : written
      }
      const mark = `${IDENTITY_TRAILER}: ${identity}`
      const prefix = `crew/roster-${alias}-`
      const reuse = await openPullRequest(checkout.hub, status.origin, { account: result.account, base: checkout.base, branch: new RegExp(`^${escaped(prefix)}[0-9a-z]+$`, "u"), identity, paths: [people] })
      const message = `Crew: ${alias} updates the team's roster`
      const body = `${message}.\n\nOpened by Crew's crew.js. It is merged at once: a pull request to a shared path here serializes concurrent writes and is not a review.\n\n${mark}`
      const landed = await landByPullRequest({ git, base: checkout.base, origin: status.origin, write, message, body, prefix, stamp: now(), hub: checkout.hub, wait, result, reuse, created })
      if (landed.open !== undefined) return openResult(result, landed, checkout.base, "Not in effect yet: ")
      held = "landed"
      if (landed.unchanged) return { ...result, state: "unchanged", message: `Nothing to land: the team's ${checkout.base} branch already has this change to ${people}.` }
      if (landed.unfetched !== undefined) return unconfirmedResult(result, landed, "updated", "Updated", "Teammates see the change once their copies are up to date.")
      return { ...result, state: "updated", commit: landed.commit, message: `Updated: the change to the team's roster ${people} merged in ${result.pr}.` }
    } catch (error) {
      if (peopleFailure(git, checkout?.base, error)) held = "kept"
      return failedResult(result, error, error.stage === "people" ? peopleNext(people, "roster", pending) : "")
    }
  })()
  return settlePeople(outcome, held, { git, top, rel: people, pending, spawnGit, action: "roster" })
}
