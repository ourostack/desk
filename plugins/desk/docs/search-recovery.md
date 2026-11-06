# Search recovery

Exact-word and timeline requests recover from classified in-memory index failures by reading current files through the existing [direct lexical backend](../mcp/src/search/direct-lexical.js). Successful recovery returns the ordinary result shape without adding a warning to each answer. It does not repair or qualify the failed index.

The [search engine](../mcp/src/search/engine.js) admits only SQLite busy, locked, I/O, corrupt-index and invalid-database errors, including their extended codes. It keeps the engine's bound desk root and the request's supported filters, scope, dates and limit. The direct corpus uses the existing discovery exclusions, redaction ledger, tokenizer and ranking. It never uses a stale index to conclude that a record is absent.

Recovery opts into a strict corpus read: it bypasses discovery caches and rejects individual file read/stat errors and paths that disappear during enumeration. Filesystem, authorization, policy and unknown errors propagate; an incomplete corpus cannot become empty success or a successful file-backend diagnostic. Ordinary discovery and direct searches before the engine starts retain their existing tolerant behavior. Aborted recovery reads remain aborted. Thread, semantic recall, similarity and explicit reindex operations are not silently replaced with a different request. This change does not broaden admission or authorize reading another root.

`searchStatus()` exposes the recovery state without claiming synchronization:

```json
{
  "state": "index_unavailable",
  "lexical_backend": "files",
  "index_error": "SQLITE_IOERR",
  "message": "The search index is unavailable; exact-word searches read current files."
}
```

`lexical_backend: "files"` follows a successful direct request. A subsequent refresh clears that success evidence, and an older overlapping recovery cannot overwrite a newer attempt's diagnostics. Restoration requires a fresh strict corpus read before it clears the failure diagnostic and returns to the ordinary search status; file results alone never establish index restoration. Cancellation during the final asynchronous ranking read also rejects the request without recording backend success.

The [regression scenarios](../../../tests/desk/mcp/__tests__/search/index_recovery.test.js) exercise two consecutive warm-index failure/recovery cycles against real Markdown and SQLite, fresh edits and additions, deletion, dates and filters, bound-root preservation, redaction, ignored paths, symlinks, individual file read/stat permission and I/O failures, cancellation and subsequent restoration. [Strict discovery controls](../../../tests/desk/mcp/__tests__/indexer/discover_strict.test.js) preserve default tolerance and reject cached success or a missing corpus. SQLite and filesystem faults are injected at their specific boundaries; these tests do not qualify installed MCP behavior, agent or transport recovery, or startup latency.
