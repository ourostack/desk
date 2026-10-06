// What the sweep prunes so local state does not grow without bound: finished retractions' tombstones after their retention window, and the
// outbox copy of a delivered session whose transcript is gone. Open retractions, quarantined files and kept (retracted) copies are never touched.
import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  COPY_RETENTION_MS,
  TOMBSTONE_RETENTION_MS,
  factoryStateRoot,
  finishRetracting,
  gitBlobSha,
  markDelivered,
  markRetracting,
  pruneDeliveredCopy,
  pruneTombstones,
  quarantine,
  readDelivered,
  setConsent,
  writeLocalFacts,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { STORE, scratch } from "./_session_helpers.js"

const SHA = "a".repeat(40)
const NOW = "2026-10-06T00:00:00.000Z"
const DAY = 24 * 60 * 60 * 1000
const ago = (days) => new Date(Date.parse(NOW) - days * DAY).toISOString()
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const nameOf = (n) => `claude-code-${sessionId(n)}.json`
const retractingFile = async (ctx, slug = "ourostack__factory") => path.join(await factoryStateRoot(ctx.env), "retracting", `${slug}.json`)
const readRetracting = async (ctx) => JSON.parse(await fs.readFile(await retractingFile(ctx), "utf8"))
const tomb = (extra = {}) => ({ path: "facts/x.json", blob: SHA, done: true, ...extra })

test("a finished retraction's tombstone records when it finished", () => scratch(async (ctx) => {
  await finishRetracting(ctx.env, STORE, [{ name: nameOf(1), path: "facts/x.json", blob: SHA }], { now: () => NOW })
  assert.deepEqual(await readRetracting(ctx), { [nameOf(1)]: tomb({ at: NOW }) })
  // Without a clock given it stamps the real time, a parsable timestamp.
  await finishRetracting(ctx.env, STORE, [{ name: nameOf(2), path: "facts/y.json", blob: SHA }])
  assert.equal(Number.isFinite(Date.parse((await readRetracting(ctx))[nameOf(2)].at)), true)
}))

test("only a tombstone past the retention window is removed; an open retraction, a fresh tombstone and junk stay", () => scratch(async (ctx) => {
  const file = await retractingFile(ctx)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const open = { path: "facts/o.json", blob: SHA }
  await fs.writeFile(file, JSON.stringify({
    [nameOf(1)]: tomb({ at: ago(91) }),
    [nameOf(2)]: tomb({ at: ago(89) }),
    [nameOf(3)]: open,
    [nameOf(4)]: tomb({ at: ago(400) }),
    "not-a-session-name": "text",
  }))
  assert.equal(await pruneTombstones(ctx.env, { now: () => NOW }), 2)
  const left = await readRetracting(ctx)
  assert.deepEqual(Object.keys(left).sort(), [nameOf(2), nameOf(3), "not-a-session-name"].sort())
  assert.deepEqual(left[nameOf(3)], open, "an open retraction is never touched")
  assert.equal(left[nameOf(2)].at, ago(89))
  // Nothing left to prune: nothing is written.
  const before = await fs.stat(file)
  assert.equal(await pruneTombstones(ctx.env, { now: () => NOW }), 0)
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs)
  assert.equal(TOMBSTONE_RETENTION_MS, 90 * DAY)
}))

test("a tombstone with no readable time is stamped now and kept, then ages from there", () => scratch(async (ctx) => {
  const file = await retractingFile(ctx)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ [nameOf(1)]: tomb(), [nameOf(2)]: tomb({ at: "not a time" }), [nameOf(3)]: tomb({ at: 5 }) }))
  assert.equal(await pruneTombstones(ctx.env, { now: () => ago(100) }), 0)
  assert.deepEqual((await readRetracting(ctx))[nameOf(1)].at, ago(100))
  assert.deepEqual((await readRetracting(ctx))[nameOf(2)].at, ago(100))
  assert.deepEqual((await readRetracting(ctx))[nameOf(3)].at, ago(100))
  // The stamp is kept as it is by a later sweep inside the window, and the tombstone goes only after it.
  assert.equal(await pruneTombstones(ctx.env, { now: () => ago(50) }), 0)
  assert.equal(await pruneTombstones(ctx.env, { now: () => NOW, retentionMs: 99 * DAY }), 3)
  assert.deepEqual(await readRetracting(ctx), {})
}))

