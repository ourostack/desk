import { mock, test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { resolveBash } from "../../../../../plugins/desk/mcp/src/util/bash.js"
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import {
  MIGRATION_BUDGET_MS,
  bashHint,
  migrationCommand,
  migrationLine,
  parseMigration,
  pendingMigrations,
  readMigrations,
  runBlock,
  runMigrationCli,
  shellQuote,
  startupMigrationLine,
} from "../../../../../plugins/desk/mcp/src/runtime/pending-migrations.js"

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk/mcp")
const deskPluginRoot = path.resolve(mcpRoot, "..")
import { migrationLine as bootMigrationLine } from "../../../../../plugins/desk/hooks/lib/boot-checks.cjs"

function migrationText({ id, safety = "safe", restart = false, agent = null, detect = "exit 0", check = "exit 0", migrate = "exit 0", announce = "Done.", description = "a test migration" }) {
  return [
    "---",
    `id: ${id}`,
    `description: ${description}`,
    ...(safety === null ? [] : [`safety: ${safety}`]),
    `needs_restart: ${restart}`,
    ...(agent === null ? [] : [`agent_work: ${agent}`]),
    "---",
    "",
    "## Detect",
    "",
    "```bash",
    detect,
    "```",
    "",
    "## Safety check",
    "",
    "```bash",
    check,
    "```",
    "",
    "## Migrate",
    "",
    "```bash",
    migrate,
    "```",
    "",
    "## Announce",
    "",
    announce,
    "",
  ].join("\n")
}

async function plugin(migrations) {
  const root = realpathSync(await mkTempRoot("desk-pending-migrations-"))
  mkdirSync(path.join(root, "migrations"))
  for (const options of migrations) writeFileSync(path.join(root, "migrations", `${options.id}.md`), migrationText(options))
  return root
}

function io() {
  const out = { stdout: "", stderr: "" }
  return { out, io: { stdout: { write: (text) => { out.stdout += text } }, stderr: { write: (text) => { out.stderr += text } } } }
}

// ── Parsing ──────────────────────────────────────────────────────────────

test("parseMigration reads the frontmatter, the three bash blocks and Announce, and rejects any other shape", () => {
  const parsed = parseMigration(migrationText({ id: "05-x", agent: true, detect: "exit 3", announce: "Line one." }).replace(/\n/gu, "\r\n"), "05-x")
  assert.deepEqual(parsed, {
    id: "05-x",
    description: "a test migration",
    safety: "safe",
    needsRestart: false,
    agentWork: true,
    blocks: { Detect: "exit 3", "Safety check": "exit 0", Migrate: "exit 0", Announce: "Line one." },
  })
  assert.equal(parseMigration("no frontmatter", "05-x"), null)
  assert.equal(parseMigration(migrationText({ id: "05-x" }), "06-y"), null, "the id must match the file name")
  assert.equal(parseMigration(migrationText({ id: "05-x" }).replace("```bash\nexit 0\n```\n\n## Migrate", "exit 0\n\n## Migrate"), "05-x"), null, "a block must be fenced bash")
  assert.equal(parseMigration(migrationText({ id: "05-x" }).replace("## Announce\n\nDone.\n", "## Notes\n\nDone.\n"), "05-x"), null, "Announce is required")
  const bare = parseMigration("---\nid: 05-x\nnot a key line\n---\n" + migrationText({ id: "05-x" }).split("---\n")[2], "05-x")
  assert.equal(bare.description, "")
  assert.equal(bare.safety, "")
  assert.equal(bare.needsRestart, false)
  assert.equal(bare.agentWork, false)
})

test("readMigrations lists well-formed migrations in id order and leaves out everything else", async () => {
  const root = await plugin([{ id: "02-second" }, { id: "01-first" }])
  writeFileSync(path.join(root, "migrations", "README.md"), "not a migration")
  writeFileSync(path.join(root, "migrations", "03-broken.md"), "---\nid: 03-broken\n---\n")
  mkdirSync(path.join(root, "migrations", "04-a-folder.md"))
  assert.deepEqual(readMigrations(root).map((migration) => [migration.id, path.basename(migration.file)]), [["01-first", "01-first.md"], ["02-second", "02-second.md"]])
  assert.deepEqual(readMigrations(path.join(root, "nowhere")), [])
})

test("Desk's own migrations all parse", () => {
  const ids = readMigrations(deskPluginRoot).map((migration) => migration.id)
  assert.ok(ids.includes("02-tidy-desk"))
  assert.equal(readMigrations(deskPluginRoot).find((migration) => migration.id === "02-tidy-desk").agentWork, true)
})

test("the real tidy instructions finish on the selected bash and preserve literal text and expanded commands", async () => {
  const { blocks } = readMigrations(deskPluginRoot).find((migration) => migration.id === "02-tidy-desk")
  const root = await mkTempRoot("desk-tidy-instructions-")
  const report = "Tidy claim: fixture-token fixture-time\ntrack_missing_scope: billing-disputes"
  // Only the report is controlled: execute the shipped instruction block, including its shell expansions.
  const reporter = 'node() { printf \'%s\\n\' "$TIDY_TEST_REPORT"; }\n'
  const pluginRoot = '/fixture/plugin "quoted" $literal `uname` %s\\n'
  const toolsRoot = '/fixture/desk "quoted" $literal `uname` %s\\n'
  for (const person of ["", 'fixture "person" $USER %s']) {
    const result = await runBlock(reporter + blocks.Migrate, {
      env: { ...process.env, DESK_PLUGIN_ROOT: pluginRoot, DESK_TOOLS_ROOT: toolsRoot, DESK_TOOLS_PERSON: person, TIDY_TEST_REPORT: report },
      cwd: root, timeoutMs: 10_000, outputChars: Infinity,
    })
    assert.equal(result.timedOut, false, "the instructions must not block before their reader starts")
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, "")
    assert.ok(result.stdout.startsWith(`${report}\n\nTidy this desk now, as ordinary work in this session.`))
    const flags = ` --root '${toolsRoot}'${person ? ` --person '${person}'` : ""} --claim 'fixture-token'`
    assert.ok(result.stdout.includes(`run: node '${pluginRoot}/mcp/scripts/tidy-status.js' --defer '<one-line reason>'${flags}\n`))
    assert.ok(result.stdout.includes(`with: node '${pluginRoot}/mcp/scripts/tidy-status.js' --write-record${flags}\n`))
    assert.ok(result.stdout.includes('in the form "<what belongs>; not <what doesn\'t>".'))
    assert.ok(result.stdout.includes("a bare `git add -A`"))
    assert.ok(result.stdout.includes("the trailer `Desk-Tidy: true`"))
    assert.ok(result.stdout.endsWith("a hand git commit is refused for them.\n"))
  }
})

test("the real tidy instructions leave a held report alone and print no steps", async () => {
  const { blocks } = readMigrations(deskPluginRoot).find((migration) => migration.id === "02-tidy-desk")
  const root = await mkTempRoot("desk-tidy-held-instructions-")
  const result = await runBlock('node() { printf \'%s\\n\' "I left my desk untidied for now."; return 1; }\n' + blocks.Migrate, {
    env: { ...process.env, DESK_PLUGIN_ROOT: "/fixture/plugin" }, cwd: root, timeoutMs: 10_000, outputChars: Infinity,
  })
  assert.deepEqual(result, { status: 0, stdout: "I left my desk untidied for now.\n", stderr: "", timedOut: false, unavailable: false })
})

