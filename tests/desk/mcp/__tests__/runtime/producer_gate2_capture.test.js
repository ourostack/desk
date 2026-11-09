import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { createHash } from "node:crypto"
import { EXACT, sameFile } from "../../../../../plugins/desk/mcp/src/util/file-identity.js"

const source = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/publication-state.js"), "utf8")
const privateSource = source.slice(source.indexOf("const FIRST_MONITORS"))
  .replaceAll("export async function", "async function").replaceAll("export function", "function")
const guard = source.slice(source.indexOf("function contextOf("), source.indexOf("/** Created by trusted server"))
function fixture({ mutateDuringReference = false, newReferenceOrigin = false, staticImage = false, loaderEnv = false,
  separateBareCommon = false, bareCommonOverride = false, imageSize, imageLinks = 1n,
  mac = false, developerValue, selectorCost = 25, selectorResult = {}, selectorChangesBase = false,
  macDependency = "/usr/lib/libSystem.B.dylib", macCommand = null, shortImageRead = 65536,
  selectorOwnerStart = "darwin:2026-11-02T03:00:00.000Z", selectorWatchdogStart = "darwin:2026-11-02T03:00:00.000Z",
  selectorWatchdogPid = 701 } = {}) {
  const developer = "/Applications/Xcode A.app/Contents/Developer", engine = `${developer}/usr/bin/git`
  const state = { clock: 1000, queries: [], defaultQueries: 0, versionQueries: 0, offsets: new Map(), imageReads: 0,
    selectorCalls: [], commandEnvs: [], globalDeveloper: developer, versions: new Map(), imageBufferLengths: [], bufferCopies: [] }
  const config = "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = /remote\n[branch \"main\"]\n\tremote = origin\n\tmerge = refs/heads/main\n"
  const content = new Map([
    ["/owned/.git", Buffer.from("gitdir: /admin\n")], ["/admin/HEAD", Buffer.from("ref: refs/heads/main\n")],
    ["/admin/commondir", Buffer.from("../common\n")],
    ["/admin/config", Buffer.from(config)], ["/common/config", Buffer.from(config)],
    ["/tools/git", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])],
    ["/remote/config", Buffer.from("[core]\n\tbare = true\n")],
    ["/remote/HEAD", Buffer.from("ref: refs/heads/main\n")],
  ])
  const dirs = new Set(["/", "/owned", "/admin", "/common", "/home", "/tools", "/remote", "/remote/hooks"])
  const links = new Map()
  if (mac) {
    const command = (kind, name, offset) => {
      const size = Math.ceil((offset + Buffer.byteLength(name) + 1) / 8) * 8, bytes = Buffer.alloc(size)
      bytes.writeUInt32LE(kind, 0); bytes.writeUInt32LE(size, 4); bytes.writeUInt32LE(offset, 8)
      bytes.write(name, offset)
      return bytes
    }
    const segment = Buffer.alloc(72), main = Buffer.alloc(24)
    segment.writeUInt32LE(0x19, 0); segment.writeUInt32LE(72, 4); segment.write("__TEXT", 8)
    segment.writeBigUInt64LE(4194304n, 32); segment.writeBigUInt64LE(3837392n, 48)
    segment.writeUInt32LE(5, 56); segment.writeUInt32LE(5, 60)
    main.writeUInt32LE(0x80000028, 0); main.writeUInt32LE(24, 4); main.writeBigUInt64LE(512n, 8)
    const commands = [segment, main, command(0xe, "/usr/lib/dyld", 12), command(macCommand ?? 0xc, macDependency, 24)]
    const image = Buffer.alloc(3837392, 0xbe), table = Buffer.concat(commands)
    image.fill(0, 0, 32); image.writeUInt32LE(0xfeedfacf, 0); image.writeUInt32LE(0x100000c, 4)
    image.writeUInt32LE(2, 12); image.writeUInt32LE(commands.length, 16); image.writeUInt32LE(table.length, 20)
    table.copy(image, 32)
    content.set("/usr/bin/git", Buffer.from("INSTALLED APPLE SHIM"))
    content.set(engine, image)
    links.set(`${developer}/usr/libexec/git-core/git`, "../../bin/git")
    for (const file of ["/usr/bin/git", engine, `${developer}/usr/libexec/git-core/git`]) {
      for (let parent = path.dirname(file); parent !== "/"; parent = path.dirname(parent)) dirs.add(parent)
    }
  }
  if (separateBareCommon) {
    content.delete("/remote/config")
    content.set("/remote/commondir", Buffer.from("../remote-common\n"))
    content.set("/remote-common/config", Buffer.from("[core]\n\tbare = true\n"))
    dirs.add("/remote-common")
  }
  const identities = new Map([...dirs, ...content.keys(), ...links.keys()].map((file, index) => [file, BigInt(index + 1)]))
  const resolve = file => links.has(file) ? path.resolve(path.dirname(file), links.get(file)) : file
  const info = file => {
    if (!dirs.has(file) && !content.has(file) && !links.has(file)) throw Object.assign(new Error("absent"), { code: "ENOENT" })
    return { dev: 1n, ino: identities.get(file), mode: dirs.has(file) ? 0o40700n : links.has(file) ? 0o120777n
      : ["/tools/git", "/usr/bin/git", engine].includes(file) ? 0o100700n : 0o100600n,
      size: BigInt(content.get(file)?.length ?? links.get(file)?.length ?? 0),
      nlink: file === "/tools/git" ? imageLinks : file === "/usr/bin/git" ? 78n : 1n,
      uid: 0n, gid: 0n, mtimeNs: 1n, ctimeNs: 1n,
      ...state.versions.get(file),
      isDirectory: () => dirs.has(file), isFile: () => content.has(file), isSymbolicLink: () => links.has(file) }
  }
  const configRaw = "core.bare\nfalse\0remote.origin.url\n/remote\0branch.main.remote\norigin\0branch.main.merge\nrefs/heads/main\0"
  const origins = file => configRaw.split("\0").filter(Boolean).map(entry => `file:${file}\0${entry}\0`).join("")
  const contexts = new WeakMap()
  if (staticImage) {
    const image = Buffer.alloc(192)
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(image)
    image.writeUInt16LE(2, 16); image.writeUInt16LE(62, 18); image.writeUInt32LE(1, 20)
    image.writeBigUInt64LE(128n, 24); image.writeBigUInt64LE(64n, 32)
    image.writeUInt16LE(64, 52); image.writeUInt16LE(56, 54); image.writeUInt16LE(1, 56)
    image.writeUInt32LE(1, 64); image.writeUInt32LE(5, 68)
    image.writeBigUInt64LE(0n, 72); image.writeBigUInt64LE(0n, 80)
    image.writeBigUInt64LE(192n, 96); image.writeBigUInt64LE(192n, 104)
    image.writeBigUInt64LE(4096n, 112)
    content.set("/tools/git", image)
  }
  if (imageSize) content.set("/tools/git", Buffer.alloc(imageSize, 0xab))
  const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const sandbox = { path, Buffer: new Proxy(Buffer, { get(target, key) {
    if (key === "from") return (...args) => {
      const bytes = target.from(...args); state.bufferCopies.push(bytes.length); return bytes
    }
    return Reflect.get(target, key)
  } }), createHash, EXACT, sameFile, constants: fs.constants, contexts,
    Date: class extends Date { static now() { return state.clock } }, digest,
    fault: code => Object.assign(new Error(code), { code }), resolveStartupActivationConfigPath: () => null,
    lstatSync: file => { state.onLstat?.(file); return info(file) }, statSync: (file, options) => {
      const value = info(resolve(file))
      return options?.bigint ? value : { ...value, dev: Number(value.dev), ino: Number(value.ino),
        mode: Number(value.mode), size: Number(value.size) }
    }, realpathSync: file => resolve(file), readlinkSync: file => links.get(file), accessSync() {},
    process: { platform: mac ? "darwin" : "linux", arch: "arm64", env: {} },
    runOwnedProcess: async request => {
      state.selectorCalls.push(request)
      state.clock += selectorCost
      if (selectorChangesBase) owner.env.PATH = "/changed"
      return { status: 0, stdout: `${state.globalDeveloper}\n`, stderr: "", signal: null,
        requestSent: true, timedOut: false, cancelled: false, outputTruncated: false,
        resources: { childrenClosed: true, exitObserved: true, resultReceived: true, phase: "closed", scope: "native-owner",
          childPid: 700, group: 700, start: selectorOwnerStart, watchdog: { pid: selectorWatchdogPid, group: 700, start: selectorWatchdogStart },
          inventory: { known: true, members: [] } }, ...selectorResult }
    },
    readSmallText: file => {
      if (!content.has(file)) throw Object.assign(new Error("absent"), { code: "ENOENT" })
      return content.get(file).toString("utf8")
    },
    openSync: file => { state.offsets.set(file, 0); return file }, fstatSync: info, closeSync() {},
    readSync: (file, buffer, offset, length, position) => {
      const start = position ?? state.offsets.get(file), amount = Math.min(length, shortImageRead, content.get(file).length - start)
      content.get(file).copy(buffer, offset, start, start + amount)
      if (position === null) state.offsets.set(file, start + amount)
      if (file === "/tools/git" || file === engine) {
        state.imageReads++
        state.imageBufferLengths.push(buffer.length)
        state.onImageRead?.(state.imageReads)
      }
      return amount
    },
    spawnSync: (_command, argv, options) => {
      state.queries.push(argv)
      state.commandEnvs.push({ ...options.env })
      const bare = argv[0].startsWith("--git-dir="), args = bare ? argv.slice(1) : argv.slice(2)
      let output = ""
      if (args[0] === "--version") { state.versionQueries++; output = "git version 2.54.0\n" }
      else if (args[0] === "--exec-path") {
        const selected = options.env.DEVELOPER_DIR ?? state.globalDeveloper
        output = mac ? `${selected.endsWith(".app") ? `${selected}/Contents/Developer` : selected}/usr/libexec/git-core\n` : "/tools\n"
      }
      else if (args.includes("--show-toplevel")) output = "/owned\n/admin\n/common\n"
      else if (args[0] === "symbolic-ref") output = "refs/heads/main\n"
      else if (args[0] === "remote") output = "/remote\n"
      else if (args.includes("--is-bare-repository")) output = "true\n"
      else if (args[0] === "var") output = "/home/.gitconfig\n"
      else if (args.includes("--git-path")) output = `${bare ? "/remote" : "/admin"}/${args.at(-1)}\n`
      else if (args[0] === "config" && args.includes("--file")) {
        const file = args[args.indexOf("--file") + 1]
        output = file === "/remote/config" ? `file:${file}\0core.bare\ntrue\0` : origins(file)
      } else if (args[0] === "config" && args.includes("--show-origin")) {
        if (bare) output = `file:${separateBareCommon ? "/remote-common" : "/remote"}/config\0core.bare\ntrue\0`
        else {
          state.defaultQueries++
          output = origins(newReferenceOrigin && state.versionQueries >= 2 ? "/foreign/config" : "/common/config")
          if (mutateDuringReference && state.versionQueries >= 2) content.set("/common/config", Buffer.from("CHANGED"))
        }
      } else if (args[0] === "config") output = bare ? "core.bare\ntrue\0" : configRaw
      return { status: 0, signal: null, error: undefined, stdout: output, stderr: "" }
    },
  }
  const recoverySource = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/recovery-state.js"), "utf8")
  const legacy = recoverySource.slice(recoverySource.indexOf("function policyInputs("), recoverySource.indexOf("function localProof(")) +
    recoverySource.slice(recoverySource.indexOf("function rootIdentity("), recoverySource.indexOf("export { rootIdentity")) +
    recoverySource.slice(recoverySource.indexOf("export function isLocalBindingCurrent("), recoverySource.indexOf("function applicable("))
      .replace("export function", "function")
  const api = vm.runInNewContext(`${guard}\n${privateSource}\n${legacy}
    ;({capture:typeof discoverFirstSaveCapture === "function" ? discoverFirstSaveCapture : undefined,
      prepare:typeof prepareFirstOperationEnvironment === "function" ? prepareFirstOperationEnvironment : undefined,
      register:typeof registerTransferredFirstOperationEnvironment === "function" ? registerTransferredFirstOperationEnvironment : undefined,
      closeOperation:typeof closeFirstOperationEnvironment === "function" ? closeFirstOperationEnvironment : undefined,
      operationData:input=>typeof FIRST_OPERATION_ENVIRONMENTS === "undefined" ? undefined : FIRST_OPERATION_ENVIRONMENTS.get(input),
      rootIdentity:firstRootIdentity,
      begin:typeof beginFirstSaveCurrentness === "function" ? beginFirstSaveCurrentness : undefined,
      assertCurrent:typeof assertFirstSaveCurrentness === "function" ? assertFirstSaveCurrentness : undefined,
      close:typeof closeFirstSaveCurrentness === "function" ? closeFirstSaveCurrentness : undefined,
      localCurrent:compareFirstLocalBinding, legacyCurrent:isLocalBindingCurrent,
      scan:scanFirstSaveFootprint, assertInputs:assertFirstInputObservation,
      observeInputs:({context,capture,operationId,producerDeadline}) => retainFirstInputObservation({
        context,sealed:FIRST_COMPLETE_CAPTURES.get(capture)?.sealed,operationId,producerDeadline}),
      invocationEligible:typeof firstDirectInvocationEligible === "function" ? firstDirectInvocationEligible : undefined})`, sandbox)
  const context = Object.freeze(Object.create(null)), env = { PATH: mac ? "/usr/bin:/bin" : "/tools", HOME: "/home", GIT_CONFIG_NOSYSTEM: "1",
    GIT_DIR: "/admin" }
  if (developerValue !== undefined) env.DEVELOPER_DIR = developerValue
  if (bareCommonOverride) env.GIT_COMMON_DIR = "/common"
  if (loaderEnv) env.LD_PRELOAD = "/untracked/loader.so"
  const owner = { active: true, root: "/owned", person: null, env,
    rootIdentity: api.rootIdentity({ root: "/owned", deadline: 10000 }) }
  contexts.set(context, owner)
  return { ...api, context, owner, env, state, content, developer, engine, links,
    actorEnv: sandbox.process.env,
    newActorContext: (env = owner.env) => { const branded = Object.freeze(Object.create(null)); contexts.set(branded, { ...owner, env: { ...env }, active: true }); return branded } }
}

