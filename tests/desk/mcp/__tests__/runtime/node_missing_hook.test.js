// With no Node.js on the machine, a host cannot start Desk's Node hooks or its tool servers. Each host's registered session-start command checks for `node` in the host's own shell first and, when there is none, gives the session one message: the Node.js Desk needs, the install command for this platform, and that a new session is needed because tool servers load only when a session starts. With a `node` older than Desk needs and no newer one installed, the Node hook gives the same message.
// These run each registered command the way its host does (Copilot: bash, or PowerShell on Windows; Claude Code: a POSIX shell, Git Bash on Windows) with a PATH that holds no node. Each run's exact context and wall time is printed as a test diagnostic.
import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { resolveBash } from "../../../../../plugins/desk/mcp/src/util/bash.js"

const require = createRequire(import.meta.url)
const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url)).replace(/[\\/]$/u, "")
const { nodeRequiredLine } = require(path.join(plugin, "hooks", "lib", "node-required.cjs"))
const readJson = (...parts) => JSON.parse(readFileSync(path.join(plugin, ...parts), "utf8"))
const WINDOWS = process.platform === "win32"
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "node-missing-")))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))

const floor = /^>=(\d+)\.0\.0$/u.exec(readJson("mcp", "package.json").engines.node)[1]
const claudeCommand = readJson("hooks", "hooks.json").hooks.SessionStart[0].hooks[0].command
const copilotStart = readJson("hooks", "copilot-hooks.json").hooks.sessionStart[0]
const RESTART = "Then the person must open a new terminal and start a new session, because tool servers load only when a session starts."
const WINGET = "winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements"
const POSIX_INSTALL = { darwin: "brew install node", linux: "sudo apt install nodejs" }

// The shell branch runs builtins only, so an empty folder is PATH enough.
function posixPathWithoutNode() {
  const bin = path.join(ROOT, "bin-without-node")
  mkdirSync(bin, { recursive: true })
  return bin
}

// Claude Code on Windows runs hook commands in Git Bash; its usr/bin holds no node.
function shells() {
  if (WINDOWS) {
    const bash = resolveBash()
    const usrBin = bash && path.join(path.dirname(path.dirname(bash)), "usr", "bin")
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    return { bash, sh: bash, pathWithoutNode: usrBin, powershell: existsSync(powershell) ? powershell : null }
  }
  const which = (name) => spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim() || null
  return { bash: which("bash"), sh: "/bin/sh", pathWithoutNode: posixPathWithoutNode(), powershell: which("pwsh") }
}
const SHELLS = shells()

// Windows keeps these in every process's environment, and PowerShell needs PATHEXT to resolve `node` to node.exe.
const WINDOWS_SYSTEM = Object.fromEntries(["SystemRoot", "OS", "PATHEXT"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]))

function env(pathValue, extra = {}) {
  const home = mkdtempSync(path.join(ROOT, "home-"))
  return { PATH: pathValue, HOME: home, USERPROFILE: home, ...WINDOWS_SYSTEM, ...extra }
}

function run(shell, command, environment) {
  const args = /powershell|pwsh/iu.test(path.basename(shell)) ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command] : ["-c", command]
  const started = performance.now()
  const result = spawnSync(shell, args, { env: environment, encoding: "utf8", cwd: ROOT, windowsHide: true })
  return { ...result, ms: performance.now() - started }
}

const claudeCommandFor = () => claudeCommand.split("${CLAUDE_PLUGIN_ROOT}").join(plugin.split(path.sep).join("/"))
const copilotCommandFor = (field) => copilotStart[field].split("${PLUGIN_ROOT}").join(plugin)

function assertNodeMessage(t, label, result, { shape, install }) {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr.trim(), "", `${label} wrote to stderr`)
  const payload = JSON.parse(result.stdout)
  const context = shape === "claude" ? payload.hookSpecificOutput.additionalContext : payload.additionalContext
  if (shape === "claude") {
    assert.deepEqual(Object.keys(payload), ["hookSpecificOutput"])
    assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart")
  } else {
    assert.deepEqual(Object.keys(payload), ["additionalContext"])
  }
  assert.match(context, new RegExp(`^Desk needs Node\\.js ${floor} or newer, and this machine has no Node\\.js \\(no \`node\` on PATH\\)`, "u"))
  assert.ok(context.includes(install), `${label} names ${install}: ${context}`)
  assert.ok(context.includes(RESTART), `${label} says a new session is needed`)
  t.diagnostic(`${label}: ${result.ms.toFixed(0)} ms (whole shell process)`)
  t.diagnostic(`${label} context: ${context}`)
}

const posixInstall = WINDOWS ? WINGET : POSIX_INSTALL[process.platform] ?? POSIX_INSTALL.linux

