// The workspace tidy receipt, revocation and recovery rules (R1-R8, F1). The inventory and basic removal rules are in workspace_tidy.test.js.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkTempRoot } from "../_temp_roots.js"
import { readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"
import { readInspectionGit } from "../../../../../plugins/desk/mcp/src/runtime/git-inspection.js"
import { TIDY_GIT_TIMEOUT_MS } from "../../../../../plugins/desk/mcp/src/runtime/workspace-tidy.js"
import { serializeMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { pathToFileURL } from "node:url"
import { dispositionRecord, mergeTidyEvidence } from "../../../../../plugins/desk/mcp/src/runtime/workspace-evidence.js"
import { withWorkspaceClaim } from "../../../../../plugins/desk/mcp/src/runtime/workspace-claim.js"
import { acknowledgeRepair, readReport, reportPath, runBootChecks, runRepair } from "../../../../../plugins/desk/hooks/lib/boot-checks.cjs"
import { different } from "../_file_identity.js"
import { fixture, git, moduleUrl, squashFixture, tidy, tidyInspectionGit, worktree } from "./_workspace_tidy_fixture.js"

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`R1 preserves tracked bytes hidden by ${flag}`, async () => {
    const f = await fixture()
    const w = await worktree(f)
    git(w.directory, "update-index", flag, "tracked")
    await fs.writeFile(path.join(w.directory, "tracked"), "uncommitted irreplaceable bytes\n")
    assert.equal(git(w.directory, "status", "--porcelain=v1"), "")
    const result = await tidy.repairWorkspace({ deskRoot: f.desk })
    assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
    assert.match(result.left[0].reason, /index.*flags/)
    assert.equal(await fs.readFile(path.join(w.directory, "tracked"), "utf8"), "uncommitted irreplaceable bytes\n")
    assert.equal(git(w.directory, "rev-parse", "HEAD"), w.record.head)
  })
}

test("R4 symlinked task card stops traversal into code and evidence", async () => {
  const f = await fixture()
  const other = await fixture()
  const original = await fs.readFile(f.card, "utf8")
  const target = path.join(f.root, "outside-card.md")
  await fs.writeFile(target, original)
  await fs.unlink(f.card)
  await fs.symlink(target, f.card)
  const nested = path.join(path.dirname(f.card), "repo", "cache", "task.md")
  await fs.mkdir(path.dirname(nested), { recursive: true })
  await fs.writeFile(nested, await fs.readFile(other.card, "utf8"))
  const result = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
  assert.equal(result.complete, true)
  assert.deepEqual(result.issues, ["1 task card skipped: track/task/task.md (not a regular file)"])
  assert.ok(!result.cards.includes(nested))
  assert.ok(!result.repositories.includes(other.repo))
})

test("R6 real canonical serializer supports nested paths and long folded tilde paths", async () => {
  const f = await fixture()
  const long = path.join(f.root, Array(5).fill("long portable workspace").join(" "), "repo")
  await fs.mkdir(path.dirname(long), { recursive: true })
  await fs.rename(f.repo, long)
  for (const value of [
    { name: "repo", local_path: `~/${path.relative(f.root, long)}`, mode: "local" },
    { name: "repo", local_path: `~/${path.relative(f.root, long)}`, mode: "local", paths: ["src/**", "test/**"], metadata: { branches: ["one", "two"] } },
  ]) {
    const body = serializeMarkdown({ status: "processing", repos: [value, { name: "remote", mode: "remote", local_path: "", paths: ["a"] }] }, "")
    assert.match(body, /local_path: >-/)
    await fs.writeFile(f.card, body)
    const result = await tidy.inspectWorkspace({ deskRoot: f.desk, homeDir: f.root, budgetMs: 5000 })
    assert.equal(result.complete, true, result.issues.join("; "))
    assert.deepEqual(result.repositories, [f.desk, long])
  }
})

