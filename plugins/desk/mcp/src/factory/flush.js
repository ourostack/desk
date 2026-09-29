// Delivery: the local outbox becomes one intake pull request per machine per
// store, and a finished job's facts are pushed on their way (finalize).
//
// `flush(env, { store, runner, deadlineMs })` is the only code that sends
// anything to a factory store. It never sends local facts: every file is
// turned into its published form by `toPublished` (no who, no when, public
// references only), checked by the public gate `validatePublishedBytes`, and
// only those bytes leave the machine. The steps:
//
//   1. Take `flush.lock` in the protected state folder (a lock older than ten
//      minutes is abandoned and replaced); a live lock returns `locked`.
//   2. Read the store's consent and account. Release the quarantine an older
//      Desk wrote when the store refused its facts as
//      `private_plugins_missing` (`releaseRefusedPluginNames`): this Desk
//      always writes `refs.private.plugins`, so those files go again.
//      Transform every outbox file that is not quarantined. The visibility of each referenced repository, and
//      of the desk's own GitHub remote, comes from the seven-day cache or
//      `GET /repos/{owner}/{repo}` with the account's token (`private: false`
//      is public, `private: true` private, 403 or 404 unknown). A token that
//      cannot see a repository in its own scope (a fine-grained token, or an
//      organization's SSO enforcement) still answers 403 or 404 for a
//      repository that is genuinely public, so either is retried once with a
//      plain, unauthenticated HTTP request — never through `gh`, whose own
//      stored login answers for whichever account is signed in there instead
//      of for no one — before it is accepted as unknown; only the exact
//      answer that comes back — public, private or still unknown — is
//      cached. A network failure, a 5xx or a rate limit, on either try, is
//      never cached as unknown: it stops the flush outright (`offline`,
//      `unexpected` or `rate_limited`), so only a definitive answer ever
//      reaches the seven-day cache. A desk that is
//      not known to be private publishes machine-keyed job IDs without
//      timing, keyed by the protected 32-byte machine secret. A file the
//      transform refuses or the public gate rejects is quarantined with a
//      stable code and never sent. When nothing changed since the last
//      delivery, the flush ends here without any network call.
//   3. Read the store. With push permission the intake branch lives in the
//      store; otherwise in the account's default-branch-only fork, created on
//      first use and brought up to date with `merge-upstream` (a fork that is
//      not ready yet returns `fork_pending`).
//   4. Read closed intake PRs of this machine's branch, newest first and page
//      by page, down to the last PR already read (a number kept in status,
//      moved only once every page has been read). When the store's automation
//      (`github-actions[bot]`) commented a first line `factory-rejected:
//      <code>`, every file of that PR, all pages of up to 500, is quarantined
//      with that code: the comment names no file, so good files in a rejected
//      PR are quarantined too; with several codes, the first data code. When
//      every code is `merge_conflict` or `unexpected_merge`, the branch was
//      stale, not the facts bad: nothing is quarantined, the files go out
//      again on a branch rebuilt from the current default branch, and the
//      result is `intake_stale_retried` with the number of stale PRs read.
//   5. A file whose exact published blob already sits at `facts/<name>` on
//      the store's default branch is marked delivered.
//
//   Accepted waste labels (`pendingLabels`) go the same way: each becomes
//   `labels/<job>/<session id>.json` through `toPublishedLabels`, with the
//   job keyed exactly as its session's facts are, and passes
//   `validateLabelsBytes`, else it is quarantined under its local key. A
//   rejected PR quarantines its labels with its facts; a stale one sends them
//   again. Labels go only with their session's facts, on the default branch
//   or in the same batch, since the store refuses labels without facts and
//   that refusal would quarantine the whole PR. Labels whose session's facts
//   are quarantined, by this flush or an earlier one, can therefore never go:
//   they are quarantined too (`holdLabels`), as `facts_quarantined` naming
//   those facts, instead of waiting forever.
//   6. The rest (at most 500 files and 24 MiB per flush) becomes one tree on
//      top of the store's default branch and one commit titled `Factory
//      intake`, and the task-owned branch `intake/<intake_id>` is
//      force-updated to exactly that commit (left alone when it already holds
//      the same tree on the same base). The open PR for that head is reused,
//      or one is opened titled `Factory intake` whose body is only the file
//      count.
//
// Every step's result is one stable `FlushCode`. The account token comes from
// `gh auth token --user <account>`, lives only in memory and reaches `gh` only
// through the runner's `token` option, which the real runner passes as
// `GH_TOKEN`; it is never an argument, a status value, a thrown message or a
// file. Runner output is parsed as data: store trees, PR lists and comments
// are matched against exact shapes and never executed. `deadlineMs` bounds the
// whole flush; it is checked before and after every runner call, and a call
// still running at the deadline is abandoned.
//
// `finalize(env, { job, runner })` re-derives the job's sessions (from the
// jobs index) plus every marker updated since the job's finalize request,
// letting a session that is still writing go quiet for five seconds, flushes
// every store holding the job's files, and removes the request only once all
// of those files are delivered or quarantined. Any failure keeps the request
// for the next end of turn or session start; a request older than 30 days is
// dropped.
//
// `flushConsented(env)` is what the session-start hook runs detached: one
// sweep, then a flush of every store with `contribute: true`, all within one
// deadline. It never throws.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { spawn as spawnProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { promises as fsp } from "node:fs"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { normalizeRemote } from "./binding.js"
import { readDeskRemote } from "./desk-repo.js"
import { deriveFile, sweep as sweepMarkers } from "./derive-run.js"
import {
  clearFinalize,
  factoryStateRoot,
  gitBlobSha,
  holdLabels,
  listFinalizeRequests,
  listMarkers,
  markDelivered,
  pendingFiles,
  pendingLabels,
  quarantine,
  readConsent,
  readJobsIndex,
  readMachineSecret,
  readStatus,
  readVisibilityCache,
  releaseRefusedPluginNames,
  writeStatus,
  writeVisibilityCache,
} from "./outbox.js"
import { refreshAndon } from "./andon-watch.js"
import { validateLabelsBytes } from "./label-schema.js"
import { serializePublished, toPublished, toPublishedLabels } from "./publish.js"
import { validatePublishedBytes } from "./published-schema.js"
import { PATTERNS, isPlainObject } from "./schema.js"

/** Every result `flush` can return. */
export const FLUSH_CODES = Object.freeze([
  "delivered_pr_open", "intake_stale_retried", "nothing_pending", "not_opted_in", "no_account", "gh_missing", "gh_too_old", "auth_failed",
  "store_missing", "account_cannot_deliver", "fork_pending", "rate_limited", "offline", "locked", "deadline", "unexpected",
])

