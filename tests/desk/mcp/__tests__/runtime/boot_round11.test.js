// Round 11 boot fixes: a task_update that leaves a task unfinished hands back the sentence to report it with, boot
// tells agents to report a task's real status, and a remote-only repo is cloned only when the next step needs it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
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
