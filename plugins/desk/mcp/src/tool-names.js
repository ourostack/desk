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
    "Create a task card at <track>/<slug>/task.md. `slug` must be an outcome name: 2-6 lowercase kebab-case words, not prompt-like or credential-like; a rejection says what to fix.",
  task_update:
    "The only way to change an existing task card (direct edits are denied). Merge `frontmatter`, record progress with `note` and `next_step`, `body_append`, or change `step`, `resource` or a `replace_section`. A move to `done` needs `evidence`. A live done/cancelled result carries archive_due: the owning main agent calls task_archive before final delivery. The cue archives nothing itself.",
  task_archive:
    "Move <track>/<slug>/ to <track>/_archive/<slug>/. A task not yet done or cancelled needs `evidence` or `outcome: \"cancelled\"`. Returns archive_pending with the retained path and next_action when publication is unproven; that is not completed publication. Repeating an archived task is safe.",
  task_move:
    "Move a task to another track and/or rename it (live or archived; archived stays archived). `to_slug` must be an outcome name and `to_track` an existing track; the target must not exist. On a Git desk it refuses a folder with unstaged or untracked changes unless `allow_dirty: true`. `unarchive: true` reopens an archived task. `into_task: \"<keeper>\"` merges a duplicate into the keeper under `_iterations/`, refused for a live task into a done or cancelled one; nothing is deleted. A commit failure never loses the move (see `commit`). Returns `mentions`: files that still name the old path, never rewritten.",
  task_signoff:
    "Record the operator's answer to a delivered task: accepted or refused. Call it only after the operator has answered, in a turn after the one that delivered the work. A refusal needs `reason` (theirs) and `return_reason` (your own reading) and puts the task back to processing. A subagent never calls this.",
  task_focus:
    "Declare the task this session is working on, so its time is credited to it. Pass `track` and `slug` of an existing card (live or archived), or `clear: true` for a side conversation. Main agent only; a subagent never calls it. Writes nothing. Returns `task_status`, `recent_progress`, `next_step`, any `shelved_lessons` to read before you act, and `archive_due` for a done/cancelled card. A missing card is an error and leaves the focus as it was. `task_create` with `focus: true` does the same for a new task.",
  track_create:
    "Create a new track.md under <root>/<slug>/ with schema_version:1 frontmatter. `slug` must be an outcome name (2-6 lowercase kebab-case words; not prompt-like, credential-like, a catch-all name, or named after the operator), and `scope` is required — one line, at most 240 characters, in the form \"<what belongs>; not <what doesn't>\". Rejections explain what to fix without echoing the rejected name back. On a Git desk it stages and commits the new track.md; a commit failure never loses the write, reported via a `commit` field.",
  track_update:
    "Merge frontmatter or append to the body of an existing track.md; preserves schema_version + created. `frontmatter.scope`, if set, is validated the same way track_create validates it. On a Git desk it stages and commits the track.md when that file held no unstaged changes before the write, so it never adopts another session's edit; a commit failure never loses the write, reported via a `commit` field.",
  track_rename:
    "Rename a track — `to` must be a valid track name per `validateTrackName`, the same rule `track_create` enforces (rejects a prompt-copied, credential-like, catch-all, or person name). Refuses if the target already exists. Rewrites `track:` in every task.md under the moved tree, live and archived. Stages the move with `git mv` on a Git desk, a plain rename otherwise, then commits the moved directory and the task cards it rewrites; a plain rename with no commit is as far as it goes on a non-Git desk, and a commit failure never loses the move, reported via a `commit` field. On a Git desk it refuses a track with unstaged changes or untracked, non-ignored files, because another session may be working there, unless `allow_dirty: true`; the refusal never quotes names. It stages the task cards it rewrites. Returns `mentions`: other .md files under the desk that still reference the old track path in free text — reported, never rewritten.",
  friction_add:
    "Append a friction entry: cross-cutting to _meta/friction.md, or track-local under <track>/_friction/ when `track` is given. `about` is \"setup\" (default: this desk's own setup, kept on the desk) or \"system\" (Desk, its skills or the factory). System friction needs a one-line `title` and opens an improvement card by itself, with no signoff; Desk builds the card's title, never from your text. Read `improvement` in the result: opened, duplicate or reopened means the card exists (`improvement_key` and `improvement_path` name it); any other value is the reason it does not. `file_card: true` also files the store's kaizen issue now. `error_code` reports a Desk failure with its evidence (friction-management has the rest).",
  lesson_add:
    "Record a correction where something loads it, and read `in_effect` and `message` in the reply before you tell anyone the lesson is kept. `scope` \"personal\" adds a one-line rule to this person's AGENTS.md `## Lessons` (or the LESSONS.md shelf beside it when AGENTS.md is full; `tier` and `shelved` say where): in effect once committed. `scope` \"desk\" is for how Desk's tools and installed plugins' skills behave: it needs `owner`, records system friction and opens an improvement card (`improvement`, `improvement_key`, `improvement_path`); not in effect until that card's change ships. `scope` \"team\" is for every teammate's agents in a shared repository (`repo`; the desk in a shared workspace): it needs `source`, writes an attributed line into that repository's AGENTS.md through a pull request it merges, and says `merged`, `pr_open` or `failed`; in effect only when merged, and refused if it would push AGENTS.md past 16 KB.",
  note_leave:
    "In a Crew shared workspace, leave another member a dated note that their session start lists until they acknowledge it. `to` is their alias on the roster (_meta/desks.md). `body` is your own explanation in your own voice: relay what someone else thinks as your understanding of it, never in their words or voice. Everyone in the workspace can read it, so put nothing private in it. Desk adds the date and you as sender, writes desks/<to>/_inbox/ through a pull request it merges, and says `merged`, `pr_open`, `duplicate` (`note` names the existing one) or `failed`; the note is left only when merged.",
  note_ack:
    "Mark a note a teammate left you acknowledged, once the operator has seen it. `note` is the path session start listed or its file name; only a note in your own inbox. The note stays in place with `status: acknowledged`, session start stops listing it, and `committed` says whether the desk committed it.",
  desk_save:
    "After you write a file with Write or Edit (a planning doc, a spec, a report), call this with its path to commit it. `paths` are relative to the desk root and must be inside this session's write prefix (desks/<alias>/ in a shared workspace). Stages and commits exactly `paths` with `message`; returns `nothing_to_commit` when none holds a change, so a mistyped path never becomes an empty commit. A task card is refused: use the task tools. `tidy: true` commits a desk tidy or its undo. A client with no filesystem passes `files` ({ path, content } UTF-8 text entries) in place of or with `paths`: Desk writes then commits them, and any refused entry writes nothing.",
  desk_search:
    "Hybrid lexical+semantic search across desk. Filters: track, status, kind, since, until. Returns ranked chunks with score_breakdown. Soft-fails to FTS-only when Ollama is unreachable. `scope` (optional): 'active' (default), 'archived', or 'all' — desk_search defaults to active because day-to-day signal beats archive noise; pass 'all' to search history too.",
  desk_recall:
    "Loose recall — `do I remember anything about X`. Ranks every desk Markdown file by meaning and by exact words together, so a document strong on both comes first; until the built-in model is ready it answers with exact words and says so. Returns top matches deduped by doc. `scope` (optional): 'active', 'archived', or 'all' (default) — desk_recall IS the historical lookback tool, so it searches everything by default; pass 'active' to scope to current work only.",
  desk_timeline:
    "Temporal query — filter docs by updated_at window, optionally combined with FTS+semantic. Without `query`: chronological listing. With `query`: hybrid ranking inside the window, ordered by updated_at DESC. `scope` (optional): 'active', 'archived', or 'all' (default) — the window already temporally scopes; archive items in-window are legitimate entries.",
  desk_reindex:
    "Re-read the desk into this session's search engine and wait until exact-word search is current. `force` is accepted for compatibility and changes nothing. Returns `action: \"reindexed\"` with the search engine's status, or an error with code `search_starting` while the search engine has not started yet.",
  desk_skill:
    "Read one of Desk's skills: the working procedures Desk's instructions point to (task-lifecycle, friction-management, evidence-discipline and the rest). With no `name`, lists every skill with its description; with `name`, returns that skill's text to follow. Read-only, and needs no desk. Use it wherever the client cannot load Desk's skills itself, such as claude.ai or ChatGPT; on a hosted Desk, skills that need a shell are listed with the reason and refused.",
  desk_status:
    "Session-start health check for the resolved desk root. The default answer is compact: `state` (`ready`, `degraded`, `admitting` or `setup_required`, the same words the session-start boot script's `status` uses), `degraded` (why Desk is not ready, empty when it is), `fix` (what to do in this session), `search` (one sentence on how search stands; search never makes `state` degraded, because until it is ready it reads the files directly), `notes` (non-blocking conditions) and where the desk is. Retries admission at once when Desk is not ready. Pass `detail: true` for the full payload (runtime cache, plugin version, local DB, lexical index, document-vector coverage, snapshots, vector packs, admission internals). Does not run expensive repair work or probe live embedding endpoints. On a hosted Desk (claude.ai, ChatGPT), the answer also carries the instructions for working with Desk there, unless you pass `has_instructions: true` because this conversation already has them; follow them, and read the skills they name with desk_skill.",
  desk_doctor:
    "Report whether Desk MCP started in healthy runtime mode and describe the active runtime target. In diagnostic mode, reports the precise startup failure and offline remediation. Optional format:'preview' returns only a local-on-demand, nine-field package/process snapshot with no task or feedback records. Optional repair:'switch_state_branch' switches the desk checkout back to its state branch when that is safe (clean tracked tree, no Git operation in progress, no local-only commits); it also counts the private partitions the retired manual measurement ledger left in the state directory, without opening, moving or deleting them.",
  improvement_open:
    "Open an improvement card on the desk, find it already open, or reopen a closed one. `source` and `id` name the case (the card key is <source>:<id>). `title` is never accepted (refused as title_not_allowed): Desk builds every title. Commits exactly the card file. Returns status \"ok\" with `result` opened, duplicate or reopened and `file_name`, or status \"refused\" with a code in `result`; `commit` appears only when the commit did not happen.",
  improvement_next:
    "Take the next improvement card: the open card that waited longest. It claims the card for a limited time and returns it (key, source, title, evidence pointers, state, counts), the `claim_id` and the authority statement. A refusal comes back as `status` (claim_held, cap_reached, none_open, too_many_cards, machine_key_unavailable or noninteractive) with a one-line `meaning`. Optional `session` is the session's UUID.",
  improvement_update:
    "Update a card you hold the claim on, with its `key` and `claim_id`: ship it (`countermeasure` is the pull request URL; `state` \"shipped\" or omitted), release it (`state` \"open\") or close it (`state` \"closed_unverified\" with `close_reason`). Verification, version and check fields belong to Desk's verify step and are refused. Commits the card file. Returns status \"updated\" with the new `state`, or status \"refused\" with a code in `result`.",
}
