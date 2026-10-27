// Who this session's person is in a Crew workspace: the one resolver the tool server's admission, the boot script,
// `crew.js status`, the one-time tidy and session start's person lookup all use, so they can never name different people.
//
// In a Crew workspace (`_meta/crew.json`, or a roster with a named row), in this order:
//   1. an explicit `--person <alias>` (source `launch-argument`);
//   2. `DESK_PERSON` (source `env:DESK_PERSON`), read only in a Crew workspace, so a user-wide value never changes a personal desk;
//   3. the roster row whose `identity` is the GitHub login this session acts as (source `crew-roster`). `DESK_IDENTITY` names
//      that login explicitly. Otherwise the logins signed in to gh are read from gh's own `hosts.yml`, with no network call:
//      exactly one of them on the roster is the member; none is `not_on_roster`; one on several rows is `several_rows`.
//      When several signed-in accounts are on the roster and gh's active account is one of them, GitHub is asked
//      (`settleMember`) which of them can push to the workspace's origin, active account first: the same choice `crew.js`
//      makes for its pushes. When the active account is not one of them, nothing says which member this is
//      (`several_accounts`). When gh lists no login, GitHub is asked which login gh acts as (`gh api user`).
// A person is never guessed from a folder, a path or a display name. On a personal desk only `--person` counts.
//
// Dependency-free (`node:` modules and dependency-free Desk modules only): the boot script and `crew.js` run it from the
// installed plugin, where no npm dependency is installed, and the admission worker runs the local half on every resolve.

import * as os from "node:os"
import * as path from "node:path"
import { crewWorkspace, isCrewWorkspace } from "./crew-roster.js"
import { ghLogins } from "./gh-logins.js"
import { envValue } from "../util/env-value.js"
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
 * `crew` is true only in a real Crew workspace (`isCrewWorkspace`): a personal desk with a track folder named `desks`
 * is not one. `logins` come active account first (`gh-logins.js`). `pending` is `"choose"` (gh's active account and
 * other signed-in accounts are on the roster; `candidates` are their rows, active account first, the order `crew.js`
 * tries them for its pushes) or `"whoami"` (gh lists no login), and `settleMember` answers it. `problem` is
 * `not_on_roster`, `invalid_alias`, `several_rows` (one account on more than one roster row), `several_accounts`
 * (several signed-in accounts on the roster and gh's active account is not one of them, or GitHub did not say which
 * can push) or, after settling, `github_unreachable`. Windows variable names are matched without regard to case.
 * `readLogins` and `workspace` are seams for tests and for callers that already read the roster.
 */
export function localMember({ deskRoot, person = null, env, platform = process.platform, homeDir = envValue(env, "HOME", platform) || os.homedir(), readLogins = ghLogins, workspace }) {
  const explicit = hasText(person) ? person.trim() : null
  const { crew: rosterSaysCrew, roster } = workspace ?? crewWorkspace(deskRoot)
  const crew = rosterSaysCrew && (roster.some((row) => hasText(row.alias)) || isCrewWorkspace(deskRoot))
  if (!crew) return { crew: false, person: explicit, source: explicit === null ? null : "launch-argument", identity: null, problem: null }
  if (explicit !== null) return { crew: true, person: explicit, source: "launch-argument", identity: null, problem: null }
  const named = envValue(env, "DESK_PERSON", platform)
  if (hasText(named)) return { crew: true, person: named.trim(), source: "env:DESK_PERSON", identity: null, problem: null }
  const rows = roster.filter((row) => hasText(row.alias) && hasText(row.identity))
  const rowsOf = (login) => rows.filter((row) => same(row.identity, login))
  const identity = envValue(env, "DESK_IDENTITY", platform)
  if (hasText(identity)) return fromRows(rowsOf(identity), [identity.trim()])
  let logins = []
  try {
    logins = unique(readLogins({ env, homeDir }).filter(hasText))
  } catch {
    logins = []
  }
  if (logins.length === 0) return { crew: true, person: null, source: null, identity: null, logins, pending: "whoami", problem: null }
  const found = logins.map(rowsOf).filter((matches) => matches.length > 0)
  const doubled = found.find((matches) => matches.length > 1)
  if (doubled !== undefined || found.length < 2) return fromRows(doubled ?? found[0] ?? [], logins)
  const candidates = found.map(([row]) => row)
  // gh's active account (first) is on the roster: GitHub says which of the accounts can push, active first, as crew.js
  // chooses. Otherwise nothing on this machine says which of several members this session is.
  if (!same(candidates[0].identity, logins[0])) return { crew: true, person: null, source: null, identity: null, logins, candidates: candidates.map((row) => row.identity), problem: "several_accounts" }
  return { crew: true, person: null, source: null, identity: null, logins, candidates, pending: "choose", problem: null }
}

