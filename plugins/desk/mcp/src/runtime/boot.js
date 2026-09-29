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
// actions, root, host, desk_export_line, prereqs, sync, active_tasks,
// card_validation, push_accounts, factory }`. `status` is one of "ready",
// "degraded" or "setup_required" — never two words, and `degraded` always
// lists why. `actions` names concrete next steps, each naming the task,
// repo or file it is about. `boot_complete` is always `true`: it marks that
// the script finished and returned a complete result, not that everything
// it found is healthy.

import { spawn as nodeSpawn, spawnSync } from "node:child_process"
import { closeSync, openSync, readdirSync, readSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { normalizeRemote } from "../factory/binding.js"
import { ghRunner, chooseAccount } from "../factory/flush.js"
import { PATTERNS } from "../factory/schema.js"
import { activeTasks } from "../desk/active-tasks.js"
import { folderHandle } from "../desk/handles.js"
import { loadFrontmatterParser } from "../desk/organization.js"
import { factoryStatus } from "../tools/factory-context.js"
import {
  claudeBindingPath,
  DESK_ROOT_NOT_FOUND,
  expandHome,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "../util/paths.js"
import { redactCredentialLikeText, redactName } from "../util/redact.js"
import { readSmallText } from "../factory/marker.js"
import { syncWorkspace } from "./session-sync.js"

const parseFrontmatter = loadFrontmatterParser()

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

const AUTH_STALE = /no longer valid|not logged into|you are not logged/iu

function evaluateAuth(result) {
  if (result.spawnError) return { ok: false, reason: "gh_missing", detail: "the `gh` binary was not found on PATH" }
  if (result.timedOut) return { ok: false, reason: "auth_timeout", detail: "`gh auth status` did not respond in time" }
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  if (AUTH_STALE.test(text)) return { ok: false, reason: "auth_stale", detail: trimmed(text, 500) }
  if (result.code !== 0) return { ok: false, reason: "auth_error", detail: trimmed(text, 500) }
  return { ok: true }
}

/**
 * The five-part prereq probe (`session-start/SKILL.md` Step 0.75), as one
 * call: `{ gh: {ok, version?, reason?, detail?}, jq: {...}, auth: {...} }`.
 * Every check resolves rather than rejects — a missing binary, a timeout or
 * a nonzero exit all come back as `{ ok: false, reason, detail }`, never a
 * thrown error.
 */
export async function checkPrereqs({ gh = ghRunner(), jq = commandRunner("jq"), timeoutMs = 8000 } = {}) {
  const [ghVersion, jqVersion, authStatus] = await Promise.all([
    gh(["--version"], { timeoutMs }),
    jq(["--version"], { timeoutMs }),
    gh(["auth", "status", "--hostname", "github.com"], { timeoutMs }),
  ])
  return { gh: evaluateGh(ghVersion), jq: evaluateJq(jqVersion), auth: evaluateAuth(authStatus) }
}

// ── Task-card frontmatter validation ────────────────────────────────────

const MAX_CARD_BYTES = 64 * 1024
const VALID_STATUSES = new Set(["drafting", "processing", "validating", "collaborating", "paused", "blocked", "done", "cancelled"])
const TERMINAL_STATUSES = new Set(["done", "cancelled"])
const REQUIRED_TEXT_FIELDS = ["title", "status", "created", "updated", "track"]

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
export function cardProblems(data) {
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
    if (typeof data[field] !== "string" || data[field].trim() === "") problems.push(`\`${field}\` is missing or not a string`)
  }
  if (typeof data.status === "string" && !VALID_STATUSES.has(data.status)) {
    problems.push(`\`status: ${data.status}\` is not one of the task-lifecycle states`)
  }
  for (const field of ["created", "updated"]) {
    if (typeof data[field] === "string" && Number.isNaN(Date.parse(data[field]))) {
      problems.push(`\`${field}\` is not a parseable timestamp`)
    }
  }
  if (!corrupted.has("repos")) {
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
export function cardValidation(root, walk = walkTaskCards) {
  const results = []
  for (const card of walk(root)) {
    const problems = cardProblems(card.data)
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
function resolveLocalStore(localPath, { spawnGit, homeDir, timeoutMs }) {
  if (typeof localPath !== "string" || localPath.trim() === "") return null
  const resolved = expandHome(localPath, homeDir)
  const result = spawnGit("git", ["-C", resolved, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: timeoutMs })
  if (!result || result.status !== 0 || typeof result.stdout !== "string") return null
  const url = result.stdout.trim()
  if (url === "") return null
  const normalized = normalizeRemote(url)
  const match = /^https:\/\/github\.com\/(.+)$/u.exec(normalized)
  return match !== null && PATTERNS.prRepo.test(match[1]) ? match[1] : null
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
 * account resolution the factory consent step (Step 2.7) uses, asking each
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
        store = resolveLocalStore(repo.local_path, { spawnGit, homeDir, timeoutMs: 5000 })
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

// ── Orchestrator ────────────────────────────────────────────────────────

const DEFAULT_BUDGET_MS = 45000

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
    return "Re-authenticate: run `gh auth login --hostname github.com`."
  }
  return `Fix the ${name} prerequisite (${check.reason}) before continuing.`
}

function cardLocation(entry) {
  return entry.desk ? `desks/${entry.desk}/${entry.track}/${entry.slug}` : `${entry.track}/${entry.slug}`
}

function emptyResult({ status, degraded, pending, actions, root, host }) {
  return {
    boot_complete: true,
    status,
    degraded,
    pending,
    actions,
    root,
    host,
    desk_export_line: null,
    prereqs: null,
    sync: null,
    active_tasks: null,
    card_validation: [],
    push_accounts: [],
    factory: null,
  }
}

/**
 * One call replacing session-start's mechanical steps (host probe, prereq
 * probe, sync, active-task scan, card validation, push-account resolution,
 * factory-consent context): see the module header for the full result
 * shape and the design choices behind it.
 */
export async function bootOnce({
  env = process.env,
  cwd = process.cwd(),
  now = Date.now,
  budgetMs = DEFAULT_BUDGET_MS,
  spawnGit = spawnSync,
  homeDir = env.HOME || os.homedir(),
  gh = ghRunner({ env }),
  jq = commandRunner("jq"),
  syncFn = syncWorkspace,
  activeTasksFn = activeTasks,
  walkFn = walkTaskCards,
  factoryStatusFn = factoryStatus,
} = {}) {
  const deadline = now() + budgetMs
  const host = probeHost({ env, now })
  const root = resolveBootRoot({ env, cwd, homeDir })

  const degraded = []
  const pending = []
  const actions = []

  if (root.status === "setup_required") {
    actions.push("No desk is bound yet on this host; hand off to desk:first-run-bootstrap.")
    return emptyResult({ status: root.status, degraded, pending, actions, root, host })
  }
  if (root.status === "degraded") {
    // `resolveBootRoot` only ever reaches "degraded" through a thrown error
    // that `util/paths.js` (directly, or via `loadActivationConfig`'s
    // `codedError` wrapping) always attaches both `.message` and `.path` to,
    // so neither field falls back to a placeholder here.
    degraded.push(`root: ${root.message}`)
    actions.push(`Restore or clone the desk at ${root.path}, or rebind through desk:first-run-bootstrap with the operator's agreement.`)
    return emptyResult({ status: root.status, degraded, pending, actions, root, host })
  }

  const prereqs = await checkPrereqs({ gh, jq })
  for (const [name, check] of Object.entries(prereqs)) {
    if (check.ok) continue
    if (check.reason.endsWith("_timeout")) {
      pending.push(`${name}: ${check.reason}`)
    } else {
      degraded.push(`${name}: ${check.reason}`)
      actions.push(prereqAction(name, check))
    }
  }

  let sync = null
  try {
    sync = await syncFn({ root: root.path, env })
  } catch (error) {
    degraded.push(`sync: ${error.message}`)
  }
  if (sync?.state === "unresolved") {
    degraded.push(`sync: unresolved${sync.reason ? ` (${sync.reason})` : ""}`)
    actions.push(`Resolve the desk's git conflict before continuing: run \`git status\` in ${root.path}.`)
  } else if (sync?.state === "quarantined") {
    actions.push(`Sync quarantined ${sync.quarantinedPaths?.length ?? 0} stray path(s) at ${root.path}; review them under _cache/ when convenient.`)
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
    cardValidationResult = cardValidation(root.path, () => cards)
  } catch (error) {
    degraded.push(`card_validation: ${error.message}`)
  }
  if (cardValidationResult.length > 0) {
    degraded.push(`${cardValidationResult.length} task card${cardValidationResult.length === 1 ? "" : "s"} with corrupted frontmatter`)
  }
  for (const entry of cardValidationResult) {
    actions.push(`Fix the frontmatter in ${cardLocation(entry)}/task.md (handle ${entry.handle}): ${entry.problems.join("; ")}.`)
  }

  let pushAccounts = []
  try {
    pushAccounts = await resolvePushAccounts({ root: root.path, cards, runner: gh, now, deadlineMs: Math.max(deadline - now(), 0), spawnGit, homeDir })
  } catch (error) {
    degraded.push(`push_accounts: ${error.message}`)
  }
  for (const entry of pushAccounts) {
    const where = cardLocation(entry)
    if (entry.result === "no_account_can_deliver") {
      degraded.push(`push account: no signed-in account can push ${entry.store} for ${where}`)
      actions.push(`Task ${where}'s repo ${entry.store} cannot be pushed by any signed-in account; do not push there. Ask the operator which account to use, or fork.`)
    } else if (entry.result === "pending") {
      pending.push(`push account for ${entry.store} (${where}): ${entry.reason}`)
    } else if (entry.result !== "account_found" && entry.result !== "not_a_github_repo") {
      degraded.push(`push account: ${entry.store} (${where}) — ${entry.result}`)
    }
  }

  let factory = null
  try {
    factory = factoryStatusFn({ env, deskRoot: root.path })
  } catch (error) {
    degraded.push(`factory: ${error.message}`)
  }

  return {
    boot_complete: true,
    status: degraded.length > 0 ? "degraded" : "ready",
    degraded,
    pending,
    actions,
    root,
    host,
    desk_export_line: `export DESK=${root.path}`,
    prereqs,
    sync,
    active_tasks: tasks,
    card_validation: cardValidationResult,
    push_accounts: pushAccounts,
    factory,
  }
}

/** The CLI entrypoint: prints `bootOnce`'s result as one line of JSON and always exits 0 — a boot script must never block session start. */
export async function runBootCli({ env = process.env, io = process, bootFn = bootOnce } = {}) {
  let result
  try {
    result = await bootFn({ env })
  } catch (error) {
    result = emptyResult({
      status: "degraded",
      degraded: [`boot: ${error.message}`],
      pending: [],
      actions: ["The boot script failed unexpectedly; run session-start's steps by hand and record this as friction."],
      root: null,
      host: null,
    })
  }
  io.stdout.write(`${JSON.stringify(result)}\n`)
  return 0
}
