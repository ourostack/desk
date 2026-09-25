// Desk's POSIX sh Node selector (launch/desk-node.sh) and its Node-free MCP responder (launch/node-missing-responder.sh).
//
// Each test builds a fixture plugin tree, a temporary HOME holding fake version-manager installs, and a PATH of fake `node` scripts plus the few system tools the selector needs, so nothing depends on which Node this machine has. The core cases run under every POSIX shell found here (/bin/sh, and dash when present, which is /bin/sh on Debian and Ubuntu).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot, pluginRoot, responderPath, selectorPath } from "./_mcp_handshake.js"

const { TOOL_NAMES } = await import(pathToFileURL(path.join(mcpRoot, "src", "tool-names.js")).href)
const packageJson = JSON.parse(readFileSync(path.join(mcpRoot, "package.json"), "utf8"))

const shells = ["/bin/sh", "/bin/dash"].filter((shell) => existsSync(shell))

function which(tool) {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" })
  assert.equal(result.status, 0, `the selector tests need ${tool} on this machine`)
  return result.stdout.trim()
}

// ---- fixtures ----

/** A plugin tree with the real launch scripts and a package.json whose engines.node is `range` (or none). */
async function makeFixture({ range = packageJson.engines.node, packageJsonText } = {}) {
  const root = await mkTempRoot("desk-node-selector-")
  const plugin = path.join(root, "plugin")
  mkdirSync(path.join(plugin, "launch"), { recursive: true })
  mkdirSync(path.join(plugin, "mcp"), { recursive: true })
  copyFileSync(selectorPath, path.join(plugin, "launch", "desk-node.sh"))
  copyFileSync(responderPath, path.join(plugin, "launch", "node-missing-responder.sh"))
  if (packageJsonText !== undefined) {
    writeFileSync(path.join(plugin, "mcp", "package.json"), packageJsonText)
  } else if (range !== null) {
    writeFileSync(path.join(plugin, "mcp", "package.json"), `${JSON.stringify({ name: "fixture", engines: { node: range } }, null, 2)}\n`)
  }
  const home = path.join(root, "home with space")
  const prefix = path.join(root, "sysroot")
  const tools = path.join(root, "tools")
  for (const dir of [home, prefix, tools]) mkdirSync(dir, { recursive: true })
  // Only the tools the scripts use, so no real `node` on this machine can be found through PATH.
  for (const tool of ["awk", "sed", "dirname", "sh"]) symlinkSync(which(tool), path.join(tools, tool))
  return { root, plugin, home, prefix, tools, selector: path.join(plugin, "launch", "desk-node.sh") }
}

/** A fake `node` that reports `version` and, when run, prints its label and arguments. */
function fakeNode(file, version, { label = file, broken = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, [
    "#!/bin/sh",
    `if [ "$1" = "--version" ]; then ${broken ? "exit 1" : `echo v${version}; exit 0`}; fi`,
    `printf 'ran %s' ${JSON.stringify(label)}`,
    `for arg in "$@"; do printf ' [%s]' "$arg"; done`,
    "printf '\\n'",
    "",
  ].join("\n"))
  chmodSync(file, 0o755)
  return file
}

function run(fixture, args, { shell = "/bin/sh", pathDirs = [], env = {}, input } = {}) {
  return spawnSync(shell, [fixture.selector, ...args], {
    encoding: "utf8",
    input,
    env: {
      HOME: fixture.home,
      PATH: [...pathDirs, fixture.tools].join(":"),
      DESK_NODE_SYSTEM_PREFIX: fixture.prefix,
      ...env,
    },
  })
}

function oldNodeFirstOnPath(fixture) {
  const dir = path.join(fixture.root, "old-bin")
  fakeNode(path.join(dir, "node"), "16.20.2", { label: "path-v16" })
  return dir
}

// ---- engines.node ----

test("the selector reads engines.node from the plugin's package.json, and its built-in fallback matches it", async () => {
  const source = readFileSync(selectorPath, "utf8")
  assert.match(source, new RegExp(`^DEFAULT_NODE_RANGE='${packageJson.engines.node.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}'$`, "mu"))
  const responder = readFileSync(responderPath, "utf8")
  assert.ok(responder.includes(`required=\${DESK_NODE_RANGE:-${packageJson.engines.node}}`), "the responder's fallback range must match engines.node")
})

