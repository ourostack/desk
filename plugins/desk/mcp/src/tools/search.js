// Public search tools go to the session's search engine (src/search/engine.js), or to the files before it starts.
// The indexed backends here rank exact-word results over an index database: the engine's in-memory one, or a
// disposable corpus read straight from the files (src/search/direct-lexical.js). Meaning-based ranking lives in the
// engine; these rank by BM25, recency, state and the active-iteration pin (util/rank.js).

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { toDeskPath } from "../util/paths.js"
import { searchRouter } from "../search/files-router.js"
import { objectInput } from "../util/object-input.js"
import {
  combineScore,
  normalizeBm25,
  recencyDecay,
  stateBias,
} from "../util/rank.js"

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const SNIPPET_MAX_CHARS = 280

// Every field each search tool reads off `input` — not in the exported
// `desk_search`/`desk_recall`/`desk_similar`/`desk_timeline` themselves
// (they spread `...input` into the query router unread) but in the paired
// `indexed*` function below that actually destructures it. Kept next to
// this module so a field added to one of those reads is a field added here
// in the same diff. __tests__/tool_schema_parity.test.js checks these
// against each tool's declared schema in tool-schemas.js.
export const DESK_SEARCH_FIELDS = ["query", "limit", "filters", "scope"]
export const DESK_RECALL_FIELDS = ["topic", "limit", "scope"]
export const DESK_SIMILAR_FIELDS = ["path", "limit", "scope"]
export const DESK_TIMELINE_FIELDS = ["from", "to", "query", "limit", "scope"]
/**
 * Read `<deskRoot>/_meta/featured.md` and return the first track slug listed
 * (one per line). Returns null when absent or empty.
 */
async function readFeaturedTrack(deskRoot) {
  try {
    const raw = await fs.readFile(
      path.join(deskRoot, "_meta", "featured.md"),
      "utf8",
    )
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.length > 0 && !trimmed.startsWith("#")) {
        return trimmed
      }
    }
    return null
  } catch (err) {
    if (err.code === "ENOENT") return null
    throw err
  }
}

/**
 * Find the active-iteration directory (relative to deskRoot) for the
 * featured track's task(s). Per planning Unit 5: "first featured track's
 * active iteration (the most recent iterations.history[] entry with
 * outcome: in-progress)".
 *
 * Returns a Set of relative-path prefixes such that any chunk whose doc.path
 * starts with one of these strings gets the +0.30 pin bonus.
 */
function computePinPrefixes(db, featuredTrack) {
  if (!featuredTrack) {
    return new Set()
  }

  // Pull all task.md docs in the featured track that have iteration history.
  const taskRows = db
    .prepare(
      "SELECT path, frontmatter FROM docs WHERE track = ? AND kind = 'task'",
    )
    .all(featuredTrack)

  const prefixes = new Set()
  for (const row of taskRows) {
    let fm
    const frontmatter =
      typeof row.frontmatter === "string" && row.frontmatter.length
        ? row.frontmatter
        : "{}"
    try {
      fm = JSON.parse(frontmatter)
    } catch {
      continue
    }
    const history = fm?.iterations?.history
    if (!Array.isArray(history)) continue
    // Walk in reverse — most-recent first — and take the first entry
    // with outcome=in-progress (per Unit 5 spec). Tolerate string variants.
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]
      if (!entry || typeof entry !== "object") continue
      const outcome =
        typeof entry.outcome === "string" ? entry.outcome.toLowerCase() : ""
      if (outcome !== "in-progress") continue
      if (typeof entry.path !== "string" || !entry.path.length) continue
      // entry.path is relative to the task dir (e.g. "./OrderService/...").
      // Normalize against the task dir so we get a desk-root-relative prefix.
      const taskDir = path.posix.dirname(toDeskPath(row.path))
      let rel = entry.path.replace(/^\.\//, "")
      const combined = path.posix.join(taskDir, toDeskPath(rel))
      prefixes.add(combined)
      break
    }
  }
  return prefixes
}

/** True if `docPath` falls under any of the pin prefixes. */
function isPinned(docPath, pinPrefixes) {
  if (!pinPrefixes.size) {
    return false
  }
  for (const p of pinPrefixes) {
    if (
      docPath === p ||
      docPath.startsWith(p + "/")
    ) {
      return true
    }
  }
  return false
}

