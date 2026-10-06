// The real readers `bindSession` is given: a task card's frontmatter, the
// desk's Git history, and the name of a code repository. All are read-only.
//
// `readTask(track, slug)` reads `<deskRoot>/[<personPrefix>/]<track>/<slug>/
// task.md`, else `<track>/_archive/<slug>/task.md`, else, for a whole
// archived track, `_archive/<track>/<slug>/task.md` or
// `_archive/<track>/_archive/<slug>/task.md`, and returns `{ status,
// created_at, updated_at, repos }` from its frontmatter (the YAML between the first
// two `---` lines, anywhere within the first 16 KiB), or `null` when none
// of the four exist. Only top-level `key: value` lines are read, quotes and
// a trailing ` # comment` stripped. A status outside `ENUMS.jobStatus`, or a
// time `normalizeTimestamp` refuses (a bare date, say), is `null`, never a
// guess; an unreadable card gives all three `null` and no repos. `repos` is
// the card's `repos:` list reduced to names (see `parseRepos`): `owner/name`
// where the card or its GitHub `url` gives one, else the bare name, never a
// path or any other field. When no card sits at the given `track/slug`, the
// desk's Git rename history of task cards is asked once per `HEAD` (`git log
// -M --diff-filter=R -p`, cached) where the task folder went, live or
// archived, following chains; a pairing that changes the card's `created:`
// is a deleted card and a new one, never a move. A deleted, never-renamed
// folder, a failed Git call and a desk that is not its own repository all
// read as `null`.
//
// `repoOfPath(absolutePath)` names the code repository a path outside the
// desk is in, as lowercase `owner/name`, from the `origin` remote of the
// nearest folder at or above the path that still exists; `null` when there is
// none to name and for the desk itself. It is asked once per repository
// (`createDeskReaders` has the details). Only the name is returned, never the
// path or the remote.
//
// `repoLookup(absolutePath)` is the one reader `bindSession` uses. It answers
// `{ repo }`, `{ none: true }` (the folder exists and is in no repository, or
// in one with no origin) or `{ unavailable: true }` (the folder is gone, any
// other stat error, a Git failure or a timeout), so a caller cannot take
// evidence that could not be read for a true none. `repoOfPath` is its name
// or `null`.
//
// `deskCommitsBetween(startIso, endIso)` lists the commits this clone made
// in the window: the reflog entries of `HEAD` and every local branch whose
// subject starts `commit:`, `commit (initial):`, `commit (amend):` or
// `commit (merge):` (so a desk's first commit can bind too), and
// whose reflog time (when this clone made the commit, to the second) falls
// in the window. Git is asked with both `--since` and `--until`. Fetched,
// pulled, rebased, checked-out and `git merge` entries are not commits this
// clone made, so another clone's or machine's commit never appears, and a
// commit later rebased keeps its original entry, SHA and time. Each is `{
// sha, committed_at, taskPaths }`, `committed_at` being the reflog time and
// `taskPaths` the desk-relative paths the commit changed (renames as a
// delete and an add; for a merge, only the files that differ from every
// parent, which is what the merge's author resolved). The reflog subject
// holds the commit message; it is matched in memory and never returned.
// `bindSession` decides which paths are task folders. `gitCommitTaskPaths(
// sha)` lists one commit's paths, with `exists: false` for a SHA not in the
// desk. `isCardHousekeeping(sha, path)` judges one commit's change to one
// card: true when `path`'s content in the commit (found through Git's own
// rename detection, so a move or rename is paired with its other side) is
// identical to its content before, or differs only in frontmatter `title:`,
// `track:` or `updated:`; false for anything else, including a path this
// commit only added or only removed, and including any git failure —
// housekeeping is never a guess. Two more differences are absorbed before
// that comparison, both aimed at what a real Desk tidy actually does to a
// card it only moves or renames, never at a card someone edited by hand:
// (1) a frontmatter scalar's surrounding quotes (`"value"`, `'value'` or
// unquoted) are normalized before comparing, since a YAML re-serialization
// can flip a value's quoting without changing it — a value whose quoted form
// holds a backslash or the quote character itself is left exactly as
// written instead, so an escape is never guessed at; (2) the commit's own
// rename pairs (its `R` entries) are used to rewrite the old card's text —
// full file-to-file, and directory-to-directory wherever the renamed file's
// old and new paths share a trailing suffix — so a reference to a path this
// same commit also moved reads as unchanged too. A pathological commit with
// more rename pairs than `RENAME_PAIR_CAP` is never housekeeping, rather
// than spend unbounded time deriving substitutions from it. `readDeskRemote`
// returns `origin`'s URL, or `null`.
//
// The desk must be a repository of its own: Git's top level for the desk
// root must be the desk root's real path (checked as an empty
// `rev-parse --show-prefix`). Otherwise (a desk inside a
// dotfiles repository at `$HOME`, say) Git would walk up and read another
// repository's history and remote, so the commit readers find nothing and
// `readDeskRemote` returns `null`.
//
// Git runs with `GIT_*` variables removed (a hook's `GIT_DIR` must not point
// it elsewhere), no prompts, and a timeout. Any failure reads as "nothing
// found", never a throw.
//
// `resolveJobIdentity({ deskRoot, personPrefix, track, slug, git, timeoutMs,
// deadline, clock }) -> { track, slug }` is a job's identity
// (ourostack/desk#76): the birth path — the `track/slug` the task's card,
// `task.md`, was first added at — found by following its *current* path's
// rename history with Git's own `--follow` (`git log --follow
// --diff-filter=A`, chasing through `-M`-equivalent rename detection, so a
// track rename, a task move and an archive move all keep the same birth
// path; a reverted rename walks back through both hops to the same
// original). A birth Git found under another path whose card's `created:`
// differs from the current card's is an unrelated deleted card that Git's
// similarity paired with this one (cards share a template), so the card's
// own path is its birth instead. No card field is written for this — it works
// retroactively, from history alone — and it falls back to the given `{
// track, slug }`, unchanged, whenever Git cannot settle the question: the
// card is found neither live nor archived (in a live track, an archived
// task within a live track, a whole archived track, or an archived task
// within an archived track — the same four shapes `finishedTasks` scans),
// the desk is not a Git repository of its own, the card has no Git history
// yet (new and uncommitted), or any ordinary Git call fails. A card just
// moved but not yet committed (right after `task_move`, before the agent's
// own commit) resolves to the *current* path until that commit lands: this
// is expected, not a bug, and is expected to become rare once Desk tools
// commit their own writes. With `deadline` (a value of `clock`, same
// contract as `readDeskRemote`'s), every Git call this makes shares it, and
// a call that reaches the deadline, or finds none left to start one, throws
// an error whose code is `git_deadline` instead of falling back — the one
// exception to "never throws for a Git reason". Without a `deadline` it
// never throws for a Git reason, only for a bad `personPrefix`
// (`checkPersonPrefix`'s own contract) or a `deskRoot` that is not an
// absolute path.
//
// Git's `--diff-filter=A` can list more than one add for the same current
// name: a card deleted and later re-created at the same path is one
// literal-path history, delete included, so the *newest* add — the current
// lineage's own creation — is the one kept, never an unrelated predecessor's
// (a rename risks the same confusion one hop further back: a deleted task
// that once passed through this exact name on its way somewhere else must
// not lend its history to whatever is here now). Two tasks that swap slugs
// in the same commit each keep the birth they already had: a path Git sees
// on both sides of one commit is a modification, never a rename candidate,
// so nothing here reads a same-commit swap as an identity change.
//
// Cached for this process — the desk's own-repository check, and the birth
// path for one desk root and one card path — since binding may resolve many
// tasks in one call. The birth-path cache is keyed on path alone, so it is
// invalidated whenever the desk's `HEAD` moves: a card path that is vacated
// (its task renamed or moved away) and later reoccupied by a different task
// within the same long-lived process must not return the first task's
// birth just because the path matches, so every call records `HEAD` and
// clears every cached birth path for the desk root when it differs from
// what an earlier call last saw. The own-repository check is not treated
// the same way: whether the desk root is Git's top level is a fact about
// the repository's structure, not its history, so it is not a function of
// `HEAD` and a commit landing does not make a cached answer stale.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import * as path from "node:path"

