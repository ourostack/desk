import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const skill = readFileSync(path.join(repoRoot, "plugins", "crew", "skills", "shared-desk-conventions", "SKILL.md"), "utf8")

test("shared-desk-conventions defines saved as merged on the remote main", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? ""
  assert.match(frontmatter, /before saying work is saved, done or ready/u)

  const section = skill.split("### Saved means on the remote `main`")[1]?.split("\n## ")[0] ?? ""
  assert.match(section, /worktree or on a branch[\s\S]+open a pull request and merge it straight away/u)
  assert.match(section, /git merge-base --is-ancestor <your-commit> origin\/main/u)
  assert.match(section, /before ending any turn that wrote files[\s\S]+git status --short --branch[\s\S]+git branch --no-merged origin\/main/u)
  assert.match(section, /Never call it saved/u)
})
