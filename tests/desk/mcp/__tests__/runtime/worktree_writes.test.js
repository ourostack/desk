import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { git, makeGitDesk, startDesk, writeActivation } from "./_admission_fixtures.js"
import { isolatedEnv, mcpRoot } from "../launch/_mcp_handshake.js"

test("supported MCP writes commit on a named worktree while main stays in another checkout", async (t) => {
  const fixture = await makeGitDesk("desk-worktree-writes-")
  const main = fixture.desk
  const mainHead = git(main, "rev-parse", "HEAD")
  const worktree = path.join(fixture.root, "session-worktree")
  git(main, "worktree", "add", "-b", "session/worktree", worktree)
  fixture.desk = worktree
  t.diagnostic(`Owned fixture: ${fixture.root}; origin: ${fixture.origin}; main: ${main}; worktree: ${worktree}; HOME: ${fixture.home}; removed by fixture teardown`)
  const identity = spawnSync("git", ["-C", worktree, "config", "--local", "--show-origin", "--get-regexp", "^user\\.(name|email)$"], {
    cwd: worktree, env: isolatedEnv(fixture), encoding: "utf8",
  })
  t.diagnostic(`Fixture-local Git identity: ${JSON.stringify({ status: identity.status, stdout: identity.stdout, stderr: identity.stderr })}`)
  const session = await startDesk(fixture, {
    args: ["--activation-config", writeActivation(fixture)],
    env: {
      GIT_AUTHOR_NAME: "Desk Test",
      GIT_AUTHOR_EMAIL: "desk-test@example.invalid",
      GIT_COMMITTER_NAME: "Desk Test",
      GIT_COMMITTER_EMAIL: "desk-test@example.invalid",
    },
  })
  t.after(() => session.close())
  await session.statusUntil((status) => status.state === "ready", { deadlineMs: 120000 })
  const call = async (name, input) => {
    const result = await session.call(name, input)
    t.diagnostic(`MCP ${name}: ${JSON.stringify(result.payload)}`)
    assert.equal(result.isError, false, JSON.stringify(result.payload))
    assert.notEqual(result.payload.commit?.status, "failed", JSON.stringify(result.payload))
    return result.payload
  }
  await call("task_create", { track: "ops", slug: "supported-write", title: "Supported write" })
  assert.match(git(worktree, "show", "HEAD:ops/supported-write/task.md"), /Supported write/u)
  assert.ok(existsSync(path.join(worktree, "ops/supported-write/task.md")))
  await call("task_update", { track: "ops", slug: "supported-write", note: "Written through MCP" })
  assert.match(readFileSync(path.join(worktree, "ops/supported-write/task.md"), "utf8"), /Written through MCP/u)
  await call("track_create", { slug: "worktree-notes", title: "Worktree notes", scope: "Worktree notes; not other work" })
  await call("track_update", { slug: "worktree-notes", frontmatter: { scope: "Session work; not peer work" } })
  const saved = await call("desk_save", { files: [{ path: "_meta/session-note.md", content: "Session note\n" }], message: "Save session note" })
  assert.equal(saved.status, "committed")
  assert.equal(git(worktree, "show", "HEAD:_meta/session-note.md"), "Session note")
  const tidy = (...args) => {
    const result = spawnSync(process.execPath, [path.join(mcpRoot, "scripts/tidy-status.js"), "--root", worktree, ...args], {
      cwd: worktree, env: isolatedEnv(fixture), encoding: "utf8",
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  const report = tidy("--report")
  const claim = /^Tidy claim: (\S+)/mu.exec(report)?.[1]
  assert.ok(claim, report)
  await call("task_move", { track: "ops", slug: "supported-write", to_slug: "supported-rename" })
  git(worktree, "mv", "_meta/session-note.md", "_meta/tidy-note.md")
  tidy("--write-record", "--claim", claim)
  const tidied = await call("desk_save", {
    paths: ["_meta/session-note.md", "_meta/tidy-note.md", "_meta/organization.json"],
    message: "Tidy supported rename", tidy: true,
  })
  assert.equal(tidied.status, "committed", JSON.stringify(tidied))
  assert.equal(JSON.parse(readFileSync(path.join(worktree, "_meta/organization.json"), "utf8")).tidy_version, 1)
  assert.match(git(worktree, "log", "-1", "--format=%B"), /Desk-Tidy: true/u)
  const denied = await session.call("desk_save", { files: [{ path: "ops/supported-rename/task.md", content: "Bypass\n" }], message: "Not allowed" })
  assert.equal(denied.isError, true, "the card guard still requires task tools")
  assert.match(readFileSync(path.join(worktree, "ops/supported-rename/task.md"), "utf8"), /Written through MCP/u)
  const head = git(worktree, "rev-parse", "HEAD")
  git(worktree, "switch", "-c", "unexpected-drift")
  const drift = await session.call("task_create", { track: "ops", slug: "must-not-write", title: "Must not write" })
  assert.equal(drift.payload.code, "write_branch_mismatch")
  assert.equal(existsSync(path.join(worktree, "ops/must-not-write/task.md")), false)
  git(worktree, "switch", "--detach")
  const detached = await session.call("desk_save", { files: [{ path: "_meta/must-not-write.md", content: "No\n" }], message: "No" })
  assert.equal(detached.payload.code, "write_branch_detached")
  assert.equal(existsSync(path.join(worktree, "_meta/must-not-write.md")), false)
  assert.equal(git(worktree, "rev-parse", "HEAD"), head)
  assert.equal(git(main, "rev-parse", "HEAD"), mainHead)
  assert.equal(git(main, "symbolic-ref", "--short", "HEAD"), "main")
  assert.equal(existsSync(path.join(main, "ops/supported-write/task.md")), false)
  await session.close()
  assert.equal(session.child.exitCode, 0)
  t.diagnostic(`MCP process ${session.child.pid} exited; main stayed at ${mainHead}; session work committed only inside the synthetic worktree`)
})
