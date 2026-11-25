// Desk's direct GitHub REST calls (the delivery gate, the drains and relays) use a token from `gh auth token`, so the gh shim never sees
// them. Where MS Desk's gh shim keeps a spend ledger on this machine, they join it: each answer GitHub gives is one line in the shim's
// `calls.log` (same fields as the shim writes), and a read is held under the same floor, so `gh-work quota` accounts for the whole hour.
// Nothing here makes a ledger: with no ledger folder (no shim on this host), MS_DESK_QUOTA=off, or a node:test run that did not name its
// own MS_DESK_QUOTA_DIR, every call passes through untouched. Credentials never reach the ledger: it holds the time, account kind, route
// without its query, session label, repository and how the call went.
//
// The ledger format and the floor rule are the shim's (scripts/gh-route-shim.sh and bin/gh-quota.mjs in MS Desk): calls.log is
// `time \t kind \t "api <route>" \t session \t owner/repo \t mode`, mode `apiget` (a read GitHub answered), `etag` (a 304, free), `write`
// (any other method, GraphQL included) or `refused` (held back here); `<kind>.rate` is "remaining reset limit fetched" and `<kind>.hold` is
// "until \t why". Reads below MS_DESK_GH_FLOOR (500) are refused for the session spending most, and for any read that is not on the merge
// path; merge-path reads run on to MS_DESK_GH_MERGE_FLOOR (half the floor). Writes always run.

import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import * as path from "node:path"
import { looksLikeNodeTestRunner } from "./test-state-guard.js"

const API = "https://api.github.com"
const TAIL_BYTES = 2 * 1024 * 1024
const NOT_SPENT = new Set(["hit", "etag", "refused", "repeat", "token"])
const MERGE_PATH = /^\/?repos\/[^/]+\/[^/?]+(?:\?.*)?$|^\/?repos\/[^/]+\/[^/]+\/(?:pulls|commits|compare|git\/refs?|branches|check-runs|check-suites|actions\/runs|actions\/workflows\/[^/]+\/runs)(?:[/?].*)?$/u

/** A read held back under the quota floor: `message` says when to try again. */
export class SpendHeld extends Error {
  constructor(message) {
    super(message)
    this.name = "SpendHeld"
    this.code = "spend_held"
  }
}

const count = (value, fallback) => (/^\d+$/u.test(String(value ?? "")) ? Number(value) : fallback)

/** The shim's ledger folder when this host has one and may use it, else null. */
export function ledgerDir(env = process.env) {
  if (env.MS_DESK_QUOTA === "off" || env.MS_DESK_ROUTE === "off") return null
  if (!env.MS_DESK_QUOTA_DIR && looksLikeNodeTestRunner(env)) return null
  const base = env.XDG_STATE_HOME || (env.HOME ? path.join(env.HOME, ".local", "state") : "")
  const dir = env.MS_DESK_QUOTA_DIR || (base ? path.join(base, "ms-desk", "gh-quota") : "")
  try {
    return dir && statSync(dir).isDirectory() ? dir : null
  } catch {
    return null
  }
}

/** The signed-in github.com login gh calls active, read from its hosts.yml the way the shim does; "" when unknown. */
export function activeLogin(env = process.env) {
  const home = env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, "gh") : env.HOME ? path.join(env.HOME, ".config", "gh") : "")
  try {
    return /^ {4}user:\s*(\S+)/mu.exec(readFileSync(path.join(home, "hosts.yml"), "utf8"))?.[1] ?? ""
  } catch {
    return ""
  }
}

/** The shim's account kind for a login (a `_microsoft` login is the work account), or for an owner when no login is known. */
export function kindOf({ login, owner, env = process.env }) {
  if (login) return /_microsoft$/iu.test(login) ? "work" : "personal"
  const name = String(owner ?? "").toLowerCase()
  if (name === "") return ""
  const listed = String(env.MS_DESK_WORK_OWNERS ?? "").toLowerCase().split(/[\s,]+/u)
  return name === "microsoft" || /[-_]microsoft$/u.test(name) || listed.includes(name) ? "work" : "personal"
}

/** What a call to https://api.github.com is: its route without the query, whether it is a read, and its repository. */
export function describeCall(url, method = "GET") {
  if (!String(url).startsWith(`${API}/`)) return null
  const full = String(url).slice(API.length)
  const route = full.split("?")[0].replace(/^\/+/u, "")
  const graphql = route === "graphql"
  return { full, route, repo: /^repos\/([^/]+\/[^/]+)/u.exec(route)?.[1] ?? "", read: String(method).toUpperCase() === "GET" && !graphql }
}