test("the real tidy instructions survive the native MSYS quoted-argument limit without losing their tail", async () => {
  const { blocks } = readMigrations(deskPluginRoot).find((migration) => migration.id === "02-tidy-desk")
  const root = await mkTempRoot("desk-tidy-msys-arguments-")
  const block = 'node() { printf \'%s\\n\' "$TIDY_TEST_REPORT"; }\n' + blocks.Migrate
  const env = {
    ...process.env,
    DESK_PLUGIN_ROOT: '/fixture/plugin "quoted" $literal `uname` %s\\n',
    DESK_TOOLS_ROOT: '/fixture/desk "quoted" $literal `uname` %s\\n',
    DESK_TOOLS_PERSON: 'fixture "person" $USER %s',
    TIDY_TEST_REPORT: "Tidy claim: fixture-token fixture-time\ntrack_missing_scope: billing-disputes",
  }
  const options = { env, cwd: root, timeoutMs: 10_000, outputChars: Infinity }
  const normal = await runBlock(block, options)
  assert.equal(normal.status, 0, normal.stderr)
  assert.ok(normal.stdout.endsWith("a hand git commit is refused for them.\n"))
  // MSYS glob.cc uses 8192 wide characters, reserving MB_CUR_MAX (up to 6) while decoding a quoted native argument.
  // Model only that transport boundary; the selected Bash still executes the real, unmodified migration.
  const nativeArguments = (command, args, settings) => spawn(command, args.map((arg) =>
    /[ \t"]/u.test(arg) ? Array.from(arg).slice(0, 8186).join("") : arg), settings)
  const windows = await runBlock(block, { ...options, platform: "win32", bash: resolveBash(), spawn: nativeArguments })
  assert.equal(windows.timedOut, false)
  assert.equal(windows.status, 0, windows.stderr)
  assert.equal(windows.stderr, "")
  assert.equal(windows.stdout, normal.stdout, "native argument handling must preserve every instruction and expanded value")
})

test("the tidy commit and its revert both go through desk_save tidy, which adds the Desk-Tidy trailer", () => {
  const text = readMigrations(deskPluginRoot).find((migration) => migration.id === "02-tidy-desk").blocks.Migrate
  const step7 = text.slice(text.indexOf("\n7. Check, record and commit."), text.indexOf("\nThen send the Announce line"))
  const revert = text.slice(text.indexOf("If the human objects"))
  for (const [label, part] of [["step 7", step7], ["the revert", revert]]) {
    assert.ok(part.length > 100, label)
    assert.match(part, /desk_save \(tidy: true/u, label)
  }
  // The quoted instruction argument escapes each backtick; the agent reads `Desk-Tidy: true`.
  assert.match(step7, /desk_save ends it with the trailer \\`Desk-Tidy: true\\`/u)
  assert.equal(text.split("Desk-Tidy: true").length - 1, 1, "the tool adds the trailer, so the text names it once")
})

// ── Running blocks ───────────────────────────────────────────────────────

const noBash = (command, args, options) => spawn("/nonexistent/bash", args, options)

function transportedSource(args) {
  assert.equal(args[0], "-c")
  assert.match(args[1], /^\. '/u, "Windows must read the source from its owned file, not a native source argument")
  return args[1].slice(3, -1).replaceAll("'\\''", "'")
}

function timeoutChild() {
  const child = new EventEmitter()
  Object.assign(child, { pid: 2 ** 22 + 45678, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
  return child
}

// On this host model Windows tree termination with an owned POSIX group, not a PATH taskkill shim.
const windowsTimeoutOptions = process.platform === "win32" ? {} : {
  execFile: (_command, args, options, callback) => execFile(process.execPath, ["-e", 'process.kill(-Number(process.argv[1]), "SIGKILL")', args[1]], options, callback),
}
const windowsTimeoutSpawn = (command, args, options) => spawn(command, args, { ...options, detached: process.platform !== "win32" })

test("runBlock Windows timeout waits for exact-PID tree termination and close in either order", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  for (const closeFirst of [false, true]) {
    const child = timeoutChild()
    let callback
    let source
    let settled = false
    const result = runBlock("while :; do :; done", {
      env: {}, cwd: process.cwd(), timeoutMs: 200, platform: "win32", bash: "fixture-bash",
      spawn: (_command, args) => { source = transportedSource(args); return child },
      execFile: (command, args, options, done) => {
        assert.ok(path.win32.isAbsolute(command))
        assert.equal(path.win32.basename(command).toLowerCase(), "taskkill.exe")
        assert.deepEqual(args, ["/PID", String(child.pid), "/T", "/F"])
        assert.equal(options.timeout, 1000)
        assert.equal(options.maxBuffer, 16_384)
        assert.equal(options.windowsHide, true)
        callback = done
        return timeoutChild()
      },
    }).then((value) => { settled = true; return value })
    t.after(async () => { child.emit("close", null); await result })
    child.stdout.emit("data", "before-deadline\n")
    t.mock.timers.tick(199)
    assert.equal(callback, undefined)
    t.mock.timers.tick(1)
    assert.equal(typeof callback, "function", "the deadline must start a tree operation, not kill only the launcher")
    if (closeFirst) child.emit("close", null)
    else callback(null, "", "")
    await Promise.resolve()
    assert.equal(settled, false, "neither helper success nor close alone qualifies termination")
    if (closeFirst) callback(null, "", "")
    else child.emit("close", null)
    assert.deepEqual(await result, { status: null, stdout: "before-deadline\n", stderr: "", timedOut: true, unavailable: false })
    assert.equal(existsSync(path.dirname(source)), false)
    assert.equal(child.listenerCount("close"), 0)
    assert.equal(child.listenerCount("error"), 0)
    t.mock.timers.tick(1001)
  }
})

test("runBlock Windows timeout rejects every termination failure and releases handles without claiming cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  for (const outcome of ["missing", "throw", "nonzero", "signal", "helper-timeout", "no-close", "child-error", "callback-then-throw"]) {
    const child = timeoutChild()
    const helper = timeoutChild()
    let source
    let callback
    const run = runBlock("while :; do :; done", {
      env: {}, cwd: process.cwd(), timeoutMs: 200, platform: "win32", bash: "fixture-bash",
      spawn: (_command, args) => { source = transportedSource(args); return child },
      execFile: (_command, _args, _options, done) => {
        callback = done
        if (outcome === "throw") throw new Error("owned synchronous launch refusal")
        if (outcome === "missing") done(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), "", "")
        if (outcome === "nonzero") done(Object.assign(new Error("exit 5"), { code: 5 }), "", "access refused")
        if (outcome === "signal") done(Object.assign(new Error("signal SIGTERM"), { signal: "SIGTERM" }), "", "")
        if (outcome === "callback-then-throw") {
          done(new Error("owned first failure"), "", "")
          throw new Error("owned subsequent failure")
        }
        if (outcome === "no-close" || outcome === "child-error") done(null, "", "")
        return helper
      },
    })
    const rejected = assert.rejects(run, (error) => {
      assert.match(error.message, /tree cleanup UNQUALIFIED/u)
      assert.ok(error.message.includes(String(child.pid)), "failure must identify the owned process")
      if (outcome === "nonzero") assert.match(error.message, /access refused/u)
      return true
    })
    t.mock.timers.tick(200)
    if (outcome === "child-error") child.emit("error", new Error("child stream operation failed"))
    t.mock.timers.tick(1000)
    await rejected
    assert.equal(child.stdout.destroyed, true)
    assert.equal(child.stderr.destroyed, true)
    assert.equal(existsSync(path.dirname(source)), false)
    assert.equal(child.listenerCount("close"), 0)
    assert.equal(child.listenerCount("error"), 0)
    if (callback !== undefined) callback(null, "", "")
    t.mock.timers.tick(1001)
  }
})

test("runBlock Windows termination locates the OS executable independently of block env and PATH", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const saved = Object.entries(process.env).filter(([key]) => /^(systemroot|windir)$/iu.test(key))
  for (const key of Object.keys(process.env)) if (/^(systemroot|windir)$/iu.test(key)) delete process.env[key]
  try {
    for (const [values, expected] of [
      [{}, "C:\\Windows\\System32\\taskkill.exe"],
      [{ sYsTeMrOoT: " D:\\Operating System ", WINDIR: "E:\\Other" }, "D:\\Operating System\\System32\\taskkill.exe"],
      [{ SystemRoot: "relative", wInDiR: "E:\\Windows" }, "E:\\Windows\\System32\\taskkill.exe"],
    ]) {
      Object.assign(process.env, values)
      const child = timeoutChild()
      const run = runBlock("while :; do :; done", {
        env: { PATH: "untrusted", SystemRoot: "Z:\\NotTheOS" }, cwd: process.cwd(), timeoutMs: 200, platform: "win32", bash: "fixture-bash",
        spawn: () => child,
        execFile: (command, _args, _options, callback) => {
          assert.equal(command, expected)
          callback(new Error("fixture refusal"), "", "")
          return timeoutChild()
        },
      })
      const rejected = assert.rejects(run, /fixture refusal/u)
      t.mock.timers.tick(200)
      await rejected
      for (const key of Object.keys(values)) delete process.env[key]
    }
  } finally {
    for (const [key, value] of saved) process.env[key] = value
  }
})

test("runBlock Windows normal close cancels the deadline and does not start termination", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const child = timeoutChild()
  let source
  const run = runBlock("printf complete", {
    env: {}, cwd: process.cwd(), timeoutMs: 200, platform: "win32", bash: "fixture-bash",
    spawn: (_command, args) => { source = transportedSource(args); return child },
    execFile: () => assert.fail("normal close must cancel the timeout"),
  })
  child.emit("close", 0)
  assert.deepEqual(await run, { status: 0, stdout: "", stderr: "", timedOut: false, unavailable: false })
  t.mock.timers.tick(1201)
  assert.equal(existsSync(path.dirname(source)), false)
  assert.equal(child.listenerCount("error"), 0)
})

test("runBlock Windows preserves both termination and source-cleanup errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let source
  const child = timeoutChild()
  const remove = fs.rmSync
  const stub = t.mock.method(fs, "rmSync", (target, options) => {
    if (source !== undefined && path.resolve(target) === path.resolve(path.dirname(source))) throw new Error("owned cleanup refused")
    return remove(target, options)
  })
  syncBuiltinESMExports()
  try {
    const run = runBlock("while :; do :; done", {
      env: {}, cwd: process.cwd(), timeoutMs: 200, platform: "win32", bash: "fixture-bash",
      spawn: (_command, args) => { source = transportedSource(args); return child },
      execFile: () => { throw new Error("owned termination refused") },
    })
    const rejected = assert.rejects(run, (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 2)
      assert.match(error.errors[0].message, /owned termination refused/u)
      assert.match(error.errors[1].message, /owned cleanup refused/u)
      return true
    })
    t.mock.timers.tick(200)
    await rejected
  } finally {
    stub.mock.restore()
    syncBuiltinESMExports()
    remove(path.dirname(source), { recursive: true, force: true })
  }
})

