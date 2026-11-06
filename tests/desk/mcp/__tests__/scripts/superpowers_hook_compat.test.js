import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { removeTree } from "../_remove_tree.js"

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const require = createRequire(import.meta.url)
const compat = require(path.join(repoRoot, "scripts/superpowers-hook-compat.cjs"))
const fs = require("node:fs")
const hash = (value) => createHash("sha256").update(value).digest("hex")

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "superpowers-compat-"))
  t.after(async () => {
    await removeTree(root)
    assert.equal(existsSync(root), false)
    t.diagnostic(`Removed owned fixture: ${root}`)
  })
  const hooks = path.join(root, "plugins/superpowers/hooks")
  mkdirSync(path.join(hooks, "upstream"), { recursive: true })
  copyFileSync(path.join(repoRoot, "upstream-sources.lock.json"), path.join(root, "upstream-sources.lock.json"))
  copyFileSync(path.join(repoRoot, "plugins/superpowers/hooks/upstream/run-hook.cmd"), path.join(hooks, "upstream/run-hook.cmd"))
  return { root, hooks }
}

test("shipped downstream artifacts match the current raw lock and generator", () => {
  compat.verify({ root: repoRoot })
})

test("compatibility artifacts keep raw batch and Unix dispatch bytes with separate provenance", (t) => {
  const { root, hooks } = fixture(t)
  const before = readFileSync(path.join(hooks, "upstream/run-hook.cmd"))
  const lockBefore = readFileSync(path.join(root, "upstream-sources.lock.json"))
  const result = compat.generate({ root })
  const raw = before.toString()
  const end = raw.indexOf("\nCMDBLOCK\n")
  assert.equal(readFileSync(path.join(hooks, "run-hook-unix"), "utf8"), raw.slice(end + "\nCMDBLOCK\n".length))
  assert.ok(readFileSync(path.join(hooks, "run-hook.cmd"), "utf8").endsWith(raw.slice(": << 'CMDBLOCK'\n".length, end) + "\n"))
  assert.deepEqual(readFileSync(path.join(hooks, "upstream/run-hook.cmd")), before)
  assert.deepEqual(readFileSync(path.join(root, "upstream-sources.lock.json")), lockBefore)
  const provenance = JSON.parse(readFileSync(path.join(hooks, "run-hook-compat.provenance.json"), "utf8"))
  assert.equal(provenance.source.sha256, hash(before))
  assert.equal(provenance.source.repository, "obra/superpowers")
  assert.equal(provenance.transform.id, "split-batch-unix-v1")
  assert.equal(provenance.transform.sha256, hash(readFileSync(path.join(repoRoot, provenance.transform.generator))))
  for (const file of provenance.outputs) assert.equal(hash(readFileSync(path.join(root, file.path))), file.sha256)
  assert.equal(result.outputs.length, 2)
  compat.verify({ root })
})

test("verification and no-change generation do not repair missing or stale outputs silently", (t) => {
  const { root, hooks } = fixture(t)
  compat.generate({ root })
  const file = path.join(hooks, "run-hook-unix")
  const modified = lstatSync(file).mtimeMs
  compat.verify({ root })
  compat.generate({ root })
  assert.equal(lstatSync(file).mtimeMs, modified)
  writeFileSync(file, "stale\n")
  assert.throws(() => compat.verify({ root }), /run-hook-unix.*drift/)
  assert.equal(readFileSync(file, "utf8"), "stale\n")
  unlinkSync(file)
  assert.throws(() => compat.verify({ root }), /run-hook-unix/)
  assert.equal(lstatSync(path.join(hooks, "run-hook.cmd")).isFile(), true)
})

test("hash and unknown-layout refusals preserve previously generated artifacts", (t) => {
  const { root, hooks } = fixture(t)
  compat.generate({ root })
  const before = readFileSync(path.join(hooks, "run-hook-compat.provenance.json"))
  writeFileSync(path.join(hooks, "upstream/run-hook.cmd"), "changed raw bytes\n")
  assert.throws(() => compat.generate({ root }), /raw.*SHA-256/)
  assert.deepEqual(readFileSync(path.join(hooks, "run-hook-compat.provenance.json")), before)
  for (const raw of [
    ": '\nexit /b 0\n'\n",
    ": << 'CMDBLOCK'\n@echo off\nexit /b 0\nCMDBLOCK\n\n# Unix: changed\n",
    ": << 'CMDBLOCK'\n@echo off\nexit /b 0\nCMDBLOCK\n\n# Unix: run the named script directly\nCMDBLOCK\n",
  ]) assert.throws(() => compat.transform(Buffer.from(raw)), /layout/)
})

