# desk MCP server

Spawned by consumers (Claude Code, Copilot CLI, ouroboros daemon) to expose a uniform tool surface for working with a desk workspace. Tools include task / track / friction / lesson CRUD and hybrid lexical+semantic search.

## Run it directly

```sh
node ./index.js --root ~/AgentBundles/<agent>.ouro/desk
```

Or via environment:

```sh
DESK=~/<your-workspace> node ./index.js
```

## Tools exposed (16)

**Runtime CRUD:**
- `task_create`, `task_update`, `task_archive`
- `track_create`, `track_update`
- `friction_add`, `lesson_add`

**Status:**
- `desk_status` — session-start-safe MCP health, root, activation, index, snapshot, and vector-pack status
- `desk_doctor` — healthy-runtime confirmation or precise first-boot failure diagnosis and remediation

**Private work measurement:**
- `desk_work_ledger` — the owner's own work-item ledger, kept in their private state directory outside Git, the search index and telemetry; it measures work, not people

**Search:**
- `desk_search` — hybrid lexical + semantic
- `desk_recall` — semantic-only loose recall with auto-clustering
- `desk_similar` — find docs similar to a given path
- `desk_timeline` — temporal queries
- `desk_thread` — provenance walk via refs_graph
- `desk_reindex` — rebuild or repair the local search index

All 16 tools are wired to real implementations. There is no qualitative feedback tool: preview feedback a participant chooses to offer is written as Markdown in their own desk at `_meta/preview-feedback.md`, and the protected store that already holds private records is retained as a [storage primitive](docs/private-feedback.md) with no route from this server. The optional `desk_doctor` input `{"format":"preview"}` returns a [minimal local diagnostic snapshot](../docs/preview-diagnostics.md), not feedback collection or a network report.

## How consumers wire this up

Desk ships host-specific declarations for hosts with different plugin-root
contracts. Copilot loads `.mcp.copilot.json`:

```json
{
  "mcpServers": {
    "desk": {
      "type": "stdio",
      "command": "node",
      "args": ["${COPILOT_PLUGIN_ROOT}/mcp/index.js"],
      "env": {}
    }
  }
}
```

Copilot expands `${COPILOT_PLUGIN_ROOT}` to the installed plugin directory before
launching the server, so startup is independent of the session working directory.
Claude Code, Codex, and generic Ouroboros consumers continue to use `.mcp.json`,
whose relative entrypoint is resolved by their host-specific activation path.

Codex global activation writes an owned `~/.codex/desk.activation.json` file in the default Codex profile. When that file exists, the MCP entrypoint auto-loads it at startup so `desk_status` can report the selected activation target, overlay chain, desk root, and runtime cache. Project-local Codex activation passes the same config explicitly with `--activation-config .codex/desk.activation.json`.

Generated Codex activation configs carry the normalized manifest `desk_runtime` policy. Person-scoped activation requires an explicit valid `person` adapter input and passes it through the existing `--person` launch argument. The standalone Codex adapter refuses named `authority_provider` policies with `authority_invalid`: it cannot serialize or install an authority callback into the child process, and must never substitute workspace authority.

`desk_runtime.semantic` controls startup convergence. `background` serves at `CONTROL_READY` and converges asynchronously. `unsupported` keeps automatic lexical convergence but skips embedding calls. `required` completes convergence and verifies a complete semantic barrier before starting MCP; missing coverage or a failed barrier refuses admission with `semantic_unavailable`. Controller compatibility includes semantic mode and embedding specification as well as the lexical contract.

The controller serializes convergence, not its clients. A concurrent request receives `{ accepted: true, reused: true, in_progress: true }` with the current state; a caller can wait using `barrier({ capability: "lexical" | "semantic", wait: true })`. Disconnecting the requesting client does not cancel the operation. Failed work remains retryable on a subsequent convergence request. The controller process stays live while its operation runs; this does not make it survive termination of the controller process itself.

## Generic stdio MCP launch

Generic stdio hosts can launch Desk as an MCP-only server, but generic stdio does not activate `worker` and does not resolve plugin dependencies for Work Suite.

Bind the root explicitly:

```sh
DESK=~/desk
node /path/to/plugins/desk/mcp/index.js --root "$DESK"
```

If the host cannot pass environment variables, pass the same concrete path directly:

```sh
node /path/to/plugins/desk/mcp/index.js --root ~/desk
```

This path provides MCP tools only; there is no worker activation, default agent preamble, or plugin dependency closure.

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `better-sqlite3` — local SQLite for the search index
- `sqlite-vec` — vector search extension
- `gray-matter` — YAML frontmatter parser

`sqlite-vec` and `better-sqlite3` are native deps. Healthy plugin activation restores the committed production runtime pack into a writable cache.

