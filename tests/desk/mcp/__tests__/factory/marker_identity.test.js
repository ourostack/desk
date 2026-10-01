import { test } from "node:test"
import assert from "node:assert/strict"
import fsSync, { promises as fs } from "node:fs"
import * as path from "node:path"
import { deriveFile, deriveMarker, sweep } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import { factoryStateRoot, listMarkers, readMarker, setConsent, writeMarker } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { END, ID, STORE, json, recent, scratch, session } from "./_session_helpers.js"

const NEWER = "2026-09-26T09:02:00.000Z"
const posix = { skip: process.platform === "win32" }

for (const [at, kind] of [["enumeration", "valid"], ["leaf-inspection", "valid"], ["leaf-inspection", "corrupt"], ["leaf-inspection", "expired"]]) {
  test(`I1 directory swap at ${at}, ${kind} external open and restoration cannot derive or mutate external data`, posix, (t) => scratch(async (ctx) => {
    const owned = { ...await session(ctx), updated_at: recent() }
    await writeMarker(ctx.env, owned)
    await setConsent(ctx.env, { store: STORE, contribute: true })
    const root = await factoryStateRoot(ctx.env)
    const dir = path.join(root, "markers")
    const saved = path.join(root, "markers-owned")
    const external = path.join(ctx.base, "external-markers")
    const file = path.join(dir, `${owned.host}-${ID}.json`)
    const externalFile = path.join(external, path.basename(file))
    const log = path.join(ctx.base, "external-log", `${ID}.jsonl`)
    await fs.mkdir(path.dirname(log), { recursive: true })
    await fs.copyFile(owned.log_path, log)
    const externalMarker = { ...owned, log_path: log, ended_at: NEWER, end_reason: "complete", updated_at: recent(1000) }
    await json(externalFile, externalMarker)
    if (kind === "corrupt") await fs.writeFile(externalFile, "{")
    if (kind === "expired") await json(externalFile, { ...externalMarker, updated_at: "2025-01-01T00:00:00.000Z" })
    await fs.chmod(externalFile, 0o644)
    const bytes = await fs.readFile(externalFile, "utf8")
    let swapped = false, restored = false, openedExternal = false, logReads = 0
    const swap = () => {
      fsSync.renameSync(dir, saved)
      fsSync.symlinkSync(external, dir, "dir")
      swapped = true
    }
    const restore = () => {
      fsSync.unlinkSync(dir)
      fsSync.renameSync(saved, dir)
      restored = true
    }
    const readdir = fs.readdir
    t.mock.method(fs, "readdir", async (target, ...args) => {
      if (at === "enumeration" && target === dir && !swapped) swap()
      return readdir(target, ...args)
    })
    const lstatSync = fsSync.lstatSync
    t.mock.method(fsSync, "lstatSync", (target, ...args) => {
      if (at === "leaf-inspection" && target === file && !swapped) swap()
      return lstatSync(target, ...args)
    })
    const openSync = fsSync.openSync
    t.mock.method(fsSync, "openSync", (target, ...args) => {
      const fd = openSync(target, ...args)
      if (target === file && swapped && !restored) {
        openedExternal = true
        restore()
      }
      return fd
    })
    const open = fs.open
    t.mock.method(fs, "open", (target, ...args) => {
      if (target === log) logReads += 1
      return open(target, ...args)
    })
    let summary
    try {
      summary = await sweep(ctx.env)
    } catch (error) {
      assert.match(error.message, /marker_changed|metadata_unreadable|symlink/u)
    } finally {
      if (swapped && !restored) restore()
    }
    assert.equal(swapped, true)
    if (at === "leaf-inspection") assert.equal(openedExternal, true)
    assert.equal(summary?.written ?? 0, 0)
    assert.equal(logReads, 0, "external native evidence must not be read or derived")
    await assert.rejects(fs.stat(path.join(root, "outbox", "ourostack__factory", path.basename(file))), { code: "ENOENT" })
    assert.equal(await fs.readFile(externalFile, "utf8"), bytes)
    assert.equal((await fs.stat(externalFile)).mode & 0o777, 0o644)
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), owned)
  }))
}

test("I1 sweep's locked read is authoritative even when the enumerated marker has a later timestamp", () => scratch(async (ctx) => {
  const owned = { ...await session(ctx), updated_at: recent() }
  await writeMarker(ctx.env, owned)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const stale = { ...owned, ended_at: NEWER, end_reason: "complete", updated_at: recent(1000) }
  const result = await deriveMarker(ctx.env, stale, { quietMs: 600000, requireStored: true })
  assert.equal(result.result, "skipped", "the current protected open marker stays busy, rather than using the newer-looking input")
  const root = await factoryStateRoot(ctx.env)
  await assert.rejects(fs.stat(path.join(root, "outbox")), { code: "ENOENT" })
  await fs.unlink(path.join(root, "markers", `${owned.host}-${ID}.json`))
  assert.notEqual((await deriveMarker(ctx.env, stale, { requireStored: true })).result, "written", "a vanished marker cannot fall back to stale input")
}))