function tailRows(dir) {
  try {
    const fd = openSync(path.join(dir, "calls.log"), "r")
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      const lines = buffer.toString("utf8").split("\n")
      if (length < size) lines.shift()
      return lines.filter(Boolean).map((line) => line.split("\t"))
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
}

const clock = (epoch) => new Date(epoch * 1000).toISOString().slice(11, 16)

/** Why a read must wait under the floor or an account hold, or null when it may run. The shim's rule (see the header). */
export function heldReason({ dir, kind, session, call, env = process.env, now = Math.floor(Date.now() / 1000) }) {
  try {
    const [until, ...why] = readFileSync(path.join(dir, `${kind}.hold`), "utf8").trim().split("\t")
    if (count(until, 0) > now) return `Wait until ${clock(count(until, 0))}Z, then repeat: the ${kind} account is on hold (${why.join("\t") || "no reason given"}), so Desk's own GitHub reads are held back to keep its REST quota for a service that needs it`
  } catch {
    // No hold.
  }
  let remaining = null
  let reset = null
  let limit = null
  try {
    ;[remaining, reset, limit] = readFileSync(path.join(dir, `${kind}.rate`), "utf8").trim().split(/\s+/u).map((value) => (/^\d+$/u.test(value) ? Number(value) : null))
  } catch {
    return null
  }
  const floor = count(env.MS_DESK_GH_FLOOR, 500)
  if (remaining === null || reset === null || reset <= now || remaining >= floor) return null
  const merge = Math.min(count(env.MS_DESK_GH_MERGE_FLOOR, Math.floor(floor / 2)), floor)
  const spent = new Map()
  for (const row of tailRows(dir)) {
    if (row[1] !== kind || !(Number(row[0]) >= now - 3600) || NOT_SPENT.has(row[5])) continue
    spent.set(row[3], (spent.get(row[3]) ?? 0) + (row[5] === "pollcalls" ? count(row[6], 0) : 1))
  }
  const mine = spent.get(session) ?? 0
  const top = mine > 0 && mine >= Math.max(0, ...spent.values())
  if (!top && MERGE_PATH.test(call.route) && remaining >= merge) return null
  const left = `the ${kind} account has ${remaining} of ${limit ?? "?"} REST calls left, under the floor of ${floor} kept for production`
  const wait = `Wait until ${clock(reset)}Z (${Math.floor((reset - now) / 60) + 1} min), then repeat`
  return top ? `${wait}: ${left}, and this session sent ${mine} calls in the last hour, the most of any session, so its reads are held back first` : `${wait}: ${left}, so Desk's own reads are held back (merge-path reads still run down to ${merge})`
}

/**
 * `fetch` that records each answer from https://api.github.com in the shim's ledger and holds reads under its floor (throwing `SpendHeld`
 * before anything is sent). `login()` is the account the token belongs to ("" when unknown, then the repository's owner decides the kind);
 * `label` names this process in the ledger when the host gives no session id. Passes straight through when this host has no ledger. A
 * call that gets no answer is not recorded: nothing says it reached GitHub.
 */
export function ledgeredFetch(fetchFn, { env = process.env, login = () => "", label = "desk", now = () => Date.now(), pid = process.pid } = {}) {
  const session = env.COPILOT_AGENT_SESSION_ID || env.AGENCY_SESSION_ID || `${label}-${pid}`
  return async (url, init) => {
    const call = describeCall(url, init?.method)
    const dir = call === null ? null : ledgerDir(env)
    const kind = dir === null ? "" : kindOf({ login: login(), owner: call.repo.split("/")[0], env })
    if (kind === "") return fetchFn(url, init)
    const log = (mode) => {
      try {
        appendFileSync(path.join(dir, "calls.log"), `${Math.floor(now() / 1000)}\t${kind}\tapi ${call.route.slice(0, 160)}\t${session}\t${call.repo}\t${mode}\n`)
      } catch {
        // A ledger that cannot be written must never stop the call.
      }
    }
    if (call.read) {
      const held = heldReason({ dir, kind, session, call, env, now: Math.floor(now() / 1000) })
      if (held !== null) {
        log("refused")
        throw new SpendHeld(held)
      }
    }
    const response = await fetchFn(url, init)
    log(response.status === 304 ? "etag" : call.read ? "apiget" : "write")
    return response
  }
}
