import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import boot from "../../../../../plugins/desk/hooks/lib/boot-checks.cjs"
import { mkTempRoot } from "../_temp_roots.js"
import { liveInspectionChildren, readInspectionGit } from "../../../../../plugins/desk/mcp/src/runtime/git-inspection.js"

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const modulePath = "../../../../../plugins/desk/mcp/src/runtime/unsaved-work.js"

async function fixture(t, { remote = true } = {}) {
  const root = await mkTempRoot("desk-unsaved-work-")
  t.diagnostic(`owned fixture: ${root}`)
  const desk = path.join(root, "private-workspace")
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  await fs.mkdir(path.join(desk, "desks", "member"), { recursive: true })
  await fs.writeFile(path.join(desk, "desks", "member", ".keep"), "")
  await fs.writeFile(path.join(desk, "_meta", "desks.md"), "| alias | identity |\n|---|---|\n| member | fixture |\n")
  git(desk, "init", "-b", "main")
  git(desk, "config", "user.name", "Fixture")
  git(desk, "config", "user.email", "fixture@example.invalid")
  git(desk, "add", ".")
  git(desk, "commit", "-m", "initial")
  if (remote) {
    const origin = path.join(root, "origin.git")
    git(root, "init", "--bare", origin)
    git(desk, "remote", "add", "origin", origin)
    git(desk, "push", "-u", "origin", "main")
  }
  return { root, desk, env: { ...process.env, HOME: root, DESK: desk, DESK_ACTIVATION_CONFIG: "" } }
}

async function line(f, options = {}) {
  const check = boot.checks.find((entry) => entry.id === "unsaved-work")
  assert.ok(check, "shared workspace inspection is registered at startup")
  return boot.runBootChecks({
    checks: [check], host: "copilot", env: f.env, sessionFolder: f.desk,
    totalBudgetMs: 30_000, checkBudgets: { "unsaved-work": 30_000 }, record: async () => {},
    ...options,
  })
}

async function inspect(desk, options = {}) {
  const { inspectUnsavedWork } = await import(modulePath)
  return inspectUnsavedWork({ deskRoot: desk, deadline: performance.now() + 30_000, ...options })
}

test("dirty shared checkout warns without exposing filenames, branches or paths", async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.desk, "private-document\nname"), "private")
  const before = git(f.desk, "status", "--porcelain=v2", "--branch")
  const index = await fs.readFile(path.join(f.desk, ".git", "index"))
  const output = await line(f)
  assert.match(output, /^Desk boot pre-checks: unsaved-work:/)
  assert.match(output, /1 checkout.*1 uncommitted/)
  assert.doesNotMatch(output, /private|member|fixture|Land it|no PR|lost/)
  assert.equal(git(f.desk, "status", "--porcelain=v2", "--branch"), before)
  assert.deepEqual(await fs.readFile(path.join(f.desk, ".git", "index")), index)
  await fs.unlink(path.join(f.desk, "private-document\nname"))
  assert.equal(await line(f), "")
})

test("clean shared checkout and nonshared desk leave healthy output byte-identical", async (t) => {
  const f = await fixture(t)
  assert.equal(await line(f), "")
  await fs.rm(path.join(f.desk, "_meta", "desks.md"))
  assert.equal(await line(f), "")
})

test("member folder resolves the containing shared workspace, not a nested repository", async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.desk, "slides"), "draft")
  assert.match(await inspect(path.join(f.desk, "desks", "member")), /1 uncommitted/)
  const nested = path.join(f.desk, "desks", "member", "nested")
  await fs.mkdir(nested)
  git(nested, "init", "-b", "main")
  assert.equal(await inspect(nested), "")
})