/** Trim a chunk text to a snippet, preferring sentence-ish boundaries. */
export function makeSnippet(text, queryTerms) {
  if (!text) return ""
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= SNIPPET_MAX_CHARS) return flat

  // Try to center the snippet around the first match of any query term.
  const terms = Array.isArray(queryTerms) ? queryTerms : []
  if (terms.length) {
    const lower = flat.toLowerCase()
    for (const term of terms) {
      const t = term.toLowerCase().trim()
      if (!t) continue
      const idx = lower.indexOf(t)
      if (idx < 0) continue
      const start = Math.max(0, idx - Math.floor(SNIPPET_MAX_CHARS / 2))
      const end = Math.min(flat.length, start + SNIPPET_MAX_CHARS)
      const prefix = start > 0 ? "..." : ""
      const suffix = end < flat.length ? "..." : ""
      return prefix + flat.slice(start, end) + suffix
    }
  }
  return flat.slice(0, SNIPPET_MAX_CHARS) + "..."
}

/** Clamp limit to [1, MAX_LIMIT] with a sane default. */
function clampLimit(limit) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

/**
 * Split a query string into FTS5-safe tokens. FTS5 MATCH expressions accept
 * a phrase / boolean grammar; for hybrid search we just want OR-ed terms.
 * We strip punctuation that FTS5 treats as operators and join with OR.
 *
 * Returns `{ matchExpr, terms }` where `matchExpr` is what we feed to MATCH
 * and `terms` is the raw token list used for snippet centering.
 */
