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
const ACTIONS = ["desk_recall", "desk_skill", "desk_search", "desk_status", "desk_doctor", "improvement_next"]
const WRITES = ["desk_doctor", "improvement_next"]

for (const group of ["desk", "desk-web"]) {
  test(`the generated output of ${group} is what its declarations produce`, () => {
    const result = spawnSync(process.execPath, [
      path.join(mcp, "src", "lib", "ouro-actions", "ouro-actions.mts"), "check",
      path.join(mcp, "src", "actions", `${group}.actions.mts`), path.join(mcp, "src", "actions", "generated", group), "--targets", "mcp,actions",
    ], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  })
}

test("the action tools are served from the generated tools, with their consent hints", () => {
  for (const name of ACTIONS) {
    assert.equal(TOOL_INPUT_SCHEMAS[name], ACTION_TOOLS[name].inputSchema, `${name} input is the generated one`)
    assert.equal(TOOL_DESCRIPTIONS[name], ACTION_TOOLS[name].description, `${name} description is the generated one`)
    assert.equal(ACTION_TOOLS[name].annotations.readOnlyHint, !WRITES.includes(name), `${name} read-only hint follows its consent`)
  }
})

test("desk_status is declared read-only, so hosted clients don't ask for approval on the first call", () => {
  assert.equal(ACTION_TOOLS.desk_status.annotations.readOnlyHint, true)
})

test("desk-web's catalog carries the effect hints its declarations generate", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const catalog = require(path.join(mcp, "web-catalog.json"));
  const generated = require(path.join(mcp, "src", "actions", "generated", "desk-web", "mcp.json"));
  for (const tool of generated.tools) {
    assert.deepEqual(catalog.tools.find((served) => served.name === tool.name).annotations, tool.annotations, `${tool.name} hints`);
  }
});
