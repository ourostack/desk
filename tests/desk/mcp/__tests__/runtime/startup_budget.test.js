import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { admitInProcess, idleSearchEngine } from "./_in_process_desk.js"

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), "desk-startup-control-ready-"))
}

test("startup admits, then starts its search engine and warms it in the background", async () => {
  const root = makeRoot()
  const events = []
  try {
    const started = await admitInProcess({
      argv: ["--root", root, "--person", "ari"],
      env: {},
      cwd: root,
      homeDir: root,
      readinessPolicy: { write_authority: "person" },
      runtimeImporter: async () => ({
        createSearchEngine({ deskRoot, semantic }) {
          events.push("start")
          assert.equal(deskRoot, root)
          assert.equal(semantic, "background")
          return idleSearchEngine({ warm() { events.push("warm") } })
        },
      }),
    })

    assert.equal(started.snapshot.state, "ready")
    assert.equal(started.person, "ari")
    assert.notEqual(started.statusContext.search, null)
    assert.deepEqual(events, ["start", "warm"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("startup refuses writes for an unresolved configured authority provider", async () => {
  const root = makeRoot()
  try {
    const started = await admitInProcess({
      argv: ["--root", root, "--person", "ari"],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => ({
        _deskRuntime: { state: "ready" },
        createSearchEngine() {
          assert.fail("no search engine before authority is admitted")
        },
      }),
      readinessPolicy: {
        root: "workspace",
        write_authority: "person",
        lexical: "required",
        semantic: "background",
        authority_provider: "crew-registry",
      },
    })
    assert.equal(started.snapshot.state, "degraded:authority_invalid")
    assert.equal(started.statusContext.search, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
