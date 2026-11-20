// lesson-capture ships agents-md-budget.mjs for any repository to copy in: its always-loaded instructions may only shrink
// unless a pull request raises the budget on purpose.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { removeTreeSync } from "../_remove_tree.js"

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "plugins", "desk", "skills", "lesson-capture", "agents-md-budget.mjs")
const { judge, report, main } = await import(pathToFileURL(script).href)

test("a file over its budget, or with none, fails; one under it says to lock in the cut", () => {
  const { lines, failed } = report(judge({ "AGENTS.md": 120, "CLAUDE.md": 10, ".github/copilot-instructions.md": 5 }, { "AGENTS.md": 100, "CLAUDE.md": 20 }))
  assert.equal(failed, true)
  assert.match(lines[0], /^AGENTS\.md: 120 B, 20 B over its 100 B budget\. Turn a rule into a check/)
  assert.match(lines[1], /^CLAUDE\.md: 10 of 20 B\. Lock in the cut with --set\.$/)
  assert.match(lines[2], /copilot-instructions\.md: 5 B and no budget\. Add one with --set\.$/)
  assert.equal(report(judge({ "AGENTS.md": 100 }, { "AGENTS.md": 100 })).failed, false)
})

test("--set writes today's sizes, and the check then passes until a file grows", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agents-md-budget-"))
  try {
    mkdirSync(path.join(root, ".github"))
    writeFileSync(path.join(root, "AGENTS.md"), "# Rules\n")
    const quiet = { log: () => {} }
    assert.equal(main(["--root", root], quiet), 1)
    assert.equal(main(["--root", root, "--set"], quiet), 0)
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".github", "agents-md-budget.json"), "utf8")), { "AGENTS.md": 8 })
    assert.equal(main(["--root", root], quiet), 0)
    writeFileSync(path.join(root, "AGENTS.md"), "# Rules\n- one more\n")
    assert.equal(main(["--root", root], quiet), 1)
  } finally {
    removeTreeSync(root)
  }
})
