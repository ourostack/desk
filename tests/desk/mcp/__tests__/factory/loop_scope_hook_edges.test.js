import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import Module, { createRequire } from "node:module"
import { Readable } from "node:stream"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { ID, scratch } from "./_session_helpers.js"

const require = createRequire(import.meta.url)
const hooks = fileURLToPath(new URL("../../../../../plugins/desk/hooks/", import.meta.url))
const loopFile = path.join(hooks, "loop-start.cjs")
const endFile = path.join(hooks, "lib", "factory-end.cjs")

async function withHook(file, overrides, body) {
  const cached = require.cache[file]
  const load = Module._load
  delete require.cache[file]
  Module._load = function (request, parent, ...args) {
    if (parent?.filename === file) {
      const replacement = overrides(request)
      if (replacement !== undefined) return replacement
    }
    return load.call(this, request, parent, ...args)
  }
  try { return await body(require(file)) }
  finally {
    Module._load = load
    if (cached === undefined) delete require.cache[file]
    else require.cache[file] = cached
  }
}

async function withExit(body) {
  const exit = process.exit
  const flag = process.env.DESK_FACTORY_HEADLESS
  let resolve
  let timer
  const exited = new Promise((ok, reject) => {
    resolve = ok
    timer = setTimeout(() => reject(new Error("hook did not finish")), 5000)
  })
  process.exit = (code) => resolve(code)
  try { await body(); assert.equal(await exited, 0) }
  finally {
    clearTimeout(timer)
    process.exit = exit
    if (flag === undefined) delete process.env.DESK_FACTORY_HEADLESS
    else process.env.DESK_FACTORY_HEADLESS = flag
  }
}

test("missing headless guard modules still refuse flagged sessions", async () => {
  const overrides = (request) => {
    if (request.endsWith("/headless-flag.cjs")) throw new Error("guard unavailable")
    if (request.endsWith("/loop-switch.cjs")) return { isLoopEnabled: () => true }
  }
  await withHook(loopFile, overrides, async ({ main }) => {
    for (const env of [null, {}, { DESK_FACTORY_HEADLESS: "" }, { DESK_FACTORY_HEADLESS: "0" }]) {
      assert.deepEqual(await main({ env, resolveRoot: async () => null }), { started: false, reason: "no_desk" })
    }
    assert.deepEqual(await main({ env: { DESK_FACTORY_HEADLESS: "1" } }), { started: false, reason: "headless_session" })
  })
  await withHook(endFile, overrides, async ({ runHook }) => {
    assert.equal(await runHook({ env: null }), "invalid")
    assert.equal(await runHook({ env: { DESK_FACTORY_HEADLESS: "0" } }), "invalid")
    assert.equal(await runHook({ env: { DESK_FACTORY_HEADLESS: "1" } }), "headless")
  })
})

test("the launcher's default root and person resolve before its child starts", () => scratch(async (ctx) => {
  const calls = []
  await withHook(loopFile, (request) => {
    if (request === "./lib/boot-checks.cjs") return { boundRoot: async () => ctx.desk }
    if (request === "node:child_process") return { spawn: (...args) => {
      calls.push(args)
      const child = new EventEmitter()
      queueMicrotask(() => child.emit("exit", 0))
      return child
    } }
  }, async ({ main }) => {
    assert.deepEqual(await main({ env: ctx.env }), { started: true, stopped: false })
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1][calls[0][1].indexOf("--desk") + 1], ctx.desk)
}))

test("end-hook launch handles missing nodes, spawn errors and successful ownership transfer", async () => {
  await withHook(endFile, (request) => {
    if (request.endsWith("/compatible-node.cjs")) return { compatibleNode: () => ({ node: "/fake-node" }) }
    if (request === "node:child_process") return { spawn: (node) => {
      const child = new EventEmitter()
      child.unref = () => {}
      queueMicrotask(() => child.emit(node === "/missing-node" ? "error" : "spawn", new Error("spawn failed")))
      return child
    } }
  }, async ({ launch }) => {
    await launch("/script", [], {}, () => ({}))
    await assert.rejects(launch("/script", [], {}, () => ({ node: "/missing-node" })), /spawn failed/)
    await launch("/script", [], {})
  })
})