test("runBlock on Windows executes source well above 8 KB with unchanged shell context and ignored stdin", async () => {
  const root = await mkTempRoot("desk-windows-block-")
  const bash = resolveBash()
  const payload = "complete-source-".repeat(1200) + ' "quote" \'apostrophe\' $literal `text` %s\\n \u{1f642}'
  const env = { ...process.env, TRANSPORT_VALUE: 'literal "$value" `text` %s\\n' }
  const context = 'printf \'%s\\n\' "$0" "$#" "$TRANSPORT_VALUE" "$PWD"; if read -r line; then echo unexpected-input; else echo stdin-eof; fi'
  const reference = spawnSync(bash, ["-c", context], { env, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  assert.equal(reference.status, 0, reference.stderr)
  let source
  const block = `printf '%s\\n' ${shellQuote(payload)}\n${context}\nprintf 'source-error\\n' >&2\nexit 7`
  const result = await runBlock(block, {
    env, cwd: root, timeoutMs: 10_000, outputChars: Infinity, platform: "win32", bash,
    spawn: (command, args, options) => {
      source = transportedSource(args)
      assert.equal(readFileSync(source, "utf8"), block, "every source byte must reach Bash")
      return spawn(command, args, options)
    },
  })
  assert.deepEqual(result, { status: 7, stdout: `${payload}\n${reference.stdout}`, stderr: "source-error\n", timedOut: false, unavailable: false })
  assert.equal(existsSync(path.dirname(source)), false, "nonzero execution must remove the owned source directory")
})

test("runBlock on Windows fails loudly for missing or unreadable source and removes the owned directory", async () => {
  const root = await mkTempRoot("desk-windows-missing-source-")
  for (const unreadable of [false, true]) {
    let source
    const result = await runBlock("echo must-not-run", {
      env: process.env, cwd: root, timeoutMs: 10_000, platform: "win32", bash: resolveBash(),
      spawn: (command, args, options) => {
        source = transportedSource(args)
        unlinkSync(source)
        // A directory cannot be read as a shell source on either OS; no ACL or root-dependent chmod fixture.
        if (unreadable) mkdirSync(source)
        return spawn(command, args, options)
      },
    })
    assert.notEqual(result.status, 0, result.stderr)
    assert.equal(result.timedOut, false)
    assert.equal(result.unavailable, false)
    assert.equal(result.stdout, "")
    assert.notEqual(result.stderr, "")
    assert.equal(existsSync(path.dirname(source)), false)
  }
})

test("runBlock on Windows quotes its source path without expanding special characters", async () => {
  const root = await mkTempRoot("desk-windows-source-path-")
  const allocate = fs.mkdtempSync
  const stub = mock.method(fs, "mkdtempSync", () => allocate(path.join(root, "source 'quoted' $literal `text` \u{1f642}-")))
  syncBuiltinESMExports()
  let source
  try {
    const result = await runBlock("printf 'complete\\n'", {
      env: process.env, cwd: root, timeoutMs: 10_000, platform: "win32", bash: resolveBash(),
      spawn: (command, args, options) => {
        source = transportedSource(args)
        return spawn(command, args, options)
      },
    })
    assert.deepEqual(result, { status: 0, stdout: "complete\n", stderr: "", timedOut: false, unavailable: false })
    assert.equal(existsSync(path.dirname(source)), false)
  } finally {
    stub.mock.restore()
    syncBuiltinESMExports()
  }
})

test("runBlock on Windows cleans its source after success, timeout and asynchronous or synchronous launch failure", async () => {
  const root = await mkTempRoot("desk-windows-source-cleanup-")
  for (const outcome of ["success", "timeout", "spawn-error", "throw"]) {
    let source
    const run = runBlock(outcome === "timeout" ? "while :; do :; done" : "printf 'complete\\n'", {
      ...windowsTimeoutOptions,
      env: process.env, cwd: root, timeoutMs: outcome === "timeout" ? 200 : 10_000, platform: "win32", bash: resolveBash(),
      spawn: (command, args, options) => {
        source = transportedSource(args)
        if (outcome === "throw") throw new Error("owned launch failure")
        return windowsTimeoutSpawn(outcome === "spawn-error" ? "/nonexistent/bash" : command, args, options)
      },
    })
    if (outcome === "throw") {
      await assert.rejects(run, /owned launch failure/u)
    } else {
      const result = await run
      assert.deepEqual(result, {
        status: outcome === "success" ? 0 : null,
        stdout: outcome === "success" ? "complete\n" : "", stderr: "",
        timedOut: outcome === "timeout", unavailable: outcome === "spawn-error",
      })
    }
    assert.equal(existsSync(path.dirname(source)), false, outcome)
  }
})

test("runBlock on Windows rejects a source write failure and removes its allocated directory", async () => {
  let source
  const write = fs.writeFileSync
  const stub = mock.method(fs, "writeFileSync", (file, ...args) => {
    if (path.basename(file) !== "block.sh") return write(file, ...args)
    source = file
    throw new Error("source write refused")
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(runBlock("echo must-not-run", {
      env: process.env, cwd: process.cwd(), timeoutMs: 1000, platform: "win32", bash: resolveBash(),
      spawn: () => assert.fail("a failed source write must not launch Bash"),
    }), /source write refused/u)
    assert.equal(existsSync(path.dirname(source)), false)
  } finally {
    stub.mock.restore()
    syncBuiltinESMExports()
  }
})

test("runBlock on Windows rejects an exhausted source cleanup failure instead of reporting success", async () => {
  let source
  const remove = fs.rmSync
  const stub = mock.method(fs, "rmSync", (target, options) => {
    if (source === undefined || path.resolve(target) !== path.resolve(path.dirname(source))) return remove(target, options)
    throw Object.assign(new Error("source cleanup refused"), { code: "EIO" })
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(runBlock("echo complete", {
      env: process.env, cwd: process.cwd(), timeoutMs: 1000, platform: "win32", bash: resolveBash(),
      spawn: (command, args, options) => {
        source = transportedSource(args)
        return spawn(command, args, options)
      },
    }), /source cleanup refused/u)
  } finally {
    stub.mock.restore()
    syncBuiltinESMExports()
    remove(path.dirname(source), { recursive: true, force: true })
  }
  assert.equal(existsSync(path.dirname(source)), false)
})

test("runBlock reports a vanished timeout target without issuing native PID operations", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const posixChild = timeoutChild()
  const kill = t.mock.method(process, "kill", () => {
    throw Object.assign(new Error("owned process group already absent"), { code: "ESRCH" })
  })
  const posix = runBlock("sleep 1", {
    env: {}, cwd: process.cwd(), timeoutMs: 100, platform: "darwin", bash: "fixture-bash",
    spawn: () => posixChild,
  })
  t.mock.timers.tick(100)
  posixChild.emit("close", null)
  assert.deepEqual(await posix, { status: null, stdout: "", stderr: "", timedOut: true, unavailable: false })
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments), [[-posixChild.pid, "SIGKILL"]])

  const windowsChild = timeoutChild()
  const helper = timeoutChild()
  let source
  let callback
  const windows = runBlock("sleep 1", {
    env: {}, cwd: process.cwd(), timeoutMs: 100, platform: "win32", bash: "fixture-bash",
    spawn: (_command, args) => { source = transportedSource(args); return windowsChild },
    execFile: (command, args, _options, done) => {
      assert.equal(path.win32.basename(command).toLowerCase(), "taskkill.exe")
      assert.deepEqual(args, ["/PID", String(windowsChild.pid), "/T", "/F"])
      callback = done
      return helper
    },
  })
  const rejected = assert.rejects(windows, (error) => {
    assert.match(error.message, /tree cleanup UNQUALIFIED/u)
    assert.match(error.message, /owned tree target already absent: controlled missing target/u)
    assert.ok(error.message.includes(String(windowsChild.pid)))
    return true
  })
  t.mock.timers.tick(100)
  windowsChild.emit("close", null)
  callback(Object.assign(new Error("owned tree target already absent"), { code: 128 }), "", "controlled missing target")
  await rejected
  assert.equal(existsSync(path.dirname(source)), false)
  for (const child of [posixChild, windowsChild]) {
    assert.equal(child.listenerCount("close"), 0)
    assert.equal(child.listenerCount("error"), 0)
  }
  for (const child of [windowsChild, helper]) {
    assert.equal(child.stdout.destroyed, true)
    assert.equal(child.stderr.destroyed, true)
  }
  t.mock.timers.tick(1001)
  assert.equal(kill.mock.callCount(), 1, "Windows must not fall back to signalling a fabricated native PID")
})

test("runBlock reports the exit, the output, a timeout that kills the whole block, and a missing bash", async () => {
  const ran = await runBlock("echo out; echo err >&2; exit 4", { env: process.env, cwd: process.cwd(), timeoutMs: 10_000 })
  assert.deepEqual(ran, { status: 4, stdout: "out\n", stderr: "err\n", timedOut: false, unavailable: false })
  const root = await mkTempRoot("desk-pending-block-")
  const marker = path.join(root, "grandchild.pid")
  const slow = await runBlock(`sleep 30 & echo $! > ${shellQuote(marker)}; wait`, { env: process.env, cwd: root, timeoutMs: 300 })
  assert.equal(slow.timedOut, true)
  assert.equal(slow.status, null)
  assert.equal(slow.unavailable, false)
  const grandchild = Number(execFileSync("cat", [marker], { encoding: "utf8" }).trim())
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.throws(() => process.kill(grandchild, 0), { code: "ESRCH" }, "the block's own children are killed with it")
  const missing = await runBlock("exit 0", { env: process.env, cwd: process.cwd(), timeoutMs: 0.2, spawn: noBash })
  assert.deepEqual(missing, { status: null, stdout: "", stderr: "", timedOut: false, unavailable: true })
  const windows = await runBlock("sleep 5", { ...windowsTimeoutOptions, env: process.env, cwd: process.cwd(), timeoutMs: 200, platform: "win32", bash: resolveBash(), spawn: windowsTimeoutSpawn })
  assert.equal(windows.timedOut, true, "Windows termination must include the shell's descendants")
  const chatty = await runBlock("yes | head -c 100000", { env: process.env, cwd: process.cwd(), timeoutMs: 10_000 })
  assert.ok(chatty.stdout.length < 100_000, "output is kept bounded")
})

test("runBlock runs the block with the bash it is given, which on Windows defaults to the one resolveBash finds, never the WSL relay", async () => {
  const seen = []
  const spy = (command, args, options) => { seen.push(command); return spawn("bash", args, options) }
  await runBlock("exit 0", { env: process.env, cwd: process.cwd(), timeoutMs: 10_000, spawn: spy, bash: "C:\\Git\\bin\\bash.exe" })
  await runBlock("exit 0", { env: process.env, cwd: process.cwd(), timeoutMs: 10_000, spawn: spy })
  await runBlock("exit 0", { env: {}, cwd: process.cwd(), timeoutMs: 10_000, spawn: spy })
  assert.deepEqual(seen, ["C:\\Git\\bin\\bash.exe", resolveBash(), resolveBash()])
})

const RELAY_ERROR = "<3>WSL (9 - Relay) ERROR: CreateProcessCommon:818: execvpe(/bin/bash) failed: No such file or directory"
const relaySpawn = (stream, text, code = 1) => () => spawn(process.execPath, ["-e", `process.${stream}.write(${JSON.stringify(text)}); process.exit(${code})`], { stdio: ["ignore", "pipe", "pipe"] })

test("runBlock without a usable bash (relay only, bash is null) is unavailable and spawns nothing", async () => {
  const run = await runBlock("exit 0", { env: {}, cwd: process.cwd(), timeoutMs: 1000, bash: null, spawn: () => assert.fail("must not spawn") })
  assert.deepEqual(run, { status: null, stdout: "", stderr: "", timedOut: false, unavailable: true })
})

test("a relay failure on stderr or stdout makes the block unavailable, but only when it failed", async () => {
  for (const [stream, text] of [["stderr", RELAY_ERROR], ["stdout", `Das Windows-Subsystem fuer Linux hat keine Distribution\n${RELAY_ERROR}`]]) {
    const run = await runBlock("x", { env: process.env, cwd: process.cwd(), timeoutMs: 10_000, spawn: relaySpawn(stream, text) })
    assert.equal(run.unavailable, true, stream)
    assert.equal(run.status, 1)
  }
  const fine = await runBlock("x", { env: process.env, cwd: process.cwd(), timeoutMs: 10_000, spawn: relaySpawn("stdout", "execvpe(x) failed is just text", 0) })
  assert.equal(fine.unavailable, false)
  const plain = await runBlock("x", { env: process.env, cwd: process.cwd(), timeoutMs: 10_000, spawn: relaySpawn("stdout", "no", 1) })
  assert.equal(plain.unavailable, false)
})

test("relay detection does not read the localized sentence: only the relay's debug line counts, so a Detect that exits 1 is still 'not needed'", async () => {
  for (const text of ["Windows Subsystem for Linux has no installed distributions.", "Das Windows-Subsystem fuer Linux hat keine installierten Distributionen."]) {
    const run = await runBlock("x", { env: process.env, cwd: process.cwd(), timeoutMs: 10_000, spawn: relaySpawn("stdout", text) })
    assert.equal(run.unavailable, false)
  }
})

const RELAYS = ["C:\\Windows\\System32\\bash.exe", "c:\\WINDOWS\\Sysnative\\bash.exe", "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe"]
const viaRelay = (bash, spawnFn) => runBlock("x", { env: process.env, cwd: process.cwd(), timeoutMs: 10_000, bash, spawn: spawnFn })

test("a WSL relay chosen by path that fails with no output is unavailable, whatever language it speaks (no distro prints only a localized sentence on stderr)", async () => {
  for (const bash of RELAYS) {
    const run = await viaRelay(bash, relaySpawn("stderr", "Das Windows-Subsystem fuer Linux hat keine installierten Distributionen."))
    assert.equal(run.unavailable, true, bash)
    assert.equal(run.status, 1)
    assert.equal((await viaRelay(bash, relaySpawn("stdout", "", 1))).unavailable, true, `${bash}: silent exit 1`)
    assert.equal((await viaRelay(bash, relaySpawn("stdout", RELAY_ERROR, 1))).unavailable, true, `${bash}: execvpe line`)
  }
})

test("a WSL relay with a working distro still gives a real result: exit 0, or a non-zero exit with real stdout", async () => {
  for (const bash of RELAYS) {
    assert.equal((await viaRelay(bash, relaySpawn("stdout", "", 0))).unavailable, false, `${bash}: exit 0`)
    const real = await viaRelay(bash, relaySpawn("stdout", "held: waiting", 1))
    assert.equal(real.unavailable, false, `${bash}: real stdout`)
    assert.equal(real.stdout, "held: waiting")
  }
})

test("a bash that is not the relay and exits 1 with no output is a real Detect result", async () => {
  assert.equal((await viaRelay("C:\\Program Files\\Git\\bin\\bash.exe", relaySpawn("stdout", "", 1))).unavailable, false)
})

test("the bash hint names Git for Windows only on Windows, in both lines", async () => {
  assert.equal(bashHint("win32"), "on Windows, install Git for Windows")
  assert.equal(bashHint("linux"), "install bash")
  const entry = [{ id: "09-x", state: "bash_unavailable" }]
  assert.match(migrationLine(entry, "/p", "win32"), /\(on Windows, install Git for Windows; the WSL bash\.exe with no distro cannot run Desk's scripts\)/u)
  for (const platform of ["darwin", "linux"]) {
    const line = migrationLine(entry, "/p", platform)
    assert.match(line, /bash could not run \(install bash\)/u)
    assert.doesNotMatch(line, /Git for Windows|WSL/u)
  }
  assert.match(migrationLine(entry, "/p"), process.platform === "win32" ? /Git for Windows/u : /install bash/u, "defaults to the running platform")
  const root = await plugin([{ id: "09-x", detect: "exit 1" }])
  const down = relaySpawn("stderr", RELAY_ERROR)
  const options = { pluginRoot: root, env: process.env, cwd: root, budgetMs: 10_000, spawn: down }
  assert.match(await startupMigrationLine({ ...options, platform: "win32" }), /install Git for Windows/u)
  assert.doesNotMatch(await startupMigrationLine({ ...options, platform: "linux" }), /Git for Windows/u)
})

test("a Detect that could not run is shown at startup by name, never read as not needed (hook path)", async () => {
  const root = await plugin([{ id: "09-x", detect: "exit 1" }])
  const spawnRelay = relaySpawn("stderr", RELAY_ERROR)
  const pending = await pendingMigrations({ pluginRoot: root, env: process.env, cwd: root, budgetMs: 10_000, spawn: spawnRelay })
  assert.deepEqual(pending, [{ id: "09-x", state: "bash_unavailable" }])
  const line = migrationLine(pending, root)
  assert.match(line, /^Desk migrations: 09-x could not be checked at startup because bash could not run/u)
  assert.match(await startupMigrationLine({ pluginRoot: root, env: process.env, cwd: root, budgetMs: 10_000, spawn: spawnRelay }), /09-x could not be checked at startup because bash could not run/u)
})

test("the migrations CLI reports a relay-only Detect as an error, not as nothing to do", async () => {
  const root = await plugin([{ id: "09-x", detect: "exit 1" }])
  const out = { stdout: "", stderr: "" }
  const code = await runMigrationCli({ argv: ["run", "09-x"], env: process.env, io: { stdout: { write: (t) => { out.stdout += t } }, stderr: { write: (t) => { out.stderr += t } } }, pluginRoot: root, cwd: root, spawn: relaySpawn("stderr", RELAY_ERROR) })
  assert.equal(code, 1)
  assert.match(out.stderr, /bash is required/u)
  assert.doesNotMatch(out.stdout, /not needed/u)
})

test("shellQuote keeps a path with spaces and quotes one word", () => {
  assert.equal(shellQuote("/a b/it's"), `'/a b/it'\\''s'`)
  assert.equal(execFileSync("bash", ["-c", `printf %s ${shellQuote("/a b/it's")}`], { encoding: "utf8" }), "/a b/it's")
  assert.equal(migrationCommand("/p", "02-x"), `node '${path.join("/p", "mcp", "scripts", "migrations.js")}' run 02-x`)
  assert.match(migrationCommand("/p", "02-x", { tools: true }), / run 02-x --tools-root <root\.path> --tools-person <write_scope\.person; leave out when none>$/u)
})

// ── What the startup hooks find ──────────────────────────────────────────

test("pendingMigrations sorts every fired Detect into what the startup line asks for", async () => {
  const root = await plugin([
    { id: "01-not-needed", detect: "exit 1" },
    { id: "02-tidy", agent: true, detect: '[ -z "${DESK_TOOLS_ROOT:-}" ] && [ -z "${DESK_TOOLS_PERSON:-}" ] && [ -n "$DESK_PLUGIN_ROOT" ]' },
    { id: "03-move", restart: true },
    { id: "04-confirm", safety: "confirm" },
    { id: "05-unset", safety: null },
    { id: "06-unsafe-now", check: "echo 'a merge is in progress'; exit 1" },
    { id: "07-silent-stop", check: "exit 1" },
    { id: "08-broken", migrate: "exit 2" },
    { id: "09-quiet", migrate: "true", announce: "I fixed the thing." },
    { id: "10-reporting", migrate: "echo 'moved 2 files'", announce: "Say if you mind." },
    { id: "11-writes-file", migrate: 'touch "$DESK_PLUGIN_ROOT/ran"' },
    { id: "12-held", agent: true, detect: "echo 'checking'; echo 'held: another session\ttidies'; exit 1" },
    { id: "13-quiet-no", detect: "echo 'not held'; exit 1" },
  ])
  const pending = await pendingMigrations({ pluginRoot: root, env: { ...process.env, DESK_TOOLS_ROOT: "/stale", DESK_TOOLS_PERSON: "stale" }, cwd: root, budgetMs: 30_000 })
  assert.deepEqual(pending, [
    { id: "02-tidy", state: "agent_work" },
    { id: "03-move", state: "restart", description: "a test migration" },
    { id: "04-confirm", state: "run", reason: "its safety is confirm, so it does not run on its own" },
    { id: "05-unset", state: "run", reason: "its safety is not set, so it does not run on its own" },
    { id: "06-unsafe-now", state: "run", reason: "its Safety check stopped it: a merge is in progress" },
    { id: "07-silent-stop", state: "run", reason: "its Safety check stopped it: no reason given" },
    { id: "08-broken", state: "run", reason: "its Migrate failed" },
    { id: "09-quiet", state: "ran", report: "", announce: "I fixed the thing." },
    { id: "10-reporting", state: "ran", report: "moved 2 files", announce: "Say if you mind." },
    { id: "11-writes-file", state: "ran", report: "", announce: "Done." },
    { id: "12-held", state: "held", reason: "another session tidies" },
  ])
  assert.ok(realpathSync(path.join(root, "ran")), "a safe, restart-free migration runs in the hook")
})

test("pendingMigrations keeps to its budget: slow blocks and an exhausted budget are unchecked or left to the agent", async () => {
  const root = await plugin([
    { id: "01-slow-detect", detect: "sleep 5" },
    { id: "02-slow-check", check: "sleep 5" },
    { id: "03-slow-migrate", migrate: "sleep 5" },
  ])
  const slow = await pendingMigrations({ pluginRoot: root, cwd: root, budgetMs: 30_000, blockLimitMs: 1_500 })
  assert.deepEqual(slow, [
    { id: "01-slow-detect", state: "unchecked" },
    { id: "02-slow-check", state: "run", reason: "its Safety check did not finish in time" },
    { id: "03-slow-migrate", state: "run", reason: "its Migrate did not finish in time" },
  ])
  // A clock that moves on at each reading runs the budget out before each later block.
  for (const [steps, expected] of [
    [0, [{ id: "01-a", state: "unchecked" }]],
    [1, [{ id: "01-a", state: "run", reason: "its Safety check did not finish in time" }]],
    [2, [{ id: "01-a", state: "run", reason: "its Migrate did not finish in time" }]],
  ]) {
    const one = await plugin([{ id: "01-a" }])
    let reading = 0
    const now = () => (reading++ < 1 + steps * 2 ? 0 : 10_000)
    assert.deepEqual(await pendingMigrations({ pluginRoot: one, cwd: one, budgetMs: 1_000, now }), expected)
  }
  const missingBash = await plugin([{ id: "01-a" }])
  assert.deepEqual(await pendingMigrations({ pluginRoot: missingBash, cwd: missingBash, spawn: noBash }), [{ id: "01-a", state: "bash_unavailable" }], "a host without bash is named, not skipped")
  assert.equal(MIGRATION_BUDGET_MS, 2_000)
})

test("migrationLine says what to do for each state, with the exact command, and nothing when none is pending", () => {
  assert.equal(migrationLine([], "/p"), "")
  const command = `node '${path.join("/p", "mcp", "scripts", "migrations.js")}' run`
  const line = migrationLine([
    { id: "02-tidy", state: "agent_work" },
    { id: "02-held", state: "held", reason: "the desk repository is in the middle of a merge" },
    { id: "03-move", state: "restart", description: "Move it" },
    { id: "04-quiet", state: "ran", report: "", announce: "Fixed." },
    { id: "05-loud", state: "ran", report: "moved 2", announce: "Fixed." },
    { id: "06-wait", state: "run", reason: "its Migrate failed" },
    { id: "07-slow", state: "unchecked" },
  ], "/p")
  assert.equal(line, [
    `Desk migrations: 02-tidy is pending. Do it now, before other work and without asking: call desk_status, then run \`${command} 02-tidy --tools-root <root.path> --tools-person <write_scope.person; leave out when none>\` and do what it prints.`,
    "02-held is on hold because the desk repository is in the middle of a merge. Nothing to do for it now; mention it to the human in one line if it matters to them.",
    `03-move is pending (Move it). Run it now, before other work and without waiting for anyone to answer: run \`${command} 03-move\`. It runs to completion on its own; when it is done, tell the human what it printed and ask them to start a new session — with no human in this session, just say in your own output that a restart is needed and carry on.`,
    "04-quiet ran at startup. Tell the human in one line: Fixed.",
    "05-loud ran at startup. Tell the human in one line: moved 2 Fixed.",
    `06-wait is pending but did not run at startup because its Migrate failed. Before other work, run \`${command} 06-wait\` and follow what it prints.`,
    `07-slow could not be checked in time at startup. Before other work, run \`${command} 07-slow --tools-root <root.path> --tools-person <write_scope.person; leave out when none>\`; it prints that nothing is needed when that is so, and otherwise what to do.`,
  ].join(" "))
})

test("startupMigrationLine never throws, and the boot-check hook helper passes the session's folder", async () => {
  const registryError = await startupMigrationLine({ pluginRoot: undefined })
  assert.match(registryError, /^Desk problem: pending-migrations — the migration registry failed internally\n/u)
  assert.match(registryError, /  file: not filed: filer_unavailable\n/u)
  const root = await plugin([{ id: "01-where", agent: true, detect: '[ "$(cd "$EXPECTED" && pwd)" = "$PWD" ]' }])
  assert.match(await startupMigrationLine({ pluginRoot: root, env: { ...process.env, EXPECTED: root }, cwd: root }), /^Desk migrations: 01-where is pending/u)
  assert.equal(await startupMigrationLine({ pluginRoot: root, env: { ...process.env, EXPECTED: root }, cwd: path.dirname(root) }), "")
})

// ── The migration registry's own failures (spec.md §1, Part 5) ─────────────

test("startupMigrationLine's registry-error block calls the injected fileProblem (never filing inline itself) and reports what it returns", async () => {
  const calls = []
  const line = await startupMigrationLine({
    pluginRoot: undefined, host: "claude",
    fileProblem: async ({ reason, host }) => { calls.push({ reason, host }); return { file: "filing in background" } },
  })
  assert.match(line, /^Desk problem: pending-migrations — the migration registry failed internally\n/u)
  assert.match(line, /  file: filing in background\n/u)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].host, "claude")
  assert.ok(calls[0].reason.length > 0)
})

test("startupMigrationLine's registry-error block still renders a reason when the registry throws a non-Error value", async () => {
  const root = await plugin([{ id: "01-where", agent: true, detect: '[ "$(cd "$EXPECTED" && pwd)" = "$PWD" ]' }])
  const line = await startupMigrationLine({ pluginRoot: root, env: { EXPECTED: root }, cwd: root, spawn: () => { throw "not-an-error-object" } })
  assert.match(line, /^Desk problem: pending-migrations — the migration registry failed internally\n/u)
  assert.match(line, /  broke: not-an-error-object\n/u)
})

test("startupMigrationLine's registry-error block stays 'not filed: filer_unavailable' when fileProblem itself throws", async () => {
  const line = await startupMigrationLine({ pluginRoot: undefined, fileProblem: async () => { throw new Error("filer unavailable") } })
  assert.match(line, /  file: not filed: filer_unavailable\n/u)
})

test("migrationLine (the boot-check hook helper) queues the detached filer, never awaiting it, when the migration registry fails internally", async () => {
  // The filing-storm throttle (fix round, spec.md §1 Part 5) keys its stamp file off
  // this call's own state directory, so this test needs a HOME of its own -- an empty
  // `env` here would fall back to the process-wide isolated-test HOME and collide with
  // the next test's identical mechanism+reason.
  const launched = []
  const line = await bootMigrationLine({
    host: "claude", env: { HOME: await mkTempRoot("desk-pending-migrations-filer-") }, pluginRoot: null,
    launchRepair: async (command, env) => { launched.push({ command, env }) },
  })
  assert.match(line, /^Desk problem: pending-migrations — the migration registry failed internally\n/u)
  assert.match(line, /  file: filing in background\n/u)
  assert.equal(launched.length, 1)
  assert.ok(launched[0].command.some((part) => part.endsWith("file-desk-problem.js")))
  assert.ok(launched[0].command.includes("--mechanism"))
  assert.ok(launched[0].command.includes("pending-migrations"))
  assert.ok(launched[0].command.includes("--host"))
  assert.ok(launched[0].command.includes("claude"))
})

test("migrationLine falls back to 'not filed: filer_unavailable' when the launcher itself fails, without throwing", async () => {
  const line = await bootMigrationLine({
    host: "claude", env: { HOME: await mkTempRoot("desk-pending-migrations-filer-") }, pluginRoot: null,
    launchRepair: async () => { throw new Error("spawn failed") },
  })
  assert.match(line, /  file: not filed: filer_unavailable\n/u)
})

test("migrationLine's filer argv carries the fixed 'reason unavailable' placeholder, never the raw reason, when argvSafeReason itself fails to load", async () => {
  // Fix round, spec.md §1 Part 5: a redaction helper that cannot load must
  // never fall back to passing its unredacted input straight through --
  // that would defeat the whole point of narrowing what reaches a spawned
  // process's own argv (`ps`-visible machine-wide). This drives migrationLine
  // down the same "registry failed internally" path as the tests above, but
  // with a `loadArgvSafeReason` that rejects, and checks the launched
  // command's own `--reason` argument rather than the human-facing block.
  const launched = []
  const line = await bootMigrationLine({
    host: "claude", env: { HOME: await mkTempRoot("desk-pending-migrations-filer-") }, pluginRoot: null,
    launchRepair: async (command, env) => { launched.push({ command, env }) },
    loadArgvSafeReason: async () => { throw new Error("argv-safe-reason module missing") },
  })
  assert.match(line, /^Desk problem: pending-migrations — the migration registry failed internally\n/u)
  assert.match(line, /  file: filing in background\n/u)
  assert.equal(launched.length, 1)
  const reasonIndex = launched[0].command.indexOf("--reason")
  assert.ok(reasonIndex >= 0)
  assert.equal(launched[0].command[reasonIndex + 1], "reason unavailable (redactor not loaded)")
})

// ── Index tracing (spec.md §3) ──────────────────────────────────────────────

// Index tracing bounds each Git snapshot to INDEX_TRACE_TIMEOUT_MS and, by
// design, skips the diff when one expires (see the tests below that fake that
// expiry). A test that asserts on drift found by *real* Git must not depend on
// how fast the machine runs Git: on a loaded Windows runner a `git diff
// --cached` that took over a second made the snapshot return null and the
// drift line vanish. These tests are about what the blocks do to the index, not
// about the timeout, so they run real Git through this seam, which drops the
// timeout option and leaves everything else as it is.
function withoutTimeout(inner = spawnSync) {
  return (command, args, options) => {
    const { timeout, ...rest } = options ?? {}
    return inner(command, args, rest)
  }
}
const realGit = withoutTimeout()

test("withoutTimeout hands the command, arguments and every option but timeout to the real spawn", () => {
  const seen = []
  const fake = withoutTimeout((...call) => { seen.push(call); return { status: 0 } })
  assert.deepEqual(fake("git", ["status"], { encoding: "utf8", timeout: 1000, env: { A: "1" } }), { status: 0 })
  assert.deepEqual(fake("git", ["status"]), { status: 0 })
  assert.deepEqual(seen, [["git", ["status"], { encoding: "utf8", env: { A: "1" } }], ["git", ["status"], {}]])
})

function gitInit(root) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "F", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "F", GIT_COMMITTER_EMAIL: "f@example.invalid" }
  execFileSync("git", ["init", "-q", "-b", "main", root], { env })
  writeFileSync(path.join(root, "committed.md"), "base\n")
  execFileSync("git", ["-C", root, "add", "committed.md"], { env })
  execFileSync("git", ["-C", root, "commit", "-qm", "first"], { env })
}

