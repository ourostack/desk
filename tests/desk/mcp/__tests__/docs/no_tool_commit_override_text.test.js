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
  // The hook has to read the variable once, in its early return. Everything else in the script (its comments, every echoed line, the hint) must not name it.
  const lines = hookScript().split("\n")
  const reading = lines.filter((line) => line.includes(NAME))
  assert.equal(reading.length, 1, "the hook names the variable on exactly one line, the one that reads it")
  assert.match(reading[0], /^\s*\[ -n "\$DESK_TOOL_COMMIT" \] && return 0$/u)
  assert.doesNotMatch(JSON.stringify(TOOL_DESCRIPTIONS), new RegExp(NAME, "u"))
})