function fromRows(rows, logins) {
  if (rows.length === 0) return { crew: true, person: null, source: null, identity: null, logins, problem: "not_on_roster" }
  const [row] = rows
  if (rows.length > 1) return { crew: true, person: null, source: null, identity: row.identity, logins, aliases: rows.map((each) => each.alias.trim()), problem: "several_rows" }
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
      let unanswered = false
      for (const row of candidates) {
        const push = await canPush(gh, row.identity, repo, timeoutMs)
        if (push === true) return { ok: true, row }
        unanswered ||= push === null
      }
      return { ok: false, unreachable: unanswered }
    })
    if (answer.ok) return { ...fromRows([answer.row], rest.logins), logins: rest.logins }
    // `unreachable`: GitHub gave no answer for at least one account, so the cause is the network, not the account choice.
    return { ...rest, problem: "several_accounts", candidates: candidates.map((row) => row.identity), ...(answer.unreachable ? { unreachable: true } : {}) }
  }
  const ambient = (envValue(env, "GH_TOKEN") || envValue(env, "GITHUB_TOKEN") || "").trim()
  const key = `whoami|${ambient === "" ? "gh" : "token"}`
  const answer = await remembered(key, now, async () => {
    // gh acts as an ambient token when one is set, else as its active account.
    const token = ambient
    const me = await gh(["api", "user", "--jq", ".login"], { ...(token === "" ? {} : { token }), timeoutMs })
    return me.code === 0 && hasText(me.stdout) ? { ok: true, login: me.stdout.trim() } : { ok: false }
  })
  if (!answer.ok) return { ...rest, problem: "github_unreachable" }
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
  if (member.problem === "several_accounts" && member.unreachable === true) {
    return `Desk could not reach GitHub to ask which of the GitHub accounts signed in to gh and on this team workspace's desk list (${member.candidates.join(", ")}) is yours, ${writable}. To write to your own desk, check that GitHub can be reached; ${after}. If GitHub answers and Desk still cannot tell, switch gh to your own account (gh auth switch --user <your login>).`
  }
  if (member.problem === "several_accounts") {
    return `Several GitHub accounts signed in to gh are on this team workspace's desk list (${member.candidates.join(", ")}), and Desk cannot tell which one is yours: gh's active account is not one of them, or GitHub did not say which of them can push to it, ${writable}. To write to your own desk, switch gh to your own account (gh auth switch --user <your login>), or start this one session with DESK_PERSON set to your alias; ${after}.`
  }
  if (member.problem === "several_rows") {
    return `This session's GitHub account ${member.identity} is on more than one row of this team workspace's desk list (${member.aliases.join(", ")}), ${writable}. Ask the team to remove the extra row from _meta/desks.md through a pull request; ${after}.`
  }
  if (member.problem === "github_unreachable") {
    return `gh lists no signed-in account here and Desk could not ask GitHub which account gh acts as, ${writable}. To write to your own desk, sign in to gh as the account you joined with (gh auth login) and check that GitHub can be reached; ${after}.`
  }
  if (member.problem === "invalid_alias") {
    return `This session's GitHub account ${member.identity} is on this team workspace's desk list with an alias that is not a valid folder name, ${writable}. Ask the team to fix that row in _meta/desks.md through a pull request; ${after}.`
  }
  return `This session's GitHub account (${member.logins.join(", ")}) is not on this team workspace's desk list, ${writable}. To write to your own desk, join with crew:join-crew, or sign in to gh as the account you joined with (gh auth login); ${after}.`
}

/** A short label for a member's source, for one-line status text. */
export function memberSourceLabel(member) {
  if (member?.source === "crew-roster") return `desk list, GitHub account ${member.identity}`
  if (member?.source === "env:DESK_PERSON") return "DESK_PERSON"
  if (member?.source === "launch-argument") return "--person"
  return "authority provider"
}
