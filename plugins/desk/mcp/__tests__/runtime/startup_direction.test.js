import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  copilotStartupDirection,
  deskStartupDirection,
  resolveStartupRoot,
} from "../../src/util/startup-direction.js"

const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
const script = path.join(mcpRoot, "scripts", "resolve-desk-root.js")

// A temporary HOME with a ~/desk fallback, a solo desk, a crew-shaped workspace and a plain repository.
function withSandbox(body) {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "desk-startup-line-")))
  try {
    const home = path.join(scratch, "home")
    const fallback = path.join(home, "desk")
    const solo = path.join(scratch, "solo")
    const crew = path.join(scratch, "crew")
    const codeRepo = path.join(scratch, "code-repo")
    for (const dir of [fallback, path.join(solo, "_meta"), path.join(solo, "_archive"), path.join(crew, "_meta"), path.join(crew, "desks"), codeRepo]) {
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
    assert.match(line, /Invoke desk:session-start now for the authoritative workspace scan before other work/u)
    assert.match(line, /An overlay that launches Desk with its own root binds that root instead; desk_status reports the root Desk actually bound/u)
  }
  // The session folder agreeing with the bound root is the same single-root case.
  assert.equal(
    deskStartupDirection({ root: "/desks/one", source: "env:DESK" }, { sessionDesk: "/desks/one" }),
    deskStartupDirection({ root: "/desks/one", source: "env:DESK" }),
  )
})

test("the startup line routes to setup only when no desk is found", () => {
  for (const bound of [null, undefined, { root: null }]) {
    const line = deskStartupDirection(bound)
    assert.match(line, /^Desk startup: no desk is bound yet, so Desk is in setup mode\./u)
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
  const inDesk = deskStartupDirection({ root: null, error: "bad" }, { sessionDesk: "/work/crew" })
  assert.match(inDesk, /This session's folder \/work\/crew is a desk; an overlay that launches Desk in this folder binds it\./u)
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
    assert.match(copilotStartupDirection({ env: { ...env, DESK_ACTIVATION_CONFIG: binding }, homeDir: env.HOME }), /Desk cannot use the desk it is bound to/u)
    assert.equal(resolveStartupRoot({ env, homeDir: env.HOME, explicitRoot: path.join(env.HOME, "nope") }).unavailable.path, path.join(env.HOME, "nope"))
  })
})

test("when the session folder is a desk the server will not bind, the line names both roots and never asserts one", () => {
  const line = deskStartupDirection({ root: "/home/me/desk", source: "home_fallback" }, { sessionDesk: "/work/crew" })
  assert.match(line, /^Desk startup: this session's folder \/work\/crew is a desk, but Desk without an overlay binds \/home\/me\/desk \(a home-folder fallback\); an overlay that launches Desk in this folder binds \/work\/crew instead\./u)
  assert.match(line, /desk_status reports the root Desk actually bound, and it wins\./u)
  assert.match(line, /Invoke desk:session-start now for the authoritative workspace scan before other work/u)
  assert.doesNotMatch(line, /\$DESK is/u)

  const unbound = deskStartupDirection({ root: null }, { sessionDesk: "/work/crew" })
  assert.match(unbound, /^Desk startup: this session's folder \/work\/crew is a desk, but Desk without an overlay has no desk bound and starts in setup mode; an overlay that launches Desk in this folder binds \/work\/crew instead\./u)
  assert.match(unbound, /desk_status reports the root Desk actually bound, and it wins\./u)
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

test("Copilot compares the session folder with the root the plain Desk server binds", () => {
  withSandbox(({ env, fallback, solo, crew, codeRepo, malformed }) => {
    const copilot = (extra, sessionFolder) => copilotStartupDirection({ env: { ...env, ...extra }, sessionFolder, homeDir: env.HOME })
    // An ordinary folder: one root, the one the server binds.
    assert.equal(copilot({}, codeRepo), deskStartupDirection({ root: fallback, source: "home_fallback" }))
    // A desk-shaped session folder that the server also binds: one root.
    assert.equal(copilot({ DESK: crew }, crew), deskStartupDirection({ root: crew, source: "env:DESK" }))
    // A desk-shaped session folder that the server does not bind: both roots, desk_status wins.
    assert.equal(copilot({ DESK: solo }, crew), deskStartupDirection({ root: solo, source: "env:DESK" }, { sessionDesk: crew }))
    assert.equal(copilot({}, crew), deskStartupDirection({ root: fallback, source: "home_fallback" }, { sessionDesk: crew }))
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
    for (const desk of ["ms-desk", "desk"]) mkdirSync(path.join(home, desk, "_meta"), { recursive: true })
    // Desk's own resolver modules, copied where Agency copies the plugin for one session.
    const load = async (container, overlays) => {
      const util = path.join(scratch, container, "desk", "mcp", "src", "util")
      mkdirSync(util, { recursive: true })
      for (const file of ["paths.js", "startup-direction.js"]) copyFileSync(path.join(mcpRoot, "src", "util", file), path.join(util, file))
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
      deskStartupDirection({ root: path.join(home, "ms-desk"), source: "overlay_home_fallback" }),
    )
    const plain = await load("agency-plugin-Yw8.p102", [])
    assert.equal(
      plain.copilotStartupDirection({ env, homeDir: home }),
      deskStartupDirection({ root: path.join(home, "desk"), source: "home_fallback" }),
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
