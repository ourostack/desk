import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { mkTempDeskRoot, exists } from "./_helpers.js"
import { withCreatedDirs } from "../../../../../plugins/desk/mcp/src/util/created-dirs.js"
import { task_create, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { qualifyArchiveFailure } from "../../../../../plugins/desk/mcp/src/tools/archive-state.js"

// Historical Directory.Move protocol controls, not production-default evidence.
const load = () => import("./_legacy_directory_move.mjs")
const source = "C:\\desk\\task", destination = "C:\\desk\\_archive\\task"
const ready = { state: "ready", pid: 42, powershell: "5.1.26100.33438", edition: "Desktop",
  runtime: "4.0.30319.42000", api: "System.IO.Directory.Move" }
const success = { state: "result", moved: true, exception: null, hresult: null }
const refusal = { state: "result", moved: false, exception: "System.IO.IOException", hresult: -2147024713 }

function native(options = {}) {
  const child = new EventEmitter()
  child.pid = 42
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  const sent = []
  const emit = value => child.stdout.emit("data", Buffer.from(typeof value === "string" ? value : JSON.stringify(value) + "\n"))
  const close = (code = 0, signal = null) => child.emit("close", code, signal)
  child.stdin.write = value => {
    sent.push(value)
    queueMicrotask(() => options.start ? options.start({ child, emit, close }) : emit(ready))
  }
  child.stdin.end = value => {
    if (value) {
      sent.push(value)
      queueMicrotask(() => {
        if (options.release) options.release({ child, emit, close })
        else { emit(success); close() }
      })
    } else if (!options.holdClose) queueMicrotask(() => close(2))
  }
  child.kill = () => { if (!options.holdKill) queueMicrotask(() => close(null, "SIGTERM")) }
  const dependencies = { platform: "win32", env: { SystemRoot: "C:\\Windows" },
    realpath: async value => value, spawn(executable, args, settings) {
      assert.equal(executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
      assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
      assert.equal(createHash("sha256").update(args[4]).digest("hex"),
        "4e41cc66ef0e98ec2cecb5ff6cb3a6b57a8c9f91759eecffc4c0372a88f7b2fa")
      assert.equal(settings.windowsHide, true)
      return child
    },
    setTimeout: (callback, ms) => setTimeout(callback, ms / 1000), clearTimeout,
  }
  return { child, sent, dependencies }
}

test("archive move waits for native readiness and precondition before releasing exact JSON paths", async () => {
  const { moveArchive } = await load(), f = native()
  let checked = false
  const result = await moveArchive(source, destination, async () => {
    assert.equal(f.sent.length, 1)
    await Promise.resolve()
    checked = true
  }, f.dependencies)
  assert.equal(checked, true)
  assert.deepEqual(f.sent, [JSON.stringify({ source, destination }) + "\n", "move\n"])
  assert.equal(result.movement, "confirmed")
  assert.equal(result.retirement, "confirmed")
})

test("precondition failure remains primary when native close cannot be confirmed; never releases", async () => {
  const { moveArchive } = await load(), f = native({ holdClose: true, holdKill: true })
  const primary = new Error("source changed")
  await assert.rejects(moveArchive(source, destination, async () => { throw primary }, f.dependencies), error => {
    assert.equal(error, primary)
    assert.equal(error.archiveMove.released, false)
    assert.equal(error.archiveMove.retirement, "unconfirmed")
    assert.equal(typeof error.native_close_failure, "string")
    assert.equal(f.sent.length, 1)
    return true
  })
})

for (const [name, start] of [
  ["spawn error", ({ child, close }) => { child.emit("error", new Error("SECRET_PATH")); close(-1) }],
  ["stdin error", ({ child, close }) => { child.stdin.emit("error", new Error("SECRET_PATH")); close(2) }],
  ["close before READY", ({ close }) => close(4)],
  ["malformed readiness", ({ emit, close }) => { emit("SECRET_PATH\n"); close(4) }],
  ["unexpected state", ({ emit, close }) => { emit({ state: "program_error" }); close(4) }],
  ["null item", ({ emit, close }) => { emit("null\n"); close(4) }],
  ["oversized stdout", ({ emit, close }) => { emit("x".repeat(16385)); close(4) }],
  ["oversized stderr", ({ child, close }) => { child.stderr.emit("data", Buffer.alloc(16385)); close(4) }],
  ["readiness timeout", () => {}],
]) test(`${name} never releases and never leaks raw native output`, async () => {
  const { moveArchive } = await load(), f = native({ start })
  await assert.rejects(moveArchive(source, destination, () => assert.fail("not ready"), f.dependencies), error => {
    assert.equal(error.archiveMove.released, false)
    assert.equal(error.message.includes("SECRET_PATH"), false)
    return true
  })
  assert.equal(f.sent.length, 1)
})

test("unavailable runtime, synchronous spawn and path resolution failures are explicit and private", async () => {
  const { moveArchive } = await load()
  for (const override of [
    { env: {} }, { spawn() { throw new Error("SECRET_PATH") } },
    { realpath() { throw new Error("SECRET_PATH") } },
  ]) await assert.rejects(moveArchive(source, destination, async () => {}, { ...native().dependencies, ...override }),
    error => !error.message.includes("SECRET_PATH"))
})

test("a close error cannot replace the failed precondition", async () => {
  const { moveArchive } = await load(), f = native()
  const end = f.child.stdin.end
  f.child.stdin.end = value => {
    if (!value) { end(); throw new Error("SECRET_CLOSE_ERROR") }
    end(value)
  }
  const primary = new Error("source changed")
  await assert.rejects(moveArchive(source, destination, async () => { throw primary }, f.dependencies), error => {
    assert.equal(error, primary)
    assert.equal(error.archiveMove.released, false)
    assert.equal(error.native_close_failure, "native input closure failed")
    return true
  })
})

test("synchronous native write and kill errors stay private and preserve the first failure", async () => {
  const { moveArchive } = await load()
  const writeFailure = native()
  writeFailure.child.stdin.write = () => { throw new Error("SECRET_INPUT_PATH") }
  await assert.rejects(moveArchive(source, destination, async () => {}, writeFailure.dependencies),
    error => !error.message.includes("SECRET"))
  const killFailure = native({ holdClose: true, holdKill: true })
  killFailure.child.kill = () => { throw new Error("SECRET_KILL_PATH") }
  const primary = new Error("precondition")
  await assert.rejects(moveArchive(source, destination, async () => { throw primary }, killFailure.dependencies), error => {
    assert.equal(error, primary)
    assert.equal(error.archiveMove.released, false)
    assert.equal(error.archiveMove.retirement, "unconfirmed")
    assert.equal(error.native_close_failure, "native retirement unconfirmed")
    return true
  })
})

test("synchronous release-pipe failure is uncertain, not a native refusal or a path leak", async () => {
  const { moveArchive } = await load(), f = native()
  const end = f.child.stdin.end
  f.child.stdin.end = value => {
    if (value) throw new Error("SECRET_RELEASE_PATH")
    end()
  }
  await assert.rejects(moveArchive(source, destination, async () => {}, f.dependencies), error => {
    assert.equal(error.message.includes("SECRET"), false)
    assert.equal(error.archiveMove.released, true)
    assert.equal(error.archiveMove.movement, "unconfirmed")
    assert.equal(error.archiveMove.retirement, "confirmed")
    return true
  })
})

test("a valid refusal received during normal retirement remains known not moved after ACK timeout", async () => {
  const { moveArchive } = await load(), f = native({ release: () => {} })
  const end = f.child.stdin.end
  f.child.stdin.end = value => {
    if (value) return end(value)
    f.child.stdout.emit("data", Buffer.from(JSON.stringify(refusal) + "\n"))
    f.child.emit("close", 3, null)
  }
  await assert.rejects(moveArchive(source, destination, async () => {}, f.dependencies), error => {
    assert.match(error.message, /acknowledgement exceeded/)
    assert.equal(error.archiveMove.movement, "refused")
    assert.equal(error.archiveMove.retirement, "confirmed")
    return true
  })
})

for (const [name, during] of [
  ["close", child => child.emit("close", 2, null)],
  ["protocol issue", child => child.stdout.emit("data", Buffer.from('{"state":"program_error"}\n'))],
]) test(`a native ${name} while awaiting the precondition prevents release`, async () => {
  const { moveArchive } = await load(), f = native()
  await assert.rejects(moveArchive(source, destination, async () => { during(f.child) }, f.dependencies),
    /native directory move/)
  assert.equal(f.sent.length, 1)
})

test("fragmented readiness and bounded diagnostics do not alter the move protocol", async () => {
  const { moveArchive } = await load(), f = native({ start: ({ child, emit }) => {
    const line = JSON.stringify(ready) + "\n"
    emit(line.slice(0, 10))
    emit(line.slice(10))
    child.stderr.emit("data", Buffer.from("bounded"))
  } })
  f.dependencies.env = { SYSTEMROOT: "C:\\Windows" }
  assert.equal((await moveArchive(source, destination, async () => {}, f.dependencies)).movement, "confirmed")
})

for (const [name, options, movement, retirement] of [
  ["native refusal", { release: ({ emit, close }) => { emit(refusal); close(3) } }, "refused", "confirmed"],
  ["missing ACK", { release: ({ close }) => close() }, "unconfirmed", "confirmed"],
  ["invalid ACK", { release: ({ emit, close }) => { emit("invalid\n"); close() } }, "unconfirmed", "confirmed"],
  ["signal after success ACK", { release: ({ emit, close }) => { emit(success); close(null, "SIGTERM") } }, "unconfirmed", "confirmed"],
  ["ACK without close", { release: ({ emit }) => emit(success), holdClose: true }, "unconfirmed", "forced"],
  ["unretired child", { release: () => {}, holdClose: true, holdKill: true }, "unconfirmed", "unconfirmed"],
  ["partial trailing ACK", { release: ({ emit, close }) => { emit(success); emit("partial"); close() } }, "unconfirmed", "confirmed"],
  ["wrong exit after ACK", { release: ({ emit, close }) => { emit(success); close(3) } }, "unconfirmed", "confirmed"],
  ["duplicate ACK", { release: ({ emit, close }) => { emit(success); emit(success); close() } }, "unconfirmed", "confirmed"],
  ["ACK before READY", { start: ({ emit, close }) => { emit(success); close() } }, "not_released", "confirmed"],
]) test(`archive move never claims success for ${name}`, async () => {
  const { moveArchive } = await load(), f = native(options)
  await assert.rejects(moveArchive(source, destination, async () => {}, f.dependencies), error => {
    assert.equal(error.archiveMove.movement, movement)
    assert.equal(error.archiveMove.retirement, retirement)
    assert.equal(error.message.includes(source), false)
    return true
  })
})

for (const bad of [
  "C:\\desk\\task.", "C:\\desk\\task ", "C:\\desk.\\task", "C:\\desk\\task:stream",
  "\\\\?\\C:\\desk\\task", "\\\\.\\C:\\desk\\task", "\\\\server\\share\\task",
  "C:task", "\\task", "relative", "C:\\desk\\NUL", "C:\\desk\\con.txt",
  "C:\\desk\\COM1", "C:\\desk\\lpt9.log", "C:\\desk\\COM¹",
  "C:\\desk\\CONIN$", "C:\\desk\\CONOUT$", "C:\\desk\\CLOCK$",
  "C:\\desk\\..\\task", "C:\\desk\\.\\task", null, undefined, 17,
  "C:\\" + "x".repeat(257), "C:\\desk\\a?b", "C:\\desk\\a\u0001b",
]) test(`unsupported native spelling refuses before spawn: ${JSON.stringify(bad)}`, async () => {
  const { moveArchive } = await load()
  let spawned = false
  for (const [src, dst] of [[bad, destination], [source, bad]]) {
    await assert.rejects(moveArchive(src, dst, async () => {}, {
      ...native().dependencies, spawn() { spawned = true; throw new Error("must not spawn") },
    }), /unsupported Windows archive path/)
  }
  assert.equal(spawned, false)
})

test("Node-resolved source and destination parent are independently validated before spawn", async () => {
  const { moveArchive } = await load()
  for (const badPath of [source, "C:\\desk\\_archive"]) {
    const f = native()
    f.dependencies.realpath = async value => value === badPath ? "C:\\ambiguous.\\task" : value
    f.dependencies.spawn = () => assert.fail("resolved unsafe path reached native spawn")
    await assert.rejects(moveArchive(source, destination, async () => {}, f.dependencies), /unsupported Windows archive path/)
  }
})

test("a short logical destination cannot bypass the physical destination length envelope through an alias", async () => {
  const { moveArchive } = await load(), f = native()
  f.dependencies.realpath = async value => value === source ? source : "C:\\" + "x".repeat(242)
  await assert.rejects(moveArchive(source, destination, async () => {}, f.dependencies), /unsupported Windows archive path/)
  assert.equal(f.sent.length, 0)
})

test("ordinary validated physical aliases preserve the exact logical paths sent to the native API", async () => {
  const { moveArchive } = await load(), f = native()
  f.dependencies.realpath = async value => value === source ? "D:\\physical\\task" : "D:\\physical\\_archive"
  await moveArchive(source, destination, async () => {}, f.dependencies)
  assert.deepEqual(JSON.parse(f.sent[0]), { source, destination })
})

test("ordinary drive paths retain Unicode apostrophes and metacharacters as JSON data", async () => {
  const { moveArchive } = await load(), f = native()
  const src = "D:\\désk's & $(literal)\\任务", dst = "D:\\désk's & $(literal)\\_archive\\任务"
  await moveArchive(src, dst, async () => {}, f.dependencies)
  assert.deepEqual(JSON.parse(f.sent[0]), { source: src, destination: dst })
})

test("POSIX move checks precondition then performs the ordinary filesystem rename", async () => {
  const { moveArchive } = await load(), root = await mkTempDeskRoot()
  const src = path.join(root, "source"), dst = path.join(root, "destination")
  await fs.mkdir(src)
  await fs.writeFile(path.join(src, "payload"), "unchanged")
  await moveArchive(src, dst, async () => assert.equal(await exists(src), true), { platform: "darwin" })
  assert.equal(await exists(src), false)
  assert.equal(await fs.readFile(path.join(dst, "payload"), "utf8"), "unchanged")
})

test("released unretired native move retains created parents but releases usage bookkeeping", async () => {
  const root = await mkTempDeskRoot(), parent = path.join(root, "new", "archive")
  const error = Object.assign(new Error("unconfirmed"), { archiveMove: { released: true, retirement: "unconfirmed" } })
  await assert.rejects(withCreatedDirs(parent, async () => { throw error }, { shouldCleanup: () => false }), error)
  assert.equal(await exists(parent), true)
  await fs.rename(path.join(root, "new"), path.join(root, "retained"))
  await assert.rejects(withCreatedDirs(parent, async () => { throw new Error("ordinary") }), /ordinary/)
  assert.equal(await exists(path.join(root, "new")), false)
})

test("confirmed native refusal still cleans newly created empty parents", async () => {
  const root = await mkTempDeskRoot(), parent = path.join(root, "new", "archive")
  await assert.rejects(withCreatedDirs(parent, async () => { throw new Error("refused") },
    { shouldCleanup: () => true }), /refused/)
  assert.equal(await exists(path.join(root, "new")), false)
})

test("retention survives another current user's last release without permanent usage counts", async () => {
  const root = await mkTempDeskRoot(), parent = path.join(root, "shared", "archive")
  let enterFirst, enterSecond, releaseFirst, releaseSecond
  const firstEntered = new Promise(resolve => { enterFirst = resolve })
  const secondEntered = new Promise(resolve => { enterSecond = resolve })
  const firstWait = new Promise(resolve => { releaseFirst = resolve })
  const secondWait = new Promise(resolve => { releaseSecond = resolve })
  // The ordinary caller creates the directory; the uncertain caller joins it.
  const ordinary = withCreatedDirs(parent, async () => {
    enterFirst()
    await firstWait
    throw new Error("ordinary last release")
  })
  const ordinaryRejected = assert.rejects(ordinary, /ordinary last release/)
  await firstEntered
  const uncertain = withCreatedDirs(parent, async () => {
    enterSecond()
    await secondWait
    throw new Error("uncertain first release")
  }, { shouldCleanup: () => false })
  const uncertainRejected = assert.rejects(uncertain, /uncertain first release/)
  await secondEntered
  releaseSecond()
  await uncertainRejected
  releaseFirst()
  await ordinaryRejected
  assert.equal(await exists(parent), true)
  await fs.rename(path.join(root, "shared"), path.join(root, "retained-shared"))
  await assert.rejects(withCreatedDirs(parent, async () => { throw new Error("fresh") }), /fresh/)
  assert.equal(await exists(path.join(root, "shared")), false)
})

test("released missing ACK is uncertain even while the original source identity is observed", async () => {
  const root = await mkTempDeskRoot(), src = path.join(root, "source"), dst = path.join(root, "archive")
  await fs.mkdir(src)
  const stat = await fs.lstat(src, { bigint: true })
  const error = Object.assign(new Error("ACK lost"), {
    archiveMove: { released: true, movement: "unconfirmed", retirement: "unconfirmed" },
  })

  await qualifyArchiveFailure(error, { effectiveRoot: root, srcDir: src, archiveDir: dst,
    sourceIdentity: `${stat.dev}:${stat.ino}:${stat.mode & 0o170000n}`, moved: false, published: false })
  assert.equal(error.archive_phase, "relocation_outcome_uncertain")
  assert.equal(error.possible_late_effect, true)
  assert.equal(error.actual_path, path.join(src, "task.md"))
})

test("never-released precondition and separate close failure remain distinguishable in the public message", async () => {
  const root = await mkTempDeskRoot(), src = path.join(root, "source")
  await fs.mkdir(src)
  const stat = await fs.lstat(src, { bigint: true })
  const error = Object.assign(new Error("precondition failed"), {
    archiveMove: { released: false, movement: "not_released", retirement: "unconfirmed" },
    native_close_failure: "native retirement unconfirmed",
  })
  await qualifyArchiveFailure(error, { effectiveRoot: root, srcDir: src, archiveDir: path.join(root, "archive"),
    sourceIdentity: `${stat.dev}:${stat.ino}:${stat.mode & 0o170000n}`, moved: false, published: false })
  assert.equal(error.archive_phase, "not_moved")
  assert.match(error.message, /^precondition failed; native retirement unconfirmed;/)
  assert.equal(error.possible_late_effect, undefined)
})

for (const [retirement, retained] of [["unconfirmed", true], ["confirmed", false]]) {
  test(`task_archive native ${retirement} failure preserves card and reports parent disposition`, async () => {
    const root = await mkTempDeskRoot()
    await task_create({ deskRoot: root, input: { track: "t", slug: "s", title: "S" }, schedulePush: () => {} })
    const card = path.join(root, "t", "s", "task.md"), before = await fs.readFile(card)
    const failure = Object.assign(new Error("native failure"), { archiveMove: {
      released: true, movement: retained ? "unconfirmed" : "refused", retirement,
    } })
    await assert.rejects(task_archive({ deskRoot: root, input: { track: "t", slug: "s", outcome: "cancelled" },
      schedulePush: () => {}, moveArchive: async (src, dst, atUse) => { await atUse(); throw failure },
    }), error => {
      assert.equal(error, failure)
      assert.equal(error.archive_phase, retained ? "relocation_outcome_uncertain" : "not_moved")
      if (retained) {
        assert.equal(error.created_parents, "retained_until_native_retirement_resolved")
        assert.match(error.message, /possible_late_effect=true/)
        assert.match(error.message, /created_parents=retained_until_native_retirement_resolved/)
        assert.match(error.message, /do not retry or reuse parents until native retirement is resolved/)
      }
      return true
    })
    assert.deepEqual(await fs.readFile(card), before)
    assert.equal(await exists(path.join(root, "t", "_archive")), retained)
  })
}

test("actual Windows native move preserves admitted Unicode/metacharacter payload", { skip: process.platform !== "win32" }, async () => {
  const { moveArchive } = await load(), base = await mkTempDeskRoot()
  const root = path.join(base, "任务's & $(data)")
  const src = path.join(root, "source"), dst = path.join(root, "archive")
  await fs.mkdir(root)
  await fs.mkdir(src)
  await fs.writeFile(path.join(src, "payload"), "exact")
  await moveArchive(src, dst, async () => {})
  assert.equal(await fs.readFile(path.join(dst, "payload"), "utf8"), "exact")
  assert.equal(await exists(src), false)
})

test("actual Windows occupied destination refuses and preserves both exact payloads", { skip: process.platform !== "win32" }, async () => {
  const { moveArchive } = await load(), root = await mkTempDeskRoot()
  const src = path.join(root, "source"), dst = path.join(root, "destination")
  await fs.mkdir(src)
  await fs.mkdir(dst)
  await fs.writeFile(path.join(src, "payload"), "source")
  await fs.writeFile(path.join(dst, "payload"), "destination")
  await assert.rejects(moveArchive(src, dst, async () => {}), error => {
    assert.equal(error.archiveMove.movement, "refused")
    assert.equal(error.archiveMove.retirement, "confirmed")
    return true
  })
  assert.equal(await fs.readFile(path.join(src, "payload"), "utf8"), "source")
  assert.equal(await fs.readFile(path.join(dst, "payload"), "utf8"), "destination")
})

for (const suffix of [".", " "]) {
  test(`actual Windows distinct trailing ${JSON.stringify(suffix)} object cannot move its normalization neighbor`,
    { skip: process.platform !== "win32" }, async () => {
      const { moveArchive } = await load(), root = await mkTempDeskRoot()
      const neighbor = path.join(root, "source"), ambiguous = neighbor + suffix
      const exact = "\\\\?\\" + ambiguous, dst = path.join(root, "destination")
      await fs.mkdir(neighbor)
      await fs.mkdir(exact)
      await fs.mkdir(dst)
      await fs.writeFile(path.join(neighbor, "payload"), "neighbor")
      await fs.writeFile(path.win32.join(exact, "payload"), "distinct")
      await fs.writeFile(path.join(dst, "payload"), "destination")
      // This cell fails, rather than waives, if this filesystem cannot make
      // the distinct object: there would be no qualified ambiguity fixture.
      assert.ok((await fs.readdir(root)).includes("source" + suffix))
      assert.notEqual((await fs.lstat(exact)).ino, (await fs.lstat(neighbor)).ino)
      for (const [src, dest] of [[ambiguous, dst], [neighbor, dst + suffix]]) {
        await assert.rejects(moveArchive(src, dest, () => assert.fail("unsupported path reached READY callback")),
          /unsupported Windows archive path/)
      }
      assert.equal(await fs.readFile(path.join(neighbor, "payload"), "utf8"), "neighbor")
      assert.equal(await fs.readFile(path.win32.join(exact, "payload"), "utf8"), "distinct")
      assert.equal(await fs.readFile(path.join(dst, "payload"), "utf8"), "destination")
    })
}