test("ahead commits and pushed but unmerged worktrees are distinct local evidence", async (t) => {
  const f = await fixture(t)
  git(f.desk, "commit", "--allow-empty", "-m", "ahead")
  assert.match(await line(f), /1 ahead of upstream/)
  git(f.desk, "push")
  const worktree = path.join(f.root, "private-linked")
  git(f.desk, "worktree", "add", "-b", "private-branch", worktree)
  git(worktree, "commit", "--allow-empty", "-m", "feature")
  git(worktree, "push", "-u", "origin", "private-branch")
  const output = await line(f)
  assert.match(output, /1 checkout.*1 not in local origin\/main/)
  assert.doesNotMatch(output, /ahead of upstream|private|no PR/)
})

test("no upstream is quiet only when commits are already in local origin/main", async (t) => {
  const f = await fixture(t)
  git(f.desk, "branch", "--unset-upstream")
  assert.equal(await line(f), "")
  git(f.desk, "commit", "--allow-empty", "-m", "unpublished")
  assert.match(await line(f), /1 not in local origin\/main.*1 without upstream/)
})

test("detached work and missing local origin/main never imply publication or PR state", async (t) => {
  const f = await fixture(t)
  git(f.desk, "checkout", "--detach")
  git(f.desk, "commit", "--allow-empty", "-m", "detached")
  assert.match(await line(f), /1 not in local origin\/main.*1 detached/)
  const local = await fixture(t, { remote: false })
  const output = await line(local)
  assert.match(output, /1 integration unknown \(local origin\/main unavailable\)/)
  assert.doesNotMatch(output, /not pushed|lost|no PR/)
})

test("unborn checkout reports dirty work without treating HEAD as an inspectable commit", async (t) => {
  const f = await fixture(t, { remote: false })
  git(f.desk, "checkout", "--orphan", "new")
  git(f.desk, "rm", "-r", "--cached", ".")
  assert.match(await line(f), /2 uncommitted/)
  assert.doesNotMatch(await line(f), /inspection failed/)
})

test("missing and corrupt linked worktrees report incomplete coverage without raw errors", async (t) => {
  const f = await fixture(t)
  const missing = path.join(f.root, "private-missing")
  git(f.desk, "worktree", "add", "-b", "missing", missing)
  await fs.rm(missing, { recursive: true })
  const corrupt = path.join(f.root, "private-corrupt")
  git(f.desk, "worktree", "add", "-b", "corrupt", corrupt)
  await fs.writeFile(path.join(corrupt, ".git"), "invalid private gitdir")
  const output = await line(f)
  assert.match(output, /2 checkouts could not be inspected/)
  assert.doesNotMatch(output, /private|fatal|ENOENT/)
})

test("worktree cap reports retained unknowns and never inspects beyond the cap", async (t) => {
  const f = await fixture(t)
  for (let i = 0; i < 3; i += 1) git(f.desk, "worktree", "add", "-b", `branch-${i}`, path.join(f.root, `linked-${i}`))
  assert.match(await inspect(f.desk, { maxWorktrees: 2 }), /2 checkouts not inspected \(limit\)/)
})

test("expired boot budget is observable, bounded and starts no inspection", async (t) => {
  const f = await fixture(t)
  assert.match(await line(f, { totalBudgetMs: 0 }), /unsaved-work: not checked \(boot budget exhausted\)/)
  const calls = []
  assert.match(await inspect(f.desk, {
    deadline: performance.now() - 1,
    git: async (...args) => { calls.push(args); throw new Error("must not run") },
  }), /budget/)
  assert.deepEqual(calls, [])
})

test("stalled inspection aborts within the existing registry budget", async (t) => {
  const f = await fixture(t)
  let aborted = false
  const started = performance.now()
  const output = await line(f, {
    totalBudgetMs: 300, checkBudgets: { "unsaved-work": 60 },
    spawnGit: () => ({ status: 0, stdout: "", stderr: "" }),
    unsavedWorkGit: (_cwd, _args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("private-path")) }, { once: true })
    }),
  })
  assert.match(output, /unsaved-work: not checked \(boot budget exhausted\)/)
  assert.equal(aborted, true)
  assert.ok(performance.now() - started < 2000)
  assert.equal(boot.TOTAL_BUDGET_MS, 300)
})