const selectionClock = { operationId: "owned", createdAtMs: 1000, producerDeadline: 11000, publicationDeadline: 61000 }
async function selectedFixture(options = {}) {
  const f = fixture({ mac: true, ...options })
  assert.equal(typeof f.prepare, "function", "private operation environment preparation is missing")
  const operationEnvironment = await f.prepare({ context: f.context, ...selectionClock })
  return { ...f, operationEnvironment }
}
test("FIRST Mac operation binds A before D without mutating original context or process env", async () => {
  const f = await selectedFixture()
  const registered = f.operationData(f.operationEnvironment)
  assert.equal(registered.env.DEVELOPER_DIR, f.developer)
  assert.equal(Object.isFrozen(registered.env), true)
  assert.equal(Object.hasOwn(f.env, "DEVELOPER_DIR"), false)
  assert.equal(Object.hasOwn(f.actorEnv, "DEVELOPER_DIR"), false)
  assert.equal(f.state.queries.length, 0)
  assert.equal(f.state.selectorCalls.length, 1)
  assert.equal(f.state.selectorCalls[0].command, "/usr/bin/xcode-select")
  assert.deepEqual(Array.from(f.state.selectorCalls[0].args), ["--print-path"])
  assert.equal(f.state.selectorCalls[0].deadline, 6000)
  assert.equal(Object.hasOwn(f.state.selectorCalls[0].env, "DEVELOPER_DIR"), false)
  assert.equal(f.state.selectorCalls[0].inspection, true)
  assert.equal(f.state.selectorCalls[0].capture, true)
  assert.equal(f.state.selectorCalls[0].ownSignals, true)
})
test("FIRST actual Mac D/S0/R and steady monitor stay on bound A when global selection changes", async () => {
  const f = await selectedFixture()
  f.state.globalDeveloper = "/Applications/Xcode B.app/Contents/Developer"
  const current = f.begin({ context: f.context, operationEnvironment: f.operationEnvironment, ...selectionClock })
  assert.equal(current.authority.env.DEVELOPER_DIR, f.developer)
  assert.equal(current.selection.value, f.developer)
  assert.equal(current.authority.root, "/owned")
  assert.ok(current.footprint.records.some(record => record.proof.mach64?.dependencies.includes("/usr/lib/libSystem.B.dylib")))
  const queryCount = f.state.queries.length
  for (let count = 0; count < 3; count++) f.assertCurrent({
    monitor: current.monitor, ...selectionClock, baseEnv: current.authority.env })
  assert.equal(f.state.queries.length, queryCount)
  assert.equal(f.state.selectorCalls.length, 1)
  assert.ok(f.state.commandEnvs.every(env => env.DEVELOPER_DIR === f.developer))
  f.content.get(f.engine)[3837391] ^= 0xff
  assert.throws(() => f.assertCurrent({ monitor: current.monitor, ...selectionClock }), { code: "producer_currentness_changed" })
})
test("FIRST existing Developer contents path is retained exactly with no selector getter", async () => {
  const developer = "/Applications/Xcode A.app/Contents/Developer"
  const f = await selectedFixture({ developerValue: developer })
  assert.equal(f.operationData(f.operationEnvironment).env.DEVELOPER_DIR, developer)
  assert.equal(f.state.selectorCalls.length, 0)
})
test("FIRST documented application form remains byte-exact while binding its Developer contents", async () => {
  const f = await selectedFixture({ developerValue: "/Applications/Xcode A.app" })
  assert.equal(f.operationData(f.operationEnvironment).env.DEVELOPER_DIR, "/Applications/Xcode A.app")
  const current = f.begin({ context: f.context, operationEnvironment: f.operationEnvironment, ...selectionClock })
  assert.equal(current.selection.developerRoot, f.developer)
  assert.equal(current.authority.env.DEVELOPER_DIR, "/Applications/Xcode A.app")
})
for (const value of ["", "relative", "~/Xcode.app", "/Applications/../Xcode.app", "/Applications/Xcode A.app/", "/A\nB",
  "/Applications/Xcode \ud800.app"]) {
  test(`FIRST original unsupported selector ${JSON.stringify(value)} is never overwritten`, async () => {
    const f = fixture({ mac: true, developerValue: value })
    assert.equal(typeof f.prepare, "function")
    await assert.rejects(f.prepare({ context: f.context, ...selectionClock }), { code: "producer_selector_unqualified" })
    assert.equal(f.env.DEVELOPER_DIR, value)
    assert.equal(f.state.selectorCalls.length, 0)
    assert.equal(f.state.queries.length, 0)
  })
}
for (const result of [{ status: 1 }, { stderr: "unexpected" }, { outputTruncated: true }, { resources: { childrenClosed: false } }]) {
  test(`FIRST selection failure/uncertain lifecycle refuses before D ${JSON.stringify(result)}`, async () => {
    const f = fixture({ mac: true, selectorResult: result })
    assert.equal(typeof f.prepare, "function")
    await assert.rejects(f.prepare({ context: f.context, ...selectionClock }), { code: "producer_selector_observation_unqualified" })
    assert.equal(f.state.selectorCalls.length, 1)
    assert.equal(f.state.queries.length, 0)
  })
}
test("FIRST selection time consumes the original body clock and cannot launch D after expiry", async () => {
  const f = fixture({ mac: true, selectorCost: 10000 })
  assert.equal(typeof f.prepare, "function")
  await assert.rejects(f.prepare({ context: f.context, ...selectionClock }), { code: "producer_deadline" })
  assert.equal(f.state.queries.length, 0)
  assert.equal(f.state.selectorCalls.length, 1)
})
for (const field of ["selectorOwnerStart", "selectorWatchdogStart"]) {
  test(`FIRST selector refuses unknown ${field} despite success/closed booleans`, async () => {
    const f = fixture({ mac: true, [field]: "darwin:unknown" })
    await assert.rejects(f.prepare({ context: f.context, ...selectionClock }), { code: "producer_selector_observation_unqualified" })
    assert.equal(f.state.queries.length, 0)
  })
}
for (const options of [{ selectorOwnerStart: "darwin:not-a-generation" }, { selectorWatchdogPid: 700 }]) {
  test(`FIRST selection refuses malformed/aliased native identity ${JSON.stringify(options)}`, async () => {
    const f = fixture({ mac: true, ...options })
    await assert.rejects(f.prepare({ context: f.context, ...selectionClock }), { code: "producer_selector_observation_unqualified" })
    assert.equal(f.state.queries.length, 0)
  })
}
test("FIRST base context drift during selection is not covered by its narrow selector overlay", async () => {
  const f = fixture({ mac: true, selectorChangesBase: true })
  assert.equal(typeof f.prepare, "function")
  await assert.rejects(f.prepare({ context: f.context, ...selectionClock }), { code: "publication_scope_changed" })
  assert.equal(f.state.queries.length, 0)
})
test("FIRST stale root context refuses before launching even the readonly selection helper", async () => {
  const f = fixture({ mac: true })
  f.state.versions.set("/owned", { ino: 999n })
  await assert.rejects(f.prepare({ context: f.context, ...selectionClock }), { code: "publication_root_changed" })
  assert.equal(f.state.selectorCalls.length, 0)
  assert.equal(f.state.queries.length, 0)
})
for (const value of [undefined, null, 42]) {
  test(`FIRST present nonstring selector ${String(value)} never becomes an absent-selector fallback`, async () => {
    const f = fixture({ mac: true })
    f.env.DEVELOPER_DIR = value
    await assert.rejects(f.prepare({ context: f.context, ...selectionClock }), { code: "producer_selector_unqualified" })
    assert.equal(Object.hasOwn(f.env, "DEVELOPER_DIR"), true)
    assert.equal(f.env.DEVELOPER_DIR, value)
    assert.equal(f.state.selectorCalls.length, 0)
  })
}
test("FIRST original base drift during final directory validation cannot be adopted by registration", async () => {
  const f = fixture({ mac: true })
  f.state.onLstat = file => { if (file === f.developer) f.env.PATH = "/foreign" }
  await assert.rejects(f.prepare({ context: f.context, ...selectionClock }), { code: "publication_scope_changed" })
  assert.equal(f.state.queries.length, 0)
})
test("FIRST Mac selector registration cannot be reconstructed from JSON", async () => {
  const f = await selectedFixture()
  assert.throws(() => f.begin({ context: f.context, operationEnvironment: JSON.parse(JSON.stringify(f.operationEnvironment)),
    ...selectionClock }), { code: "producer_operation_environment_required" })
  assert.throws(() => f.begin({ context: f.context, ...selectionClock }), { code: "producer_operation_environment_required" })
})
for (const key of ["SDKROOT", "TOOLCHAINS", "GIT_EXEC_PATH", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "xcrun_nocache"]) {
  test(`FIRST Mac refuses original ${key} instead of deleting it`, async () => {
    const f = fixture({ mac: true })
    f.env[key] = ""
    assert.equal(typeof f.prepare, "function")
    await assert.rejects(f.prepare({ context: f.context, ...selectionClock }), { code: "producer_invocation_unqualified" })
    assert.equal(f.env[key], "")
    assert.equal(f.state.selectorCalls.length, 0)
  })
}
for (const options of [{ macDependency: "/private/app/libcustom.dylib" }, { macCommand: 0x8000001c }]) {
  test(`FIRST actual Mac capture refuses unresolved loader/dependency class ${JSON.stringify(options)}`, async () => {
    const f = await selectedFixture(options)
    assert.throws(() => f.begin({ context: f.context, operationEnvironment: f.operationEnvironment, ...selectionClock }),
      { code: "producer_invocation_unqualified" })
  })
}
test("FIRST Mach structural capture handles short reads without replacing the complete stream", async () => {
  const f = await selectedFixture({ shortImageRead: 777 })
  const current = f.begin({ context: f.context, operationEnvironment: f.operationEnvironment, ...selectionClock })
  const record = current.footprint.records.find(value => value.proof.mach64)
  assert.equal(record.proof.byteCount, "3837392")
  assert.equal(record.proof.sha256, createHash("sha256").update(f.content.get(f.engine)).digest("hex"))
  assert.ok(f.state.imageBufferLengths.every(length => length === 65536))
})
for (const drift of ["retired", "base-env"]) {
  test(`FIRST in-stream ${drift} stops the next image read instead of finishing with stale authority`, async () => {
    const f = await selectedFixture()
    f.state.onImageRead = count => {
      if (count !== 2) return
      if (drift === "retired") f.closeOperation(f.operationEnvironment)
      else f.env.PATH = "/foreign"
    }
    assert.throws(() => f.begin({ context: f.context, operationEnvironment: f.operationEnvironment, ...selectionClock }),
      { code: drift === "retired" ? "producer_operation_environment_required" : "publication_scope_changed" })
    assert.equal(f.state.imageReads, 2)
    assert.equal(f.state.queries.length, 2)
  })
}
for (const boundary of ["dispatcher-lookup", "config-result"]) {
  test(`FIRST ${boundary} witnesses renew the private operation before another discovery/reference dispatch`, async () => {
    const f = await selectedFixture()
    let changed = false, dispatchedBeforeChange
    f.state.onLstat = file => {
      if (changed || (boundary === "dispatcher-lookup" ? file !== "/usr/bin/git"
        : file !== "/common/config" || f.state.defaultQueries === 0)) return
      changed = true
      dispatchedBeforeChange = f.state.queries.length
      f.env.PATH = "/foreign"
    }
    assert.throws(() => f.begin({ context: f.context, operationEnvironment: f.operationEnvironment, ...selectionClock }),
      { code: "publication_scope_changed" })
    assert.equal(changed, true)
    assert.equal(f.state.queries.length, dispatchedBeforeChange)
  })
}
for (const malformed of ["magic", "overbound", "unknown-command", "missing-entry"]) {
  test(`FIRST complete Mac witness refuses ${malformed} structural data without a format fallback`, async () => {
    const f = await selectedFixture(), image = f.content.get(f.engine)
    if (malformed === "magic") image.writeUInt32LE(0xdeadbeef, 0)
    if (malformed === "overbound") image.writeUInt32LE(65536, 20)
    if (malformed === "unknown-command") image.writeUInt32LE(0x12345678, 32)
    if (malformed === "missing-entry") image.writeBigUInt64LE(9999999n, 32 + 72 + 8)
    assert.throws(() => f.begin({ context: f.context, operationEnvironment: f.operationEnvironment, ...selectionClock }),
      { code: "producer_invocation_unqualified" })
  })
}
test("FIRST unsupported Mach names cannot allocate a second unbounded prefix buffer", async () => {
  const f = await selectedFixture({ macDependency: `/private/${"A".repeat(3000)}` })
  assert.throws(() => f.begin({ context: f.context, operationEnvironment: f.operationEnvironment, ...selectionClock }),
    { code: "producer_invocation_unqualified" })
  assert.ok(f.state.bufferCopies.every(length => length <= 128))
})
test("FIRST owner and executor independently register the authenticated A binding without selecting again", async () => {
  const f = await selectedFixture()
  const caller = f.begin({ context: f.context, operationEnvironment: f.operationEnvironment, ...selectionClock })
  Object.assign(f.actorEnv, caller.authority.env)
  const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  const createActor = () => {
    const context = f.newActorContext(caller.authority.env)
    const operationEnvironment = f.register({ context, selection: JSON.parse(JSON.stringify(caller.selection)),
      expectedDigest: digest(caller.selection), ...selectionClock })
    return f.begin({ context, operationEnvironment, ...selectionClock,
      expectedAuthority: caller.authority, expectedFootprint: caller.footprint })
  }
  const owner = createActor()
  f.close(caller.monitor)
  f.state.globalDeveloper = "/Applications/Xcode B.app/Contents/Developer"
  f.assertCurrent({ monitor: owner.monitor, ...selectionClock, baseEnv: owner.authority.env })
  const executor = createActor()
  assert.notEqual(owner.monitor, executor.monitor)
  f.close(owner.monitor)
  f.assertCurrent({ monitor: executor.monitor, ...selectionClock })
  assert.equal(f.state.selectorCalls.length, 1)
  assert.ok(f.state.commandEnvs.every(env => env.DEVELOPER_DIR === f.developer))
})
test("FIRST transfer rechecks actual inherited selector after its final directory IO before registration", async () => {
  const f = await selectedFixture(), caller = f.begin({
    context: f.context, operationEnvironment: f.operationEnvironment, ...selectionClock })
  Object.assign(f.actorEnv, caller.authority.env)
  const context = f.newActorContext(caller.authority.env)
  f.state.onLstat = file => { if (file === f.developer) f.actorEnv.DEVELOPER_DIR = "/foreign" }
  assert.throws(() => f.register({ context, selection: caller.selection, ...selectionClock,
    expectedDigest: createHash("sha256").update(JSON.stringify(caller.selection)).digest("hex") }),
  { code: "producer_operation_environment_required" })
})
for (const tamper of ["digest", "base-digest", "deadline", "inherited-env", "context"]) {
  test(`FIRST actual transfer registration refuses ${tamper} before a monitor exists`, async () => {
    const f = await selectedFixture(), caller = f.begin({
      context: f.context, operationEnvironment: f.operationEnvironment, ...selectionClock })
    const selection = { ...caller.selection }
    Object.assign(f.actorEnv, caller.authority.env)
    const context = tamper === "context" ? {} : f.newActorContext(caller.authority.env)
    if (tamper === "base-digest") selection.baseEnvDigest = "0".repeat(64)
    if (tamper === "inherited-env") f.actorEnv.DEVELOPER_DIR = "/foreign"
    const expectedDigest = createHash("sha256").update(JSON.stringify(selection)).digest("hex")
    assert.throws(() => f.register({ context, selection, ...selectionClock,
      ...(tamper === "deadline" ? { producerDeadline: 11001 } : {}),
      expectedDigest: tamper === "digest" ? "0".repeat(64) : expectedDigest }),
    { code: tamper === "context" ? "publication_context_invalid" : "producer_operation_environment_required" })
    assert.equal(f.state.selectorCalls.length, 1)
  })
}
test("FIRST selection expiry preserves its actual observation instead of losing uncertain helper custody", async () => {
  const f = fixture({ mac: true, selectorCost: 10000, selectorResult: { resources: { childrenClosed: false } } })
  await assert.rejects(f.prepare({ context: f.context, ...selectionClock }), error =>
    error.code === "producer_deadline" && error.selector_observation?.resources.childrenClosed === false)
  assert.equal(f.state.queries.length, 0)
})

