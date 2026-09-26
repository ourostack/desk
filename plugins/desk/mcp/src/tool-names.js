// Single source of truth for the 18 MCP tools desk-mcp exposes.
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
  "track_create",
  "track_update",
  "track_rename",
  "friction_add",
  "lesson_add",
  // Private, non-Git work measurement the owner keeps about their own work
  "desk_work_ledger",
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
    "Merge frontmatter or append to the body of an existing task.md; preserves schema_version + created.",
  task_archive:
    "Move <root>/<track>/<slug>/ to <root>/<track>/_archive/<slug>/, marking status=done if non-terminal. Idempotent.",
  task_move:
    "Move a task to another track and/or rename it (live or archived — archived stays archived). `to_slug`, if set, must be an outcome name per `validateName`, the same rule `task_create` enforces; an unchanged slug is never re-validated. `to_track`, if set, must be a valid track name per `validateTrackName`, the same rule `track_create`/`track_rename` enforce, and its `track.md` must already exist — a move never creates a track implicitly. Refuses if the target already exists. Sets `track:` on the moved task.md and best-effort moves its row between the source and destination `track.md` \"## Tasks\" tables (or renames the row in place for a same-track move) — a track.md that doesn't follow the recommended table template is left untouched, never corrupted. Stages the move with `git mv` on a Git desk, a plain rename otherwise; never commits. `unarchive: true` reopens an archived task: it moves `<track>/_archive/<slug>/` back to a live task folder and restores its row in the destination \"## Tasks\" table, without changing its status. `into_task: \"<keeper>\"` merges a duplicate task into the task that keeps the job: the folder moves to `<keeper>/_iterations/<created-date>-<slug>/`, its card becomes `merged-task.md` there with `merged_into:` set, and its row leaves the source table; nothing is deleted. Returns `mentions`: other .md files under the desk that still reference the old path in free text — reported, never rewritten.",
  track_create:
    "Create a new track.md under <root>/<slug>/ with schema_version:1 frontmatter. `slug` must be an outcome name (2-6 lowercase kebab-case words; not prompt-like, credential-like, a catch-all name, or named after the operator), and `scope` is required — one line, at most 240 characters, in the form \"<what belongs>; not <what doesn't>\". Rejections explain what to fix without echoing the rejected name back.",
  track_update:
    "Merge frontmatter or append to the body of an existing track.md; preserves schema_version + created. `frontmatter.scope`, if set, is validated the same way track_create validates it.",
  track_rename:
    "Rename a track — `to` must be a valid track name per `validateTrackName`, the same rule `track_create` enforces (rejects a prompt-copied, credential-like, catch-all, or person name). Refuses if the target already exists. Rewrites `track:` in every task.md under the moved tree, live and archived. Stages the move with `git mv` on a Git desk, a plain rename otherwise; never commits. Returns `mentions`: other .md files under the desk that still reference the old track path in free text — reported, never rewritten.",
  friction_add:
    "Append a friction entry — cross-cutting to <root>/_meta/friction.md, or track-local to <root>/<track>/_friction/<date>-<theme>.md.",
  lesson_add:
    "Write or append a lesson under <root>/_meta/tips/<topic>.md. Existing file gets an `## Update <date>` section.",
  desk_work_ledger:
    "Private work-item measurement about the caller's own work, stored in the OS user's own state directory — never in the desk Git workspace, the search index, or telemetry. A work item is one request for one specific independently assessable outcome; identity is taken at intake before any commitment. Records commitment, size features (before execution), phases, scope changes, links, completion and closure; and records an exact file/directory scope envelope plus a one-ruling-per-cycle work-design loop through `run_contract`, `cycle`, and `work_design_ruling`. Detects repeated boundary rejection, stalled findings without new learning, write-set escape, and declared architecture expansion; blocks a new cycle while a pivot is unresolved; leaves the ruling model-owned; keeps the stored discriminator strict; canonicalizes legacy comparison on read without rewriting history; imports minimal usage facts with provenance from the host's own local session records; and reports every field as measured, declared, inferred, estimated or unavailable. Actions: `capabilities`, `intake`, `commit`, `size`, `phase`, `scope_change`, `link`, `complete`, `close`, `correct`, `delete`, `inspect`, `report`, `run_contract`, `cycle`, `work_design_ruling`, `import_usage`, `cost_basis`, `set_recording`, `link_evaluation_receipt`. Scoped to the session's desk root and --person binding; it cannot read or write another participant's ledger. Results return to this caller only — there is no share or export action. It measures work, not people: no ranking, no scoring, no transcripts, and no universal credit-to-money conversion.",
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
    "Fast session-start health/status report for the resolved desk root, runtime cache, plugin version, local DB, lexical index, document-vector coverage, snapshots, and vector packs. Does not run expensive repair work or probe live embedding endpoints.",
  desk_doctor:
    "Report whether Desk MCP started in healthy runtime mode and describe the active runtime target. In diagnostic mode, reports the precise startup failure and offline remediation. Optional format:'preview' returns only a local-on-demand, nine-field package/process snapshot with no task or feedback records.",
}
