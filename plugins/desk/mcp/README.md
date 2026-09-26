# desk MCP server

Spawned by consumers (Claude Code, Copilot CLI, ouroboros daemon) to expose a uniform tool surface for working with a desk workspace. Tools include task / track / friction / lesson CRUD and hybrid lexical+semantic search.

## Lexical-first alpha candidate

Desk `3.2.0-alpha.7` / `desk-mcp@1.4.0-alpha.6` packages the [reviewed lexical milestone](https://github.com/ourostack/ouroboros-skills/commit/0eb9ea139a997c5c39394ac7b95ab02bff7331b5): correct lexical answers during startup and file changes, fresh direct fallback when readiness is uncertain, durable journal/restart behavior, one index writer, and zero orphan vectors.

Semantic scheduling and transactional recovery are not qualified in this alpha. Repeated tombstone-policy changes fail closed but may return a generic error instead of typed `readiness_changed_during_read`. The semantic mechanisms described below are not a qualification claim. Runtime dependency packs reuse byte-identical, previously native-verified payloads with provenance; repackaging is not fresh native execution.

## Run it directly

```sh
node ./index.js --root ~/AgentBundles/<agent>.ouro/desk
```

Or via environment:

```sh
DESK=~/<your-workspace> node ./index.js
```

## Tools exposed (18)

**Runtime CRUD:**
- `task_create`, `task_update`, `task_archive`
- `track_create`, `track_update`
- `friction_add`, `lesson_add`

**Cheap moves:**
- `task_move` — move a task to another track and/or rename it (live or archived); refuses a taken target or an invalid new name, and best-effort keeps both `track.md` "## Tasks" tables in sync
- `track_rename` — rename a track, rewriting `track:` on every task card under it, live and archived

**Status:**
- `desk_status` — session-start-safe MCP health, root, activation, index, snapshot, and vector-pack status
- `desk_doctor` — healthy-runtime confirmation or precise failure diagnosis and remediation; `{"repair":"switch_state_branch"}`, `{"repair":"reclaim_controller"}` and `{"repair":"prune_readiness_state"}` run the repairs described under [Handshake first, then admission](#handshake-first-then-admission)

**Private work measurement:**
- `desk_work_ledger` — the owner's own work-item ledger, kept in their private state directory outside Git, the search index and telemetry; it measures work, not people

**Search:**
- `desk_search` — hybrid lexical + semantic
- `desk_recall` — semantic-only loose recall with auto-clustering
- `desk_similar` — find docs similar to a given path
- `desk_timeline` — temporal queries
- `desk_thread` — provenance walk via refs_graph
- `desk_reindex` — rebuild or repair the local search index

All 18 tools are wired to real implementations. There is no qualitative feedback tool: preview feedback a participant chooses to offer is written as Markdown in their own desk at `_meta/preview-feedback.md`, and the protected store that already holds private records is retained as a [storage primitive](docs/private-feedback.md) with no route from this server. The optional `desk_doctor` input `{"format":"preview"}` returns a [minimal local diagnostic snapshot](../docs/preview-diagnostics.md), not feedback collection or a network report.

## How consumers wire this up

Desk ships host-specific declarations for hosts with different plugin-root contracts. Both start `mcp/bootstrap.cjs` with whatever `node` the host finds, so Desk never depends on which Node a host or shell puts first on `PATH`. The bootstrap is written in ES5 and runs on Node 8 and later. It lists the Node binaries on `PATH` and under nvm, fnm, Volta, asdf, mise and Homebrew (on Windows: nvm-windows, fnm, Volta, mise and Program Files), keeps the ones that satisfy `engines.node` in `package.json`, and prefers the newest whose ABI has a shipped runtime pack, so `index.js` never restarts itself. It runs `index.js` in its own process when the running Node is that choice, and otherwise as a child with inherited stdio. When no compatible Node is installed, the bootstrap answers the MCP handshake itself, lists every Desk tool, and answers each call with `{"state":"degraded:node_missing","fix":"<install command for this machine>"}`. The one case it cannot cover is a machine with no `node` executable at all; Desk's setup and `desk_doctor` make sure Node is installed.

Copilot loads `.mcp.copilot.json`:

```json
{
  "mcpServers": {
    "desk": {
      "type": "stdio",
      "command": "node",
      "args": ["${COPILOT_PLUGIN_ROOT}/mcp/bootstrap.cjs"],
      "env": {}
    }
  }
}
```

Copilot expands `${COPILOT_PLUGIN_ROOT}` to the installed plugin directory before launching the server, so startup is independent of the session working directory. Claude Code, Codex, and generic Ouroboros consumers use `.mcp.json`, whose inline launcher finds the plugin through `DESK_PLUGIN_ROOT` (set from `${CLAUDE_PLUGIN_ROOT}`) or the working directory and runs the same bootstrap. If it finds neither, it still completes the handshake and reports `degraded:plugin_root_missing`.

Once Node is running, `index.js` never exits before the handshake either. On a Node older than the `engines.node` floor it goes straight to finding a compatible Node (or to diagnostic mode), and any exception before the server starts becomes diagnostic mode with `state: "degraded:startup_exception"`. Diagnostic mode lists the full tool set; tools it cannot run return `{"status":"degraded","code","fix"}`.

## Handshake first, then admission

`index.js` answers `initialize` and `tools/list` before it does anything that can fail or take time. Only two things happen before the handshake: the Node version check, and the move to a compatible Node when no shipped runtime pack fits this one (that fix needs stdio the process has not answered yet). The tool list is always the full set of 18 tools and never changes during a session.

Nothing blocks the thread that answers the host. Admission starts only after the first `tools/list` reply (or after 1 s when no client asks). Root and activation resolution, the pack inspection and the runtime restore (which can wait up to 30 s on another process's publication lock) run on a worker thread (`src/runtime/admission-worker.js`); Git and the readiness controller are asynchronous. `initialize`, `tools/list`, `ping` and `desk_status` answer within 200 ms whatever admission is doing, including the transition to `ready`: the admission worker loads the restored native modules (`better-sqlite3` and `sqlite-vec`) once, so their first load never runs on the thread that answers the host, the runtime server is imported one local module per turn of the event loop, background convergence starts on a later turn, and opening the index database is split from the checks after it. Measured on a loaded Mac (load average 9 to 12) over 18 runs, the slowest answer through the transition was 50 to 75 ms; without the native warm-up it was 79 to 181 ms. Earlier measurements saw a rare whole-process stall of 236 to 314 ms under heavy load, which delays `ping` as much as `desk_status`, so the bound is normal operation, not a guarantee on a starved machine. `desk_status` joins an attempt that is already running without waiting on it, waits briefly for one it starts, and spends at most 90 ms of its own on the runtime status detail; when that detail is late it serves the last one, marked `cached`.

Admission runs in the background (`src/runtime/desk-session.js`, `src/runtime/admission.js`): root resolution, the activation config and its `desk_runtime` policy, the runtime restore, the state-branch check, write authority and the readiness controller. Its state is `admitting`, then `ready` or `degraded:<code>`:

- A degraded session retries on its own after 1, 2, 5, 10 and 30 s, then every 60 s, and at once on every `desk_status` call and on a change to the checkout's `.git/HEAD`. A fix the agent makes in the session (creating the desk, correcting the activation config, pushing local commits) upgrades the same session to `ready` with no restart.
- `desk_status` always answers, with `state`, `code`, `fix`, the latest `repair` and an `admission` block (attempts, next retry, state branch, controller, a hung controller's missed checks and owner, whether writes are available, exceptions caught after the handshake, and the launcher mode).
- Reads (`desk_search`, `desk_recall`, `desk_similar`, `desk_timeline`, `desk_thread`) need the runtime and a root. Without a readiness controller, lexical search and timeline read the files directly.
- `desk_work_ledger` also needs admitted write authority; `desk_reindex` needs the readiness controller.
- Writes (`task_*`, `track_*`, `friction_add`, `lesson_add`) need admitted write authority and the checkout on its state branch, re-checked before every write. They never need the readiness controller: with one that answers, the change is journaled through it; without one, it goes straight to the file and a controller's watcher, or the next controller's convergence scan, picks it up.
- A tool whose needs are not met returns `{"status":"degraded","state","code","fix","blockers","tool"}` with a fix the agent can act on in the session. A tool that throws returns the same shape with `code: "tool_exception"`.
- After the handshake, an uncaught exception or unhandled rejection never ends the process, on every launch path (`node index.js`, `bootstrap.cjs` running `index.js` in its own process or re-running it as a child, and the Claude `.mcp.json` inline launcher): Desk records it, moves to `degraded:runtime_exception`, keeps serving and re-admits on its backoff.

Desk records each state change in its state directory, `$XDG_STATE_HOME/ouroboros-skills/desk` or `~/.local/state/ouroboros-skills/desk`: `last-start.json` holds the latest record of any session (`state`, `code`, `repair`, `fix`, `root`, `pid`), starting with `admitting`, and `last-start/<root key>.json` holds each root's own record, which also starts with `admitting` as soon as the session resolves the root (the key is the first 16 hex digits of the SHA-256 of the root path). `desk_status`'s `admission.last_start` names the root's own record once the root is known. Each repair Desk makes is appended to `repairs.log`. Tests and embedders pass `stateHome` to `main()` to keep all of this, and the readiness controllers, in a temporary folder.

### The readiness controller

- **One rendezvous per root.** Every session derives the controller socket from the real root path, the user and the lexical contract, in the per-user folder `/tmp/desk-readiness-<uid>`, whatever `XDG_RUNTIME_DIR` or `TMPDIR` say, so sessions started from different environments elect one controller. A controller started by an older Desk at another socket is joined through the endpoint its owner record names, when that one answers.
- **Lost controllers.** A ready session checks its controller every 60 s, on `desk_status` (in the background) and before journaling a write, and re-elects a lost one. It reclaims a socket only when no running process owns it: the owner named in `owner.json` is gone (no such process, a process with that PID that started at a different time, or an owner that started before this boot), or `owner.json` is missing or corrupt and the socket refuses connections twice, 50 ms apart, and is still the same file.
- **An owner is a PID plus a start time.** When a controller is elected, `owner.json` records its process's PID and its start time as the OS reports it (`owner.process_start`: `/proc/<pid>/stat` field 22 with the boot id on Linux, `ps -o lstart=` on macOS, `Win32_Process.CreationDate` on Windows). A PID that is alive but started at a different time is another process that reused it, so the recorded owner is gone and the socket is reclaimed. A record from an older Desk without a start time is judged by its PID alone.
- **Clean release.** A Desk process releases its controller on every normal end: stdin closed, `SIGTERM`, `SIGINT`, `beforeExit` and `exit`. It removes `owner.json` and the socket file only while they are still its own (same PID, start time and token, and the socket file it published). A signal Desk handles alone still ends the process by that signal. So a root between sessions normally has no owner record at all; a stale one is left only by a crash.
- **A running owner is never taken over.** While `owner.json` names a process that runs, other sessions never unlink its socket and never start a second controller, even when it does not answer or refuses connections (a stopped process, or one whose accept queue is full). They give a busy owner one 1 s handshake per attempt, then stay controller-free.
- **Hung controllers.** A handshake probe (5 s, or `DESK_READINESS_PROBE_MS`) that a controller accepts but does not answer is a miss, and so is one its socket refuses, or finds no socket for, while its owner runs. After 3 misses in a row, spaced by the admission backoff, the session is `degraded:controller_hung`, and its fix tells the agent there is nothing to do: search uses plain text, writes work, and the controller recovers when it answers again or its owner ends. The fix calls the owner the Desk process that owns the controller only when its start time was checked; for a record without one it names the PID as the process the record names, which may be another process that reused it. Desk keeps retrying and returns to `ready` on the same controller. Desk never signals the owner, because the controller runs inside another session's Desk MCP server and stopping it would cost that session its Desk connection. `desk_doctor {"repair":"reclaim_controller"}` reports the owner PID and endpoint and reclaims nothing.
- **An embedding-model override** (`DESK_EMBED_MODEL` or `OLLAMA_EMBED_MODEL` that differs from the pinned model) degrades semantic search only. The controller keeps the pinned contract; this session's searches are lexical, `desk_recall` and `desk_similar` answer `embedding_override`, writes stay available, and `desk_status` shows `semantic.status: "unavailable (embedding_override)"` with the fix. A `required` semantic policy reports `degraded:embedding_override`.
- A readiness state directory of ours with a looser mode than `700` is tightened to `700`, and an unreadable index database (truncated, or not a database) is moved aside and rebuilt during convergence; `desk_status` reports it as `local_db.state: "corrupt"` meanwhile.
- `desk_doctor {"repair":"prune_readiness_state"}` removes leftover readiness-controller folders whose owner process is dead, whose socket no longer accepts connections and whose root no longer exists (a root on an unmounted `/Volumes`, `/media`, `/mnt` or `/run/media` volume is kept).

### The state branch

A host that keeps the desk on one branch passes `--state-branch <name>` (or sets `desk.state_branch` in the activation config). Desk then checks the checkout that holds the desk root. It runs `git switch --no-guess <name>` only when all of these hold: no tracked change, no merge, cherry-pick, revert, bisect or rebase in progress, no `index.lock`, no local-only commits (HEAD is on a remote branch, or the branch equals its upstream), the local state branch exists, and HEAD has not moved since the check. It never fetches or resets, and `git switch` keeps untracked files.

- **During the session's first admission attempt only**, whatever that attempt ends in, a detached HEAD, and a branch that equals its upstream, are switched back automatically. Desk reports `repaired: detached HEAD → main (was <sha>)` in `desk_status`, `last-start.json` and `repairs.log`.
- **After that attempt**, Desk never switches on its own, even in a session that never reached `ready`. When HEAD is off the state branch (a person's deliberate `git switch`, or a blocker the first attempt found and the agent then cleared), writes go read-only with a fix that names `desk_doctor {"repair":"switch_state_branch"}`; switching back restores `ready`. The `.git/HEAD` watch only re-runs the checks.
- A branch with no upstream whose commits are all on a remote branch is safe but may be in use on purpose, so the agent asks for it with the same doctor repair.
- Anything else (tracked changes, an operation in progress, local-only commits) stays as it is, with the blockers and the fix.

### Starting Desk refuse-but-connect (for launchers)

A launcher that found a problem it cannot fix still starts Desk connected: `--degraded <code> [--degraded-reason <text>]`. Desk completes the handshake, lists every tool and reports `state: "degraded:<code>"` with the reason and a fix.

- **Read-only codes** keep reads and refuse writes: `crew_state_unavailable`, `crew_state_not_main`, `repository_mismatch`, `authority_invalid`, `identity_unavailable`, `identity_not_emu`, `identity_unregistered` and `identity_ambiguous`. Pass `--root` and `--person` when known. A `crew_state_*` code together with `--state-branch <name>` hands the checkout to Desk's own state-branch check, which can repair it and upgrade the session in place.
- **Every other code** (for example `lifecycle_conflict`, `dependency_*`, `snapshot_*`, `registry_malformed`) is an integrity failure: Desk does no admission and refuses every data tool; `desk_status` and `desk_doctor` answer. A code that is not lowercase `a-z0-9_` is reported as `launcher_refused`.
- The launcher's condition is re-checked only when the host reconnects the Desk MCP server, and the fix says so.

Codex global activation writes an owned `~/.codex/desk.activation.json` file in the default Codex profile. When that file exists, the MCP entrypoint auto-loads it at startup so `desk_status` can report the selected activation target, overlay chain, desk root, and runtime cache. Project-local Codex activation passes the same config explicitly with `--activation-config .codex/desk.activation.json`.

Generated Codex activation configs carry the normalized manifest `desk_runtime` policy. Person-scoped activation requires an explicit valid `person` adapter input and passes it through the existing `--person` launch argument. The standalone Codex adapter refuses named `authority_provider` policies with `authority_invalid`: it cannot serialize or install an authority callback into the child process, and must never substitute workspace authority.

`desk_runtime.semantic` controls startup convergence. `background` is admitted at `CONTROL_READY` and converges asynchronously. `unsupported` keeps automatic lexical convergence but skips embedding calls. `required` completes convergence and verifies a complete semantic barrier before admission reaches `ready`: complete document coverage, current active-vector provenance, and a successful active-model query-embedding probe are all required. Until then the session is `degraded:semantic_unavailable`, with lexical reads and writes available, and it retries in the background. Even a warm, fully vectorized index stays there when that probe fails. Background convergence performs the same probe without blocking startup and remains `LEXICAL_READY`, rather than `READY`, when it fails. Query availability is observed at convergence time, not guaranteed indefinitely. Controller compatibility includes semantic mode and embedding specification as well as the lexical contract.

The controller serializes convergence, not its clients. A concurrent request receives `{ accepted: true, reused: true, in_progress: true }` with the current state; a caller can wait using `barrier({ capability: "lexical" | "semantic", wait: true })`. Disconnecting the requesting client does not cancel the operation. Failed work remains retryable on a subsequent convergence request. The controller process stays live while its operation runs; this does not make it survive termination of the controller process itself.

Semantic-enabled controller compatibility also requires the query-probe contract, so a new consumer cannot reuse a legacy coverage-only controller to bypass admission checks. This does not stop or upgrade already-running legacy consumers.

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

Desk validates the committed runtime support matrix before loading production dependencies. If the host's Node ABI is unsupported, Desk searches only bounded local Node locations (the active executable, `PATH`, and standard NVM, Volta, asdf, and mise locations) and performs at most one guarded stdio-preserving handoff to a compatible runtime. It never installs, downloads, or reaches the network during startup. If no healthy local path exists, a dependency-free diagnostic MCP remains live with `desk_status` and `desk_doctor`; all mutation tools fail closed with the same diagnosis and offline remediation instead of crashing the host. A missing or corrupt pack for a supported Node is found during admission instead, after the handshake, and is retried in place.

Diagnostic responses retain `status: "degraded"`, `mode: "diagnostic"`, the precise reason and runtime context, and a nonempty `remediation` list. The failed activation attempt remains visible as `activation_status: "terminal"` with its phase, code, expected/observed evidence, and `retryable: false`; this does not mean the diagnostic server has stopped. Remediation names the in-session step (call `desk_status` after the fix); only a different Node needs the host to reconnect the Desk MCP server. `automatic_actions` is empty when no further automatic recovery is performed.

Semantic controller admission captures the normalized, ordered effective embedding endpoints once: `DESK_EMBED_ENDPOINT`, `DESK_OLLAMA_ENDPOINT`, `OLLAMA_HOST`, then the existing loopback fallbacks, with duplicates removed. That exact list participates in controller identity and is used for both document convergence and the required query probe. A process with a different endpoint list cannot borrow another controller's probe. Internal embedding callers can supply a nonempty `endpoints` list of already-resolved URLs to use exactly that order without ambient fallback; the single `endpoint` override remains supported.

Common startup routes writes from the admitted authority, not the raw CLI argument. Workspace authority requires no `--person`; person authority uses the admitted person's identity, including a provider-derived identity when the argument is absent. A conflicting `--person`, missing authority, or unenforceable person identity is refused as `degraded:authority_invalid`: reads stay available and every write is refused. This applies to direct launches as well as host adapters.

### Developer notes

Direct development checkouts can still run `npm install` when intentionally working on the MCP package.

Semantic ranking requires Ollama with `nomic-embed-text` pulled. The active embedding specification pins this model for both document and query embeddings. With semantic mode `background` or `required`, an effective `DESK_EMBED_MODEL` (or fallback `OLLAMA_EMBED_MODEL`) that differs from the pinned model is never used: the readiness controller keeps the pinned contract and indexes with the pinned model, and this session's semantic search is unavailable (`embedding_override`) while lexical search and writes keep working. Unset the override or set it to `nomic-embed-text`, then reconnect the Desk MCP server, because the override is read from the server's environment; another model requires a separately versioned embedding specification. The runtime does not rewrite the override.

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

Every test process in the coverage gate runs with `HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_RUNTIME_DIR` in one temporary folder per run (`__tests__/_isolated_env.mjs`, which the gate preloads and `__tests__/_temp_roots.js` imports), so no test reaches the real `~/.cache` or `~/.local/state`. `npm test` preloads it too. To run tests directly with the same setup, preload it: `node --import ./__tests__/_isolated_env.mjs --test <files>`. (`package.json` is part of the published artifacts' source scope, so changing its `test` script meant re-anchoring the vector pack and snapshot manifests; their payloads are unchanged.) A write under the real home, outside the OS temp folder and this checkout, fails the test that made it; `__tests__/test_isolation.test.js` guards the setup.

Run the same changed-production coverage gate used by CI with Node 22 or later:

```sh
npm run test:coverage
```

The gate runs the maintained tests through pinned `nyc` and `@istanbuljs/esm-loader-hook` development dependencies, then reads their JSON report. Statements are AST-instrumented units, not a copy of line coverage. The existing per-file thresholds and documented exclusions remain authoritative; the producer does not impose a separate global threshold. The pinned `test-exclude` override is covered by selector and real ESM/CommonJS execution fixtures. Source roots are canonicalized before instrumentation, and owned temporary reports are removed after evaluation. A nested invocation is refused with a failure status rather than reported as an unmeasured pass.
