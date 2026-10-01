import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  DESK_SETUP_DIRECTION,
  bootCommand,
  copilotStartupDirection,
  deskStartupDirection,
  promptBootDirection,
  resolveStartupRoot,
  startDirection,
} from "../../../../../plugins/desk/mcp/src/util/startup-direction.js"

const mcpRoot = path.resolve(fileURLToPath(new URL("../../../../../plugins/desk/mcp", import.meta.url)))
const script = path.join(mcpRoot, "scripts", "resolve-desk-root.js")

// A temporary HOME with a ~/desk fallback that has the desk layout, a solo desk, a crew-shaped workspace and a plain repository.
function withSandbox(body) {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-startup-line-")))
  try {
    const home = path.join(scratch, "home")
    const fallback = path.join(home, "desk")
    const solo = path.join(scratch, "solo")
    const crew = path.join(scratch, "crew")
    const codeRepo = path.join(scratch, "code-repo")
    for (const dir of [path.join(fallback, "_meta"), path.join(fallback, "_archive"), path.join(solo, "_meta"), path.join(solo, "_archive"), path.join(crew, "_meta"), path.join(crew, "desks"), codeRepo]) {
      mkdirSync(dir, { recursive: true })
    }
    const malformed = path.join(scratch, "bad.json")
    writeFileSync(malformed, "{")
    body({ env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, home, fallback, solo, crew, codeRepo, malformed })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test("the startup line names the bound root and where it came from", () => {
  for (const [source, label] of [
    ["explicit-root", "the root passed to Desk"],
    ["host-session-root", "the root passed to Desk"],
    ["host-project", "this session's project folder is a desk"],
    ["activation-config", "the saved desk binding"],
    ["env:DESK", "the DESK environment variable"],
    ["home_fallback", "a home-folder fallback"],
    ["overlay_home_fallback", "the home-folder desk of a work overlay loaded in this session"],
  ]) {
    const line = deskStartupDirection({ root: "/desks/one", source })
    assert.ok(line.startsWith(`Desk startup: $DESK is /desks/one (${label}). `), `${source}: ${line}`)
    assert.match(line, /The boot has not run yet: .* not a scan of the workspace\. Run `node \S*session-boot\.js` now, before other work/u)
    assert.match(line, /An overlay that launches Desk with its own root binds that root instead; desk_status reports the root Desk actually bound/u)
  }
})

test("the startup line routes to setup only when no desk is found", () => {
  for (const bound of [null, undefined, { root: null }]) {
    const line = deskStartupDirection(bound)
    assert.match(line, /^Desk startup: no desk is bound yet, so Desk is in setup mode and the boot has not run\./u)
    assert.match(line, /desk:first-run-bootstrap by default/u)
    assert.match(line, /crew:join-crew/u)
    assert.match(line, /Do not offer to continue without Desk/u)
  }
})

test("an unreadable root configuration is reported as unreadable, never as setup mode", () => {
  const line = deskStartupDirection({ root: null, error: "desk-mcp: activation config /x must be valid JSON" })
  assert.match(line, /^Desk startup: Desk's root configuration could not be read \(desk-mcp: activation config \/x must be valid JSON\), so this hook cannot say which desk is bound\./u)
  assert.match(line, /desk_status reports the actual state/u)
  assert.doesNotMatch(line, /no desk is bound yet|setup mode|\$DESK is/u)
})

test("a binding whose folder is missing is named as unusable, never as setup mode or another desk", () => {
  const line = deskStartupDirection({ root: null, unavailable: { path: "/gone/desk", message: "desk-mcp: the saved desk binding /b.json names /gone/desk, which does not exist. Desk does not fall back to another desk." } })
  assert.match(line, /^Desk startup: Desk cannot use the desk it is bound to \(desk-mcp: the saved desk binding \/b\.json names \/gone\/desk, which does not exist\./u)
  assert.match(line, /desk_status reports root_unavailable with the fix/u)
  assert.match(line, /desk:first-run-bootstrap/u)
  assert.doesNotMatch(line, /no desk is bound yet|\$DESK is/u)
  withSandbox(({ env, fallback }) => {
    const binding = path.join(env.HOME, "binding.json")
    writeFileSync(binding, JSON.stringify({ schema_version: 1, desk: { root: path.join(env.HOME, "moved") } }))
    const bound = resolveStartupRoot({ env: { ...env, DESK: fallback }, homeDir: env.HOME, activationConfigPath: binding })
    assert.equal(bound.root, null)
    assert.equal(bound.unavailable.path, path.join(env.HOME, "moved"))
    assert.match(bound.unavailable.message, /does not fall back/u)
    const saved = copilotStartupDirection({ env: { ...env, DESK_ACTIVATION_CONFIG: binding }, homeDir: env.HOME })
    assert.match(saved, /Desk cannot use the desk it is bound to/u)
    assert.match(saved, /rebind with desk:first-run-bootstrap/u)
    assert.equal(saved.split("does not fall back").length, 2, "the line says it once")
    // A missing $DESK is fixed by correcting DESK, not by rebinding.
    const fromEnv = copilotStartupDirection({ env: { ...env, DESK: path.join(env.HOME, "moved") }, homeDir: env.HOME })
    assert.match(fromEnv, /correct or unset DESK and reconnect the Desk MCP server/u)
    assert.doesNotMatch(fromEnv, /first-run-bootstrap/u)
    assert.equal(fromEnv.split("does not fall back").length, 2, "the line says it once")
    assert.equal(resolveStartupRoot({ env, homeDir: env.HOME, explicitRoot: path.join(env.HOME, "nope") }).unavailable.path, path.join(env.HOME, "nope"))
  })
})

test("resolveStartupRoot separates a missing desk from an unreadable configuration", () => {
  withSandbox(({ env, fallback, malformed }) => {
    assert.deepEqual(resolveStartupRoot({ env, homeDir: env.HOME }), { root: fallback, source: "home_fallback" })
    rmSync(fallback, { recursive: true })
    assert.deepEqual(resolveStartupRoot({ env, homeDir: env.HOME }), { root: null })
    const broken = resolveStartupRoot({ env, homeDir: env.HOME, activationConfigPath: malformed })
    assert.equal(broken.root, null)
    assert.match(broken.error, /must be valid JSON/u)
  })
})

test("Copilot resolves the root with the session folder as the project folder, exactly as the server will", () => {
  withSandbox(({ env, fallback, solo, crew, codeRepo, malformed }) => {
    const copilot = (extra, sessionFolder) => copilotStartupDirection({ env: { ...env, ...extra }, sessionFolder, homeDir: env.HOME })
    // An ordinary folder: one root, the one the server binds.
    assert.equal(copilot({}, codeRepo), deskStartupDirection({ root: fallback, source: "home_fallback" }))
    // A desk-shaped session folder is the root, as it is on Claude Code, whatever $DESK or the home fallback say.
    assert.equal(copilot({ DESK: crew }, crew), deskStartupDirection({ root: crew, source: "host-project" }))
    assert.equal(copilot({ DESK: solo }, crew), deskStartupDirection({ root: crew, source: "host-project" }))
    assert.equal(copilot({}, crew), deskStartupDirection({ root: crew, source: "host-project" }))
    // An unreadable saved binding is reported as unreadable.
    assert.match(copilot({ DESK_ACTIVATION_CONFIG: malformed }, codeRepo), /root configuration could not be read/u)
    // No session folder at all behaves like an ordinary folder.
    assert.equal(copilot({}, undefined), deskStartupDirection({ root: fallback, source: "home_fallback" }))
  })
})

test("resolve-desk-root --startup-line prints the Claude line, where the server also takes the project folder", () => {
  withSandbox(({ env, fallback, crew, malformed }) => {
    const line = (extra) => execFileSync(process.execPath, [script, "--startup-line"], { encoding: "utf8", env: { ...env, ...extra } })
    assert.equal(line({}), deskStartupDirection({ root: fallback, source: "home_fallback" }))
    assert.equal(line({ CLAUDE_PROJECT_DIR: crew }), deskStartupDirection({ root: crew, source: "host-project" }))
    assert.match(line({ DESK_ACTIVATION_CONFIG: malformed }), /root configuration could not be read/u)
    rmSync(fallback, { recursive: true })
    assert.equal(line({}), deskStartupDirection(null))
  })
})

test("root CLI preserves its JSON and root-only contracts with missing or malformed bindings", () => {
  withSandbox(({ env, fallback, malformed }) => {
    const run = (args, extra = {}) => execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...env, NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH, ...extra },
    })
    assert.equal(run(["--root-only"]), fallback)
    assert.equal(JSON.parse(run([])).root, fallback)
    assert.match(run(["--startup-line"]), /Desk startup:/u)
    const bad = JSON.parse(run([], { DESK_ACTIVATION_CONFIG: malformed }))
    assert.equal(bad.root, null)
    assert.deepEqual(bad.tried, [])
    assert.match(bad.error, /JSON/)
    rmSync(fallback, { recursive: true })
    assert.equal(run(["--root-only"]), "")
    const missing = JSON.parse(run([]))
    assert.equal(missing.root, null)
    assert.ok(missing.tried.length > 0)
  })
})

test("Desk running from an Agency session that loads the ms-desk overlay still names ~/ms-desk; without the overlay it does not", async () => {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-agency-session-")))
  try {
    const home = path.join(scratch, "home")
    for (const desk of ["ms-desk", "desk"]) for (const part of ["_meta", "_archive"]) mkdirSync(path.join(home, desk, part), { recursive: true })
    // Desk's own resolver modules, copied where Agency copies the plugin for one session.
    const load = async (container, overlays) => {
      const util = path.join(scratch, container, "desk", "mcp", "src", "util")
      mkdirSync(util, { recursive: true })
      for (const file of ["paths.js", "startup-direction.js", "redact.js"]) copyFileSync(path.join(mcpRoot, "src", "util", file), path.join(util, file))
      mkdirSync(path.join(util, "..", "factory"), { recursive: true })
      copyFileSync(path.join(mcpRoot, "src", "factory", "credential.js"), path.join(util, "..", "factory", "credential.js"))
      writeFileSync(path.join(scratch, container, "desk", "mcp", "package.json"), JSON.stringify({ type: "module" }))
      for (const overlay of overlays) {
        mkdirSync(path.join(scratch, container, overlay), { recursive: true })
        writeFileSync(path.join(scratch, container, overlay, "plugin.json"), JSON.stringify({ name: overlay }))
      }
      return import(pathToFileURL(path.join(util, "startup-direction.js")).href)
    }
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home }
    const withOverlay = await load("agency-plugin-Zx9.p101", ["ms-desk"])
    assert.equal(
      withOverlay.copilotStartupDirection({ env, homeDir: home }),
      withOverlay.deskStartupDirection({ root: path.join(home, "ms-desk"), source: "overlay_home_fallback" }),
    )
    assert.ok(withOverlay.bootCommand().includes(path.join("agency-plugin-Zx9.p101", "desk", "mcp", "scripts", "session-boot.js")), "each copy names its own boot script")
    const plain = await load("agency-plugin-Yw8.p102", [])
    assert.equal(
      plain.copilotStartupDirection({ env, homeDir: home }),
      plain.deskStartupDirection({ root: path.join(home, "desk"), source: "home_fallback" }),
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("the startup line gives the boot command by absolute path, says the boot has not run, and quotes a path with a space", () => {
  const line = deskStartupDirection({ root: "/desks/one", source: "env:DESK" })
  const command = bootCommand()
  assert.ok(path.isAbsolute(command.replace(/^node /u, "")), command)
  assert.ok(command.endsWith(path.join("mcp", "scripts", "session-boot.js")) || command.endsWith(`${path.join("mcp", "scripts", "session-boot.js")}"`))
  assert.ok(line.includes(`Run \`${command}\` now`))
  assert.match(line, /--task "<what the operator named>"/u)
  assert.match(line, /A child agent with a bounded brief follows the brief instead/u)
  assert.equal(bootCommand("/a b/session-boot.js"), 'node "/a b/session-boot.js"')
  assert.equal(bootCommand("/a/session-boot.js"), "node /a/session-boot.js")
  assert.match(startDirection("node x"), /Run `node x` now/u)
  assert.match(DESK_SETUP_DIRECTION, /the boot has not run/u)
  assert.ok(DESK_SETUP_DIRECTION.includes(command))
  assert.doesNotMatch(line, /Desk boot pre-checks:/u, "a hook with no pre-check line never mentions one")
})

test("the per-prompt boot direction is a short pointer that gives the exact command", () => {
  const line = promptBootDirection("node /x/session-boot.js")
  assert.match(line, /^Desk boot is pending for this session: run `node \/x\/session-boot\.js` first \(one quick call\), then answer this message\. A child agent with a bounded brief skips this\.$/u)
  assert.doesNotMatch(line, /has not run/u, "a pointer, not an unconditional claim")
  assert.ok(promptBootDirection().includes(bootCommand()))
})
