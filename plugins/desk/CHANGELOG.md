# desk plugin — changelog

## 3.2.0-alpha.41 — 2026-09-26

Task A3 review corrections: [Git inspection](mcp/src/runtime/git-inspection.js) now uses a trusted absolute executable from standard host installation directories, never candidate `PATH`, and separates the modeled environment from the inspection-process environment. Only modeled Git location variables cross that boundary; candidate executable-search, loader and configuration overrides do not. The [review regressions](mcp/__tests__/runtime/protected_checkout_review.test.js) use a harmless executable sentinel, including a proposed command that explicitly names absolute Git, and require that inspection never runs it.

[Physical path traversal](mcp/src/runtime/shell-paths.js) follows symlinks before resolving parents for sequential `git -C` and `cd -P`; Bash retains a separate logical working directory for `cd -L` and honors `CDPATH`. [Operation-specific option parsing](mcp/src/runtime/git-guard-options.js) accepts unambiguous Git option abbreviations and consumes option values, so `restore --sour` and `branch --forc` are guarded while `branch --format -f` remains read-only. Forced worktree removal reads the victim's policy without the issuer's `GIT_DIR`.

The [Bash inspector](mcp/src/runtime/shell-commands.js) handles ANSI-C quoting, unquoted variable field splitting, `case` arms and unreachable commands after `exit`. A [separate PowerShell interpreter](mcp/src/runtime/powershell-commands.js) handles case-insensitive variables and location parameters, assignment, `sl`, subexpressions and the correct nested-shell grammar. Claude registers both `Bash` and native `PowerShell`; Copilot's PowerShell hook command uses a cross-platform path. Unknown computed target locations produce explicit inspection errors instead of being treated as unprotected. [Documentation](docs/protected-checkouts.md) states the trust and grammar boundaries. Ships the unchanged `desk-mcp@1.4.0-alpha.6` dependency payload; native packs and snapshot source scope are unchanged.

## 3.2.0-alpha.40 — 2026-09-26

Milestone 3a, task A3: [protected-checkout shell hooks](docs/protected-checkouts.md) for Claude `PreToolUse` and Copilot `preToolUse`, registered at plugin scope with no parent/subagent exemption. The [shared guard](mcp/src/runtime/protected-checkout.js) denies only the listed Git operations on a locally marked target and returns the exact worktree guidance. The [shell inspector](mcp/src/runtime/shell-commands.js) resolves quoted paths, chained directories, Git directory options, wrappers, aliases, substitutions and control flow without executing the proposed command; the documentation states the boundary for arbitrary computed code. Human Git commands bypass no new Git hook because none is installed.

[Common Desk admission](mcp/src/runtime/desk-session.js) marks launcher-bound roots using a checkout-specific conditional include, so new task worktrees do not inherit automatic protection. [Command-table regressions](mcp/__tests__/runtime/protected_checkout.test.js) exercise parent and child hook payloads, unchanged HEAD and reflog on denial, human terminal access and new worktree isolation. The [Desk-to-Superpowers adapter](skills/using-superpowers-with-desk/SKILL.md) supplies the one-line owned-worktree rule to implementer and reviewer briefs without changing vendored Superpowers. Ships the existing `desk-mcp@1.4.0-alpha.6` dependency payload; native dependency packs and snapshot source scope are unchanged.

## 3.2.0-alpha.39 — 2026-09-26

Milestone 3a, task A2b: the readiness controller, watcher, journal and index writer now run in a child process owned by the electing MCP session. Reindexing no longer shares that session's event loop. The [real-process regression](mcp/__tests__/runtime/controller_process.test.js) rebuilds an absent index from exactly 6,000 documents and enforces a 200 ms maximum for the owning session's `tools/list`; this is a measured normal-operation bound, not a guarantee against OS starvation. The root rendezvous, election, semantic contracts, health pings and controller-free reads and writes remain unchanged.

The owning session holds a private supervisor endpoint and the actual child handle. After three missed probes of the same controller generation, `desk_doctor {"repair":"reclaim_controller"}` can ask that supervisor to stop only its hung child. The supervisor re-probes health, requires a successful live process-start match and unchanged private ownership and socket identity, then confirms child death before releasing the rendezvous. It never signals an MCP session or a PID merely read from disk. Legacy and unverifiable owners remain report-only. `owner_verified` now means a successful live identity match, not the presence of a stored start-time field.

A child exit invalidates the owning session's local election state and starts background re-election without losing its MCP connection; an interrupted reindex returns an error rather than a false success. Parent termination closes the child's IPC lifetime, while a host that captures a signal keeps its child and ownership. The MCP process no longer installs controller-cleanup signal listeners, so passive signal-exit v3, v4 and mixed observers cannot deadlock each other's shutdown decisions. The dedicated child handles its own termination even with an inherited v4 preload. Regression coverage includes deliberate v4 capture, retained active host handlers, two successive hung-child reclaims and two successive mid-reindex deaths. Ships the existing `desk-mcp@1.4.0-alpha.6` dependency payload with updated source; native dependency packs are unchanged.

## 3.2.0-alpha.38 — 2026-09-26

Milestone 3a, task A2: handshake first, then admission. The Desk MCP server answers `initialize` and `tools/list` before it does anything that can fail or take time, and nothing ever blocks the thread that answers the host: `initialize`, `tools/list`, `ping` and `desk_status` answer within 200 ms in normal operation whatever admission is doing, through the transition to `ready` too (slowest answer 50 to 75 ms over 18 runs on a loaded Mac; a rare whole-process stall of 236 to 314 ms was seen earlier under heavy machine load): the admission worker loads the restored native modules once so their first load never runs on the thread that answers the host, the runtime server is imported one local module per turn of the event loop, convergence starts on a later turn, and `desk_status` joins a running attempt without waiting on it and serves its last runtime detail, marked `cached`, when a fresh one is late. Before the handshake, `index.js` only checks the Node version and moves to a compatible Node when no shipped runtime pack fits. A dependency-free front door (`src/runtime/front-door.js`) always lists all 18 tools; admission starts after the first `tools/list` reply. Root and activation resolution, the pack inspection and the runtime restore (including a wait on another process's publication lock) run on a worker thread (`src/runtime/admission-worker.js`); Git runs asynchronously. Admission (`src/runtime/admission.js`, `src/runtime/desk-session.js`) is `admitting`, then `ready` or `degraded:<code>`; a degraded session retries after 1, 2, 5, 10 and 30 s and then every 60 s, and at once on every `desk_status` call and on a `.git/HEAD` change, so creating a missing desk, fixing an activation config or pushing local commits upgrades the running session to `ready`. Reads work without a readiness controller (lexical search and timeline read the files directly); writes need admitted authority and the checkout on its state branch, never the controller: with one they are journaled, without one they go straight to the file. A refused tool returns `{status: "degraded", code, fix, blockers}`, and a tool that throws returns `tool_exception` the same way. After the handshake, an uncaught exception or unhandled rejection never ends the process on any launch path, including `bootstrap.cjs` and the `.mcp.json` inline launcher running `index.js` in their own process: Desk records it as `degraded:runtime_exception`, keeps serving and re-admits. A lost controller is re-elected in the background. A socket is reclaimed only when no running process owns it: its recorded owner is gone (no such process, a process with that PID that started at another time, or an owner that started before this boot), or `owner.json` is missing or corrupt and the socket refuses twice. `owner.json` names its owner by PID and start time (`owner.process_start`, read from `/proc` on Linux, `ps -o lstart=` on macOS and `Win32_Process` on Windows), so a stale record whose PID another process has reused no longer pins the root in `controller_hung`; a record from an older Desk without a start time is judged by its PID alone. A Desk process releases its controller on every normal end (stdin closed, `SIGTERM`, `SIGINT`, `beforeExit`, `exit`), removing `owner.json` and the socket file only while they are still its own, and a signal it handles alone still ends the process by that signal. While the recorded owner runs, other sessions never unlink its socket or start a second controller, even when it is stopped or its accept queue is full. A controller that misses 3 handshake probes in a row (no answer, or refused while its owner runs) marks the session `degraded:controller_hung`, which stays controller-free with reads and writes working, and whose fix says there is nothing to do and names the owner as the Desk process only when its start time was checked; Desk never signals the owner, another session's Desk MCP server, and `desk_doctor {"repair":"reclaim_controller"}` reports it. Every session meets its root's controller in `/tmp/desk-readiness-<uid>` whatever `XDG_RUNTIME_DIR` says, so sessions from different environments elect one controller. An embedding-model override degrades semantic search only (`semantic: unavailable (embedding_override)`); lexical search and writes keep working. New generic `--state-branch <name>` (or `desk.state_branch` in the activation config): during the session's first admission attempt only, whatever it ends in, a detached HEAD, or a branch equal to its upstream, is switched back with `git switch --no-guess` only when the tracked tree is clean, no Git operation or `index.lock` is in progress, no commit is local-only, the state branch exists and HEAD has not moved since the check; Desk never fetches or resets, and reports `repaired: detached HEAD → main (was <sha>)`. After that attempt Desk never switches on its own, even in a session that never reached `ready`: a HEAD that leaves the state branch makes writes read-only with a fix that names `desk_doctor {"repair":"switch_state_branch"}`. New refuse-but-connect start mode for launchers: `--degraded <code> [--degraded-reason <text>]` keeps reads for crew-state, repository and identity codes and refuses every data tool for integrity codes. `desk_doctor {"repair":"prune_readiness_state"}` removes leftover readiness-controller folders whose owner is dead, whose socket is closed and whose root is gone. Desk records each state change in `last-start.json` and `last-start/<root key>.json` (`state`, `code`, `repair`; the root's record starts with `admitting`, and `desk_status` names it) and each repair in `repairs.log` in its state directory. A runtime publication lock held for the whole wait is reported as `runtime_restore_locked` with the lock and its owner PID. An unreadable index database is reported as `corrupt` and rebuilt during convergence. A1's pre-handshake admission retry is removed; the Claude `.mcp.json` launcher falls back to its own responder when the bootstrap's `run()` rejects; remediation text names the in-session step instead of restarting the host. Every test process under `npm test` and the coverage gate runs with `HOME` and the XDG folders in a temporary folder per run (`__tests__/_isolated_env.mjs`, also imported by `_temp_roots.js`), a write under the real home fails the test, and tests pass a temporary `stateHome`, so none writes to the real `~/.cache` or `~/.local/state`; and the handshake helpers pace `notifications/initialized` and `tools/list` as separate writes, like a real host. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

Fix round 4: a readiness controller's `owner.json` now names its owner by PID and start time, so a stale record whose PID another process has reused no longer keeps later sessions in `controller_hung`; every normal end of a Desk process (stdin closed, `SIGTERM`, `SIGINT`, `beforeExit`, `exit`) removes its own owner record and socket file; the `controller_hung` fix names the owner as the Desk process only when its start time was checked; the admission worker loads the restored native modules so the transition to `ready` stays at 50 to 75 ms in the measured runs; and `npm test` preloads the test isolation setup.

Verification follow-up: signal cleanup runs before existing listeners, so an exit observer such as the coverage runner's `signal-exit` can forward the signal after Desk removes its listener, rather than both waiting for the other to end the process. Explicit host signal handlers retain control. Spawned shutdown tests have bounded deadlines, startup-status tests wait for controller detail instead of assuming admission has already finished, and a two-cycle regression covers an old owner record pointing at a vanished XDG socket while the fallback socket has no listener.

Fix round 5: a host signal handler that keeps the process running now also keeps its controller's ownership files and exit hooks. Later sessions join the same live controller instead of electing a second one while the original still serves accepted connections. Normal signal termination and the coverage runner's passive `signal-exit` observers still clean up the rendezvous. Real-process regressions retain an original controller connection and attempt a second election through two consecutive cycles for each of `SIGTERM` and `SIGINT`.

## 3.2.0-alpha.37 — 2026-09-25

Milestone 3, task M3-6: the local outbox and consent, and the factory CLI's first subcommand. New `factory/outbox.js` is the protected, owner-only state folder under `<state>/ouroboros-skills/desk/factory/` (`$XDG_STATE_HOME`, else `~/.local/state`) that holds everything a machine keeps before, and instead of, sending anything to a factory store: per-store consent (`readConsent`/`setConsent`, which mints a store's `intake_id` on its first "yes" and keeps it through any later decision, serialized so concurrent decisions for different stores are never lost), pending-session markers (`writeMarker`/`listMarkers`, pruned past 30 days or on an unparseable `updated_at`, one corrupt marker dropped rather than blocking the rest), the local-facts outbox (`writeLocalFacts`, a no-op without a "yes" and a refusal that never writes invalid facts), delivered and quarantined records (`pendingFiles`, `markDelivered`, `quarantine`, a file that fails to parse quarantined with reason `invalid` instead of blocking the batch), the visibility cache (`readVisibilityCache`/`writeVisibilityCache`, validated entries and malformed ones skipped on read, 7-day expiry), flush status (`readStatus`/`writeStatus`), finalize requests and the jobs index (`requestFinalize`, `listFinalizeRequests`, `clearFinalize`, `readJobsIndex`, `updateJobsIndex`), and a machine secret (`readMachineSecret`: 32 bytes, created exactly once even under concurrent first use via an exclusive hard link, validated on every read and rotated — under this file's own lock, re-checked inside it so concurrent readers of a corrupt secret serialize on one fix-up instead of racing each other — with a recorded `secret_rotated` status if ever found the wrong size; never logged). Every read-modify-write of a shared JSON file is serialized by a stale-recoverable lock file (the same shape as the planned `flush.lock`, judged from the lock file's own filesystem `mtime`, never its content); every listing skips a symlink, a hard link or other non-regular entry rather than following it; a JSON state file that fails to parse, or parses to the wrong shape, is moved aside and read as empty; a read re-checks the same symlink, hard-link, mode and macOS-ACL guards a write does before any byte is used; and a stale (over one hour old) leftover temp file is swept on the next write to that folder. `pendingFiles` takes an injected `publishedBytesFor` so it never imports `publish.js` itself, comparing `gitBlobSha` (matching `git hash-object`) of the transform's current output against the last delivered blob SHA. New `factory/os-protect.js` holds the directory-chain guards (Git-checkout refusal resolved with `realpath` before anything is created and re-checked on every folder this module owns, symlink refusal, macOS extended-ACL clearing) and the leaf-file guards (symlink and hard-link refusal, mode repair) that `src/protected/store.js` also calls for its own directory chain (its one remaining leaf-file check, the database file's, stays inline, unchanged); `factory/windows-acl.js` — moved from `src/feedback/windows-acl.js`, which now just re-exports it, with an added `label` so each caller's refusals read as its own — is the same batched, verified NTFS-DACL routine `store.js` and `readiness/journal.js` already called, applied here too: the outbox checks the provider is available before creating anything and protects a whole operation's directories and file in one call rather than one call per path. New `scripts/factory.js` is the first Desk factory CLI, with its first subcommand: `factory.js consent --store <owner/repo> --contribute yes|no [--account <gh login>]`, printing the resulting record as one JSON line and exiting 1 with one usage or validation line on stderr; later tasks add more subcommands. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

