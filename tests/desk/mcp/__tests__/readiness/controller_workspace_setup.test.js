import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { fork, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import * as server from "../../../../../plugins/desk/mcp/src/server.js"
import { startControllerProcess } from "../../../../../plugins/desk/mcp/src/readiness/controller-process.js"
import { connectOrStartController, socketTakeoverGuards } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"
import { startReadinessController } from "../../../../../plugins/desk/mcp/src/readiness/controller-server.js"
import { ensureCardGuard, HOOK_MARKER, installCardGuard } from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"
import { controllerStartTimeoutMs, readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"
import { mkTempRoot } from "../_temp_roots.js"
import { killAndWait } from "../_kill_and_wait.js"

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

async function startupGuardFixture(t) {
  const root = await mkTempRoot("controller-startup-guard-")
  let options, running, sleeper
  const client = await connectOrStartController({
    root, stateHome: path.join(root, "state"), ephemeral: true,
    startController: async value => {
      options = value
      running = await startReadinessController(value)
      return running
    },
  })
  const ownerFile = path.join(options.stateDir, "owner.json")
  const original = readFileSync(ownerFile, "utf8")
  const sockets = new Set()
  t.after(async () => {
    if (existsSync(ownerFile)) writeFileSync(ownerFile, original)
    for (const socket of sockets) socket.destroy()
    await client.close()
    if (sleeper) await killAndWait(sleeper)
  })
  sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" })
  await new Promise((resolve, reject) => { sleeper.once("spawn", resolve); sleeper.once("error", reject) })
  const processStart = await readProcessStart(sleeper.pid)
  assert.equal(typeof processStart, "string", "the startup allowance requires actual process-generation verification")
  const record = JSON.parse(original)
  record.owner.pid = sleeper.pid
  record.owner.process_start = processStart
  record.startup = { started_at: new Date().toISOString() }
  writeFileSync(ownerFile, JSON.stringify(record))
  const listeners = running.server.listeners("connection")
  running.server.removeAllListeners("connection")
  let connections = 0
  return {
    ...options, ownerFile, record,
    connections: () => connections,
    observe(callback) {
      running.server.on("connection", socket => {
        sockets.add(socket)
        socket.on("error", () => socket.destroy())
        socket.once("close", () => sockets.delete(socket))
        connections++
        if (callback(connections)) for (const listener of listeners) listener(socket)
      })
    },
  }
}

const posixStartup = process.platform === "win32" ? "Windows uses bind-collision election, not the POSIX owner-before-bind guard" : false

test("verified preparation waits past an unanswered probe and joins without changing ownership", { skip: posixStartup }, async t => {
  const f = await startupGuardFixture(t)
  const before = readFileSync(f.ownerFile, "utf8")
  f.observe(connection => connection > 1)
  assert.equal(await socketTakeoverGuards[process.platform](f), true)
  assert.ok(f.connections() >= 2, "a later real handshake must succeed after the unanswered probe")
  assert.equal(readFileSync(f.ownerFile, "utf8"), before)
})

for (const change of ["corrupt", "token", "pid", "endpoint", "process-start", "ready", "different-endpoint"]) {
  test(`startup allowance stops for ${change} without reclaiming or waiting out a stale startup`, { skip: posixStartup }, async t => {
    const f = await startupGuardFixture(t)
    const mutate = () => {
      const record = structuredClone(f.record)
      if (change === "corrupt") writeFileSync(f.ownerFile, "{corrupt")
      else {
        if (change === "token") record.owner.token = "changed-owner-token"
        if (change === "pid") record.owner.pid = process.pid
        if (change === "endpoint" || change === "different-endpoint") record.endpoint += ".foreign"
        if (change === "process-start") record.owner.process_start += "-changed"
        if (change === "ready") delete record.startup
        writeFileSync(f.ownerFile, JSON.stringify(record))
      }
    }
    if (change === "different-endpoint") mutate()
    f.observe(connection => {
      if (connection === 1 && change !== "different-endpoint") mutate()
      return false
    })
    await assert.rejects(socketTakeoverGuards[process.platform](f), { code: "controller_owner_unresponsive" })
    assert.equal(f.connections(), change === "corrupt" || change === "different-endpoint" ? 1 : 2,
      "changed startup state must fall back to the ordinary single hung-owner handshake")
    assert.equal(existsSync(f.endpoint), true, "a live owner is never reclaimed")
  })
}

test("cold real Git preparation admits a concurrent process before bounded status and durable acknowledgements", async (t) => {
  const base = await mkTempRoot("controller-prepare-")
  const folder = path.join(base, "desk")
  mkdirSync(path.join(folder, "_meta"), { recursive: true })
  mkdirSync(path.join(folder, "_archive"))
  const root = realpathSync(folder)
  const operation = `probe-${randomUUID()}.md`
  // The preload below makes each of the child's Git checks this slow. The start window bounds the child's own start, so both deadlines get the injected delay on top; otherwise the 6.75 s it adds leaves an instrumented coverage child about 3 s to boot.
  const gitDelayMs = 1350
  const expectedGitChecks = ["rev-parse", "check-ignore", "rev-parse", "rev-parse", "ls-files"]
  const startWindowMs = controllerStartTimeoutMs() + gitDelayMs * expectedGitChecks.length
  writeFileSync(path.join(root, operation), "# Real controller preparation\n")
  for (const args of [
    ["init", "-b", "main"], ["config", "user.name", "Fixture"],
    ["config", "user.email", "fixture@example.invalid"], ["add", "."], ["commit", "-m", "fixture"],
  ]) git(root, args)
  await server.ensureIndex(root, { skipEmbed: true, snapshots: false, vectorPacks: false })
  const callsFile = path.join(base, "git-calls.json")
  const preparingFile = path.join(base, "published-preparation")
  const preload = path.join(base, "slow-real-git.mjs")
  writeFileSync(preload, `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { writeFileSync } from "node:fs";
    const spawn = childProcess.spawnSync;
    const calls = [];
    childProcess.spawnSync = function(command, args, ...rest) {
      if (command === "git" && args[0] === "-C" && args[1] === ${JSON.stringify(root)}) {
        calls.push(args[2]);
        writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
        if (calls.length === 3) writeFileSync(${JSON.stringify(preparingFile)}, "preparing");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${gitDelayMs});
      }
      return spawn.call(this, command, args, ...rest);
    };
    syncBuiltinESMExports();
  `)
  const peerEntry = path.join(base, "joining-session.mjs")
  const clientUrl = new URL("../../../../../plugins/desk/mcp/src/readiness/controller-client.js", import.meta.url).href
  writeFileSync(peerEntry, `
    import { connectOrStartController } from ${JSON.stringify(clientUrl)};
    import { startReadinessController } from ${JSON.stringify(new URL("./controller-server.js", clientUrl).href)};
    import { readFileSync } from "node:fs";
    process.once("message", async ({ identity, stateHome, ownerFile }) => {
      let client;
      try {
        const observedPreparing = Boolean(JSON.parse(readFileSync(ownerFile, "utf8")).startup);
        client = await connectOrStartController({
          root: identity.root, protocolVersion: identity.protocol_version,
          lexicalContract: identity.lexical_contract, semanticContract: identity.semantic_contract,
          stateHome, ephemeral: true,
          startController: options => startReadinessController({
            ...options,
            prepareRootSync() { throw new Error("a joining session must not prepare another controller"); },
          }),
        });
        process.send({ type: "result", accepted: true, observedPreparing, owner: (await client.status()).owner, pid: process.pid });
      } catch (error) {
        process.send({ type: "result", accepted: false, code: error.code, message: error.message });
      } finally {
        await client?.close();
        process.disconnect();
      }
    });
    process.send({ type: "loaded" });
  `)
  const peer = fork(peerEntry, [], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] })
  const peerExit = new Promise(resolve => peer.once("exit", resolve))
  t.after(async () => {
    if (peer.exitCode === null && peer.signalCode === null) peer.kill("SIGTERM")
    await peerExit
  })
  const peerResult = new Promise(resolve => {
    peer.on("message", message => { if (message.type === "result") resolve(message) })
    peer.once("error", error => resolve({ accepted: false, code: error.code, message: error.message }))
    peer.once("exit", code => resolve({ accepted: false, message: `joining session exited ${code} without a result` }))
  })
  await new Promise((resolve, reject) => {
    peer.on("message", message => { if (message.type === "loaded") resolve() })
    peer.once("error", reject)
    peer.once("exit", code => reject(new Error(`joining session exited ${code} before loading`)))
  })
  let launchOptions
  const starting = server.connectOrStartController({
    deskRoot: root, stateHome: path.join(base, "state"), ephemeral: true,
    policy: { semantic: "unsupported" },
    controllerLauncher: options => {
      launchOptions = options
      return startControllerProcess(options, {
        spawn: (file, args, options) => fork(file, args, {
          ...options, execArgv: ["--import", pathToFileURL(preload).href],
        }),
        timeoutMs: startWindowMs,
      })
    },
  })
  t.after(() => starting.then(client => client.close(), () => {}))
  const deadline = Date.now() + startWindowMs
  while (!existsSync(preparingFile)) {
    assert.ok(Date.now() < deadline, "the real elected child must enter its published preparation")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const ownerFile = path.join(launchOptions.stateDir, "owner.json")
  const preparingOwner = JSON.parse(readFileSync(ownerFile, "utf8"))
  peer.send({ identity: launchOptions.identity, stateHome: path.join(base, "state"), ownerFile })
  const client = await starting
  let convergence
  try {
    const before = JSON.parse(readFileSync(callsFile, "utf8"))
    assert.deepEqual(before, expectedGitChecks,
      "all real ignore/guard checks must finish before a controller is admitted")
    assert.ok(readFileSync(path.join(root, ".git", "hooks", "pre-commit"), "utf8").includes(HOOK_MARKER))
    git(root, ["check-ignore", "-q", ".state/desk-index.sqlite"])
    convergence = client.beginConvergence()
    const start = Date.now()
    const [status, recorded] = await Promise.all([client.status(), client.recordChange({ path: operation })])
    const elapsedMs = Date.now() - start
    assert.notEqual(status.owner.pid, process.pid)
    const joined = await peerResult
    assert.equal(joined.accepted, true, JSON.stringify(joined))
    assert.equal(joined.observedPreparing, true, "the independent session must enter during preparation, not after readiness")
    assert.notEqual(joined.pid, process.pid)
    assert.notEqual(joined.pid, status.owner.pid)
    assert.equal(joined.owner.pid, status.owner.pid, "both actual processes must use the single elected controller")
    const readyOwner = JSON.parse(readFileSync(ownerFile, "utf8"))
    assert.deepEqual(readyOwner.owner, preparingOwner.owner, "joining must preserve the elected owner generation and token")
    assert.equal(recorded.recorded, true)
    assert.ok(Number.isSafeInteger(recorded.sequence))
    assert.ok(elapsedMs < 5000, "the unchanged durable acknowledgement deadline still bounds the response")
    await convergence
    assert.deepEqual(JSON.parse(readFileSync(callsFile, "utf8")), before,
      "background convergence must not discover more cold synchronous Git setup")
    t.diagnostic(JSON.stringify({ gitChecksBeforeReady: before.length, statusAndRecordMs: elapsedMs }))
  } finally {
    await convergence?.catch(() => {})
    await client.close()
  }
})

test("only the bind winner prepares, after its owner record is published", async () => {
  const root = await mkTempRoot("controller-prepare-owner-")
  let prepared = 0
  let options
  const first = await connectOrStartController({
    root, stateHome: path.join(root, "state"), ephemeral: true,
    startController: value => {
      options = value
      return startReadinessController({
        ...value,
        prepareRootSync: () => {
          const record = JSON.parse(readFileSync(path.join(value.stateDir, "owner.json"), "utf8"))
          assert.equal(record.owner.pid, process.pid)
          assert.equal(record.identity.id, value.identity.id)
          assert.equal(typeof record.startup?.started_at, "string")
          prepared++
        },
      })
    },
  })
  try {
    assert.equal(prepared, 1)
    const ownerFile = path.join(options.stateDir, "owner.json")
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(ownerFile, "utf8")), "startup"), false,
      "ready owners must not retain a startup allowance")
    const digest = () => createHash("sha256").update(readFileSync(ownerFile)).digest("hex")
    const before = digest()
    let loserPrepared = false
    await assert.rejects(startReadinessController({
      ...options, prepareRootSync: () => { loserPrepared = true },
    }), { code: "EADDRINUSE" })
    assert.equal(loserPrepared, false)
    assert.equal(digest(), before, "the losing binder must not change the live owner's record")
  } finally {
    await first.close()
  }
})

