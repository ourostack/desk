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
//   2. Read the store's consent and account. Transform every outbox file that
//      is not quarantined. The visibility of each referenced repository, and
//      of the desk's own GitHub remote, comes from the seven-day cache or
//      `GET /repos/{owner}/{repo}` with the account's token (`private: false`
//      is public, `private: true` private, 403 or 404 unknown). A desk that is
//      not known to be private publishes machine-keyed job IDs without
//      timing, keyed by the protected 32-byte machine secret. A file the
//      transform refuses or the public gate rejects is quarantined with a
//      stable code and never sent. When nothing changed since the last
//      delivery, the flush ends here without any network call.
//   3. Read the store. With push permission the intake branch lives in the
//      store; otherwise in the account's default-branch-only fork, created on
//      first use and brought up to date with `merge-upstream` (a fork that is
//      not ready yet returns `fork_pending`).
//   4. Read closed intake PRs of this machine's branch. When the store's
//      automation (`github-actions[bot]`) commented a first line
//      `factory-rejected: <code>`, the files of that PR are quarantined with
//      that code. PRs already read are remembered as a number in status.
//   5. A file whose exact published blob already sits at `facts/<name>` on
//      the store's default branch is marked delivered.
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
  listFinalizeRequests,
  listMarkers,
  markDelivered,
  pendingFiles,
  quarantine,
  readConsent,
  readJobsIndex,
  readMachineSecret,
  readStatus,
  readVisibilityCache,
  writeStatus,
  writeVisibilityCache,
} from "./outbox.js"
import { serializePublished, toPublished } from "./publish.js"
import { validatePublishedBytes } from "./published-schema.js"
import { PATTERNS, isPlainObject } from "./schema.js"

/** Every result `flush` can return. */
export const FLUSH_CODES = Object.freeze([
  "delivered_pr_open", "nothing_pending", "not_opted_in", "no_account", "gh_missing", "gh_too_old", "auth_failed",
  "store_missing", "fork_pending", "rate_limited", "offline", "locked", "deadline", "unexpected",
])

export const INTAKE_TITLE = "Factory intake"
export const REJECTION_AUTHOR = "github-actions[bot]"
export const MIN_GH_VERSION = Object.freeze([2, 40, 0])
export const DEFAULT_DEADLINE_MS = 120000
export const FINALIZE_QUIET_MS = 5000

const LOCK_STALE_MS = 10 * 60 * 1000
const MAX_FILES = 500
const MAX_BYTES = 24 * 1024 * 1024
const MAX_OUTPUT = 64 * 1024 * 1024
const FINALIZE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const INTAKE_ID = /^[0-9a-f]{16}$/u
const SHA = /^[0-9a-f]{40}$/u
const BRANCH = /^[A-Za-z0-9._-]{1,100}$/u
const REJECTED = /^factory-rejected: ([a-z][a-z0-9_]{0,63})$/u
const FACTS_NAME = /^(?:claude-code|copilot-cli)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u
const FACTS_PATH = /^facts\/((?:claude-code|copilot-cli)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json)$/u
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

function createClient({ runner, deadline, now }) {
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

  async function need(method, route, body) {
    const answer = await api(method, route, body)
    if (answer.status !== 200) stop("unexpected")
    return answer.json
  }

  return { session, api, need }
}

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

