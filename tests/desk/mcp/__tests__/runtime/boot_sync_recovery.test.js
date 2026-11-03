import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { formatBootText, syncSummary, syncWords } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"

const gh = async (args) => ({ code: 0, stdout: args[0] === "--version" ? "gh version 2.54.0\n" : "", stderr: "" })
const boot = (root, extra = {}) => bootOnce({
  env: { DESK: root }, cwd: root, homeDir: root, gh,
  jq: async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" }),
  migrationsFn: async () => [], cardGuardFn: () => ({ state: "skipped" }),
  factoryStatusFn: () => ({ store: null, consent: "held", stores: [], warnings: [] }),
  syncBudgetMs: 1, syncFn: () => new Promise(() => {}),
  ...extra,
})

test("boot wait expiry is pending with unknown effects, not a failed or unchanged sync", async () => {
  const root = await mkTempRoot("desk-boot-recovery-")
  await fs.mkdir(path.join(root, "_meta"))
  await fs.mkdir(path.join(root, "_archive"))
  let settle
  const result = await boot(root, { syncFn: () => new Promise((resolve) => { settle = resolve }) })
  assert.ok(result.pending.includes("sync: boot_budget_exceeded"))
  assert.match(result.sync_summary, /^sync pending: .*effects unknown/u)
  assert.doesNotMatch(result.sync_summary, /nothing was pulled or pushed|sync failed/u)
  assert.match(syncWords(result.sync_summary), /^Desk sync pending:/u)
  settle({ state: "synced" })
  for (const instructions of [result.instructions, result.text_instructions]) {
    const recovery = instructions.find((line) => line.startsWith("Verify desk sync with direct Git"))
    assert.ok(recovery, "JSON and plain boot both require direct recovery")
    assert.match(recovery, /account-scoped/u)
    assert.match(recovery, /0 ahead and 0 behind/u)
    assert.match(recovery, /do not report working from local state/u)
    assert.match(recovery, /Never stash, rebase, reset/u)
    assert.doesNotMatch(instructions.join("\n"), /open your reply with|pull --rebase --autostash/u)
  }
  assert.doesNotMatch(formatBootText(result), /nothing was pulled or pushed/u)
})

test("unresolved and thrown helpers require the same safe recovery, preserving genuine barriers", async () => {
  const root = await mkTempRoot("desk-boot-recovery-barriers-")
  await fs.mkdir(path.join(root, "_meta"))
  await fs.mkdir(path.join(root, "_archive"))
  for (const cause of ["deadline", "unreachable", "auth_failed", "diverged", "conflict"]) {
    const result = await boot(root, { syncFn: async () => ({ state: "unresolved", cause }) })
    for (const lines of [result.instructions, result.text_instructions]) {
      assert.match(lines.join("\n"), /Verify desk sync with direct Git/u)
      assert.match(lines.join("\n"), /authentication.*conflict.*unknown/u)
      assert.doesNotMatch(lines.join("\n"), /pull --rebase --autostash|reconcile with a rebase|open your reply with/u)
    }
    assert.doesNotMatch(syncSummary({ sync: result.sync }), /nothing was pulled or pushed/u)
  }
  const thrown = await boot(root, { syncFn: async () => { throw new Error("helper unavailable") } })
  assert.match(thrown.instructions.join("\n"), /Verify desk sync with direct Git/u)
})

