// Desk's direct GitHub REST calls (the delivery gate, the drains and relays) use an account's token directly, so MS Desk's gh shim never
// sees them. Where the shim keeps a spend ledger on this machine, they join it: each send is a line in the shim's `calls.log` (same fields
// the shim writes), and a read is held under the same floor. This covers Desk's own direct calls only: a `gh` that does not resolve to the
// shim, or a token used elsewhere on the host, still spends the account's quota unseen. Nothing here makes a ledger: with no ledger folder
// (no shim on this host), MS_DESK_QUOTA=off, or a node:test run that did not name its own MS_DESK_QUOTA_DIR, every call passes through
// untouched. Credentials never reach the ledger: it holds the time, account kind, route without its query, session label, repository and
// how the call went.
//
// The ledger format and the floor rule are the shim's (scripts/gh-route-shim.sh and bin/gh-quota.mjs in MS Desk): calls.log is
// `time \t kind \t "api <route>" \t session \t owner/repo \t mode`; mode is `apiget` (a read GitHub answered), `etag` (a 304, free), `write`
// (any other method, GraphQL included), `refused` (held back here) or `unknown` (sent, but no answer came back: a timeout or a dropped
// connection, which may or may not have been charged; the shim's report counts it as sent, the upper bound). `<kind>.rate` is
// "remaining reset limit fetched" for the REST `core` pool, refreshed from `GET /rate_limit` (free) at most once a minute; here it is also
// refreshed from the `x-ratelimit-*` headers of every answer, so the floor sees a burst before the minute is up. Writes take a lock file and
// only ever tighten (a later window replaces, within one window the lower remaining wins), so concurrent processes cannot raise it. `<kind>.hold` is
// "until \t why". Reads below MS_DESK_GH_FLOOR (500) are refused for the session spending most, and for any read that is not on the merge
// path; merge-path reads run on to MS_DESK_GH_MERGE_FLOOR (half the floor). Writes and GraphQL (its own pool) always run, and GraphQL is
// not counted in the REST tally.

import { createHash } from "node:crypto"
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { looksLikeNodeTestRunner } from "./test-state-guard.js"

const API = "https://api.github.com"
const TAIL_BYTES = 2 * 1024 * 1024
const NOT_SPENT = new Set(["hit", "etag", "refused", "repeat", "token"])
const RATE_MAX_AGE = 60
const MERGE_PATH = /^\/?repos\/[^/]+\/[^/?]+(?:\?.*)?$|^\/?repos\/[^/]+\/[^/]+\/(?:pulls|commits|compare|git\/refs?|branches|check-runs|check-suites|actions\/runs|actions\/workflows\/[^/]+\/runs)(?:[/?].*)?$/u

/** A read held back under the quota floor: `message` says when to try again. */
export class SpendHeld extends Error {
  constructor(message) {
    super(message)
    this.name = "SpendHeld"
    this.code = "spend_held"
  }
}

let unrecorded = 0
let warned = false

/** How many sends this process could not write to the ledger (an unwritable folder), so an attribution report can say it is incomplete. */
export const unrecordedSends = () => unrecorded

let unattributed = 0

/** How many ledger rows this process wrote for a token whose account could not be told (kind `unresolved`): the shim's report groups only work and personal, so these never show in it. */
export const unattributedSends = () => unattributed

const count = (value, fallback) => (/^\d+$/u.test(String(value ?? "")) ? Number(value) : fallback)

/** The shim's ledger folder when this host has one and may use it, else null. */
export function ledgerDir(env, underTest = looksLikeNodeTestRunner(env)) {
  if (env.MS_DESK_QUOTA === "off" || env.MS_DESK_ROUTE === "off") return null
  if (!env.MS_DESK_QUOTA_DIR && underTest) return null
  const base = env.XDG_STATE_HOME || (env.HOME ? path.join(env.HOME, ".local", "state") : "")
  const dir = env.MS_DESK_QUOTA_DIR || (base ? path.join(base, "ms-desk", "gh-quota") : "")
  try {
    return dir && statSync(dir).isDirectory() ? dir : null
  } catch {
    return null
  }
}

