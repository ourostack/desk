import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { createHash } from "node:crypto"
import { EXACT, sameFile } from "../../../../../plugins/desk/mcp/src/util/file-identity.js"

const source = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/publication-state.js"), "utf8")
const block = (source.includes("const FIRST_MONITORS") ? source.slice(source.indexOf("const FIRST_MONITORS")) : "")
  .replaceAll("export async function", "async function")
function systemImageFixture({ size = 3837392, links = 78n, shortRead = 65536, declaredSize, zeroAt,
  expireAt, failAt, closeError = false } = {}) {
  const state = { bytes: Buffer.alloc(size, 0xab), clock: 1000, offset: 0, calls: [], allocations: [],
    counts: {}, alias: "/images/git", links: new Map(), version: {}, fdVersion: {}, errors: [], readLengths: [], opens: [] }
  const event = type => {
    const label = `${type}${state.counts[type] = (state.counts[type] ?? 0) + 1}`
    state.calls.push(label)
    if (label === expireAt) state.clock = 10000
    if (label === failAt || type === "close" && closeError) {
      const error = Object.assign(new Error(label), { code: type === "close" ? "EBADF" : "EIO" })
      state.errors.push(error)
      throw error
    }
    state.afterEvent?.(label)
  }
  const info = file => {
    const directory = ["/", "/tools", "/images"].includes(file), alias = file === "/tools/git" || state.links.has(file)
    if (!directory && !alias && !["/images/git", "/images/other"].includes(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" })
    return { dev: 1n, ino: directory ? 10n : alias ? 4n : file === "/images/git" ? 2n : 3n,
      uid: 0n, gid: 0n, nlink: directory || alias ? 1n : links, mode: directory ? 0o40755n : alias ? 0o120777n : 0o100755n,
      size: directory ? 0n : alias ? 11n : declaredSize ?? BigInt(state.bytes.length),
      mtimeNs: 1n, ctimeNs: 1n, ...(!directory && !alias ? state.version : {}),
      isFile: () => !directory && !alias, isDirectory: () => directory, isSymbolicLink: () => alias }
  }
  const sandbox = { path, createHash, EXACT, sameFile, constants: fs.constants,
    Buffer: new Proxy(Buffer, { get(target, key) {
      if (["alloc", "allocUnsafe", "allocUnsafeSlow"].includes(key)) return (length, ...args) => {
        state.allocations.push(length); return target[key](length, ...args)
      }
      if (["from", "concat"].includes(key)) return (...args) => {
        const bytes = target[key](...args)
        state.allocations.push(bytes.length)
        return bytes
      }
      return Reflect.get(target, key)
    } }),
    Date: class extends Date { static now() {
      if (expireAt === "publish" && state.counts.close && ++state.afterCloseChecks === 2) state.clock = 10000
      return state.clock
    } },
    digest: value => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    fault: code => Object.assign(new Error(code), { code }),
    lstatSync: file => { event("lstat"); return info(file) },
    statSync: file => info(file === "/tools/git" ? state.alias : file),
    realpathSync: file => {
      event("realpath")
      const seen = new Set()
      while (file === "/tools/git" || state.links.has(file)) {
        if (seen.has(file)) throw Object.assign(new Error("loop"), { code: "ELOOP" })
        seen.add(file)
        const target = file === "/tools/git" ? state.alias : state.links.get(file)
        file = path.resolve(path.dirname(file), target)
      }
      return file
    },
    readlinkSync: file => { event("readlink"); return file === "/tools/git" ? state.alias : state.links.get(file) },
    openSync: (file, flags) => {
      state.opens.push({ file, flags }); state.openedFile = file; state.offset = 0; event("open"); return 17
    },
    fstatSync: () => { event("fstat"); return { ...info(state.openedFile), ...state.fdVersion } },
    readSync: (_fd, bytes, offset, length, position) => {
      assert.equal(position, null)
      state.readLengths.push(length)
      const count = state.counts.read + 1 || 1
      const amount = count === zeroAt ? 0 : Math.min(length, shortRead, state.bytes.length - state.offset)
      state.bytes.copy(bytes, offset, state.offset, state.offset + amount)
      state.offset += amount
      event("read")
      return amount
    },
    closeSync: () => event("close"),
  }
  const api = vm.runInNewContext(`${block.replaceAll("export function", "function")}
    ;({role:typeof deriveFirstSystemInput === "function" ? deriveFirstSystemInput : undefined,
      hash:typeof hashFirstSystemImage === "function" ? hashFirstSystemImage : undefined,
      compare:typeof compareFirstSystemImage === "function" ? compareFirstSystemImage : undefined,
      privateRead:readFirstWitness})`, sandbox)
  state.afterCloseChecks = 0
  return { ...api, state, input() {
    assert.equal(typeof api.role, "function", "private system role derivation is missing")
    return api.role({ file: "/tools/git", purpose: "advertised-git", deadline: 10000 })
  } }
}
test("FIRST system image streams all 3837392 bytes with fixed 64KiB storage and a real EOF", () => {
  const f = systemImageFixture(), input = f.input()
  const proof = f.hash({ input, deadline: 10000 })
  assert.equal(proof.kind, "readonly-system-image")
  assert.equal(proof.complete, true)
  assert.equal(proof.byteCount, "3837392")
  assert.equal(proof.targetVersion.nlink, "78")
  assert.equal(proof.sha256, createHash("sha256").update(f.state.bytes).digest("hex"))
  assert.ok(f.state.allocations.length > 0 && f.state.allocations.every(size => size <= 65536))
  assert.ok(f.state.readLengths.every(size => size <= 65536))
  assert.equal(f.state.counts.read, 60)
  assert.equal(f.state.calls.at(-1), "close1")
  assert.equal(f.state.opens[0].file, "/images/git")
  assert.equal(f.state.opens[0].flags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
})
test("FIRST system roles never weaken the single-link or 1MiB private reader", () => {
  const linked = systemImageFixture({ size: 12 })
  linked.input()
  assert.throws(() => linked.privateRead({ path: "/images/git", limit: 1024 * 1024, deadline: 10000 }),
    { code: "producer_witness_unqualified" })
  const large = systemImageFixture({ links: 1n })
  assert.throws(() => large.privateRead({ path: "/images/git", limit: 1024 * 1024, deadline: 10000 }),
    { code: "producer_witness_unqualified" })
  assert.equal(linked.state.counts.open, undefined)
  assert.equal(large.state.counts.open, undefined)
})
test("FIRST system stream accepts short reads but hashes and verifies the entire image", () => {
  const f = systemImageFixture({ size: 131073, shortRead: 777 })
  const proof = f.hash({ input: f.input(), deadline: 10000 })
  assert.equal(proof.byteCount, "131073")
  assert.equal(proof.sha256, createHash("sha256").update(f.state.bytes).digest("hex"))
  assert.equal(f.state.offset, 131073)
  assert.equal(f.state.counts.read, 170)
})
for (const options of [{ zeroAt: 2 }, { declaredSize: 4000000n }, { declaredSize: 100n },
  { declaredSize: 9007199254740993n }, { links: 0n }]) {
  test(`FIRST system stream refuses incomplete EOF/growth/unlinked input ${JSON.stringify(options, (_key, value) =>
    typeof value === "bigint" ? String(value) : value)}`, () => {
    const f = systemImageFixture(options), input = f.input()
    assert.throws(() => f.hash({ input, deadline: 10000 }), error => {
      assert.equal(error.system_input_observation.complete, false)
      assert.equal(typeof error.system_input_observation.byteCount, "string")
      return error.code === "producer_system_input_changed" || error.code === "producer_system_input_unqualified"
    })
    assert.ok((f.state.counts.close ?? 0) <= 1)
  })
}
for (const phase of ["lstat1", "readlink1", "realpath1", "open1", "fstat1", "read1", "read2", "fstat2", "realpath2", "close1"]) {
  test(`FIRST system stream expiry during ${phase} stops subsequent work and settles only its own FD`, () => {
    const f = systemImageFixture({ expireAt: phase }), input = f.input()
    assert.throws(() => f.hash({ input, deadline: 10000 }), error => {
      assert.equal(error.code, "producer_deadline")
      assert.equal(error.system_input_observation.complete, false)
      if (phase === "read1") assert.equal(error.system_input_observation.byteCount, "65536")
      return true
    })
    const after = f.state.calls.slice(f.state.calls.indexOf(phase) + 1)
    assert.ok(after.every(call => call === "close1"))
  })
}
test("FIRST expired system role cannot acquire a descriptor or refresh its original deadline", () => {
  const f = systemImageFixture(), input = f.input()
  f.state.clock = 10000
  assert.throws(() => f.hash({ input, deadline: 10000 }), error =>
    error.code === "producer_deadline" && error.system_input_observation?.byteCount === "0")
  assert.throws(() => f.hash({ input, deadline: 20000 }), { code: "producer_system_input_role_required" })
  assert.equal(f.state.calls.length, 0)
})
test("FIRST system expiry at final digest publication retains complete-read evidence but never a qualified witness", () => {
  const f = systemImageFixture({ size: 12, expireAt: "publish" }), input = f.input()
  assert.throws(() => f.hash({ input, deadline: 10000 }), error =>
    error.code === "producer_deadline" && error.system_input_observation?.complete === false &&
    error.system_input_observation.byteCount === "12" && error.witness_resource.closed === true)
  assert.equal(f.state.counts.close, 1)
})
test("FIRST system read preserves the original read error, exact partial count and secondary close uncertainty", () => {
  const f = systemImageFixture({ failAt: "read2", closeError: true }), input = f.input()
  assert.throws(() => f.hash({ input, deadline: 10000 }), error => {
    assert.equal(error, f.state.errors[0])
    assert.equal(error.code, "EIO")
    assert.equal(error.system_input_observation.byteCount, "65536")
    assert.equal(error.system_input_observation.complete, false)
    assert.equal(error.witness_resource.closed, false)
    assert.equal(error.close_error.code, "EBADF")
    return true
  })
  assert.equal(f.state.counts.close, 1)
})
test("FIRST complete bytes with failed close never yield a successful system witness", () => {
  const f = systemImageFixture({ size: 1, closeError: true }), input = f.input()
  assert.throws(() => f.hash({ input, deadline: 10000 }), error =>
    error.code === "EBADF" && error.system_input_observation.complete === false && error.witness_resource.closed === false)
  assert.equal(f.state.counts.close, 1)
})
test("FIRST system expiry stays primary when settling its descriptor also fails", () => {
  const f = systemImageFixture({ expireAt: "read1", closeError: true }), input = f.input()
  assert.throws(() => f.hash({ input, deadline: 10000 }), error =>
    error.code === "producer_deadline" && error.close_error.code === "EBADF" &&
    error.system_input_observation.byteCount === "65536" && error.witness_resource.closed === false)
  assert.equal(f.state.counts.read, 1)
  assert.equal(f.state.counts.close, 1)
})
test("FIRST system versions preserve BigInt inode precision rather than equating adjacent large identities", () => {
  const f = systemImageFixture({ size: 12 }), input = f.input()
  f.state.version = { ino: 9007199254740993n }
  const expected = f.hash({ input, deadline: 10000 })
  assert.equal(expected.targetVersion.ino, "9007199254740993")
  f.state.version.ino = 9007199254740992n
  assert.equal(f.compare({ input, expected, deadline: 10000 }), false)
})
test("FIRST system comparison rereads bytes despite identical stats and never adopts the changed witness", () => {
  const f = systemImageFixture(), input = f.input(), expected = f.hash({ input, deadline: 10000 })
  assert.equal(f.compare({ input, expected: JSON.parse(JSON.stringify(expected)), deadline: 10000 }), true)
  f.state.bytes[f.state.bytes.length - 1] = 0x11
  assert.equal(f.compare({ input, expected, deadline: 10000 }), false)
  assert.equal(f.compare({ input, expected, deadline: 10000 }), false)
  assert.equal(expected.sha256, createHash("sha256").update(Buffer.alloc(3837392, 0xab)).digest("hex"))
  assert.equal(f.state.counts.close, 4)
})
for (const version of [{ ino: 8n }, { nlink: 79n }, { mode: 0o100700n }, { uid: 1n }, { gid: 1n },
  { mtimeNs: 9n }, { ctimeNs: 9n }]) {
  test(`FIRST system comparison refuses exact version drift ${Object.keys(version)[0]}`, () => {
    const f = systemImageFixture({ size: 32 }), input = f.input(), expected = f.hash({ input, deadline: 10000 })
    f.state.version = version
    assert.equal(f.compare({ input, expected, deadline: 10000 }), false)
  })
}
test("FIRST system role and path/role JSON copies cannot mint a readonly input class", () => {
  const f = systemImageFixture(), input = f.input()
  for (const forged of [{ ...input }, JSON.parse(JSON.stringify(input)),
    { file: "/tools/git", purpose: "advertised-git", kind: "readonly-system-image", allowHardlinks: true }]) {
    assert.throws(() => f.hash({ input: forged, deadline: 10000 }), { code: "producer_system_input_role_required" })
  }
  assert.equal(f.state.calls.length, 0)
})
test("FIRST structural JSON options cannot upgrade an ordinary input role into Mac admission", () => {
  const f = systemImageFixture({ size: 131073 }), input = f.input()
  const proof = f.hash({ input, deadline: 10000, operationEnvironment: {}, mach64: true, kind: "Mach64" })
  assert.equal(proof.complete, true)
  assert.equal(Object.hasOwn(proof, "mach64"), false)
  assert.equal(proof.sha256, createHash("sha256").update(f.state.bytes).digest("hex"))
})
for (const change of ["replace", "mode", "links", "truncate", "grow", "alias", "intermediate-link"]) {
  test(`FIRST in-flight system ${change} drift refuses completion without adopting its path/FD epoch`, () => {
    const f = systemImageFixture({ size: 131072 }), input = f.input()
    if (change === "intermediate-link") {
      f.state.alias = "/images/middle"
      f.state.links.set("/images/middle", "/images/git")
    }
    f.state.afterEvent = label => {
      if (label !== "read1") return
      if (change === "replace") { f.state.version = { ino: 8n }; f.state.fdVersion = { ino: 2n } }
      if (change === "mode") f.state.version = { mode: 0o100700n }
      if (change === "links") f.state.version = { nlink: 79n }
      if (change === "truncate") f.state.bytes = f.state.bytes.subarray(0, 65536)
      if (change === "grow") f.state.bytes = Buffer.alloc(131073, 0xab)
      if (change === "alias") f.state.alias = "/images/other"
      if (change === "intermediate-link") f.state.links.set("/images/middle", "/images/./git")
    }
    assert.throws(() => f.hash({ input, deadline: 10000 }), { code: "producer_system_input_changed" })
    assert.equal(f.state.counts.close, 1)
  })
}
test("FIRST system input resolves each symlink epoch and refuses cycles before acquiring an FD", () => {
  const f = systemImageFixture({ size: 12 }), input = f.input()
  f.state.alias = "/images/middle"
  f.state.links.set("/images/middle", "../images/git")
  const proof = f.hash({ input, deadline: 10000 })
  assert.equal(proof.real, "/images/git")
  assert.ok(proof.pathLinks.some(entry => entry.file === "/images/middle" && entry.link === "../images/git"))
  f.state.links.set("/images/middle", "/tools/git")
  assert.throws(() => f.hash({ input, deadline: 10000 }), { code: "producer_system_input_unqualified" })
  assert.equal(f.state.counts.open, 1)
})

function invocationDiscoveryFixture({ wrapper = false, changesDuringProbe = false } = {}) {
  const image = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])
  const state = { calls: [], epoch: 1n, offsets: new Map() }
  const info = file => {
    const directory = ["/", "/tools", "/actual"].includes(file)
    if (!directory && !["/tools/git", "/actual/git"].includes(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" })
    return { dev: 1n, ino: file === "/actual/git" ? 3n : directory ? 10n : 2n,
      nlink: 1n, uid: 0n, gid: 0n, mode: directory ? 0o40700n : 0o100700n,
      size: directory ? 0n : BigInt(image.length), mtimeNs: state.epoch, ctimeNs: state.epoch,
      isFile: () => !directory, isDirectory: () => directory }
  }
  const sandbox = {
    Buffer, path, createHash, EXACT, sameFile, constants: fs.constants,
    Date: class extends Date { static now() { return 1000 } },
    digest: value => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    fault: code => Object.assign(new Error(code), { code }),
    lstatSync: info, statSync: info, realpathSync: file => file, accessSync() {},
    openSync: file => { state.offsets.set(file, 0); return file }, fstatSync: info, closeSync() {},
    readSync: (file, buffer, offset, length, position) => {
      const start = position ?? state.offsets.get(file), count = Math.min(length, image.length - start)
      image.copy(buffer, offset, start, start + count)
      if (position === null) state.offsets.set(file, start + count)
      return count
    },
    spawnSync: (_command, args) => {
      state.calls.push(args)
      if (changesDuringProbe) state.epoch++
      return { status: 0, signal: null, stderr: "", stdout: args.includes("--version")
        ? "git version 2.54.0\n" : wrapper ? "/actual\n" : "/tools\n" }
    },
  }
  const discover = vm.runInNewContext(`${block.replaceAll("export function", "function")}
    ;typeof discoverFirstInvocation === "function" ? discoverFirstInvocation : undefined`, sandbox)
  return { state, discover }
}
test("FIRST invocation discovery refuses a dispatcher whose selected Git implementation is a different inode", () => {
  const f = invocationDiscoveryFixture({ wrapper: true })
  assert.equal(typeof f.discover, "function")
  assert.throws(() => f.discover({ root: "/owned", env: { PATH: "/tools" }, deadline: 10000 }),
    { code: "producer_invocation_unqualified" })
})
test("FIRST direct invocation discovery seals the executable and helper identity around its reference probes", () => {
  const f = invocationDiscoveryFixture()
  assert.equal(typeof f.discover, "function")
  const result = f.discover({ root: "/owned", env: { PATH: "/tools" }, deadline: 10000 })
  assert.equal(result.executable, "/tools/git")
  assert.equal(result.execPath, "/tools")
  assert.equal(result.queries.length, 2)
  assert.ok(result.captureEpochs.records.some(record => record.path === "/tools"))
})
test("FIRST invocation probe rejects executable/lookup epoch changes rather than accepting matching output", () => {
  const f = invocationDiscoveryFixture({ changesDuringProbe: true })
  assert.equal(typeof f.discover, "function")
  assert.throws(() => f.discover({ root: "/owned", env: { PATH: "/tools" }, deadline: 10000 }),
    { code: "producer_currentness_changed" })
  assert.equal(f.state.calls.length, 1)
})
test("FIRST initial invocation seals ancestor lookup epochs, not just the executable's immediate directory", () => {
  const f = invocationDiscoveryFixture()
  const result = f.discover({ root: "/owned", env: { PATH: "/tools" }, deadline: 10000 })
  assert.ok(result.captureEpochs.records.some(record => record.path === "/"))
})
function witness({ expire = false, closeError = false, queryChanges = false, queryExpires = false, queryOutput = "OBSERVED\n",
  configQueries = false, lookupChanges = false, content = Buffer.from("CFG é\n"), executable = false, authorityQueries = false,
  captureDirectories = false } = {}) {
  const state = { clock: 1000, calls: [], content, lookupVersion: 1n, offset: 0 }
  const stat = { dev: 1n, ino: 2n, nlink: 1n, uid: 0n, gid: 0n, mode: executable ? 0o100700n : 0o100600n, size: BigInt(state.content.length),
    mtimeNs: 1n, ctimeNs: 1n, isFile: () => true, isDirectory: () => false }
  const directory = file => ["/", "/one", "/two"].includes(file) ||
    captureDirectories && ["/owned", "/owned/.git", "/admin", "/common", "/remote"].includes(file)
  const sandbox = { Buffer, EXACT, sameFile, path, createHash,
    digest: value => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    fault: code => Object.assign(new Error(code), { code }),
    contexts: new WeakMap(),
    Date: class extends Date { static now() { return state.clock } },
    constants: fs.constants,
    lstatSync: file => {
      state.calls.push("lstat")
      if (file === "/one/git") throw Object.assign(new Error("missing"), { code: "ENOENT" })
      return directory(file) ? { ...stat, mode: 0o40700n, mtimeNs: state.lookupVersion, ctimeNs: state.lookupVersion,
        isDirectory: () => true, isFile: () => false } : stat
    },
    realpathSync: file => file, statSync: file => directory(file) ? { ...stat, isDirectory: () => true, isFile: () => false } : stat,
    accessSync: () => { state.calls.push("access") },
    fstatSync: () => { state.calls.push("fstat"); return stat },
    openSync: () => { state.calls.push("open"); state.offset = 0; return 17 },
    readSync: (_fd, bytes, offset, length, position) => {
      const start = position ?? state.offset, count = Math.min(length, state.content.length - start)
      state.calls.push("read"); state.content.copy(bytes, offset, start, start + count)
      if (position === null) state.offset += count
      if (expire) state.clock = 10000
      return count
    },
    spawnSync: (_command, args) => {
      state.calls.push("git")
      if (queryChanges) state.content = Buffer.from("BAD é\n")
      if (queryExpires) state.clock = 10000
      if (lookupChanges) state.lookupVersion++
      const output = configQueries ? `file:${args[args.indexOf("--file") + 1]}\0core.bare\nfalse\0` : queryOutput
      const query = args[0] === "-C" ? args.slice(2) : args.slice(1)
      const row = authorityQueries ? referenceOutputsFixture().observations.find(value =>
        JSON.stringify(value.args) === JSON.stringify(query) && (value.gitDir ?? null) ===
          (args[0].startsWith("--git-dir=") ? args[0].slice("--git-dir=".length) : null)) : null
      return { status: 0, signal: null, stdout: row?.stdout ?? output, stderr: "" }
    },
    closeSync: () => {
      state.calls.push("close")
      if (closeError) throw Object.assign(new Error("Close refused"), { code: "EIO" })
    },
  }
  const contextGuard = source.slice(source.indexOf("function contextOf("), source.indexOf("/** Created by trusted server"))
  const api = vm.runInNewContext(`${contextGuard}\n${block.replaceAll("export function", "function")}
    ;({read:typeof readFirstWitness === "function" ? readFirstWitness : undefined,
      snapshot:typeof firstFileProof === "function" ? firstFileProof : undefined,
      scan:typeof scanFirstSaveFootprint === "function" ? scanFirstSaveFootprint : undefined,
      inspect:typeof inspectFirstReference === "function" ? inspectFirstReference : undefined,
      seal:typeof sealFirstReferencePass === "function" ? sealFirstReferencePass : undefined,
      configInputs:typeof firstConfigInputs === "function" ? firstConfigInputs : undefined,
      defaultInputs:typeof firstConfigDefaultInputs === "function" ? firstConfigDefaultInputs : undefined,
      configClosure:typeof discoverFirstConfigClosure === "function" ? discoverFirstConfigClosure : undefined,
      lookupEpochs:typeof firstLookupEpochs === "function" ? firstLookupEpochs : undefined,
      referenceOutputs:typeof validateFirstReferenceOutputs === "function" ? validateFirstReferenceOutputs : undefined,
      invocationLookup:typeof firstInvocationLookup === "function" ? firstInvocationLookup : undefined,
      authorityCapture:typeof captureFirstAuthorityQueries === "function" ? captureFirstAuthorityQueries : undefined,
      captureRecords:typeof firstCaptureInputRecords === "function" ? firstCaptureInputRecords : undefined,
      resolution:typeof firstGitResolution === "function" ? firstGitResolution : undefined,
      retainObservation:typeof retainFirstInputObservation === "function" ? retainFirstInputObservation : undefined,
      assertObservation:typeof assertFirstInputObservation === "function" ? assertFirstInputObservation : undefined,
      closeObservation:typeof closeFirstInputObservation === "function" ? closeFirstInputObservation : undefined})`, sandbox)
  const context = Object.freeze(Object.create(null))
  const owner = { active: true, root: "/owned", person: null, env: {},
    rootIdentity: createHash("sha256").update(JSON.stringify({ root: "/owned", dev: 1, ino: 2, gitDev: 1, gitIno: 2, gitFile: null })).digest("hex") }
  sandbox.contexts.set(context, owner)
  return { state, context, owner, ...api }
}
for (const change of ["unchanged", "bytes", "result", "expiry"]) {
  test(`FIRST sealing ${change} pins S0 before reference and refuses late adoption`, () => {
    const f = witness({ queryChanges: change === "bytes", queryExpires: change === "expiry",
      queryOutput: change === "result" ? "SUBSTITUTED\n" : "OBSERVED\n" })
    assert.equal(typeof f.seal, "function")
    const discovered = {
      version: 1, envDigest: createHash("sha256").update("{}").digest("hex"),
      records: [{ path: "/cfg", contents: true, proof: f.snapshot({ path: "/cfg", contents: true, deadline: 10000 }) }],
      queries: [{ args: ["config", "--list"], gitDir: null, stdout: "OBSERVED\n" }],
      complete: true,
    }
    const operation = () => f.seal({ root: "/owned", env: {}, discovered, deadline: 10000 })
    if (change === "unchanged") assert.equal(operation().observations[0].stdout, "OBSERVED\n")
    else assert.throws(operation, { code: change === "expiry" ? "producer_deadline" : "producer_currentness_changed" })
  })
}

test("FIRST reference sealing rejects an incomplete discovery closure before running any query", () => {
  const f = witness()
  assert.throws(() => f.seal({ root: "/owned", env: {}, discovered: {
    envDigest: createHash("sha256").update("{}").digest("hex"),
    records: [{ path: "/cfg", contents: true, proof: f.snapshot({ path: "/cfg", contents: true, deadline: 10000 }) }],
    queries: [{ args: ["config", "--list"], gitDir: null, stdout: "OBSERVED\n" }],
    unresolvedDependencies: ["/missing/config.worktree"],
  }, deadline: 10000 }), { code: "producer_currentness_unqualified" })
  assert.equal(f.state.calls.filter(call => call === "git").length, 0)
})

test("FIRST witness reader has an inner original-deadline guard", () => {
  const f = witness()
  assert.equal(typeof f.read, "function")
  assert.equal(f.read({ path: "/cfg", limit: 1024, deadline: 10000 }), "CFG é\n")
})
test("FIRST executable input read preserves exact binary bytes instead of UTF8 replacement characters", () => {
  const content = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0xfe, 0, 0x81]), f = witness({ content })
  const output = f.read({ path: "/binary", limit: 1024, deadline: 10000, binary: true })
  assert.equal(Buffer.isBuffer(output), true)
  assert.equal(output.equals(content), true)
})
test("FIRST binary footprint hashes raw input and refuses changed invalid-UTF8 bytes", () => {
  const initial = Buffer.from([0xff, 0, 0xfe]), f = witness({ content: initial })
  const proof = f.snapshot({ path: "/binary", binary: true, deadline: 10000 })
  assert.equal(proof.sha256, createHash("sha256").update(initial).digest("hex"))
  f.state.content = Buffer.from([0x81, 0, 0x82])
  assert.throws(() => f.scan({ footprint: { records: [{ path: "/binary", binary: true, proof }] }, deadline: 10000 }),
    { code: "producer_currentness_changed" })
})
for (const value of [undefined, "", ".:/bin", "/one::/two", "relative"]) {
  test(`FIRST invocation lookup refuses incomplete or cwd-relative PATH ${String(value)}`, () => {
    const f = witness()
    assert.equal(typeof f.invocationLookup, "function")
    assert.throws(() => f.invocationLookup({ env: { PATH: value }, deadline: 10000 }),
      { code: "producer_invocation_unqualified" })
    assert.equal(f.state.calls.includes("git"), false)
  })
}
test("FIRST invocation lookup records earlier absences and exact selected executable bytes without qualifying a wrapper", () => {
  const bytes = Buffer.from("UNQUALIFIED EXECUTABLE BYTES"), f = witness({ executable: true, content: bytes })
  const result = f.invocationLookup({ env: { PATH: "/one:/two" }, deadline: 10000 })
  assert.equal(result.executable, "/two/git")
  assert.equal(result.records[0].proof.absent, true)
  assert.equal(result.records[1].proof.sha256, createHash("sha256").update(bytes).digest("hex"))
  assert.equal(result.implementationQualified, false)
  assert.equal(f.state.calls.includes("git"), false)
})
test("FIRST capture refuses transient lookup changes even when the final input bytes match", () => {
  const f = witness({ lookupChanges: true })
  assert.equal(typeof f.lookupEpochs, "function")
  const record = { path: "/cfg", contents: true, proof: f.snapshot({ path: "/cfg", contents: true, deadline: 10000 }) }
  const epochs = f.lookupEpochs({ records: [record], deadline: 10000 })
  assert.throws(() => f.inspect({ root: "/owned", env: {}, args: ["config", "--list"], deadline: 10000,
    footprint: { records: [record], envDigest: createHash("sha256").update("{}").digest("hex") },
    captureEpochs: epochs }), { code: "producer_currentness_changed" })
})
for (const change of ["unchanged", "bytes", "deadline"]) {
  test(`FIRST reference query ${change} binds its actual result to pre/post input witnesses`, () => {
    const f = witness({ queryChanges: change === "bytes", queryExpires: change === "deadline" })
    assert.equal(typeof f.inspect, "function")
    const proof = f.snapshot({ path: "/cfg", contents: true, deadline: 10000 })
    f.state.calls.length = 0
    const operation = () => f.inspect({ root: "/owned", env: {}, args: ["config", "--list"],
      footprint: { envDigest: createHash("sha256").update("{}").digest("hex"),
        records: [{ path: "/cfg", contents: true, proof }] }, deadline: 10000 })
    if (change === "bytes") assert.throws(operation, { code: "producer_currentness_changed" })
    else if (change === "deadline") {
      assert.throws(operation, { code: "producer_deadline" })
      assert.equal(f.state.calls.at(-1), "git")
    } else assert.equal(operation().stdout, "OBSERVED\n")
    assert.equal(f.state.calls.filter(call => call === "git").length, 1)
  })
}
function terminalFixture(change = null) {
  const producer = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/producer-state.js"), "utf8")
  const begin = producer.indexOf("function validateFirstBodyTerminalReport(")
  const end = producer.indexOf("\nfunction bodyObservation(", begin)
  const text = begin < 0 ? "" : producer.slice(begin, end)
  const validate = vm.runInNewContext(`${text}\n;typeof validateFirstBodyTerminalReport === "function" ? validateFirstBodyTerminalReport : undefined`, {
    Date: class extends Date { static now() { return 1000 } },
    fault: code => Object.assign(new Error(code), { code }),
    digest: value => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  })
  const id = "11111111-1111-4111-8111-111111111111"
  const record = { id, root: "/owned", createdAtMs: 0, producerDeadline: 10000, publicationDeadline: 60000,
    kind: "desk-save", state: "accepted", bodyHistory: [], bodyFiles: [] }
  const candidate = { kind: "body-outcome", schema_version: 2, operationId: id, producerDeadline: 10000,
    publicationDeadline: 60000, outcome: { state: "body_settled", reason: "nothing_to_commit",
      attribution: "provisional", publication: "not_started",
      protocol: { lastIntentSequence: 0, lastApprovalAckSequence: 0, lastCompletedSequence: 0 },
      effects: { status: "unknown", readback_required: true, applied_paths: [], uncertain_paths: [], open_files: [], dispatches: [] }, command: null, proof: null,
      noOpWitness: { selectedChangedPaths: [], status: 0, error: null, signal: null } } }
  if (change === "deadline") candidate.producerDeadline = 11000
  if (change === "state") candidate.outcome.state = "success"
  if (change === "command") candidate.outcome.command = { status: 0, error: null }
  if (change === "sequence") candidate.outcome.protocol.lastIntentSequence = 1
  if (change === "active") record.bodyPhase = { sequence: 1, phase: "open", state: "unknown" }
  if (change === "noop") candidate.outcome.noOpWitness.status = 1
  return { validate, candidate, record }
}
function commandEnvironment({ baseEnv = { PATH: "/tools" }, commandEnv, indexPath = null }) {
  const text = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/producer-state.js"), "utf8")
  const start = text.indexOf("function compareFirstCommandEnvironment("), end = text.indexOf("\nexport function assertFirstCommandEnvironment(", start)
  const compare = vm.runInNewContext(`${start < 0 ? "" : text.slice(start, end)}
    ;typeof compareFirstCommandEnvironment === "function" ? compareFirstCommandEnvironment : undefined`, {
      fault: code => Object.assign(new Error(code), { code }),
    })
  assert.equal(typeof compare, "function")
  return compare({ baseEnv, commandEnv, operationId: "owned", indexPath })
}
test("FIRST command environment permits only its fixed base and the documented operation-local overlays", () => {
  commandEnvironment({ commandEnv: { PATH: "/tools", DESK_TOOL_COMMIT: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_REFLOG_ACTION: "desk-publication:owned" } })
})
for (const extra of [{ PATH: "/other" }, { GIT_CONFIG_COUNT: "1" }, { GIT_INDEX_FILE: "/foreign/index" },
  { GIT_REFLOG_ACTION: "changed" }, { DESK_TOOL_COMMIT: "0" }]) {
  test(`FIRST command environment rejects substituted actual spawn inputs ${JSON.stringify(extra)}`, () => {
    assert.throws(() => commandEnvironment({ commandEnv: { PATH: "/tools", DESK_TOOL_COMMIT: "1",
      GIT_TERMINAL_PROMPT: "0", ...extra } }), { code: "producer_command_environment_changed" })
  })
}
test("FIRST command environment keeps caller reflog action exact and requires the privately registered index path", () => {
  commandEnvironment({ baseEnv: { PATH: "/tools", GIT_REFLOG_ACTION: "caller exact" },
    commandEnv: { PATH: "/tools", GIT_REFLOG_ACTION: "caller exact", DESK_TOOL_COMMIT: "1",
      GIT_TERMINAL_PROMPT: "0", GIT_INDEX_FILE: "/private/index" }, indexPath: "/private/index" })
  assert.throws(() => commandEnvironment({ baseEnv: { PATH: "/tools", GIT_REFLOG_ACTION: "caller exact" },
    commandEnv: { PATH: "/tools", GIT_REFLOG_ACTION: "desk-publication:owned", DESK_TOOL_COMMIT: "1",
      GIT_TERMINAL_PROMPT: "0" } }), { code: "producer_command_environment_changed" })
})
function commandTerminal({ failed = false, status = 0, signal = null, active = false, wrongProof = false } = {}) {
  const f = terminalFixture()
  const proof = { parent: "a".repeat(40), expected: [{ path: "owned.md", sha: "b".repeat(40), mode: "100644", stage: "0" }],
    exactPaths: ["owned.md"], branch: "refs/heads/main", witness: `desk-publication:${f.record.id}` }
  const commit = { phase: "commit", sequence: 1, state: active ? "unknown" : "completed", detail: { proof } }
  f.record.bodyHistory = [commit]; f.record.bodyPhase = commit
  f.candidate.outcome = {
    state: failed ? "blocked" : "body_settled", reason: failed ? "EIO" : null,
    attribution: "provisional", publication: "not_started",
    protocol: { lastIntentSequence: 1, lastApprovalAckSequence: 1, lastCompletedSequence: active ? 0 : 1 },
    effects: { status: "unknown", readback_required: true, applied_paths: [], uncertain_paths: [], open_files: [],
      dispatches: [{ id: f.record.id, sequence: 1, phase: "commit", producerDeadline: 10000, detail: { proof }, state: active ? "unknown" : "completed" }] },
    command: { status, error: null, signal, output: {
      stdout: { bytes: 0, sha256: "c".repeat(64), rawRetained: false },
      stderr: { bytes: 0, sha256: "c".repeat(64), rawRetained: false } } },
    proof: wrongProof ? { ...proof, parent: "d".repeat(40) } : proof,
    ...(failed ? { failure: { code: "EIO", stage: "report", phase: "commit", intentSequence: 1, dispatchState: active ? "unknown" : "completed" } } : {}),
  }
  return f
}
for (const options of [{}, { status: 1 }, { signal: "SIGTERM" }, { active: true }, { wrongProof: true },
  { failed: true, status: 1 }, { failed: true, status: 0 }, { failed: true, active: true, status: null }]) {
  test(`FIRST command terminal predicate ${JSON.stringify(options)} preserves success/failure separation`, () => {
    const f = commandTerminal(options)
    const operation = () => f.validate({ candidate: f.candidate, record: f.record, phaseSequence: 1 })
    if (!options.failed && (options.status === 1 || options.signal || options.active || options.wrongProof)) {
      assert.throws(operation, { code: "producer_terminal_report_invalid" })
    } else {
      const output = operation()
      assert.equal(output.state, options.failed ? "blocked" : "body_settled")
      assert.equal(output.command.status, Object.hasOwn(options, "status") ? options.status : 0)
    }
  })
}
for (const change of ["foreign-path", "raw-output", "unknown-descriptor", "completion-ahead", "failure-code",
  "failure-stage", "duplicate-terminal", "raw-envelope", "invented-dispatch", "raw-effects"]) {
  test(`FIRST terminal rejects ${change} before its data can change completion observations`, () => {
    const f = commandTerminal({ failed: true, status: 1 })
    f.record.payloadManifest = { paths: ["owned.md"], files: [] }
    if (change === "foreign-path") f.candidate.outcome.effects.applied_paths = ["../foreign.md"]
    if (change === "raw-output") f.candidate.outcome.command.output.stderr.raw = "PRIVATE"
    if (change === "unknown-descriptor") f.candidate.outcome.effects.open_files = [{ path: "/owned/owned.md", relativePath: "owned.md", descriptor: 99, closed: false }]
    if (change === "completion-ahead") f.candidate.outcome.protocol.lastCompletedSequence = 2
    if (change === "failure-code") f.candidate.outcome.failure.code = "arbitrary"
    if (change === "failure-stage") f.candidate.outcome.failure.stage = "success"
    if (change === "duplicate-terminal") f.record.terminalReportDigest = "already-accepted"
    if (change === "raw-envelope") f.candidate.stdout = "PRIVATE"
    if (change === "invented-dispatch") f.candidate.outcome.effects.dispatches.push({
      id: f.record.id, sequence: 2, phase: "write", producerDeadline: 10000, detail: { path: "owned.md" }, state: "completed" })
    if (change === "raw-effects") f.candidate.outcome.effects.message = "PRIVATE"
    assert.throws(() => f.validate({ candidate: f.candidate, record: f.record, phaseSequence: 1 }),
      { code: change === "duplicate-terminal" ? "producer_report_duplicate" : "producer_terminal_report_invalid" })
  })
}
for (const change of [null, "deadline", "state", "command", "sequence", "active", "noop"]) {
  test(`FIRST terminal ${change ?? "valid no-op"} predicate validates before observation`, () => {
    const f = terminalFixture(change)
    assert.equal(typeof f.validate, "function")
    if (change) assert.throws(() => f.validate({ candidate: f.candidate, record: f.record, phaseSequence: 0 }),
      { code: "producer_terminal_report_invalid" })
    else assert.equal(f.validate({ candidate: f.candidate, record: f.record, phaseSequence: 0 }).state, "body_settled")
  })
}
test("FIRST exact footprint rechecks actual bytes and prevents the next item after expiry", () => {
  const f = witness()
  assert.equal(typeof f.snapshot, "function")
  assert.equal(typeof f.scan, "function")
  const proof = f.snapshot({ path: "/cfg", contents: true, deadline: 10000 })
  f.scan({ footprint: { records: [{ path: "/cfg", contents: true, proof }] }, deadline: 10000 })
  const expired = witness({ expire: true })
  assert.throws(() => expired.scan({ footprint: { records: [
    { path: "/cfg", contents: true, proof }, { path: "/next", contents: true, proof },
  ] }, deadline: 10000 }), { code: "producer_deadline" })
  assert.equal(expired.state.calls.filter(call => call === "read").length, 1)
})
test("expiry inside witness data read prevents following stat/read but closes its own readonly descriptor", () => {
  const f = witness({ expire: true })
  assert.equal(typeof f.read, "function")
  assert.throws(() => f.read({ path: "/cfg", limit: 1024, deadline: 10000 }), { code: "producer_deadline" })
  assert.deepEqual(f.state.calls, ["lstat", "open", "fstat", "read", "close"])
})
test("witness close failure preserves original deadline as primary evidence", () => {
  const f = witness({ expire: true, closeError: true })
  assert.equal(typeof f.read, "function")
  assert.throws(() => f.read({ path: "/cfg", limit: 1024, deadline: 10000 }), error =>
    error.code === "producer_deadline" && error.close_error.code === "EIO")
  assert.equal(f.state.calls.at(-1), "close")
})
test("FIRST config discovery records active origins and inactive conditional include inputs", () => {
  const f = witness()
  assert.equal(typeof f.configInputs, "function")
  const inputs = f.configInputs({ root: "/owned", env: { HOME: "/private-home" }, deadline: 10000,
    output: "file:.git/config\0remote.origin.url\n/local/bare\0file:.git/config\0includeif.onbranch:other.path\n../inactive.cfg\0" })
  assert.deepEqual(Array.from(inputs.map(input => input.path)), ["/owned/.git/config", "/owned/inactive.cfg"])
})
for (const value of ["%(prefix)/unknown", "~other/unknown"]) {
  test(`FIRST config discovery refuses unresolved expansion ${value}`, () => {
    const f = witness()
    assert.equal(typeof f.configInputs, "function")
    assert.throws(() => f.configInputs({ root: "/owned", env: { HOME: "/home" }, deadline: 10000,
      output: `file:.git/config\0include.path\n${value}\0` }), { code: "producer_currentness_unqualified" })
  })
}
test("FIRST config discovery refuses incomplete origin/value framing", () => {
  const f = witness()
  assert.equal(typeof f.configInputs, "function")
  assert.throws(() => f.configInputs({ root: "/owned", env: {}, deadline: 10000,
    output: "file:.git/config\0" }), { code: "producer_currentness_unqualified" })
})
test("FIRST config discovery refuses an unsupported conditional input instead of declaring its closure complete", () => {
  const f = witness()
  assert.throws(() => f.configInputs({ root: "/owned", env: { HOME: "/home" }, deadline: 10000,
    output: "file:.git/config\0includeif.unknown-selector:outside.path\n/private/conditional\0" }),
    { code: "producer_currentness_unqualified" })
})
test("FIRST default config closure includes absent common/worktree/HOME/XDG/system input locations", () => {
  const f = witness()
  assert.equal(typeof f.defaultInputs, "function")
  const inputs = f.defaultInputs({ env: { HOME: "/home", XDG_CONFIG_HOME: "/xdg" }, admin: "/admin", common: "/common",
    globalPaths: ["/home/.gitconfig", "/xdg/git/config"], systemPaths: ["/etc/gitconfig"], deadline: 10000 })
  assert.deepEqual(Array.from(inputs.map(value => value.path)), [
    "/common/config", "/admin/config.worktree", "/home/.gitconfig", "/xdg/git/config", "/etc/gitconfig",
  ])
})
test("FIRST config closure refuses unknown system search locations rather than claiming absent policy", () => {
  const f = witness()
  assert.equal(typeof f.defaultInputs, "function")
  assert.throws(() => f.defaultInputs({ env: { HOME: "/home" }, admin: "/admin", common: "/common",
    globalPaths: ["/home/.gitconfig"], deadline: 10000 }), { code: "producer_currentness_unqualified" })
})
test("FIRST explicit false NOSYSTEM does not hide system config closure", () => {
  const f = witness()
  assert.throws(() => f.defaultInputs({ env: { HOME: "/home", GIT_CONFIG_NOSYSTEM: "0" }, admin: "/admin", common: "/common",
    globalPaths: ["/home/.gitconfig"], deadline: 10000 }), { code: "producer_currentness_unqualified" })
})
test("FIRST config closure snapshots origins/defaults before querying each individual include graph", () => {
  const f = witness({ configQueries: true })
  assert.equal(typeof f.configClosure, "function")
  const result = f.configClosure({ root: "/owned", env: {}, deadline: 10000,
    initialOutput: "file:/cfg\0include.path\n/declared\0",
    defaults: [{ path: "/default", contents: true }] })
  assert.deepEqual(Array.from(result.records.map(record => record.path)), ["/cfg", "/declared", "/default"])
  assert.equal(result.queries.length, 3)
  assert.equal(f.state.calls.filter(call => call === "git").length, 3)
})
test("FIRST provisional config query changing a held source refuses before graph expansion", () => {
  const f = witness({ configQueries: true, queryChanges: true })
  assert.equal(typeof f.configClosure, "function")
  assert.throws(() => f.configClosure({ root: "/owned", env: {}, deadline: 10000,
    initialOutput: "file:/cfg\0include.path\n/declared\0", defaults: [] }), { code: "producer_currentness_changed" })
  assert.equal(f.state.calls.filter(call => call === "git").length, 1)
})
test("FIRST config discovery does not reset a captured lookup epoch after a query changes it", () => {
  const f = witness({ configQueries: true, lookupChanges: true })
  assert.throws(() => f.configClosure({ root: "/owned", env: {}, deadline: 10000,
    initialOutput: "file:/cfg\0include.path\n/declared\0", defaults: [] }), { code: "producer_currentness_changed" })
  assert.equal(f.state.calls.filter(call => call === "git").length, 1)
})
test("FIRST provisional authority capture executes the original dependent query plan under input witnesses", () => {
  const f = witness({ authorityQueries: true }), env = { GIT_CONFIG_NOSYSTEM: "1" }
  assert.equal(typeof f.authorityCapture, "function")
  const proof = f.snapshot({ path: "/cfg", contents: true, deadline: 10000 })
  const result = f.authorityCapture({ root: "/owned", env, resolution: { admin: { real: "/admin" }, common: { real: "/common" } },
    destination: { route: "/remote", real: "/remote" },
    footprint: { records: [{ path: "/cfg", contents: true, proof }],
      envDigest: createHash("sha256").update(JSON.stringify(env)).digest("hex") }, deadline: 10000 })
  assert.equal(result.observations.length, 20)
  assert.equal(result.reference.branch, "refs/heads/main")
  assert.equal(result.reference.serverHooks.length, 6)
  assert.equal(f.state.calls.filter(call => call === "git").length, 20)
})
test("FIRST authority discovery aborts before a dependent query after original input mutation", () => {
  const f = witness({ authorityQueries: true, queryChanges: true }), env = { GIT_CONFIG_NOSYSTEM: "1" }
  assert.equal(typeof f.authorityCapture, "function")
  const proof = f.snapshot({ path: "/cfg", contents: true, deadline: 10000 })
  assert.throws(() => f.authorityCapture({ root: "/owned", env, resolution: { admin: { real: "/admin" }, common: { real: "/common" } },
    footprint: { records: [{ path: "/cfg", contents: true, proof }],
      envDigest: createHash("sha256").update(JSON.stringify(env)).digest("hex") }, deadline: 10000 }),
    { code: "producer_currentness_changed" })
  assert.equal(f.state.calls.filter(call => call === "git").length, 1)
})
test("FIRST capture assembly binds resolved policy/default/hook paths before reference dispatch", () => {
  const f = witness({ captureDirectories: true })
  assert.equal(typeof f.captureRecords, "function")
  const reference = { branch: "refs/heads/main", referenceHook: "/hook", localPushHook: "/pre-push",
    serverRoot: "/remote", serverHooks: ["/remote/hooks/update"], globalPaths: ["/home/.gitconfig"] }
  const env = { HOME: "/home", GIT_CONFIG_NOSYSTEM: "1", GIT_DIR: "/admin", GIT_COMMON_DIR: "/common" }
  const resolution = f.resolution({ root: "/owned", env, deadline: 10000 })
  const result = f.captureRecords({ root: "/owned", env,
    resolution, reference, configRecords: [{ path: "/cfg", contents: true,
      proof: f.snapshot({ path: "/cfg", contents: true, deadline: 10000 }) }],
    invocationRecords: [], deadline: 10000 })
  const names = Array.from(result.map(record => record.path))
  assert.ok(names.includes("/admin/HEAD"))
  assert.ok(names.includes("/common/config"))
  assert.ok(names.includes("/admin/config.worktree"))
  assert.ok(names.includes("/hook"))
  assert.ok(names.includes("/pre-push"))
  assert.ok(names.includes("/remote/config"))
  assert.ok(names.includes("/remote/hooks/update"))
  assert.ok(names.includes("/home/.gitconfig"))
})
test("FIRST capture assembly refuses stale admin/common resolution rather than attaching fresh unrelated witnesses", () => {
  const f = witness({ captureDirectories: true })
  const env = { HOME: "/home", GIT_CONFIG_NOSYSTEM: "1", GIT_DIR: "/admin", GIT_COMMON_DIR: "/common" }
  const resolution = f.resolution({ root: "/owned", env, deadline: 10000 })
  resolution.admin.real = "/foreign"
  assert.throws(() => f.captureRecords({ root: "/owned", env, resolution,
    reference: { branch: "refs/heads/main", referenceHook: "/hook", localPushHook: "/pre-push", globalPaths: [] },
    configRecords: [], invocationRecords: [], deadline: 10000 }), { code: "producer_currentness_changed" })
})
test("FIRST private input observation keeps actual sealed provenance, rejects clones, and rechecks without Git", () => {
  const f = witness({ captureDirectories: true })
  assert.equal(typeof f.retainObservation, "function")
  const proof = f.snapshot({ path: "/cfg", contents: true, deadline: 10000 })
  const sealed = f.seal({ root: "/owned", env: {}, discovered: {
    envDigest: createHash("sha256").update("{}").digest("hex"),
    records: [{ path: "/cfg", contents: true, proof }],
    queries: [{ args: ["config", "--list"], stdout: "OBSERVED\n" }],
  }, deadline: 10000 })
  assert.throws(() => f.retainObservation({ context: f.context, sealed: JSON.parse(JSON.stringify(sealed)),
    operationId: "owned", producerDeadline: 10000 }), { code: "producer_currentness_unqualified" })
  const monitor = f.retainObservation({ context: f.context, sealed, operationId: "owned", producerDeadline: 10000 })
  const before = f.state.calls.filter(call => call === "git").length
  for (let index = 0; index < 10; index++) f.assertObservation({ monitor, operationId: "owned", producerDeadline: 10000 })
  assert.equal(f.state.calls.filter(call => call === "git").length, before)
  assert.throws(() => f.assertObservation({ monitor: JSON.parse(JSON.stringify(monitor)),
    operationId: "owned", producerDeadline: 10000 }), { code: "producer_currentness_unqualified" })
  f.closeObservation(monitor)
  assert.throws(() => f.assertObservation({ monitor, operationId: "owned", producerDeadline: 10000 }),
    { code: "producer_currentness_unqualified" })
})
test("FIRST private input observation refuses changed current bytes instead of refreshing its capture", () => {
  const f = witness({ captureDirectories: true })
  assert.equal(typeof f.retainObservation, "function")
  const proof = f.snapshot({ path: "/cfg", contents: true, deadline: 10000 })
  const sealed = f.seal({ root: "/owned", env: {}, discovered: {
    envDigest: createHash("sha256").update("{}").digest("hex"),
    records: [{ path: "/cfg", contents: true, proof }],
    queries: [{ args: ["config", "--list"], stdout: "OBSERVED\n" }],
  }, deadline: 10000 })
  const monitor = f.retainObservation({ context: f.context, sealed, operationId: "owned", producerDeadline: 10000 })
  f.state.content = Buffer.from("BAD é\n")
  assert.throws(() => f.assertObservation({ monitor, operationId: "owned", producerDeadline: 10000 }),
    { code: "producer_currentness_changed" })
})
function referenceOutputsFixture(change = null) {
  const branch = "refs/heads/main", config = "branch.main.remote\norigin\0branch.main.merge\nrefs/heads/main\0remote.origin.url\n/remote\0"
  const origins = "file:/admin/config\0branch.main.remote\norigin\0file:/admin/config\0branch.main.merge\nrefs/heads/main\0file:/admin/config\0remote.origin.url\n/remote\0"
  const observations = [
    { args: ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], stdout: "/owned\n/admin\n/common\n" },
    { args: ["symbolic-ref", "--quiet", "HEAD"], stdout: branch + "\n" },
    { args: ["config", "--null", "--list"], stdout: config },
    { args: ["rev-parse", "--path-format=absolute", "--git-path", "hooks/reference-transaction"], stdout: "/hook\n" },
    { args: ["remote", "get-url", "--all", "origin"], stdout: "/remote\n" },
    { args: ["remote", "get-url", "--push", "--all", "origin"], stdout: "/remote\n" },
    { args: ["config", "--null", "--show-origin", "--list"], stdout: origins },
    { args: ["var", "GIT_CONFIG_GLOBAL"], stdout: "/home/.gitconfig\n" },
    { args: ["config", "--null", "--list"], stdout: config },
    { args: ["config", "--null", "--show-origin", "--list"], stdout: origins },
    { args: ["remote", "get-url", "--push", "--all", "origin"], stdout: "/remote\n" },
    { args: ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"], stdout: "/pre-push\n" },
    { args: ["rev-parse", "--is-bare-repository"], gitDir: "/remote", stdout: "true\n" },
    { args: ["config", "--null", "--local", "--list"], gitDir: "/remote", stdout: "core.bare\ntrue\0" },
    ...["pre-receive", "update", "post-receive", "post-update", "proc-receive", "reference-transaction"].map(name =>
      ({ args: ["rev-parse", "--path-format=absolute", "--git-path", `hooks/${name}`], gitDir: "/remote", stdout: `/remote/hooks/${name}\n` })),
  ]
  if (change === "config-race") observations[8].stdout += "remote.origin.pushurl\n/foreign\0"
  if (change === "origin-race") observations[9].stdout = origins.replaceAll("/admin/config", "/other/config")
  if (change === "route-race") observations[10].stdout = "/foreign\n"
  if (change === "multiple-routes") observations[5].stdout = "/remote\n/other\n"
  if (change === "missing-hook") observations.pop()
  if (change === "bare") observations[12].stdout = "false\n"
  if (change === "file-url") {
    observations[5].stdout = "file:///remote\n"
    observations[10].stdout = "file:///remote\n"
  }
  return { root: "/owned", resolution: { admin: { real: "/admin" }, common: { real: "/common" } },
    ...(change === "file-url" ? { destination: { route: "file:///remote", real: "/remote" } } : {}),
    observations, deadline: 10000 }
}
test("FIRST file-URL reference uses its captured canonical bare destination rather than the encoded route as git-dir", () => {
  const f = witness()
  const result = f.referenceOutputs(referenceOutputsFixture("file-url"))
  assert.equal(result.push, "file:///remote")
  assert.equal(result.serverRoot, "/remote")
})
test("FIRST reference refuses unsupported transport even if supplied destination data claims a local path", () => {
  const f = witness(), input = referenceOutputsFixture("file-url")
  input.observations[5].stdout = "https://untrusted/remote\n"
  input.observations[10].stdout = "https://untrusted/remote\n"
  input.destination.route = "https://untrusted/remote"
  assert.throws(() => f.referenceOutputs(input), { code: "producer_currentness_unqualified" })
})
for (const upstream of ["no_remote", "no_upstream"]) {
  test(`FIRST reference preserves local ${upstream} without pretending publication is possible`, () => {
    const f = witness(), input = referenceOutputsFixture()
    input.observations = input.observations.filter(row => row.args[0] !== "remote" && !row.gitDir)
    for (const row of input.observations.filter(row => row.args[0] === "config")) {
      row.stdout = row.args.includes("--show-origin")
        ? upstream === "no_remote" ? "" : "file:/admin/config\0remote.origin.url\n/remote\0"
        : upstream === "no_remote" ? "" : "remote.origin.url\n/remote\0"
    }
    const result = f.referenceOutputs(input)
    assert.equal(result.nothingToSync, upstream)
    assert.equal(result.branch, "refs/heads/main")
    assert.equal(result.serverRoot, undefined)
    assert.equal(result.localPushHook, "/pre-push")
  })
}
for (const change of [null, "config-race", "origin-race", "route-race", "multiple-routes", "missing-hook", "bare"]) {
  test(`FIRST reference outputs ${change ?? "stable"} preserve all original route/config/server predicates`, () => {
    const f = witness()
    assert.equal(typeof f.referenceOutputs, "function")
    const input = referenceOutputsFixture(change)
    if (change) assert.throws(() => f.referenceOutputs(input), { code: "producer_currentness_unqualified" })
    else {
      const result = f.referenceOutputs(input)
      assert.equal(result.branch, "refs/heads/main")
      assert.equal(result.fetch, "/remote")
      assert.equal(result.push, "/remote")
      assert.equal(result.serverHooks.length, 6)
    }
  })
}
function lifecycle(record) {
  const producer = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/producer-state.js"), "utf8")
  const start = producer.indexOf("function firstBodyLifecycleObservation(")
  const end = producer.indexOf("\nfunction projection(", start)
  const source = start < 0 ? "" : producer.slice(start, end)
  const observe = vm.runInNewContext(`${source}\n;typeof firstBodyLifecycleObservation === "function"
    ? firstBodyLifecycleObservation : undefined`, {})
  assert.equal(typeof observe, "function")
  return observe(record)
}
test("new FIRST lifecycle projection preserves start and completion as separate schema2 observations", () => {
  const result = lifecycle({ kind: "desk-save", executionCount: 1, requestSent: true, capabilityGranted: true,
    bodyLifecycle: { version: 2, grantIssueCount: 1, observedStartCount: 1, completedReportCount: 0 } })
  assert.equal(result.version, 2)
  assert.equal(result.observedStartCount, 1)
  assert.equal(result.completedReportCount, 0)
  assert.equal(result.legacyExecutionCountMeaning, undefined)
  assert.equal(result.safeRetry, false)
})
test("new FIRST unknown start projection never falls back to completed or zero execution", () => {
  const result = lifecycle({ kind: "desk-save", executionCount: null, requestSent: true,
    bodyLifecycle: { version: 2, grantIssueCount: 1, observedStartCount: null, completedReportCount: 0 } })
  assert.equal(result.version, 2)
  assert.equal(result.observedStartCount, null)
  assert.equal(result.completedReportCount, 0)
})
for (const evidence of [
  { name: "completed open with old counter zero", record: { kind: "desk-save", executionCount: 0, capabilityGranted: true,
    requestSent: true, bodyHistory: [{ phase: "open", state: "completed" }] }, start: 1, completed: 0 },
  { name: "issued grant without body observation", record: { kind: "desk-save", executionCount: 0,
    capabilityGranted: true, requestSent: true }, start: null, completed: 0 },
  { name: "failed completed body report", record: { kind: "desk-save", executionCount: 1, capabilityGranted: true,
    bodyOutcome: { state: "blocked" } }, start: 1, completed: 1 },
  { name: "unconfirmed transfer", record: { kind: "desk-save", executionCount: 0, requestSent: true }, start: null, completed: 0 },
]) {
  test(`FIRST legacy lifecycle ${evidence.name} never implies safe replay`, () => {
    const output = lifecycle(evidence.record)
    assert.equal(output.observedStartCount, evidence.start)
    assert.equal(output.completedReportCount, evidence.completed)
    assert.equal(output.safeRetry, false)
    assert.equal(output.legacyExecutionCountMeaning, "completed_body_report")
  })
}
function resolutionFixture({ changedPointer = false, pointerChangesDuringRead = false } = {}) {
  const state = { reads: [] }, files = new Map([
    ["/owned/.git", { content: "gitdir: /admin\n", ino: 1n }],
    ["/admin/commondir", { content: "../common\n", ino: 2n }],
    ["/other/commondir", { content: "../common\n", ino: 3n }],
    ["/admin/HEAD", { content: "ref: refs/heads/main\n", ino: 4n }],
    ["/hook", { content: "hook-data\n", ino: 5n }],
    ["/remote/config", { content: "[core]\n\tbare = true\n", ino: 6n }],
  ])
  const dirs = new Map([["/", 8n], ["/owned", 9n], ["/admin", 10n], ["/common", 11n], ["/other", 12n], ["/remote", 13n]])
  const info = file => {
    const value = files.get(file), directory = dirs.has(file)
    if (!value && !directory) throw Object.assign(new Error("missing"), { code: "ENOENT" })
    return { dev: 1n, ino: directory ? dirs.get(file) : value.ino, mode: directory ? 0o40700n : 0o100600n,
      nlink: 1n, size: directory ? 0n : BigInt(Buffer.byteLength(value.content)), mtimeNs: 1n, ctimeNs: 1n,
      isFile: () => !directory, isDirectory: () => directory }
  }
  const sandbox = {
    path, Buffer, EXACT, sameFile, Date: class extends Date { static now() { return 1000 } }, constants: fs.constants,
    createHash, digest: value => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    fault: code => Object.assign(new Error(code), { code }),
    resolveStartupActivationConfigPath: () => null,
    lstatSync: info, statSync: info, realpathSync: file => file,
    openSync: file => file, fstatSync: info, closeSync() {},
    readSync: (file, buffer) => {
      state.reads.push(file)
      const text = file === "/owned/.git" && (changedPointer ||
        (pointerChangesDuringRead && state.reads.filter(value => value === file).length > 1))
        ? "gitdir: /other\n" : files.get(file).content
      Buffer.from(text).copy(buffer); return Buffer.byteLength(text)
    },
  }
  const api = vm.runInNewContext(`${block.replaceAll("export function", "function")}
    ;({resolve:typeof firstGitResolution === "function" ? firstGitResolution : undefined,
      rootIdentity:typeof firstRootIdentity === "function" ? firstRootIdentity : undefined,
      legacyProof:typeof firstLegacyFileProof === "function" ? firstLegacyFileProof : undefined,
      policyInputs:typeof firstPolicyInputs === "function" ? firstPolicyInputs : undefined,
      authorityFromReference:typeof firstAuthorityFromReference === "function" ? firstAuthorityFromReference : undefined,
      compareBinding:typeof compareFirstLocalBinding === "function" ? compareFirstLocalBinding : undefined,
      metadata:typeof firstPublicationMetadata === "function" ? firstPublicationMetadata : undefined,
      destination:typeof firstDestinationResolution === "function" ? firstDestinationResolution : undefined,
      compareServer:typeof compareFirstServerPolicy === "function" ? compareFirstServerPolicy : undefined})`, sandbox)
  return { state, files, ...api }
}
test("FIRST deadline-aware publication metadata keeps exact path/content and link identity predicates", () => {
  const f = resolutionFixture()
  assert.equal(typeof f.metadata, "function")
  const value = f.metadata({ file: "/remote/config", contents: true, deadline: 10000 })
  assert.equal(value.real, "/remote/config")
  assert.equal(value.linkDev, 1)
  assert.equal(value.linkIno, 6)
  assert.equal(value.content, createHash("sha256").update(JSON.stringify("[core]\n\tbare = true\n")).digest("hex"))
})
for (const changed of [null, "config", "hook"]) {
  test(`FIRST server policy ${changed ?? "unchanged"} rechecks existing destination/config/hook identity`, () => {
    const f = resolutionFixture()
    assert.equal(typeof f.destination, "function")
    assert.equal(typeof f.compareServer, "function")
    const policy = { root: "/remote", dev: 1, ino: 13,
      resolution: f.destination({ route: "/remote", deadline: 10000 }),
      configFile: f.metadata({ file: "/remote/config", contents: true, deadline: 10000 }),
      hooks: [f.metadata({ file: "/hook", deadline: 10000 })] }
    if (changed === "config") f.files.get("/remote/config").content = "[core]\n\tbare = false\n"
    if (changed === "hook") f.files.get("/hook").ino = 88n
    assert.equal(f.compareServer({ policy, deadline: 10000 }), changed === null)
  })
}
test("FIRST bounded gitdir/common-dir reconstruction follows actual pointer bytes", () => {
  const f = resolutionFixture()
  assert.equal(typeof f.resolve, "function")
  const result = f.resolve({ root: "/owned", env: {}, deadline: 10000 })
  assert.equal(result.admin.real, "/admin")
  assert.equal(result.common.real, "/common")
  assert.ok(f.state.reads.includes("/owned/.git"))
})
test("FIRST gitdir reconstruction observes substituted administration rather than guessing the old path", () => {
  const f = resolutionFixture({ changedPointer: true })
  assert.equal(typeof f.resolve, "function")
  const result = f.resolve({ root: "/owned", env: {}, deadline: 10000 })
  assert.equal(result.admin.real, "/other")
  assert.notEqual(result.admin.real, "/admin")
})
test("FIRST gitdir resolution refuses pointer mutation during input capture", () => {
  const f = resolutionFixture({ pointerChangesDuringRead: true })
  assert.throws(() => f.resolve({ root: "/owned", env: {}, deadline: 10000 }), { code: "producer_currentness_changed" })
})
test("FIRST deadline-aware file proof preserves the existing local binding tuple and digest semantics", () => {
  const f = resolutionFixture()
  assert.equal(typeof f.legacyProof, "function")
  const proof = f.legacyProof({ file: "/owned/.git", contents: true, deadline: 10000 })
  assert.equal(proof.real, "/owned/.git")
  assert.equal(proof.version.dev, "1")
  assert.equal(proof.version.ino, "1")
  assert.equal(proof.sha256, createHash("sha256").update(JSON.stringify("gitdir: /admin\n")).digest("hex"))
})
test("FIRST root and environment proof preserve binding semantics without a Git query", () => {
  const f = resolutionFixture()
  assert.equal(typeof f.rootIdentity, "function")
  assert.equal(typeof f.policyInputs, "function")
  const rootProof = f.rootIdentity({ root: "/owned", deadline: 10000 })
  const expected = createHash("sha256").update(JSON.stringify({ root: "/owned", dev: 1, ino: 9, gitDev: 1, gitIno: 1,
    gitFile: "gitdir: /admin\n" })).digest("hex")
  assert.equal(rootProof, expected)
  assert.notEqual(f.policyInputs({ HOME: "/one", GIT_CONFIG_COUNT: "0" }),
    f.policyInputs({ HOME: "/one", GIT_CONFIG_COUNT: "1" }))
})
test("FIRST authority projection keeps legacy binding keys while using its actual reference and physical witnesses", () => {
  const f = resolutionFixture()
  assert.equal(typeof f.authorityFromReference, "function")
  const env = { HOME: "/home", GIT_CONFIG_NOSYSTEM: "1" }
  const resolution = f.resolve({ root: "/owned", env, deadline: 10000 })
  const reference = { branch: "refs/heads/main", config: "core.bare\nfalse\0", configOrigins: "",
    referenceHook: "/hook", localPushHook: "/hook", globalPaths: [],
    nothingToSync: "no_remote" }
  const authority = f.authorityFromReference({ root: "/owned", env, person: null, resolution, reference, deadline: 10000 })
  assert.equal(authority.root, "/owned")
  assert.equal(authority.binding.branch, "refs/heads/main")
  assert.equal(authority.binding.nothingToSync, "no_remote")
  assert.equal(authority.binding.localProof.root, f.rootIdentity({ root: "/owned", deadline: 10000 }))
  assert.equal(authority.binding.localProof.resolution.admin.real, "/admin")
  assert.equal(authority.serverPolicy, null)
  assert.match(authority.binding.key, /^[0-9a-f]{64}$/)
})
for (const change of [null, "branch", "config", "marker", "environment", "hook"]) {
  test(`FIRST current binding scan ${change ?? "unchanged"} uses physical witnesses without recapture`, () => {
    const f = resolutionFixture(), env = { HOME: "/home", GIT_CONFIG_COUNT: "0" }
    assert.equal(typeof f.compareBinding, "function")
    const binding = { branch: "refs/heads/main", gitDir: "/admin", commonDir: "/common",
      localProof: { root: f.rootIdentity({ root: "/owned", deadline: 10000 }), policy: f.policyInputs(env),
        resolution: f.resolve({ root: "/owned", env, deadline: 10000 }),
        files: [f.legacyProof({ file: "/admin/commondir", contents: true, deadline: 10000 })] },
      referenceHook: { proof: f.legacyProof({ file: "/hook", contents: false, deadline: 10000 }) } }
    if (change === "branch") f.files.get("/admin/HEAD").content = "ref: refs/heads/other\n"
    if (change === "config") f.files.get("/admin/commondir").content = "../other\n"
    if (change === "marker") f.files.get("/owned/.git").ino = 99n
    if (change === "environment") env.GIT_CONFIG_COUNT = "1"
    if (change === "hook") f.files.get("/hook").ino = 99n
    const operation = () => f.compareBinding({ binding, root: "/owned", env, deadline: 10000 })
    if (change) assert.equal(operation(), false)
    else assert.equal(operation(), true)
  })
}
