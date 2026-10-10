// Round 11 boot fixes: a task_update that leaves a task unfinished hands back the sentence to report it with, boot
// tells agents to report a task's real status, and a remote-only repo is cloned only when the next step needs it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { UNMATCHED_TASK_INSTRUCTION, UNMATCHED_TASK_INSTRUCTION_TEXT, formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"

// ── task_update says how to report an unfinished task ───────────────────

async function deskWithTask(body = "**Next step:** wire the check.\n") {
  const root = await mkTempRoot("desk-round11-update-")
  await task_create({ deskRoot: root, input: { track: "t", slug: "s", title: "S", body } })
  return root
}

test("a note on an unfinished task returns report_as with the status and next step, and a line against saying done", async () => {
  const root = await deskWithTask()
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "s", note: "wired it", frontmatter: { status: "validating" } } })
  assert.equal(result.report_as, "Task s is at validating (not done): wire the check.")
  assert.equal(result.report_note, "Do not tell the operator this task is done; it is at validating.")
})

test("report_as uses the next step this call sets, and says when the card has none", async () => {
  const root = await deskWithTask("No step here.\n")
  const none = await task_update({ deskRoot: root, input: { track: "t", slug: "s", note: "x" } })
  assert.match(none.report_as, /^Task s is at \w+ \(not done\): no next step recorded$/u)
  const set = await task_update({ deskRoot: root, input: { track: "t", slug: "s", next_step: "open the PR", frontmatter: { status: "validating" } } })
  assert.equal(set.report_as, "Task s is at validating (not done): open the PR")
  assert.equal(Object.hasOwn(set, "next_step_note"), false)
})

test("a call with no note, next step or status change still reports the real status", async () => {
  const root = await deskWithTask()
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "s", body_append: "More." } })
  assert.match(result.report_as, /not done\): wire the check\.$/u)
})

test("a card with no status is reported as having none, never as 'undefined'", async () => {
  const root = await deskWithTask()
  const file = path.join(root, "t", "s", "task.md")
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/^status:.*\n/mu, ""))
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "s", note: "x" } })
  assert.match(result.report_as, /^Task s is at no recorded status \(not done\)/u)
  assert.doesNotMatch(result.report_note, /undefined/u)
})

test("a call that leaves the task cancelled has no report_as", async () => {
  const root = await deskWithTask()
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "s", note: "abandoned", frontmatter: { status: "cancelled" } } })
  assert.equal(Object.hasOwn(result, "report_as"), false)
  assert.equal(Object.hasOwn(result, "report_note"), false)
})

// ── Boot: report the real status; remote-only repos are not cloned by default ───

const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const gh = async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
  if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" }
  return { code: 1, stdout: "", stderr: "unexpected call" }
}

async function deskWithRepos(repoLines) {
  const root = await mkTempRoot("desk-boot-round11-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  const dir = path.join(root, "ops", "relay")
  await fs.mkdir(dir, { recursive: true })
  const card = ["schema_version: 1", "title: Relay", "status: processing", "created: '2026-01-01T00:00:00Z'", "updated: '2026-01-02T00:00:00Z'", "track: ops", `repos:\n${repoLines}`].join("\n")
  await fs.writeFile(path.join(dir, "task.md"), `---\n${card}\n---\n\nBody.\n`)
  return root
}

const boot = (root, taskQuery) =>
  bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, taskQuery,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    repoFn: () => ({ states: [], pending: [] }),
  })

test("every boot tells the agent to report a task's real status", async () => {
  const root = await deskWithRepos("  - name: acme/relay\n    local_path: ~/code/relay\n    mode: local")
  for (const query of [null, "relay", "nothing-like-it"]) {
    const result = await boot(root, query)
    const line = result.instructions.find((text) => text.startsWith("When you report on a task"))
    assert.equal(line, "When you report on a task, say its real status; say 'done' only for a task whose status is done.")
  }
})

