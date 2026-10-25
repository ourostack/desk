# Search roadmap

Desk search now runs inside each session's Desk MCP server: an in-memory exact-word index, a small built-in embedding model, and section vectors in `.state/desk-vectors.sqlite` (see `plugins/desk/mcp/src/search/`). The capabilities below were removed or switched off to get there. Rebuild one only when a real session needs it, and record which session.

| Removed capability | Problem it would solve |
| --- | --- |
| A separate search controller process shared by every session on a desk | Several sessions on one desk each keep their own exact-word index and embed what the shared vectors file lacks; one process would do that work once. |
| Ownership and election between Desk builds sharing one index | Different Desk versions writing one shared index safely. Today nothing is shared except the vectors file, which is keyed by text and model, so no build can damage another's data. |
| The write journal, event fences and freshness proofs | Proving that a search result covers every write made before it. Today a write or a file-watcher event marks the index stale, and the next search re-reads the changed files first. |
| Barrier waits and the meaning-search deadline | Making recall wait until every section is embedded. Today recall answers at once and fills the gap with exact-word matches. |
| Hung-controller detection and `desk_doctor` `reclaim_controller` | Only needed while search ran in its own process. |
| Ollama embeddings (`nomic-embed-text`, 768 dimensions) | Better meaning matches than the built-in static model. A stronger in-process model (for example MiniLM through WASM on a worker thread) is the next step if recall quality falls short; it must stay install-free. |
| Shared vector packs and index snapshots shipped in the plugin | An instant first run on a very large desk. Today the first embedding of a 19,000-section desk takes about 20 seconds in the background. The code is still in the repository but no longer called; delete it with its release checks. |
| Meaning-based ranking inside `desk_search` and `desk_timeline` | Hybrid exact-word plus meaning ranking. These tools now rank exact words only; `desk_recall` covers meaning. |
| Cleanup of vectors no section uses any more | The vectors file only grows (about 1.5 KB per distinct section text). Add compaction if it becomes large. |
| A persisted exact-word index, or one built off the main thread | Each session builds its index in memory at start: about 5 s on a copy of a 19,000-section desk, and the last database write of that build blocks the server for about 2 s once. Persist the index or build it on a worker thread if that pause shows up in real sessions. |
| `sqlite-vec` nearest-neighbour search | Recall compares the query with every vector in memory, which is fast to roughly 100,000 sections. Add an index above that. |
