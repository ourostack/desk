// The JSON input schema every Desk MCP tool advertises in tools/list.
//
// A host builds its tool-call arguments from these. An empty schema
// (`{ properties: {}, additionalProperties: true }`) tells the host nothing,
// so Claude Code sent task_update's `frontmatter` as a JSON string and the
// card was corrupted (2026-09-27). Every tool declares its properties and its
// required fields here; __tests__/tool_schemas.test.js fails if a tool in
// TOOL_NAMES has no schema, declares no properties (unless it takes no input
// at all), leaves a property undescribed or lists a required field it does
// not declare.
//
// The tools still validate their own input: the server does not enforce these
// schemas, and a host may not either.
//
// Dependency-free, like tool-names.js: the front door serves these before the
// runtime pack is restored.

import { flag, integer, list, oneOf, schema, text } from "./tool-schema-parts.js"

export const DOCTOR_REPAIRS = Object.freeze(["switch_state_branch"])

// Tools that take no input at all. Only these may declare no properties.
export const NO_INPUT_TOOLS = Object.freeze([])

const SCOPE = {
  type: "string",
  enum: ["active", "archived", "all"],
  description: "Which documents to search: live work, archived work, or both.",
}
const LIMIT = integer("Maximum number of results.")
const oneOrMany = (description) => ({
  anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  description,
})


const TASK_TARGET = {
  track: text("The track folder the task lives in."),
  slug: text("The task folder name."),
}

const DISPLAY_LABEL = text("Optional short description of the focused task, at most 72 characters; never paths, URLs, emails or credentials. Unsafe labels are ignored.")

const CONTENT_HOME = {
  type: "object",
  additionalProperties: false,
  properties: {
    purpose: text("A purpose from the repository's .desk/content-home.json, or `mixed` (then `sections` is required)."),
    lifecycle: { type: "string", enum: ["current", "historical"] },
    product_repository: { type: "string" },
    source_reference: text("Original provenance and restrictions, or unknown."),
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: text("What the section covers: a task_update field such as `note` or `body_append`, `files/<index>/content` or `paths/<index>` for desk_save."),
          start: integer("Inclusive UTF-8 byte offset; omit to cover the whole subject."),
          end: integer("Exclusive UTF-8 byte offset; omit to cover the whole subject."),
          purpose: { type: "string" },
          lifecycle: { type: "string", enum: ["current", "historical"] },
          product_repository: { type: "string" },
          source_reference: { type: "string" },
        },
        required: ["subject", "purpose", "lifecycle"],
      },
      description: "For `mixed`: classify every subject's bytes once, in order, with no gaps or overlaps, with the same four fields as above.",
    },
  },
  required: ["purpose"],
  description: "Required only where the repository publishes .desk/content-home.json: `lifecycle` is current or historical, `product_repository` the owner/repository of current product material. A refusal says what to declare.",
}

const CARD_UPDATE = {
  frontmatter: {
    type: "object",
    additionalProperties: true,
    description: "Fields to merge into the card's frontmatter, as a JSON object (not a string). A `status` must be one of drafting, processing, validating, collaborating, paused, blocked, done, cancelled.",
  },
  body_append: text("Markdown to append to the card body, separated by a blank line."),
}

const REPOS_REMOVED_REASON = text("One line on why. Required to remove every repo from a card; not with `status: done`, and not needed with `status: cancelled`.")

const RETURN_REASON = {
  type: "string",
  enum: ["agent_error", "changed_ask", "new_information", "external"],
  description: "Required when the task goes backwards (out of `done`, or below its furthest stage), refused otherwise: agent_error is your mistake, changed_ask the operator's new ask, new_information something nobody knew, external an outside break.",
}

// Mirrors STEP_STATES in src/desk/steps.js, less the states Desk derives (DERIVED_STATES) (this file stays free of imports).
const STEP = {
  type: "object",
  properties: {
    id: text("The step's name: short kebab-case, unique on the card, never renamed. An unknown name adds a row."),
    state: { type: "string", enum: ["pending", "in progress", "blocked", "dropped"], description: "A new step starts pending. `blocked` and `dropped` need `reason`. Desk sets `in review`, `merged` and `delivered` itself from the PR URL in `evidence`." },
    depends_on: list("Steps that must be delivered or dropped first; empty for none. Needed for a new step; changes only while pending."),
    repo: text("One of the card's repos, or \"—\" for none. Needed for a new step; changes only while pending."),
    evidence: text("The PR URL that backs the step, `task:<track>/<slug>` for a step delegated to its own card, or a line on where it stands."),
    reason: text("Why the step is blocked or dropped."),
    expect: text("The state you last saw; if the step is in another state, nothing is written."),
    dependents_ok: list("When dropping: dependent steps that are still valid; the others become blocked."),
  },
  required: ["id"],
  additionalProperties: false,
  description: "One row of the card's `## Steps` table.",
}

