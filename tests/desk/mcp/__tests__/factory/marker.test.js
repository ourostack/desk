import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import * as path from "node:path"
import { absolutePath, MAX_MARKER_BYTES, readSmallText, validMarker, validRouting } from "../../../../../plugins/desk/mcp/src/factory/marker.js"
import { factoryStateRoot, listFinalizeJobs, readMarker, writeMarker } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { scratch, session, SENTINEL, STORE, END } from "./_session_helpers.js"
import { different } from "../_file_identity.js"

test("marker validation rejects unknown fields, path traversal, free-text metadata and malformed optional context", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  assert.equal(validMarker(marker), true)
  assert.equal(validMarker({ ...marker, desk_root: null, ended_at: END, end_reason: "complete", entrypoint: "cli", person_prefix: "", routing: { source: "default", store: STORE, warnings: [] }, plugins: [{ name: "desk", version: "3.2.0-alpha.46" }] }), true)
  assert.equal(validMarker({ ...marker, person_prefix: "desks/alice" }), true)
  for (const invalid of [
    null, [], {}, { ...marker, extra: "text" }, { ...marker, schema_version: 2 }, { ...marker, host: "other" },
    { ...marker, session_id: 1 }, { ...marker, session_id: "no" }, { ...marker, log_path: "../foo" },
    { ...marker, cwd: "relative" }, { ...marker, desk_root: 1 }, { ...marker, end_reason: "free text" },
    { ...marker, ended_at: 1 }, { ...marker, ended_at: "wrong" }, { ...marker, ended_at: "2026-99-99T00:00:00.000Z" },
    { ...marker, updated_at: null }, { ...marker, plugins: null }, { ...marker, plugins: Array(65).fill({ name: "desk", version: "1.0.0" }) },
    ...[null, {}, { name: "desk", version: "1.0.0", text: "prompt" }, { name: null, version: "1.0.0" },
      { name: "Bad Name", version: "1.0.0" }, { name: "desk", version: null }, { name: "desk", version: "secret" }].map((plugin) => ({ ...marker, plugins: [plugin] })),
    { ...marker, entrypoint: "whatever" }, { ...marker, person_prefix: 1 }, { ...marker, person_prefix: "desks/../bob" },
    { ...marker, routing: {} },
  ]) assert.equal(validMarker(invalid), false, JSON.stringify(invalid).slice(0, 150))
  for (const value of [null, "a".repeat(4097), "/x\0y", "relative"]) assert.equal(absolutePath(value), false)
}))

test("a marker plugin may name its install source; one written before sources were recorded stays valid", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  for (const plugins of [
    [{ name: "desk", version: "1.0.0" }],
    [{ name: "desk", version: "1.0.0", source: null }],
    [{ name: "desk", version: "1.0.0", source: "ourostack/desk" }, { name: "notes", version: "2.0.0" }],
  ]) assert.equal(validMarker({ ...marker, plugins }), true, JSON.stringify(plugins))
  for (const source of ["", "ourostack", "ourostack/desk/extra", `${SENTINEL} x/y`, 42, ["ourostack/desk"], { repo: "ourostack/desk" }, "https://github.com/ourostack/desk"]) {
    assert.equal(validMarker({ ...marker, plugins: [{ name: "desk", version: "1.0.0", source }] }), false, JSON.stringify(source))
  }
  assert.equal(validMarker({ ...marker, plugins: [{ name: "desk", version: "1.0.0", source: null, origin: "x" }] }), false, "no other key is allowed")
}))

test("routing snapshots accept only classified local warnings and valid destinations", () => {
  const valid = { source: "overlay", store: STORE, warnings: [{ code: "manifest_unreadable", manifest: path.resolve("plugin.json") }] }
  assert.equal(validRouting(valid), true)
  assert.equal(validRouting({ source: "invalid_declaration", store: null, warnings: [] }), true)
  for (const value of [
    null, {}, { ...valid, extra: true }, { ...valid, source: "bad" }, { ...valid, source: "invalid_declaration" },
    { ...valid, store: null }, { ...valid, store: "bad" }, { ...valid, warnings: null },
    { ...valid, warnings: Array(193).fill(valid.warnings[0]) },
    ...[null, {}, { ...valid.warnings[0], extra: true }, { code: "text", manifest: path.resolve("x") }, { code: "manifest_unparseable", manifest: "relative" }]
      .map((warning) => ({ ...valid, warnings: [warning] })),
  ]) assert.equal(validRouting(value), false)
})

test("bounded metadata reads refuse non-files, links, oversize and growth during read", (t) => scratch(async ({ base }) => {
  const file = path.join(base, "metadata.json")
  fs.writeFileSync(file, "1234")
  assert.equal(readSmallText(file), "1234")
  assert.throws(() => readSmallText(file, 3), /metadata_unreadable/u)
  assert.throws(() => readSmallText(base), /metadata_unreadable/u)
  const linked = path.join(base, "hard")
  fs.linkSync(file, linked)
  assert.throws(() => readSmallText(file), /metadata_unreadable/u)
  fs.unlinkSync(linked)
  fs.writeFileSync(file, "12")
  const original = fs.readSync
  const read = t.mock.method(fs, "readSync", (...args) => {
    fs.writeFileSync(file, "1234")
    return original(...args)
  })
  assert.throws(() => readSmallText(file, 3), /metadata_unreadable/u)
  assert.equal(read.mock.callCount(), 1)
}))

