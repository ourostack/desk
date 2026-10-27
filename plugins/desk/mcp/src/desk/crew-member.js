// Who this session's person is in a Crew workspace: the one resolver the tool server's admission, the boot script,
// `crew.js status`, the one-time tidy and session start's person lookup all use, so they can never name different people.
//
// In a Crew workspace (`crewWorkspace(root).crew`), in this order:
//   1. an explicit `--person <alias>` (source `launch-argument`);
//   2. `DESK_PERSON` (source `env:DESK_PERSON`), read only in a Crew workspace, so a user-wide value never changes a personal desk;
//   3. the roster row whose `identity` is the GitHub login this session acts as (source `crew-roster`). `DESK_IDENTITY` names
//      that login explicitly. Otherwise the logins signed in to gh are read from gh's own `hosts.yml`, with no network call:
//      exactly one of them on the roster is the member; none is `not_on_roster`. Only when several signed-in accounts are on
//      the roster, or gh lists none, is GitHub asked (`settleMember`): which of those accounts can push to the workspace's
//      origin, the same per-account choice `crew.js` makes for its pushes, or which login gh acts as (`gh api user`).
// A person is never guessed from a folder, a path or a display name. On a personal desk only `--person` counts.
//
// Dependency-free (`node:` modules and dependency-free Desk modules only): the boot script and `crew.js` run it from the
// installed plugin, where no npm dependency is installed, and the admission worker runs the local half on every resolve.

import * as os from "node:os"
import * as path from "node:path"
import { crewWorkspace } from "./crew-roster.js"
import { ghLogins } from "./gh-logins.js"
import { readRemotes } from "../util/git-config-file.js"

// How long a failed GitHub answer is kept before the next resolution asks again.
const FAILED_ANSWER_MS = 60000
const DEFAULT_TIMEOUT_MS = 10000
const NOT_SEEN = /\(HTTP 40[34]\)/u

const hasText = (value) => typeof value === "string" && value.trim() !== ""
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()
const unique = (values) => values.filter((value, index) => values.findIndex((other) => same(other, value)) === index)

function validAlias(alias) {
  return hasText(alias) && !/[\\/]|\.\./u.test(alias) && alias.trim() !== "." && !path.isAbsolute(alias.trim())
}

/**
 * The person, from what is on this machine, without a network call:
 * `{ crew, person, source, identity, logins, candidates, pending, problem }`.
 * `pending` is `"choose"` (several signed-in accounts are on the roster; `candidates` are their rows, active account
 * first) or `"whoami"` (gh lists no login), and `settleMember` answers it. `problem` is `not_on_roster`,
 * `invalid_alias` or, after settling, `several_accounts`. `readLogins` and `roster` are seams for tests and for callers
 * that already read the roster.
 */
export function localMember({ deskRoot, person = null, env, homeDir = env.HOME || os.homedir(), readLogins = ghLogins, workspace }) {
  const explicit = hasText(person) ? person.trim() : null
  const { crew, roster } = workspace ?? crewWorkspace(deskRoot)
  if (!crew) return { crew: false, person: explicit, source: explicit === null ? null : "launch-argument", identity: null, problem: null }
  if (explicit !== null) return { crew: true, person: explicit, source: "launch-argument", identity: null, problem: null }
  if (hasText(env.DESK_PERSON)) return { crew: true, person: env.DESK_PERSON.trim(), source: "env:DESK_PERSON", identity: null, problem: null }
  const rows = roster.filter((row) => hasText(row.alias) && hasText(row.identity))
  const matching = (logins) => logins.map((login) => rows.find((row) => same(row.identity, login))).filter((row) => row !== undefined)
  if (hasText(env.DESK_IDENTITY)) return fromRows(matching([env.DESK_IDENTITY.trim()]), [env.DESK_IDENTITY.trim()])
  let logins = []
  try {
    logins = unique(readLogins({ env, homeDir }).filter(hasText))
  } catch {
    logins = []
  }
  if (logins.length === 0) return { crew: true, person: null, source: null, identity: null, logins, pending: "whoami", problem: null }
  const rowsFound = matching(logins)
  if (rowsFound.length > 1) return { crew: true, person: null, source: null, identity: null, logins, candidates: rowsFound, pending: "choose", problem: null }
  return fromRows(rowsFound, logins)
}

function fromRows(rows, logins) {
  if (rows.length === 0) return { crew: true, person: null, source: null, identity: null, logins, problem: "not_on_roster" }
  const [row] = rows
  if (!validAlias(row.alias)) return { crew: true, person: null, source: null, identity: row.identity, logins, problem: "invalid_alias" }
  return { crew: true, person: row.alias.trim(), source: "crew-roster", identity: row.identity, logins, problem: null }
}

// The GitHub `<owner>/<name>` of the clone's origin, from its Git config file, or null.
export function originRepository(deskRoot) {
  const url = readRemotes(deskRoot)?.remotes?.origin
  if (!hasText(url)) return null
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github[\w.-]*\/|git@github[\w.-]*:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu.exec(url.trim())
  return match === null ? null : `${match[1]}/${match[2]}`
}