import { checkPersonPrefix, isTaskSegment, normalizeRemote, relativeSegments, taskOfSegments } from "./binding.js"
import { recordFromLines } from "./outcome.js"
import { ENUMS, PATTERNS } from "./schema.js"
import { normalizeTimestamp } from "./time.js"

const READ_BYTES = 16 * 1024
const DEFAULT_TIMEOUT_MS = 20_000

// `resolveJobIdentity`'s process-lifetime caches: a desk root's real path ->
// is it its own Git repository (never invalidated: see the header); "<that
// real path>\u0000<repo-relative card path>" -> the birth `{ track, slug }`
// already found for it (invalidated per root when `HEAD` moves); and a desk
// root's real path -> the `HEAD` commit its birth-path cache entries were
// last validated against.
const REPO_CHECK_CACHE = new Map()
const BIRTH_PATH_CACHE = new Map()
const REPO_HEAD_CACHE = new Map()
// A desk root and person alias -> `{ head, renames }`: the task-folder
// renames found once for that `HEAD` (see `taskRenameLookup`).
const RENAME_CACHE = new Map()

export function gitEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value
  }
  env.GIT_TERMINAL_PROMPT = "0"
  env.LC_ALL = "C"
  return env
}

// `strict`: a call that timed out or was killed by a signal throws `git_deadline` whatever it printed, instead of reading as "nothing found".
function runGit({ git, deskRoot, timeoutMs, spawn = spawnSync, strict = false }, args) {
  const result = spawn(git, ["-C", deskRoot, "-c", "core.quotePath=false", "-c", "log.showSignature=false", ...args], {
    encoding: "utf8",
    env: gitEnv(),
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (strict && (result.error?.code === "ETIMEDOUT" || result.signal)) throw gitDeadline()
  return result.status === 0 ? result.stdout : null
}

// ---------------------------------------------------------------------------
// Task cards.
// ---------------------------------------------------------------------------

function readHead(file) {
  let descriptor
  try {
    descriptor = openSync(file, "r")
  } catch (error) {
    return error.code === "ENOENT" || error.code === "ENOTDIR" ? null : ""
  }
  try {
    const buffer = Buffer.alloc(READ_BYTES)
    const length = readSync(descriptor, buffer, 0, READ_BYTES, 0)
    return buffer.toString("utf8", 0, length)
  } catch {
    return ""
  } finally {
    closeSync(descriptor)
  }
}

function unquote(raw) {
  const value = raw.trim()
  const quoted = /^(["'])(.*)\1(?:\s+#.*)?$/u.exec(value)
  if (quoted) return quoted[2]
  return value.replace(/\s+#.*$/u, "").trim()
}

function frontmatterLines(text) {
  const lines = text.split(/\r?\n/u)
  if (lines[0] !== "---") return []
  const end = lines.indexOf("---", 1)
  return end === -1 ? [] : lines.slice(1, end)
}

function frontmatterOf(lines) {
  const fields = {}
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/u.exec(line)
    if (match && !Object.hasOwn(fields, match[1])) fields[match[1]] = unquote(match[2])
  }
  return fields
}

const NAME_SEGMENT = /^(?!\.+$)[A-Za-z0-9_.-]+$/u
const GITHUB_URL = /^(?:https?:\/\/(?:[^/@\s]+@)?|git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu

// `owner/name` when the text is two safe segments (no empty, `.` or `..`).
const ownerName = (text) => {
  const parts = text.split("/")
  return parts.length === 2 && parts.every((part) => NAME_SEGMENT.test(part)) ? text : null
}

// One `repos:` entry (a name string, or the fields of an object entry) as the
// name it stands for: `owner/name` when `name` is one, else the one parsed
// from a GitHub `url` (even for a name that is not itself a safe name), else
// the bare name when it is a safe single segment; null otherwise, and for no
// name. No other field (`local_path`, `mode`) is ever read out.
function repoName(entry) {
  const name = entry.name ?? ""
  if (name === "") return null
  const own = ownerName(name)
  if (own !== null) return own
  const url = GITHUB_URL.exec(entry.url ?? "")
  const fromUrl = url === null ? null : ownerName(`${url[1]}/${url[2]}`)
  if (fromUrl !== null) return fromUrl
  return NAME_SEGMENT.test(name) ? name : null
}

function flowRepoEntries(value) {
  const inner = /^\[(.*)\]/u.exec(value)
  if (!inner) return []
  return inner[1].split(",").map((item) => ({ name: unquote(item) }))
}

function blockRepoEntries(lines) {
  const entries = []
  let itemIndent = null
  for (const line of lines) {
    if (/^[^\s-]/u.test(line)) break
    const item = /^(\s*)-\s*(.*)$/u.exec(line)
    if (item && (itemIndent === null || item[1].length <= itemIndent)) {
      itemIndent = item[1].length
      const field = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u.exec(item[2])
      entries.push(field ? { [field[1]]: unquote(field[2]) } : { name: unquote(item[2]) })
      continue
    }
    const field = /^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line)
    if (field && entries.length > 0 && !Object.hasOwn(entries.at(-1), field[1])) entries.at(-1)[field[1]] = unquote(field[2])
  }
  return entries
}

// The card's `repos:` list, block or flow form, strings or objects, as
// distinct names in order.
function parseRepos(lines) {
  const at = lines.findIndex((line) => /^repos:/u.test(line))
  if (at === -1) return []
  const value = lines[at].slice("repos:".length).trim()
  const entries = value === "" ? blockRepoEntries(lines.slice(at + 1)) : flowRepoEntries(value)
  return [...new Set(entries.map(repoName).filter((name) => name !== null))]
}

function cardFields(text) {
  const lines = frontmatterLines(text)
  const fields = frontmatterOf(lines)
  return {
    status: ENUMS.jobStatus.includes(fields.status) ? fields.status : null,
    created_at: normalizeTimestamp(fields.created),
    updated_at: normalizeTimestamp(fields.updated),
    repos: parseRepos(lines),
  }
}

// The card's absolute folder — live, an archived task within a live track,
// a whole archived track, or an archived task within an archived track —
// and its raw text, or null when none of the four exist. The one place
// `readTask` and job-identity resolution both look a card up, so they
// always agree on where it lives; `finishedTasks` (`boot-check.js`) walks
// the same four shapes on its own, since it must enumerate every track,
// live and archived, rather than look one up. When none of the four holds
// the card, `renamedKey(track, slug)` (a `[track, slug]` or null; see
// `taskRenameLookup`) says where Git history moved the task folder to, and
// the same four places are searched under that name.
function findCard(base, track, slug, renamedKey) {
  const inFourPlaces = (t, s) => {
    for (const folder of [
      path.join(base, t, s),
      path.join(base, t, "_archive", s),
      path.join(base, "_archive", t, s),
      path.join(base, "_archive", t, "_archive", s),
    ]) {
      const text = readHead(path.join(folder, "task.md"))
      if (text !== null) return { folder, text }
    }
    return null
  }
  const found = inFourPlaces(track, slug)
  if (found !== null) return found
  const moved = renamedKey(track, slug)
  return moved === null ? null : inFourPlaces(moved[0], moved[1])
}

// Whether two cards' `created:` values allow them to be one card: false only
// when both are readable timestamps and differ. Cards share a template, so
// Git's similarity can pair a deleted card with an unrelated new one; the
// creation time the task tools write once, and every move keeps, tells them
// apart. A card without a readable `created:` cannot be told apart and is
// taken as Git paired it.
function sameCreation(before, after) {
  const a = normalizeTimestamp(before)
  const b = normalizeTimestamp(after)
  return a === null || b === null || a === b
}

// The renames of task cards in `git log -M --diff-filter=R -p -U0` output, in
// log order (newest first): `{ oldPath, path }` for each rename whose
// `created:` line is unchanged or not comparable (`sameCreation`). A rename
// whose diff changes a readable `created:` is a deleted card paired with a
// new one, not a move, and is left out.
export function parseCardRenames(output) {
  const renames = []
  for (const block of output.split(/^diff --git /mu).slice(1)) {
    const from = /^rename from (.+)$/mu.exec(block)
    const to = /^rename to (.+)$/mu.exec(block)
    if (from === null || to === null) continue
    const removed = /^-created:(.*)$/mu.exec(block)
    const added = /^\+created:(.*)$/mu.exec(block)
    if (removed !== null && added !== null && !sameCreation(unquote(removed[1]), unquote(added[1]))) continue
    renames.push({ oldPath: from[1], path: to[1] })
  }
  return renames
}

// `(track, slug) -> [track, slug] | null`: where the task folder went, by
// Git's own rename history of task cards (`git log -M --diff-filter=R -p`
// over `task.md` files, one pass per `HEAD`, cached per desk root and person
// alias, since the alias decides which renames count), leaving out a pairing
// that changes the card's creation time (`parseCardRenames`). Follows chains
// in order, live or archived. null for a never-renamed task, a desk that is
// not its own repository, and any Git failure. `runFn(options, args)` is
// `runGit` or a deadline-aware wrapper of it.
function taskRenameLookup(options, alias, runFn) {
  const moves = cardMoves(options, alias, runFn)
  return (track, slug) => {
    const list = moves()
    if (list === null) return null
    const start = `${track}/${slug}`
    let key = start
    for (const move of list) {
      if (move.from === key && !move.merged) key = move.to
    }
    return key === start ? null : key.split("/")
  }
}

// `(track, slug) -> [track, slug] | null`: the task this one was merged into
// with `task_move into_task`, by the same Git history (the merge renames its
// `task.md` to `<keeper>/_iterations/<date>-<slug>/merged-task.md`), after
// any renames before the merge; null when it was never merged, and for any
// Git failure. The keeper is named as it was at the merge; `readTask`
// follows its later renames.
function taskMergeLookup(options, alias, runFn) {
  const moves = cardMoves(options, alias, runFn)
  return (track, slug) => {
    const list = moves()
    if (list === null) return null
    let key = `${track}/${slug}`
    for (const move of list) {
      if (move.from !== key) continue
      if (move.merged) return move.to.split("/")
      key = move.to
    }
    return null
  }
}

// The task a merged card's path (`<keeper folder>/_iterations/<name>/merged-task.md`) was merged into, as `track/slug`, or null.
function mergeKeeperOfPath(filePath, alias) {
  const keeper = /^(.+)\/_iterations\/[^/]+\/merged-task\.md$/u.exec(filePath)
  return keeper === null ? null : cardKeyOfPath(`${keeper[1]}/task.md`, alias)
}

// `() -> [{ from, to, merged }] | null`, oldest first: every move of a task card in Git history, once per `HEAD` (cached per desk root and
// person alias): a rename (`merged: false`, `to` the card's new `track/slug`) or a merge into another task (`merged: true`, `to` the keeper).
function cardMoves(options, alias, runFn) {
  const root = path.resolve(options.deskRoot)
  const cacheKey = `${root}\u0000${alias ?? ""}`
  return function renames() {
    if (!isOwnRepository(options, runFn)) return null
    const head = runFn(options, ["rev-parse", "HEAD"])
    if (head === null) return null
    const cached = RENAME_CACHE.get(cacheKey)
    if (cached !== undefined && cached.head === head.trim()) return cached.renames
    const output = runFn(options, ["log", "-M", "--diff-filter=R", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--format=", "--", ":(glob)**/task.md", ":(glob)**/merged-task.md"])
    if (output === null) return null
    const found = []
    for (const entry of parseCardRenames(output).reverse()) {
      const from = cardKeyOfPath(entry.oldPath, alias)
      const to = cardKeyOfPath(entry.path, alias)
      const keeper = to === null ? mergeKeeperOfPath(entry.path, alias) : null
      if (from !== null && to !== null && from !== to) found.push({ from, to, merged: false })
      else if (from !== null && keeper !== null) found.push({ from, to: keeper, merged: true })
    }
    RENAME_CACHE.set(cacheKey, { head: head.trim(), renames: found })
    return found
  }
}

// ---------------------------------------------------------------------------
// Card housekeeping (identity/placement-only edits).
// ---------------------------------------------------------------------------

const HOUSEKEEPING_KEY = /^(?:title|track|updated):/u

// The frontmatter's lines, unbounded (a commit diff can move real content
// past line 40), and the body: the text after the closing `---`. Not a
// field map — a line comparison can't afford to parse YAML, since a nested
// value (a nested `repos:` entry, say) would then be invisible to it; every
// frontmatter line is kept as written.
function splitCard(text) {
  const lines = text.split(/\r?\n/u)
  if (lines[0] !== "---") return { frontmatter: [], body: text }
  const end = lines.indexOf("---", 1)
  if (end === -1) return { frontmatter: [], body: text }
  return { frontmatter: lines.slice(1, end), body: lines.slice(end + 1).join("\n") }
}

// A line starts a new top-level `key: value` frontmatter entry when it is
// non-blank and has no leading whitespace; a blank or indented line
// continues the entry above it (a folded value or a nested list, say).
function isTopLevelLine(line) {
  return line !== "" && !/^\s/u.test(line)
}

// Drops every top-level `title:`, `track:` or `updated:` line, and every
// line that continues one of them, from a frontmatter's lines. Nothing
// else is touched: a field this doesn't name keeps every line it has,
// nested content included.
function stripHousekeepingLines(frontmatterLines) {
  const kept = []
  let skipping = false
  for (const line of frontmatterLines) {
    if (isTopLevelLine(line)) skipping = HOUSEKEEPING_KEY.test(line)
    if (!skipping) kept.push(line)
  }
  return kept
}

// A quoted frontmatter scalar's inner text, when its quoting is safe to
// normalize away: matched surrounding `"…"` or `'…'` with no backslash and
// no instance of that same quote character inside. Anything else — an
// unquoted value, mismatched or unterminated quotes, or a quoted value that
// itself holds a backslash or an embedded quote — is returned unchanged, so
// a real YAML escape is never reinterpreted, only ever compared literally.
function normalizedScalar(value) {
  const doubled = /^"([^"\\]*)"$/u.exec(value)
  if (doubled) return doubled[1]
  const singled = /^'([^'\\]*)'$/u.exec(value)
  if (singled) return singled[1]
  return value
}

// One frontmatter line with its scalar value's quoting normalized, when the
// line is a top-level or nested `key: value` entry or a `- value` list
// item; every other line (a bare `key:`, a map-valued list item such as
// `- name: alpha`, `---`, blank) is returned unchanged. Applied after
// `stripHousekeepingLines`, so a YAML re-serialization that only changed a
// scalar's quoting — `created: "…"` to `created: '…'`, `requester: "ari"`
// to `requester: ari`, `  - "./a.md"` to `  - ./a.md` — compares equal.
const SCALAR_LINE = /^(\s*[A-Za-z_][A-Za-z0-9_-]*:\s*)(.*)$/u
const LIST_ITEM_LINE = /^(\s*-\s*)(.*)$/u
function normalizeQuotingLine(line) {
  const scalar = SCALAR_LINE.exec(line)
  if (scalar) return scalar[1] + normalizedScalar(scalar[2])
  const item = LIST_ITEM_LINE.exec(line)
  if (item) return item[1] + normalizedScalar(item[2])
  return line
}

// A pathological commit's rename count this module will derive path
// substitutions from, so a commit with an unreasonable number of renames
// costs bounded time instead of unbounded time: past the cap the commit is
// never housekeeping (the fail-safe direction — any doubt binds).
const RENAME_PAIR_CAP = 2000

// A path segment character: substitutions only replace a path at a
// boundary, so `a/x` never matches inside `a/xy`, but any non-path
// character before the match — a `/`, whitespace, a quote, `~`, the start
// of the text — is accepted, which is what lets a reference written with a
// leading prefix (`~/desk/agentic-workflows/…`) still match a substitution
// derived from the commit's own unprefixed rename pair.
const PATH_BOUNDARY_CHAR = "[A-Za-z0-9_.-]"

function escapeForPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

// `text` with every substitution's old path replaced by its new path, in
// one pass over the original text so a substitution's own replacement is
// never itself rescanned by a shorter one (a file substituted into a newly
// inserted subdirectory, say, must not have that subdirectory's own
// directory-level substitution applied to it a second time). One combined
// pattern alternates every old path, longest first, each matched only at a
// path boundary on both sides (`a/x` never matches inside `a/xy`, but any
// non-path character before it — `/`, whitespace, a quote, `~`, the start
// of the text — is accepted, which is what lets a reference written with a
// leading prefix, such as `~/desk/agentic-workflows/…`, still match a
// substitution derived from the commit's own unprefixed rename pair).
// Regex alternation tries the longest candidate at each position first and
// backtracks to a shorter one only when the longer one's boundary check
// fails, so the longest satisfying match always wins. `substitutions` is
// keyed into a map by old path first, so two rename pairs that happen to
// derive the same old path keep only the later one — never observed from a
// real commit (see `directorySubstitution`), but harmless if it ever
// happens: whichever substitution is kept either resolves the text, in
// which case it was a fair reading of the commit's own renames, or it
// doesn't, in which case the comparison still falls through to "different"
// and the fail-safe direction holds regardless.
function applyPathSubstitutions(text, substitutions) {
  const byOldPath = new Map()
  for (const { oldPath, newPath } of substitutions) byOldPath.set(oldPath, newPath)
  const oldPaths = [...byOldPath.keys()].sort((left, right) => right.length - left.length)
  if (oldPaths.length === 0) return text
  const alternation = oldPaths.map(escapeForPattern).join("|")
  const pattern = new RegExp(`(?<!${PATH_BOUNDARY_CHAR})(?:${alternation})(?!${PATH_BOUNDARY_CHAR})`, "gu")
  return text.replace(pattern, (match) => byOldPath.get(match))
}

// The directory-level substitution one renamed file's old and new path
// imply, when they share a trailing path suffix: `a/x-2026/task.md` ->
// `a/x/task.md` shares the one segment `task.md`, so the directory that
// held it renamed `a/x-2026` -> `a/x`. Restricted to a same-depth "peer"
// rename — `oldPath` and `newPath` split into the same number of segments
// — on purpose: a file moved one level deeper into its own parent (`a/f.md`
// -> `a/planning/f.md`, say) shares that same trailing-suffix shape, but
// deriving `a` -> `a/planning` from it would substitute every other,
// unrelated mention of `a` throughout every other card's text too — a real
// same-commit regression this module confirmed empirically against a live
// tidy commit. A file moved a level deeper is still covered by its own
// direct file-to-file substitution; it just never also widens into a
// directory-level one.
//
// Also restricted to a derived pair whose paths keep at least two segments
// each — `shared` never grows past two less than the (now shared) segment
// count — so the substitution's old and new sides are never a single bare
// word. A whole-track rename (`cxa-tester-build` -> `cca-tools`, say) still
// shares every segment above the renamed one, which would otherwise derive
// exactly that bare `cxa-tester-build` -> `cca-tools` pair; substituting a
// single common word like that throughout every other card's text is
// exactly as unsafe as the depth case above, and real same-commit evidence
// confirmed it twice more: a track named after a person renamed to a
// different name corrupted an unrelated card's plain-prose mention of that
// person's own username in a filesystem path, and a track's bare old name
// corrupted an unrelated card's own title and heading that merely happened
// to read the same as that name. `directorySubstitution` now stops one
// segment short of that in both cases, so the same evidence instead derives
// `cxa-tester-build/_planning` -> `cca-tools/_planning` — specific enough
// that only an actual reference into that subdirectory can match it. Null
// for a depth change, when the paths share no trailing segment at all, or
// when the shared suffix would otherwise consume all but one segment on
// each side. Since whatever segment makes `oldPath` and `newPath` differ
// can never itself be part of the matched trailing suffix, that segment
// always survives into the returned pair, so it never comes back equal on
// both sides either.
function directorySubstitution(oldPath, newPath) {
  const oldSegments = oldPath.split("/")
  const newSegments = newPath.split("/")
  if (oldSegments.length !== newSegments.length) return null
  const limit = oldSegments.length - 2
  let shared = 0
  while (shared < limit && oldSegments[oldSegments.length - 1 - shared] === newSegments[newSegments.length - 1 - shared]) {
    shared += 1
  }
  if (shared === 0) return null
  return {
    oldPath: oldSegments.slice(0, oldSegments.length - shared).join("/"),
    newPath: newSegments.slice(0, newSegments.length - shared).join("/"),
  }
}

// The path substitutions a commit's own rename pairs imply: each renamed
// file, old path to new, plus the directory-level pair its rename implies
// (see `directorySubstitution`), deduplicated. `renamePairs` past
// `RENAME_PAIR_CAP` is refused outright (`null`), which the caller reads as
// "not housekeeping" — deriving substitutions from an unbounded rename list
// is exactly the runtime a pathological commit must not be allowed to cost.
function deriveSubstitutions(renamePairs) {
  if (renamePairs.length > RENAME_PAIR_CAP) return null
  const byKey = new Map()
  for (const { oldPath, newPath } of renamePairs) {
    byKey.set(`${oldPath}\u0000${newPath}`, { oldPath, newPath })
    const dir = directorySubstitution(oldPath, newPath)
    if (dir) byKey.set(`${dir.oldPath}\u0000${dir.newPath}`, dir)
  }
  return [...byKey.values()]
}

// One top-level frontmatter entry: its key (`null` when the line doesn't
// parse as `key:` or `key: value`), the raw value text after the colon on
// its own header line, and the header line plus every line that continues
// it (a block scalar's body, a nested map or list). Operates on lines
// already run through `stripHousekeepingLines`/`normalizeQuotingLine`, so
// grouping never has to re-derive either of those.
const TOP_LEVEL_ENTRY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t](.*))?$/u
function groupFrontmatterEntries(lines) {
  const entries = []
  for (const line of lines) {
    if (isTopLevelLine(line)) {
      const match = TOP_LEVEL_ENTRY.exec(line)
      entries.push({ key: match ? match[1] : null, value: match ? (match[2] ?? "") : "", header: line, continuation: [] })
    } else if (entries.length > 0) {
      entries[entries.length - 1].continuation.push(line)
    }
  }
  return entries
}