test("end-hook root, child and person boundaries hold for each capture host", () => scratch(async (ctx) => {
  const log = path.join(ctx.base, "root-rollout.jsonl")
  await fs.writeFile(log, JSON.stringify({ payload: { id: ID } }) + "\n")
  await fs.mkdir(path.join(ctx.base, "copilot"), { recursive: true })
  const agencyPlugin = path.join(ctx.base, ".local", "agency", "plugins", "sessions", "fixture", "desk")
  await fs.mkdir(agencyPlugin, { recursive: true })
  await withHook(endFile, (request) => request === "node:os" ? { ...require("node:os"), homedir: () => ctx.base } : undefined, async ({ runHook, readInput }) => {
    const flag = process.env.DESK_FACTORY_HEADLESS
    process.env.DESK_FACTORY_HEADLESS = "1"
    try { assert.equal(await runHook(), "headless") }
    finally {
      if (flag === undefined) delete process.env.DESK_FACTORY_HEADLESS
      else process.env.DESK_FACTORY_HEADLESS = flag
    }
    const codex = { session_id: ID, transcript_path: log, cwd: ctx.desk, hook_event_name: "SessionEnd", reason: "other" }
    assert.equal(await runHook({ host: "codex", payload: codex, env: ctx.env, launch: async () => assert.fail("Codex only records") }), "written")
    assert.equal(await runHook({ host: "codex", payload: { ...codex, parent_thread_id: ID }, env: ctx.env }), "invalid")
    assert.equal(await runHook({ host: "copilot", payload: { sessionId: ID, cwd: ctx.desk }, env: ctx.env }), "invalid")
    const payload = { sessionId: ID, cwd: ctx.desk, reason: "unknown-reason" }
    assert.equal(await runHook({ host: "copilot", payload, env: { ...ctx.env, COPILOT_HOME: path.join(ctx.base, "copilot") }, launch: async () => {} }), "written")
    assert.equal(await runHook({
      host: "copilot", payload: { sessionId: ID, cwd: ctx.desk, stopReason: "end_turn" }, supportsFinalize: false,
      env: { ...ctx.env, HOME: "", COPILOT_HOME: undefined }, pluginRoot: agencyPlugin,
    }), "written")
    assert.equal(await runHook({
      host: "copilot", payload, env: { ...ctx.env, DESK_ACTIVATION_CONFIG: path.join(ctx.base, "missing-activation.json"), DESK: undefined },
      launch: async () => assert.fail("an unresolved desk must start nothing"),
    }), "unavailable")
    assert.equal(await runHook({ host: "copilot", payload, env: { ...ctx.env, DESK_PERSON: "../escape" } }), "invalid")
    const failed = new Readable({ read() { this.destroy(new Error("input failed")) } })
    assert.equal(await readInput(failed), null)
  })
}))

test("end-hook entry refuses recursive sessions and handles worker input failure", async () => {
  await withHook(endFile, () => undefined, async ({ main }) => {
    await withExit(async () => {
      process.env.DESK_FACTORY_HEADLESS = "1"
      main("/entry")
    })
    await withExit(async () => {
      process.env.DESK_FACTORY_HEADLESS = "0"
      main("/entry", [process.execPath, "/entry", "claude", "--factory-worker"], Readable.from(["{}"]))
    })
    await withExit(async () => {
      process.env.DESK_FACTORY_HEADLESS = "0"
      main("/entry", [process.execPath, "/entry", "claude", "--factory-worker"], {
        on: () => { throw new Error("input unavailable") },
        removeAllListeners: () => {},
        pause: () => {},
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 170))
  })
})

test("end-hook bounded worker closes after pipe failure and stops only its owned child", async () => {
  for (const event of ["error", "close", "deadline"]) {
    const signals = []
    await withHook(endFile, (request) => {
      if (request === "node:child_process") return { spawn: () => {
        const child = new EventEmitter()
        child.kill = (signal) => { signals.push(signal); child.emit("close", 0) }
        child.stdin = new EventEmitter()
        child.stdin.end = () => queueMicrotask(() => {
          if (event === "deadline") return
          child.stdin.emit("error", new Error("pipe closed"))
          child.emit(event, event === "error" ? new Error("spawn failed") : 0)
        })
        return child
      } }
    }, async ({ main }) => {
      await withExit(async () => {
        process.env.DESK_FACTORY_HEADLESS = "0"
        main("/entry", [process.execPath, "/entry", "claude"], Readable.from(["{}"]))
      })
    })
    assert.deepEqual(signals, event === "deadline" ? ["SIGKILL"] : [])
  }
})

test("launcher command entry exits quietly on headless and policy-refusal paths", async () => {
  for (const failed of [false, true]) {
    const load = Module._load
    const priorMain = process.mainModule
    const entry = new Module(loopFile)
    Module._load = function (request, parent, ...args) {
      if (failed && parent?.filename === loopFile && request.endsWith("/loop-switch.cjs")) {
        return { isLoopEnabled: () => { throw new Error("policy unavailable") } }
      }
      return load.call(this, request, parent, ...args)
    }
    process.mainModule = entry
    try {
      await withExit(async () => {
        process.env.DESK_FACTORY_HEADLESS = failed ? "0" : "1"
        entry.load(loopFile)
      })
    } finally {
      Module._load = load
      process.mainModule = priorMain
    }
  }
})