test("split transform retains executable CMD apostrophes and refreshed Unix footer", () => {
  const batch = '@echo off\nfor /f "delims=" %%B in (\'where bash\') do set "BASH_EXE=%%B"\n"%BASH_EXE%" "%~dp0%~1" %2\nexit /b %ERRORLEVEL%'
  const unix = '\n# Unix: run the named script directly\nexec "${BASH:-bash}" "$1" "$@"\n'
  const outputs = compat.transform(Buffer.from(": << 'CMDBLOCK'\n" + batch + "\nCMDBLOCK\n" + unix))
  assert.ok(outputs.cmd.endsWith(batch + "\n"))
  assert.equal(outputs.unix, unix)
})

test("invalid source identity and missing raw input fail before downstream writes", (t) => {
  const { root, hooks } = fixture(t)
  compat.generate({ root })
  const before = readFileSync(path.join(hooks, "run-hook-compat.provenance.json"))
  const lockPath = path.join(root, "upstream-sources.lock.json")
  const original = readFileSync(lockPath)
  const lock = JSON.parse(original)
  lock.sources.find((entry) => entry.id === "obra-superpowers").repository = "other/provider"
  writeFileSync(lockPath, JSON.stringify(lock))
  assert.throws(() => compat.generate({ root }), /source identity/)
  writeFileSync(lockPath, original)
  unlinkSync(path.join(hooks, "upstream/run-hook.cmd"))
  assert.throws(() => compat.generate({ root }), /run-hook\.cmd/)
  assert.deepEqual(readFileSync(path.join(hooks, "run-hook-compat.provenance.json")), before)
})

test("a dangling output symlink is refused rather than followed", { skip: process.platform === "win32" }, (t) => {
  const { root, hooks } = fixture(t)
  const output = path.join(hooks, "run-hook-unix")
  const target = path.join(root, "missing-target")
  symlinkSync(target, output)
  assert.throws(() => compat.generate({ root }), /regular output/)
  assert.equal(lstatSync(output).isSymbolicLink(), true)
  assert.throws(() => lstatSync(target), /ENOENT/)
  assert.throws(() => lstatSync(path.join(hooks, "run-hook.cmd")), /ENOENT/)
})

function incomingGeneration(t) {
  const owned = fixture(t)
  compat.generate({ root: owned.root })
  const before = new Map(compat.OUTPUT_PATHS.map((file) => [file, readFileSync(path.join(owned.root, file))]))
  const rawPath = path.join(owned.hooks, "upstream/run-hook.cmd")
  const original = readFileSync(rawPath, "utf8")
  const raw = original.replace("@echo off\n", "@echo off\nREM Fixture upstream change\n")
  assert.notEqual(raw, original)
  writeFileSync(rawPath, raw)
  const lockPath = path.join(owned.root, "upstream-sources.lock.json")
  const lock = JSON.parse(readFileSync(lockPath))
  lock.sources.find((source) => source.id === "obra-superpowers").files
    .find((file) => file.sourcePath === "hooks/run-hook.cmd").sha256 = hash(raw)
  writeFileSync(lockPath, JSON.stringify(lock))
  return { ...owned, before }
}

test("late artifact read failure leaves every earlier output unchanged", (t) => {
  const { root, hooks, before } = incomingGeneration(t)
  const io = { ...fs, readFileSync(file, ...args) {
    if (file === path.join(hooks, "run-hook-unix")) throw Object.assign(new Error("injected late read failure"), { code: "EACCES" })
    return fs.readFileSync(file, ...args)
  } }
  assert.throws(() => compat.generate({ root, io }), /late read failure/)
  for (const [file, bytes] of before) assert.deepEqual(readFileSync(path.join(root, file)), bytes)
})