test("inspection errors and malformed output produce a fixed privacy-safe warning", async (t) => {
  const f = await fixture(t)
  for (const git of [
    async () => { throw new Error("/private/secret branch-name") },
    async () => ({ ok: false, stderr: "/private/secret" }),
    async () => ({ ok: true, stdout: "malformed private output" }),
  ]) {
    const output = await inspect(f.desk, { git })
    assert.match(output, /inspection incomplete/)
    assert.doesNotMatch(output, /private|secret|branch-name/)
  }
})

test("missing promisor objects never start an implicit fetch during inspection", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t)
  const marker = path.join(f.root, "fetch-attempt")
  const upload = path.join(f.root, "upload.cjs")
  await fs.writeFile(upload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "attempt"); process.exit(1)\n`)
  git(f.desk, "config", "remote.origin.uploadpack", `"${process.execPath}" "${upload}"`)
  git(f.desk, "config", "remote.origin.promisor", "true")
  git(f.desk, "config", "extensions.partialClone", "origin")
  const head = git(f.desk, "rev-parse", "HEAD")
  await fs.unlink(path.join(f.desk, ".git", "objects", head.slice(0, 2), head.slice(2)))
  // Establish that this owned remote records a lazy-fetch attempt without the inspection guard.
  assert.throws(() => git(f.desk, "cat-file", "-t", head))
  assert.equal(await fs.readFile(marker, "utf8"), "attempt")
  await fs.unlink(marker)
  const result = await readInspectionGit(f.desk, ["cat-file", "-t", head])
  assert.equal(result.ok, false)
  await assert.rejects(fs.stat(marker), { code: "ENOENT" })
  assert.match(await line(f), /could not be inspected|integration unknown/)
  await assert.rejects(fs.stat(marker), { code: "ENOENT" })
  assert.equal(liveInspectionChildren(), 0)
})

test("inspection disables configured fsmonitor and reports staged renames once", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t)
  git(f.desk, "mv", "_meta/desks.md", "_meta/desks-renamed.md")
  // Keep the shared-workspace identity while the staged rename remains observable.
  await fs.writeFile(path.join(f.desk, "_meta", "crew.json"), "{}")
  const marker = path.join(f.root, "fsmonitor-attempt")
  const monitor = path.join(f.desk, ".git", "monitor")
  await fs.writeFile(monitor, `#!/bin/sh\nprintf attempt > '${marker}'\n`)
  await fs.chmod(monitor, 0o755)
  git(f.desk, "config", "core.fsmonitor", monitor)
  const output = await line(f)
  assert.match(output, /3 uncommitted entries/)
  await assert.rejects(fs.stat(marker), { code: "ENOENT" })
})

test("default cap checks sixteen places and reports the seventeenth without leaking names", async (t) => {
  const f = await fixture(t)
  for (let i = 0; i < 16; i += 1) git(f.desk, "worktree", "add", "-b", `private-${i}`, path.join(f.root, `private-${i}`))
  const last = path.join(f.root, "private-15")
  await fs.writeFile(path.join(last, "private-file"), "draft")
  const output = await inspect(f.desk)
  assert.match(output, /1 checkout not inspected \(limit\)/)
  assert.doesNotMatch(output, /private/)
  // When the bound clone is last in the inventory it still gets inspected inside the cap.
  assert.match(await inspect(last), /1 uncommitted entries/)
})

test("registry timeout terminates its real blocked inspection child", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t)
  const fifo = path.join(f.root, "blocked-include")
  execFileSync("mkfifo", [fifo])
  let pending
  const started = performance.now()
  const output = await line(f, {
    totalBudgetMs: 300, checkBudgets: { "unsaved-work": 60 },
    unsavedWorkGit: (cwd, args, options) => {
      pending = readInspectionGit(cwd, ["-c", `include.path=${fifo}`, ...args], options)
      return pending
    },
  })
  assert.match(output, /budget/)
  assert.ok(pending, "the real inspection started")
  await assert.rejects(pending, /aborted|timed out/)
  assert.equal(liveInspectionChildren(), 0)
  const elapsed = performance.now() - started
  t.diagnostic(`blocked inspection and child reaping: ${Math.round(elapsed)} ms; check allowance 60 ms`)
  assert.ok(elapsed < 2000)
})