test("R2 exclusive cleanup claim refuses compliant revocation and consumer reacquisition", async () => {
  assert.equal(typeof tidy.revokeWorkspaceRelease, "function")
  const f = await fixture()
  const w = await worktree(f)
  let statusCount = 0
  let revoked = false
  const run = async (cwd, args) => {
    const result = await tidyInspectionGit(cwd, args)
    if (args[0] === "status" && ++statusCount === 2) {
      await assert.rejects(tidy.revokeWorkspaceRelease({
        repository: w.record.repository, worktree: w.directory, branch: w.record.branch, owner: w.record.owner,
      }), /claimed/)
      revoked = true
    }
    return result
  }
  const result = await tidy.repairWorkspace({ deskRoot: f.desk, git: run })
  assert.equal(revoked, true)
  assert.equal(result.removed.length, 1, JSON.stringify({ left: result.left, issues: result.issues }))
})

test("R2 revoked release before cleanup preserves a live reacquired consumer", async () => {
  const f = await fixture()
  const w = await worktree(f)
  await tidy.revokeWorkspaceRelease({
    repository: w.record.repository, worktree: w.directory, branch: w.record.branch, owner: w.record.owner,
  })
  const consumer = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { cwd: w.directory, stdio: "ignore" })
  try {
    await once(consumer, "spawn")
    const result = await tidy.repairWorkspace({ deskRoot: f.desk })
    assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
    assert.match(result.left[0].reason, /ownership/)
    assert.ok((await fs.stat(w.directory)).isDirectory())
    assert.equal(consumer.exitCode, null)
  } finally { consumer.kill(); if (consumer.exitCode === null && consumer.signalCode === null) await once(consumer, "exit") }
})

test("R2 raw receipt revocation after final status is observed before removal", async () => {
  const f = await fixture()
  const w = await worktree(f)
  let count = 0
  let consumer
  const run = async (cwd, args) => {
    const result = await tidyInspectionGit(cwd, args)
    if (args[0] === "status" && ++count === 2) {
      await fs.unlink(w.receipt)
      consumer = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { cwd: w.directory, stdio: "ignore" })
      await once(consumer, "spawn")
    }
    return result
  }
  try {
    const result = await tidy.repairWorkspace({ deskRoot: f.desk, git: run })
    assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
    assert.ok((await fs.stat(w.directory)).isDirectory())
    assert.equal(consumer.exitCode, null)
  } finally { if (consumer) { consumer.kill(); await once(consumer, "exit") } }
})