test("the emitted direct Git checks expose stale refs and preserve staged, dirty and untracked writer bytes in two recovery cycles", async () => {
  const root = await mkTempRoot("desk-boot-recovery-git-")
  const remote = path.join(root, "origin.git")
  const writer = path.join(root, "writer")
  const desk = path.join(root, "desk")
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git(root, "init", "--bare", remote)
  git(root, "init", writer)
  git(writer, "config", "user.name", "Fixture")
  git(writer, "config", "user.email", "fixture@example.test")
  await fs.writeFile(path.join(writer, "owned.txt"), "base\n")
  await fs.writeFile(path.join(writer, "staged.txt"), "base\n")
  git(writer, "add", ".")
  git(writer, "commit", "-qm", "seed")
  git(writer, "remote", "add", "origin", remote)
  git(writer, "push", "-u", "origin", "main")
  git(root, "clone", remote, desk)
  await fs.mkdir(path.join(desk, "_meta"))
  await fs.mkdir(path.join(desk, "_archive"))
  await fs.writeFile(path.join(desk, "owned.txt"), "other writer dirty\n")
  await fs.writeFile(path.join(desk, "staged.txt"), "other writer staged\n")
  git(desk, "add", "staged.txt")
  await fs.writeFile(path.join(desk, "untracked.txt"), "other writer untracked\n")
  const snapshot = async () => ({
    status: git(desk, "status", "--porcelain=v1", "--untracked-files=all"),
    index: await fs.readFile(path.join(desk, ".git", "index")),
    files: await Promise.all(["owned.txt", "staged.txt", "untracked.txt"].map((file) => fs.readFile(path.join(desk, file)))),
  })
  const before = await snapshot()
  const result = await boot(desk)
  const recovery = result.instructions.find((line) => line.startsWith("Verify desk sync with direct Git"))
  assert.ok(recovery)
  const commands = [...recovery.matchAll(/`git -C [^`]+`/gu)].map(([command]) => command.slice(1, -1))
  const fetch = commands.find((command) => command.endsWith("fetch --no-tags origin"))
  const compare = commands.find((command) => command.includes("rev-list --left-right --count"))
  assert.ok(fetch && compare, "the instructions supply fresh fetch and an exact branch comparison")
  // This fixture's established transport is local Git; no real account or service is used.
  const run = (command) => {
    const args = command.slice(command.indexOf(desk) + desk.length).replace(/^'/u, "").trim().split(/\s+/u).map((arg) => arg.replace(/^'|'$/gu, ""))
    return git(desk, ...args)
  }
  for (let cycle = 1; cycle <= 2; cycle += 1) {
    await fs.writeFile(path.join(writer, `remote-${cycle}.txt`), "incoming\n")
    git(writer, "add", ".")
    git(writer, "commit", "-qm", `remote ${cycle}`)
    git(writer, "push", "origin", "main")
    assert.equal(run(compare), cycle === 1 ? "0\t0" : "0\t1", "cached refs alone are not freshness evidence")
    run(fetch)
    assert.equal(run(compare), `0\t${cycle}`, "a fresh fetch reveals the real behind count")
    assert.deepEqual(await snapshot(), before, "fetch and readback never disturb another writer")
  }
  // The actual caller case: helper still unknown, fresh 0/0, other writers' bytes unchanged.
  const current = path.join(root, "current")
  git(root, "clone", remote, current)
  await fs.writeFile(path.join(current, "owned.txt"), "preserve this dirty file\n")
  await fs.writeFile(path.join(current, "untracked.txt"), "preserve this untracked file\n")
  const pending = await boot(current)
  assert.ok(pending.pending.includes("sync: boot_budget_exceeded"))
  git(current, "fetch", "--no-tags", "origin")
  assert.equal(git(current, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"), "0\t0")
  assert.equal(await fs.readFile(path.join(current, "owned.txt"), "utf8"), "preserve this dirty file\n")
  assert.equal(await fs.readFile(path.join(current, "untracked.txt"), "utf8"), "preserve this untracked file\n")
  for (const lines of [pending.instructions, pending.text_instructions]) {
    const rule = lines.find((line) => line.startsWith("Verify desk sync with direct Git"))
    assert.match(rule, /current commits even with unrelated dirty files and an unknown helper outcome: do not report working from local state/u)
    assert.match(rule, /does not prove helper settlement/u)
  }
  assert.equal(git(current, "diff", "--name-only", "--diff-filter=U"), "")
  assert.equal(await fs.stat(path.join(current, ".git", "MERGE_HEAD")).then(() => true, (error) => {
    if (error.code !== "ENOENT") throw error
    return false
  }), false)
  git(current, "remote", "set-url", "origin", path.join(root, "missing.git"))
  assert.throws(() => git(current, "fetch", "--no-tags", "origin"))
  assert.equal(git(current, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"), "0\t0", "failed fetch leaves deceptively current cached refs")

  // An actual conflicted merge can coexist with fresh 0/0: graph equality is not a conflict-resolution receipt.
  await fs.writeFile(path.join(writer, "owned.txt"), "remote change\n")
  git(writer, "add", "owned.txt")
  git(writer, "commit", "-qm", "incoming conflict")
  git(writer, "push", "origin", "main")
  const conflicted = path.join(root, "conflicted")
  git(root, "clone", remote, conflicted)
  git(conflicted, "config", "user.name", "Fixture")
  git(conflicted, "config", "user.email", "fixture@example.test")
  git(conflicted, "checkout", "-qb", "side", "HEAD~1")
  await fs.writeFile(path.join(conflicted, "owned.txt"), "side change\n")
  git(conflicted, "add", "owned.txt")
  git(conflicted, "commit", "-qm", "side")
  git(conflicted, "checkout", "-q", "main")
  assert.throws(() => git(conflicted, "merge", "--no-edit", "side"))
  git(conflicted, "fetch", "--no-tags", "origin")
  assert.equal(git(conflicted, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"), "0\t0")
  assert.equal(git(conflicted, "diff", "--name-only", "--diff-filter=U"), "owned.txt")
  assert.ok((await fs.readFile(path.join(conflicted, ".git", "MERGE_HEAD"), "utf8")).trim())
  const barrier = await boot(conflicted)
  for (const lines of [barrier.instructions, barrier.text_instructions]) {
    assert.match(lines.join("\n"), /with no observed Git-operation\/conflict barrier/u)
  }
})
