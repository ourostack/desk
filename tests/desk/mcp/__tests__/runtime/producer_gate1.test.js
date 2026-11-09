import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createPublicationContext, closePublicationContext } from "../../../../../plugins/desk/mcp/src/runtime/publication-state.js"

const gate = await import("../../../../../plugins/desk/mcp/src/runtime/producer-state.js")

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desk-producer-gate1-"))
  const root = path.join(directory, "root"), home = path.join(directory, "home")
  fs.mkdirSync(root); fs.mkdirSync(home)
  const env = { PATH: "/usr/bin:/bin", HOME: home, XDG_STATE_HOME: path.join(directory, "state"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") }
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8", timeout: 5000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git("init", "-q", "-b", "main"); git("config", "user.name", "Gate fixture"); git("config", "user.email", "fixture@example.invalid")
  fs.writeFileSync(path.join(root, "owned"), "UNCHANGED\n"); git("add", "owned"); git("commit", "-qm", "fixture")
  const context = createPublicationContext({ root, env, sessionId: "gate1-owned" })
  t.after(() => t.diagnostic(JSON.stringify({ retainedFixture: directory })))
  return { root, env, context, git }
}

test("gate1 accepts one immutable read-only producer and qualifies actual native executor custody", async (t) => {
  const f = fixture(t), before = f.git("rev-parse", "HEAD")
  const intent = gate.createProducerReadOnlyIntent({ context: f.context })
  const queued = await gate.requestProducerReadOnly({ context: f.context, intent })
  const joined = await gate.requestProducerReadOnly({ context: f.context, intent })
  assert.equal(joined.id, queued.id)
  const final = await gate.flushProducer({ context: f.context, id: queued.id, timeoutMs: 12000 })
  t.diagnostic(JSON.stringify({ queued, final }))
  assert.equal(final.state, "capability_verified", JSON.stringify(final))
  assert.equal(final.producerDeadline, queued.createdAtMs + 10000)
  assert.equal(final.publicationDeadline, queued.createdAtMs + 60000)
  assert.equal(final.resources.childrenClosed, true)
  assert.equal(final.executionCount, 1)
  assert.equal(final.relationship.peerCredentials, false)
  assert.equal(final.relationship.executor.parentPid, final.relationship.native.pid)
  assert.equal(final.relationship.executor.group, final.relationship.native.group)
  assert.equal(f.git("rev-parse", "HEAD"), before)
  assert.equal(fs.readFileSync(path.join(f.root, "owned"), "utf8"), "UNCHANGED\n")
})

test("serialized producer data cannot mint a read-only dispatch capability", async (t) => {
  const f = fixture(t)
  const intent = gate.createProducerReadOnlyIntent({ context: f.context })
  await assert.rejects(gate.requestProducerReadOnly({ context: f.context, intent: JSON.parse(JSON.stringify(intent)) }),
    { code: "producer_intent_invalid" })
  closePublicationContext(f.context)
  await assert.rejects(gate.requestProducerReadOnly({ context: f.context, intent }), { code: "publication_context_invalid" })
})

for (const change of ["nonce", "used", "grant", "pid-reuse", "native-group", "parent", "owner", "missing"]) {
  test(`a ${change} claim cannot produce a gate1 execution relationship`, () => {
    const owner = { state: "present", pid: 10, start: "owner-generation" }
    const native = { state: "present", pid: 20, start: "native-generation", group: 20, parentPid: 10 }
    const executor = { state: "present", pid: 30, start: "executor-generation", group: 20, parentPid: 20 }
    const claim = { nonce: "controlled-private-nonce", pid: 30, start: "executor-generation",
      container: { pid: 20, start: "native-generation", token: "native-token" } }
    const expectedGrant = { id: "owned-operation", revision: 4, owner,
      native: { childPid: 20, start: "native-generation", group: 20, token: "native-token" } }
    const grant = structuredClone(expectedGrant)
    if (change === "nonce") claim.nonce = "different-private-value"
    if (change === "grant") grant.revision = 3
    if (change === "pid-reuse") executor.start = "reused-generation"
    if (change === "native-group") native.group = 90
    if (change === "parent") executor.parentPid = 90
    if (change === "owner") owner.state = "unknown"
    if (change === "missing") executor.state = "absent"
    assert.throws(() => gate.qualifyProducerExecutor({ claim, nonce: "controlled-private-nonce",
      used: change === "used", native, executor, owner, grant, expectedGrant }))
  })
}

test("an executor with a wrong private nonce receives no capability and performs zero fixture execution", async (t) => {
  const f = fixture(t)
  const preload = path.join(path.dirname(f.root), "wrong-nonce.cjs")
  fs.writeFileSync(preload, 'if(process.argv.includes("--producer-gate1-executor"))process.env.DESK_PRODUCER_EXECUTOR_NONCE="wrong-private-nonce";\n')
  const context = createPublicationContext({ root: f.root, env: { ...f.env, NODE_OPTIONS: `--require=${preload}` }, sessionId: "wrong-channel-nonce" })
  const intent = gate.createProducerReadOnlyIntent({ context })
  const initial = await gate.requestProducerReadOnly({ context, intent })
  const result = await gate.flushProducer({ context, id: initial.id, timeoutMs: 12000 })
  t.diagnostic(JSON.stringify({ result }))
  assert.equal(result.state, "blocked", JSON.stringify(result))
  assert.equal(result.executionCount, 0)
  assert.equal(result.resources.childrenClosed, true)
  assert.equal(result.outcome.stdout, "")
})

for (const cut of ["before-send", "sent-before-ack", "after-accept"]) {
  for (const cycle of cut === "before-send" ? [1] : [1, 2]) {
  test(`owned caller loss ${cut} cycle ${cycle} preserves gate1 acceptance and original deadlines`, async (t) => {
    const f = fixture(t)
    const directory = path.dirname(f.root)
    const callerFile = path.join(directory, "caller.mjs"), preload = path.join(directory, "caller-loss.cjs")
    const rootModule = new URL("../../../../../plugins/desk/mcp/src/runtime/", import.meta.url).href
    fs.writeFileSync(callerFile, `import {createPublicationContext} from ${JSON.stringify(rootModule + "publication-state.js")};
import {createProducerReadOnlyIntent,requestProducerReadOnly} from ${JSON.stringify(rootModule + "producer-state.js")};
const context=createPublicationContext({root:process.argv[2],env:process.env,sessionId:"lost-caller"});
const intent=createProducerReadOnlyIntent({context});await requestProducerReadOnly({context,intent});
`)
    const cutSource = cut === "before-send"
      ? `const fs=require("node:fs");const unlink=fs.unlinkSync;fs.unlinkSync=function(file){const r=unlink(file);if(String(file).endsWith(".tmp")&&String(file).includes(".producer-gate1"))process.kill(process.pid,"SIGKILL");return r;};`
      : `const cp=require("node:child_process");const spawn=cp.spawn;cp.spawn=function(...args){const child=spawn.apply(this,args);${
        cut === "sent-before-ack"
          ? 'const send=child.send.bind(child);child.send=function(message,callback){return send(message,(error)=>{callback?.(error);if(message.kind==="producer-grant"&&!error)process.kill(process.pid,"SIGKILL");});};'
          : 'child.on("message",message=>{if(message.kind==="producer-accepted")process.kill(process.pid,"SIGKILL");});'
      }return child;};`
    fs.writeFileSync(preload, `if(process.argv[1]?.endsWith("caller.mjs")){${cutSource}}\n`)
    const run = spawnSync(process.execPath, [callerFile, f.root], {
      env: { ...f.env, NODE_OPTIONS: `--require=${preload}` }, encoding: "utf8", timeout: 12000,
    })
    assert.equal(run.signal, "SIGKILL", run.stderr)
    const sync = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills/desk/sync")
    const journalDirectory = path.join(sync, fs.readdirSync(sync).find((name) => name.endsWith(".producer-gate1")))
    const filename = fs.readdirSync(journalDirectory).find((name) => /^[0-9a-f-]{36}\.json$/.test(name))
    const id = filename.slice(0, -5)
    const result = cut === "before-send" ? gate.readProducer({ context: f.context, id })
      : await gate.flushProducer({ context: f.context, id, timeoutMs: 12000 })
    t.diagnostic(JSON.stringify({ cut, caller: { status: run.status, signal: run.signal }, result }))
    assert.equal(result.producerDeadline, result.createdAtMs + 10000)
    assert.equal(result.publicationDeadline, result.createdAtMs + 60000)
    if (cut === "before-send") {
      assert.equal(result.state, "reserved")
      assert.equal(result.requestSent, false)
      assert.equal(result.executionCount, 0)
    } else {
      assert.equal(result.requestSent, true)
      assert.equal(result.state, "capability_verified", JSON.stringify(result))
      assert.equal(result.executionCount, 1)
      assert.equal(result.resources.childrenClosed, true)
    }
  })
}
}

test("a CLI operation ID and serialized journal never replace the required private caller channel", (t) => {
      const f = fixture(t)
      const script = new URL("../../../../../plugins/desk/mcp/scripts/sync-push.js", import.meta.url)
      const result = spawnSync(process.execPath, [script.pathname, "--producer-gate1", "11111111-1111-4111-8111-111111111111", "--root", f.root],
        { env: f.env, encoding: "utf8", timeout: 3000 })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /producer_private_channel_required/u)
      assert.equal(result.stdout, "")
    })

    test("a reported container substitution is refused against actual native parent/group witnesses", async (t) => {
      const f = fixture(t)
      const preload = path.join(path.dirname(f.root), "wrong-container.cjs")
      fs.writeFileSync(preload, 'if(process.argv.includes("--producer-gate1-executor")){const c=JSON.parse(process.env.DESK_RECOVERY_CONTAINER);c.pid+=1;process.env.DESK_RECOVERY_CONTAINER=JSON.stringify(c);}\n')
      const context = createPublicationContext({ root: f.root, env: { ...f.env, NODE_OPTIONS: `--require=${preload}` }, sessionId: "wrong-container" })
      const intent = gate.createProducerReadOnlyIntent({ context })
      const initial = await gate.requestProducerReadOnly({ context, intent })
      const final = await gate.flushProducer({ context, id: initial.id, timeoutMs: 12000 })
      t.diagnostic(JSON.stringify({ final }))
      assert.equal(final.state, "blocked", JSON.stringify(final))
      assert.equal(final.executionCount, 0)
      assert.equal(final.resources.childrenClosed, true)
      assert.equal(final.outcome.stdout, "")
    })

    test("a read-only executor hang is bounded by the original native deadline with truthful closure", async (t) => {
      const f = fixture(t)
      const preload = path.join(path.dirname(f.root), "hang-executor.cjs")
      fs.writeFileSync(preload, 'if(process.argv.includes("--producer-gate1-executor"))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000);\n')
      const context = createPublicationContext({ root: f.root, env: { ...f.env, NODE_OPTIONS: `--require=${preload}` }, sessionId: "hung-read-only" })
      const intent = gate.createProducerReadOnlyIntent({ context })
      const initial = await gate.requestProducerReadOnly({ context, intent })
      const final = await gate.flushProducer({ context, id: initial.id, timeoutMs: 14000 })
      t.diagnostic(JSON.stringify({ initial, final }))
      assert.equal(final.producerDeadline, initial.producerDeadline)
      assert.equal(final.publicationDeadline, initial.publicationDeadline)
      assert.ok(["blocked", "unknown"].includes(final.state))
      assert.equal(final.executionCount, 0)
      assert.equal(final.outcome.stdout, "")
      assert.equal(final.resources.childrenClosed, true, JSON.stringify(final))
    })