test("FIRST actual complete capture seals a full large hardlinked system image without opening unsupported invocation admission", () => {
  const f = fixture({ imageSize: 3837392, imageLinks: 78n })
  const capture = f.capture({ context: f.context, operationId: "owned", producerDeadline: 10000 })
  const image = capture.footprint.records.find(record => record.path === "/tools/git")
  assert.equal(image.proof.kind, "readonly-system-image")
  assert.equal(image.proof.complete, true)
  assert.equal(image.proof.byteCount, "3837392")
  assert.equal(image.proof.targetVersion.nlink, "78")
  assert.equal(image.proof.sha256, createHash("sha256").update(f.content.get("/tools/git")).digest("hex"))
  assert.equal(capture.invocation.implementationQualified, false)
  const monitor = f.observeInputs({ context: f.context, capture, operationId: "owned", producerDeadline: 10000 })
  const queries = f.state.queries.length, reads = f.state.imageReads
  f.assertInputs({ monitor, operationId: "owned", producerDeadline: 10000 })
  assert.ok(f.state.imageReads >= reads + 60)
  assert.equal(f.state.queries.length, queries)
  f.content.get("/tools/git")[3837391] = 0x11
  assert.throws(() => f.assertInputs({ monitor, operationId: "owned", producerDeadline: 10000 }),
    { code: "producer_currentness_changed" })
  assert.throws(() => f.assertInputs({ monitor, operationId: "owned", producerDeadline: 10000 }),
    { code: "producer_currentness_changed" })
  assert.throws(() => f.assertCurrent({ monitor, operationId: "owned", producerDeadline: 10000 }),
    { code: "producer_currentness_unqualified" })
  assert.equal(f.state.queries.length, queries)
})
test("FIRST actual permission capture preserves private system roles through S0/R and monitor copies, not JSON", () => {
  const f = fixture({ staticImage: true })
  const result = f.begin({ context: f.context, operationId: "owned", producerDeadline: 10000 })
  assert.equal(result.footprint.records.find(record => record.path === "/tools/git").proof.kind, "readonly-system-image")
  const reads = f.state.imageReads, queries = f.state.queries.length
  f.assertCurrent({ monitor: result.monitor, operationId: "owned", producerDeadline: 10000 })
  assert.ok(f.state.imageReads > reads)
  assert.equal(f.state.queries.length, queries)
  assert.throws(() => f.scan({ footprint: JSON.parse(JSON.stringify(result.footprint)), deadline: 10000 }),
    { code: "producer_system_input_role_required" })
  f.content.get("/tools/git")[191] ^= 0xff
  assert.throws(() => f.assertCurrent({ monitor: result.monitor, operationId: "owned", producerDeadline: 10000 }),
    { code: "producer_currentness_changed" })
  assert.equal(f.state.queries.length, queries)
})

