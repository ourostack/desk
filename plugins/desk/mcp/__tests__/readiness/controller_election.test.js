import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { connectOrStartController } from "../../src/readiness/controller-client.js"

test("simultaneous compatible starters elect one controller", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-controller-root-"))
  const stateHome = mkdtempSync(path.join(tmpdir(), "desk-controller-state-"))
  try {
    const options = {
      root,
      stateHome,
      protocolVersion: 1,
      lexicalContract: { schema: 1, chunker: "v1", normalization: "v1" },
    }
    const [first, second] = await Promise.all([
      connectOrStartController(options),
      connectOrStartController(options),
    ])
    assert.equal(first.accepted, true)
    assert.equal(second.accepted, true)
    assert.equal(first.id, second.id)
    const statuses = await Promise.all([first.status(), second.status()])
    assert.equal(statuses[0].owner.pid, statuses[1].owner.pid)
    await first.close()
    await second.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(stateHome, { recursive: true, force: true })
  }
})

test("incompatible protocols use isolated controller namespaces", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-controller-root-"))
  const stateHome = mkdtempSync(path.join(tmpdir(), "desk-controller-state-"))
  try {
    const common = {
      root,
      stateHome,
      lexicalContract: { schema: 1, chunker: "v1", normalization: "v1" },
    }
    const first = await connectOrStartController({ ...common, protocolVersion: 1 })
    const second = await connectOrStartController({ ...common, protocolVersion: 2 })
    assert.notEqual(first.id, second.id)
    await first.close()
    await second.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(stateHome, { recursive: true, force: true })
  }
})