test("finishing preparation refuses a replaced owner record without overwriting it", async () => {
  const root = await mkTempRoot("controller-prepare-replaced-")
  let controller, ownerFile, foreign
  try {
    await assert.rejects(connectOrStartController({
      root, stateHome: path.join(root, "state"), ephemeral: true,
      startController: async value => {
        controller = await startReadinessController({
          ...value,
          prepareRootSync: () => {
            ownerFile = path.join(value.stateDir, "owner.json")
            const record = JSON.parse(readFileSync(ownerFile, "utf8"))
            record.owner.token = "foreign-owner-must-remain"
            foreign = JSON.stringify(record)
            writeFileSync(ownerFile, foreign)
          },
        })
        return controller
      },
    }), { code: "controller_owner_changed" })
    assert.equal(readFileSync(ownerFile, "utf8"), foreign)
  } finally {
    await controller?.close()
  }
})

test("a real failed card-guard installation refuses readiness and can recover after confirmed repair", async t => {
  const root = await mkTempRoot("controller-preparation-soft-failure-")
  mkdirSync(path.join(root, "_meta"))
  mkdirSync(path.join(root, "_archive"))
  git(root, ["init", "-b", "main"])
  const hooks = path.join(root, ".managed-hooks")
  writeFileSync(hooks, "owned obstruction, not a hooks directory")
  git(root, ["config", "core.hooksPath", hooks])
  assert.equal(ensureCardGuard(root).state, "failed", "exercise the real helper's soft failure, not a thrown callback double")
  let options, unexpected, recovered
  const request = {
    deskRoot: root, stateHome: path.join(root, "state"), ephemeral: true,
    policy: { semantic: "unsupported" },
    controllerLauncher: value => {
      options = value
      return server.startControllerRuntime(value)
    },
  }
  t.after(async () => { await unexpected?.close(); await recovered?.close() })
  await assert.rejects(server.connectOrStartController(request).then(client => {
    unexpected = client
    return client
  }), { code: "controller_workspace_preparation_failed" })
  assert.equal(existsSync(path.join(options.stateDir, "owner.json")), false)
  if (process.platform !== "win32") assert.equal(existsSync(options.endpoint), false)
  assert.equal(readFileSync(hooks, "utf8"), "owned obstruction, not a hooks directory")
  renameSync(hooks, `${hooks}.held`)
  mkdirSync(hooks)
  recovered = await server.connectOrStartController(request)
  assert.equal(recovered.accepted, true)
  assert.ok(readFileSync(path.join(hooks, "pre-commit"), "utf8").includes(HOOK_MARKER))
  assert.equal(ensureCardGuard(root), null, "only successful preparation is cached before later index opening")
  await recovered.close()
  recovered = await server.connectOrStartController(request)
  assert.equal(recovered.accepted, true, "cached successful preparation remains a valid startup")
})