export const INTAKE_TITLE = "Factory intake"
export const REJECTION_AUTHOR = "github-actions[bot]"
export const MIN_GH_VERSION = Object.freeze([2, 40, 0])
export const DEFAULT_DEADLINE_MS = 120000
export const FINALIZE_QUIET_MS = 5000

const LOCK_STALE_MS = 10 * 60 * 1000
const MAX_FILES = 500
const MAX_CLOSED_PRS = 300
// Refusals that mean the intake branch was stale, not that its facts are bad: the files stay pending, and the next batch is rebuilt on the store's current default branch.
const STALE_INTAKE_CODES = new Set(["merge_conflict", "unexpected_merge"])
const MAX_COMMENTS = 300
const MAX_BYTES = 24 * 1024 * 1024
const MAX_OUTPUT = 64 * 1024 * 1024
const FINALIZE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const INTAKE_ID = /^[0-9a-f]{16}$/u
const SHA = /^[0-9a-f]{40}$/u
const BRANCH = /^[A-Za-z0-9._-]{1,100}$/u
const REJECTED = /^factory-rejected: ([a-z][a-z0-9_]{0,63})$/u
// A PR is open for delivery after either result.
const DELIVERED_OPEN = new Set(["delivered_pr_open", "intake_stale_retried"])
const FACTS_NAME = /^(?:claude-code|copilot-cli)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u
const FACTS_PATH = /^facts\/((?:claude-code|copilot-cli)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json)$/u
const HOSTS = Object.freeze(["claude-code", "copilot-cli"])
const HTTP_STATUS = /\(HTTP (\d{3})\)/u
const RATE_LIMIT = /rate limit/iu
const OFFLINE = /error connecting to|could not resolve|no such host|dial tcp|connection refused|connection reset|network is unreachable|i\/o timeout|TLS handshake timeout|timed out/iu
const GITHUB_REMOTE = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})$/u
const TIMEOUT = Symbol("timeout")
// Everything `pendingFiles` is asked about in the listing pass: bytes no
// delivered record can match, so every outbox file that is not quarantined
// is listed.
const LIST_ALL = Buffer.alloc(0)

class Stop extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

const stop = (code) => {
  throw new Stop(code)
}

// Candidate-controlled answers are data: anything that is not the expected shape reads as empty or stops the flush.
const list = (value) => (Array.isArray(value) ? value : [])
const requireSha = (value) => (typeof value === "string" && SHA.test(value) ? value : stop("unexpected"))

// ---------------------------------------------------------------------------
// The real runner.
// ---------------------------------------------------------------------------

/**
 * `ghRunner({ spawn, env }) -> runner(args, { token, input, timeoutMs })`:
 * runs `gh <args>` and resolves `{ code, stdout, stderr }`, or `{ code: null,
 * stdout, stderr, spawnError }` when `gh` could not start, or `{ code: null,
 * stdout, stderr, timedOut: true }` after `timeoutMs`. Ambient tokens are
 * removed from the child's environment; `token`, when given, is set as
 * `GH_TOKEN` and nowhere else. Prompts and update checks are off.
 */
export function ghRunner({ spawn = spawnProcess, env = process.env, maxOutput = MAX_OUTPUT } = {}) {
  return (args, { token, input, timeoutMs = DEFAULT_DEADLINE_MS } = {}) => new Promise((resolve) => {
    const childEnv = { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" }
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete childEnv[name]
    if (typeof token === "string" && token !== "") childEnv.GH_TOKEN = token
    const stdout = []
    const stderr = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const text = (chunks) => Buffer.concat(chunks).toString("utf8")
    const child = spawn("gh", args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ code: null, stdout: text(stdout), stderr: text(stderr), timedOut: true })
    }, timeoutMs)
    const collect = (into) => (chunk) => {
      size += chunk.length
      if (size <= maxOutput) into.push(Buffer.from(chunk))
    }
    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.on("error", (error) => finish({ code: null, stdout: "", stderr: "", spawnError: error.code ?? "spawn_failed" }))
    child.on("close", (code) => finish({ code, stdout: text(stdout), stderr: text(stderr) }))
    child.stdin.on("error", () => {})
    child.stdin.end(input ?? "")
  })
}

/**
 * `anonymousGithub({ fetch }) -> (repo, { timeoutMs }) -> Promise<{ status, json, headers } | { networkError: true }>`:
 * asks `GET https://api.github.com/repos/{owner}/{repo}` with a `User-Agent` and an `Accept` header and
 * nothing else — no `Authorization` header, no cookie, no ambient credential of any kind. This never goes
 * through `gh`: on a machine signed in to `gh`, unsetting `GH_TOKEN` and its relatives still leaves `gh`
 * free to fall back to its own stored login (`gh auth login`), which answers for whichever account happens
 * to be signed in there — the same restricted account on a single-account machine, or an arbitrary one on
 * a multi-account machine — never for no one. A plain HTTP request has no such fallback. A network failure
 * or an abort at `timeoutMs` is reported as `{ networkError: true }`, never thrown.
 */