function entryLiteral(entry) {
  return [entry.header, ...entry.continuation].join("\n")
}

// An entry's own header line plus a chomp-`-` block scalar body (`>-`
// folded, `|-` literal) folded to the text it denotes, when that's
// unambiguous: uniform indentation (taken from the first continuation
// line), no blank line, no other chomp or explicit-indentation indicator
// (bare `>`/`|`, `+`, or a digit are all left unparsed). Anything this
// can't fold with confidence — including a nested map or list, which has
// no `>-`/`|-` header at all — returns `null`, the same "don't know, so it
// binds" signal `deriveSubstitutions` and friends already use past their
// own caps.
const BLOCK_SCALAR_HEADER = /^([|>])-$/u
function semanticScalarValue(entry) {
  const blockHeader = BLOCK_SCALAR_HEADER.exec(entry.value.trim())
  if (blockHeader) {
    if (entry.continuation.length === 0) return null
    const indentMatch = /^(\s+)/u.exec(entry.continuation[0])
    if (!indentMatch) return null
    const indent = indentMatch[1]
    const contentLines = []
    for (const line of entry.continuation) {
      if (line === "" || !line.startsWith(indent)) return null
      contentLines.push(line.slice(indent.length))
    }
    return blockHeader[1] === ">" ? contentLines.join(" ") : contentLines.join("\n")
  }
  if (entry.continuation.length > 0) return null
  return normalizedScalar(entry.value)
}