test("a physically unreadable late sibling refuses generation before any earlier artifact change", { skip: process.platform === "win32" }, (t) => {
  const { root, hooks, before } = incomingGeneration(t)
  const sibling = path.join(hooks, "run-hook-unix")
  fs.chmodSync(sibling, 0o000)
  try {
    assert.throws(() => compat.generate({ root }), (error) => error.code === "EACCES")
  } finally {
    fs.chmodSync(sibling, 0o644)
  }
  for (const [file, bytes] of before) assert.deepEqual(readFileSync(path.join(root, file)), bytes)
})

test("late publish failure restores the previous complete artifact set and permits retry", (t) => {
  const { root, hooks, before } = incomingGeneration(t)
  let failed = false
  const io = { ...fs, renameSync(from, to) {
    if (!failed && to === path.join(hooks, "run-hook-compat.provenance.json")) {
      failed = true
      throw Object.assign(new Error("injected late publish failure"), { code: "EIO" })
    }
    return fs.renameSync(from, to)
  } }
  assert.throws(() => compat.generate({ root, io }), (error) => {
    assert.equal(error.recoveryStatus, "restored")
    assert.match(error.message, /late publish failure/)
    assert.equal(existsSync(error.recoveryPath), false)
    return true
  })
  for (const [file, bytes] of before) assert.deepEqual(readFileSync(path.join(root, file)), bytes)
  compat.generate({ root })
  compat.verify({ root })
})

test("foreign changes during failed publish are preserved with explicit UNKNOWN recovery evidence", (t) => {
  const { root, hooks } = incomingGeneration(t)
  const cmd = path.join(hooks, "run-hook.cmd")
  const io = { ...fs, renameSync(from, to) {
    if (to === path.join(hooks, "run-hook-compat.provenance.json")) {
      writeFileSync(cmd, "distinct external content\n")
      throw new Error("injected publish with external writer")
    }
    return fs.renameSync(from, to)
  } }
  assert.throws(() => compat.generate({ root, io }), (error) => {
    assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.equal(readFileSync(cmd, "utf8"), "distinct external content\n")
    assert.equal(existsSync(path.join(error.recoveryPath, "journal.json")), true)
    const journal = JSON.parse(readFileSync(path.join(error.recoveryPath, "journal.json")))
    assert.equal(journal.status, "UNKNOWN")
    assert.equal(journal.unresolved.some((entry) => entry.path.endsWith("run-hook.cmd")), true)
    assert.equal(readFileSync(path.join(error.recoveryPath, "before-0")).equals(readFileSync(cmd)), false)
    assert.throws(() => compat.generate({ root }), /unresolved transaction/)
    t.after(async () => {
      await removeTree(error.recoveryPath)
      assert.equal(existsSync(error.recoveryPath), false)
      t.diagnostic(`Removed owned UNKNOWN recovery fixture: ${error.recoveryPath}`)
    })
    return true
  })
})

test("late staging write failure publishes no artifact", (t) => {
  const { root, before } = incomingGeneration(t)
  const io = { ...fs, writeFileSync(file, ...args) {
    if (path.basename(file) === "after-1") throw new Error("injected staging write failure")
    return fs.writeFileSync(file, ...args)
  } }
  assert.throws(() => compat.generate({ root, io }), (error) => {
    assert.equal(error.recoveryStatus, "restored")
    assert.equal(existsSync(error.recoveryPath), false)
    return true
  })
  for (const [file, bytes] of before) assert.deepEqual(readFileSync(path.join(root, file)), bytes)
})

test("a rename that took effect before throwing is restored from attributable candidate identity", (t) => {
  const { root, hooks, before } = incomingGeneration(t)
  let failed = false
  const io = { ...fs, renameSync(from, to) {
    fs.renameSync(from, to)
    if (!failed && to === path.join(hooks, "run-hook.cmd")) {
      failed = true
      throw new Error("rename completed but reported failure")
    }
  } }
  assert.throws(() => compat.generate({ root, io }), (error) => {
    assert.equal(error.recoveryStatus, "restored")
    return true
  })
  for (const [file, bytes] of before) assert.deepEqual(readFileSync(path.join(root, file)), bytes)
})

