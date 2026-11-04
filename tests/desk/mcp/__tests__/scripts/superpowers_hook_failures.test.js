import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as fs from "node:fs"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { mock, test } from "node:test"
import { removeTree } from "../_remove_tree.js"

const repo = fileURLToPath(new URL("../../../../../", import.meta.url))
const require = createRequire(import.meta.url)
const compat = require(path.join(repo, "scripts/superpowers-hook-compat.cjs"))
const crypto = require("node:crypto")
const CMD = "plugins/superpowers/hooks/run-hook.cmd"
const UNIX = "plugins/superpowers/hooks/run-hook-unix"
const PROVENANCE = "plugins/superpowers/hooks/run-hook-compat.provenance.json"
const RAW = "plugins/superpowers/hooks/upstream/run-hook.cmd"

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "superpowers-failure-"))
  t.after(async () => { await removeTree(root); assert.equal(fs.existsSync(root), false) })
  for (const file of ["upstream-sources.lock.json", RAW]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.copyFileSync(path.join(repo, file), path.join(root, file))
  }
  return root
}
const ioWith = (overrides) => ({ ...fs, ...overrides })

test("snapshot rejects escaped paths, non-directory ancestors, inaccessible paths and unstable reads", (t) => {
  const root = fixture(t)
  assert.throws(() => compat.snapshot({ root, paths: ["../outside"] }), /out-of-root/)
  fs.writeFileSync(path.join(root, "regular"), "value")
  assert.throws(() => compat.snapshot({ root, paths: ["regular/child"] }), /nonregular directory/)
  const denied = Object.assign(new Error("denied stat"), { code: "EACCES" })
  assert.throws(() => compat.snapshot({ root, paths: [CMD], io: ioWith({ lstatSync(file) {
    if (file === path.join(root, path.dirname(CMD))) throw denied
    return fs.lstatSync(file)
  } }) }), /denied stat/)
  assert.throws(() => compat.snapshot({ root, paths: ["denied"], io: ioWith({ lstatSync(file) {
    if (file === path.join(root, "denied")) throw denied
    return fs.lstatSync(file)
  } }) }), /denied stat/)
  assert.throws(() => compat.snapshot({ root, paths: ["regular"], io: ioWith({ readFileSync(file) {
    const bytes = fs.readFileSync(file)
    if (file === path.join(root, "regular")) fs.appendFileSync(file, "changed")
    return bytes
  } }) }), /concurrent read/)
  assert.throws(() => compat.directoryIdentity(path.join(root, "regular")), /not an owned directory/)
  assert.equal(compat.sameDirectory(root, compat.directoryIdentity(root)), true)
  const state = {}
  const created = compat.allocateDirectory({ parent: root, prefix: "default-io-", state })
  assert.equal(created, state.path)
  assert.equal(state.status, "creation-observed")
})

test("prepare rejects raw aliases and ambiguous/misbound evidence lock entries", (t) => {
  const root = fixture(t), raw = path.join(root, RAW)
  fs.unlinkSync(raw); fs.mkdirSync(raw)
  assert.throws(() => compat.prepare({ root }), /regular single-link/)
  fs.rmdirSync(raw); fs.copyFileSync(path.join(repo, RAW), raw)
  const lockPath = path.join(root, "upstream-sources.lock.json"), original = fs.readFileSync(lockPath)
  for (const value of ["wrong", undefined]) {
    const lock = JSON.parse(original)
    lock.sources.find((source) => source.id === "obra-superpowers").files.find((file) => file.sourcePath === "hooks/run-hook.cmd").upstreamPath = value
    fs.writeFileSync(lockPath, JSON.stringify(lock))
    assert.throws(() => compat.prepare({ root }), /ambiguous raw hook/)
  }
})

test("journal rejects absent expected identity, changed prior bytes, descriptor mutation and zero-progress write", (t) => {
  const root = fixture(t), file = path.join(root, "journal"), before = Buffer.from("before"), after = Buffer.from("after")
  const identity = compat.writeOwnedJournal(file, null, null, before, true)
  assert.throws(() => compat.writeOwnedJournal(file, null, before, after, false), /original guard journal/)
  assert.throws(() => compat.writeOwnedJournal(file, identity, Buffer.from("wrong"), after, false), /original guard journal/)
  let fdReads = 0
  assert.throws(() => compat.writeOwnedJournal(file, identity, before, after, false, ioWith({ readFileSync(target, ...args) {
    if (typeof target === "number" && ++fdReads === 2) return Buffer.from("changed descriptor bytes")
    return fs.readFileSync(target, ...args)
  } })), /descriptor bytes changed/)
  assert.throws(() => compat.writeOwnedJournal(file, identity, before, after, false,
    ioWith({ writeSync: () => 0 })), /no progress/)
  fs.writeFileSync(file, before)
  let wrote = false
  assert.throws(() => compat.writeOwnedJournal(file, identity, before, after, false, ioWith({
    writeSync(...args) { wrote = true; return fs.writeSync(...args) },
    readFileSync(target, ...args) { return wrote && typeof target === "number" ? Buffer.from("wrong readback") : fs.readFileSync(target, ...args) },
  })), /qualified readback changed/)
})

