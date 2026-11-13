// Desk's agent-facing words held to Ouro AX by its surface checker: errors lead with their fix and carry a code,
// tool descriptions say when to use the tool and stay short, and nothing sends an agent to run a script.
// A finding is recorded in ax-surfaces-baseline.json, counted per check and file; a new one fails, and so does a recorded one that is fixed.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { checkSurfaces, countFindings, extractSurfaces, ratchet, surfacesText } from "../../../../../plugins/desk/mcp/src/lib/ouro-ui/registry/ouro/ax/surfaces.ts"
import { TOOL_DESCRIPTIONS } from "../../../../../plugins/desk/mcp/src/tool-names.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "../../../../..")
const baselinePath = path.join(here, "ax-surfaces-baseline.json")

function deskSurfaces() {
  const extracted = extractSurfaces({
    root: repoRoot,
    paths: ["plugins/desk/mcp/src", "plugins/desk/mcp/web.cjs", "plugins/desk/mcp/web-auth.cjs", "plugins/desk/hooks"],
    tool: "desk",
  })
  const browser = JSON.parse(readFileSync(path.join(repoRoot, "plugins/desk/mcp/web-catalog.json"), "utf8")).tools
  return {
    ...extracted,
    errors: extracted.errors.filter((error) => !error.id.includes("/lib/ouro-ui/")),
    tools: [
      ...Object.entries(TOOL_DESCRIPTIONS).map(([name, description]) => ({ name, description, where: "plugins/desk/mcp/src/tool-names.js" })),
      ...browser.map((tool) => ({ name: tool.name, description: tool.description, where: "plugins/desk/mcp/web-catalog.json" })),
    ],
  }
}

test("every error and tool description in Desk is within Ouro AX, or recorded in the baseline that only shrinks", (t) => {
  const report = checkSurfaces(deskSurfaces())
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
  assert.equal(baseline.ax, "surfaces-baseline/2")
  const result = ratchet(report, baseline.findings)
  if (process.env.UPDATE_AX_SURFACES_BASELINE === "1" && result.added.length === 0) {
    writeFileSync(baselinePath, `${JSON.stringify({ ax: baseline.ax, findings: Object.fromEntries(Object.entries(countFindings(report)).sort(([a], [b]) => (a < b ? -1 : 1))) }, null, 2)}\n`)
    return
  }
  assert.ok(
    result.ok,
    `${surfacesText(report, result, { baselinePath: "tests/desk/mcp/__tests__/runtime/ax-surfaces-baseline.json" })}\nA new finding is fixed in the code. A fixed one leaves the baseline: run this test with UPDATE_AX_SURFACES_BASELINE=1.`,
  )
  t.diagnostic(`${Object.values(baseline.findings).reduce((a, b) => a + b, 0)} findings recorded in ${report.surfaces} surfaces`)
})