// ---- discovery across version managers ----

const managers = [
  { id: "nvm (default folder)", file: ({ home }) => path.join(home, ".nvm", "versions", "node", "v22.9.0", "bin", "node") },
  { id: "nvm (NVM_DIR)", file: ({ root }) => path.join(root, "custom-nvm", "versions", "node", "v22.9.0", "bin", "node"), env: ({ root }) => ({ NVM_DIR: path.join(root, "custom-nvm") }) },
  { id: "fnm (XDG data folder)", file: ({ home }) => path.join(home, ".local", "share", "fnm", "node-versions", "v22.9.0", "installation", "bin", "node") },
  { id: "fnm (macOS Application Support)", file: ({ home }) => path.join(home, "Library", "Application Support", "fnm", "node-versions", "v22.9.0", "installation", "bin", "node") },
  { id: "fnm (~/.fnm)", file: ({ home }) => path.join(home, ".fnm", "node-versions", "v22.9.0", "installation", "bin", "node") },
  { id: "fnm (FNM_DIR)", file: ({ root }) => path.join(root, "custom-fnm", "node-versions", "v22.9.0", "installation", "bin", "node"), env: ({ root }) => ({ FNM_DIR: path.join(root, "custom-fnm") }) },
  { id: "Volta (default folder)", file: ({ home }) => path.join(home, ".volta", "tools", "image", "node", "22.9.0", "bin", "node") },
  { id: "Volta (VOLTA_HOME)", file: ({ root }) => path.join(root, "custom-volta", "tools", "image", "node", "22.9.0", "bin", "node"), env: ({ root }) => ({ VOLTA_HOME: path.join(root, "custom-volta") }) },
  { id: "asdf (default folder)", file: ({ home }) => path.join(home, ".asdf", "installs", "nodejs", "22.9.0", "bin", "node") },
  { id: "asdf (ASDF_DATA_DIR)", file: ({ root }) => path.join(root, "custom-asdf", "installs", "nodejs", "22.9.0", "bin", "node"), env: ({ root }) => ({ ASDF_DATA_DIR: path.join(root, "custom-asdf") }) },
  { id: "mise (default folder)", file: ({ home }) => path.join(home, ".local", "share", "mise", "installs", "node", "22.9.0", "bin", "node") },
  { id: "mise (MISE_DATA_DIR)", file: ({ root }) => path.join(root, "custom-mise", "installs", "node", "22.9.0", "bin", "node"), env: ({ root }) => ({ MISE_DATA_DIR: path.join(root, "custom-mise") }) },
  { id: "Homebrew on Apple silicon", file: ({ prefix }) => path.join(prefix, "opt", "homebrew", "bin", "node") },
  { id: "Homebrew on Intel", file: ({ prefix }) => path.join(prefix, "usr", "local", "bin", "node") },
  { id: "Homebrew keg-only node@22 (Apple silicon)", file: ({ prefix }) => path.join(prefix, "opt", "homebrew", "opt", "node@22", "bin", "node") },
  { id: "Homebrew keg-only node@22 (Intel)", file: ({ prefix }) => path.join(prefix, "usr", "local", "opt", "node@22", "bin", "node") },
  { id: "the system", file: ({ prefix }) => path.join(prefix, "usr", "bin", "node") },
]

// Discovery is plain globbing, so one shell covers it; the selection logic below runs under every shell.
for (const manager of managers) {
  const shell = shells[0]
  test(`[${shell}] finds a compatible Node installed by ${manager.id} while Node 16 is first on PATH`, async () => {
    const fixture = await makeFixture()
    const file = fakeNode(manager.file(fixture), "22.9.0")
    const result = run(fixture, ["--which"], {
      shell,
      pathDirs: [oldNodeFirstOnPath(fixture)],
      env: manager.env?.(fixture) ?? {},
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), file)
  })
}