// True when both values name the same UTC instant, once written the way a
// full YAML re-dump (`Date.prototype.toISOString()`, under the hood) always
// writes it: exactly `.000` milliseconds when the original had none, an
// implicit `T00:00:00` for a bare `YYYY-MM-DD` date. Two verified real-data
// residuals this module's tests were built against are both this same
// artifact: a date-only `created:` reformatted to its own midnight
// timestamp, and a `created:`/similar full timestamp gaining a redundant
// `.000` with no other change. A real sub-second change (non-`.000`
// milliseconds appearing or changing) or a non-UTC offset is a real
// difference, not this artifact, and returns `null`/unequal.
const DATE_ONLY_VALUE = /^\d{4}-\d{2}-\d{2}$/u
const TIMESTAMP_VALUE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{3})?Z$/u
function timestampInstant(value) {
  if (DATE_ONLY_VALUE.test(value)) return `${value}T00:00:00`
  const match = TIMESTAMP_VALUE.exec(value)
  if (!match) return null
  if (match[2] !== undefined && match[2] !== ".000") return null
  return match[1]
}
function isEquivalentTimestampPair(a, b) {
  const instantA = timestampInstant(a)
  const instantB = timestampInstant(b)
  return instantA !== null && instantB !== null && instantA === instantB
}