test("R2 atomic expected-head deletion preserves a reacquired ref already merged on main", async () => {
  const f = await fixture()
  const w = await worktree(f)
  await fs.writeFile(path.join(f.repo, "tracked"), "new base")
  git(f.repo, "commit", "-am", "new base")
  const newHead = git(f.repo, "rev-parse", "HEAD")
  let changed = false
  const run = async (cwd, args) => {
    const result = await tidyInspectionGit(cwd, args)
    if (args[0] === "rev-parse" && args.includes("--quiet") && args.includes(w.record.branch)) {
      git(f.repo, "update-ref", w.record.branch, newHead)
      changed = true
    }
    return result
  }
  const result = await tidy.repairWorkspace({ deskRoot: f.desk, git: run })
  assert.equal(changed, true)
  assert.equal(result.removed.length, 1, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.equal(result.removed[0].branchRemoved, false)
  assert.equal(git(f.repo, "rev-parse", "topic"), newHead)
})

test("R7 push repository, not fetch URL, decides remote deletion", async () => {
  const { f, w } = await squashFixture()
  const fork = path.join(f.root, "fork.git")
  git(f.root, "init", "--bare", fork)
  git(f.repo, "remote", "set-url", "--push", "origin", fork)
  git(w.directory, "push", "origin", "topic")
  // The upstream delivery exists but its topic is absent; the actual push
  // repository still owns topic and must veto cleanup.
  git(f.root, "--git-dir", f.remote, "update-ref", "-d", "refs/heads/topic")
  w.record.remote.endpoint = pathToFileURL(fork).href
  await w.save()
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.match(result.left[0].reason, /remote branch exists/)
  assert.ok(git(f.root, "--git-dir", fork, "rev-parse", "topic"))
})

test("R7 changed and multiple push endpoints cannot reuse a release receipt", async () => {
  const { f, w } = await squashFixture()
  const unrelated = path.join(f.root, "unrelated.git")
  git(f.root, "init", "--bare", unrelated)
  git(f.repo, "remote", "set-url", "origin", unrelated)
  const changed = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(changed.removed.length, 0)
  assert.match(changed.left[0].reason, /endpoint.*changed/)
  git(f.repo, "remote", "set-url", "origin", f.remote)
  git(f.repo, "remote", "set-url", "--add", "--push", "origin", unrelated)
  git(f.repo, "remote", "set-url", "--add", "--push", "origin", f.remote)
  const multiple = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(multiple.removed.length, 0)
  assert.match(multiple.left[0].reason, /ambiguous.*push/)
  assert.ok((await fs.stat(w.directory)).isDirectory())
})

test("R7 an exact delivery endpoint cannot be rewritten to another repository for inspection", async () => {
  const { f } = await squashFixture()
  const unrelated = path.join(f.root, "unrelated.git")
  git(f.root, "init", "--bare", unrelated)
  git(f.repo, "config", `url.${unrelated}.insteadOf`, pathToFileURL(f.remote).href)
  assert.equal(git(f.repo, "remote", "get-url", "--push", "origin"), f.remote)
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.match(result.left[0].reason, /query endpoint.*changed/)
  assert.ok(git(f.root, "--git-dir", f.remote, "rev-parse", "topic"))
})

test("R3 two repairs preserve squash branch and removed-resource evidence until canonical acknowledgement", async () => {
  const { f, w } = await squashFixture()
  git(f.repo, "push", "origin", "--delete", "topic")
  const first = await runRepair(f.desk)
  assert.equal(first.removed.length, 1)
  assert.match(first.left[0].reason, /branch retained/)
  const second = await runRepair(f.desk)
  assert.equal(second.removed.length, 1)
  assert.match(second.left[0].reason, /branch retained/)
  assert.equal(git(f.repo, "rev-parse", "topic"), w.record.head)
  const file = reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  const persisted = await readReport(file)
  assert.equal(persisted.removed.length, 1)
  assert.equal(persisted.resources[0].receipt.release.evidence, w.record.release.evidence)
  const resource = persisted.resources[0]
  await assert.rejects(acknowledgeRepair(f.desk, { id: resource.id, digest: "stale", canonicalEvidence: "task.md#resources" }), /changed/)
  const acknowledged = await acknowledgeRepair(f.desk, { id: resource.id, digest: resource.digest, canonicalEvidence: "task.md#resources" })
  assert.equal(acknowledged.resources.length, 0)
  const third = await runRepair(f.desk)
  assert.deepEqual(third.left, [])
  assert.deepEqual(third.removed, [])
  assert.equal(git(f.repo, "rev-parse", "topic"), w.record.head)
})

test("cards with no repos, or repos Desk cannot read, among valid ones never stop the tidy for the desk", async () => {
  const f = await fixture()
  const plain = path.join(f.desk, "track", "no-repos-field", "task.md")
  const broken = path.join(f.desk, "track", "unreadable-repos", "task.md")
  const other = path.join(f.desk, "track", "unreadable-too", "task.md")
  for (const [file, body] of [
    [plain, "---\nstatus: processing\n---\n"],
    [broken, "---\nstatus: processing\nrepos: [{mode: local}]\n---\n"],
    [other, "---\nstatus: processing\nrepos:\n  - mode: local\n    local_path: ./relative\n---\n"],
  ]) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body)
  }
  const inventory = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
  assert.equal(inventory.complete, true)
  assert.deepEqual(inventory.issues, ["2 task cards with unreadable repos: track/unreadable-repos/task.md (repos list not readable), track/unreadable-too/task.md (repo ./relative is not an absolute or ~/ path); their repositories were not inspected"])
  assert.deepEqual(inventory.cardRecords[plain].repositories, [f.desk], "no repos field: the desk only")
  assert.ok(inventory.repositories.includes(await fs.realpath(f.repo)), "the valid card's repository is still inspected")

  const w = await worktree(f, "still-tidied")
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.deepEqual(result.removed.map((entry) => entry.path), [w.directory])
})

