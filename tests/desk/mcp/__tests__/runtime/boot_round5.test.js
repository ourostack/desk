// Round 5 boot fixes: a failed sync is named for what it is (unreachable, refused credentials, deadline,
// diverged, conflict), and the push route the account step resolves reaches `instructions`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"

const VERSION_OK = "gh version 2.54.0 (2024-07-31)\n"
const CARD = (repo, title = "Example task") => [
  "schema_version: 1", `title: ${title}`, "status: processing", "created: '2026-01-01T00:00:00Z'", "updated: '2026-01-02T00:00:00Z'",
  "track: example-track", `repos:\n  - name: ${repo}\n    local_path: ""\n    mode: remote`,
].join("\n")

async function mkDesk(cards = {}) {
  const root = await mkTempRoot("desk-boot-round5-")
  await fs.mkdir(path.join(root, "_meta"), { recursive: true })
  await fs.mkdir(path.join(root, "_archive"), { recursive: true })
  for (const [slug, frontmatter] of Object.entries(cards)) {
    const dir = path.join(root, "example-track", slug)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "task.md"), `---\n${frontmatter}\n---\n\nBody.\n`)
  }
  return root
}

function fakeGh({ accounts, repos }) {
  return async (args, { token } = {}) => {
    if (args[0] === "--version") return { code: 0, stdout: VERSION_OK, stderr: "" }
    if (args[0] === "auth" && args[1] === "status") {
      const block = ({ login, active }) => `  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: ${active}\n`
      return { code: 0, stdout: `github.com\n${accounts.map(block).join("\n")}`, stderr: "" }
    }
    if (args[0] === "auth" && args[1] === "token") return { code: 0, stdout: `token-${args[3]}\n`, stderr: "" }
    if (args[0] === "api") {
      const login = typeof token === "string" ? token.replace(/^token-/u, "") : null
      const answer = repos[login]
      if (typeof answer === "number") return { code: 1, stdout: "{}", stderr: `gh: Not Found (HTTP ${answer})\n` }
      return { code: 0, stdout: JSON.stringify(answer), stderr: "" }
    }
    return { code: 1, stdout: "", stderr: "unexpected call" }
  }
}

const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const factoryStatusFn = () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] })
const PUSH = { full_name: "acme/widgets", private: false, allow_forking: true, default_branch: "main", permissions: { push: true, pull: true } }
const NO_PUSH = { ...PUSH, permissions: { push: false, pull: true } }

async function boot(root, { sync = { state: "synced" }, gh, taskQuery = null } = {}) {
  return bootOnce({
    env: { DESK: root }, cwd: root, homeDir: root, gh: gh ?? fakeGh({ accounts: [{ login: "ari", active: true }], repos: { ari: PUSH } }), jq,
    syncFn: async () => sync, factoryStatusFn, taskQuery,
  })
}

// ── sync ────────────────────────────────────────────────────────────────