test("a named task with a remote-mode repo gets one line: clone only if needed, into the code location, never /tmp, and record it", async () => {
  const root = await deskWithRepos("  - name: anthropics/claude-code\n    local_path: ''\n    mode: remote\n  - name: acme/relay\n    local_path: ~/code/relay\n    mode: local")
  const result = await boot(root, "relay")
  const lines = result.instructions.filter((text) => text.includes("no local clone"))
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes("anthropics/claude-code") && !lines[0].includes("acme/relay"))
  assert.match(lines[0], /Do not clone any of them unless the next step needs its code/u)
  assert.match(lines[0], /code location \(`defaults\.clone_root` in .*\.machine-local\.yml, default ~\/code\/\), never \/tmp/u)
  assert.match(lines[0], /task_update/u)
  assert.deepEqual(result.task.task.remote_repos, ["anthropics/claude-code"])
})

test("a repo with a blank local path counts as having no clone, and an unnamed one is still named", async () => {
  const root = await deskWithRepos("  - local_path: ''\n    mode: local\n  - name: acme/other\n    mode: local")
  const result = await boot(root, "relay")
  assert.match(result.instructions.find((text) => text.includes("no local clone")), /remote-only repos \(no local clone\): a repo without a name, acme\/other\./u)
})

test("no remote line when every repo is cloned, when no task is named, or when the task is not found", async () => {
  const cloned = await deskWithRepos("  - name: acme/relay\n    local_path: ~/code/relay\n    mode: local")
  assert.equal((await boot(cloned, "relay")).instructions.some((text) => text.includes("no local clone")), false)
  const remote = await deskWithRepos("  - name: acme/relay\n    mode: remote")
  assert.equal((await boot(remote, null)).instructions.some((text) => text.includes("no local clone")), false)
  assert.equal((await boot(remote, "nothing-like-it")).instructions.some((text) => text.includes("no local clone")), false)
})

test("a task card with no repos list adds no remote line", async () => {
  const root = await deskWithRepos("  []")
  const result = await boot(root, "relay")
  assert.equal(result.instructions.some((text) => text.includes("no local clone")), false)
  assert.deepEqual(result.task.task.remote_repos, [])
})

test("a missing local clone is cloned only when the next step needs its code", async () => {
  const root = await deskWithRepos("  - name: acme/relay\n    local_path: ~/code/relay\n    mode: local")
  const result = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh, jq, taskQuery: "relay",
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    repoFn: () => ({ states: [{ track: "ops", slug: "relay", repo: "acme/relay", local_path: "~/code/relay", present: false }], pending: [] }),
  })
  const line = result.instructions.find((text) => text.includes("is not at its recorded path"))
  assert.match(line, /only if the next step needs its code, clone it with `gh repo clone acme\/relay ~\/code\/relay`; otherwise do not clone it/u)
})

// ── The push route says what was and was not checked ────────────────────

import { pushRoute } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"

test("pushRoute states what Desk found for the active account, and claims nothing it did not check", () => {
  const entry = (active) => ({ store: "anthropics/claude-code", account: "arimendelow", route: "fork", accounts: [active, { account: "arimendelow", route: "fork" }] })
  const found = (reason) => pushRoute(entry({ account: "arimendelow_microsoft", reason }))
  assert.equal(found(undefined), "push as arimendelow via fork arimendelow/claude-code. The active gh account is arimendelow_microsoft; Desk routes this repo's pushes through the fork and did not check that account's own access.")
  assert.match(found("store_not_visible"), /and its own access check could not see the repository\.$/u)
  assert.match(found("auth_failed"), /its own access check failed to sign in\.$/u)
  assert.match(found("forking_disabled"), /found forking disabled\.$/u)
  assert.match(found("managed_account"), /found a managed account\.$/u)
  assert.match(found("something_new"), /its own access check returned something_new\.$/u)
  assert.match(found(""), /did not check that account's own access\.$/u)
  assert.doesNotMatch(found(undefined), /cannot|no access/u)
})

test("a fork route boot line keeps one sentence per fact and the route account's own limit", async () => {
  const root = await deskWithRepos("  - name: acme/relay\n    local_path: ''\n    mode: remote")
  const result = await bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, jq, taskQuery: "relay",
    gh: async (args, { token } = {}) => {
      if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
      if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account work (keyring)\n  - Active account: true\n  ✓ Logged in to github.com account ari (keyring)\n  - Active account: false\n", stderr: "" }
      if (args[0] === "auth" && args[1] === "token") return { code: 0, stdout: `token-${args[3]}\n`, stderr: "" }
      if (args[0] === "api") return token === "token-work" ? { code: 1, stdout: "{}", stderr: "gh: Not Found (HTTP 404)\n" } : { code: 0, stdout: JSON.stringify({ full_name: "acme/relay", private: false, allow_forking: true, permissions: { push: false, pull: true } }), stderr: "" }
      return { code: 1, stdout: "", stderr: "unexpected" }
    },
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    repoFn: () => ({ states: [], pending: [] }),
  })
  const line = result.instructions.find((text) => text.startsWith("Push route for acme/relay"))
  assert.match(line, /push as ari via fork ari\/relay\. The active gh account is work; Desk routes this repo's pushes through the fork and its own access check could not see the repository\. Account ari cannot push to it directly\./u)
  assert.equal(line.includes("\n"), false)
})