// Mirrors DISPOSITIONS and RESOURCE_FIELDS in src/desk/resources.js.
const RESOURCE = {
  type: "object",
  properties: {
    identity: text("`worktree:<absolute path>` or `branch:<owner/repo>#<name>` (`<org/project/repo>` for Azure DevOps) that you created. A known identity updates its row."),
    step: text("The step in the card's `## Steps` table that owns it; cleanup is due when that step is delivered or dropped."),
    intended: text("What you intend to do with it, in a few words."),
    disposition: { type: "string", enum: ["removed-and-absent", "named transfer", "retained-with-trigger"], description: "Record once the resource is dealt with; needs `details`. Desk removes nothing." },
    details: text("With `disposition`: the readback that it is gone; who took it and acknowledged; or why it stays, who owns it and what triggers its cleanup."),
    migrate: {
      type: "object",
      properties: Object.fromEntries(["identity", "owner", "writers", "intended", "evidence", "terminal"].map((key) => [key,
        key === "identity" ? { type: "string" } : oneOf([{ type: "string" }, { type: "null" }]),
      ])),
      required: ["identity", "owner", "writers", "intended", "evidence", "terminal"],
      additionalProperties: false,
      description: "Legacy Resources table recovery, applied with this row write: map each of the six fields to an existing column name (case-insensitive), or null if absent (not for identity); task-card-format has the rules. Live cards only.",
    },
  },
  required: ["identity"],
  additionalProperties: false,
  description: "One row of the card's `## Resources` table.",
}

const TASK_PROGRESS = {
  note: text("One line of progress, appended as `- <date>: <note>` under `## Progress log`. Say only what happened; completion needs `status: done` with `evidence`."),
  next_step: text("Replaces the card's `**Next step:**` paragraph."),
}

const REPLACE_SECTION = {
  type: "object",
  properties: {
    heading: text("The section's name without the `## `, such as `Progress log`; a missing section is appended."),
    markdown: text("The section's new text, without its heading. The only way to replace a section."),
  },
  required: ["heading", "markdown"],
  additionalProperties: false,
  description: "Replace the body of one `## ` section; the frontmatter is untouched.",
}

const TASK_DONE_EVIDENCE = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["pr", "commit", "ci_run", "non_code", "steps"], description: "What kind of reference this is. `steps` closes a card that has a `## Steps` table and needs no `ref`." },
    ref: text("Not needed for `steps`. A PR URL for pr; a 7-40 character hex commit sha (optionally with repo/branch) or commit URL for commit; the run's https URL for ci_run; an https URL or desk-relative path to the proof for non_code."),
  },
  required: ["kind"],
  description: "A JSON object, required when this call moves a task into `done` (task_update), or archives one not already `done` or `cancelled` without `outcome: \"cancelled\"` (task_archive). A card with a `## Steps` table finishes only with `{ kind: \"steps\" }`; a card listing `repos` only with `pr` or a pushed `commit` in one of them (task-card-format has the rules). A refusal says what to supply.",
}

const TASK_ARCHIVE_OUTCOME = {
  type: "string",
  enum: ["cancelled"],
  description: 'Pass "cancelled" to archive a task not already `done` or `cancelled` as abandoned work, with no `evidence`. Omit otherwise.',
}