// The frontmatter-equality check `isHousekeepingEdit` runs once its fast,
// purely textual comparison (this same function, before this fallback
// existed) finds a difference. Same key at the same position, in the same
// order, both sides: kept. Any entry whose two sides aren't byte-identical
// falls to a semantic comparison that recognizes exactly two YAML
// re-serialization artifacts — an ISO timestamp re-encoded with the same
// instant (a bare date's own midnight, or the same time with a redundant
// `.000` added), and a folded/literal block scalar re-encoded as (or from)
// the single-line scalar with the same text — and nothing else. Different
// entry counts, a reordered key, a key that doesn't parse, or a value
// neither side can confidently reduce to plain text: not equal, the same
// fail-safe direction every other heuristic in this module takes.
function frontmatterEntriesEqual(beforeLines, afterLines) {
  const before = groupFrontmatterEntries(beforeLines)
  const after = groupFrontmatterEntries(afterLines)
  if (before.length !== after.length) return false
  for (let index = 0; index < before.length; index += 1) {
    const beforeEntry = before[index]
    const afterEntry = after[index]
    if (entryLiteral(beforeEntry) === entryLiteral(afterEntry)) continue
    if (beforeEntry.key === null || afterEntry.key === null || beforeEntry.key !== afterEntry.key) return false
    const beforeValue = semanticScalarValue(beforeEntry)
    const afterValue = semanticScalarValue(afterEntry)
    if (beforeValue === null || afterValue === null) return false
    if (beforeValue === afterValue || isEquivalentTimestampPair(beforeValue, afterValue)) continue
    return false
  }
  return true
}

// True when the two bodies are byte-identical, or differ by exactly one
// trailing newline on either side — the one body-level artifact a full
// YAML re-dump is known to introduce (real evidence: personal-desk commit
// 207c6dd2, where a hand-authored file with no trailing newline gained
// one). More than that one newline of difference, or any difference
// earlier in the text, is a real change.
function bodiesEquivalent(before, after) {
  return before === after || `${before}\n` === after || before === `${after}\n`
}

// True when the only difference between the two card texts is identity or
// placement. `substitutions` (this commit's own rename pairs, file and
// directory) are applied to `oldText` first, so a reference to a path this
// same commit also moved — in frontmatter or body — reads as unchanged too.
// The body must then be byte-identical, up to one trailing newline
// (`bodiesEquivalent`); the frontmatter must be identical once every
// top-level `title:`, `track:` and `updated:` line (and their continuation
// lines) is dropped from both and each remaining line's scalar quoting is
// normalized (`normalizeQuotingLine`) — a per-entry comparison
// (`frontmatterEntriesEqual`), never a per-field guess, so a change inside a
// nested value (a `repos:` entry's `branch_base:`, say) is never invisible
// to it, and the two known YAML-reserialization artifacts (an ISO timestamp
// re-encoded as the same instant, folded block scalar vs. single line) are
// the only value encodings it treats as equal without being byte-identical.
function isHousekeepingEdit(oldText, newText, substitutions) {
  const before = splitCard(applyPathSubstitutions(oldText, substitutions))
  const after = splitCard(newText)
  if (!bodiesEquivalent(before.body, after.body)) return false
  const beforeLines = stripHousekeepingLines(before.frontmatter).map(normalizeQuotingLine)
  const afterLines = stripHousekeepingLines(after.frontmatter).map(normalizeQuotingLine)
  return frontmatterEntriesEqual(beforeLines, afterLines)
}

