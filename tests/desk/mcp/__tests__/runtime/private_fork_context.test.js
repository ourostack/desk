import { test } from "node:test"
import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { mkdirSync, symlinkSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { startControllerProcess } from "../../../../../plugins/desk/mcp/src/readiness/controller-process.js"
import { controllerIdentity, deriveControllerEndpoint } from "../../../../../plugins/desk/mcp/src/readiness/identity.js"
import { readinessContracts } from "../../../../../plugins/desk/mcp/src/readiness/contracts.js"
import { createStatusInspection } from "../../../../../plugins/desk/mcp/src/runtime/status-inspection.js"
import { openDb, closeDb } from "../../../../../plugins/desk/mcp/src/db/init.js"

const policy = { lexical: "required", semantic: "unsupported" }
const helperUrl = new URL("../../../../../plugins/desk/mcp/src/runtime/desk-git-context.js", import.meta.url)
const controllerEntry = fileURLToPath(new URL("../../../../../plugins/desk/mcp/src/readiness/controller-child.js", import.meta.url))
const inspectionEntry = fileURLToPath(new URL("../../../../../plugins/desk/mcp/src/runtime/status-inspection-child.js", import.meta.url))

async function withMode(root, mode, action) {
  const names = ["DESK", "DESK_ISOLATED_HOSTED", "DESK_HOSTED", "DESK_BUILTIN_SCRIPT"]
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  try {
    process.env.DESK = root
    delete process.env.DESK_ISOLATED_HOSTED
    delete process.env.DESK_HOSTED
    delete process.env.DESK_BUILTIN_SCRIPT
    if (mode === "private") process.env.DESK_ISOLATED_HOSTED = "1"
    if (mode === "legacy") process.env.DESK_HOSTED = "1"
    return await action()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function assertLaunch(entry, args, options, expected, mode, root, extra = {}) {
  assert.deepEqual(args, [])
  const legacyOptions = { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true, ...extra }
  if (mode !== "private") {
    assert.equal(entry, expected)
    assert.deepEqual(options, legacyOptions, "marker-off options must remain byte-equivalent")
    return
  }
  assert.equal(entry, "--", "fork must receive a fixed separator, never the admitted private source filename")
  assert.deepEqual(options.stdio, legacyOptions.stdio)
  assert.equal(options.windowsHide, true)
  assert.equal(options.serialization, extra.serialization)
  assert.equal(options.env.DESK, root)
  assert.equal(options.env.DESK_ISOLATED_HOSTED, "1")
  assert.equal(options.env.DESK_BUILTIN_SCRIPT, pathToFileURL(expected).href)
  assert.deepEqual(options.execArgv.slice(0, 2), ["--input-type=module", "--eval"])
  assert.ok(![entry, ...args, ...options.execArgv].some((arg) => arg.includes(root) || arg.includes(expected)))
}

test("fork adapter preserves local/legacy options and reuses the private script loader", async () => {
  const { deskForkInvocation, deskScriptInvocation } = await import(helperUrl)
  const root = await mkTempRoot("private-fork-helper-")
  const script = path.join(root, "private-source", "child.js")
  for (const env of [{}, { DESK_HOSTED: "1" }, { DESK_ISOLATED_HOSTED: "0" }]) {
    assert.deepEqual(deskForkInvocation({ script, env }), { modulePath: script, args: [], options: { execArgv: [] } })
  }
  const env = { ...process.env, DESK_ISOLATED_HOSTED: "1", DESK: root }
  const invocation = deskForkInvocation({ script, env })
  const launch = deskScriptInvocation({ script, args: [], env })
  assert.equal(invocation.modulePath, "--")
  assert.deepEqual([...invocation.options.execArgv, invocation.modulePath, ...invocation.args], launch.args)
  assert.deepEqual(invocation.options.env, launch.options.env)
})

test("private controller imports do not attach their entrypoint unless the admitted script URL matches", async () => {
  const { deskForkInvocation } = await import(helperUrl)
  const invocation = deskForkInvocation({
    script: path.join(await mkTempRoot("private-fork-nonentry-"), "not-controller.js"),
    env: { ...process.env, DESK_ISOLATED_HOSTED: "1" },
  })
  const child = fork(invocation.modulePath, [], {
    ...invocation.options,
    execArgv: ["--input-type=module", "--eval", 'await import(process.env.TEST_CONTROLLER_URL); process.send({ listeners: process.listenerCount("message") }); process.disconnect()'],
    env: { ...invocation.options.env, TEST_CONTROLLER_URL: pathToFileURL(controllerEntry).href },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  })
  let reply
  child.on("message", (message) => { reply = message })
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  assert.equal(code, 0)
  assert.deepEqual(reply, { listeners: 0 })
})

test("private controller/status roots refuse outside and symlink-escaped contexts before any fork", async () => {
  const root = await mkTempRoot("private-fork-authority-")
  const outside = await mkTempRoot("private-fork-outside-")
  const escape = path.join(root, "escape")
  symlinkSync(outside, escape, "junction")
  await withMode(root, "private", async () => {
    for (const target of [outside, escape, path.join(root, "missing")]) {
      const spawn = () => assert.fail("refused root must not launch a child")
      const refusal = (error) => {
        assert.equal(error.code, "DESK_GIT_CONTEXT_REFUSED")
        assert.ok(!error.message.includes(root) && !error.message.includes(outside))
        return true
      }
      assert.throws(() => createStatusInspection(target, { spawn }), refusal)
      await assert.rejects(startControllerProcess({ identity: { root: target } }, { spawn }), refusal)
    }
  })
})

for (const mode of ["local", "legacy", "private"]) {
  test(`${mode} real controller preserves guarded entry, IPC readiness, owner and normal close`, async () => {
    const root = await mkTempRoot("private-fork-controller-")
    const identity = controllerIdentity({ root, ...readinessContracts(policy) })
    const endpoint = deriveControllerEndpoint({ identity })
    const stateDir = path.join(root, "readiness", identity.id)
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    await withMode(root, mode, async () => {
      let calls = 0
      const controller = await startControllerProcess({ identity, endpoint, stateDir, policy, embed: null, ephemeral: true }, {
        spawn(entry, args, options) {
          calls += 1
          assertLaunch(entry, args, options, controllerEntry, mode, root)
          return fork(entry, args, options)
        },
      })
      try {
        assert.equal(calls, 1)
        assert.equal(controller.owner.kind, "controller_child")
        assert.ok(controller.owner.pid > 0)
      } finally {
        await controller.close()
      }
    })
  })

  test(`${mode} real status reader preserves advanced IPC and reads actual SQLite without retaining its handle`, async () => {
    const root = await mkTempRoot("private-fork-inspect-")
    const db = openDb(root)
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run("private_fork", "persisted")
    closeDb(db)
    await withMode(root, mode, async () => {
      let calls = 0
      const reader = createStatusInspection(root, {
        spawn(entry, args, options) {
          calls += 1
          assertLaunch(entry, args, options, inspectionEntry, mode, root, { serialization: "advanced" })
          return fork(entry, args, options)
        },
      })
      try {
        assert.equal((await reader.inspect("local")).local_db.state, "available")
        assert.equal((await reader.inspect("index")).generation, null)
        assert.equal(calls, 1, "one real child handles both phases")
      } finally {
        await reader.close()
      }
    })
    const reopened = openDb(root)
    try {
      assert.equal(reopened.prepare("SELECT value FROM meta WHERE key = ?").get("private_fork").value, "persisted")
    } finally {
      closeDb(reopened)
    }
  })
}
