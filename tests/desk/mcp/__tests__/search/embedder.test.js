import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { loadEmbedder, MODEL, tokenize } from "../../../../../plugins/desk/mcp/src/search/embedder.js"
import { mkTempRoot } from "../_temp_roots.js"
import { fixtureModel } from "./_model_fixture.js"

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0)

test("the real model is pinned to a revision and both of its files to SHA-256 hashes", () => {
  assert.match(MODEL.url, /^https:\/\/huggingface\.co\/minishlab\/potion-base-8M\/resolve\/[0-9a-f]{40}$/)
  assert.deepEqual(Object.keys(MODEL.files).sort(), ["model.safetensors", "tokenizer.json"])
  for (const hash of Object.values(MODEL.files)) assert.match(hash, /^[0-9a-f]{64}$/)
})

test("tokenize lowercases, strips accents, splits punctuation and Chinese characters, and drops unknown words", () => {
  const { vocab } = fixtureModel()
  const id = (word) => vocab.get(word)
  // "café" loses its accent, so it no longer matches the vocabulary's accented entry.
  assert.deepEqual(tokenize("The CAR,soup cafe\u0301!", vocab), [id("the"), id("car"), id(","), id("soup")])
  assert.deepEqual(tokenize("Cars repair", vocab), [id("car"), id("##s"), id("re"), id("##pair")])
  assert.deepEqual(tokenize("zzz 汉 soup\u0000garden", vocab), [id("soup"), id("garden")])
  assert.deepEqual(tokenize("car".repeat(40), vocab), [])
})

test("a model is downloaded once, checked against its hashes, and read from disk afterwards", async () => {
  const stateDir = await mkTempRoot("desk-embedder-")
  const fixture = fixtureModel()
  const first = await loadEmbedder({ stateDir, fetch: fixture.fetch, model: fixture.model })
  assert.equal(first.id, "fixture/model@1")
  assert.equal(fixture.requests.length, 2)
  const again = await loadEmbedder({ stateDir, fetch: () => assert.fail("no download expected"), model: fixture.model })
  const car = again.embed("car")
  assert.ok(Math.abs(dot(car, car) - 1) < 1e-6)
  assert.ok(dot(again.embed("automobile notes"), car) > 0.9)
  assert.ok(dot(again.embed("soup"), car) < 0.1)
  assert.deepEqual([...again.embed("unknownword")], [0, 0, 0, 0])
  assert.ok(existsSync(path.join(stateDir, "embedding-model", "fixture-model-1", "model.safetensors")))
})

test("a damaged model file is downloaded again", async () => {
  const stateDir = await mkTempRoot("desk-embedder-")
  const fixture = fixtureModel()
  const dir = path.join(stateDir, "embedding-model", "fixture-model-1")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "tokenizer.json"), "damaged")
  await loadEmbedder({ stateDir, fetch: fixture.fetch, model: fixture.model })
  assert.equal(readFileSync(path.join(dir, "tokenizer.json"), "utf8"), fixture.files["tokenizer.json"].toString("utf8"))
})

test("a failed or tampered download is refused", async () => {
  const stateDir = await mkTempRoot("desk-embedder-")
  const fixture = fixtureModel()
  await assert.rejects(loadEmbedder({ stateDir, model: fixture.model, fetch: async () => ({ ok: false, status: 503 }) }),
    /downloading tokenizer\.json failed with HTTP 503/)
  await assert.rejects(loadEmbedder({ stateDir, model: fixture.model, fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }) }),
    /does not match its pinned hash/)
})