test("a definite private native-owner refusal cannot receive an executor capability or admission retry", async (t) => {
  const f = fixture(t)
  const preload = path.join(path.dirname(f.root), "refuse-native.cjs")
  fs.writeFileSync(preload, 'const i=process.argv.indexOf("--native-owner");if(i!==-1){process.send({kind:"refused",token:process.argv[i+1],reason:"native_owner_identity_unavailable"},()=>{process.disconnect();process.exit(1);});}\n')
  const context = createPublicationContext({ root: f.root, env: { ...f.env, NODE_OPTIONS: `--require=${preload}` }, sessionId: "native-refusal" })
  const intent = gate.createProducerReadOnlyIntent({ context })
  const initial = await gate.requestProducerReadOnly({ context, intent })
  const final = await gate.flushProducer({ context, id: initial.id, timeoutMs: 12000 })
  t.diagnostic(JSON.stringify({ final }))
  assert.equal(final.state, "blocked", JSON.stringify(final))
  assert.equal(final.outcome.error, "native_owner_identity_unavailable")
  assert.equal(final.outcome.requestSent, false)
  assert.equal(final.executionCount, 0)
  assert.equal(final.resources.childrenClosed, true)
  assert.equal(final.relationship, undefined)
})

test("a malformed verified journal cannot report gate1 proof from its state string", async (t) => {
  const f = fixture(t)
  const intent = gate.createProducerReadOnlyIntent({ context: f.context })
  const initial = await gate.requestProducerReadOnly({ context: f.context, intent })
  let final = await gate.flushProducer({ context: f.context, id: initial.id, timeoutMs: 12000 })
  assert.equal(final.state, "capability_verified")
  const cleanupUntil = Math.min(initial.producerDeadline + 2000, Date.now() + 2000)
  while (final.broker?.custody === "owned" && Date.now() < cleanupUntil) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    final = gate.readProducer({ context: f.context, id: initial.id })
  }
  assert.notEqual(final.broker?.custody, "owned", "Corruption controls require the writer's cleanup publication to settle first")
  const sync = path.join(f.env.XDG_STATE_HOME, "ouroboros-skills/desk/sync")
  const directory = path.join(sync, fs.readdirSync(sync).find((name) => name.endsWith(".producer-gate1")))
  const file = path.join(directory, `${initial.id}.json`)
  for (const changed of [
    { ...final, requestSent: false, executionCount: 0, owner: undefined, relationship: undefined, outcome: undefined },
    { ...final, outcome: { ...final.outcome, outputTruncated: undefined } },
    { ...final, outcome: { ...final.outcome, cancelled: true } },
    { ...final, resources: { ...final.resources, resultReceived: false } },
    { ...final, resources: { ...final.resources, inventory: { known: false } } },
    { ...final, relationship: { ...final.relationship, peerCredentials: true } },
    { ...final, resources: { ...final.resources, exitObserved: "false", resultReceived: "false" } },
    { ...final, resources: { ...final.resources, token: "" } },
    { ...final, resources: { ...final.resources, inventory: { known: true, members: { length: 0 } } } },
    { ...final, resources: { ...final.resources, inventory: { known: true, members: "" } } },
    { ...final, resources: { ...final.resources, group: undefined }, relationship: {
      ...final.relationship, native: { ...final.relationship.native, group: undefined },
      executor: { ...final.relationship.executor, group: undefined } } },
  ]) {
    fs.writeFileSync(file, JSON.stringify(changed))
    assert.throws(() => gate.readProducer({ context: f.context, id: initial.id }), { code: "producer_record_invalid" })
  }
})

