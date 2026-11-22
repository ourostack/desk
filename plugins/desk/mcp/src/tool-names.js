// Single source of truth for the MCP tools desk-mcp exposes.
//
// Imported by both server.js (registers them) and the tests (asserts the
// list is canonical). Kept in a no-deps file so tests can import without
// the @modelcontextprotocol/sdk dep being installed.

import { ACTION_TOOLS } from "./actions/served.js"

export const TOOL_NAMES = [
  // Runtime CRUD (Unit 3)
  "task_create",
  "task_update",
  "task_archive",
  "task_focus",
  "task_signoff",
  "track_create",
  "track_update",
  "friction_add",
  "lesson_add",
  "desk_save",
  // Teammate notes (Crew)
  "note",
  // Search
  "desk_search",
  "desk_recall",
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

const HAND_WRITTEN_DESCRIPTIONS = {
  task_create:
    "Use when new work needs its own card: create a task card at <track>/<slug>/task.md. `slug` must be an outcome name: 1-6 lowercase kebab-case words, at most 48 characters, not prompt-like or credential-like; a rejection says what to fix.",
  task_update:
    "Use when an existing task card changes (direct edits are denied). Merge `frontmatter`, record progress with `note` and `next_step`, put rulings and evidence pointers in `log` (a dated entry in log.md beside the card; cheap, rapid entries share one commit), or change `step`, `resource` or a section. A move to `done` needs `evidence`; a done/cancelled result carries archive_due: the owning main agent calls task_archive. To move or rename, pass `to_track`, `to_slug`, `unarchive` or `into_task` alone.",
  task_archive:
    "Use when a task's work is finished or cancelled: move <track>/<slug>/ to <track>/_archive/<slug>/. A task not yet done or cancelled needs `evidence` or `outcome: \"cancelled\"`. Returns archive_pending with the retained path and next_action when publication is unproven; that is not completed publication. Repeating an archived task is safe.",
  task_signoff:
    "Record the operator's answer to a delivered task: accepted or refused. Call it only after the operator has answered, in a turn after the one that delivered the work. A refusal needs `reason` (theirs) and `return_reason` (your own reading) and puts the task back to processing. A subagent never calls this.",
  task_focus:
    "Declare the task this session is working on, so its time is credited to it. Pass `track` and `slug` of an existing card (live or archived), or `clear: true` for a side conversation. Main agent only; a subagent never calls it. Writes nothing. Returns `task_status`, `recent_progress`, `next_step`, any `shelved_lessons` to read before you act, and `archive_due` for a done/cancelled card. `task_create` with `focus: true` does the same for a new task.",
  track_create:
    "Use when new work needs its own track: create a track at <slug>/track.md. `slug` must be an outcome name (1-6 lowercase kebab-case words, at most 48 characters) and `scope` is required: one line, at most 240 characters, \"<what belongs>; not <what doesn't>\". A rejection says what to fix. On a Git desk it stages and commits the new track.md; a commit failure keeps the written file and is reported in a `commit` field.",
  track_update:
    "Merge frontmatter or append to the body of an existing track.md. `frontmatter.scope`, if set, is validated as track_create validates it. On a Git desk it stages and commits the track.md when that file held no unstaged changes before the write, so a track.md another session had already changed is written but left uncommitted; a commit failure keeps the written file and is reported in a `commit` field. To rename the track, pass `rename_to` alone; the input schema has the rest.",
  friction_add:
    "Use when something got in your way and should be recorded: append a friction entry to _meta/friction.md, or under <track>/_friction/ when `track` is given. `about` is \"setup\" (default, kept on the desk) or \"system\" (Desk, its skills or the factory); system friction needs a one-line `title` and opens an improvement card. Read `improvement` in the result: opened, duplicate or reopened means the card exists. `error_code` reports a Desk failure with its evidence (friction-management has the rest).",
  lesson_add:
    "Record a correction where something loads it, and read `in_effect` and `message` in the reply before you tell anyone the lesson is kept. `scope` \"personal\" adds a one-line rule to this person's AGENTS.md; \"desk\" is for how Desk's tools or a plugin's skills behave: it needs `owner` and opens an improvement card; \"team\" adds a line to a shared repository's AGENTS.md through a pull request: it needs `source`.",
  note:
    "In a Crew shared workspace, leave another member a dated note that their session start lists until they acknowledge it (`to`, `subject`, `body`), or acknowledge one a teammate left you (`ack`). `body` is your own explanation in your own voice: relay what someone else thinks as your understanding of it, never in their words. Everyone in the workspace can read it, so put nothing private in it. A note is left only when the reply says `merged`.",
  desk_save:
    "After you write a file with Write or Edit (a planning doc, a spec, a report), call this with its path to commit it. `paths` are relative to the desk root, inside this session's write prefix (desks/<alias>/ in a shared workspace). Stages and commits exactly `paths` with `message`. A task card is refused: use the task tools. `tidy: true` commits a desk tidy or its undo. A client with no filesystem passes `files` ({ path, content } text) with or instead of `paths`.",
  improvement_open:
    "Use when a case needs an improvement card: open one on the desk, find it already open, or reopen a closed one. `source` and `id` name the case (the card key is <source>:<id>). Desk builds every title, and a passed `title` is refused as `title_not_allowed`.",
  improvement_update:
    "Use when you ship, release or close a card you hold the claim on, with its `key` and `claim_id`: ship it (`countermeasure` is the pull request URL; `state` \"shipped\" or omitted), release it (`state` \"open\") or close it (`state` \"closed_unverified\" with `close_reason`).",
}

export const TOOL_DESCRIPTIONS = Object.freeze({
  ...HAND_WRITTEN_DESCRIPTIONS,
  ...Object.fromEntries(Object.entries(ACTION_TOOLS).map(([name, tool]) => [name, tool.description])),
})

// The MCP annotations tools/list serves with each tool (readOnlyHint and the rest), by tool name: today the ones the
// declarations in actions/ generate. The Ouro AX census reads a tool's read-only evidence here (ax/walkers/mcp.mts).
export const TOOL_ANNOTATIONS = Object.freeze(Object.fromEntries(Object.entries(ACTION_TOOLS).map(([name, tool]) => [name, tool.annotations])))