/** The signed-in github.com login gh calls active, read from its hosts.yml the way the shim does; "" when unknown. */
export function activeLogin(env) {
  const home = env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, "gh") : env.HOME ? path.join(env.HOME, ".config", "gh") : "")
  try {
    return /^ {4}user:\s*(\S+)/mu.exec(readFileSync(path.join(home, "hosts.yml"), "utf8"))?.[1] ?? ""
  } catch {
    return ""
  }
}

/** The shim's account kind for a login: a `_microsoft` login is the work account. */
const kindOf = (login) => (/_microsoft$/iu.test(login) ? "work" : "personal")

/** What a call to https://api.github.com is: its route without the query, whether it is a REST read, whether it is GraphQL, and its repository. */
function describeCall(url, method = "GET") {
  if (!String(url).startsWith(`${API}/`)) return null
  const route = String(url).slice(API.length).split("?")[0].replace(/^\/+/u, "")
  const graphql = route === "graphql"
  return { route, graphql, repo: /^repos\/([^/]+\/[^/]+)/u.exec(route)?.[1] ?? "", read: String(method).toUpperCase() === "GET" && !graphql }
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

function readRate(dir, kind) {
  try {
    const [remaining, reset, limit, fetched] = readFileSync(path.join(dir, `${kind}.rate`), "utf8").trim().split(/\s+/u).map((value) => (/^\d+$/u.test(value) ? Number(value) : null))
    return { remaining, reset, limit, fetched: fetched ?? 0 }
  } catch {
    return { remaining: null, reset: null, limit: null, fetched: 0 }
  }
}

const LOCK_STALE_MS = 10_000
const LOCK_TRIES = 200
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// One writer at a time per rate file, across processes: an exclusive lock file, broken when its owner is long gone. False when the lock
// could not be had, in which case the write is skipped (the next answer or refresh carries the numbers).
function locked(file, write) {
  const lock = `${file}.lock`
  for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
    try {
      closeSync(openSync(lock, "wx"))
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock)
      } catch {
        // Released between the two calls.
      }
      pause(5)
      continue
    }
    try {
      write()
    } finally {
      unlinkSync(lock)
    }
    return true
  }
  return false
}

// Fold one observation of the REST pool into the stored numbers. A later window replaces the stored one, an earlier one is ignored, and
// within one window the lower remaining wins together with the ceiling of the answer that gave it, so answers arriving out of order, from
// a free refresh or from a concurrent process only ever tighten the picture.
function mergeRate(dir, kind, { remaining, reset, limit }, now) {
  const file = path.join(dir, `${kind}.rate`)
  return locked(file, () => {
    const had = readRate(dir, kind)
    if (had.reset !== null && had.reset > reset) return
    const keep = had.reset === reset && had.remaining !== null && had.remaining < remaining
    const next = keep ? { remaining: had.remaining, limit: had.limit ?? limit } : { remaining, limit }
    const temp = `${file}.${process.pid}`
    writeFileSync(temp, `${next.remaining} ${reset} ${next.limit} ${now}\n`)
    renameSync(temp, file)
  })
}

// The REST pool's numbers from an answer's headers.
function noteRate(dir, kind, response, now) {
  try {
    const header = (name) => response.headers?.get?.(name) ?? null
    const resource = header("x-ratelimit-resource")
    if (resource !== null && resource !== "core") return
    const [remaining, limit, reset] = ["x-ratelimit-remaining", "x-ratelimit-limit", "x-ratelimit-reset"].map((name) => (/^\d+$/u.test(String(header(name))) ? Number(header(name)) : null))
    if (remaining === null || limit === null || reset === null) return
    mergeRate(dir, kind, { remaining, reset, limit }, now)
  } catch {
    // The headers are a refinement of the stored numbers; the next read refreshes them.
  }
}

const refreshing = new Map()

