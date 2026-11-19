// The launcher a wake runner calls: it fetches the release branch into its own clone, and without one resolves the released Desk through Agency's plugin cache, falls back to the last good path and says so.
import assert from "node:assert/strict"
import { spawn as spawnAsync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { installLauncher } from "../../../../../plugins/desk/mcp/src/runtime/drains.js"
import { launch, makeGit } from "../../../../../plugins/desk/mcp/scripts/drains-launcher.mjs"

const SPEC = (channel) => `copilot:github:ourostack/desk:plugins/desk@${channel}`

// A fake Agency cache: `entries` is [dir_name, spec, fetched_at, hasScript].
function cacheOf(root, entries) {
  const cache = path.join(root, "cache")
  const index = { entries: {} }
  for (const [dir, spec, fetched, hasScript] of entries) {
    index.entries[`${spec}#${dir}`] = { spec, dir_name: dir, ...(fetched === undefined ? {} : { fetched_at: fetched }) }
    if (hasScript) {
      mkdirSync(path.join(cache, "entries", dir, "mcp", "scripts"), { recursive: true })
      writeFileSync(path.join(cache, "entries", dir, "mcp", "scripts", "drains.js"), "")
    }
  }
  mkdirSync(cache, { recursive: true })
  writeFileSync(path.join(cache, "cache_index.json"), JSON.stringify(index))
  return cache
}

const offline = () => ({ status: 1, stderr: "offline\n" })

function run(root, cache, extra = {}) {
  const calls = []
  const err = []
  const status = launch({
    argv: ["poll"],
    env: { XDG_STATE_HOME: path.join(root, "state"), AGENCY_PLUGIN_CACHE: cache, ...extra.env },
    home: root,
    git: Object.hasOwn(extra, "git") ? extra.git : offline,
    spawn: (...args) => { calls.push(args); return { status: extra.status === undefined ? 0 : extra.status } },
    stderr: { write: (text) => err.push(text) },
    execPath: "/node",
    now: () => new Date("2026-11-13T22:00:00Z"),
  })
  const dir = path.join(root, "state", "ouroboros-skills", "desk", "drains")
  return { status, calls, err, lastGood: path.join(dir, "last-good-script"), log: path.join(dir, "resolve.log") }
}

test("runs the newest released entry that has the script, ignoring other channels and entries without it, and remembers the path", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const cache = cacheOf(root, [
    ["old", SPEC("release"), 100, true],
    ["newest-without-script", SPEC("release"), 300, false],
    ["new", "claude:github:ourostack/desk:plugins/desk@release", 200, true],
    ["main", SPEC("main"), 400, true],
    ["unstamped", SPEC("release"), undefined, true],
    ["also-unstamped", SPEC("release"), undefined, true],
    ["oldest", SPEC("release"), 50, true],
  ])
  const r = run(root, cache)
  const wanted = path.join(cache, "entries", "new", "mcp", "scripts", "drains.js")
  assert.equal(r.status, 0)
  assert.equal(r.calls.length, 1)
  assert.deepEqual(r.calls[0].slice(0, 2), ["/node", [wanted, "poll"]])
  assert.equal(r.calls[0][2].windowsHide, true)
  assert.equal(r.calls[0][2].env.DESK_DRAINS_RELEASE, process.env.DESK_DRAINS_RELEASE)
  assert.equal(readFileSync(r.lastGood, "utf8"), `${wanted}\n`)
  assert.deepEqual(r.err, [])
  // The same path again leaves the record alone; a different one replaces it.
  assert.equal(run(root, cache).status, 0)
  assert.equal(readFileSync(r.lastGood, "utf8"), `${wanted}\n`)
  const newer = cacheOf(root, [["newer", SPEC("release"), 900, true]])
  run(root, newer)
  assert.equal(readFileSync(r.lastGood, "utf8"), `${path.join(newer, "entries", "newer", "mcp", "scripts", "drains.js")}\n`)
})

test("passes the script's exit status on, and treats a script that never ran as a failure", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const cache = cacheOf(root, [["a", SPEC("release"), 1, true]])
  assert.equal(run(root, cache, { status: 3 }).status, 3)
  assert.equal(run(root, cache, { status: null }).status, 1)
})