// ── task_update says it committed ───────────────────────────────────────

async function gitDeskWithTask() {
  const root = await mkTempRoot("desk-round11-git-")
  for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) assert.equal(spawnSync("git", args, { cwd: root }).status, 0)
  await task_create({ deskRoot: root, input: { track: "t", slug: "s", title: "S", body: "**Next step:** wire it.\n" }, schedulePush: () => {} })
  return root
}
const head = (root) => spawnSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim()

test("a task_update that commits the card says so: the sha, not yet pushed, and not to commit it again", async () => {
  const root = await gitDeskWithTask()
  const pushes = []
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "s", note: "did it" }, schedulePush: (options) => pushes.push(options) })
  assert.equal(result.desk_commit, head(root))
  assert.equal(result.desk_pushed, false)
  assert.equal(result.desk_note, "Desk card only: Desk committed it (a rebasing push may change desk_commit) and pushes in the background; run no git for it. Desk did not push your project's code; say code was pushed only if your own git push succeeded.")
  // Round P, V and W (Copilot): the model read the note as its own project commit having been pushed. The note leads with "card only", denies pushing the project's code, and ties any such claim to the agent's own push.
  assert.match(result.desk_note, /^Desk card only: /u)
  assert.match(result.desk_note, /Desk did not push your project's code/u)
  assert.match(result.desk_note, /only if your own git push succeeded\.$/u)
  assert.ok(result.desk_note.length <= 220)
  // The note is read first: it is the second field, right after the status, ahead of the commit, the path and the report cues.
  assert.deepEqual(Object.keys(result).slice(0, 3), ["status", "desk_note", "path"])
  assert.equal(pushes.length, 1)
})

test("no desk_commit when the commit failed, git cannot name HEAD, or the desk is not a git repository", async () => {
  const root = await gitDeskWithTask()
  const wrap = (match, answer) => (command, args, options) => (match(args) ? answer : spawnSync(command, args, options))
  const failed = await task_update({ deskRoot: root, input: { track: "t", slug: "s", note: "a" }, schedulePush: () => {}, spawnGit: wrap((args) => args.includes("commit"), { status: 1, stdout: "", stderr: "boom" }) })
  assert.equal(failed.commit.status, "failed")
  assert.equal(Object.hasOwn(failed, "desk_commit"), false)
  for (const answer of [{ status: 1, stdout: "", stderr: "" }, { status: 0, stdout: "  \n" }, { status: 0, stdout: null }, null]) {
    const result = await task_update({ deskRoot: root, input: { track: "t", slug: "s", note: "b" }, schedulePush: () => {}, spawnGit: wrap((args) => args.includes("rev-parse") && args.includes("--short"), answer) })
    assert.equal(Object.hasOwn(result, "desk_commit"), false, JSON.stringify(answer))
    assert.equal(Object.hasOwn(result, "desk_pushed"), false)
  }
  const plain = await deskWithTask()
  assert.equal(Object.hasOwn(await task_update({ deskRoot: plain, input: { track: "t", slug: "s", note: "c" } }), "desk_commit"), false)
})