for (const shell of shells) {
  test(`[${shell}] picks the newest compatible Node across managers and skips one that does not run`, async () => {
    const fixture = await makeFixture()
    const { home, prefix } = fixture
    fakeNode(path.join(home, ".nvm", "versions", "node", "v18.20.4", "bin", "node"), "18.20.4")
    fakeNode(path.join(home, ".nvm", "versions", "node", "v20.11.1", "bin", "node"), "20.11.1")
    const nvm24 = fakeNode(path.join(home, ".nvm", "versions", "node", "v24.1.0", "bin", "node"), "24.1.0")
    fakeNode(path.join(home, ".local", "share", "fnm", "node-versions", "v22.9.0", "installation", "bin", "node"), "22.9.0")
    fakeNode(path.join(home, ".volta", "tools", "image", "node", "23.1.0", "bin", "node"), "23.1.0")
    fakeNode(path.join(home, ".asdf", "installs", "nodejs", "21.0.0", "bin", "node"), "21.0.0")
    // The newest by folder name, but its binary does not run: it must be skipped.
    fakeNode(path.join(home, ".local", "share", "mise", "installs", "node", "25.0.0", "bin", "node"), "25.0.0", { broken: true })
    // Homebrew's path carries no version, so the selector asks the binary: 24.2.0 beats nvm's 24.1.0.
    const brew = fakeNode(path.join(prefix, "opt", "homebrew", "bin", "node"), "24.2.0")
    let result = run(fixture, ["--which"], { shell, pathDirs: [oldNodeFirstOnPath(fixture)] })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), brew)

    // Numeric, not lexical: 24.10.0 beats 24.2.0.
    const nvm2410 = fakeNode(path.join(home, ".nvm", "versions", "node", "v24.10.0", "bin", "node"), "24.10.0")
    result = run(fixture, ["--which"], { shell })
    assert.equal(result.stdout.trim(), nvm2410)
    assert.notEqual(nvm24, nvm2410)
  })

  test(`[${shell}] execs the chosen Node with every argument intact, even when an old node is first on PATH`, async () => {
    const fixture = await makeFixture()
    const chosen = fakeNode(path.join(fixture.home, ".nvm", "versions", "node", "v22.9.0", "bin", "node"), "22.9.0", { label: "nvm-v22" })
    for (const mode of [[], ["--mcp"]]) {
      const result = run(fixture, [...mode, "/plugin/mcp/index.js", "--root", "a dir with spaces", ""], {
        shell,
        pathDirs: [oldNodeFirstOnPath(fixture)],
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, "ran nvm-v22 [/plugin/mcp/index.js] [--root] [a dir with spaces] []\n")
    }
    assert.ok(existsSync(chosen))
  })

  test(`[${shell}] a tie keeps the Node that comes first on PATH`, async () => {
    const fixture = await makeFixture()
    const pathDir = path.join(fixture.root, "path-bin")
    const onPath = fakeNode(path.join(pathDir, "node"), "22.9.0")
    fakeNode(path.join(fixture.home, ".nvm", "versions", "node", "v22.9.0", "bin", "node"), "22.9.0")
    const result = run(fixture, ["--which"], { shell, pathDirs: [pathDir] })
    assert.equal(result.stdout.trim(), onPath)
  })

  test(`[${shell}] hooks fall back to the first node on PATH when none is compatible, and exit 127 when there is no Node`, async () => {
    const fixture = await makeFixture()
    let result = run(fixture, ["hook.cjs", "x"], { shell, pathDirs: [oldNodeFirstOnPath(fixture)] })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, "ran path-v16 [hook.cjs] [x]\n")

    result = run(fixture, ["--which"], { shell, pathDirs: [oldNodeFirstOnPath(fixture)] })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, "")

    const empty = await makeFixture()
    result = run(empty, ["hook.cjs"], { shell })
    assert.equal(result.status, 127)
    assert.match(result.stderr, /no Node\.js is installed; Desk needs Node >=20\.0\.0/u)
  })

  test(`[${shell}] with no compatible Node, --mcp completes the MCP handshake through the sh responder and names the fix`, async () => {
    const fixture = await makeFixture()
    const result = run(fixture, ["--mcp", "/plugin/mcp/index.js"], {
      shell,
      pathDirs: [oldNodeFirstOnPath(fixture)],
      input: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "desk_status", arguments: {} } },
      ].map((message) => JSON.stringify(message)).join("\n") + "\n",
    })
    assert.equal(result.status, 0, result.stderr)
    const [init, list, status] = parseLines(result.stdout)
    assert.equal(init.result.serverInfo.name, "desk-mcp-node-missing")
    assert.deepEqual(list.result.tools.map((tool) => tool.name), TOOL_NAMES)
    const payload = JSON.parse(status.result.content[0].text)
    assert.equal(payload.state, "degraded:node_missing")
    assert.equal(payload.required_node, packageJson.engines.node)
    assert.match(payload.fix, /nvm install --lts|brew install node/u)
  })
}

