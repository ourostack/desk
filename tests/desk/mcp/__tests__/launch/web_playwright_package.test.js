// Opt-in differential test against an explicitly supplied, owned installed package tree.
// No browser is started: the configured executable only records an attempt and exits.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"
import { openSession } from "./_mcp_session.js"

const require = createRequire(import.meta.url)
const { apply, readRevision, REVISION } = require(path.join(mcpRoot, "web-playwright-patch.cjs"))
const source = process.env.DESK_PLAYWRIGHT_TEST_MODULES
const enabled = source && process.platform !== "win32"

test("actual installed MCP preserves failed-acquisition close safety", {
  skip: enabled ? false : "requires explicit owned DESK_PLAYWRIGHT_TEST_MODULES and a POSIX executable fixture",
  timeout: 30000,
}, async () => {
  const root = await mkTempRoot("playwright-lifecycle-package-")
  const observations = []
  for (const patched of [false, true]) {
    const dir = path.join(root, patched ? "patched" : "stock")
    const modules = path.join(dir, "node_modules")
    mkdirSync(dir, { recursive: true })
    cpSync(source, modules, { recursive: true, verbatimSymlinks: true })
    if (patched) apply({ dir, version: "fixture", core: null })
    const log = path.join(dir, "attempts.jsonl")
    const executable = path.join(dir, "owned-browser")
    writeFileSync(executable, `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ attempt: true }) + "\\n"); process.exit(1);\n`)
    chmodSync(executable, 0o700)
    const session = await openSession({
      command: process.execPath,
      args: [path.join(modules, "@playwright", "mcp", "cli.js"), "--headless", "--isolated", "--executable-path", executable],
      cwd: dir,
      env: { PATH: path.dirname(process.execPath), HOME: dir, USERPROFILE: dir, TMPDIR: dir, XDG_CACHE_HOME: path.join(dir, "cache") },
    })
    const count = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0
    try {
      assert.equal(count(), 0, "handshake must not launch")
      const navigation = await session.request("tools/call", { name: "browser_navigate", arguments: { url: "http://127.0.0.1:1/owned-unused" } })
      const afterNavigation = count()
      const close = await session.request("tools/call", { name: "browser_close", arguments: {} })
      const afterClose = count()
      observations.push({ patched, navigationError: navigation.result?.isError === true, closeError: close.result?.isError === true, afterNavigation, afterClose })
      assert.equal(navigation.result?.isError, true)
      assert.equal(afterNavigation, 1)
      assert.equal(afterClose, patched ? 1 : 2)
      if (patched) {
        assert.notEqual(close.result?.isError, true)
        assert.match(close.result.content[0].text, /no browser session is open/i)
        for (const format of ["json", "raw"]) {
          const result = await session.request("tools/call", { name: "browser_close", arguments: { _meta: { [format]: true } } })
          assert.notEqual(result.result?.isError, true)
          if (format === "json") assert.deepEqual(JSON.parse(result.result.content[0].text), { result: "No browser session is open." })
          else assert.equal(result.result.content[0].text, "No browser session is open.")
        }
        const invalid = await session.request("tools/call", { name: "browser_close", arguments: [] })
        if (invalid.error) assert.ok(Number.isInteger(invalid.error.code) && invalid.error.code < 0)
        else {
          assert.equal(invalid.result?.isError, true)
          assert.match(invalid.result.content[0].text, /Invalid arguments for tool "browser_close"/)
        }
        assert.equal(count(), 1, "repeated and invalid idle close must not launch")
      }
    } finally {
      await session.close()
    }
  }
  console.log(JSON.stringify({ actualPackageDifferential: observations, actualBrowserProcesses: 0 }))
})