## 3.2.0-alpha.35 — 2026-09-25

Milestone 4, task M4-5: the one-time tidy. Adds the `02-tidy-desk` Desk migration, which agents run once in their first session after the upgrade: it tidies the agent's own desk into the organization rules and announces it in one line ("I tidied up my desk a bit: … Say if you mind and I'll put anything back.") without asking first. Its Detect fires when `desk_doctor` reports organization findings in the session's own desk subtree and that subtree's `_meta/organization.json` does not record `tidy_version: 1`; it never fires for a desk that is not a Git repository, or for a crew desk unless `DESK_PERSON` names the session's own desk. Its Migrate block changes nothing: it prints the findings and the ordered steps (scope lines, outcome names, merging duplicate tasks, filing loose files, re-filing person-named and catch-all tracks, archiving empty tracks, then recording, committing and pushing), which the agent performs with the Desk tools. Migrations gain an optional `agent_work: true` frontmatter field for this kind of in-session work; `desk:session-start` runs such migrations after the workspace is synced and the crew desk is known, and the driver passes `DESK_PLUGIN_ROOT` and `DESK_PERSON` to every block. New `mcp/scripts/tidy-status.js` (backed by `src/desk/tidy.js`) reports, detects, checks safety and writes `_meta/organization.json` (`{ "schema_version": 1, "tidy_version": 1, "tidied_at": <iso> }`, documented in `directory-structure`); it runs from the installed plugin with no npm dependency, so the organization checks now load gray-matter lazily and fall back to a small dependency-free card reader (`src/desk/frontmatter-lite.js`). `task_move` gains `unarchive: true` (reopen an archived task into a live folder and restore its row; `start-task` now uses it instead of a hand-run `git mv`) and `into_task` (merge a duplicate task into the task that keeps the job as a dated `_iterations/` folder, with its card kept as `merged-task.md`). The doctor now allows the desk-root `artifacts/` folder and dot-folders such as `.git/`, which it previously reported as loose on every Git desk, and a new test covers redaction of `track_empty` on a credential-like track name.

Fix round 1: `naming.js` exports `isCredentialLike(name)`, which splits a name on every non-alphanumeric character, strips its extension and applies the password-prefix, secret-run and IPv4 rules whatever else the name gets wrong; `validateName` reports `credential_like` first and the doctor redacts through it, so a prompt-like, over-long or extension-bearing name that carries a password is never printed. The tidy works on the desk the Desk tools use: the driver passes `desk_status`'s root and person (`DESK_TOOLS_ROOT`, `DESK_TOOLS_PERSON`), the script resolves its own (the person on a crew desk from `_meta/desks.md`'s identity column, with `DESK_PERSON` as an override), and Migrate prints both and says one line instead of tidying when they differ, when no person resolves, or while Git is mid-merge or mid-rebase (the Safety check no longer stops the session). The report lists uncommitted paths so the agent leaves other sessions' tasks and tracks alone; the steps add untracked loose files with `git add` before `git mv`, leave ignored files, file desk-wide material in `_meta/`, merge duplicates only on the agent's judgment and never hide a live task, name moves by their new names in the commit message, check the staged set before committing, and revert without losing the record. Stale tasks no longer make Detect fire, and Detect reads the record before walking the desk. The indexer indexes `merged-task.md` as kind `merged-task`. `task_move` refuses to merge a task into itself. The doctor no longer allows dot-folders at a track root. The dependency-free card reader rejects duplicate keys, unclosed quotes and unbalanced flow collections as gray-matter does, drops a comment after a closing quote, reads `|` and `>` block scalars, and reads a timestamp with a space before its offset.

Fix round 2: `task_move` and `track_rename` refuse, on a Git desk, a source folder with uncommitted tracked changes or untracked, non-ignored files, because another session may be working there, unless the caller passes `allow_dirty: true`; the refusal never quotes names, and the tidy never passes `allow_dirty`. The tidy's `gh` identity lookup is cached in Desk's state folder (`ouroboros-skills/desk/identity-cache.json` under `$XDG_STATE_HOME`, else `~/.local/state`), keyed by desk root, for 24 hours when found and 1 hour when the lookup fails, so Detect makes no network call at most session starts.

Fix round 3: `isCredentialLike` checks each name both with and without its extension, so a password written after a dot (`set-pw.hunter2`) is redacted, and a loose entry with such a name is flagged to get an outcome name when it moves. `task_move` also refuses, unless `allow_dirty: true`, when a `track.md` whose tasks table it would edit has uncommitted changes, and `into_task` refuses to merge a live task into a done or cancelled one. The tidy commits with `git commit -- <tidy paths>` and never unstages anyone else's work, and when the tools name a person the tidy cannot resolve, it says exactly that in one line. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

Fix round 4: the tidy's own earlier steps no longer block its later ones. `task_move` and `track_rename` refuse only unstaged changes to tracked files or untracked, non-ignored files (`git diff --name-only` or `git ls-files --others --exclude-standard` under the path), in the source folder and in every `track.md` they edit; staged changes count as the current tidy's own work in progress. Both tools now stage every file they write, not only the `git mv`. `track_create` stages the new `track.md`, and `track_update` stages the `track.md` it writes when that file held no unstaged changes before, so it never adopts another session's edit; both write anyway if `git add` fails. A scope-line write then a rename, two renames in a row, a rename then a merge, and a new track then a re-file then a track rename all go through in one run without `allow_dirty`, while another session's unstaged `track.md` edit or untracked file in a task folder is still refused. The tidy's rules now say to stage anything else it changes right away, and step 7 checks that nothing under the tidy paths is unstaged or untracked before `git commit -- <tidy paths>`.

## 3.2.0-alpha.34 — 2026-09-25

Splits the factory's facts into a local form that never leaves the machine and a published form for the public stores, and adds the one transform between them. The M3-1 schema becomes the local schema, `desk.factory.local/1`: it keeps exact times, drops `contributor`, takes the binding's jobs with the task card's creation time (and a null observation time for a card that is not done or cancelled), and gives commit references a nullable repository; `validateLocalFacts` and `validateLocalFactsBytes` replace `validateFacts` and `validateFactsBytes`, which stay as aliases until a later task retires them. New `factory/published-schema.js` is the public gate for `desk.factory.published/1`, which says how the work went with no who and no when: durations and offsets only, no date, time of day, contributor, machine, path or branch, and only public repositories' references, the rest counted. It reuses the local schema's spec walker, enums, patterns, caps, canonical-bytes rule and no-echo errors, refuses any date-shaped string or time of day, requires a version-4 session ID (other versions can carry a time or a machine), caps the session's duration and every offset at ten years so none can carry an epoch value, and refuses a repeated `unavailable` entry or reference. New `factory/publish.js` holds `toPublished`, the only code that produces what leaves the machine: a pure, deterministic transform that turns times into the session's duration, interval offsets from its start and job offsets from the task card's creation, drops an interval outside the session rather than clamping it, keeps only references whose repository is public, and removes the hyphens of a date (and the colons of a time) inside a model ID or plugin name. It refuses a session longer than ten years or starting before 2025, when neither host existed (`implausible_session_span`, a bogus early log line), or with a session ID that is not version 4 (`session_id_not_v4`), instead of publishing it. A desk whose own remote is public or unknown publishes no job timing and keys each job ID with a per-machine secret (`HMAC-SHA256`), marked `{job_offsets, desk_public}` and sorted by that keyed ID, so a public desk's task-card dates cannot turn offsets back into time; the gate refuses a `desk_public` file that still carries job timing. Both derivers now write local facts with no contributor and mark data trimmed to a schema limit with the new `capped` reason, keeping `log_truncated` for a log that ends mid-record; the Copilot deriver reads the host's real reference shapes: a bare PR number takes the session's repository from the session database, and every commit ref is looked up in the session's own repository with one local `git cat-file --batch-check` (new `factory/commit-resolve.js`), so a short SHA becomes its full SHA and binding gets full hashes; a commit is labeled with the session's repository only when that repository has it and its `origin` is that repository; a reference it cannot resolve is counted and published only as a private count. Nothing calls the transform yet. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

## 3.2.0-alpha.32 — 2026-09-25

Milestone 4, task M4-4: the skills own routing, naming and layout. The agent names every task and track from its outcome with no proposal step, routes new work by each track's one-line `scope:` ("<what belongs>; not <what doesn't>"), creates a new track with a scope line when none clearly fits, and treats a follow-up, re-review or retry of the same outcome as an iteration of the existing task, reopening a `done` or archived task for it (`start-task`, `track-card-format`, `task-lifecycle` "One job is one task" and its new `done` → `processing` reopen transition, `peer-pr-review`); a task with no repositories keeps its iterations under `<task>/_iterations/`. `directory-structure` lists what may sit at the desk and track roots and points renames at `task_move` and `track_rename`. `interaction-style` section 2 is now "Organization: tidy and announce": when something could be better organized, the agent tidies it through Git, says so in one line ("I'm going to tidy up my desk a bit: … Say if you mind.") and proceeds, and it gains the procedure for frontloading what the human must supply. `using-desk` gains the organization sentence, the frontloading and stay-in-the-conversation rules, and two sections, "Cite every factual claim" (procedure in `evidence-discipline`) and "Own the stack", each stated as its essence only; it grows from 6379 to 7483 bytes. The estimate rule now lives only in `evidence-discipline` "Fixtures or refusal", with pointers from `interaction-style` and `operator-voice-comments`. Hard-wrapped prose in 14 Desk and 2 Crew skills is joined onto one line per paragraph, list item and blockquote paragraph, and a Desk content contract now fails on a new hard wrap in any Desk or Crew skill; its detector skips fenced and indented code, tables and HTML. Crew moves to `0.2.2` for its unwrapped skills. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

## 3.2.0-alpha.29 — 2026-09-25

Milestone 4, task M4-3: doctor organization checks. Adds `organizationFindings(deskRoot, { personPrefix, operatorNames, now })`, a read-only scan that surfaces organization problems in the caller's own desk subtree so an agent can tidy them later — tidying itself is a later task; this one only reports. It checks the loose-file allow-lists from the rulings (a desk root may only hold track folders, underscore folders, `desks/`, `AGENTS.md`, `README.md`, `CLAUDE.md` and dotfiles; a track root may only hold `track.md`, task folders and underscore folders — everything else is `loose_file`), a track's `scope` line (`track_missing_scope`), a track named after the operator or a catch-all (`track_person_name`, `track_catch_all`), a track with no live or archived tasks (`track_empty`), a non-terminal task whose `updated` is more than 30 days old (`stale_task`), and two or more non-archived task cards that reference the same pull request URL in their frontmatter or the first 200 lines of their body (`duplicate_job`). Every track and task directory name is re-checked through M4-1's `validateName`/`validateTrackName` (`name_shape`, `name_prompt_like`, `name_credential_like`) — unlike the CRUD tools, the doctor's job is exactly to surface a pre-existing bad name, not to gate a write; a `credential_like` finding never echoes the offending path segment, reporting the parent path plus the literal `<redacted segment>` instead. The scan never walks into a `desks/` container it finds, so a crew desk's peer subtrees stay invisible to it however it's invoked. `desk_doctor` now prints an "Organization" section (count per code, first five paths per code) and returns the findings under a new `organization` key in its structured output; the dependency-free `preview` format is unaffected and still carries no workspace data. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

## 3.2.0-alpha.28 — 2026-09-25