// ---- engines range semantics ----

const rangeCases = [
  { range: ">=20.0.0", versions: ["16.20.2", "20.0.0"], expected: "20.0.0" },
  { range: ">= 20", versions: ["19.9.9", "20.1.0"], expected: "20.1.0" },
  { range: "^20 || ^22", versions: ["20.5.0", "21.9.0", "22.1.0", "23.0.0"], expected: "22.1.0" },
  { range: "~20.1", versions: ["20.1.9", "20.2.0"], expected: "20.1.9" },
  { range: "~20.1.3", versions: ["20.1.2", "20.1.4", "20.2.0"], expected: "20.1.4" },
  { range: ">=20 <23", versions: ["22.9.9", "23.0.0", "24.0.0"], expected: "22.9.9" },
  { range: ">20", versions: ["20.9.0", "21.0.0"], expected: "21.0.0" },
  { range: ">20.1.0", versions: ["20.1.0", "20.1.1"], expected: "20.1.1" },
  { range: "<=22", versions: ["22.9.0", "23.0.0"], expected: "22.9.0" },
  { range: "<=22.1.0", versions: ["22.1.0", "22.1.1"], expected: "22.1.0" },
  { range: "<22", versions: ["21.9.9", "22.0.0"], expected: "21.9.9" },
  { range: "22.3.1", versions: ["22.3.0", "22.3.1", "22.4.0"], expected: "22.3.1" },
  { range: "=22", versions: ["21.0.0", "22.8.0", "23.0.0"], expected: "22.8.0" },
  { range: "22.x", versions: ["22.8.0", "23.0.0"], expected: "22.8.0" },
  { range: "v22.3", versions: ["22.3.5", "22.4.0"], expected: "22.3.5" },
  { range: "^0.2.3", versions: ["0.2.9", "0.3.0"], expected: "0.2.9" },
  { range: "^0.0.3", versions: ["0.0.3", "0.0.4"], expected: "0.0.3" },
  { range: "^0.2", versions: ["0.2.9", "0.3.0"], expected: "0.2.9" },
  { range: "*", versions: ["16.0.0", "24.0.0"], expected: "24.0.0" },
  { range: ">=20.0.0", versions: ["20.9.0", "20.10.0"], expected: "20.10.0" },
  { range: "latest", versions: ["22.0.0"], expected: null },
  { range: ">=26", versions: ["24.0.0", "25.9.9"], expected: null },
]

for (const { range, versions, expected } of rangeCases) {
  test(`engines range ${JSON.stringify(range)} over ${versions.join(", ")} selects ${expected ?? "nothing"}`, async () => {
    const fixture = await makeFixture({ range })
    for (const version of versions) {
      fakeNode(path.join(fixture.home, ".nvm", "versions", "node", `v${version}`, "bin", "node"), version)
    }
    const result = run(fixture, ["--which"])
    if (expected === null) {
      assert.equal(result.status, 1, result.stdout)
    } else {
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), path.join(fixture.home, ".nvm", "versions", "node", `v${expected}`, "bin", "node"))
    }
  })
}

test("engines.node on the same line as engines, or a missing package.json, still yields a range", async () => {
  const inline = await makeFixture({ packageJsonText: '{"name":"x","engines": { "node": ">=24" }}\n' })
  fakeNode(path.join(inline.home, ".nvm", "versions", "node", "v22.9.0", "bin", "node"), "22.9.0")
  assert.equal(run(inline, ["--which"]).status, 1)

  const missing = await makeFixture({ range: null })
  const node20 = fakeNode(path.join(missing.home, ".nvm", "versions", "node", "v20.1.0", "bin", "node"), "20.1.0")
  fakeNode(path.join(missing.home, ".nvm", "versions", "node", "v19.9.0", "bin", "node"), "19.9.0")
  assert.equal(run(missing, ["--which"]).stdout.trim(), node20)
})

// ---- the Node-free responder ----

