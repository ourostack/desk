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

Before dispatch, the client reads detailed `desk_status` in its newly owned server, compares its actual root to the requested root's resolved real path, and checks the reported write scope. A root mismatch refuses before the operation. Pending status is read again within the shared 60-second budget. Cached detail is usable only when its timestamp belongs to this newly owned server session; older or undated cached detail refuses. A cached pre-admission scope that does not match is read again, never overridden; a current scope mismatch refuses. `preflight` retains the current/cached distinction, timestamp and scope. This does not call old cached detail in the misrouted host fresh. The mutation is sent at most once; its runtime authority gates remain active.

The command writes one local JSON report and exits:

| Exit | Meaning |
| --- | --- |
| `0` | The tool reported completion, no pending push is claimed, and any expected Git commit was observed through a HEAD change. This is not a project's code-delivery claim. |
| `1` | No mutation was dispatched: input, root, admission, scope or transport preflight refused. |
| `2` | Partial or unknown effects: tool/parse/transport failure after dispatch, missing commit evidence, `commit_failed`, `push_pending`, or uncertain child shutdown. |

The report retains `operation`, `requestedRoot`, `actualRoot` when available, `preflight`, `result`, `effects`, local `git.headBefore`/`headAfter`, `transport.pid`/`shutdown`, and concrete `readback` commands. Tool-result string values matching input strings are redacted, and our shared credential scrub also covers runtime error text; the original JSON remains the source for exact card/file identities. Raw parser errors and child stderr are not printed. `effects.mutation: "not_dispatched"` establishes only that this client sent no mutation; admission may still create derived runtime state or perform its already-declared state-branch checks. `reported_applied` is the tool's account, not an independent diff. `reported_complete` covers `nothing_to_commit` and `already_archived` without claiming those responses prove unchanged files. An `isError` response alone never establishes unchanged files. A changed HEAD is an observation, not attribution against a concurrent writer.

Push runs through the existing asynchronous handler. A configured remote is conservatively reported as pending, even if its worker later finishes; the client does not poll for delivery or advertise a successful push. A commit failure can leave the real card write applied. A timeout after dispatch can also occur after application. Read the named card/files and local status, HEAD, last commit paths and upstream in the confirmed desk before considering another mutation. Do not automatically resend, retry a permission/validation refusal elsewhere, or replace this path with unvalidated card edits.

The owned bootstrap is closed on every outcome, with bounded EOF/SIGTERM shutdown; the runtime's shared readiness controller and scheduled push retain their ordinary lifetime. At the agent's reporting boundary, use `desk-problem`'s existing `broke / means / fix / file / tell` fields, keeping private roots local and public filings generic. This JSON transport report does not replace that block or change any published MCP result schema.

## Factory capture, delivery and store pipeline

Claude and Copilot end/stop hooks write protected local markers; detached derivation credits each session's time to the task its main agent declared with `task_focus` (inferring a task only where nothing is declared) and writes consent-gated local facts. Each session start runs the bounded boot-check registry and starts delivery detached: one sweep, then a flush of every consented store that sends only transformed published facts as one intake pull request per machine per store. Task completion queues finalization, which the end-of-turn hook and the boot check run as `finalize`. The factory CLI exposes `derive`, `status`, `flush` and `finalize`, validates store intake (published facts and waste labels) with `validate-pr`, builds deterministic reports and cross-job waste rollups with `build`, compares a desk's real work in a window with the factory's jobs with `reconcile`, and derives a hashed report URL with `job-link`, which `task_update` and `task_archive` write into the task card as `factory_report` on the transition to `done` when the store has consent and the desk is known to be private (any other desk's card records why in `factory_report_unavailable`, and a later `task_update` fills the link once it can). `desk_status` and `desk_doctor` report the bound desk's store, consent per store, undelivered and quarantined counts and the last flush result code as `factory`, with no path, secret, account or content. `evaluate` prepares bounded briefs for the waste evaluator when a task reaches `done`, and `evaluate-accept` checks the evaluator's labels before they join the local outbox; delivering those labels is not wired yet. The live delivery proof against the public store is separate milestone work. See [the factory capture and pipeline contract](../docs/factory-local-capture.md) for privacy, commands, formulas and recovery boundaries.

## Tools exposed (23)

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
- `task_signoff` — records the operator's answer to a delivered task: accepted or refused. A refusal also takes the operator's reason (not_what_was_asked, defect, changed_ask, incomplete or other) and the agent's own reading of the cause (agent_error, changed_ask, new_information or external), puts the task back to processing (an archived card is brought back to the live tree first) and records the return. Desk records the call as the operator's answer and does not check which turn made it; repeating the same answer changes nothing, and a different answer replaces the one held. The card's sign-off block no longer gets a verification flag; a card answered earlier keeps the one it has. It returns the one sentence the agent says to the operator, and never any card text. A subagent never calls it.

