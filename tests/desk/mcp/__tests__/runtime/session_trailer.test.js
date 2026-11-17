import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { installSessionTrailerHooks } from "../../../../../plugins/desk/mcp/src/runtime/session-trailer.js"

const baseEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }
delete baseEnv.COPILOT_AGENT_SESSION_ID
delete baseEnv.AGENCY_SESSION_ID

function git(cwd, args, env = {}, extra = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...baseEnv, GIT_CONFIG_GLOBAL: path.join(cwd, "..", "no-global"), ...env }, ...extra })
  return result
}
const ok = (result) => {
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function repo() {
  const root = await mkTempRoot("session-trailer-")
  const dir = path.join(root, "work")
  mkdirSync(dir)
  ok(git(dir, ["init", "-q", "-b", "main"]))
  const installed = installSessionTrailerHooks(dir)
  assert.equal(installed.state, "ok")
  return dir
}

const message = (dir, ref = "HEAD") => ok(git(dir, ["log", "-1", "--format=%B", ref]))

function commit(dir, subject, env = {}, extra = [], file = "f.txt") {
  writeFileSync(path.join(dir, file), `${Math.random()}\n`)
  ok(git(dir, ["add", "."]))
  return git(dir, ["commit", "-q", "-m", subject, ...extra], env)
}

test("a commit gets the session trailer from COPILOT_AGENT_SESSION_ID", async () => {
  const dir = await repo()
  ok(commit(dir, "first", { COPILOT_AGENT_SESSION_ID: "abc-123" }))
  assert.equal(message(dir), "first\n\nSession: abc-123")
})

test("AGENCY_SESSION_ID is the fallback, and the Copilot id wins when both are set", async () => {
  const dir = await repo()
  ok(commit(dir, "one", { AGENCY_SESSION_ID: "agency-1" }))
  assert.match(message(dir), /Session: agency-1$/u)
  ok(commit(dir, "two", { COPILOT_AGENT_SESSION_ID: "copilot-2", AGENCY_SESSION_ID: "agency-1" }))
  assert.match(message(dir), /Session: copilot-2$/u)
})

test("a human commit (no session id) is left alone", async () => {
  const dir = await repo()
  ok(commit(dir, "by hand"))
  assert.equal(message(dir), "by hand")
})

test("a message that already has a Session trailer is not given a second one, even on amend", async () => {
  const dir = await repo()
  ok(commit(dir, "first\n\nSession: other-9", { COPILOT_AGENT_SESSION_ID: "abc-123" }))
  assert.equal(message(dir), "first\n\nSession: other-9")
  ok(git(dir, ["commit", "-q", "--amend", "--no-edit"], { COPILOT_AGENT_SESSION_ID: "abc-123" }))
  assert.equal(message(dir), "first\n\nSession: other-9")
})

test("an existing trailer block keeps its trailers and gains the Session line", async () => {
  const dir = await repo()
  ok(commit(dir, "first\n\nReviewed-by: Someone <s@example.com>", { COPILOT_AGENT_SESSION_ID: "abc-123" }))
  assert.equal(message(dir), "first\n\nReviewed-by: Someone <s@example.com>\nSession: abc-123")
})

test("a merge commit, a fixup commit and a squash message get no trailer", async () => {
  const dir = await repo()
  const env = { COPILOT_AGENT_SESSION_ID: "abc-123" }
  ok(commit(dir, "base"))
  ok(git(dir, ["checkout", "-q", "-b", "side"]))
  ok(commit(dir, "side work", {}, [], "side.txt"))
  ok(git(dir, ["checkout", "-q", "main"]))
  ok(commit(dir, "main work"))
  ok(git(dir, ["merge", "--no-ff", "-q", "side", "-m", "merge side"], env))
  assert.equal(message(dir), "merge side")
  ok(commit(dir, "more"))
  ok(commit(dir, "fixup! more", env))
  assert.equal(message(dir), "fixup! more")
  ok(git(dir, ["merge", "--squash", "-q", "side"], env))
})

test("a commit made in a linked worktree gets the trailer through the shared hooks", async () => {
  const dir = await repo()
  ok(commit(dir, "base"))
  const linked = path.join(dir, "..", "linked")
  ok(git(dir, ["worktree", "add", "-q", "-b", "lane", linked]))
  ok(commit(linked, "lane work", { COPILOT_AGENT_SESSION_ID: "lane-7" }))
  assert.match(message(linked), /Session: lane-7$/u)
})

test("installing again changes nothing, an older Desk hook is rewritten, and a foreign hook is chained and still runs", async () => {
  const dir = await repo()
  const hooks = path.join(dir, ".git", "hooks")
  assert.deepEqual(installSessionTrailerHooks(dir).hooks.map((hook) => hook.state), ["current", "current"])
  const file = path.join(hooks, "prepare-commit-msg")
  writeFileSync(file, readFileSync(file, "utf8").replace(" v1", " v0"))
  assert.equal(installSessionTrailerHooks(dir).hooks[0].state, "updated")

  const other = path.join(path.dirname(dir), "foreign")
  mkdirSync(other)
  ok(git(other, ["init", "-q", "-b", "main"]))
  const foreign = path.join(other, ".git", "hooks", "prepare-commit-msg")
  writeFileSync(foreign, '#!/bin/sh\necho "foreign ran" >> "$(dirname "$0")/ran.log"\n')
  chmodSync(foreign, 0o755)
  assert.equal(installSessionTrailerHooks(other).hooks[0].chained, true)
  ok(commit(other, "x", { COPILOT_AGENT_SESSION_ID: "abc-123" }))
  assert.match(message(other), /Session: abc-123$/u)
  assert.match(readFileSync(path.join(other, ".git", "hooks", "ran.log"), "utf8"), /foreign ran/u)
})

test("a foreign hook that replaces Desk's later is chained and the stale chained hook is kept as a backup", async () => {
  const dir = await repo()
  const hook = path.join(dir, ".git", "hooks", "prepare-commit-msg")
  for (const body of ["first", "second"]) {
    writeFileSync(hook, `#!/bin/sh\n# ${body}\n`)
    assert.equal(installSessionTrailerHooks(dir).hooks[0].chained, true)
  }
  assert.match(readFileSync(`${hook}.desk-chained`, "utf8"), /second/u)
  assert.equal(readdirSync(path.dirname(hook)).filter((name) => name.startsWith("prepare-commit-msg.desk-chained.bak-")).length, 1)
})

test("a tracked core.hooksPath is left alone and outside a repository nothing happens", async () => {
  const dir = await repo()
  mkdirSync(path.join(dir, ".githooks"))
  writeFileSync(path.join(dir, ".githooks", "pre-commit"), "#!/bin/sh\n")
  ok(git(dir, ["add", ".githooks"]))
  ok(git(dir, ["config", "core.hooksPath", ".githooks"]))
  assert.equal(installSessionTrailerHooks(dir).state, "tracked")
  assert.equal(installSessionTrailerHooks(path.dirname(dir)).state, "skipped")
})

test("a git that cannot run is reported as failed, never thrown", () => {
  const result = installSessionTrailerHooks(".", { spawnGit: () => { throw new Error("no git") } })
  assert.deepEqual(result, { state: "failed", reason: "no git" })
})

async function pushFixture() {
  const dir = await repo()
  const remote = path.join(path.dirname(dir), "remote.git")
  ok(spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote], { encoding: "utf8", env: baseEnv }))
  ok(git(dir, ["remote", "add", "origin", remote]))
  return dir
}

