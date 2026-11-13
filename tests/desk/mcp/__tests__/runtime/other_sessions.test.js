// Boot tells the agent which other sessions work in this repo on this machine, and the few rules that follow.
import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { describe, otherSessions, parseProcesses, parseWorktrees, sessionProcesses } from "../../../../../plugins/desk/mcp/src/runtime/other-sessions.js"
import { mkTempRoot } from "../_temp_roots.js"

const porcelain = (...trees) => trees.map(([dir, branch]) => `worktree ${dir}\nHEAD 0123456789abcdef\n${branch === "detached" ? "detached" : `branch refs/heads/${branch}`}\n`).join("\n")

test("git's worktree list reads as directories and branches, leaving out one git would prune", () => {
  const text = `${porcelain(["/r/main", "main"], ["/r/wt/a", "feature-a"], ["/r/wt/b", "detached"])}\nworktree /r/bare\nbare\n\nworktree /r/odd\nHEAD 0123\n\nworktree /r/gone\nHEAD 0123\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n`
  const trees = parseWorktrees(text)
  assert.deepEqual(trees.map(({ dir, branch }) => [dir, branch]), [[path.resolve("/r/main"), "main"], [path.resolve("/r/wt/a"), "feature-a"], [path.resolve("/r/wt/b"), "detached HEAD"], [path.resolve("/r/bare"), "no branch"], [path.resolve("/r/odd"), "no branch"]])
  assert.deepEqual(trees.map(({ bare }) => bare), [false, false, false, true, false])
})

test("only one process per session counts, and never this session's own", () => {
  const rows = parseProcesses([
    "  100     1 1-02:03:04 /bin/agency copilot --server --stdio",
    "  101   100    05:10 /cache/copilot-runtime --server --stdio",
    "  102   101       00:09 /cache/copilot extension_bootstrap.mjs",
    "  200     1       07:30 /usr/local/bin/copilot --resume",
    "  300     1    10:00:00 /bin/agency copilot --server --stdio",
    "  301   300       00:01 /cache/copilot-runtime --server",
    "  400     1       00:02 /usr/bin/vim copilot-notes.md",
  ].join("\n"))
  assert.deepEqual(rows.find((row) => row.pid === 100).up, ((24 + 2) * 60 + 3) * 60 * 1000 + 4000)
  assert.deepEqual(sessionProcesses(rows).map((row) => row.pid), [100, 200, 300])
  assert.deepEqual(sessionProcesses(rows, { hostPid: 301 }).map((row) => row.pid), [100, 200], "the session that runs boot is left out through its parent chain")
})

function machine({ trees, processes = "", cwds = {}, throwPs = false }) {
  return async (file, args) => {
    if (file === "git" && args[0] === "worktree") return porcelain(...trees)
    if (file === "git") return `${trees.find(([dir]) => dir === "/r/wt/me")?.[0] ?? trees[0][0]}\n`
    if (throwPs) throw new Error("spawn ps ENOENT")
    if (file === "ps") return processes
    if (file === "lsof") return Object.entries(cwds).map(([pid, cwd]) => `p${pid}\nfcwd\nn${cwd}`).join("\n")
    throw new Error(`unexpected ${file}`)
  }
}

