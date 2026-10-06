// The boot script: one call that does session-start's mechanical steps and
// returns one JSON result, instead of a chain of prose steps the agent
// re-derives and re-runs by hand each session (boot-in-one-call, scope items
// 2, 3, 4, 5, 6, 8, 9, 11, 13).
//
// What it fixes:
//   - the missing `--root` bug: `session-sync.js`'s CLI only reads `--root`
//     or `$DESK`, but the hook's own root resolution never exports `$DESK`
//     and never passes `--root`, so sync silently no-ops whenever the root
//     comes from activation-config or host-project source. This module
//     resolves the root itself and calls `syncWorkspace` in-process, so
//     there is no argv boundary to drop the root across.
//   - the RECOVERING-vs-ready contradiction: this module never calls the
//     admission-controller readiness convergence `desk_status` does (slow,
//     network-bound). It reports one `status` word derived only from the
//     checks it actually ran, and lists what it could not finish under
//     `pending` rather than blocking or guessing.
//   - the opaque "1 task card with unreadable repos" line: `card_validation`
//     below names the task (by redacted track/slug and stable handle) and
//     the specific reason for every corrupted card, mirroring
//     `runtime/workspace-tidy.js`'s `skippedIssue`/`cardLabel` pattern.
//
// Every step is independently wrapped: a step that throws degrades only
// that part of the result (an entry in `degraded`, the field left `null` or
// empty) and never stops the others from reporting. `active_tasks` and
// `card_validation` come from a plain filesystem walk (this module's own,
// mirroring `desk/active-tasks.js`'s scan without its terminal-status
// filter, since every card needs validating, not just the open ones) —
// never from the slow runtime status. A step that needs the network (the
// prereq probe's `gh auth status`, and push-account resolution) is bounded
// by an overall wall-clock budget; anything still unresolved when the
// budget runs out is reported under `pending`, never left to hang the
// whole call.
//
// `bootOnce` returns `{ boot_complete: true, status, degraded, pending,
// instructions, root, host, prereqs, sync, sync_summary, agents_md, active_tasks,
// card_validation, push_accounts, factory }`. The CLI prints it as readable
// text (`boot-text.js`) unless `--json` asks for this structure. `status` is one of "ready", "degraded" or
// "setup_required" — never two words, and `degraded` always lists why.
// `instructions` is the one list of next steps an agent acts on, each naming
// the task, repo or file it is about (it used to be mirrored by an `actions`
// list; nothing read that, and agents saw every line twice, so it is gone).
// There is no `export DESK` line either: an environment variable does not
// survive an agent's separate shell calls, so the instructions give the
// desk's absolute path to use directly. `boot_complete` is always `true`: it marks that
// the script finished and returned a complete result, not that everything
// it found is healthy.

