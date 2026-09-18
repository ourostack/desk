import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import {
  controllerIdentity,
  semanticPartitionIdentity,
} from "../../src/readiness/identity.js"

test("controller identity canonicalizes path aliases and compatibility contracts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-identity-"))
  const other = path.join(root, "other")
  const alias = path.join(root, "alias")
  mkdirSync(other)
  try {
    symlinkSync(other, alias, "junction")
    const lexicalContract = {
      schema: 1,
      chunker: "markdown-v1",
      normalization: "unicode-v1",
    }
    const direct = controllerIdentity({
      root: other,
      protocolVersion: 1,
      lexicalContract,
    })
    const throughAlias = controllerIdentity({
      root: alias,
      protocolVersion: 1,
      lexicalContract,
    })
    assert.equal(direct.id, throughAlias.id)
    assert.equal(direct.root, throughAlias.root)
    assert.notEqual(
      direct.id,
      controllerIdentity({
        root,
        protocolVersion: 1,
        lexicalContract,
      }).id,
    )
    assert.notEqual(
      direct.id,
      controllerIdentity({
        root: other,
        protocolVersion: 2,
        lexicalContract,
      }).id,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("semantic partitions isolate embedding specifications deterministically", () => {
  assert.equal(
    semanticPartitionIdentity({ provider: "local", model: "a", dimensions: 3 }),
    semanticPartitionIdentity({ dimensions: 3, model: "a", provider: "local" }),
  )
  assert.notEqual(
    semanticPartitionIdentity({ provider: "local", model: "a", dimensions: 3 }),
    semanticPartitionIdentity({ provider: "local", model: "b", dimensions: 3 }),
  )
})
