import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { openSession } from "../launch/_mcp_session.js"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")
const pathsModule = await import(pathToFileURL(path.join(mcpRoot, "src", "util", "paths.js")))
const entrypoint = await import(pathToFileURL(path.join(mcpRoot, "index.js")))
const runtimeDeps = await import(pathToFileURL(path.join(mcpRoot, "src", "runtime", "runtime-deps.js")))
const packageJson = JSON.parse(readFileSync(path.join(mcpRoot, "package.json"), "utf8"))
const packageLock = JSON.parse(readFileSync(path.join(mcpRoot, "package-lock.json"), "utf8"))
const hostPackPaths = runtimeDeps.deriveRuntimeDependencyPackPaths({
  mcpRoot,
  packageJson,
  packageLock,
})
const hostRuntimePackExists = existsSync(hostPackPaths.archivePath)

// A folder with the desk layout: home-folder guesses bind only these.
function makeDesk(dir) {
  mkdirSync(path.join(dir, "_meta"), { recursive: true })
  mkdirSync(path.join(dir, "_archive"), { recursive: true })
}

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "desk-activation-config-"))
  const dirs = {
    root,
    explicitRoot: path.join(root, "explicit-desk"),
    hostSessionRoot: path.join(root, "host-session-desk"),
    activationRoot: path.join(root, "activation-desk"),
    envRoot: path.join(root, "env-desk"),
    home: path.join(root, "home"),
    runtimeCache: path.join(root, "runtime-cache"),
    xdgCache: path.join(root, "xdg-cache"),
  }
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true })
  }
  // A work overlay's desk and a personal desk, both in the home folder.
  makeDesk(path.join(dirs.home, "ms-desk"))
  makeDesk(path.join(dirs.home, "desk"))
  dirs.configPath = path.join(root, "desk.activation-config.json")
  return dirs
}

function writeActivationConfig(filePath, rootPath, extra = {}) {
  writeFileSync(
    filePath,
    JSON.stringify({
      schema_version: 1,
      desk: {
        root: rootPath,
      },
      ...extra,
    }, null, 2),
    "utf8",
  )
}

function requireFunction(module, name) {
  assert.equal(typeof module[name], "function", `${name} must be exported`)
  return module[name]
}

function projectTried(result) {
  return result.tried.map((entry) => [entry.source, entry.path])
}

test("parseArgs captures activation config path without losing root or person", () => {
  assert.deepEqual(
    entrypoint.parseArgs([
      "--activation-config",
      "/tmp/desk.activation-config.json",
      "--host-session-root",
      "/tmp/host-session-desk",
      "--root",
      "/tmp/desk",
      "--person",
      "ari",
    ]),
    {
      activationConfig: "/tmp/desk.activation-config.json",
      hostSessionRoot: "/tmp/host-session-desk",
      person: "ari",
      root: "/tmp/desk",
    },
  )
  assert.deepEqual(
    entrypoint.parseArgs(["--root", "/tmp/desk", "--activation-config"]),
    {
      person: null,
      root: "/tmp/desk",
    },
  )
})

