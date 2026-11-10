// The Standing authority section session start shows: found at any heading level, cut at the next heading at its level
// or above, capped, and read from the person's own Crew desk only.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { standingAuthorityLine, standingAuthoritySection } from "../../../../../plugins/desk/mcp/src/runtime/standing-authority.js"

test("the section runs from its heading to the next heading at its level or above, nested headings included", () => {
  const text = "# Desk\n\n## Standing authority\n\n- grant one\n\n### Detail\n\n- grant two\n\n## Next\n\n- other\n"
  assert.equal(standingAuthoritySection(text), "- grant one\n\n### Detail\n\n- grant two")
  assert.equal(standingAuthoritySection("# Desk\n### Standing authority (Ari)\n- g\n## Up\n- x"), "- g")
})

test("no heading, an empty section or a heading inside a code fence is no section", () => {
  assert.equal(standingAuthoritySection("# Desk\n- a rule\n"), null)
  assert.equal(standingAuthoritySection("## Standing authority\n\n## Next\n- x"), null)
  assert.equal(standingAuthoritySection("```\n## Standing authority\n- fake\n```\n"), null)
  assert.equal(standingAuthoritySection(null), null)
})

test("a solo desk's own file is read, named, and a long section is capped with a pointer", () => {
  const read = (f) => (f === path.join("/d", "AGENTS.md") ? `## Standing authority\n${"- long grant line\n".repeat(40)}` : null)
  const line = standingAuthorityLine({ root: "/d", cap: 200, read })
  assert.match(line, /^Desk standing authority: /u)
  assert.ok(line.includes(`From ${path.join("/d", "AGENTS.md")}:\n- long grant line`))
  assert.ok(line.endsWith(`(The section continues in ${path.join("/d", "AGENTS.md")}.)`), line.slice(-120))
  assert.equal(standingAuthorityLine({ root: "/d", read: () => null }), "")
  assert.equal(standingAuthorityLine({ root: null, read }), "")
})

test("in a Crew workspace only the person's own desk grants: the team's root file and an unresolved person show nothing", () => {
  const files = {
    [path.join("/w", "AGENTS.md")]: "## Standing authority\n- team grant\n",
    [path.join("/w", "desks/ari", "AGENTS.md")]: "## Standing authority\n- ari's grant\n",
  }
  const read = (f) => files[f] ?? null
  const line = standingAuthorityLine({ root: "/w", personPrefix: "desks/ari", crew: true, read })
  assert.ok(line.includes(`From ${path.join("/w", "desks/ari", "AGENTS.md")}:\n- ari's grant`))
  assert.doesNotMatch(line, /team grant/u)
  assert.equal(standingAuthorityLine({ root: "/w", crew: true, read }), "")
})

test("the default reader takes the file from disk, and a missing file is no section", () => {
  const root = mkdtempSync(path.join(tmpdir(), "standing-authority-"))
  try {
    writeFileSync(path.join(root, "AGENTS.md"), "# Desk\n\n## Standing authority\n\n- grant on disk\n")
    assert.match(standingAuthorityLine({ root }), /- grant on disk/u)
    assert.equal(standingAuthorityLine({ root: path.join(root, "missing") }), "")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a long section with no line break is cut on a character boundary, never inside one", () => {
  const read = () => `## Standing authority\n- ${"é".repeat(200)}`
  const line = standingAuthorityLine({ root: "/d", cap: 101, read })
  const shown = line.split(":\n")[1].split("\n(The section continues")[0]
  assert.equal(shown, `- ${"é".repeat(49)}`)
  assert.doesNotMatch(line, /\uFFFD/u)
})