test("a migration block that stages a file produces a Desk problem: index-drift block in startupMigrationLine's output", async () => {
  const root = await plugin([{ id: "02-tidy-desk", migrate: "touch stray.txt && git add stray.txt" }])
  gitInit(root)
  const line = await startupMigrationLine({ pluginRoot: root, cwd: root, budgetMs: 30_000, spawnGit: realGit })
  assert.match(line, /Desk problem: index-drift — unexpected file staged during 02-tidy-desk:migrate/)
  assert.match(line, /stray\.txt/)
  assert.doesNotMatch(line, /staged a file it should never touch/)
})

test("a Safety check block that stages a file is named by its own tag, distinct from Migrate", async () => {
  const root = await plugin([{ id: "01-a", check: "touch sneaky.txt && git add sneaky.txt" }])
  gitInit(root)
  const line = await startupMigrationLine({ pluginRoot: root, cwd: root, budgetMs: 30_000, spawnGit: realGit })
  assert.match(line, /Desk problem: index-drift — unexpected file staged during 01-a:safety-check/)
  assert.doesNotMatch(line, /01-a:migrate/)
})

test("several files staged by one block are all named, in the plural", async () => {
  const root = await plugin([{ id: "01-a", migrate: "touch x.txt y.txt && git add x.txt y.txt" }])
  gitInit(root)
  const line = await startupMigrationLine({ pluginRoot: root, cwd: root, budgetMs: 30_000, spawnGit: realGit })
  assert.match(line, /Desk problem: index-drift — unexpected files staged during 01-a:migrate/)
  assert.match(line, /x\.txt/)
  assert.match(line, /y\.txt/)
  assert.match(line, /Files appeared in the index while "01-a:migrate" ran/)
})