async function deskRepositories(env) {
  const byName = new Map()
  const remotes = new Map()
  for (const marker of await listMarkers(env)) {
    const root = marker.desk_root
    if (root === null) continue
    if (!remotes.has(root)) remotes.set(root, githubRepoOfRemote(readDeskRemote({ deskRoot: root, timeoutMs: 5000 })))
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
  return repos
}

async function resolveVisibility(env, client, account, repos, nowIso) {
  const cache = await readVisibilityCache(env, { now: nowIso })
  const known = new Map(Object.entries(cache).map(([repo, entry]) => [repo.toLowerCase(), entry.visibility]))
  const patch = {}
  for (const repo of [...new Set(repos.map((name) => name.toLowerCase()))].sort()) {
    if (known.has(repo)) continue
    await client.session(account)
    const answer = await client.api("GET", `repos/${repo}`)
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

function publishOne(local, name, { transform, known, desk, secret }) {
  if (`${local?.session?.host}-${local?.session?.id}.json` !== name) return { reason: "invalid" }
  let out
  try {
    out = transform(local, {
      visibility: (repo) => known.get(repo.toLowerCase()) ?? "unknown",
      // Every GitHub desk remote was resolved with the references; anything else is unknown.
      deskVisibility: desk ? known.get(desk.toLowerCase()) : "unknown",
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

// ---------------------------------------------------------------------------
// Store side.
// ---------------------------------------------------------------------------

async function resolveTarget(client, { store, account, info }) {
  const branch = info.default_branch
  if (info.permissions?.push === true) return { repo: store, owner: store.split("/")[0], branch }
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

async function readRejections(env, client, { store, head, through }) {
  const rejected = new Set()
  let highest = through
  const closed = await client.need("GET", `repos/${store}/pulls?state=closed&head=${encodeURIComponent(head.label)}&per_page=30`)
  for (const pr of list(closed)) {
    if (!isPlainObject(pr) || !Number.isSafeInteger(pr.number) || pr.number <= through || pr.head?.ref !== head.ref) continue
    highest = Math.max(highest, pr.number)
    if (pr.merged_at !== null && pr.merged_at !== undefined) continue
    const comments = await client.need("GET", `repos/${store}/issues/${pr.number}/comments?per_page=100`)
    let code = null
    for (const comment of list(comments)) {
      if (comment?.user?.login !== REJECTION_AUTHOR || typeof comment.body !== "string") continue
      code = REJECTED.exec(comment.body.split(/\r?\n/u)[0])?.[1] ?? null
      if (code !== null) break
    }
    if (code === null) continue
    const files = await client.need("GET", `repos/${store}/pulls/${pr.number}/files?per_page=100`)
    for (const file of list(files)) {
      const name = FACTS_PATH.exec(String(file?.filename))?.[1]
      if (name === undefined) continue
      await quarantine(env, store, name, code)
      rejected.add(name)
    }
  }
  return { rejected, through: highest }
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
    tree: batch.map((item) => ({ path: `facts/${item.name}`, mode: "100644", type: "blob", content: item.bytes.toString("utf8") })),
  })
  const tree = requireSha(created?.sha)
  // The tree must hold exactly the bytes that were checked.
  const landed = await factsOnBranch(client, target.repo, tree)
  for (const item of batch) if (landed.get(item.name) !== item.sha) stop("unexpected")
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
  const { store, client, now, transform, maxFiles, maxBytes, progress } = context
  const nowIso = () => new Date(now()).toISOString()
  const record = (await readConsent(env)).stores[store]
  if (record?.contribute !== true) return { result: "not_opted_in" }
  if (typeof record.account !== "string" || record.account === "") return { result: "no_account" }
  if (!INTAKE_ID.test(record.intake_id ?? "")) stop("unexpected")
  const { account } = record

  const candidates = await pendingFiles(env, store, { publishedBytesFor: () => LIST_ALL })
  if (candidates.length === 0) return { result: "nothing_pending" }

  // `pendingFiles` already quarantined every file that does not parse.
  const parsed = candidates.map(({ name, localBytes }) => ({ name, local: JSON.parse(localBytes.toString("utf8")) }))
  const desks = await deskRepositories(env)
  const repos = parsed.flatMap(({ local }) => referencedRepos(local))
  for (const { name } of parsed) if (desks.get(name)) repos.push(desks.get(name))
  const known = await resolveVisibility(env, client, account, repos, nowIso)
  const secret = await readMachineSecret(env)

  const bytesByName = new Map()
  for (const { name, local } of parsed) {
    const out = publishOne(local, name, { transform, known, desk: desks.get(name), secret })
    if (out.bytes) bytesByName.set(name, out.bytes)
    else await quarantine(env, store, name, out.reason)
  }
  // Every file without published bytes was just quarantined, so the listing below never asks about one.
  let pending = (await pendingFiles(env, store, { publishedBytesFor: (facts) => bytesByName.get(`${facts.session.host}-${facts.session.id}.json`) }))
    .map(({ name }) => ({ name, bytes: bytesByName.get(name), sha: gitBlobSha(bytesByName.get(name)) }))
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
  const rejections = await readRejections(env, client, { store, head, through: Number.isSafeInteger(through) ? through : 0 })
  progress.rejectionsThrough = rejections.through
  pending = pending.filter((item) => !rejections.rejected.has(item.name))

  const main = await client.need("GET", `repos/${store}/branches/${target.branch}`)
  const base = { sha: requireSha(main?.commit?.sha), tree: requireSha(main?.commit?.commit?.tree?.sha) }
  const onMain = await factsOnBranch(client, store, base.tree)
  const remaining = []
  for (const item of pending) {
    if (onMain.get(item.name) === item.sha) await markDelivered(env, store, { name: item.name, publishedBlobSha: item.sha })
    else remaining.push(item)
  }
  progress.pending = remaining.map((item) => item.name)
  if (remaining.length === 0) return { result: "nothing_pending" }

  const batch = takeBatch(remaining, { maxFiles, maxBytes })
  await pushBatch(client, { target, branch, base, batch })
  const pr = await openPr(client, { store, head, base: target.branch, count: batch.length })
  return { result: "delivered_pr_open", pr }
}

/** The flush with what finalize needs: the names still waiting for delivery after it. */
async function flushDetailed(env, { store, runner = ghRunner(), deadlineMs = DEFAULT_DEADLINE_MS, now = Date.now, transform = toPublished, maxFiles = MAX_FILES, maxBytes = MAX_BYTES }) {
  const deadline = now() + deadlineMs
  if (!isRepo(store)) return { result: "unexpected", pending: null }
  let lock
  try {
    lock = await acquireLock(await factoryStateRoot(env))
  } catch {
    // An unsafe state folder or an unusable lock file: nothing is sent.
    return { result: "unexpected", pending: null }
  }
  if (lock === null) return { result: "locked", pending: null }
  const progress = { pending: null, rejectionsThrough: null }
  let outcome
  try {
    const client = createClient({ runner, deadline, now })
    outcome = await deliver(env, { store, client, now, transform, maxFiles, maxBytes, progress })
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
          ...(through !== null ? { rejections_through: through } : {}),
        },
      },
    })
  } catch {
    // A status that cannot be written never changes the result.
  } finally {
    await releaseLock(lock)
  }
  const pending = outcome.result === "nothing_pending" ? [] : outcome.result === "delivered_pr_open" ? progress.pending : null
  return { ...outcome, pending }
}

/**
 * `flush(env, { store, runner, deadlineMs = 120000 }) -> { result, pr? }`,
 * `result` one of `FLUSH_CODES`, `pr` `{ number, url }` with
 * `delivered_pr_open`. Also takes `now` (a millisecond clock), `transform`
 * (the publishing transform) and the batch caps `maxFiles`/`maxBytes`.
 */
export async function flush(env, options = {}) {
  const { pending, ...result } = await flushDetailed(env, options)
  return result
}

// ---------------------------------------------------------------------------
// Start-time delivery.
// ---------------------------------------------------------------------------

/** One sweep, then a flush of every store with `contribute: true`, within one deadline. Never throws. */
export async function flushConsented(env, { runner = ghRunner(), deadlineMs = DEFAULT_DEADLINE_MS, now = Date.now, sweep = sweepMarkers, flush: flushStore = flush } = {}) {
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
    }
    return { swept, stores: results }
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
 * `deadlineMs`, `quietMs` (5000), `maxQuietWaitMs`, `now`, `derive` and
 * `flush` for tests.
 */
export async function finalize(env, {
  job, runner = ghRunner(), deadlineMs = DEFAULT_DEADLINE_MS, quietMs = FINALIZE_QUIET_MS, maxQuietWaitMs = 60000, now = Date.now, derive = deriveFile, flush: flushStore = flushDetailed,
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
    const { result } = await derive(env, path.join(root, "markers", name), { quietMs, maxWaitMs: maxQuietWaitMs })
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
      outcome = await flushStore(env, { store, runner, deadlineMs: remaining, now })
      if (outcome.result === "locked") await sleep(Math.min(1000, Math.max(0, deadline - now())))
    } while (outcome.result === "locked")
    flushes[store] = outcome.result
    const done = (outcome.result === "nothing_pending" || outcome.result === "delivered_pr_open") && Array.isArray(outcome.pending)
      && files.every((name) => !outcome.pending.includes(name))
    if (!done) delivered = false
  }

  if (!delivered) return { result: "retained", flushes }
  await clearFinalize(env, job)
  return { result: "cleared", flushes }
}