// `git diff-tree --name-status -z` output: `status\0path` for an add,
// modify or delete, `status\0oldPath\0newPath` for a rename or copy (status
// starts `R` or `C`, optionally followed by a similarity percentage).
export function parseNameStatus(output) {
  const parts = output.split("\0").filter((part) => part !== "")
  const entries = []
  let i = 0
  while (i < parts.length) {
    const status = parts[i]
    i += 1
    if (/^[RC]/u.test(status)) {
      const oldPath = parts[i]
      const newPath = parts[i + 1]
      i += 2
      if (oldPath !== undefined && newPath !== undefined) entries.push({ status, oldPath, path: newPath })
    } else {
      const filePath = parts[i]
      i += 1
      if (filePath !== undefined) entries.push({ status, path: filePath })
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// Git history.
// ---------------------------------------------------------------------------

const COMMIT_ENTRY = /^commit(?: \((?:initial|amend|merge)\))?: /u
const REFLOG_TIME = /@\{([^}]+)\}$/u

// `git log -g -z --name-only --format=%x1e<header>`: records split by 0x1e,
// a NUL after the header, then a newline (a NUL for a merge) and
// NUL-separated paths. The header is `sha 0x1f ref@{time} 0x1f subject`.
function parseReflog(output) {
  const entries = []
  for (const record of output.split("\x1e")) {
    const headerEnd = record.indexOf("\0")
    if (headerEnd === -1) continue
    const [sha, selector, subject] = record.slice(0, headerEnd).split("\x1f")
    const time = REFLOG_TIME.exec(selector)
    const at = time === null ? null : normalizeTimestamp(time[1])
    if (at === null || !COMMIT_ENTRY.test(subject)) continue
    const taskPaths = record.slice(headerEnd + 1).split("\0").map((entry) => entry.replace(/^\n/u, "")).filter((entry) => entry !== "")
    entries.push({ sha, committed_at: at, taskPaths })
  }
  return entries
}

// True when Git's top level for `deskRoot` is the desk root itself. Git's
// `--show-prefix` is the desk root's path below its top level, so it is
// empty exactly when the top level is the desk root's real path (it
// resolves symlinks, and letter case on a case-insensitive disk, as Git
// does). `runFn` calls `runGit` directly by default; a deadline-aware
// caller passes its own, so this one call stays inside its shared budget.
function isOwnRepository(options, runFn = runGit) {
  const prefix = runFn(options, ["rev-parse", "--show-prefix"])
  return prefix !== null && prefix.trim() === ""
}

// The repo-relative path segments of `relativePath`'s birth commit — the
// newest commit in which it was purely added, chasing the name back through
// Git's own rename detection (`--follow` implies it) — or null when Git has
// no such commit (an uncommitted path, or any Git failure). `--diff-filter=A`
// keeps only genuine adds, newest first; the *first* one is kept, since a
// literal path can have more than one across an unrelated delete and
// re-create, and only the newest is this path's own current lineage (see
// the header for why, and for the same-commit swap this also keeps out).
// Unlike `isOwnRepository`, `runFn` has no default here: `resolveJobIdentity`
// is this function's only caller, and it always passes its own deadline-aware
// `run`, so a default would be dead code no path through this module reaches.
function gitBirthPath(options, relativePath, runFn) {
  const output = runFn(options, ["log", "--follow", "--diff-filter=A", "-z", "--format=%x1e%H", "--name-only", "--", relativePath])
  if (output === null) return null
  const records = output.split("\x1e").filter((record) => record !== "")
  if (records.length === 0) return null
  const headerEnd = records[0].indexOf("\0")
  if (headerEnd === -1) return null
  const paths = records[0].slice(headerEnd + 1).split("\0").map((entry) => entry.replace(/^\n/u, "")).filter((entry) => entry !== "")
  return paths.length > 0 ? { sha: records[0].slice(0, headerEnd).trim(), path: paths[0] } : null
}

// The `track/slug` a `task.md` path names, in any of the four places a card
// lives (see `findCard`), or null for any other path or another person's.
function cardKeyOfPath(filePath, alias) {
  let segments = relativeSegments(filePath)
  if (alias !== null) {
    if (segments[0] !== "desks" || segments[1] !== alias) return null
    segments = segments.slice(2)
  }
  if (segments.at(-1) !== "task.md") return null
  const folder = segments.slice(0, -1)
  const archivedTrack = folder[0] === "_archive" ? folder.slice(1) : folder
  const names = archivedTrack[1] === "_archive" ? [archivedTrack[0], archivedTrack[2]] : archivedTrack
  return names.length === 2 && archivedTrack.length === (archivedTrack[1] === "_archive" ? 3 : 2) && names.every(isTaskSegment) ? names.join("/") : null
}

function isWindow(startIso, endIso) {
  return typeof startIso === "string" && typeof endIso === "string" && PATTERNS.timestamp.test(startIso) && PATTERNS.timestamp.test(endIso) && startIso <= endIso
}

// A normalized remote with a host and a path, such as `https://github.com/owner/name`.
const HOSTED_REMOTE = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/u

// The `owner/name` of a normalized remote: the last two parts of its path, or null when it has no host or they are not two safe names.
function repoOfRemote(normalized) {
  const hosted = HOSTED_REMOTE.exec(normalized)
  return hosted === null ? null : ownerName(hosted[1].split("/").slice(-2).join("/"))
}

const NONE = Object.freeze({ none: true })
const UNAVAILABLE = Object.freeze({ unavailable: true })

// What a path is: "directory", "missing" (ENOENT or ENOTDIR: it is gone), "other" (it exists and is not a directory) or "error" (any other
// stat failure: a permission or I/O error, an unmounted volume).
function folderKind(target) {
  try {
    return statSync(target).isDirectory() ? "directory" : "other"
  } catch (error) {
    return error.code === "ENOENT" || error.code === "ENOTDIR" ? "missing" : "error"
  }
}

// The real path of a folder, or the folder as given when it cannot be resolved.
function realFolder(folder) {
  try {
    return realpathSync(folder)
  } catch {
    return path.resolve(folder)
  }
}

// The nearest folder at or above `directory` that holds a `.git` entry (a folder, or a linked worktree's file), or null.
function repositoryRoot(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, ".git"))) return current
    if (path.dirname(current) === current) return null
  }
}

/**
 * `createDeskReaders({ deskRoot, personPrefix, git, timeoutMs })` ->
 * `{ readTask, mergedInto, deskCommitsBetween, gitCommitTaskPaths, isCardHousekeeping,
 * resolveJobIdentity, repoOfPath, repoLookup }`; `bindSession` takes all but
 * `deskCommitsBetween`, which `factory reconcile` still reads.
 */
