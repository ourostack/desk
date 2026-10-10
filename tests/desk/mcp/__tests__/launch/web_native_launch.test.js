import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const fs = require("node:fs")
const childProcess = require("node:child_process")
const native = require(path.join(mcpRoot, "web-native-launch.cjs"))
const builder = require(path.join(mcpRoot, "scripts", "build-browser-launch-assets.cjs"))

test("an archive-installed mode-0644 binary launches only from a verified private executable copy", { skip: process.platform === "win32" }, async () => {
  const root = await mkTempRoot("browser-launch-installed-mode-")
  const install = path.join(root, "install")
  cpSync(path.join(mcpRoot, "native"), path.join(install, "native"), { recursive: true })
  cpSync(path.join(mcpRoot, "artifacts", "browser-launch"), path.join(install, "artifacts", "browser-launch"), { recursive: true })
  const installed = path.join(install, "artifacts", "browser-launch", process.platform + "-" + process.arch, "desk-browser-launch")
  chmodSync(installed, 0o644)
  const attempt = native.prepare({ mcpRoot: install, root, executable: process.execPath, profile: "Default", owner: "Desk archive fixture", platform: process.platform, arch: process.arch, env: process.env })
  assert.notEqual(attempt.file, installed)
  assert.equal(path.dirname(attempt.file), path.dirname(attempt.env.DESK_BROWSER_RECEIPT))
  assert.equal(lstatSync(attempt.file).mode & 0o777, 0o700)
  assert.equal(lstatSync(installed).mode & 0o777, 0o644, "shared installation stays unchanged")
  assert.deepEqual(readFileSync(attempt.file), readFileSync(installed))
  attempt.dispose()
  assert.equal(existsSync(path.dirname(attempt.file)), false)
})

test("failed or corrupted private copies are refused and their exact attempt directories are removed", async () => {
  const root = await mkTempRoot("browser-launch-copy-failure-")
  const base = { mcpRoot, root, executable: process.execPath, profile: "Default", owner: "Desk copy fixture", platform: process.platform, arch: process.arch, env: process.env }
  const copy = fs.copyFileSync
  try {
    fs.copyFileSync = () => { throw new Error("copy refused fixture") }
    assert.throws(() => native.prepare(base), /copy refused fixture/u)
    assert.deepEqual(readdirSync(root), [])
    fs.copyFileSync = (source, destination, flags) => { copy(source, destination, flags); writeFileSync(destination, "corrupt copy") }
    assert.throws(() => native.prepare(base), /browser_native_launch_integrity/u)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    fs.copyFileSync = copy
  }
})

test("the private executable filename follows the requested target without mutating packaged assets", async () => {
  const root = await mkTempRoot("browser-launch-copy-name-")
  const spawn = childProcess.spawnSync
  try {
    childProcess.spawnSync = (file, args, options) => {
      assert.equal(args[0], "--check")
      writeFileSync(options.env.DESK_BROWSER_RECEIPT, JSON.stringify({ version: 1, nonce: options.env.DESK_BROWSER_NONCE, status: "ready" }))
      return { status: 0 }
    }
    for (const platform of ["win32", "darwin"]) {
      const attempt = native.prepare({ mcpRoot, root, executable: process.execPath, profile: "Default", owner: "Desk copy name", platform, arch: "arm64", env: process.env })
      assert.equal(path.basename(attempt.file), "desk-browser-launch" + (platform === "win32" ? ".exe" : ""))
      attempt.dispose()
    }
    assert.deepEqual(readdirSync(root), [])
  } finally {
    childProcess.spawnSync = spawn
  }
})

test("packaged launch assets cover all existing browser architectures and reject modified bytes", async () => {
  const verified = native.verifyAssets(mcpRoot)
  assert.deepEqual(verified.targets.sort(), ["darwin-arm64", "darwin-x64", "linux-arm", "linux-arm64", "linux-x64", "win32-arm64", "win32-ia32", "win32-x64"])
  const root = await mkTempRoot("browser-launch-modified-")
  const asset = native.selectAsset(mcpRoot, process.platform, process.arch)
  const copy = path.join(root, path.basename(asset.file))
  copyFileSync(asset.file, copy)
  writeFileSync(copy, "tampered")
  assert.throws(() => native.checkAsset(copy, asset.sha256, process.platform), /browser_native_launch_integrity/u)
})