test("rollback IO failure retains before-images and explicit UNKNOWN journal instead of false atomicity", (t) => {
  const { root, hooks, before } = incomingGeneration(t)
  const io = { ...fs, renameSync(from, to) {
    if (to === path.join(hooks, "run-hook-compat.provenance.json") || path.basename(from).startsWith("restore-")) {
      throw new Error("injected publish and rollback failure")
    }
    return fs.renameSync(from, to)
  } }
  assert.throws(() => compat.generate({ root, io }), (error) => {
    assert.equal(error.recoveryStatus, "UNKNOWN")
    const journal = JSON.parse(readFileSync(path.join(error.recoveryPath, "journal.json")))
    assert.equal(journal.status, "UNKNOWN")
    assert.deepEqual(readFileSync(path.join(error.recoveryPath, "before-0")), before.get(compat.OUTPUT_PATHS[0]))
    assert.equal(existsSync(path.join(error.recoveryPath, "current-0")), true)
    assert.throws(() => compat.generate({ root }), /unresolved transaction/)
    t.after(async () => {
      await removeTree(error.recoveryPath)
      assert.equal(existsSync(error.recoveryPath), false)
      t.diagnostic(`Removed owned rollback-failure recovery fixture: ${error.recoveryPath}`)
    })

    return true
  })
})

test("removed raw files are restored with the rest of a failed refresh transaction", (t) => {
  const { root } = fixture(t)
  writeFileSync(path.join(root, "removed"), "prior removed payload\n")
  writeFileSync(path.join(root, "later"), "prior later payload\n")
  const io = { ...fs, renameSync(from, to) {
    if (to === path.join(root, "later")) throw new Error("injected later failure")
    return fs.renameSync(from, to)
  } }
  assert.throws(() => compat.publish({ root, io, artifacts: [
    { path: "removed", content: null }, { path: "later", content: Buffer.from("new later payload\n") },
  ] }), (error) => error.recoveryStatus === "restored")
  assert.equal(readFileSync(path.join(root, "removed"), "utf8"), "prior removed payload\n")
  assert.equal(readFileSync(path.join(root, "later"), "utf8"), "prior later payload\n")
})

test("a foreign deletion after a failed move is not resurrected by rollback", (t) => {
  const { root } = fixture(t)
  const target = path.join(root, "removed")
  writeFileSync(target, "prior removed payload\n")
  const io = { ...fs, renameSync(from, to) {
    if (from === target) {
      unlinkSync(target)
      throw new Error("failed move with independent deletion")
    }
    return fs.renameSync(from, to)
  } }
  assert.throws(() => compat.publish({ root, io, artifacts: [{ path: "removed", content: null }] }), (error) => {
    assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.equal(existsSync(target), false)
    assert.equal(readFileSync(path.join(error.recoveryPath, "before-0"), "utf8"), "prior removed payload\n")
    t.after(async () => {
      await removeTree(error.recoveryPath)
      assert.equal(existsSync(error.recoveryPath), false)
      t.diagnostic(`Removed owned independent-deletion recovery fixture: ${error.recoveryPath}`)
    })
    return true
  })
})

for (const drift of ["earlier-output", "unchanged-input"]) {
  test(`complete-set settlement refuses ${drift} divergence introduced by a later write`, (t) => {
    const { root, hooks } = incomingGeneration(t)
    const foreign = drift === "earlier-output" ? path.join(hooks, "run-hook.cmd") : path.join(hooks, "upstream/run-hook.cmd")
    const io = { ...fs, renameSync(from, to) {
      fs.renameSync(from, to)
      if (to === path.join(hooks, "run-hook-compat.provenance.json")) writeFileSync(foreign, "foreign final-map content\n")
    } }
    assert.throws(() => compat.generate({ root, io }), (error) => {
      assert.equal(error.recoveryStatus, "UNKNOWN")
      assert.equal(readFileSync(foreign, "utf8"), "foreign final-map content\n")
      assert.equal(error.recoveryState.unresolved.some((item) => item.path.endsWith(path.basename(foreign))), true)
      t.after(async () => { await removeTree(error.recoveryPath) })
      return true
    })
  })
}