test("a migration block that changes nothing in the index adds no drift block", async () => {
  const root = await plugin([{ id: "01-a", migrate: "echo fine" }])
  gitInit(root)
  const line = await startupMigrationLine({ pluginRoot: root, cwd: root, budgetMs: 30_000, spawnGit: realGit })
  assert.doesNotMatch(line, /Desk problem/)
})

test("a cwd that is not itself a Git repository is never watched for drift", async () => {
  const root = await plugin([{ id: "01-a", migrate: "exit 0" }])
  const line = await startupMigrationLine({ pluginRoot: root, cwd: root, budgetMs: 30_000, spawnGit: realGit })
  assert.doesNotMatch(line, /Desk problem/)
})

test("pendingMigrations' own return shape is unchanged: a plain array of { id, state, ... } entries", async () => {
  const root = await plugin([{ id: "01-a", migrate: "touch stray.txt && git add stray.txt" }])
  gitInit(root)
  const drifts = []
  const pending = await pendingMigrations({ pluginRoot: root, cwd: root, budgetMs: 30_000, spawnGit: realGit, onIndexDrift: (block) => drifts.push(block) })
  assert.deepEqual(pending, [{ id: "01-a", state: "ran", report: "", announce: "Done." }])
  assert.equal(drifts.length, 1)
  assert.match(drifts[0], /Desk problem: index-drift — unexpected file staged during 01-a:migrate/)
})