test("native selection refuses an unshipped target instead of borrowing another architecture", () => {
  assert.throws(() => native.selectAsset(mcpRoot, "freebsd", "x64"), /browser_native_launch_unsupported/u)
})

test("native assets reject source drift, altered inventories, nonregular files, and invalid checksums", async () => {
  const root = await mkTempRoot("browser-launch-provenance-")
  mkdirSync(path.join(root, "native", "browser-launch"), { recursive: true })
  mkdirSync(path.join(root, "artifacts", "browser-launch"), { recursive: true })
  for (const file of ["go.mod", "main.go"]) copyFileSync(path.join(mcpRoot, "native", "browser-launch", file), path.join(root, "native", "browser-launch", file))
  const source = JSON.parse(readFileSync(path.join(mcpRoot, "artifacts", "browser-launch", "manifest.json"), "utf8"))
  const manifest = path.join(root, "artifacts", "browser-launch", "manifest.json")
  for (const value of [{ ...source, version: 2 }, { ...source, sourceSha256: "foreign" }, { ...source, assets: {} }]) {
    writeFileSync(manifest, JSON.stringify(value))
    assert.throws(() => native.selectAsset(root, process.platform, process.arch), /browser_native_launch_integrity/u)
  }
  const file = path.join(root, "ordinary")
  writeFileSync(file, "fixture")
  chmodSync(file, 0o700)
  assert.throws(() => native.checkAsset(file, "not-a-hash", process.platform), /browser_native_launch_integrity/u)
  assert.throws(() => native.checkAsset(root, "a".repeat(64), process.platform), /browser_native_launch_integrity/u)
  if (process.platform !== "win32") {
    const link = path.join(root, "linked-asset")
    symlinkSync(file, link)
    assert.throws(() => native.checkAsset(link, "a".repeat(64), process.platform), /browser_native_launch_integrity/u)
  }
})

test("preflight uses a private exclusive attempt without opening a browser or retaining a credential", async () => {
  const root = await mkTempRoot("browser-launch-attempt-")
  const attempt = native.prepare({ mcpRoot, root, executable: process.execPath, profile: "Profile 4", owner: "Desk owned fixture", platform: process.platform, arch: process.arch, env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: "private-secret" } })
  assert.ok(path.isAbsolute(attempt.file))
  assert.equal(attempt.owner, "Desk owned fixture")
  assert.equal(attempt.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined)
  assert.equal(attempt.env.DESK_BROWSER_EXECUTABLE, process.execPath)
  assert.equal(attempt.before(), null)
  assert.equal(attempt.read(), null, "ready preflight was consumed, not a stale launch success")
  assert.equal(JSON.stringify(readdirSync(root)).includes("private-secret"), false)
  assert.equal(lstatSync(path.dirname(attempt.env.DESK_BROWSER_RECEIPT)).isDirectory(), true)
  attempt.dispose()
  assert.deepEqual(readdirSync(root), [])
})

test("each attempt has a unique owner and receipt, while available session identity is recognizable", async () => {
  const env = { COPILOT_AGENT_SESSION_ID: "abcdefgh-1234-5678", DESK_SESSION_ID: "generic-session" }
  const a = native.ownerName(env, "Copilot CLI")
  const b = native.ownerName(env, "Copilot CLI")
  assert.notEqual(a, b)
  assert.match(a, /generic-sess/u)
  assert.match(a, /Copilot CLI/u)
  assert.match(native.ownerName({ CLAUDE_CODE_SESSION_ID: "another-session" }, "Claude Code"), /another-sess/u)
  assert.match(native.ownerName({}, "Host\nbad"), /^Desk Host bad /u)
  assert.match(native.ownerName({}, 42), /^Desk agent /u)
})

