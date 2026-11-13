// The Claude SessionStart hook is Node, so it never depends on which `bash` is first on PATH. It exits 0 on every path and honours the headless flag.
// Every run gets its own throwaway HOME and desk, a registry with no checks, and a factory start that does nothing.
import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { bootFixtureEnv } from "../_boot_fixture.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url)).replace(/[\\/]$/u, "")
const hook = path.join(plugin, "hooks", "claude-session-start.cjs")
const foundationPath = path.join(plugin, "skills", "using-desk", "SKILL.md")
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "claude-start-")))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))

const fixture = path.join(ROOT, "boot-fixture.cjs")
writeFileSync(fixture, 'module.exports = { checks: [], startFactory: async () => true, migrationLine: async () => "" };\n')

let counter = 0
function scratch(extra = {}, bootFixture = fixture) {
  const dir = path.join(ROOT, `run-${counter += 1}`)
  const home = path.join(dir, "home")
  const desk = path.join(dir, "desk")
  mkdirSync(home, { recursive: true })
  mkdirSync(path.join(desk, "_meta"), { recursive: true })
  mkdirSync(path.join(desk, "_archive"), { recursive: true })
  const env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    DESK: desk,
    CLAUDE_PLUGIN_ROOT: plugin,
    // The hook's own boot has its own tests below; every other test runs without one.
    DESK_AUTO_BOOT: "0",
    ...extra,
  }
  return { dir, env: bootFixtureEnv(env, bootFixture) }
}

const runNode = (args, env) => spawnSync(process.execPath, [hook, ...args], { env, encoding: "utf8", cwd: ROOT })
const context = (stdout) => JSON.parse(stdout).hookSpecificOutput.additionalContext

test("the hook prints the SessionStart envelope: the startup line first, then the foundation, then the one RFC line", () => {
  const { env } = scratch()
  const result = runNode([foundationPath], env)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.endsWith("\n"), true)
  const payload = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(payload), ["hookSpecificOutput"])
  assert.deepEqual(Object.keys(payload.hookSpecificOutput), ["hookEventName", "additionalContext"])
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart")
  const text = payload.hookSpecificOutput.additionalContext
  const foundation = text.indexOf("The human supplies intent")
  assert.ok(text.startsWith("Desk startup:"), "the startup line leads")
  assert.ok(text.indexOf("Desk runs the session boot itself") < foundation)
  // The separator follows the plugin root's own spelling: a Windows root keeps its backslashes.
  const sep = plugin.includes("\\") ? "\\" : "/"
  assert.ok(text.endsWith(`Desk RFC: ${plugin}${sep}docs${sep}agentic-engineering-v2-rfc.md\n`))
})

test("the foundation path defaults to the plugin's own when the host passes none, and the plugin root to the hook's own folder", () => {
  const { env } = scratch()
  delete env.CLAUDE_PLUGIN_ROOT
  const result = runNode([], env)
  assert.equal(result.status, 0, result.stderr)
  const text = context(result.stdout)
  assert.match(text, /The human supplies intent/u)
  const root = path.resolve(path.dirname(hook), "..")
  const sep = root.includes("\\") ? "\\" : "/"
  assert.ok(text.endsWith(`Desk RFC: ${root}${sep}docs${sep}agentic-engineering-v2-rfc.md\n`))
})

test("a foundation that cannot be read prints the boot fallback, which names no script, and still exits 0", () => {
  const { env, dir } = scratch()
  const missing = path.join(dir, "no-such-SKILL.md")
  const result = runNode([missing], env)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(context(result.stdout), `desk worker boot — the Desk foundation could not be read from ${missing}. Desk runs its own boot; its result comes with your first Desk tool reply, and desk:session-start explains it. The boot's instructions are for the operator's session: a child agent with a bounded brief, or a session the operator told not to boot, follows its brief and ignores them.`)
})

test("a plugin root whose Desk modules cannot be loaded gets the could-not-resolve line, with the foundation and RFC line after it", () => {
  const { env, dir } = scratch()
  const bare = path.join(dir, "bare-plugin")
  mkdirSync(path.join(bare, "skills", "using-desk"), { recursive: true })
  cpSync(foundationPath, path.join(bare, "skills", "using-desk", "SKILL.md"))
  const result = runNode([], { ...env, CLAUDE_PLUGIN_ROOT: bare })
  assert.equal(result.status, 0, result.stderr)
  const text = context(result.stdout)
  assert.ok(text.startsWith("Desk startup: Desk could not resolve its root in this hook, so the hook did not start the boot. Desk starts it with your first Desk tool reply;"))
  assert.match(text, /The human supplies intent/u)
})