import { spawn as nodeSpawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { normalizeRemote } from "../factory/binding.js"
import { ghRunner, chooseAccount, signedInAccounts } from "../factory/flush.js"
import { PATTERNS } from "../factory/schema.js"
import { activeTasks } from "../desk/active-tasks.js"
import { folderHandle } from "../desk/handles.js"
import { loadFrontmatterParser } from "../desk/organization.js"
import { parseFrontmatterLite } from "../desk/frontmatter-lite.js"
import { factoryStatus } from "../tools/factory-context.js"
import {
  claudeBindingPath,
  DESK_ROOT_NOT_FOUND,
  resolveLocalPath,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "../util/paths.js"
import { redactCredentialLikeText, redactName } from "../util/redact.js"
import { shellQuote, shellQuotePath } from "../util/shell-quote.js"
import { readSmallText } from "../factory/marker.js"
import { isHeadlessFactorySession } from "../factory/headless-flag.js"
import { isNoninteractive } from "../factory/session-kind.js"
import { improvementBootCheck, improvementCountText, improvementLine, improvementNotes } from "../factory/boot-check.js"
import { AUTHORITY } from "../desk/improvement-authority.js"
import { improvementPerson } from "../desk/improvement-person.js"
import { runtimeResolverFailure } from "../desk/runtime-resolver.js"
import { LIFECYCLE_STATES, TERMINAL_STATES } from "../desk/lifecycle.js"
import { healthWord, syncDegradation } from "./health.js"
import { pendingMigrations, migrationLine } from "./pending-migrations.js"
import { syncWorkspace } from "./session-sync.js"
import { recordLocalOnlyOnCards } from "../tools/local-only.js"
import { installCardGuard } from "../desk/card-commit-guard.js"
import { NO_TASK_INSTRUCTION, NO_TASK_INSTRUCTION_TEXT, UNMATCHED_TASK_INSTRUCTION, UNMATCHED_TASK_INSTRUCTION_TEXT, formatBootText, lastSyncedAt, pushRoute, readAgentsMd, shownRepoPath, syncSummary } from "./boot-text.js"
import { checkStaleDesk } from "./stale-desk.js"
import { planStaleRefresh, startStaleRefresh, startedLine } from "./stale-desk-refresh.js"
import { deferredToolsHint } from "../util/deferred-tools.js"
import { recordUnsigned, signoffInstructions } from "../desk/unsigned-deliveries.js"

const parseFrontmatter = loadFrontmatterParser()
// Without gray-matter (a plugin run straight from its install folder) the
// dependency-free reader stands in; it does not parse nested values, so `repos`
// lists cannot be validated on that path.
const NESTED_CARD_FIELDS = parseFrontmatter !== parseFrontmatterLite
const DESK_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

// ── Root resolution ─────────────────────────────────────────────────────

/**
 * The desk root, classified for boot: `{ status: "ready", path, source,
 * binding_path }`, `{ status: "setup_required", binding_path, tried }` (no
 * source names a desk at all — a first run, not an outage), or
 * `{ status: "degraded", binding_path, tried, reason, message, path?,
 * source? }` (a source names a desk whose folder is missing, unreadable or
 * malformed). Mirrors `scripts/resolve-desk-root.js`'s `resolveHookDeskRoot`
 * but keeps the thrown error's `code` so boot can tell the two failure
 * shapes apart instead of collapsing them into one message string.
 */
export function resolveBootRoot({
  env = process.env,
  cwd = process.cwd(),
  homeDir = env.HOME || os.homedir(),
  readActivationConfig = (file) => readSmallText(file),
} = {}) {
  const bindingPath = claudeBindingPath(env)
  try {
    const resolved = resolveDeskRootWithSource({
      activationConfigPath: resolveActivationConfigPath({ env }),
      env,
      cwd,
      homeDir,
      // A Bash-spawned boot script has no CLAUDE_PROJECT_DIR (Claude Code only
      // sets it for the MCP server's own process); its cwd stands in, and like
      // the host project it only counts when it is itself a desk workspace.
      // Mirrors `desk/tidy.js`'s `resolveRoot`, which resolves the same way for
      // the same reason.
      hostProjectRoot: env.CLAUDE_PROJECT_DIR ?? cwd,
      readActivationConfig,
    })
    return { status: "ready", path: resolved.root, source: resolved.source, binding_path: bindingPath }
  } catch (error) {
    const status = error.code === DESK_ROOT_NOT_FOUND ? "setup_required" : "degraded"
    return {
      status,
      path: error.path ?? null,
      source: error.source ?? null,
      binding_path: bindingPath,
      tried: error.tried ?? [],
      // Every throw out of `resolveDeskRootWithSource` — including through
      // the injectable `readActivationConfig` seam, which `loadActivationConfig`
      // always re-wraps in a `codedError` — sets `.code` (see `util/paths.js`),
      // so this never falls back to a message-only reason.
      reason: error.code,
      message: error.message,
    }
  }
}

// ── Host identity ───────────────────────────────────────────────────────

/** `{ hostname, user, cwd, platform, release, probed_at }`. Never throws. */
export function probeHost({
  env = process.env,
  hostname = os.hostname,
  userInfo = os.userInfo,
  cwd = process.cwd,
  platform = os.platform,
  release = os.release,
  now = Date.now,
} = {}) {
  const envUser = typeof env.USER === "string" && env.USER !== "" ? env.USER : env.USERNAME
  let user = typeof envUser === "string" && envUser !== "" ? envUser : null
  if (user === null) {
    try {
      user = userInfo().username
    } catch {
      user = null
    }
  }
  let host
  try {
    host = hostname()
  } catch {
    host = null
  }
  return {
    hostname: host,
    user,
    cwd: cwd(),
    platform: platform(),
    release: release(),
    probed_at: new Date(now()).toISOString(),
  }
}

// ── Prerequisite probe ──────────────────────────────────────────────────

/** A generic subprocess runner shaped like `factory/flush.js`'s `ghRunner`, for commands other than `gh`. */
export function commandRunner(cmd, { spawn = nodeSpawn, env = process.env, maxOutput = 1024 * 1024 } = {}) {
  return (args, { timeoutMs = 5000 } = {}) => new Promise((resolve) => {
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
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
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
  })
}

const GH_VERSION_FLOOR = [2, 40]

function parseGhVersion(stdout) {
  const match = /gh version (\d+)\.(\d+)\.(\d+)/u.exec(stdout ?? "")
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
}

function meetsGhFloor([major, minor]) {
  return major > GH_VERSION_FLOOR[0] || (major === GH_VERSION_FLOOR[0] && minor >= GH_VERSION_FLOOR[1])
}

function trimmed(text, limit = 300) {
  return (text ?? "").trim().slice(0, limit)
}

function evaluateGh(result) {
  if (result.spawnError) return { ok: false, reason: "gh_missing", detail: "the `gh` binary was not found on PATH" }
  if (result.timedOut) return { ok: false, reason: "gh_timeout", detail: "`gh --version` did not respond in time" }
  if (result.code !== 0) return { ok: false, reason: "gh_error", detail: trimmed(result.stderr || result.stdout) }
  const version = parseGhVersion(result.stdout)
  if (version === null) return { ok: false, reason: "gh_version_unparseable", detail: trimmed(result.stdout) }
  const versionText = version.join(".")
  if (!meetsGhFloor(version)) {
    return {
      ok: false,
      reason: "gh_too_old",
      version: versionText,
      detail: `gh ${versionText} is older than the 2.40 floor \`gh auth switch -u\` needs`,
    }
  }
  return { ok: true, version: versionText }
}

function evaluateJq(result) {
  if (result.spawnError) return { ok: false, reason: "jq_missing", detail: "the `jq` binary was not found on PATH" }
  if (result.timedOut) return { ok: false, reason: "jq_timeout", detail: "`jq --version` did not respond in time" }
  if (result.code !== 0) return { ok: false, reason: "jq_error", detail: trimmed(result.stderr || result.stdout) }
  return { ok: true }
}

// gh says the host has no usable sign-in: the one answer that is a hard stop.
const AUTH_STALE = /no longer valid|not logged into|you are not logged|no accounts? (?:are |is )?(?:logged|found|configured)|gh auth login/iu
const RATE_LIMITED = /rate limit|\bHTTP 429\b|\bHTTP 403\b|\b(?:429|403)\b|secondary rate|abuse detection/iu
const NETWORK_ERROR = /timed? ?out|timeout|dial tcp|no such host|connection (?:refused|reset)|ECONN|ENOTFOUND|EAI_AGAIN|network|TLS|EOF|temporary failure|unreachable|HTTP 5\d\d/iu

/** Why `gh auth status` could not tell, in words for a warning line. */
function authTransientWhy(result) {
  if (result.timedOut) return "timed out"
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  if (RATE_LIMITED.test(text)) return "rate limited"
  if (NETWORK_ERROR.test(text)) return "network error"
  return "unrecognised gh error"
}

function evaluateAuth(result) {
  if (result.spawnError) return { ok: false, reason: "gh_missing", detail: "the `gh` binary was not found on PATH" }
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  // Not logged in is judged on gh's own words, even after a timeout or an exit 0: the output says what gh found.
  if (AUTH_STALE.test(text) && (result.code === 0 || !RATE_LIMITED.test(text))) return { ok: false, reason: "auth_stale", detail: trimmed(text, 500) }
  if (result.code === 0 && result.timedOut !== true) return { ok: true }
  // Anything else (a timeout, the network, a rate limit, an exit gh gave no reason for) is a failure to check, not a failure to sign in.
  const why = authTransientWhy(result)
  return { ok: false, reason: "auth_unverified", soft: true, detail: `${why}${trimmed(text, 300) === "" ? "" : `: ${trimmed(text, 300)}`}`, why }
}

const AUTH_RETRY_BACKOFF_MS = 750
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Whether gh is signed in for github.com. The offline check comes first (`gh auth token`, which reads the stored token
 * and asks GitHub nothing, so a rate limit or a bad network cannot fail it); only when that does not show a token does
 * `gh auth status` (an online check) run. A failure that is not "not logged in" gets one retry after a short backoff, then
 * resolves as `auth_unverified` (a warning, never a hard stop). The token itself is never read into the result.
 */
export async function checkAuth(ghAuth, { timeoutMs = 8000, sleep = sleepFor, backoffMs = AUTH_RETRY_BACKOFF_MS } = {}) {
  // The three calls share the one budget the old single call had (`timeoutMs`), so a slow GitHub never makes boot slower than it was:
  // the offline check gets a quarter, the online check half, and the retry what is left after the backoff.
  const offlineMs = Math.floor(timeoutMs / 4)
  const onlineMs = Math.floor(timeoutMs / 2)
  const offline = await ghAuth(["auth", "token", "--hostname", "github.com"], { timeoutMs: offlineMs })
  if (offline.spawnError === undefined && offline.code === 0 && offline.timedOut !== true && String(offline.stdout ?? "").trim() !== "") return { ok: true }
  let verdict = evaluateAuth(await ghAuth(["auth", "status", "--hostname", "github.com"], { timeoutMs: onlineMs }))
  if (verdict.soft === true) {
    await sleep(backoffMs)
    verdict = evaluateAuth(await ghAuth(["auth", "status", "--hostname", "github.com"], { timeoutMs: Math.max(1, timeoutMs - offlineMs - onlineMs - backoffMs) }))
  }
  return verdict
}

/**
 * The five-part prereq probe (`session-start/SKILL.md` Step 0.75), as one
 * call: `{ gh: {ok, version?, reason?, detail?}, jq: {...}, auth: {...} }`.
 * Every check resolves rather than rejects — a missing binary, a timeout or
 * a nonzero exit all come back as `{ ok: false, reason, detail }`, never a
 * thrown error.
 */
export async function checkPrereqs({ gh = ghRunner(), jq = commandRunner("jq"), ghAuth = gh, timeoutMs = 8000, authOptions = {} } = {}) {
  // `ghAuth` runs with the ambient environment: `gh` itself honors GH_TOKEN,
  // so a host signed in only through that variable is healthy. (`gh`, the
  // factory's runner, strips ambient tokens on purpose.)
  const [ghVersion, jqVersion, auth] = await Promise.all([
    gh(["--version"], { timeoutMs }),
    jq(["--version"], { timeoutMs }),
    checkAuth(ghAuth, { timeoutMs, ...authOptions }),
  ])
  return { gh: evaluateGh(ghVersion), jq: evaluateJq(jqVersion), auth }
}

// ── Task-card frontmatter validation ────────────────────────────────────

const MAX_CARD_BYTES = 64 * 1024
const VALID_STATUSES = new Set(LIFECYCLE_STATES)
const TERMINAL_STATUSES = new Set(TERMINAL_STATES)
const REQUIRED_TEXT_FIELDS = ["title", "status", "created", "updated", "track"]

function isTimestampField(field) {
  return field === "created" || field === "updated"
}

function isNumericKeyedObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every((key) => /^\d+$/u.test(key))
}

/**
 * Every problem with a task card's already-parsed frontmatter, in plain
 * language naming the field: numeric-string-keyed objects where a list was
 * expected (the corruption pattern the faster-desk-pr-flow card hit, a
 * pre-#51 bug — generalized here to every field, not just `repos`), missing
 * or malformed required fields, an unrecognized `status`, unparseable
 * `created`/`updated`, and malformed `repos[]` entries. `[]` when the card
 * is healthy.
 */
export function cardProblems(data, { nested = true } = {}) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return ["frontmatter did not parse as a YAML mapping"]
  }
  const problems = []
  const corrupted = new Set()
  for (const [field, value] of Object.entries(data)) {
    if (isNumericKeyedObject(value)) {
      corrupted.add(field)
      const keys = Object.keys(value).slice(0, 5).join(", ")
      problems.push(`\`${field}\` is an object with numeric-string keys (${keys}) where a list was expected — frontmatter is likely corrupted`)
    }
  }
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (corrupted.has(field)) continue
    // An unquoted YAML timestamp parses as a Date; that is a valid timestamp.
    if (isTimestampField(field) && data[field] instanceof Date) continue
    if (typeof data[field] !== "string" || data[field].trim() === "") problems.push(`\`${field}\` is missing or not a string`)
  }
  if (typeof data.status === "string" && !VALID_STATUSES.has(data.status)) {
    problems.push(`\`status: ${data.status}\` is not one of the task-lifecycle states`)
  }
  for (const field of ["created", "updated"]) {
    const value = data[field]
    const unparseable = value instanceof Date ? Number.isNaN(value.getTime()) : typeof value === "string" && Number.isNaN(Date.parse(value))
    if (unparseable) problems.push(`\`${field}\` is not a parseable timestamp`)
  }
  if (nested && !corrupted.has("repos")) {
    if (!Array.isArray(data.repos)) {
      problems.push("`repos` is missing or not a list")
    } else {
      data.repos.forEach((entry, index) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          problems.push(`repos[${index}] is not an object`)
          return
        }
        for (const field of ["name", "local_path", "mode"]) {
          if (typeof entry[field] !== "string") problems.push(`repos[${index}].${field} is missing or not a string`)
        }
        if (entry.url !== undefined && typeof entry.url !== "string") problems.push(`repos[${index}].url is not a string`)
        if (typeof entry.mode === "string" && entry.mode !== "local" && entry.mode !== "remote") {
          problems.push(`repos[${index}].mode is "${entry.mode}", not "local" or "remote"`)
        }
      })
    }
  }
  return problems
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function readCardText(filePath) {
  let fd
  try {
    fd = openSync(filePath, "r")
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(MAX_CARD_BYTES)
    const bytesRead = readSync(fd, buffer, 0, MAX_CARD_BYTES, 0)
    return buffer.toString("utf8", 0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

function scanTracks(scanRoot, deskRaw) {
  const cards = []
  for (const track of listDirs(scanRoot)) {
    if (deskRaw === null && track === "desks") continue
    const trackDir = path.join(scanRoot, track)
    for (const slug of listDirs(trackDir)) {
      const file = path.join(trackDir, slug, "task.md")
      const text = readCardText(file)
      if (text === null) continue
      let data
      try {
        data = parseFrontmatter(text).data
      } catch {
        data = {}
      }
      cards.push({ track, slug, desk: deskRaw, file, data })
    }
  }
  return cards
}

/**
 * Every task card under `root`, raw (unredacted) `{ track, slug, desk,
 * file, data }` tuples — the desk root plus every `desks/<alias>/` subtree,
 * skipping `_` and `.` folders, same layout as `desk/active-tasks.js`'s
 * scan, but without its terminal-status filter: every card is read, not
 * only the open ones, since a `done` card's frontmatter can be corrupted
 * too. `data` is `{}` when a card's frontmatter fails to parse at all.
 */
export function walkTaskCards(root) {
  const cards = scanTracks(root, null)
  for (const alias of listDirs(path.join(root, "desks"))) {
    cards.push(...scanTracks(path.join(root, "desks", alias), alias))
  }
  return cards
}

/** `card_validation`: every card `walk(root)` finds with `cardProblems(card.data).length > 0`, named by redacted track/slug/desk plus a stable handle — never by re-opening a redacted name. */
export function cardValidation(root, walk = walkTaskCards, { nested = NESTED_CARD_FIELDS } = {}) {
  const results = []
  for (const card of walk(root)) {
    const problems = cardProblems(card.data, { nested })
    if (problems.length === 0) continue
    results.push({
      track: redactName(card.track),
      slug: redactName(card.slug),
      ...(card.desk === null ? {} : { desk: redactName(card.desk) }),
      handle: folderHandle("task", root, path.dirname(card.file)),
      problems,
    })
  }
  return results
}

// ── Per-task-repo push-account resolution ───────────────────────────────

const MIN_ACCOUNT_CALL_MS = 3000

// `spawnGit` follows `runtime/session-sync.js`'s own convention: its result
// shape (`status`, `stdout`), never an exception, is the contract every
// caller in this codebase trusts. `normalizeRemote` throws only for a
// non-string or blank remote (`factory/binding.js`), which the `url === ""`
// check above already rules out, so neither call needs its own try/catch —
// a card whose `local_path` cannot be read still degrades cleanly, one
// level up, through `resolvePushAccounts`'s own caller in `bootOnce`.
function resolveLocalStore(localPath, { spawnGit, homeDir, deskRoot, timeoutMs }) {
  if (typeof localPath !== "string" || localPath.trim() === "") return null
  const resolved = resolveLocalPath(localPath, { homeDir, deskRoot })
  const result = spawnGit("git", ["-C", resolved, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: timeoutMs })
  if (!result || result.status !== 0 || typeof result.stdout !== "string") return null
  const url = result.stdout.trim()
  if (url === "") return null
  const normalized = normalizeRemote(url)
  const match = /^https:\/\/github\.com\/(.+)$/u.exec(normalized)
  return match !== null && PATTERNS.prRepo.test(match[1]) ? match[1] : null
}

// Only a URL git would clone as a remote: https://, ssh:// or scp-style git@host:path, with nothing a shell or git
// option parser could read as anything else. Credentials embedded in the URL are dropped first.
const CLONE_URL = /^(?:https:\/\/[\w.-]+(?::\d+)?\/[\w.~%+@:/-]+|ssh:\/\/(?:[\w.-]+@)?[\w.-]+(?::\d+)?\/[\w.~%+@:/-]+|git@[\w.-]+:[\w.~%+/-]+)$/u

/** A repo entry's `url` (where to clone it from) as a safe clone URL, or null when it has none or it is not one. */
function cloneUrl(value) {
  if (typeof value !== "string") return null
  const text = value.trim().replace(/^(https:\/\/)[^/@\s]*@/u, "$1")
  return CLONE_URL.test(text) ? redactCredentialLikeText(text) : null
}

function repoLabel(card, repo) {
  return {
    track: redactName(card.track),
    slug: redactName(card.slug),
    ...(card.desk === null ? {} : { desk: redactName(card.desk) }),
    repo: typeof repo.name === "string" ? redactCredentialLikeText(repo.name) : null,
  }
}

/**
 * The push account for every repo of every non-terminal task card, reusing
 * `factory/flush.js`'s `chooseAccount` — the same per-store, per-signed-in-
 * account resolution the factory consent instruction uses, asking each
 * account's own token about push/fork permission rather than assuming
 * `gh`'s active account. A repo entry that resolves to a real `owner/repo`
 * slug (a `remote`-mode `name` matching `PATTERNS.prRepo`, or a
 * `local`-mode clone's own `git remote` normalized the same way) gets one
 * `chooseAccount` call per distinct store, shared by every task that
 * references it; a repo with no resolvable slug is reported with
 * `result: "not_a_github_repo"` and no network call. A store whose call
 * would not fit in the remaining wall-clock budget is reported with
 * `result: "pending"` instead of blocking the rest of boot.
 */
export async function resolvePushAccounts({
  root,
  cards,
  runner,
  now = Date.now,
  deadlineMs = 20000,
  spawnGit = spawnSync,
  homeDir = os.homedir(),
  perCallTimeoutMs = 12000,
}) {
  const deadline = now() + deadlineMs
  const results = []
  const entries = []
  for (const card of cards) {
    if (TERMINAL_STATUSES.has(card.data?.status)) continue
    if (!Array.isArray(card.data?.repos)) continue
    for (const repo of card.data.repos) {
      if (repo === null || typeof repo !== "object") continue
      const label = repoLabel(card, repo)
      let store = null
      if (repo.mode === "remote" && typeof repo.name === "string" && PATTERNS.prRepo.test(repo.name)) {
        store = repo.name
      } else if (repo.mode === "local") {
        store = resolveLocalStore(repo.local_path, { spawnGit, homeDir, deskRoot: root, timeoutMs: 5000 })
      }
      if (store === null) {
        results.push({ ...label, result: "not_a_github_repo" })
        continue
      }
      entries.push({ label, store })
    }
  }

  const resolved = new Map()
  for (const store of new Set(entries.map((entry) => entry.store))) {
    const remaining = deadline - now()
    if (remaining < MIN_ACCOUNT_CALL_MS) {
      resolved.set(store, { result: "pending", reason: "boot_budget_exceeded" })
      continue
    }
    // `chooseAccount` resolves every failure of its own into a `{ result }`
    // code (see `factory/flush.js`); a card whose data makes this loop
    // itself throw is still caught one level up, by `resolvePushAccounts`'s
    // caller in `bootOnce`.
    resolved.set(store, await chooseAccount({ store, runner, deadlineMs: Math.min(remaining, perCallTimeoutMs), now }))
  }
  for (const entry of entries) results.push({ ...entry.label, store: entry.store, ...resolved.get(entry.store) })
  return results
}

// ── Ambient GitHub token as one account ─────────────────────────────────

export const ENV_TOKEN_ACCOUNT = "env-token"

function ambientToken(env) {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    if (typeof env[name] === "string" && env[name].trim() !== "") return env[name].trim()
  }
  return null
}

/**
 * Wraps the factory's account runner (which strips ambient tokens on purpose)
 * so a host signed in to `gh` only through `GH_TOKEN`/`GITHUB_TOKEN` counts
 * as one account, `env-token`, instead of as no account at all. Accounts
 * `gh` itself lists are left alone; the token only ever stays in memory and
 * answers `gh auth token --user env-token`.
 */
export function withAmbientToken(runner, env) {
  const token = ambientToken(env)
  if (token === null) return runner
  return async (args, options) => {
    const result = await runner(args, options)
    if (args[0] === "auth" && args[1] === "status" && signedInAccounts([result.stdout, result.stderr].join("\n")).length === 0) {
      return { code: 0, stdout: `github.com\n  ✓ Logged in to github.com account ${ENV_TOKEN_ACCOUNT} (environment token)\n  - Active account: true\n`, stderr: "" }
    }
    if (args[0] === "auth" && args[1] === "token" && args[3] === ENV_TOKEN_ACCOUNT) return { code: 0, stdout: `${token}\n`, stderr: "" }
    return result
  }
}

// ── Named task ──────────────────────────────────────────────────────────

/**
 * Resolves `--task <query>` against the open task cards: an exact match on a
 * handle, slug, `track/slug` or title (case-insensitive) wins; otherwise a
 * substring match on those, which must be unique. Returns `{ status:
 * "resolved", task }`, `{ status: "ambiguous", candidates }` or `{ status:
 * "not_found" }`; names in the answer are redacted like every other field.
 */
export function resolveTaskQuery(query, cards, root) {
  const needle = String(query).trim().toLowerCase()
  if (needle === "") return { status: "not_found" }
  const open = cards.filter((card) => !TERMINAL_STATUSES.has(card.data.status))
  const keys = (card) => [
    folderHandle("task", root, path.dirname(card.file)),
    card.slug,
    `${card.track}/${card.slug}`,
    typeof card.data.title === "string" ? card.data.title : "",
  ].map((key) => key.toLowerCase())
  const summary = (card) => ({
    track: redactName(card.track),
    slug: redactName(card.slug),
    ...(card.desk === null ? {} : { desk: redactName(card.desk) }),
    title: typeof card.data.title === "string" ? redactCredentialLikeText(card.data.title) : null,
    status: card.data.status ?? null,
    handle: folderHandle("task", root, path.dirname(card.file)),
  })
  let matches = open.filter((card) => keys(card).includes(needle))
  // `--task` takes whatever the operator typed ("resume valve-firmware-flasher"): one open task whose slug or track/slug stands in the phrase as a whole token is the task;
  // two make it ambiguous. A partial slug ("flasher") never matches.
  if (matches.length === 0) {
    const whole = (key) => new RegExp(`(?<![\\w-])${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w-])`, "u").test(needle)
    matches = open.filter((card) => [card.slug, `${card.track}/${card.slug}`].some((key) => key !== "" && whole(key.toLowerCase())))
  }
  // What is left is a partial match on a title only; a partial slug or handle is never a match.
  if (matches.length === 0) matches = open.filter((card) => typeof card.data.title === "string" && card.data.title.toLowerCase().includes(needle))
  if (matches.length === 0) return { status: "not_found" }
  if (matches.length > 1) return { status: "ambiguous", candidates: matches.map(summary) }
  return { status: "resolved", task: { ...summary(matches[0]), card: `${cardLocation({ desk: matches[0].desk, track: matches[0].track, slug: matches[0].slug })}/task.md`, file: matches[0].file } }
}

// `$DESK/.machine-local.yml`'s `repos:` map (repo name to the path of this machine's clone), read with a small line parser
// because boot runs before any YAML dependency is certain to be installed. A missing, unreadable or malformed file is an
// empty map. Only `name: path` lines indented under `repos:` count; quotes and trailing comments are dropped.
function machineLocalRepos(root) {
  let text
  try {
    text = readSmallText(path.join(root, ".machine-local.yml"))
  } catch {
    return new Map()
  }
  const repos = new Map()
  let inRepos = false
  for (const line of text.split(/\r?\n/u)) {
    if (/^\S/u.test(line)) inRepos = /^repos:\s*(?:#.*)?$/u.test(line)
    else if (inRepos) {
      const entry = /^\s+["']?([^:"'#]+?)["']?\s*:\s*(?:"([^"]*)"|'([^']*)'|([^#\s][^#]*?))\s*(?:#.*)?$/u.exec(line)
      const value = entry?.[2] ?? entry?.[3] ?? entry?.[4]
      if (entry !== null && value !== undefined && value !== "") repos.set(entry[1], value)
    }
  }
  return repos
}

/**
 * Names of the card's repos that are remote-only: recorded as `mode: remote`, or with no local path, and with no clone
 * this machine's `.machine-local.yml` points at (a `repos:` entry under the repo's name, or its name after the owner, whose path exists).
 */
function remoteRepoNames(card, { root, homeDir }) {
  const repos = Array.isArray(card.data.repos) ? card.data.repos : []
  const overrides = machineLocalRepos(root)
  const hasLocalClone = (repo) => {
    if (typeof repo.name !== "string" || repo.name === "") return false
    const target = overrides.get(repo.name) ?? overrides.get(repo.name.split("/").at(-1))
    return target !== undefined && existsSync(resolveLocalPath(target, { homeDir, deskRoot: root }))
  }
  return repos
    .filter((repo) => repo !== null && typeof repo === "object" && (repo.mode === "remote" || typeof repo.local_path !== "string" || repo.local_path.trim() === "") && !hasLocalClone(repo))
    .map((repo) => (typeof repo.name === "string" && repo.name !== "" ? redactCredentialLikeText(repo.name) : "a repo without a name"))
}

function hostLineHostname(cardText) {
  const match = /^Host: `([^`]+)`/mu.exec(cardText)
  return match === null ? null : match[1]
}

// ── Code repos and open pull requests ───────────────────────────────────

const REPO_FETCH_TIMEOUT_MS = 10000

/** `git fetch` plus branch and dirty state for every locally-cloned repo of every open task, within the deadline. */
export function repoStates({ cards, root, spawnGit = spawnSync, homeDir = os.homedir(), now, deadline }) {
  const states = []
  const pending = []
  for (const card of cards) {
    if (TERMINAL_STATUSES.has(card.data?.status) || !Array.isArray(card.data?.repos)) continue
    for (const repo of card.data.repos) {
      if (repo === null || typeof repo !== "object" || repo.mode !== "local" || typeof repo.local_path !== "string") continue
      const label = repoLabel(card, repo)
      const dir = resolveLocalPath(repo.local_path, { homeDir, deskRoot: root })
      if (deadline - now() < MIN_ACCOUNT_CALL_MS) {
        pending.push(`repo state for ${label.repo} (${cardLocation(card)}): boot_budget_exceeded`)
        continue
      }
      const fetched = spawnGit("git", ["-C", dir, "fetch", "--quiet", "origin"], { encoding: "utf8", timeout: REPO_FETCH_TIMEOUT_MS })
      const status = spawnGit("git", ["-C", dir, "status", "--porcelain", "-b"], { encoding: "utf8", timeout: 5000 })
      if (!status || status.status !== 0 || typeof status.stdout !== "string") {
        states.push({ ...label, local_path: repo.local_path, path: dir, ...(cloneUrl(repo.url) === null ? {} : { url: cloneUrl(repo.url) }), present: false })
        continue
      }
      const lines = status.stdout.split("\n").filter((line) => line !== "")
      // A clone with no remote at all has nowhere to push: its commits are the delivered work (`done-evidence.js`).
      const remotes = spawnGit("git", ["-C", dir, "remote"], { encoding: "utf8", timeout: 5000 })
      states.push({
        ...label,
        present: true,
        local_path: repo.local_path,
        path: dir,
        branch: (lines[0] ?? "").replace(/^## (?:No commits yet on )?/u, "").split("...")[0] || null,
        dirty: lines.length > 1,
        fetched: Boolean(fetched) && fetched.status === 0,
        ...(remotes?.status === 0 && typeof remotes.stdout === "string" && remotes.stdout.trim() === "" ? { local_only: true } : {}),
      })
    }
  }
  return { states, pending }
}

// What gh prints when GitHub refuses the credential itself (a revoked or expired token, a bad GH_TOKEN), as opposed to a rate limit or a network failure.
const AUTH_REJECTED = /HTTP 401|bad credentials|requires authentication|token[^.\n]{0,40}(?:invalid|expired|revoked)|no longer valid/iu

/** Open pull requests the signed-in account authored, one `gh pr list` per distinct GitHub repo, within the deadline. */
export async function openPullRequests({ stores, runner, now, deadline }) {
  const prs = []
  const pending = []
  for (const store of stores) {
    const remaining = deadline - now()
    if (remaining < MIN_ACCOUNT_CALL_MS) {
      pending.push(`open pull requests for ${store}: boot_budget_exceeded`)
      continue
    }
    const result = await runner(["pr", "list", "--repo", store, "--author", "@me", "--state", "open", "--json", "number,title,url,isDraft,reviewDecision"], { timeoutMs: Math.min(remaining, 12000) })
    if (result.timedOut) {
      pending.push(`open pull requests for ${store}: timeout`)
      continue
    }
    if (result.code !== 0) {
      // The offline sign-in check cannot see a token GitHub has revoked, or an invalid GH_TOKEN; this call can, so say it once, as a warning.
      const said = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      if (AUTH_REJECTED.test(said) && !pending.some((line) => line.startsWith("auth: "))) {
        pending.push(`auth: GitHub rejected the sign-in gh uses (gh said: ${redactCredentialLikeText(trimmed(said, 200).replace(/\s+/gu, " "))}); pushes will fail until you run \`gh auth login --hostname github.com\`, or unset or replace GH_TOKEN if it is set`)
      }
      continue
    }
    let list
    try {
      list = JSON.parse(result.stdout)
    } catch {
      continue
    }
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      prs.push({ store, number: entry.number, title: redactCredentialLikeText(String(entry.title ?? "")), url: entry.url, draft: entry.isDraft === true, review: entry.reviewDecision ?? null })
    }
  }
  return { prs, pending }
}