// The shim's own refresh: `GET /rate_limit` (free) when the stored numbers are missing or a minute old.
async function refreshRate({ dir, kind, fetchFn, init, now }) {
  const had = readRate(dir, kind)
  if (had.remaining !== null && now - had.fetched < RATE_MAX_AGE) return
  const key = `${dir}\0${kind}`
  if (!refreshing.has(key)) {
    refreshing.set(
      key,
      (async () => {
        try {
          const response = await fetchFn(`${API}/rate_limit`, { headers: init?.headers, signal: init?.signal })
          const core = response.status === 200 ? JSON.parse(await response.text())?.resources?.core : null
          if (core && [core.remaining, core.reset, core.limit].every((value) => Number.isInteger(value))) mergeRate(dir, kind, core, now)
        } catch {
          // Without fresh numbers the stored ones (or none) decide.
        } finally {
          refreshing.delete(key)
        }
      })(),
    )
  }
  await refreshing.get(key)
}

/** Why a read must wait under the floor or an account hold, or null when it may run. The shim's rule (see the header). */
function heldReason({ dir, kind, pool, session, call, env, now }) {
  try {
    const [until, ...why] = readFileSync(path.join(dir, `${pool}.hold`), "utf8").trim().split("\t")
    if (count(until, 0) > now) return `Wait until ${clock(count(until, 0))}Z, then repeat: the ${kind} account is on hold (${why.join("\t") || "no reason given"}), so Desk's own GitHub reads are held back to keep its REST quota for a service that needs it`
  } catch {
    // No hold.
  }
  const { remaining, reset, limit } = readRate(dir, pool)
  const floor = count(env.MS_DESK_GH_FLOOR, 500)
  if (remaining === null || reset === null || reset <= now || remaining >= floor) return null
  const merge = Math.min(count(env.MS_DESK_GH_MERGE_FLOOR, Math.floor(floor / 2)), floor)
  const spent = new Map()
  for (const row of tailRows(dir)) {
    if (row[1] !== kind || !(Number(row[0]) >= now - 3600) || NOT_SPENT.has(row[5]) || row[2] === "api graphql") continue
    spent.set(row[3], (spent.get(row[3]) ?? 0) + (row[5] === "pollcalls" ? count(row[6], 0) : 1))
  }
  const mine = spent.get(session) ?? 0
  const top = mine > 0 && mine >= Math.max(0, ...spent.values())
  if (!top && MERGE_PATH.test(call.route) && remaining >= merge) return null
  const left = `the ${kind} account has ${remaining} of ${limit ?? "?"} REST calls left, under the floor of ${floor} kept for production`
  const wait = `Wait until ${clock(reset)}Z (${Math.floor((reset - now) / 60) + 1} min), then repeat`
  return top ? `${wait}: ${left}, and this session sent ${mine} calls in the last hour, the most of any session, so its reads are held back first` : `${wait}: ${left}, so Desk's own reads are held back (merge-path reads still run down to ${merge})`
}

const bearer = (init) => {
  const header = init?.headers?.Authorization ?? init?.headers?.authorization
  return typeof header === "string" && /^bearer\s+\S/iu.test(header) ? header.replace(/^bearer\s+/iu, "").trim() : ""
}

const identities = new Map()
const asking = new Map()

