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

export const DOCTOR_REPAIRS = Object.freeze(["switch_state_branch", "reclaim_controller", "prune_readiness_state"])

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

const CARD_UPDATE = {
  frontmatter: {
    type: "object",
    additionalProperties: true,
    description: "Fields to shallow-merge into the card's frontmatter, as a JSON object (not a string). `schema_version` and `created` are kept; `updated` is refreshed.",
  },
  body_append: text("Markdown to append to the card body, separated by a blank line."),
}

const REPOS_REMOVED_REASON = text("Required to remove every repo from a card that names code repos (a task whose work turned out not to touch them): one line on why, recorded on the card as `repos_removed` with each repo\'s name and the time. The same call may not set `status: done`; finish in a separate call. Not needed when the call sets `status: cancelled`.")

const TASK_PROGRESS = {
  note: text("One line of progress to record: appended as `- <date>: <note>` under the card's `## Progress log` section (created if missing). Say only what actually happened; completion needs `status: done` with `evidence`, never a note."),
  next_step: text("The card's recorded next step: replaces its `**Next step:**` paragraph (added if missing). Use it when the next action changes."),
}

const TASK_DONE_EVIDENCE = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["pr", "commit", "ci_run", "non_code"], description: "What kind of reference this is." },
    ref: text('The verifiable, checkable reference in that kind\'s own shape: a PR URL (GitHub or Azure DevOps) for pr; a 7-40 character hex commit sha, optionally with its repo/branch, or a commit URL for commit; the CI run\'s own https URL for ci_run; or an https URL or desk-relative path to the proof for non_code.'),
  },
  required: ["kind", "ref"],
  description: "Required, as a JSON object (not a string), when this call moves a task into `done` from a non-`done` status: at least one checkable reference backing the completion claim. On task_update, that is any transition whose merged status becomes `done`. On task_archive, that is archiving a task that isn't already `done` or `cancelled`, unless `outcome: \"cancelled\"` is given instead. A task whose card lists `repos` can only be finished with `pr` (a PR URL in one of those repos) or `commit` (a commit that resolves in a recorded clone and is pushed): `ci_run` and `non_code` are refused, and a commit made in the desk never counts. Omit for every other update, including a transition to `cancelled`. Refused with an error naming what to supply when required and this is missing, malformed, or shaped wrong for its kind.",
}

const TASK_ARCHIVE_OUTCOME = {
  type: "string",
  enum: ["cancelled"],
  description: 'Pass "cancelled" to archive a task that is not already `done` or `cancelled` as abandoned work, needing no `evidence`. Omit for a completed task and pass `evidence` instead. An already-`done` or already-`cancelled` task, or one with no task.md at all, needs neither.',
}

export const TOOL_INPUT_SCHEMAS = Object.freeze({
  task_create: schema({
    ...TASK_TARGET,
    slug: text("The task folder name: an outcome name, 2-6 lowercase kebab-case words."),
    title: text("The task title."),
    status: text("Initial status; defaults to drafting."),
    body: text("Markdown body, without frontmatter."),
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
          name: text("The repository name."),
          local_path: text("Where it is cloned, as a tilde path; empty when it is not cloned."),
          mode: { type: "string", enum: ["local", "remote"], description: "local (cloned) or remote (read through the API)." },
          url: text("Where to clone it from, when the clone is missing on a machine; optional."),
        },
        required: ["name"],
        additionalProperties: true,
      },
      description: "The code repositories the task works in, per the task-card format.",
    },
    iterations: {
      type: "object",
      properties: {
        active: oneOf([{ type: "string" }, { type: "null" }], "The running iteration's relative path, or null between iterations."),
        history: { type: "array", items: { type: "object", additionalProperties: true }, description: "One entry per iteration." },
      },
      additionalProperties: true,
      description: "The task's iterations, per the task-card format.",
    },
    predecessor: { type: "object", additionalProperties: true, description: "The task this one continues, such as { track, slug }." },
    initiated_by: { type: "string", enum: ["operator", "agent"], description: "Who started the task: the operator asked, or the agent recognized the work." },
    origin_note: text("When the agent started the task: one line on what it noticed."),
  }, ["track", "slug", "title"]),
  task_update: schema({ ...TASK_TARGET, ...CARD_UPDATE, ...TASK_PROGRESS, evidence: TASK_DONE_EVIDENCE, repos_removed_reason: REPOS_REMOVED_REASON }, ["track", "slug"]),
  task_archive: schema({ ...TASK_TARGET, evidence: TASK_DONE_EVIDENCE, outcome: TASK_ARCHIVE_OUTCOME }, ["track", "slug"]),
  task_move: schema({
    ...TASK_TARGET,
    handle: text("The task's handle from the boot result's active_tasks, desk_status with detail: true, or a desk_doctor finding, in place of track and slug; use it for a name shown as <redacted segment>."),
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
      description: "What the friction is about. \"setup\" (default): friction with this desk's own setup; it stays on the desk. \"system\": friction with Desk itself (its skills, tools or the factory); it becomes a kaizen candidate for the curator.",
    },
    title: text("Required when about is \"system\": the kaizen card's title, on one line."),
    plugin: text("When about is \"system\": the plugin the friction is in; defaults to \"desk\"."),
    friction_class: {
      type: "string",
      // Mirrors FRICTION_CLASSES in src/factory/kaizen-file.js.
      enum: ["guard", "hook", "mcp_tool", "skill", "factory", "release", "ci", "docs", "other"],
      description: "When about is \"system\": the kind of friction; defaults to \"other\".",
    },
    signal: text("When about is \"system\": the rollups measure the friction moves, when known."),
    evidence_jobs: list("When about is \"system\": factory job ids that show the friction, when known."),
    file_card: flag("Curator-only, after its signoff step: file the \"system\" kaizen candidate as a card now instead of leaving it a candidate. Only valid when about is \"system\"."),
  }, ["body"]),
  lesson_add: schema({
    topic: text("The lesson topic; slugified for the filename."),
    body: text("Markdown body."),
  }, ["topic", "body"]),
  desk_save: schema({
    paths: list("The paths to commit, relative to the desk root."),
    message: text("The commit message."),
  }, ["paths", "message"]),
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
  desk_similar: schema({ path: text("The seed document's path relative to the desk root."), limit: LIMIT, scope: SCOPE }, ["path"]),
  desk_timeline: schema({
    from: text("Start of the updated_at window (ISO 8601)."),
    to: text("End of the updated_at window (ISO 8601)."),
    query: text("Optional query to rank documents inside the window."),
    limit: LIMIT,
    scope: SCOPE,
  }),
  desk_thread: schema({
    start_path: text("The starting document's path relative to the desk root."),
    depth: integer("Maximum hop distance; defaults to 4."),
    direction: { type: "string", enum: ["forward", "backward", "both"], description: "Which edges to follow; defaults to both." },
  }, ["start_path"]),
  desk_reindex: schema({ force: flag("Request a full rebuild; it still joins the shared controller's convergence.") }),
  desk_status: schema({
    detail: flag("Pass true for the full payload (index, snapshots, vector packs, embedding spec, admission internals; tens of KB). Omit it for the compact answer: one `state` word, why it is not `ready`, what to do, and pointers."),
  }),
  desk_doctor: schema({
    format: { type: "string", enum: ["full", "preview"], description: "preview returns only the local package/process snapshot." },
    repair: { type: "string", enum: [...DOCTOR_REPAIRS], description: "A named repair to run." },
  }),
})
