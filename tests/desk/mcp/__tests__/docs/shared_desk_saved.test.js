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
  assert.match(section, /branch in a worktree[\s\S]+merge its pull request straight away/u)
  assert.match(section, /git merge-base --is-ancestor <your-commit> origin\/main/u)
  assert.match(section, /before ending a turn that wrote files[\s\S]+git status --short --branch[\s\S]+git branch --no-merged origin\/main/u)
  assert.match(section, /Never call it saved/u)
})

test("shared-desk-conventions merges a shared write on the workspace's required checks, not over red", () => {
  const section = skill.split("## Read across, write your own")[1]?.split("### Saved means")[0] ?? ""
  assert.doesNotMatch(section, /merge it at once, retrying/u)
  assert.match(section, /merge yourself on green/u)
  assert.match(section, /`required_checks` in `main`'s `\.desk\/publication\.json`/u)
  assert.match(section, /hasn't reported is not green/u)
  assert.match(section, /With no policy and no required check, merge at once/u)
  assert.match(section, /gh pr merge <n> --match-head-commit "\$SHA"/u)
  assert.match(section, /Never merge over red/u)
  assert.match(section, /no AI attribution/u)
})
