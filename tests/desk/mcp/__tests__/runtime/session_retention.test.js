// Session retention: what it removes, what it keeps, and how it deletes. Every fixture lives under a temporary root: a fake Copilot app
// database, session folders, a bare remote with clones and worktrees, and old or new files dated with utimes.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, promises as fs } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { mkTempRoot } from "../_temp_roots.js"
import { parseRetentionArgs, runRetention, runSessionRetentionCli, USAGE } from "../../../../../plugins/desk/mcp/src/runtime/session-retention.js"

const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-retention.js", import.meta.url))
const DAY = 86_400_000
const GB = 1_073_741_824
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

async function write(file, content = "x", { daysOld = 0 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  if (daysOld) await age(file, daysOld)
  return file
}

async function age(target, daysOld) {
  const when = new Date(Date.now() - daysOld * DAY)
  await fs.utimes(target, when, when)
  return target
}

// A folder whose own mtime is old: made, filled, then dated.
async function oldDir(dir, files = ["f.js"], daysOld = 10) {
  for (const f of files) await write(path.join(dir, f))
  return age(dir, daysOld)
}

// A session folder whose top-level files are all old (inactive unless something else marks it active) or new.
async function session(state, id, { daysOld = 10, files = {} } = {}) {
  const dir = path.join(state, id)
  await write(path.join(dir, "events.jsonl"), "{}\n", { daysOld })
  await write(path.join(dir, "plan.md"), "plan", { daysOld })
  await fs.mkdir(path.join(dir, "checkpoints"), { recursive: true })
  for (const [name, content] of Object.entries(files)) await write(path.join(dir, name), content, { daysOld })
  return dir
}

function appDb(file, { sessions = [], workspaces = [], aliases = [], worktrees = [] }) {
  const db = new Database(file)
  db.exec(`create table sessions (id text primary key, is_running integer not null default 0, archived_at text);
    create table worktrees (id text primary key, path text not null);
    create table workspaces (id text primary key, session_id text, archived_at text, worktree_id text, source_path text, created_pr_state text);
    create table workspace_session_aliases (session_id text primary key, workspace_id text not null);`)
  for (const s of sessions) db.prepare("insert into sessions (id, is_running, archived_at) values (?, ?, ?)").run(s.id, s.running ? 1 : 0, s.archived ? "2026-01-01" : null)
  for (const w of worktrees) db.prepare("insert into worktrees (id, path) values (?, ?)").run(w.id, w.path)
  for (const w of workspaces) {
    db.prepare("insert into workspaces (id, session_id, archived_at, worktree_id, source_path, created_pr_state) values (?, ?, ?, ?, ?, ?)")
      .run(w.id, w.session ?? null, w.archived ? "2026-01-01" : null, w.worktree ?? null, w.source ?? null, w.pr ?? null)
  }
  for (const a of aliases) db.prepare("insert into workspace_session_aliases (session_id, workspace_id) values (?, ?)").run(a.session, a.workspace)
  db.close()
}

// A bare remote whose main holds a committed .gitignore (dist/), and a clone of it at code/repo.
async function repos(root) {
  const remote = path.join(root, "remote.git")
  const seed = path.join(root, "seed")
  git(root, "init", "--bare", "-b", "main", remote)
  await fs.mkdir(seed)
  git(seed, "init", "-b", "main")
  await write(path.join(seed, ".gitignore"), "dist/\n")
  await write(path.join(seed, "README"), "base\n")
  git(seed, "add", ".")
  git(seed, "commit", "-m", "base")
  git(seed, "remote", "add", "origin", remote)
  git(seed, "push", "-u", "origin", "main")
  const repo = path.join(root, "code", "repo")
  await fs.mkdir(path.dirname(repo), { recursive: true })
  git(root, "clone", "-q", remote, repo)
  return { remote, repo }
}

async function commit(dir, name) {
  await write(path.join(dir, name), name)
  git(dir, "add", name)
  git(dir, "commit", "-q", "-m", name)
}

async function world(prefix) {
  const root = await fs.realpath(await mkTempRoot(prefix))
  const copilot = path.join(root, "copilot")
  const paths = {
    root,
    state: path.join(copilot, "session-state"),
    db: path.join(copilot, "data.db"),
    logs: path.join(copilot, "logs"),
    report: path.join(root, "report"),
    trash: path.join(root, "trash"),
  }
  await fs.mkdir(paths.state, { recursive: true })
  return paths
}

const baseArgs = (w) => ["--session-state", w.state, "--app-db", w.db, "--log-dirs", w.logs, "--report-dir", w.report, "--trash", w.trash, "--git-pause-ms", "0", "--load-limit", "1000"]

function options(argv, env = {}) {
  const parsed = parseRetentionArgs(argv, { env: { HOME: env.HOME ?? "/home/fixture", ...env } })
  assert.ok(parsed.options, parsed.error)
  return parsed.options
}

const byCategory = (report, category) => report.plan.filter((item) => item.category === category).map((item) => item.path).sort()
const skippedReason = (report, p) => report.skipped.find((s) => s.path === p)?.reason

test("a full pass keeps active work and unsafe checkouts, lists the rest, then removes it", async () => {
  const w = await world("desk-session-retention-full-")
  const { remote, repo } = await repos(w.root)
  const wtRoot = path.join(w.root, "code", "repo-worktrees")
  const wt = (name, ...extra) => {
    git(repo, "worktree", "add", "-q", ...extra, path.join(wtRoot, name), "origin/main")
    return path.join(wtRoot, name)
  }

  // Worktrees under the code root, which comes from the app database's worktree rows.
  const activeWt = wt("active-wt", "--detach")
  await oldDir(path.join(activeWt, "node_modules"))
  const yamlWt = wt("yaml-wt", "--detach")
  const prewarm = wt("copilot-prewarm-1", "--detach")
  const staleClean = wt("stale-clean", "--detach")
  const staleUnpushed = wt("stale-unpushed", "--detach")
  await commit(staleUnpushed, "local-only")
  const squashed = wt("stale-squashed", "--detach")
  await commit(squashed, "squashed-one")
  git(squashed, "push", "-q", "origin", "HEAD:refs/pull/1/head")
  const squashed2 = wt(path.join("group", "stale-squashed-2"), "--detach")
  await commit(squashed2, "squashed-two")
  git(squashed2, "push", "-q", "origin", "HEAD:refs/pull/2/head")
  const locked = wt("locked", "--detach")
  git(repo, "worktree", "lock", locked)
  const merging = wt("merging", "--detach")
  await write(path.join(git(merging, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"), "0".repeat(40))
  const standalone = path.join(wtRoot, "standalone")
  git(w.root, "clone", "-q", remote, standalone)
  await oldDir(path.join(wtRoot, "node_modules", "pkg"))

  // Sessions.
  const running = await session(w.state, "s-running")
  const runningModules = await oldDir(path.join(running, "files", "app", "node_modules"))
  const runningDist = path.join(running, "files", "app", "dist")
  await write(path.join(runningDist, "a.js"))
  await write(path.join(running, "files", "old-shot.png"), "png", { daysOld: 10 })
  const runningClone = path.join(running, "files", "clone")
  git(w.root, "clone", "-q", remote, runningClone)
  const runningCloneDist = await oldDir(path.join(runningClone, "dist"))
  const runningCloneTarget = await oldDir(path.join(runningClone, "target"))
  await session(w.state, "s-workspace")
  await session(w.state, "s-alias")
  const live = await session(w.state, "s-live", { files: { "workspace.yaml": `cwd: "${yamlWt}"\nother: 1\n` } })
  await write(path.join(live, `inuse.${process.pid}.lock`), "", { daysOld: 10 })
  const deadLock = await session(w.state, "s-dead-lock")
  await write(path.join(deadLock, "inuse.99999999.lock"), "", { daysOld: 10 })
  const deadVideo = await write(path.join(deadLock, "files", "demo.webm"))
  await session(w.state, "s-recent", { daysOld: 0 })
  await write(path.join(w.state, "stray-file"), "")

  const archived = await session(w.state, "s-archived", { files: { "workspace.yaml": "cwd: /nowhere\n", "notes.md": "keep" } })
  const files = path.join(archived, "files")
  const video = await write(path.join(files, "demo.mp4"))
  const trace = await write(path.join(files, "run.trace"))
  const traceZip = await write(path.join(files, "trace-1.zip"))
  await write(path.join(files, "bundle.zip"))
  const bigProfile = await write(path.join(files, "profile.json"))
  await fs.truncate(bigProfile, 11 * 1_048_576)
  await write(path.join(files, "small-trace.json"), "{}")
  await write(path.join(files, "data.json"), "{}")
  const oldShot = await write(path.join(files, "shot.png"), "png", { daysOld: 10 })
  await write(path.join(files, "new.png"), "png")
  await write(path.join(files, "notes.md"), "keep")
  await write(path.join(files, "a", "b", "c", "d", "e", "f", "g", "deep.mp4"))
  const browser = path.join(files, "browser")
  await write(path.join(browser, "Local State"), "{}")
  const sessionModules = path.join(files, "node_modules")
  await write(path.join(sessionModules, "pkg", "index.js"))
  const cloneSafe = path.join(files, "clone-safe")
  git(w.root, "clone", "-q", remote, cloneSafe)
  const wtSafe = path.join(files, "wt-safe")
  git(repo, "worktree", "add", "-q", "--detach", wtSafe, "origin/main")
  const cloneDirty = path.join(files, "clone-dirty")
  git(w.root, "clone", "-q", remote, cloneDirty)
  await write(path.join(cloneDirty, "scratch.txt"))
  const dirtyModules = await oldDir(path.join(cloneDirty, "node_modules"))
  const dirtyDist = await oldDir(path.join(cloneDirty, "dist"))
  const dirtyTarget = await oldDir(path.join(cloneDirty, "target"))
  const newDist = path.join(cloneDirty, "sub", "dist")
  await write(path.join(newDist, "x.js"))
  await fs.symlink(path.join(w.root, "code"), path.join(files, "link"), "junction")

  const openPr = await session(w.state, "s-open-pr")
  const prShot = await write(path.join(openPr, "files", "shot.png"), "png", { daysOld: 10 })
  const aliasArchived = await session(w.state, "s-alias-archived")
  const aliasVideo = await write(path.join(aliasArchived, "files", "clip.mov"))

  // Checkouts in an inactive session that are not safe to remove, one reason each.
  const unsafe = await session(w.state, "s-unsafe")
  const u = (name) => path.join(unsafe, "files", name)
  await write(path.join(u("broken"), ".git"), "gitdir: /nonexistent/gitdir\n")
  git(w.root, "clone", "-q", remote, u("corrupt-index"))
  await fs.writeFile(path.join(u("corrupt-index"), ".git", "index"), "garbage")
  await fs.mkdir(u("no-remote"), { recursive: true })
  git(u("no-remote"), "init", "-q", "-b", "main")
  await commit(u("no-remote"), "file")
  git(w.root, "clone", "-q", remote, u("stash"))
  await fs.writeFile(path.join(u("stash"), "README"), "changed\n")
  git(u("stash"), "stash", "-q")
  await fs.mkdir(u("unborn"), { recursive: true })
  git(u("unborn"), "init", "-q", "-b", "main")
  git(u("unborn"), "remote", "add", "origin", remote)
  git(w.root, "clone", "-q", remote, u("extra-branch"))
  git(u("extra-branch"), "checkout", "-q", "-b", "feature")
  await commit(u("extra-branch"), "feature-file")
  git(u("extra-branch"), "checkout", "-q", "main")
  git(w.root, "clone", "-q", remote, u("broken-remote"))
  await commit(u("broken-remote"), "local")
  git(u("broken-remote"), "remote", "set-url", "origin", path.join(w.root, "missing.git"))

  // Logs and an opt-in state root.
  const oldLog = await write(path.join(w.logs, "old.log"), "log", { daysOld: 9 })
  const nestedLog = await write(path.join(w.logs, "sub", "older.log"), "log", { daysOld: 30 })
  await write(path.join(w.logs, "new.log"), "log")
  const stateRoot = path.join(w.root, "state")
  const stateModules = await oldDir(path.join(stateRoot, "tool", "node_modules"))
  await oldDir(path.join(stateRoot, "tool", "dist", "node_modules"), ["f.js"], 0)
  const oldProfile = await oldDir(path.join(stateRoot, "profiles", "old"), ["Local State"])
  await oldDir(path.join(stateRoot, "profiles", "locked"), ["Local State", "SingletonLock"])
  await oldDir(path.join(stateRoot, "profiles", "new"), ["Local State"], 0)

  appDb(w.db, {
    sessions: [
      { id: "s-running", running: true, archived: true },
      { id: "s-archived", archived: true },
      { id: "s-workspace" },
      { id: "s-alias" },
      { id: "s-live", archived: true },
      { id: "s-dead-lock", archived: true },
    ],
    worktrees: [{ id: "t-active", path: activeWt }, { id: "t-stale", path: staleClean }],
    workspaces: [
      { id: "w-active", session: "s-workspace", worktree: "t-active", source: repo },
      { id: "w-alias", session: "s-other" },
      { id: "w-pr", session: "s-open-pr", archived: true, pr: "open" },
      { id: "w-archived", archived: true, worktree: "t-stale" },
      { id: "w-live", session: "s-live", archived: true },
    ],
    aliases: [{ session: "s-alias", workspace: "w-alias" }, { session: "s-alias-archived", workspace: "w-archived" }],
  })

  const argv = [...baseArgs(w), "--state-roots", stateRoot, "--sizes"]
  const dry = await runRetention(options(argv), { paceEvery: 1 })
  assert.equal(dry.mode, "dry-run")
  assert.equal(dry.classificationError, null)
  assert.deepEqual(dry.codeRoots, [wtRoot])
  assert.deepEqual(dry.sessions, { active: 5, inactive: 5 })
  assert.deepEqual(dry.worktrees, { protected: 3, candidates: 3 })
  assert.deepEqual(byCategory(dry, "videos"), [video, aliasVideo, deadVideo].sort())
  assert.deepEqual(byCategory(dry, "traces"), [bigProfile, trace, traceZip].sort())
  assert.deepEqual(byCategory(dry, "screenshots"), [oldShot])
  assert.deepEqual(byCategory(dry, "browser-profiles"), [browser])
  assert.deepEqual(byCategory(dry, "state-browser-profiles"), [oldProfile])
  assert.deepEqual(byCategory(dry, "session-clones"), [cloneSafe, wtSafe].sort())
  assert.deepEqual(byCategory(dry, "worktrees"), [staleClean, squashed, squashed2].sort())
  assert.deepEqual(byCategory(dry, "logs"), [oldLog, nestedLog].sort())
  assert.deepEqual(byCategory(dry, "build-output"), [
    path.join(activeWt, "node_modules"), runningModules, runningCloneDist, sessionModules, dirtyModules, dirtyDist, stateModules,
  ].sort())
  assert.ok(!dry.plan.some((item) => [prShot, runningDist, runningCloneTarget, dirtyTarget, newDist, prewarm, yamlWt, locked, merging, standalone].includes(item.path)))
  assert.equal(skippedReason(dry, cloneDirty), "uncommitted changes (3 paths)")
  assert.equal(skippedReason(dry, staleUnpushed), "unpushed commits on HEAD (1 not on any remote)")
  assert.equal(skippedReason(dry, locked), "worktree is locked")
  assert.equal(skippedReason(dry, merging), "git operation in progress (MERGE_HEAD)")
  assert.equal(skippedReason(dry, u("broken")), "git metadata unreadable (broken or orphaned checkout)")
  assert.equal(skippedReason(dry, u("corrupt-index")), "git status failed")
  assert.equal(skippedReason(dry, u("no-remote")), "no git remote")
  assert.equal(skippedReason(dry, u("stash")), "has git stash entries")
  assert.equal(skippedReason(dry, u("unborn")), "cannot compare HEAD with remotes")
  assert.equal(skippedReason(dry, u("extra-branch")), "unpushed commits on feature (1 not on any remote)")
  assert.equal(skippedReason(dry, u("broken-remote")), "unpushed commits on HEAD (1 not on any remote)")
  assert.ok(existsSync(video), "a dry run removes nothing")
  assert.ok(existsSync(path.join(w.report, `${dry.at.slice(0, 10)}-dry-run.json`)))

  const applied = await runRetention(options([...argv, "--apply"]), { paceEvery: 1 })
  assert.equal(applied.mode, "apply")
  assert.deepEqual(applied.applied.failed, [])
  for (const item of dry.plan) assert.equal(existsSync(item.path), false, `${item.path} was removed`)
  for (const kept of [prShot, runningDist, runningCloneTarget, dirtyTarget, newDist, prewarm, yamlWt, locked, merging, standalone, activeWt, cloneDirty,
    path.join(archived, "events.jsonl"), path.join(archived, "plan.md"), path.join(archived, "checkpoints"), path.join(archived, "notes.md"), path.join(files, "notes.md"), path.join(files, "new.png")]) {
    assert.ok(existsSync(kept), `${kept} is kept`)
  }
  const listed = git(repo, "worktree", "list", "--porcelain")
  assert.ok(!listed.includes(staleClean) && !listed.includes(wtSafe), "removed worktrees are pruned from Git")
  assert.deepEqual(await fs.readdir(w.trash), [])
})

test("an unreadable app database leaves sessions and worktrees alone and prunes only logs", async () => {
  const w = await world("desk-session-retention-nodb-")
  const s = await session(w.state, "s-old")
  const video = await write(path.join(s, "files", "demo.mp4"))
  const oldLog = await write(path.join(w.logs, "old.log"), "log", { daysOld: 9 })
  const emptyLog = await write(path.join(w.logs, "empty.log"), "", { daysOld: 9 })
  const report = await runRetention(options([...baseArgs(w), "--ceiling", "--apply"]))
  assert.match(report.classificationError, /cannot read the app database .*; sessions and worktrees left untouched/u)
  assert.deepEqual(report.plan.map((item) => item.path).sort(), [emptyLog, oldLog].sort())
  assert.equal(report.ceiling, null)
  assert.ok(existsSync(video))
  assert.equal(existsSync(oldLog), false)
})

test("default code roots skip the filesystem root, the home folder and roots nested in another", async () => {
  const w = await world("desk-session-retention-roots-")
  const home = path.join(w.root, "home")
  const outer = path.join(w.root, "a")
  appDb(w.db, {
    worktrees: [
      { id: "1", path: path.join(path.parse(w.root).root, "wt-at-root") },
      { id: "2", path: path.join(home, "wt") },
      { id: "3", path: path.join(outer, "wt") },
      { id: "4", path: path.join(outer, "b", "wt") },
      { id: "5", path: path.join(outer, "wt2") },
    ],
  })
  await write(path.join(await session(w.state, "s-old"), "files", "clip.mp4"))
  const report = await runRetention(options([...baseArgs(w), "--skip", "logs,sessions,worktrees,state"], { HOME: home }))
  assert.deepEqual(report.codeRoots, [outer])
  assert.deepEqual(report.plan, [])
  const explicit = await runRetention(options([...baseArgs(w), "--code-roots", [outer, ""].join(path.delimiter), "--worktree-depth", "0"]))
  assert.deepEqual(explicit.codeRoots, [outer])
})

test("overlapping roots list each item once, and a missing du leaves the ceiling unmeasured", async () => {
  const w = await world("desk-session-retention-overlap-")
  const s = await session(w.state, "s-old")
  const video = await write(path.join(s, "files", "clip.mp4"), "v", { daysOld: 10 })
  appDb(w.db, {})
  const argv = [...baseArgs(w), "--log-dirs", path.join(s, "files"), "--ceiling"]
  const saved = process.env.PATH
  // With no PATH, du cannot be found, as on a machine without it.
  process.env.PATH = ""
  let report
  try {
    report = await runRetention(options(argv))
  } finally {
    process.env.PATH = saved
  }
  assert.deepEqual(report.plan.map((item) => [item.category, item.path]), [["logs", video]])
  assert.equal(report.ceiling.unmeasured, true)
})

test("the ceiling prunes the oldest archived sessions first and stops once under it", async () => {
  const w = await world("desk-session-retention-ceiling-")
  const mk = async (id, daysOld) => {
    const dir = await session(w.state, id, { daysOld })
    await write(path.join(dir, "files", "blob.bin"), "b".repeat(5000))
    await write(path.join(dir, "files", "notes.md"), "keep")
    const bigLog = await write(path.join(dir, "files", "big.log"))
    await fs.truncate(bigLog, 2 * 1_048_576)
    await write(path.join(dir, "files", "clip.mp4"))
    await write(path.join(dir, "files", "repo", ".git", "HEAD"), "ref: refs/heads/main\n")
    await write(path.join(dir, "files", "repo", "big.bin"), "b".repeat(5000))
    return dir
  }
  const oldest = await mk("s-archived-old", 30)
  await mk("s-archived-new", 10)
  await mk("s-plain", 40)
  await fs.symlink(w.state, path.join(oldest, "files", "link"), "junction")
  await session(w.state, "s-active", { daysOld: 0 })
  await write(path.join(w.logs, "new.log"), "log")
  const { repo } = await repos(w.root)
  git(repo, "worktree", "add", "-q", "--detach", path.join(w.root, "code", "wts", "stale"), "origin/main")
  git(w.root, "clone", "-q", path.join(w.root, "remote.git"), path.join(w.root, "code", "wts", "clone"))
  appDb(w.db, { sessions: [{ id: "s-archived-old", archived: true }, { id: "s-archived-new", archived: true }] })
  const du = (sizes) => async (p) => sizes[path.basename(p)] ?? 0
  const argv = [...baseArgs(w), "--ceiling", "--ceiling-gb", "5", "--code-roots", path.join(w.root, "code", "wts"), "--log-dirs", [w.logs, path.join(w.root, "missing-logs")].join(path.delimiter)]

  const dry = await runRetention(options(argv), { diskUsage: du({ "session-state": 5 * GB + 1000 }) })
  assert.equal(dry.ceiling.sessionsPruned, 1)
  assert.equal(dry.ceiling.currentBytes, 5 * GB + 1000)
  const pruned = byCategory(dry, "ceiling")
  assert.deepEqual(pruned, [path.join(oldest, "files", "big.log"), path.join(oldest, "files", "blob.bin")].sort())
  assert.ok(dry.ceiling.extraBytes > 0)

  const under = await runRetention(options(argv), { diskUsage: du({ "session-state": 4 * GB }) })
  assert.equal(under.ceiling.sessionsPruned, 0)

  const unmeasured = await runRetention(options(argv), { diskUsage: async () => null })
  assert.deepEqual(unmeasured.ceiling, { unmeasured: true, ceilingBytes: 5 * GB })

  const applied = await runRetention(options([...argv, "--apply"]), { diskUsage: du({ "session-state": 5 * GB + 1000 }) })
  assert.equal(applied.ceiling.sessionsPruned, 1)
  assert.deepEqual(applied.applied.failed, [])
  for (const p of pruned) assert.equal(existsSync(p), false)
  assert.ok(existsSync(path.join(oldest, "files", "notes.md")))
  assert.ok(existsSync(path.join(oldest, "files", "repo", "big.bin")))
  assert.ok("ceiling" in applied.applied.byCategory && "videos" in applied.applied.byCategory)

  const real = await runRetention(options([...baseArgs(w), "--ceiling", "--skip", "logs"]))
  // du measures where it exists; elsewhere (as on Windows without it on PATH) the ceiling says it is unmeasured.
  assert.ok(real.ceiling.unmeasured === true || real.ceiling.currentBytes > 0)
})

test("deletion is paced, rate-limited and survives read-only folders, other volumes and vanished items", async () => {
  const w = await world("desk-session-retention-apply-")
  const s = await session(w.state, "s-old")
  const f = (...p) => path.join(s, "files", ...p)
  const items = {
    eaccesOnce: await write(f("once", "clip.mp4")),
    deniedTree: f("denied", "target"),
    otherError: await write(f("other.mp4")),
    secondOther: await write(f("second", "clip.mov")),
    crossVolume: f("xdev", "node_modules"),
    renameFails: f("eperm", ".next"),
    vanishes: f("vanish", ".turbo"),
  }
  await write(path.join(items.deniedTree, "deep", "pkg.js"))
  await write(path.join(items.crossVolume, "pkg.js"))
  await write(path.join(items.renameFails, "pkg.js"))
  await write(path.join(items.vanishes, "pkg.js"))
  const oldLog = await write(path.join(w.logs, "old.log"), "log", { daysOld: 9 })
  await write(path.join(w.trash, "1", "left", "over.js"))
  appDb(w.db, {})

  const calls = { sleeps: [], chmod: 0 }
  const seen = new Set()
  let clock = Date.now()
  let ticks = 0
  let free = 0
  let readings = 0
  let loads = 0
  const code = (c) => Object.assign(new Error(c), { code: c })
  const real = (p) => fs.rm(p, { recursive: true, force: true })
  const deps = {
    // The clock and the free-space readings move unevenly, so the rate limit sees both a full minute and a too-fast one.
    now: () => (clock += ++ticks % 3 ? 20_000 : 100_000),
    freeBytes: async () => (free += ++readings % 2 ? 4 * GB : 0),
    // The 5-minute load is high on every other reading, so deletion both yields and carries on.
    loadavg: () => [2000, ++loads % 2 ? 2000 : 0, 0],
    sleep: async (ms) => { calls.sleeps.push(ms) },
    paceEvery: 1,
    deleteBatch: 1,
    run: async () => {
      calls.chmod++
      return { ok: true, stdout: "", stderr: "" }
    },
    rm: async (p) => {
      const first = !seen.has(p)
      seen.add(p)
      if (p === oldLog) await real(items.vanishes)
      if (p === items.eaccesOnce && first) throw code("EACCES")
      if (p === items.otherError) throw code("EIO")
      if (p === items.secondOther) throw first ? code("EPERM") : code("EBUSY")
      if (p.includes("-target")) throw code("EACCES")
      return real(p)
    },
    rename: async (from, to) => {
      if (from === items.crossVolume) throw code("EXDEV")
      if (from === items.renameFails) throw code("EPERM")
      return fs.rename(from, to)
    },
  }
  const report = await runRetention(options([...baseArgs(w), "--apply"]), deps)
  const failed = Object.fromEntries(report.applied.failed.map((x) => [x.path, x.reason]))
  assert.equal(existsSync(items.eaccesOnce), false)
  assert.equal(existsSync(items.crossVolume), false)
  assert.equal(failed[items.otherError], "EIO")
  assert.equal(failed[items.secondOther], "EBUSY")
  assert.equal(failed[items.renameFails], "EPERM")
  assert.match(failed[items.vanishes], /ENOENT/u)
  const denied = report.applied.failed.filter((x) => x.reason === "not removable by this user (left in the trash)")
  assert.equal(denied.length, 1, "one undeletable tree is reported once")
  assert.ok(calls.chmod > 0)
  assert.equal(existsSync(path.join(w.trash, "1")), false, "an earlier run's trash goes first")
  assert.ok(calls.sleeps.includes(1500) && calls.sleeps.includes(2000) && calls.sleeps.some((ms) => ms > 0 && ms < 60_000))
})

test("the CLI parses flags, prints a summary or JSON, and reports failures", async () => {
  const w = await world("desk-session-retention-cli-")
  const out = () => {
    const io = { text: "", err: "" }
    return { io, stdout: { write: (t) => { io.text += t } }, stderr: { write: (t) => { io.err += t } } }
  }
  const env = { HOME: path.join(w.root, "home") }
  const cli = async (argv, deps) => {
    const o = out()
    const code = await runSessionRetentionCli({ argv, env, io: o, deps })
    return { code, ...o.io }
  }

  assert.deepEqual(await cli(["--help"]), { code: 0, text: `${USAGE}\n`, err: "" })
  assert.equal((await cli(["-h"])).code, 0)
  for (const [argv, message] of [
    [["--log-days"], "--log-days needs a value"],
    [["--log-days", "soon"], "--log-days needs a number of zero or more, not soon"],
    [["--log-days", " "], "--log-days needs a number of zero or more"],
    [["--log-days", "-1"], "--log-days needs a number of zero or more"],
    [["--skip", "logs,everything"], "--skip takes logs, sessions, worktrees, state, not everything"],
    [["--frobnicate", "1"], "unknown option --frobnicate"],
  ]) {
    const r = await cli(argv)
    assert.equal(r.code, 2)
    assert.ok(r.err.includes(message), r.err)
  }

  const defaults = parseRetentionArgs([], { env: { COPILOT_HOME: path.join(w.root, "copilot"), XDG_STATE_HOME: path.join(w.root, "xdg") }, homeDir: path.join(w.root, "h") }).options
  assert.equal(defaults.home, path.join(w.root, "h"))
  assert.equal(defaults.appDb, path.join(w.root, "copilot", "data.db"))
  assert.equal(defaults.reportDir, path.join(w.root, "xdg", "desk", "session-retention"))
  assert.equal(parseRetentionArgs([]).options.sessionState, path.join(process.env.COPILOT_HOME, "session-state"))
  const fromHome = parseRetentionArgs([], { env: { HOME: env.HOME } }).options
  assert.equal(fromHome.logDirs[0], path.join(env.HOME, ".copilot", "logs"))
  assert.equal(fromHome.trash, path.join(env.HOME, ".local", "state", "desk", "session-retention", "trash"))

  // No app database: logs only, with the reason printed.
  const oldLog = await write(path.join(w.logs, "old.log"), "log", { daysOld: 9 })
  const text = await cli([...baseArgs(w), "--verbose"])
  assert.equal(text.code, 0)
  assert.match(text.text, /^session-retention dry-run \(\d+s\): 1 items would be removed\n/u)
  assert.match(text.text, /cannot read the app database/u)
  assert.match(text.text, /logs +1 items/u)
  assert.match(text.text, /left in place \(unsafe to remove\): 0/u)

  const json = await cli([...baseArgs(w), "--json"])
  const parsed = JSON.parse(json.text)
  assert.equal(parsed.plan, undefined)
  assert.equal(parsed.categories.logs.items, 1)

  // A summary with failures, skipped checkouts and an unmeasured ceiling.
  appDb(w.db, {})
  const s = await session(w.state, "s-old")
  await write(path.join(s, "files", "clip.mp4"))
  await write(path.join(s, "files", "repo", ".git"), "gitdir: /nonexistent\n")
  const failing = await cli([...baseArgs(w), "--apply", "--verbose", "--ceiling", "--sizes"], {
    diskUsage: async () => null,
    rm: async (p) => {
      if (p.endsWith("clip.mp4")) throw Object.assign(new Error("EIO: busy disk"), { code: "EIO" })
      return fs.rm(p, { recursive: true, force: true })
    },
  })
  assert.equal(failing.code, 0)
  assert.match(failing.text, /items removed, \d+\.\d\d GB freed/u)
  assert.match(failing.text, /freed \d+\.\d\d GB/u)
  assert.match(failing.text, /ceiling not checked/u)
  assert.match(failing.text, /failed: 1\n.*clip\.mp4: EIO: busy disk/u)
  assert.match(failing.text, /repo: git metadata unreadable/u)
  assert.ok(!existsSync(oldLog))

  const measured = await cli([...baseArgs(w), "--ceiling"], { diskUsage: async () => 1 })
  assert.match(measured.text, /agent storage 0\.00 GB, ceiling 60\.00 GB; the ceiling pass pruned 0 sessions/u)

  await write(path.join(w.root, "not-a-folder"), "")
  const broken = await cli([...baseArgs(w), "--report-dir", path.join(w.root, "not-a-folder", "report")])
  assert.equal(broken.code, 1)
  assert.match(broken.err, /^session-retention failed: /u)
})

test("the script runs the CLI", async () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8", env: process.env })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, `${USAGE}\n`)
})