export function anonymousGithub({ fetch: fetchImpl = globalThis.fetch } = {}) {
  return async (repo, { timeoutMs = DEFAULT_DEADLINE_MS } = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}`, {
        method: "GET",
        headers: { "User-Agent": "desk-factory", Accept: "application/vnd.github+json" },
        signal: controller.signal,
      })
      let json = null
      try {
        json = await response.json()
      } catch {
        // An error body is informational only.
      }
      return { status: response.status, json, headers: response.headers }
    } catch {
      return { networkError: true }
    } finally {
      clearTimeout(timer)
    }
  }
}

// ---------------------------------------------------------------------------
// The lock.
// ---------------------------------------------------------------------------

async function acquireLock(root) {
  const file = path.join(root, "flush.lock")
  const token = randomBytes(16).toString("hex")
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(file, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), token }))
      } finally {
        await handle.close()
      }
      return { file, token }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      // Staleness comes from the file's own time, never its content.
      const stat = await fsp.stat(file).catch(() => null)
      if (stat !== null && Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return null
      // Another flush may have replaced the stale lock since it was read: remove only the same file.
      const again = await fsp.stat(file).catch(() => null)
      if (stat !== null && (again === null || again.ino !== stat.ino || again.mtimeMs !== stat.mtimeMs)) return null
      await fsp.unlink(file).catch(() => {})
    }
  }
  return null
}

async function releaseLock({ file, token }) {
  try {
    if (JSON.parse(await fsp.readFile(file, "utf8")).token === token) await fsp.unlink(file)
  } catch {
    // Gone or replaced: never remove another owner's lock.
  }
}

// ---------------------------------------------------------------------------
// Talking to GitHub through the runner.
// ---------------------------------------------------------------------------

function parseJson(text) {
  if (text.trim() === "") return null
  try {
    return JSON.parse(text)
  } catch {
    return stop("unexpected")
  }
}

function createClient({ runner, deadline, now, anonymousLookup = anonymousGithub() }) {
  const state = { token: null }

  async function call(args, { token, input } = {}) {
    const remaining = deadline - now()
    if (remaining <= 0) stop("deadline")
    let timer
    let result
    try {
      result = await Promise.race([
        Promise.resolve().then(() => runner(args, { token: token ?? undefined, input, timeoutMs: remaining })),
        new Promise((resolve) => { timer = setTimeout(resolve, remaining, TIMEOUT) }),
      ])
    } catch {
      stop("unexpected")
    } finally {
      clearTimeout(timer)
    }
    if (result === TIMEOUT || now() >= deadline) stop("deadline")
    if (!isPlainObject(result)) stop("unexpected")
    return result
  }

  async function session(account) {
    if (state.token !== null) return
    const version = await call(["--version"])
    if (version.spawnError === "ENOENT" || version.code === 127) stop("gh_missing")
    if (version.code !== 0) stop("unexpected")
    const match = /gh version (\d+)\.(\d+)\.(\d+)/u.exec(String(version.stdout))
    if (match === null || compareVersion(match.slice(1).map(Number), MIN_GH_VERSION) < 0) stop("gh_too_old")
    const auth = await call(["auth", "token", "--user", account])
    const token = auth.code === 0 ? String(auth.stdout).trim() : ""
    if (token === "") stop("auth_failed")
    state.token = token
  }

  /** `{ status, json }` for a 2xx answer or an HTTP error the caller may expect; every other failure stops the flush. */
  async function api(method, route, body) {
    const args = ["api", "--method", method, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", route]
    if (body !== undefined) args.push("--input", "-")
    const result = await call(args, { token: state.token, input: body === undefined ? undefined : JSON.stringify(body) })
    const stdout = String(result.stdout ?? "")
    const stderr = String(result.stderr ?? "")
    if (result.code === 0) return { status: 200, json: parseJson(stdout) }
    if (result.spawnError === "ENOENT") stop("gh_missing")
    const status = Number(HTTP_STATUS.exec(stderr)?.[1] ?? 0)
    if (status === 429 || RATE_LIMIT.test(stderr)) stop("rate_limited")
    if (status === 401) stop("auth_failed")
    if (status === 0) stop(result.timedOut === true || OFFLINE.test(stderr) ? "offline" : "unexpected")
    let json = null
    try {
      json = JSON.parse(stdout)
    } catch {
      // An error body is informational only.
    }
    return { status, json }
  }

  /**
   * `{ status, json }` for a 200, 403 or 404 answer to an unauthenticated
   * `GET /repos/{owner}/{repo}`, through `anonymousLookup` (`anonymousGithub`
   * in production; a fake in tests) rather than `gh`. A rate limit hit by
   * this try, a network failure, or any other status stops the flush
   * outright, exactly as an authenticated call would.
   */
  async function anonymousRepo(repo) {
    const remaining = deadline - now()
    if (remaining <= 0) stop("deadline")
    let timer
    let result
    try {
      result = await Promise.race([
        Promise.resolve().then(() => anonymousLookup(repo, { timeoutMs: remaining })),
        new Promise((resolve) => { timer = setTimeout(resolve, remaining, TIMEOUT) }),
      ])
    } catch {
      stop("unexpected")
    } finally {
      clearTimeout(timer)
    }
    if (result === TIMEOUT || now() >= deadline) stop("deadline")
    if (!isPlainObject(result)) stop("unexpected")
    if (result.networkError === true) stop("offline")
    const { status, json, headers } = result
    if (status === 429 || (status === 403 && isRateLimitedAnswer(json, headers))) stop("rate_limited")
    if (status === 200 || status === 403 || status === 404) return { status, json }
    stop("unexpected")
  }

  async function need(method, route, body) {
    const answer = await api(method, route, body)
    if (answer.status !== 200) stop("unexpected")
    return answer.json
  }

  return { call, session, api, anonymousRepo, need }
}

// GitHub answers a rate-limited anonymous request with 403 (never 429, which is reserved for a
// secondary/abuse limit) and either an empty `x-ratelimit-remaining` budget or a message naming the limit.
const isRateLimitedAnswer = (json, headers) => headers?.get?.("x-ratelimit-remaining") === "0" || RATE_LIMIT.test(String(json?.message ?? ""))

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

const isRepo = (value) => typeof value === "string" && PATTERNS.prRepo.test(value) && !/(?:^|\/)\.\.?$/u.test(value)
const sameRepo = (left, right) => typeof left === "string" && left.toLowerCase() === right.toLowerCase()

// ---------------------------------------------------------------------------
// Transform: local facts to published bytes, with visibility.
// ---------------------------------------------------------------------------

// `readDeskRemote` answers a non-empty URL or `null`; only a GitHub remote has a visibility to ask about.
const githubRepoOfRemote = (remote) => (remote === null ? null : GITHUB_REMOTE.exec(normalizeRemote(remote))?.[1] ?? null)

async function deskRepositories(env, { deadline, now }) {
  const byName = new Map()
  const remotes = new Map()
  for (const marker of await listMarkers(env)) {
    const root = marker.desk_root
    if (root === null) continue
    if (!remotes.has(root)) {
      let remote
      try {
        remote = readDeskRemote({ deskRoot: root, timeoutMs: 5000, deadline, clock: now })
      } catch {
        stop("deadline")
      }
      remotes.set(root, githubRepoOfRemote(remote))
    }
    byName.set(`${marker.host}-${marker.session_id}.json`, remotes.get(root))
  }
  return byName
}

function referencedRepos(facts) {
  const repos = []
  // An outbox file of an older schema may lack `refs`; the transform then refuses it.
  for (const refs of [facts?.refs?.prs, facts?.refs?.commits]) {
    for (const ref of list(refs)) if (isRepo(ref?.repo)) repos.push(ref.repo)
  }
  // A plugin's install source decides whether a public store may name it.
  for (const plugin of list(facts?.plugins)) if (isRepo(plugin?.source)) repos.push(plugin.source)
  return repos
}

async function resolveVisibility(env, client, account, repos, nowIso) {
  const cache = await readVisibilityCache(env, { now: nowIso })
  const known = new Map(Object.entries(cache).map(([repo, entry]) => [repo.toLowerCase(), entry.visibility]))
  const patch = {}
  for (const repo of [...new Set(repos.map((name) => name.toLowerCase()))].sort()) {
    if (known.has(repo)) continue
    await client.session(account)
    let answer = await client.api("GET", `repos/${repo}`)
    // The account's own token can 403 or 404 a repository that is genuinely public: a fine-grained token
    // scoped away from it, or an organization's SSO enforcement withholding it from this token alone. A
    // rate-limited 403 never reaches here — `api` already stops the flush for that. Since neither remaining
    // reason follows a plain, unauthenticated request, one more try with no token at all — never through
    // `gh`, whose own stored login would answer for an arbitrary signed-in account instead of for no one —
    // tells a repository truly private or gone (still 403 or 404) from one only this account cannot see (now 200).
    if (answer.status === 403 || answer.status === 404) answer = await client.anonymousRepo(repo)
    let visibility
    if (answer.status === 200 && answer.json?.private === false) visibility = "public"
    else if (answer.status === 200 && answer.json?.private === true) visibility = "private"
    else if (answer.status === 200 || answer.status === 403 || answer.status === 404) visibility = "unknown"
    else stop("unexpected")
    known.set(repo, visibility)
    patch[repo] = { visibility, checked_at: nowIso() }
  }
  if (Object.keys(patch).length > 0) await writeVisibilityCache(env, patch)
  return known
}

function publishOne(local, name, { transform, known, desk, store, secret }) {
  if (`${local?.session?.host}-${local?.session?.id}.json` !== name) return { reason: "invalid" }
  let out
  try {
    out = transform(local, {
      visibility: (repo) => known.get(repo.toLowerCase()) ?? "unknown",
      // Every GitHub desk remote was resolved with the references; anything else is unknown.
      deskVisibility: desk ? known.get(desk.toLowerCase()) : "unknown",
      // The store was resolved with them too; an unknown store is treated as public.
      storeVisibility: known.get(store.toLowerCase()) ?? "unknown",
      machineSecret: secret,
    })
  } catch {
    return { reason: "invalid" }
  }
  if (out.published === null) return { reason: out.reason }
  const bytes = Buffer.from(serializePublished(out.published), "utf8")
  const checked = validatePublishedBytes(bytes)
  if (!checked.ok) return { reason: checked.errors[0].code }
  return { bytes }
}

// The facts file names a labels file's session can have, one per host.
// A local labels key; `pendingLabels` lists only keys of this shape.
const LABELS_KEY = /^labels\/([0-9a-f]{32})\/(.+)\.json$/u
const factsNamesOf = (session) => HOSTS.map((host) => `${host}-${session}.json`)

// A local labels file as the store receives it: the job keyed exactly as its
// facts are (the desk remote of the session's marker decides), then the
// labels gate.
function publishLabelsOne(local, key, { known, desks, secret }) {
  if (`labels/${local?.job}/${local?.session}.json` !== key) return { reason: "invalid" }
  const desk = factsNamesOf(local.session).map((name) => desks.get(name)).find((repo) => typeof repo === "string")
  let out
  try {
    out = toPublishedLabels(local, { deskVisibility: desk === undefined ? "unknown" : known.get(desk.toLowerCase()), machineSecret: secret })
  } catch {
    return { reason: "invalid" }
  }
  const bytes = Buffer.from(serializePublished(out.published), "utf8")
  const checked = validateLabelsBytes(bytes)
  if (!checked.ok) return { reason: checked.errors[0].code }
  return { path: out.path, bytes }
}

// ---------------------------------------------------------------------------
// Store side.
// ---------------------------------------------------------------------------

// A GitHub login with `_` belongs to an Enterprise Managed User: personal logins may hold only letters, digits and hyphens,
// and a managed login is the handle, `_` and the enterprise's short code. A managed account cannot fork or open pull
// requests on repositories outside its enterprise.
const MANAGED_LOGIN = /_/u

/**
 * How `account` can open an intake pull request on a store it read as `info` (`GET /repos/{store}` with its token):
 * `"direct"` with push permission, `"fork"` through its own fork, or why it cannot: `"forking_disabled"` or
 * `"managed_account"`.
 */
export function deliveryRoute(account, info) {
  if (info?.permissions?.push === true) return "direct"
  if (info?.allow_forking === false) return "forking_disabled"
  if (MANAGED_LOGIN.test(account)) return "managed_account"
  return "fork"
}

async function resolveTarget(client, { store, account, info }) {
  const branch = info.default_branch
  const route = deliveryRoute(account, info)
  if (route === "direct") return { repo: store, owner: store.split("/")[0], branch }
  if (route !== "fork") stop("account_cannot_deliver")
  const repoName = store.split("/")[1]
  let fork = null
  const existing = await client.api("GET", `repos/${account}/${repoName}`)
  if (existing.status === 200 && existing.json?.fork === true && sameRepo(existing.json?.parent?.full_name, store)) fork = existing.json.full_name
  else if (existing.status !== 200 && existing.status !== 404) stop("unexpected")
  if (fork === null) fork = (await client.need("POST", `repos/${store}/forks`, { default_branch_only: true }))?.full_name
  if (!isRepo(fork)) stop("unexpected")
  const ready = await client.api("GET", `repos/${fork}/git/ref/heads/${branch}`)
  if (ready.status === 404 || ready.status === 409) stop("fork_pending")
  if (ready.status !== 200) stop("unexpected")
  await client.need("POST", `repos/${fork}/merge-upstream`, { branch })
  return { repo: fork, owner: fork.split("/")[0], branch }
}

/**
 * Every item of a paged GitHub list, `perPage` at a time, until a short page or
 * `maxItems`. `stopAt(item)` ends the listing at the first item it accepts
 * (that item excluded). A page that fails stops the flush, so a caller that
 * records progress only after this returns never records a partial read.
 */
async function readPages(client, route, { perPage, maxItems, stopAt = () => false }) {
  const items = []
  for (let page = 1; items.length < maxItems; page += 1) {
    const answer = list(await client.need("GET", `${route}${route.includes("?") ? "&" : "?"}per_page=${perPage}&page=${page}`))
    for (const item of answer) {
      if (stopAt(item)) return items
      items.push(item)
    }
    if (answer.length < perPage) break
  }
  return items.slice(0, maxItems)
}

async function readRejections(env, client, { store, head, through, labelKeys }) {
  const rejected = new Set()
  let stale = 0
  let highest = through
  // Newest first; PR numbers grow with creation, so the listing stops at the first PR already read.
  const closed = await readPages(client, `repos/${store}/pulls?state=closed&head=${encodeURIComponent(head.label)}&sort=created&direction=desc`, {
    perPage: 30, maxItems: MAX_CLOSED_PRS, stopAt: (pr) => Number.isSafeInteger(pr?.number) && pr.number <= through,
  })
  for (const pr of closed) {
    if (!isPlainObject(pr) || !Number.isSafeInteger(pr.number) || pr.head?.ref !== head.ref) continue
    highest = Math.max(highest, pr.number)
    if (pr.merged_at !== null && pr.merged_at !== undefined) continue
    const comments = await readPages(client, `repos/${store}/issues/${pr.number}/comments`, { perPage: 100, maxItems: MAX_COMMENTS })
    // The automation's comment starts with a `factory-rejected: <code>` line and may carry one such line per code.
    let codes = []
    for (const comment of comments) {
      if (comment?.user?.login !== REJECTION_AUTHOR || typeof comment.body !== "string") continue
      const lines = comment.body.split(/\r?\n/u)
      if (!REJECTED.test(lines[0])) continue
      for (const line of lines) {
        const match = REJECTED.exec(line)
        if (match === null) break
        codes.push(match[1])
      }
      break
    }
    if (codes.length === 0) continue
    // Stale only when every code says so; any data code rejects the files, and quarantine names the first one.
    const code = codes.find((candidate) => !STALE_INTAKE_CODES.has(candidate))
    if (code === undefined) {
      stale += 1
      continue
    }
    // A batch holds up to MAX_FILES files; GitHub pages them 100 at a time.
    for (const file of await readPages(client, `repos/${store}/pulls/${pr.number}/files`, { perPage: 100, maxItems: MAX_FILES })) {
      // A labels file is known by its published path; only labels still waiting here can be named back to their local key.
      const name = FACTS_PATH.exec(String(file?.filename))?.[1] ?? labelKeys.get(String(file?.filename))
      if (name === undefined) continue
      await quarantine(env, store, name, code, SHA.test(String(file.sha)) ? { blob: file.sha } : {})
      rejected.add(name)
    }
  }
  return { rejected, stale, through: highest }
}

function treeEntries(json) {
  const entries = new Map()
  for (const entry of list(json?.tree)) {
    if (!isPlainObject(entry) || typeof entry.path !== "string" || typeof entry.type !== "string" || typeof entry.sha !== "string") continue
    entries.set(entry.path, { type: entry.type, sha: entry.sha })
  }
  return entries
}

async function factsOnBranch(client, repo, treeSha) {
  const facts = treeEntries(await client.need("GET", `repos/${repo}/git/trees/${treeSha}`)).get("facts")
  if (facts?.type !== "tree") return new Map()
  const blobs = new Map()
  for (const [name, entry] of treeEntries(await client.need("GET", `repos/${repo}/git/trees/${requireSha(facts.sha)}`))) {
    if (entry.type === "blob" && FACTS_NAME.test(name)) blobs.set(name, entry.sha)
  }
  return blobs
}

/** The blob SHA at each `labels/<job>/<session>.json` of `paths` in the tree, reading only the jobs asked about. */
async function labelsOnBranch(client, repo, treeSha, paths) {
  const blobs = new Map()
  if (paths.length === 0) return blobs
  const labels = treeEntries(await client.need("GET", `repos/${repo}/git/trees/${treeSha}`)).get("labels")
  if (labels?.type !== "tree") return blobs
  const jobs = treeEntries(await client.need("GET", `repos/${repo}/git/trees/${requireSha(labels.sha)}`))
  for (const job of [...new Set(paths.map((item) => item.split("/")[1]))].sort()) {
    const entry = jobs.get(job)
    if (entry?.type !== "tree") continue
    for (const [name, blob] of treeEntries(await client.need("GET", `repos/${repo}/git/trees/${requireSha(entry.sha)}`))) blobs.set(`labels/${job}/${name}`, blob.sha)
  }
  return blobs
}

function takeBatch(remaining, { maxFiles, maxBytes }) {
  const batch = []
  let bytes = 0
  for (const item of remaining) {
    if (batch.length >= maxFiles || (batch.length > 0 && bytes + item.bytes.length > maxBytes)) break
    batch.push(item)
    bytes += item.bytes.length
  }
  return batch
}

async function pushBatch(client, { target, branch, base, batch }) {
  const created = await client.need("POST", `repos/${target.repo}/git/trees`, {
    base_tree: base.tree,
    tree: batch.map((item) => ({ path: item.path, mode: "100644", type: "blob", content: item.bytes.toString("utf8") })),
  })
  const tree = requireSha(created?.sha)
  // The tree must hold exactly the bytes that were checked.
  const landed = await factsOnBranch(client, target.repo, tree)
  const landedLabels = await labelsOnBranch(client, target.repo, tree, batch.filter((item) => item.labels).map((item) => item.path))
  for (const item of batch) if ((item.labels ? landedLabels.get(item.path) : landed.get(item.name)) !== item.sha) stop("unexpected")
  const current = await client.api("GET", `repos/${target.repo}/git/ref/heads/${branch}`)
  if (current.status !== 200 && current.status !== 404) stop("unexpected")
  const headSha = current.status === 200 ? requireSha(current.json?.object?.sha) : null
  if (headSha !== null) {
    const head = await client.need("GET", `repos/${target.repo}/git/commits/${headSha}`)
    const parents = list(head?.parents).map((parent) => parent?.sha)
    if (head?.tree?.sha === tree && parents.length === 1 && parents[0] === base.sha) return headSha
  }
  const commit = requireSha((await client.need("POST", `repos/${target.repo}/git/commits`, { message: INTAKE_TITLE, tree, parents: [base.sha] }))?.sha)
  const moved = headSha === null
    ? await client.need("POST", `repos/${target.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit })
    : await client.need("PATCH", `repos/${target.repo}/git/refs/heads/${branch}`, { sha: commit, force: true })
  if (moved?.object?.sha !== commit) stop("unexpected")
  return commit
}