for (const race of ["directory", "hardlink", "growth", "replacement", "volume"]) {
  test(`bounded metadata reads refuse ${race} changes between inspection and open`, (t) => scratch(async ({ base }) => {
    const file = path.join(base, "metadata")
    fs.writeFileSync(file, "1234")
    const open = fs.openSync
    const fstat = fs.fstatSync
    t.mock.method(fs, "openSync", (...args) => {
      if (race === "directory") { fs.unlinkSync(file); fs.mkdirSync(file) }
      if (race === "hardlink") fs.linkSync(file, path.join(base, "other"))
      if (race === "growth") fs.writeFileSync(file, "12345")
      if (race === "replacement") { fs.renameSync(file, path.join(base, "old")); fs.writeFileSync(file, "1234") }
      return open(...args)
    })
    if (race === "volume") t.mock.method(fs, "fstatSync", (fd, ...rest) => {
      const real = fstat(fd, ...rest)
      return { ...real, isFile: () => true, dev: different(real.dev) }
    })
    assert.throws(() => readSmallText(file, 4), /metadata_unreadable/u)
  }))
}

test("protected marker reads accept only matching regular entries and cap serialized marker size", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  await writeMarker(ctx.env, marker)
  const root = await factoryStateRoot(ctx.env)
  const file = path.join(root, "markers", `${marker.host}-${marker.session_id}.json`)
  assert.deepEqual(await readMarker(ctx.env, file), marker)
  for (const wrong of [null, path.join(root, "elsewhere", path.basename(file)), path.join(root, "markers", "invalid.json")]) {
    assert.equal(await readMarker(ctx.env, wrong), null)
  }
  fs.writeFileSync(file, JSON.stringify({ ...marker, host: "copilot-cli" }))
  assert.equal(await readMarker(ctx.env, file), null)
  fs.writeFileSync(file, "{}")
  assert.equal(await readMarker(ctx.env, file), null)
  const large = { ...marker, routing: { source: "default", store: STORE, warnings: Array(100).fill({ code: "manifest_unreadable", manifest: path.resolve("x".repeat(1000)) }) } }
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > MAX_MARKER_BYTES)
  await assert.rejects(writeMarker(ctx.env, large), /too large/u)
}))

for (const change of ["directory", "hardlink", "rewrite", "replacement"]) {
  test(`metadata read rejects a ${change} after open instead of returning a stale pathname snapshot`, (t) => scratch(async ({ base }) => {
    const file = path.join(base, "metadata")
    fs.writeFileSync(file, "1234")
    const read = fs.readSync
    t.mock.method(fs, "readSync", (...args) => {
      const count = read(...args)
      if (change === "directory") { fs.renameSync(file, path.join(base, "old")); fs.mkdirSync(file) }
      if (change === "hardlink") fs.linkSync(file, path.join(base, "other"))
      if (change === "rewrite") fs.writeFileSync(file, "56789")
      if (change === "replacement") { fs.renameSync(file, path.join(base, "old")); fs.writeFileSync(file, "1234") }
      return count
    })
    assert.throws(() => readSmallText(file), /metadata_unreadable/u)
  }))
}

test("finalize hook enumeration ignores invalid entries and caps work at eight jobs or 128 entries", (t) => scratch(async ({ env, base }) => {
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "finalize")
  assert.deepEqual(await listFinalizeJobs(env), [])
  fs.mkdirSync(path.join(dir, `${"a".repeat(32)}.json`))
  fs.writeFileSync(path.join(dir, "not-a-job.json"), "{}")
  const hard = path.join(dir, `${"b".repeat(32)}.json`)
  fs.writeFileSync(hard, "{}")
  fs.linkSync(hard, path.join(base, "external"))
  assert.deepEqual(await listFinalizeJobs(env), [])
  for (let n = 0; n < 9; n++) fs.writeFileSync(path.join(dir, `${n.toString(16).padStart(32, "0")}.json`), "{}")
  assert.equal((await listFinalizeJobs(env)).length, 8)
  for (const entry of fs.readdirSync(dir)) {
    if (entry !== `${"a".repeat(32)}.json`) fs.unlinkSync(path.join(dir, entry))
  }
  for (let n = 0; n < 130; n++) fs.writeFileSync(path.join(dir, `junk-${n}`), "")
  assert.deepEqual(await listFinalizeJobs(env), [])
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith("junk-")) fs.unlinkSync(path.join(dir, entry))
  }
  const vanishing = path.join(dir, `${"c".repeat(32)}.json`)
  fs.writeFileSync(vanishing, "{}")
  const original = fs.promises.lstat
  t.mock.method(fs.promises, "lstat", async (file, ...args) => {
    if (file === vanishing && fs.existsSync(file)) fs.unlinkSync(file)
    return original(file, ...args)
  })
  assert.deepEqual(await listFinalizeJobs(env), [])
}))