test("falls back to the last good path when the cache cannot be read, and logs one line to stderr and resolve.log", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const good = cacheOf(root, [["a", SPEC("release"), 1, true]])
  const first = run(root, good)
  const script = path.join(good, "entries", "a", "mcp", "scripts", "drains.js")
  for (const broken of [path.join(root, "no-cache"), cacheOf(path.join(root, "x"), [["m", SPEC("main"), 1, true]])]) {
    const r = run(root, broken)
    assert.equal(r.status, 0)
    assert.deepEqual(r.calls[0].slice(0, 2), ["/node", [script, "poll"]])
    assert.equal(r.err.length, 1)
    assert.ok(r.err[0].startsWith("2026-11-13T22:00:00.000Z could not resolve the released Desk ("), r.err[0])
    assert.ok(r.err[0].endsWith(`); using the last good path ${script}\n`), r.err[0])
  }
  assert.equal(readFileSync(first.log, "utf8").split("\n").filter(Boolean).length, 2)
})

test("an index with no entries is an unresolved Desk, not a crash", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const cache = path.join(root, "cache")
  mkdirSync(cache, { recursive: true })
  writeFileSync(path.join(cache, "cache_index.json"), "{}")
  const r = run(root, cache)
  assert.equal(r.status, 1)
  assert.match(r.err[0], /no released Desk entry.*no last good path/u)
})

test("stops with a failure when there is no last good path, or it no longer exists", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const none = run(root, path.join(root, "no-cache"))
  assert.equal(none.status, 1)
  assert.match(none.err[0], /no last good path/u)
  assert.deepEqual(none.calls, [])
  writeFileSync(none.lastGood, `${path.join(root, "gone.js")}\n`)
  const gone = run(root, path.join(root, "no-cache"))
  assert.equal(gone.status, 1)
  assert.deepEqual(gone.calls, [])
})

test("state lives under XDG_STATE_HOME when it is an absolute path, else under the home folder, and the defaults are the real environment", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const cache = cacheOf(root, [["a", SPEC("release"), 1, true]])
  const calls = []
  const spawn = (...args) => { calls.push(args); return { status: 0 } }
  for (const XDG_STATE_HOME of ["relative", undefined]) {
    launch({ argv: [], env: { XDG_STATE_HOME, AGENCY_PLUGIN_CACHE: cache }, home: root, spawn, git: offline })
    assert.ok(existsSync(path.join(root, ".local", "state", "ouroboros-skills", "desk", "drains", "last-good-script")))
  }
  // Every default: this process's environment, home folder, stderr and node.
  const home = process.env.HOME
  const defaultCache = path.join(home, ".local", "agency", "plugins", "cache")
  assert.equal(existsSync(defaultCache), false)
  const quiet = process.stderr.write
  process.stderr.write = () => true
  try {
    assert.equal(launch({ argv: [], spawn, git: offline }), 1)
    cacheOf(path.join(home, ".local", "agency", "plugins"), [["a", SPEC("release"), 1, true]])
    assert.equal(launch({ argv: ["status"], spawn, git: offline }), 0)
  } finally {
    process.stderr.write = quiet
  }
  // The real spawn, on a script that does nothing.
  assert.equal(launch({ argv: [], env: { XDG_STATE_HOME: path.join(root, "real"), AGENCY_PLUGIN_CACHE: cache }, home: root, git: offline }), 0)
  assert.equal(calls.at(-1)[0], process.execPath)
  assert.deepEqual(calls.at(-1)[1].slice(1), ["status"])
})

test("the installed copy runs as a program: it finds the released script and passes its output and status through", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const cache = path.join(root, "cache")
  mkdirSync(path.join(cache, "entries", "r", "mcp", "scripts"), { recursive: true })
  writeFileSync(path.join(cache, "entries", "r", "mcp", "scripts", "drains.js"), "console.log(JSON.stringify(process.argv.slice(2))); process.exit(4)\n")
  writeFileSync(path.join(cache, "cache_index.json"), JSON.stringify({ entries: { a: { spec: SPEC("release"), dir_name: "r", fetched_at: 1 } } }))
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, "state"), AGENCY_PLUGIN_CACHE: cache, DESK_DRAINS_RELEASE_URL: path.join(root, "no-such-repo") }
  const { path: installed } = installLauncher({ env })
  const result = spawnSync(process.execPath, [installed, "poll", "--x"], { encoding: "utf8", env })
  assert.equal(result.status, 4, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), ["poll", "--x"])
  assert.equal(fileURLToPath(new URL(`file://${installed}`)), installed)
})

