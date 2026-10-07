// Guards how Desk declares its MCP servers to each host. Two failures on 2026-10-01 motivated it:
// a server named `web` made OpenAI-backed models reject every request, and the first rename touched
// only the declaration file Copilot does not read. These tests read the real shipped files.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  MAX_FUNCTION_NAME_LENGTH,
  RESERVED_MCP_SERVER_NAMES,
  SERVER_NAME_PATTERN,
  checkHardCodedServerNames,
  checkHostDeclarationParity,
  checkServerName,
  collectMcpDeclarations,
  hardCodedServerNames,
  launcherEntryFiles,
  validateMcpDeclarations,
} from "./_contracts/mcp-declarations.js"
import { TOOL_NAMES } from "../../../../../plugins/desk/mcp/src/tool-names.js"

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const { BROWSER_TOOL_NAMES } = require(path.join(repoRoot, "plugins", "desk", "mcp", "web.cjs"))
const toolNames = { desk: TOOL_NAMES, "desk-web": BROWSER_TOOL_NAMES }

// ---- the real files ----

test("every MCP server name Desk declares, on every host and plugin, passes the name rules", () => {
  const declarations = collectMcpDeclarations({ repoRoot })
  const sources = declarations.map((entry) => entry.source)
  for (const expected of [
    "plugins/desk/.mcp.json",
    "plugins/desk/.mcp.copilot.json",
    "plugins/desk/activation/desk.activation.json",
    "plugins/desk/.codex-plugin/plugin.json",
  ]) {
    assert.ok(sources.includes(expected), `${expected} is not among the scanned declarations: ${sources.join(", ")}`)
  }
  const names = new Set(declarations.flatMap((entry) => entry.names))
  assert.deepEqual([...names].sort(), ["desk", "desk-web"])
  const errors = validateMcpDeclarations({ declarations, toolNames })
  assert.deepEqual(errors, [])
})

test("the Claude, Codex and Copilot declarations name the same servers and launch the same entry files", () => {
  const read = (file) => collectMcpDeclarations({ repoRoot }).find((entry) => entry.source === file)
  const claude = read("plugins/desk/.mcp.json")
  const copilot = read("plugins/desk/.mcp.copilot.json")
  assert.deepEqual(claude.names, ["desk", "desk-web"])
  assert.deepEqual(checkHostDeclarationParity({ claude: claude.servers, copilot: copilot.servers }), [])
  assert.deepEqual(launcherEntryFiles(claude.servers.desk), ["bootstrap.cjs"])
  assert.deepEqual(launcherEntryFiles(claude.servers["desk-web"]), ["web.cjs"])
  assert.deepEqual(launcherEntryFiles(copilot.servers.desk), ["bootstrap.cjs"])
  assert.deepEqual(launcherEntryFiles(copilot.servers["desk-web"]), ["web.cjs"])
})

test("the Copilot-facing plugin metadata points at a declaration file that exists and is scanned", () => {
  const declarations = collectMcpDeclarations({ repoRoot })
  const manifest = declarations.find((entry) => entry.source === "plugins/desk/plugin.json")
  assert.deepEqual(manifest.names, ["desk", "desk-web"])
  assert.equal(manifest.reference, "plugins/desk/.mcp.copilot.json")
})

// ---- the rules themselves ----

test("the reserved-name list carries the OpenAI namespaces and cites the failure that added it", () => {
  assert.deepEqual([...RESERVED_MCP_SERVER_NAMES].sort(), [
    "api", "browser", "computer", "container", "default", "file_search", "functions", "image_gen",
    "mcp", "multi_tool_use", "python", "tool", "tools", "web",
  ])
  assert.equal(Object.isFrozen(RESERVED_MCP_SERVER_NAMES), true)
  assert.equal(MAX_FUNCTION_NAME_LENGTH, 64)
  assert.equal(SERVER_NAME_PATTERN.source, "^[a-z][a-z0-9-]*$")
})

test("checkServerName rejects reserved, malformed and too-long names and accepts a good one", () => {
  assert.deepEqual(checkServerName("desk-web", ["browser_click"]), [])
  for (const reserved of RESERVED_MCP_SERVER_NAMES) {
    assert.match(checkServerName(reserved, ["x"]).join("\n"), /reserved/u, reserved)
  }
  for (const bad of ["Desk", "1desk", "desk_web", "desk web", "", "-desk"]) {
    assert.match(checkServerName(bad, ["x"]).join("\n"), /must match/u, JSON.stringify(bad))
  }
  const long = "a".repeat(40)
  const errors = checkServerName(long, ["t".repeat(30)])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /71 characters/u)
  assert.match(errors[0], /64/u)
  assert.deepEqual(checkServerName("a".repeat(30), ["t".repeat(33)]), [])
  assert.equal(checkServerName("a".repeat(30), ["t".repeat(34)]).length, 1)
})

