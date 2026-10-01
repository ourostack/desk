import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")
const pathsModule = await import(pathToFileURL(path.join(mcpRoot, "src", "util", "paths.js")))
const entrypoint = await import(pathToFileURL(path.join(mcpRoot, "index.js")))
const resolveRootScript = path.join(mcpRoot, "scripts", "resolve-desk-root.js")

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "desk-claude-binding-"))
  const dirs = {
    root,
    home: path.join(root, "home"),
    project: path.join(root, "project-desk"),
    codeRepo: path.join(root, "code-repo"),
    crew: path.join(root, "crew-workspace"),
    bound: path.join(root, "bound-desk"),
    envRoot: path.join(root, "env-desk"),
    pluginData: path.join(root, "plugin-data"),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  for (const desk of [dirs.project, dirs.bound, dirs.envRoot]) {
    mkdirSync(path.join(desk, "_meta"), { recursive: true })
    mkdirSync(path.join(desk, "_archive"), { recursive: true })
  }
  mkdirSync(path.join(dirs.crew, "_meta"), { recursive: true })
  mkdirSync(path.join(dirs.crew, "desks"), { recursive: true })
  writeFileSync(path.join(dirs.codeRepo, "AGENTS.md"), "# repo\n")
  mkdirSync(path.join(dirs.codeRepo, "_meta"), { recursive: true })
  return dirs
}

