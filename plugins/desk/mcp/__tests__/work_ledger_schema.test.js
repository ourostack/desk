// The desk_work_ledger input schema (src/work-ledger-schema.js), kept apart
// from tool_schemas.test.js so retiring the ledger removes this file whole.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { TOOL_INPUT_SCHEMAS } from "../src/tool-schemas.js"
import { LEDGER_ACTIONS } from "../src/measurement/actions.js"

test("the work ledger schema declares every field any action accepts, and every action", () => {
  const ledger = TOOL_INPUT_SCHEMAS.desk_work_ledger
  assert.deepEqual(ledger.properties.action.enum, Object.keys(LEDGER_ACTIONS))
  const accepted = new Set(Object.values(LEDGER_ACTIONS).flat())
  assert.deepEqual([...accepted].sort(), Object.keys(ledger.properties).sort())
})

test("the work ledger's object and list fields are typed", () => {
  const { properties } = TOOL_INPUT_SCHEMAS.desk_work_ledger
  assert.deepEqual(properties.operator_go.required, ["by", "at"])
  assert.deepEqual(properties.task_ref.required, ["track", "slug"])
  assert.deepEqual(properties.carry_forward.items.required, ["work_item_id", "completed_at"])
  for (const field of ["scope_envelope", "fallback_paths", "write_set"]) assert.equal(properties[field].items.type, "string")
  assert.equal(properties.expected_revision.type, "integer")
})