test("publish refuses missing before-images and a writer arriving after complete preflight", (t) => {
  const root = fixture(t), target = path.join(root, "output")
  assert.throws(() => compat.publish({ root, before: new Map(), artifacts: [{ path: "output", content: Buffer.from("new") }] }), /missing before-image/)
  let staged = false
  assert.throws(() => compat.publish({ root, artifacts: [{ path: "output", content: Buffer.from("new") }], io: ioWith({
    writeFileSync(file, ...args) {
      fs.writeFileSync(file, ...args)
      if (!staged && path.basename(file) === "journal.json") { staged = true; fs.writeFileSync(target, "foreign") }
    },
  }) }), (error) => {
    assert.equal(error.recoveryStatus, "restored")
    assert.match(error.message, /concurrent publish/)
    return true
  })
  assert.equal(fs.readFileSync(target, "utf8"), "foreign")
})

for (const mode of ["missing", "inaccessible"]) {
  test(`final-map ${mode} earlier input is explicit UNKNOWN and retains evidence failures`, (t) => {
    const root = fixture(t), target = path.join(root, "output")
    fs.writeFileSync(target, "old")
    let replaced = false
    assert.throws(() => compat.publish({ root, artifacts: [{ path: "output", content: Buffer.from("new") }], io: ioWith({
      renameSync(from, to) {
        fs.renameSync(from, to)
        if (to === target) { replaced = true; if (mode === "missing") fs.unlinkSync(target) }
      },
      lstatSync(file) {
        if (mode === "inaccessible" && replaced && file === target) throw new Error("unreadable final input")
        return fs.lstatSync(file)
      },
    }) }), (error) => {
      assert.equal(error.recoveryStatus, "UNKNOWN")
      assert.ok(error.recoveryState.unresolved.length > 0)
      return true
    })
  })
}

for (const changed of [false, true]) {
  test(`newly created output rollback ${changed ? "preserves a late writer" : "restores absence"}`, (t) => {
    const root = fixture(t), target = path.join(root, "output")
    let failed = false, admittedReads = 0
    assert.throws(() => compat.publish({ root, artifacts: [
      { path: "output", content: Buffer.from("new") }, { path: "later", content: Buffer.from("later") },
    ], io: ioWith({
      renameSync(from, to) {
        if (to === path.join(root, "later")) { failed = true; throw new Error("later failed") }
        return fs.renameSync(from, to)
      },
      lstatSync(file) {
        if (changed && failed && file === target && ++admittedReads === 3) fs.writeFileSync(target, "foreign during rollback")
        return fs.lstatSync(file)
      },
    }) }), (error) => {
      assert.equal(error.recoveryStatus, changed ? "UNKNOWN" : "restored")
      return true
    })
    if (changed) assert.equal(fs.readFileSync(target, "utf8"), "foreign during rollback")
    else assert.equal(fs.existsSync(target), false)
  })
}

for (const alteration of ["staged-bytes", "restored-bytes"]) {
  test(`rollback ${alteration} mutation is not reported as restored`, (t) => {
    const root = fixture(t), target = path.join(root, "output")
    fs.writeFileSync(target, "old")
    let failed = false
    assert.throws(() => compat.publish({ root, artifacts: [
      { path: "output", content: Buffer.from("new") }, { path: "later", content: Buffer.from("later") },
    ], io: ioWith({
      renameSync(from, to) {
        if (to === path.join(root, "later")) { failed = true; throw new Error("publish failed") }
        fs.renameSync(from, to)
        if (alteration === "restored-bytes" && failed && to === target) fs.writeFileSync(target, "foreign after restoration")
      },
      chmodSync(file, mode) {
        fs.chmodSync(file, mode)
        if (alteration === "staged-bytes" && path.basename(file) === "restore-0") fs.writeFileSync(file, "foreign staged restore")
      },
    }) }), (error) => {
      assert.equal(error.recoveryStatus, "UNKNOWN")
      assert.match(error.message, /publish failed/)
      return true
    })
  })
}

