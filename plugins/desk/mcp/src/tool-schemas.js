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

import { LEDGER_ACTIONS } from "./measurement/actions.js"

export const DOCTOR_REPAIRS = Object.freeze(["switch_state_branch", "reclaim_controller", "prune_readiness_state"])

// Tools that take no input at all. Only these may declare no properties.
export const NO_INPUT_TOOLS = Object.freeze(["desk_status"])

const text = (description) => ({ type: "string", description })
const flag = (description) => ({ type: "boolean", description })
const integer = (description) => ({ type: "integer", minimum: 1, description })
const list = (description) => ({ type: "array", items: { type: "string" }, description })
const anyValue = (description) => ({ description })

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

function schema(properties, required = []) {
  return Object.freeze({ type: "object", properties, required, additionalProperties: false })
}

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

// Every field any desk_work_ledger action accepts. The ledger itself refuses
// a field the chosen action does not take.
const LEDGER_FIELDS = {
  request: text("intake: the request as the requester stated it."),
  requested_by: text("intake: who asked."),
  request_key: text("intake: an idempotency key for the request."),
  work_item_id: text("The work item the action applies to."),
  outcome: text("commit: the one independently assessable outcome."),
  scope: text("commit, size: what the work covers."),
  evidence: text("commit, complete, work_design_ruling: the evidence for the record."),
  delivery_endpoint: text("commit: where the outcome is delivered."),
  operator_go: anyValue("commit: the operator's go for the work."),
  task_ref: anyValue("commit: the Desk task card this work item belongs to."),
  work_type: text("size: the kind of work."),
  systems: list("size: the systems the work touches."),
  uncertainty: text("size: how uncertain the work is."),
  risk: text("size: how risky the work is."),
  verification: text("size: how the outcome will be verified."),
  phase: text("phase, run_contract, cycle, work_design_ruling: the phase name."),
  cycle: anyValue("phase: the cycle label; cycle, work_design_ruling: the cycle number (a positive integer)."),
  started_at: text("phase: when the phase started (ISO 8601)."),
  ended_at: text("phase: when the phase ended (ISO 8601)."),
  state: text("phase, close: the state to record."),
  kind: text("scope_change: the kind of change."),
  change: text("scope_change: what changed."),
  reason: text("The reason for the record."),
  agreed_by: text("scope_change: who agreed to the change."),
  related_work_item_id: text("link: the other work item."),
  relation: text("link: how the two work items relate."),
  endpoint: text("complete: the endpoint reached."),
  field: text("correct: the field to correct."),
  value: anyValue("correct: the corrected value (null clears it)."),
  expected_revision: anyValue("correct, cost_basis: the revision the correction expects to replace."),
  confirm: flag("delete: must be true to delete."),
  include_phase_span: flag("report: include the phase span."),
  since: text("review, import_usage: start of the window (ISO 8601)."),
  until: text("review, import_usage: end of the window (ISO 8601)."),
  carry_forward: anyValue("review: items to carry forward."),
  progress_signal: text("run_contract: what shows progress."),
  failure_signal: text("run_contract: what shows failure."),
  non_convergence_rule: text("run_contract: when the loop counts as not converging."),
  scope_envelope: anyValue("run_contract: the exact files and directories the work may change."),
  fallback_paths: anyValue("run_contract: the fallback paths if the work does not converge."),
  candidate_ref: text("cycle: the candidate under evaluation."),
  boundary: text("cycle: the boundary that judged the candidate."),
  result: text("cycle: the boundary's result."),
  progress_evidence: text("cycle: the evidence of progress."),
  finding_fingerprint: text("cycle: a fingerprint of the findings."),
  open_findings: list("cycle: findings still open."),
  closed_findings: list("cycle: findings closed in this cycle."),
  write_set: anyValue("cycle: the files the cycle changed."),
  discriminator: { type: "object", additionalProperties: true, description: "cycle: the discriminator object." },
  trigger: text("work_design_ruling: what triggered the ruling."),
  decision: text("work_design_ruling: the decision."),
  cost_if_wrong: text("work_design_ruling: the cost if the ruling is wrong."),
  source: text("import_usage, cost_basis: the source of the facts."),
  session_id: text("import_usage: the host session to import."),
  machine_id: text("import_usage: the machine the session ran on."),
  amount: { type: "number", description: "cost_basis: the amount." },
  currency: text("cost_basis: the currency."),
  rate: { type: "number", description: "cost_basis: the rate." },
  rate_unit: text("cost_basis: the rate's unit."),
  effective_date: text("cost_basis: when the cost basis takes effect."),
  enabled: flag("set_recording: whether recording is on."),
  measurement_kind: text("link_evaluation_receipt: the kind of measurement."),
  receipt_ref: text("link_evaluation_receipt: the receipt reference."),
  receipt_sha256: text("link_evaluation_receipt: the receipt's SHA-256 digest."),
  run_set_id: text("link_evaluation_receipt: the run set."),
  run_id: text("link_evaluation_receipt: the run."),
  case_id: text("link_evaluation_receipt: the case."),
  status: text("link_evaluation_receipt: the receipt status."),
  grade: text("link_evaluation_receipt: the grade."),
  availability: text("link_evaluation_receipt: the receipt's availability."),
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
    repos: anyValue("The code repositories the task works in, per the task-card format."),
    iterations: anyValue("The task's iterations, per the task-card format."),
    predecessor: anyValue("The task this one continues."),
  }, ["track", "slug", "title"]),
  task_update: schema({ ...TASK_TARGET, ...CARD_UPDATE }, ["track", "slug"]),
  task_archive: schema(TASK_TARGET, ["track", "slug"]),
  task_move: schema({
    ...TASK_TARGET,
    to_track: text("The destination track; its track.md must already exist."),
    to_slug: text("The new task folder name: an outcome name."),
    unarchive: flag("Reopen an archived task into a live folder."),
    into_task: text("Merge this duplicate task into the named keeper task."),
    allow_dirty: flag("Move even though the folder has unstaged or untracked changes."),
  }, ["track", "slug"]),
  track_create: schema({
    slug: text("The track folder name: an outcome name, 2-6 lowercase kebab-case words."),
    title: text("The track title."),
    scope: text("One line, at most 240 characters: \"<what belongs>; not <what doesn't>\"."),
    status: text("Initial status; defaults to active."),
    body: text("Markdown body, without frontmatter."),
    predecessor: anyValue("The track this one continues."),
    adopted_from: anyValue("Where the track was adopted from, per the track-card format."),
    planning: text("Path to the track's planning document."),
  }, ["slug", "title", "scope"]),
  track_update: schema({ slug: text("The track folder name."), ...CARD_UPDATE }, ["slug"]),
  track_rename: schema({
    track: text("The track folder to rename."),
    to: text("The new track folder name: an outcome name."),
    allow_dirty: flag("Rename even though the track has unstaged or untracked changes."),
  }, ["track", "to"]),
  friction_add: schema({
    track: text("Track for a track-local entry; omit for the cross-cutting log."),
    theme: text("Short slug for a track-local entry's filename; defaults to untitled."),
    body: text("The entry body, without surrounding --- separators."),
  }, ["body"]),
  lesson_add: schema({
    topic: text("The lesson topic; slugified for the filename."),
    body: text("Markdown body."),
  }, ["topic", "body"]),
  desk_work_ledger: schema({
    action: { type: "string", enum: Object.keys(LEDGER_ACTIONS), description: "The ledger action; `capabilities` lists the fields each action takes." },
    ...LEDGER_FIELDS,
  }, ["action"]),
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
  desk_status: schema({}),
  desk_doctor: schema({
    format: { type: "string", enum: ["full", "preview"], description: "preview returns only the local package/process snapshot." },
    repair: { type: "string", enum: [...DOCTOR_REPAIRS], description: "A named repair to run." },
  }),
})