// ── Orchestrator ────────────────────────────────────────────────────────

const DEFAULT_BUDGET_MS = 45000
const SYNC_BUDGET_MS = 25000
const AGENT_HOSTS = Object.freeze(["claude", "copilot", "codex"])

const HOST_ENV = Object.freeze({
  claude: ["CLAUDECODE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PROJECT_DIR"],
  codex: ["CODEX_HOME", "CODEX_SANDBOX", "CODEX_THREAD_ID"],
  copilot: ["COPILOT_AGENT_SESSION_ID", "COPILOT_CLI", "GITHUB_COPILOT_CLI"],
})

/** Which of the covered agent hosts this process runs under, from the variables each host sets; "unknown" otherwise. */
export function detectAgentHost(env) {
  // A Copilot session started from a Claude Code shell inherits CLAUDECODE, so the session id Copilot itself sets wins.
  if (env.COPILOT_AGENT_SESSION_ID) return "copilot"
  const found = Object.entries(HOST_ENV).find(([, names]) => names.some((name) => Boolean(env[name])))
  return found === undefined ? "unknown" : found[0]
}

function parserName(nested) {
  return nested ? "gray-matter" : "lite"
}

function prereqAction(name, check) {
  if (name === "gh" && check.reason === "gh_missing") {
    return "Install gh: macOS `brew install gh`, Windows `winget install --id GitHub.cli`, Linux see https://cli.github.com/."
  }
  if (name === "gh" && check.reason === "gh_too_old") {
    return `Upgrade gh (found ${check.version}, need >= 2.40): brew upgrade gh / winget upgrade GitHub.cli / sudo apt upgrade gh.`
  }
  if (name === "jq" && check.reason === "jq_missing") {
    return "Install jq: `brew install jq`, `winget install jqlang.jq`, or `sudo apt install jq`."
  }
  if (name === "auth" && check.reason === "auth_stale") {
    return `Re-authenticate: run \`gh auth login --hostname github.com\` (gh said: ${check.detail.replace(/\s+/gu, " ")}).`
  }
  return `Fix the ${name} prerequisite (${check.reason}) before continuing.`
}

