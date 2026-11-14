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
  // Teammate notes (Crew)
  "note_leave",
  "note_ack",
  // Search
  "desk_search",
  "desk_recall",
  "desk_timeline",
  // Index management
  "desk_reindex",
  // Health/status
  "desk_status",
  "desk_doctor",
  // Skills, for a client that cannot load them as plugin skills
  "desk_skill",
  // Improvement cards
  "improvement_open",
  "improvement_next",
  "improvement_update",
]

export const TOOL_DESCRIPTIONS = {
  task_create:
    "Use when new work needs its own card: create a task card at <track>/<slug>/task.md. `slug` must be an outcome name: 2-6 lowercase kebab-case words, not prompt-like or credential-like; a rejection says what to fix.",
  task_update:
    "The only way to change an existing task card (direct edits are denied). Merge `frontmatter`, record progress with `note` and `next_step`, `body_append`, or change `step`, `resource` or a `replace_section`. A move to `done` needs `evidence`. A live done/cancelled result carries archive_due: the owning main agent calls task_archive before final delivery. The cue archives nothing itself.",
  task_archive:
    "Use when a task's work is finished or cancelled: move <track>/<slug>/ to <track>/_archive/<slug>/. A task not yet done or cancelled needs `evidence` or `outcome: \"cancelled\"`. Returns archive_pending with the retained path and next_action when publication is unproven; that is not completed publication. Repeating an archived task is safe.",
  task_move:
    "Use when a task belongs in another track or needs a new name: move or rename it (live or archived; archived stays archived). `to_slug` must be an outcome name and `to_track` an existing track; the target must not exist. On a Git desk it refuses a folder with unstaged or untracked changes unless `allow_dirty: true`. `unarchive: true` reopens an archived task; `into_task: \"<keeper>\"` merges a duplicate into the keeper, refused for a live task into a done or cancelled one; nothing is deleted.",
  task_signoff:
    "Record the operator's answer to a delivered task: accepted or refused. Call it only after the operator has answered, in a turn after the one that delivered the work. A refusal needs `reason` (theirs) and `return_reason` (your own reading) and puts the task back to processing. A subagent never calls this.",
  task_focus:
    "Declare the task this session is working on, so its time is credited to it. Pass `track` and `slug` of an existing card (live or archived), or `clear: true` for a side conversation. Main agent only; a subagent never calls it. Writes nothing. Returns `task_status`, `recent_progress`, `next_step`, any `shelved_lessons` to read before you act, and `archive_due` for a done/cancelled card. `task_create` with `focus: true` does the same for a new task.",
  track_create:
    "Use when new work needs its own track: create a track at <slug>/track.md. `slug` must be an outcome name (2-6 lowercase kebab-case words) and `scope` is required: one line, at most 240 characters, \"<what belongs>; not <what doesn't>\". A rejection says what to fix. On a Git desk it stages and commits the new track.md; a commit failure never loses the write, reported via a `commit` field.",
  track_update:
    "Merge frontmatter or append to the body of an existing track.md. `frontmatter.scope`, if set, is validated as track_create validates it. On a Git desk it stages and commits the track.md when that file held no unstaged changes before the write, so it never adopts another session's edit; a commit failure never loses the write, reported via a `commit` field.",
  track_rename:
    "Use when a track needs a new name: `to` must be a valid track name (as in track_create) and must not already exist. Rewrites `track:` in every task.md under the moved tree, live and archived, and commits the moved directory. On a Git desk it refuses a track with unstaged changes or untracked, non-ignored files, because another session may be working there, unless `allow_dirty: true`; the refusal never quotes names. It stages the task cards it rewrites.",
  friction_add:
    "Use when something got in your way and should be recorded: append a friction entry to _meta/friction.md, or under <track>/_friction/ when `track` is given. `about` is \"setup\" (default, kept on the desk) or \"system\" (Desk, its skills or the factory); system friction needs a one-line `title` and opens an improvement card. Read `improvement` in the result: opened, duplicate or reopened means the card exists. `error_code` reports a Desk failure with its evidence (friction-management has the rest).",
  lesson_add:
    "Record a correction where something loads it, and read `in_effect` and `message` in the reply before you tell anyone the lesson is kept. `scope` \"personal\" adds a one-line rule to this person's AGENTS.md; \"desk\" is for how Desk's tools or a plugin's skills behave: it needs `owner` and opens an improvement card; \"team\" adds a line to a shared repository's AGENTS.md through a pull request: it needs `source`.",
  note_leave:
    "In a Crew shared workspace, leave another member a dated note that their session start lists until they acknowledge it. `to` is their alias on the roster (_meta/desks.md). `body` is your own explanation in your own voice: relay what someone else thinks as your understanding of it, never in their words. Everyone in the workspace can read it, so put nothing private in it. The note is left only when the reply says `merged`.",
  note_ack:
    "Use when the operator has seen a note a teammate left you: mark it acknowledged. `note` is the path session start listed or its file name; only a note in your own inbox.",
  desk_save:
    "After you write a file with Write or Edit (a planning doc, a spec, a report), call this with its path to commit it. `paths` are relative to the desk root, inside this session's write prefix (desks/<alias>/ in a shared workspace). Stages and commits exactly `paths` with `message`. A task card is refused: use the task tools. `tidy: true` commits a desk tidy or its undo. A client with no filesystem passes `files` ({ path, content } text) with or instead of `paths`.",
  desk_search:
    "Use when you cannot tell which file holds something. Hybrid lexical+semantic search across the desk. Filters: track, status, kind, since, until. `scope`: 'active' (default), 'archived' or 'all'.",
  desk_recall:
    "Use for loose recall, as in `do I remember anything about X`. Ranks every desk Markdown file by meaning and exact words together. `scope`: 'active', 'archived' or 'all' (default; this is the historical lookback).",
  desk_timeline:
    "Use when you need what changed in a time window: list documents whose updated_at falls in it, chronologically; with `query`, hybrid-ranked inside the window, newest first. `scope`: 'active', 'archived' or 'all' (default).",
  desk_reindex:
    "Use when search misses what you just wrote: re-read the desk into this session's search engine and wait until exact-word search is current.",
  desk_skill:
    "Use when your client cannot load Desk's skills itself (claude.ai, ChatGPT): read one of Desk's skills, the working procedures its instructions point to. With no `name`, lists every skill with its description; with `name`, returns that skill's text to follow. Read-only and needs no desk.",
  desk_status:
    "Session-start health check for the resolved desk root. The compact answer has `state` (ready, degraded, admitting or setup_required), `degraded` (why), `fix` (what to do in this session), `search`, `notes` and where the desk is. Retries admission when Desk is not ready. `detail: true` returns the full payload. A hosted Desk (claude.ai, ChatGPT) also returns its instructions, unless `has_instructions: true`; follow them and read the skills they name with desk_skill.",
  desk_doctor:
    "Use when Desk misbehaves or its runtime needs checking: report whether Desk MCP started in healthy runtime mode and describe the active runtime target; in diagnostic mode, the precise startup failure and offline remediation. `format: \"preview\"` returns only the local package/process snapshot. `repair: \"switch_state_branch\"` switches the desk checkout back to its state branch when that is safe.",
  improvement_open:
    "Use when a case needs an improvement card: open one on the desk, find it already open, or reopen a closed one. `source` and `id` name the case (the card key is <source>:<id>). `title` is never accepted: Desk builds every title.",
  improvement_next:
    "Use when you take on improvement work: take the next improvement card, the open card that waited longest. It claims the card for a limited time and returns it with the `claim_id` and the authority statement. A refusal comes back as `status` (claim_held, cap_reached, none_open, too_many_cards, machine_key_unavailable or noninteractive) with a one-line `meaning`. Optional `session` is the session's UUID.",
  improvement_update:
    "Use when you ship, release or close a card you hold the claim on, with its `key` and `claim_id`: ship it (`countermeasure` is the pull request URL; `state` \"shipped\" or omitted), release it (`state` \"open\") or close it (`state` \"closed_unverified\" with `close_reason`).",
}
