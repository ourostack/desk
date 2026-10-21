// Test-only controller checks plus the existing archive criteria, not production adoption.
import "../_isolated_env.mjs"
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import * as harness from "./archive_handoff_qualification_child.mjs"

const owned = { root: "C:\\owned", src: "C:\\owned\\source", dst: "C:\\owned\\archive",
  env: {}, person: null }
function controller(options = {}) {
  const trace = []
  const primary = new Error("controlled operation failure")
  const cleanup = new Error("controlled cleanup failure")
  const session = {
    receipt: { scope: "synthetic_controller_only" },
    async admit() { trace.push("admit") },
    async move(atUse) {
      trace.push("move-entered")
      await atUse()
      trace.push("go")
      return { movement: "confirmed" }
    },
    async close() {
      trace.push("close")
      if (options.closeFails) throw cleanup
    },
  }
  const dependencies = {
    candidate: true, platform: "win32",
    async lstat() {
      if (options.sourceMissing) throw Object.assign(new Error("owned source absent"), { code: "ENOENT" })
      if (options.sourceProbeFails) throw primary
      return { isDirectory: () => true }
    },
    async openSession(pair) {
      assert.deepEqual(pair, { source: owned.src, destination: owned.dst })
      trace.push("capture")
      return session
    },
    async runArchive(input) {
      trace.push("actual-operation-and-preparation")
      if (options.prepareFails) throw primary
      if (options.sourceMissing) return { status: "already_archived" }
      const atUse = async () => {
        trace.push("real-at-use")
        if (options.atUseFails) throw primary
      }
      await input.moveArchive(owned.src, owned.dst, atUse)
      return { status: "archived" }
    },
  }
  return { trace, primary, cleanup, session, dependencies }
}

test("synthetic controller: capture precedes the corresponding operation and admission precedes its real callback", async () => {
  const f = controller()
  const result = await harness.archiveOwned(owned, {}, f.dependencies)
  assert.equal(result.status, "archived")
  assert.deepEqual(f.trace, ["capture", "actual-operation-and-preparation", "admit", "move-entered",
    "real-at-use", "go", "close"])
})

test("synthetic controller: the capture-to-preparation control runs while its session is held", async () => {
  const f = controller()
  f.dependencies.afterCapture = async () => { f.trace.push("controlled-between-capture-and-preparation") }
  await harness.archiveOwned(owned, {}, f.dependencies)
  assert.deepEqual(f.trace.slice(0, 3), ["capture", "controlled-between-capture-and-preparation",
    "actual-operation-and-preparation"])
  assert.equal(f.trace.at(-1), "close")
})

test("synthetic controller: snapshot receipts are reread before settled observation and after cleanup", async () => {
  const f = controller()
  Object.defineProperty(f.session, "receipt", { get: () => ({ stage: f.trace.at(-1) }) })
  f.dependencies.decorateMove = (delegate, observation) => async (...args) => {
    const result = await delegate(...args)
    assert.equal(observation.native.stage, "go")
    return result
  }
  await harness.archiveOwned(owned, {}, f.dependencies)
  assert.equal(harness.archiveCandidateObservations({ includeSynthetic: true }).at(-1).native.stage, "close")
})

test("synthetic controller: a capture failure retains its safe receipt without claiming the operation ran", async () => {
  const f = controller()
  f.primary.handleReceipt = { scope: "synthetic_controller_only", capturedValidated: false, cleanupConfirmed: true }
  f.dependencies.openSession = async () => { f.trace.push("capture"); throw f.primary }
  await assert.rejects(harness.archiveOwned(owned, {}, f.dependencies), error => error === f.primary)
  const observation = harness.archiveCandidateObservations({ includeSynthetic: true }).at(-1)
  assert.equal(observation.sourceCapture, "capture_failed")
  assert.equal(observation.operationOutcome, "not_entered")
  assert.deepEqual(observation.native, f.primary.handleReceipt)
  assert.deepEqual(f.trace, ["capture"])
})

for (const condition of ["prepareFails", "atUseFails"]) {
  test(`synthetic controller: ${condition} stays primary and closes without releasing GO`, async () => {
    const f = controller({ [condition]: true })
    await assert.rejects(harness.archiveOwned(owned, {}, f.dependencies), error => error === f.primary)
    assert.equal(f.trace.at(-1), "close")
    assert.equal(f.trace.includes("go"), false)
    assert.equal(f.trace.filter(step => step === "close").length, 1)
  })
}