test("actual extension relay re-reads the selected profile before first acquisition and after close", {
  skip: enabled ? false : "requires explicit owned DESK_PLAYWRIGHT_TEST_MODULES and a POSIX executable fixture",
  timeout: 30000,
}, async () => {
  const root = await mkTempRoot("playwright-credential-package-")
  const observations = []
  for (const patched of [false, true]) {
    const dir = path.join(root, patched ? "patched" : "stock")
    const modules = path.join(dir, "node_modules")
    mkdirSync(dir)
    cpSync(source, modules, { recursive: true, verbatimSymlinks: true })
    const bundleFile = path.join(modules, "playwright-core", "lib", "coreBundle.js")
    const original = readFileSync(bundleFile, "utf8")
    apply({ dir, version: "fixture", core: null })
    if (!patched) writeFileSync(bundleFile, original)
    const profile = path.join(dir, "Profile 4")
    const storage = path.join(profile, "Local Storage", "leveldb")
    mkdirSync(storage, { recursive: true })
    const { ClassicLevel } = require(path.join(modules, "classic-level"))
    const key = Buffer.from("_chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm\u0000\u0001auth-token", "latin1")
    async function persist(value) {
      const db = new ClassicLevel(storage, { keyEncoding: "buffer", valueEncoding: "buffer" })
      try {
        if (value === null) await db.del(key)
        else await db.put(key, Buffer.concat([Buffer.from([1]), Buffer.from(value)]))
      } finally {
        await db.close()
      }
    }
    await persist("fixture-rotated-before-first")
    const log = path.join(dir, "attempts.jsonl")
    const executable = path.join(dir, "owned-browser")
    writeFileSync(executable, `#!${process.execPath}
      const fs = require("fs");
      const file = ${JSON.stringify(log)};
      const count = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\\n").length : 0;
      const expected = count === 0 ? "fixture-rotated-before-first" : "fixture-rotated-after-close";
      const page = new URL(process.argv[process.argv.length - 1]);
      fs.appendFileSync(file, JSON.stringify({ credentialCurrent: page.searchParams.get("token") === expected }) + "\\n");
    `)
    chmodSync(executable, 0o700)
    const session = await openSession({
      command: process.execPath,
      args: [path.join(mcpRoot, "web-real-tabs.cjs"), path.join(modules, "@playwright", "mcp", "cli.js"),
        "--extension", "--browser", "msedge", "--executable-path", executable, "--user-data-dir", dir, "--profile-dir-name", "Profile 4"],
      cwd: dir,
      env: {
        PATH: path.dirname(process.execPath), HOME: dir, USERPROFILE: dir, TMPDIR: dir,
        DESK_BROWSER_PROFILE_DIR: profile, PLAYWRIGHT_MCP_EXTENSION_TOKEN: "fixture-stale-startup",
        PWTEST_EXTENSION_CONNECT_TIMEOUT: "1000",
      },
    })
    const attempts = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : []
    try {
      const navigate = () => session.request("tools/call", { name: "browser_navigate", arguments: { url: "http://127.0.0.1:1/owned-unused" } })
      assert.equal((await navigate()).result?.isError, true)
      assert.deepEqual(attempts(), [{ credentialCurrent: patched }])
      if (patched) {
        const close = await session.request("tools/call", { name: "browser_close", arguments: {} })
        assert.notEqual(close.result?.isError, true)
        await persist("fixture-rotated-after-close")
        assert.equal((await navigate()).result?.isError, true)
        assert.deepEqual(attempts(), [{ credentialCurrent: true }, { credentialCurrent: true }])
        await persist(null)
        const absent = await navigate()
        assert.equal(absent.result?.isError, true)
        assert.match(absent.result.content[0].text, /browser_token_unavailable/)
        assert.equal(attempts().length, 2, "an absent credential must not launch with the stale startup token")
        for (const token of ["fixture-stale-startup", "fixture-rotated-before-first", "fixture-rotated-after-close"]) {
          assert.equal(session.stderr().includes(token), false, "diagnostics must not expose fixture credentials")
        }
      }
      observations.push({ patched, attempts: attempts(), actualBrowserProcesses: 0 })
    } finally {
      await session.close()
    }
  }
  console.log(JSON.stringify({ actualCredentialDifferential: observations }))
})

test("latest-channel production install and warm launch preserve failed-close safety", {
  skip: process.env.DESK_BROWSER_INSTALL_SMOKE === "1" && process.platform !== "win32" ? false : "explicit networked POSIX installation smoke test",
  timeout: 420000,
}, async (t) => {
  const root = await mkTempRoot("playwright-lifecycle-install-")
  const home = path.join(root, "home")
  const state = path.join(root, "state")
  const log = path.join(root, "attempts.jsonl")
  const executable = path.join(root, "owned-browser")
  mkdirSync(home)
  writeFileSync(executable, `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ attempt: true }) + "\\n"); process.exit(1);\n`)
  chmodSync(executable, 0o700)
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home, USERPROFILE: home, TMPDIR: home, DESK_BROWSER_STATE_DIR: state,
    npm_config_cache: path.join(root, "npm-cache"), npm_config_registry: process.env.DESK_BROWSER_TEST_REGISTRY || "https://registry.npmjs.org",
  }
  const count = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0
  let warmStarted
  let generation
  for (const mode of ["fresh", "warm"]) {
    warmStarted = Date.now()
    const before = count()
    const runtime = await require(path.join(mcpRoot, "web.cjs")).prepareBrowserRuntime({ env, firstInstallMs: 150000 })
    const session = await openSession({
      command: runtime.nodePath,
      args: [path.join(runtime.installed.dir, "node_modules", "@playwright", "mcp", "cli.js"),
        "--headless", "--isolated", "--executable-path", executable],
      env, cwd: home, timeoutMs: 150000,
    })
    try {
      const navigation = await session.request("tools/call", { name: "browser_navigate", arguments: { url: "http://127.0.0.1:1/owned-unused" } })
      const afterNavigation = count()
      const close = await session.request("tools/call", { name: "browser_close", arguments: {} })
      assert.equal(navigation.result?.isError, true)
      assert.equal(afterNavigation, before + 1, JSON.stringify(navigation))
      assert.equal(count(), afterNavigation)
      assert.notEqual(close.result?.isError, true)
      const pointer = JSON.parse(readFileSync(path.join(state, "current.json"), "utf8"))
      const receipt = JSON.parse(readFileSync(path.join(state, pointer.dir, "playwright-patch.json"), "utf8"))
      assert.equal(receipt.revision, REVISION)
      assert.equal(readRevision({ dir: path.join(state, pointer.dir), version: receipt.mcpVersion, core: receipt.coreVersion }), REVISION)
      if (mode === "fresh") generation = pointer.dir
      else assert.equal(pointer.dir, generation, "warm launch reuses the verified generation")
      t.diagnostic(JSON.stringify({ mode, mcp: receipt.mcpVersion, core: receipt.coreVersion, patchRevision: receipt.revision, afterNavigation, afterClose: count(), actualBrowserProcesses: 0 }))
    } finally {
      await session.close()
    }
  }
  const deadline = Date.now() + 210000
  let refresh
  while (Date.now() < deadline) {
    refresh = existsSync(path.join(state, "last-refresh.json")) ? JSON.parse(readFileSync(path.join(state, "last-refresh.json"), "utf8")) : null
    if (refresh && Date.parse(refresh.at) >= warmStarted && !existsSync(path.join(state, "refresh.lock"))) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.equal(existsSync(path.join(state, "refresh.lock")), false, "owned detached refresh must finish")
  assert.equal(refresh?.result.ok, true, JSON.stringify(refresh))
})
