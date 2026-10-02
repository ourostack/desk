#!/usr/bin/env node
// Refreshes (or checks) mcp/web-catalog.json, the snapshot of Playwright MCP's tool list that web-proxy.cjs serves while the browser installs.
//
//   node scripts/refresh-web-catalog.mjs            install the latest @playwright/mcp, read its tool list and rewrite the snapshot
//   node scripts/refresh-web-catalog.mjs --check    the same, but only report; exit 1 when the tools differ from the snapshot
//
// Options: --file <snapshot> (default mcp/web-catalog.json), --package <spec> (default @playwright/mcp@latest), --npm-cli <npm-cli.js> (default: the npm on PATH).
// Exit codes: 0 the snapshot matches (or was rewritten), 1 --check found a difference, 2 the latest release could not be installed or asked for its tools.
// A new release that only changes the version leaves the tools alone: --check passes and a rewrite records the new version.
// A tool added or removed also needs BROWSER_TOOL_NAMES in web.cjs and the inline launcher's `names` list in .mcp.json updated; tests/desk/mcp/__tests__/launch/web.test.js fails until all three agree.

import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const { describeDiff, diffCatalog } = require("../web-proxy.cjs")
const defaultFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web-catalog.json")

function option(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}

function install(spec, dir, npmCli) {
  const command = npmCli ? [process.execPath, [npmCli]] : [process.platform === "win32" ? "npm.cmd" : "npm", []]
  const result = spawnSync(command[0], [...command[1], "install", "--prefix", dir, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", spec], { encoding: "utf8", shell: !npmCli && process.platform === "win32" })
  if (result.status !== 0) throw new Error(`npm install ${spec} failed: ${String(result.stderr).trim().split("\n").pop()}`)
  const root = path.join(dir, "node_modules", "@playwright", "mcp")
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["playwright-mcp"]
  return { version: pkg.version, cli: path.join(root, bin) }
}

// Start the installed browser, send the handshake and tools/list, and resolve with the tools it lists.
function listTools(cli) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--headless", "--isolated"], { stdio: ["pipe", "pipe", "inherit"] })
    let text = ""
    let asked = false
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("the browser did not list its tools within 60 seconds")) }, 60000)
    child.on("error", reject)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      text += chunk
      for (const line of text.split("\n")) {
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 1 && !asked) {
          asked = true
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`)
        } else if (message.id === 2) {
          clearTimeout(timer)
          child.kill("SIGTERM")
          if (message.error) reject(new Error(`tools/list failed: ${message.error.message}`))
          else resolve(message.result.tools)
          return
        }
      }
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "refresh-web-catalog", version: "1" } } })}\n`)
  })
}

export async function run(argv, io = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) }) {
  const file = option(argv, "--file", defaultFile)
  const check = argv.includes("--check")
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-web-catalog-"))
  try {
    const { version, cli } = install(option(argv, "--package", "@playwright/mcp@latest"), dir, option(argv, "--npm-cli", null))
    const tools = (await listTools(cli)).sort((a, b) => (a.name < b.name ? -1 : 1))
    const current = JSON.parse(readFileSync(file, "utf8"))
    const diff = diffCatalog(current.tools, tools)
    const differs = describeDiff(diff) !== ""
    if (differs) io.out(`@playwright/mcp ${version} lists tools that differ from the snapshot (${current.playwrightMcpVersion}): ${describeDiff(diff)}\n`)
    else io.out(`@playwright/mcp ${version} lists the same tools as the snapshot (${current.playwrightMcpVersion}).\n`)
    if (check) return differs ? 1 : 0
    if (differs || version !== current.playwrightMcpVersion) {
      writeFileSync(file, `${JSON.stringify({ playwrightMcpVersion: version, tools }, null, 2)}\n`)
      io.out(`Rewrote ${file} for ${version}.\n`)
    }
    return 0
  } catch (error) {
    io.err(`${error.message}\n`)
    return 2
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2))