function buildFtsQuery(query) {
  const terms = (query ?? "")
    .split(/[^A-Za-z0-9_]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
  if (!terms.length) return { matchExpr: null, terms: [] }
  // Quote each term to neutralize any residual FTS5 operator interpretation;
  // join with OR for a relaxed lexical match.
  const matchExpr = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ")
  return { matchExpr, terms }
}

// ---------------------------------------------------------------------------
// Shared candidate-gathering helpers.
// ---------------------------------------------------------------------------

/**
 * Resolve the `scope` parameter to a docs-level filter clause.
 *
 * `scope` values:
 *   "active"   — is_archived = 0 (default for desk_search)
 *   "archived" — is_archived = 1
 *   "all"      — no filter (default for desk_recall, desk_similar, desk_timeline)
 *
 * If the caller passes an unrecognized value, falls back to the toolDefault.
 *
 * @param {string|undefined} scope  caller-supplied value
 * @param {"active"|"archived"|"all"} toolDefault per-tool default
 * @param {string} alias SQL table alias
 * @returns {{sql: string, params: Array}}
 */
function resolveScopeFilter(scope, toolDefault, alias = "d") {
  const resolved = ["active", "archived", "all"].includes(scope)
    ? scope
    : toolDefault
  if (resolved === "all") return { sql: "", params: [] }
  if (resolved === "archived") {
    return { sql: ` AND ${alias}.is_archived = 1`, params: [] }
  }
  // "active" (the default)
  return { sql: ` AND ${alias}.is_archived = 0`, params: [] }
}

/**
 * Build the `WHERE` clause + bind values for the docs-level filter set.
 * Returns `{ sql, params }`. `sql` is empty string when no filters; else
 * starts with " AND ...".
 *
 * Note: `scope` is handled separately by `resolveScopeFilter()` so per-tool
 * defaults can differ. Callers compose the two: `${filterFragment}${scopeFragment}`.
 */
function buildDocsFilter(filters, alias = "d") {
  if (!filters || typeof filters !== "object") return { sql: "", params: [] }
  const clauses = []
  const params = []
  if (filters.track) {
    if (Array.isArray(filters.track)) {
      if (filters.track.length) {
        clauses.push(
          `${alias}.track IN (${filters.track.map(() => "?").join(",")})`,
        )
        params.push(...filters.track)
      }
    } else if (typeof filters.track === "string") {
      clauses.push(`${alias}.track = ?`)
      params.push(filters.track)
    }
  }
  if (filters.status) {
    const arr = Array.isArray(filters.status) ? filters.status : [filters.status]
    const clean = arr.filter((s) => typeof s === "string" && s.length)
    if (clean.length) {
      clauses.push(`${alias}.status IN (${clean.map(() => "?").join(",")})`)
      params.push(...clean)
    }
  }
  if (filters.kind) {
    const arr = Array.isArray(filters.kind) ? filters.kind : [filters.kind]
    const clean = arr.filter((s) => typeof s === "string" && s.length)
    if (clean.length) {
      clauses.push(`${alias}.kind IN (${clean.map(() => "?").join(",")})`)
      params.push(...clean)
    }
  }
  if (filters.since && typeof filters.since === "string") {
    clauses.push(`${alias}.updated_at >= ?`)
    params.push(filters.since)
  }
  if (filters.until && typeof filters.until === "string") {
    clauses.push(`${alias}.updated_at <= ?`)
    params.push(filters.until)
  }
  if (!clauses.length) return { sql: "", params: [] }
  return { sql: " AND " + clauses.join(" AND "), params }
}

/**
 * Gather candidate chunks from FTS5 with raw bm25 scores. Returns rows of
 * `{ chunk_id, doc_id, raw_bm25 }`. Bm25 is sqlite's bm25() — negative
 * floats with lower-magnitude = more relevant (we flip + normalize later).
 *
 * filterFragment is the AND-prefixed snippet from buildDocsFilter; params is
 * its bind values.
 */
function gatherFtsCandidates(db, matchExpr, filterFragment, filterParams, candidateLimit) {
  if (!matchExpr) return []
  const sql = `
    SELECT c.id AS chunk_id, c.doc_id AS doc_id, bm25(chunks_fts) AS raw_bm25
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN docs d ON d.id = c.doc_id
    WHERE chunks_fts MATCH ? ${filterFragment}
    ORDER BY raw_bm25, d.path, c.chunk_index
    LIMIT ?
  `
  return db.prepare(sql).all(matchExpr, ...filterParams, candidateLimit)
}

/**
 * Hydrate chunk + doc metadata for a set of chunk_ids. Returns a Map
 * chunk_id → row with { doc_path, kind, track, task_slug, status,
 * updated_at, text, heading }.
 */
function hydrateChunks(db, chunkIds) {
  if (!chunkIds.length) return new Map()
  const placeholders = chunkIds.map(() => "?").join(",")
  const rows = db
    .prepare(
      `SELECT c.id AS chunk_id, c.text, c.heading, c.doc_id,
              d.path AS doc_path, d.kind, d.track, d.task_slug,
              d.status, d.updated_at, d.is_archived
       FROM chunks c
       JOIN docs d ON d.id = c.doc_id
       WHERE c.id IN (${placeholders})
       ORDER BY d.path, c.chunk_index`,
    )
    .all(...chunkIds)
  return new Map(rows.map((r) => [r.chunk_id, r]))
}

/** Re-check a hydrated row against filters. */
function passesFilter(row, filters) {
  if (!filters) return true
  if (filters.track) {
    if (Array.isArray(filters.track)) {
      if (filters.track.length && !filters.track.includes(row.track)) return false
    } else if (row.track !== filters.track) {
      return false
    }
  }
  if (filters.status) {
    const arr = Array.isArray(filters.status) ? filters.status : [filters.status]
    if (arr.length && !arr.includes(row.status)) return false
  }
  if (filters.kind) {
    const arr = Array.isArray(filters.kind) ? filters.kind : [filters.kind]
    if (arr.length && !arr.includes(row.kind)) return false
  }
  if (filters.since && row.updated_at && row.updated_at < filters.since) return false
  if (filters.until && row.updated_at && row.updated_at > filters.until) return false
  return true
}

/** Post-filter a hydrated row by scope. */
export function passesScope(row, scope, toolDefault) {
  const resolved = ["active", "archived", "all"].includes(scope) ? scope : toolDefault
  if (resolved === "all") return true
  const archived = row.is_archived ? true : false
  if (resolved === "archived") return archived
  return !archived
}

function shouldReplaceBest(existing, score) {
  return !existing || score > existing.score
}

function comparableUpdatedAt(row) {
  return typeof row.updated_at === "string" ? row.updated_at : ""
}

function firstChunkText(row) {
  return typeof row.text === "string" ? row.text : ""
}

// ---------------------------------------------------------------------------
// Tool: desk_search
// ---------------------------------------------------------------------------

/**
 * desk_search — exact words (BM25) + recency + state-bias + pin.
 *
 * Input:
 *   { query: string, filters?: {track,status,kind,since,until}, limit?: number }
 *
 * Returns:
 *   { results: [...], search_mode: "lexical", latency_ms: number, query: string }
 */
export async function desk_search({ deskRoot, input, opts, search, queryRouter, signal }) {
  const request = { ...input }
  // A JSON-string `filters` would otherwise read as no filters at all.
  if (request.filters != null) request.filters = objectInput(request.filters, {
    tool: "desk_search",
    field: "filters",
    effect: "nothing was searched",
    example: '{"track": "desk-plugin", "status": ["implementing", "blocked"]}',
  })
  return (queryRouter ?? searchRouter(search)).lexical({
    ...request, deskRoot, now: opts?.now, opts, signal, kind: "lexical",
  })
}

// Shared result contract for the engine's index and a fresh in-memory FTS corpus; `db` is either one.
export async function indexedSearch({ deskRoot, input, opts, db }) {
  const t0 = Date.now()
  const query = String(input?.query ?? "").trim()
  if (!query) {
    return {
      results: [],
      latency_ms: 0,
      query: "",
      note: "empty query",
    }
  }
  const limit = clampLimit(input?.limit)
  const filters = input?.filters ?? null
  const scope = input?.scope
  const now = opts?.now ?? Date.now()

  const { matchExpr, terms } = buildFtsQuery(query)
  const filter = buildDocsFilter(filters)
  // desk_search default: active. Day-to-day signal; archive on opt-in.
  const scopeFilter = resolveScopeFilter(scope, "active")

  // Over-fetch; the candidates are re-ranked below.
  const ftsCandidates = gatherFtsCandidates(
    db,
    matchExpr,
    filter.sql + scopeFilter.sql,
    [...filter.params, ...scopeFilter.params],
    limit * 4,
  )
  const hydrated = hydrateChunks(db, [...new Set(ftsCandidates.map((r) => r.chunk_id))])

  // Normalize BM25 over the FTS candidate set.
  const bm25ByChunk = new Map()
  const bm25Norm = normalizeBm25(ftsCandidates.map((r) => r.raw_bm25))
  ftsCandidates.forEach((r, i) => bm25ByChunk.set(r.chunk_id, bm25Norm[i]))

  // Active-iteration pin.
  const featuredTrack = await readFeaturedTrack(deskRoot)
  const pinPrefixes = computePinPrefixes(db, featuredTrack)

  // Score every candidate and pick top-N. We dedupe by doc_id so a single
  // doc with many matching chunks doesn't crowd out the result list — keep
  // the best chunk per doc.
  const bestByDoc = new Map()
  for (const [id, row] of hydrated) {
    // The candidate query already applied the scope. It applied the filters too, but this recheck also
    // drops everything for a filter value of the wrong type, which the query ignores.
    if (!passesFilter(row, filters)) continue
    const { score, breakdown } = combineScore({
      bm25: bm25ByChunk.get(id),
      recency: recencyDecay(row.updated_at, now),
      state: stateBias(row.status),
      pin: isPinned(row.doc_path, pinPrefixes),
      semanticAvailable: false,
    })
    const existing = bestByDoc.get(row.doc_id)
    if (shouldReplaceBest(existing, score)) {
      bestByDoc.set(row.doc_id, {
        path: row.doc_path,
        kind: row.kind,
        track: row.track,
        task_slug: row.task_slug,
        status: row.status,
        updated_at: row.updated_at,
        snippet: makeSnippet(row.text, terms),
        score,
        score_breakdown: breakdown,
      })
    }
  }

  const results = [...bestByDoc.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)

  return {
    query,
    results,
    search_mode: "lexical",
    latency_ms: Date.now() - t0,
  }
}

// ---------------------------------------------------------------------------
// Tool: desk_recall
// ---------------------------------------------------------------------------

// desk_recall — "do I remember anything about X", ranked by meaning in the session's search engine
// (src/search/engine.js), which always answers.
export async function desk_recall({ deskRoot, input, opts, search, queryRouter, signal }) {
  return (queryRouter ?? searchRouter(search)).semantic({
    ...input, deskRoot, opts, signal, kind: "recall",
  })
}

// ---------------------------------------------------------------------------
// Tool: desk_similar
// ---------------------------------------------------------------------------

// desk_similar — "more like this": the documents nearest the average of the seed document's section vectors.
export async function desk_similar({ deskRoot, input, opts, search, queryRouter, signal }) {
  return (queryRouter ?? searchRouter(search)).semantic({
    ...input, deskRoot, opts, signal, kind: "similar",
  })
}

// ---------------------------------------------------------------------------
// Tool: desk_timeline
// ---------------------------------------------------------------------------

/**
 * desk_timeline — temporal slice. With `query`: exact-word search within the
 * window. Without `query`: bare chronological listing of docs touched in
 * the window.
 *
 * Input: { from: ISO, to: ISO, query?: string, limit?: number }
 * Returns: { results, search_mode, latency_ms }
 */
export async function desk_timeline({ deskRoot, input, opts, search, queryRouter, signal }) {
  return (queryRouter ?? searchRouter(search)).lexical({
    ...input, deskRoot, now: opts?.now, opts, signal, kind: "timeline",
  })
}

export async function indexedTimeline({ input, opts, db }) {
  const t0 = Date.now()
  const from = String(input?.from ?? "").trim() || null
  const to = String(input?.to ?? "").trim() || null
  const query = String(input?.query ?? "").trim()
  const limit = clampLimit(input?.limit)
  const scope = input?.scope
  const now = opts?.now ?? Date.now()

  // Window filter clauses for the docs table + scope filter.
  // desk_timeline default: "all" — timeline is already temporally bounded;
  // archive items in the window are legitimate timeline entries.
  const params = []
  const clauses = []
  if (from) {
    clauses.push("d.updated_at >= ?")
    params.push(from)
  }
  if (to) {
    clauses.push("d.updated_at <= ?")
    params.push(to)
  }
  const scopeFilter = resolveScopeFilter(scope, "all")
  const windowSql = (clauses.length ? " AND " + clauses.join(" AND ") : "") + scopeFilter.sql
  params.push(...scopeFilter.params)

  let candidateChunks = []
  if (query) {
    // Exact words within the window.
    const { matchExpr, terms } = buildFtsQuery(query)
    const ftsRows = matchExpr
      ? db
          .prepare(
            `SELECT c.id AS chunk_id, c.doc_id, bm25(chunks_fts) AS raw_bm25
             FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.rowid
             JOIN docs d ON d.id = c.doc_id
             WHERE chunks_fts MATCH ? ${windowSql}
             ORDER BY raw_bm25, d.path, c.chunk_index
             LIMIT ?`,
          )
          .all(matchExpr, ...params, limit * 4)
      : []
    const hydrated = hydrateChunks(db, [...new Set(ftsRows.map((r) => r.chunk_id))])

    const bm25ByChunk = new Map()
    const bm25Norm = normalizeBm25(ftsRows.map((r) => r.raw_bm25))
    ftsRows.forEach((r, i) => bm25ByChunk.set(r.chunk_id, bm25Norm[i]))

    const bestByDoc = new Map()
    // The query above already applied the window and scope.
    for (const [id, row] of hydrated) {
      const { score, breakdown } = combineScore({
        bm25: bm25ByChunk.get(id),
        recency: recencyDecay(row.updated_at, now),
        state: stateBias(row.status),
        pin: false, // timeline doesn't pin
        semanticAvailable: false,
      })
      const existing = bestByDoc.get(row.doc_id)
      if (shouldReplaceBest(existing, score)) {
        bestByDoc.set(row.doc_id, {
          path: row.doc_path,
          kind: row.kind,
          track: row.track,
          task_slug: row.task_slug,
          status: row.status,
          updated_at: row.updated_at,
          snippet: makeSnippet(row.text, terms),
          score,
          score_breakdown: breakdown,
        })
      }
    }
    candidateChunks = [...bestByDoc.values()]
      // Within timeline, sort by updated_at DESC per spec (recency
      // dominates inside an explicit window — score-driven ordering
      // makes more sense for desk_search where the window is implicit).
      .sort((a, b) => comparableUpdatedAt(b).localeCompare(comparableUpdatedAt(a)) || a.path.localeCompare(b.path))
      .slice(0, limit)
  } else {
    // No query — straight chronological listing within the window.
    const rows = db
      .prepare(
        `SELECT d.id AS doc_id, d.path AS doc_path, d.kind, d.track,
                d.task_slug, d.status, d.updated_at,
                (SELECT text FROM chunks WHERE doc_id = d.id ORDER BY chunk_index LIMIT 1) AS text
         FROM docs d
         WHERE 1=1 ${windowSql}
         ORDER BY d.updated_at DESC, d.path
         LIMIT ?`,
      )
      .all(...params, limit)
    candidateChunks = rows.map((r) => ({
      path: r.doc_path,
      kind: r.kind,
      track: r.track,
      task_slug: r.task_slug,
      status: r.status,
      updated_at: r.updated_at,
      snippet: makeSnippet(firstChunkText(r), []),
    }))
  }

  return {
    from,
    to,
    query: query || null,
    results: candidateChunks,
    search_mode: query ? "lexical" : "temporal",
    latency_ms: Date.now() - t0,
  }
}

export const __searchInternalsForTests = {
  buildDocsFilter,
  buildFtsQuery,
  clampLimit,
  computePinPrefixes,
  gatherFtsCandidates,
  hydrateChunks,
  isPinned,
  makeSnippet,
  passesFilter,
  passesScope,
  readFeaturedTrack,
  resolveScopeFilter,
  shouldReplaceBest,
  comparableUpdatedAt,
  firstChunkText,
}