async function openPr(client, { store, head, base, count }) {
  const body = String(count)
  const open = await client.need("GET", `repos/${store}/pulls?state=open&head=${encodeURIComponent(head.label)}&per_page=10`)
  const existing = list(open).find((pr) => isPlainObject(pr) && Number.isSafeInteger(pr.number) && pr.head?.ref === head.ref)
  let pr = existing
  if (pr === undefined) {
    pr = await client.need("POST", `repos/${store}/pulls`, { title: INTAKE_TITLE, head: head.label, base, body, maintainer_can_modify: false })
  } else if (pr.body !== body) {
    await client.need("PATCH", `repos/${store}/pulls/${pr.number}`, { body })
  }
  if (!Number.isSafeInteger(pr?.number) || typeof pr.html_url !== "string") stop("unexpected")
  return { number: pr.number, url: pr.html_url }
}

// ---------------------------------------------------------------------------
// The flush.
// ---------------------------------------------------------------------------

async function deliver(env, context) {
  const { store, client, now, deadline, transform, maxFiles, maxBytes, progress } = context
  const nowIso = () => new Date(now()).toISOString()
  const record = (await readConsent(env)).stores[store]
  if (record?.contribute !== true) return { result: "not_opted_in" }
  if (typeof record.account !== "string" || record.account === "") return { result: "no_account" }
  if (!INTAKE_ID.test(record.intake_id ?? "")) stop("unexpected")
  const { account } = record

  // A store refused an older Desk's facts for naming every plugin; this Desk publishes them with `refs.private.plugins`, so they go again.
  await releaseRefusedPluginNames(env, store)
  const candidates = await pendingFiles(env, store, { publishedBytesFor: () => LIST_ALL })
  const labelCandidates = await pendingLabels(env, store, { publishedBytesFor: () => LIST_ALL })
  if (candidates.length === 0 && labelCandidates.length === 0) return { result: "nothing_pending" }

  // `pendingFiles` already quarantined every file that does not parse, and `pendingLabels` lists only labels that parse.
  const parsed = candidates.map(({ name, localBytes }) => ({ name, local: JSON.parse(localBytes.toString("utf8")) }))
  const parsedLabels = labelCandidates.map(({ name, localBytes }) => ({ key: name, local: JSON.parse(localBytes.toString("utf8")) }))
  const desks = await deskRepositories(env, { deadline, now })
  const repos = parsed.flatMap(({ local }) => referencedRepos(local))
  // Only a store known not to be public may name a plugin from a private or unknown source.
  if (parsed.some(({ local }) => list(local?.plugins).length > 0)) repos.push(store)
  for (const { name } of parsed) if (desks.get(name)) repos.push(desks.get(name))
  for (const { local } of parsedLabels) for (const name of factsNamesOf(local?.session)) if (desks.get(name)) repos.push(desks.get(name))
  const known = await resolveVisibility(env, client, account, repos, nowIso)
  const secret = await readMachineSecret(env)

  const bytesByName = new Map()
  for (const { name, local } of parsed) {
    const out = publishOne(local, name, { transform, known, desk: desks.get(name), store, secret })
    if (out.bytes) bytesByName.set(name, out.bytes)
    else await quarantine(env, store, name, out.reason)
  }
  const labelsByKey = new Map()
  for (const { key, local } of parsedLabels) {
    const out = publishLabelsOne(local, key, { known, desks, secret })
    if (out.bytes) labelsByKey.set(key, out)
    else await quarantine(env, store, key, out.reason)
  }
  // Every file without published bytes was just quarantined, so the listings below never ask about one.
  const factsPending = (await pendingFiles(env, store, { publishedBytesFor: (facts) => bytesByName.get(`${facts.session.host}-${facts.session.id}.json`) }))
    .map(({ name }) => ({ name, path: `facts/${name}`, bytes: bytesByName.get(name), sha: gitBlobSha(bytesByName.get(name)) }))
  const labelsPending = (await pendingLabels(env, store, { publishedBytesFor: (labels) => labelsByKey.get(`labels/${labels.job}/${labels.session}.json`).bytes }))
    .map(({ name }) => {
      const { path: published, bytes } = labelsByKey.get(name)
      const [, job, session] = LABELS_KEY.exec(name)
      return { name, path: published, bytes, sha: gitBlobSha(bytes), labels: true, job, session }
    })
  // Labels whose facts are quarantined never go; `holdLabels` quarantines them instead. Checked again after rejections, which may quarantine facts.
  const withoutHeld = async (items) => {
    const kept = []
    for (const item of items) if (!item.labels || (await holdLabels(env, store, { job: item.job, session: item.session })) === null) kept.push(item)
    return kept
  }
  let pending = await withoutHeld([...factsPending, ...labelsPending])
  if (pending.length === 0) return { result: "nothing_pending" }
  progress.pending = pending.map((item) => item.name)

  await client.session(account)
  const infoAnswer = await client.api("GET", `repos/${store}`)
  if (infoAnswer.status === 404) return { result: "store_missing" }
  if (infoAnswer.status !== 200 || !isPlainObject(infoAnswer.json) || !BRANCH.test(infoAnswer.json.default_branch ?? "")) stop("unexpected")
  const target = await resolveTarget(client, { store, account, info: infoAnswer.json })
  const branch = `intake/${record.intake_id}`
  const head = { ref: branch, label: `${target.owner}:${branch}` }

  const through = (await readStatus(env)).last_flush?.[store]?.rejections_through
  const labelKeys = new Map(labelsPending.map((item) => [item.path, item.name]))
  const rejections = await readRejections(env, client, { store, head, through: Number.isSafeInteger(through) ? through : 0, labelKeys })
  progress.rejectionsThrough = rejections.through
  pending = await withoutHeld(pending.filter((item) => !rejections.rejected.has(item.name)))

  const main = await client.need("GET", `repos/${store}/branches/${target.branch}`)
  const base = { sha: requireSha(main?.commit?.sha), tree: requireSha(main?.commit?.commit?.tree?.sha) }
  const onMain = await factsOnBranch(client, store, base.tree)
  const labelsOnMain = await labelsOnBranch(client, store, base.tree, pending.filter((item) => item.labels).map((item) => item.path))
  const remaining = []
  for (const item of pending) {
    if ((item.labels ? labelsOnMain.get(item.path) : onMain.get(item.name)) === item.sha) await markDelivered(env, store, { name: item.name, publishedBlobSha: item.sha })
    else remaining.push(item)
  }
  progress.pending = remaining.map((item) => item.name)
  if (remaining.length === 0) return { result: "nothing_pending" }

  // Facts go first. Labels go only with their session's facts, on the default branch or in the same batch: the store's gate refuses labels without facts, and that refusal would quarantine every file of the PR.
  const taken = takeBatch(remaining, { maxFiles, maxBytes })
  const factsReady = new Set([...onMain.keys(), ...taken.filter((item) => !item.labels).map((item) => item.name)])
  const batch = taken.filter((item) => !item.labels || factsNamesOf(item.session).some((name) => factsReady.has(name)))
  if (batch.length === 0) return { result: "nothing_pending" }
  await pushBatch(client, { target, branch, base, batch })
  const pr = await openPr(client, { store, head, base: target.branch, count: batch.length })
  // A stale refusal is not a delivery failure, but it is not a plain delivery either: say so, with how many stale PRs this flush read.
  if (rejections.stale > 0) return { result: "intake_stale_retried", pr, stale_retries: rejections.stale }
  return { result: "delivered_pr_open", pr }
}

