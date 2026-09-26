// organizationFindings — read-only organization checks over a desk subtree.
//
// M4-3 ruling: the doctor reports organization problems in the caller's own
// desk subtree so agents can tidy them; tidying itself is a later task. This
// module only ever reads — it never writes, moves or deletes anything.
//
// Scope: `personPrefix` (an absolute path, already resolved by the caller —
// mirrors `util/paths.js`'s `personPrefix(deskRoot, person)`) is the root of
// the walk. A crew desk's peer subtrees (`desks/<other-alias>/`) are never
// visible here because the caller passes a prefix that excludes them; this
// module additionally never recurses into a `desks/` directory it finds,
// as defense in depth against ever reporting on a peer's desk.
//
// Scope, continued: a desk-root-level `_archive/` (whole archived *tracks*,
// per `directory-structure`) is never scanned either — accepted as of the
// M4-3 fix-round ruling. Once a track is retired to that archive its
// organization is history, not something an agent is actively tidying; this
// keeps the doctor's job to the live desk. A *track's own* `_archive/`
// (archived tasks within a still-live track) is scanned, because
// `track_empty` and the name/staleness checks still meaningfully apply
// there.
//
// Loose-file allow-lists (rulings, 2026-09-25):
//   - desk root: track folders, underscore folders, `desks/` (crew), the
//     shared `artifacts/` folder `directory-structure` defines (M4-5),
//     `AGENTS.md`, `README.md`, `CLAUDE.md`, dotfiles.
//   - track root: `track.md`, task folders, underscore folders.
// Dotfiles include dot-folders such as `.git/` (M4-5): a Git desk always has
// one, and the tidy's Detect must not fire on every Git desk because of it.
// A "track folder" is a directory whose immediate root has a `track.md`; a
// "task folder" is a directory whose immediate root has a `task.md`.
// Anything else is loose.
//
// Name findings (`name_shape`, `name_prompt_like`, `name_credential_like`,
// `track_person_name`, `track_catch_all`) reuse M4-1's `validateName` /
// `validateTrackName` against every existing track/task directory name —
// unlike the CRUD tools, the doctor's job is exactly to surface a
// pre-existing bad name for tidying, not to gate a write.
//
// Redaction (fix round 1, controller ruling): a credential-like path segment
// must never be echoed, in ANY finding whose path or hint touches it, not
// only the one finding that names it directly — a sibling `stale_task` or
// `loose_file` for the very same directory is just as much a leak. Every
// finding path/hint in this module is built through `redactedRelPath` (or
// composed only from other findings' already-redacted paths, as
// `duplicate_job`'s hint is), which independently redacts each path segment:
// via M4-1's `validateName` returning `credential_like`, or — because a
// segment that fails `validateName`'s kebab-case *shape* gate never reaches
// its own credential check — via a direct scan for a 16+ character hex or
// hex-plus-letter run inside the segment, regardless of its overall shape.
//
// `duplicate_job` scans every *non-archived* task card's frontmatter (raw
// text) and the first 200 lines of its body for a pull
// request URL (GitHub/GitHub-Enterprise `/pull/<n>` and Azure DevOps
// `/pullrequest/<n>` shapes, on any host); two or more cards sharing one URL
// are each flagged. Each card is read through a single bounded
// `fs.openSync`/`readSync` of at most its first 64 KiB — enough to hold any
// real card's frontmatter plus far more than 200 body lines — so a card
// with an unusually large body (a pasted log, a long transcript) never
// costs more I/O or memory than that, however large the file actually is.
//
// `stale_task` flags a non-terminal task (`status` not `done`/`cancelled`)
// whose `updated` is more than 30 days before `now`.
//
// Card parsing (M4-5): the Desk MCP parses cards with gray-matter. The
// one-time tidy migration's Detect runs these same checks straight from the
// installed plugin, where no npm dependency is installed, so gray-matter is
// loaded lazily and `frontmatter-lite.js` stands in when it can't be found.
// Pull request URLs are read from the raw frontmatter text, which the
// dependency-free reader extracts on both paths, so they find the same URLs.