test("foreign empty directory replacement is not removed during rollback", (t) => {
  const { root } = fixture(t)
  const directory = path.join(root, "new-owned-dir")
  let foreignIdentity
  const io = { ...fs, renameSync(from, to) {
    if (to === path.join(root, "later")) {
      unlinkSync(path.join(directory, "file"))
      fs.rmdirSync(directory)
      mkdirSync(directory)
      foreignIdentity = lstatSync(directory)
      throw new Error("later publish failure after foreign directory replacement")
    }
    return fs.renameSync(from, to)
  } }
  assert.throws(() => compat.publish({ root, io, artifacts: [
    { path: "new-owned-dir/file", content: Buffer.from("owned\n") }, { path: "later", content: Buffer.from("later\n") },
  ] }), (error) => {
    assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.equal(lstatSync(directory).ino, foreignIdentity.ino)
    assert.equal(lstatSync(directory).birthtimeMs, foreignIdentity.birthtimeMs)
    t.after(async () => { await removeTree(error.recoveryPath) })
    return true
  })
})

test("mkdir completing before throwing retains unobserved creation as UNKNOWN", (t) => {
  const { root } = fixture(t)
  const directory = path.join(root, "mkdir-uncertain")
  const io = { ...fs, mkdirSync(file, ...args) {
    fs.mkdirSync(file, ...args)
    if (file === directory) throw new Error("mkdir completed before IO error")
  } }
  assert.throws(() => compat.publish({ root, io, artifacts: [
    { path: "mkdir-uncertain/file", content: Buffer.from("owned\n") },
  ] }), (error) => {
    assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.equal(lstatSync(directory).isDirectory(), true)
    assert.equal(error.recoveryState.unresolved.some((entry) => entry.path === directory), true)
    t.after(async () => { await removeTree(error.recoveryPath) })
    return true
  })
})

test("publication, rollback, evidence and journal failures all survive in thrown recovery state", (t) => {
  const { root, hooks } = incomingGeneration(t)
  let publishingFailed = false
  const io = { ...fs, renameSync(from, to) {
    if (to === path.join(hooks, "run-hook-compat.provenance.json")) {
      publishingFailed = true
      throw new Error("PRIMARY publication failure")
    }
    if (path.basename(from).startsWith("restore-")) throw new Error("SECONDARY rollback failure")
    return fs.renameSync(from, to)
  }, writeFileSync(file, ...args) {
    if (publishingFailed && path.basename(file).startsWith("current-")) throw new Error("SECONDARY evidence failure")
    if (publishingFailed && path.basename(file) === "journal.json") throw new Error("SECONDARY journal failure")
    return fs.writeFileSync(file, ...args)
  } }
  assert.throws(() => compat.generate({ root, io }), (error) => {
    assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.equal(error.cause.message, "PRIMARY publication failure")
    const state = JSON.stringify(error.recoveryState)
    for (const reason of ["SECONDARY rollback failure", "SECONDARY evidence failure", "SECONDARY journal failure"]) assert.ok(state.includes(reason))
    assert.ok(error.recoveryState.beforeImages.length >= 3)
    t.after(async () => { await removeTree(error.recoveryPath) })
    return true
  })
})

test("a forged recovery root is not read or written during rollback", (t) => {
  const { root, hooks } = incomingGeneration(t)
  let foreignRoot
  const originalCmd = readFileSync(path.join(hooks, "run-hook.cmd"))
  const io = { ...fs, renameSync(from, to) {
    if (to === path.join(hooks, "run-hook-compat.provenance.json")) {
      foreignRoot = path.dirname(from)
      fs.rmSync(foreignRoot, { recursive: true })
      mkdirSync(foreignRoot)
      writeFileSync(path.join(foreignRoot, "before-0"), "FORGED backup\n")
      writeFileSync(path.join(foreignRoot, "marker"), "FOREIGN root\n")
      throw new Error("publish fault with forged recovery root")
    }
    return fs.renameSync(from, to)
  } }
  assert.throws(() => compat.generate({ root, io }), (error) => {
    assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.notEqual(readFileSync(path.join(hooks, "run-hook.cmd"), "utf8"), "FORGED backup\n")
    assert.notDeepEqual(readFileSync(path.join(hooks, "run-hook.cmd")), originalCmd)
    assert.deepEqual(fs.readdirSync(foreignRoot).sort(), ["before-0", "marker"])
    assert.ok(error.recoveryState.beforeImages.length >= 3)
    t.after(async () => { await removeTree(foreignRoot) })
    return true
  })
})