function cardLocation(entry) {
  return entry.desk ? `desks/${entry.desk}/${entry.track}/${entry.slug}` : `${entry.track}/${entry.slug}`
}

function emptyResult({ status, degraded, pending, instructions = [], root, host }) {
  return {
    boot_complete: true,
    status,
    degraded,
    pending,
    instructions,
    covers_hosts: AGENT_HOSTS,
    root,
    host,
    migrations: [],
    prereqs: null,
    sync: null,
    sync_summary: null,
    needs_operator: null,
    agents_md: null,
    active_tasks: null,
    card_parser: parserName(NESTED_CARD_FIELDS),
    card_validation: [],
    push_accounts: [],
    repo_states: [],
    open_prs: [],
    task: null,
    factory: null,
    stale_desk: null,
  }
}

const FACTORY_QUESTION = (store, login) => `Desk can contribute measurement data about your finished tasks to \`${store}\`, which builds a report for each finished job. What it publishes: durations, counts, tool kinds, plugin and model versions, and references to public repositories. What it never publishes: prompt, assistant or tool content, names, or dates and times of day. \`${store}\` is a public repository, and your GitHub account \`${login}\` appears as the author of the intake pull requests that deliver the data. Contribute? (yes or no)`

export { isNoninteractive }

const IMPROVEMENT_BUDGET_MS = 500