test("unqualified recovery root with created parent retains directory instead of cleaning by path", (t) => {
  const root = fixture(t)
  assert.throws(() => compat.publish({ root, artifacts: [
    { path: "parent/output", content: Buffer.from("new") }, { path: "later", content: Buffer.from("later") },
  ], io: ioWith({ renameSync(from, to) {
    if (to === path.join(root, "later")) {
      const recovery = path.dirname(from)
      fs.rmSync(recovery, { recursive: true }); fs.mkdirSync(recovery)
      throw new Error("foreign recovery root")
    }
    return fs.renameSync(from, to)
  } }) }), (error) => {
    assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.ok(error.recoveryState.unresolved.some((entry) => entry.reason?.includes("directory cleanup withheld")))
    return true
  })
  assert.equal(fs.existsSync(path.join(root, "parent")), true)
})

for (const rollback of [true, false]) {
  test(`${rollback ? "restored" : "committed"} transaction cleanup failure has explicit retained status`, (t) => {
    const root = fixture(t), target = path.join(root, "output")
    fs.writeFileSync(target, "old")
    let cleanup = false
    assert.throws(() => compat.publish({ root, artifacts: [
      { path: "output", content: Buffer.from("new") }, { path: "later", content: Buffer.from("later") },
    ], io: ioWith({
      renameSync(from, to) {
        if (rollback && to === path.join(root, "later")) throw new Error("publish fault")
        return fs.renameSync(from, to)
      },
      rmSync() { cleanup = true; throw new Error("cleanup IO failure") },
      writeFileSync(file, ...args) {
        if (cleanup && path.basename(file) === "journal.json") throw new Error("cleanup journal failure")
        return fs.writeFileSync(file, ...args)
      },
    }) }), (error) => {
      assert.equal(error.recoveryStatus, rollback ? "UNKNOWN" : "committed-cleanup-pending")
      return true
    })
  })
}

test("default-root entry methods verify their current source without rewriting matching files", () => {
  const before = fs.statSync(path.join(repo, PROVENANCE)).mtimeMs
  assert.equal(compat.prepare().provenance.source.path, RAW)
  assert.equal(compat.verify().source.path, RAW)
  assert.equal(compat.generate().source.path, RAW)
  assert.equal(fs.statSync(path.join(repo, PROVENANCE)).mtimeMs, before)
})

test("standalone generator CLI qualifies fixture generation/verification and refuses malformed invocation", (t) => {
  const root = fixture(t)
  fs.mkdirSync(path.join(root, "scripts"))
  const script = path.join(root, "scripts/superpowers-hook-compat.cjs")
  fs.copyFileSync(path.join(repo, "scripts/superpowers-hook-compat.cjs"), script)
  for (const action of ["generate", "verify"]) {
    const result = spawnSync(process.execPath, [script, action], { encoding: "utf8", timeout: 5000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).source.path, RAW)
  }
  for (const args of [[], ["unknown"], ["verify", "extra"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5000 })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /usage:/)
  }
})

test("journal descriptor admission works on platforms without O_NOFOLLOW", (t) => {
  const root = fixture(t), file = path.join(root, "journal")
  const opens = []
  const io = ioWith({
    constants: { ...fs.constants, O_NOFOLLOW: undefined },
    openSync(target, flags, ...args) {
      if (fs.constants.O_NOFOLLOW !== undefined) {
        assert.equal(flags & fs.constants.O_NOFOLLOW, 0, "provider refuses the host-only unsupported O_NOFOLLOW bit")
      }
      opens.push(flags)
      return fs.openSync(target, flags, ...args)
    },
  })
  const identity = compat.writeOwnedJournal(file, null, null, Buffer.from("before"), true, io)
  assert.equal(compat.readOwnedJournal(file, identity, io).content.toString(), "before")
  compat.writeOwnedJournal(file, identity, Buffer.from("before"), Buffer.from("after"), false, io)
  assert.equal(compat.readOwnedJournal(file, identity, io).content.toString(), "after")
  assert.ok(opens.length >= 4, "generation, prior-content admission and readbacks use the provider")
})