test("onIndexDrift defaults to doing nothing, so a caller that omits it is never broken by drift", async () => {
  const root = await plugin([{ id: "01-a", migrate: "touch stray.txt && git add stray.txt" }])
  gitInit(root)
  const pending = await pendingMigrations({ pluginRoot: root, cwd: root, budgetMs: 30_000, spawnGit: realGit })
  assert.deepEqual(pending, [{ id: "01-a", state: "ran", report: "", announce: "Done." }])
})

// A before-snapshot that succeeds but whose matching after-snapshot then fails
// or times out must skip the diff too — the asymmetric case findings 1(b)/(c)
// guard against, distinct from the before-fails case above. No real Git is
// needed: `spawnGit` is faked end to end, succeeding on `rev-parse` and on the
// very first `diff` call, then failing every one after it.
function beforeSucceedsAfterFailsSpawnGit() {
  let diffCalls = 0
  return (command, args) => {
    if (args.includes("rev-parse")) return { status: 0, stdout: "true\n", stderr: "" }
    diffCalls += 1
    if (diffCalls === 1) return { status: 0, stdout: "", stderr: "" }
    return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) }
  }
}

test("pendingMigrations: an after-snapshot that fails once its before-snapshot succeeded is skipped, not treated as no drift", async () => {
  const root = await plugin([{ id: "01-a" }])
  const drifts = []
  const pending = await pendingMigrations({ pluginRoot: root, cwd: root, budgetMs: 30_000, spawnGit: beforeSucceedsAfterFailsSpawnGit(), onIndexDrift: (block) => drifts.push(block) })
  assert.deepEqual(pending, [{ id: "01-a", state: "ran", report: "", announce: "Done." }])
  assert.equal(drifts.length, 0)
})

// ── The real tidy migration, found by the startup hook helper ─────────────