// A real git repository standing in for ourostack/desk: a `release` branch holding plugins/desk, committed on demand.
function releaseRepo(root, { script = true } = {}) {
  const repo = path.join(root, "desk-remote")
  mkdirSync(repo, { recursive: true })
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: repo, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git("init", "--quiet")
  git("checkout", "--quiet", "-b", "release")
  let n = 0
  const commit = (version) => {
    mkdirSync(path.join(repo, "plugins", "desk", "mcp", "scripts"), { recursive: true })
    writeFileSync(path.join(repo, "plugins", "desk", "plugin.json"), JSON.stringify({ name: "desk", version }))
    if (script) writeFileSync(path.join(repo, "plugins", "desk", "mcp", "scripts", "drains.js"), `// ${version}\n`)
    mkdirSync(path.join(repo, "other"), { recursive: true })
    writeFileSync(path.join(repo, "other", "file.txt"), `${++n}\n`)
    git("add", "-A")
    git("commit", "--quiet", "-m", `Release Desk ${version}`)
    return git("rev-parse", "HEAD")
  }
  return { repo, commit }
}

test("fetches the release branch into its own clone, runs it, and refreshes only when the branch moved", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const { repo, commit } = releaseRepo(root)
  const first = commit("3.2.122")
  const cache = path.join(root, "no-cache")
  const dir = path.join(root, "state", "ouroboros-skills", "desk", "drains")
  const script = path.join(dir, "desk-release", "plugins", "desk", "mcp", "scripts", "drains.js")
  const seen = []
  const go = (extra = {}) => {
    const r = run(root, cache, { env: { DESK_DRAINS_RELEASE_URL: repo }, git: extra.git, status: 0 })
    seen.push(r.calls[0][2].env.DESK_DRAINS_RELEASE)
    return r
  }
  // The default git: the real one, against the local repository.
  let r = go()
  assert.deepEqual(r.calls[0].slice(0, 2), ["/node", [script, "poll"]])
  assert.deepEqual(r.err, [])
  assert.equal(readFileSync(script, "utf8"), "// 3.2.122\n")
  assert.equal(existsSync(path.join(dir, "desk-release", "other")), false, "only plugins/desk is checked out")
  // Unchanged: one probe and one rev-parse, nothing fetched.
  const verbs = []
  const counting = (args, ms) => { verbs.push(args.find((arg) => ["ls-remote", "rev-parse", "fetch", "clone"].includes(arg))); return spawnSync("git", args, { encoding: "utf8", timeout: ms }) }
  r = go({ git: counting })
  assert.deepEqual(verbs, ["ls-remote", "rev-parse"])
  // A new release replaces the files in the same clone.
  const second = commit("3.2.123")
  r = go()
  assert.equal(readFileSync(script, "utf8"), "// 3.2.123\n")
  assert.deepEqual(seen, [first, first, second])
  assert.equal(existsSync(r.lastGood), false, "the Agency cache is never consulted while the own copy works")
})

test("when GitHub cannot be asked, the own copy runs and one line says so; a broken clone is fetched again", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const { repo, commit } = releaseRepo(root)
  const sha = commit("3.2.122")
  const cache = path.join(root, "no-cache")
  const base = { env: { DESK_DRAINS_RELEASE_URL: repo }, git: undefined }
  run(root, cache, base)
  const r = run(root, cache, { ...base, git: (args, ms) => (args.includes("ls-remote") ? { status: 1, stderr: "could not resolve host\n" } : spawnSync("git", args, { encoding: "utf8", timeout: ms })) })
  assert.equal(r.status, 0)
  assert.equal(r.calls[0][2].env.DESK_DRAINS_RELEASE, sha)
  assert.equal(r.err.length, 1)
  assert.ok(r.err[0].endsWith(`could not fetch the released Desk (could not resolve host); using the copy from ${sha.slice(0, 8)}\n`), r.err[0])
  assert.equal(readFileSync(r.log, "utf8"), r.err[0])
  // A clone that git cannot read is replaced.
  const clone = path.join(path.dirname(r.log), "desk-release")
  writeFileSync(path.join(clone, ".git", "HEAD"), "garbage")
  const fixed = run(root, cache, base)
  assert.equal(fixed.calls[0][2].env.DESK_DRAINS_RELEASE, sha)
  assert.deepEqual(fixed.err, [])
})