for (const [cause, sync, expected, degraded] of [
  ["unreachable", { state: "unresolved", reason: "pull_rebase_failed", cause: "unreachable", remote: "https://github.com/o/desk.git", error: "fatal: unable to access 'https://github.com/o/desk.git/': Could not resolve host: github.com", conflicted: [] },
    [/could not sync: origin https:\/\/github\.com\/o\/desk\.git is unreachable \(fatal: unable to access/u, /Work continues on local state; say so in one line/u, /retry sync/u, /`git status` will read clean/u], "pull_rebase_failed, unreachable"],
  ["auth_failed", { state: "unresolved", reason: "pull_rebase_failed", cause: "auth_failed", remote: "https://github.com/o/desk.git", error: "fatal: Authentication failed", conflicted: [] },
    [/origin https:\/\/github\.com\/o\/desk\.git refused this host's credentials \(fatal: Authentication failed\)/u, /gh auth status/u, /retry sync before pushing/u], "pull_rebase_failed, auth_failed"],
  ["auth_failed without a remote or error", { state: "unresolved", reason: "pull_rebase_failed", cause: "auth_failed", remote: null, error: "", conflicted: [] },
    [/could not sync: origin refused this host's credentials\. Work continues/u], "pull_rebase_failed, auth_failed"],
  ["deadline", { state: "unresolved", reason: "sync_deadline_exceeded", cause: "deadline", remote: null, error: "", conflicted: [] },
    [/sync ran out of time/u, /retry sync/u], "sync_deadline_exceeded, deadline"],
  ["a per-call timeout", { state: "unresolved", reason: "pull_rebase_failed", cause: "deadline", remote: "https://github.com/o/desk.git", error: "", conflicted: [] },
    [/A git call timed out while syncing the desk with origin https:\/\/github\.com\/o\/desk\.git/u, /retry sync/u], "pull_rebase_failed, deadline"],
  ["a per-call timeout without a remote", { state: "unresolved", reason: "pull_rebase_failed", cause: "deadline", remote: null, error: "", conflicted: [] },
    [/A git call timed out while syncing the desk: the remote is slow/u], "pull_rebase_failed, deadline"],
  ["diverged", { state: "unresolved", reason: "pull_rebase_failed", cause: "diverged", remote: "git@github.com:o/desk.git", error: "fatal: Need to specify how to reconcile divergent branches.", conflicted: [] },
    [/has diverged from origin git@github\.com:o\/desk\.git/u, /log --oneline --left-right @\{u\}\.\.\.HEAD/u, /do not push until they agree/u], "pull_rebase_failed, diverged"],
  ["conflict", { state: "unresolved", reason: "pull_rebase_failed", cause: "conflict", remote: "x", error: "CONFLICT", conflicted: ["seed.md", "a/b.md"] },
    [/git sync is unresolved \(conflicted: seed\.md, a\/b\.md\): run `git status`/u], "pull_rebase_failed, conflict"],
  ["an unknown failure", { state: "unresolved", reason: "pull_rebase_failed", cause: "other", remote: null, error: "strange", conflicted: [] },
    [/git sync is unresolved: run `git status`/u], "pull_rebase_failed, other"],
]) {
  test(`bootOnce: a sync that failed as ${cause} gets its own accurate instruction and action`, async () => {
    const result = await boot(await mkDesk(), { sync })
    assert.equal(result.status, "degraded")
    assert.ok(result.degraded.includes(`sync: unresolved (${degraded})`), result.degraded.join("|"))
    const line = result.instructions.find((entry) => /^(The desk|A git call)/u.test(entry))
    for (const pattern of expected) {
      assert.match(line, pattern)
      assert.match(result.instructions.join("\n"), pattern)
    }
    if (!/conflict|unknown|diverged/u.test(cause)) assert.doesNotMatch(line, /git sync is unresolved/u)
  })
}

test("bootOnce: a sync result without a cause (an older syncFn) keeps the git status instruction", async () => {
  const result = await boot(await mkDesk(), { sync: { state: "unresolved" } })
  assert.ok(result.instructions.some((line) => /git sync is unresolved: run `git status`/u.test(line)))
  assert.ok(result.degraded.includes("sync: unresolved"))
})

// ── push route ──────────────────────────────────────────────────────────

test("bootOnce: a plain direct push by the active account adds no route line", async () => {
  const result = await boot(await mkDesk({ one: CARD("acme/widgets") }))
  assert.equal(result.push_accounts[0].result, "account_found")
  assert.ok(!result.instructions.some((line) => /Push route|Push access|Do not push/u.test(line)))
  assert.ok(!result.instructions.some((line) => /Push route/u.test(line)))
})

test("bootOnce: a fork route names the repo, the account and the route, in instructions and actions", async () => {
  const gh = fakeGh({ accounts: [{ login: "ari", active: true }], repos: { ari: NO_PUSH } })
  const result = await boot(await mkDesk({ one: CARD("acme/widgets") }), { gh })
  const line = result.instructions.find((entry) => entry.startsWith("Push route for acme/widgets"))
  assert.match(line, /task example-track\/one/u)
  assert.match(line, /account ari cannot push to it directly\. Push your branch to ari's fork/u)
  assert.match(line, /never push to acme\/widgets itself\. Tell the operator this route in one line/u)
  assert.ok(result.instructions.includes(line))
})

test("bootOnce: when only a non-active account can push, the instruction names both and how to push as the right one", async () => {
  const gh = fakeGh({ accounts: [{ login: "work", active: true }, { login: "ari", active: false }], repos: { work: 404, ari: PUSH } })
  const result = await boot(await mkDesk({ one: CARD("acme/widgets") }), { gh })
  const line = result.instructions.find((entry) => entry.startsWith("Push route for acme/widgets"))
  assert.match(line, /account ari is the one with push access \(route direct\), but gh's active account is work/u)
  assert.match(line, /GH_TOKEN=\$\(gh auth token --user ari\)/u)
  assert.match(line, /Tell the operator this in one line/u)
})

test("bootOnce: no account can deliver lists each account's reason", async () => {
  const gh = fakeGh({ accounts: [{ login: "work", active: true }, { login: "ari", active: false }], repos: { work: 404, ari: 404 } })
  const result = await boot(await mkDesk({ one: CARD("acme/widgets") }), { gh })
  const line = result.instructions.find((entry) => entry.startsWith("Do not push acme/widgets"))
  assert.match(line, /no signed-in account can \(work: store_not_visible; ari: store_not_visible\)\. Ask the operator which account to use, or fork, and say so in one line/u)
})

test("bootOnce: a no-account answer without an account list still says so", async () => {
  const gh = fakeGh({ accounts: [], repos: {} })
  const result = await boot(await mkDesk({ one: CARD("acme/widgets") }), { gh })
  assert.ok(result.instructions.some((line) => /^Do not push acme\/widgets \(task example-track\/one\): no signed-in account can\. Ask/u.test(line)))
})

test("bootOnce: an account lookup that failed is reported as unknown push access", async () => {
  const gh = async (args) => (args[0] === "--version" ? { code: 0, stdout: VERSION_OK, stderr: "" } : { code: 127, stdout: "", stderr: "", spawnError: "ENOENT" })
  const result = await boot(await mkDesk({ one: CARD("acme/widgets") }), { gh })
  const line = result.instructions.find((entry) => entry.startsWith("Push access for acme/widgets"))
  assert.match(line, /could not be checked \(gh_missing\): treat it as unknown/u)
  assert.ok(result.instructions.includes(line))
})

test("bootOnce: a named task keeps only its own repos' route lines; with no name every active task is covered", async () => {
  const gh = fakeGh({ accounts: [{ login: "ari", active: true }], repos: { ari: NO_PUSH } })
  const root = await mkDesk({ one: CARD("acme/widgets", "Widgets"), two: CARD("acme/gadgets", "Gadgets") })
  const both = await boot(root, { gh })
  assert.equal(both.instructions.filter((line) => line.startsWith("Push route for")).length, 2)
  const named = await boot(root, { gh, taskQuery: "gadgets" })
  assert.equal(named.task.status, "resolved")
  const lines = named.instructions.filter((line) => line.startsWith("Push route for"))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /acme\/gadgets/u)
  const unmatched = await boot(root, { gh, taskQuery: "no-such-task" })
  assert.equal(unmatched.instructions.filter((line) => line.startsWith("Push route for")).length, 2, "a name that matches nothing narrows nothing")
})

test("bootOnce: a repo that is not on GitHub and a pending account lookup add no route line", async () => {
  const root = await mkDesk({ one: CARD("not-a-slug") })
  const result = await boot(root)
  assert.equal(result.push_accounts[0].result, "not_a_github_repo")
  assert.ok(!result.instructions.some((line) => /Push (route|access)/u.test(line)))
})

test("bootOnce: a repo shared by many tasks is one grouped line, and the total is capped, in instructions and actions", async () => {
  const gh = fakeGh({ accounts: [{ login: "ari", active: true }], repos: { ari: NO_PUSH } })
  const cards = {}
  for (let index = 0; index < 30; index += 1) cards[`a-shared-${index}`] = CARD("acme/widgets", `Shared ${index}`)
  for (let index = 0; index < 7; index += 1) cards[`own-${index}`] = CARD(`acme/repo${index}`, `Own ${index}`)
  const result = await boot(await mkDesk(cards), { gh })
  for (const list of [result.instructions, result.instructions]) {
    const lines = list.filter((line) => /^Push route for|^\.\.\.and \d+ more repos/u.test(line))
    assert.equal(lines.length, 6, "five route lines plus one summary")
    const shared = lines.find((line) => line.includes("acme/widgets"))
    assert.match(shared, /^Push route for acme\/widgets \(tasks example-track\/a-shared-\d+, example-track\/a-shared-\d+, example-track\/a-shared-\d+ and 27 more\)/u)
    assert.match(lines[5], /^\.\.\.and 3 more repos with push-route notes/u)
  }
})

test("bootOnce: a named task narrows the actions as well as the instructions", async () => {
  const gh = fakeGh({ accounts: [{ login: "ari", active: true }], repos: { ari: NO_PUSH } })
  const root = await mkDesk({ one: CARD("acme/widgets", "Widgets"), two: CARD("acme/gadgets", "Gadgets") })
  const named = await boot(root, { gh, taskQuery: "gadgets" })
  const lines = named.instructions.filter((line) => line.startsWith("Push route for"))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /acme\/gadgets/u)
})

test("bootOnce: one task listing the same store twice is named once", async () => {
  const gh = fakeGh({ accounts: [{ login: "ari", active: true }], repos: { ari: NO_PUSH } })
  const card = CARD("acme/widgets") + "\n  - name: acme/widgets\n    local_path: \"\"\n    mode: remote"
  const result = await boot(await mkDesk({ one: card }), { gh })
  const lines = result.instructions.filter((line) => line.startsWith("Push route for"))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /\(task example-track\/one\)/u)
})