for (const fault of ["missing", "changed-journal"]) {
  test(`held guard ${fault} refuses publication before its first consumer mutation`, (t) => {
    const { root } = fixture(t)
    const guardPath = path.join(root, ".superpowers-hook-transaction-guard-test")
    mkdirSync(guardPath)
    const content = Buffer.from("captured guard\n")
    writeFileSync(path.join(guardPath, "journal.json"), content)
    const guard = { path: guardPath, identity: compat.directoryIdentity(guardPath), content,
      journalIdentity: compat.readOwnedJournal(path.join(guardPath, "journal.json")).identity }
    if (fault === "missing") fs.rmSync(guardPath, { recursive: true })
    else writeFileSync(path.join(guardPath, "journal.json"), "foreign guard journal\n")
    assert.throws(() => compat.publish({ root, heldGuard: guard,
      artifacts: [{ path: "consumer", content: Buffer.from("must not publish\n") }] }), /guard/)
    assert.equal(existsSync(path.join(root, "consumer")), false)
  })
}

for (const fault of ["mkdir-after-effect", "identity-read"]) {
  test(`initial recovery allocation ${fault} reports known-path UNKNOWN with before-images`, (t) => {
    const { root } = incomingGeneration(t)
    let allocated
    const io = { ...fs, mkdirSync(file, ...args) {
      fs.mkdirSync(file, ...args)
      if (path.basename(file).startsWith(".superpowers-hook-transaction-")) {
        allocated = file
        if (fault === "mkdir-after-effect") throw new Error("allocation completed then failed")
      }
    }, lstatSync(file, ...args) {
      if (fault === "identity-read" && file === allocated) throw new Error("allocation identity read failed")
      return fs.lstatSync(file, ...args)
    } }
    assert.throws(() => compat.generate({ root, io }), (error) => {
      assert.equal(error.recoveryStatus, "UNKNOWN")
      assert.equal(error.recoveryPath, allocated)
      assert.ok(error.recoveryState.beforeImages.length >= 3)
      assert.equal(error.recoveryState.allocation.status, "creation-attempted")
      assert.equal(existsSync(allocated), true)
      t.after(async () => { await removeTree(allocated) })
      return true
    })
  })
}

test("rollback re-admits consumer ownership after staging restore bytes", (t) => {
  const { root, hooks } = incomingGeneration(t)
  const target = path.join(hooks, "run-hook.cmd")
  const io = { ...fs, renameSync(from, to) {
    if (to === path.join(hooks, "run-hook-compat.provenance.json")) throw new Error("publish failure")
    return fs.renameSync(from, to)
  }, chmodSync(file, mode) {
    fs.chmodSync(file, mode)
    if (path.basename(file) === "restore-0") writeFileSync(target, "foreign edit during restoration\n")
  } }
  assert.throws(() => compat.generate({ root, io }), (error) => {
    assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.equal(readFileSync(target, "utf8"), "foreign edit during restoration\n")
    t.after(async () => { await removeTree(error.recoveryPath) })
    return true
  })
})

for (const fault of ["destination", "guard"]) {
  test(`forward publication renews ${fault} admission after parent creation`, (t) => {
    const { root } = fixture(t)
    const guardPath = path.join(root, ".superpowers-hook-transaction-guard-owned")
    mkdirSync(guardPath)
    const content = Buffer.from("guard\n")
    writeFileSync(path.join(guardPath, "journal.json"), content)
    const guard = { path: guardPath, identity: compat.directoryIdentity(guardPath), content,
      journalIdentity: compat.readOwnedJournal(path.join(guardPath, "journal.json")).identity }
    const target = path.join(root, "new-parent/file")
    const io = { ...fs, mkdirSync(file, ...args) {
      fs.mkdirSync(file, ...args)
      if (file === path.dirname(target)) {
        if (fault === "destination") writeFileSync(target, "foreign newly appeared destination\n")
        else fs.rmSync(guardPath, { recursive: true })
      }
    } }
    assert.throws(() => compat.publish({ root, io, heldGuard: guard,
      artifacts: [{ path: "new-parent/file", content: Buffer.from("owned candidate\n") }] }), (error) => {
      if (fault === "destination") assert.equal(readFileSync(target, "utf8"), "foreign newly appeared destination\n")
      else assert.equal(existsSync(target), false)
      t.after(async () => { await removeTree(error.recoveryPath) })
      return true
    })
  })
}

