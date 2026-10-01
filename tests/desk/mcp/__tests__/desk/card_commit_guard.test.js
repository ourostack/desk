// The desk's own pre-commit hook (round 12): a commit that changes a live task card is refused unless Desk is committing.
// These tests run the real hook through real `git commit` calls in throwaway repositories.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import {
  CHAINED_NAME,
  HOOK_MARKER,
  TOOL_COMMIT_ENV,
  hookScript,
  installCardGuard,
  isLiveCardPath,
  uninstallCardGuard,
} from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"
import { commitPaths } from "../../../../../plugins/desk/mcp/src/util/git-stage.js"

const CARD = "---\ntitle: x\nstatus: processing\n---\n\nbody\n"

function sh(cwd, args, env = {}) {
  const base = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }
  delete base[TOOL_COMMIT_ENV]
  return spawnSync("git", args, { cwd, encoding: "utf8", env: { ...base, ...env } })
}

function makeDesk({ withMarkers = true } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "card-guard-")))
  assert.equal(sh(root, ["init", "-q", "-b", "main"]).status, 0)
  // Desk's own commit path (commitPaths) runs git with the process environment, so the identity lives in the repository.
  assert.equal(sh(root, ["config", "user.name", "t"]).status, 0)
  assert.equal(sh(root, ["config", "user.email", "t@example.com"]).status, 0)
  if (withMarkers) {
    mkdirSync(path.join(root, "_meta"), { recursive: true })
    mkdirSync(path.join(root, "_archive"), { recursive: true })
    writeFileSync(path.join(root, "_meta", "keep.md"), "x\n")
  }
  mkdirSync(path.join(root, "greenhouse", "watering-api"), { recursive: true })
  writeFileSync(path.join(root, "greenhouse", "watering-api", "task.md"), CARD)
  writeFileSync(path.join(root, "README.md"), "hi\n")
  assert.equal(sh(root, ["add", "-A"]).status, 0)
  assert.equal(sh(root, ["commit", "-q", "-m", "seed", "--no-verify"]).status, 0)
  return root
}

const cardPath = (root) => path.join(root, "greenhouse", "watering-api", "task.md")

function commitAll(root, message = "edit", env = {}) {
  assert.equal(sh(root, ["add", "-A"]).status, 0)
  return sh(root, ["commit", "-q", "-m", message], env)
}

test("isLiveCardPath: track/slug/task.md and the same under desks/<alias>, not archives, loose or hidden folders", () => {
  assert.equal(isLiveCardPath("greenhouse/watering-api/task.md"), true)
  assert.equal(isLiveCardPath("Greenhouse\\Watering-API\\TASK.md"), true)
  assert.equal(isLiveCardPath("./greenhouse/watering-api/task.md"), true)
  assert.equal(isLiveCardPath("desks/ari/greenhouse/watering-api/task.md"), true)
  assert.equal(isLiveCardPath("greenhouse/_archive/watering-api/task.md"), false)
  assert.equal(isLiveCardPath("_meta/x/task.md"), false)
  assert.equal(isLiveCardPath(".state/x/task.md"), false)
  assert.equal(isLiveCardPath("desks/ari/task.md"), false)
  assert.equal(isLiveCardPath("greenhouse/watering-api/notes.md"), false)
  assert.equal(isLiveCardPath("greenhouse/watering-api/repo/task.md"), false)
  assert.equal(isLiveCardPath("task.md"), false)
})

test("the hook script carries the marker, the env name, the task_update and ToolSearch hint, and git-stage uses the same variable name", () => {
  const text = hookScript()
  assert.ok(text.startsWith("#!/bin/sh\n"))
  assert.ok(text.includes(HOOK_MARKER))
  assert.ok(text.includes(`$${TOOL_COMMIT_ENV}`))
  assert.match(text, /task_update/)
  assert.match(text, /ToolSearch/)
  assert.equal(TOOL_COMMIT_ENV, "DESK_TOOL_COMMIT")
  const stage = readFileSync(new URL("../../../../../plugins/desk/mcp/src/util/git-stage.js", import.meta.url), "utf8")
  assert.ok(stage.includes(`"${TOOL_COMMIT_ENV}"`))
})