test("pushing onto a branch whose tip carries another session's trailer warns once, naming it, and still pushes", async () => {
  const dir = await pushFixture()
  ok(commit(dir, "theirs", { COPILOT_AGENT_SESSION_ID: "other-session" }))
  ok(git(dir, ["push", "-q", "origin", "main"]))
  ok(commit(dir, "mine", { COPILOT_AGENT_SESSION_ID: "my-session" }))
  const push = git(dir, ["push", "origin", "main"], { COPILOT_AGENT_SESSION_ID: "my-session" })
  assert.equal(push.status, 0, push.stderr)
  assert.equal(push.stderr.match(/Warning: the latest commit on refs\/heads\/main was made by session other-session/gu)?.length, 1)
  assert.match(push.stderr, /this is session my-session/u)
})

test("pushing onto your own session's tip, a new branch, or without a session id prints no warning", async () => {
  const dir = await pushFixture()
  ok(commit(dir, "theirs", { COPILOT_AGENT_SESSION_ID: "other-session" }))
  const first = git(dir, ["push", "origin", "main"], { COPILOT_AGENT_SESSION_ID: "other-session" })
  assert.doesNotMatch(first.stderr, /Warning/u)
  ok(commit(dir, "again", { COPILOT_AGENT_SESSION_ID: "other-session" }))
  assert.doesNotMatch(git(dir, ["push", "origin", "main"], { COPILOT_AGENT_SESSION_ID: "other-session" }).stderr, /Warning/u)
  ok(commit(dir, "by hand"))
  assert.doesNotMatch(git(dir, ["push", "origin", "main"]).stderr, /Warning/u)
  ok(git(dir, ["checkout", "-q", "-b", "fresh"]))
  assert.doesNotMatch(git(dir, ["push", "origin", "fresh"], { COPILOT_AGENT_SESSION_ID: "my-session" }).stderr, /Warning/u)
})

test("a Session trailer matches none of the attribution checks", async () => {
  const trailer = "Session: 4deb13bb-8332-4832-8448-03b62431711b"
  // ourostack/.github tools/no-ai-trailer/check.sh AI_CREDIT, and the org `no-ai-credit-trailer` ruleset, and Desk's git-hygiene scan.
  const aiCredit = /^[ \t]*[A-Za-z-]+-by[ \t]*:.*(\[bot\]|(^|[^A-Za-z0-9])(copilot|claude|anthropic|openai|chatgpt|gpt|codex|gemini|cursor|devin|aider)([^A-Za-z]|$))/imu
  const ruleset = /co-authored-by:[^\n]*(\[bot\]|copilot)/iu
  const deskScan = /Co-Authored-By:|Co-authored with|Generated (with|by) |Built (by|with) |AI-assisted/iu
  for (const check of [aiCredit, ruleset, deskScan]) assert.doesNotMatch(`subject\n\n${trailer}\n`, check)
})
