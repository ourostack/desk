// The variable Desk's own commits set to get past the card guard must never reach an agent: an agent that reads its name can copy it to bypass the guard.
// Every shipped text under plugins/desk (skills, migrations, hooks, denial and refusal texts, tool descriptions, the README) is scanned.
// Only the two code files that implement the variable may name it, and CHANGELOG.md keeps its history (the release writes it; a pull request never edits it).
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk")
const IMPLEMENTATION = new Set(["mcp/src/desk/card-commit-guard.js", "mcp/src/util/git-stage.js", "CHANGELOG.md"])
const NAME = "DESK_TOOL_COMMIT"

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) yield* files(full)
    else yield full
  }
}

test("no shipped agent-facing text names the card guard's commit variable", () => {
  const offenders = []
  let scanned = 0
  for (const file of files(PLUGIN)) {
    const rel = path.relative(PLUGIN, file).split(path.sep).join("/")
    if (IMPLEMENTATION.has(rel)) continue
    const text = readFileSync(file)
    if (text.includes(0)) continue
    scanned++
    if (text.toString("utf8").includes(NAME)) offenders.push(rel)
  }
  assert.ok(scanned > 100, "the scan walks the whole plugin")
  assert.deepEqual(offenders, [], `remove ${NAME} from these files and point the agent at the Desk tool instead`)
})

test("the card guard's refusal and the tool texts do not name it either", async () => {
  const { hookScript } = await import("../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js")
  const { TOOL_DESCRIPTIONS } = await import("../../../../../plugins/desk/mcp/src/tool-names.js").then((m) => ({ TOOL_DESCRIPTIONS: m.TOOL_DESCRIPTIONS ?? m.default ?? m }))
  const refusal = hookScript().split("\n").filter((line) => /echo|printf|>&2/u.test(line)).join("\n")
  assert.doesNotMatch(refusal, new RegExp(NAME, "u"))
  assert.doesNotMatch(JSON.stringify(TOOL_DESCRIPTIONS), new RegExp(NAME, "u"))
})