// Inherit the runner's environment (including any coverage hook in
// NODE_OPTIONS) but drop the host variables each case sets explicitly.
function childEnv(values) {
  const env = { ...process.env, ...values }
  for (const key of ["DESK", "DESK_ACTIVATION_CONFIG", "CODEX_HOME", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR"]) {
    if (!(key in values)) delete env[key]
  }
  return env
}

function writeBinding(pluginData, rootPath) {
  writeFileSync(
    path.join(pluginData, "desk.activation.json"),
    JSON.stringify({ schema_version: 1, desk: { root: rootPath } }),
  )
}

test("isDeskWorkspace recognizes solo desks and crew workspaces but not ordinary repos", () => {
  const fixture = makeFixture()
  try {
    assert.equal(pathsModule.isDeskWorkspace(fixture.project), true)
    assert.equal(pathsModule.isDeskWorkspace(fixture.crew), true)
    assert.equal(pathsModule.isDeskWorkspace(fixture.codeRepo), false, "_meta alone is not a desk")
    assert.equal(pathsModule.isDeskWorkspace(path.join(fixture.root, "missing")), false)
    assert.equal(pathsModule.isDeskWorkspace(""), false)
    assert.equal(pathsModule.isDeskWorkspace(undefined), false)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a host project that is itself a desk binds before activation config, DESK and home fallbacks", () => {
  const fixture = makeFixture()
  try {
    const configPath = path.join(fixture.pluginData, "desk.activation.json")
    writeBinding(fixture.pluginData, fixture.bound)
    mkdirSync(path.join(fixture.home, "ms-desk"), { recursive: true })
    const result = pathsModule.resolveDeskRootWithSource({
      activationConfigPath: configPath,
      env: { DESK: fixture.envRoot },
      homeDir: fixture.home,
      hostProjectRoot: fixture.project,
    })
    assert.equal(result.root, fixture.project)
    assert.equal(result.source, "host-project")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("explicit and host-session roots still outrank the host project", () => {
  const fixture = makeFixture()
  try {
    const explicit = pathsModule.resolveDeskRootWithSource({
      explicitRoot: fixture.bound,
      homeDir: fixture.home,
      hostProjectRoot: fixture.project,
    })
    assert.equal(explicit.source, "explicit-root")
    const hostSession = pathsModule.resolveDeskRootWithSource({
      hostSessionRoot: fixture.bound,
      homeDir: fixture.home,
      hostProjectRoot: fixture.project,
    })
    assert.equal(hostSession.source, "host-session-root")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a host project that is not a desk is recorded and falls through without failing closed", () => {
  const fixture = makeFixture()
  try {
    const result = pathsModule.resolveDeskRootWithSource({
      env: { DESK: fixture.envRoot },
      homeDir: fixture.home,
      hostProjectRoot: fixture.codeRepo,
    })
    assert.equal(result.root, fixture.envRoot)
    assert.equal(result.source, "env:DESK")
    assert.deepEqual(result.tried.map((entry) => entry.source), ["host-project", "env:DESK"])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("startup activation config falls back to the Claude plugin data binding after Codex", () => {
  const fixture = makeFixture()
  try {
    const binding = path.join(fixture.pluginData, "desk.activation.json")
    assert.equal(
      entrypoint.resolveStartupActivationConfigPath({ args: {}, env: { CLAUDE_PLUGIN_DATA: fixture.pluginData } }),
      null,
      "no binding file yet means no activation config",
    )
    writeBinding(fixture.pluginData, fixture.bound)
    assert.equal(
      entrypoint.resolveStartupActivationConfigPath({ args: {}, env: { CLAUDE_PLUGIN_DATA: fixture.pluginData } }),
      binding,
    )
    assert.equal(
      entrypoint.resolveStartupActivationConfigPath({
        args: {},
        env: { CLAUDE_PLUGIN_DATA: fixture.pluginData, DESK_ACTIVATION_CONFIG: "/explicit.json" },
      }),
      "/explicit.json",
    )
    assert.equal(pathsModule.claudeBindingPath({ CLAUDE_PLUGIN_DATA: fixture.pluginData }), binding)
    assert.equal(pathsModule.claudeBindingPath({}), null)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("startup root resolution uses CLAUDE_PROJECT_DIR and the plugin data binding", () => {
  const fixture = makeFixture()
  try {
    writeBinding(fixture.pluginData, fixture.bound)
    const fromProject = entrypoint.resolveStartupDeskRoot({
      args: {},
      env: { CLAUDE_PROJECT_DIR: fixture.project, CLAUDE_PLUGIN_DATA: fixture.pluginData },
      homeDir: fixture.home,
    })
    assert.equal(fromProject.root, fixture.project)
    assert.equal(fromProject.source, "host-project")
    const fromBinding = entrypoint.resolveStartupDeskRoot({
      args: {},
      env: { CLAUDE_PROJECT_DIR: fixture.codeRepo, CLAUDE_PLUGIN_DATA: fixture.pluginData },
      homeDir: fixture.home,
    })
    assert.equal(fromBinding.root, fixture.bound)
    assert.equal(fromBinding.source, "activation-config")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("main serves setup mode instead of exiting when no desk exists yet, and loads a desk created later in the same session", async () => {
  const fixture = makeFixture()
  const { startInProcess } = await import("./_in_process_desk.js")
  const { callTool } = await import("../../../../../plugins/desk/mcp/src/server.js")
  let runtimeLoads = 0
  const desk = await startInProcess({
    argv: [],
    env: { HOME: fixture.home, CLAUDE_PROJECT_DIR: fixture.codeRepo, CLAUDE_PLUGIN_DATA: fixture.pluginData },
    homeDir: fixture.home,
    cwd: fixture.codeRepo,
    mcpRoot: "/fixture/mcp",
    runtimeImporter: async () => {
      runtimeLoads += 1
      return { callTool, connectOrStartController: async () => ({ accepted: true, async status() { return { state: "READY" } } }) }
    },
  })
  // A work overlay's desk in the home folder: plain Desk with no binding must not bind it.
  mkdirSync(path.join(fixture.home, "ms-desk", "_meta"), { recursive: true })
  mkdirSync(path.join(fixture.home, "ms-desk", "_archive"), { recursive: true })
  try {
    const { payload: diagnostic } = await desk.call("desk_status", { detail: true })
    assert.equal(diagnostic.state, "degraded:no_desk_root")
    assert.equal(diagnostic.mode, "setup")
    assert.equal(diagnostic.status, "setup_required")
    assert.equal(diagnostic.reason, "no_desk_root")
    assert.equal(diagnostic.binding_path, path.join(fixture.pluginData, "desk.activation.json"))
    assert.deepEqual(
      diagnostic.paths_tried.map((entry) => entry.source),
      ["host-project", "home_fallback", "home_fallback"],
    )
    assert.doesNotMatch(JSON.stringify(diagnostic.paths_tried), /ms-desk/u)
    assert.equal(diagnostic.remediation[0].action, "run_first_run_bootstrap")
    assert.equal(diagnostic.remediation.at(-1).action, "check_binding")
    assert.match(diagnostic.summary, /no desk/iu)
    assert.equal(runtimeLoads, 0, "the runtime is not loaded without a desk")
    // First-run bootstrap creates the desk; the same session picks it up.
    const created = path.join(fixture.home, "desk")
    mkdirSync(path.join(created, "_meta"), { recursive: true })
    mkdirSync(path.join(created, "_archive"), { recursive: true })
    const ready = await desk.statusUntil((payload) => payload.state === "ready")
    assert.equal(ready.root.path, created)
    assert.equal(ready.root.source, "home_fallback", "desk_status reports where the root came from")
    assert.equal(runtimeLoads, 1)
  } finally {
    await desk.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("main reports a wrong explicit root as degraded:root_unavailable, never as setup mode", async () => {
  const fixture = makeFixture()
  const { admitInProcess } = await import("./_in_process_desk.js")
  try {
    const started = await admitInProcess({
      argv: ["--root", path.join(fixture.root, "missing")],
      env: { HOME: fixture.home },
      homeDir: fixture.home,
      mcpRoot: "/fixture/mcp",
      diagnosticServerStarter: () => assert.fail("explicit misconfiguration must not become setup mode"),
      runtimeImporter: async () => assert.fail("runtime must not load"),
    })
    assert.equal(started.snapshot.state, "degraded:root_unavailable")
    assert.match(started.snapshot.diagnostic.observed.message, /--root path does not exist/u)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a saved binding to a missing folder degrades to root_unavailable, binds no other desk, and upgrades in place once the folder exists", async () => {
  const fixture = makeFixture()
  const { startInProcess } = await import("./_in_process_desk.js")
  const { callTool } = await import("../../../../../plugins/desk/mcp/src/server.js")
  // Both home-folder desks exist, and $DESK names a third: none may stand in for the binding.
  for (const home of ["desk", "ms-desk"]) {
    mkdirSync(path.join(fixture.home, home, "_meta"), { recursive: true })
    mkdirSync(path.join(fixture.home, home, "_archive"), { recursive: true })
  }
  const moved = path.join(fixture.root, "moved-desk")
  writeBinding(fixture.pluginData, moved)
  const bindingPath = path.join(fixture.pluginData, "desk.activation.json")
  let runtimeLoads = 0
  const desk = await startInProcess({
    argv: [],
    env: { HOME: fixture.home, DESK: fixture.envRoot, CLAUDE_PROJECT_DIR: fixture.codeRepo, CLAUDE_PLUGIN_DATA: fixture.pluginData },
    homeDir: fixture.home,
    cwd: fixture.codeRepo,
    mcpRoot: "/fixture/mcp",
    diagnosticServerStarter: () => assert.fail("a binding to a missing folder is not setup mode"),
    runtimeImporter: async () => {
      runtimeLoads += 1
      return { callTool, connectOrStartController: async () => ({ accepted: true, async status() { return { state: "READY" } } }) }
    },
  })
  try {
    const degraded = await desk.statusUntil((payload) => payload.state !== "admitting")
    assert.equal(degraded.state, "degraded:root_unavailable")
    assert.equal(degraded.status, "degraded")
    assert.deepEqual(degraded.root, { path: moved, source: "activation-config", problem: "does not exist", activation_config: bindingPath })
    assert.match(degraded.admission.summary, /does not fall back to another desk/u)
    assert.match(degraded.fix, new RegExp(`names ${moved.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"))
    assert.match(degraded.fix, /desk:first-run-bootstrap/u)
    assert.match(degraded.fix, /call desk_status/u)
    const read = await desk.call("desk_search", { query: "anything" })
    assert.equal(read.isError, true)
    assert.equal(read.payload.code, "root_unavailable")
    const write = await desk.call("task_create", { track: "ops", slug: "refused-write", title: "Refused" })
    assert.equal(write.isError, true)
    assert.equal(write.payload.code, "root_unavailable")
    assert.equal(runtimeLoads, 0, "no other desk was bound")

    // The desk comes back where the binding says: the same session upgrades with no restart.
    mkdirSync(path.join(moved, "_meta"), { recursive: true })
    mkdirSync(path.join(moved, "_archive"), { recursive: true })
    const ready = await desk.statusUntil((payload) => payload.state === "ready")
    assert.equal(ready.root.path, moved)
    assert.equal(ready.root.source, "activation-config")
    assert.equal(runtimeLoads, 1)
  } finally {
    await desk.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a $DESK naming a missing folder degrades to root_unavailable with a DESK fix and never binds ~/desk", async () => {
  const fixture = makeFixture()
  const { admitInProcess } = await import("./_in_process_desk.js")
  mkdirSync(path.join(fixture.home, "desk", "_meta"), { recursive: true })
  mkdirSync(path.join(fixture.home, "desk", "_archive"), { recursive: true })
  const missing = path.join(fixture.root, "gone-desk")
  try {
    const started = await admitInProcess({
      argv: [],
      env: { HOME: fixture.home, DESK: missing },
      homeDir: fixture.home,
      mcpRoot: "/fixture/mcp",
      diagnosticServerStarter: () => assert.fail("a set $DESK is not setup mode"),
      runtimeImporter: async () => assert.fail("no other desk may be bound"),
    })
    assert.equal(started.snapshot.state, "degraded:root_unavailable")
    assert.deepEqual(started.snapshot.diagnostic.root, { path: missing, source: "env:DESK", problem: "does not exist", activation_config: null })
    assert.match(started.snapshot.fix, /The DESK environment variable names/u)
    assert.match(started.snapshot.fix, /unset DESK/u)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("an empty ~/desk is not a desk: with no binding, main serves setup mode instead of binding it", async () => {
  const fixture = makeFixture()
  const { startInProcess } = await import("./_in_process_desk.js")
  mkdirSync(path.join(fixture.home, "desk"), { recursive: true })
  const desk = await startInProcess({
    argv: [],
    env: { HOME: fixture.home },
    homeDir: fixture.home,
    mcpRoot: "/fixture/mcp",
    runtimeImporter: async () => assert.fail("an empty ~/desk must not be bound"),
  })
  try {
    const { payload } = await desk.call("desk_status", { detail: true })
    assert.equal(payload.state, "degraded:no_desk_root")
    assert.equal(payload.mode, "setup")
    assert.deepEqual(payload.paths_tried.map((entry) => entry.path), [path.join(fixture.home, "desk"), path.join(fixture.home, "worker-workspace")])
  } finally {
    await desk.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("resolve-desk-root runs when its path goes through a symlink, as under the macOS $TMPDIR or a symlinked ~/.claude", async () => {
  const fixture = makeFixture()
  try {
    const link = path.join(fixture.root, "linked-plugin")
    symlinkSync(path.dirname(mcpRoot), link, process.platform === "win32" ? "junction" : "dir")
    const linkedScript = path.join(link, "mcp", "scripts", "resolve-desk-root.js")
    const root = execFileSync(process.execPath, [linkedScript, "--root-only"], {
      encoding: "utf8",
      env: childEnv({ HOME: fixture.home, DESK: fixture.envRoot }),
    })
    assert.equal(root, fixture.envRoot, "the symlinked spelling still runs the script")

    const { isEntrypoint } = await import(pathToFileURL(resolveRootScript))
    const scriptUrl = pathToFileURL(resolveRootScript).href
    assert.equal(isEntrypoint(linkedScript, scriptUrl), true)
    assert.equal(isEntrypoint(resolveRootScript, scriptUrl), true)
    assert.equal(isEntrypoint(path.join(mcpRoot, "index.js"), scriptUrl), false, "another script is not this one")
    assert.equal(isEntrypoint(path.join(fixture.root, "missing.js"), scriptUrl), false)
    assert.equal(isEntrypoint(undefined, scriptUrl), false)
    assert.equal(isEntrypoint(), false, "under the test runner this module is not the entrypoint")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("resolve-desk-root script reports the same root the server would use", () => {
  const fixture = makeFixture()
  try {
    const run = (env) => JSON.parse(execFileSync(process.execPath, [resolveRootScript], {
      encoding: "utf8",
      env: childEnv({ HOME: fixture.home, ...env }),
    }))
    const project = run({ CLAUDE_PROJECT_DIR: fixture.project })
    assert.equal(project.root, fixture.project)
    assert.equal(project.source, "host-project")
    const none = run({ CLAUDE_PROJECT_DIR: fixture.codeRepo, CLAUDE_PLUGIN_DATA: fixture.pluginData })
    assert.equal(none.root, null)
    assert.equal(none.binding_path, path.join(fixture.pluginData, "desk.activation.json"))
    assert.ok(none.tried.length >= 3)
    assert.ok(none.tried.every((entry) => !entry.path.endsWith(`${path.sep}ms-desk`)))
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