/**
 * What a session is told about the improvement cards, for an agent that reads it at session start: what a card is,
 * that the cards are standing work, when to take one, and (the one authority paragraph the improvement tools export)
 * what it may decide itself. Said only for a session with an operator in it, and the authority paragraph only when
 * a card is open. An unreadable folder and set-aside files are said whatever the count is.
 */
export function improvementInstructions(summary) {
  if (summary === null || summary === undefined) return []
  if (summary.status !== "ok") return [improvementLine(summary)]
  const out = []
  if (summary.open > 0) {
    out.push(`Improvement cards: ${improvementCountText(summary)}. An improvement card is one finding of the factory about our own tooling, with its evidence. The cards are standing, pre-authorized work: take the oldest when your foreground work allows it, this is an interactive session and the machine is under its cap, by handing it to a background subagent through improvement_next, which refuses and says why when the session or the machine's cap does not allow it. ${AUTHORITY}`)
  }
  const notes = improvementNotes(summary)
  if (notes.length > 0) out.push(`Improvement cards: ${notes.join("; ")}`)
  return out
}

function factoryInstructions(factory, pluginRoot, { noninteractive }) {
  // No operator to ask: say nothing, record nothing. The next interactive session asks.
  if (factory?.consent !== "undecided" || noninteractive) return []
  const store = factory.store
  const cli = path.join(pluginRoot, "mcp", "scripts", "factory.js")
  return [
    `Factory consent is undecided for ${store}. It never comes before the work the operator asked for, and never instead of it: do that work first. Afterwards raise it at most once, as one short line at the end of your reply ("Desk can contribute measurement data about your finished tasks to ${store}; want the details?"), never as its own decision group, and only if the operator is in the conversation. If they say yes to hearing it, find the account that would open the intake pull requests with \`node ${cli} account --store ${store}\` (never assume gh's active account).`,
    `With result account_found, ask this, naming that account as the login: "${FACTORY_QUESTION(store, "<login>")}" With no_account_can_deliver, do not ask: say in one line that no signed-in GitHub account can open pull requests on ${store} (give each account's reason), and that signing in a personal account with \`gh auth login\` lets a later session ask.`,
    `Record the answer only with \`node ${cli} consent --store ${store} --contribute yes --account <login>\` or \`node ${cli} consent --store ${store} --contribute no\`; a no is a decision too and is never asked again.`,
  ]
}

// What a failed sync means for the agent, by why it failed. A conflict or an unknown failure sends the agent to
// `git status`; an unreachable or refusing origin must not, because `git status` then reads clean and the
// degraded state gets dismissed (round 5). Returns null for a sync that did not fail.
function syncInstruction(sync, root) {
  if (sync?.state !== "unresolved") return null
  const where = sync.remote ? `origin ${sync.remote}` : "origin"
  const why = sync.error ? ` (${sync.error})` : ""
  if (sync.cause === "unreachable") {
    return `The desk could not sync: ${where} is unreachable${why}. Work continues on local state; say so in one line, and retry sync (\`git -C ${shellQuote(root.path)} pull --rebase --autostash\`) before pushing anything. \`git status\` will read clean, because nothing is conflicted: that does not mean the desk is in sync.`
  }
  if (sync.cause === "auth_failed") {
    return `The desk could not sync: ${where} refused this host's credentials${why}. Work continues on local state; say so in one line, check \`gh auth status\` (sign in again with \`gh auth login\` if it is stale), then retry sync before pushing anything. \`git status\` will read clean: that does not mean the desk is in sync.`
  }
  if (sync.cause === "deadline" && sync.reason !== "sync_deadline_exceeded") {
    return `A git call timed out while syncing the desk${where === "origin" ? "" : ` with ${where}`}: the remote is slow or unreachable. Work continues on local state; say so in one line, and retry sync (\`git -C ${shellQuote(root.path)} pull --rebase --autostash\`) before pushing anything.`
  }
  if (sync.cause === "deadline") {
    return `The desk sync ran out of time before it finished. Work continues on local state; say so in one line and retry sync (\`git -C ${shellQuote(root.path)} pull --rebase --autostash\`) before pushing anything.`
  }
  if (sync.cause === "diverged") {
    return `The desk has diverged from ${where}${why}: each side has commits the other lacks. Run \`git -C ${shellQuote(root.path)} status\` and \`git -C ${shellQuote(root.path)} log --oneline --left-right @{u}...HEAD\`, reconcile with a rebase, and do not push until they agree.`
  }
  const paths = Array.isArray(sync.conflicted) && sync.conflicted.length > 0 ? ` (conflicted: ${sync.conflicted.join(", ")})` : ""
  return `The desk's git sync is unresolved${paths}: run \`git status\` in ${root.path} and resolve what it shows before changing anything there.`
}

// A push route worth telling the agent about: no account can deliver, the route goes through a fork, or the only
// account with access is not the one gh has active (the agent would push with the wrong login). A plain direct push
// by the active account needs no line. `accounts` lists gh's active account first.
function pushInstruction(entry, where) {
  const store = entry.store
  if (entry.result === "no_account_can_deliver") {
    const reasons = Array.isArray(entry.accounts) && entry.accounts.length > 0
      ? ` (${entry.accounts.map((item) => `${item.account}: ${item.reason}`).join("; ")})`
      : ""
    return `Do not push ${store} (${where}): no signed-in account can${reasons}. Ask the operator which account to use, or fork, and say so in one line when you report on the task.`
  }
  if (entry.result === "account_found") {
    const active = entry.accounts[0].account
    if (entry.route === "fork") {
      const notActive = entry.account === active ? "" : ` Push as ${entry.account} (\`GH_TOKEN=$(gh auth token --user ${entry.account})\` for the git or gh call), and write ${entry.account}, never ${active}, as the push account in any note.`
      const route = pushRoute(entry)
      return `Push route for ${store} (${where}): ${route}${route.endsWith(".") ? " Account" : "; account"} ${entry.account} cannot push to it directly. Push your branch to ${entry.account}'s fork and open the pull request from there; never push to ${store} itself.${notActive} Tell the operator this route in one line when you report on this task; it is one line of your report, not the whole of it.`
    }
    if (entry.account !== active) {
      return `Push route for ${store} (${where}): account ${entry.account} is the one with push access (route ${entry.route}), but gh's active account is ${active}. Push as ${entry.account} (\`GH_TOKEN=$(gh auth token --user ${entry.account})\` for the git or gh call), not with the active login. Tell the operator this in one line when you report on the task.`
    }
    return null
  }
  if (entry.result === "pending" || entry.result === "not_a_github_repo") return null
  return `Push access for ${store} (${where}) could not be checked (${entry.result}): treat it as unknown and verify with \`gh auth status\` before pushing.`
}

const PUSH_LINE_CAP = 5

function taskList(locations) {
  const shown = locations.slice(0, 3).join(", ")
  const more = locations.length > 3 ? ` and ${locations.length - 3} more` : ""
  return `${locations.length === 1 ? "task" : "tasks"} ${shown}${more}`
}