test("pruning with no retracting folder, a store file with no tombstone or a file that is not a store's does nothing", () => scratch(async (ctx) => {
  assert.equal(await pruneTombstones(ctx.env, { now: () => NOW }), 0)
  const file = await retractingFile(ctx)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ [nameOf(1)]: { path: "facts/o.json", blob: SHA } }))
  await fs.writeFile(path.join(path.dirname(file), ".hidden.json"), JSON.stringify({ [nameOf(1)]: tomb({ at: ago(500) }) }))
  assert.equal(await pruneTombstones(ctx.env, { now: () => NOW }), 0)
  assert.equal(JSON.parse(await fs.readFile(path.join(path.dirname(file), ".hidden.json"), "utf8"))[nameOf(1)].at, ago(500), "a dotfile is not a store's file")
  // Both of the default arguments.
  assert.equal(await pruneTombstones(ctx.env), 0)
}))

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
async function deliveredCopy(ctx, n) {
  const facts = structuredClone(GOLDEN)
  facts.session.id = sessionId(n)
  facts.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  const written = await writeLocalFacts(ctx.env, STORE, facts)
  assert.equal(written.written, true, JSON.stringify(written))
  return written.name
}
const outboxFile = async (ctx, name) => path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name)
const present = (file) => fs.lstat(file).then(() => true, () => false)

const shaOfCopy = async (ctx, name) => gitBlobSha(await fs.readFile(await outboxFile(ctx, name)))
const deliverCopy = async (ctx, name, extra = {}) => markDelivered(ctx.env, STORE, { name, publishedBlobSha: SHA, publishedPath: "facts/x.json", localSha: await shaOfCopy(ctx, name), ...extra })

