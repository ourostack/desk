import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { ACTION_TOOLS } from "../../../../../plugins/desk/mcp/src/actions/served.js"
import { TOOL_DESCRIPTIONS } from "../../../../../plugins/desk/mcp/src/tool-names.js"
import { TOOL_INPUT_SCHEMAS } from "../../../../../plugins/desk/mcp/src/tool-schemas.js"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const mcp = path.join(repoRoot, "plugins", "desk", "mcp")
const ACTIONS = ["desk_recall", "desk_skill"]

test("the generated action output is what its declarations produce", () => {
  const result = spawnSync(process.execPath, [
    path.join(mcp, "src", "lib", "ouro-actions", "ouro-actions.mts"), "check",
    path.join(mcp, "src", "actions", "desk-read.actions.mts"), path.join(mcp, "src", "actions", "generated"),
  ], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test("the read tools are served from the generated tools, with their read-only hints", () => {
  for (const name of ACTIONS) {
    assert.equal(TOOL_INPUT_SCHEMAS[name], ACTION_TOOLS[name].inputSchema, `${name} input is the generated one`)
    assert.equal(TOOL_DESCRIPTIONS[name], ACTION_TOOLS[name].description, `${name} description is the generated one`)
    assert.equal(ACTION_TOOLS[name].annotations.readOnlyHint, true)
  }
})
