import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { main, parseArgs } from "../../index.js"
import { createSetupDiagnostic } from "../../src/runtime/diagnostics.js"

function makeHome() {
  const root = mkdtempSync(path.join(tmpdir(), "desk-overlay-onboarding-"))
  const home = path.join(root, "home")
  // A work desk at a home fallback path: an overlay that owns its own root
  // must never be silently bound to it.
  mkdirSync(path.join(home, "ms-desk"), { recursive: true })
  return { root, home }
}

async function startSetup(argv, home) {
  const started = []
  await main({
    argv,
    env: { HOME: home },
    homeDir: home,
    mcpRoot: "/fixture/mcp",
    diagnosticServerStarter: (options) => {
      started.push(options)
    },
    runtimeImporter: async () => {
      throw new Error("runtime must not load in setup mode")
    },
  })
  assert.equal(started.length, 1)
  return started[0].diagnostic
}

test("parseArgs captures the overlay onboarding skill and reason", () => {
  const args = parseArgs(["--onboarding", "crew:join-crew", "--onboarding-reason", "No crew checkout at ~/code/platform-workflows."])
  assert.equal(args.onboarding, "crew:join-crew")
  assert.equal(args.onboardingReason, "No crew checkout at ~/code/platform-workflows.")
})

test("an overlay that cannot resolve its root starts Desk in setup mode on its own onboarding path, skipping home fallbacks", async () => {
  const { root, home } = makeHome()
  try {
    const diagnostic = await startSetup(
      ["--onboarding", "crew:join-crew", "--onboarding-reason", "No crew checkout found for this identity."],
      home,
    )
    assert.equal(diagnostic.mode, "setup")
    assert.equal(diagnostic.onboarding_skill, "crew:join-crew")
    assert.equal(diagnostic.reason_detail, "No crew checkout found for this identity.")
    assert.deepEqual(diagnostic.paths_tried, [], "home fallbacks such as ~/ms-desk must not be consulted")
    assert.equal(diagnostic.remediation[0].action, "run_onboarding")
    assert.match(diagnostic.remediation[0].message, /crew:join-crew/u)
    assert.match(diagnostic.summary, /No desk is bound yet/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an explicit root still wins over an onboarding request", async () => {
  const { root, home } = makeHome()
  const desk = path.join(root, "desk")
  mkdirSync(desk)
  try {
    const { admitInProcess } = await import("./_in_process_desk.js")
    const started = await admitInProcess({
      argv: ["--root", desk, "--onboarding", "crew:join-crew"],
      env: {},
      cwd: desk,
      homeDir: home,
      mcpRoot: "/fixture/mcp",
      diagnosticServerStarter: () => assert.fail("an explicit root must not enter setup mode"),
      runtimeImporter: async () => ({
        async connectOrStartController() {
          return { accepted: true, id: "controller-1", beginConvergence() {} }
        },
      }),
    })
    assert.equal(started.snapshot.state, "ready")
    assert.equal(started.statusContext.root.root, desk)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("default setup mode names desk:first-run-bootstrap and the Claude binding", () => {
  const diagnostic = createSetupDiagnostic({ bindingPath: "/data/desk.activation.json" })
  assert.equal(diagnostic.onboarding_skill, "desk:first-run-bootstrap")
  assert.equal(diagnostic.reason_detail, null)
  assert.equal(diagnostic.remediation[0].action, "run_first_run_bootstrap")
  assert.match(diagnostic.remediation[1].message, /\/data\/desk\.activation\.json/u)
})

test("overlay setup mode leaves binding to the overlay's onboarding path", () => {
  const diagnostic = createSetupDiagnostic({ onboardingSkill: "crew:join-crew", bindingPath: "/data/desk.activation.json" })
  assert.deepEqual(diagnostic.remediation.map((step) => step.action), ["run_onboarding", "restart_session"])
})