for (const change of ["replace", "remove"]) {
  test(`I1 production sweep rejects the stale enumerated state when the locked marker is ${change}d`, (t) => scratch(async (ctx) => {
    const current = { ...await session(ctx), updated_at: recent() }
    const enumerated = { ...current, ended_at: NEWER, end_reason: "complete", updated_at: recent(1000) }
    await writeMarker(ctx.env, enumerated)
    await setConsent(ctx.env, { store: STORE, contribute: true })
    const root = await factoryStateRoot(ctx.env)
    const name = `${current.host}-${ID}.json`
    const file = path.join(root, "markers", name)
    const lock = path.join(root, "deriving", `${name}.lock`)
    const open = fs.open
    let changed = false
    t.mock.method(fs, "open", async (target, ...args) => {
      if (target === lock && !changed) {
        changed = true
        if (change === "remove") await fs.unlink(file)
        else await json(file, current)
      }
      return open(target, ...args)
    })
    const summary = await sweep(ctx.env)
    assert.equal(changed, true)
    assert.equal(summary.written, 0)
    if (change === "replace") assert.equal(summary.skipped, 1)
    await assert.rejects(fs.stat(path.join(root, "outbox")), { code: "ENOENT" })
  }))
}

test("I1 a different physical marker directory cannot inherit the protected directory's identity", posix, (t) => scratch(async (ctx) => {
  const marker = await session(ctx)
  await writeMarker(ctx.env, marker)
  const root = await factoryStateRoot(ctx.env)
  const dir = path.join(root, "markers")
  const old = path.join(root, "old-markers")
  const name = `${marker.host}-${ID}.json`
  const file = path.join(dir, name)
  const lstatSync = fsSync.lstatSync
  let swapped = false
  t.mock.method(fsSync, "lstatSync", (target, ...args) => {
    if (target === file && !swapped) {
      fsSync.renameSync(dir, old)
      fsSync.mkdirSync(dir, { mode: 0o700 })
      fsSync.renameSync(path.join(old, name), file)
      swapped = true
    }
    return lstatSync(target, ...args)
  })
  try {
    await assert.rejects(readMarker(ctx.env, file), /marker_changed/u)
    assert.equal(swapped, true)
  } finally {
    if (swapped) {
      fsSync.renameSync(file, path.join(old, name))
      fsSync.rmdirSync(dir)
      fsSync.renameSync(old, dir)
    }
  }
}))

test("I1 file-based derivation cannot prefer its pre-lock copy over the current protected marker", (t) => scratch(async (ctx) => {
  const current = { ...await session(ctx), updated_at: recent() }
  await writeMarker(ctx.env, { ...current, ended_at: NEWER, end_reason: "complete", updated_at: recent(1000) })
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const root = await factoryStateRoot(ctx.env)
  const name = `${current.host}-${ID}.json`
  const file = path.join(root, "markers", name)
  const open = fs.open
  let replaced = false
  t.mock.method(fs, "open", async (target, ...args) => {
    if (target === path.join(root, "deriving", `${name}.lock`) && !replaced) {
      replaced = true
      await json(file, current)
    }
    return open(target, ...args)
  })
  assert.equal((await deriveFile(ctx.env, file)).result, "written")
  const facts = JSON.parse(await fs.readFile(path.join(root, "outbox", "ourostack__factory", name), "utf8"))
  assert.equal(replaced, true)
  assert.equal(facts.session.end_reason, null)
}))

test("I1 protection cannot adopt a different marker directory midway through repair", posix, (t) => scratch(async (ctx) => {
  const marker = await session(ctx)
  await writeMarker(ctx.env, marker)
  const root = await factoryStateRoot(ctx.env)
  const dir = path.join(root, "markers")
  const old = path.join(root, "old-markers")
  const external = path.join(ctx.base, "external")
  const name = `${marker.host}-${ID}.json`
  await json(path.join(external, name), marker)
  await fs.chmod(external, 0o700)
  await fs.chmod(dir, 0o755)
  const chmod = fs.chmod
  let swapped = false
  t.mock.method(fs, "chmod", async (target, ...args) => {
    await chmod(target, ...args)
    if (target === dir && !swapped) {
      await fs.rename(dir, old)
      await fs.rename(external, dir)
      swapped = true
    }
  })
  try {
    await assert.rejects(readMarker(ctx.env, path.join(dir, name)), /marker_changed/u)
    assert.equal(swapped, true)
  } finally {
    if (swapped) {
      await fs.rename(dir, external)
      await fs.rename(old, dir)
    }
  }
}))

test("I1 a fresh leaf replacing an expired marker at pruning time is preserved", posix, (t) => scratch(async (ctx) => {
  const fresh = await session(ctx)
  await writeMarker(ctx.env, { ...fresh, updated_at: "2025-01-01T00:00:00.000Z" })
  const root = await factoryStateRoot(ctx.env)
  const file = path.join(root, "markers", `${fresh.host}-${ID}.json`)
  const read = fsSync.readSync
  let readComplete = false, checks = 0, replaced = false
  t.mock.method(fsSync, "readSync", (...args) => {
    const count = read(...args)
    readComplete = true
    return count
  })
  const lstat = fs.lstat
  t.mock.method(fs, "lstat", async (target, ...args) => {
    // Three leaf inspections finish read/protection; the fourth is the prune identity check.
    if (readComplete && target === file && ++checks === 4) {
      await fs.rename(file, path.join(ctx.base, "expired"))
      await json(file, fresh)
      replaced = true
    }
    return lstat(target, ...args)
  })
  assert.deepEqual(await listMarkers(ctx.env), [])
  assert.equal(replaced, true)
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), fresh)
}))
