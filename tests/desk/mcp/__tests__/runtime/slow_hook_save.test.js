// A save whose pre-commit hook runs longer than Desk's own time budget still finishes: the
// budget covers Desk's steps, not the user's hooks, and a save that was cut off never answers as if nothing was there to commit.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { commitPaths, stagePaths } from "../../../../../plugins/desk/mcp/src/util/git-stage.js"

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

test("a hook that outlasts the commit's time budget does not cut the save off", async () => {
  const root = await mkTempRoot("desk-slow-hook-")
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  writeFileSync(path.join(root, "card.md"), "one\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "seed"])
  // Longer than the 10 s budget for all of Desk's own steps.
  const hook = path.join(root, ".git", "hooks", "pre-commit")
  writeFileSync(hook, "#!/bin/sh\nsleep 11\n")
  chmodSync(hook, 0o755)
  writeFileSync(path.join(root, "card.md"), "two\n")
  assert.equal(stagePaths(root, ["card.md"], spawnSync).ok, true)

  const committed = commitPaths(root, ["card.md"], "save two", spawnSync)
  assert.equal(committed.ok, true, JSON.stringify(committed))
  assert.equal(git(root, ["log", "-1", "--format=%s"]).trim(), "save two")
})