test("a changed destination revision survives a stale producer transition before grant send", async (t) => {
  const f = fixture(t)
  const originalOpen = fs.openSync, originalClose = fs.closeSync
  let changedFile, selected, destination
  fs.openSync = (file, ...args) => {
    const fd = originalOpen(file, ...args)
    if (String(file).endsWith(".tmp") && String(file).includes(".producer-gate1")) {
      destination = String(file).replace(/\.[0-9a-f-]{36}\.tmp$/u, "")
      if (fs.existsSync(destination)) selected = fd
    }
    return fd
  }
  fs.closeSync = (fd) => {
    originalClose(fd)
    if (!changedFile && fd === selected) {
      changedFile = destination
      const live = JSON.parse(fs.readFileSync(destination, "utf8"))
      fs.writeFileSync(destination, JSON.stringify({ ...live, revision: 999, state: "unknown", reason: "external replacement" }))
    }
  }
  const { syncBuiltinESMExports } = await import("node:module"); syncBuiltinESMExports()
  try {
    const intent = gate.createProducerReadOnlyIntent({ context: f.context })
    await gate.requestProducerReadOnly({ context: f.context, intent })
    assert.ok(changedFile)
    assert.equal(JSON.parse(fs.readFileSync(changedFile, "utf8")).revision, 999)
  } finally { fs.openSync = originalOpen; fs.closeSync = originalClose; syncBuiltinESMExports() }
})