**Cheap moves:**
- `task_move` — move a task to another track and/or rename it (live or archived); refuses a taken target or an invalid new name, and best-effort keeps both `track.md` "## Tasks" tables in sync; `unarchive: true` reopens an archived task into a live folder and restores its row, and `into_task: "<kept task>"` merges a duplicate task into the task that keeps the job as an iteration folder; on a Git desk it refuses a task, or a `track.md` it would edit, with unstaged changes or untracked files (another session may be working there), unless `allow_dirty: true`, and it stages every file it writes, so staged changes read as the current tidy's own work; merging with `into_task: "<kept task>"` never hides a live task inside a done one
- `track_rename` — rename a track, rewriting `track:` on every task card under it, live and archived; on a Git desk it refuses a track with unstaged changes or untracked files unless `allow_dirty: true`, and stages the task cards it rewrites

**Status:**
- `desk_status` — session-start-safe MCP health. Compact by default (one health word, why it is not ready, what to do, the search-index word, root, sync and pointers); `detail: true` returns the full root, activation, index, snapshot, and vector-pack payload
- `desk_doctor` — healthy-runtime confirmation or precise failure diagnosis and remediation; `{"repair":"switch_state_branch"}`, `{"repair":"reclaim_controller"}` and `{"repair":"prune_readiness_state"}` run the repairs described under [Handshake first, then admission](#handshake-first-then-admission); it also counts the private partitions the retired manual measurement ledger left under `<state home>/ouroboros-skills/desk/work-ledger/`, without opening, moving or deleting them

**Search:**
- `desk_search` — hybrid lexical + semantic
- `desk_recall` — semantic-only loose recall with auto-clustering
- `desk_similar` — find docs similar to a given path
- `desk_timeline` — temporal queries
- `desk_thread` — provenance walk via refs_graph
- `desk_reindex` — rebuild or repair the local search index

All 23 tools are wired to real implementations. There is no work-measurement tool either: the factory accounts for each session when it ends and reports each finished job ([local capture](../docs/factory-local-capture.md)). There is no qualitative feedback tool: preview feedback a participant chooses to offer is written as Markdown in their own desk at `_meta/preview-feedback.md`, and the protected store that already holds private records is retained as a [storage primitive](docs/private-feedback.md) with no route from this server. The optional `desk_doctor` input `{"format":"preview"}` returns a [minimal local diagnostic snapshot](../docs/preview-diagnostics.md), not feedback collection or a network report.

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

Copilot expands `${COPILOT_PLUGIN_ROOT}` to the installed plugin directory before launching the server, so startup is independent of the session working directory. Copilot CLI 1.0.89 and 1.0.91 do not read that file, though: they build a plugin's servers from `.mcp.json`, and a clean `copilot plugin install` followed by a real browser call and `desk_status` call works through its inline launcher. Both files therefore have to agree, and `tests/desk/mcp/__tests__/activation/mcp_declaration_integrity.test.js` fails when their server names, types, commands or entry files drift apart. The same test reads every MCP declaration under `plugins/*` (including the Codex and activation manifests) and rejects server names that model APIs reserve (`web`, `functions`, `browser` and others, listed in `RESERVED_MCP_SERVER_NAMES` in `src/activation/mcp-declarations.js`), names outside `^[a-z][a-z0-9-]*$`, and names so long that `<server>-<longest tool>` (Copilot's form) or `mcp__plugin_<plugin>_<server>__<longest tool>` (Claude Code's form) passes 64 characters. It also checks that the server names the Codex adapter spells out in code (`mcp_servers.desk`) are declared, and it reads a tool list by `<plugin>/<server>` before the bare server name, so two plugins may declare the same server name. Claude Code, Codex, and generic Ouroboros consumers use `.mcp.json`, whose inline launcher finds the plugin through `DESK_PLUGIN_ROOT` (set from `${CLAUDE_PLUGIN_ROOT}`) or the working directory and runs the same bootstrap. If it finds neither, it still completes the handshake and reports `degraded:plugin_root_missing`.

Once Node is running, `index.js` never exits before the handshake either. On a Node older than the `engines.node` floor it goes straight to finding a compatible Node (or to diagnostic mode), and any exception before the server starts becomes diagnostic mode with `state: "degraded:startup_exception"`. Diagnostic mode lists the full tool set; tools it cannot run return `{"status":"degraded","code","fix"}`.

## Handshake first, then admission

`index.js` answers `initialize` and `tools/list` before it does anything that can fail or take time. Only two things happen before the handshake: the Node version check, and the move to a compatible Node when no shipped runtime pack fits this one (that fix needs stdio the process has not answered yet). The tool list is always the full set of 23 tools and never changes during a session.

Nothing blocks the thread that answers the host. Admission starts only after the first `tools/list` reply (or after 1 s when no client asks). Root and activation resolution, the pack inspection and the runtime restore (which can wait up to 30 s on another process's publication lock) run on a worker thread (`src/runtime/admission-worker.js`); Git and the readiness controller are asynchronous. `initialize`, `tools/list`, `ping` and `desk_status` answer within 200 ms whatever admission is doing, including the transition to `ready`: the admission worker loads the restored native modules (`better-sqlite3` and `sqlite-vec`) once, so their first load never runs on the thread that answers the host, the runtime server is imported one local module per turn of the event loop, background convergence starts on a later turn, and opening the index database is split from the checks after it. Measured on a loaded Mac (load average 9 to 12) over 18 runs, the slowest answer through the transition was 50 to 75 ms; without the native warm-up it was 79 to 181 ms. Earlier measurements saw a rare whole-process stall of 236 to 314 ms under heavy load, which delays `ping` as much as `desk_status`, so the bound is normal operation, not a guarantee on a starved machine. `desk_status` joins an attempt that is already running without waiting on it, waits briefly for one it starts, and spends at most 90 ms of its own on the runtime status detail; when that detail is late it serves the last one, marked `cached`.

The runtime status computation's root observation and two read-only SQLite inspections (local DB coverage and generation metadata) run sequentially in one disposable child process, outside the answering thread, preserving their original sampling order around the controller observations. The child loads only the shared inspection modules, not the full runtime. A timer cannot interrupt synchronous filesystem or native SQLite work; moving that work is what preserves the response budget. A process, rather than another native worker thread, also preserves the Windows runtime's native-module safety boundary (Windows admission does not perform the warm-up described above). Concurrent status calls join the session's one computation. Context replacement, the existing run-age limit, or session shutdown aborts its owned reader; a replacement and shutdown wait for that reader to exit. On IPC disconnect the dedicated reader exits explicitly. The parent also bounds retirement: 100 ms for disconnect, 100 ms after SIGTERM, then 200 ms to observe exit after SIGKILL. Cancellation starts at SIGTERM. A reader that still has not exited produces `status_reader_not_exited`, with its exact PID and termination failures; its owned handle is retained and replacement refuses instead of starting another reader. Controller cleanup still runs when reader retirement fails. No SQLite handle crosses IPC, and no additional persistent service, readiness ledger or status cache is introduced. The parent's existing query router still decides generation certainty from its proof and the controller's current cursor. All status fields and cache timestamps retain their meanings; a late result is explicitly cached, not presented as a fresh observation.

Admission runs in the background (`src/runtime/desk-session.js`, `src/runtime/admission.js`): root resolution, the activation config and its `desk_runtime` policy, the runtime restore, the state-branch check, write authority and the readiness controller. Its state is `admitting`, then `ready` or `degraded:<code>`:

- Every data operation revalidates its destination through the existing worker-backed resolver before dispatch. A ready session also schedules or joins this check on `desk_status`, within the unchanged status budget. Unchanged inputs do not reload the runtime, inspect the state branch, elect a controller, or reindex; writes still perform their ordinary branch checks. A late association can replace a guessed fallback only after the new destination, policy and authority have been admitted. Explicit roots and host/session roots keep their precedence; saved activation and DESK associations now outrank host folder hints, including when the association is invalid. A missing or invalid saved binding refuses instead of falling back, and losing established context is not permission to select a different home-folder guess.
- Admission and data operations share one context boundary. A running operation finishes against its captured destination before admission can replace that destination; another operation waits for revalidation or refuses without dispatch if verification is still pending. Replacement intent must be at least as strong as the established resolver source: losing an association cannot reselect a captured launch folder, another equal-strength folder hint, or a lower-priority default. Stronger verified intent can upgrade an initial guess, and a same-path source change preserves the destination without unnecessary re-admission. Root changes clear the in-memory task focus. Root, activation or person changes invalidate cached status ownership, and late completions from the previous context cannot restore it. During unresolved replacement admission, status reports the current diagnostic rather than stamping old ownership ready. No second registry, task ledger, host hook or global default is involved.
- Same-context detail served while destination verification is pending retains `status_detail_from`, the actual runtime computation's start time, whether the caller just computed it or joined an existing computation. It never stamps cached detail with the caller's time. Without completed same-context proof, `detail_pending` remains true and no cache timestamp is invented. `admission.writes` remains refused until verification settles; a cached status does not bypass the operation's destination or authority gates.
- An operation that arrives during a status or HEAD admission attempt waits for that attempt, then samples destination inputs again. A resolver reply sampled before the operation arrived is not proof for its dispatch. This fresh check reuses ordinary revalidation and does not repeat unchanged runtime loading or controller election.
- A degraded session retries on its own after 1, 2, 5, 10 and 30 s, then every 60 s, and at once on every `desk_status` call and on a change to the checkout's `.git/HEAD`. A fix the agent makes in the session (creating the desk, correcting the activation config, pushing local commits) upgrades the same session to `ready` with no restart.
- `task_focus` answers whenever the runtime and a root are available, with no write authority. While the server is still admitting it waits up to 2 seconds for admission, then answers or refuses.
- `desk_status` always answers, with `state`, `code`, `fix`, the latest `repair` and an `admission` block (attempts, next retry, state branch, controller, a hung controller's missed checks and owner, whether writes are available, exceptions caught after the handshake, and the launcher mode).
- Reads (`desk_search`, `desk_recall`, `desk_similar`, `desk_timeline`, `desk_thread`) need the runtime and a root. Without a readiness controller, lexical search and timeline read the files directly.
- `desk_reindex` also needs the readiness controller.
- Writes (`task_*`, `track_*`, `friction_add`, `lesson_add`, `desk_save`) need admitted write authority and the checkout on its state branch, re-checked before every write. They never need the readiness controller: with one that answers, the change is journaled through it; without one, it goes straight to the file and a controller's watcher, or the next controller's convergence scan, picks it up.
- A tool whose needs are not met returns `{"status":"degraded","state","code","fix","blockers","tool"}` with a fix the agent can act on in the session. A tool that throws returns the same shape with `code: "tool_exception"`.
- After the handshake, an uncaught exception or unhandled rejection never ends the process, on every launch path (`node index.js`, `bootstrap.cjs` running `index.js` in its own process or re-running it as a child, and the Claude `.mcp.json` inline launcher): Desk records it, moves to `degraded:runtime_exception`, keeps serving and re-admits on its backoff.

Desk records each state change in its state directory, `$XDG_STATE_HOME/ouroboros-skills/desk` or `~/.local/state/ouroboros-skills/desk`: `last-start.json` holds the latest record of any session (`state`, `code`, `repair`, `fix`, `root`, `pid`), starting with `admitting`, and `last-start/<root key>.json` holds each root's own record, which also starts with `admitting` as soon as the session resolves the root (the key is the first 16 hex digits of the SHA-256 of the root path). `desk_status`'s `admission.last_start` names the root's own record once the root is known. Each repair Desk makes is appended to `repairs.log`. Tests and embedders pass `stateHome` to `main()` to keep all of this, and the readiness controllers, in a temporary folder.

### The readiness controller

- **A child process, not an MCP session.** The electing session starts the controller, watcher, journal and index writer on a separate event loop in its own child process. Reindexing cannot monopolize the owning MCP session's event loop. The [6,000-document regression](../../../tests/desk/mcp/__tests__/runtime/controller_process.test.js) rebuilds a missing index while measuring every owning-session `tools/list` reply against the 200 ms bound. As with admission, this is a normal-operation bound, not a guarantee on a machine the OS cannot schedule.
- **One rendezvous per root.** Every session derives the controller socket from the real root path, the user and the lexical contract, in the per-user folder `/tmp/desk-readiness-<uid>`, whatever `XDG_RUNTIME_DIR` or `TMPDIR` say, so sessions started from different environments elect one controller. A controller started by an older Desk at another socket is joined through the endpoint its owner record names, when that one answers.
- **Lost controllers.** Child death immediately invalidates the owning session's local controller and starts background re-election; its MCP connection survives, including when the child dies during a reindex. The interrupted tool reports an error. Other ready sessions check the controller every 60 s, on `desk_status` (in the background) and before journaling a write, and re-elect a lost one. Election reclaims a socket only when no running process owns it: the owner named in `owner.json` is gone (no such process, a process with that PID that started at a different time, or an owner that started before this boot), or `owner.json` is missing or corrupt and the socket refuses connections twice, 50 ms apart, and is still the same file.
- **An owner is a PID plus a start time.** When a controller is elected, `owner.json` records its process's PID and its start time as the OS reports it (`owner.process_start`: `/proc/<pid>/stat` field 22 with the boot id on Linux, `ps -o lstart=` on macOS, `Win32_Process.CreationDate` on Windows). A PID that is alive but started at a different time is another process that reused it, so the recorded owner is gone and the socket is reclaimed. A record from an older Desk without a start time is judged by its PID alone.
- **Clean release without host-observer guessing.** The MCP process installs no controller-cleanup signal listeners. Parent termination, whether stdin EOF, an ordinary signal or event-loop drain, closes the child's IPC lifetime and the child releases its own rendezvous. A host that retains the MCP process, including a signal-exit v4 callback returning `true`, keeps the child and its ownership intact. Passive v3, passive v4 and mixed observers therefore retain their ordinary termination behavior. The dedicated child also handles its own `SIGTERM` and `SIGINT`, independently of inherited observers. Cleanup removes `owner.json` and socket files only while their PID, process-start identity, token and socket identity still match. A supervisor force-stop waits for child death before cleanup; stale ownership is never released while that child can still write.
- **Election never takes over a running owner.** While `owner.json` names a process that runs, other sessions never unlink its socket or start a second controller, even when it does not answer or refuses connections (a stopped process, or one whose accept queue is full). They give a busy owner one 1 s handshake per attempt, then stay controller-free. Explicit hung-child repair has the separate preconditions below.
- **Hung controllers and safe repair.** A handshake probe (5 s, or `DESK_READINESS_PROBE_MS`) that a controller accepts but does not answer is a miss, and so is one its socket refuses, or finds no socket for, while its owner runs. After 3 consecutive misses of the same owner generation, the session is `degraded:controller_hung`; lexical reads and writes keep working. `desk_doctor {"repair":"reclaim_controller"}` may then ask the owning MCP session's private supervisor to stop its controller child. The supervisor checks health again, verifies the live process-start identity, the private directory and unchanged socket/owner record, and signals only its retained child handle, never a PID selected from the record. All MCP connections stay open and re-elect after child death. A changed owner, healthy child, failed identity lookup, insufficient misses or missing supervisor refuses repair. Old session-owned controllers and unverifiable owners remain report-only. `owner_verified` is true only after a successful live process-start match; a stored field alone is not verification.
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

The tests live in [`tests/desk/mcp/__tests__`](../../../tests/desk/mcp/__tests__/), outside the plugin folder, so hosts that install or refresh Desk never download them. `tests/desk/mcp` mirrors this folder, and the test setup links `tests/desk/mcp/node_modules` to this folder's installed `node_modules` so the tests' package imports resolve. Run `npm ci` here first.

Every test process in the coverage gate runs with `HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_RUNTIME_DIR` in one temporary folder per run (`tests/desk/mcp/__tests__/_isolated_env.mjs`, which the gate preloads and `_temp_roots.js` imports), so no test reaches the real `~/.cache` or `~/.local/state`. `npm test` preloads it too. To run tests directly with the same setup, preload it from this folder: `node --import ../../../tests/desk/mcp/__tests__/_isolated_env.mjs --test <files>`. (`package.json` is part of the published artifacts' source scope, so changing its `test` script meant re-anchoring the vector pack and snapshot manifests; their payloads are unchanged.) A write under the real home, outside the OS temp folder and this checkout, fails the test that made it; `test_isolation.test.js` guards the setup.

Run the same changed-production coverage gate used by CI with Node 22 or later:

```sh
npm run test:coverage
```

The gate runs the maintained tests through pinned `nyc` and `@istanbuljs/esm-loader-hook` development dependencies, then reads their JSON report. Statements are AST-instrumented units, not a copy of line coverage. The existing per-file thresholds and documented exclusions remain authoritative; the producer does not impose a separate global threshold. The pinned `test-exclude` override is covered by selector and real ESM/CommonJS execution fixtures. Source roots are canonicalized before instrumentation, and owned temporary reports are removed after evaluation. A nested invocation is refused with a failure status rather than reported as an unmeasured pass.

CI runs the same gate as parallel shards, because the instrumented suite runs its files one at a time and took about 17 minutes as one job. Each shard job runs `npm run test:coverage -- --shard <index>/<total> --output <dir>`: its share of the test files, still one at a time under the same instrumentation, keeping the raw coverage, each file's duration and a manifest. The `desk MCP test suite` job then runs `npm run test:coverage -- --merge <dir>` over all the shards. It refuses the result unless every shard of the split is present once and passed, every shard measured the same changed files, and together they ran exactly the test files of one whole-suite run. It then reports their combined raw coverage and applies the same per-file thresholds once. [`config/coverage-shards.json`](config/coverage-shards.json) holds each test file's expected seconds from a CI run; it only balances the shards, and a file it does not list still runs.