/** The flush with what finalize needs: the names still waiting for delivery after it. */
async function flushDetailed(env, { store, runner = ghRunner(), deadlineMs = DEFAULT_DEADLINE_MS, now = Date.now, transform = toPublished, maxFiles = MAX_FILES, maxBytes = MAX_BYTES, anonymousLookup = anonymousGithub() }) {
  const deadline = now() + deadlineMs
  if (!isRepo(store)) return { result: "unexpected", pending: null }
  let lock
  try {
    // A machine without factory state has decided nothing; flushing must not create the state that turns on finalize requests.
    const root = await factoryStateRoot(env, { create: false })
    if (root === null) return { result: "not_opted_in", pending: null }
    lock = await acquireLock(root)
  } catch {
    // An unsafe state folder or an unusable lock file: nothing is sent.
    return { result: "unexpected", pending: null }
  }
  if (lock === null) return { result: "locked", pending: null }
  const progress = { pending: null, rejectionsThrough: null }
  let outcome
  try {
    const client = createClient({ runner, deadline, now, anonymousLookup })
    outcome = await deliver(env, { store, client, now, deadline, transform, maxFiles, maxBytes, progress })
  } catch (error) {
    outcome = { result: error instanceof Stop ? error.code : "unexpected" }
  }
  try {
    const previous = (await readStatus(env)).last_flush?.[store]?.rejections_through
    const through = progress.rejectionsThrough ?? (Number.isSafeInteger(previous) ? previous : null)
    await writeStatus(env, {
      last_flush: {
        [store]: {
          at: new Date(now()).toISOString(),
          result: outcome.result,
          ...(outcome.pr ? { pr: outcome.pr.number } : {}),
          ...(outcome.stale_retries ? { stale_retries: outcome.stale_retries } : {}),
          ...(through !== null ? { rejections_through: through } : {}),
        },
      },
    })
  } catch {
    // A status that cannot be written never changes the result.
  } finally {
    await releaseLock(lock)
  }
  const pending = outcome.result === "nothing_pending" ? [] : DELIVERED_OPEN.has(outcome.result) ? progress.pending : null
  return { ...outcome, pending }
}

