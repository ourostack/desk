// The real boot script and the real tool server, each started as its own process in a member's Crew clone, with a
// user-wide DESK pointing at the member's personal desk and no --person: both bind the clone and name the same member,
// and a write lands in the member's own desk. The clone is checked out with core.autocrlf=true, as a Windows member's
// is, so the roster has CRLF line endings. No network: gh's own hosts.yml names the signed-in account.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { indexPath, isolatedEnv, makeIsolatedHome } from "../launch/_mcp_handshake.js"
import { openSession } from "../launch/_mcp_session.js"

const BOOT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-boot.js", import.meta.url))
const ROSTER = "# Desks\n\n| alias | identity | path |\n|---|---|---|\n| pat | pat_example | desks/pat |\n| sam | sam_example | desks/sam |\n"

function git(cwd, env, ...args) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
}

async function fixture() {
  const f = await makeIsolatedHome("desk-crew-e2e-")
  const env = isolatedEnv(f, { DESK: f.desk, GH_CONFIG_DIR: path.join(f.root, "gh") })
  // The member's personal desk, named by a user-wide DESK.
  for (const dir of ["_meta", "_archive"]) mkdirSync(path.join(f.desk, dir), { recursive: true })
  // gh signed in as two accounts, one of them the member's.
  mkdirSync(env.GH_CONFIG_DIR, { recursive: true })
  writeFileSync(path.join(env.GH_CONFIG_DIR, "hosts.yml"), "github.com:\n    users:\n        pat-personal:\n        pat_example:\n    user: pat_example\n")
  writeFileSync(path.join(f.home, ".gitconfig"), "[user]\n\tname = Pat\n\temail = pat@example.test\n[core]\n\tautocrlf = true\n[init]\n\tdefaultBranch = main\n")
  // The team workspace: committed with LF, cloned with autocrlf.
  const source = path.join(f.root, "source")
  mkdirSync(path.join(source, "_meta"), { recursive: true })
  mkdirSync(path.join(source, "desks", "pat"), { recursive: true })
  mkdirSync(path.join(source, "desks", "sam"), { recursive: true })
  writeFileSync(path.join(source, "_meta", "desks.md"), ROSTER)
  writeFileSync(path.join(source, "desks", "pat", "AGENTS.md"), "# Pat\n\nPat's own rules.\n")
  writeFileSync(path.join(source, "desks", "sam", "AGENTS.md"), "# Sam\n")
  git(source, env, "init", "-q")
  git(source, env, "add", "-A")
  git(source, env, "commit", "-q", "-m", "team workspace")
  const clone = path.join(f.root, "code", "team")
  git(f.root, env, "clone", "-q", source, clone)
  return { f, env, clone: realpathSync(clone) }
}

test("boot and tool server in a Crew clone, with a user-wide DESK and no --person, bind the clone and the same member", { timeout: 180000 }, async () => {
  const { f, env, clone } = await fixture()
  if (process.platform === "win32") assert.match(readFileSync(path.join(clone, "_meta", "desks.md"), "utf8"), /\r\n/u, "checked out with CRLF")

  const boot = JSON.parse(execFileSync(process.execPath, [BOOT, "--json"], { cwd: clone, env, encoding: "utf8", windowsHide: true, timeout: 120000 }))
  assert.deepEqual({ path: realpathSync(boot.root.path), source: boot.root.source }, { path: clone, source: "host-project" })
  assert.deepEqual(boot.person, { alias: "pat", source: "crew-roster", identity: "pat_example", write_path: "desks/pat", problem: null })

  const server = await openSession({ command: process.execPath, args: [indexPath], cwd: clone, env, timeoutMs: 60000 })
  try {
    const status = await server.statusUntil((payload) => payload.state !== "admitting" && payload.write_scope !== undefined, { deadlineMs: 120000 })
    assert.equal(status.state, "ready", JSON.stringify(status))
    assert.deepEqual({ root: realpathSync(status.root.path), source: status.root.source }, { root: clone, source: boot.root.source })
    assert.deepEqual(status.write_scope, { mode: "person", person: boot.person.alias, relative_path: boot.person.write_path, source: boot.person.source, identity: boot.person.identity })
    const created = await server.call("task_create", { track: "ops", slug: "first-task", title: "First task" })
    assert.equal(created.isError, false, JSON.stringify(created.payload))
    assert.equal(created.payload.path, "desks/pat/ops/first-task/task.md")
    assert.equal(existsSync(path.join(clone, "desks", "pat", "ops", "first-task", "task.md")), true)
    assert.equal(existsSync(path.join(f.desk, "ops")), false, "nothing written to the personal desk")
  } finally {
    await server.close()
  }
})
