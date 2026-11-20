// The Claude Code / Codex launch form of desk-web (`node -e <bootstrap>`) must pass the authenticated-output
// runtime check, so `browser_context open browser=mine` is not refused before the driver loads (#1390).
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const pluginRoot = path.join(repoRoot, "plugins", "desk")
const web = require(path.join(pluginRoot, "mcp", "web.cjs"))
const shipped = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.claude-codex.json"), "utf8")).mcpServers["desk-web"]

const STUB_DRIVER = `
const fs = require("fs"), path = require("path")
exports.chromium = { launchPersistentContext() {
  fs.writeFileSync(path.join(__dirname, "reached"), "1")
  throw new Error("synthetic stub driver stops here")
} }
`

// Starts the shipped launch command with synthetic state, home and driver, sends one browser_context open, and returns its text.
async function openMine(launch) {
  const root = await mkTempRoot("desk-web-launcher-")
  const home = path.join(root, "home")
  const state = path.join(root, "state")
  const driverDir = path.join(state, `playwright-core-${web.PLAYWRIGHT_VERSION}`, "node_modules", "playwright-core")
  fs.mkdirSync(path.join(driverDir, "lib", "tools", "cli-client"), { recursive: true })
  fs.writeFileSync(path.join(driverDir, "lib", "tools", "cli-client", "cli.js"), "")
  fs.writeFileSync(path.join(driverDir, "package.json"), JSON.stringify({ name: "playwright-core", version: web.PLAYWRIGHT_VERSION, main: "index.js" }))
  fs.writeFileSync(path.join(driverDir, "index.js"), STUB_DRIVER)
  const profile = path.join(home, "Library", "Application Support", "Microsoft Edge")
  fs.mkdirSync(path.join(profile, "Default", "Network"), { recursive: true })
  fs.writeFileSync(path.join(profile, "Local State"), JSON.stringify({ profile: { last_used: "Default" } }))
  fs.writeFileSync(path.join(profile, "Default", "Network", "Cookies"), "synthetic")
  const exe = path.join(home, "Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge")
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, "")

  const env = { ...process.env, HOME: home, USERPROFILE: home, DESK_BROWSER_STATE_DIR: state, DESK_PLUGIN_ROOT: pluginRoot, DESK_WEB_IDLE_MS: "0" }
  for (const key of ["NODE_OPTIONS", "DEBUG", "DEBUG_FILE", "PWDEBUG"]) delete env[key]
  const child = spawn(process.execPath, launch, { cwd: pluginRoot, env, stdio: ["pipe", "pipe", "pipe"] })
  try {
    const reply = new Promise((resolve, reject) => {
      let out = ""
      const timer = setTimeout(() => reject(new Error("no reply from desk-web")), 30000)
      child.stdout.on("data", (chunk) => {
        out += chunk
        for (const line of out.split("\n")) {
          let message
          try { message = JSON.parse(line) } catch { continue }
          if (message.id === 2) { clearTimeout(timer); resolve(message) }
        }
      })
      child.on("error", reject)
    })
    const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })
    send({ method: "notifications/initialized" })
    send({ id: 2, method: "tools/call", params: { name: "browser_context", arguments: { action: "open", browser: "mine" } } })
    const message = await reply
    return { text: JSON.stringify(message.result), reached: fs.existsSync(path.join(driverDir, "reached")) }
  } finally {
    child.kill()
  }
}

test("the shipped Claude/Codex desk-web launcher opens mine past the runtime check", { skip: process.platform !== "darwin" }, async () => {
  assert.equal(shipped.command, "node")
  assert.equal(shipped.args[0], "-e")
  const { text, reached } = await openMine(shipped.args)
  assert.doesNotMatch(text, /AUTH_LOGGING_REFUSED/u)
  assert.equal(reached, true, text)
})

test("an inline script other than the shipped launcher is still refused", { skip: process.platform !== "darwin" }, async () => {
  const body = shipped.args[1].replace("var fs=require('fs')", "var x=1;var fs=require('fs')")
  assert.notEqual(body, shipped.args[1])
  const { text, reached } = await openMine(["-e", body])
  assert.match(text, /AUTH_LOGGING_REFUSED: Node runtime flag -e is unqualified/u)
  assert.equal(reached, false)
})

test("--require and an extra flag next to the shipped launcher are refused and named", { skip: process.platform !== "darwin" }, async () => {
  const preload = path.join(await mkTempRoot("desk-web-preload-"), "preload.cjs")
  fs.writeFileSync(preload, "")
  for (const [launch, flag] of [
    [["--require", preload, ...shipped.args], "--require"],
    [["--no-warnings", ...shipped.args], "--no-warnings"],
  ]) {
    const { text, reached } = await openMine(launch)
    assert.match(text, new RegExp(`AUTH_LOGGING_REFUSED: Node runtime flag ${flag} is unqualified`, "u"))
    assert.equal(reached, false)
  }
})