/**
 * `flush(env, { store, runner, deadlineMs = 120000 }) -> { result, pr?,
 * stale_retries? }`, `result` one of `FLUSH_CODES`, `pr` `{ number, url }`
 * with `delivered_pr_open` and `intake_stale_retried`, which also gives how
 * many stale-refused intake PRs this flush read before opening a new one. Also takes `now` (a millisecond clock), `transform`
 * (the publishing transform), the batch caps `maxFiles`/`maxBytes`, and `anonymousLookup` (`anonymousGithub()`
 * by default; a fake in tests) for the unauthenticated repository retry.
 */
export async function flush(env, options = {}) {
  const { pending, ...result } = await flushDetailed(env, options)
  return result
}

// ---------------------------------------------------------------------------
// Start-time delivery.
// ---------------------------------------------------------------------------

/**
 * One sweep, then, for every store with `contribute: true`, a flush and a
 * refresh of its open andon issues (`andon-watch.js`), within one deadline.
 * Resolves `{ swept, stores, andon }` with each store's results. Never
 * throws.
 */
export async function flushConsented(env, { runner = ghRunner(), deadlineMs = DEFAULT_DEADLINE_MS, now = Date.now, sweep = sweepMarkers, flush: flushStore = flush, andon: watch = refreshAndon } = {}) {
  const deadline = now() + deadlineMs
  try {
    if (await factoryStateRoot(env, { create: false }) === null) return { stores: {} }
    const consent = await readConsent(env)
    const stores = Object.keys(consent.stores).filter((store) => consent.stores[store]?.contribute === true).sort()
    if (stores.length === 0) return { stores: {} }
    let swept = null
    try {
      swept = await sweep(env)
    } catch {
      // A failed sweep leaves markers for the next start; delivery still runs.
    }
    const results = {}
    const andon = {}
    for (const store of stores) {
      const remaining = deadline - now()
      if (remaining <= 0) {
        results[store] = { result: "deadline" }
        continue
      }
      try {
        results[store] = await flushStore(env, { store, runner, deadlineMs: remaining, now })
      } catch {
        results[store] = { result: "unexpected" }
      }
      if (deadline - now() <= 0) {
        andon[store] = { result: "deadline" }
        continue
      }
      try {
        andon[store] = await watch(env, { store, runner, now })
      } catch {
        andon[store] = { result: "unexpected" }
      }
    }
    return { swept, stores: results, andon }
  } catch {
    return { stores: {} }
  }
}