test("Claude Code with no node: the registered SessionStart command says what to install and that a new session is needed", { skip: SHELLS.sh ? false : "no POSIX shell" }, (t) => {
  for (const shell of new Set([SHELLS.sh, SHELLS.bash].filter(Boolean))) {
    const environment = env(SHELLS.pathWithoutNode)
    if (run(shell, "command -v node", environment).status === 0) return t.skip(`${shell} finds a node on ${SHELLS.pathWithoutNode}`)
    assertNodeMessage(t, `claude via ${shell}`, run(shell, claudeCommandFor(), environment), { shape: "claude", install: posixInstall })
  }
})

test("Copilot on macOS or Linux with no node: the registered bash sessionStart command says what to install and that a new session is needed", { skip: !WINDOWS && SHELLS.bash ? false : "Copilot runs the bash command only on macOS and Linux" }, (t) => {
  assertNodeMessage(t, "copilot via bash", run(SHELLS.bash, copilotCommandFor("bash"), env(SHELLS.pathWithoutNode)), { shape: "copilot", install: posixInstall })
})

test("Copilot on Windows with no node: the registered PowerShell sessionStart command names the winget install and that a new session is needed", { skip: SHELLS.powershell ? false : "no PowerShell here" }, (t) => {
  const empty = mkdtempSync(path.join(ROOT, "empty-path-"))
  assertNodeMessage(t, `copilot via ${path.basename(SHELLS.powershell)}`, run(SHELLS.powershell, copilotCommandFor("powershell"), env(empty)), { shape: "copilot", install: WINGET })
})