test("install writes an executable hook once and is idempotent", () => {
  const root = makeDesk()
  try {
    const first = installCardGuard(root)
    assert.equal(first.state, "installed")
    assert.equal(first.path, path.join(root, ".git", "hooks", "pre-commit"))
    assert.equal(statSync(first.path).mode & 0o111, 0o111)
    assert.equal(readFileSync(first.path, "utf8"), hookScript())
    const second = installCardGuard(root)
    assert.deepEqual(second, { state: "current", path: first.path })
    chmodSync(first.path, 0o644)
    assert.equal(installCardGuard(root).state, "current")
    assert.equal(statSync(first.path).mode & 0o111, 0o111, "an installed hook that lost its execute bit gets it back")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an older Desk hook is rewritten in place", () => {
  const root = makeDesk()
  try {
    const file = path.join(root, ".git", "hooks", "pre-commit")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `#!/bin/sh\n${HOOK_MARKER} v0\nexit 0\n`)
    const result = installCardGuard(root)
    assert.equal(result.state, "updated")
    assert.equal(readFileSync(file, "utf8"), hookScript())
    assert.equal(existsSync(path.join(root, ".git", "hooks", CHAINED_NAME)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a hand commit that edits a live card is refused, with a message that names task_update and the ToolSearch hint", () => {
  const root = makeDesk()
  try {
    installCardGuard(root)
    writeFileSync(cardPath(root), CARD.replace("processing", "validating"))
    const refused = commitAll(root)
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /greenhouse\/watering-api\/task\.md/)
    assert.match(refused.stderr, /task_update/)
    assert.match(refused.stderr, /ToolSearch/)
    assert.match(refused.stderr, /git restore --staged/)
    const log = sh(root, ["log", "--oneline"]).stdout.trim().split("\n")
    assert.equal(log.length, 1, "nothing was committed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a commit with no card change, or with a change to the card's other files, passes", () => {
  const root = makeDesk()
  try {
    installCardGuard(root)
    writeFileSync(path.join(root, "README.md"), "changed\n")
    writeFileSync(path.join(root, "greenhouse", "watering-api", "notes.md"), "notes\n")
    assert.equal(commitAll(root).status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a new card, a card under desks/<alias>, and a rename that edits the card are refused; an archive move and a pure rename pass", () => {
  const root = makeDesk()
  try {
    installCardGuard(root)
    mkdirSync(path.join(root, "greenhouse", "new-job"), { recursive: true })
    writeFileSync(path.join(root, "greenhouse", "new-job", "task.md"), CARD)
    assert.notEqual(commitAll(root).status, 0, "a card born in a hand commit")
    assert.equal(sh(root, ["reset", "-q"]).status, 0)
    rmSync(path.join(root, "greenhouse", "new-job"), { recursive: true })

    mkdirSync(path.join(root, "desks", "ari", "garden", "planting"), { recursive: true })
    writeFileSync(path.join(root, "desks", "ari", "garden", "planting", "task.md"), CARD)
    assert.notEqual(commitAll(root).status, 0, "a card under desks/<alias>")
    assert.equal(sh(root, ["reset", "-q"]).status, 0)
    rmSync(path.join(root, "desks"), { recursive: true })

    // A pure rename of the card's folder.
    assert.equal(sh(root, ["mv", "greenhouse/watering-api", "greenhouse/watering-api-2"]).status, 0)
    assert.equal(sh(root, ["commit", "-q", "-m", "rename"]).status, 0, "R100 passes")

    // A rename that also edits the card.
    assert.equal(sh(root, ["mv", "greenhouse/watering-api-2", "greenhouse/watering-api-3"]).status, 0)
    writeFileSync(path.join(root, "greenhouse", "watering-api-3", "task.md"), `${CARD}more\n`)
    assert.notEqual(commitAll(root).status, 0, "R<100 is a change")
    assert.equal(sh(root, ["reset", "-q"]).status, 0)
    assert.equal(sh(root, ["checkout", "--", "."]).status, 0)
    assert.equal(sh(root, ["mv", "greenhouse/watering-api-2", "greenhouse/watering-api-3"]).status, 0)

    // Moving the card into the archive.
    mkdirSync(path.join(root, "greenhouse", "_archive"), { recursive: true })
    assert.equal(sh(root, ["mv", "greenhouse/watering-api-3", "greenhouse/_archive/watering-api-3"]).status, 0)
    assert.equal(sh(root, ["commit", "-q", "-m", "archive"]).status, 0, "an archive move passes")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("deleting a card passes", () => {
  const root = makeDesk()
  try {
    installCardGuard(root)
    rmSync(path.join(root, "greenhouse", "watering-api"), { recursive: true })
    assert.equal(commitAll(root).status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Desk's own commit path (commitPaths) sets the marker, so a card it commits passes the hook", () => {
  const root = makeDesk()
  try {
    installCardGuard(root)
    writeFileSync(cardPath(root), CARD.replace("processing", "validating"))
    assert.equal(sh(root, ["add", "--", "greenhouse/watering-api/task.md"]).status, 0)
    const result = commitPaths(root, ["greenhouse/watering-api/task.md"], "task_update: greenhouse/watering-api", spawnSync)
    assert.deepEqual(result, { ok: true, stderr: result.stderr })
    assert.match(sh(root, ["log", "-1", "--format=%s"]).stdout, /task_update: greenhouse\/watering-api/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a partial commit (git commit -- <paths>) is judged by what it commits, not by other staged work", () => {
  const root = makeDesk()
  try {
    installCardGuard(root)
    writeFileSync(path.join(root, "README.md"), "changed\n")
    writeFileSync(cardPath(root), CARD.replace("processing", "validating"))
    assert.equal(sh(root, ["add", "-A"]).status, 0)
    const partial = sh(root, ["commit", "-q", "-m", "readme only", "--", "README.md"])
    assert.equal(partial.status, 0, partial.stderr)
    assert.equal(sh(root, ["status", "--porcelain"]).stdout.trim(), "M  greenhouse/watering-api/task.md", "the card stays staged")
    assert.notEqual(sh(root, ["commit", "-q", "-m", "card", "--", "greenhouse/watering-api/task.md"]).status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a repository that is not a desk is not guarded by a shared hook", () => {
  const root = makeDesk({ withMarkers: false })
  try {
    writeFileSync(path.join(root, ".git", "hooks", "pre-commit"), hookScript(), { mode: 0o755 })
    writeFileSync(cardPath(root), CARD.replace("processing", "validating"))
    assert.equal(commitAll(root).status, 0, "no _meta folder: not a desk")
    mkdirSync(path.join(root, "_meta"))
    writeFileSync(path.join(root, "_meta", "x.md"), "x\n")
    writeFileSync(cardPath(root), CARD)
    assert.equal(commitAll(root).status, 0, "_meta without _archive or desks: not a desk")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a hook that was there before is kept as pre-commit.desk-chained and runs after Desk's check, with git's arguments", () => {
  const root = makeDesk()
  try {
    const hooks = path.join(root, ".git", "hooks")
    mkdirSync(hooks, { recursive: true })
    const log = path.join(root, "..", `chain-${path.basename(root)}.log`)
    writeFileSync(path.join(hooks, "pre-commit"), `#!/bin/sh\necho "ran $@" >> "${log}"\n[ -f "${log}.fail" ] && exit 1\nexit 0\n`, { mode: 0o755 })
    const result = installCardGuard(root)
    assert.equal(result.state, "installed")
    assert.equal(result.chained, true)
    assert.equal(existsSync(path.join(hooks, CHAINED_NAME)), true)
    assert.equal(readFileSync(path.join(hooks, "pre-commit"), "utf8"), hookScript())
    assert.equal(installCardGuard(root).state, "current", "the second install does not chain Desk's own hook")

    writeFileSync(path.join(root, "README.md"), "changed\n")
    assert.equal(commitAll(root).status, 0)
    assert.match(readFileSync(log, "utf8"), /^ran/)

    writeFileSync(`${log}.fail`, "")
    writeFileSync(path.join(root, "README.md"), "changed again\n")
    assert.notEqual(commitAll(root).status, 0, "the chained hook's own refusal still stops the commit")
    rmSync(`${log}.fail`)
    rmSync(log)
    writeFileSync(cardPath(root), CARD.replace("processing", "validating"))
    assert.notEqual(commitAll(root).status, 0, "Desk's check comes first")
    assert.equal(existsSync(log), false, "the chained hook did not run for a refused card change")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a foreign tool that rewrites pre-commit later (husky regeneration) replaces the stale chained hook, keeps a backup and the guard goes back in front", () => {
  const root = makeDesk()
  try {
    const hooks = path.join(root, ".git", "hooks")
    mkdirSync(hooks, { recursive: true })
    writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho first\nexit 0\n", { mode: 0o755 })
    assert.equal(installCardGuard(root).state, "installed")
    writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho second\nexit 0\n", { mode: 0o755 })
    const result = installCardGuard(root)
    assert.equal(result.state, "installed")
    assert.equal(result.chained, true)
    assert.equal(readFileSync(path.join(hooks, "pre-commit"), "utf8"), hookScript())
    assert.match(readFileSync(path.join(hooks, CHAINED_NAME), "utf8"), /second/)
    const backups = readdirSync(hooks).filter((name) => name.startsWith(`${CHAINED_NAME}.bak-`))
    assert.equal(backups.length, 1)
    assert.match(readFileSync(path.join(hooks, backups[0]), "utf8"), /first/)
    writeFileSync(cardPath(root), CARD.replace("processing", "validating"))
    assert.notEqual(commitAll(root).status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the pre-commit framework moving Desk's hook to pre-commit.legacy does not loop: the install leaves it, and a commit terminates", () => {
  const root = makeDesk()
  try {
    const hooks = path.join(root, ".git", "hooks")
    mkdirSync(hooks, { recursive: true })
    writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    installCardGuard(root)
    // `pre-commit install` moves the hook it finds to pre-commit.legacy and writes its own, which runs the legacy hook first.
    renameSync(path.join(hooks, "pre-commit"), path.join(hooks, "pre-commit.legacy"))
    const log = path.join(root, "..", `fw-${path.basename(root)}.log`)
    writeFileSync(path.join(hooks, "pre-commit"), `#!/bin/sh\necho framework >> "${log}"\nlegacy="$(dirname "$0")/pre-commit.legacy"\n[ -x "$legacy" ] && { "$legacy" "$@" || exit $?; }\nexit 0\n`, { mode: 0o755 })
    assert.deepEqual(installCardGuard(root), { state: "current", path: path.join(hooks, "pre-commit.legacy"), via: "legacy" })
    writeFileSync(path.join(root, "README.md"), "changed\n")
    assert.equal(commitAll(root).status, 0)
    writeFileSync(cardPath(root), CARD.replace("processing", "validating"))
    assert.notEqual(commitAll(root).status, 0, "the guard still refuses through the framework")
    // The worst case: the framework hook sits at pre-commit.desk-chained under Desk's hook, which runs it, which runs Desk's hook again.
    writeFileSync(path.join(hooks, CHAINED_NAME), readFileSync(path.join(hooks, "pre-commit"), "utf8").replace("pre-commit.legacy", "pre-commit"), { mode: 0o755 })
    writeFileSync(path.join(hooks, "pre-commit"), hookScript(), { mode: 0o755 })
    writeFileSync(cardPath(root), CARD)
    writeFileSync(path.join(root, "README.md"), "changed twice\n")
    assert.equal(commitAll(root).status, 0, "re-entry exits 0 rather than looping")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a chained file that carries the Desk marker is never run", () => {
  const root = makeDesk()
  try {
    const hooks = path.join(root, ".git", "hooks")
    mkdirSync(hooks, { recursive: true })
    installCardGuard(root)
    const log = path.join(root, "..", `marker-${path.basename(root)}.log`)
    writeFileSync(path.join(hooks, CHAINED_NAME), `#!/bin/sh\n${HOOK_MARKER} v1\necho ran >> "${log}"\nexit 1\n`, { mode: 0o755 })
    writeFileSync(path.join(root, "README.md"), "changed\n")
    assert.equal(commitAll(root).status, 0)
    assert.equal(existsSync(log), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a merge, cherry-pick or revert in progress passes: resolving a card conflict is a git operation", () => {
  const root = makeDesk()
  try {
    installCardGuard(root)
    sh(root, ["checkout", "-q", "-b", "other"])
    writeFileSync(cardPath(root), CARD.replace("processing", "validating"))
    assert.equal(commitAll(root, "other side", { [TOOL_COMMIT_ENV]: "1" }).status, 0)
    sh(root, ["checkout", "-q", "main"])
    writeFileSync(cardPath(root), CARD.replace("processing", "done"))
    assert.equal(commitAll(root, "main side", { [TOOL_COMMIT_ENV]: "1" }).status, 0)
    assert.notEqual(sh(root, ["merge", "other", "-m", "merge"]).status, 0, "the merge conflicts on the card")
    writeFileSync(cardPath(root), CARD)
    assert.equal(sh(root, ["add", "-A"]).status, 0)
    assert.equal(sh(root, ["commit", "-q", "-m", "resolve"]).status, 0, "no marker needed to resolve")
    // A plain card edit after the merge is refused again.
    writeFileSync(cardPath(root), CARD.replace("processing", "blocked"))
    assert.notEqual(commitAll(root).status, 0)
    // Cherry-pick of the same conflicting change.
    sh(root, ["reset", "-q", "--hard"])
    const picked = sh(root, ["cherry-pick", "other"])
    if (picked.status !== 0) {
      writeFileSync(cardPath(root), CARD)
      assert.equal(sh(root, ["add", "-A"]).status, 0)
      assert.equal(sh(root, ["-c", "core.editor=true", "cherry-pick", "--continue"]).status, 0)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a card whose staged frontmatter does not parse can be repaired by hand; the refusal message names the escape hatch", () => {
  const root = makeDesk()
  try {
    installCardGuard(root)
    writeFileSync(cardPath(root), "title: x\nstatus: processing\nno fence\n")
    assert.equal(commitAll(root, "corrupt", { [TOOL_COMMIT_ENV]: "1" }).status, 0)
    writeFileSync(cardPath(root), "---\ntitle: [unclosed\n")
    assert.equal(commitAll(root, "still corrupt").status, 0, "an unclosed fence is unreadable, so it passes")
    writeFileSync(cardPath(root), "---\r\ntitle: x\r\nstatus: processing\r\n---\r\nbody\r\n")
    const refused = commitAll(root, "crlf card")
    assert.notEqual(refused.status, 0, "a CRLF card that parses is still refused")
    assert.match(refused.stderr, /DESK_TOOL_COMMIT=1 git commit/)
    assert.match(refused.stderr, /task_update cannot parse/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a core.hooksPath that holds tracked files is left alone with a remedy; uninstall restores a chained hook", () => {
  const root = makeDesk()
  try {
    assert.equal(sh(root, ["config", "core.hooksPath", ".githooks"]).status, 0)
    mkdirSync(path.join(root, ".githooks"), { recursive: true })
    writeFileSync(path.join(root, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    assert.equal(sh(root, ["add", "-A"]).status, 0)
    assert.equal(sh(root, ["commit", "-q", "-m", "hooks", "--no-verify"]).status, 0)
    const result = installCardGuard(root)
    assert.equal(result.state, "tracked")
    assert.match(result.remedy, /DESK_TOOL_COMMIT/)
    assert.equal(readFileSync(path.join(root, ".githooks", "pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n")
    assert.equal(sh(root, ["status", "--porcelain"]).stdout, "")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("uninstallCardGuard removes Desk's hook and puts a chained hook back; absent and failed states", () => {
  const root = makeDesk()
  try {
    const hooks = path.join(root, ".git", "hooks")
    mkdirSync(hooks, { recursive: true })
    assert.equal(uninstallCardGuard(root).state, "absent")
    writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    assert.equal(uninstallCardGuard(root).state, "absent", "a foreign hook is not Desk's to remove")
    installCardGuard(root)
    assert.equal(uninstallCardGuard(root).state, "removed")
    assert.equal(readFileSync(path.join(hooks, "pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n")
    assert.equal(existsSync(path.join(hooks, CHAINED_NAME)), false)
    installCardGuard(root)
    rmSync(path.join(hooks, CHAINED_NAME), { force: true })
    assert.equal(uninstallCardGuard(root).state, "removed")
    assert.equal(existsSync(path.join(hooks, "pre-commit")), false)
    const plain = realpathSync(mkdtempSync(path.join(tmpdir(), "card-guard-plain-")))
    try {
      assert.equal(uninstallCardGuard(plain).state, "absent")
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
    assert.equal(uninstallCardGuard(root, { spawnGit: () => { throw new Error("boom") } }).state, "failed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the hook text uses LF endings, and an installed copy with CRLF endings is rewritten", () => {
  const root = makeDesk()
  try {
    assert.equal(hookScript().includes("\r"), false)
    installCardGuard(root)
    const file = path.join(root, ".git", "hooks", "pre-commit")
    writeFileSync(file, hookScript().replace(/\n/gu, "\r\n"), { mode: 0o755 })
    assert.equal(installCardGuard(root).state, "updated")
    assert.equal(readFileSync(file, "utf8"), hookScript())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a path with spaces or non-ASCII characters in a card folder is guarded", () => {
  const root = makeDesk()
  try {
    installCardGuard(root)
    mkdirSync(path.join(root, "caf\u00e9 track", "my-task"), { recursive: true })
    writeFileSync(path.join(root, "caf\u00e9 track", "my-task", "task.md"), CARD)
    assert.notEqual(commitAll(root).status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a symlinked foreign hook is chained too", () => {
  const root = makeDesk()
  try {
    const hooks = path.join(root, ".git", "hooks")
    mkdirSync(hooks, { recursive: true })
    writeFileSync(path.join(hooks, "real-hook"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    symlinkSync("real-hook", path.join(hooks, "pre-commit"))
    const result = installCardGuard(root)
    assert.equal(result.state, "installed")
    assert.equal(lstatSync(path.join(hooks, CHAINED_NAME)).isSymbolicLink(), true)
    assert.equal(lstatSync(path.join(hooks, "pre-commit")).isSymbolicLink(), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a core.hooksPath is respected: the hook goes there, and .git/hooks is left alone", () => {
  const root = makeDesk()
  try {
    assert.equal(sh(root, ["config", "core.hooksPath", ".githooks"]).status, 0)
    const result = installCardGuard(root)
    assert.equal(result.state, "installed")
    assert.equal(result.path, path.join(root, ".githooks", "pre-commit"))
    assert.equal(existsSync(path.join(root, ".git", "hooks", "pre-commit")), false)
    writeFileSync(cardPath(root), CARD.replace("processing", "validating"))
    assert.notEqual(commitAll(root).status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the deliberate override is out of scope: the marker or --no-verify lets a hand commit through", () => {
  const root = makeDesk()
  try {
    installCardGuard(root)
    writeFileSync(cardPath(root), CARD.replace("processing", "validating"))
    assert.equal(commitAll(root, "override", { [TOOL_COMMIT_ENV]: "1" }).status, 0)
    writeFileSync(cardPath(root), CARD)
    assert.equal(sh(root, ["add", "-A"]).status, 0)
    assert.equal(sh(root, ["commit", "-q", "-m", "skip", "--no-verify"]).status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("install skips a folder that is not a git repository, or not the top of one, and never throws", () => {
  const plain = realpathSync(mkdtempSync(path.join(tmpdir(), "card-guard-plain-")))
  try {
    assert.deepEqual(installCardGuard(plain), { state: "skipped", reason: "not a git repository" })
    const repo = makeDesk()
    try {
      mkdirSync(path.join(repo, "inner"))
      assert.equal(installCardGuard(path.join(repo, "inner")).state, "skipped")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

test("install reports a failure when git cannot say where hooks live, or the hooks folder cannot be written", () => {
  const root = makeDesk()
  try {
    const fake = (answers) => (cmd, args) => {
      const key = args.slice(2).join(" ")
      return answers[key] ?? { status: 1, stdout: "", stderr: "" }
    }
    const top = { status: 0, stdout: `${root}\n`, stderr: "" }
    assert.deepEqual(installCardGuard(root, { spawnGit: fake({ "rev-parse --show-toplevel": top }) }), { state: "failed", reason: "git did not say where its hooks live" })
    assert.deepEqual(installCardGuard(root, { spawnGit: fake({ "rev-parse --show-toplevel": top, "rev-parse --git-path hooks": { status: 0, stdout: "\n", stderr: "" } }) }), { state: "failed", reason: "git did not say where its hooks live" })
    // The hooks path is a file, so the folder cannot be made.
    writeFileSync(path.join(root, "blocker"), "x")
    const blocked = installCardGuard(root, { spawnGit: fake({ "rev-parse --show-toplevel": top, "rev-parse --git-path hooks": { status: 0, stdout: "blocker/hooks\n", stderr: "" } }) })
    assert.equal(blocked.state, "failed")
    assert.equal(typeof blocked.reason, "string")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("install treats a top-level it cannot resolve as different from the desk", () => {
  const root = makeDesk()
  try {
    const gone = path.join(root, "not-there")
    const result = installCardGuard(root, { spawnGit: () => ({ status: 0, stdout: `${gone}\n`, stderr: "" }) })
    assert.equal(result.state, "skipped")
    const same = installCardGuard(gone, { spawnGit: () => ({ status: 0, stdout: `${gone}\n`, stderr: "" }) })
    assert.notEqual(same.state, "skipped", "unresolvable paths compare as written")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("ensureCardGuard installs once per desk per process and tries again after a failure; openDb installs it for the real index path only", async () => {
  const { ensureCardGuard } = await import("../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js")
  const { openDb } = await import("../../../../../plugins/desk/mcp/src/db/init.js")
  const root = makeDesk()
  try {
    const failing = (cmd, args) => (args.includes("--show-toplevel") ? { status: 0, stdout: `${root}\n` } : { status: 1, stdout: "", stderr: "" })
    assert.equal(ensureCardGuard(root, { spawnGit: failing }).state, "failed")
    const first = ensureCardGuard(root)
    assert.equal(first.state, "installed")
    assert.equal(ensureCardGuard(root), null, "the second call in this process does nothing")

    const other = makeDesk()
    try {
      openDb(other, { dbPath: path.join(other, "elsewhere.sqlite") }).close()
      assert.equal(existsSync(path.join(other, ".git", "hooks", "pre-commit")), false, "a test's dbPath override says nothing about the desk")
      openDb(other).close()
      assert.equal(readFileSync(path.join(other, ".git", "hooks", "pre-commit"), "utf8"), hookScript())
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