test("with no clone and no GitHub, the Agency cache is used and the line gives both reasons; every way git can fail has a reason", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const cache = cacheOf(root, [["a", SPEC("release"), 1, true]])
  const asked = []
  const fails = [
    [(args) => { asked.push(args); return { status: 1, stderr: "fatal: unable to access\nmore\n" } }, "fatal: unable to access"],
    [() => ({ status: null, error: new Error("spawn git ENOENT") }), "spawn git ENOENT"],
    [() => ({ status: 1, stderr: "\n", error: new Error("spawn git EACCES") }), "spawn git EACCES"],
    [() => ({ status: 1, stderr: "" }), "git failed"],
    [() => ({ status: 0, stdout: "" }), "the release branch was not found"],
  ]
  for (const [git, reason] of fails) {
    const r = run(root, path.join(root, "nope"), { git })
    assert.equal(r.status, 1)
    assert.ok(r.err[0].includes(`(${reason}; `), r.err[0])
  }
  assert.deepEqual(asked[0].slice(0, 3), ["ls-remote", "https://github.com/ourostack/desk.git", "refs/heads/release"])
  assert.equal(run(root, cache).status, 0)
})

test("a release branch without the script is not run; the Agency cache is", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const { repo, commit } = releaseRepo(root, { script: false })
  commit("3.2.122")
  const cache = cacheOf(root, [["a", SPEC("release"), 1, true]])
  const r = run(root, cache, { env: { DESK_DRAINS_RELEASE_URL: repo }, git: undefined })
  assert.deepEqual(r.calls[0].slice(0, 2), ["/node", [path.join(cache, "entries", "a", "mcp", "scripts", "drains.js"), "poll"]])
  assert.equal(r.calls[0][2].env.DESK_DRAINS_RELEASE, process.env.DESK_DRAINS_RELEASE)
  // With the cache gone too, the line has only the cache's reason: the fetch itself worked.
  const broken = run(root, path.join(root, "nope"), { env: { DESK_DRAINS_RELEASE_URL: repo }, git: undefined })
  assert.equal(broken.status, 0)
  assert.match(broken.err[0], /could not resolve the released Desk \(ENOENT/u)
})

test("a git that cannot find git-remote-https is retried with the helper directory beside a git on PATH, then without GIT_EXEC_PATH", () => {
  const missing = { status: 128, stderr: "git: 'remote-https' is not a git command. See 'git --help'.\n" }
  const helper = path.join("/cache/bin", "..", "libexec", "git-core")
  const seen = []
  const spawn = (cmd, args, options) => { seen.push(options.env.GIT_EXEC_PATH); return options.env.GIT_EXEC_PATH === helper ? { status: 0, stdout: "ok" } : missing }
  const exists = (file) => file === path.join(helper, "git-remote-http")
  // The background caller has the git on PATH but no GIT_EXEC_PATH.
  assert.equal(makeGit(spawn, { PATH: ["/usr/bin", "/cache/bin"].join(path.delimiter) }, exists)(["ls-remote"], 5).stdout, "ok")
  assert.deepEqual(seen, [undefined, helper])
  // A stale inherited value is replaced, and with no helper directory anywhere it is dropped as the last resort.
  seen.length = 0
  const none = (cmd, args, options) => { seen.push(options.env.GIT_EXEC_PATH); return options.env.GIT_EXEC_PATH ? missing : { status: 0, stdout: "own" } }
  assert.equal(makeGit(none, { PATH: "/usr/bin", GIT_EXEC_PATH: "/gone" }, () => false)([], 5).stdout, "own")
  assert.deepEqual(seen, ["/gone", undefined])
  // Still failing after every retry: the last failure is returned. Other failures and successes run once.
  assert.equal(makeGit(() => missing, { PATH: "/usr/bin" }, () => false)([], 5).status, 128)
  seen.length = 0
  assert.equal(makeGit((c, a, o) => { seen.push(1); return { status: 1, stderr: "offline\n" } }, { PATH: "/x" }, () => true)([], 5).status, 1)
  assert.equal(makeGit((c, a, o) => { seen.push(2); return { status: 0 } }, { PATH: "/x" }, () => true)([], 5).status, 0)
  assert.equal(seen.length, 2)
  // The default environment has a PATH.
  assert.equal(makeGit(() => ({ status: 0 }), {}, () => true)([], 5).status, 0)
})