test("synthetic controller: an absent source does not capture or turn an archived path into a relocation", async () => {
  const f = controller({ sourceMissing: true })
  assert.equal((await harness.archiveOwned(owned, {}, f.dependencies)).status, "already_archived")
  assert.deepEqual(f.trace, ["actual-operation-and-preparation"])
})

test("synthetic controller: source probe errors are not silently treated as an archived path", async () => {
  const f = controller({ sourceProbeFails: true })
  await assert.rejects(harness.archiveOwned(owned, {}, f.dependencies), error => error === f.primary)
  assert.deepEqual(f.trace, [])
  const observation = harness.archiveCandidateObservations({ includeSynthetic: true }).at(-1)
  assert.equal(observation.operationOutcome, "not_entered")
  assert.equal(observation.failureStage, "before_operation")
})

test("synthetic controller: cleanup failure is separate and never replaces the preparation error", async () => {
  const f = controller({ prepareFails: true, closeFails: true })
  Object.freeze(f.primary)
  await assert.rejects(harness.archiveOwned(owned, {}, f.dependencies), error => error === f.primary)
  const observation = harness.archiveCandidateObservations({ includeSynthetic: true }).at(-1)
  assert.equal(observation.cleanupFailure, "native_session_close_unconfirmed")
  assert.equal(observation.operationOutcome, "threw")
})

test("synthetic controller: an early non-move return still retires its captured baseline", async () => {
  const f = controller()
  f.dependencies.runArchive = async () => {
    f.trace.push("preflight-return")
    return { status: "unchanged-preflight-result" }
  }
  const result = await harness.archiveOwned(owned, {}, f.dependencies)
  assert.equal(result.status, "unchanged-preflight-result")
  assert.deepEqual(f.trace, ["capture", "preflight-return", "close"])
})

test("synthetic controller: unconfirmed cleanup cannot return a success-shaped operation result", async () => {
  const f = controller({ closeFails: true })
  await assert.rejects(harness.archiveOwned(owned, {}, f.dependencies), error => error === f.cleanup)
  assert.equal(f.trace.at(-1), "close")
  assert.equal(harness.archiveCandidateObservations({ includeSynthetic: true }).at(-1).cleanupFailure,
    "native_session_close_unconfirmed")
})

test("synthetic controller: a wrong pair or repeated move cannot release a second attempt", async () => {
  for (const wrongPair of [true, false]) {
    const f = controller()
    f.dependencies.runArchive = async input => {
      if (!wrongPair) await input.moveArchive(owned.src, owned.dst, async () => {})
      await input.moveArchive(wrongPair ? "C:\\other\\source" : owned.src, owned.dst, async () => {})
    }
    await assert.rejects(harness.archiveOwned(owned, {}, f.dependencies), /one exact source\/destination attempt/u)
    assert.equal(f.trace.filter(step => step === "go").length, wrongPair ? 0 : 1)
    assert.equal(f.trace.at(-1), "close")
  }
})

test("synthetic controller: default qualification does not open a candidate session", async () => {
  const f = controller()
  f.dependencies.candidate = false
  f.dependencies.runArchive = async input => {
    assert.equal(input.moveArchive, undefined)
    return { status: "normal-default" }
  }
  assert.equal((await harness.archiveOwned(owned, {}, f.dependencies)).status, "normal-default")
  assert.deepEqual(f.trace, [])
})

test("registration only: aggregate qualification is registered once at file scope, without invoking any test callbacks", async () => {
  const script = `
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";
const tests = [], hooks = [];
const context = createContext({ process: Object.freeze({ platform: "darwin", env: Object.freeze({}) }) });
const source = new SourceTextModule(readFileSync(0, "utf8"), { context });
const cache = new Map();
await source.link(specifier => {
  if (cache.has(specifier)) return cache.get(specifier);
  let names = [], values = {};
  if (specifier === "node:test") {
    names = ["test", "after"];
    values = { test: name => { tests.push(name); }, after: hook => { hooks.push(hook); } };
  } else if (["node:assert/strict", "node:fs/promises", "node:path", "node:child_process"].includes(specifier)) {
    names = specifier === "node:child_process" ? ["spawnSync"] : ["default"];
    values = Object.fromEntries(names.map(name => [name, Object.freeze({})]));
  } else if (!["../_isolated_env.mjs", "./archive_handoff_qualification_child.mjs"].includes(specifier)) {
    throw new Error("Unexpected registration-control import");
  }
  const stub = new SyntheticModule(names, function () {
    for (const name of names) this.setExport(name, values[name]);
  }, { context });
  cache.set(specifier, stub);
  return stub;
});
await source.evaluate({ timeout: 1000 });
console.log(JSON.stringify({ scope: "captured_module_registration_only_no_test_callbacks",
  aggregateHooks: hooks.length, windowsCases: tests.filter(name => name.startsWith("actual Windows: ")).length }));
`
  const execArgv = process.execArgv.filter(arg => arg !== "--test" && !arg.startsWith("--test-"))
  const control = spawnSync(process.execPath, [...execArgv,
    "--import", new URL("../_isolated_env.mjs", import.meta.url).href,
    "--experimental-vm-modules", "--input-type=module", "-e", script], {
    input: await fs.readFile(new URL(import.meta.url), "utf8"), encoding: "utf8", env: process.env, timeout: 5000,
  })
  assert.equal(control.status, 0, control.error?.code ?? "captured module registration control failed")
  assert.deepEqual(JSON.parse(control.stdout), { scope: "captured_module_registration_only_no_test_callbacks",
    aggregateHooks: 1, windowsCases: 8 })
})

