// embed-query.js — embed a search query for the desk MCP search tools.
//
// Thin wrapper over `../indexer/embed.js`'s embedChunk. Same Ollama endpoint,
// same model, same soft-fail behaviour: when Ollama is unreachable we return
// `{ vector: null, available: false }` rather than throwing, so the search
// tools can degrade to FTS-only.
//
// Kept separate from the indexer module because:
//   - the indexer is batch-oriented (embedChunks aborts on first failure to
//     avoid hammering a dead Ollama); query-time is single-shot
//   - tests can inject a deterministic `fetch` here without poking the
//     indexer's internals
//   - a caller that reads more than once for one request passes
//     `opts.queryVectors`, a Map, so the query is embedded only once

import { embedChunkDetailed } from "../indexer/embed.js"

/**
 * Embed a query string. Returns `{ vector, available }` — `vector` is a
 * Float32-friendly 768-dim array on success, null on soft-fail. `available`
 * is the boolean form callers use to flip semantic vs FTS-only paths.
 *
 * @param {string} query
 * @param {object} [opts] — forwarded to embedChunk (endpoint, model, fetch);
 *   `queryVectors`, when given, is a Map that keeps each answered query's
 *   vector for the rest of one request.
 * @returns {Promise<{ vector: number[] | null, available: boolean }>}
 */
export async function embedQuery(query, opts = {}) {
  if (typeof query !== "string" || query.trim().length === 0) {
    return { vector: null, available: false, diagnostic: null }
  }
  const kept = opts.queryVectors?.get(query)
  if (kept) return kept
  const result = await embedChunkDetailed(query, opts)
  const answer = {
    vector: result.vector,
    available: result.available,
    diagnostic: result.diagnostic,
  }
  if (answer.available) opts.queryVectors?.set(query, answer)
  return answer
}