import { closeSync, openSync, readSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { parseFrontmatterLite } from "./frontmatter-lite.js"
import { validateName, validateTrackName, validateScope } from "./naming.js"

const requireFromHere = createRequire(import.meta.url)

/**
 * gray-matter when it can be loaded, the dependency-free reader otherwise.
 * `load` is a test seam; real callers never pass it.
 */
export function loadFrontmatterParser(load = () => requireFromHere("gray-matter")) {
  try {
    return load()
  } catch {
    return parseFrontmatterLite
  }
}

const parseFrontmatter = loadFrontmatterParser()

// Mirrors tools/task.js's TERMINAL_STATUSES — duplicated rather than
// imported to keep this read-only reporting module independent of the CRUD
// tool's internals.
const TERMINAL_STATUSES = new Set(["done", "cancelled"])

const STALE_MS = 30 * 24 * 60 * 60 * 1000

const DESK_ROOT_ALLOWED_FILES = new Set(["AGENTS.md", "README.md", "CLAUDE.md"])

// Plain (non-underscore) folders a desk root may hold besides tracks: the
// shared `artifacts/` folder (vector packs, snapshots, publication policy).
const DESK_ROOT_ALLOWED_DIRS = new Set(["artifacts"])

// A bounded read never costs more than this many bytes per card, whatever
// the file's real size — see the module header.
const MAX_CARD_BYTES = 64 * 1024

// A pull request URL, generic enough to cover github.com, GitHub Enterprise,
// and Azure DevOps: scheme, host+path, then `/pull/<number>` (GitHub-style)
// or `/pullrequest/<number>` (Azure DevOps' `.../pullrequest/<n>`).
const PR_URL_RE = /https?:\/\/[^\s)"'<>]+\/pull(?:request)?\/\d+/g

const REDACTED_SEGMENT = "<redacted segment>"

function isUnderscoreDir(name) {
  return name.startsWith("_")
}

function isDotfile(name) {
  return name.startsWith(".")
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// Reads at most `MAX_CARD_BYTES` from the start of `filePath` — a single
// `open`/bounded `read`/`close`, never a full-file `readFileSync`. A
// truncated multi-byte UTF-8 sequence at the boundary decodes to a
// replacement character rather than throwing, and gray-matter tolerates a
// body truncated mid-line; either way the frontmatter (always at the very
// start of the file) is read whole for any real card. Any failure — missing
// file, unreadable, or malformed frontmatter — is treated the same way: the
// doctor skips what it can't make sense of rather than throwing, matching
// `safeReaddir`'s tolerance.
function readCard(filePath) {
  let fd
  try {
    fd = openSync(filePath, "r")
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(MAX_CARD_BYTES)
    const bytesRead = readSync(fd, buffer, 0, MAX_CARD_BYTES, 0)
    const text = buffer.toString("utf8", 0, bytesRead)
    const parsed = parseFrontmatter(text)
    // gray-matter does not reliably keep the raw frontmatter text (a cached
    // parse drops it), so it is always taken from the dependency-free reader.
    return { data: parsed.data, content: parsed.content, matter: parseFrontmatterLite(text).matter }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function firstLines(text, n) {
  return text.split("\n").slice(0, n).join("\n")
}

// `readCard` always hands back a `matter` string (the raw frontmatter) and a
// `content` string (empty ones for a body-less/frontmatter-less file), so
// neither is ever null/undefined here.
function extractPrUrls(parsed) {
  const urls = new Set()
  for (const match of parsed.matter.matchAll(PR_URL_RE)) urls.add(match[0])
  for (const match of firstLines(parsed.content, 200).matchAll(PR_URL_RE)) urls.add(match[0])
  return [...urls]
}

// A "word" is 16+ hex characters, or 16+ alphanumeric characters mixing at
// least one digit and one letter — the same shape M4-1's `validateName`
// treats as a secret's value, checked case-insensitively here since a
// pre-existing directory name (never validated at creation) isn't
// guaranteed to be lowercase the way a newly-created one is.
function looksLikeSecretRun(word) {
  const candidate = word.toLowerCase()
  if (candidate.length < 16) return false
  if (/^[0-9a-f]+$/.test(candidate)) return true
  return /[0-9]/.test(candidate) && /[a-z]/.test(candidate)
}

// A path segment is credential-like when M4-1's `validateName` says so
// (a password-prefix word followed by another word, or an IPv4-looking
// run — only checked when the segment is otherwise shape-valid kebab-case),
// OR — independently, because a segment that fails that shape gate never
// reaches `validateName`'s own credential check — when any alphanumeric run
// within it (split on every non-alphanumeric character, so this catches
// hyphenated, underscored, or unseparated legacy names alike) looks like a
// secret's value on its own.
function isCredentialLikeSegment(segment) {
  if (validateName(segment).code === "credential_like") return true
  return segment.split(/[^0-9a-zA-Z]+/).some(looksLikeSecretRun)
}

// The one function every finding's `path` is built through: a POSIX-
// separated path relative to `deskRoot`, with each credential-like segment
// replaced by the literal `<redacted segment>` — never the parent-plus-leaf
// special case a single call site used to own. Applying this uniformly,
// directly against the real filesystem path rather than only at the name
// check that first notices a bad name, is what keeps a secret-shaped
// directory name from leaking through a *different* finding for the exact
// same directory (`stale_task`, `track_missing_scope`, `track_empty`,
// `loose_file`, `duplicate_job` all build paths this way too).
function redactedRelPath(deskRoot, absPath) {
  return path
    .relative(deskRoot, absPath)
    .split(path.sep)
    .map((segment) => (isCredentialLikeSegment(segment) ? REDACTED_SEGMENT : segment))
    .join("/")
}

// Maps an M4-1 validator rejection code to a doctor finding code.
// `shape`/`too_long` are both shape problems from the doctor's point of
// view; `catch_all`/`person` only ever come back from `validateTrackName`
// and already match finding codes the brief defines for tracks.
function nameFindingCode(validatorCode) {
  switch (validatorCode) {
    case "prompt_like":
      return "name_prompt_like"
    case "credential_like":
      return "name_credential_like"
    case "catch_all":
      return "track_catch_all"
    case "person":
      return "track_person_name"
    default:
      return "name_shape"
  }
}

function nameFinding({ result, deskRoot, absPath, moveHint }) {
  return {
    code: nameFindingCode(result.code),
    path: redactedRelPath(deskRoot, absPath),
    hint: `${result.hint} — ${moveHint}`,
  }
}

function processTaskDir({ taskDirAbs, deskRoot, archived, findings, liveTaskCards, now }) {
  const slug = path.basename(taskDirAbs)
  const taskMdPath = path.join(taskDirAbs, "task.md")
  const taskDirRel = redactedRelPath(deskRoot, taskDirAbs)

  const nameResult = validateName(slug)
  if (!nameResult.ok) {
    findings.push(
      nameFinding({
        result: nameResult,
        deskRoot,
        absPath: taskDirAbs,
        moveHint: "rename with task_move",
      }),
    )
  }

  const parsed = readCard(taskMdPath)
  if (!parsed) return

  const status = parsed.data.status
  const updated = parsed.data.updated
  if (!TERMINAL_STATUSES.has(status) && typeof updated === "string") {
    const updatedMs = Date.parse(updated)
    if (!Number.isNaN(updatedMs) && now - updatedMs > STALE_MS) {
      findings.push({
        code: "stale_task",
        path: `${taskDirRel}/task.md`,
        hint: "no update in 30+ days — review whether this task is still active, or tidy it",
      })
    }
  }

  if (!archived) {
    liveTaskCards.push({ path: taskDirRel, prUrls: extractPrUrls(parsed) })
  }
}

function walkTrackRoot({ trackDirAbs, deskRoot, findings, liveTaskCards, now }) {
  let liveTaskCount = 0
  let archivedTaskCount = 0

  for (const entry of safeReaddir(trackDirAbs)) {
    const entryAbs = path.join(trackDirAbs, entry.name)

    if (entry.isFile()) {
      if (entry.name === "track.md" || isDotfile(entry.name)) continue
      findings.push({
        code: "loose_file",
        path: redactedRelPath(deskRoot, entryAbs),
        hint: "loose at a track root — file it under a task folder or an underscore folder",
      })
      continue
    }

    if (!entry.isDirectory()) continue
    if (isDotfile(entry.name)) continue

    if (entry.name === "_archive") {
      for (const archivedEntry of safeReaddir(entryAbs)) {
        if (!archivedEntry.isDirectory()) continue
        const archivedTaskDirAbs = path.join(entryAbs, archivedEntry.name)
        const hasTaskMd = safeReaddir(archivedTaskDirAbs).some((e) => e.isFile() && e.name === "task.md")
        if (!hasTaskMd) continue
        archivedTaskCount += 1
        processTaskDir({
          taskDirAbs: archivedTaskDirAbs,
          deskRoot,
          archived: true,
          findings,
          liveTaskCards,
          now,
        })
      }
      continue
    }

    if (isUnderscoreDir(entry.name)) continue

    const hasTaskMd = safeReaddir(entryAbs).some((e) => e.isFile() && e.name === "task.md")
    if (!hasTaskMd) {
      findings.push({
        code: "loose_file",
        path: redactedRelPath(deskRoot, entryAbs),
        hint: "loose at a track root — this directory has no task.md; file it under a task folder or an underscore folder",
      })
      continue
    }

    liveTaskCount += 1
    processTaskDir({
      taskDirAbs: entryAbs,
      deskRoot,
      archived: false,
      findings,
      liveTaskCards,
      now,
    })
  }

  return { liveTaskCount, archivedTaskCount }
}

function processTrackDir({ trackDirAbs, deskRoot, operatorNames, findings, liveTaskCards, now }) {
  const trackName = path.basename(trackDirAbs)
  const trackMdPath = path.join(trackDirAbs, "track.md")
  const trackDirRel = redactedRelPath(deskRoot, trackDirAbs)

  const nameResult = validateTrackName(trackName, { operatorNames })
  if (!nameResult.ok) {
    findings.push(
      nameFinding({
        result: nameResult,
        deskRoot,
        absPath: trackDirAbs,
        moveHint: "rename with track_rename",
      }),
    )
  }

  const parsed = readCard(trackMdPath)
  if (parsed) {
    const scopeResult = validateScope(parsed.data.scope)
    if (!scopeResult.ok) {
      findings.push({
        code: "track_missing_scope",
        path: `${trackDirRel}/track.md`,
        hint: `${scopeResult.hint} — set it with track_update`,
      })
    }
  }

  const { liveTaskCount, archivedTaskCount } = walkTrackRoot({
    trackDirAbs,
    deskRoot,
    findings,
    liveTaskCards,
    now,
  })

  if (liveTaskCount === 0 && archivedTaskCount === 0) {
    findings.push({
      code: "track_empty",
      path: trackDirRel,
      hint: "no live or archived tasks under this track",
    })
  }
}

function walkDeskLevel({ scanRoot, deskRoot, operatorNames, findings, liveTaskCards, now }) {
  for (const entry of safeReaddir(scanRoot)) {
    const entryAbs = path.join(scanRoot, entry.name)

    if (entry.isFile()) {
      if (DESK_ROOT_ALLOWED_FILES.has(entry.name) || isDotfile(entry.name)) continue
      findings.push({
        code: "loose_file",
        path: redactedRelPath(deskRoot, entryAbs),
        hint: "loose at the desk root — file it under a track or an underscore folder",
      })
      continue
    }

    if (!entry.isDirectory()) continue

    // Dot-folders (`.git/`, `.state/`, `.github/`) are allowed like dotfiles.
    if (isDotfile(entry.name)) continue
    if (isUnderscoreDir(entry.name)) continue
    // Never walk into a crew container — a peer's own desk is theirs.
    if (entry.name === "desks") continue
    if (DESK_ROOT_ALLOWED_DIRS.has(entry.name)) continue

    const hasTrackMd = safeReaddir(entryAbs).some((e) => e.isFile() && e.name === "track.md")
    if (!hasTrackMd) {
      findings.push({
        code: "loose_file",
        path: redactedRelPath(deskRoot, entryAbs),
        hint: "loose at the desk root — this directory has no track.md; file it under a track or an underscore folder",
      })
      continue
    }

    processTrackDir({
      trackDirAbs: entryAbs,
      deskRoot,
      operatorNames,
      findings,
      liveTaskCards,
      now,
    })
  }
}

// Every `path` fed in here already went through `redactedRelPath`, so a
// credential-like task directory's segment is already `<redacted segment>`
// by the time it reaches this function — `path`/`hint` below never need
// (and never get a chance) to re-leak it.
function findDuplicateJobs(liveTaskCards) {
  const byUrl = new Map()
  for (const card of liveTaskCards) {
    for (const url of card.prUrls) {
      if (!byUrl.has(url)) byUrl.set(url, [])
      byUrl.get(url).push(card.path)
    }
  }

  const findings = []
  for (const paths of byUrl.values()) {
    if (paths.length < 2) continue
    for (const taskPath of paths) {
      const others = paths.filter((other) => other !== taskPath)
      findings.push({
        code: "duplicate_job",
        path: `${taskPath}/task.md`,
        hint: `references the same pull request as ${others.join(", ")} — consider consolidating`,
      })
    }
  }
  return findings
}

// A single composite key per finding, so the comparator itself is branch-free.
function sortKey(finding) {
  return `${finding.code}\u0000${finding.path}`
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
}

/**
 * organizationFindings(deskRoot, { personPrefix, operatorNames, now }) ->
 *   Array<{ code, path, hint }>
 *
 * Read-only. `personPrefix` is the absolute subtree root to scan (defaults
 * to `deskRoot` — a solo desk); `operatorNames` feeds `track_person_name`;
 * `now` (epoch ms, defaults to `Date.now()`) drives `stale_task`.
 */
export function organizationFindings(deskRoot, { personPrefix, operatorNames = [], now } = {}) {
  const scanRoot = personPrefix ?? deskRoot
  const effectiveNow = now ?? Date.now()
  const findings = []
  const liveTaskCards = []

  walkDeskLevel({
    scanRoot,
    deskRoot,
    operatorNames,
    findings,
    liveTaskCards,
    now: effectiveNow,
  })

  findings.push(...findDuplicateJobs(liveTaskCards))

  return sortFindings(findings)
}
