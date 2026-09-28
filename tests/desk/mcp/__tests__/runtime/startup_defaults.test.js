import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  isEntrypoint,
  main,
  resolveMcpServerVersion,
  resolveStartupActivationConfigPath,
  resolveStartupActivationContext,
  resolveStartupDeskRoot,
  resolveStartupReadinessPolicy,
  resolveStartupRuntimeCacheDir,
} from "../../index.js"
import { createRuntimeDiagnostic, createSetupDiagnostic } from "../../src/runtime/diagnostics.js"
import { claudeBindingPath, resolveActivationConfigPath } from "../../src/util/paths.js"

const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
const hostEnvKeys = ["DESK", "DESK_ACTIVATION_CONFIG", "CODEX_HOME", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR"]

// The startup helpers default to the live process environment. Pin the host
// variables they read so these defaults are exercised deterministically.
function withHostEnv(values, run) {
  const saved = Object.fromEntries(hostEnvKeys.map((key) => [key, process.env[key]]))
  for (const key of hostEnvKeys) delete process.env[key]
  Object.assign(process.env, values)
  try {
    return run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// Child processes inherit the runner's environment (including any coverage
// hook in NODE_OPTIONS) without the host variables these tests control.
function childEnv(values) {
  const env = { ...process.env, ...values }
  for (const key of hostEnvKeys) if (!(key in values)) delete env[key]
  return env
}

test("startup helpers default to the live process environment", () => {
  const desk = mkdtempSync(path.join(tmpdir(), "desk-startup-defaults-"))
  try {
    withHostEnv({ DESK: desk }, () => {
      assert.equal(resolveStartupDeskRoot().root, desk)
      assert.equal(resolveStartupActivationConfigPath(), null)
      assert.equal(resolveStartupRuntimeCacheDir(), null)
      assert.equal(resolveStartupActivationContext(), null)
      assert.equal(resolveStartupReadinessPolicy().lexical, "required")
      assert.equal(resolveActivationConfigPath(), null)
      assert.equal(claudeBindingPath(), null)
    })
  } finally {
    rmSync(desk, { recursive: true, force: true })
  }
})

test("server version and entrypoint checks use their real defaults", () => {
  assert.match(resolveMcpServerVersion({ mcpRoot }), /^\d+\.\d+\.\d+/u)
  assert.equal(typeof resolveMcpServerVersion(), "string")
  assert.equal(typeof isEntrypoint(), "boolean")
})

test("diagnostics fill in defaults when called without details", () => {
  const setup = createSetupDiagnostic()
  assert.deepEqual(setup.paths_tried, [])
  assert.equal(setup.binding_path, null)
  assert.match(setup.remediation[1].message, /exporting DESK=<path>/u)

  assert.equal(createRuntimeDiagnostic().mode, "diagnostic")
  const restore = createRuntimeDiagnostic({ reason: "runtime_restore_failed" })
  assert.match(restore.remediation[0].message, /Desk's runtime cache/u)
})

test("resolve-desk-root reports configuration errors and prints nothing for --root-only without a desk", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "desk-resolve-root-"))
  try {
    const script = path.join(mcpRoot, "scripts", "resolve-desk-root.js")
    const home = path.join(scratch, "home")
    mkdirSync(home)
    const malformed = path.join(scratch, "bad.json")
    writeFileSync(malformed, "{")
    const env = childEnv({ HOME: home })
    const broken = JSON.parse(execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...env, DESK_ACTIVATION_CONFIG: malformed },
    }))
    assert.equal(broken.root, null)
    assert.deepEqual(broken.tried, [])
    assert.match(broken.error, /must be valid JSON/u)
    assert.equal(execFileSync(process.execPath, [script, "--root-only"], { encoding: "utf8", env }), "")
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

function semanticRuntime({ beginConvergence, barrier, beginBackgroundConvergence } = {}) {
  return async () => ({
    async admitControlPlane({ deskRoot }) {
      return {
        state: "CONTROL_READY",
        root: deskRoot,
        authority: { mode: "workspace" },
        runtime: { state: "ready" },
        controller: { accepted: true, id: "controller-1", beginConvergence, barrier },
        automatic_actions: [],
      }
    },
    beginBackgroundConvergence,
  })
}

async function startWith(root, readinessPolicy, runtimeImporter) {
  const { admitInProcess } = await import("./_in_process_desk.js")
  return admitInProcess({ argv: ["--root", root], env: {}, cwd: root, homeDir: root, readinessPolicy, runtimeImporter })
}

test("required semantic convergence reports non-Error failures and a missing barrier", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-semantic-required-"))
  const required = { semantic: "required" }
  try {
    for (const thrown of [null, "offline"]) {
      const { snapshot } = await startWith(root, required, semanticRuntime({
        async beginConvergence() {
          throw thrown
        },
        async barrier() {},
      }))
      assert.equal(snapshot.state, "degraded:semantic_unavailable")
      assert.deepEqual(snapshot.diagnostic.observed, { name: "unknown", message: String(thrown) })
    }
    const { snapshot } = await startWith(root, required, semanticRuntime({
      async beginConvergence() {},
      async barrier() {
        return undefined
      },
    }))
    assert.equal(snapshot.state, "degraded:semantic_unavailable")
    assert.deepEqual(snapshot.diagnostic.observed, { barrier: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("background convergence failures with non-Error values are logged, not thrown", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-semantic-background-"))
  try {
    const { stderr } = await startWith(root, { semantic: "background" }, semanticRuntime({
      beginBackgroundConvergence: () => Promise.reject("index busy"),
    }))
    assert.match(stderr, /background convergence failed: index busy/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