test("a headless evaluator session prints nothing and exits 0, for exactly the values the shared rule names", () => {
  for (const [value, silent] of [["1", true], ["true", true], [" ", true], [" 0 ", true], ["0", false], ["", false]]) {
    const { env } = scratch({ DESK_FACTORY_HEADLESS: value })
    const result = runNode([foundationPath], env)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout === "", silent, JSON.stringify(value))
  }
})

test("a fake bash that exits 1 first on PATH changes nothing: the hook exits 0 with valid output", () => {
  const { env, dir } = scratch()
  const bin = path.join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  const relay = "execvpe(/bin/bash) failed"
  writeFileSync(path.join(bin, "bash"), `#!/bin/sh\necho '${relay}' >&2\nexit 1\n`)
  chmodSync(path.join(bin, "bash"), 0o755)
  writeFileSync(path.join(bin, "bash.cmd"), `@echo ${relay} 1>&2\r\n@exit /b 1\r\n`)
  const fakeEnv = { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` }
  // The fake really is what `bash` resolves to here (a shell fallback keeps this honest where bash.cmd is needed).
  const probe = spawnSync("bash", ["-c", "exit 0"], { env: fakeEnv, encoding: "utf8", shell: process.platform === "win32" })
  assert.equal(probe.status, 1)
  // Run the node command hooks.json registers, with the host's variable substituted: past its node check, the command runs node, not bash.
  const registered = JSON.parse(spawnRead()).hooks.SessionStart[0].hooks[0].command
  const nodeCommand = /; then (node [^;]+);/u.exec(registered)[1]
  const args = [...nodeCommand.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin).matchAll(/"([^"]+)"/gu)].map((match) => match[1])
  assert.equal(args.length, 2)
  const result = spawnSync(process.execPath, args, { env: fakeEnv, encoding: "utf8", cwd: ROOT })
  assert.equal(result.status, 0, result.stderr)
  assert.match(context(result.stdout), /The human supplies intent/u)
})

function spawnRead() {
  return spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", path.join(plugin, "hooks", "hooks.json")], { encoding: "utf8" }).stdout
}

// Whatever line the migration check returns (pending, or could not be checked) is passed through as the resolver composed it; this does not depend on its wording.
const migrationFixture = path.join(ROOT, "migration-fixture.cjs")
writeFileSync(migrationFixture, 'module.exports = { checks: [], startFactory: async () => true, migrationLine: async () => "Desk migrations: sentinel-migration is reported by the check." };\n')

test("a migration line from the check is passed through, after the startup line and before the foundation", () => {
  const { env } = scratch({}, migrationFixture)
  const result = runNode([foundationPath], env)
  assert.equal(result.status, 0, result.stderr)
  const text = context(result.stdout)
  const line = text.indexOf("Desk migrations: sentinel-migration is reported by the check.")
  assert.ok(line > text.indexOf("Desk startup:"))
  assert.ok(line < text.indexOf("The human supplies intent"))
})

test("a host that closes the output pipe early does not make the hook fail", async () => {
  const { env } = scratch()
  const child = spawn(process.execPath, [hook, foundationPath], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.destroy()
  const code = await new Promise((resolve) => child.on("close", resolve))
  assert.equal(code, 0)
})

// The real migration check, not a fixture: with a bash that fails the way the WSL relay with no distro does, each migration's Detect cannot run, and the line pending-migrations.js composes for that reaches the agent through this hook. It does not depend on the line's wording past its meaning. A Windows host resolves Git's bash and never the PATH one, so this stands in only where `bash` comes from PATH.
const realMigrationFixture = path.join(ROOT, "real-migration-fixture.cjs")
writeFileSync(realMigrationFixture, "module.exports = { checks: [], startFactory: async () => true };\n")

test("a migration Detect that cannot run because bash is the WSL relay is reported through the hook, not hidden", { skip: process.platform === "win32" }, () => {
  const { env, dir } = scratch({}, realMigrationFixture)
  const bin = path.join(dir, "relay-bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, "bash"), "#!/bin/sh\necho '<3>WSL (9 - Relay) ERROR: CreateProcessCommon:818: execvpe(/bin/bash) failed: No such file or directory' >&2\nexit 1\n")
  chmodSync(path.join(bin, "bash"), 0o755)
  const result = runNode([foundationPath], { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` })
  assert.equal(result.status, 0, result.stderr)
  const text = context(result.stdout)
  const line = text.indexOf("Desk migrations:")
  assert.ok(line > text.indexOf("Desk startup:"))
  assert.ok(line < text.indexOf("The human supplies intent"))
  assert.match(text, /could not be checked at startup because bash could not run/u)
})
