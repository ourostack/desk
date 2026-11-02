import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { removeTree } from "../_remove_tree.js"

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const wrapper = path.join(repoRoot, "plugins/superpowers/hooks/run-hook.cmd")
const bash = process.env.SUPERPOWERS_TEST_BASH || (process.platform === "win32" ? "bash" : "/bin/bash")
const deadlineMs = 2000

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "superpowers hook "))
  t.after(async () => {
    await removeTree(root)
    assert.equal(existsSync(root), false)
    t.diagnostic(`Removed owned fixture: ${root}`)
  })
  const plugin = path.join(root, "plugins/superpowers")
  const hooks = path.join(plugin, "hooks")
  mkdirSync(hooks, { recursive: true })
  for (const name of ["run-hook.cmd", "run-hook-unix", "copilot-hooks.json", "run-hook-compat.provenance.json"]) {
    copyFileSync(path.join(repoRoot, "plugins/superpowers/hooks", name), path.join(hooks, name))
  }
  copyFileSync(path.join(repoRoot, "plugins/superpowers/plugin.json"), path.join(plugin, "plugin.json"))
  copyFileSync(path.join(repoRoot, "plugins/desk/activation/copilot-root.flattened-bundle.json"), path.join(root, "bundle.json"))
  return { root, plugin, hooks, wrapper: path.join(hooks, "run-hook.cmd") }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: "",
    timeout: deadlineMs,
    killSignal: "SIGKILL",
    ...options,
  })
  assert.equal(result.error, undefined, `hook must finish within ${deadlineMs}ms: ${result.error?.message}`)
  assert.equal(result.signal, null)
  return result
}

test("Superpowers wrapper reaches an owned hook without hanging in the batch preamble", (t) => {
  const owned = fixture(t)
  writeFileSync(path.join(owned.hooks, "probe"), 'printf "hook reached\\n"\n')
  const result = run(bash, [owned.wrapper, "probe"], { cwd: owned.root })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "hook reached\n")
  assert.equal(result.stderr, "")
})

test("Superpowers wrapper preserves spaced, empty and literal shell arguments", (t) => {
  const owned = fixture(t)
  writeFileSync(path.join(owned.hooks, "probe"), 'printf "<%s>\\n" "$@"\n')
  const result = run(bash, [owned.wrapper, "probe", "space value", "", "it's literal", "$HOME", "*", ";", "7", "8", "9", "10"])
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "<space value>\n<>\n<it's literal>\n<$HOME>\n<*>\n<;>\n<7>\n<8>\n<9>\n<10>\n")
  assert.equal(result.stderr, "")
})

test("Superpowers wrapper preserves hook stdin, stderr and nonzero exit status", (t) => {
  const owned = fixture(t)
  writeFileSync(path.join(owned.hooks, "probe"), 'IFS= read -r line\nprintf "<%s>\\n" "$line"\nprintf "hook failure\\n" >&2\nexit 37\n')
  const result = run(bash, [owned.wrapper, "probe"], { input: "input with spaces and $literal\n" })
  assert.equal(result.status, 37)
  assert.equal(result.stdout, "<input with spaces and $literal>\n")
  assert.equal(result.stderr, "hook failure\n")
})

test("Superpowers wrapper reports a missing hook instead of success", (t) => {
  const owned = fixture(t)
  const result = run(bash, [owned.wrapper, "absent-hook"])
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /absent-hook/)
})

test("authored source and copied-package declarations select the compatible driver in both shell fields", (t) => {
  const owned = fixture(t)
  for (const plugin of [path.join(repoRoot, "plugins/superpowers"), owned.plugin]) {
    const manifest = JSON.parse(readFileSync(path.join(plugin, "plugin.json")))
    const declaration = JSON.parse(readFileSync(path.join(plugin, manifest.hooks))).hooks.sessionStart[0]
    assert.equal(declaration.bash, 'bash "${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start')
    assert.equal(declaration.powershell, '& "${PLUGIN_ROOT}\\hooks\\run-hook.cmd" session-start')
    assert.equal(declaration.timeoutSec, 10)
  }
  const bundle = JSON.parse(readFileSync(path.join(owned.root, "bundle.json")))
  const provider = bundle.dependency_closure.find((entry) => entry.id === "superpowers")
  assert.equal(path.join(owned.root, path.dirname(provider.plugin)), owned.plugin)
  writeFileSync(path.join(owned.hooks, "session-start"), 'printf "copied declaration reached\\n"\n')
  const manifest = JSON.parse(readFileSync(path.join(owned.plugin, "plugin.json")))
  const declaration = JSON.parse(readFileSync(path.join(owned.plugin, manifest.hooks))).hooks.sessionStart[0]
  const result = run(bash, ["-c", declaration.bash], {
    env: { ...process.env, PLUGIN_ROOT: owned.plugin },
    cwd: owned.root,
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "copied declaration reached\n")
  assert.equal(result.stderr, "")
})

test("compatibility driver preserves basename dispatch", (t) => {
  const owned = fixture(t)
  writeFileSync(path.join(owned.hooks, "probe"), 'printf "basename reached\\n"\n')
  const result = run(bash, ["run-hook.cmd", "probe"], { cwd: owned.hooks })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "basename reached\n")
})

test("missing Unix sibling fails explicitly without executing batch commands", (t) => {
  const owned = fixture(t)
  unlinkSync(path.join(owned.hooks, "run-hook-unix"))
  const result = run(bash, [owned.wrapper, "probe"])
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /run-hook-unix/)
  assert.doesNotMatch(result.stderr, /command not found/)
})

test("unreadable Unix sibling fails explicitly", { skip: process.platform === "win32" }, (t) => {
  const owned = fixture(t)
  const sibling = path.join(owned.hooks, "run-hook-unix")
  chmodSync(sibling, 0o000)
  try {
    const result = run(bash, [owned.wrapper, "probe"])
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /run-hook-unix.*Permission denied/)
  } finally {
    chmodSync(sibling, 0o644)
  }
})

test("Superpowers wrapper dispatches an owned hook through native cmd.exe", { skip: process.platform !== "win32" }, (t) => {
  const owned = fixture(t)
  writeFileSync(path.join(owned.hooks, "probe"), 'printf "<%s>\\n" "$@"\n')
  const result = run(process.env.ComSpec || "cmd.exe", [
    "/d", "/s", "/c", `""${owned.wrapper}" probe "space value" "" tail"`,
  ], { cwd: owned.root })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.replaceAll("\r\n", "\n"), "<space value>\n<>\n<tail>\n")
  assert.equal(result.stderr, "")
})

test("authored copied-package PowerShell declaration dispatches through native Windows", { skip: process.platform !== "win32" }, (t) => {
  const owned = fixture(t)
  writeFileSync(path.join(owned.hooks, "session-start"), 'printf "powershell declaration reached\\n"\n')
  const declaration = JSON.parse(readFileSync(path.join(owned.hooks, "copilot-hooks.json"))).hooks.sessionStart[0]
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    declaration.powershell.replaceAll("${PLUGIN_ROOT}", "$env:PLUGIN_ROOT"),
  ], { env: { ...process.env, PLUGIN_ROOT: owned.plugin }, cwd: owned.root })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.replaceAll("\r\n", "\n"), "powershell declaration reached\n")
  assert.equal(result.stderr, "")
})