async function tidyDesk({ messy }) {
  const root = realpathSync(await mkTempRoot("desk-pending-tidy-"))
  const desk = path.join(root, "desk")
  const home = path.join(root, "home")
  mkdirSync(home)
  mkdirSync(path.join(desk, "_meta"), { recursive: true })
  mkdirSync(path.join(desk, "billing-disputes", "refund-flow-cleanup"), { recursive: true })
  writeFileSync(path.join(desk, "billing-disputes", "track.md"), `---\ntitle: billing-disputes\nstatus: active\n${messy ? "" : "scope: billing disputes; not payroll\n"}---\n`)
  writeFileSync(path.join(desk, "billing-disputes", "refund-flow-cleanup", "task.md"), `---\ntitle: refund-flow-cleanup\nstatus: processing\nupdated: '${new Date().toISOString()}'\n---\n`)
  for (const args of [["init", "-q"], ["config", "user.name", "Fixture Owner"], ["config", "user.email", "fixture@example.invalid"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) {
    execFileSync("git", ["-C", desk, ...args])
  }
  const env = { ...process.env, HOME: home, DESK: desk, DESK_IDENTITY: "nobody", DESK_ACTIVATION_CONFIG: "" }
  for (const key of ["CLAUDE_PROJECT_DIR", "CLAUDE_PLUGIN_DATA", "CLAUDE_CONFIG_DIR", "AGENCY_TOML", "DESK_PERSON"]) delete env[key]
  return { desk, home, env }
}

test("a pending tidy puts the tidy instruction in the startup context; a tidy desk gets no line", async () => {
  const pending = await tidyDesk({ messy: true })
  for (const host of ["claude", "copilot"]) {
    const env = host === "claude" ? { ...pending.env, CLAUDE_PROJECT_DIR: pending.home } : pending.env
    const line = await bootMigrationLine({ host, env, sessionFolder: pending.home, budgetMs: 60_000 })
    assert.match(line, /^Desk migrations: 02-tidy-desk is pending\. Do it now, before other work and without asking/u, host)
    assert.ok(line.includes(`node '${path.join(deskPluginRoot, "mcp", "scripts", "migrations.js")}' run 02-tidy-desk --tools-root <root.path>`), host)
    assert.ok(line.length < 400, `${host}: the line stays short (${line.length})`)
    assert.doesNotMatch(line, /01-move-to-ourostack-desk/u)
  }
  const tidy = await tidyDesk({ messy: false })
  assert.equal(await bootMigrationLine({ host: "claude", env: tidy.env, budgetMs: 60_000 }), "")
  assert.equal(await bootMigrationLine({ host: "copilot", env: tidy.env, sessionFolder: tidy.home, budgetMs: 60_000 }), "")
  assert.equal(await bootMigrationLine({ host: "copilot", env: tidy.env, budgetMs: 60_000 }), "", "no session folder: the process folder stands in")
})

// ── `scripts/migrations.js run <id>` ─────────────────────────────────────

test("the run command walks one migration the way the migrations skill describes", async () => {
  const root = await plugin([
    { id: "01-not-needed", detect: "exit 1" },
    { id: "02-confirm", safety: "confirm" },
    { id: "03-unset", safety: null },
    { id: "04-blocked", check: "echo 'git is required'; echo 'and more' >&2; exit 1" },
    { id: "05-broken", migrate: "echo halfway; echo boom >&2; exit 3" },
    { id: "06-steps", agent: true, migrate: 'printf "root=%s person=%s\\nstep 1\\n" "${DESK_TOOLS_ROOT:-none}" "${DESK_TOOLS_PERSON:-none}"', announce: "I tidied <counts>." },
    { id: "07-wait", agent: true, migrate: "echo 'I left my desk untidied for now.'", announce: "I tidied <counts>." },
    { id: "08-fixed", migrate: "echo 'changed one file'", announce: "All set." },
    { id: "09-restart", restart: true, announce: "Moved." },
    // Steps longer than the hooks' output bound still reach the agent whole.
    { id: "11-held", agent: true, detect: "echo 'held: another session is on it'; exit 1" },
    { id: "10-long", agent: true, migrate: 'for i in $(seq 1 400); do echo "finding $i: a long report line that fills the output"; done; echo "Steps, in order:"; echo "7. Record."', announce: "Tidied." },
  ])
  const run = async (argv, env = process.env) => {
    const captured = io()
    const code = await runMigrationCli({ argv, env: { ...env, DESK_TOOLS_ROOT: "/stale", DESK_TOOLS_PERSON: "stale" }, io: captured.io, pluginRoot: root, cwd: root })
    return { code, ...captured.out }
  }
  assert.deepEqual(await run(["run", "01-not-needed"]), { code: 0, stdout: "Migration 01-not-needed is not needed; nothing to do.\n", stderr: "" })
  assert.deepEqual(await run(["run", "02-confirm"]), { code: 0, stdout: "Migration 02-confirm has safety: confirm, which is not implemented; skipping it.\n", stderr: "" })
  assert.deepEqual(await run(["run", "03-unset"]), { code: 0, stdout: "Migration 03-unset has safety: (none), which is not implemented; skipping it.\n", stderr: "" })
  assert.deepEqual(await run(["run", "04-blocked"]), { code: 1, stdout: "git is required\nand more\nMigration 04-blocked cannot run yet; resolve the reason above first.\n", stderr: "" })
  assert.deepEqual(await run(["run", "05-broken"]), { code: 1, stdout: "halfway\nboom\nMigration 05-broken failed mid-run; manual intervention needed.\n", stderr: "" })
  assert.deepEqual(await run(["run", "06-steps"]), { code: 0, stdout: "root=none person=none\nstep 1\n\nAnnounce line, filled in with this run's own counts and commit link:\nI tidied <counts>.\n", stderr: "" })
  assert.equal((await run(["run", "06-steps", "--tools-root", "/desk", "--tools-person", "bob"])).stdout.split("\n")[0], "root=/desk person=bob")
  assert.deepEqual(await run(["run", "07-wait"]), { code: 0, stdout: "I left my desk untidied for now.\n", stderr: "" })
  assert.deepEqual(await run(["run", "08-fixed"]), { code: 0, stdout: "changed one file\nAll set.\n", stderr: "" })
  assert.deepEqual(await run(["run", "09-restart"]), { code: 0, stdout: "Moved.\nPlease start a new session so my preamble loads against the migrated paths.\n", stderr: "" })
  assert.deepEqual(await run(["run", "11-held"]), { code: 0, stdout: "Migration 11-held is on hold because another session is on it; nothing to do now.\n", stderr: "" })
  const long = await run(["run", "10-long"])
  assert.ok(long.stdout.length > 20_000, String(long.stdout.length))
  assert.match(long.stdout, /\nfinding 400: [^\n]*\nSteps, in order:\n7\. Record\.\n\nAnnounce line, filled in with this run's own counts and commit link:\nTidied\.\n$/u)

  const usage = "usage: migrations.js run <id> [--tools-root <path>] [--tools-person <alias>]\n"
  assert.deepEqual(await run([]), { code: 2, stdout: "", stderr: usage })
  assert.deepEqual(await run(["list"]), { code: 2, stdout: "", stderr: usage })
  assert.deepEqual(await run(["run", "08-fixed", "--force"]), { code: 2, stdout: "", stderr: 'migrations.js: unknown or incomplete argument "--force"\n' })
  assert.deepEqual(await run(["run", "08-fixed", "--tools-root"]), { code: 2, stdout: "", stderr: 'migrations.js: unknown or incomplete argument "--tools-root"\n' })
  assert.deepEqual(await run(["run", "99-none"]), { code: 2, stdout: "", stderr: "migrations.js: Desk has no migration 99-none\n" })

  const captured = io()
  const code = await runMigrationCli({ argv: ["run", "08-fixed"], io: captured.io, pluginRoot: root, cwd: root, spawn: noBash })
  assert.deepEqual({ code, ...captured.out }, { code: 1, stdout: "", stderr: "migrations.js: bash is required to run Desk's migrations\n" })
})

// ── Index tracing on `runMigrationCli` (spec.md §3) ─────────────────────────
//
// The real incident this Part exists for happened here: `02-tidy-desk` is
// `agent_work: true`, and `pendingMigrations` never runs its Safety check or
// Migrate block itself (it stops after Detect for an agent-work migration) —
// those blocks only ever run through this function. This is the path that
// matters most.

test("runMigrationCli catches a block that stages a file and prints a Desk problem: index-drift block, without changing the exit code", async () => {
  const root = await plugin([{ id: "01-a", migrate: "echo changed && touch stray.txt && git add stray.txt" }])
  gitInit(root)
  const captured = io()
  const code = await runMigrationCli({ argv: ["run", "01-a"], io: captured.io, pluginRoot: root, cwd: root, spawnGit: realGit })
  assert.equal(code, 0)
  assert.match(captured.out.stdout, /Desk problem: index-drift — unexpected file staged during 01-a:migrate/)
  assert.match(captured.out.stdout, /stray\.txt/)
  assert.match(captured.out.stdout, /changed/)
  assert.match(captured.out.stdout, /Done\./)
  assert.doesNotMatch(captured.out.stdout, /staged a file it should never touch/)
})

test("runMigrationCli names every file when a block stages several, in the plural, tagged by block", async () => {
  const root = await plugin([{ id: "01-a", check: "touch a.txt b.txt && git add a.txt b.txt" }])
  gitInit(root)
  const captured = io()
  const code = await runMigrationCli({ argv: ["run", "01-a"], io: captured.io, pluginRoot: root, cwd: root, spawnGit: realGit })
  assert.equal(code, 0)
  assert.match(captured.out.stdout, /Desk problem: index-drift — unexpected files staged during 01-a:safety-check/)
  assert.doesNotMatch(captured.out.stdout, /01-a:migrate/)
  assert.match(captured.out.stdout, /a\.txt/)
  assert.match(captured.out.stdout, /b\.txt/)
  assert.match(captured.out.stdout, /Files appeared in the index while "01-a:safety-check" ran/)
})

test("runMigrationCli: an after-snapshot that fails once its before-snapshot succeeded is skipped, not treated as no drift", async () => {
  const root = await plugin([{ id: "01-a" }])
  const captured = io()
  const code = await runMigrationCli({ argv: ["run", "01-a"], io: captured.io, pluginRoot: root, cwd: root, spawnGit: beforeSucceedsAfterFailsSpawnGit() })
  assert.equal(code, 0)
  assert.doesNotMatch(captured.out.stdout, /Desk problem/)
})

test("runMigrationCli tracks the index only when cwd is itself a Git repository", async () => {
  const root = await plugin([{ id: "01-a", migrate: "touch stray.txt && git init -q . && git add stray.txt" }])
  const captured = io()
  const code = await runMigrationCli({ argv: ["run", "01-a"], io: captured.io, pluginRoot: root, cwd: root, spawnGit: realGit })
  assert.equal(code, 0)
  assert.doesNotMatch(captured.out.stdout, /Desk problem/)
})

test("scripts/migrations.js runs Desk's own tidy migration and prints its steps and announcement", async () => {
  const pending = await tidyDesk({ messy: true })
  const script = path.join(mcpRoot, "scripts", "migrations.js")
  const result = spawnSync(process.execPath, [script, "run", "02-tidy-desk", "--tools-root", pending.desk], { env: pending.env, cwd: pending.home, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`^Desk tools: ${pending.desk.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n`, "u"))
  assert.match(result.stdout, /track_missing_scope: billing-disputes/u)
  assert.match(result.stdout, /Tidy this desk now, as ordinary work in this session\./u)
  assert.match(result.stdout, /\nAnnounce line, filled in with this run's own counts and commit link:\nI tidied up my desk a bit: /u)
  // The steps carry this run's claim to the record and defer commands.
  const token = /^Tidy claim: (\S+) /mu.exec(result.stdout)[1]
  assert.ok(result.stdout.includes(`--write-record --root '${pending.desk}' --claim '${token}'`))
  assert.ok(result.stdout.includes(`--defer '<one-line reason>' --root '${pending.desk}' --claim '${token}'`))
  // While that claim is fresh, a second session is told the tidy is taken, at startup and from the command.
  const again = spawnSync(process.execPath, [script, "run", "02-tidy-desk", "--tools-root", pending.desk], { env: pending.env, cwd: pending.home, encoding: "utf8" })
  assert.equal(again.status, 0)
  assert.match(again.stdout, /^Migration 02-tidy-desk is on hold because another session has been tidying this desk since \S+; nothing to do now\.\n$/u)
  assert.match(await bootMigrationLine({ host: "claude", env: { ...pending.env, CLAUDE_PROJECT_DIR: pending.home }, budgetMs: 60_000 }), /^Desk migrations: 02-tidy-desk is on hold because another session has been tidying this desk since \S+\. Nothing to do for it now/u)
  const tidy = await tidyDesk({ messy: false })
  const nothing = spawnSync(process.execPath, [script, "run", "02-tidy-desk", "--tools-root", tidy.desk], { env: tidy.env, cwd: tidy.home, encoding: "utf8" })
  assert.deepEqual([nothing.status, nothing.stdout], [0, "Migration 02-tidy-desk is not needed; nothing to do.\n"])
})

// ── The real 01-move-to-ourostack-desk migration, against a temp CLAUDE_CONFIG_DIR ──
//
// Regression coverage for the migration script's shell logic, not a test of
// the wording fix above: it never calls migrationLine, so it would pass
// unchanged on the old wording too. It exists because, during the
// eng-workflow-v2 fresh-setup dry run (finding 3), a real `claude` CLI run by
// hand against fixtures built the same way was directly observed to complete
// this exact migration's Migrate block in one shot; the friction was never
// the shell logic, only the startup text's wording (fixed above, in
// migrationLine's assertion). This test locks the shell logic down against
// regressions with a fake `claude` that understands only the handful of
// `plugin`/`plugin marketplace` subcommands the Migrate block calls, backed
// by JSON files under a temp `CLAUDE_CONFIG_DIR` — no network, no real Claude
// Code install, nothing outside the fixture's own temp folders.

function hasCommand(name) {
  return spawnSync("bash", ["-c", `command -v ${name}`]).status === 0
}

function readCfgJson(cfg, ...segments) {
  try {
    return JSON.parse(readFileSync(path.join(cfg, ...segments), "utf8"))
  } catch {
    return null
  }
}

async function oldChannelFixture() {
  const cfg = realpathSync(await mkTempRoot("desk-channel-migration-cfg-"))
  const bin = realpathSync(await mkTempRoot("desk-channel-migration-bin-"))
  const fakeCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/runtime/fake-claude-plugin-cli.mjs")
  const wrapper = path.join(bin, "claude")
  writeFileSync(wrapper, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCli)} "$@"\n`)
  chmodSync(wrapper, 0o755)

  // The state a machine still on the frozen ouroboros-skills v2-alpha channel
  // is in: the old marketplace pinned to that ref, and desk/superpowers/
  // plain-language all installed from it, each carrying an existing desk
  // binding the migration is supposed to carry over untouched.
  mkdirSync(path.join(cfg, "plugins"), { recursive: true })
  writeFileSync(path.join(cfg, "plugins", "known_marketplaces.json"), `${JSON.stringify({ "ouroboros-skills": { source: { source: "github", repo: "ourostack/ouroboros-skills", ref: "v2-alpha" } } }, null, 2)}\n`)
  writeFileSync(path.join(cfg, "fake-plugin-state.json"), `${JSON.stringify([
    { id: "desk@ouroboros-skills", scope: "user", enabled: true, installPath: "", projectPath: "" },
    { id: "superpowers@ouroboros-skills", scope: "user", enabled: true, installPath: "", projectPath: "" },
    { id: "plain-language@ouroboros-skills", scope: "user", enabled: true, installPath: "", projectPath: "" },
  ], null, 2)}\n`)
  const binding = { schema_version: 1, desk: { root: "/home/operator/desk" } }
  mkdirSync(path.join(cfg, "plugins", "data", "desk-ouroboros-skills"), { recursive: true })
  writeFileSync(path.join(cfg, "plugins", "data", "desk-ouroboros-skills", "desk.activation.json"), `${JSON.stringify(binding)}\n`)

  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, PATH: `${bin}${path.delimiter}${process.env.PATH}`, AGENCY_TOML: path.join(cfg, "agency.toml") }
  return { cfg, bin, env, binding }
}

test("scripts/migrations.js runs the real channel migration against a temp CLAUDE_CONFIG_DIR fixture, swapping the enabled plugin exactly once", { skip: ["jq", "git", "gh", "bash"].some((name) => !hasCommand(name)) && "jq, git, gh and bash are required" }, async () => {
  const fixture = await oldChannelFixture()
  const script = path.join(mcpRoot, "scripts", "migrations.js")

  const first = spawnSync(process.execPath, [script, "run", "01-move-to-ourostack-desk"], { env: fixture.env, cwd: fixture.cfg, encoding: "utf8" })
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.match(first.stdout, /Desk moved to ourostack\/desk\./u)
  assert.match(first.stdout, /Please start a new session so my preamble loads against the migrated paths\.\n$/u)

  // The enabled plugin actually swapped: nothing is left on ouroboros-skills,
  // and desk, superpowers and plain-language all now run from ourostack.
  const ids = readCfgJson(fixture.cfg, "fake-plugin-state.json").map((entry) => entry.id).sort()
  assert.deepEqual(ids, ["desk@ourostack", "plain-language@ourostack", "superpowers@ourostack"])

  // The old marketplace is gone; the new one is declared with automatic updates on.
  const markets = readCfgJson(fixture.cfg, "plugins", "known_marketplaces.json")
  assert.equal(markets["ouroboros-skills"], undefined)
  assert.equal(markets.ourostack.source.repo, "ourostack/desk")
  assert.equal(readCfgJson(fixture.cfg, "settings.json").extraKnownMarketplaces.ourostack.autoUpdate, true)

  // The desk binding carried over to the new install's data directory, unchanged.
  assert.deepEqual(readCfgJson(fixture.cfg, "plugins", "data", "desk-ourostack", "desk.activation.json"), fixture.binding)

  // Idempotent against a re-invocation once it has already converged: the next
  // session's own run of this same command (the only thing the frozen channel
  // ever has to trigger it with) finds nothing left to do.
  const second = spawnSync(process.execPath, [script, "run", "01-move-to-ourostack-desk"], { env: fixture.env, cwd: fixture.cfg, encoding: "utf8" })
  assert.deepEqual([second.status, second.stdout], [0, "Migration 01-move-to-ourostack-desk is not needed; nothing to do.\n"])
})