test("R8 a desk bound through a symlink alias is the same desk: task lookup, report, lock and next boot agree", async () => {
  const f = await fixture()
  const alias = path.join(f.root, "desk-alias")
  await fs.symlink(f.desk, alias)
  const direct = await worktree(f, "direct")
  const result = await tidy.repairWorkspace({ deskRoot: alias })
  assert.deepEqual(result.left, [], "the receipt's task resolves under the alias exactly as under the real path")
  assert.equal(result.removed[0].path, direct.directory)

  const viaHook = await worktree(f, "via-hook")
  const repaired = await runRepair(alias)
  assert.equal(repaired.removed[0].path, viaHook.directory)
  assert.equal(repaired.root, f.desk, "the report's identity is the real path")
  const file = reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  const persisted = await readReport(file)
  assert.equal(persisted.root, f.desk)
  assert.equal("bound" in persisted, false, "the report stores one identity, the real path")
  assert.equal((await runRepair(f.desk)).root, f.desk, "the real path reaches the same report")

  const env = { ...process.env, DESK: alias, DESK_ACTIVATION_CONFIG: "", HOME: f.root }
  const boots = async () => {
    let line
    for (let attempt = 0; attempt < 20; attempt += 1) {
      // Identity/report/lock semantics are not a startup-budget benchmark.
      // Keep real inventory/receipt checks; give the instrumented fixture its
      // own finite observation window. Separate tests enforce boot deadlines.
      line = await runBootChecks({ host: "claude", env, launch: async () => {},
        totalBudgetMs: 10000, checkBudgets: { "workspace-tidy": 5000 }, inspectionBudgetMs: 4000 })
      if (!line.includes("budget exceeded")) break
    }
    return line
  }
  assert.match(await boots(), /Last repair: Tidied 1 stale worktrees/, "the next boot through the alias finds the repair's report")
  await fs.writeFile(`${file}.lock`, "another-owner")
  assert.match(await boots(), /repair lock/, "and the lock the repair holds")
  assert.deepEqual(await runRepair(alias), { busy: true, lock: `${file}.lock` })
  await fs.unlink(`${file}.lock`)

  // A report written before roots were canonical names the alias; it still belongs to this desk.
  await fs.writeFile(file, JSON.stringify({ ...persisted, root: alias }))
  assert.match(await boots(), /Last repair:/)

  // An issue the last repair already named is not repeated in the live part of the line.
  await fs.mkdir(path.join(f.desk, "track", "unfinished"), { recursive: true })
  await fs.writeFile(path.join(f.desk, "track", "unfinished", "task.md"), "---\ntitle: unfinished\n---\n")
  const issue = "1 task card skipped: track/unfinished/task.md (no readable status)"
  assert.ok((await boots()).includes(`deferred (0 listed); ${issue}`), "a live issue the report lacks is named")
  await fs.writeFile(file, JSON.stringify({ ...persisted, issues: [issue] }))
  const line = await boots()
  assert.equal(line.split(issue).length - 1, 1, line)
})

