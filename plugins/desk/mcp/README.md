# desk MCP server

Spawned by consumers (Claude Code, Copilot CLI, ouroboros daemon) to expose a uniform tool surface for working with a desk workspace. Tools include task / track / friction / lesson CRUD and exact-word plus meaning-based search.

## Lexical-first milestone

This server packages the [reviewed lexical milestone](https://github.com/ourostack/ouroboros-skills/commit/0eb9ea139a997c5c39394ac7b95ab02bff7331b5): correct lexical answers during startup and file changes, fresh direct fallback when readiness is uncertain, durable journal/restart behavior, one index writer, and zero orphan vectors.

Semantic scheduling and transactional recovery are not qualified yet. Repeated tombstone-policy changes fail closed but may return a generic error instead of typed `readiness_changed_during_read`. Runtime dependency packs reuse byte-identical, previously native-verified payloads with provenance; repackaging is not fresh native execution.

## Run it directly

```sh
node ./index.js --root ~/AgentBundles/<agent>.ouro/desk
```

Or via environment:

```sh
DESK=~/<your-workspace> node ./index.js
```

## Validated local recovery after a confirmed transport mismatch

Use this command only after the agent has confirmed a requested/actual desk mismatch, refused the misrouted mutation, and established the intended existing desk. A missing-card error alone is not a mismatch. Permission, validation, containment and genuinely missing-card refusals remain refusals; this command is not an override or a machine-binding repair. [Issue #301](https://github.com/ourostack/desk/issues/301) records a motivating observed mismatch, not a selection bug fixed by this transport.

From the installed plugin's `mcp` directory, with Node meeting this package's engines floor:

```sh
node scripts/local-recovery.js \
  --root "/confirmed/existing/desk" \
  --operation task_update \
  --input-file "/private/recovery-input.json"
```

The JSON file holds the ordinary tool arguments, for example `{"track":"ops","slug":"example","status":"processing"}`. Omit `--input-file` to read JSON from stdin. Never put the payload or secrets in command arguments. Inputs are limited to 1 MiB. Supported operation names are deliberately limited to `task_update`, `task_create`, `task_archive` and `desk_save`; there is no focus, sign-off, doctor repair or arbitrary-tool escape hatch.

The client starts our ordinary `bootstrap.cjs` as an owned stdio child, then uses standard MCP `initialize`, `tools/list` and `tools/call` requests. The bootstrap retains our existing Node selection and dependency-pack handling. The complete `index.js` front door, shared admission, authority/person/state-branch gates, card validation, journal and exact-path commit/push handlers run unchanged. No global installation, current-session MCP restart, manual binding, alternate validator or raw-handler call is needed.

Pass `--activation-config` and `--person` only for the existing, authorized launch context; the runtime still decides authority. `--state-branch` is accepted only when it matches the branch already declared in that activation context. It cannot replace that declaration. An inherited card-guard commit override is refused. No cwd-derived workspace is substituted. The explicit root must already exist and resolve to a directory; missing or inaccessible roots never fall back or trigger setup.

Before dispatch, the client reads detailed `desk_status` in its newly owned server, compares its actual root to the requested root's resolved real path, and checks the reported write scope. A root mismatch refuses before the operation. Pending status is read again within the 60-second preflight budget. The dispatched mutation then has up to 60 seconds of its own, counted from when it is sent, and the whole run is capped at 100 seconds, so the mutation always has at least 40 seconds and the command prints its report before a 120-second command limit, such as Claude Code's default, can stop it. Cached detail is usable only when its timestamp belongs to this newly owned server session; older or undated cached detail refuses. A cached pre-admission scope that does not match is read again, never overridden; a current scope mismatch refuses. `preflight` retains the current/cached distinction, timestamp and scope. This does not call old cached detail in the misrouted host fresh. The mutation is sent at most once; its runtime authority gates remain active.

The command writes one local JSON report and exits:

| Exit | Meaning |
| --- | --- |
| `0` | The tool reported completion, no pending push is claimed, and any expected Git commit was observed through a HEAD change. This is not a project's code-delivery claim. |
| `1` | No mutation was dispatched: input, root, admission, scope or transport preflight refused. |
| `2` | Partial or unknown effects: tool/parse/transport failure after dispatch, missing commit evidence, `commit_failed`, `push_pending`, or uncertain child shutdown. |

The report retains `operation`, `requestedRoot`, `actualRoot` when available, `preflight`, `result`, `effects`, local `git.headBefore`/`headAfter`, `transport.pid`/`shutdown`, and concrete `readback` commands. Tool-result string values matching input strings are redacted, and our shared credential scrub also covers runtime error text; the original JSON remains the source for exact card/file identities. Raw parser errors and child stderr are not printed. `effects.mutation: "not_dispatched"` establishes only that this client sent no mutation; admission may still create derived runtime state or perform its already-declared state-branch checks. `reported_applied` is the tool's account, not an independent diff. `reported_complete` covers `nothing_to_commit` and `already_archived` without claiming those responses prove unchanged files. An `isError` response alone never establishes unchanged files. A changed HEAD is an observation, not attribution against a concurrent writer.

Push runs through the existing asynchronous handler. A configured remote is conservatively reported as pending, even if its worker later finishes; the client does not poll for delivery or advertise a successful push. A commit failure can leave the real card write applied. A timeout after dispatch can also occur after application. Read the named card/files and local status, HEAD, last commit paths and upstream in the confirmed desk before considering another mutation. Do not automatically resend, retry a permission/validation refusal elsewhere, or replace this path with unvalidated card edits.

The owned bootstrap is closed on every outcome, with bounded EOF/SIGTERM shutdown; the scheduled push keeps its ordinary lifetime. At the agent's reporting boundary, use `desk-problem`'s existing `broke / means / fix / file / tell` fields, keeping private roots local and public filings generic. This JSON transport report does not replace that block or change any published MCP result schema.

## Factory capture, delivery and store pipeline

Claude and Copilot end/stop hooks write protected local markers; detached derivation credits each session's time to the task its main agent declared with `task_focus` (inferring a task only where nothing is declared) and writes consent-gated local facts. Each session start runs the bounded boot-check registry and starts delivery detached: one sweep, then a flush of every consented store that sends only transformed published facts as one intake pull request per machine per store. Task completion queues finalization, which the end-of-turn hook and the boot check run as `finalize`. The factory CLI exposes `derive`, `status`, `flush` and `finalize`, validates store intake (published facts and waste labels) with `validate-pr`, builds deterministic reports and cross-job waste rollups with `build`, compares a desk's real work in a window with the factory's jobs with `reconcile`, and derives a hashed report URL with `job-link`, which `task_update` and `task_archive` write into the task card as `factory_report` on the transition to `done` when the store has consent and the desk is known to be private (any other desk's card records why in `factory_report_unavailable`, and a later `task_update` fills the link once it can). `desk_status` and `desk_doctor` report the bound desk's store, consent per store, undelivered and quarantined counts and the last flush result code as `factory`, with no path, secret, account or content. `evaluate` prepares bounded briefs for the waste evaluator when a task reaches `done`, and `evaluate-accept` checks the evaluator's labels before they join the local outbox; delivering those labels is not wired yet. The live delivery proof against the public store is separate milestone work. See [the factory capture and pipeline contract](../docs/factory-local-capture.md) for privacy, commands, formulas and recovery boundaries.

## Tools exposed (24)

**Runtime CRUD:**
- `task_create`, `task_update`, `task_archive`
- `track_create`, `track_update` (on a Git desk, each stages the `track.md` it writes; `track_update` skips that when the file already held unstaged changes)
- `friction_add`, `lesson_add`
- `desk_save` — commit files written directly with Write/Edit rather than through a structured Desk tool; each path must resolve inside the resolved `--person` write prefix, or the call is refused

**Improvement cards:**
- `improvement_open` — open an improvement card on the desk, find it already open, or reopen a closed one; Desk builds every title, and the call commits exactly the card file
- `improvement_next` — claim the oldest open card as standing, pre-authorized work; refuses in a noninteractive or headless session and at the claim bounds ([the loop](../docs/factory-local-capture.md#the-improvement-loop))
- `improvement_update` — the holder of the claim ships the card with its countermeasure pull request, releases it or closes it as wont_fix, duplicate or not_reproducible

**Declared focus:**
- `task_focus` — the session's main agent declares the task it is working on, as a track and slug or with `clear: true`; the factory reads the call from the transcript to credit the session's time to that task. It returns the card's status and its last 5 progress entries (each cut to 300 characters; a card found only under the archive folder is marked archived), writes nothing and needs no write authority. `task_create` takes a focus flag to declare a new task in the same call. Desk holds the focus in memory for the session, never on disk, and adds a focus_note hint, worded for the main agent, to `task_update` and `task_archive` on another card and to every task tool call until the session declares a focus or clears it on purpose. A subagent never calls it. Archiving the focused card leaves the focus as it is (the factory keeps crediting the declared task until the next `task_focus` call), and `task_move` of it carries the focus to the new place.

**Sign-off:**
- `task_signoff` — records the operator's answer to a delivered task: accepted or refused. A refusal also takes the operator's reason (not_what_was_asked, defect, changed_ask, incomplete or other) and the agent's own reading of the cause (agent_error, changed_ask, new_information or external), puts the task back to processing (an archived card is brought back to the live tree first) and records the return. A card whose whole track was archived into the desk's `_archive/` is found there too: an acceptance is recorded where the card is, and a refusal is refused with the `git mv` to run first (the track back, or only the task when a live track of that name exists), because a task cannot be worked in an archived track. Desk records the call as the operator's answer and does not check which turn made it; repeating the same answer changes nothing, and a different answer replaces the one held. The card's sign-off block no longer gets a verification flag; a card answered earlier keeps the one it has. It returns the one sentence the agent says to the operator, and never any card text. A subagent never calls it.

**Cheap moves:**
- `task_move` — move a task to another track and/or rename it (live or archived); refuses a taken target or an invalid new name, and best-effort keeps both `track.md` "## Tasks" tables in sync; `unarchive: true` reopens an archived task into a live folder and restores its row, and `into_task: "<kept task>"` merges a duplicate task into the task that keeps the job as an iteration folder; on a Git desk it refuses a task, or a `track.md` it would edit, with unstaged changes or untracked files (another session may be working there), unless `allow_dirty: true`, and it stages every file it writes, so staged changes read as the current tidy's own work; merging with `into_task: "<kept task>"` never hides a live task inside a done one
- `track_rename` — rename a track, rewriting `track:` on every task card under it, live and archived; on a Git desk it refuses a track with unstaged changes or untracked files unless `allow_dirty: true`, and stages the task cards it rewrites

**Status:**
- `desk_status` — session-start-safe MCP health. Compact by default (one health word, why it is not ready, what to do, one sentence about search, root, sync and pointers); `detail: true` returns the full root, activation, runtime and search payload
- `desk_doctor` — healthy-runtime confirmation or precise failure diagnosis and remediation; `{"repair":"switch_state_branch"}` runs the repair described under [Handshake first, then admission](#handshake-first-then-admission); it also counts the private partitions the retired manual measurement ledger left under `<state home>/ouroboros-skills/desk/work-ledger/`, without opening, moving or deleting them

**Skills:**
- `desk_skill` — reads Desk's skills through the server, for a client that cannot load them as plugin skills (claude.ai, ChatGPT); no name lists them, a name returns that skill's text. A hosted Desk refuses the skills that need a shell.

**Search:**
- `desk_search` — exact-word search
- `desk_recall` — meaning-based recall; until the model and vectors are ready it answers with exact-word matches and says so
- `desk_similar` — find docs similar to a given path
- `desk_timeline` — temporal queries
- `desk_thread` — provenance walk via refs_graph
- `desk_reindex` — rebuild or repair the local search index

All 24 tools are wired to real implementations. There is no work-measurement tool either: the factory accounts for each session when it ends and reports each finished job ([local capture](../docs/factory-local-capture.md)). There is no qualitative feedback tool: preview feedback a participant chooses to offer is written as Markdown in their own desk at `_meta/preview-feedback.md`, and the protected store that already holds private records is retained as a [storage primitive](docs/private-feedback.md) with no route from this server. The optional `desk_doctor` input `{"format":"preview"}` returns a [minimal local diagnostic snapshot](../docs/preview-diagnostics.md), not feedback collection or a network report.

## How consumers wire this up

Desk ships host-specific declarations for hosts with different plugin-root contracts. Both start `mcp/bootstrap.cjs` with whatever `node` the host finds, so Desk never depends on which Node a host or shell puts first on `PATH`. The bootstrap is written in ES5 and runs on Node 8 and later. It lists the Node binaries on `PATH` and under nvm, fnm, Volta, asdf, mise and Homebrew (on Windows: nvm-windows, fnm, Volta, mise and Program Files), keeps the ones that satisfy `engines.node` in `package.json`, and prefers the newest whose ABI has a shipped runtime pack, so `index.js` never restarts itself. It runs `index.js` in its own process when the running Node is that choice, and otherwise as a child with inherited stdio. When no compatible Node is installed, the bootstrap answers the MCP handshake itself, lists every Desk tool, and answers each call with `{"state":"degraded:node_missing","fix":"<install command for this machine>"}`. The one case it cannot cover is a machine with no `node` executable at all; Desk's setup and `desk_doctor` make sure Node is installed.

`plugin.json` names `.mcp.copilot.json` as the Copilot declaration:

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

Copilot's native `plugin.json` explicitly selects `.mcp.copilot.json`. Copilot expands `${COPILOT_PLUGIN_ROOT}` to the installed plugin directory before launching the server, so startup is independent of the session working directory. Claude Code explicitly selects `.mcp.claude-codex.json` through its `mcpServers` manifest path (the file keeps its old name so existing launchers that name it keep working). That common payload also remains available to explicit generic/Ouroboros consumers: its inline launcher finds the plugin through `DESK_PLUGIN_ROOT` (set from `${CLAUDE_PLUGIN_ROOT}`) or the working directory and runs the same bootstrap. If it finds neither, it still completes the handshake and reports `degraded:plugin_root_missing`.

There is deliberately no root `.mcp.json`: Agency's legacy acquired-plugin loader would otherwise copy it into additional user MCP configuration alongside the native Copilot plugin. Relocating the common file removes that injection input without changing either payload or trusting USER providers. It does not itself prove native provider enablement, ownership, labels or runtime operation; those require receiving-host qualification. Historical Copilot CLI 1.0.89/1.0.91 trials used the old generic file, not this native-only Copilot layout, and do not qualify the relocated package.

The engine declarations still have to agree. `tests/desk/mcp/__tests__/activation/mcp_declaration_integrity.test.js` fails when their server names, types, commands or entry files drift apart, native references stop resolving, or root `.mcp.json` returns. It reads every MCP declaration under `plugins/*` (including the activation manifest), rejects reserved namespaces (`web`, `functions`, `browser` and others), enforces `^[a-z][a-z0-9-]*$` and the 64-character host function-name limit. Tool lists are resolved by `<plugin>/<server>` before the bare server name, so two plugins may declare the same server name.

Once Node is running, `index.js` never exits before the handshake either. On a Node older than the `engines.node` floor it goes straight to finding a compatible Node (or to diagnostic mode), and any exception before the server starts becomes diagnostic mode with `state: "degraded:startup_exception"`. Diagnostic mode lists the full tool set; tools it cannot run return `{"status":"degraded","code","fix"}`.

## Handshake first, then admission

`index.js` answers `initialize` and `tools/list` before it does anything that can fail or take time. Only two things happen before the handshake: the Node version check, and the move to a compatible Node when no shipped runtime pack fits this one (that fix needs stdio the process has not answered yet). The tool list is always the full set of 24 tools and never changes during a session.

Nothing blocks the thread that answers the host. Admission starts only after the first `tools/list` reply (or after 1 s when no client asks). Root and activation resolution, the pack inspection and the runtime restore (which can wait up to 30 s on another process's publication lock) run on a worker thread (`src/runtime/admission-worker.js`); Git is asynchronous, and search builds its index in the background. `initialize`, `tools/list`, `ping` and `desk_status` answer within 200 ms whatever admission is doing, including the transition to `ready`: the runtime server is imported one local module per turn of the event loop, background convergence starts on a later turn, and opening the index database is split from the checks after it. The admission worker never loads a native addon: it once loaded `better-sqlite3` and `sqlite-vec` to save the main thread's first load (about 60 to 80 ms), and that crashed the whole server (SIGSEGV on macOS, 0xC0000005 on Windows) when the worker ended before the main thread had loaded the addon itself, in about 1 Copilot session in 3 on a loaded Mac. The main thread now pays that first load at the transition to `ready`. Earlier measurements saw a rare whole-process stall of 236 to 314 ms under heavy load, which delays `ping` as much as `desk_status`, so the bound is normal operation, not a guarantee on a starved machine. `desk_status` joins an attempt that is already running without waiting on it, waits briefly for one it starts, and spends at most 90 ms of its own on the runtime status detail; when that detail is late it serves the last one, marked `cached`.

The runtime status computation's root observation runs in one disposable child process, outside the answering thread. The child loads only the shared inspection modules, not the full runtime. A timer cannot interrupt synchronous filesystem work; moving that work is what preserves the response budget. A process, rather than a native worker thread, also preserves the Windows runtime's native-module safety boundary. Concurrent status calls join the session's one computation. Context replacement, the existing run-age limit, or session shutdown aborts its owned reader; a replacement and shutdown wait for that reader to exit. The parent bounds retirement: 100 ms for disconnect, 100 ms after SIGTERM, then 200 ms to observe exit after SIGKILL. A reader that still has not exited produces `status_reader_not_exited`, with its exact PID; its owned handle is retained and replacement refuses instead of starting another reader. A late result is explicitly cached, not presented as a fresh observation.

Admission runs in the background (`src/runtime/desk-session.js`, `src/runtime/admission.js`): root resolution, the activation config and its `desk_runtime` policy, the runtime restore, the state-branch check, write authority and starting search. Its state is `admitting`, then `ready` or `degraded:<code>`:

- Every data operation revalidates its destination through the existing worker-backed resolver before dispatch. A ready session also schedules or joins this check on `desk_status`, within the unchanged status budget. Unchanged inputs do not reload the runtime, inspect the state branch, or restart search; writes still perform their ordinary branch checks. A late association can replace a guessed fallback only after the new destination, policy and authority have been admitted. Explicit roots and host/session roots keep their precedence. Next, the project folder the host opened (Claude Code's `CLAUDE_PROJECT_DIR`, Copilot's session record) wins when it is itself a desk, on both hosts; then the saved binding and `$DESK`, which outrank a bare launch folder and the home fallbacks, including when the association is invalid. A missing or invalid saved binding refuses instead of falling back, and losing established context is not permission to select a different home-folder guess.
- Admission and data operations share one context boundary. A running operation finishes against its captured destination before admission can replace that destination; another operation waits for revalidation or refuses without dispatch if verification is still pending. Replacement intent must be at least as strong as the established resolver source: losing an association cannot reselect a captured launch folder, another equal-strength folder hint, or a lower-priority default. Stronger verified intent can upgrade an initial guess, and a same-path source change preserves the destination without unnecessary re-admission. Root changes clear the in-memory task focus. Root, activation or person changes invalidate cached status ownership, and late completions from the previous context cannot restore it. During unresolved replacement admission, status reports the current diagnostic rather than stamping old ownership ready. No second registry, task ledger, host hook or global default is involved.
- Same-context detail served while destination verification is pending retains `status_detail_from`, the actual runtime computation's start time, whether the caller just computed it or joined an existing computation. It never stamps cached detail with the caller's time. Without completed same-context proof, `detail_pending` remains true and no cache timestamp is invented. `admission.writes` remains refused until verification settles; a cached status does not bypass the operation's destination or authority gates.
- An operation that arrives during a status or HEAD admission attempt waits for that attempt, then samples destination inputs again. A resolver reply sampled before the operation arrived is not proof for its dispatch. This fresh check reuses ordinary revalidation and does not repeat unchanged runtime loading or search start.
- A degraded session retries on its own after 1, 2, 5, 10 and 30 s, then every 60 s, and at once on every `desk_status` call and on a change to the checkout's `.git/HEAD`. A fix the agent makes in the session (creating the desk, correcting the activation config, pushing local commits) upgrades the same session to `ready` with no restart.
- `task_focus` answers whenever the runtime and a root are available, with no write authority. While the server is still admitting it waits up to 2 seconds for admission, then answers or refuses.
- `desk_status` always answers, with `state`, `code`, `fix`, the latest `repair` and an `admission` block (attempts, next retry, state branch, whether writes are available, exceptions caught after the handshake, and the launcher mode).
- Reads (`desk_search`, `desk_recall`, `desk_similar`, `desk_timeline`, `desk_thread`) need the runtime and a root. Until the server's search has started, word search and timeline read the files directly.
- `desk_reindex` and `desk_thread` wait for the server's search to start.
- Writes (`task_*`, `track_*`, `friction_add`, `lesson_add`, `desk_save`) need admitted write authority and the checkout on its state branch, re-checked before every write. They never wait for search: the change goes straight to the file and the search's folder watcher picks it up.
- A tool whose needs are not met returns `{"status":"degraded","state","code","fix","blockers","tool"}` with a fix the agent can act on in the session. A tool that throws returns the same shape with `code: "tool_exception"`.
- After the handshake, an uncaught exception or unhandled rejection never ends the process, on every launch path (`node index.js`, `bootstrap.cjs` running `index.js` in its own process or re-running it as a child, and the Claude `.mcp.claude-codex.json` inline launcher): Desk records it, moves to `degraded:runtime_exception`, keeps serving and re-admits on its backoff.

Desk records each state change in its state directory, `$XDG_STATE_HOME/ouroboros-skills/desk` or `~/.local/state/ouroboros-skills/desk`: `last-start.json` holds the latest record of any session (`state`, `code`, `repair`, `fix`, `root`, `pid`), starting with `admitting`, and `last-start/<root key>.json` holds each root's own record, which also starts with `admitting` as soon as the session resolves the root (the key is the first 16 hex digits of the SHA-256 of the root path). `desk_status`'s `admission.last_start` names the root's own record once the root is known. Each repair Desk makes is appended to `repairs.log`. Tests and embedders pass `stateHome` to `main()` to keep all of this in a temporary folder.

### Search

Search runs inside each Desk server; there is no separate controller process. At start the server reads the desk's Markdown into an in-memory word index (about a second for a desk of thousands of files) and watches the desk folder for changes. Meaning-based search uses a small embedding model (Model2Vec `minishlab/potion-base-8M`, about 30 MB, downloaded once at a pinned revision into `$DESK/.state/embedding-model/`) run in plain JavaScript. Section vectors are saved by text hash in `$DESK/.state/desk-vectors.sqlite`, so each text is embedded once and every session on the desk shares them.

- Until the vectors are ready, `desk_recall` answers with exact-word matches and says so; `desk_status` reports `Search is preparing N of M sections…` and then `Search is ready.`
- Older builds kept a search index in `$DESK/.state/desk-index.sqlite`. The server removes it at start when no process has it open, and `desk_status` says how much space that freed.
- Older builds also ran a readiness controller that kept a folder per desk under `~/.cache/ouroboros-skills/desk/readiness`. Each session removes the ones no running process owns, 30 seconds after it starts.

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

An activation config (`--activation-config <path>`, `$DESK_ACTIVATION_CONFIG`, or Claude's saved binding) carries the normalized manifest `desk_runtime` policy.

`desk_runtime.semantic` turns meaning-based search on or off. `background` (and `required`, which behaves the same) loads the model and embeds the desk in the background; `unsupported` leaves exact-word search only. Admission never waits for search: reads and writes are available as soon as the session is `ready`.

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
- `gray-matter` — YAML frontmatter parser

`better-sqlite3` is a native dependency. Healthy plugin activation restores the committed production runtime pack into a writable cache. The pack still carries `sqlite-vec`, which only the admission worker's warm-up loads; it goes with the next pack rebuild.

Desk validates the committed runtime support matrix before loading production dependencies. If the host's Node ABI is unsupported, Desk searches only bounded local Node locations (the active executable, `PATH`, and standard NVM, Volta, asdf, and mise locations) and performs at most one guarded stdio-preserving handoff to a compatible runtime. It never installs, downloads, or reaches the network during startup. If no healthy local path exists, a dependency-free diagnostic MCP remains live with `desk_status` and `desk_doctor`; all mutation tools fail closed with the same diagnosis and offline remediation instead of crashing the host. A missing or corrupt pack for a supported Node is found during admission instead, after the handshake, and is retried in place.

Diagnostic responses retain `status: "degraded"`, `mode: "diagnostic"`, the precise reason and runtime context, and a nonempty `remediation` list. The failed activation attempt remains visible as `activation_status: "terminal"` with its phase, code, expected/observed evidence, and `retryable: false`; this does not mean the diagnostic server has stopped. Remediation names the in-session step (call `desk_status` after the fix); only a different Node needs the host to reconnect the Desk MCP server. `automatic_actions` is empty when no further automatic recovery is performed.

Common startup routes writes from the admitted authority, not the raw CLI argument. Workspace authority requires no `--person`; person authority uses the admitted person's identity, including a provider-derived identity when the argument is absent. A conflicting `--person`, missing authority, or unenforceable person identity is refused as `degraded:authority_invalid`: reads stay available and every write is refused. This applies to direct launches as well as host adapters.

### Developer notes

Direct development checkouts can still run `npm install` when intentionally working on the MCP package.

Meaning-based search needs no setup. The model's two files (about 30 MB) are downloaded once, at a pinned revision with pinned SHA-256 hashes, into `$DESK/.state/embedding-model/`. Without a network on the first run, `desk_status` says the model could not load, exact-word search keeps working, and Desk tries again a minute later at the next desk change. Ollama and the `DESK_EMBED_*` / `OLLAMA_*` settings are no longer used.

## Redaction ledger

The plugin's `artifacts/tombstones/tombstones.jsonl` lists documents, by path and content hash, that search must never index. Section embeddings are derivative data and may carry privacy risk, so they stay in the desk's `.state/` folder, out of Git. Vector packs, index snapshots and their publication policy were removed; `docs/roadmap/search.md` lists them with the other removed search capabilities.

## Tests

```sh
npm test
```

Boots the server with temp roots, asserts the tool surface registers, and exercises the real tool bodies via the dispatcher and fixture desks.

The tests live in [`tests/desk/mcp/__tests__`](../../../tests/desk/mcp/__tests__/), outside the plugin folder, so hosts that install or refresh Desk never download them. `tests/desk/mcp` mirrors this folder, and the test setup links `tests/desk/mcp/node_modules` to this folder's installed `node_modules` so the tests' package imports resolve. Run `npm ci` here first.

The browser tests (`launch/web.test.js`) use a fake Playwright CLI. Set `DESK_BROWSER_REAL=1` to also drive a real Edge or Chrome; that run installs `playwright-core` from npm.

CI installs the same test-only package. It is not a runtime dependency or browser download. `DESK_TEST_MAINTAINED_CLI_DIR` remains an explicit override for an admitted input; full-source and bounded-region hashes reject unknown input instead of borrowing a user cache.

Every test process in the coverage gate runs with `HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_RUNTIME_DIR` in one temporary folder per run (`tests/desk/mcp/__tests__/_isolated_env.mjs`, which the gate preloads and `_temp_roots.js` imports), so no test reaches the real `~/.cache` or `~/.local/state`. `npm test` preloads it too. To run tests directly with the same setup, preload it from this folder: `node --import ../../../tests/desk/mcp/__tests__/_isolated_env.mjs --test <files>`. (`package.json` is part of the published artifacts' source scope, so changing its `test` script meant re-anchoring the vector pack and snapshot manifests; their payloads are unchanged.) A write under the real home, outside the OS temp folder and this checkout, fails the test that made it; `test_isolation.test.js` guards the setup.

Run the same changed-production coverage gate used by CI with Node 22 or later:

```sh
npm run test:coverage
```

The gate itself is a build tool outside the shipped plugin, in [`tools/desk-build`](../../../tools/desk-build) with the support matrix and Copilot bundle generators; this package's scripts run it. It runs the maintained tests through pinned `nyc` and `@istanbuljs/esm-loader-hook` development dependencies, then reads their JSON report. Statements are AST-instrumented units, not a copy of line coverage. The existing per-file thresholds and documented exclusions remain authoritative; the producer does not impose a separate global threshold. The pinned `test-exclude` override is covered by selector and real ESM/CommonJS execution fixtures. Source roots are canonicalized before instrumentation, and owned temporary reports are removed after evaluation. A nested invocation is refused with a failure status rather than reported as an unmeasured pass.

CI runs the same gate as parallel shards, because the instrumented suite runs its files one at a time and took about 17 minutes as one job. Each shard job runs `npm run test:coverage -- --shard <index>/<total> --output <dir>`: its share of the test files, still one at a time under the same instrumentation, keeping the raw coverage, each file's duration and a manifest. The `desk MCP test suite` job then runs `npm run test:coverage -- --merge <dir>` over all the shards. It refuses the result unless every shard of the split is present once and passed, every shard measured the same changed files, and together they ran exactly the test files of one whole-suite run. It then reports their combined raw coverage and applies the same per-file thresholds once. [`tools/desk-build/config/coverage-shards.json`](../../../tools/desk-build/config/coverage-shards.json) holds each test file's expected seconds from a CI run; it only balances the shards, and a file it does not list still runs.