// One line per store and outcome, not per task and repo: a repo shared by many tasks is one line naming the first
// few. At most PUSH_LINE_CAP lines, then one summary. `namedTask`, when the operator named one, narrows to its repos.
function pushLines(pushAccounts, namedTask) {
  const groups = new Map()
  for (const entry of pushAccounts) {
    if (namedTask !== null && (entry.track !== namedTask.track || entry.slug !== namedTask.slug)) continue
    if (pushInstruction(entry, "") === null) continue
    const key = [entry.store, entry.result, entry.account, entry.route].join("|")
    const group = groups.get(key) ?? { entry, locations: [] }
    const location = cardLocation(entry)
    if (!group.locations.includes(location)) group.locations.push(location)
    groups.set(key, group)
  }
  const lines = [...groups.values()].map(({ entry, locations }) => pushInstruction(entry, taskList(locations)))
  if (lines.length <= PUSH_LINE_CAP) return lines
  return [...lines.slice(0, PUSH_LINE_CAP), `...and ${lines.length - PUSH_LINE_CAP} more repos with push-route notes: read each task's \`push:\` line in the plain-text boot (the \`push_accounts\` field with \`--json\`) before pushing anywhere.`]
}

// What to do about a recorded local clone that is not on this machine: the exact clone command when the card carries
// the repo's `url` (or its name is owner/repo), otherwise exactly what to ask the operator (boot acceptance round A:
// "no remote" left the agent guessing between inventing a repo and asking an open question).
function hasCloneSource(missing) {
  return typeof missing.url === "string" || (typeof missing.repo === "string" && /^[\w.-]+\/[\w.-]+$/u.test(missing.repo))
}

function missingCloneInstruction(missing) {
  const where = shellQuotePath(missing.path ?? missing.local_path)
  const lead = `The named task's local repo ${missing.repo} is not at its recorded path ${shownRepoPath(missing)}`
  if (typeof missing.url === "string") {
    return `${lead}: only if the next step needs its code, clone it with \`git clone -- ${shellQuote(missing.url)} ${where}\` (the card's recorded url); otherwise do not clone it.`
  }
  return `${lead}: only if the next step needs its code, clone it with \`gh repo clone ${shellQuote(missing.repo)} ${where}\`; otherwise do not clone it.`
}

// A missing clone with no source to clone from blocks the hand-off: the agent has to ask first. So the hand-off and the question are ONE instruction, in
// the order they happen, never two parallel steps (boot acceptance round O: "I can't hand off to session-resumption if I first need to ask about the missing repo").
// The one question boot makes the agent ask before any work, or null when nothing blocks. The text boot prints it right after the headline and
// `--json` carries it as `needs_operator`; the consent line is left out of that boot (the operator has one question to answer first).
function needsOperator(ctx) {
  const { taskQuery, task, repoStateList } = ctx
  if (taskQuery === null || task?.status !== "resolved") return null
  const blockers = repoStateList.filter((state) => state.present === false && state.track === task.task.track && state.slug === task.task.slug && !hasCloneSource(state))
  if (blockers.length === 0) return null
  const names = blockers.map((missing) => missing.repo)
  // The headline names at most three repos; the question may name them all but stays within 400 characters.
  const summary = `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} not on this machine`
  const each = names.map((name) => `Where is ${name} cloned, or what URL should I clone it from?`).join(" ")
  if (each.length <= 400) return { question: each, summary }
  let listed = names
  const together = (list) => `Where are ${list.join(", ")}${list.length < names.length ? ` and ${names.length - list.length} more` : ""} cloned, or what URLs should I clone them from?`
  while (listed.length > 1 && together(listed).length > 400) listed = listed.slice(0, -1)
  return { question: together(listed), summary }
}

function askThenHandOff(blockers, task) {
  const named = blockers.length === 1 ? `its local repo ${blockers[0].repo} is not at its recorded path ${shownRepoPath(blockers[0])}` : `its local repos are not at their recorded paths (${blockers.map((missing) => `${missing.repo} at ${shownRepoPath(missing)}`).join("; ")})`
  const questions = blockers.map((missing) => `"Where is ${missing.repo} cloned, or what URL should I clone it from?"`).join(" and ")
  const finish = blockers.map((missing) => `clone ${missing.repo} to ${missing.path ?? missing.local_path} (or record the path they give)`).join(" and ")
  return `The operator named a task (${task.card}, handle ${task.handle}), but ${named}, and the card records no usable clone url for ${blockers.length === 1 ? "it" : "them"}. Do not invent the repo or any progress in it. Before anything else, ask the operator one question and stop until they answer: ${questions} Once they answer, ${finish}, save the answer on the card with task_update (a \`url\` or \`local_path\` on that repos entry) so the next session does not ask, and only then hand off to desk:session-resumption for ${task.card} (handle ${task.handle}), skipping the status block. Every other instruction below still applies.`
}

// A repo the card records as remote-only, or with no local path: it is read through the hosting service, and cloned only
// when the next step needs its code (an agent once cloned a public repo into the shared /tmp just to look at it).
function remoteRepoInstruction(names, root) {
  return `The named task's remote-only repos (no local clone): ${names.join(", ")}. Do not clone any of them unless the next step needs its code. If it does, clone into the operator's code location (\`defaults.clone_root\` in ${root.path}/.machine-local.yml, default ~/code/), never /tmp, and record the clone on the card with task_update (the repo's \`local_path\`, with \`mode: local\`).`
}

// The factory consent line the plain-text boot prints in place of the three long instructions `--json` keeps: one short
// line, after the work, with the pointer to the script that runs only if the operator says yes.
function factoryTextLine(factory, pluginRoot) {
  const store = factory.store
  const details = path.join(pluginRoot, "skills", "session-start", "details.md")
  return `Factory consent is undecided for ${store}. Only after the operator's work is done, and only if they are in the conversation, end your reply with this one plain sentence, as a statement and never a question: "Desk can contribute measurement data about finished tasks to ${store}; say 'factory details' to see what it sends." Say it once, and ask nothing. Only if they then say 'factory details' (or ask what is sent), follow "Factory consent" in ${details}; the script is \`node ${path.join(pluginRoot, "mcp", "scripts", "factory.js")}\`.`
}

// The instructions as `{ text, plain }` pairs: `text` is what `--json` carries, `plain` the shorter wording the text boot
// prints, or null when the text boot says it elsewhere (a push route sits on its task) or not at all.
function buildInstructionItems(ctx) {
  const { root, prereqResults, pushAccounts, cardValidationResult, sync, factory, task, host, migrationEntries, pluginRoot, taskQuery, agentHost, noninteractive, repoStateList, improvement } = ctx
  const out = []
  const add = (text, plain = text) => out.push({ text, plain })
  // A question for the operator comes first, before the desk path and the tool names: the agent must not start anything until it is asked.
  const namedBlockers = taskQuery !== null && task?.status === "resolved" ? repoStateList.filter((state) => state.present === false && state.track === task.task.track && state.slug === task.task.slug && !hasCloneSource(state)) : []
  if (namedBlockers.length > 0) add(askThenHandOff(namedBlockers, task.task))
  for (const entry of migrationEntries) {
    add(migrationLine([entry], pluginRoot).replace(/^Desk migrations: /u, ""))
  }
  add(
    `Use the absolute path ${root.path} for the desk in every command and tool call. Each shell call starts fresh, so an exported \`$DESK\` would not persist; where a Desk skill says \`$DESK\`, it means this path.`,
    `Use ${root.path} as the desk path in every command and tool call; where a Desk skill says \`$DESK\`, it means this path.`,
  )
  for (const [name, check] of Object.entries(prereqResults)) {
    if (check.ok || check.soft === true || check.reason.endsWith("_timeout")) continue
    add(`Hard stop: ${prereqAction(name, check)} A failed prerequisite is like a compile error: fix it before anything else, never fall back to local-only work; proceed only if the operator explicitly overrides after you name the specific risk.`)
  }
  const syncLine = syncInstruction(sync, root)
  if (syncLine !== null) add(syncLine)
  if (sync?.state === "quarantined") add(`Sync moved stray untracked paths to _cache/stray-<date>/ under ${root.path}; mention it in one line and continue.`)
  for (const entry of cardValidationResult) {
    add(`Fix the frontmatter of ${cardLocation(entry)}/task.md (handle ${entry.handle}): ${entry.problems.join("; ")}.`)
  }
  // The named task's repos when the operator named one, every active task's otherwise. The text boot prints each push
  // route on its task instead, so these are `--json`-only.
  const namedTask = taskQuery !== null && task?.status === "resolved" ? task.task : null
  for (const line of pushLines(pushAccounts, namedTask)) add(line, null)
  add(deferredToolsHint(agentHost))
  if (taskQuery !== null) {
    if (task?.status === "resolved") {
      const named = repoStateList.filter((state) => state.present === false && state.track === task.task.track && state.slug === task.task.slug)
      if (namedBlockers.length === 0) add(`The operator named a task: hand off to desk:session-resumption for ${task.task.card} (handle ${task.task.handle}) and skip the status block. Every check above still applies.`)
      for (const missing of named.filter(hasCloneSource)) add(missingCloneInstruction(missing))
      if (task.task.remote_repos.length > 0) add(remoteRepoInstruction(task.task.remote_repos, root))
      if (task.host_line_changed) add(`That card's Host line names a different host; replace it with: Host: \`${host.hostname}\` / user: \`${host.user}\` / cwd: \`${host.cwd}\` / OS: \`${host.platform}\` / probed: ${host.probed_at}.`)
    } else if (task?.status === "ambiguous") {
      add(`The name matches more than one open task (${task.candidates.map((c) => c.handle).join(", ")}): ask which one, in one line.`)
    } else {
      add(UNMATCHED_TASK_INSTRUCTION, UNMATCHED_TASK_INSTRUCTION_TEXT)
    }
  } else {
    add(NO_TASK_INSTRUCTION, NO_TASK_INSTRUCTION_TEXT)
  }
  // The sign-off line comes before the consent block: consent stays the last instruction of the text boot.
  signoffInstructions(ctx.unsigned, { noninteractive }).forEach((text) => add(text))
  // An ask-and-stop blocker means the operator has one question to answer first: no consent line on this boot.
  const consent = needsOperator(ctx) === null ? factoryInstructions(factory, pluginRoot, { noninteractive }) : []
  consent.forEach((text, index) => add(text, index === 0 ? factoryTextLine(factory, pluginRoot) : null))
  if (!noninteractive) for (const text of improvementInstructions(improvement)) add(text)
  add("If the next step needs something that is not on this machine (a branch, a file, a clone), say what is missing and stop; never recreate or simulate it. Never clone or fetch to look for something the card says is on another machine, and never clone inside the desk folder; clone a missing repo only where an instruction above says to, at the path it gives.", null)
  add("When you report on a task, say its real status; say 'done' only for a task whose status is done.", null)
  add(`This boot covers the ${AGENT_HOSTS.join(", ")} hosts${agentHost === "unknown" ? "" : `; this session looks like ${agentHost}`}.`, null)
  return out
}