for (const kind of ["no-git", "tracked-hooks"]) {
  test(`controller preparation preserves the legitimate ${kind} helper outcome`, async t => {
    const root = await mkTempRoot(`controller-preparation-${kind}-`)
    mkdirSync(path.join(root, "_meta"))
    mkdirSync(path.join(root, "_archive"))
    let hook
    if (kind === "tracked-hooks") {
      git(root, ["init", "-b", "main"])
      mkdirSync(path.join(root, ".hooks"))
      hook = path.join(root, ".hooks", "pre-commit")
      writeFileSync(hook, "owned tracked hook must remain unchanged")
      git(root, ["config", "core.hooksPath", ".hooks"])
      git(root, ["add", ".hooks/pre-commit"])
    }
    assert.equal(installCardGuard(root).state, kind === "no-git" ? "skipped" : "tracked")
    const client = await server.connectOrStartController({
      deskRoot: root, stateHome: path.join(root, "state"), ephemeral: true,
      policy: { semantic: "unsupported" }, controllerLauncher: server.startControllerRuntime,
    })
    t.after(() => client.close())
    assert.equal(client.accepted, true)
    assert.equal(ensureCardGuard(root), null)
    if (hook) assert.equal(readFileSync(hook, "utf8"), "owned tracked hook must remain unchanged")
  })
}

for (const kind of ["throw", "async-return"]) {
  test(`preparation ${kind} refuses readiness and releases only its owned rendezvous`, async () => {
    const root = await mkTempRoot("controller-prepare-failure-")
    const original = new Error("owned preparation failed")
    let options
    let unexpected
    try {
      await assert.rejects(connectOrStartController({
        root, stateHome: path.join(root, "state"), ephemeral: true,
        startController: value => {
          options = value
          return startReadinessController({
            ...value,
            prepareRootSync: () => {
              if (kind === "throw") throw original
              return Promise.resolve()
            },
          })
        },
      }).then(value => { unexpected = value; return value }), error =>
        kind === "throw" ? error === original : /synchronously/u.test(error.message))
      assert.equal(existsSync(path.join(options.stateDir, "owner.json")), false)
      if (process.platform !== "win32") assert.equal(existsSync(options.endpoint), false)
    } finally {
      await unexpected?.close()
    }
  })
}