function parseLines(text) {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

function respond(lines, { env = {}, shell = "/bin/sh" } = {}) {
  return spawnSync(shell, [responderPath], {
    encoding: "utf8",
    input: lines.join(""),
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home", ...env },
  })
}

for (const shell of shells) {
  test(`[${shell}] the responder answers the MCP handshake and every tool call with the degraded result`, () => {
    const result = respond([
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      "\n",
      "not json at all\n",
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\r\n`,
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })}\n`,
      // The TypeScript SDK writes id last; an "id" inside the arguments must not be taken for it.
      `${JSON.stringify({ method: "tools/call", params: { name: "task_create", arguments: { id: 99, note: "say \"hi\" | ok" } }, jsonrpc: "2.0", id: "call-4" })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { arguments: { name: "task_create" }, name: "desk_status" } })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "resources/list" })}\n`,
      // The last line may arrive without a newline before stdin closes.
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "desk_doctor" } }),
    ], { env: { DESK_NODE_RANGE: ">=20.0.0" }, shell })
    assert.equal(result.status, 0, result.stderr)
    const messages = parseLines(result.stdout)
    assert.deepEqual(messages.map((message) => message.id), [1, 2, 3, "call-4", 5, 6, 7])
    const [init, ping, list, gated, status, unknown, doctor] = messages
    assert.equal(init.result.protocolVersion, "2025-03-26")
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: true } })
    assert.match(init.result.instructions, /degraded|Node\.js/u)
    assert.deepEqual(ping.result, {})
    assert.deepEqual(list.result.tools.map((tool) => tool.name), TOOL_NAMES)
    for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, "object")
    assert.equal(gated.result.isError, true)
    assert.equal(status.result.isError, false)
    assert.equal(doctor.result.isError, false)
    const payload = JSON.parse(status.result.content[0].text)
    assert.deepEqual(JSON.parse(gated.result.content[0].text), payload)
    assert.equal(payload.status, "degraded")
    assert.equal(payload.state, "degraded:node_missing")
    assert.equal(payload.code, "node_missing")
    assert.equal(payload.required_node, ">=20.0.0")
    assert.match(payload.fix, /^Run `.+` in a shell, then reconnect the Desk MCP server/u)
    assert.equal(unknown.error.code, -32601)
    assert.match(unknown.error.message, /resources\/list/u)
  })
}

test("the responder defaults the protocol version and the range when neither is given", () => {
  const result = respond([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`, `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "desk_status" } })}\n`])
  const [init, status] = parseLines(result.stdout)
  assert.equal(init.result.protocolVersion, "2025-06-18")
  assert.equal(JSON.parse(status.result.content[0].text).required_node, packageJson.engines.node)
})

test("the responder's install command fits the machine: Homebrew, then an existing nvm, then a fresh nvm", async () => {
  const root = await mkTempRoot("desk-node-fix-")
  const statusFix = (env) => {
    const result = respond([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "desk_status" } })}\n`], { env })
    return JSON.parse(parseLines(result.stdout)[0].result.content[0].text).fix
  }
  const brewBin = path.join(root, "brew-bin")
  mkdirSync(brewBin)
  writeFileSync(path.join(brewBin, "brew"), "#!/bin/sh\nexit 0\n")
  chmodSync(path.join(brewBin, "brew"), 0o755)
  assert.match(statusFix({ PATH: `${brewBin}:/usr/bin:/bin` }), /^Run `brew install node`/u)

  const nvmDir = path.join(root, "nvm with space")
  mkdirSync(nvmDir)
  writeFileSync(path.join(nvmDir, "nvm.sh"), "# nvm\n")
  assert.ok(statusFix({ NVM_DIR: nvmDir }).startsWith(`Run \`. "${nvmDir}/nvm.sh" && nvm install --lts\``))
  const home = path.join(root, "home")
  mkdirSync(path.join(home, ".nvm"), { recursive: true })
  writeFileSync(path.join(home, ".nvm", "nvm.sh"), "# nvm\n")
  assert.ok(statusFix({ HOME: home }).startsWith(`Run \`. "${home}/.nvm/nvm.sh" && nvm install --lts\``))

  assert.match(statusFix({}), /^Run `curl -fsSL https:\/\/raw\.githubusercontent\.com\/nvm-sh\/nvm\/v[0-9.]+\/install\.sh \| bash && \. "\$HOME\/\.nvm\/nvm\.sh" && nvm install --lts`/u)
})