function buildInstructions(ctx) {
  return buildInstructionItems(ctx).map((item) => item.text)
}

// The three closing rules that `--json` carries as separate lines, as one instruction, plus the step-heading rule.
const CLOSING_RULES = "In every reply: if the next step needs something that is not on this machine (a branch, a file, a clone), say what is missing and stop, and never recreate or simulate it; never clone or fetch to look for something the card says is on another machine, never clone inside the desk folder, and clone a missing repo only where an instruction above says to, at the path it gives; give each task's real status and say 'done' only for a task whose status is done; do not print Desk skill step headings."

// What the reply must open with when the sync did not go cleanly, from the sync summary's own words (never a placeholder): a failed sync, or a pull that worked but left the desk's uncommitted changes in conflict.
function syncOpening(summary) {
  const failed = /^sync failed: (.+?); nothing was pulled or pushed;/u.exec(summary)
  if (failed !== null) return { say: `Desk could not sync with origin (${failed[1]}); working from local state`, lead: "Desk could not sync" }
  const conflict = /^sync: the pull succeeded, but (.+)$/u.exec(summary)
  if (conflict !== null) return { say: `Desk pulled from origin, but ${conflict[1]}`, lead: "Desk pulled but could not finish syncing" }
  return null
}
const syncRule = ({ say, lead }) => `${lead}: open your reply with \"${say}\" before anything else, and never use \"synced\" for it.`

// The plain-text wording of the same instructions, in the order the text boot prints them: the closing rules, then the
// factory line, so the factory question never comes before the work.
function buildTextInstructions(ctx) {
  const plain = buildInstructionItems(ctx).map((item) => item.plain).filter((line) => line !== null)
  const factoryAt = plain.findIndex((line) => line.startsWith("Factory consent is undecided"))
  // A boot degraded by a failed sync adds how to say it (round S2: the headline said "sync failed" and the reply said "Desk synced locally").
  const opening = syncOpening(ctx.syncSummaryText)
  plain.splice(factoryAt === -1 ? plain.length : factoryAt, 0, opening === null ? CLOSING_RULES : `${CLOSING_RULES} ${syncRule(opening)}`)
  return plain
}

function withinBudget(promise, ms, timeoutValue) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), Math.max(ms, 0))
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * One call replacing session-start's mechanical steps (migration check, host
 * probe, prereq probe, sync, active-task scan, card validation, push-account
 * resolution, repo fetch and open-PR lookup, named-task resolution,
 * factory-consent context): see the module header for the full result shape
 * and the design choices behind it. `taskQuery`, when given, names the task
 * the operator wants to resume.
 */