for (const operation of ["read", "write"]) {
  for (const field of ["ino", "dev", "birthtimeNs"]) {
    test(`journal ${operation} rejects a same-byte replacement hidden by numeric ${field} precision loss`, (t) => {
      const { root } = fixture(t)
      const journal = path.join(root, "journal")
      const outside = path.join(root, "outside")
      const previous = Buffer.from("captured original bytes\n")
      let replaced = false
      const replace = () => {
        fs.renameSync(journal, outside)
        writeFileSync(journal, previous)
        fs.chmodSync(journal, 0o600)
        replaced = true
      }
      const identityStat = (stat, options) => {
        const exact = { ino: 9007199254740992n, dev: 9007199254740992n, birthtimeNs: 9007199254740992n }
        if (replaced) exact[field] += 1n
        const bigint = options?.bigint === true
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          ino: bigint ? exact.ino : Number(exact.ino),
          dev: bigint ? exact.dev : Number(exact.dev),
          birthtimeMs: bigint ? exact.birthtimeNs / 1000000n : Number(exact.birthtimeNs) / 1000000,
          ...(bigint ? { birthtimeNs: exact.birthtimeNs } : {}),
        })
      }
      const io = { ...fs,
        lstatSync(file, options) { return identityStat(fs.lstatSync(file, options), options) },
        fstatSync(fd, options) { return identityStat(fs.fstatSync(fd, options), options) },
        openSync(file, flags, ...args) {
          if (operation === "write" && !replaced && flags === (fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0))) replace()
          return fs.openSync(file, flags, ...args)
        },
      }
      const identity = compat.writeOwnedJournal(journal, null, null, previous, true, io)
      if (operation === "read") replace()
      assert.throws(() => operation === "read"
        ? compat.readOwnedJournal(journal, identity, io)
        : compat.writeOwnedJournal(journal, identity, previous, Buffer.from("forbidden overwrite\n"), false, io),
      /original guard journal file identity changed/)
      assert.equal(replaced, true)
      assert.deepEqual(readFileSync(outside), previous)
      assert.deepEqual(readFileSync(journal), previous)
    })
  }
}

for (const alias of ["symlink", "hardlink", "regular-replacement"]) {
  test(`same-byte ${alias} cannot become owned guard journal authority`, (t) => {
    const { root } = fixture(t)
    const journal = path.join(root, "journal")
    const outside = path.join(root, "outside")
    const previous = Buffer.from("captured original bytes\n")
    const identity = compat.writeOwnedJournal(journal, null, null, previous, true)
    fs.renameSync(journal, outside)
    if (alias === "symlink") fs.symlinkSync(outside, journal)
    else if (alias === "hardlink") fs.linkSync(outside, journal)
    else writeFileSync(journal, previous)
    assert.throws(() => compat.readOwnedJournal(journal, identity))
    assert.throws(() => compat.writeOwnedJournal(journal, identity, previous, Buffer.from("forbidden overwrite\n"), false))
    assert.deepEqual(readFileSync(outside), previous)
    assert.deepEqual(readFileSync(journal), previous)
  })
}

test("a replaced recovery directory is not recursively deleted after settlement", (t) => {
  const { root } = incomingGeneration(t)
  let replaced = false
  const io = { ...fs, writeFileSync(file, ...args) {
    if (!replaced && path.basename(file) === "journal.json" && JSON.parse(args[0]).status === "committed") {
      const directory = path.dirname(file)
      fs.rmSync(directory, { recursive: true })
      mkdirSync(directory)
      writeFileSync(path.join(directory, "foreign-content"), "synthetic foreign directory content\n")
      replaced = true
    }
    return fs.writeFileSync(file, ...args)
  } }
  assert.throws(() => compat.generate({ root, io }), (error) => {
    assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.equal(error.recoveryState.status, "UNKNOWN")
    assert.equal(readFileSync(path.join(error.recoveryPath, "foreign-content"), "utf8"), "synthetic foreign directory content\n")
    t.after(async () => { await removeTree(error.recoveryPath) })
    return true
  })
})