test("FIRST complete capture composes actual discovery, complete S0 and reference results without manufacturing invocation eligibility", () => {
  const f = fixture()
  assert.equal(typeof f.capture, "function")
  const result = f.capture({ context: f.context, operationId: "owned", producerDeadline: 10000 })
  assert.equal(result.authority.binding.branch, "refs/heads/main")
  assert.equal(result.authority.serverPolicy.root, "/remote")
  assert.equal(result.invocation.implementationQualified, false)
  assert.ok(result.footprint.records.some(record => record.path === "/admin/config.worktree" && record.proof.absent))
  assert.ok(result.footprint.records.some(record => record.path === "/home/.gitconfig" && record.proof.absent))
  assert.equal(result.referenceObservations.filter(row => row.args.includes("--show-toplevel")).length, 1)
  assert.ok(f.state.queries.length > 20)
})
test("FIRST bare endpoint with a separate common-dir is refused before permission, rather than pinning an absent local config", () => {
  const f = fixture({ staticImage: true, separateBareCommon: true })
  assert.throws(() => f.begin({ context: f.context, operationId: "owned", producerDeadline: 10000 }),
    { code: "producer_currentness_unqualified" })
})
test("FIRST bare policy cannot silently inherit a caller common-dir environment override", () => {
  const f = fixture({ staticImage: true, bareCommonOverride: true })
  assert.throws(() => f.begin({ context: f.context, operationId: "owned", producerDeadline: 10000 }),
    { code: "producer_currentness_unqualified" })
})
test("FIRST direct bare closure uses actual config origin inspection and replays it in R", () => {
  const f = fixture({ staticImage: true })
  const capture = f.capture({ context: f.context, operationId: "owned", producerDeadline: 10000 })
  const origins = capture.captureObservations.filter(row => row.gitDir === "/remote" &&
    row.args.includes("--show-origin") && row.args.includes("--local"))
  assert.equal(origins.length, 1)
  assert.equal(origins[0].stdout, "file:/remote/config\0core.bare\ntrue\0")
  assert.ok(capture.footprint.records.some(record => record.path === "/remote/commondir" && record.proof.absent))
})
test("FIRST supported bare config drift is refused by actual steady witnesses without another Git capture", () => {
  const f = fixture({ staticImage: true })
  const currentness = f.begin({ context: f.context, operationId: "owned", producerDeadline: 10000 })
  const count = f.state.queries.length
  f.content.set("/remote/config", Buffer.from("[core]\n\tbare = true\n\thooksPath = /foreign/hooks\n"))
  assert.throws(() => f.assertCurrent({ monitor: currentness.monitor, operationId: "owned", producerDeadline: 10000 }))
  assert.equal(f.state.queries.length, count)
})
for (const options of [{ mutateDuringReference: true }, { newReferenceOrigin: true }]) {
  test(`FIRST actual capture refuses input/closure change during R ${JSON.stringify(options)}`, () => {
    const f = fixture(options)
    assert.equal(typeof f.capture, "function")
    assert.throws(() => f.capture({ context: f.context, operationId: "owned", producerDeadline: 10000 }),
      { code: "producer_currentness_changed" })
  })
}
test("FIRST direct invocation eligibility requires a complete static image, not a header or --version", () => {
  const f = fixture({ staticImage: true })
  assert.equal(typeof f.invocationEligible, "function")
  assert.equal(f.invocationEligible({ executable: "/tools/git", env: f.env, deadline: 10000 }), true)
  f.content.set("/tools/git", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))
  assert.equal(f.invocationEligible({ executable: "/tools/git", env: f.env, deadline: 10000 }), false)
})
test("FIRST direct invocation refuses interpreter/dynamic segments and loader selectors", () => {
  const f = fixture({ staticImage: true })
  assert.equal(typeof f.invocationEligible, "function")
  f.content.get("/tools/git").writeUInt32LE(3, 64)
  assert.equal(f.invocationEligible({ executable: "/tools/git", env: f.env, deadline: 10000 }), false)
  const selected = fixture({ staticImage: true, loaderEnv: true })
  assert.equal(selected.invocationEligible({ executable: "/tools/git", env: selected.env, deadline: 10000 }), false)
})
test("FIRST complete permission monitor is locally branded and repeated current checks do not recapture Git", () => {
  const f = fixture({ staticImage: true })
  assert.equal(typeof f.begin, "function")
  const result = f.begin({ context: f.context, operationId: "owned", producerDeadline: 10000 })
  const initialQueries = f.state.queries.length
  for (let index = 0; index < 10; index++) f.assertCurrent({
    monitor: result.monitor, operationId: "owned", producerDeadline: 10000, root: "/owned", person: null, baseEnv: f.env })
  assert.equal(f.state.queries.length, initialQueries)
  assert.throws(() => f.assertCurrent({ monitor: JSON.parse(JSON.stringify(result.monitor)), operationId: "owned",
    producerDeadline: 10000, root: "/owned", person: null, baseEnv: f.env }), { code: "producer_currentness_unqualified" })
  f.close(result.monitor)
  assert.throws(() => f.assertCurrent({ monitor: result.monitor, operationId: "owned", producerDeadline: 10000 }),
    { code: "producer_currentness_unqualified" })
})
test("FIRST monitor refuses unknown invocation and never promotes sealed observation JSON to policy authority", () => {
  const f = fixture()
  assert.equal(typeof f.begin, "function")
  assert.throws(() => f.begin({ context: f.context, operationId: "owned", producerDeadline: 10000 }),
    { code: "producer_invocation_unqualified" })
})
async function requestFixture(options = {}) {
  const f = fixture(options), intents = new WeakMap(), state = { prepareCalls: 0, dispatchCalls: 0 }
  const producer = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/producer-state.js"), "utf8")
  const request = producer.slice(producer.indexOf("export async function requestDeskSaveProducer("), producer.indexOf("function storeSavePayload("))
    .replace("export async function", "async function")
    .replace('const { prepareDeskSaveInput } = await import("../tools/desk-save.js")', "")
  const invoke = vm.runInNewContext(`${request}\nrequestDeskSaveProducer`, {
    Date: class extends Date { static now() { return f.state.clock } }, intents,
    digest: value => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    realpathSync: file => file, fault: code => Object.assign(new Error(code), { code }),
    captureProducerAdmission: () => assert.fail("Repeated legacy full capture must not run"),
    prepareFirstOperationEnvironment: f.prepare, closeFirstOperationEnvironment: f.closeOperation,
    beginFirstSaveCurrentness: f.begin, assertFirstSaveCurrentness: f.assertCurrent, closeFirstSaveCurrentness: f.close,
    prepareDeskSaveInput: async ({ input }) => {
      state.prepareCalls++
      if (options.changeAfterAwait) f.content.set("/common/config", Buffer.from("CHANGED"))
      return input
    },
    requestProducerReadOnly: async ({ intent }) => {
      state.dispatchCalls++
      const request = intents.get(intent)
      state.request = request
      f.assertCurrent({ monitor: request.currentness.monitor, operationId: request.id, producerDeadline: request.producerDeadline })
      assert.equal(request.currentness.authority.binding.branch, "refs/heads/main")
      return { id: request.id, createdAtMs: request.createdAtMs, producerDeadline: request.producerDeadline,
        publicationDeadline: request.publicationDeadline }
    },
  })
  return { ...f, requestState: state, invoke }
}
test("FIRST actual caller prepares private Mac env before capture under its already-issued clock", async () => {
  const f = await requestFixture({ mac: true })
  const result = await f.invoke({ context: f.context, root: "/owned", input: {
    paths: ["owned.md"], files: [], message: "first", tidy: false } })
  assert.equal(result.createdAtMs, 1000)
  assert.equal(result.producerDeadline, 11000)
  assert.equal(result.publicationDeadline, 61000)
  assert.equal(f.requestState.request.context, f.context)
  assert.equal(f.requestState.request.currentness.selection.value, f.developer)
  assert.equal(Object.hasOwn(f.env, "DEVELOPER_DIR"), false)
  assert.equal(f.state.selectorCalls.length, 1)
  assert.equal(f.requestState.dispatchCalls, 1)
})
test("FIRST caller uses one qualified capture then checks its private monitor after input awaits", async () => {
  const f = await requestFixture({ staticImage: true })
  const answer = await f.invoke({ context: f.context, root: "/owned", person: null, stateBranch: "main",
    input: { paths: ["owned.md"], files: [], message: "first", tidy: false } })
  assert.equal(answer.createdAtMs, 1000)
  assert.equal(answer.producerDeadline, 11000)
  assert.equal(answer.publicationDeadline, 61000)
  assert.equal(f.requestState.prepareCalls, 1)
  assert.equal(f.requestState.dispatchCalls, 1)
})
test("FIRST caller refuses unsupported invocation before preparing private payload or dispatching a worker", async () => {
  const f = await requestFixture()
  await assert.rejects(f.invoke({ context: f.context, input: {} }), { code: "producer_invocation_unqualified" })
  assert.equal(f.requestState.prepareCalls, 0)
  assert.equal(f.requestState.dispatchCalls, 0)
})
test("FIRST caller does not adopt changed policy after awaited input validation", async () => {
  const f = await requestFixture({ staticImage: true, changeAfterAwait: true })
  await assert.rejects(f.invoke({ context: f.context, input: { paths: [], files: [], message: "first", tidy: false } }),
    error => ["producer_currentness_changed", "publication_binding_changed"].includes(error.code))
  assert.equal(f.requestState.dispatchCalls, 0)
})
for (const change of ["file", "person", "environment", "operation", "deadline", "authority"]) {
  test(`FIRST private monitor refuses changed ${change} instead of adopting new inputs`, () => {
    const f = fixture({ staticImage: true })
    assert.equal(typeof f.begin, "function")
    const current = f.begin({ context: f.context, operationId: "owned", producerDeadline: 10000 })
    const input = { monitor: current.monitor, operationId: "owned", producerDeadline: 10000, root: "/owned", person: null, baseEnv: f.env }
    if (change === "file") f.content.set("/common/config", Buffer.from("CHANGED"))
    if (change === "person") input.person = "foreign"
    if (change === "environment") input.baseEnv = { ...f.env, GIT_CONFIG_COUNT: "1" }
    if (change === "operation") input.operationId = "foreign"
    if (change === "deadline") input.producerDeadline = 11000
    if (change === "authority") {
      current.authority.binding.branch = "refs/heads/foreign"
      current.footprint.records.length = 0
      f.content.set("/common/config", Buffer.from("CHANGED"))
    }
    assert.throws(() => f.assertCurrent(input))
  })
}
for (const change of [null, "policy-after-await", "native-generation", "closed-peer"]) {
  test(`FIRST actual executor validation ${change ?? "stable"} consumes the real private policy monitor without recapture`, async () => {
    const f = fixture({ staticImage: true })
    const currentness = f.begin({ context: f.context, operationId: "owned", producerDeadline: 10000 })
    const producer = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/producer-state.js"), "utf8")
    const access = producer.slice(producer.indexOf("export function producerExecution("), producer.indexOf("const folder ="))
      .replaceAll("export function", "function").replaceAll("export async function", "async function")
    const executions = new WeakMap(), capability = Object.freeze({})
    executions.set(capability, { active: true, id: "owned", authority: currentness.authority,
      currentnessMonitor: currentness.monitor, producerDeadline: 10000, self: { start: "self" },
      peer: { destroyed: change === "closed-peer" }, container: { pid: 20, start: "native" } })
    const initialQueries = f.state.queries.length
    const validate = vm.runInNewContext(`${access}\nvalidateExecution`, {
      executions, process: { pid: 30 }, assertFirstSaveCurrentness: f.assertCurrent,
      validateAuthority: () => assert.fail("Repeated full capture must not run"),
      Date: class extends Date { static now() { return f.state.clock } },
      fault: code => Object.assign(new Error(code), { code }),
      generation: pid => {
        if (change === "policy-after-await") f.content.set("/common/config", Buffer.from("CHANGED"))
        return pid === 30 ? { pid: 30, start: "self", parentPid: 20, group: 20 }
          : { pid: 20, start: change === "native-generation" ? "REUSED" : "native", group: 20 }
      },
    })
    if (change) await assert.rejects(validate(capability))
    else await validate(capability)
    assert.equal(f.state.queries.length, initialQueries)
  })
}
test("accepted actor creates an independent monitor by fresh capture and original-footprint comparison, not caller monitor reuse", () => {
  const f = fixture({ staticImage: true })
  const caller = f.begin({ context: f.context, operationId: "owned", producerDeadline: 10000 })
  const ownerContext = f.newActorContext()
  const acceptedOwner = f.begin({ context: ownerContext, operationId: "owned", producerDeadline: 10000,
    expectedAuthority: JSON.parse(JSON.stringify(caller.authority)), expectedFootprint: JSON.parse(JSON.stringify(caller.footprint)) })
  f.close(caller.monitor)
  f.owner.active = false
  assert.throws(() => f.assertCurrent({ monitor: caller.monitor, operationId: "owned", producerDeadline: 10000 }))
  const before = f.state.queries.length
  f.assertCurrent({ monitor: acceptedOwner.monitor, operationId: "owned", producerDeadline: 10000 })
  assert.equal(f.state.queries.length, before)
})
test("a new actor cannot adopt policy changed after the accepted transfer or renew the original operation deadline", () => {
  const f = fixture({ staticImage: true })
  const caller = f.begin({ context: f.context, operationId: "owned", producerDeadline: 10000 })
  const ownerContext = f.newActorContext()
  f.content.set("/common/config", Buffer.from("CHANGED"))
  assert.throws(() => f.begin({ context: ownerContext, operationId: "owned", producerDeadline: 10000,
    expectedAuthority: caller.authority, expectedFootprint: caller.footprint }))
})
for (const change of ["policy", "channel", "actor", "selector"]) {
  test(`actual body plus actual private monitor refuses ${change} drift in its final target await before truncation`, async () => {
    const f = change === "selector" ? await selectedFixture() : fixture({ staticImage: true })
    const deadline = change === "selector" ? 11000 : 10000
    const currentness = f.begin({ context: f.context, operationEnvironment: f.operationEnvironment,
      operationId: "owned", producerDeadline: deadline })
    const producer = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/producer-state.js"), "utf8")
    const access = producer.slice(producer.indexOf("export function producerExecution("), producer.indexOf("const folder ="))
      .replaceAll("export function", "function").replaceAll("export async function", "async function")
    const body = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/producer-body.js"), "utf8")
      .replace(/^import .*$/gmu, "").replaceAll("export async function", "async function")
    const executions = new WeakMap(), capability = Object.freeze({}), calls = []
    let approved = null, actorChanged = false
    const execution = { active: true, id: "owned", authority: currentness.authority,
      currentnessMonitor: currentness.monitor, commandBaseEnv: Object.freeze({ ...currentness.authority.env }),
      producerDeadline: deadline, publicationDeadline: deadline + 50000,
      terminalSchema: 2, protocol: { lastIntentSequence: 0, lastApprovalAckSequence: 0, lastCompletedSequence: 0 },
      peer: { destroyed: false }, self: { start: "self" }, container: { pid: 20, start: "native" },
      payload: { paths: ["owned.md"], files: [{ path: "owned.md", content: "NEW" }], message: "first", tidy: false },
      started: async () => {}, approve: async step => { approved = step.phase }, report: async () => {} }
    executions.set(capability, execution)
    const execute = vm.runInNewContext(`${access}\n${body}\nexecuteAcceptedDeskSave`, {
      executions, process: { pid: 30 }, assertFirstSaveCurrentness: f.assertCurrent,
      validateAuthority: () => assert.fail("Legacy policy query must not run"),
      Date: class extends Date { static now() { return f.state.clock } }, Buffer, path, createHash,
      fault: code => Object.assign(new Error(code), { code }),
      generation: pid => pid === 30 ? { pid: 30, start: actorChanged ? "reused" : "self", parentPid: 20, group: 20 }
        : { pid: 20, start: "native", group: 20 },
      personPrefix: () => "/owned", isPathContained: () => true,
      prepareDeskSaveInput: async () => ({ ...execution.payload,
        checkedFiles: [{ absolute: "/owned/owned.md", relativePath: "owned.md", content: "NEW" }] }),
      resolveWriteTarget: async () => {
        if (approved === "open") {
          if (change === "policy") f.content.set("/common/config", Buffer.from("CHANGED"))
          if (change === "channel") execution.peer.destroyed = true
          if (change === "actor") actorChanged = true
          if (change === "selector") execution.authority.env.DEVELOPER_DIR = "/foreign"
        }
      },
      constants: fs.constants,
      fs: { mkdir: async () => { calls.push("mkdir") }, open: async () => {
        calls.push("open"); return { fd: 17, writeFile: async () => { calls.push("write") }, close: async () => { calls.push("close") } }
      } },
      spawnSync: () => assert.fail("No Git effects may run"),
    })
    const result = await execute({ executionCapability: capability })
    assert.equal(result.state, "blocked")
    assert.deepEqual(calls, ["mkdir"])
    assert.equal(result.effects.open_files.length, 0)
    assert.equal(result.effects.dispatches.some(step => step.phase === "open"), false)
  })
}
for (const change of [null, "config", "branch", "admin", "environment"]) {
  test(`FIRST bounded currentness and the unchanged legacy predicate agree for ${change ?? "stable inputs"}`, () => {
    const f = fixture({ staticImage: true })
    const captured = f.begin({ context: f.context, operationId: "owned", producerDeadline: 10000 })
    const env = { ...f.env }
    if (change === "config") f.content.set("/common/config", Buffer.from("CHANGED"))
    if (change === "branch") f.content.set("/admin/HEAD", Buffer.from("ref: refs/heads/foreign\n"))
    if (change === "admin") f.content.set("/owned/.git", Buffer.from("gitdir: /foreign\n"))
    if (change === "environment") env.GIT_CONFIG_COUNT = "1"
    const args = { binding: captured.authority.binding, root: "/owned", env, deadline: 10000 }
    const actual = callback => { try { return { current: callback() } } catch { return { current: false } } }
    assert.deepEqual(actual(() => f.localCurrent(args)),
      actual(() => f.legacyCurrent(args.binding, { root: args.root, env })))
    assert.equal(actual(() => f.localCurrent(args)).current, change === null)
  })
}
