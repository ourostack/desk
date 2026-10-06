// Every Desk MCP tool's declared input schema lists exactly the fields its
// handler reads — no more, no fewer.
//
// Regression (2026-09-29): `friction_add`'s schema declared only `track`,
// `theme` and `body`, but its handler (`tools/friction.js`) also reads
// `about`, `file_card`, `title`, `plugin`, `friction_class`, `signal` and
// `evidence_jobs`. A host builds its tool-call arguments from the declared
// schema, so a field the handler accepts but the schema omits is a field no
// host can ever send.
//
// Mechanism: each handler module exports an explicit `<TOOL>_FIELDS` array
// colocated with the function that reads `input`/`values`, so a field added
// to a handler's own destructuring/lookup is a field the same diff must add
// to that list — the fix round 4 tools already do half of this
// (`OPTIONAL_RUNTIME_FIELDS` in tools/task.js, `OPTIONAL_TRACK_FIELDS` in
// tools/track.js), just not exported or checked against the schema. A
// generic (reflection/AST) parity check was ruled out: handlers in this
// codebase read `input` in shapes a single static rule can't cover without
// false positives/negatives — direct destructuring
// (`const { track, slug } = values`), a loop over a module-local optional-
// fields array, a field read three call-frames away inside a query-router-
// dispatched `indexed*` helper (desk_search, desk_recall, desk_similar,
// desk_timeline, desk_thread), and one tool (`desk_doctor`) whose top-level
// fields (`format`, `repair`) are actually read by its session-layer
// dispatcher (`runtime/desk-session.js`), not by the module `server.js`
// registers for it (`tools/doctor.js`, which only ever sees `{ format }`).
// Explicit, hand-audited field lists next to each real reader are the
// robust option available without a bigger refactor of how those tools
// consume input.
//
// desk_status takes no input at all (NO_INPUT_TOOLS, per tool_schemas.test.js)
// and is included here with an empty field list for the same reason.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { TOOL_NAMES } from "../../../../plugins/desk/mcp/src/tool-names.js"
import { NO_INPUT_TOOLS, TOOL_INPUT_SCHEMAS } from "../../../../plugins/desk/mcp/src/tool-schemas.js"

import { TASK_CREATE_FIELDS, TASK_UPDATE_FIELDS, TASK_ARCHIVE_FIELDS } from "../../../../plugins/desk/mcp/src/tools/task.js"
import { TASK_FOCUS_FIELDS } from "../../../../plugins/desk/mcp/src/tools/task-focus.js"
import { TASK_SIGNOFF_FIELDS } from "../../../../plugins/desk/mcp/src/tools/task-signoff.js"
import { TASK_MOVE_FIELDS, TRACK_RENAME_FIELDS } from "../../../../plugins/desk/mcp/src/tools/move.js"
import { TRACK_CREATE_FIELDS, TRACK_UPDATE_FIELDS } from "../../../../plugins/desk/mcp/src/tools/track.js"
import { IMPROVEMENT_OPEN_FIELDS, IMPROVEMENT_NEXT_FIELDS, IMPROVEMENT_UPDATE_FIELDS } from "../../../../plugins/desk/mcp/src/tools/improvement.js"
import { FRICTION_ADD_FIELDS } from "../../../../plugins/desk/mcp/src/tools/friction.js"
import { LESSON_ADD_FIELDS } from "../../../../plugins/desk/mcp/src/tools/lesson.js"
import { DESK_SAVE_FIELDS } from "../../../../plugins/desk/mcp/src/tools/desk-save.js"
import {
  DESK_SEARCH_FIELDS,
  DESK_RECALL_FIELDS,
  DESK_SIMILAR_FIELDS,
  DESK_TIMELINE_FIELDS,
} from "../../../../plugins/desk/mcp/src/tools/search.js"
import { DESK_THREAD_FIELDS } from "../../../../plugins/desk/mcp/src/tools/thread.js"
import { DESK_REINDEX_FIELDS } from "../../../../plugins/desk/mcp/src/tools/reindex.js"
import { DESK_STATUS_FIELDS } from "../../../../plugins/desk/mcp/src/tools/status.js"
import { DESK_DOCTOR_FIELDS } from "../../../../plugins/desk/mcp/src/runtime/desk-session.js"

// One entry per tool in TOOL_NAMES, each the exported field list colocated
// with that tool's real handler (see the header for which module that is).
const HANDLER_FIELDS = {
  task_create: TASK_CREATE_FIELDS,
  task_update: TASK_UPDATE_FIELDS,
  task_archive: TASK_ARCHIVE_FIELDS,
  task_move: TASK_MOVE_FIELDS,
  task_focus: TASK_FOCUS_FIELDS,
  task_signoff: TASK_SIGNOFF_FIELDS,
  track_create: TRACK_CREATE_FIELDS,
  track_update: TRACK_UPDATE_FIELDS,
  track_rename: TRACK_RENAME_FIELDS,
  friction_add: FRICTION_ADD_FIELDS,
  lesson_add: LESSON_ADD_FIELDS,
  desk_save: DESK_SAVE_FIELDS,
  desk_search: DESK_SEARCH_FIELDS,
  desk_recall: DESK_RECALL_FIELDS,
  desk_similar: DESK_SIMILAR_FIELDS,
  desk_timeline: DESK_TIMELINE_FIELDS,
  desk_thread: DESK_THREAD_FIELDS,
  desk_reindex: DESK_REINDEX_FIELDS,
  desk_status: DESK_STATUS_FIELDS,
  desk_doctor: DESK_DOCTOR_FIELDS,
  improvement_open: IMPROVEMENT_OPEN_FIELDS,
  improvement_next: IMPROVEMENT_NEXT_FIELDS,
  improvement_update: IMPROVEMENT_UPDATE_FIELDS,
}

test("HANDLER_FIELDS names exactly the tools in TOOL_NAMES, once each", () => {
  assert.deepEqual(Object.keys(HANDLER_FIELDS).sort(), [...TOOL_NAMES].sort())
})

test("every handler field list holds unique field names", () => {
  for (const [name, fields] of Object.entries(HANDLER_FIELDS)) {
    assert.deepEqual([...fields].sort(), [...new Set(fields)].sort(), `${name}: duplicate field in its own FIELDS list`)
  }
})

test("every tool's schema declares exactly the fields its handler reads", () => {
  for (const name of TOOL_NAMES) {
    const declared = Object.keys(TOOL_INPUT_SCHEMAS[name].properties).sort()
    const accepted = [...HANDLER_FIELDS[name]].sort()
    assert.deepEqual(
      declared,
      accepted,
      `${name}: schema declares ${JSON.stringify(declared)} but the handler reads ${JSON.stringify(accepted)}`,
    )
  }
})

test("a tool with no input (NO_INPUT_TOOLS) has an empty handler field list", () => {
  for (const name of NO_INPUT_TOOLS) {
    assert.deepEqual(HANDLER_FIELDS[name], [])
  }
})

test("the task_update schema lists return_reason with its four values", () => {
  const property = TOOL_INPUT_SCHEMAS.task_update.properties.return_reason
  assert.equal(property.type, "string")
  assert.deepEqual(property.enum, ["agent_error", "changed_ask", "new_information", "external"])
  assert.ok(!TOOL_INPUT_SCHEMAS.task_update.required.includes("return_reason"))
})