test("inspection combines its cancellation signals without AbortSignal.any, and releases its listeners", async (t) => {
  const original = AbortSignal.any
  t.after(() => { AbortSignal.any = original })
  AbortSignal.any = undefined
  const f = await fixture()
  const outer = new AbortController()
  const blocked = []
  const stalled = (cwd, args, options) => new Promise((resolve) => {
    blocked.push(options.signal)
    options.signal.addEventListener("abort", () => resolve({ ok: false, stdout: "", code: 1 }))
  })
  const pending = tidy.inspectWorkspace({ deskRoot: f.desk, git: stalled, budgetMs: 5_000, signal: outer.signal })
  while (blocked.length === 0) await new Promise((resolve) => setImmediate(resolve))
  outer.abort(new Error("host deadline"))
  const inventory = await pending
  assert.equal(inventory.complete, false)
  assert.equal(blocked[0].aborted, true, "the caller's abort reaches the running Git inspection")
  assert.equal(blocked[0].reason.message, "host deadline")

  const early = new AbortController()
  early.abort("already")
  const combined = tidy.anySignal([undefined, early.signal, new AbortController().signal])
  assert.equal(combined.signal.aborted, true)
  assert.equal(combined.signal.reason, "already")

  const first = new AbortController()
  const second = new AbortController()
  const removed = []
  const watch = (controller) => {
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.removeEventListener = (type, listener) => { removed.push(type); remove(type, listener) }
  }
  watch(first)
  watch(second)
  const live = tidy.anySignal([first.signal, second.signal])
  assert.equal(live.signal.aborted, false)
  second.abort("second")
  assert.equal(live.signal.reason, "second")
  assert.deepEqual(removed, ["abort", "abort"], "both listeners are removed once one signal aborts")
  const idle = tidy.anySignal([new AbortController().signal])
  idle.cleanup()
  idle.cleanup()
  assert.equal(idle.signal.aborted, false)
})

test("R3 cleanup requires persisted pending evidence before destructive removal", async () => {
  const f = await fixture()
  const w = await worktree(f)
  const states = []
  const result = await tidy.repairWorkspace({
    deskRoot: f.desk,
    onDisposition: async (entry) => { states.push(entry.state); throw new Error("evidence store unavailable") },
  })
  assert.deepEqual(states, ["cleanup_pending"])
  assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.match(result.left[0].reason, /evidence store/)
  assert.ok((await fs.stat(w.directory)).isDirectory())
})

test("R2 legacy receipts and mismatched revocation owners remain report-only", async () => {
  const f = await fixture()
  const w = await worktree(f)
  await assert.rejects(tidy.revokeWorkspaceRelease({ ...w.record, owner: "different" }), /ownership mismatch/)
  w.record.version = 1
  await w.save()
  const result = await tidy.repairWorkspace({ deskRoot: f.desk })
  assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.match(result.left[0].reason, /ownership/)
})

test("R2 late changed receipt and failed revocation absence are explicit refusals", async (t) => {
  const f = await fixture()
  const w = await worktree(f)
  let count = 0
  const run = async (cwd, args) => {
    const result = await tidyInspectionGit(cwd, args)
    if (args[0] === "status" && ++count === 2) {
      w.record.owner = "new owner"
      await w.save()
    }
    return result
  }
  const result = await tidy.repairWorkspace({ deskRoot: f.desk, git: run })
  assert.equal(result.removed.length, 0, JSON.stringify({ left: result.left, issues: result.issues }))
  assert.match(result.left[0].reason, /release.*changed/)
  const unlink = fs.unlink.bind(fs)
  const mock = t.mock.method(fs, "unlink", (file) => file === w.receipt ? Promise.resolve() : unlink(file))
  await assert.rejects(tidy.revokeWorkspaceRelease(w.record), /absence unverified/)
  mock.mock.restore()
})