export function createDeskReaders({ deskRoot, personPrefix = "", git = "git", timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("createDeskReaders: deskRoot must be an absolute path")
  checkPersonPrefix(personPrefix, "createDeskReaders")
  const base = path.join(deskRoot, personPrefix)
  const options = { git, deskRoot, timeoutMs }

  let ownRepository
  const deskIsOwnRepository = () => {
    if (ownRepository === undefined) ownRepository = isOwnRepository(options)
    return ownRepository
  }

  const alias = checkPersonPrefix(personPrefix, "createDeskReaders")
  const renamedKey = taskRenameLookup(options, alias, runGit)
  const mergedKey = taskMergeLookup(options, alias, runGit)
  /** `mergedInto(track, slug) -> { track, slug } | null`: the task a merged task now lives in, when it has no card of its own (`taskMergeLookup`). */
  function mergedInto(track, slug) {
    if (!isTaskSegment(track) || !isTaskSegment(slug) || readTask(track, slug) !== null) return null
    const keeper = mergedKey(track, slug)
    return keeper === null ? null : { track: keeper[0], slug: keeper[1] }
  }

  function readTask(track, slug) {
    if (!isTaskSegment(track) || !isTaskSegment(slug)) return null
    const found = findCard(base, track, slug, renamedKey)
    return found === null ? null : cardFields(found.text)
  }

  // The outcome record the card carries, its status and the time it was last updated, or null when no card exists (archived cards are found too).
  function readOutcome(track, slug) {
    if (!isTaskSegment(track) || !isTaskSegment(slug)) return null
    const found = findCard(base, track, slug, renamedKey)
    if (found === null) return null
    const lines = frontmatterLines(found.text)
    const fields = frontmatterOf(lines)
    return { record: recordFromLines(lines), status: ENUMS.jobStatus.includes(fields.status) ? fields.status : null, evidenceAt: normalizeTimestamp(fields.updated) }
  }

  // Keyed by sha alone: this cache lives for exactly one `createDeskReaders`
  // call, so it can never mix results across a different `deskRoot`, `git`
  // binary, or `timeoutMs` the way a module-level cache keyed only on
  // `deskRoot`+`sha` could (two callers can point `git` at a stub in tests).
  // No invalidation is needed either way — a commit's own diff-tree is
  // immutable from the moment the commit exists.
  const commitDiffCache = new Map()
  function commitDiffAndSubstitutions(sha) {
    if (commitDiffCache.has(sha)) return commitDiffCache.get(sha)
    const output = runGit(options, ["diff-tree", "--root", "-M", "--no-commit-id", "--name-status", "-r", "-z", sha])
    const result = output === null ? null : (() => {
      const entries = parseNameStatus(output)
      // `parseNameStatus` only ever pushes an `R`/`C` entry once both sides
      // of the pair parsed, so every `R` entry here already has its `oldPath`.
      const renamePairs = entries
        .filter((entry) => /^R/u.test(entry.status))
        .map((entry) => ({ oldPath: entry.oldPath, newPath: entry.path }))
      return { entries, substitutions: deriveSubstitutions(renamePairs) }
    })()
    commitDiffCache.set(sha, result)
    return result
  }

  function deskCommitsBetween(startIso, endIso) {
    if (!isWindow(startIso, endIso) || !deskIsOwnRepository()) return []
    const branches = runGit(options, ["for-each-ref", "--format=%(refname)", "refs/heads"])
    if (branches === null) return []
    const output = runGit(options, [
      "log", "--walk-reflogs", "--date=iso-strict", `--since=${startIso}`, `--until=${endIso}`,
      "--no-renames", "--cc", "--name-only", "-z", "--format=%x1e%H%x1f%gd%x1f%gs",
      "HEAD", ...branches.split("\n").filter((ref) => ref.startsWith("refs/heads/")),
    ])
    if (output === null) return []
    // Git bounds the entries by reflog time; binding matches each to a call.
    // HEAD's reflog and the branch's both record one commit: keep it once.
    const seen = new Map()
    for (const entry of parseReflog(output)) {
      const key = `${entry.sha}@${entry.committed_at}`
      if (!seen.has(key)) seen.set(key, entry)
    }
    return [...seen.values()]
  }

  function gitCommitTaskPaths(sha) {
    const missing = { exists: false, taskPaths: [] }
    if (typeof sha !== "string" || !PATTERNS.commitSha.test(sha) || !deskIsOwnRepository()) return missing
    if (runGit(options, ["cat-file", "-e", `${sha}^{commit}`]) === null) return missing
    const output = runGit(options, ["diff-tree", "--root", "--no-commit-id", "--no-renames", "-r", "-z", "--name-only", sha])
    return { exists: true, taskPaths: (output ?? "").split("\0").filter((entry) => entry !== "") }
  }

  // Its own diff-tree call, Git's own rename detection on (its default
  // similarity threshold, just to pair an old path with a new one): a
  // question about one path's change in one commit, independent of the
  // `--no-renames` path lists above (those must keep a rename as a delete
  // and an add, so the old and new task each get their own say). The
  // pairing only finds candidates; the verdict is always this module's own
  // content comparison, never Git's similarity score. The same call's `R`
  // entries — the commit's own rename pairs, whatever path is under
  // judgment — are reused to derive the path substitutions `isHousekeepingEdit`
  // applies to the old text before comparing; `deriveSubstitutions` returns
  // `null` past `RENAME_PAIR_CAP`, which reads the same as any other doubt:
  // not housekeeping. `commitDiffAndSubstitutions` caches the diff-tree call
  // and the derived substitutions per sha, so a commit touching N cards in
  // one `createDeskReaders` session pays for the diff-tree walk once.
  function isCardHousekeeping(sha, filePath) {
    if (typeof filePath !== "string" || filePath === "") return false
    if (typeof sha !== "string" || !PATTERNS.commitSha.test(sha) || !deskIsOwnRepository()) return false
    const diff = commitDiffAndSubstitutions(sha)
    if (diff === null) return false
    const { entries, substitutions } = diff
    const match = entries.find((entry) => entry.path === filePath || entry.oldPath === filePath)
    if (!match || match.status === "A" || match.status === "D") return false
    const oldPath = match.oldPath ?? filePath
    const oldText = runGit(options, ["show", `${sha}~1:${oldPath}`])
    const newText = runGit(options, ["show", `${sha}:${match.path}`])
    if (oldText === null || newText === null) return false
    if (substitutions === null) return false
    return isHousekeepingEdit(oldText, newText, substitutions)
  }

  // `repoLookup`: each directory asked about -> its answer, and each repository root -> its answer. Both live for this one set of
  // readers, so a session's many writes in one repository cost one Git call.
  const lookupByDirectory = new Map()
  const lookupByRoot = new Map()
  const deskFolder = realFolder(deskRoot)
  let deskOrigin
  // A folder's `origin`, normalized: `{ origin }` (null when it has no remote), or `{ failed: true }` when Git itself failed.
  // `git config --get` exits 1 when the key is not set, which is a clean "no origin"; any other exit, a signal or a timeout is a failure.
  const originOf = (folder) => {
    const result = spawnSync(git, ["-C", folder, "-c", "core.quotePath=false", "config", "--get", "remote.origin.url"], { encoding: "utf8", env: gitEnv(), timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] })
    if (result.error !== undefined || result.signal !== null || (result.status !== 0 && result.status !== 1)) return { failed: true }
    const remote = result.status === 0 ? result.stdout.trim() : ""
    return { origin: remote === "" ? null : normalizeRemote(remote) }
  }
  const lookupOfRoot = (root) => {
    const found = originOf(root)
    if (found.failed) return UNAVAILABLE
    if (found.origin === null) return NONE
    if (deskOrigin === undefined) deskOrigin = originOf(deskRoot).origin ?? null
    // Another checkout of the desk's own remote is the desk, not a code repository.
    const repo = found.origin === deskOrigin ? null : repoOfRemote(found.origin)
    return repo === null ? NONE : { repo }
  }
  /**
   * `repoLookup(absolutePath)`: the code repository holding a path, as one of three answers a caller cannot confuse:
   * `{ repo: "owner/name" }` (lowercase, from the `origin` remote of the nearest folder at or above the path that still exists: a deleted
   * file is still in its repository; a path that is a folder is looked up as itself, so a nested repository root names its own repository,
   * and an existing file by its folder; with `{ maybeFile: true }` (a commit's path entry) a missing path is a deleted file, lost only when the
   * folder it was in is missing too, where without it a missing path is a folder that is gone); `{ none: true }` (the folder exists and Git cleanly reports no repository, or a repository with no
   * origin or one that is not `host/…/owner/name`, or the desk itself: a path inside the desk root, or a checkout of the desk's own remote;
   * also a path that is not absolute); and `{ unavailable: true }` (the evidence cannot be read: the folder is gone (ENOENT, ENOTDIR) or
   * and no repository above it names it, any other stat error such as a permission or I/O failure, a Git failure or a
   * timeout). Only the name is ever returned, never the path or the remote.
   */
  function repoLookup(absolutePath, { maybeFile = false } = {}) {
    if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath)) return NONE
    const start = path.resolve(absolutePath)
    const cacheKey = maybeFile ? `${start}\0file` : start
    if (lookupByDirectory.has(cacheKey)) return lookupByDirectory.get(cacheKey)
    let directory = start
    let kind = folderKind(directory)
    let lost = kind !== "directory"
    // A path that may be a file (a commit's path entry) and is missing is a deleted file, not a lost folder, when the folder it was in exists.
    if (kind === "missing" && maybeFile) lost = folderKind(path.dirname(start)) !== "directory"
    // A file that exists is in its folder's repository; nothing is lost.
    if (kind === "other") {
      directory = path.dirname(start)
      kind = folderKind(directory)
      lost = false
    }
    // The filesystem root always exists, so the guard against walking past it is for a stat that fails there.
    /* node:coverage ignore next */
    while (kind === "missing" && path.dirname(directory) !== directory) {
      directory = path.dirname(directory)
      kind = folderKind(directory)
    }
    let answer
    const inDesk = path.relative(deskFolder, realFolder(directory))
    if (inDesk === "" || (!inDesk.startsWith("..") && !path.isAbsolute(inDesk))) answer = NONE
    else if (kind === "error") answer = UNAVAILABLE
    else {
      const root = repositoryRoot(directory)
      if (root !== null) {
        if (!lookupByRoot.has(root)) lookupByRoot.set(root, lookupOfRoot(root))
        answer = lookupByRoot.get(root)
      } else answer = NONE
      if (lost && answer.repo === undefined) answer = UNAVAILABLE
    }
    lookupByDirectory.set(cacheKey, answer)
    return answer
  }
  /** `repoOfPath(absolutePath) -> "owner/name" | null`: `repoLookup`'s name, or `null` for either of its other answers. */
  const repoOfPath = (absolutePath) => repoLookup(absolutePath).repo ?? null

  return {
    readTask, mergedInto, deskCommitsBetween, gitCommitTaskPaths, isCardHousekeeping, repoOfPath, repoLookup, readOutcome,
    resolveJobIdentity: (track, slug) => resolveJobIdentity({ deskRoot, personPrefix, track, slug, git, timeoutMs }),
  }
}