export async function bootOnce({
  env = process.env,
  cwd = process.cwd(),
  now = Date.now,
  budgetMs = DEFAULT_BUDGET_MS,
  taskQuery = null,
  spawnGit = spawnSync,
  homeDir = env.HOME || os.homedir(),
  gh: ghArg,
  ghAuth: ghAuthArg,
  authOptions = {},
  jq = commandRunner("jq"),
  pluginRoot = DESK_PLUGIN_ROOT,
  migrationsFn = pendingMigrations,
  syncFn = syncWorkspace,
  activeTasksFn = activeTasks,
  walkFn = walkTaskCards,
  repoFn = repoStates,
  localOnlyFn = recordLocalOnlyOnCards,
  prFn = openPullRequests,
  factoryStatusFn = factoryStatus,
  improvementFn = improvementBootCheck,
  lastSyncFn = lastSyncedAt,
  cardGuardFn = installCardGuard,
  agentsFn = readAgentsMd,
  staleDeskFn = checkStaleDesk,
  nestedCards = NESTED_CARD_FIELDS,
  unsignedFn = recordUnsigned,
} = {}) {
  const gh = ghArg ?? ghRunner({ env })
  const ghAuth = ghAuthArg ?? (ghArg ?? commandRunner("gh", { env }))
  const deadline = now() + budgetMs
  const host = { ...probeHost({ env, now }), agent: detectAgentHost(env) }

  const degraded = []
  const pending = []

  // Migrations settle before anything touches `$DESK/`: a stale pre-migration
  // path must never be scanned or synced.
  let migrationEntries = []
  try {
    migrationEntries = await migrationsFn({ pluginRoot, env, cwd })
  } catch (error) {
    degraded.push(`migrations: ${error.message}`)
  }
  for (const entry of migrationEntries) {
    if (entry.state === "unchecked") pending.push(`migration ${entry.id}: not checked in time`)
    if (entry.state === "restart" || entry.state === "run") degraded.push(`migration ${entry.id}: ${entry.state === "restart" ? "needs a restart" : entry.reason}`)
  }
  const migrationSummary = migrationEntries.map((entry) => ({ id: entry.id, state: entry.state }))
  const stopForMigration = migrationEntries.some((entry) => entry.state === "restart" || entry.state === "run")

  const root = resolveBootRoot({ env, cwd, homeDir })
  if (root.status === "setup_required") {
    return { ...emptyResult({ status: root.status, degraded, pending, root, host }), migrations: migrationSummary, instructions: [
      "No desk is bound on this host: this is a first run, not an outage. Hand off to desk:first-run-bootstrap Entrance A (or the onboarding path desk_status names in `onboarding_skill`, such as an overlay's own) and skip the rest of session-start.",
    ] }
  }
  if (root.status === "degraded") {
    // `resolveBootRoot` only ever reaches "degraded" through a thrown error
    // that `util/paths.js` (directly, or via `loadActivationConfig`'s
    // `codedError` wrapping) always attaches both `.message` and `.path` to,
    // so neither field falls back to a placeholder here.
    degraded.push(`root: ${root.message}`)
    return { ...emptyResult({ status: root.status, degraded, pending, root, host }), migrations: migrationSummary, instructions: [
      `Stop: the desk configured at ${root.path} is missing or unreadable. Restore or clone it there, or rebind through desk:first-run-bootstrap with the operator's agreement. Never use a different desk to work around this.`,
    ] }
  }
  if (stopForMigration) {
    const instructions = migrationEntries.map((entry) => migrationLine([entry], pluginRoot).replace(/^Desk migrations: /u, ""))
    return { ...emptyResult({ status: "degraded", degraded, pending, root, host }), instructions, migrations: migrationSummary }
  }

  // A headless evaluator session changes nothing in the desk: no card guard, no sync, no stale refresh.
  const headless = isHeadlessFactorySession(env)
  // The stale-Desk lookup runs alongside everything below; it has its own hard budget and never rejects.
  const staleDesk = Promise.resolve()
    .then(() => (headless ? null : staleDeskFn({ env, pluginRoot, agentHost: host.agent, now })))
    .catch(() => null)

  // The desk's own pre-commit hook (refuses a hand commit that changes a task card; see desk/card-commit-guard.js). Installing is idempotent and quiet;
  // only a failure to install is worth a line.
  try {
    const guard = headless ? { state: "skipped" } : cardGuardFn(root.path, { spawnGit })
    if (guard.state === "failed") degraded.push(`card guard: ${guard.reason}`)
    // A tracked hooks folder is the team's choice, not a fault: one note with the manual remedy, nothing degraded.
    if (guard.state === "tracked") pending.push(`card guard not installed: ${guard.reason}; ${guard.remedy}`)
  } catch (error) {
    degraded.push(`card guard: ${error.message}`)
  }

  const prereqs = await checkPrereqs({ gh, jq, ghAuth, authOptions })
  for (const [name, check] of Object.entries(prereqs)) {
    if (check.ok) continue
    if (check.soft === true) {
      pending.push(`${name}: Could not verify GitHub sign-in (${check.why}); continuing; pushes may fail until it clears`)
    } else if (check.reason.endsWith("_timeout")) {
      pending.push(`${name}: ${check.reason}`)
    } else {
      degraded.push(`${name}: ${check.reason}`)
    }
  }

  let sync = null
  let syncTimedOut = false
  try {
    const synced = headless ? { state: "skipped", nothingToSync: "headless" } : await withinBudget(syncFn({ root: root.path, env }), Math.min(SYNC_BUDGET_MS, deadline - now()), { timedOut: true })
    if (synced.timedOut === true) {
      syncTimedOut = true
      pending.push("sync: boot_budget_exceeded")
    } else sync = synced
  } catch (error) {
    degraded.push(`sync: ${error.message}`)
  }
  const syncProblem = syncDegradation(sync)
  if (syncProblem !== null) degraded.push(syncProblem)
  let lastSyncAt = null
  try {
    lastSyncAt = lastSyncFn({ root: root.path, env })
  } catch {
    lastSyncAt = null
  }
  const syncSummaryText = syncSummary({ sync, timedOut: syncTimedOut, lastSyncAt, root: root.path })
  // The desk's own rules, read after the sync so a pull that changed them is already in. Never throws.
  let agentsMd = null
  try {
    agentsMd = agentsFn(root.path)
  } catch {
    agentsMd = null
  }

  let tasks = null
  try {
    tasks = activeTasksFn(root.path)
  } catch (error) {
    degraded.push(`active_tasks: ${error.message}`)
  }

  let cards = []
  let cardValidationResult = []
  try {
    cards = walkFn(root.path)
    cardValidationResult = cardValidation(root.path, () => cards, { nested: nestedCards })
  } catch (error) {
    degraded.push(`card_validation: ${error.message}`)
  }
  if (!nestedCards) {
    const why = runtimeResolverFailure()
    pending.push(`card repos: not validated, gray-matter is not installed (the dependency-free reader cannot parse repos lists)${why === null ? "" : `; restoring the runtime dependencies failed: ${redactCredentialLikeText(why)}`}`)
  }
  if (cardValidationResult.length > 0) {
    degraded.push(`${cardValidationResult.length} task card${cardValidationResult.length === 1 ? "" : "s"} with corrupted frontmatter`)
  }

  let pushAccounts = []
  try {
    pushAccounts = await resolvePushAccounts({ root: root.path, cards, runner: withAmbientToken(gh, env), now, deadlineMs: Math.max(deadline - now(), 0), spawnGit, homeDir })
  } catch (error) {
    degraded.push(`push_accounts: ${error.message}`)
  }
  for (const entry of pushAccounts) {
    const where = cardLocation(entry)
    if (entry.result === "no_account_can_deliver") {
      degraded.push(`push account: no signed-in account can push ${entry.store} for ${where}`)
    } else if (entry.result === "pending") {
      pending.push(`push account for ${entry.store} (${where}): ${entry.reason}`)
    } else if (entry.result !== "account_found" && entry.result !== "not_a_github_repo") {
      degraded.push(`push account: ${entry.store} (${where}) — ${entry.result}`)
    }
  }

  let repoStateList = []
  try {
    const found = repoFn({ cards, root: root.path, spawnGit, homeDir, now, deadline })
    repoStateList = found.states
    pending.push(...found.pending)
  } catch (error) {
    degraded.push(`repo_states: ${error.message}`)
  }
  // A clone seen with no remote and no card url is recorded on its card as local-only, once: the only record the done
  // check trusts for a commit with nowhere to push (`tools/local-only.js`).
  try {
    await localOnlyFn({ cards, deskRoot: root.path, spawnGit, homeDir })
  } catch {
    // Recording is a convenience and never a reason to degrade a boot.
  }

  let openPrs = []
  try {
    const stores = [...new Set(pushAccounts.filter((entry) => typeof entry.store === "string").map((entry) => entry.store))]
    const found = await prFn({ stores, runner: ghAuth, now, deadline })
    openPrs = found.prs
    pending.push(...found.pending)
  } catch (error) {
    degraded.push(`open_prs: ${error.message}`)
  }

  // A stored token GitHub refused while the push routes were checked: say so once per account, as a warning.
  for (const account of new Set(pushAccounts.flatMap((entry) => (Array.isArray(entry.accounts) ? entry.accounts.filter((item) => item.reason === "auth_failed").map((item) => item.account) : [])))) {
    pending.push(`auth: GitHub rejected the stored sign-in for ${account}; pushes as ${account} will fail until you run \`gh auth login --hostname github.com\``)
  }

  let factory = null
  try {
    factory = factoryStatusFn({ env, deskRoot: root.path })
  } catch (error) {
    degraded.push(`factory: ${error.message}`)
  }

  // The delivered tasks that await the operator's sign-off; the counts go to status.json.
  let unsigned = null
  try {
    unsigned = await unsignedFn(env, root.path, now())
  } catch {
    unsigned = null
  }

  // The improvement cards the session may take: nothing is read for a session with no operator in it.
  let improvement = null
  if (root !== null && !isNoninteractive(env)) {
    try {
      // The person the Desk tools resolve, without a network call; a bad DESK_PERSON never stops the boot.
      const who = await improvementPerson({ deskRoot: root.path, env, now: now() })
      improvement = who.status !== "ok"
        ? { status: "unchecked", reason: who.reason }
        : await withinBudget(improvementFn({ deskRoot: root.path, personPrefix: who.personPrefix, env, now: now() }), Math.min(IMPROVEMENT_BUDGET_MS, deadline - now()), null)
      if (improvement === null) pending.push("improvement: boot_budget_exceeded")
    } catch (error) {
      degraded.push(`improvement: ${error.message}`)
    }
  }

  let task = null
  if (taskQuery !== null) {
    const resolved = resolveTaskQuery(taskQuery, cards, root.path)
    if (resolved.status === "resolved") {
      const { file, ...shown } = resolved.task
      const recorded = hostLineHostname(readCardText(file) ?? "")
      task = { status: "resolved", task: { ...shown, remote_repos: remoteRepoNames(cards.find((card) => card.file === file), { root: root.path, homeDir }) }, host_line_changed: recorded !== null && recorded !== host.hostname }
    } else {
      task = resolved
    }
  }

  const staleFinding = await staleDesk
  const status = healthWord(degraded)
  const instructionContext = { root, prereqResults: prereqs, pushAccounts, cardValidationResult, sync, factory, task, host, migrationEntries, pluginRoot, taskQuery, agentHost: host.agent, noninteractive: isNoninteractive(env), repoStateList, syncSummaryText, unsigned, improvement }
  const instructions = buildInstructions(instructionContext)
  return {
    boot_complete: true,
    status,
    degraded,
    pending,
    instructions,
    covers_hosts: AGENT_HOSTS,
    root,
    host,
    migrations: migrationSummary,
    prereqs,
    sync,
    sync_summary: syncSummaryText,
    agents_md: agentsMd,
    active_tasks: tasks,
    card_parser: parserName(nestedCards),
    card_validation: cardValidationResult,
    push_accounts: pushAccounts,
    repo_states: repoStateList,
    open_prs: openPrs,
    task,
    factory,
    stale_desk: staleFinding,
    needs_operator: needsOperator(instructionContext),
    // Only for the plain-text boot (`runBootCli` leaves it out of `--json`).
    text_instructions: buildTextInstructions(instructionContext),
    unsigned_deliveries: unsigned,
  }
}

/** `--task <query>` and `--json` from the command line: the named task or null, and whether to print the structured result. */
export function parseBootArgs(argv) {
  const index = argv.indexOf("--task")
  // `--task --json` names no task: a flag is never the query.
  const value = index === -1 ? undefined : argv[index + 1]
  return {
    taskQuery: typeof value === "string" && value.trim() !== "" && !value.startsWith("--") ? value : null,
    json: argv.includes("--json"),
  }
}

/**
 * The CLI entrypoint: prints `bootOnce`'s result as readable text (or, with `--json`, as one line of JSON for tools and
 * tests) and always exits 0 — a boot script must never block session start.
 */
export async function runBootCli({ argv = [], env = process.env, io = process, bootFn = bootOnce, refreshOptions = {} }) {
  const { taskQuery, json } = parseBootArgs(argv)
  let result
  try {
    result = await bootFn({ env, taskQuery })
  } catch (error) {
    result = emptyResult({
      status: "degraded",
      degraded: [`boot: ${error.message}`],
      pending: [],
      instructions: ["The boot script failed unexpectedly: check `gh --version`, `jq --version` and `gh auth status` by hand, and record the failure as friction."],
      root: null,
      host: null,
    })
  }
  const finding = result.stale_desk ?? null
  // A stale Desk is refreshed on its own host, but only after the boot output is written, and by a detached runner: boot never waits for it.
  const options = { finding, env, pluginRoot: DESK_PLUGIN_ROOT, agentHost: result.host?.agent, root: result.root?.path ?? null, ...refreshOptions }
  const prepared = finding === null ? { state: "unavailable" } : planStaleRefresh(options)
  if (finding !== null) {
    const started = prepared.state === "ready"
    result = { ...result, stale_desk: { ...finding, auto_refresh: started ? "started" : prepared.state, line: started ? startedLine(finding, prepared.plan) : finding.line } }
  }
  const { text_instructions: _textOnly, ...structured } = result
  io.stdout.write(json ? `${JSON.stringify(structured)}\n` : formatBootText(result))
  if (prepared.state === "ready") startStaleRefresh({ ...options, prepared })
  return 0
}