// Which account a token belongs to: the login the caller knows, else what GitHub says for `GET /user`, once per token per process even
// when several calls start together (one asks, the rest wait for it), kept by the token's digest, never the token. An answer that names
// no account (a 403 for an app's installation token, say) is kept as "". A lookup that got no answer (`transient`: a dropped connection,
// a 5xx or a 429) is not kept, so the next call asks again. `probe` is how the lookup went for the call that sent it ("apiget" when
// answered, "unknown" when it got no answer; null for a call that sent none), `id` the token's digest.
async function loginOf({ token, hint, fetchFn, init }) {
  if (hint) return { login: hint, probe: null, transient: false, id: "" }
  const id = createHash("sha256").update(token).digest("hex")
  if (identities.has(id)) return { login: identities.get(id), probe: null, transient: false, id }
  if (asking.has(id)) return { ...(await asking.get(id)), probe: null }
  const ask = (async () => {
    try {
      const response = await fetchFn(`${API}/user`, { headers: init?.headers, signal: init?.signal })
      const login = response.status === 200 ? JSON.parse(await response.text())?.login : ""
      const found = typeof login === "string" ? login : ""
      if (response.status >= 500 || response.status === 429) return { login: "", probe: "unknown", transient: true, id }
      identities.set(id, found)
      return { login: found, probe: "apiget", transient: false, id }
    } catch {
      return { login: "", probe: "unknown", transient: true, id }
    } finally {
      asking.delete(id)
    }
  })()
  asking.set(id, ask)
  return ask
}

/**
 * `fetch` that records each send to https://api.github.com in the shim's ledger and holds reads under its floor (throwing `SpendHeld`
 * before anything is sent). Only requests that carry a token are accounted: they spend an account's quota. `login()` is the account the
 * token belongs to when the caller knows it, else GitHub is asked once per token; the repository's owner is never a stand-in for it, and a
 * token whose account GitHub names none for (an installation token) is recorded as kind `unresolved`, which the shim's report does not group (`unattributedSends()` counts them), and floored on the numbers its own answers carry; one whose lookup got no answer holds the read, as nothing says which floor applies. `label` names this process in the ledger when the
 * host gives no session id. A send that gets no answer is recorded as `unknown`. A ledger that cannot be written never stops the call: it
 * raises a process warning (DESK_SPEND_UNRECORDED) and counts in `unrecordedSends()`.
 */
export function ledgeredFetch(fetchFn, { env, login = () => "", label = "desk", now = () => Date.now(), pid = process.pid }) {
  const session = env.COPILOT_AGENT_SESSION_ID || env.AGENCY_SESSION_ID || `${label}-${pid}`
  return async (url, init) => {
    const call = describeCall(url, init?.method)
    const token = call === null ? "" : bearer(init)
    const dir = token === "" ? null : ledgerDir(env)
    if (dir === null) return fetchFn(url, init)
    const { login: account, probe, transient, id } = await loginOf({ token, hint: login(), fetchFn, init })
    const kind = account === "" ? "unresolved" : kindOf(account)
    const pool = account === "" ? `unresolved-${id.slice(0, 12)}` : kind
    const at = () => Math.floor(now() / 1000)
    const log = (mode, route = call.route, repo = call.repo) => {
      try {
        if (kind === "unresolved") unattributed += 1
        appendFileSync(path.join(dir, "calls.log"), `${at()}\t${kind}\tapi ${route.slice(0, 160)}\t${session}\t${repo}\t${mode}\n`)
      } catch (error) {
        unrecorded += 1
        if (!warned) {
          warned = true
          process.emitWarning(`Fix the permissions of the gh spend ledger folder ${dir} (${error.code}), then repeat: Desk's GitHub calls are being sent without being recorded, so the spend report is incomplete`, { code: "DESK_SPEND_UNRECORDED" })
        }
      }
    }
    if (probe !== null) log(probe, "user", "")
    if (call.read) {
      if (transient) {
        log("refused")
        throw new SpendHeld("Repeat once GitHub answers `GET /user`: Desk could not tell which account this token belongs to, so its read was held back rather than counted against a guessed quota floor")
      }
      await refreshRate({ dir, kind: pool, fetchFn, init, now: at() })
      const held = heldReason({ dir, kind, pool, session, call, env, now: at() })
      if (held !== null) {
        log("refused")
        throw new SpendHeld(held)
      }
    }
    let response
    try {
      response = await fetchFn(url, init)
    } catch (error) {
      log("unknown")
      throw error
    }
    if (!call.graphql) noteRate(dir, pool, response, at())
    log(response.status === 304 ? "etag" : call.read ? "apiget" : "write")
    return response
  }
}