test("resolveDeskRootWithSource applies explicit, host-session, activation, DESK, then home fallback precedence", () => {
  const resolveDeskRootWithSource = requireFunction(pathsModule, "resolveDeskRootWithSource")
  const fixture = makeFixture()
  try {
    writeActivationConfig(fixture.configPath, fixture.activationRoot)
    const common = {
      activationConfigPath: fixture.configPath,
      env: {
        DESK: fixture.envRoot,
        HOME: fixture.home,
      },
      homeDir: fixture.home,
    }

    const explicit = resolveDeskRootWithSource({
      ...common,
      explicitRoot: fixture.explicitRoot,
      hostSessionRoot: fixture.hostSessionRoot,
    })
    assert.equal(explicit.root, fixture.explicitRoot)
    assert.equal(explicit.source, "explicit-root")
    assert.deepEqual(projectTried(explicit), [["explicit-root", fixture.explicitRoot]])

    const hostSession = resolveDeskRootWithSource({
      ...common,
      hostSessionRoot: fixture.hostSessionRoot,
    })
    assert.equal(hostSession.root, fixture.hostSessionRoot)
    assert.equal(hostSession.source, "host-session-root")

    const activation = resolveDeskRootWithSource(common)
    assert.equal(activation.root, fixture.activationRoot)
    assert.equal(activation.source, "activation-config")
    assert.deepEqual(projectTried(activation).map(([source]) => source), [
      "activation-config",
    ])

    const envDesk = resolveDeskRootWithSource({
      env: {
        DESK: fixture.envRoot,
        HOME: fixture.home,
      },
      homeDir: fixture.home,
    })
    assert.equal(envDesk.root, fixture.envRoot)
    assert.equal(envDesk.source, "env:DESK")

    const fallback = resolveDeskRootWithSource({
      env: {
        HOME: fixture.home,
      },
      homeDir: fixture.home,
    })
    assert.equal(fallback.root, path.join(fixture.home, "desk"), "plain Desk skips the work overlay's ~/ms-desk")
    assert.equal(fallback.source, "home_fallback")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("activation config loader validates schema and redacts malformed JSON content", () => {
  const loadActivationConfig = requireFunction(pathsModule, "loadActivationConfig")
  const fixture = makeFixture()
  try {
    assert.equal(loadActivationConfig(), null)

    const missingConfigPath = path.join(fixture.root, "missing.activation-config.json")
    assert.throws(
      () => loadActivationConfig({ configPath: missingConfigPath }),
      (err) => {
        assert.match(err.message, /activation config .* could not be read/u)
        assert.doesNotMatch(err.message, /must be valid JSON/u)
        return true
      },
    )

    const invalidJsonPath = path.join(fixture.root, "invalid.activation-config.json")
    writeFileSync(invalidJsonPath, '{"desk":{"root":"SECRET-DESK-PATH"', "utf8")
    assert.throws(
      () => loadActivationConfig({ configPath: invalidJsonPath }),
      (err) => {
        assert.match(err.message, /activation config .* must be valid JSON/u)
        assert.match(err.message, new RegExp(escapeRegExp(invalidJsonPath), "u"))
        assert.doesNotMatch(err.message, /SECRET-DESK-PATH/u)
        return true
      },
    )

    const badSchemaPath = path.join(fixture.root, "bad-schema.activation-config.json")
    writeFileSync(badSchemaPath, JSON.stringify({
      schema_version: 2,
      desk: {
        root: fixture.activationRoot,
      },
    }), "utf8")
    assert.throws(
      () => loadActivationConfig({ configPath: badSchemaPath }),
      /activation config schema_version must be 1/u,
    )

    const missingRootPath = path.join(fixture.root, "missing-root.activation-config.json")
    writeFileSync(missingRootPath, JSON.stringify({ schema_version: 1, desk: {} }), "utf8")
    assert.throws(
      () => loadActivationConfig({ configPath: missingRootPath }),
      /activation config desk\.root must be a non-empty string/u,
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("activation config roots support tilde and relative paths with injectable cwd", () => {
  const resolveDeskRootWithSource = requireFunction(pathsModule, "resolveDeskRootWithSource")
  const fixture = makeFixture()
  try {
    const tildeRoot = path.join(fixture.home, "tilde-desk")
    mkdirSync(tildeRoot, { recursive: true })
    writeActivationConfig(path.join(fixture.home, "tilde.activation-config.json"), "~/tilde-desk")
    const tilde = resolveDeskRootWithSource({
      activationConfigPath: "~/tilde.activation-config.json",
      env: {},
      homeDir: fixture.home,
    })
    assert.equal(tilde.root, tildeRoot)
    assert.equal(tilde.source, "activation-config")

    const relativeRoot = path.join(fixture.root, "relative-desk")
    mkdirSync(relativeRoot, { recursive: true })
    writeActivationConfig(path.join(fixture.root, "relative.activation-config.json"), "relative-desk")
    const relative = resolveDeskRootWithSource({
      activationConfigPath: "relative.activation-config.json",
      cwd: fixture.root,
      env: {},
      homeDir: fixture.home,
    })
    assert.equal(relative.root, relativeRoot)
    assert.equal(relative.source, "activation-config")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("root resolver reports nonexistent explicit and host-session roots", () => {
  const resolveDeskRootWithSource = requireFunction(pathsModule, "resolveDeskRootWithSource")
  const fixture = makeFixture()
  try {
    const missingExplicit = path.join(fixture.root, "missing-explicit")
    assert.throws(
      () => resolveDeskRootWithSource({
        explicitRoot: missingExplicit,
        homeDir: fixture.home,
      }),
      new RegExp(`--root path does not exist: ${escapeRegExp(missingExplicit)}`, "u"),
    )

    const missingHostSession = path.join(fixture.root, "missing-host-session")
    assert.throws(
      () => resolveDeskRootWithSource({
        hostSessionRoot: missingHostSession,
        homeDir: fixture.home,
      }),
      new RegExp(`host/session root path does not exist: ${escapeRegExp(missingHostSession)}`, "u"),
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a saved binding to a missing folder is root_unavailable and never falls back to $DESK or a home folder", () => {
  const resolveDeskRootWithSource = requireFunction(pathsModule, "resolveDeskRootWithSource")
  const fixture = makeFixture()
  try {
    const missingActivation = path.join(fixture.root, "missing-activation")
    writeActivationConfig(fixture.configPath, missingActivation)
    for (const env of [{ DESK: fixture.envRoot }, {}]) {
      assert.throws(
        () => resolveDeskRootWithSource({
          activationConfigPath: fixture.configPath,
          env,
          homeDir: fixture.home,
        }),
        (err) => {
          assert.equal(err.code, pathsModule.DESK_ROOT_UNAVAILABLE)
          assert.equal(err.path, missingActivation)
          assert.equal(err.source, "activation-config")
          assert.equal(err.problem, "does not exist")
          assert.equal(err.activation_config, fixture.configPath)
          assert.match(err.message, new RegExp(`${escapeRegExp(fixture.configPath)} names ${escapeRegExp(missingActivation)}, which does not exist`, "u"))
          assert.match(err.message, /does not fall back to another desk/u)
          assert.deepEqual(err.tried.map((entry) => entry.source), ["activation-config"], "nothing after the binding is consulted")
          return true
        },
      )
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("an explicit binding whose folder is not a folder or cannot be read is root_unavailable", () => {
  const resolveDeskRootWithSource = requireFunction(pathsModule, "resolveDeskRootWithSource")
  const fixture = makeFixture()
  try {
    const file = path.join(fixture.root, "a-file")
    writeFileSync(file, "not a desk\n", "utf8")
    for (const options of [
      { explicitRoot: file },
      { hostSessionRoot: file },
      { activationConfigPath: fixture.configPath },
    ]) {
      writeActivationConfig(fixture.configPath, file)
      assert.throws(
        () => resolveDeskRootWithSource({ ...options, env: { DESK: fixture.envRoot }, homeDir: fixture.home }),
        (err) => {
          assert.equal(err.code, pathsModule.DESK_ROOT_UNAVAILABLE)
          assert.equal(err.problem, "is not a folder")
          assert.equal(err.path, file)
          return true
        },
      )
    }
    // A path under a file does not exist either.
    assert.throws(
      () => resolveDeskRootWithSource({ explicitRoot: path.join(file, "desk"), homeDir: fixture.home }),
      (err) => err.code === pathsModule.DESK_ROOT_UNAVAILABLE && err.problem === "does not exist",
    )
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      // A folder Desk cannot list, and a folder inside a parent Desk cannot search.
      const locked = path.join(fixture.root, "locked-desk")
      mkdirSync(path.join(locked, "inner"), { recursive: true })
      chmodSync(locked, 0o000)
      try {
        for (const root of [locked, path.join(locked, "inner")]) {
          writeActivationConfig(fixture.configPath, root)
          assert.throws(
            () => resolveDeskRootWithSource({ activationConfigPath: fixture.configPath, env: {}, homeDir: fixture.home }),
            (err) => err.code === pathsModule.DESK_ROOT_UNAVAILABLE && err.problem === "cannot be read" && err.path === root,
          )
        }
      } finally {
        chmodSync(locked, 0o700)
      }
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("with no binding at all, a work overlay's ~/ms-desk is never bound by plain Desk", () => {
  const resolveDeskRootWithSource = requireFunction(pathsModule, "resolveDeskRootWithSource")
  const fixture = makeFixture()
  try {
    rmSync(path.join(fixture.home, "desk"), { recursive: true, force: true })
    assert.throws(
      () => resolveDeskRootWithSource({ env: {}, homeDir: fixture.home }),
      (err) => {
        assert.equal(err.code, pathsModule.DESK_ROOT_NOT_FOUND)
        assert.deepEqual(err.tried.map((entry) => entry.path), [
          path.join(fixture.home, "desk"),
          path.join(fixture.home, "worker-workspace"),
        ])
        assert.doesNotMatch(err.message, /ms-desk/u)
        return true
      },
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

// An Agency session container holding Desk and the plugins selected with it.
function agencySession(fixture, plugins) {
  const container = path.join(fixture.root, "sessions", "agency-plugin-Ab3_x-9.p4242")
  for (const [folder, name] of Object.entries(plugins)) {
    mkdirSync(path.join(container, folder), { recursive: true })
    if (name !== null) writeFileSync(path.join(container, folder, "plugin.json"), JSON.stringify({ name }), "utf8")
  }
  return path.join(container, "desk")
}

test("an Agency session that loads the ms-desk overlay still binds ~/ms-desk, instead of the personal fallbacks", () => {
  const resolveDeskRootWithSource = requireFunction(pathsModule, "resolveDeskRootWithSource")
  const fixture = makeFixture()
  try {
    const deskPluginRoot = agencySession(fixture, { desk: "desk", "ms-desk": "ms-desk", superpowers: "superpowers" })
    const bound = resolveDeskRootWithSource({ deskPluginRoot, env: {}, homeDir: fixture.home })
    assert.equal(bound.root, path.join(fixture.home, "ms-desk"))
    assert.equal(bound.source, "overlay_home_fallback")
    assert.deepEqual(bound.tried, [{ source: "overlay_home_fallback", overlay: "ms-desk", path: path.join(fixture.home, "ms-desk") }])
    assert.deepEqual(pathsModule.loadedOverlayHomeDesks({ deskPluginRoot, homeDir: fixture.home }).map((entry) => entry.overlay), ["ms-desk"])

    // Any binding still wins over the overlay's home folder.
    writeActivationConfig(fixture.configPath, fixture.activationRoot)
    assert.equal(resolveDeskRootWithSource({ activationConfigPath: fixture.configPath, deskPluginRoot, env: {}, homeDir: fixture.home }).source, "activation-config")
    assert.equal(resolveDeskRootWithSource({ deskPluginRoot, env: { DESK: fixture.envRoot }, homeDir: fixture.home }).source, "env:DESK")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("the ms-desk overlay counts as loaded only as a declared sibling in an Agency session container", () => {
  const fixture = makeFixture()
  try {
    const cases = {
      "no ms-desk sibling": agencySession(fixture, { desk: "desk" }),
      "a sibling folder that declares another name": (() => {
        const root = path.join(fixture.root, "other", "agency-plugin-Qq.p7")
        mkdirSync(path.join(root, "ms-desk"), { recursive: true })
        writeFileSync(path.join(root, "ms-desk", "plugin.json"), JSON.stringify({ name: "impostor" }), "utf8")
        return path.join(root, "desk")
      })(),
      "a sibling with no readable manifest": (() => {
        const root = path.join(fixture.root, "bare", "agency-plugin-Rr.p8")
        mkdirSync(path.join(root, "ms-desk"), { recursive: true })
        return path.join(root, "desk")
      })(),
      "a plain install folder, not an Agency container": (() => {
        const root = path.join(fixture.root, "installed-plugins", "ourostack")
        mkdirSync(path.join(root, "ms-desk"), { recursive: true })
        writeFileSync(path.join(root, "ms-desk", "plugin.json"), JSON.stringify({ name: "ms-desk" }), "utf8")
        return path.join(root, "desk")
      })(),
      "no plugin root": "",
    }
    for (const [label, deskPluginRoot] of Object.entries(cases)) {
      assert.deepEqual(pathsModule.loadedOverlayHomeDesks({ deskPluginRoot, homeDir: fixture.home }), [], label)
      const bound = pathsModule.resolveDeskRootWithSource({ deskPluginRoot, env: {}, homeDir: fixture.home })
      assert.equal(bound.root, path.join(fixture.home, "desk"), label)
      assert.equal(bound.source, "home_fallback", label)
    }
    // This checkout is not an Agency session, so the default plugin root loads no overlay.
    assert.deepEqual(pathsModule.loadedOverlayHomeDesks({ homeDir: fixture.home }), [])
    assert.deepEqual(pathsModule.loadedOverlayHomeDesks(), [])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("root resolver final diagnostic lists every fallback source attempted in order", () => {
  const resolveDeskRootWithSource = requireFunction(pathsModule, "resolveDeskRootWithSource")
  const root = mkdtempSync(path.join(tmpdir(), "desk-root-diagnostic-"))
  try {
    const emptyHome = path.join(root, "empty-home")
    mkdirSync(emptyHome, { recursive: true })
    assert.throws(
      () => resolveDeskRootWithSource({ env: {}, homeDir: emptyHome }),
      (err) => {
        assert.equal(err.code, pathsModule.DESK_ROOT_NOT_FOUND)
        assert.match(err.message, /no desk workspace found/u)
        assert.doesNotMatch(err.message, /ms-desk/u)
        const expected = [
          path.join(emptyHome, "desk"),
          path.join(emptyHome, "worker-workspace"),
        ]
        let cursor = -1
        for (const item of expected) {
          const next = err.message.indexOf(item)
          assert.notEqual(next, -1, `${item} must appear in diagnostic`)
          assert.ok(next > cursor, `${item} must appear after the previous attempted source`)
          cursor = next
        }
        return true
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a set $DESK is explicit: a missing, non-folder or unreadable $DESK is root_unavailable and never falls back to ~/desk", () => {
  const resolveDeskRootWithSource = requireFunction(pathsModule, "resolveDeskRootWithSource")
  const fixture = makeFixture()
  try {
    const missing = path.join(fixture.root, "missing-env-desk")
    const file = path.join(fixture.root, "env-file")
    writeFileSync(file, "not a desk\n", "utf8")
    const cases = [[missing, "does not exist"], [file, "is not a folder"]]
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = path.join(fixture.root, "locked-env-desk")
      mkdirSync(locked)
      chmodSync(locked, 0o000)
      cases.push([locked, "cannot be read"])
    }
    try {
      for (const [desk, problem] of cases) {
        assert.throws(
          () => resolveDeskRootWithSource({ env: { DESK: desk }, homeDir: fixture.home }),
          (err) => {
            assert.equal(err.code, pathsModule.DESK_ROOT_UNAVAILABLE)
            assert.equal(err.source, "env:DESK")
            assert.equal(err.path, desk)
            assert.equal(err.problem, problem)
            assert.match(err.message, /does not fall back to another desk/u)
            assert.deepEqual(err.tried.map((entry) => entry.source), ["env:DESK"], "no home folder is consulted")
            return true
          },
        )
      }
    } finally {
      if (cases.length === 3) chmodSync(cases[2][0], 0o700)
    }
    // An existing $DESK keeps today's acceptance even without the desk layout.
    assert.equal(resolveDeskRootWithSource({ env: { DESK: fixture.envRoot }, homeDir: fixture.home }).source, "env:DESK")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a home-folder guess binds only a folder with the desk layout; an empty ~/desk leaves Desk in setup mode", () => {
  const resolveDeskRootWithSource = requireFunction(pathsModule, "resolveDeskRootWithSource")
  const fixture = makeFixture()
  try {
    const home = path.join(fixture.root, "fresh-home")
    // Plain Desk: an empty ~/desk and a ~/worker-workspace with only _meta.
    mkdirSync(path.join(home, "desk"), { recursive: true })
    mkdirSync(path.join(home, "worker-workspace", "_meta"), { recursive: true })
    assert.throws(
      () => resolveDeskRootWithSource({ env: {}, homeDir: home }),
      (err) => {
        assert.equal(err.code, pathsModule.DESK_ROOT_NOT_FOUND)
        assert.deepEqual(err.tried.map((entry) => entry.source), ["home_fallback", "home_fallback"])
        return true
      },
    )
    // Once a guess has the layout (a crew-shaped desks/ counts too), it binds.
    mkdirSync(path.join(home, "worker-workspace", "desks"), { recursive: true })
    assert.equal(resolveDeskRootWithSource({ env: {}, homeDir: home }).root, path.join(home, "worker-workspace"))
    makeDesk(path.join(home, "desk"))
    assert.equal(resolveDeskRootWithSource({ env: {}, homeDir: home }).root, path.join(home, "desk"))
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("a session that loads the ms-desk overlay tries only ~/ms-desk: a missing or non-desk ~/ms-desk is setup mode, never the personal ~/desk", () => {
  const resolveDeskRootWithSource = requireFunction(pathsModule, "resolveDeskRootWithSource")
  const fixture = makeFixture()
  try {
    const home = path.join(fixture.root, "work-home")
    // Real personal desks are present; the overlay's own desk is missing, then empty.
    makeDesk(path.join(home, "desk"))
    makeDesk(path.join(home, "worker-workspace"))
    const deskPluginRoot = agencySession(fixture, { desk: "desk", "ms-desk": "ms-desk" })
    const setupOnly = (label) => assert.throws(
      () => resolveDeskRootWithSource({ deskPluginRoot, env: {}, homeDir: home }),
      (err) => {
        assert.equal(err.code, pathsModule.DESK_ROOT_NOT_FOUND, label)
        assert.deepEqual(err.tried, [{ source: "overlay_home_fallback", overlay: "ms-desk", path: path.join(home, "ms-desk") }], label)
        assert.doesNotMatch(err.message, new RegExp(`${escapeRegExp(path.join(home, "desk"))}$`, "mu"), label)
        return true
      },
    )
    setupOnly("missing ~/ms-desk")
    mkdirSync(path.join(home, "ms-desk"), { recursive: true })
    setupOnly("empty ~/ms-desk")
    makeDesk(path.join(home, "ms-desk"))
    const bound = resolveDeskRootWithSource({ deskPluginRoot, env: {}, homeDir: home })
    assert.equal(bound.root, path.join(home, "ms-desk"))
    assert.equal(bound.source, "overlay_home_fallback")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("legacy resolveDeskRoot delegates to the same root resolver with injectable env and home", () => {
  const resolveDeskRootWithSource = requireFunction(pathsModule, "resolveDeskRootWithSource")
  const fixture = makeFixture()
  try {
    const options = {
      env: {
        DESK: fixture.envRoot,
        HOME: fixture.home,
      },
      homeDir: fixture.home,
    }
    assert.equal(pathsModule.resolveDeskRoot(undefined, options), fixture.envRoot)
    assert.equal(
      pathsModule.resolveDeskRoot(undefined, options),
      resolveDeskRootWithSource(options).root,
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("entrypoint startup root resolution uses parsed activation config and canonical path resolver", () => {
  const resolveStartupDeskRoot = requireFunction(entrypoint, "resolveStartupDeskRoot")
  const resolveStartupActivationConfigPath = requireFunction(entrypoint, "resolveStartupActivationConfigPath")
  const fixture = makeFixture()
  try {
    writeActivationConfig(fixture.configPath, fixture.activationRoot)
    const args = entrypoint.parseArgs(["--activation-config", fixture.configPath])
    assert.equal(resolveStartupActivationConfigPath({ args, env: {} }), fixture.configPath)
    const result = resolveStartupDeskRoot({
      args,
      env: {
        DESK: fixture.envRoot,
        HOME: fixture.home,
      },
      homeDir: fixture.home,
    })
    assert.equal(result.root, fixture.activationRoot)
    assert.equal(result.source, "activation-config")

    const codexHome = path.join(fixture.root, "codex-home")
    const codexConfigPath = path.join(codexHome, "desk.activation.json")
    mkdirSync(codexHome, { recursive: true })
    writeActivationConfig(codexConfigPath, fixture.activationRoot)
    assert.equal(
      resolveStartupActivationConfigPath({
        args: {},
        env: {
          CODEX_HOME: codexHome,
        },
      }),
      codexConfigPath,
    )
    assert.equal(
      resolveStartupDeskRoot({
        args: {},
        env: {
          CODEX_HOME: codexHome,
          DESK: fixture.envRoot,
        },
        homeDir: fixture.home,
      }).source,
      "activation-config",
    )

    const overrideConfigPath = path.join(fixture.root, "override.activation.json")
    writeActivationConfig(overrideConfigPath, fixture.envRoot)
    assert.equal(
      resolveStartupActivationConfigPath({
        args: {},
        env: {
          CODEX_HOME: codexHome,
          DESK_ACTIVATION_CONFIG: overrideConfigPath,
        },
      }),
      overrideConfigPath,
    )
    assert.equal(
      resolveStartupActivationConfigPath({
        args: {},
        env: {
          CODEX_HOME: path.join(fixture.root, "missing-codex-home"),
        },
      }),
      null,
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("entrypoint startup runtime cache resolution uses activation config only", () => {
  const resolveStartupRuntimeCacheDir = requireFunction(entrypoint, "resolveStartupRuntimeCacheDir")
  const fixture = makeFixture()
  try {
    assert.equal(resolveStartupRuntimeCacheDir({ args: {}, cwd: fixture.root, homeDir: fixture.home }), null)

    writeActivationConfig(fixture.configPath, fixture.activationRoot, {
      runtimeCacheDir: "   ",
    })
    assert.equal(
      resolveStartupRuntimeCacheDir({
        args: entrypoint.parseArgs(["--activation-config", fixture.configPath]),
        cwd: fixture.root,
        homeDir: fixture.home,
      }),
      null,
    )

    writeActivationConfig(fixture.configPath, fixture.activationRoot, {
      runtimeCacheDir: fixture.runtimeCache,
    })
    assert.equal(
      resolveStartupRuntimeCacheDir({
        args: entrypoint.parseArgs(["--activation-config", fixture.configPath]),
        cwd: path.join(fixture.root, "ignored-cwd"),
        homeDir: fixture.home,
      }),
      fixture.runtimeCache,
    )

    writeActivationConfig(fixture.configPath, fixture.activationRoot, {
      runtimeCacheDir: "relative-runtime-cache",
    })
    assert.equal(
      resolveStartupRuntimeCacheDir({
        args: entrypoint.parseArgs(["--activation-config", fixture.configPath]),
        cwd: fixture.root,
        homeDir: fixture.home,
      }),
      path.join(fixture.root, "relative-runtime-cache"),
    )

    writeActivationConfig(fixture.configPath, fixture.activationRoot, {
      runtimeCacheDir: "~/tilde-runtime-cache",
    })
    assert.equal(
      resolveStartupRuntimeCacheDir({
        args: entrypoint.parseArgs(["--activation-config", fixture.configPath]),
        cwd: fixture.root,
        homeDir: fixture.home,
      }),
      path.join(fixture.home, "tilde-runtime-cache"),
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("entrypoint startup activation context normalizes activation config metadata", () => {
  const resolveStartupActivationContext = requireFunction(entrypoint, "resolveStartupActivationContext")
  const fixture = makeFixture()
  try {
    assert.equal(resolveStartupActivationContext({ args: {}, cwd: fixture.root, homeDir: fixture.home }), null)

    writeActivationConfig(fixture.configPath, fixture.activationRoot, {
      activation: null,
    })
    assert.equal(
      resolveStartupActivationContext({
        args: entrypoint.parseArgs(["--activation-config", fixture.configPath]),
        cwd: fixture.root,
        homeDir: fixture.home,
      }),
      null,
    )

    writeActivationConfig(fixture.configPath, fixture.activationRoot, {
      activation: "bad",
    })
    assert.equal(
      resolveStartupActivationContext({
        args: entrypoint.parseArgs(["--activation-config", fixture.configPath]),
        cwd: fixture.root,
        homeDir: fixture.home,
      }),
      null,
    )

    writeActivationConfig(fixture.configPath, fixture.activationRoot, {
      activation: {
        selected_id: "ms-area:worker",
        chain: ["desk:worker", "ms-desk:worker", "ms-area:worker"],
        mode: "global-personal",
        source: "caller",
      },
    })
    assert.deepEqual(
      resolveStartupActivationContext({
        args: entrypoint.parseArgs(["--activation-config", fixture.configPath]),
        cwd: fixture.root,
        homeDir: fixture.home,
      }),
      {
        selected_id: "ms-area:worker",
        chain: ["desk:worker", "ms-desk:worker", "ms-area:worker"],
        mode: "global-personal",
        source: "activation-config",
      },
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("entrypoint startup root resolution lets host/session root override activation config", () => {
  const resolveStartupDeskRoot = requireFunction(entrypoint, "resolveStartupDeskRoot")
  const fixture = makeFixture()
  try {
    writeActivationConfig(fixture.configPath, fixture.activationRoot)
    const args = entrypoint.parseArgs([
      "--host-session-root",
      fixture.hostSessionRoot,
      "--activation-config",
      fixture.configPath,
    ])
    const result = resolveStartupDeskRoot({
      args,
      env: {
        DESK: fixture.envRoot,
        HOME: fixture.home,
      },
      homeDir: fixture.home,
    })
    assert.equal(result.root, fixture.hostSessionRoot)
    assert.equal(result.source, "host-session-root")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("entrypoint main resolves startup root before launching injected runtime server", async () => {
  const { admitInProcess } = await import("./_in_process_desk.js")
  const fixture = makeFixture()
  try {
    writeActivationConfig(fixture.configPath, fixture.activationRoot, {
      runtimeCacheDir: fixture.runtimeCache,
      desk_runtime: { write_authority: "person" },
    })
    const calls = []
    const started = await admitInProcess({
      argv: [
        "--host-session-root",
        fixture.hostSessionRoot,
        "--activation-config",
        fixture.configPath,
        "--person",
        "ari",
      ],
      env: {
        DESK: fixture.envRoot,
        HOME: fixture.home,
      },
      homeDir: fixture.home,
      mcpRoot: "/fixture/mcp",
      cwd: fixture.root,
      runtimeImporter: async ({ mcpRoot, runtimeCacheDir }) => {
        calls.push(["runtimeImporter", mcpRoot, runtimeCacheDir])
        return {
          connectOrStartController: async () => ({
            accepted: true,
            id: "controller-1",
            beginConvergence() {},
          }),
        }
      },
    })
    assert.deepEqual(calls, [["runtimeImporter", "/fixture/mcp", fixture.runtimeCache]])
    assert.equal(started.snapshot.state, "ready")
    assert.equal(started.statusContext.root.root, fixture.hostSessionRoot)
    assert.equal(started.person, "ari")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("entrypoint guard handles direct launch, import, realpath fallback, and fatal launch errors", async () => {
  const isEntrypoint = requireFunction(entrypoint, "isEntrypoint")
  const runIfEntrypoint = requireFunction(entrypoint, "runIfEntrypoint")
  const modulePath = path.join(repoRoot, "plugins", "desk", "mcp", "index.js")
  const moduleUrl = pathToFileURL(modulePath).href

  assert.equal(isEntrypoint({ argv: ["node"], moduleUrl }), false)
  assert.equal(isEntrypoint({
    argv: ["node", "/same/path"],
    moduleUrl,
    realpath: () => "/same/path",
  }), true)
  assert.equal(isEntrypoint({
    argv: ["node", modulePath],
    moduleUrl,
    realpath: () => {
      throw new Error("realpath unavailable")
    },
  }), true)

  assert.equal(runIfEntrypoint({ argv: ["node"], moduleUrl }), null)

  let launched = false
  await runIfEntrypoint({
    argv: ["node", modulePath],
    moduleUrl,
    launch: async () => {
      launched = true
    },
  })
  assert.equal(launched, true)

  let syncLaunches = 0
  await runIfEntrypoint({
    argv: ["node", modulePath],
    moduleUrl,
    launch: () => {
      syncLaunches += 1
      return "started"
    },
  })
  assert.equal(syncLaunches, 1)

  // A launch failure no longer exits: the entrypoint serves diagnostic mode so the handshake still completes.
  const writes = []
  const exits = []
  const diagnosticStarts = []
  await runIfEntrypoint({
    argv: ["node", modulePath],
    moduleUrl,
    launch: async () => {
      throw new Error("bad launch")
    },
    stderr: { write: (text) => writes.push(text) },
    exit: (code) => exits.push(code),
    startDiagnostic: ({ error }) => diagnosticStarts.push(error.message),
  })
  assert.match(writes.join(""), /\[desk-mcp\] startup exception: bad launch; serving diagnostic mode/u)

  await runIfEntrypoint({
    argv: ["node", modulePath],
    moduleUrl,
    launch: () => {
      throw new Error("bad sync launch")
    },
    stderr: { write: (text) => writes.push(text) },
    exit: (code) => exits.push(code),
    startDiagnostic: ({ error }) => diagnosticStarts.push(error.message),
  })
  assert.match(writes.join(""), /\[desk-mcp\] startup exception: bad sync launch; serving diagnostic mode/u)
  assert.deepEqual(diagnosticStarts, ["bad launch", "bad sync launch"])
  assert.deepEqual(exits, [])
})

test("entrypoint stdio startup uses activation config root for real MCP tool calls", {
  skip: hostRuntimePackExists ? false : `no committed runtime dependency pack for ${process.platform}-${process.arch}-node-${process.versions.modules}`,
}, async () => {
  const fixture = makeFixture()
  try {
    writeActivationConfig(fixture.configPath, fixture.activationRoot)
    const result = await runTaskCreateThroughEntrypoint(fixture)
    assert.equal(result.initialize.error, undefined, result.stderr || result.stdout)
    assert.equal(result.created.error, undefined, result.stderr || result.stdout)
    assert.equal(
      existsSync(path.join(fixture.activationRoot, "activation-check", "from-server", "task.md")),
      true,
      "real MCP startup must write through the activation-config root",
    )
    assert.equal(
      existsSync(path.join(fixture.envRoot, "activation-check", "from-server", "task.md")),
      false,
      "conflicting DESK root must not receive writes when activation config is present",
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5 })
  }
})

test("entrypoint stdio startup lets host/session root override activation config root", {
  skip: hostRuntimePackExists ? false : `no committed runtime dependency pack for ${process.platform}-${process.arch}-node-${process.versions.modules}`,
}, async () => {
  const fixture = makeFixture()
  try {
    writeActivationConfig(fixture.configPath, fixture.activationRoot)
    const result = await runTaskCreateThroughEntrypoint(fixture, {
      args: [
        "--host-session-root",
        fixture.hostSessionRoot,
        "--activation-config",
        fixture.configPath,
      ],
      track: "host-session-check",
    })
    assert.equal(result.initialize.error, undefined, result.stderr || result.stdout)
    assert.equal(result.created.error, undefined, result.stderr || result.stdout)
    assert.equal(
      existsSync(path.join(fixture.hostSessionRoot, "host-session-check", "from-server", "task.md")),
      true,
      "real MCP startup must write through the host/session root when provided",
    )
    assert.equal(
      existsSync(path.join(fixture.activationRoot, "host-session-check", "from-server", "task.md")),
      false,
      "activation config root must not receive writes when host/session root is present",
    )
    assert.equal(
      existsSync(path.join(fixture.envRoot, "host-session-check", "from-server", "task.md")),
      false,
      "conflicting DESK root must not receive writes when host/session root is present",
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5 })
  }
})

test("entrypoint stdio startup uses relative activation runtime cache and reuses it on repeated startup", {
  skip: hostRuntimePackExists ? false : `no committed runtime dependency pack for ${process.platform}-${process.arch}-node-${process.versions.modules}`,
}, async () => {
  const fixture = makeFixture()
  try {
    const activationCacheRelative = "activation-runtime-cache"
    const activationCache = path.join(fixture.root, activationCacheRelative)
    const envCache = path.join(fixture.root, "env-cache-should-not-win")
    mkdirSync(envCache, { recursive: true })
    writeActivationConfig(fixture.configPath, fixture.activationRoot, {
      runtimeCacheDir: activationCacheRelative,
    })

    const first = await runTaskCreateThroughEntrypoint(fixture, {
      envOverrides: { DESK_RUNTIME_CACHE_DIR: envCache },
      track: "relative-cache-first",
    })
    assert.equal(first.initialize.error, undefined, first.stderr || first.stdout)
    assert.equal(first.created.error, undefined, first.stderr || first.stdout)

    const second = await runTaskCreateThroughEntrypoint(fixture, {
      envOverrides: { DESK_RUNTIME_CACHE_DIR: envCache },
      track: "relative-cache-second",
    })
    assert.equal(second.initialize.error, undefined, second.stderr || second.stdout)
    assert.equal(second.created.error, undefined, second.stderr || second.stdout)
    assert.doesNotMatch(
      second.stderr,
      /illegal readiness transition: LEXICAL_READY -> LEXICAL_CONVERGING/u,
      "reused compatible consumers must not request backward lexical convergence",
    )

    assert.equal(hasRuntimeDeps(activationCache), true, "relative activation runtimeCacheDir should receive runtime dependencies")
    assert.equal(hasRuntimeDeps(envCache), false, "DESK_RUNTIME_CACHE_DIR must not receive runtime dependencies when activation config supplies runtimeCacheDir")
    assert.equal(sourceMirrorCount(activationCache), 1, "repeated startup should reuse the same source mirror for unchanged MCP source")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5 })
  }
})

async function runTaskCreateThroughEntrypoint(fixture, {
  args = ["--activation-config", fixture.configPath],
  envOverrides = {},
  track = "activation-check",
} = {}) {
  const session = await openSession({ command: process.execPath, args: [
    path.join(mcpRoot, "index.js"),
    ...args,
  ],
    cwd: fixture.root,
    env: {
      ...process.env,
      DESK: fixture.envRoot,
      DESK_RUNTIME_CACHE_DIR: fixture.runtimeCache,
      HOME: fixture.home,
      XDG_CACHE_HOME: fixture.xdgCache,
      ...envOverrides,
    },
  })
  try {
    const status = await session.statusUntil((payload) => payload.state !== "admitting", { deadlineMs: 60000 })
    assert.equal(status.state, "ready", JSON.stringify(status))
    const created = await session.request("tools/call", {
      name: "task_create",
      arguments: { track, slug: "from-server", title: "From server" },
    })
    assert.notEqual(created.result?.isError, true, JSON.stringify(created))
    return {
      initialize: session.initialize,
      created,
      stderr: session.stderr(),
      stdout: JSON.stringify(created),
    }
  } finally {
    await session.close()
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

function hasRuntimeDeps(cacheDir) {
  return existsSync(path.join(cacheDir, "node_modules"))
    && existsSync(path.join(cacheDir, "package.json"))
    && existsSync(path.join(cacheDir, "package-lock.json"))
}

function sourceMirrorCount(cacheDir) {
  const mirrorRoot = path.join(cacheDir, "source-mirror")
  if (!existsSync(mirrorRoot)) {
    return 0
  }
  return readdirSync(mirrorRoot)
    .map((entry) => path.join(mirrorRoot, entry))
    .filter((entry) => statSync(entry).isDirectory())
    .length
}
