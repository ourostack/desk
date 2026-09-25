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
// Loose-file allow-lists (rulings, 2026-09-25):
//   - desk root: track folders, underscore folders, `desks/` (crew),
//     `AGENTS.md`, `README.md`, `CLAUDE.md`, dotfiles.
//   - track root: `track.md`, task folders, underscore folders.
// A "track folder" is a directory whose immediate root has a `track.md`; a
// "task folder" is a directory whose immediate root has a `task.md`.
// Anything else is loose.
//
// Name findings (`name_shape`, `name_prompt_like`, `name_credential_like`,
// `track_person_name`, `track_catch_all`) reuse M4-1's `validateName` /
// `validateTrackName` against every existing track/task directory name —
// unlike the CRUD tools, the doctor's job is exactly to surface a
// pre-existing bad name for tidying, not to gate a write. A rejection whose
// code is `credential_like` never echoes the offending path segment: the
// finding's `path` is the parent path plus the literal `<redacted segment>`.
//
// `duplicate_job` scans every *non-archived* task card's frontmatter (whole
// object, stringified) and the first 200 lines of its body for a pull
// request URL; two or more cards sharing one URL are each flagged.
//
// `stale_task` flags a non-terminal task (`status` not `done`/`cancelled`)
// whose `updated` is more than 30 days before `now`.

import { readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"
import matter from "gray-matter"
import { validateName, validateTrackName, validateScope } from "./naming.js"

// Mirrors tools/task.js's TERMINAL_STATUSES — duplicated rather than
// imported to keep this read-only reporting module independent of the CRUD
// tool's internals.
const TERMINAL_STATUSES = new Set(["done", "cancelled"])

const STALE_MS = 30 * 24 * 60 * 60 * 1000

const DESK_ROOT_ALLOWED_FILES = new Set(["AGENTS.md", "README.md", "CLAUDE.md"])

// A pull request URL, generic enough to cover github.com and enterprise/ADO
// style hosts: scheme, host+path, then `/pull/<number>`.
const PR_URL_RE = /https?:\/\/[^\s)"'<>]+\/pull\/\d+/g

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

// Any failure reading or parsing a card (missing, unreadable, or malformed
// frontmatter) is treated the same way: the doctor skips what it can't make
// sense of rather than throwing, matching `safeReaddir`'s tolerance.
function readCard(filePath) {
  try {
    return matter(readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

// POSIX-separated relative path, for stable cross-platform finding paths.
function relPath(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join("/")
}

function firstLines(text, n) {
  return text.split("\n").slice(0, n).join("\n")
}

// gray-matter always hands back a `data` object and a `content` string
// (empty ones for a body-less/frontmatter-less file), so neither is ever
// null/undefined here.
function extractPrUrls(parsed) {
  const urls = new Set()
  const frontmatterText = JSON.stringify(parsed.data)
  for (const match of frontmatterText.matchAll(PR_URL_RE)) urls.add(match[0])
  for (const match of firstLines(parsed.content, 200).matchAll(PR_URL_RE)) urls.add(match[0])
  return [...urls]
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

function nameFinding({ result, deskRoot, parentAbs, segment, moveHint }) {
  const code = nameFindingCode(result.code)
  const parentRel = relPath(deskRoot, parentAbs)
  const isRedacted = code === "name_credential_like"
  const leaf = isRedacted ? "<redacted segment>" : segment
  const findingPath = parentRel ? `${parentRel}/${leaf}` : leaf
  return {
    code,
    path: findingPath,
    hint: `${result.hint} — ${moveHint}`,
  }
}

function processTaskDir({
  taskDirAbs,
  deskRoot,
  parentAbs,
  archived,
  findings,
  liveTaskCards,
  now,
}) {
  const slug = path.basename(taskDirAbs)
  const taskMdPath = path.join(taskDirAbs, "task.md")
  const taskDirRel = relPath(deskRoot, taskDirAbs)

  const nameResult = validateName(slug)
  if (!nameResult.ok) {
    findings.push(
      nameFinding({
        result: nameResult,
        deskRoot,
        parentAbs,
        segment: slug,
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
        path: relPath(deskRoot, entryAbs),
        hint: "loose at a track root — file it under a task folder or an underscore folder",
      })
      continue
    }

    if (!entry.isDirectory()) continue

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
          parentAbs: entryAbs,
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
        path: relPath(deskRoot, entryAbs),
        hint: "loose at a track root — this directory has no task.md; file it under a task folder or an underscore folder",
      })
      continue
    }

    liveTaskCount += 1
    processTaskDir({
      taskDirAbs: entryAbs,
      deskRoot,
      parentAbs: trackDirAbs,
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
  const parentAbs = path.dirname(trackDirAbs)
  const trackMdPath = path.join(trackDirAbs, "track.md")
  const trackDirRel = relPath(deskRoot, trackDirAbs)

  const nameResult = validateTrackName(trackName, { operatorNames })
  if (!nameResult.ok) {
    findings.push(
      nameFinding({
        result: nameResult,
        deskRoot,
        parentAbs,
        segment: trackName,
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
        path: relPath(deskRoot, entryAbs),
        hint: "loose at the desk root — file it under a track or an underscore folder",
      })
      continue
    }

    if (!entry.isDirectory()) continue

    if (isUnderscoreDir(entry.name)) continue
    // Never walk into a crew container — a peer's own desk is theirs.
    if (entry.name === "desks") continue

    const hasTrackMd = safeReaddir(entryAbs).some((e) => e.isFile() && e.name === "track.md")
    if (!hasTrackMd) {
      findings.push({
        code: "loose_file",
        path: relPath(deskRoot, entryAbs),
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