test("with node on PATH, each guarded command runs Desk's Node hook as before", (t) => {
  const nodeDir = path.dirname(process.execPath)
  const desk = path.join(ROOT, "desk")
  mkdirSync(path.join(desk, "_meta"), { recursive: true })
  mkdirSync(path.join(desk, "_archive"), { recursive: true })
  const cases = [
    SHELLS.sh && ["claude", SHELLS.sh, claudeCommandFor(), `${nodeDir}${path.delimiter}${SHELLS.pathWithoutNode}`],
    !WINDOWS && SHELLS.bash && ["copilot", SHELLS.bash, copilotCommandFor("bash"), `${nodeDir}${path.delimiter}${SHELLS.pathWithoutNode}`],
    SHELLS.powershell && WINDOWS && ["copilot", SHELLS.powershell, copilotCommandFor("powershell"), `${nodeDir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`],
  ].filter(Boolean)
  for (const [shape, shell, command, pathValue] of cases) {
    const result = run(shell, command, env(pathValue, { DESK: desk, DESK_FACTORY_HEADLESS: "", CLAUDE_PLUGIN_ROOT: plugin, PLUGIN_ROOT: plugin }))
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    const context = shape === "claude" ? payload.hookSpecificOutput.additionalContext : payload.additionalContext
    // The Node hook ran: its context carries the foundation, and never the missing-Node message.
    assert.match(context, /# Using Desk/u, `${shape} via ${shell}: ${context.slice(0, 400)}`)
    assert.doesNotMatch(context, /Desk needs Node\.js/u, `${shape} via ${shell}: ${context.slice(0, 400)}`)
    t.diagnostic(`${shape} via ${shell} with node: ${result.ms.toFixed(0)} ms`)
  }
})

test("the shell messages name the Node.js floor in mcp/package.json, so the two never drift apart", () => {
  const script = readFileSync(path.join(plugin, "hooks", "node-missing.sh"), "utf8")
  for (const text of [script, copilotStart.powershell]) assert.ok(text.includes(`Desk needs Node.js ${floor} or newer`), text.slice(0, 200))
  assert.ok(script.includes(`prints v${floor} or newer`))
  // The text reaches JSON through printf or a PowerShell literal: no character there may need escaping.
  const literals = [...copilotStart.powershell.matchAll(/'(\{"additionalContext":[^']*)'/gu)].map((match) => match[1])
  assert.equal(literals.length, 2)
  for (const literal of literals) assert.doesNotThrow(() => JSON.parse(literal))
  for (const match of script.matchAll(/desk_(?:install|text)='([^']*)'/gu)) assert.doesNotMatch(match[1], /["\\%]/u)
})

// ---- a node older than Desk needs ----

const old = { path: "/old/bin/node", version: "v16.20.2", abi: "93" }
const noneCompatible = () => ({ node: null, range: `>=${floor}.0.0` })

test("a node older than Desk needs, with no newer one installed, gets the same message with the version it found", () => {
  const home = mkdtempSync(path.join(ROOT, "old-home-"))
  const windows = nodeRequiredLine({ env: { HOME: home }, platform: "win32", current: old, select: noneCompatible })
  assert.match(windows, new RegExp(`^Desk needs Node\\.js ${floor} or newer, and the \`node\` on PATH is v16\\.20\\.2 with no newer Node\\.js installed`, "u"))
  assert.ok(windows.includes(`run \`${WINGET}\` in a terminal`))
  assert.ok(windows.includes(RESTART))

  const bin = mkdtempSync(path.join(ROOT, "brew-bin-"))
  writeFileSync(path.join(bin, "brew"), "#!/bin/sh\n")
  chmodSync(path.join(bin, "brew"), 0o755)
  const mac = nodeRequiredLine({ env: { HOME: home, PATH: bin }, platform: "darwin", current: old, select: noneCompatible })
  if (!WINDOWS) assert.ok(mac.includes("run `brew install node` in a terminal"), mac)

  const range = nodeRequiredLine({ env: { HOME: home }, platform: "win32", current: old, select: () => ({ node: null, range: `>=${floor}.11.0` }) })
  assert.match(range, new RegExp(`^Desk needs Node\\.js >=${floor}\\.11\\.0, and`, "u"), "a range that is not a plain major floor is named as written")
})

test("a node Desk can use, here or installed elsewhere, gets no message, and a failed check never blocks the session", () => {
  assert.equal(nodeRequiredLine({ current: old, select: () => ({ node: { path: "/newer/bin/node" }, range: `>=${floor}.0.0` }) }), "")
  assert.equal(nodeRequiredLine({ current: old, select: () => { throw new Error("broken") } }), "")
  assert.equal(nodeRequiredLine(), "", "the Node running this test is new enough")
})

// The hook must never say Node is missing when the tool server would find one. Both search with the bootstrap's own rule and time
// budget, and a search that ran out of time says nothing, because the server, starting later, may still find a Node.
test("an old node first on PATH with a slow, unversioned newer Node beside it gets no message, as the tool server would find it", { skip: WINDOWS ? "a POSIX shell wrapper stands in for the slow Node" : false }, () => {
  const bin = mkdtempSync(path.join(ROOT, "slow-node-bin-"))
  writeFileSync(path.join(bin, "node"), `#!/bin/sh\n/bin/sleep 0.4\nexec ${JSON.stringify(process.execPath)} "$@"\n`)
  chmodSync(path.join(bin, "node"), 0o755)
  const home = mkdtempSync(path.join(ROOT, "slow-node-home-"))
  const env = { PATH: bin, HOME: home, DESK_NODE_SYSTEM_PREFIX: path.join(ROOT, "no-system-prefix") }
  assert.equal(nodeRequiredLine({ env, platform: process.platform, current: old }), "")
})

test("a search cut short by its time budget never claims Node is missing", () => {
  let clock = 0
  const exhausted = (options) => { clock += 60_000; return { node: null, range: `>=${floor}.0.0`, probeBudgetMs: options.probeBudgetMs } }
  assert.equal(nodeRequiredLine({ env: { HOME: ROOT }, platform: "linux", current: old, select: exhausted, now: () => clock }), "")
})

// With a version manager installed, the advice uses it, as the bootstrap's own fix does. Here `node` must end up on PATH for the
// host to start anything, so nvm-windows also needs `nvm use`.
const NVM_WINDOWS = "run `nvm install lts` and then `nvm use lts` in a terminal"
const NVM_POSIX = "run `nvm install --lts` in a terminal"

test("with no node and nvm installed, the shell message says to install through nvm", { skip: SHELLS.sh ? false : "no POSIX shell" }, (t) => {
  const home = mkdtempSync(path.join(ROOT, "nvm-home-"))
  mkdirSync(path.join(home, ".nvm"), { recursive: true })
  writeFileSync(path.join(home, ".nvm", "nvm.sh"), "# nvm\n")
  // Git Bash always marks itself as Windows (MSYSTEM), so the macOS and Linux case runs only there.
  if (!WINDOWS) {
    const posix = run(SHELLS.sh, claudeCommandFor(), { ...env(SHELLS.pathWithoutNode), HOME: home })
    assertNodeMessage(t, "claude with nvm", posix, { shape: "claude", install: NVM_POSIX })
  }
  const windows = run(SHELLS.sh, claudeCommandFor(), env(SHELLS.pathWithoutNode, { OS: "Windows_NT", NVM_HOME: "C:\\nvm" }))
  assertNodeMessage(t, "claude with nvm-windows", windows, { shape: "claude", install: NVM_WINDOWS })
})

test("with no node and nvm-windows installed, the PowerShell message says to install and use a version through nvm", { skip: SHELLS.powershell ? false : "no PowerShell here" }, (t) => {
  const empty = mkdtempSync(path.join(ROOT, "empty-path-"))
  const result = run(SHELLS.powershell, copilotCommandFor("powershell"), env(empty, { NVM_HOME: "C:\\nvm" }))
  assertNodeMessage(t, "copilot with nvm-windows", result, { shape: "copilot", install: NVM_WINDOWS })
})