test("controlled transport: real archive retains new parents and publication state while native retirement is unknown",
  { timeout: 35000 }, async () => {
    const f = await harness.fixture("controller-native-retirement-unknown", { onGit: true, status: "done" })
    const parent = path.dirname(f.dst)
    assert.deepEqual(await fs.readdir(parent), [])
    await fs.rename(parent, path.join(f.base, "owned-empty-parent-before-attempt"))
    const original = await fs.readFile(f.card)
    const head = harness.git(f.root, "rev-parse", "HEAD"), index = harness.git(f.root, "ls-files", "-s")
    const requests = await harness.requests(f)
    assert.equal(harness.exists(parent), false)
    const primary = Object.assign(new Error("controlled released native outcome is unconfirmed"), {
      archiveMove: { released: true, closed: false, forced: true, movement: "unconfirmed", retirement: "unconfirmed" },
    })
    const session = {
      receipt: { scope: "controlled_transport_not_Windows_API" },
      async admit() {},
      async move(atUse) { await atUse(); throw primary },
      async close() { throw new Error("controlled native retirement remains unconfirmed") },
    }
    await assert.rejects(harness.archiveOwned(f, { input: { track: "t", slug: harness.SLUG } }, {
      candidate: true, platform: "win32", openSession: async () => session,
    }), error => error === primary)
    assert.equal(primary.archive_phase, "relocation_outcome_uncertain")
    assert.equal(primary.possible_late_effect, true)
    assert.equal(primary.created_parents, "retained_until_native_retirement_resolved")
    assert.match(primary.message, /do not retry or reuse parents/u)
    assert.equal(harness.exists(parent), true)
    assert.equal(harness.exists(f.dst), false)
    assert.equal((await fs.readFile(f.card)).equals(original), true)
    assert.equal(harness.git(f.root, "rev-parse", "HEAD"), head)
    assert.equal(harness.git(f.root, "ls-files", "-s"), index)
    assert.deepEqual(await harness.requests(f), requests)
    const observation = harness.archiveCandidateObservations({ includeSynthetic: true }).at(-1)
    assert.equal(observation.cleanupFailure, "native_session_close_unconfirmed")
    assert.equal(observation.operationOutcome, "threw")
  })

if (process.platform === "win32") {
  process.env.DESK_TEST_ARCHIVE_HANDLE_CANDIDATE = "1"
  await import("./archive_handoff_qualification.test.js")
} else {
  test("actual Windows: test-only candidate faces the unchanged normal archive qualification criteria",
    { skip: true }, () => {})
}

test("actual Windows: candidate refuses a destination occupied after the real freshness check",
  { skip: process.platform !== "win32", timeout: 35000 }, async () => {
    const f = await harness.fixture("candidate-late-occupied", { onGit: true, status: "done" })
    const original = await fs.readFile(f.card), foreign = Buffer.from("OWNED_INDEPENDENT_OCCUPIED_DESTINATION\n")
    const head = harness.git(f.root, "rev-parse", "HEAD"), index = harness.git(f.root, "ls-files", "-s")
    const requests = await harness.requests(f)
    let created = false
    await assert.rejects(harness.archiveOwned(f, { input: { track: "t", slug: harness.SLUG } }, {
      candidate: true,
      decorateMove: (delegate, observation) => {
        observation.control = "late_occupied_destination"
        return (source, destination, atUse) => delegate(source, destination, async () => {
          await atUse()
          await fs.mkdir(destination)
          await fs.writeFile(path.join(destination, "task.md"), foreign)
          created = true
        })
      },
    }), error => {
      assert.equal(error.archiveMove.movement, "refused")
      assert.equal(error.archiveMove.retirement, "confirmed")
      assert.equal(error.archiveMove.closed, true)
      assert.equal(error.archiveMove.forced, false)
      return true
    })
    assert.equal(created, true)
    assert.equal((await fs.readFile(f.card)).equals(original), true)
    assert.equal((await fs.readFile(f.archived)).equals(foreign), true)
    assert.equal(harness.git(f.root, "rev-parse", "HEAD"), head)
    assert.equal(harness.git(f.root, "ls-files", "-s"), index)
    assert.deepEqual(await harness.requests(f), requests)
  })

