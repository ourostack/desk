import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { fork, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import * as server from "../../../../../plugins/desk/mcp/src/server.js"
import { startControllerProcess } from "../../../../../plugins/desk/mcp/src/readiness/controller-process.js"
import { connectOrStartController } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"
import { startReadinessController } from "../../../../../plugins/desk/mcp/src/readiness/controller-server.js"
import { HOOK_MARKER } from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"
import { controllerStartTimeoutMs } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"
import { mkTempRoot } from "../_temp_roots.js"

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test("cold real Git preparation admits a concurrent process before bounded status and durable acknowledgements", async (t) => {
  const base = await mkTempRoot("controller-prepare-")
  const folder = path.join(base, "desk")
  mkdirSync(path.join(folder, "_meta"), { recursive: true })
  mkdirSync(path.join(folder, "_archive"))
  const root = realpathSync(folder)
  const operation = `probe-${randomUUID()}.md`
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
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1350);
      }
      return spawn.call(this, command, args, ...rest);
    };
    syncBuiltinESMExports();
  `)
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
      })
    },
  })
  t.after(() => starting.then(client => client.close(), () => {}))
  const deadline = Date.now() + controllerStartTimeoutMs()
  while (!existsSync(preparingFile)) {
    assert.ok(Date.now() < deadline, "the real elected child must enter its published preparation")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const ownerFile = path.join(launchOptions.stateDir, "owner.json")
  const preparingOwner = JSON.parse(readFileSync(ownerFile, "utf8"))
  const peerEntry = path.join(base, "joining-session.mjs")
  const clientUrl = new URL("../../../../../plugins/desk/mcp/src/readiness/controller-client.js", import.meta.url).href
  writeFileSync(peerEntry, `
    import { connectOrStartController } from ${JSON.stringify(clientUrl)};
    const identity = ${JSON.stringify(launchOptions.identity)};
    let client;
    try {
      client = await connectOrStartController({
        root: identity.root, protocolVersion: identity.protocol_version,
        lexicalContract: identity.lexical_contract, semanticContract: identity.semantic_contract,
        stateHome: ${JSON.stringify(path.join(base, "state"))}, ephemeral: true,
        startController() { throw new Error("a joining session must not prepare another controller"); },
      });
      process.send({ accepted: true, owner: (await client.status()).owner, pid: process.pid });
    } catch (error) {
      process.send({ accepted: false, code: error.code, message: error.message });
    } finally {
      await client?.close();
      process.disconnect();
    }
  `)
  const peer = fork(peerEntry, [], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] })
  const peerExit = new Promise(resolve => peer.once("exit", resolve))
  t.after(async () => {
    if (peer.exitCode === null && peer.signalCode === null) peer.kill("SIGTERM")
    await peerExit
  })
  const peerResult = new Promise((resolve, reject) => {
    peer.once("message", resolve)
    peer.once("error", reject)
    peer.once("exit", code => {
      if (code !== 0) reject(new Error(`joining session exited ${code}`))
    })
  })
  const client = await starting
  let convergence
  try {
    const before = JSON.parse(readFileSync(callsFile, "utf8"))
    assert.deepEqual(before, ["rev-parse", "check-ignore", "rev-parse", "rev-parse", "ls-files"],
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
