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
import { mkTempRoot } from "../_temp_roots.js"

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test("cold real Git preparation finishes before readiness without delaying status or durable acknowledgements", async (t) => {
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
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1350);
      }
      return spawn.call(this, command, args, ...rest);
    };
    syncBuiltinESMExports();
  `)
  const client = await server.connectOrStartController({
    deskRoot: root, stateHome: path.join(base, "state"), ephemeral: true,
    policy: { semantic: "unsupported" },
    controllerLauncher: options => startControllerProcess(options, {
      spawn: (file, args, options) => fork(file, args, {
        ...options, execArgv: ["--import", pathToFileURL(preload).href],
      }),
    }),
  })
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
          prepared++
        },
      })
    },
  })
  try {
    assert.equal(prepared, 1)
    const ownerFile = path.join(options.stateDir, "owner.json")
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
