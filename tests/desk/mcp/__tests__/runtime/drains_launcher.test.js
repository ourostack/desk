// The launcher a wake runner calls: it finds the released Desk through Agency's plugin cache, falls back to the last good path and says so.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { installLauncher } from "../../../../../plugins/desk/mcp/src/runtime/drains.js"
import { launch } from "../../../../../plugins/desk/mcp/scripts/drains-launcher.mjs"

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

function run(root, cache, extra = {}) {
  const calls = []
  const err = []
  const status = launch({
    argv: ["poll"],
    env: { XDG_STATE_HOME: path.join(root, "state"), AGENCY_PLUGIN_CACHE: cache },
    home: root,
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
  assert.deepEqual(r.calls, [["/node", [wanted, "poll"], { stdio: "inherit", windowsHide: true }]])
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
    assert.match(r.err[0], new RegExp(`^2026-11-13T22:00:00.000Z could not resolve the released Desk \\(.+\\); using the last good path ${script.replaceAll("/", "\\/")}\\n$`, "u"))
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
    launch({ argv: [], env: { XDG_STATE_HOME, AGENCY_PLUGIN_CACHE: cache }, home: root, spawn })
    assert.ok(existsSync(path.join(root, ".local", "state", "ouroboros-skills", "desk", "drains", "last-good-script")))
  }
  // Every default: this process's environment, home folder, stderr and node.
  const home = process.env.HOME
  const defaultCache = path.join(home, ".local", "agency", "plugins", "cache")
  assert.equal(existsSync(defaultCache), false)
  const quiet = process.stderr.write
  process.stderr.write = () => true
  try {
    assert.equal(launch({ argv: [], spawn }), 1)
    cacheOf(path.join(home, ".local", "agency", "plugins"), [["a", SPEC("release"), 1, true]])
    assert.equal(launch({ argv: ["status"], spawn }), 0)
  } finally {
    process.stderr.write = quiet
  }
  // The real spawn, on a script that does nothing.
  assert.equal(launch({ argv: [], env: { XDG_STATE_HOME: path.join(root, "real"), AGENCY_PLUGIN_CACHE: cache }, home: root }), 0)
  assert.equal(calls.at(-1)[0], process.execPath)
  assert.deepEqual(calls.at(-1)[1].slice(1), ["status"])
})

test("the installed copy runs as a program: it finds the released script and passes its output and status through", async () => {
  const root = await mkTempRoot("desk-launcher-")
  const cache = path.join(root, "cache")
  mkdirSync(path.join(cache, "entries", "r", "mcp", "scripts"), { recursive: true })
  writeFileSync(path.join(cache, "entries", "r", "mcp", "scripts", "drains.js"), "console.log(JSON.stringify(process.argv.slice(2))); process.exit(4)\n")
  writeFileSync(path.join(cache, "cache_index.json"), JSON.stringify({ entries: { a: { spec: SPEC("release"), dir_name: "r", fetched_at: 1 } } }))
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, "state"), AGENCY_PLUGIN_CACHE: cache }
  const { path: installed } = installLauncher({ env })
  const result = spawnSync(process.execPath, [installed, "poll", "--x"], { encoding: "utf8", env })
  assert.equal(result.status, 4, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), ["poll", "--x"])
  assert.equal(fileURLToPath(new URL(`file://${installed}`)), installed)
})