test("binding failures stay private and headless sessions start no inspection", async (t) => {
  const f = await fixture(t)
  const config = path.join(f.root, "private-binding.json")
  await fs.writeFile(config, "{")
  const unavailable = await line(f, {
    sessionFolder: f.root, env: { ...f.env, DESK_ACTIVATION_CONFIG: config },
  })
  assert.match(unavailable, /unsaved-work: binding unavailable/)
  assert.doesNotMatch(unavailable, /private|SyntaxError/)
  assert.equal(await line(f, {
    env: { ...f.env, DESK_FACTORY_HEADLESS: "1" },
    unsavedWorkGit: () => { throw new Error("headless inspection must not run") },
  }), "")
  assert.equal(await inspect(undefined), "")
})

test("a missing upstream is unknown and Claude uses the same bound workspace", async (t) => {
  const f = await fixture(t)
  git(f.desk, "branch", "feature")
  git(f.desk, "push", "-u", "origin", "feature")
  git(f.desk, "checkout", "feature")
  git(f.desk, "branch", "-dr", "origin/feature")
  const output = await line(f, { host: "claude", env: { ...f.env, CLAUDE_PROJECT_DIR: f.desk } })
  assert.match(output, /upstream comparison unavailable/)
  assert.doesNotMatch(output, /ahead of upstream|not in local origin\/main/)
})

test("changed tracked files never execute a configured clean filter", async (t) => {
  const f = await fixture(t)
  const file = path.join(f.desk, "filtered.txt")
  await fs.writeFile(file, "original\n")
  await fs.writeFile(path.join(f.desk, ".gitattributes"), "filtered.txt filter=marker\n")
  git(f.desk, "add", ".")
  git(f.desk, "commit", "-m", "filter fixture")
  git(f.desk, "push")
  const marker = path.join(f.root, "filter-executed")
  const script = path.join(f.root, "filter.cjs")
  await fs.writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdin.pipe(process.stdout)\n`)
  git(f.desk, "config", "filter.marker.clean", `"${process.execPath}" "${script}"`)
  await fs.writeFile(file, "changed!\n")
  git(f.desk, "status", "--porcelain=v2")
  assert.equal(await fs.readFile(marker, "utf8"), "executed", "the harmless fixture proves status invokes the filter")
  await fs.unlink(marker)
  const output = await inspect(f.desk)
  await assert.rejects(fs.stat(marker), { code: "ENOENT" })
  assert.match(output, /content.*not compared|content.*unknown/)
})

test("snapshot time consumes the same wall-clock boot deadline", async (t) => {
  const f = await fixture(t)
  let now = 0
  t.mock.method(performance, "now", () => now)
  const allowances = []
  const output = await line(f, {
    totalBudgetMs: 300, checkBudgets: { "unsaved-work": 100 },
    spawnGit: (_command, args, options) => {
      if (args.includes("rev-parse")) return { status: 0, stdout: "true\n" }
      const allowance = Math.min(180, options.timeout)
      allowances.push(allowance)
      now += allowance
      return allowance < 180
        ? { status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }
        : { status: 0, stdout: "" }
    },
  })
  assert.ok(now <= 300, `snapshots spent ${now} ms outside the 300 ms deadline`)
  assert.deepEqual(allowances, [180, 120])
  assert.match(output, /budget exhausted/)
})

test("submodule content stays unknown without executing its clean filter", async (t) => {
  const f = await fixture(t)
  const source = path.join(f.root, "submodule-source")
  await fs.mkdir(source)
  git(source, "init", "-b", "main")
  git(source, "config", "user.name", "Fixture")
  git(source, "config", "user.email", "fixture@example.invalid")
  await fs.writeFile(path.join(source, "filtered.txt"), "original\n")
  await fs.writeFile(path.join(source, ".gitattributes"), "filtered.txt filter=marker\n")
  git(source, "add", ".")
  git(source, "commit", "-m", "submodule fixture")
  git(f.desk, "-c", "protocol.file.allow=always", "submodule", "add", source, "module")
  git(f.desk, "commit", "-m", "owned submodule")
  git(f.desk, "push")
  const submodule = path.join(f.desk, "module")
  const marker = path.join(f.root, "submodule-filter-executed")
  const script = path.join(f.root, "submodule-filter.cjs")
  await fs.writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdin.pipe(process.stdout)\n`)
  git(submodule, "config", "filter.marker.clean", `"${process.execPath}" "${script}"`)
  await fs.writeFile(path.join(submodule, "filtered.txt"), "changed!\n")
  git(f.desk, "status", "--porcelain=v2")
  assert.equal(await fs.readFile(marker, "utf8"), "executed")
  await fs.unlink(marker)
  const output = await line(f)
  await assert.rejects(fs.stat(marker), { code: "ENOENT" })
  assert.match(output, /1 tracked entries need review \(content not compared\)/)
  assert.doesNotMatch(output, /uncommitted entries/)
})