export const TOOL_INPUT_SCHEMAS = Object.freeze({
  task_create: schema({
    ...TASK_TARGET,
    slug: text("The task folder name: an outcome name, 2-6 lowercase kebab-case words."),
    title: text("The task title."),
    status: text("Initial status; defaults to drafting. One of drafting, processing, validating, collaborating, paused, blocked, done, cancelled."),
    body: text("Markdown body, without frontmatter."),
    focus: flag("Pass true to also declare this task as the session's focus (as task_focus does), for work that starts now. Main agent only."),
    display_label: DISPLAY_LABEL,
    intake_proposal: {
      type: "object",
      additionalProperties: false,
      properties: {
        outcome: text("The requested outcome and its purpose, reflecting the supplied scope."),
        assumptions: text("Your actual material assumptions and defaults, including runtime, input/data and error behavior for code."),
        recommended_decisions: text("Routine technical defaults you settled, and every remaining human decision together; say plainly when all are settled."),
        completion_checks: text("Concrete completion terms: usable output, usage/documentation and specific behavioral, edge and error verification as applicable."),
      },
      required: ["outcome", "assumptions", "recommended_decisions", "completion_checks"],
      description: "For a new, unapproved focused drafting outcome: your complete first-reply proposal, supplied before the card exists (start-task has the rules). Stored on the card and returned as alignment_packet; present all four contents together in normal chat, never ask_user or a form, before any confirmation. Omit for approved, resumed or parked work.",
    },
    category: text("general | reminder | coordination | infrastructure | another category."),
    cadence: text("Recurring cadence, such as 30m."),
    scheduledAt: text("One-time scheduled time (ISO 8601)."),
    requester: text("Who asked for the task."),
    validator: text("Who validates completion."),
    artifacts: list("Outputs the task produced, such as PR URLs or file paths."),
    active_bridge: text("The bridge ID this task records."),
    bridge_sessions: list("Session IDs the bridge coordinates."),
    planning_complete: flag("Skip brainstorming and planning; resume at implementation."),
    adopted_at: text("When the task entered the workspace (ISO 8601)."),
    repos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          local_path: text("Where it is cloned, as a tilde path; empty when not cloned."),
          mode: { type: "string", enum: ["local", "remote"] },
          url: text("Where to clone it from if the clone is missing; optional."),
        },
        required: ["name"],
        additionalProperties: true,
      },
      description: "The code repositories the task works in (task-card-format has the shape); `mode` is local (cloned) or remote (read through the API).",
    },
    iterations: {
      type: "object",
      properties: {
        active: oneOf([{ type: "string" }, { type: "null" }]),
        history: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      additionalProperties: true,
      description: "The task's iterations: `active` is the running iteration's relative path or null, `history` has one entry per iteration.",
    },
    predecessor: { type: "object", additionalProperties: true, description: "The task this one continues, such as { track, slug }." },
    initiated_by: { type: "string", enum: ["operator", "agent"], description: "Who started the task: the operator asked, or the agent recognized the work." },
    origin_note: text("When the agent started the task: one line on what it noticed."),
    steps: { type: "array", items: STEP, description: "The outcome's steps, in order, written as the card's `## Steps` table. A new step needs `id`, `repo` and `depends_on`." },
  }, ["track", "slug", "title"]),
  task_update: schema({ ...TASK_TARGET, status: text("Shorthand for `frontmatter.status`: one of drafting, processing, validating, collaborating, paused, blocked, done, cancelled. Moving to `done` needs `evidence`."), ...CARD_UPDATE, ...TASK_PROGRESS, evidence: TASK_DONE_EVIDENCE, repos_removed_reason: REPOS_REMOVED_REASON, return_reason: RETURN_REASON, step: STEP, resource: RESOURCE, display_label: DISPLAY_LABEL, replace_section: REPLACE_SECTION, content_home: CONTENT_HOME }, ["track", "slug"]),
  task_archive: schema({ ...TASK_TARGET, evidence: TASK_DONE_EVIDENCE, outcome: TASK_ARCHIVE_OUTCOME }, ["track", "slug"]),
  task_signoff: schema({
    track: text("The track folder of the delivered task."),
    slug: text("The task folder name."),
    outcome: { type: "string", enum: ["accepted", "refused"], description: "The operator's answer; refused sends the task back to processing." },
    // Mirrors REFUSAL_REASONS in src/factory/outcome.js (this file stays free of imports).
    reason: { type: "string", enum: ["not_what_was_asked", "defect", "changed_ask", "incomplete", "other"], description: "Required when refused, not allowed when accepted: the operator's reason, mapped from what they said." },
    return_reason: { ...RETURN_REASON, description: "Required when refused, not allowed when accepted: your own reading of the cause. agent_error is your mistake, changed_ask the operator's new ask, new_information something nobody knew, external an outside break." },
  }, ["track", "slug", "outcome"]),
  task_focus: schema({
    track: text("The track folder of the task you are working on; give it with `slug`."),
    slug: text("The task folder name; give it with `track`."),
    clear: flag("Pass true, alone, to declare no task: for a side conversation that belongs to none."),
    display_label: DISPLAY_LABEL,
  }),
  task_move: schema({
    ...TASK_TARGET,
    handle: text("The task's handle from active_tasks, desk_status `detail: true` or a desk_doctor finding, in place of track and slug; use it for a name shown as <redacted segment>."),
    to_track: text("The destination track; its track.md must already exist."),
    to_slug: text("The new task folder name: an outcome name."),
    unarchive: flag("Reopen an archived task into a live folder."),
    into_task: text("Merge this duplicate task into the named keeper task."),
    allow_dirty: flag("Move even though the folder has unstaged or untracked changes."),
  }),
  track_create: schema({
    slug: text("The track folder name: an outcome name, 2-6 lowercase kebab-case words."),
    title: text("The track title."),
    scope: text("One line, at most 240 characters: \"<what belongs>; not <what doesn't>\"."),
    status: text("Initial status; defaults to active."),
    body: text("Markdown body, without frontmatter."),
    predecessor: { type: "object", additionalProperties: true, description: "The track this one continues: { slug, title, status }." },
    adopted_from: { type: "object", additionalProperties: true, description: "Where the track was adopted from: { source_path, source_sha, adopted_at, adopted_by }." },
    planning: text("Path to the track's planning document."),
  }, ["slug", "title", "scope"]),
  track_update: schema({ slug: text("The track folder name."), ...CARD_UPDATE }, ["slug"]),
  track_rename: schema({
    track: text("The track folder to rename."),
    handle: text("The track's handle from the boot result's active_tasks, desk_status with detail: true, or a desk_doctor finding, in place of track; use it for a name shown as <redacted segment>."),
    to: text("The new track folder name: an outcome name."),
    allow_dirty: flag("Rename even though the track has unstaged or untracked changes."),
  }, ["to"]),
  friction_add: schema({
    track: text("Track for a track-local entry; omit for the cross-cutting log."),
    theme: text("Short slug for a track-local entry's filename; defaults to untitled."),
    body: text("The entry body, without surrounding --- separators."),
    about: {
      type: "string",
      enum: ["setup", "system"],
      description: "What the friction is about. \"setup\" (default): this desk's own setup, kept on the desk. \"system\": Desk itself (its skills, tools or the factory); an improvement card opens by itself.",
    },
    title: text("Required when about is \"system\": the card's title, on one line."),
    plugin: text("For \"system\": the plugin the friction is in; defaults to \"desk\"."),
    friction_class: {
      type: "string",
      // Mirrors FRICTION_CLASSES in src/factory/kaizen-file.js.
      enum: ["guard", "hook", "mcp_tool", "skill", "factory", "release", "ci", "docs", "other"],
      description: "For \"system\": the kind of friction; defaults to \"other\".",
    },
    signal: text("For \"system\": the rollups measure the friction moves, when known."),
    evidence_jobs: list("For \"system\": factory job ids that show the friction."),
    file_card: flag("For \"system\": also file the store's kaizen issue now, instead of leaving it to the loop."),
    error_code: text("Reports a Desk failure: the code its message gave, such as desk_push_blocked. Records the failure and the Desk version, host and sync status as system friction; `body` and `title` are then optional."),
  }, []),
  lesson_add: schema({
    scope: {
      type: "string",
      enum: ["personal", "desk", "team"],
      description: "Whose behaviour the lesson changes. \"personal\": this person's preference, in their AGENTS.md. \"desk\": how Desk's tools or an installed plugin's skills behave; needs `owner`. \"team\": every teammate's agents in a shared repository; needs `source`.",
    },
    topic: text("The rule's short name, on one line; a later lesson with the same topic replaces it."),
    body: text("The rule, on one line."),
    owner: text("Required for \"desk\": skill:<plugin>:<skill>, tool:<Desk tool name>, brief (the brief every child agent gets) or foundation (the always-on using-desk text)."),
    repo: text("For \"team\": the path of your local clone of the team's repository. Defaults to the desk in a shared workspace."),
    source: text("Required for \"team\": where the lesson comes from, on one line: the decision record's path where the repository has _shared/decisions/, else who said it, where and when (YYYY-MM-DD)."),
  }, ["scope", "topic", "body"]),
  note_leave: schema({
    to: text("The alias of the member the note is for, as in the roster (_meta/desks.md)."),
    subject: text("What the note is about, on one line of at most 120 characters."),
    body: text("The note, in your own voice, at most 8000 characters. Relay someone else's thinking as your understanding of it, never in their words. Everyone in the workspace can read it."),
    related: list("Up to 10 links: https URLs, or paths relative to the workspace root."),
  }, ["to", "subject", "body"]),
  note_ack: schema({
    note: text("The note's path as session start listed it, or its file name."),
  }, ["note"]),
  desk_save: schema({
    content_home: CONTENT_HOME,
    paths: list("The paths to commit, relative to the desk root. Required unless `files` is given."),
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: text("Where to write the file, relative to the desk root."),
          content: text("The file's full content, as UTF-8 text (at most 1 MiB)."),
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      description: "For a client with no filesystem: files to write, then commit with `paths`. A refused entry (outside the desk or write prefix, in .git, .state/ or .github/workflows/, a task card or link) refuses the call before anything is written. Not with `tidy: true`. Required unless `paths` is given.",
    },
    message: text("The commit message."),
    tidy: flag("Pass true to commit a desk tidy or its undo: moved or renamed task cards already staged by task_move, track_rename or git mv, with the old and new path of every move, plus _meta/organization.json. Other staged work stays staged."),
  }, ["message"]),
  desk_search: schema({
    query: text("The search query."),
    limit: LIMIT,
    scope: SCOPE,
    filters: {
      type: "object",
      additionalProperties: false,
      properties: {
        track: oneOrMany("Track name or names."),
        status: oneOrMany("Task status or statuses."),
        kind: oneOrMany("Document kind or kinds."),
        since: text("Only documents updated at or after this time (ISO 8601)."),
        until: text("Only documents updated at or before this time (ISO 8601)."),
      },
      description: "Filters, as a JSON object (not a string).",
    },
  }, ["query"]),
  desk_recall: schema({ topic: text("What to recall."), limit: LIMIT, scope: SCOPE }, ["topic"]),
  desk_timeline: schema({
    from: text("Start of the updated_at window (ISO 8601)."),
    to: text("End of the updated_at window (ISO 8601)."),
    query: text("Optional query to rank documents inside the window."),
    limit: LIMIT,
    scope: SCOPE,
  }),
  desk_reindex: schema({ force: flag("Accepted for compatibility; it changes nothing.") }),
  desk_status: schema({
    detail: flag("Pass true for the full payload (tens of KB). Omit it for the compact answer."),
    has_instructions: flag("Hosted Desk only: pass true when an earlier desk_status answer in this conversation already gave you Desk's instructions."),
  }),
  desk_skill: schema({
    name: text("The skill to read, such as task-lifecycle; omit it to list every skill."),
  }),
  desk_doctor: schema({
    format: { type: "string", enum: ["full", "preview"], description: "preview returns only the local package/process snapshot." },
    repair: { type: "string", enum: [...DOCTOR_REPAIRS], description: "A named repair to run." },
  }),
  improvement_open: schema({
    source: { type: "string", enum: ["andon", "friction_candidate", "reconcile_class", "desk_problem", "store_build", "evaluator", "loop_alarm", "flush_health"], description: "Where the card comes from; the card key is <source>:<id>." },
    id: text("The case's id: owner/repo#number for andon and store_build, ourostack/desk#number for desk_problem, 32 hex for friction_candidate, else a code from the source's closed list."),
    title: text("Never accepted: Desk builds every title (refused as title_not_allowed)."),
    evidence: list("Up to 10 pointers: job:<32 hex>, issue:<owner/repo>#<n>, pr:<owner/repo>#<n>, reconcile:<reason>@<count>, fingerprint:<hex>."),
    plugin: text("The plugin the improvement is in; defaults to \"desk\"."),
    signal: text("The rollups measure the improvement moves, when known."),
  }, ["source", "id"]),
  improvement_next: schema({ session: text("The session's UUID, when known.") }),
  improvement_update: schema({
    key: text("The card's key, as improvement_next returned it."),
    claim_id: text("The claim_id improvement_next returned."),
    state: { type: "string", enum: ["shipped", "open", "closed_unverified"], description: "shipped (with countermeasure; may be omitted then), open (release the claim) or closed_unverified (with close_reason)." },
    countermeasure: text("The pull request URL that ships the fix: https://github.com/<owner>/<repo>/pull/<n>."),
    close_reason: { type: "string", enum: ["wont_fix", "duplicate", "not_reproducible"], description: "Why you close the card; required with state closed_unverified." },
  }, ["key", "claim_id"]),
})
