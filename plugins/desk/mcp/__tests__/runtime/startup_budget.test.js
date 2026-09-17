import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { main } from "../../index.js"

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), "desk-startup-control-ready-"))
}

test("startup admits and registers before background convergence without indexing", async () => {
  const root = makeRoot()
  const events = []
  try {
    await main({
      argv: ["--root", root, "--person", "ari"],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => ({
        ensureIndex() {
          throw new Error("ensureIndex must not run during admission")
        },
        async admitControlPlane({ deskRoot, person, policy }) {
          events.push("admit")
          assert.equal(deskRoot, root)
          assert.equal(person, "ari")
          assert.equal(policy.lexical, "required")
          return {
            state: "CONTROL_READY",
            root: deskRoot,
            authority: { mode: "person", person },
            runtime: { state: "ready" },
            controller: { accepted: true, id: "controller-1" },
            automatic_actions: [],
          }
        },
        async startServer({ statusContext }) {
          events.push("start")
          assert.equal(statusContext.admission.state, "CONTROL_READY")
        },
        beginBackgroundConvergence(admission) {
          events.push("converge")
          assert.equal(admission.controller.id, "controller-1")
        },
      }),
    })

    assert.deepEqual(events, ["admit", "start", "converge"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("default admission performs no workspace discovery, network, hashing, or indexing", async () => {
  const root = makeRoot()
  let started
  try {
    await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => ({
        _deskRuntime: { state: "ready" },
        async startServer(args) {
          started = args
        },
      }),
    })

    assert.equal(started.statusContext.admission.state, "CONTROL_READY")
    assert.equal(started.statusContext.admission.root, root)
    assert.deepEqual(started.statusContext.admission.automatic_actions, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