// ---------------------------------------------------------------------------
// Finalize.
// ---------------------------------------------------------------------------

async function outboxHas(root, store, name) {
  try {
    const stat = await fsp.lstat(path.join(root, "outbox", store.replace("/", "__"), name))
    return stat.isFile()
  } catch {
    return false
  }
}

const jobFiles = (index, job) => (Array.isArray(index[job]) ? index[job].filter((name) => typeof name === "string") : [])

async function logIsQuiet(marker, quietMs) {
  try {
    return Date.now() - (await fsp.stat(marker.log_path)).mtimeMs >= quietMs
  } catch {
    return true
  }
}

/**
 * `finalize(env, { job, runner }) -> { result: "cleared" | "retained" |
 * "expired" | "invalid", flushes? }`. See the header. Also takes
 * `deadlineMs`, `quietMs` (5000), `maxQuietWaitMs`, `now`, `derive`,
 * `anonymousLookup` (`anonymousGithub()` by default; a fake in tests, passed
 * through to each flush's unauthenticated repository retry) and `flush` for
 * tests.
 */
export async function finalize(env, {
  job, runner = ghRunner(), deadlineMs = DEFAULT_DEADLINE_MS, quietMs = FINALIZE_QUIET_MS, maxQuietWaitMs = 60000, now = Date.now, derive = deriveFile, anonymousLookup = anonymousGithub(), flush: flushStore = flushDetailed,
} = {}) {
  if (typeof job !== "string" || !PATTERNS.jobId.test(job)) return { result: "invalid" }
  const root = await factoryStateRoot(env, { create: false })
  if (root === null) return { result: "retained", reason: "no_state" }
  const deadline = now() + deadlineMs
  const request = (await listFinalizeRequests(env)).find((entry) => entry?.job === job) ?? null
  const requestedAt = typeof request?.requested_at === "string" && PATTERNS.timestamp.test(request.requested_at) ? request.requested_at : null
  if (requestedAt !== null && now() - Date.parse(requestedAt) > FINALIZE_TTL_MS) {
    await clearFinalize(env, job)
    return { result: "expired" }
  }

  // Re-derive the job's sessions and anything that ran since the request.
  const indexed = new Set(jobFiles(await readJobsIndex(env), job))
  let settled = true
  for (const marker of await listMarkers(env)) {
    const name = `${marker.host}-${marker.session_id}.json`
    if (!indexed.has(name) && !(requestedAt !== null && marker.updated_at >= requestedAt)) continue
    const { result } = await derive(env, path.join(root, "markers", name), { quietMs, maxWaitMs: Math.max(0, Math.min(maxQuietWaitMs, deadline - now())) })
    if (result === "source_unreadable" || (result === "skipped" && !(await logIsQuiet(marker, quietMs)))) settled = false
  }

  // Every store holding one of the job's files, from the derivation receipts.
  const names = jobFiles(await readJobsIndex(env), job)
  const receipts = (await readStatus(env)).derivations ?? {}
  const byStore = new Map()
  for (const name of names) {
    const store = receipts[name]?.store
    if (!isRepo(store) || !(await outboxHas(root, store, name))) continue
    byStore.set(store, [...(byStore.get(store) ?? []), name])
  }

  const flushes = {}
  let delivered = settled
  for (const store of [...byStore.keys()].sort()) {
    const files = byStore.get(store)
    let outcome
    do {
      const remaining = deadline - now()
      if (remaining <= 0) {
        outcome = { result: "deadline", pending: null }
        break
      }
      outcome = await flushStore(env, { store, runner, deadlineMs: remaining, now, anonymousLookup })
      if (outcome.result === "locked") await sleep(Math.min(1000, Math.max(0, deadline - now())))
    } while (outcome.result === "locked")
    flushes[store] = outcome.result
    const done = (outcome.result === "nothing_pending" || DELIVERED_OPEN.has(outcome.result)) && Array.isArray(outcome.pending)
      && files.every((name) => !outcome.pending.includes(name))
    if (!done) delivered = false
  }

  if (!delivered) return { result: "retained", flushes }
  await clearFinalize(env, job)
  return { result: "cleared", flushes }
}