test("the fetch is single-flight: a fresh fetch or a live lock means the current copy is used with no git call and no error line", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const { repo, commit } = releaseRepo(root)
  const first = commit("3.2.122")
  const dir = path.join(root, "state", "ouroboros-skills", "desk", "drains")
  const real = (args, ms) => spawnSync("git", args, { encoding: "utf8", timeout: ms })
  const go = (git) => {
    const calls = []
    const err = []
    launch({ argv: ["poll"], env: { XDG_STATE_HOME: path.join(root, "state"), DESK_DRAINS_RELEASE_URL: repo }, home: root, git: (args, ms) => { const verb = args.find((a) => ["ls-remote", "fetch", "clone"].includes(a)); if (verb) calls.push(verb); return git(args, ms) }, spawn: () => ({ status: 0 }), stderr: { write: (t) => err.push(t) }, execPath: "/node" })
    return { calls, err }
  }
  assert.deepEqual(go(real).calls, ["ls-remote", "clone"])
  commit("3.2.123")
  // Under a minute since the last success: no network at all.
  assert.deepEqual(go(real), { calls: [], err: [] })
  // Older than that but another live runner (this process) holds the lock: still no fetch, no error.
  const old = new Date(Date.now() - 120_000)
  utimesSync(path.join(dir, "last-fetch"), old, old)
  mkdirSync(path.join(dir, "fetch.lock"))
  writeFileSync(path.join(dir, "fetch.lock", "pid"), String(process.pid))
  assert.deepEqual(go(real), { calls: [], err: [] })
  // A lock whose owner is gone, or that has no readable owner and is old, is cleared and the fetch goes ahead.
  writeFileSync(path.join(dir, "fetch.lock", "pid"), "2147483646")
  assert.deepEqual(go(real).calls, ["ls-remote", "fetch"])
  assert.equal(existsSync(path.join(dir, "fetch.lock")), false, "the lock is released")
  utimesSync(path.join(dir, "last-fetch"), old, old)
  mkdirSync(path.join(dir, "fetch.lock"))
  utimesSync(path.join(dir, "fetch.lock"), old, old)
  assert.deepEqual(go(real).calls, ["ls-remote"])
  assert.equal(existsSync(path.join(dir, "fetch.lock")), false)
  assert.notEqual(first, undefined)
})

test("runners started together share one clone without a shallow.lock error or a stray line", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const { repo, commit } = releaseRepo(root)
  commit("3.2.122")
  const dir = path.join(root, "state", "ouroboros-skills", "desk", "drains")
  // The first install has no clone yet, so it is made alone; the overlapping ticks are the steady state.
  launch({ argv: ["poll"], env: { XDG_STATE_HOME: path.join(root, "state"), DESK_DRAINS_RELEASE_URL: repo }, home: root, spawn: () => ({ status: 0 }), stderr: { write() {} }, execPath: "/node" })
  const old = new Date(Date.now() - 120_000)
  utimesSync(path.join(dir, "last-fetch"), old, old)
  commit("3.2.123")
  const launcher = new URL("../../../../../plugins/desk/mcp/scripts/drains-launcher.mjs", import.meta.url).href
  const code = `import(${JSON.stringify(launcher)}).then(({ launch }) => { process.exitCode = launch({ argv: ["poll"], spawn: () => ({ status: 0 }), execPath: "/node" }) })`
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, "state"), DESK_DRAINS_RELEASE_URL: repo, AGENCY_PLUGIN_CACHE: path.join(root, "none") }
  const runs = Array.from({ length: 8 }, () => new Promise((resolve) => {
    let err = ""
    const child = spawnAsync(process.execPath, ["--input-type=module", "-e", code], { env, windowsHide: true })
    child.stderr.on("data", (d) => { err += d })
    child.on("close", (status) => resolve({ status, err }))
  }))
  for (const { status, err } of await Promise.all(runs)) {
    assert.equal(err.includes("shallow.lock"), false, err)
    assert.equal(status, 0, err)
  }
  assert.equal(existsSync(path.join(dir, "fetch.lock")), false)
  assert.equal(readFileSync(path.join(dir, "desk-release", "plugins", "desk", "mcp", "scripts", "drains.js"), "utf8"), "// 3.2.123\n")
  assert.equal(existsSync(path.join(dir, "resolve.log")), false)
})