test("R6 canonical nested paths alone work and malformed repository indentation leaves that card's repositories uninspected", async () => {
  const f = await fixture()
  await fs.writeFile(f.card, serializeMarkdown({
    status: "processing", repos: [{ name: "repo", local_path: "~/repo", mode: "local", paths: ["src/**"] }],
  }, ""))
  assert.equal((await tidy.inspectWorkspace({ deskRoot: f.desk, homeDir: f.root, budgetMs: 5000 })).complete, true)
  for (const body of [
    "---\nstatus: processing\nrepos:\n  invalid: map\n---",
    "---\nstatus: processing\nrepos:\n  invalid: map\n  - mode: remote\n---",
    "---\nstatus: processing\nrepos:\n  - mode: remote\n bad-indent: x\n---",
  ]) {
    await fs.writeFile(f.card, body)
    const result = await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })
    assert.deepEqual(result.cardRecords[f.card].repositories, [], "the malformed card authorizes nothing")
    assert.match(result.issues.join(" "), /1 task card with unreadable repos/)
  }
  await fs.writeFile(f.card, "---\nstatus: processing\nrepos:\n  - mode: remote\n\n\n---")
  assert.equal((await tidy.inspectWorkspace({ deskRoot: f.desk, budgetMs: 5000 })).complete, true)
})

test("F1-I01 near-boundary history accepts safe cleanup, remains readable, acknowledges and resumes", async (t) => {
  const f = await fixture()
  const w = await worktree(f)
  await fs.unlink(w.receipt)
  await withWorkspaceClaim(w.record, () => w.save())
  const limit = 1_048_576
  const historical = []
  const historyReport = () => ({ ...mergeTidyEvidence({ resources: historical }), root: f.desk, updated: new Date().toISOString() })
  for (let index = 0; ; index += 1) {
    const receipt = { ...structuredClone(w.record), worktree: path.join(f.root, `history-${index}`), branch: `refs/heads/history-${index}`, owner: `history/attempt-${index}` }
    historical.push(dispositionRecord(receipt, "removed", true))
    if (Buffer.byteLength(JSON.stringify(historyReport())) > limit - 512) { historical.pop(); break }
  }
  const spare = limit - 256 - Buffer.byteLength(JSON.stringify(historyReport()))
  const last = historical.at(-1)
  last.receipt.release.evidence += "x".repeat(Math.floor(spare / 2))
  historical[historical.length - 1] = dispositionRecord(last.receipt, "removed", true)
  const before = JSON.stringify(historyReport())
  assert.ok(Buffer.byteLength(before) >= limit - 258 && Buffer.byteLength(before) < limit)
  const file = reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  await fs.writeFile(file, before)

  const result = await runRepair(f.desk)
  assert.ok(result.removed.some((entry) => entry.path === w.directory))
  await assert.rejects(fs.stat(w.directory), { code: "ENOENT" })
  const readable = await readReport(file)
  assert.ok((await fs.stat(file)).size <= limit)
  t.diagnostic(JSON.stringify({ historicalResources: historical.length, bytesBefore: Buffer.byteLength(before), bytesAfter: (await fs.stat(file)).size, acceptedCleanup: true }))
  assert.deepEqual(readable.resources.filter((entry) => entry.path !== w.directory), historical)
  const current = readable.resources.find((entry) => entry.path === w.directory)
  await acknowledgeRepair(f.desk, { id: current.id, digest: current.digest, canonicalEvidence: "task.md#resources" })
  const drained = await readReport(file)
  assert.deepEqual(drained.resources, historical)
  const later = await worktree(f, "later")
  const resumed = await runRepair(f.desk)
  assert.ok(resumed.removed.some((entry) => entry.path === later.directory))
  assert.ok((await fs.stat(file)).size <= limit)
  assert.equal((await readReport(file)).resources.length, historical.length + 1)
})

