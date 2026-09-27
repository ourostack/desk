// Every Desk MCP tool advertises a real JSON input schema.
//
// Regression (2026-09-27): every tool was listed with
// `{ properties: {}, additionalProperties: true }`, so Claude Code had no
// shape to build arguments from and sent task_update's `frontmatter` as a
// JSON string, which corrupted the card. This test fails if a tool is
// registered without declared properties or required fields.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { TOOL_NAMES } from "../src/tool-names.js"
import { NO_INPUT_TOOLS, TOOL_INPUT_SCHEMAS } from "../src/tool-schemas.js"
import { FRONT_DOOR_TOOLS } from "../src/runtime/front-door.js"
import { LEDGER_ACTIONS } from "../src/measurement/actions.js"

function assertDeclared(name, inputSchema) {
  assert.ok(inputSchema, `${name}: no input schema`)
  assert.equal(inputSchema.type, "object", `${name}: schema type`)
  assert.equal(inputSchema.additionalProperties, false, `${name}: additionalProperties must be declared false`)
  assert.ok(inputSchema.properties && typeof inputSchema.properties === "object", `${name}: properties`)
  assert.ok(Array.isArray(inputSchema.required), `${name}: required must be an array`)
  const keys = Object.keys(inputSchema.properties)
  if (!NO_INPUT_TOOLS.includes(name)) assert.ok(keys.length > 0, `${name}: declares no properties`)
  for (const field of inputSchema.required) {
    assert.ok(keys.includes(field), `${name}: required field ${field} is not declared`)
  }
  for (const [field, property] of Object.entries(inputSchema.properties)) {
    assert.equal(typeof property.description, "string", `${name}.${field}: needs a description`)
    assert.ok(property.description.length > 0, `${name}.${field}: empty description`)
  }
}

test("every tool in TOOL_NAMES has a declared input schema, and no other tool does", () => {
  assert.deepEqual(Object.keys(TOOL_INPUT_SCHEMAS).sort(), [...TOOL_NAMES].sort())
  for (const name of TOOL_NAMES) assertDeclared(name, TOOL_INPUT_SCHEMAS[name])
})

test("only tools that take no input may declare no properties", () => {
  for (const name of NO_INPUT_TOOLS) {
    assert.ok(TOOL_NAMES.includes(name))
    assert.deepEqual(Object.keys(TOOL_INPUT_SCHEMAS[name].properties), [])
  }
})

test("the front door serves the declared schema for every tool", () => {
  assert.deepEqual(FRONT_DOOR_TOOLS.map((tool) => tool.name), TOOL_NAMES)
  for (const tool of FRONT_DOOR_TOOLS) {
    assert.equal(tool.inputSchema, TOOL_INPUT_SCHEMAS[tool.name])
    assertDeclared(tool.name, tool.inputSchema)
  }
})

test("object-valued card fields are declared as objects, so hosts send objects rather than strings", () => {
  for (const name of ["task_update", "track_update"]) {
    assert.equal(TOOL_INPUT_SCHEMAS[name].properties.frontmatter.type, "object")
  }
  assert.equal(TOOL_INPUT_SCHEMAS.desk_search.properties.filters.type, "object")
})

test("the work ledger schema declares every field any action accepts, and every action", () => {
  const ledger = TOOL_INPUT_SCHEMAS.desk_work_ledger
  assert.deepEqual(ledger.properties.action.enum, Object.keys(LEDGER_ACTIONS))
  const accepted = new Set(Object.values(LEDGER_ACTIONS).flat())
  assert.deepEqual([...accepted].sort(), Object.keys(ledger.properties).sort())
})