test("native launch receives the original URL but writes only an authenticated secret-free receipt", async () => {
  const root = await mkTempRoot("browser-launch-receipt-")
  const attempt = native.prepare({ mcpRoot, root, executable: process.execPath, profile: "Default", owner: "Desk receipt fixture", platform: process.platform, arch: process.arch, env: process.env })
  attempt.before()
  const connect = new URL("chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html")
  connect.searchParams.set("mcpRelayUrl", "ws://127.0.0.1:12345/own")
  connect.searchParams.set("client", JSON.stringify({ name: attempt.owner }))
  connect.searchParams.set("token", "private-secret")
  const launched = spawnSync(attempt.file, ["--profile-directory=Default", connect.href], { env: { ...process.env, ...attempt.env }, encoding: "utf8" })
  assert.equal(launched.status, 0)
  assert.equal(launched.stdout + launched.stderr, "")
  assert.equal(attempt.read().status, "spawned")
  assert.equal(readFileSync(attempt.env.DESK_BROWSER_RECEIPT, "utf8").includes("private-secret"), false)
  const replay = spawnSync(attempt.file, ["--profile-directory=Default", connect.href], { env: { ...process.env, ...attempt.env }, encoding: "utf8" })
  assert.notEqual(replay.status, 0, "same attempt cannot open an unaccounted replacement")
  attempt.dispose()
  assert.equal(existsSync(attempt.env.DESK_BROWSER_RECEIPT), false)
})

test("missing executable, invalid profile, and symlinked or forged receipts refuse before dispatch", async () => {
  const root = await mkTempRoot("browser-launch-refusal-")
  const base = { mcpRoot, root, executable: process.execPath, profile: "Default", owner: "Desk refusal fixture", platform: process.platform, arch: process.arch, env: process.env }
  assert.throws(() => native.prepare({ ...base, executable: path.join(root, "absent") }), /browser_native_launch_refused/u)
  assert.throws(() => native.prepare({ ...base, profile: "../Default" }), /browser_native_launch_refused/u)
  const attempt = native.prepare(base)
  attempt.before()
  writeFileSync(attempt.env.DESK_BROWSER_RECEIPT, JSON.stringify({ version: 1, nonce: "foreign", status: "spawned", pid: 1 }))
  assert.throws(() => attempt.read(), /browser_native_launch_receipt_invalid/u)
  attempt.dispose()
})

test("the artifact builder uses fixed target argv and refuses failed builds or the wrong toolchain", async () => {
  const root = await mkTempRoot("browser-launch-builder-")
  mkdirSync(path.join(root, "native", "browser-launch"), { recursive: true })
  for (const name of ["main.go", "go.mod"]) copyFileSync(path.join(mcpRoot, "native", "browser-launch", name), path.join(root, "native", "browser-launch", name))
  const builds = []
  const spawn = (file, args, options) => {
    assert.equal(file, "go")
    assert.equal(options.shell, false)
    if (args[0] === "version") return { status: 0, stdout: "go version go1.27.1 fixture" }
    assert.deepEqual(args.slice(0, 4), ["build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w -buildid="])
    assert.equal(options.env.CGO_ENABLED, "0")
    const output = args[args.indexOf("-o") + 1]
    writeFileSync(output, `fixture ${options.env.GOOS} ${options.env.GOARCH}`)
    builds.push([options.env.GOOS, options.env.GOARCH])
    return { status: 0 }
  }
  const output = []
  builder.run([], { root, spawn, stdout: { write: (text) => output.push(text) } })
  assert.deepEqual(builds, [["darwin", "arm64"], ["darwin", "amd64"], ["linux", "arm"], ["linux", "arm64"], ["linux", "amd64"], ["windows", "arm64"], ["windows", "386"], ["windows", "amd64"]])
  builder.run(["--verify"], { root, stdout: { write: (text) => output.push(text) } })
  assert.match(output.at(-1), /verified/u)
  assert.throws(() => builder.run(["--unexpected"]), /Usage/u)
  assert.throws(() => builder.run([], { root, spawn: () => ({ status: 1 }) }), /Go 1.27.1/u)
  assert.throws(() => builder.run([], { root, spawn: () => ({ status: 0, stdout: "go version go1.26.0 fixture" }) }), /Go 1.27.1/u)
  assert.throws(() => builder.run([], { root, spawn: (file, args) => args[0] === "version" ? { status: 0, stdout: "go version go1.27.1 fixture" } : { status: 1, stderr: "fixture build failure" } }), /Build failed/u)
  builder.run(["--verify"])
})