test("the host tool-name forms are both measured: Copilot's server-tool and Claude's plugin-scoped name", () => {
  // desk-web + browser_take_screenshot is 32 characters in Copilot; Claude's mcp__plugin_desk_<server>__<tool> is longer.
  const errors = checkServerName("a".repeat(25), ["t".repeat(25)], { claudePlugin: "desk" })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /mcp__plugin_desk_/u)
  assert.deepEqual(checkServerName("a".repeat(25), ["t".repeat(25)]), [])
})

test("validateMcpDeclarations reports each bad name with its source, and asks for tool names it does not know", () => {
  const declarations = [
    { source: "a/.mcp.json", host: "claude", names: ["web", "desk"] },
    { source: "b/plugin.json", host: "codex", names: ["Bad_Name"] },
    { source: "c/.mcp.json", host: "claude", names: ["mystery"] },
  ]
  const errors = validateMcpDeclarations({ declarations, toolNames: { web: ["x"], desk: ["x"], Bad_Name: ["x"] } })
  assert.equal(errors.length, 3)
  assert.match(errors[0], /^a\/\.mcp\.json: .*"web".*reserved/u)
  assert.match(errors[1], /^b\/plugin\.json: .*"Bad_Name".*must match/u)
  assert.match(errors[2], /^c\/\.mcp\.json: .*"mystery".*tool names/u)
})

test("host parity rejects a renamed, added, removed or re-pointed server", () => {
  const claude = {
    desk: { type: "stdio", command: "node", args: ["-e", "var p=path.join(root,'mcp','bootstrap.cjs')"] },
    "desk-web": { type: "stdio", command: "node", args: ["-e", "path.join(root, 'mcp', 'web.cjs')"] },
  }
  const copilot = {
    desk: { type: "stdio", command: "node", args: ["${COPILOT_PLUGIN_ROOT}/mcp/bootstrap.cjs"] },
    "desk-web": { type: "stdio", command: "node", args: ["${COPILOT_PLUGIN_ROOT}/mcp/web.cjs"] },
  }
  assert.deepEqual(checkHostDeclarationParity({ claude, copilot }), [])
  // the 2026-10-01 drift: one file renamed, the other not
  const renamed = { web: copilot["desk-web"], desk: copilot.desk }
  const names = checkHostDeclarationParity({ claude, copilot: renamed }).join("\n")
  assert.match(names, /server names differ/u)
  assert.match(names, /desk-web/u)
  assert.match(names, /\bweb\b/u)
  const repointed = { ...copilot, "desk-web": { ...copilot["desk-web"], args: ["${COPILOT_PLUGIN_ROOT}/mcp/other.cjs"] } }
  assert.match(checkHostDeclarationParity({ claude, copilot: repointed }).join("\n"), /desk-web.*other\.cjs.*web\.cjs/u)
  const wrongRoot = { ...copilot, desk: { ...copilot.desk, args: ["/abs/mcp/bootstrap.cjs"] } }
  assert.match(checkHostDeclarationParity({ claude, copilot: wrongRoot }).join("\n"), /\$\{COPILOT_PLUGIN_ROOT\}/u)
  const retyped = { ...copilot, desk: { ...copilot.desk, type: "http" } }
  assert.match(checkHostDeclarationParity({ claude, copilot: retyped }).join("\n"), /type/u)
  const recommand = { ...copilot, desk: { ...copilot.desk, command: "python" } }
  assert.match(checkHostDeclarationParity({ claude, copilot: recommand }).join("\n"), /command/u)
  const noArgs = { ...copilot, desk: { type: "stdio", command: "node" } }
  assert.match(checkHostDeclarationParity({ claude, copilot: noArgs }).join("\n"), /one argument/u)
  assert.deepEqual(launcherEntryFiles({}), [])
  const noEntry = { ...claude, desk: { ...claude.desk, args: ["-e", "1"] } }
  assert.match(checkHostDeclarationParity({ claude: noEntry, copilot }).join("\n"), /no mcp\/<file> entry/u)
})