test("actual Windows: candidate preserves payload through Unicode and PowerShell-metacharacter path components",
  { skip: process.platform !== "win32", timeout: 35000 }, async () => {
    const f = await harness.fixture("candidate-\u8eab\u4efd's & $(literal)", { status: "done" })
    const original = await fs.readFile(f.card), companion = await fs.readFile(path.join(f.src, "companion.txt"))
    const result = await harness.archiveOwned(f, { input: { track: "t", slug: harness.SLUG } }, {
      candidate: true,
      decorateMove: (delegate, observation) => { observation.control = "unicode_literal_path"; return delegate },
    })
    assert.equal(result.status, "archived")
    assert.equal(harness.exists(f.src), false)
    assert.equal((await fs.readFile(f.archived)).equals(original), true)
    assert.equal((await fs.readFile(path.join(f.dst, "companion.txt"))).equals(companion), true)
  })

test("actual Windows: native capture defers an absent parent until the real operation creates it",
  { skip: process.platform !== "win32", timeout: 35000 }, async () => {
    const f = await harness.fixture("candidate-missing-destination-parent", { status: "done" })
    const parent = path.dirname(f.dst), original = await fs.readFile(f.card)
    assert.deepEqual(await fs.readdir(parent), [])
    await fs.rename(parent, path.join(f.base, "owned-empty-parent-before-native-capture"))
    const result = await harness.archiveOwned(f, { input: { track: "t", slug: harness.SLUG } }, {
      candidate: true,
      decorateMove: (delegate, observation) => { observation.control = "missing_destination_parent"; return delegate },
    })
    assert.equal(result.status, "archived")
    assert.equal(harness.exists(f.src), false)
    assert.equal((await fs.readFile(f.archived)).equals(original), true)
    const observation = harness.archiveCandidateObservations().at(-1)
    assert.equal(observation.destinationParentAtCapture, "deferred_until_admit")
    assert.equal(observation.native.destinationParentValidation, "validated")
    assert.equal(observation.native.cleanupConfirmed, true)
  })

async function substituteOwnedSource(f, reparse) {
  const original = new Map()
  for (const name of await fs.readdir(f.src)) {
    assert.equal((await fs.lstat(path.join(f.src, name))).isFile(), true)
    original.set(name, await fs.readFile(path.join(f.src, name)))
  }
  const retained = path.join(f.base, "native-captured-original")
  await fs.rename(f.src, retained)
  const replacement = new Map(original)
  replacement.set("companion.txt", Buffer.from("OWNED_INDEPENDENT_REPLACEMENT_PAYLOAD\n"))
  const target = reparse ? path.join(f.base, "owned-reparse-target") : f.src
  await fs.mkdir(target)
  for (const [name, bytes] of replacement) await fs.writeFile(path.join(target, name), bytes)
  if (reparse) await fs.symlink(target, f.src, "junction")
  return { original, retained, replacement, target }
}