test("a launch receipt cannot authorize a symlink, a malformed payload, or an unverified earlier start", async () => {
  const root = await mkTempRoot("browser-launch-state-")
  const base = { mcpRoot, root, executable: process.execPath, profile: "Default", owner: "Desk state fixture", platform: process.platform, arch: process.arch, env: process.env }
  const attempt = native.prepare(base)
  attempt.before()
  writeFileSync(attempt.env.DESK_BROWSER_RECEIPT, JSON.stringify({ version: 1, nonce: attempt.env.DESK_BROWSER_NONCE, status: "starting" }))
  assert.throws(() => attempt.before(), /browser_native_launch_unknown/u)
  writeFileSync(attempt.env.DESK_BROWSER_RECEIPT, JSON.stringify({ version: 1, nonce: attempt.env.DESK_BROWSER_NONCE, status: "spawned", pid: 0 }))
  assert.throws(() => attempt.read(), /browser_native_launch_receipt_invalid/u)
  writeFileSync(attempt.env.DESK_BROWSER_RECEIPT, "x".repeat(4097))
  assert.throws(() => attempt.read(), /browser_native_launch_receipt_invalid/u)
  writeFileSync(attempt.env.DESK_BROWSER_RECEIPT, "{malformed secret")
  assert.throws(() => attempt.read(), /browser_native_launch_receipt_invalid/u)
  for (const value of [null, [], { version: 0 }, { version: 1, nonce: attempt.env.DESK_BROWSER_NONCE, status: "foreign" }, { version: 1, nonce: attempt.env.DESK_BROWSER_NONCE, status: "spawned", pid: 1.5 }]) {
    writeFileSync(attempt.env.DESK_BROWSER_RECEIPT, JSON.stringify(value))
    assert.throws(() => attempt.read(), /browser_native_launch_receipt_invalid/u)
  }
  attempt.dispose()
  if (process.platform !== "win32") {
    const linked = native.prepare(base)
    linked.before()
    const target = path.join(root, "foreign-receipt")
    writeFileSync(target, "{}")
    symlinkSync(target, linked.env.DESK_BROWSER_RECEIPT)
    assert.throws(() => linked.read(), /browser_native_launch_receipt_invalid/u)
    linked.dispose()
    assert.equal(readFileSync(target, "utf8"), "{}")
    const asset = native.selectAsset(mcpRoot, process.platform, process.arch)
    const copy = path.join(root, "nonexecutable")
    copyFileSync(asset.file, copy)
    chmodSync(copy, 0o600)
    assert.doesNotThrow(() => native.checkAsset(copy, asset.sha256), "archive mode is not content corruption")
  }
})

test("a receipt under a non-directory path is not mistaken for an absent launch", async () => {
  const root = await mkTempRoot("browser-launch-unreadable-")
  const attempt = native.prepare({ mcpRoot, root, executable: process.execPath, profile: "Default", owner: "Desk read refusal", platform: process.platform, arch: process.arch, env: process.env })
  const dir = path.dirname(attempt.env.DESK_BROWSER_RECEIPT)
  attempt.dispose()
  assert.throws(() => attempt.read(), /browser_native_launch_receipt_invalid/u)
  writeFileSync(dir, "not a directory")
  assert.throws(() => attempt.read(), /browser_native_launch_receipt_invalid/u)
})

test("a replaced receipt parent symlink cannot stand in for the private attempt directory", { skip: process.platform === "win32" ? "POSIX symlink fixture" : false }, async () => {
  const root = await mkTempRoot("browser-launch-parent-link-")
  const attempt = native.prepare({ mcpRoot, root, executable: process.execPath, profile: "Default", owner: "Desk parent refusal", platform: process.platform, arch: process.arch, env: process.env })
  const dir = path.dirname(attempt.env.DESK_BROWSER_RECEIPT)
  attempt.dispose()
  const replacement = path.join(root, "replacement")
  mkdirSync(replacement)
  symlinkSync(replacement, dir)
  assert.throws(() => attempt.read(), /browser_native_launch_receipt_invalid/u)
})