test("boot lists the other worktrees and sessions here, this one first, and the rules", async () => {
  const trees = [["/r/main", "main"], ["/r/wt/me", "mine"], ["/r/wt/other", "theirs"]]
  const result = await otherSessions({
    cwd: "/r/wt/me", env: { DESK_SESSION_HOST_PID: "501" }, platform: "linux", home: "/h", now: () => Date.parse("2026-11-13T12:00:00Z"),
    exec: machine({
      trees,
      processes: "  500     1 02:00:00 /bin/agency copilot --server\n  501   500    01:00:00 /cache/copilot-runtime --server\n  600     1 03:30 /bin/agency copilot --server\n  700     1 04:00 /bin/agency copilot --server\n",
      cwds: { 600: "/r/wt/other/src", 700: "/r/main" },
    }),
  })
  assert.equal(result.worktrees, 3)
  assert.equal(result.sessions, 2)
  const [head, mine, ...rest] = result.lines
  assert.equal(head, "Other work on this machine in this repo: 3 worktrees, 2 other running sessions.")
  assert.equal(mine, "- /r/wt/me (mine): you are here")
  assert.ok(rest.includes("- /r/wt/other (theirs): 1 session running (up 4 min)"), rest.join("\n"))
  assert.ok(rest.includes("- /r/main (the shared main checkout, main): 1 session running (up 4 min)"), rest.join("\n"))
  assert.match(result.lines.at(-1), /^Rules while others work here: never stash, reset, clean or switch branches in a shared checkout; never touch, move or remove another session's worktree; branch from origin\/main in your own worktree \(`git worktree add <dir> -b <branch> origin\/main`\), and remove only what you created\.$/u)
})

test("a lone session says nothing, and a machine without ps still names the other worktrees", async () => {
  const alone = await otherSessions({ cwd: "/r/main", env: {}, now: Date.now, home: "/h", platform: "linux", exec: machine({ trees: [["/r/main", "main"]], processes: "  500     1 02:00 /bin/agency copilot --server\n", cwds: { 500: "/r/main" } }) })
  assert.equal(alone, null, "the only session in the only worktree: nobody else")
  const crowded = await otherSessions({ cwd: "/r/main", env: {}, now: Date.now, home: "/h", platform: "linux", exec: machine({ trees: [["/r/main", "main"]], processes: "  500     1 02:00 /bin/agency copilot --server\n  501     1 03:00 /bin/agency copilot --server\n", cwds: { 500: "/r/main", 501: "/r/main" } }) })
  assert.equal(crowded.sessions, 1, "two sessions in one shared checkout: one of them is this one")
  assert.match(crowded.lines[1], /^- \/r\/main \(the shared main checkout, main\): you are here; 1 session besides yours$/u)
  const noPs = await otherSessions({ cwd: "/r/wt/me", env: {}, now: Date.now, home: "/h", platform: "linux", exec: machine({ trees: [["/r/main", "main"], ["/r/wt/me", "mine"]], throwPs: true }) })
  assert.equal(noPs.worktrees, 2)
  assert.equal(noPs.sessions, 0)
  const windows = await otherSessions({ cwd: "/r/wt/me", env: {}, now: Date.now, home: "/h", platform: "win32", exec: machine({ trees: [["/r/main", "main"], ["/r/wt/me", "mine"]], throwPs: true }) })
  assert.equal(windows.worktrees, 2)
})

test("a git that cannot answer in time, or a folder that is no repo, leaves boot unhindered", async () => {
  const slow = await otherSessions({ cwd: "/r", env: {}, now: Date.now, home: "/h", platform: "linux", budgetMs: 50, exec: () => new Promise(() => {}) })
  assert.equal(slow, null)
  const notRepo = await otherSessions({ cwd: "/nowhere", env: {}, now: Date.now, home: "/h", platform: "linux", exec: async () => { throw new Error("not a git repository") } })
  assert.equal(notRepo, null)
})

test("a long list shows this worktree first and counts the rest", () => {
  const now = Date.parse("2026-11-13T12:00:00Z")
  const trees = Array.from({ length: 10 }, (_, index) => ({ dir: `/r/wt/${index}`, branch: `b${index}`, activity: now - index * 60000, sessions: 0, upMs: null }))
  trees.push({ dir: "/r/wt/old", branch: "old", activity: now - 9 * 24 * 3600 * 1000, sessions: 0, upMs: null })
  const lines = describe({ trees, current: "/r/wt/9", home: "/h", now })
  assert.match(lines[1], /^- \/r\/wt\/9 \(b9\): you are here$/u)
  assert.equal(lines.filter((line) => line.startsWith("- /r")).length, 6)
  assert.match(lines.find((line) => line.startsWith("- and ")), /^- and 5 more worktrees, quiet for a day or more or past this list; `git worktree list` shows them$/u)
})

test("with a real repo and a linked worktree, boot names both", async () => {
  const base = realpathSync(await mkTempRoot("other-sessions-"))
  const git = (cwd, ...args) => {
    const done = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } })
    assert.equal(done.status, 0, done.stderr)
  }
  const main = path.join(base, "main")
  mkdirSync(main)
  git(main, "init", "-q", "-b", "main")
  writeFileSync(path.join(main, "a.txt"), "a\n")
  git(main, "add", ".")
  git(main, "commit", "-qm", "first")
  const linked = path.join(base, "linked")
  git(main, "worktree", "add", "-q", linked, "-b", "feature")
  const result = await otherSessions({ cwd: linked, env: {}, now: Date.now, platform: "win32", home: base })
  assert.equal(result.worktrees, 2)
  assert.match(result.lines[1], /^- ~\/linked \(feature\): you are here$/u)
  assert.match(result.lines[2], /^- ~\/main \(the shared main checkout, main\): last git activity \d+ min ago$/u)
})

