import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { runOwnedProcess } from "../../../../../plugins/desk/mcp/src/runtime/recovery-state.js"
import { removeTree } from "../_remove_tree.js"
import { readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"

const quote = (value) => `'${value.replace(/'/gu, "'\\''")}'`

function members(group, includeDefunct = false) {
  const result = spawnSync("/bin/ps", [process.platform === "linux" ? "-s" : "-g", String(group), "-o", "pid=,pgid=,stat=,lstart="], { encoding: "utf8", timeout: 5000 })
  if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return []
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return result.stdout.trim().split("\n").map((line) => line.trim().split(/\s+/u))
    .filter((row) => Number(row[1]) === group && (includeDefunct || !/^[ZX]/u.test(row[2])))
}

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-native-owner-"))
  const home = path.join(dir, "home")
  mkdirSync(path.join(home, "gh"), { recursive: true })
  const env = { HOME: home, GH_CONFIG_DIR: path.join(home, "gh"), PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C",
    XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"), GIT_CONFIG_NOSYSTEM: "1" }
  const resources = []
  let final
  let active
  t.after(async () => {
    if (active) final = await active
    if (final?.resources.childrenClosed === false) {
      t.diagnostic(JSON.stringify({ retainedFixture: dir, resources: final.resources }))
      return
    }
    await removeTree(dir)
  })
  const run = async (command, args, duration = 10000, inspection = false) => {
      const events = []
      const began = Date.now()
      active = runOwnedProcess({
        command, args, cwd: dir, env, deadline: Date.now() + duration, inspection,
        spawnImpl: (...args) => {
          const child = spawn(...args)
          for (const event of ["exit", "close", "disconnect"]) child.on(event, () => events.push({ event, elapsedMs: Date.now() - began }))
          for (const [stream, value] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
            for (const event of ["end", "close"]) value?.on(event, () => events.push({ event: `${stream}.${event}`, elapsedMs: Date.now() - began }))
          }
          return child
        },
        onResource: (record) => {
          resources.push(record)
          writeFileSync(path.join(dir, "resources.json"), JSON.stringify(resources))
        },
      })
      final = await active
      t.diagnostic(JSON.stringify({ resources: final.resources, error: final.error, status: final.status,
        ...(final.resources.childrenClosed ? {} : { events }), ...(final.status ? { stderr: final.stderr.slice(0, 2000) } : {}) }))
      return final
  }
  return {
    dir, env, resources,
    // This primitive has no filer/delivery path; commands below are generated fixture-only Bash or Node.
    run: (block, duration) => run("/bin/bash", ["-c", block], duration),
    runCommand: run,
  }
}

async function ready(files, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (files.every((file) => existsSync(file) && readFileSync(file, "utf8").trim() !== "")) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail("The exact-owned native fixture did not become ready")
}

function inspector(f) {
  const script = path.join(f.dir, "inspector.mjs")
  const meta = path.join(f.dir, "inspector.json")
  const block = path.join(f.dir, "block.pid")
  const pending = new URL("../../../../../plugins/desk/mcp/src/runtime/pending-migrations.js", import.meta.url).href
  const recovery = new URL("../../../../../plugins/desk/mcp/src/runtime/recovery-state.js", import.meta.url).href
  const start = new URL("../../../../../plugins/desk/mcp/src/readiness/process-start.js", import.meta.url).href
  writeFileSync(script, `import {writeFileSync,renameSync} from "node:fs"
import {runBlock} from ${JSON.stringify(pending)}
import {inspectionContainment} from ${JSON.stringify(recovery)}
import {readProcessStart} from ${JSON.stringify(start)}
const containment=inspectionContainment()
const meta={pid:process.pid,start:await readProcessStart(process.pid),group:containment.pid}
writeFileSync(${JSON.stringify(`${meta}.tmp`)},JSON.stringify(meta))
renameSync(${JSON.stringify(`${meta}.tmp`)},${JSON.stringify(meta)})
await runBlock(${JSON.stringify(`printf '%s\\n' "$$" > ${quote(block)}\nexec sleep 30`)},{env:process.env,cwd:${JSON.stringify(f.dir)},timeoutMs:30000,containment})
`)
  return { script, meta, block }
}

async function witnessed(f, paths) {
  await ready([paths.meta, paths.block])
  const owner = f.resources.at(-1)
  assert.ok(owner.start)
  assert.equal(await readProcessStart(owner.childPid), owner.start)
  assert.ok(owner.watchdog?.start)
  assert.equal(await readProcessStart(owner.watchdog.pid), owner.watchdog.start)
  const inner = JSON.parse(readFileSync(paths.meta, "utf8"))
  assert.equal(await readProcessStart(inner.pid), inner.start)
  const block = { pid: Number(readFileSync(paths.block, "utf8").trim()) }
  block.start = await readProcessStart(block.pid)
  assert.ok(block.start)
  const group = members(owner.group)
  assert.ok(group.some(([pid]) => Number(pid) === inner.pid))
  assert.ok(group.some(([pid]) => Number(pid) === block.pid), "Migration block must inherit the native owner's group")
  writeFileSync(path.join(f.dir, "fault-witnesses.json"), JSON.stringify({ owner, inner, block, group }))
  return { owner, inner, block }
}

async function killWitnessed(actor) {
  const current = await readProcessStart(actor.pid)
  if (current === null) return false
  assert.equal(current, actor.start, "Never signal a recycled fixture PID")
  const state = spawnSync("/bin/ps", ["-p", String(actor.pid), "-o", "stat="], { encoding: "utf8", timeout: 5000 })
  if (state.status === 1 && !state.stdout.trim()) return false
  assert.equal(state.status, 0, state.stderr)
  if (/^[ZX]/u.test(state.stdout.trim())) return false
  process.kill(actor.pid, "SIGKILL")
  return true
}

test("the private native owner returns success only after actual group closure", async (t) => {
  const f = fixture(t)
  const result = await f.run("printf success")
  assert.equal(result.status, 0, result.error)
  assert.equal(result.stdout, "success")
  assert.ok(result.resources.start)
  assert.equal(result.resources.childrenClosed, true)
  assert.deepEqual(members(result.resources.group), [])
})

for (const persistent of [false, true]) test(persistent
  ? "persistent watchdog identity uncertainty refuses before native effects within the original bootstrap cap"
  : "one transient watchdog identity-read timeout recovers before any native grant", async (t) => {
  const f = fixture(t)
  const trace = path.join(f.dir, "identity-probes.jsonl")
  const observer = path.join(f.dir, "identity-observer.cjs")
  writeFileSync(observer, `const cp=require("node:child_process")
const fs=require("node:fs")
const {syncBuiltinESMExports}=require("node:module")
const original=cp.spawnSync
let first=true
cp.spawnSync=function(command,args,options){
  if(!process.argv.includes("--native-watchdog")||command!=="/bin/ps")return original(command,args,options)
  const delayed=${persistent}||first;first=false
  const result=delayed?original("/bin/sh",["-c",'sleep 1.1; exec /bin/ps "$@"',"owned-read-only-probe",...args],options):original(command,args,options)
  fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,parent:process.ppid,delayed,status:result.status,error:result.error?.code,timeout:options.timeout})+"\\n")
  return result
}
syncBuiltinESMExports()
`)
  f.env.NODE_OPTIONS = `--require=${observer}`
  const result = await f.run("printf bounded")
  const observations = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse)
  assert.equal(observations[0].error, "ETIMEDOUT")
  assert.equal(observations[0].timeout, 1000)
  assert.equal(result.resources.childrenClosed, true)
  if (persistent) {
    assert.equal(result.status, null)
    assert.equal(result.requestSent, false)
    assert.equal(result.stdout, "")
    assert.ok(["grant_not_received", "watchdog_lost"].includes(result.error), result.error)
  } else {
    assert.equal(result.status, 0, JSON.stringify(result))
    assert.equal(result.stdout, "bounded")
    assert.ok(observations.some((observation) => observation.status === 0 && !observation.delayed))
  }
  t.diagnostic(JSON.stringify({ observations, resources: result.resources, harnessSignals: [] }))
})