// ---------------------------------------------------------------------------
// Choosing the account.
// ---------------------------------------------------------------------------

/** Every result `chooseAccount` can return. */
export const ACCOUNT_RESULTS = Object.freeze(["account_found", "no_account_can_deliver", "gh_missing", "gh_too_old", "rate_limited", "offline", "deadline", "unexpected"])

/** The github.com logins in `gh auth status` output, the active one first. */
export function signedInAccounts(text) {
  const accounts = []
  let current = null
  for (const line of String(text).split("\n")) {
    const login = /Logged in to github\.com account ([A-Za-z0-9][A-Za-z0-9_-]{0,38})(?:\s|$)/u.exec(line)
    if (login) {
      current = { login: login[1], active: false }
      if (!accounts.some((entry) => entry.login === current.login)) accounts.push(current)
      continue
    }
    if (/^\S/u.test(line)) current = null
    else if (current !== null && /Active account:\s*true/u.test(line)) current.active = true
  }
  return [...accounts.filter((entry) => entry.active), ...accounts.filter((entry) => !entry.active)].map((entry) => entry.login)
}

/**
 * `chooseAccount({ store, runner, deadlineMs })`: the signed-in github.com account that can open intake pull requests
 * on `store`, never assumed from gh's active account. Each account signed in to gh is asked for `GET /repos/{store}`
 * with its own token; one with push permission is preferred, then one that can fork, the active account first among
 * equals. Returns `{ result: "account_found", account, route, accounts }`, or `{ result: "no_account_can_deliver",
 * accounts }` where each account carries its `route` or the reason it cannot deliver (`store_not_visible`,
 * `auth_failed`, `forking_disabled`, `managed_account`), or another of `ACCOUNT_RESULTS` when gh cannot be asked.
 * Tokens stay in memory and reach gh only as `GH_TOKEN`.
 */
export async function chooseAccount({ store, runner, deadlineMs = 60000, now = Date.now }) {
  if (!isRepo(store)) throw new Error("chooseAccount: store must be <owner>/<repo>")
  const deadline = now() + deadlineMs
  try {
    const status = await createClient({ runner, deadline, now }).call(["auth", "status", "--hostname", "github.com"])
    if (status.spawnError === "ENOENT" || status.code === 127) stop("gh_missing")
    const accounts = []
    for (const account of signedInAccounts(`${status.stdout ?? ""}\n${status.stderr ?? ""}`)) {
      const client = createClient({ runner, deadline, now })
      try {
        await client.session(account)
        const answer = await client.api("GET", `repos/${store}`)
        if (answer.status === 200 && isPlainObject(answer.json)) {
          const route = deliveryRoute(account, answer.json)
          accounts.push(route === "direct" || route === "fork" ? { account, route } : { account, reason: route })
        } else if (answer.status === 403 || answer.status === 404) {
          accounts.push({ account, reason: "store_not_visible" })
        } else {
          stop("unexpected")
        }
      } catch (error) {
        if (!(error instanceof Stop) || error.code !== "auth_failed") throw error
        accounts.push({ account, reason: "auth_failed" })
      }
    }
    const chosen = accounts.find((entry) => entry.route === "direct") ?? accounts.find((entry) => entry.route === "fork")
    return chosen ? { result: "account_found", account: chosen.account, route: chosen.route, accounts } : { result: "no_account_can_deliver", accounts }
  } catch (error) {
    return { result: error instanceof Stop ? error.code : "unexpected" }
  }
}