test("producer persistence failure stops later catch/cleanup writes and reports exact custody", async (t) => {
  const f = fixture(t)
  const preload = path.join(path.dirname(f.root), "journal-close-refusal.cjs")
  fs.writeFileSync(preload, `if(process.argv.includes("--producer-gate1")){const fs=require("node:fs");let writes=0,selected;const open=fs.openSync,close=fs.closeSync;fs.openSync=function(file,...args){const fd=open(file,...args);if(String(file).includes(".producer-gate1")&&String(file).endsWith(".tmp")){writes++;selected=fd;}return fd;};fs.closeSync=function(fd){close(fd);if(fd===selected&&writes===3)throw Object.assign(new Error("Owned close refusal"),{code:"EIO",syscall:"close"});};process.on("exit",()=>process.stderr.write("fixture-write-attempts:"+writes+"\\n"));}\n`)
  const callerFile = path.join(path.dirname(f.root), "persistence-caller.mjs")
  const runtime = new URL("../../../../../plugins/desk/mcp/src/runtime/", import.meta.url).href
  fs.writeFileSync(callerFile, `import{createPublicationContext}from${JSON.stringify(runtime + "publication-state.js")};import{createProducerReadOnlyIntent,requestProducerReadOnly,flushProducer}from${JSON.stringify(runtime + "producer-state.js")};const context=createPublicationContext({root:process.argv[2],env:process.env,sessionId:"persistence"});const intent=createProducerReadOnlyIntent({context});const r=await requestProducerReadOnly({context,intent});await flushProducer({context,id:r.id,timeoutMs:12000});\n`)
  const result = spawnSync(process.execPath, [callerFile, f.root], {
    env: { ...f.env, NODE_OPTIONS: `--require=${preload}` }, encoding: "utf8", timeout: 15000,
  })
  t.diagnostic(JSON.stringify({ result: { status: result.status, signal: result.signal, stderr: result.stderr } }))
  assert.match(result.stderr, /fixture-write-attempts:3/u)
  assert.match(result.stderr, /producerTemporary|retainedTemporary/u)
  assert.match(result.stderr, /closed":false/u)
})

test("a broker peer reset is observational and cannot escape accepted native settlement", async (t) => {
    const f = fixture(t)
    const preload = path.join(path.dirname(f.root), "broker-reset.cjs")
    fs.writeFileSync(preload, `if(process.argv.includes("--producer-gate1")){const net=require("node:net"),create=net.createServer;net.createServer=function(listener){return create(function(peer){listener(peer);queueMicrotask(()=>peer.emit("error",Object.assign(new Error("Owned peer reset"),{code:"ECONNRESET"})));});};}\n`)
    const context = createPublicationContext({ root: f.root, env: { ...f.env, NODE_OPTIONS: `--require=${preload}` }, sessionId: "peer-reset" })
    const intent = gate.createProducerReadOnlyIntent({ context })
    const initial = await gate.requestProducerReadOnly({ context, intent })
    const final = await gate.flushProducer({ context, id: initial.id, timeoutMs: 12000 })
    t.diagnostic(JSON.stringify({ final }))
    assert.equal(final.state, "blocked", JSON.stringify(final))
    assert.equal(final.executionCount, 0)
    assert.equal(final.resources.childrenClosed, true)
    assert.equal(final.channelFailures[0].code, "ECONNRESET")
  })

for (const point of ["acceptance", "terminal", "cleanup"]) {
  test(`a ${point} persistence failure is latched without a later record write or custody loss`, async (t) => {
    const f = fixture(t)
    const directory = path.dirname(f.root), preload = path.join(directory, "all-journal-paths.cjs")
    fs.writeFileSync(preload, `if(process.argv.includes("--producer-gate1")){const fs=require("node:fs");const open=fs.openSync,write=fs.writeFileSync;let failed=false,later=0;const files=new Map();fs.openSync=function(file,...args){if(failed&&String(file).includes(".producer-gate1")&&String(file).endsWith(".tmp"))later++;const fd=open(file,...args);files.set(fd,String(file));return fd;};fs.writeFileSync=function(fd,content,...args){if(typeof fd==="number"&&files.get(fd)?.includes(".producer-gate1")){const r=JSON.parse(String(content));const selected=${JSON.stringify(point)}==="acceptance"?r.state==="accepted"&&!r.broker:${JSON.stringify(point)}==="terminal"?r.state==="capability_verified"&&r.broker?.custody==="owned":r.broker?.custody==="removed";if(selected&&!failed){failed=true;throw Object.assign(new Error("Controlled persistence denied"),{code:"ENOSPC",path:files.get(fd),syscall:"write"});}}return write(fd,content,...args);};process.on("exit",()=>process.stderr.write("journal-later-writes:"+later+";failure:"+failed+"\\n"));}\n`)
    const callerFile = path.join(directory, "all-paths-caller.mjs")
    const runtime = new URL("../../../../../plugins/desk/mcp/src/runtime/", import.meta.url).href
    fs.writeFileSync(callerFile, `import{createPublicationContext}from${JSON.stringify(runtime + "publication-state.js")};import{createProducerReadOnlyIntent,requestProducerReadOnly,flushProducer}from${JSON.stringify(runtime + "producer-state.js")};const context=createPublicationContext({root:process.argv[2],env:process.env,sessionId:"all-paths"});const intent=createProducerReadOnlyIntent({context});const r=await requestProducerReadOnly({context,intent});await flushProducer({context,id:r.id,timeoutMs:12000});\n`)
    const result = spawnSync(process.execPath, [callerFile, f.root], {
      env: { ...f.env, NODE_OPTIONS: `--require=${preload}` }, encoding: "utf8", timeout: 15000,
    })
    t.diagnostic(JSON.stringify({ point, result: { status: result.status, signal: result.signal, stderr: result.stderr } }))
    assert.match(result.stderr, /journal-later-writes:0;failure:true/u)
    assert.match(result.stderr, /ENOSPC/u)
    assert.match(result.stderr, /retainedTemporary/u)
    if (point !== "acceptance") {
      assert.match(result.stderr, /childrenClosed":true/u)
      assert.match(result.stderr, /broker/u)
    }
  })
}