test("a Bash leader exiting with an owned descendant does not become clean success", async (t) => {
  const f = fixture(t)
  const pid = path.join(f.dir, "descendant.pid")
  const generation = path.join(f.dir, "descendant.start")
  const result = await f.run(`sleep 30 &\nprintf '%s\\n' "$!" > ${quote(pid)}\n/bin/ps -p "$!" -o lstart= > ${quote(generation)}\nexit 0`)
  assert.equal(existsSync(pid), true)
  assert.ok(readFileSync(generation, "utf8").trim())
  assert.equal(result.status, null)
  assert.equal(result.error, "descendants_outlived_command")
  assert.equal(result.resources.childrenClosed, true)
  assert.deepEqual(members(result.resources.group), [])
})

for (const persistent of [false, true]) test(persistent
  ? "persistent closure uncertainty preserves actual command effects and expires without false success"
  : "one unavailable closure read is retried without replaying the completed command", async (t) => {
  const f = fixture(t)
  const trace = path.join(f.dir, "closure-probes.jsonl")
  const executions = path.join(f.dir, "executions")
  const observer = path.join(f.dir, "closure-observer.cjs")
  writeFileSync(observer, `const cp=require("node:child_process")
const fs=require("node:fs")
const {syncBuiltinESMExports}=require("node:module")
const original=cp.spawnSync
let first=true
cp.spawnSync=function(command,args,options){
  if(!process.argv.includes("--native-owner")||command!=="/bin/ps"||!["-g","-s"].includes(args[0]))return original(command,args,options)
  const delayed=${persistent}||first;first=false
  const result=delayed?original("/bin/sh",["-c",'sleep .35; exec /bin/ps "$@"',"owned-read-only-probe",...args],options):original(command,args,options)
  fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,delayed,status:result.status,error:result.error?.code,timeout:options.timeout})+"\\n")
  return result
}
syncBuiltinESMExports()
`)
  f.env.NODE_OPTIONS = `--require=${observer}`
  const result = await f.run(`printf once >> ${quote(executions)}; printf bounded`, persistent ? 3000 : 10000)
  const observations = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse)
  assert.equal(observations[0].error, "ETIMEDOUT")
  assert.equal(observations[0].timeout, 250)
  assert.equal(result.status, persistent ? null : 0, JSON.stringify(result))
  if (persistent) assert.equal(result.timedOut, true)
  assert.equal(result.stdout, "bounded")
  assert.equal(readFileSync(executions, "utf8"), "once")
  assert.equal(result.resources.childrenClosed, true)
  t.diagnostic(JSON.stringify({ observations, resources: result.resources, harnessSignals: [] }))
})