test("collectMcpDeclarations reads plugin manifests with inline servers, string references and none", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const root = mkdtempSync(path.join(tmpdir(), "mcp-declarations-"))
  try {
    mkdirSync(path.join(root, "plugins", "inline"), { recursive: true })
    mkdirSync(path.join(root, "plugins", "dangling"), { recursive: true })
    mkdirSync(path.join(root, "plugins", "bare"), { recursive: true })
    writeFileSync(path.join(root, "plugins", "inline", "plugin.json"), JSON.stringify({ mcpServers: { web: {}, ok: {} } }))
    writeFileSync(path.join(root, "plugins", "dangling", "plugin.json"), JSON.stringify({ mcpServers: "./missing.json" }))
    writeFileSync(path.join(root, "plugins", "bare", "plugin.json"), JSON.stringify({ name: "bare", activation: { codex: null, copilot: {} } }))
    mkdirSync(path.join(root, "plugins", "sparse", "activation"), { recursive: true })
    writeFileSync(path.join(root, "plugins", "sparse", ".mcp.json"), "{}")
    writeFileSync(path.join(root, "plugins", "sparse", "plugin.json"), JSON.stringify({ mcpServers: "./.mcp.json" }))
    writeFileSync(path.join(root, "plugins", "sparse", "activation", "empty.activation.json"), "{}")
    writeFileSync(path.join(root, "plugins", "sparse", "activation", "named.activation.json"), JSON.stringify({ mcp_servers: [{ id: "python" }] }))
    writeFileSync(path.join(root, "plugins", "sparse", "activation", "notes.md"), "ignored")
    writeFileSync(path.join(root, "plugins", "bare", ".mcp.json"), JSON.stringify({ mcpServers: { browser: { type: "stdio", args: [] } } }))
    writeFileSync(path.join(root, "plugins", "README.md"), "not a plugin")
    const found = collectMcpDeclarations({ repoRoot: root })
    assert.deepEqual(found.map((entry) => [entry.source, entry.names]), [
      ["plugins/bare/.mcp.json", ["browser"]],
      ["plugins/dangling/plugin.json", []],
      ["plugins/inline/plugin.json", ["web", "ok"]],
      ["plugins/sparse/.mcp.json", []],
      ["plugins/sparse/activation/named.activation.json", ["python"]],
    ])
    assert.deepEqual(found[3].plugin, "sparse")
    assert.equal(found[1].missing, "plugins/dangling/missing.json")
    const errors = validateMcpDeclarations({ declarations: found, toolNames: { browser: ["x"], web: ["x"], ok: ["x"], python: ["x"] } })
    assert.match(errors.join("\n"), /plugins\/dangling\/plugin\.json: .*plugins\/dangling\/missing\.json.*does not exist/u)
    assert.match(errors.join("\n"), /"browser".*reserved/u)
    assert.match(errors.join("\n"), /"web".*reserved/u)
    assert.match(errors.join("\n"), /plugins\/sparse\/activation\/named\.activation\.json: .*"python".*reserved/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- #144 review nits: the Codex adapter's own server names, and tool lists keyed by plugin ----

test("the server names the Codex adapter spells out in code are declared by a manifest", () => {
  const source = "plugins/desk/mcp/src/activation/adapters/codex.js"
  const names = hardCodedServerNames(readFileSync(path.join(repoRoot, source), "utf8"))
  assert.ok(names.includes("desk"), `the adapter's hard-coded names were not found: ${names.join(", ")}`)
  const declared = [...new Set(collectMcpDeclarations({ repoRoot }).flatMap((entry) => entry.names))]
  assert.deepEqual(checkHardCodedServerNames({ source, names, declared }), [])
})

test("hardCodedServerNames reads TOML tables and path arrays, and a name no declaration holds is reported with its source", () => {
  assert.deepEqual(hardCodedServerNames('[plugins."x".mcp_servers.alpha]\n[mcp_servers.beta]\nconst p = ["mcp_servers", "gamma"]\nmcp_servers = []'), ["alpha", "beta", "gamma"])
  assert.deepEqual(hardCodedServerNames("nothing here"), [])
  const errors = checkHardCodedServerNames({ source: "adapter.js", names: ["desk", "gone"], declared: ["desk", "desk-web"] })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /^adapter\.js hard-codes the MCP server "gone".*declared: desk, desk-web/u)
})

test("a tool list is read by <plugin>/<server> before the bare server name, so two plugins can share a server name", () => {
  const declarations = [
    { source: "a/.mcp.json", plugin: "a", host: "claude", names: ["relay"] },
    { source: "b/.mcp.json", plugin: "b", host: "claude", names: ["relay"] },
  ]
  const long = "t".repeat(60)
  const errors = validateMcpDeclarations({ declarations, toolNames: { "a/relay": ["x"], "b/relay": [long] } })
  assert.equal(errors.length, 2, errors.join("\n"))
  assert.ok(errors.every((error) => error.startsWith("b/.mcp.json: ")), "only plugin b's long tool trips the limit")
  assert.deepEqual(validateMcpDeclarations({ declarations, toolNames: { relay: ["x"] } }), [])
})