test("a delivered copy is pruned only when its delivery is trusted and it is the very copy that was delivered", () => scratch(async (ctx) => {
  assert.equal(COPY_RETENTION_MS, 90 * DAY)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const name = await deliveredCopy(ctx, 1)
  // Not delivered yet: the outbox copy is the only thing that holds it.
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, name), false)
  // Delivered with no recorded local copy (an older Desk), or with no path: kept.
  await markDelivered(ctx.env, STORE, { name, publishedBlobSha: SHA, publishedPath: "facts/x.json" })
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, name), false, "no local sha: an older Desk's record")
  await markDelivered(ctx.env, STORE, { name, publishedBlobSha: SHA, localSha: "not a sha" , publishedPath: "facts/x.json" })
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, name), false, "a local sha that is not one is not recorded")
  const noPath = await deliveredCopy(ctx, 6)
  await markDelivered(ctx.env, STORE, { name: noPath, publishedBlobSha: SHA, localSha: await shaOfCopy(ctx, noPath) })
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, noPath), false, "no trusted path: a later retraction could not find the file")
  // The path entry's blob must be the delivered blob.
  await deliverCopy(ctx, name)
  const root = await factoryStateRoot(ctx.env)
  const pathsFile = path.join(root, "delivered-paths", "ourostack__factory.json")
  const paths = JSON.parse(await fs.readFile(pathsFile, "utf8"))
  await fs.writeFile(pathsFile, JSON.stringify({ ...paths, [name]: { ...paths[name], blob: "b".repeat(40) } }))
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, name), false, "a path record that is not for the delivered blob")
  await fs.writeFile(pathsFile, JSON.stringify({ ...paths, [name]: "facts/x.json" }))
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, name), false, "a bare path is an older record")
  await fs.writeFile(pathsFile, JSON.stringify(paths))
  // The copy changed after it was delivered: an undelivered update, never pruned.
  const file = await outboxFile(ctx, name)
  await fs.writeFile(file, `${await fs.readFile(file, "utf8")} `)
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, name), false, "newer than what was delivered")
  assert.equal(await present(file), true)
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).trimEnd())
  // Quarantined: the store refused it, so the copy is evidence.
  await quarantine(ctx.env, STORE, name, "unknown_key")
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, name), false)
  await fs.rm(path.join(root, "quarantine"), { recursive: true })
  // Names that are not a facts copy, and a copy that is not there.
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, "labels/job/x.json"), false)
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, "nonsense"), false)
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, nameOf(9)), false)
  // A directory is not a copy.
  const dir = await deliveredCopy(ctx, 5)
  await deliverCopy(ctx, dir)
  await fs.rm(await outboxFile(ctx, dir))
  await fs.mkdir(await outboxFile(ctx, dir))
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, dir), false)
  // Retracting, then tombstoned: the record names it.
  await markRetracting(ctx.env, STORE, [{ name, path: "facts/x.json", blob: SHA }])
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, name), false)
  await finishRetracting(ctx.env, STORE, [{ name, path: "facts/x.json", blob: SHA }])
  assert.equal((await readDelivered(ctx.env, STORE)).retracted[name] !== undefined, true)
  await deliverCopy(ctx, name)
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, name), false)
  assert.equal(await present(await outboxFile(ctx, name)), true)
  // Delivered, trusted and unchanged: pruned, and the delivered record stays.
  const plain = await deliveredCopy(ctx, 2)
  await deliverCopy(ctx, plain)
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, plain), true)
  assert.equal(await present(await outboxFile(ctx, plain)), false)
  assert.equal((await readDelivered(ctx.env, STORE)).blobs[plain], SHA)
  assert.equal(await pruneDeliveredCopy(ctx.env, STORE, plain), false, "already gone")
}))

test("a tombstone is never pruned while any local copy of its session exists for the store: outbox, kept, labels or quarantine", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const root = await factoryStateRoot(ctx.env)
  const where = {
    outbox: (n) => path.join(root, "outbox", "ourostack__factory", nameOf(n)),
    kept: (n) => path.join(root, "retracted-copies", "ourostack__factory", nameOf(n)),
    quarantine: (n) => path.join(root, "quarantine", "ourostack__factory", nameOf(n)),
    labels: (n) => path.join(root, "labels", "ourostack__factory", "1a2b3c4d5e6f708192a3b4c5d6e7f809", `${sessionId(n)}.json`),
    keptLabels: (n) => path.join(root, "retracted-copies", "ourostack__factory", "labels", "1a2b3c4d5e6f708192a3b4c5d6e7f809", `${sessionId(n)}.json`),
    quarantinedLabels: (n) => path.join(root, "quarantine", "ourostack__factory", "labels", "1a2b3c4d5e6f708192a3b4c5d6e7f809", `${sessionId(n)}.json`),
  }
  const file = await retractingFile(ctx)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const kinds = Object.keys(where)
  const records = {}
  for (const [index, kind] of kinds.entries()) {
    const n = index + 1
    await fs.mkdir(path.dirname(where[kind](n)), { recursive: true })
    await fs.writeFile(where[kind](n), "{}")
    records[nameOf(n)] = tomb({ at: ago(500) })
  }
  records[nameOf(20)] = tomb({ at: ago(500) })
  await fs.writeFile(file, JSON.stringify(records))
  assert.equal(await pruneTombstones(ctx.env, { now: () => NOW }), 1, "only the session with nothing left locally")
  assert.deepEqual(Object.keys(await readRetracting(ctx)).sort(), kinds.map((_, index) => nameOf(index + 1)).sort())
  // The copy goes, and so may the tombstone.
  await fs.rm(where.outbox(1))
  assert.equal(await pruneTombstones(ctx.env, { now: () => NOW }), 1)
}))