for (const stage of ["capture_before_prepare", "prepare_before_admit", "freshness_before_delete", "reparse_before_delete"]) {
  test(`actual Windows: candidate rejects source substitution at ${stage}`,
    { skip: process.platform !== "win32", timeout: 35000 }, async () => {
      const f = await harness.fixture(`candidate-${stage}`, { status: "done" })
      const requests = await harness.requests(f)
      let substitution, callbacks = 0
      const substitute = async () => {
        assert.equal(substitution, undefined)
        substitution = await substituteOwnedSource(f, stage === "reparse_before_delete")
      }

      await assert.rejects(harness.archiveOwned(f, { input: { track: "t", slug: harness.SLUG } }, {
        candidate: true,
        afterCapture: stage === "capture_before_prepare" ? substitute : undefined,
        decorateMove: (delegate, observation) => {
          observation.control = stage
          return async (source, destination, atUse) => {
            if (stage === "prepare_before_admit") await substitute()
            return delegate(source, destination, async () => {
              await atUse()
              callbacks++
              if (stage === "freshness_before_delete" || stage === "reparse_before_delete") await substitute()
            })
          }
        },
      }), error => {
        const released = stage === "freshness_before_delete" || stage === "reparse_before_delete"
        assert.equal(error.archiveMove.released, released)
        assert.equal(error.archiveMove.movement, released ? "refused" : "not_released")
        assert.equal(error.archiveMove.retirement, "confirmed")
        assert.equal(error.archiveMove.closed, true)
        assert.equal(error.archiveMove.forced, false)
        return true
      })
      assert.ok(substitution)
      assert.equal(callbacks, stage === "capture_before_prepare" || stage === "prepare_before_admit" ? 0 : 1)
      assert.equal(harness.exists(f.dst), false)
      for (const [name, bytes] of substitution.original)
        assert.equal((await fs.readFile(path.join(substitution.retained, name))).equals(bytes), true)
      for (const [name, bytes] of substitution.replacement)
        assert.equal((await fs.readFile(path.join(substitution.target, name))).equals(bytes), true)
      assert.equal((await fs.lstat(f.src)).isSymbolicLink(), stage === "reparse_before_delete")
      assert.deepEqual(await harness.requests(f), requests)
      const observation = harness.archiveCandidateObservations().at(-1)
      assert.equal(observation.control, stage)
      assert.ok(observation.events.some(event => event.type === "move-callable-entered"))
      assert.equal(observation.cleanupFailure, null)
    })
}

after(async () => {
  if (process.platform !== "win32") return
  const artifact = JSON.parse(await fs.readFile(new URL("../../../../../windows-archive-race-observations.json", import.meta.url)))
  const observations = [...harness.archiveCandidateObservations(),
    ...artifact.actorReceipts.map(actor => {
      assert.equal(actor.receipt?.kind, "test_only_preadmitted_source_handle")
      assert.deepEqual(actor.missingNativeStages, [])
      return actor.receipt
    })]
  assert.ok(observations.length > 0)
  for (const observation of observations) {
    assert.equal(observation.scope, "actual_native_controller")
    assert.equal(observation.cleanupFailure, null)
    assert.equal(observation.droppedEvents, 0)
    const native = observation.native
    if (!native) {
      assert.equal(observation.sourceCapture, "not_applicable_source_absent")
      assert.equal(observation.operationOutcome, "returned")
      continue
    }
    assert.equal(native.scope, "test_only_native_preadmission_session")
    assert.equal(native.additionalNativeAdmission, true)
    assert.equal(native.nodeIdentityBridge, false)
    assert.equal(native.capturedValidated, true)
    assert.equal(native.cleanupConfirmed, true)
    assert.equal(native.handles.confirmedDisposed, true)
    assert.equal(native.archiveMove.closed, true)
    assert.equal(native.archiveMove.retirement, "confirmed")
    assert.equal(native.archiveMove.forced, false)
    assert.equal(native.uncertain, false)
    assert.deepEqual(native.protocolIssues, [])
    assert.equal(native.droppedEvents, 0)
    assert.equal(native.programSha256, native.executedProgramSha256)
    assert.equal(native.exit.signal, null)
    assert.equal(native.close.signal, null)
    assert.equal(native.exit.code, native.close.code)
    assert.ok([0, 3].includes(native.exit.code))
    for (const type of ["native_spawn", "capture_requested", "native_captured", "native_result",
      "native_exit", "native_close", "session_settled"])
      assert.ok(native.events.some(event => event.type === type), `Native lifecycle missing ${type}`)
    const capture = native.events.find(event => event.type === "native_captured")
    const entered = observation.events.find(event => event.type === "operation-entered")
    assert.ok(entered)
    assert.ok(BigInt(capture.monotonicNs) < BigInt(entered.monotonicNs))
    if (native.archiveMove.movement === "confirmed") {
      assert.equal(native.admissionValidated, true)
      assert.equal(native.rename.byHandle, true)
      assert.equal(native.rename.replaceIfExists, false)
      assert.equal(native.rename.success, true)
      assert.ok(Object.values(native.comparisons).every(Boolean))
    }
  }
  assert.deepEqual(harness.archiveCandidateObservations().map(observation => observation.control).filter(Boolean).sort(),
    ["late_occupied_destination", "unicode_literal_path", "missing_destination_parent", "capture_before_prepare",
      "prepare_before_admit", "freshness_before_delete", "reparse_before_delete"].sort())
})