test("a hung command is stopped by its independent finite native owner", async (t) => {
  const f = fixture(t)
  const pid = path.join(f.dir, "command.pid")
  const began = Date.now()
  const result = await f.run(`printf '%s\\n' "$$" > ${quote(pid)}\nexec sleep 30`, 6000)
  assert.equal(existsSync(pid), true, "The real command began before the deadline")
  assert.equal(result.status, null)
  assert.equal(result.timedOut, true)
  assert.equal(result.resources.childrenClosed, true)
  assert.ok(Date.now() - began < 10000)
  assert.deepEqual(members(result.resources.group), [])
})

for (const laterEmpty of [true, false]) test(`known descendant cleanup grace survives real unknown inventory; laterEmpty=${laterEmpty}`, async (t) => {
  const f = fixture(t)
  const trace = path.join(f.dir, "mixed-inventories.jsonl")
  const observed = path.join(f.dir, "positive-observation")
  const generation = path.join(f.dir, "descendant.json")
  const effects = path.join(f.dir, "effects")
  const descendant = path.join(f.dir, "descendant.mjs")
  const start = new URL("../../../../../plugins/desk/mcp/src/readiness/process-start.js", import.meta.url).href
  writeFileSync(descendant, `import {writeFileSync,existsSync} from "node:fs"
import {readProcessStart} from ${JSON.stringify(start)}
writeFileSync(${JSON.stringify(generation)},JSON.stringify({pid:process.pid,start:await readProcessStart(process.pid)}))
const watching=setInterval(()=>{if(existsSync(${JSON.stringify(observed)})){clearInterval(watching);setTimeout(()=>process.exit(0),${laterEmpty ? 350 : 30000})}},5)
`)
  const observer = path.join(f.dir, "mixed-observer.cjs")
  writeFileSync(observer, `const cp=require("node:child_process")
const fs=require("node:fs")
const {syncBuiltinESMExports}=require("node:module")
const original=cp.spawnSync
let count=0
let positive=false
let afterPositive=0
cp.spawnSync=function(command,args,options){
  if(!process.argv.includes("--native-owner")||command!=="/bin/ps"||!["-g","-s"].includes(args[0]))return original(command,args,options)
  count++
  const delayed=positive&&(${laterEmpty ? "++afterPositive===1" : "true"})
  const result=delayed?original("/bin/sh",["-c",'sleep .35; exec /bin/ps "$@"',"owned-read-only-probe",...args],options):original(command,args,options)
  const actor=fs.existsSync(${JSON.stringify(generation)})?JSON.parse(fs.readFileSync(${JSON.stringify(generation)},"utf8")):null
  const seen=!positive&&result.status===0&&String(result.stdout??"").split("\\n").some(line=>line.trim().split(/\\s+/)[1]===String(actor?.pid))
  fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,count,delayed,positive:seen,status:result.status,error:result.error?.code,timeout:options.timeout,stdout:String(result.stdout??"")})+"\\n")
  if(seen){positive=true;fs.writeFileSync(${JSON.stringify(observed)},"observed")}
  return result
}
syncBuiltinESMExports()
`)
  f.env.NODE_OPTIONS = `--require=${observer}`
  const result = await f.run(`${quote(process.execPath)} ${quote(descendant)} &\nwhile [ ! -s ${quote(generation)} ]; do sleep .01; done\nprintf once >> ${quote(effects)}\nexit 0`, 10000)
  const actor = JSON.parse(readFileSync(generation, "utf8"))
  const inventories = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse)
  const firstPositive = inventories.findIndex((inventory) => inventory.positive)
  assert.ok(firstPositive >= 0, "A real inventory positively observed the descendant before the injected timeout")
  assert.ok(actor.start)
  assert.equal(inventories[firstPositive + 1].error, "ETIMEDOUT")
  assert.equal(result.status, null, JSON.stringify(result))
  assert.equal(result.error, "descendants_outlived_command")
  assert.ok(inventories[firstPositive + 1].timeout < 250, "The active grace bounds the next observation too")
  assert.equal(readFileSync(effects, "utf8"), "once")
  assert.equal(result.resources.childrenClosed, true)
  assert.deepEqual(members(result.resources.group), [])
  t.diagnostic(JSON.stringify({ actor, inventories, resources: result.resources, effects: "once", harnessSignals: [] }))
})