/**
 * `resolveJobIdentity({ deskRoot, personPrefix, track, slug, git, timeoutMs,
 * deadline, clock, spawn })` -> `{ track, slug }`: the task's birth path.
 * See the header, including the `deadline`/`git_deadline` contract shared
 * with `readDeskRemote`. `spawn` replaces `spawnSync` in tests.
 */
export function resolveJobIdentity({
  deskRoot, personPrefix = "", track, slug, git = "git", timeoutMs = DEFAULT_TIMEOUT_MS,
  deadline = null, clock = () => performance.now(), spawn = spawnSync,
}) {
  const current = { track, slug }
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("resolveJobIdentity: deskRoot must be an absolute path")
  const alias = checkPersonPrefix(personPrefix, "resolveJobIdentity")
  if (!isTaskSegment(track) || !isTaskSegment(slug)) return current

  const options = { git, deskRoot, timeoutMs, spawn }
  const root = path.resolve(deskRoot)

  // Mirrors `readDeskRemote`'s own `run`, in `isOwnRepository`/
  // `gitBirthPath`'s `runFn(options, args)` shape so it can replace
  // their default `runGit` directly: with no deadline this is exactly
  // `runGit(options, args)` (never throws), and with one it caps each call
  // to the time left, throwing `git_deadline` before starting a call the
  // deadline has no room for, and after one that reached it anyway.
  const run = (_options, args) => {
    let limit = timeoutMs
    if (deadline !== null) {
      limit = Math.min(timeoutMs, Math.floor(deadline - clock()))
      if (limit < 1) throw gitDeadline()
    }
    const output = runGit({ ...options, timeoutMs: limit, strict: deadline !== null }, args)
    if (deadline !== null && clock() >= deadline) throw gitDeadline()
    return output
  }

  const found = findCard(path.join(deskRoot, personPrefix), track, slug, taskRenameLookup(options, alias, run))
  if (found === null) return current

  let ownRepo = REPO_CHECK_CACHE.get(root)
  if (ownRepo === undefined) {
    ownRepo = isOwnRepository(options, run)
    REPO_CHECK_CACHE.set(root, ownRepo)
  }
  if (!ownRepo) return current

  // A path vacated by one task and later reoccupied by another, within this
  // same process, must not hand back the first task's cached birth just
  // because the path matches: a commit landing is the only way that can
  // happen, so every call checks `HEAD` and drops every cached birth path
  // for this root the moment it differs from what an earlier call saw.
  const head = run(options, ["rev-parse", "HEAD"])
  const stamp = head === null ? null : head.trim()
  if (stamp !== null && REPO_HEAD_CACHE.get(root) !== stamp) {
    for (const key of BIRTH_PATH_CACHE.keys()) {
      if (key.startsWith(`${root}\u0000`)) BIRTH_PATH_CACHE.delete(key)
    }
    REPO_HEAD_CACHE.set(root, stamp)
  }

  const relative = path.relative(deskRoot, path.join(found.folder, "task.md")).split(path.sep).join("/")
  const cacheKey = `${root}\u0000${relative}`
  if (BIRTH_PATH_CACHE.has(cacheKey)) return BIRTH_PATH_CACHE.get(cacheKey)

  // `--follow` pairs by similarity, so a birth found under another path must be the same card: its creation time there must not differ
  // from the card's own (`sameCreation`). A birth that does is an unrelated deleted card; the card is then its own lineage, at its path.
  let birth = gitBirthPath(options, relative, run)
  if (birth !== null && birth.path !== relative) {
    const then = run(options, ["cat-file", "blob", `${birth.sha}:${birth.path}`])
    if (then !== null && !sameCreation(frontmatterOf(frontmatterLines(found.text)).created, frontmatterOf(frontmatterLines(then)).created)) birth = { path: relative }
  }
  const parsed = birth === null ? null : taskOfSegments(relativeSegments(birth.path), alias)
  const result = parsed === null ? current : { track: parsed.track, slug: parsed.slug }
  BIRTH_PATH_CACHE.set(cacheKey, result)
  return result
}

/**
 * `readDeskRemote({ deskRoot, git, timeoutMs, deadline, clock })`: the desk's
 * `origin` URL, or `null`. With `deadline` (a value of `clock`, which defaults
 * to `performance.now`), both Git calls share it: each gets at most the time
 * left, and a call that reaches the deadline, or none left to start one,
 * throws an error whose code is `git_deadline` instead of reading as "no
 * remote", so a caller never mistakes a timeout for a desk without one. A
 * call killed by its own time limit, or by any signal, throws the same way
 * with or without a deadline. `spawn` replaces `spawnSync` in tests.
 */
export function readDeskRemote({ deskRoot, git = "git", timeoutMs = DEFAULT_TIMEOUT_MS, deadline = null, clock = () => performance.now(), spawn = spawnSync }) {
  const run = (args) => {
    let limit = timeoutMs
    if (deadline !== null) {
      limit = Math.min(timeoutMs, Math.floor(deadline - clock()))
      if (limit < 1) throw gitDeadline()
    }
    const output = runGit({ git, deskRoot, timeoutMs: limit, spawn, strict: true }, args)
    if (deadline !== null && clock() >= deadline) throw gitDeadline()
    return output
  }
  const prefix = run(["rev-parse", "--show-prefix"])
  if (prefix === null || prefix.trim() !== "") return null
  const output = run(["config", "--get", "remote.origin.url"])
  const remote = output === null ? "" : output.trim()
  return remote === "" ? null : remote
}

function gitDeadline() {
  return Object.assign(new Error("git_deadline"), { code: "git_deadline" })
}