Adds the factory's binding and store routing. `factory/binding.js`'s `bindSession` decides which Desk tasks a session worked on and returns only hashed job IDs with their bases, the card's created time, the session's status transitions and the card's observed status; `jobId` hashes the normalized desk remote, the person prefix and the task's track and slug. A task binds through a successful Desk task tool call, a successful file write in its live or archived folder, or a desk commit that changed its folder. Because agents commit with `git commit -q`, which prints no hash, a desk commit binds when this clone made it (a `commit`, `commit (initial)`, `commit (amend)` or `commit (merge)` reflog entry) at a time inside one of the session's own successful `git commit` shell calls in the desk, so commits fetched from another clone or machine never bind; Copilot's native commit refs bind directly, and hashes scraped from tool output never bind. Two sessions on one clone whose successful commit calls overlap both bind a commit made in the overlap. `factory/shell-git.js` finds those calls in memory, treating `--git-dir`, `--work-tree`, `GIT_DIR`, `GIT_WORK_TREE`, `pushd`, `popd` and subshells as an unknown directory, and both derivers now emit `events.shellGitCommits` for successful calls and `events.nativeCommitShas`; the command text never reaches facts or events. `factory/desk-repo.js` holds the real read-only readers (task-card frontmatter, this clone's commits in a window read once per session, one commit's changed paths, the desk's remote), which read nothing when the desk root is not its repository's top level. `factory/store-route.js`'s `resolveStore` picks the store from the desk's `_meta/factory.json`, then a sibling plugin's `desk.factory.store`, then `ourostack/factory`, and holds the facts on any invalid declaration; an unreadable or unparseable plugin manifest is skipped and reported in the result's `warnings`. Nothing calls them yet. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

## 3.2.0-alpha.27 — 2026-09-25

Milestone 3a, task A1: the Desk MCP server never exits before the MCP handshake, and it starts on a compatible Node even when the host puts an old `node` first on `PATH`, on macOS, Linux and Windows. Both host MCP configs (the Claude `.mcp.json` and the Copilot `.mcp.copilot.json`) now run `mcp/bootstrap.cjs` with whatever `node` the host finds. The bootstrap is ES5 and runs on Node 8 and later. It finds Node binaries on `PATH` and under nvm, fnm, Volta, asdf, mise and Homebrew (on Windows: nvm-windows, fnm, Volta, mise and Program Files), keeps those that satisfy `engines.node`, and prefers the newest whose ABI has a shipped runtime pack, read from the same support matrix `index.js` uses, so `index.js` never restarts itself. It runs `index.js` in its own process when the running Node is that choice, and otherwise as a child with inherited stdio, forwarded signals and its exit code. With no compatible Node, the bootstrap itself answers the handshake, lists every Desk tool and answers each call with `{state: "degraded:node_missing", fix: "<install command for this OS>"}`. The Claude launcher still completes a handshake, as `degraded:plugin_root_missing`, when it cannot find the plugin at all. The one case out of reach is a machine with no `node` at all. In `index.js`, `main()` checks the running Node against the engines floor before any other work, a startup exception is served as diagnostic mode (`degraded:startup_exception`) instead of `exit(1)`, failure snapshots no longer need `structuredClone` (Node 16 crashed on it), and diagnostic mode lists the full tool set, advertises `tools.listChanged` and gates data tools with `{status: "degraded", code, fix}`. Anything that throws inside the bootstrap, including a synchronous spawn failure, is served as `degraded:bootstrap_failed` or `degraded:node_spawn_failed`. The `node_missing` fix names the Node major Desk ships a runtime pack for on this platform (for example `nvm install 22` or `brew install node@22`; on Windows `nvm install 24` or a `winget` command that PowerShell 5.1 accepts). Probes share a 3 s budget and never run Volta, asdf or mise shims. Before giving up, `index.js` retries a readiness-controller election or socket failure for up to 5 s with backoff, the window the host's own retry used to cover; A2 replaces this with background re-election. The Codex activation bridge launches the bootstrap too. The coverage gate now also measures `mcp/bootstrap.cjs`, and the Windows CI job completes real handshakes through it on Node 24 (in-process) and Node 20 (re-exec). Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

## 3.2.0-alpha.26 — 2026-09-25

Milestone 4, task M4-2: cheap moves. Adds two Desk MCP tools so a weak name or a misfiled task is easy to fix without a hand-edit. `task_move` moves a task to another track and/or renames it — it works on a live or an archived task (staying archived if it started archived), refuses a taken target, and validates a new slug through M4-1's `validateName` (an unchanged slug is never re-validated); a destination track goes through the same `validateTrackName` `track_create`/`track_rename` already enforce and must already have its own `track.md` — a move never creates a track implicitly. It sets `track:` on the moved card and best-effort moves its row between the source and destination `track.md` "## Tasks" tables, or renames the row in place for a same-track move — a `track.md` that doesn't follow the recommended table template is left untouched, never corrupted. `track_rename` renames a track through the same `validateTrackName` `track_create` already enforces, refuses a taken target, and rewrites `track:` in every task card under it, live and archived. Both stage the move with `git mv` semantics on a Git desk (staging first so an untracked or modified source is picked up cleanly) and fall back to a plain rename otherwise; neither ever commits, and neither rewrites free text elsewhere — both return `mentions`, the other `.md` files under the desk that still reference the old path, for the agent or operator to fix if it matters. No refusal from either tool ever quotes a candidate, including a path-segment error: `track`/`slug` are screened for traversal-shaped input (`..`, `/`, `\`, empty) before any path-resolution code runs, ahead of the generic write-target guard whose message is allowed to quote for tool-misuse debugging. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

## 3.2.0-alpha.23 — 2026-09-25

Adds the factory's Copilot CLI deriver (`factory/derive-copilot.js`): it streams one session's `events.jsonl` in a single pass with small state and turns it, with that session's rows in the host's `session-store.db`, into privacy-safe local facts (turns, tool calls and outcomes, human and permission waits, subagents, API retries, compactions, usage, plugins, PR and commit references) plus in-memory binding events for Desk task tools and successful file writes. A turn is one root interaction (a prompt's model iterations), subagent events never count as the root's, and only a root message with no source that is not an autopilot continuation counts as a human prompt. Usage comes from the last `session.shutdown` when nothing follows it and otherwise from the database rows, never both, and a stale shutdown is marked unavailable; no content field is read into facts, and every copied value is validated, so the output always passes `validateFacts`. The factory reads the session database through its own `factory/copilot-usage.js`, which loads `node:sqlite` lazily and silently and reports the data as unavailable on a runtime without it; the work ledger keeps its `better-sqlite3` reader in `measurement/copilot-usage.js`, unchanged. Nothing calls the deriver yet. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

## 3.2.0-alpha.22 — 2026-09-25

Milestone 4, task M4-1: naming and scope rules enforced by the Desk MCP tools. `track_create`, `track_update` and `task_create` now validate every name and, for tracks, the new `scope:` frontmatter line, so no client can create or rename into a prompt-copied name, a credential-like token, a person-named or catch-all track, or a track with no scope. Adds `desk/naming.js`: `validateName` and `validateTrackName` reject a first word drawn from a greeting or request list, an IPv4-looking run, a credential-like word or token, a name outside 2–6 lowercase kebab-case words, or (for tracks) a catch-all or person name; `validateScope` requires a single line of at most 240 characters; `operatorNames` reads `_meta/desks.md`'s alias/identity columns plus the desk's own `git config user.name`. Errors always say how to fix the name and never echo a credential-like candidate back. Existing names are never rejected on read — only creation and renaming validate. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

## 3.2.0-alpha.21 — 2026-09-25

Adds the Claude Code deriver, the factory's first source reader: `factory/derive-claude.js` reads a session's native JSONL transcript in one streaming pass with small state (memory tracks the number of turns and tool calls, not the transcript's size) and turns it into a facts object (`jobs: []`, filled in by a later task) plus in-memory binding events for matching Desk tool calls, successful file writes and commits to tasks. It takes each message's usage once (the per-field maximum across the lines Claude Code repeats it on), leaves API-error lines and the `<synthetic>` model out of usage, requests and the root model while still counting them as API retries, buckets every tool call and outcome, infers turns and human waits from human prompts only (excluding meta, compact-summary, system and task-notification lines), folds subagent transcripts in as numbered agents with their real parent at any nesting depth, and dedupes PR refs seen through both `pr-link` and `gitOperation.pr`. It never throws on an unexpected line shape, and it checks every value it copies against the facts schema, dropping what fails with a matching `unavailable` entry, so its output always passes `validateFacts`; a transcript with no usable envelope returns `source_unreadable` instead of invented values. Nothing it derives ever carries transcript text, prompt text, tool input or tool output — those only ever reach the in-memory events, never the facts. Commits are not native to the host, so `refs.commits` stays empty with `unavailable {commits, host_does_not_record}`; permission waits and CI runs are unavailable for the same reason and by slice-1 scope. Ships its own generator, `__tests__/factory/fixtures/claude/make.js`, which builds the synthetic transcripts the deriver's tests run against — no real transcript is read or copied. Also extends `schema.test.js`'s oversized-array cases to plant the sentinel inside every capped array's unread items, not only `plugins`, closing a gap noted in the facts-schema review. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

## 3.2.0-alpha.20 — 2026-09-25

Lays the first foundation of the factory, the privacy-safe work measurement built from native session logs: the facts file v1 schema and its validator, the tool-name-to-kind mapping for Claude Code and Copilot CLI, and shared timestamp/interval helpers. Nothing reads or writes real session data yet; this only adds the shape every later factory piece validates against. `normalizeTimestamp` moves into `factory/time.js` verbatim, and the work ledger's `measurement/copilot-usage.js` re-exports it unchanged. `measurement/work-profile.js` keeps its own private, span-shaped `intervalUnion` (a different signature from the new `factory/time.js` one, which works on `{start, end}` pairs), now rewritten as a thin adapter that filters and remaps onto the shared implementation — its behavior and every existing test are unchanged. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

## 3.2.0-alpha.19 — 2026-09-25

Updates the RFC's status: layered foundations load once on both hosts, the RFC path works from any repository, alpha users migrate automatically; notes launchers that do not refresh dependencies. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

## 3.2.0-alpha.18 — 2026-09-25

A cleanup release: each rule the Codex block, the skills and the docs still restated now lives only with its owner, the last hard-wrapped skills are unwrapped, and the unused Ponytail dependency is gone. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

- **Codex owned block.** It injects the `using-desk` foundation and adds only Codex activation text: run `desk:session-start`, bind `$DESK`, and apply `plain-language` and `superpowers:using-superpowers`, because no Codex hook loads them. The Desk MCP health guard (`session-start`), the hard-wrap rule (Plain Language), method entry (`using-desk`) and the legacy Work Suite mapping (the retired-name redirect) are no longer restated. The Codex worker body tells a worker started in `manual-only` mode, where nothing injects `using-desk`, to invoke it.
- **Retired name.** Every skill and doc that sent work through `desk:superpowers-integration` now names `desk:using-superpowers-with-desk`. The redirect skill stays for unchanged standing instructions.
- **Channel rule.** `independent-review`, `pr-self-review`, `pr-feedback-on-own-pr`, `session-resumption` and `task-lifecycle` drop frozen-candidate wording: reviewers use the current candidate on the channel, and a recorded head is evidence only.
- **Unwrapped prose.** `interaction-style`, `operator-voice-comments`, `peer-pr-review`, `pr-feedback-on-own-pr`, `pr-review-interrogation` and `runtime-symptom-investigation` are unwrapped (whitespace only), then their wrapped blockquotes are joined and 26 compounds that the old wrapping split at a hyphen are repaired. The strict hard-wrap contract and a new split-hyphen check cover every unwrapped skill.
- **Docs.** `lesson-capture`, `docs/agent-files.md` and the README stop describing an invariants block. `directory-structure` shows `$DESK/AGENTS.md` and the optional `$DESK/_meta/operator-rules.md`.
- **Ponytail.** `desk.activation.json` no longer declares `ponytail-upstream`, and the Copilot bundle producer has no Ponytail branch; a manifest with no explicit selection builds the three-root closure.
- **Checks.** `validate-skills` treats caret prerelease ranges like npm semver (`^1.0.0-alpha.2` admits `1.0.0`). The Codex cache-audit fixtures use real Superpowers and Crew versions. The restated-rule check lives once, in `test-desk-contracts`, and now also covers the Codex golden block. Commit constants that stay in code are labelled as provenance evidence.
- **Evaluations.** `engineering-v2-kernel` and `investigation-boundaries` are re-recorded with new fingerprints; only whitespace, spelling, the adapter's name and the frozen wording changed in their sources.
- **Versions.** Plain Language `0.2.4` → `0.2.5` (its hook shares one contract loader between Claude and Copilot, with byte-identical output) everywhere it is recorded, including the regenerated Copilot bundle.

## 3.2.0-alpha.17 — 2026-09-25

The three worker bodies now carry only identity and context, and the Claude output style is deleted. Every rule the bodies restated already has one owner, so each rule now loads once. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

- **Worker bodies.** `agents/worker.md` (Claude), `agents/worker.agent.md` (Copilot) and `agents/worker.toml` (Codex) keep their frontmatter, the line that says the host injects `using-desk` once, the identity and desk paragraphs, the `$DESK` binding (`desk_status` reports the bound root), operator preferences, "Tell me what you want to work on" and the overlays paragraph. The three share that text word for word. Each is now about 3 KB, down from 10 to 16 KB.
- **What left the bodies.** The invariants block, the skills tables and the lifecycle line. Each rule stays with its owner: `using-desk` (method entry, one decision group, authority and permissions, durable context, commit and push, asking only when blocked), `session-start` (prerequisites and the Desk MCP health guard), `interaction-style` (slugs, announced parallel work), `session-resumption` and `task-lifecycle` (bounded processes and delivery), `friction-management`, `using-superpowers-with-desk` (prior approval), `evidence-discipline` (primary sources, fixtures or refusal) and Plain Language (plain output, leading with the answer, no hard wraps). The bodies no longer name the retired `desk:superpowers-integration` or a frozen candidate.
- **Output style deleted.** `output-styles/worker.md` duplicated the body and the startup hook, and on Claude it loaded on top of the worker agent. A headless Claude session with and without it showed the same main-thread prompt: the worker body as identity, with no Claude Code coding-instruction sections either way, so nothing was lost. `outputStyles` leaves `.claude-plugin/plugin.json` and the Claude `nativeSurfaces` list.
- **Tests.** A contract test keeps the bodies identity-only and identical across hosts. The recovery, health-guard, content-routing and method-selection tests now read the owning skills and assert the bodies do not restate them. The host-manifest check fails if the output style returns.

## 3.2.0-alpha.16 — 2026-09-25

Deletes `principles.md`. Agents were told to open it by a path they could not resolve, and it repeated rules that `using-desk` now owns. Each of its rules now lives in one place: always-on essentials stay in `using-desk`, and each procedure moves into the skill that runs it. Ships `desk-mcp@1.4.0-alpha.6` source; the MCP version and runtime packs are unchanged.

- **Where the rules went.**
  - `interaction-style`: return-control anti-patterns, "Respond before editing", "No phantom limits", starting announced parallel work in the same message, and a table that maps a host's memory, plan, task, review and autopilot commands to the desk.
  - `evidence-discipline`: "Primary sources before recommendations", "Evidence precedence" by kind of claim, and "Answer the governing question". Its description now triggers for any recommendation or claim that depends on external or mutable facts.
  - `session-resumption`: the protected-evidence boundary (private or sensitive operational evidence stays outside Git; the desk keeps only pointers and non-sensitive summaries) and verified resource exhaustion.
  - `operator-voice-comments`: anything sent or scheduled in the operator's name, including email and calendar invitations, needs the operator's approval of the exact audience and content; a go on the work is not approval to send.
  - `preflight-actions`: requests to widen the agent's permissions or stop prompts. The operator applies the change; the agent never edits its own permissions or retries after a denial.
  - `git-hygiene`: operator authorship over repository conventions, the Copilot attribution variants, and lean diffs. It drops frozen-ref wording for the channel rule (a commit hash is evidence only), and its prose is unwrapped.
  - `work-orchestration`: "Align new work before go". Review runs on the candidate branch with the reviewed head recorded as evidence, not on a frozen candidate.
  - `curator`, `content-routing`, `lesson-capture`, `friction-management` and `repo-handling` take no-defer, gate removal, callable-back artifacts, process shape, logging what the operator teaches, and read-only rules for other people's repositories.
  - Plain Language `0.2.4` owns the no-hard-wrap rule.
- **Rules that now agree.** `preflight-actions` no longer waives send approval: its "no further permission loop" covers only actions in the agent's own role, and anything sent in the operator's name still goes through `operator-voice-comments`. `git-hygiene`'s fetch-first steps apply only to checkouts the task owns; other people's clones are read without mutating them, as `repo-handling` says. Both skills state that rule in identical words, with one exception: the operator's explicit instruction to update a specific clone.
- **Unwrapped prose.** `curator`, `friction-management`, `preflight-actions`, `repo-handling` and `session-resumption` are unwrapped (whitespace only). A contract test keeps every fully unwrapped skill touched here that way, and flags an edited line inside an older wrapped paragraph in the rest.
- **Foundation.** `using-desk` gains one clause: private or sensitive operational evidence stays outside Git, with only pointers in the desk.
- **Evaluations.** `engineering-v2-kernel` and `investigation-boundaries` now list the new owners as sources in place of `principles.md`, re-reviewed with new fingerprints.
- **Versions.** Plain Language `0.2.3` → `0.2.4` everywhere it is recorded, including the regenerated Copilot bundle.

## 3.2.0-alpha.15 — 2026-09-24

Rewrites `using-desk`, the Desk foundation every session loads, and gives every startup the RFC's installed path. Ships `desk-mcp@1.4.0-alpha.6` source with the changes below; the MCP version and runtime packs are unchanged.

- **New foundation.** `using-desk` now has thirteen one-line sections that say only how the human and the agent work together: the agent never hands the human a step it could do itself; alignment, then ownership, with work continuing while a question is pending; agent-facing coaching of the collaboration; verb-scoped authority, where access is not ownership and an explicit no-write instruction wins; waste judgment that never drops proof; channels, never commits; durable context in the desk; child agents; and the RFC. It matches the RFC's terms (job, task, outcome, channel) and no longer mentions frozen candidates.
- **RFC line.** The Claude and Copilot startup hooks and the Codex activation instructions add `Desk RFC: <installed path>` after the foundation, so the agent can open the RFC from any repository. The Copilot hook computes the path; it still reads only the foundation.
- **Startup line never names a root Desk will not use.** Both hooks build the `Desk startup:` line from one shared module, `mcp/src/util/startup-direction.js`, and say where the root came from (the project folder, the saved binding, `$DESK` or a home-folder fallback). On Claude the Desk server also takes `CLAUDE_PROJECT_DIR`, so the line names the one root. On Copilot the plain Desk server gets no session folder, so when the session folder (hook input `cwd`, else the process folder) is a desk that plain Desk would not bind, the line names both roots, says an overlay launched in that folder binds it, and says `desk_status` reports the root actually bound and wins. An unreadable saved binding is reported as unreadable instead of as setup mode, and a hook that cannot run the resolver says so. The Claude RFC line keeps backslash separators for a Windows plugin root.

## 3.2.0-alpha.14 — 2026-09-24

Bumps the pinned Plain Language dependency to `0.2.3` everywhere it is recorded (both `plugin.json` variants, the Codex manifest, `activation/desk.activation.json`, and the regenerated `activation/copilot-root.flattened-bundle.json`), so a Copilot session picks up Plain Language's new Copilot `sessionStart` hook. The Desk MCP stays at `desk-mcp@1.4.0-alpha.6`; its source and runtime packs are unchanged.

## 3.2.0-alpha.13 — 2026-09-24

Carries the move migration from the final `ouroboros-skills` release, so a session on either side knows about the move. The Desk MCP stays at `desk-mcp@1.4.0-alpha.6`; its source and runtime packs are unchanged.

- **Move migration.** `migrations/01-move-to-ourostack-desk.md` is the same file that `ouroboros-skills` Desk `3.2.0-alpha.10.1` ships.
  - When it fires: only for a V2 install on the old channel, meaning `desk@ouroboros-skills` from a marketplace that tracks `v2-alpha` (even when `desk@ourostack` is already installed), or an `agency.toml` entry `github:ourostack/ouroboros-skills:plugins/<desk|superpowers|plain-language|crew>@v2-alpha`. It stays silent for installs from this repository and for V1 installs.
  - What it moves: it reinstalls Desk, its companions and Crew from `@ourostack` with automatic updates on, and carries the desk binding over. It rewrites only the `@v2-alpha` Agency coordinates and keeps a one-time backup.
  - What it keeps: it never removes an old companion that a remaining V1 plugin, such as Work Suite, depends on, and it tells the operator how to remove those later. It always removes the old Desk.
- **Migration format.** `session-start-migrations` now states the format consistently: Detect, Safety check and Migrate each hold one fenced bash block, and Announce is plain text. The driver shows Migrate's report of what it changed on this machine before Announce.
- **Migration harness.** `scripts/test-desk-migrations.cjs` runs every Desk migration against a fake `claude` on `PATH` that models installed manifests and marketplace-scoped dependency errors and can fail chosen commands, with temporary `HOME`, `CLAUDE_CONFIG_DIR` and `AGENCY_TOML`, across first runs, reruns, failures, Work Suite users and V1 installs. It also checks that the startup hooks here never tell users to move. CI runs it in Validate skills.

## 3.2.0-alpha.12 — 2026-09-24

Rewrites the Agentic Engineering V2 RFC as the evergreen north star: the three acts and Agent Experience, the human and agent working relationship with agent-led coaching, layered foundations, the factory (measuring and designing the work), channels never commits, and a status section that separates what works today from what is being built. The Desk MCP stays at `desk-mcp@1.4.0-alpha.6`; its source and runtime packs are unchanged.

## 3.2.0-alpha.11 — 2026-09-24

Desk now lives in its own repository, `ourostack/desk`, with its companions Superpowers, Plain Language and Crew. The Desk MCP stays at `desk-mcp@1.4.0-alpha.6`; its source and runtime packs are unchanged.

- **New home and marketplace.** The marketplace is named `ourostack`, so the plugin IDs are `desk@ourostack`, `superpowers@ourostack`, `plain-language@ourostack` and `crew@ourostack`. Install with `claude plugin marketplace add ourostack/desk`. The Claude binding file moves with the marketplace name to `plugins/data/desk-ourostack/desk.activation.json`.
- **Channel is `main`.** Agency dependencies track `github:ourostack/desk:plugins/<name>@main`, and the dependency checker reports any `ouroboros-skills` coordinate as moved to `ourostack/desk`.
- **Dependency ranges.** Desk requires Superpowers `^6.3.0` and Plain Language `^0.2.2` instead of exact versions, so a compatible companion release no longer needs a Desk release.
- **Only the V2 plugins.** Work Suite, Ponytail, the loose skill catalog and their checks stay in `ourostack/ouroboros-skills`. CI now also runs the browser context broker's own tests, and `scripts/test-desk-contracts.cjs` keeps the content contracts for Desk's own skills and worker surfaces that used to live in the Work Suite contract script.

## 3.2.0-alpha.10 — 2026-09-24

Brings the claims-based browser context broker and bounded validation artifacts from main. The Desk MCP stays at `desk-mcp@1.4.0-alpha.6`; its source and runtime packs are unchanged.

- **Browser context broker.** The `browser-context-broker` package (from main's Desk 3.2.0, #226 and #227) ships under `plugins/desk/browser-context-broker/`. It hands each caller a lease on a matching headed browser context, exposes only the lease's own targets through an authenticated CDP proxy, and recovers or cleans up stale leases without touching other callers' targets. `cdp-headed-browser` now routes acquisition, proxying, status, doctor and release through the broker, and the docs validator enforces that routing.
- **Bounded validation artifacts.** `git-hygiene` treats coverage and fully instrumented builds as exact-SHA final-candidate gates, and `work-doer` bounds disposable validation artifacts: copy proved outputs to a commit-addressed path, then delete test-owned build roots, containers and images (from main, #215).

## 3.2.0-alpha.9 — 2026-09-24

Overlays get the same friction-free first run. Ships `desk-mcp@1.4.0-alpha.6` source with the change below; the MCP version and runtime packs are unchanged.

- **Overlay onboarding.** An overlay that owns its workspace root launches the Desk MCP with `--onboarding <skill>` (and optionally `--onboarding-reason`) when it cannot resolve one. Desk starts in setup mode on that path, skipping home fallbacks that belong to other desks, and `desk_status` reports `onboarding_skill` and `reason_detail`. The startup hooks, `session-start`, `first-run-bootstrap` and the worker guards route to the named path, such as `crew:join-crew`, instead of solo bootstrap.
- **Dependencies track channels.** `git-hygiene` states that plugin dependency declarations track their release channel branch (such as `@v2-alpha`) from the canonical repository, never an exact commit or a fork, and `scripts/check-dependency-channels.cjs` enforces it in CI.
- **Setup handles Node.** `SETUP.md` has the agent install a supported Node or switch the default itself, involving the operator only for something only they can do.

## 3.2.0-alpha.8 — 2026-09-24

Setup no longer ends at "Desk MCP is unavailable". Ships `desk-mcp@1.4.0-alpha.6` source with the changes below; the MCP version and its runtime dependency packs are unchanged because the packs carry only third-party dependencies.

- **Setup mode instead of an exit.** With no desk bound, the Desk MCP stays up and `desk_status`/`desk_doctor` report `mode: setup`, the paths tried, the binding file and the next step, instead of the server exiting.
- **Claude binds the right desk.** A session opened in a desk binds that desk (`CLAUDE_PROJECT_DIR`, only when it has the desk shape); otherwise the binding saved at `$CLAUDE_PLUGIN_DATA/desk.activation.json`, which survives plugin updates. Explicit, host-session, activation, `$DESK` and home fallbacks keep their precedence.
- **Hooks agree with the server.** The Claude and Copilot startup hooks use the server's own root resolver, route a missing desk straight to `first-run-bootstrap`, and the Claude hook re-injects the foundation after compaction.
- **Onboarding looks before it asks.** Bootstrap Entrance A scans for existing local desks, discovers the operator's desk repository with `gh`, asks once with what it found, offers a fresh desk when nothing exists, and saves the binding. A real MCP outage is repaired first; continuing without Desk is the last resort.
- **One-link setup.** `SETUP.md` is written for the agent: give it the link and say "set this up". Desk ships `desk:worker` as Claude's default agent.
- **Durable context and attribution.** The foundation states on every host that durable context lives in the desk and that no AI attribution is added to commits, pull requests, comments or documents.

## 3.2.0-alpha.7 — 2026-09-21

**Public V2 foundation/onboarding source candidate: one RFC, one concise always-on Desk foundation, one authoritative startup scan, and exactly two blessed onboarding paths.** Desk now publishes a public Agentic Engineering V2 RFC, reduces the always-on Desk body to concise `using-desk` foundation clauses, keeps Claude/Copilot/Codex startup ownership lightweight and exact-once, and leaves the authoritative migration, sync, task discovery, and resumption scan in `desk:session-start` instead of duplicating partial startup scans. The source contract now makes source authority explicit before work begins, keeps material mid-execution requirements on the same durable task with updated evidence and review gates, requires stage-local visual proof when it helps, clarifies flow and delegation judgment, strengthens instruction coherence, and tightens safe dirty-state reconciliation. Onboarding now blesses exactly two public entry paths: Path 1 starts or upgrades the same Desk in place, including the executable V1-to-V2 upgrade entrance, and Path 2 begins with repository-first Crew-v1 migration before any member activation or join.

Desk `3.2.0-alpha.7` continues to couple to `desk-mcp@1.4.0-alpha.6`. This remains opt-in, source-candidate work on `v2-alpha`; installed-consumer qualification and native runtime qualification remain separate, and this release makes no default-installation change or production-support claim.

## 3.2.0-alpha.6 — 2026-09-20

**Lexical-first alpha: correct lexical answers during startup and file changes, with fresh direct reads when index readiness is uncertain.** This candidate packages the [reviewed lexical milestone](https://github.com/ourostack/ouroboros-skills/commit/0eb9ea139a997c5c39394ac7b95ab02bff7331b5): durable journal/restart behavior, one index writer, and vector cleanup that leaves zero orphan vectors. Uncertain readiness falls back to current source files rather than serving stale indexed answers.

Desk `3.2.0-alpha.6` couples to `desk-mcp@1.4.0-alpha.6`. Windows readiness journals are protected in a private staging directory before atomic publication, so an interrupted host startup cannot strand an unprotected final journal directory and block lexical convergence on the next launch. Release metadata and generated source-scope anchors are refreshed. All three runtime dependency packs reuse byte-identical, previously native-verified alpha.5 dependency payloads; their manifests record the source archive and native-verification provenance. Repackaging is not fresh native execution or cross-platform qualification.

**Known limits:** semantic scheduling and transactional recovery are not qualified in this alpha. Repeated tombstone-policy changes fail closed but may surface as a generic error rather than typed `readiness_changed_during_read`. This remains an opt-in candidate, not a qualified V1 replacement, publication, or downstream installation change.

## 3.2.0-alpha.5 — 2026-09-18

**Opt-in dogfood alpha for bounded work design, with deterministic one-ruling semantics and no lifecycle takeover.** Desk now records an exact-file/directory scope envelope and the four convergence controls around Superpowers: declared architecture expansion, write-set escape, stalled findings without new learning, and repeated boundary rejection after three failed cycles at the same boundary. Each cycle keeps the full trigger evidence, but one canonical primary trigger yields one ruling per cycle; the ruling stays model-owned, unresolved pivots block the next cycle, and Superpowers remains the engineering lifecycle owner.

Desk `3.2.0-alpha.5` couples to `desk-mcp@1.4.0-alpha.5`. Legacy discriminator compatibility is read-time only: old shapes are canonicalized for comparison without rewriting stored history. This remains an opt-in dogfood alpha for the source surface and does not replace Superpowers as lifecycle owner. Cross-platform `1.4.0-alpha.5` runtime packs are a separate native-build publication boundary and are not included in this source-surface commit.

## 3.2.0-alpha.4 — 2026-09-15

**The fully assembled generic alpha candidate, published as a dogfoodable source milestone rather than a qualified alpha.** Standalone Desk now selects exactly three roots — Desk, Superpowers and Plain Language. Ponytail and Work Suite are no longer selected for the standalone composition, and no private feedback API ships; the legacy four-root closure survives only for a manifest that declares no selection at all. Acquisition stays ordinary and single-root: `plugins/desk/agency.json` declares the two generic dependencies at `@v2-alpha`, and Agency branch tracking is the update path, so this release adds no installer, refresh command or rollback channel.

Desk `3.2.0-alpha.4` couples to `desk-mcp@1.4.0-alpha.4` and Plain Language `0.2.1`. Plain Language now requires a reader-facing name before any internal identifier, and the engineering seam plans the smallest coherent usable milestone while keeping later qualification visible. `desk:using-superpowers-with-desk` is the active adapter; `desk:superpowers-integration` remains only as a compatibility redirect. Work profiles carry typed action evidence, and the public relevant-revision workflow publishes status read-only, with no model or credential, so the current head stays `pending` until compatible evidence returns.

Generated activation, the flattened Copilot bundle, Codex activation fixtures, host support matrices and the reviewed-source kernel fingerprint were regenerated once from their existing producers for this candidate. All three runtime packs ship for this version, each produced on the platform and Node ABI it claims: macOS ARM64 on Node ABI 127 from the maintainer's host, Linux x64 on Node 22.23.2 (ABI 127) and Windows x64 on Node 24.18.0 (ABI 137) from their own native runners, which load each pack's native code before publishing it. Generated-artifact verification covers all three. Native runtime qualification, consumer-composition qualification and the alpha's own evaluation stay pending.

`content-routing` now treats the product repository as a first-class home. Product behavior, interfaces, installation contracts, defaults, compatibility promises and release rules belong in that repository's source, documentation and executable tests. Workspace and plugin routing happens only after that product-contract check.

## 3.2.0-alpha.3 — 2026-09-09

**Opt-in Superpowers source candidate, not a default installation change or native-admission claim.** Desk selects pinned Superpowers 6.3.0 as the sole engineering method. Desk/Crew retain state, existing approvals, delegation limits and intentional alpha/PR-only delivery boundaries. The independent-review contract makes RoboRev a first-class host-provided reviewer with one implementation owner for remediation and re-review. Work Suite remains available as a legacy standalone provider.

Desk `3.2.0-alpha.3` couples to `desk-mcp@1.4.0-alpha.3`, current activation metadata and generated host fixtures. The read-only context adapter requires existing canonical task, plan and doing files; no-create path resolution preserves its default write behavior, and the existing segment validator is exported unchanged. Copilot uses the authored hook adapter while pristine upstream hooks and all selected skill payloads retain their lock hashes.

The Darwin and Windows runtime dependency targets are repackaged for the candidate. Linux x64 on Node ABI 127 is also included from the existing [native Linux CI build](https://github.com/ourostack/ouroboros-skills/actions/runs/34444276591), and generated-artifact verification now requires all three targets. The Windows dependency payload is reused with verified provenance, not executed on this Mac. Approved public vector/snapshot payloads remain byte-identical while current source metadata is re-anchored. Historical preview results and runtime limitations remain historical; full native and consumer-composition qualification is separate.

## 3.2.0-alpha.2 — 2026-09-08

**The second opt-in preview fixes two native Windows failures without changing the Work Suite method.** The ACL provider constrains its Windows PowerShell child's module search to that provider's system modules, avoiding incompatible PowerShell Core modules inherited from the host. Canonical LF text checkouts preserve the bytes used by runtime-lock and source fingerprints; binary files remain binary. The temporary CI diagnostic is removed, and the native Windows job also validates source-bound evaluation contracts.

Desk `3.2.0-alpha.2` and `desk-mcp@1.4.0-alpha.2` couple the repairs to regenerated activation files, runtime support metadata and offline packs. Both packs reuse the verified native binary bytes and unchanged production dependency closure. Vector and snapshot payloads remain byte-identical; their metadata was regenerated because its source scope includes the MCP package identity. No new embedding request was made. [Native Windows CI](https://github.com/ourostack/ouroboros-skills/actions/runs/34266621708) now passes real NTFS protection, feedback CRUD/reopen and offline source-mirror attribution; full Windows CLI adoption remains a separate scope. Work Suite `4.0.0-alpha.1`, Plain Language `0.2.0` and Ponytail `4.9.0` stay pinned; existing installations are not switched automatically.

## 3.2.0-alpha.1 — 2026-09-08

**Agentic Engineering V2 is an opt-in executable RFC, not a main-channel promotion.** Work Suite `4.0.0-alpha.1` requires substantive alignment and explicit go before new implementation, resumes approved work without another approval round, and ends at the agreed delivery boundary. Primary outcome and counterexample evidence replace a universal coverage percentage without weakening repository-required coverage, test-first execution, or independent review. A permanent three-case kernel covers alignment, complete local delivery, and source-backed status. Desk adds explicit private preview-feedback capture, inspection, correction, and deletion, with separately confirmed sharing, plus a minimal local-on-demand diagnostic snapshot. Desk moves to `3.2.0-alpha.1` and `desk-mcp@1.4.0-alpha.1`; Plain Language `0.2.0` and Ponytail `4.9.0` remain pinned. Existing installations are not switched automatically.

## 3.1.2 — 2026-09-07

**Lesson and friction filenames now preserve Unicode text without filesystem-dependent collisions.** The shared slug helper uses pinned Unicode 16 character categories, standards-based full case folding, pinned Unicode 17 canonical normalization, attached combining marks, and Unicode letters and numbers while replacing path separators and punctuation with `-`; Windows-reserved device basenames are prefixed safely on every platform. Existing pre-1.3.4 lesson files are reused only when their heading proves the same normalized topic, verified legacy device-name files are moved to the canonical safe path before appending, and track-local friction uses an identity marker plus an underscore collision namespace so unverified legacy files remain separate. Existing ASCII and punctuation-only behavior remains unchanged. Redistributed normalization and case-folding code carries its required MIT notices. Unreachable `gray-matter` fallbacks were removed under characterization so the changed runtime stays fully covered. Desk moves to 3.1.2 and `desk-mcp@1.3.4`; Work Suite v3.0.0, Plain Language v0.2.0, and Ponytail v4.9.0 remain unchanged.

## 3.1.1 — 2026-09-02

**CDP-attached browser automation now preserves the operator's foreground application.** New pages use background `Target.createTarget` targets; `/json/new`, `/json/activate`, `Target.activateTarget`, and `page.bringToFront()` are forbidden during unattended work; direct APIs remain preferred when they cover the task. `desk-mcp@1.3.3`, Work Suite v3.0.0, Plain Language v0.2.0, and Ponytail v4.9.0 remain unchanged.

## 3.1.0 — 2026-08-27

**Humanize is now available to every Desk consumer as a triggered editorial capability.** Humanize refines prose toward a more natural editorial voice; Plain Language remains the separate always-on policy for making information findable, understandable, usable, and precise. Plain Language keeps its own plugin because it has independent activation and is consumed by both Desk and Work Suite. Humanize has no independent host policy, so its standalone catalog export is removed and Desk becomes its distribution boundary. `desk-mcp@1.3.3`, Work Suite v3.0.0, Plain Language v0.2.0, and Ponytail v4.9.0 remain unchanged.

## 3.0.0 — 2026-08-26

**Align Desk with Work Suite 3.** Desk's Claude, Codex, and Copilot activation metadata now lock Work Suite 3.0.0, including the Claude `^3.0.0` dependency range. Work Orchestration verifies authority before mutation, validates explicit cross-repo dependency graphs, isolates parallel worktrees, coordinates shared version files, and leaves task/iteration lifecycle state to Desk. `desk-mcp@1.3.3`, Plain Language v0.2.0, and Ponytail v4.9.0 remain unchanged.

## 2.1.3 — 2026-08-26

**First-person future language now keeps live-action ownership with the operator.** Statements such as "I'll send it" or "I'll share it" authorize preparation at most; worker sends or posts only when the operator explicitly delegates that action. `desk-mcp@1.3.3` remains unchanged.

## 2.1.2 — 2026-08-25

**Plain Language is now a substantive first-party output policy.** The standalone plugin keeps one skill source plus its parent/subagent hook, removes unused upstream snapshots and maintenance, and adds concrete rules for replies, work reports, documents, meaning preservation, and pre-send review. Plain Language moves to 0.2.0 and Work Suite to 2.1.2. `desk-mcp@1.3.3` remains unchanged.

## 2.1.1 — 2026-08-25

**Plain Language now contains only the output contract agents need at runtime.** Source provenance, legal positioning, scoring commentary, and internal skill-precedence names no longer consume prompt space; the contract states the reader outcomes, meaning-preservation floor, and destination-appropriate voice directly. Plain Language moves to 0.1.1 and Work Suite to 2.1.1. `desk-mcp@1.3.3` remains unchanged.

## 2.1.0 — 2026-08-25

**Upstream source checks are now read-only, identity-verified, and approval-safe.** The steward tracks the latest non-stale release or default branch for every public source, verifies repository identity, license, forward ancestry, and selected-file hashes, and reports exact candidate digests. Selected instruction or executable changes stop at `needs-human-approval`; API, auth, rate-limit, identity, and ancestry failures stop as `blocked`. `desk-mcp@1.3.3` remains unchanged.

## 2.0.0 — 2026-08-25

**Workers now load upstream Ponytail for coding and use a direct Work Suite 2 workflow.** Clear tasks skip ideation and planning, implementation proof follows risk instead of ritual, review runs once at the branch boundary, and merge remains responsible for release or install refresh, smoke, cleanup, and continuation. Plain Language remains authoritative for human-readable output. `desk-mcp@1.3.3` remains unchanged.

## 1.8.0 — 2026-08-24

**Human-readable worker output now carries a first-class Plain Language dependency.** The new `plain-language` 0.1.0 plugin supplies concise reader-centered guidance, a native Claude parent/subagent hook, and generated host fallbacks while preserving facts, evidence state, uncertainty, attribution, safety, accessibility, technical precision, schemas, exact source content, and existing Desk voice rules. Work Suite moves to 1.6.0 to consume the same dependency. `desk-mcp@1.3.3` remains unchanged.

## 1.7.19 — 2026-08-18

**Windows Copilot hosts now receive a native Desk runtime pack.** The release includes the production dependency closure for Windows x64 on Node ABI 137, including loadable `better-sqlite3` and `sqlite-vec` binaries, and the generated support matrix advertises that exact target. Generated-artifact validation now requires the Windows pack alongside the existing macOS pack, preventing future releases from silently returning canonical Desk to diagnostic mode. `desk-mcp@1.3.3` remains unchanged.

## 1.7.18 — 2026-08-18

**Claude, Codex, and Agency now launch Desk from the installed plugin root.** The shared `.mcp.json` uses a portable Node bootstrap: Claude and Agency provide the installed root through `${CLAUDE_PLUGIN_ROOT}`, while Codex resolves the declared working directory against the plugin root. This permanently removes the Windows startup failure even when Agency loads the shared manifest, without breaking Codex's host-native plugin path. The dedicated Copilot manifest remains unchanged. `desk-mcp@1.3.3` remains unchanged.

## 1.7.17 — 2026-08-18

**Copilot now launches Desk from the installed plugin root on every platform.** The Copilot root manifest uses a dedicated MCP declaration with `${COPILOT_PLUGIN_ROOT}`, avoiding the process-working-directory ambiguity that made `desk` fail on Windows while a workspace-level duplicate appeared healthy. Claude, Codex, Ouroboros, and generic stdio consumers keep the host-neutral `.mcp.json` contract. `desk-mcp@1.3.3` remains unchanged.

**Authored prose now has an always-on no-hard-wrap invariant.** Desk workers must keep each Markdown paragraph, list item, blockquote, message, task card paragraph, commit body paragraph, and PR body paragraph on one physical line, using newlines only for genuine structure or source-preserved semantic breaks. A fail-closed finishing check joins column-wrap continuation lines only in prose authored or changed by the current task, avoiding brittle rewrites of third-party or historical source. The contract is repeated across the shared principles, Claude agent and output-style surfaces, Copilot agent, Codex subagent, and activation-owned Codex default instructions so downstream overlays inherit it. Host-manifest validation now fails when any boot surface drifts. `desk-mcp@1.3.3` remains unchanged.

## 1.7.16 — 2026-07-22

**Persistent MCP configuration now treats startup availability as part of the contract.** `add-workspace-mcp` classifies every frontmatter or auto-loaded workspace MCP as boot-critical: persist only when it can initialize truthfully everywhere the agent is expected to launch, keep conditionally available services behind explicit one-off activation, and never disguise authentication, authorization, or protocol failures as success. Launch verification now proves first-prompt readiness and checks the full output for repeated initialization failures instead of stopping at a successful config parse. MCP remains `desk-mcp@1.3.3`.

## 1.7.15 — 2026-07-22

**Research-backed recommendations now start from primary evidence.** A new always-on substrate invariant requires workers to verify load-bearing claims against reasonably available first-party sources, keep verified facts, evidence-based inferences, unknowns, and decisions distinct, and continue reading and synthesizing instead of returning control while a material primary-source thread remains open. The rule is repeated across every worker boot surface so it stays active across Claude Code, GitHub Copilot CLI, Codex, and every overlay that inherits Desk. `desk-mcp@1.3.3` remains unchanged.

## 1.7.14 — 2026-07-22

**Diagnostic mode now reports the installed Desk MCP version.** The dependency-light entrypoint reads package metadata before any degraded path and passes that version through every diagnostic launch, so hosts see the real `desk-mcp@1.3.3` identity instead of `0.0.0`. Invalid or unavailable package metadata still falls back safely without turning diagnostics into another startup failure.

## 1.7.13 — 2026-07-21

**Person-scoped Desk writes now fail closed at the filesystem boundary.** All seven task, track, friction, and lesson mutations share one segment-validation and realpath-confinement resolver, so hostile path segments, broken links, and symlinks escaping the authenticated person's subtree are rejected while repo-wide reads remain available. Task archive additionally models the complete post-relocation symlink chain before and after rename, preserving safe internal links while rejecting retargeting, cycles, source-directory aliases, and destinations nested inside the source. MCP bumped to `desk-mcp@1.3.2`.

**First boot now repairs itself offline or stays diagnosable.** Desk validates committed runtime support truth before loading production dependencies, atomically restores native runtime packs and source mirrors into a writable cache, and performs one guarded stdio-preserving handoff when a compatible local Node is available. When recovery is impossible, a dependency-free diagnostic MCP keeps `desk_status` and the new `desk_doctor` live while all mutation tools fail closed with actionable remediation instead of crashing the host.

## 1.7.12 — 2026-07-20

**Peer PR review now has an entrypoint-first teaching mode.** When the operator is unfamiliar with the
repo and wants to learn while reviewing, the walkthrough follows the runtime request from the external
boundary through dispatch, scenario/tool construction, and downstream workflows before applying the
diff. Findings remain private until the operator reaches the code and forms judgment; approved comments
may then post during the walkthrough.

## 1.7.11 — 2026-07-20

**Authorization now includes an ownership axis.** Explicit action
mandates remain full-send on worker/operator-owned surfaces and
established contribution or delegation paths. Technical access no
longer implies authority to mutate a partner-operated live surface
outside its owners' SOP or operating path.

**Autopilot preserves collaboration boundaries.** Work Suite 1.5.4
keeps broad, reversible mandates autonomous without treating broad
authority as ownership of another team's live operational state.

## 1.7.10 — 2026-07-16

**Explicit no-write instructions now override proactive capture.** Investigation mandates still permit
normal durable routing when writes are allowed, but *do not edit / do not write / leave the workspace
unchanged* now blocks snapshots, notes, task updates, and other filesystem capture for that run. Work Suite
1.5.3 carries the same override in `deep-research`.

## 1.7.9 — 2026-07-16

**Authorization now follows the operator's verb.** Investigation, research, read, and mapping mandates are
explicitly read-only with respect to live/shared state: a capability finding is evidence, not an instruction
to send, apply, deploy, publish, file, merge, or change configuration. The default worker summaries,
`interaction-style`, and `preflight-actions` now share that boundary while preserving autonomous continuation
inside explicit do/fix/ship mandates.

**Deep research keeps the governing question in view.** Work Suite 1.5.2 adds question fidelity: counterfactual
and timeline questions are answered before adjacent workaround mechanics, and filed findings do not become an
agent action queue.

## 1.7.8 — 2026-07-09

**De-identify the public session-start registry example + dependency-ladder docs.** The `session-start` skill's `_meta/desks.md` example table and the README / activation dependency-ladder prose carried real internal identifiers in a public generic plugin -- a specific operator's account login, a private crew repo path, and vendor-specific framing ("Microsoft-flavored", "EMU", "MS crews"). Replaced with neutral placeholders (`alex` / `agarcia_corp`, `example-org/crew-workspace`, "org-backed crews / SSO login / org-flavored overlay"). Behavior-neutral -- the registry is read by session-start prose, not code. Also scrubbed a stray operator home-path from a committed `worker/tasks/` planning doc, and de-leaked the same operator identity from the historical 1.7.2 entry below. (The desk MCP test fixtures keep naming a concrete overlay as the reference example; that is deliberate fixture usage, not user-facing content.)

## 1.7.7 — 2026-07-09

**Codex implicit marketplace drift is now visible to the cache audit.** The Codex cache audit now checks the host's implicit `~/.agents/plugins/marketplace.json` when present, in addition to the repo marketplace and installed `~/.codex/plugins/cache` manifests. This catches the failure mode where a machine keeps installing Desk from an old `~/plugins` snapshot even though the repo source and cache-version checks look healthy. `desk:codex-onboarding` now prefers canonical repo-backed local marketplace paths for development installs, warns against durable unsupervised `~/plugins` snapshots, and tells agents to run the stricter audit before treating a repair as complete.

## 1.7.6 — 2026-07-09

**Oversized embedding chunks no longer abort the rest of a Desk reindex.** The Desk MCP indexer now treats Ollama context-length failures as chunk-local vector misses and continues embedding later chunks in the same batch. Known chunk-local failures are recorded as stable `chunk_embedding_failures` tombstones, so startup and search repairs do not repeatedly probe permanently oversized chunks. `desk_status` now separates known unembeddable skips from repairable missing vectors, and vector-pack import clears the tombstone when a shared embedding becomes available. No-op vector-pack repairs are remembered by a signature over the missing chunk identities and pack sidecars, so a pack that does not cover a known-unembeddable chunk is not revalidated on every search; changing the pack sidecars retries repair. This prevents one very large task card from leaving unrelated downstream documents without vectors after `desk_reindex --force`; only the oversized chunk remains missing, while every embeddable chunk after it is indexed. Coverage now exercises the detailed embedding diagnostics, HTTP/JSON/timeout failure paths, endpoint normalization, vector-pack tombstone repair, no-op vector-pack retry suppression, malformed-status-table tolerance, and the vector rebuild behavior that keeps later chunks moving after an oversized input.

## 1.7.5 — 2026-07-08

**New `doc-review-rigor` skill.** Adds the generic doc-substance evaluation method to the desk plugin -- extract every reviewable claim from a document, classify each (blocking / should-fix / nit / open question), and surface them without ever auto-posting. Extracted from a crew-specific skill during a plugin-layering cleanup so the surface-agnostic method lives at the generic `desk` layer and overlays compose it with their own grounding.

**`content-routing` now gates a new skill's layer.** The `content-routing` skill gained a skill-placement section (the engine/skin test + the canonical-library/bundle mechanism) so it can answer "which layer does this belong in?" when a skill is first written. This shipped in the same plugin-layering cleanup and is documented here for completeness.

**Version-surface catch-up.** Both changes above landed without moving the version surfaces (CI stays green while every surface agrees at the old version, so the omission is invisible to CI). This release aligns every desk manifest, the activation lock, the regenerated copilot bundle, the codex activation fixtures, and the marketplace entry -- and carries the coupled `work-suite` dependency-lock bump to 1.5.1 (below).

## 1.7.4 — 2026-06-29

**Defensive top-level `tools:` allowlist on the `worker` agent.** Declared `tools: ["*"]` (unrestricted) on `agents/worker.md` so a recent Agency tool-visibility change — which strips any agent that declares an `mcp-servers:` block down to control tools (`skill`, `sql`, `task_complete`) unless it also carries a top-level `tools:` allowlist — cannot silently narrow the substrate base if it tightens further. The base `worker` declares no `mcp-servers:` block, so this is preventive, not a fix for a live regression. The Copilot (`worker.agent.md`) and Codex (`worker.toml`) renderings carry no tools-allowlist field and are unchanged.

## 1.7.3 — 2026-06-17

**Codex activation config is MCP-visible.** Global Codex activation now owns a `~/.codex/desk.activation.json` file alongside the generated `config.toml` and `AGENTS.md` blocks in the default Codex profile, and emits an owned top-level `mcp_servers.desk` bridge that passes that activation config to the bundled Desk MCP entrypoint. `desk_status` can report the selected activation target and overlay chain instead of only proving that a Desk root was found. Project-local Codex activation passes the same config explicitly with `--activation-config .codex/desk.activation.json`. The shared `.mcp.json` remains host-neutral (`["./mcp/index.js"]`) so Claude/Copilot plugin launches are not coupled to Codex paths.

**Workspace artifacts are first-class.** Runtime startup now checks `$DESK/artifacts/` before plugin-bundled release artifacts, so a shared Desk repo can commit document-side vector packs and warm-start snapshots for that repo. A fresh machine restores a compatible snapshot into local `.state/`, falls back to repo-local vector packs, and only generates document embeddings for uncovered chunks. Publication remains policy-gated through `artifacts/publication-policy.json`.

**Runtime source mirrors include artifact scripts.** The dependency-light MCP entrypoint now mirrors `scripts/` along with `src/`, package files, and `index.js`. Fresh Codex/stdio MCP launches can run vector-pack and snapshot import helpers from the source mirror instead of failing after dependencies restore.

## 1.7.2 — 2026-06-10

**Registry `identity` column — "which desk am I" matches identity, not a re-derived handle.** Fixes a shared-workspace foot-gun in the 1.7.0 `_meta/desks.md` schema: it described the `alias` as "derived from identity," which invites a consumer to *re-derive* a handle from the operator's identity each session (e.g. an SSO login minus an org suffix). But a chosen short handle need not be a transform of the identity (`agarcia_corp`'s desk is `alex`, not `agarcia`), so re-deriving silently binds a returning teammate to the **wrong desk** (a new empty `desks/<derived>/` instead of their real `desks/<chosen>/`). The schema now carries an explicit **`identity`** column and the "which desk am I" step matches on it — the registry is the source of truth for the identity→alias binding; a re-derived handle is only a *default* used to seed a brand-new row. Prose-only (the registry is read by session-start prose, not MCP code — no code surface); default-tolerant (single-OFF-mode desk needs no registry).

## 1.7.1 — 2026-06-10

**`_shared/` read-across indexing.** Completes the shared-workspace read-across promise: the indexer now indexes team-neutral docs under `_shared/` (e.g. `_shared/landscape/*.md`) so `desk_search` spans the whole crew brain — every agent reads all of `desks/*/` **and** `_shared/`, not just its own desk. `discover.js` (`isIndexable`/`classify`) accepts `_shared/**.md` as `kind=shared`; without this a crew member's search silently missed the shared facts the `shared-desk-conventions` skill promises are repo-wide. Behavior-preserving for single-desk workspaces (no `_shared/` dir → no new indexable docs, byte-identical). New classification branch covered 100%.

MCP bumped to `desk-mcp@1.3.1`.

## 1.7.0 — 2026-06-10

**`--person <alias>` write-prefix (default-OFF, behavior-preserving) + session-start registry awareness.** The first piece of the shared-workspace capability: one git repo, multiple operators, per-person write-scoping — with zero change for existing single-desk operators.

- **`--person <alias>` write-prefix on the desk MCP.** A new `personPrefix(deskRoot, person)` helper (`util/paths.js`) scopes a session's *writes* to `<root>/desks/<alias>/` while reads/search still span the whole repo. Threaded from `index.js` arg-parse (`--person <alias>`) through `callTool`/`startServer` to every write-path builder — `task_create`/`task_update`/`task_archive`, `track_create`/`track_update`, `friction_add` (both the track-local and the cross-cutting `_meta/friction.md` branches), and `lesson_add`. Returned `path` stays anchored at the real root, so it reads `desks/<alias>/…`. Alias validation rejects `..` and path separators; empty/whitespace is treated as null (OFF). **Default-OFF is byte-identical to today** — no `--person`, no `desks/` layer, the existing test suite stays green.
- **Indexer read-transparency.** `discover.js` `classify`/`isIndexable` strip a leading `desks/<alias>/` prefix so a doc at `desks/ari/<track>/<slug>/task.md` attributes to the real `<track>` (not `desks`) and `desks/<alias>/_meta/{friction.md,tips/*.md}` are still recognized. The recursive-by-filename walker already found nested docs; this fixes their *classification*.
- **`session-start` desk-registry awareness (prose).** Reads a committed `_meta/desks.md` registry when present — enumerates the desk-set, resolves "which desk am I" from the session's `--person` binding, and adds a crew-workspace banner to the status block. Documents the registry schema (`alias | path | repo | worker_variant | write_subtree`). Default-tolerant: no registry → single-desk, byte-identical to today.

MCP bumped to `desk-mcp@1.3.0`.

## 1.6.1 — 2026-06-02

**Two worker-discipline encodings.**

- **`principles.md` Invariant 8 — Durable-by-default.** Reusable artifacts the agent drafts that the operator might call back in a *future* session (a command, query, snippet, paste-ready draft) get persisted to the workspace **at draft time**, not left only in chat — chat is ephemeral across sessions, so a fresh agent would re-derive instead of retrieve. The test: *"would a fresh session be able to `grep` it?"*
- **`operator-voice-comments` — Match the operator's casing register.** Generalizes the existing "lowercase nit prefix" guidance: when an operator writes in a casual lowercase register, match it on *every* line (including **bold leads** + the first word after a period), and reserve normal capitalization for formal artifacts (docs, high-effort posts). The bold-lead slip is called out specifically.

## 1.6.0 — 2026-06-02

**Claude Code boots as the desk worker by default.** Codex gets the worker as its default via the `AGENTS.md` append; Claude Code previously only shipped the *selectable* `--agent desk:worker` sub-agent, so a fresh `claude` came up as the generic assistant rather than the worker. Two additions close that gap:

- **`output-styles/worker.md`** — the worker persona as a `force-for-plugin: true` output style, so it auto-activates for every session while `desk` is enabled (no manual `/output-style`). `keep-coding-instructions: true` layers it on top of Claude Code's built-in coding behavior instead of replacing it.
- **`hooks/hooks.json` + `hooks/session-start.sh`** — a fast, non-blocking `SessionStart` hook (matcher `startup|resume|clear`) that injects orientation: binds `$DESK`, scans open (non-terminal) task cards, and points at the `session-start` skill. Always exits 0 so it can never block a session.

Additive and engine-scoped — no change to existing `--agent desk:worker` invocations or to the Codex/Copilot default paths.

## 1.5.3 — 2026-06-02

**`fixtures-or-refusal` promoted to an always-on worker-body invariant.** The rule (don't emit a time / duration / cost / scope estimate without a historical fixture; inherited/relayed estimates count too) lived only in the description-gated `evidence-discipline` skill, so it wasn't in context during the general estimate-producing moments where it's most violated (planning docs, summaries, relayed plans). It's now a Core-invariants one-liner in all three worker-body variants (`worker.md`, `worker.agent.md`, `worker.toml`), pointing at `evidence-discipline` for the full rule. The body is the only always-on surface — `principles.md` is reviewed before-operating, not injected every turn — so the body is where an always-on guard belongs.

## 1.5.2 — 2026-06-01

**content-routing: the identity axis + an explicit overlay-instantiation handoff.** The substrate picture now names the work/personal **account axis** — desk instances split on the identity they authenticate as (an employer-managed vs a personal account), which is what decides which account a push lands under — not only on purpose. And the closing cross-reference is sharpened from one soft line into the explicit three-layer handoff: generic decision here → an overlay's companion skill names the concrete repos/accounts + cross-repo discipline → the workspace holds the operator-exact literals.

## 1.5.1 — 2026-06-01

**Wire the encode flows to `content-routing`.** `curator`, `friction-management`, and `lesson-capture` now reference the new `content-routing` skill for the home decision (workspace vs plugin, which plugin, always-on vs triggered) instead of restating it ad hoc. Also sweeps the last stale `plugins/worker/...` paths — `curator`'s `skills|repo-knowledge/...` disposition targets and `pr-self-review`'s `repo-knowledge/.../code-standards.md` rule source — to the generic `plugins/<plugin>/...` shape (the monolithic worker plugin was split into desk/work-suite + overlays).

## 1.5.0 — 2026-06-01

**New `content-routing` skill — where does durable content belong?** The decision tree for placing a rule/lesson/fact/preference: operator-specific → the workspace; general → a plugin (generic `desk`/`work-suite` if publishable, an overlay plugin if employer/context-specific); within a plugin, every-turn → the agent body / `principles.md`, fires-at-a-moment → a skill. Plus the substrate model (one generic plugin + overlays; multiple desk instances) and the self-check that keeps a general principle from being wedged into an operator's rules file under an "operator said X" framing (the mis-tag that makes it fail to fire). The encode flows (`curator`, `friction-management`, `lesson-capture`) consult it. Registered in worker.md.

## 1.4.9 — 2026-06-01

**`git-hygiene` targeted staging — never `git add -A` in a shared/multi-track workspace.** New pre-commit subsection: stage the explicit files your unit wrote, never `git add -A` / `git add .` from a workspace root, where parallel agents/tracks leave untracked state across directories — `-A` sweeps another track's in-flight file into your commit (message lies by omission; intentionally-untracked work frozen mid-thought). The prevention to the diff-scope scan's detection.

## 1.4.8 — 2026-06-01

**`cdp-headed-browser` send-safety — read the authoritative outbound layer before you send.** New section: a rich web editor keeps a model separate from the DOM, and pressing Send transmits the model — so DOM-injection (`execCommand`) + reading `innerText` to "verify" can send content the agent never saw. Hard rule: never send without reading the exact content that will transmit via the authoritative path, never a layer you just manipulated. Plus commit via real paste/keystroke not DOM-injection, don't use the shared OS clipboard as private staging when a human shares the machine, and surface the final text for confirmation before sending to real people.

## 1.4.7 — 2026-06-01

**Review/comment value-restraint (two friction encodes).** `peer-pr-review` Phase 7 gains two value-filters beyond the confidence check: validator-parrot (cut what an automated validator already flags) and landscape-gap-as-finding (verify the access/deployment model before flagging a "risk" that's really your own gap; if it checks out the disposition is "no finding," not "ask the author"). `operator-voice-comments` gains "Match the receiver's expertise — evidence-trail, not a tour": for a system-expert receiver, terse evidence-trail mode (cap at the load-bearing few, don't recreate surfaces they already have, don't invert the audience-asymmetry).

## 1.4.6 — 2026-06-01

**`pr-surface-hygiene` PSH-009 — one canonical body for human + agent readers; no agent-only formatting.** New rule (generalizes beyond PRs to bug reports / dashboards / runbooks / status posts): an artifact read by both humans and agents gets ONE canonical body, not a duplicated `## For your AI agent` block. Modern agents have large context + tool calls to fetch source, so an agent-only section is drift that reads like robot prose to humans. Use stable section headings + inline actionable data + collapsibles; a structured machine-readable sidecar as a separate attachment is the only sanctioned exception.

## 1.4.5 — 2026-06-01

**`runtime-symptom-investigation` — the control-plane view is not the inside ground-truth.** New section: when asking "is this system alive or wedged?", a control-plane / outside view (orchestrator status fields, cloud power/provisioning state, an is-it-running API) is hearsay — it can stick in a transitional value while the system runs fine. Find the authoritative *inside* signal (a heartbeat it writes, a health endpoint it serves) and check that first before any aggressive recovery; only a genuinely-stale inside signal justifies a restart. Source-of-truth variant of "Poll vs inspect."

## 1.4.4 — 2026-06-01

**`pr-surface-hygiene` PSH-008 — use the repo's PR template, not a custom structure.** Before opening a PR in any repo, probe for a PR-template file (`.github/PULL_REQUEST_TEMPLATE*`, repo-rooted, `/docs/`, or the platform's equivalent) AND pull the last 2–3 merged PRs to mirror the team's actual filled-in convention (recent merged PRs are ground truth; templates drift). Never invent a custom `## Problem` / `## What this PR does` structure when the repo has a template or convention — it reads as "wrong template" and gets bounced.

## 1.4.3 — 2026-06-01

**`interaction-style` §6 — fix the tooling, don't hand mechanical work to the operator.** New subsection: when the agent hits a tooling limitation mid-task, fix the tooling (reconfigure, relaunch, wrap, switch identity) rather than punt the manual step to the operator — the operator provides judgement, not hands. If it can't be fixed this session, capture friction + drive through whatever is automatable so the operator's step is one click. Slow tooling is the agent's problem too: "go slow / take your time" means invest more in correctness, never a license to punt.

## 1.4.2 — 2026-06-01

**`git-hygiene` — verify the merge landed before cleanup.** The "Clone hygiene" cleanup step now gates worktree/branch removal on a confirmed `gh pr view <id> --json state --jq .state == MERGED`, never chaining cleanup unconditionally after `gh pr merge`. A merge can fail (flipped auth identity, newly-required status check, race); cleanup that assumes success deletes the worktree + branch on a false premise. If the merge didn't land, nothing is lost — the commit is safe on the remote and the PR stays open.

## 1.4.1 — 2026-06-01

**`git-hygiene` clone-on-`main` + worktree discipline.** New section "Clone hygiene — `main` is the resting state; do work in worktrees": the canonical clone's resting state is `main`; each unit of work happens in a git worktree off `main` (not by checking out a branch in the shared clone); after merge, remove the worktree + delete the branch + `pull --ff-only` so the clone returns to a clean `main` with zero residue. Adds a "Verify before delete" subsection — a leftover branch is only safe to delete once `git diff origin/main..<branch> --stat` is empty; a non-empty diff means real unmerged work to drive to merge or preserve, never delete unexamined.

## 1.4.0 — 2026-06-01

**New Invariant 7 — gather all human judgement before beginning a task.** `principles.md` gains a seventh cross-cutting invariant: before starting a task, surface and resolve every decision that genuinely needs the principal's judgement up front, in one batch, rather than deferring to "I'll ask when I get there" — the asking-channel may be closed when you reach the fork, and entangled calls resolved late invalidate earlier work. Pairs with the execution-side `work-suite:autopilot` "act when authority is broad and the action is safe-and-reversible" rule. The intro's invariant count is corrected (five → seven; the stale "five" predated Invariant 6). No behavior change to the existing invariants.

Also reconciles a pre-existing version drift across the desk manifests (root `plugin.json` at 1.3.5, `.claude-plugin`/`.codex-plugin` at 1.3.4, marketplace entry at 1.3.3) — all now 1.4.0.

## 1.3.5 — 2026-05-27

**Fix fresh-install MCP launch when `$DESK` is unset.** The plugin's `.mcp.json` was passing `--root "${DESK:-./desk}"`, which Claude Code (and Codex) pass through to the MCP entrypoint literally — the shell substitution never runs. So fresh installs without an exported `$DESK` got `node mcp/index.js --root ./desk`, which resolved relative to the plugin install dir, didn't exist, and the MCP exited fatally. JSON-RPC surfaced as `-32000` and none of the plugin's tools loaded.

What changes:

- `mcp/src/util/paths.js` — `resolveDeskRoot()` now walks a fallback chain when `--root` isn't passed and `$DESK` isn't set: `$HOME/ms-desk/` → `$HOME/desk/` → `$HOME/worker-workspace/` (the last one for operators still on the pre-rename layout). The fatal error message now lists every path tried, so the operator can diagnose at a glance.
- `.mcp.json` — drop the inline `${DESK:-./desk}` fallback. `args` is now just `["./mcp/index.js"]`; the JS does discovery.
- `mcp/__tests__/scaffold.test.js` — six new tests cover the chain: explicit `--root` wins, `$DESK` wins over fallbacks, fallback chain order, last-resort `worker-workspace`, and the diagnostic fatal message.

No behavior change for operators who already set `$DESK` or pass `--root` explicitly.

## 1.3.4 — 2026-05-26

**Claude Code install path is now operator-actionable.** Repo gains a Claude Code marketplace manifest (`.claude-plugin/marketplace.json` at the root of `ouroboros-skills`) listing `desk` and `work-suite`. The desk plugin's README `Under Claude Code` section, previously a single sentence assuming prior marketplace knowledge, now walks through the three slash commands:

```
/plugin marketplace add ourostack/ouroboros-skills
/plugin install desk@ouroboros-skills
/plugin install work-suite@ouroboros-skills
```

…plus the agent-launch command (`claude --agent desk:worker`) and a note that Claude Code doesn't auto-resolve deps (install `work-suite` explicitly).

No semantic changes to skills or agent body. Pure install-path improvement so fresh-machine adoption stops requiring tribal knowledge.

## 1.3.3 — 2026-05-26

**Fix YAML frontmatter parse error in `desk:worker` agent files.** Smoke test on Claude Code surfaced `YAML parsing error: mapping values are not allowed in this context at line 2 column 279` when launching the agent. The `description:` value contained `Cross-harness: same skills body...` — the unquoted `:` followed by a space is parsed by YAML as a mapping key starting inside the scalar.

Fix: double-quote the `description` value in `agents/worker.md` and `agents/worker.agent.md`, and replace the inline `Cross-harness:` colon with an em-dash (`Cross-harness —`) for readability when reading raw. Same em-dash treatment applied to the Codex TOML's `description` for consistency (TOML was already correctly quoted; just the readability tweak).

No semantic changes — same canonical body, same agent behavior.

## 1.3.2 — 2026-05-26

**Git-hygiene: mass-history-rewrite upstream-currency rule.** Encodes a lesson learned the hard way during an author-rename rewrite: force-pushing rewritten history without first verifying the local clone is current with origin silently drops any commits that advanced upstream since the last sync.

What changes:

- New `Mass history rewrites — upstream-currency check is load-bearing` subsection in `git-hygiene/SKILL.md` (under `Force-push — safe-conditions procedure`).
- Three concrete patterns: (1) the standing `git fetch origin && git log HEAD..origin/<branch>` check before any force-push that follows a history rewrite; (2) start-from-fresh-mirror-clone as the preferred pattern for `git filter-repo` runs (sidesteps the stale-checkout window); (3) recovery procedure when commits did get dropped — fetch the orphan chain by SHA into `refs/recovered/old-tip`, rebase onto the rewritten base (clean when the rewrite only changed metadata since trees are identical), force-push again after re-applying the upstream-currency check.
- Existing `AI-attribution cleanup` use case cross-references the new subsection.

Why this lives in desk (substrate), not an overlay: every consumer agent that ever rewrites history on a shared branch faces the same trap, regardless of context (corporate engineering, autonomous agent, personal-coding). The rule belongs with the engineering posture skills the substrate provides.

## 1.3.1 — 2026-05-26

**Codex agent-setup docs**: close the UX gap introduced in 1.3.0. Codex plugins ship skills + MCP + apps + hooks per the [plugin schema](https://developers.openai.com/codex/concepts/customization), but cannot ship subagents or AGENTS.md content directly — the agent layer is user-installed. 1.3.0 shipped `agents/worker.toml` but didn't explain how to install it, nor did it mention the AGENTS.md path that most operators actually want.

What changes:

- **New `agents/README.md`** — per-harness install + invocation reference. Spells out the two Codex paths: (A) default behavior via appending the canonical body to `~/.codex/AGENTS.md` so Codex always reads it; (B) explicit subagent via `cp worker.toml → ~/.codex/agents/`. The two paths compose.
- **`codex-onboarding` skill** — adds Step 7 (Install the `worker` agent layer) covering both paths, with the `awk`-based frontmatter-stripping append command for Path A and the `cp` + verify-with-`codex /agents list` for Path B.
- **Top-level README's Invocation section** — Codex line is now two-paragraph, calls out the schema constraint, and links to `agents/README.md` for details.

No functional/manifest changes vs. 1.3.0; purely documentation.

## 1.3.0 — 2026-05-26

**Default `worker` agent + cross-harness manifest completion.** The desk plugin is now standalone-functional — no overlay required. A new substrate-default engineering agent ships with the plugin, and the manifest set is complete for Claude Code + Copilot CLI + Codex.

What this changes:

- **New default agent: `desk:worker`** — a long-running engineering agent that uses the desk substrate. Owns work end-to-end (ideate → plan → implement → review → PR → merge) and keeps its tracks, tasks, friction, and lessons on the desk. Substrate-default; consumer overlays (corporate-engineering, autonomous-agent, personal-coding) layer their own agents on top.
- **Three agent files for the three harnesses, same canonical body:**
  - `agents/worker.md` — Claude Code (YAML frontmatter + body)
  - `agents/worker.agent.md` — Copilot CLI (`target: github-copilot`, `user-invocable: true`)
  - `agents/worker.toml` — Codex subagent template (operator copies to `~/.codex/agents/worker.toml` to register)
- **Copilot CLI manifest added:** `plugin.json` at plugin root. Names `agents/`, `skills/`, `mcpServers` paths per the Copilot CLI plugin reference. Pairs with the existing `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`.
- **Version sync across the three plugin manifests** — all three now declare 1.3.0 so consumers see one version regardless of which harness they install through.

The agent's body uses the `$DESK` placeholder so any consumer agent can bind its own workspace path without forking the substrate. Cross-harness invocation:

```bash
# Claude Code (via plugin loader / marketplace)
claude --agent desk:worker

# Copilot CLI
copilot --agent worker

# Codex
codex /agent worker   # after copying worker.toml to ~/.codex/agents/
```

## 1.2.2 — 2026-05-23

- Add Codex plugin metadata and a local-marketplace entry for `desk`.
- Add a Codex onboarding skill covering local install, `$DESK` binding, MCP registration, and the companion `work-suite` plugin.
- Document the Codex install path in the desk README.
- Fix the MCP package test script so `npm test` discovers nested Node test files on current Node.
- Upgrade the MCP TypeScript SDK dependency to the current non-vulnerable line.
- Make semantic search self-healing across machines: embedding endpoint discovery now honors `OLLAMA_HOST` plus desk-specific overrides, unavailable semantic responses include structured diagnostics and repair guidance, and `desk_reindex` repairs fresh lexical-only indexes once embeddings return without requiring `force:true`.

## 1.2.1 — 2026-05-22

First actual migration shipped via the framework (overlay-private). Migrations using this framework are idempotent and reversible: the operations they wrap (e.g. `mv` for path renames) are atomic + the new name is the only post-state. Safety check refuses if there's uncommitted work in the old workspace dir; never sweep-stages.

This release is just the migration framework — no code or driver changes from 1.2.0. Concrete migrations live in consumer overlays.

## 1.2.0 — 2026-05-22

**`session-start-migrations` framework.** New skill that auto-heals stale machine state when a plugin's canonical names drift (workspace dir renamed, plugin clone moved, symlink target changed, etc.). Walks every enabled plugin's `migrations/<NN>-<slug>.md` dir at session start, runs each migration's Detect predicate, and (for the ones that fire) runs Safety check + Migrate + Announce, then hard-stops the session for restart.

Why this lives in desk (substrate), not in any overlay: overlays sometimes rename themselves, and a migration framework hosted inside the plugin being renamed has to rename itself mid-execution. Substrate-resident means the framework survives any overlay churn.

Design choices:

- **Self-evidencing predicates, no marker file.** Each migration's Detect block inspects actual machine state (a dir's existence, a symlink's target). Robust against restored backups, partial Time Machine snapshots, and any other path where a marker file desyncs from reality. Cost: every Detect runs on every session start; on a machine with no pending migrations (the common case) this is a few cheap bash exits.
- **Four sections (Detect / Safety check / Migrate / Announce)** map cleanly to one concern each. Detect is a pure predicate. Safety guards against partial state. Migrate does the work, idempotently. Announce is the operator-facing message.
- **Cross-plugin ordering by alphabetical filename.** The `<NN>-<slug>.md` convention plus a 2-digit prefix gives global ordering across every plugin's migrations dir; plugins coordinate by picking the next available `NN` rather than via a central registry.
- **`needs_restart: true` hard-stops the session** after the announcement. The operator restarts; the next session begins against canonical paths.

Integration: `desk:session-start` now hands off to this skill in a new Step 0.5 — after Step 0's host-identity probe, before Step 1's prereq probe. The order matters: most later steps assume `$DESK/` resolves to the canonical workspace path, so migrations run first.

This release ships the framework only; concrete migrations live in consumer overlays.

## 1.1.0 — 2026-05-22

**Archive is now searchable.** Reversed the v1.0 indexer behavior that skipped `_archive/` at index time. Archive content was always meant to be preserved for future recall — making it unsearchable defeated the purpose.

What changed:

- **Indexer**: walks under `_archive/` ancestors. Loose `.md` files there (migrated legacy filenames like `2026-02-23-planning-foo.md`) are also indexed — basename pattern infers kind (`-planning-` → planning, `-doing-` → doing, etc.) or falls back to `kind: archive`. Each indexed doc gets a new `is_archived: bool` flag.
- **Search tools**: all five accept an optional `scope: "active" | "archived" | "all"` parameter. **Per-tool defaults match each tool's purpose:**
  - `desk_search` → `active` (day-to-day signal beats archive noise)
  - `desk_recall` → `all` (this IS the historical lookback tool)
  - `desk_similar` → `all` (similarity has no time/status semantic)
  - `desk_timeline` → `all` (already temporally scoped by window)
  - `desk_thread` → no scope param; always walks across (refs don't respect archive boundaries)
- **DB schema**: new `is_archived` column on `docs` table + index. Migration is idempotent: opening an existing v1.0 DB ALTER-ADDs the column with default 0; next reindex populates correctly.

Operator-visible: `desk_recall("teams bot integration")` now finds archived planning/doing notes from months ago. `desk_search("teams bot")` still defaults to active-only — agents asking "what should I do next" get current work, not archived history. Override per-call with `scope: "all"` when historical breadth matters.

Migration: existing indexes auto-upgrade their schema on next open. To populate archive embeddings, run `ouro desk reindex --force` once per bundle (or `mcp call ... desk_reindex --args '{"force":true}'`).

## 1.0.0 — 2026-05-22

**v1.0 declared.** Substrate validated end-to-end on a real ouroboros agent bundle:

- Phase 0 (standalone MCP server): 37/37 pass, including pure-semantic recall (paraphrase query finds task via Ollama-backed embeddings, zero keyword overlap)
- Phase 1 (daemon discovery + spawn): plugin .mcp.json discovered, server spawned, tools surface
- Phase 2 (CRUD + search via daemon): 12/12 desk operations pass (task/track lifecycle, archive, friction, lesson, search, recall, similar, timeline, thread, reindex)
- Phase 4.2 (cross-machine round-trip): bundle pushed to origin with all artifacts intact

Surface confirmed:

- 13 MCP tools (7 CRUD + 5 search + 1 reindex)
- `schema_version: 1` on every write
- Auto-index-on-read (every search ensures index freshness)
- Hybrid semantic + lexical search with explicit `score_breakdown` (semantic / bm25 / recency / state / pin)
- Soft-fail to FTS-only when Ollama unreachable
- `task_archive` is idempotent (moves dir → `_archive/`, no error on re-archive)

## 0.7.1 — 2026-05-22

- Ship `desk_reindex` MCP tool. Wraps `ensureIndex` (mtime-incremental). `force: true` mode drops the sqlite db before rebuild. 13 tools total (was 12).

## 0.7.0 — 2026-05-22

- `desk_thread` provenance walk MCP tool.

## 0.6.0 — 2026-05-22

- Search tools: `desk_search`, `desk_recall`, `desk_similar`, `desk_timeline`.

## 0.5.0 — 2026-05-22

- SQLite + sqlite-vec + nomic-embed-text indexer (via Ollama).

## 0.4.0 — 2026-05-22

- Runtime CRUD MCP tools: `task_create`, `task_update`, `task_archive`, `track_create`, `track_update`, `friction_add`, `lesson_add`.

## 0.3.0 — 2026-05-22

- MCP server scaffold with `.mcp.json` declaration.

## 0.2.0 — 2026-05-22

- Extends task.md schema; adds `schema_version: 1`; drops Execution Mode (spawn-mode).

## 0.1.0

- Initial skills + skeleton.

## Setup (v1.0)

After `ouro plugin install github:ourostack/ouroboros-skills:plugins/desk --agent <name>`:

1. **Install plugin's MCP deps:** `cd ~/.ouro-cli/plugins/desk/mcp && npm install`
2. **Install Ollama** for full semantic surface (recall / similar). Mac one-time: `curl -L https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz | tar -xz` then add the binary to PATH. Linux: `curl -fsSL https://ollama.com/install.sh | sh`.
3. **Pull the embedding model:** `ollama serve &` then `ollama pull nomic-embed-text` (one-time, ~274MB).
4. **Restart daemon** so plugin MCP discovery picks up the new server: `ouro stop && ouro up`.

Without Ollama, desk_search falls back to FTS5-only (keyword) and desk_recall/desk_similar return empty. Substrate works; semantic surface is degraded.

## Known limitations (v1.0)

These do NOT block v1.0 use but are tracked for follow-ups:

- **Plugin install does not run `npm install`.** After `ouro plugin install ...`, the operator (or a v1.1 install hook) needs to `cd ~/.ouro-cli/plugins/desk/mcp && npm install`. Otherwise the server can't spawn (`@modelcontextprotocol/sdk`, `better-sqlite3`, `sqlite-vec`, `gray-matter` missing). v1.1: either auto-run install on plugin install OR vendor deps OR ship as a bundled single-file build.
- **Tool input schemas are loose.** `inputSchema: { type: "object", properties: {}, additionalProperties: true }` — agents have to infer from descriptions. Works but agents occasionally pass wrong field names on first attempt. v1.1: define explicit JSON Schema per tool.
- **`mcp__ouro-<agent>__send_message` response wrapper hangs at 600s** when the agent makes multi-tool sequences via desk MCP, even though the agent finishes successfully (artifacts on disk). This is in the **ouro MCP** comms layer, not desk. Tracked separately.
- **Ollama is a soft dep** for full semantic surface. With Ollama down, `desk_search` falls back to FTS-only (still works), `desk_recall` returns empty + a note, `desk_similar` uses stored embeddings only. For the agent-as-substrate promise, the operator should keep Ollama + `nomic-embed-text` available.
- **Daemon must be restarted** after a fresh `ouro plugin install ...` for the new plugin's MCP server to be discovered. v1.1: signal the daemon to reconcile on plugin-list change.

These are upgradable in place — none change the v1.0 wire format or storage schema.