test("losing the inspector still closes its contained migration child", async (t) => {
  const f = fixture(t)
  const paths = inspector(f)
  const running = f.runCommand(process.execPath, [paths.script], 30000, true)
  let actors
  try {
    actors = await witnessed(f, paths)
    await killWitnessed(actors.inner)
    const result = await running
    assert.equal(result.status, null)
    assert.equal(result.resources.childrenClosed, true)
    assert.deepEqual(members(actors.owner.group), [])
    t.diagnostic(JSON.stringify({ exitedKernelRecords: members(actors.owner.group, true) }))
  } finally {
    if (actors) {
      await killWitnessed(actors.inner)
      await killWitnessed(actors.block)
    }
    await running
  }
})

test("the independent watchdog bounds children after native-owner loss", async (t) => {
  const f = fixture(t)
  const paths = inspector(f)
  const running = f.runCommand(process.execPath, [paths.script], 30000, true)
  let actors
  try {
    actors = await witnessed(f, paths)
    await killWitnessed({ pid: actors.owner.childPid, start: actors.owner.start })
    const result = await running
    assert.equal(result.status, null)
    assert.equal(result.resources.childrenClosed, true)
    assert.equal(result.error, "native_outcome_unknown")
    assert.deepEqual(members(actors.owner.group), [])
    t.diagnostic(JSON.stringify({ productClosedGroup: actors.owner.group, outcome: "native response unknown", generations: actors }))
  } finally {
    if (actors) {
      const inspectorCleanup = await killWitnessed(actors.inner)
      const blockCleanup = await killWitnessed(actors.block)
      assert.equal(inspectorCleanup || blockCleanup, false, "Harness cleanup cannot supply product closure")
    }
    await running
    if (actors) {
      const end = Date.now() + 2000
      while (members(actors.owner.group).length > 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25))
      assert.deepEqual(members(actors.owner.group), [], "Harness retirement is separate from product closure")
      t.diagnostic(JSON.stringify({ exitedKernelRecords: members(actors.owner.group, true) }))
    }
  }
})

test("the native owner bounds children after watchdog loss", async (t) => {
  const f = fixture(t)
  const paths = inspector(f)
  const running = f.runCommand(process.execPath, [paths.script], 30000, true)
  let actors
  try {
    actors = await witnessed(f, paths)
    await killWitnessed(actors.owner.watchdog)
    const result = await running
    assert.equal(result.status, null)
    assert.equal(result.resources.childrenClosed, true)
    assert.deepEqual(members(actors.owner.group), [])
  } finally {
    if (actors) {
      const first = await killWitnessed(actors.inner)
      const second = await killWitnessed(actors.block)
      assert.equal(first || second, false, "Product must close the actors without harness assistance")
    }
    await running
  }
})

test("multiple controller losses retain unknown and do not invent finite closure", async (t) => {
  const f = fixture(t)
  const paths = inspector(f)
  const running = f.runCommand(process.execPath, [paths.script], 30000, true)
  let actors
  try {
    actors = await witnessed(f, paths)
    assert.equal(await readProcessStart(actors.owner.watchdog.pid), actors.owner.watchdog.start)
    process.kill(actors.owner.watchdog.pid, "SIGSTOP")
    await killWitnessed({ pid: actors.owner.childPid, start: actors.owner.start })
    const result = await running
    assert.equal(result.status, null)
    assert.equal(result.resources.childrenClosed, false)
    assert.ok(["helper_closure_unknown", "stdio_closure_unknown"].includes(result.error), result.error)
  } finally {
    const cleanup = {}
    if (actors) {
      cleanup.watchdog = await killWitnessed(actors.owner.watchdog)
      cleanup.inspector = await killWitnessed(actors.inner)
      cleanup.block = await killWitnessed(actors.block)
    }
    await running
    if (actors) {
      const end = Date.now() + 2000
      while (members(actors.owner.group).length > 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25))
      assert.deepEqual(members(actors.owner.group), [])
      t.diagnostic(JSON.stringify({ multiFaultProductOutcome: "unknown", group: actors.owner.group, harnessCleanup: cleanup, generations: actors }))
    }
  }
})