test("F1-I01 exhausted canonical capacity refuses before cleanup and acknowledgement releases capacity", async () => {
  const f = await fixture()
  const w = await worktree(f)
  const historical = []
  const seed = () => ({ format: "workspace-tidy-compact-v1", resources: historical, issues: [], root: f.desk, updated: new Date().toISOString(), line: "" })
  for (let index = 0; ; index += 1) {
    const receipt = { ...structuredClone(w.record), worktree: path.join(f.root, `history-${index}`), branch: `refs/heads/history-${index}`, owner: `history/attempt-${index}` }
    historical.push(dispositionRecord(receipt, "removed", true))
    if (Buffer.byteLength(JSON.stringify(seed())) > 1_048_000) { historical.pop(); break }
  }
  const last = historical.at(-1)
  last.receipt.release.evidence += "x".repeat(1_048_512 - Buffer.byteLength(JSON.stringify(seed())))
  historical[historical.length - 1] = dispositionRecord(last.receipt, "removed", true)
  const before = JSON.stringify(seed())
  assert.equal(Buffer.byteLength(before), 1_048_512)
  const file = reportPath(f.desk, git(f.desk, "rev-parse", "--absolute-git-dir"))
  await fs.writeFile(file, before)
  await assert.rejects(runRepair(f.desk), /capacity/)
  assert.ok((await fs.stat(w.directory)).isDirectory())
  assert.equal(git(w.directory, "rev-parse", "HEAD"), w.record.head)
  assert.equal(await fs.readFile(file, "utf8"), before)
  assert.deepEqual((await readReport(file)).resources, historical)
  for (const entry of historical.slice(0, 4)) {
    await acknowledgeRepair(f.desk, { id: entry.id, digest: entry.digest, canonicalEvidence: "task.md#resources" })
  }
  const resumed = await runRepair(f.desk)
  assert.ok(resumed.removed.some((entry) => entry.path === w.directory))
  const after = await readReport(file)
  assert.deepEqual(after.resources.filter((entry) => entry.path !== w.directory), historical.slice(4))
  assert.ok((await fs.stat(file)).size <= 1_048_576)
})

test("the unreadable-repos issue names the first three cards in order and counts the rest", async () => {
  const f = await fixture()
  for (const name of ["e", "d", "c", "b", "a"]) {
    const file = path.join(f.desk, "track", name, "task.md")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `---\nstatus: processing\nrepos:\n  - mode: local\n    local_path: ~/missing-${name}\n---\n`)
  }
  const { issues } = await tidy.inspectWorkspace({ deskRoot: f.desk, homeDir: f.root, budgetMs: 5000 })
  assert.deepEqual(issues, ["5 task cards with unreadable repos: track/a/task.md (repo ~/missing-a not found), track/b/task.md (repo ~/missing-b not found), track/c/task.md (repo ~/missing-c not found), and 2 more; their repositories were not inspected"])
})

test("Windows paths from Git match the same folder spelled natively or in another case, and only that", () => {
  const { nativeGitPath, foldPath, samePath, insidePath } = tidy
  assert.equal(nativeGitPath("C:/Users/me/repo", "win32"), "C:\\Users\\me\\repo")
  assert.equal(nativeGitPath("/home/me/repo", "linux"), "/home/me/repo")
  assert.equal(nativeGitPath(undefined, "win32"), undefined)
  assert.equal(foldPath("C:/Users/Me", "win32"), "c:\\users\\me")
  assert.equal(foldPath("/Home/Me", "linux"), "/Home/Me")
  assert.equal(samePath("C:/Users/me/repo", "C:\\Users\\Me\\repo", "win32"), true)
  assert.equal(samePath("C:\\Users\\a", "C:\\Users\\b", "win32"), false)
  assert.equal(samePath("C:\\Users\\RUNNER~1\\w", "C:/Users/runneradmin/w", "win32"), false, "a short name is a different spelling and is not guessed")
  assert.equal(samePath("/a/Repo", "/a/repo", "linux"), false)
  assert.equal(samePath("/a/repo", "/a/repo", "linux"), true)
  assert.equal(insidePath("C:/r/.git/worktrees", "C:\\R\\.git\\worktrees\\t", "win32"), true)
  assert.equal(insidePath("C:\\r", "C:\\rr", "win32"), false)
  assert.equal(insidePath("/r/w", "/r/w/t", "linux"), true)
  assert.equal(insidePath("/r/w", "/r/wx", "linux"), false)
  assert.equal(tidy.parseWorktrees("worktree C:/a/b\0HEAD x\0branch refs/heads/t\0\0", "r").length, 1)
})