test("the boot text carries the lines, right after the status", () => {
  const text = formatBootText({ status: "ready", degraded: [], pending: [], root: { path: "/desk" }, other_sessions: { lines: ["Other work on this machine in this repo: 2 worktrees, 1 other running session.", "- /r/wt (b): you are here", "Rules while others work here: x"] } })
  assert.match(text, /^Desk boot: ready \| desk \/desk\nOther work on this machine in this repo: 2 worktrees, 1 other running session\.\n- \/r\/wt \(b\): you are here\nRules while others work here: x/u)
})

test("time spans read in minutes, hours and days, and a worktree with a session and no git activity still reads plainly", () => {
  const now = Date.parse("2026-11-13T12:00:00Z")
  const minute = 60 * 1000
  const tree = (dir, activity, sessions = 0, upMs = null) => ({ dir, branch: "b", activity, sessions, upMs })
  const lines = describe({
    trees: [tree("/r/main", now - 3 * minute), tree("/r/wt/h", now - 5 * 60 * minute, 2, 100 * minute), tree("/r/wt/d", null, 1, 3 * 24 * 60 * minute), tree("/r/wt/me", null)],
    current: "/r/wt/me", home: "/h", now,
  })
  assert.ok(lines.includes("- /r/main (the shared main checkout, b): last git activity 3 min ago"), lines.join("\n"))
  assert.ok(lines.includes("- /r/wt/h (b): 2 sessions running (up 2 h); last git activity 5 h ago"), lines.join("\n"))
  assert.ok(lines.includes("- /r/wt/d (b): 1 session running (up 3 days)"), lines.join("\n"))
  assert.ok(lines.includes("- /r/wt/me (b): you are here"), lines.join("\n"))
  assert.equal(describe({ trees: [tree("/r/wt/old", now - 5 * 24 * 60 * minute, 0), tree("/r/wt/me", null)], current: "/r/wt/me", home: "/h", now }).filter((line) => line.startsWith("- and ")).length, 1)
  assert.match(describe({ trees: [tree("/r/wt/old", now - 5 * 24 * 60 * minute), tree("/r/wt/me", null)], current: "/r/wt/me", home: "/h", now })[2], /^- and 1 more worktree, quiet/u)
  assert.equal(describe({ trees: [tree("/h/code/x", now - 1000, 0), tree("/r/wt/me", null)], current: "/r/wt/me", home: "/h", now }).some((line) => line.startsWith("- ~/code/x ")), true)
})

test("a session whose folder is unknown, or outside every worktree, is not counted, and a machine with no sessions skips the folder lookup", async () => {
  const trees = [["/r/main", "main"], ["/r/wt/me", "mine"]]
  const base = { cwd: "/r/wt/me", env: {}, now: Date.now, home: "/h", platform: "linux" }
  const result = await otherSessions({ ...base, exec: machine({ trees, processes: "  600     1 03:30 /bin/agency copilot --server\n  601     1 03:30 /bin/agency copilot --server\n", cwds: { 601: "/elsewhere" } }) })
  assert.equal(result.sessions, 0)
  const calls = []
  const quiet = machine({ trees, processes: "" })
  await otherSessions({ ...base, exec: async (file, args) => { calls.push(file); return quiet(file, args) } })
  assert.equal(calls.includes("lsof"), false)
})

test("a worktree whose .git file names no folder has no git activity to report", async () => {
  const base = realpathSync(await mkTempRoot("other-sessions-nogit-"))
  const wt = path.join(base, "wt")
  mkdirSync(wt)
  writeFileSync(path.join(wt, ".git"), "not a pointer\n")
  const result = await otherSessions({ cwd: wt, env: {}, now: Date.now, home: base, platform: "win32", exec: async (file, args) => (args[0] === "worktree" ? porcelain([path.join(base, "main"), "main"], [wt, "mine"]) : `${wt}\n`) })
  assert.equal(result.lines[1], "- ~/wt (mine): you are here", "no activity fact for a worktree git cannot read")
  assert.match(result.lines[2], /^- and 1 more worktree, quiet/u)
})