Desk validates the committed runtime support matrix before loading production dependencies. If the host's Node ABI is unsupported, Desk searches only bounded local Node locations (the active executable, `PATH`, and standard NVM, Volta, asdf, and mise locations) and performs at most one guarded stdio-preserving handoff to a compatible runtime. It never installs, downloads, or reaches the network during startup. If no healthy local path exists, a dependency-free diagnostic MCP remains live with `desk_status` and `desk_doctor`; all mutation tools fail closed with the same diagnosis and offline remediation instead of crashing the host.

### Developer notes

Direct development checkouts can still run `npm install` when intentionally working on the MCP package.

Semantic ranking requires Ollama with `nomic-embed-text` pulled. The active embedding specification pins this model for both document and query embeddings. With semantic mode `background` or `required`, startup refuses an effective `DESK_EMBED_MODEL` (or fallback `OLLAMA_EMBED_MODEL`) that differs from the pinned model, before connecting to a readiness controller or calling an embedding endpoint. Unset the override or set it to `nomic-embed-text`; another model requires a separately versioned embedding specification. The runtime does not rewrite the override or fall back to lexical-only startup for this configuration error.

Semantic mode `unsupported` ignores model configuration at startup and skips embedding during automatic convergence. Explicit indexed queries and `desk_reindex` can still generate embeddings, so their MCP dispatch checks the same model pin before any index or endpoint work, including in `unsupported` mode. A differing model is refused, not silently replaced. This also covers `desk_thread`, whose index refresh can generate document vectors. Low-level embedding helpers retain explicit `opts.model` injection for isolated tests and future specification work, not ordinary runtime model selection.

Semantic-enabled index convergence automatically migrates legacy vectors whose local `meta` provenance is absent or does not match the complete active embedding specification and provenance version. It discards only derived vectors and embedding-failure tombstones, retaining documents, lexical state, and history. Provenance is established after complete active-model generation, complete validated current-spec artifact coverage, or an empty index. An incomplete migration leaves provenance absent and retries on the next convergence; this can repeat successful partial embedding work. Matching provenance avoids that invalidation. `unsupported` / `skipEmbed` convergence neither invalidates nor establishes provenance; the next semantic-enabled admission performs the migration. No operator repair, schema change, or artifact rebuild is required.

The MCP resolves the embedding endpoint in this order: explicit test/tool `endpoint`, `DESK_EMBED_ENDPOINT`, `DESK_OLLAMA_ENDPOINT`, `OLLAMA_HOST`, `http://127.0.0.1:11434`, then `http://localhost:11434`. Set `DESK_EMBED_TIMEOUT_MS` to adjust the per-endpoint timeout.

If Ollama is unavailable, search soft-falls-back to FTS5-only with `semantic_unavailable` plus `semantic_diagnostic` and `semantic_repair` fields in the response. If a desk was indexed while Ollama was down, `desk_reindex` without arguments now repairs missing vectors automatically once embeddings are reachable; `force:true` is only needed when you intentionally want to drop and rebuild the whole DB.

## Shared Workspace Artifacts

The local index remains machine-local at `$DESK/.state/desk-index.sqlite`. Shared document embeddings and warm-start snapshots live outside `.state/` under `$DESK/artifacts/`:

- `$DESK/artifacts/vector-packs/<embedding-spec-id>/<pack-id>.jsonl`
- `$DESK/artifacts/snapshots/<embedding-spec-id>/<snapshot-id>.sqlite.zst`

Runtime startup prefers workspace artifacts over plugin release artifacts. It restores compatible snapshots by copying them into `.state/`, falls back to vector packs when needed, and only generates document embeddings for chunks not covered by committed artifacts.

## Artifact privacy

Embeddings and snapshots are derivative data and may carry privacy risk. Vector packs store document-side embedding data, and snapshots may preserve searchable index state, so artifact publication is explicit, policy-checked, and separate from ordinary MCP startup.

## Tests

```sh
npm test
```

Boots the server with temp roots, asserts the tool surface registers, and exercises the real tool bodies via the dispatcher and fixture desks.

Run the same changed-production coverage gate used by CI with Node 22 or later:

```sh
npm run test:coverage
```

The gate runs the maintained tests through pinned `nyc` and `@istanbuljs/esm-loader-hook` development dependencies, then reads their JSON report. Statements are AST-instrumented units, not a copy of line coverage. The existing per-file thresholds and documented exclusions remain authoritative; the producer does not impose a separate global threshold. The pinned `test-exclude` override is covered by selector and real ESM/CommonJS execution fixtures. Source roots are canonicalized before instrumentation, and owned temporary reports are removed after evaluation. A nested invocation is refused with a failure status rather than reported as an unmeasured pass.