// ── .state/ stays out of git status ─────────────────────────────────────

import { ensureStateIgnored } from "../../../../../plugins/desk/mcp/src/util/state-ignore.js"
import { openDb } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { createWorkspaceWatcher } from "../../../../../plugins/desk/mcp/src/readiness/workspace-watcher.js"

const gitIn = (root, ...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
async function gitRoot() {
  const root = await mkTempRoot("desk-state-ignore-")
  assert.equal(gitIn(root, "init", "-q").status, 0)
  return root
}

test("ensureStateIgnored adds .state/ to the repository's own exclude file, so the desk's files do not change", async () => {
  const root = await gitRoot()
  assert.equal(ensureStateIgnored(root), true)
  await fs.mkdir(path.join(root, ".state"))
  await fs.writeFile(path.join(root, ".state", "desk-index.sqlite"), "x")
  assert.equal(gitIn(root, "status", "--short").stdout, "")
  assert.equal(await fs.readFile(path.join(root, ".git", "info", "exclude"), "utf8").then((text) => text.endsWith(".state/\n")), true)
  assert.equal(ensureStateIgnored(root), false, "asked once per desk")
})

test("ensureStateIgnored leaves a desk that already ignores .state/, a non-git folder and a failing git alone", async () => {
  const ignored = await gitRoot()
  await fs.writeFile(path.join(ignored, ".gitignore"), ".state/\n")
  assert.equal(ensureStateIgnored(ignored), false)
  const exclude = path.join(ignored, ".git", "info", "exclude")
  assert.equal((await fs.readFile(exclude, "utf8").catch(() => "")).includes(".state/"), false)
  assert.equal(ensureStateIgnored(await mkTempRoot("desk-not-git-")), false)
  const odd = await gitRoot()
  assert.equal(ensureStateIgnored(odd, { spawnGit: () => { throw new Error("no git") } }), false)
})

test("ensureStateIgnored keeps an existing exclude file's lines, with or without a final newline, and creates the file's folder", async () => {
  const root = await gitRoot()
  const exclude = path.join(root, ".git", "info", "exclude")
  await fs.writeFile(exclude, "*.tmp")
  assert.equal(ensureStateIgnored(root), true)
  assert.equal(await fs.readFile(exclude, "utf8"), "*.tmp\n.state/\n")
  const bare = await gitRoot()
  await fs.rm(path.join(bare, ".git", "info"), { recursive: true, force: true })
  assert.equal(ensureStateIgnored(bare), true)
  assert.equal(await fs.readFile(path.join(bare, ".git", "info", "exclude"), "utf8"), ".state/\n")
})

test("opening the index and starting the readiness watcher on a git desk without a .gitignore leave git status clean", async () => {
  const root = await gitRoot()
  const db = openDb(root)
  db.close()
  assert.equal(gitIn(root, "status", "--short").stdout, "")
  const other = await gitRoot()
  const watcher = await createWorkspaceWatcher({ root: other })
  await watcher.close?.()
  assert.equal(gitIn(other, "status", "--short").stdout, "")
  const overridden = await gitRoot()
  openDb(overridden, { dbPath: path.join(overridden, "elsewhere", "x.sqlite") }).close()
  assert.equal(await fs.readFile(path.join(overridden, ".git", "info", "exclude"), "utf8").then((text) => text.includes(".state/")), false)
})

// ── A local override makes a remote-mode repo a local one ───────────────

test("a repo that .machine-local.yml points at an existing clone is not remote-only; one it points at nothing for still is", async () => {
  const root = await deskWithRepos("  - name: acme/relay\n    local_path: ''\n    mode: remote\n  - name: other/quoted\n    mode: remote\n  - name: other/gone\n    mode: remote\n  - name: other/commented\n    mode: remote\n  - name: other/absent\n    mode: remote\n  - name: other/empty\n    mode: remote")
  for (const dir of ["relay-clone", "quoted-clone", "commented-clone"]) await fs.mkdir(path.join(root, dir))
  await fs.writeFile(path.join(root, ".machine-local.yml"), [
    "# per machine",
    "repos:",
    `  relay: ${path.join(root, "relay-clone")}`,
    `  "other/quoted": "${path.join(root, "quoted-clone")}"`,
    `  gone: ${path.join(root, "not-here")}`,
    `  commented: '${path.join(root, "commented-clone")}'  # a comment`,
    "  empty:",
    "  not a pair",
    "defaults:",
    `  absent: ${path.join(root, "relay-clone")}`,
    "",
  ].join("\n"))
  const result = await boot(root, "relay")
  assert.deepEqual(result.task.task.remote_repos, ["other/gone", "other/absent", "other/empty"])
  assert.match(result.instructions.find((text) => text.includes("no local clone")), /other\/gone, other\/absent, other\/empty\./u)
})

test("a ~ path in .machine-local.yml resolves against home, and no repos: section, a missing file or a directory in its place changes nothing", async () => {
  const root = await deskWithRepos("  - name: acme/relay\n    mode: remote")
  await fs.mkdir(path.join(root, "clone"))
  await fs.writeFile(path.join(root, ".machine-local.yml"), "defaults:\n  clone_root: ~/code\nrepos:\n  relay: ~/clone\n")
  assert.deepEqual((await boot(root, "relay")).task.task.remote_repos, [], "homeDir is the desk root in this test")
  await fs.writeFile(path.join(root, ".machine-local.yml"), "defaults:\n  relay: ~/clone\n")
  assert.deepEqual((await boot(root, "relay")).task.task.remote_repos, ["acme/relay"])
  await fs.rm(path.join(root, ".machine-local.yml"))
  assert.deepEqual((await boot(root, "relay")).task.task.remote_repos, ["acme/relay"])
  await fs.mkdir(path.join(root, ".machine-local.yml"))
  assert.deepEqual((await boot(root, "relay")).task.task.remote_repos, ["acme/relay"])
})

// ── report_as redacts and caps the next step ────────────────────────────

test("report_as redacts credential-like text in the next step and cuts a long one at a word", async () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
  const root = await deskWithTask(`**Next step:** push with ${secret} then wire it.\n`)
  const redacted = await task_update({ deskRoot: root, input: { track: "t", slug: "s", note: "x" } })
  assert.doesNotMatch(redacted.report_as, /ghp_/u)
  assert.match(redacted.report_as, /^Task s is at \w+ \(not done\): push with .+ then wire it\.$/u)
  const long = await task_update({ deskRoot: root, input: { track: "t", slug: "s", next_step: `${"wire the check and then ".repeat(30)}finish` } })
  assert.ok(long.report_as.endsWith(" ... (see card)"), long.report_as)
  assert.ok(long.report_as.length < 400)
  assert.equal(long.report_as.includes("finish"), false)
  const unbroken = await task_update({ deskRoot: root, input: { track: "t", slug: "s", next_step: "x".repeat(500) } })
  assert.match(unbroken.report_as, /\(not done\): x{300} \.\.\. \(see card\)$/u)
})

// ── PR #135 review nit: the unmatched-name wording, read from a real boot ───────

test("a name that matches no open task gets the report-every-task instruction from a real boot, in JSON field names and in plain text without them", async () => {
  const root = await deskWithRepos("  - name: acme/relay\n    local_path: ~/code/relay\n    mode: local")
  const result = await boot(root, "nothing-like-it")
  assert.equal(result.task.status, "not_found")
  assert.ok(result.instructions.includes(UNMATCHED_TASK_INSTRUCTION), result.instructions.join("\n"))
  assert.ok(result.text_instructions.includes(UNMATCHED_TASK_INSTRUCTION_TEXT), result.text_instructions.join("\n"))
  const text = formatBootText(result)
  assert.match(text, /The name matches no open task: report every task under "Active tasks" above, each with its status and its next step or blocker, then ask what to resume or start\./u)
  assert.doesNotMatch(text, /show the active_tasks status block/u)
})