test("process filters never start and metadata-only changes are not called uncommitted content", async (t) => {
  const f = await fixture(t)
  const file = path.join(f.desk, "filtered.txt")
  await fs.writeFile(file, "original\n")
  await fs.writeFile(path.join(f.desk, ".gitattributes"), "filtered.txt filter=marker\n")
  git(f.desk, "add", ".")
  git(f.desk, "commit", "-m", "process filter fixture")
  git(f.desk, "push")
  const marker = path.join(f.root, "process-filter-executed")
  const script = path.join(f.root, "process-filter.cjs")
  await fs.writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.exit(1)\n`)
  git(f.desk, "config", "filter.marker.process", `"${process.execPath}" "${script}"`)
  // Only metadata changes; a content comparison would find the original bytes.
  await fs.utimes(file, new Date("2020-01-01"), new Date("2020-01-01"))
  try { git(f.desk, "status", "--porcelain=v2") } catch { /* the deliberately incomplete process protocol can fail */ }
  assert.equal(await fs.readFile(marker, "utf8"), "executed")
  await fs.unlink(marker)
  const output = await line(f)
  await assert.rejects(fs.stat(marker), { code: "ENOENT" })
  assert.match(output, /content not compared/)
  assert.doesNotMatch(output, /uncommitted entries/)
})

test("NUL-delimited path counts preserve leading whitespace instead of merging distinct paths", async (t) => {
  const f = await fixture(t)
  for (const name of [" leading", "leading"]) await fs.writeFile(path.join(f.desk, name), "draft")
  git(f.desk, "add", ".")
  for (const name of [" untracked", "untracked"]) await fs.writeFile(path.join(f.desk, name), "draft")
  assert.match(await line(f), /4 uncommitted entries/)
})

test("a commit after the initial inventory cannot produce a clean publication observation", async (t) => {
  const f = await fixture(t)
  git(f.desk, "branch", "--unset-upstream")
  let changed = false
  const output = await inspect(f.desk, {
    git: async (cwd, args, options) => {
      const result = await readInspectionGit(cwd, args, options)
      if (!changed && args.includes("list")) {
        changed = true
        git(f.desk, "commit", "--allow-empty", "-m", "arriving commit")
      }
      return result
    },
  })
  assert.notEqual(git(f.desk, "rev-parse", "HEAD"), git(f.desk, "rev-parse", "origin/main"))
  assert.match(output, /inspection.*unknown|inventory changed/)
  assert.doesNotMatch(output, /arriving|private|fixture/)
})

test("a branch switch at the same commit invalidates the initial inventory", async (t) => {
  const f = await fixture(t)
  const original = git(f.desk, "rev-parse", "HEAD")
  let changed = false
  const output = await inspect(f.desk, {
    git: async (cwd, args, options) => {
      const result = await readInspectionGit(cwd, args, options)
      if (!changed && args.includes("list")) {
        changed = true
        git(f.desk, "checkout", "-b", "private-new-branch")
      }
      return result
    },
  })
  assert.equal(git(f.desk, "rev-parse", "HEAD"), original)
  assert.match(output, /inspection.*unknown|inventory changed/)
  assert.doesNotMatch(output, /private|fixture/)
})

test("an unavailable final inventory cannot turn partial inspection into a clean observation", async (t) => {
  const f = await fixture(t)
  let inventories = 0
  const output = await inspect(f.desk, {
    git: async (cwd, args, options) => {
      if (args.includes("list") && ++inventories === 2) return { ok: false, stdout: "", stderr: "private inventory error", code: 128 }
      return readInspectionGit(cwd, args, options)
    },
  })
  assert.match(output, /inspection incomplete.*unknown/)
  assert.doesNotMatch(output, /private|inventory error/)
})

test("a truncated final inventory invalidates otherwise clean checkout observations", async (t) => {
  const f = await fixture(t)
  let inventories = 0
  const output = await inspect(f.desk, {
    git: async (cwd, args, options) => {
      const result = await readInspectionGit(cwd, args, options)
      if (args.includes("list") && ++inventories === 2) return { ...result, stdout: result.stdout.split("\0")[0] }
      return result
    },
  })
  assert.match(output, /inventory changed.*unknown/)
  assert.doesNotMatch(output, /private|fixture/)
})

test("the final inventory cannot start after the existing inspection deadline", async (t) => {
  const f = await fixture(t)
  let now = 0
  let inventories = 0
  t.mock.method(performance, "now", () => now)
  const output = await inspect(f.desk, {
    deadline: 100,
    git: async (cwd, args, options) => {
      if (args.includes("list")) inventories += 1
      const result = await readInspectionGit(cwd, args, { ...options, timeoutMs: 30_000 })
      if (args.includes("rev-list")) now = 100
      return result
    },
  })
  assert.match(output, /budget exhausted.*unknown/)
  assert.equal(inventories, 1, "the expired final inventory was not dispatched")
})

for (const scenario of [
  { name: "a successful final inventory after the deadline cannot admit silence", settledAt: 101, dirty: false, abort: false, unknown: true },
  { name: "a successful final inventory at the deadline cannot admit counts", settledAt: 100, dirty: true, abort: false, unknown: true },
  { name: "a successful final inventory after cancellation cannot admit counts", settledAt: 0, dirty: true, abort: true, unknown: true },
  { name: "a successful final inventory before the deadline preserves clean silence", settledAt: 99, dirty: false, abort: false, unknown: false },
]) {
  test(scenario.name, async (t) => {
    const f = await fixture(t)
    if (scenario.dirty) await fs.writeFile(path.join(f.desk, "private-draft"), "draft")
    const cancellation = new AbortController()
    let now = 0
    let inventories = 0
    let initial
    t.mock.method(performance, "now", () => now)
    const output = await inspect(f.desk, {
      deadline: 100, signal: cancellation.signal,
      git: async (cwd, args, options) => {
        if (args.includes("list") && ++inventories === 2) {
          now = scenario.settledAt
          if (scenario.abort) cancellation.abort()
          return initial
        }
        const result = await readInspectionGit(cwd, args, { ...options, timeoutMs: 30_000 })
        if (args.includes("list")) initial = result
        return result
      },
    })
    assert.equal(inventories, 2, "the final inventory started before the controlled expiry or cancellation")
    if (scenario.unknown) {
      assert.match(output, /budget exhausted.*unknown/)
      assert.doesNotMatch(output, /uncommitted entries|publication review|private/)
    } else {
      assert.equal(output, "")
    }
  })
}