// Answers kept for the life of this process: `<kind>|<root>|<logins>` → { at, value }.
const answers = new Map()

/** Forget every cached GitHub answer (tests). */
export function forgetMemberAnswers() {
  answers.clear()
}

async function remembered(key, now, ask) {
  const held = answers.get(key)
  if (held !== undefined && (held.value.ok || now() - held.at < FAILED_ANSWER_MS)) return held.value
  const value = await ask()
  answers.set(key, { at: now(), value })
  return value
}

// Whether `login` can push to `repo`: true or false from GitHub, or null when GitHub could not be asked.
async function canPush(gh, login, repo, timeoutMs) {
  const token = await gh(["auth", "token", "--hostname", "github.com", "--user", login], { timeoutMs })
  if (token.code !== 0 || !hasText(token.stdout)) return null
  const answer = await gh(["api", `repos/${repo}`, "--jq", ".permissions.push"], { token: token.stdout.trim(), timeoutMs })
  if (answer.code === 0) return answer.stdout.trim() === "true"
  return NOT_SEEN.test(String(answer.stderr)) ? false : null
}

/**
 * The person once the pending GitHub question is answered: the same shape as `localMember`, with `pending` gone. A
 * member that needs no question is returned as it is. GitHub is asked at most once per process for the same question
 * (a failed answer again after a minute); with no answer the result is a problem, never a guess. `gh` is a runner with
 * `ghRunner`'s shape; `now` is for tests.
 */
export async function settleMember(local, { deskRoot, env, gh, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now }) {
  if (local?.pending === undefined) return local
  // Loaded only when GitHub must be asked, so the admission worker's resolve job never loads the factory's GitHub module.
  gh ??= (await import("../factory/flush.js")).ghRunner({ env })
  const { pending, candidates, ...rest } = local
  if (pending === "choose") {
    const repo = originRepository(deskRoot)
    const key = `choose|${deskRoot}|${repo}|${candidates.map((row) => row.identity).join(",")}`
    const answer = repo === null ? { ok: false } : await remembered(key, now, async () => {
      for (const row of candidates) {
        const push = await canPush(gh, row.identity, repo, timeoutMs)
        if (push === true) return { ok: true, row }
      }
      return { ok: false }
    })
    if (answer.ok) return { ...fromRows([answer.row], rest.logins), logins: rest.logins }
    return { ...rest, problem: "several_accounts", candidates: candidates.map((row) => row.identity) }
  }
  const key = `whoami|${hasText(env.GH_TOKEN) || hasText(env.GITHUB_TOKEN) ? "token" : "gh"}`
  const answer = await remembered(key, now, async () => {
    // gh acts as an ambient token when one is set, else as its active account.
    const token = (env.GH_TOKEN || env.GITHUB_TOKEN || "").trim()
    const me = await gh(["api", "user", "--jq", ".login"], { ...(token === "" ? {} : { token }), timeoutMs })
    return me.code === 0 && hasText(me.stdout) ? { ok: true, login: me.stdout.trim() } : { ok: false }
  })
  if (!answer.ok) return { ...rest, problem: "not_on_roster" }
  const { roster } = crewWorkspace(deskRoot)
  const rows = roster.filter((row) => hasText(row.alias) && same(row.identity, answer.login))
  return fromRows(rows, [answer.login])
}

/** `localMember`, then `settleMember`: the person a session in `deskRoot` writes as. */
export async function resolveMember(options) {
  return settleMember(localMember(options), options)
}

/** The one plain message for a Crew workspace session with no person, or null when there is a person. */
export function memberMessage(member) {
  if (!member?.crew || member.person !== null || member.problem === null || member.problem === undefined) return null
  const writable = "so Desk keeps this team workspace read-only in this session"
  const after = "then call desk_status, which checks again"
  if (member.problem === "several_accounts") {
    return `Several GitHub accounts signed in to gh are on this team workspace's roster (${member.candidates.join(", ")}), and GitHub did not say which of them can push to it, ${writable}. To write to your own desk, sign out of gh the account that is not yours here (gh auth logout --user <login>) or set DESK_PERSON to your alias; ${after}.`
  }
  if (member.problem === "invalid_alias") {
    return `This session's GitHub account ${member.identity} is on this team workspace's roster with an alias that is not a valid folder name, ${writable}. Ask the team to fix that row in _meta/desks.md through a pull request; ${after}.`
  }
  const who = member.logins?.length ? `This session's GitHub account (${member.logins.join(", ")}) is` : "No GitHub account signed in to gh is"
  return `${who} not on this team workspace's roster, ${writable}. To write to your own desk, join with crew:join-crew, or sign in to gh as the account you joined with (gh auth login); ${after}.`
}

/** A short label for a member's source, for one-line status text. */
export function memberSourceLabel(member) {
  if (member?.source === "crew-roster") return `crew roster, GitHub account ${member.identity}`
  if (member?.source === "env:DESK_PERSON") return "DESK_PERSON"
  if (member?.source === "launch-argument") return "--person"
  return "authority provider"
}
