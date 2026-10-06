// Single source of truth for the MCP tools desk-mcp exposes.
//
// Imported by both server.js (registers them) and the tests (asserts the
// list is canonical). Kept in a no-deps file so tests can import without
// the @modelcontextprotocol/sdk dep being installed.

export const TOOL_NAMES = [
  // Runtime CRUD (Unit 3)
  "task_create",
  "task_update",
  "task_archive",
  "task_move",
  "task_focus",
  "task_signoff",
  "track_create",
  "track_update",
  "track_rename",
  "friction_add",
  "lesson_add",
  "desk_save",
  // Search (Units 5 + 6)
  "desk_search",
  "desk_recall",
  "desk_similar",
  "desk_timeline",
  "desk_thread",
  // Index management
  "desk_reindex",
  // Health/status
  "desk_status",
  "desk_doctor",
]

export const TOOL_DESCRIPTIONS = {
  task_create:
    "Create a new task.md under <root>/<track>/<slug>/ with schema_version:1 frontmatter. `slug` must be an outcome name — 2-6 lowercase kebab-case words, not prompt-like or credential-like; rejected names explain what to fix without echoing the rejected name back.",
  task_update:
    "The only way to change an existing task.md (a direct Write/Edit of one is denied). Merge `frontmatter` (status, repos, iterations), record progress with `note` (a dated line under `## Progress log`), replace the recorded `**Next step:**` with `next_step`, or `body_append` markdown; preserves schema_version + created. A move to `done` needs `evidence`.",
  task_archive:
    "Move <root>/<track>/<slug>/ to <root>/<track>/_archive/<slug>/, marking status=done if non-terminal. Idempotent.",
  task_move:
    "Move a task to another track and/or rename it (live or archived — archived stays archived). `to_slug`, if set, must be an outcome name per `validateName`, the same rule `task_create` enforces; an unchanged slug is never re-validated. `to_track`, if set, must be a valid track name per `validateTrackName`, the same rule `track_create`/`track_rename` enforce, and its `track.md` must already exist — a move never creates a track implicitly. Refuses if the target already exists. Sets `track:` on the moved task.md and best-effort moves its row between the source and destination `track.md` \"## Tasks\" tables (or renames the row in place for a same-track move) — a track.md that doesn't follow the recommended table template is left untouched, never corrupted. Stages the move with `git mv` on a Git desk, a plain rename otherwise, then commits the moved directory and any `track.md` tables it edited; a plain rename with no commit is as far as it goes on a non-Git desk, and a commit failure never loses the move, reported via a `commit` field. On a Git desk it refuses a task folder with unstaged changes or untracked, non-ignored files, because another session may be working there, unless `allow_dirty: true`; the refusal never quotes names. The same rule covers each `track.md` whose tasks table the move would edit. Staged changes don't count: it stages every file it writes, as do `track_rename`, `track_create` and `track_update`, so a staged change is the current tidy's own work in progress. `unarchive: true` reopens an archived task: it moves `<track>/_archive/<slug>/` back to a live task folder and restores its row in the destination \"## Tasks\" table, without changing its status. `into_task: \"<keeper>\"` merges a duplicate task into the task that keeps the job: the folder moves to `<keeper>/_iterations/<created-date>-<slug>/`, its card becomes `merged-task.md` there with `merged_into:` set, and its row leaves the source table; nothing is deleted. It refuses to merge a live task into a done or cancelled one: keep the live task instead. Returns `mentions`: other .md files under the desk that still reference the old path in free text — reported, never rewritten.",
  task_signoff:
    "Record the operator's answer to a delivered task: accepted or refused. Call it only after the operator has answered, in a turn after the one that delivered the work. A refusal needs `reason` (theirs) and `return_reason` (your own reading) and puts the task back to processing. Desk marks the answer verified only when it saw a human turn behind it. A subagent never calls this.",
  task_focus:
    "Declare the task this session is working on, so its time is credited to that task. Pass `track` and `slug` of an existing card (live, or only under `_archive/`, which the answer marks `archived: true`), or `clear: true` for a side conversation that belongs to no task; anything else is refused. Returns the card's `task_status` and `recent_progress` (its last 5 progress-log entries, each cut to 300 characters; empty when the card has none), so the call also shows where the task stands. A missing card is an error, `card not found: <track>/<slug>`, and leaves the focus as it was. Call it when you start or switch tasks, if you are the session's main agent: a subagent must never call it. It writes nothing and needs no network or write authority, and nothing is kept on disk. `task_create` with `focus: true` does the same for a task it creates. Desk holds the focus for the session: `task_update` and `task_archive` on another card, and every task tool call while the session has never declared a focus, add a `focus_note` hint; hints never block a call.",
  track_create:
    "Create a new track.md under <root>/<slug>/ with schema_version:1 frontmatter. `slug` must be an outcome name (2-6 lowercase kebab-case words; not prompt-like, credential-like, a catch-all name, or named after the operator), and `scope` is required — one line, at most 240 characters, in the form \"<what belongs>; not <what doesn't>\". Rejections explain what to fix without echoing the rejected name back. On a Git desk it stages and commits the new track.md; a commit failure never loses the write, reported via a `commit` field.",
  track_update:
    "Merge frontmatter or append to the body of an existing track.md; preserves schema_version + created. `frontmatter.scope`, if set, is validated the same way track_create validates it. On a Git desk it stages and commits the track.md when that file held no unstaged changes before the write, so it never adopts another session's edit; a commit failure never loses the write, reported via a `commit` field.",
  track_rename:
    "Rename a track — `to` must be a valid track name per `validateTrackName`, the same rule `track_create` enforces (rejects a prompt-copied, credential-like, catch-all, or person name). Refuses if the target already exists. Rewrites `track:` in every task.md under the moved tree, live and archived. Stages the move with `git mv` on a Git desk, a plain rename otherwise, then commits the moved directory and the task cards it rewrites; a plain rename with no commit is as far as it goes on a non-Git desk, and a commit failure never loses the move, reported via a `commit` field. On a Git desk it refuses a track with unstaged changes or untracked, non-ignored files, because another session may be working there, unless `allow_dirty: true`; the refusal never quotes names. It stages the task cards it rewrites. Returns `mentions`: other .md files under the desk that still reference the old track path in free text — reported, never rewritten.",
  friction_add:
    "Append a friction entry — cross-cutting to <root>/_meta/friction.md, or track-local to <root>/<track>/_friction/<date>-<theme>.md. `about` is \"setup\" (default: this desk's own setup, kept on the desk) or \"system\" (Desk, its skills or the factory): system friction needs a one-line `title` and may carry `plugin` (default \"desk\"), `friction_class` (guard, hook, mcp_tool, skill, factory, release, ci, docs or other; default other), `signal` (a rollups measure) and `evidence_jobs`; it is recorded on the desk as a kaizen candidate and sends nothing (result `kaizen: \"candidate\"`). `file_card: true` is for the curator after its signoff step only: it files the card in the desk's factory store (the facts route; nothing when the route is unknown; structured fields only in a public store; deduplicated; at most five a day) and records the outcome on the desk: status \"filed\" with the `url` and `kaizen` \"filed\" or \"duplicate\", or status \"added\" with the reason code in `kaizen`.",
  lesson_add:
    "Write or append a lesson under <root>/_meta/tips/<topic>.md. Existing file gets an `## Update <date>` section.",
  desk_save:
    "After you write a file with Write or Edit (a planning doc, a spec, a report), call this with the file's path to commit it. `paths` are relative to the desk root; each must resolve inside the resolved --person write prefix, or the call is refused. Stages and commits exactly `paths` with `message` (`git commit -- <paths>`, never -a or -A). Returns `nothing_to_commit`, without committing, when none of `paths` holds an unstaged change or an untracked file — most often a path that was never actually written — so a stale or mistyped path never becomes an empty commit. A task card is refused: use task_update, task_create, task_move or task_archive. To commit a desk tidy or its undo, pass `tidy: true` with the old and new path of every moved task card and the record file: cards go through only as staged moves or deletes, other staged work stays staged, and the message ends with the `Desk-Tidy: true` trailer.",
  desk_search:
    "Hybrid lexical+semantic search across desk. Filters: track, status, kind, since, until. Returns ranked chunks with score_breakdown. Soft-fails to FTS-only when Ollama is unreachable. `scope` (optional): 'active' (default), 'archived', or 'all' — desk_search defaults to active because day-to-day signal beats archive noise; pass 'all' to search history too.",
  desk_recall:
    "Semantic-only loose recall — `do I remember anything about X`. Requires Ollama; errors when unreachable. Returns top matches deduped by doc. `scope` (optional): 'active', 'archived', or 'all' (default) — desk_recall IS the historical lookback tool, so it searches everything by default; pass 'active' to scope to current work only.",
  desk_similar:
    "Find docs similar to a given path via centroid of the seed doc's chunk embeddings. Returns ranked similar docs excluding the seed itself. `scope` (optional): 'active', 'archived', or 'all' (default) — similarity has no time/status semantic so the full corpus is searched by default.",
  desk_timeline:
    "Temporal query — filter docs by updated_at window, optionally combined with FTS+semantic. Without `query`: chronological listing. With `query`: hybrid ranking inside the window, ordered by updated_at DESC. `scope` (optional): 'active', 'archived', or 'all' (default) — the window already temporally scopes; archive items in-window are legitimate entries.",
  desk_thread:
    "Provenance walk via refs_graph: BFS along planning/doing/feedback/iteration edges from a starting doc. Returns an ordered chain {path, kind, ref_kind, hop_distance, why_connected, updated_at}. Inputs: start_path (required), depth (optional, default 4), direction (optional: forward|backward|both, default both). Always walks across active + archive — refs don't respect archive boundaries. Errors with not_indexed when start_path isn't in the index.",
  desk_reindex:
    "Rebuild the desk-index sqlite db. Without args, behaves like ensureIndex (mtime-based incremental). With force:true, drops the db and rebuilds from scratch. Returns counts + timing.",
  desk_status:
    "Session-start health check for the resolved desk root. The default answer is compact: `state` (`ready`, `degraded`, `admitting` or `setup_required`, the same words the session-start boot script's `status` uses), `degraded` (why Desk is not ready, empty when it is), `fix` (what to do in this session), `search` (the search index in one word: `ready`, `converging`, `degraded`, `unavailable` or `not_checked`; a degraded index never makes `state` degraded, because search then reads the files directly), `notes` (non-blocking conditions) and where the desk is. Retries admission at once when Desk is not ready. Pass `detail: true` for the full payload (runtime cache, plugin version, local DB, lexical index, document-vector coverage, snapshots, vector packs, admission internals). Does not run expensive repair work or probe live embedding endpoints.",
  desk_doctor:
    "Report whether Desk MCP started in healthy runtime mode and describe the active runtime target. In diagnostic mode, reports the precise startup failure and offline remediation. Optional format:'preview' returns only a local-on-demand, nine-field package/process snapshot with no task or feedback records. Optional repair:'switch_state_branch' switches the desk checkout back to its state branch when that is safe (clean tracked tree, no Git operation in progress, no local-only commits); repair:'reclaim_controller' reports a readiness controller that accepts connections but does not answer, naming its owner process, and stops nothing (the controller runs inside another session's Desk MCP server); repair:'prune_readiness_state' removes leftover readiness-controller folders whose owner process is dead and whose root no longer exists. It also counts the private partitions the retired manual measurement ledger left in the state directory, without opening, moving or deleting them.",
}