test("allocation failing before a name exists preserves original error and unknown creation", (t) => {
  const root = fixture(t)
  const method = mock.method(crypto, "randomUUID", () => { throw Error("entropy unavailable before name") })
  try {
    assert.throws(() => compat.publish({ root, artifacts: [{ path: "output", content: Buffer.from("new") }] }), (error) => {
      assert.equal(error.recoveryStatus, "UNKNOWN")
      assert.equal(error.recoveryPath, null)
      assert.match(error.message, /creation outcome unknown/)
      assert.equal(error.cause.message, "entropy unavailable before name")
      return true
    })
  } finally { method.mock.restore() }
  assert.equal(fs.existsSync(path.join(root, "output")), false)
})

test("directory creation changed to a file is UNKNOWN without path-only removal", (t) => {
  const root = fixture(t), parent = path.join(root, "parent")
  assert.throws(() => compat.publish({ root, artifacts: [{ path: "parent/output", content: Buffer.from("new") }],
    io: ioWith({ mkdirSync(file, ...args) {
      if (file === parent) fs.writeFileSync(file, "foreign non-directory")
      else fs.mkdirSync(file, ...args)
    } }) }), (error) => {
    assert.equal(error.recoveryStatus, "UNKNOWN")
    assert.match(error.message, /changed type/)
    return true
  })
  assert.equal(fs.readFileSync(parent, "utf8"), "foreign non-directory")
})

for (const stage of ["restored", "committed"]) {
  test(`recovery identity changed after ${stage} journal is never cleaned as owned`, (t) => {
    const root = fixture(t), target = path.join(root, "output"), later = path.join(root, "later")
    fs.writeFileSync(target, "before")
    let recovery, committed = false, committedLaterReads = 0, replaced = false
    function replace() {
      if (replaced) return
      replaced = true
      fs.renameSync(recovery, path.join(root, "retained-original-recovery"))
      fs.mkdirSync(recovery)
      fs.writeFileSync(path.join(recovery, "foreign"), "foreign recovery")
    }
    assert.throws(() => compat.publish({ root, artifacts: [
      { path: "output", content: Buffer.from("new") }, { path: "later", content: Buffer.from("later") },
    ], io: ioWith({
      writeFileSync(file, ...args) {
        fs.writeFileSync(file, ...args)
        if (path.basename(file) === "journal.json") {
          recovery = path.dirname(file)
          const status = JSON.parse(args[0]).status
          if (stage === "restored" && status === "restored") replace()
          if (stage === "committed" && status === "committed") committed = true
        }
      },
      renameSync(from, to) {
        if (stage === "restored" && to === later) throw Error("publication refused")
        return fs.renameSync(from, to)
      },
      lstatSync(file) {
        const stat = fs.lstatSync(file)
        if (stage === "committed" && committed && file === later && ++committedLaterReads === 2) replace()
        return stat
      },
    }) }), (error) => {
      assert.equal(error.recoveryStatus, "UNKNOWN")
      assert.equal(fs.readFileSync(path.join(error.recoveryPath, "foreign"), "utf8"), "foreign recovery")
      return true
    })
    assert.equal(replaced, true)
  })
}

test("repository CLI entry uses the same generation/verification and refuses unsupported options", () => {
  const script = path.join(repo, "scripts/superpowers-hook-compat.cjs")
  const before = fs.readFileSync(path.join(repo, PROVENANCE))
  for (const args of [["generate"], ["verify"], [], ["unknown"], ["verify", "extra"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5000 })
    assert.equal(result.status, args.length === 1 && ["generate", "verify"].includes(args[0]) ? 0 : 1, result.stderr)
  }
  assert.deepEqual(fs.readFileSync(path.join(repo, PROVENANCE)), before)
})

test("captured read-only inputs are revalidated before any publication", (t) => {
  const root = fixture(t)
  fs.writeFileSync(path.join(root, "unchanged"), "original")
  const before = compat.snapshot({ root, paths: ["unchanged", "new"] })
  fs.writeFileSync(path.join(root, "unchanged"), "foreign")
  assert.throws(() => compat.publish({ root, before, artifacts: [{ path: "new", content: Buffer.from("new") }] }), /pre-publish change/)
  assert.equal(fs.existsSync(path.join(root, "new")), false)
})

test("complete final map includes unchanged captured input identity", (t) => {
  const root = fixture(t)
  fs.writeFileSync(path.join(root, "unchanged"), "original")
  const before = compat.snapshot({ root, paths: ["unchanged", "new"] })
  compat.publish({ root, before, artifacts: [{ path: "new", content: Buffer.from("new") }] })
  assert.equal(fs.readFileSync(path.join(root, "unchanged"), "utf8"), "original")
})
