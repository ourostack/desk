// An inspection Git must never outlive the process that started it. A Git read that blocks forever (here: open() on a FIFO included from the repository's own configuration, with no writer) used to stay blocked after its parent died, because the parent's own timeout only works while the parent is alive. These tests kill the parent mid-read and assert that no Git process is left with its working directory in the fixture.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { readInspectionGit } from "../../../../../plugins/desk/mcp/src/runtime/git-inspection.js"
import { killAndWait } from "../_kill_and_wait.js"
import { blockedRepo, posixOnly, processesWithCwdUnder, waitForNoProcessesUnder } from "../_process_hygiene.js"

const modulePath = fileURLToPath(new URL("../../../../../plugins/desk/mcp/src/runtime/git-inspection.js", import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A parent that starts one blocked inspection read and then waits for it forever.
function startParent(t, { prot, env }, { timeoutMs }) {
  const script = `
    import { readInspectionGit } from ${JSON.stringify(pathToFileURL(modulePath).href)}
    readInspectionGit(${JSON.stringify(prot)}, ["symbolic-ref", "--quiet", "--short", "HEAD"], { timeoutMs: ${timeoutMs} }).then(() => process.exit(0), () => process.exit(3))
    process.stdout.write("started\\n")
    setInterval(() => {}, 1000)
  `
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: prot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] })
  t.after(() => killAndWait(parent))
  return parent
}

async function waitForBlockedGit(root) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = processesWithCwdUnder(root).filter((p) => /^git$/u.test(p.command))
    if (found.length > 0) return found
    await sleep(100)
  }
  assert.fail("the inspection read never started")
}

for (const [signal, timeoutMs, patienceMs] of [["SIGTERM", 60000, 3000], ["SIGKILL", 3000, 12000]]) {
  test(`killing the parent with ${signal} mid-read leaves no Git process behind`, { skip: posixOnly }, async (t) => {
    const f = blockedRepo(t)
    const parent = startParent(t, f, { timeoutMs })
    await waitForBlockedGit(f.root)
    parent.kill(signal)
    await new Promise((resolve) => parent.once("exit", resolve))
    const left = await waitForNoProcessesUnder(f.root, patienceMs)
    assert.deepEqual(left, [], `${signal}: orphaned process(es) still in the fixture`)
  })
}

test("a parent that calls process.exit() mid-read leaves no Git process behind", { skip: posixOnly }, async (t) => {
  const f = blockedRepo(t)
  const script = `
    import { readInspectionGit } from ${JSON.stringify(pathToFileURL(modulePath).href)}
    readInspectionGit(${JSON.stringify(f.prot)}, ["symbolic-ref", "HEAD"], { timeoutMs: 60000 }).catch(() => {})
    setTimeout(() => process.exit(0), 700)
  `
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: f.prot, env: { ...process.env, ...f.env }, stdio: "ignore" })
  t.after(() => killAndWait(parent))
  await new Promise((resolve) => parent.once("exit", resolve))
  assert.deepEqual(await waitForNoProcessesUnder(f.root, 3000), [])
})

test("a signal handler registered by the host keeps the process alive: the reaper kills Git but does not re-raise", { skip: posixOnly }, async (t) => {
  const f = blockedRepo(t)
  const script = `
    import { readInspectionGit } from ${JSON.stringify(pathToFileURL(modulePath).href)}
    process.on("SIGTERM", () => { process.stdout.write("host handled\\n"); setTimeout(() => process.exit(0), 200) })
    readInspectionGit(${JSON.stringify(f.prot)}, ["symbolic-ref", "HEAD"], { timeoutMs: 60000 }).catch(() => {})
    process.stdout.write("started\\n")
    setInterval(() => {}, 1000)
  `
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: f.prot, env: { ...process.env, ...f.env }, stdio: ["ignore", "pipe", "inherit"] })
  t.after(() => killAndWait(parent))
  let out = ""
  parent.stdout.on("data", (chunk) => { out += chunk })
  await waitForBlockedGit(f.root)
  parent.kill("SIGTERM")
  const [code] = await new Promise((resolve) => parent.once("exit", (...args) => resolve(args)))
  assert.equal(code, 0)
  assert.match(out, /host handled/u)
  assert.deepEqual(await waitForNoProcessesUnder(f.root, 3000), [])
})