// ---- every Desk entry point goes through the selector ----

test("the Claude and Copilot MCP configs launch Desk through the selector", () => {
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.desk
  assert.equal(claude.command, "sh")
  assert.equal(claude.args[0], "-c")
  assert.match(claude.args[1], /exec sh "\$r\/launch\/desk-node\.sh" --mcp "\$r\/mcp\/index\.js"/u)
  assert.deepEqual(claude.env, { DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" })
  // Claude Code expands ${VAR} and ${VAR:-default} in args; the inline script must use only the $VAR form.
  assert.doesNotMatch(claude.args[1], /\$\{/u)

  const copilot = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.copilot.json"), "utf8")).mcpServers.desk
  assert.equal(copilot.command, "sh")
  assert.deepEqual(copilot.args, ["${COPILOT_PLUGIN_ROOT}/launch/desk-node.sh", "--mcp", "${COPILOT_PLUGIN_ROOT}/mcp/index.js"])
})

test("Desk hooks that run Node run it through the selector", () => {
  const copilotHooks = JSON.parse(readFileSync(path.join(pluginRoot, "hooks", "copilot-hooks.json"), "utf8"))
  assert.equal(copilotHooks.hooks.sessionStart[0].bash, 'sh "${PLUGIN_ROOT}/launch/desk-node.sh" "${PLUGIN_ROOT}/hooks/copilot-session-start.cjs"')
  const claudeHook = readFileSync(path.join(pluginRoot, "hooks", "session-start.sh"), "utf8")
  assert.match(claudeHook, /sh "\$PLUGIN_ROOT\/launch\/desk-node\.sh" "\$PLUGIN_ROOT\/mcp\/scripts\/resolve-desk-root\.js" --startup-line/u)
  assert.doesNotMatch(claudeHook.replace(/^#.*$/gmu, ""), /(^|[;&|(]\s*)node\s/mu)
})

test("the Claude config's inline launcher still completes a handshake when it cannot find the plugin", async () => {
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.desk
  const cwd = await mkTempRoot("desk-no-plugin-cwd-")
  const result = spawnSync(claude.command, claude.args, {
    cwd,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" },
    input: [
      { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } }, jsonrpc: "2.0", id: 0 },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { method: "ping", jsonrpc: "2.0", id: 1 },
      { method: "tools/list", jsonrpc: "2.0", id: 2 },
      { method: "tools/call", params: { name: "desk_status", arguments: {} }, jsonrpc: "2.0", id: 3 },
      { method: "prompts/list", jsonrpc: "2.0", id: "p" },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n",
  })
  assert.equal(result.status, 0, result.stderr)
  const [init, ping, list, status, unknown] = parseLines(result.stdout)
  assert.equal(init.id, 0)
  assert.equal(init.result.protocolVersion, "2025-03-26")
  assert.deepEqual(ping.result, {})
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["desk_status"])
  assert.equal(JSON.parse(status.result.content[0].text).state, "degraded:plugin_root_missing")
  assert.equal(unknown.error.code, -32601)
})

test("the Claude config's inline launcher finds the plugin through DESK_PLUGIN_ROOT or the working directory", async () => {
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.desk
  const fixture = await makeFixture()
  fakeNode(path.join(fixture.home, ".nvm", "versions", "node", "v22.9.0", "bin", "node"), "22.9.0", { label: "nvm-v22" })
  const env = { HOME: fixture.home, PATH: fixture.tools, DESK_NODE_SYSTEM_PREFIX: fixture.prefix }
  const viaEnv = spawnSync(claude.command, claude.args, { cwd: fixture.root, encoding: "utf8", env: { ...env, DESK_PLUGIN_ROOT: fixture.plugin } })
  assert.equal(viaEnv.stdout, `ran nvm-v22 [${path.join(fixture.plugin, "mcp", "index.js")}]\n`)
  const viaCwd = spawnSync(claude.command, claude.args, { cwd: fixture.plugin, encoding: "utf8", env: { ...env, DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" } })
  assert.match(viaCwd.stdout, /^ran nvm-v22 \[.*\/plugin\/mcp\/index\.js\]\n$/u)
})
