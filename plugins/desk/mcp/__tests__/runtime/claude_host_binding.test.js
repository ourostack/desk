import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

test("main serves setup mode instead of exiting when no desk exists yet", async () => {
  const fixture = makeFixture()
  try {
    const started = []
    await entrypoint.main({
      argv: [],
      env: { HOME: fixture.home, CLAUDE_PROJECT_DIR: fixture.codeRepo, CLAUDE_PLUGIN_DATA: fixture.pluginData },
      homeDir: fixture.home,
      cwd: fixture.codeRepo,
      mcpRoot: "/fixture/mcp",
      diagnosticServerStarter: (options) => {
        started.push(options)
      },
      runtimeImporter: async () => {
        throw new Error("runtime must not load without a desk")
      },
    })
    assert.equal(started.length, 1)
    const { diagnostic } = started[0]
    assert.equal(diagnostic.mode, "setup")
    assert.equal(diagnostic.status, "setup_required")
    assert.equal(diagnostic.reason, "no_desk_root")
    assert.equal(diagnostic.binding_path, path.join(fixture.pluginData, "desk.activation.json"))
    assert.deepEqual(
      diagnostic.paths_tried.map((entry) => entry.source),
      ["host-project", "fallback:ms-desk", "fallback:desk", "fallback:worker-workspace"],
    )
    assert.equal(diagnostic.remediation[0].action, "run_first_run_bootstrap")
    assert.match(diagnostic.summary, /no desk/iu)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("main still fails closed on a wrong explicit root", async () => {
  const fixture = makeFixture()
  try {
    await assert.rejects(
      entrypoint.main({
        argv: ["--root", path.join(fixture.root, "missing")],
        env: { HOME: fixture.home },
        homeDir: fixture.home,
        mcpRoot: "/fixture/mcp",
        diagnosticServerStarter: () => assert.fail("explicit misconfiguration must not become setup mode"),
        runtimeImporter: async () => assert.fail("runtime must not load"),
      }),
      /--root path does not exist/u,
    )
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
    assert.ok(none.tried.length >= 4)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
