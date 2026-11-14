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

// Strings the extractor reads as errors that are not: they stay in the manifest as texts, which are still checked for
// scripts, but are not held to "lead with the fix". A carrier wraps a message whose call sites are checked themselves.
const NOT_ERRORS = {
  // Crew's replies that report an outcome other than a failure: a plan, a success, a status, or a note.
  "plugins/desk/mcp/src/crew/workspace.js#the-team-s-tooling-repository": "status note",
  "plugins/desk/mcp/src/crew/workspace.js#the-team-s-tooling-is": "status note",
  "plugins/desk/mcp/src/crew/workspace.js#this-is-a-crew-workspace": "status",
  "plugins/desk/mcp/src/crew/workspace.js#this-repository-is-already-a": "already done",
  "plugins/desk/mcp/src/crew/workspace.js#plan-only-nothing-was-written": "plan",
  "plugins/desk/mcp/src/crew/workspace.js#plan-only-nothing-was-written~2": "plan",
  "plugins/desk/mcp/src/crew/workspace.js#plan-only-nothing-was-written~3": "plan",
  "plugins/desk/mcp/src/crew/workspace.js#started-this-clone-s-crew": "success",
  "plugins/desk/mcp/src/crew/workspace.js#started-committed-on-this-clone": "success",
  "plugins/desk/mcp/src/crew/workspace.js#started-this-repository-is-now": "success",
  "plugins/desk/mcp/src/crew/workspace.js#started-this-repository-is-now~2": "success",
  "plugins/desk/mcp/src/crew/workspace.js#is-already-on-the-roster": "already done",
  "plugins/desk/mcp/src/crew/workspace.js#joined-is-on-the-roster": "success",
  "plugins/desk/mcp/src/crew/workspace.js#crew-s-desk-adopting": "commit message",
  "plugins/desk/mcp/src/crew/workspace.js#nothing-was-written": "carrier",
  "plugins/desk/mcp/src/crew/workspace.js#nothing-was-written~2": "carrier",
  "plugins/desk/mcp/src/desk/content-home.js#nothing-was-written-or-committed": "carrier",
  "plugins/desk/mcp/src/desk/resources.js#no-resource-was-changed": "carrier",
  "plugins/desk/mcp/src/desk/steps.js#no-step-was-changed": "carrier",
  "plugins/desk/mcp/src/factory/pipeline/build.js#factory-build": "carrier",
  "plugins/desk/mcp/src/factory/pr-green.js#pr-green": "carrier of a code",
  "plugins/desk/mcp/src/factory/release-version.js#release-version": "carrier of a code",
  "plugins/desk/mcp/src/factory/store-issues.js#factory-issues": "carrier of a code",
  "plugins/desk/mcp/src/tools/desk-save.js#got-a-string-that-is": "carrier of a checked message",
  "plugins/desk/mcp/src/tools/desk-save.js#the-path-holds-a-nul": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#the-path-holds-or-a": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#the-content-is-over-1": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#it-is-outside-the-resolved": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#it-is-listed-twice": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#the-file-there-is-a": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#what-is-there-is-not": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/desk-save.js#it-leads-through-a-symbolic": "reason in a checked refusal",
  "plugins/desk/mcp/src/tools/lesson-team.js#already-in-effect-the-default": "success reply",
  "plugins/desk/mcp/src/tools/lesson-team.js#in-effect-merged-in-from": "success reply",
  "plugins/desk/mcp/src/tools/move.js#task-move": "commit message",
  "plugins/desk/mcp/src/tools/move.js#track-rename": "commit message",
  "plugins/desk/mcp/src/tools/note.js#left-for-merged-in-s": "success reply",
  "plugins/desk/mcp/src/tools/status.js#desk-search-is-starting": "status",
  "plugins/desk/mcp/src/tools/task.js#task-update-set-in-status": "carrier of a checked message",
  "plugins/desk/mcp/src/desk/improvement-person.js#no-lookup-at-session-start": "internal sentinel, caught by its caller",
  "plugins/desk/mcp/src/desk/runtime-resolver.js#cannot-find-module-in-the": "mirrors Node's own failed require",
}

function deskSurfaces() {
  const extracted = extractSurfaces({
    root: repoRoot,
    paths: ["plugins/desk/mcp/src", "plugins/desk/mcp/web.cjs", "plugins/desk/mcp/web-auth.cjs", "plugins/desk/hooks"],
    tool: "desk",
  })
  const browser = JSON.parse(readFileSync(path.join(repoRoot, "plugins/desk/mcp/web-catalog.json"), "utf8")).tools
  const found = extracted.errors.filter((error) => !error.id.includes("/lib/ouro-ui/"))
  return {
    ...extracted,
    errors: found.filter((error) => !(error.id in NOT_ERRORS)),
    texts: found.filter((error) => error.id in NOT_ERRORS).map(({ id, text, where }) => ({ id, text, where })),
    tools: [
      ...Object.entries(TOOL_DESCRIPTIONS).map(([name, description]) => ({ name, description, where: "plugins/desk/mcp/src/tool-names.js" })),
      ...browser.map((tool) => ({ name: tool.name, description: tool.description, where: "plugins/desk/mcp/web-catalog.json" })),
    ],
  }
}

test("every error and tool description in Desk is within Ouro AX, or recorded in the baseline that only shrinks", (t) => {
  const surfaces = deskSurfaces()
  assert.deepEqual(Object.keys(NOT_ERRORS).filter((id) => !surfaces.texts.some((text) => text.id === id)), [], "NOT_ERRORS names a text that is gone: remove it")
  const report = checkSurfaces(surfaces)
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
