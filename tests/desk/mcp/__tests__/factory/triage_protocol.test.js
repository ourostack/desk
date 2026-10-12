import "../_isolated_env.mjs"
import {ownedHostTest,ownedCatalogTest} from "./_owned_catalog_host.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { PassThrough, Writable } from "node:stream"
import fs from "node:fs"
import {spawnSync,spawn} from "node:child_process"
import os from "node:os"
import {createHash} from "node:crypto"
import * as path from "node:path"
import {serializeMessage,deserializeMessage} from "@modelcontextprotocol/sdk/shared/stdio.js"
import moduleBuiltin,{syncBuiltinESMExports} from "node:module"
import childProcess from "node:child_process"
import {EventEmitter} from "node:events"
const protocol=await import("../../../../../plugins/desk/mcp/src/factory/triage-protocol.js").catch(()=>({}))
const custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js").catch(()=>({}))
const fixture=JSON.parse(fs.readFileSync(new URL("../../../../../plugins/desk/mcp/src/factory/v12-owned-catalog.json",import.meta.url)))
// The first input frame of native qualification attempt 3 (Claude Code
// 2.1.296), copied from its observation receipt: 459 bytes, sha256 57c78d24...
const RECORDED_PROBE=Buffer.from("eyJqc29ucnBjIjoiMi4wIiwiaWQiOiJzZXJ2ZXItZGlzY292ZXItcHJvYmUtMSIsIm1ldGhvZCI6InNlcnZlci9kaXNjb3ZlciIsInBhcmFtcyI6eyJfbWV0YSI6eyJpby5tb2RlbGNvbnRleHRwcm90b2NvbC9wcm90b2NvbFZlcnNpb24iOiIyMDI2LTA3LTI4IiwiaW8ubW9kZWxjb250ZXh0cHJvdG9jb2wvY2xpZW50SW5mbyI6eyJuYW1lIjoiY2xhdWRlLWNvZGUiLCJ0aXRsZSI6IkNsYXVkZSBDb2RlIiwidmVyc2lvbiI6IjIuMS4yOTYiLCJkZXNjcmlwdGlvbiI6IkFudGhyb3BpYydzIGFnZW50aWMgY29kaW5nIHRvb2wiLCJ3ZWJzaXRlVXJsIjoiaHR0cHM6Ly9jbGF1ZGUuY29tL2NsYXVkZS1jb2RlIn0sImlvLm1vZGVsY29udGV4dHByb3RvY29sL2NsaWVudENhcGFiaWxpdGllcyI6eyJyb290cyI6eyJsaXN0Q2hhbmdlZCI6dHJ1ZX0sImVsaWNpdGF0aW9uIjp7ImZvcm0iOnt9LCJ1cmwiOnt9fX19fX0K","base64")
const PROBE_ANSWER='{"jsonrpc":"2.0","id":"server-discover-probe-1","error":{"code":-32601,"message":"Method not found"}}\n'
// Only these synthetic unit children inherit the maintained ESM measurement
// import. Actual env-i launcher/server bundles never use this helper.
function unitMeasurementArgs(){
  const imports=[]
  for(let i=0;i<process.execArgv.length;i++){
    if(process.execArgv[i]==="--import"&&process.execArgv[i+1]?.startsWith("data:text/javascript,")){
      imports.push("--import",process.execArgv[++i])
    }
  }
  return imports
}
test("owned_protocol_discovery",()=>{
  assert.equal(typeof protocol.guardedCatalogTransport,"function")
  assert.equal(typeof protocol.serveCatalog,"function")
})
test("importing_entry_sources_is_inert",()=>{
  for(const file of ["triage-catalog-server","launch-triage-catalog"]){
    const url=new URL(`../../../../../plugins/desk/mcp/scripts/${file}.js`,import.meta.url).href
    const child=spawnSync(process.execPath,["--input-type=module","-e",
      `await import(${JSON.stringify(url)}); console.log("inert_import_completed")`],
      {env:{...process.env,SYNTHETIC_IMPORT_SENTINEL:"unaccepted_unit_only"},encoding:"utf8",timeout:5000})
    assert.equal(child.status,0,child.stderr)
    assert.equal(child.stdout,"inert_import_completed\n")
    assert.equal(child.stderr,"")
  }
})
test("same_source_first_js_guards_refuse_unknown_or_drifted_identity",async()=>{
  const server=await import("../../../../../plugins/desk/mcp/scripts/triage-catalog-server.js")
  const launcher=await import("../../../../../plugins/desk/mcp/scripts/launch-triage-catalog.js")
  const good={platform:"darwin",getuid:()=>506,geteuid:()=>506,env:{LANG:"C",LC_ALL:"C",TZ:"UTC",__CF_USER_TEXT_ENCODING:"0x1FA:0:0"}}
  for(const guard of [server.serverFirstEnvironment,launcher.launcherFirstEnvironment]){
    assert.equal(guard(good),true)
    assert.equal(guard({...good,platform:"linux",env:{LANG:"C",LC_ALL:"C",TZ:"UTC"}}),true)
    for(const change of [
      {getuid:undefined},{getuid:()=>-1},{getuid:()=>4294967296},{geteuid:()=>507},
      {env:{...good.env,NODE_OPTIONS:"synthetic"}},{env:{...good.env,LANG:"other"}},
      {env:{LANG:"C",LC_ALL:"C",TZ:"UTC"}},{platform:"linux"},
    ])assert.equal(guard({...good,...change}),false)
  }
  for(const start of [server.startCatalogServer,launcher.startCatalogLauncher]){
    const runtime={...good,env:{...good.env,UNKNOWN:"synthetic"},stderr:new PassThrough()}
    const chunks=[];runtime.stderr.on("data",x=>chunks.push(x))
    assert.equal(await start(runtime),null)
    assert.equal(runtime.exitCode,1)
    assert.ok(Buffer.concat(chunks).toString().endsWith("_environment\n"))
  }
  const prior=process.exitCode,write=process.stderr.write
  process.stderr.write=()=>true
  try{
    assert.equal(await server.startCatalogServer(),null)
    assert.equal(await launcher.startCatalogLauncher(),null)
  }finally{process.exitCode=prior;process.stderr.write=write}
})
ownedHostTest("same_source_module_custody_is_bounded_and_nonselectable","posix",async(t)=>{
  const {catalogModuleLoad}=await import("../../../../../plugins/desk/mcp/scripts/triage-catalog-server.js")
  const root=new URL("../../../../../plugins/desk/mcp/",import.meta.url)
  const file=new URL("src/factory/triage-catalog.js",root),records=new Map(),bytes=fs.readFileSync(file)
  const loaded=source=>()=>({format:"module",source})
  assert.equal(catalogModuleLoad(records,root.pathname,file.href,{},loaded(bytes)).format,"module")
  assert.equal(records.size,1)
  assert.equal(records.get(file.pathname).bytes,fs.statSync(file).size)
  // The record is the hash of the bytes Node evaluates, even when the file on
  // disk differs from what the loader returned.
  const evaluated=new Map()
  catalogModuleLoad(evaluated,root.pathname,file.href,{},loaded("export const replaced=1\n"))
  assert.equal(evaluated.get(file.pathname).sha256,createHash("sha256").update("export const replaced=1\n").digest("hex"))
  assert.equal(catalogModuleLoad(records,root.pathname,"node:fs",{},()=>42),42)
  assert.throws(()=>catalogModuleLoad(records,"/not-owned/",file.href,{},loaded(bytes)),{message:"module_custody"})
  const full=new Map(Array.from({length:512},(_,i)=>[String(i),{}]))
  assert.throws(()=>catalogModuleLoad(full,root.pathname,file.href,{},loaded(bytes)),{message:"module_custody"})
  assert.throws(()=>catalogModuleLoad(new Map(),root.pathname,file.href,{},loaded(Buffer.alloc(16777217))),{message:"module_custody"})
  // CommonJS left to Node's own reader: the hook hashes the file it reads.
  const unread=new Map();catalogModuleLoad(unread,root.pathname,file.href,{},()=>({format:"commonjs",source:null}))
  assert.equal(unread.get(file.pathname).sha256,createHash("sha256").update(bytes).digest("hex"))
  const realpath=fs.realpathSync
  try{
    fs.realpathSync=()=>"/synthetic/alias"
    assert.throws(()=>catalogModuleLoad(new Map(),root.pathname,file.href,{},loaded(bytes)),{message:"module_custody"})
  }finally{fs.realpathSync=realpath}
})
ownedHostTest("same_source_entry_failures_do_not_bootstrap_or_touch_profile","posix",async()=>{
  const server=await import("../../../../../plugins/desk/mcp/scripts/triage-catalog-server.js")
  const launcher=await import("../../../../../plugins/desk/mcp/scripts/launch-triage-catalog.js")
  const uid=process.getuid(),env={LANG:"C",LC_ALL:"C",TZ:"UTC"}
  if(process.platform==="darwin")env.__CF_USER_TEXT_ENCODING="0x"+uid.toString(16).toUpperCase()+":0:0"
  const runtime=argv=>({platform:process.platform,env,argv,getuid:()=>uid,geteuid:()=>uid,stderr:new PassThrough(),stdin:new PassThrough(),
    stdout:new PassThrough(),execPath:process.execPath,cwd:()=>"/synthetic/missing"})
  for(const [entry,url]of [[server.catalogServerEntry,new URL("../../../../../plugins/desk/mcp/scripts/triage-catalog-server.js",import.meta.url)],
    [launcher.catalogLauncherEntry,new URL("../../../../../plugins/desk/mcp/scripts/launch-triage-catalog.js",import.meta.url)]]){
    const invalid=runtime([process.execPath,url.pathname]);invalid.env={...env,UNKNOWN:"synthetic"}
    assert.equal(await entry(invalid),null);assert.equal(invalid.exitCode,1)
    assert.equal(await entry(runtime([process.execPath,"/not-the-entry"])),null)
  }
  const capability=moduleBuiltin.registerHooks
  try{
    moduleBuiltin.registerHooks=undefined;syncBuiltinESMExports()
    const invalid=runtime([process.execPath,"server"])
    assert.equal(await server.startCatalogServer(invalid),null)
    assert.equal(invalid.exitCode,1)
  }finally{moduleBuiltin.registerHooks=capability;syncBuiltinESMExports()}
  const invalidServer=runtime([process.execPath,"server","--unexpected"])
  assert.equal(await server.startCatalogServer(invalidServer),null)
  assert.equal(invalidServer.exitCode,1)
  const invalidLauncher=runtime([process.execPath,"launcher","--unexpected"])
  assert.equal(await launcher.startCatalogLauncher(invalidLauncher),null)
  assert.equal(invalidLauncher.exitCode,1)
})
ownedHostTest("same_source_unit_launcher_control_and_teardown_outcomes","posix",async(t)=>{
  const {catalogLauncherEntry}=await import("../../../../../plugins/desk/mcp/scripts/launch-triage-catalog.js")
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  for(const scenario of ["finish","native_eof","wrong_generation","wrong_event","extra_key","input_error","child_error","stderr_limit","parent_changed","signal","nonzero_exit",
    "deadline","early_eof","pipe_error","redundant_epipe","stderr_small","readable_after_ready","spawn_throw",
    "wrong_cwd","uid_changed_after_first_js","close_listener_throw","parent_stable","snapshot_after_open_drift"]){
    await t.test(scenario,async()=>{
      const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"unit-launcher-")));fs.chmodSync(dir,0o700)
      t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
      const inputDir=path.join(dir,"input");fs.mkdirSync(inputDir,{mode:0o700})
      await catalog.writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
      const deadline=Date.now()+(scenario==="deadline"?1700:5000),owned=await custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline})
      const runtime=new EventEmitter(),uid=process.getuid(),env={LANG:"C",LC_ALL:"C",TZ:"UTC"}
      if(process.platform==="darwin")env.__CF_USER_TEXT_ENCODING="0x"+uid.toString(16).toUpperCase()+":0:0"
      Object.assign(runtime,{platform:process.platform,getuid:()=>uid,geteuid:()=>uid,env,execPath:process.execPath,ppid:process.pid,
        argv:[process.execPath,new URL("../../../../../plugins/desk/mcp/scripts/launch-triage-catalog.js",import.meta.url).pathname,...owned.launch.args.slice(owned.launch.args.indexOf("--entry"))],
        cwd:()=>owned.runDir,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()})
      if(scenario==="wrong_cwd")runtime.cwd=()=>dir
      if(scenario==="uid_changed_after_first_js"){
        let reads=0
        runtime.getuid=()=>++reads<=3?uid:uid+1
      }
      const child=new EventEmitter();Object.assign(child,{pid:123456,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()})
      let childClosed=false
      const close=(code,signal=null)=>{if(childClosed)return;childClosed=true;child.emit("close",code,signal)}
      child.kill=()=>{queueMicrotask(()=>close(1));return true}
      child.stdin.once("finish",()=>queueMicrotask(()=>close(0)))
      if(scenario==="close_listener_throw"){
        const on=child.on.bind(child)
        child.on=(event,...args)=>{if(event==="close")throw Error("synthetic_late_listener_failed");return on(event,...args)}
      }
      const spawnOriginal=childProcess.spawn
      childProcess.spawn=function(command,...args){
        if(command===process.execPath){
          if(scenario==="spawn_throw")throw Error("synthetic_spawn_failed")
          return child
        }
        return spawnOriginal.call(this,command,...args)
      };syncBuiltinESMExports()
      let controller,control
      const originalOpen=fs.promises.open
      if(scenario==="snapshot_after_open_drift")fs.promises.open=async(file,...args)=>{
        const handle=await originalOpen(file,...args)
        if(file===owned.launch.identity.bootstrap.snapshotFile)handle.readFile=async()=>{
          const bytes=Buffer.from((await fs.promises.readFile(file)))
          bytes[0]=32
          return bytes
        }
        return handle
      }
      try{controller=await catalogLauncherEntry(runtime)}
      finally{childProcess.spawn=spawnOriginal;fs.promises.open=originalOpen;syncBuiltinESMExports()}
      t.after(async()=>{close(1);if(control!==undefined)fs.closeSync(control);await owned.close()})
      if(["spawn_throw","wrong_cwd","uid_changed_after_first_js","close_listener_throw","snapshot_after_open_drift"].includes(scenario)){
        assert.equal(controller,null)
        assert.equal(runtime.exitCode,1)
        assert.equal(fs.existsSync(path.join(dir,"qualification.json")),false)
        return
      }
      assert.ok(controller,"same source must reach control phase")
      control=fs.openSync(owned.launch.identity.bootstrap.readyFifo,fs.constants.O_WRONLY|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW)
      const send=async frame=>{await custody.boundedFdWrite(control,catalog.catalogCanonical(frame)+"\n",deadline);await new Promise(resolve=>setTimeout(resolve,30))}
      const ready={event:"ready",generation:owned.generation,server_pid:child.pid}
      const queuedReadable=runtime.stdin.listeners("readable").at(-1)
      runtime.stdin.emit("readable")
      if(scenario==="wrong_generation")await send({...ready,generation:"f".repeat(64)})
      else if(scenario==="wrong_event")await send({...ready,event:"finish"})
      else if(scenario==="extra_key")await send({...ready,arbitrary:true})
      else if(scenario==="early_eof")runtime.stdin.end()
      else{
        await send(ready)
        if(scenario==="finish"){await send({...ready,event:"finish"});await controller.endInput()}
        if(scenario==="native_eof")runtime.stdin.end()
        if(scenario==="input_error")runtime.stdin.emit("error",Error("synthetic"))
        if(scenario==="child_error")child.emit("error",Error("synthetic"))
        if(scenario==="stderr_limit")child.stderr.write(Buffer.alloc(65537))
        if(scenario==="parent_changed")runtime.ppid++
        if(scenario==="parent_stable"){await new Promise(resolve=>setTimeout(resolve,150));await send({...ready,event:"finish"})}
        if(scenario==="signal")runtime.emit("SIGTERM")
        if(scenario==="nonzero_exit")close(1)
        if(scenario==="pipe_error")child.stdin.emit("error",Object.assign(Error("synthetic_pipe"),{code:"EPIPE"}))
        if(scenario==="redundant_epipe"){await controller.endInput();child.stdin.emit("error",Object.assign(Error("synthetic_redundant"),{code:"EPIPE"}))}
        if(scenario==="stderr_small"){child.stderr.write("unit_bounded_stderr");await send({...ready,event:"finish"})}
        if(scenario==="readable_after_ready"){queuedReadable();await send({...ready,event:"finish"})}
      }
      const stop=Date.now()+2000
      while(!runtime.stdout.writableEnded&&Date.now()<stop)await new Promise(resolve=>setTimeout(resolve,10))
      assert.equal(runtime.stdout.writableEnded,true,"source must close pipes/timer/watch")
      assert.equal(runtime.exitCode,["finish","native_eof","redundant_epipe","stderr_small","readable_after_ready","parent_stable"].includes(scenario)?0:1)
      assert.equal(fs.existsSync(path.join(dir,"qualification.json")),false)
      assert.equal(fs.existsSync(path.join(dir,"unaccepted.json")),false)
    })
  }
})
ownedHostTest("instrumented_unit_server_uses_same_source_without_proof_authority","posix",async(t)=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"unit-server-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const snapshot=catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)})
  const snapshotFile=path.join(dir,"catalog.json");fs.writeFileSync(snapshotFile,snapshot.snapshotBytes,{mode:0o600})
  const serverURL=new URL("../../../../../plugins/desk/mcp/scripts/triage-catalog-server.js",import.meta.url)
  // Fixed test-only unit entry, no production CLI/env flag. The process's actual
  // argv/env fail production provenance; a synthetic runtime object measures
  // source functions only, and no custody/qualification/store API is called.
  const script=path.join(dir,"unit-server.mjs")
  fs.writeFileSync(script,`
import {catalogServerEntry} from ${JSON.stringify(serverURL.href)}
const uid=process.getuid(),env={LANG:"C",LC_ALL:"C",TZ:"UTC"}
if(process.platform==="darwin")env.__CF_USER_TEXT_ENCODING="0x"+uid.toString(16).toUpperCase()+":0:0"
const runtime=Object.create(process)
Object.assign(runtime,{env,argv:[process.execPath,${JSON.stringify(serverURL.pathname)}],cwd:()=>${JSON.stringify(dir)},once:process.once.bind(process),exit:process.exit.bind(process)})
const controller=await catalogServerEntry(runtime)
if(!controller)process.exit(1)
process.once("beforeExit",()=>{process.exitCode=runtime.exitCode})
`,{mode:0o600})
  const fd=fs.openSync(snapshotFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
  const child=spawn(process.execPath,[...unitMeasurementArgs(),script],{cwd:new URL("../../../../../plugins/desk/mcp",import.meta.url),env:{...process.env},stdio:["pipe","pipe","pipe","pipe",fd]})
  fs.closeSync(fd)
  let out="",err="",receipts=""
  child.stdout.on("data",chunk=>{out+=chunk});child.stderr.on("data",chunk=>{err+=chunk})
  child.stdio[3].on("data",chunk=>{receipts+=chunk})
  child.stdin.on("error",()=>{})
  const closed=new Promise(resolve=>child.once("close",(code,signal)=>resolve({code,signal})))
  const timer=setTimeout(()=>child.kill("SIGKILL"),8000)
  t.after(()=>{clearTimeout(timer);child.kill("SIGKILL")})
  const send=async message=>{
    await new Promise((resolve,reject)=>child.stdin.write(serializeMessage(deserializeMessage(JSON.stringify(message))),error=>error?reject(error):resolve()))
    if(Object.hasOwn(message,"id")){
      const stop=Date.now()+4000
      while(!out.split("\n").filter(Boolean).some(line=>JSON.parse(line).id===message.id)&&child.exitCode===null&&Date.now()<stop)await new Promise(resolve=>setTimeout(resolve,10))
    }
  }
  await send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"isolated_unit",version:"1"}}})
  await send({jsonrpc:"2.0",method:"notifications/initialized"})
  await send({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"candidate_submit",arguments:{candidate:fixture.candidate}}})
  child.stdin.end()
  const exit=await closed;clearTimeout(timer)
  assert.equal(exit.code,0,err)
  assert.equal(err,"")
  const frames=receipts.trim().split("\n").map(value=>JSON.parse(value))
  const semantic=frames.filter(value=>value.event!=="observation")
  assert.deepEqual(semantic.map(value=>value.event),["bootstrap","submit","terminal"])
  for(const frame of frames.filter(value=>value.event==="observation"))assert.equal(custody.validateCatalogObservation(frame.payload),true)
  assert.equal(semantic[1].payload.rpc_id,2)
  assert.equal(semantic[1].payload.candidate_sha256,catalog.catalogHash(catalog.catalogCanonical(fixture.candidate)))
  assert.equal(fs.existsSync(path.join(dir,"qualification.json")),false)
  assert.equal(fs.existsSync(path.join(dir,"unaccepted.json")),false)
})
test("wire_limits_and_lifecycle",async()=>{
  for (const line of ['{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}\n','not json\n','{"jsonrpc":"2.0","id":1,"method":"ping","extra":true}\n',Buffer.from([0xff,10])," ".repeat(393217)]) {
    const input=new PassThrough(),output=new PassThrough()
    let failure
    const guarded=protocol.guardedCatalogTransport({input,output,onFailure:e=>{failure=e}})
    input.end(line)
    await new Promise(r=>setTimeout(r,30))
    assert.ok(failure,"malformed/oversize wire must fail")
    await guarded.close()
  }
})
ownedHostTest("same_source_unit_server_fatal_and_late_receipt_paths_are_closed","posix",async(t)=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  for(const scenario of ["known_fatal","unknown_fatal","guard_failed_on_close","duplicate_finish","receipt_count","receipt_frame"]){
    await t.test(scenario,async()=>{
      const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"unit-server-fatal-")));fs.chmodSync(dir,0o700)
      t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
      const snapshot=catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"b".repeat(64)})
      const snapshotFile=path.join(dir,"catalog.json");fs.writeFileSync(snapshotFile,snapshot.snapshotBytes,{mode:0o600})
      const serverURL=new URL("../../../../../plugins/desk/mcp/scripts/triage-catalog-server.js",import.meta.url),script=path.join(dir,"fixed-unit-server.mjs")
      const action={
        known_fatal:'controller.fatal(Error("wire_output_limit"));controller.fatal(Error("ignored_second_error"));',
        unknown_fatal:'controller.fatal(Error("synthetic_secret_never_echo"));',
        guard_failed_on_close:'controller.service.guarded.failed=()=>true;await controller.finish();',
        duplicate_finish:'await Promise.all([controller.finish(),controller.finish()]);process.stdin.destroy();',
        receipt_count:'try{for(let i=0;i<4;i++)await controller.receipt("unit",{})}catch(e){if(e.message!=="receipt_limit")throw e;controller.fatal(Error("unit_limit"))}',
        receipt_frame:'try{await controller.receipt("unit",{text:"x".repeat(393216)})}catch(e){if(e.message!=="receipt_limit")throw e;controller.fatal(Error("unit_limit"))}',
      }[scenario]
      fs.writeFileSync(script,`
import {catalogServerEntry} from ${JSON.stringify(serverURL.href)}
const uid=process.getuid(),env={LANG:"C",LC_ALL:"C",TZ:"UTC"}
if(process.platform==="darwin")env.__CF_USER_TEXT_ENCODING="0x"+uid.toString(16).toUpperCase()+":0:0"
const runtime=Object.create(process)
Object.assign(runtime,{env,argv:[process.execPath,${JSON.stringify(serverURL.pathname)}],cwd:()=>${JSON.stringify(dir)},once:process.once.bind(process),exit:process.exit.bind(process)})
const controller=await catalogServerEntry(runtime)
if(!controller)process.exit(1)
process.once("SIGUSR1",async()=>{${action}})
process.once("beforeExit",()=>{process.exitCode=runtime.exitCode})
`,{mode:0o600})
      const fd=fs.openSync(snapshotFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
      const child=spawn(process.execPath,[...unitMeasurementArgs(),script],{cwd:new URL("../../../../../plugins/desk/mcp",import.meta.url),env:{...process.env},stdio:["pipe","pipe","pipe","pipe",fd]});fs.closeSync(fd)
      child.stdin.on("error",()=>{})
      let stdout="",stderr="",receipt=""
      child.stdout.on("data",chunk=>{stdout+=chunk});child.stderr.on("data",chunk=>{stderr+=chunk});child.stdio[3].on("data",chunk=>{receipt+=chunk})
      const closed=new Promise(resolve=>child.once("close",(code,signal)=>resolve({code,signal})))
      const timer=setTimeout(()=>child.kill("SIGKILL"),6000)
      t.after(()=>{clearTimeout(timer);child.kill("SIGKILL")})
      const deadline=Date.now()+4000
      while(!receipt.includes("\n")&&child.exitCode===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10))
      assert.ok(receipt.includes("\n"),stderr)
      // Wait for the fixed unit signal registration after startup's bootstrap.
      await new Promise(resolve=>setTimeout(resolve,30))
      child.kill("SIGUSR1")
      const exit=await closed;clearTimeout(timer)
      assert.equal(exit.code,scenario==="duplicate_finish"?0:1,stderr)
      assert.equal(stdout,"")
      assert.equal(stderr.includes("synthetic_secret_never_echo"),false)
      assert.equal(stderr.includes("ignored_second_error"),false)
      const frames=receipt.trim().split("\n").map(line=>JSON.parse(line))
      assert.equal(frames.filter(frame=>frame.event==="terminal").length,scenario==="duplicate_finish"?1:0)
      if(scenario==="known_fatal")assert.equal(stderr,"catalog_session_failed_wire_output_limit\n")
      if(scenario==="unknown_fatal")assert.equal(stderr,"catalog_session_failed\n")
      assert.equal(fs.existsSync(path.join(dir,"qualification.json")),false)
    })
  }
})
test("canonical_wire_accepts_lf_and_crlf_only_with_raw_byte_limits",async(t)=>{
  const payload='{"jsonrpc":"2.0","id":1,"method":"ping"}'
  for(const [name,parts,frameBytes,incomingBytes,want]of [
    ["lf",[payload+"\n"],payload.length,payload.length+1,null],
    ["crlf",[payload+"\r\n"],payload.length+1,payload.length+2,null],
    ["split_crlf",[payload+"\r","\n"],payload.length+1,payload.length+2,null],
    ["split_payload",[payload.slice(0,12),payload.slice(12)+"\r","\n"],payload.length+1,payload.length+2,null],
    ["lf_frame_over",[payload+"\n"],payload.length-1,1000,"wire_frame_limit"],
    ["crlf_frame_over",[payload+"\r\n"],payload.length,1000,"wire_frame_limit"],
    ["crlf_raw_over",[payload+"\r\n"],1000,payload.length+1,"wire_input_limit"],
    ["double_cr",[payload+"\r\r\n"],1000,1000,null],
    ["trailing_space",[payload+" \n"],1000,1000,null],
    ["trailing_tab",[payload+"\t\r\n"],1000,1000,null],
    ["leading_space",[" "+payload+"\r\n"],1000,1000,null],
    ["lone_cr",[payload+"\r"],1000,1000,"wire_incomplete"],
  ]){
    await t.test(name,async()=>{
      const input=new PassThrough(),output=new PassThrough(),messages=[]
      let failure
      const guard=protocol.guardedCatalogTransport({input,output,
        limits:{frameBytes,incomingBytes,outgoingBytes:1000,incomingFrames:1,outgoingFrames:1},
        onFailure:error=>{failure=error},onMessage:value=>messages.push(value)})
      guard.transport.onmessage=()=>{}
      await guard.transport.start()
      for(const part of parts)input.write(part)
      input.end()
      await new Promise(resolve=>setTimeout(resolve,10))
      assert.equal(failure?.message??null,want,name)
      assert.equal(messages.length,want===null?1:0,name)
      assert.equal(guard.counters().totalIn,parts.reduce((n,x)=>n+Buffer.byteLength(x),0),name)
      if(want===null)assert.deepEqual(messages[0],{jsonrpc:"2.0",id:1,method:"ping"})
      await guard.close()
    })
  }
})
test("failed_private_receipt_does_not_seal_submission",async(t)=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const state=catalog.createCatalogState(JSON.parse(catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,
    recordRefs:fixture.record_refs,generation:"a".repeat(64)}).snapshotBytes))
  const input=new PassThrough(),output=new PassThrough();let out="",failure
  output.on("data",chunk=>{out+=chunk})
  const service=await protocol.serveCatalog({state,input,output,
    writeReceipt:async()=>{throw Error("synthetic_receipt_failure")},onFailure:error=>{failure=error}})
  t.after(()=>service.close())
  const send=async message=>{
    input.write(serializeMessage(deserializeMessage(JSON.stringify(message))))
    if(Object.hasOwn(message,"id")){
      const deadline=Date.now()+1000
      while(!out.split("\n").filter(Boolean).some(line=>JSON.parse(line).id===message.id)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10))
    }
  }
  await send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"isolated_unit",version:"1"}}})
  await send({jsonrpc:"2.0",method:"notifications/initialized"})
  await send({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"candidate_submit",arguments:{candidate:fixture.candidate}}})
  const response=out.trim().split("\n").map(line=>JSON.parse(line)).find(value=>value.id===2)
  assert.equal(response.result.isError,true)
  assert.equal(state.phase,"open")
  assert.equal(state.submission,null)
  assert.equal(failure?.message,"synthetic_receipt_failure")
  assert.equal(out.includes("synthetic_receipt_failure"),false)
})
test("wire_callback_failure_queue_and_idle_paths_are_bounded",async(t)=>{
  for(const failureMode of ["callback","throw","frame","aggregate","count","closed"]){
    await t.test(failureMode,async()=>{
      const input=new PassThrough(),output=new PassThrough()
      let failure,count=0
      const limits={frameBytes:393216,incomingBytes:16777216,outgoingBytes:16777216,incomingFrames:256,outgoingFrames:256}
      if(failureMode==="frame")limits.frameBytes=4
      if(failureMode==="aggregate")limits.outgoingBytes=4
      if(failureMode==="count")limits.outgoingFrames=0
      if(failureMode==="callback")output.write=(_bytes,callback)=>{callback(Error("synthetic_output_callback"));return false}
      if(failureMode==="throw")output.write=()=>{throw Error("synthetic_output_throw")}
      const guard=protocol.guardedCatalogTransport({input,output,limits,onFailure:error=>{failure=error;count++}})
      if(failureMode==="closed")input.write("invalid\n")
      const sent=guard.transport.send({jsonrpc:"2.0",id:1,result:{}})
      const outcome=await Promise.race([sent.then(()=>"resolved",()=>"rejected"),new Promise(resolve=>setTimeout(()=>resolve("pending"),100))])
      assert.equal(outcome,"rejected","output failure must settle the actual SDK send, not wait forever for drain")
      await guard.waitIdle()
      assert.ok(failure)
      assert.equal(count,1)
      assert.equal(guard.failed(),true)
      input.emit("error",Error("second_error"))
      assert.equal(count,1)
      await guard.close();await guard.close()
      assert.equal(input.listenerCount("data"),0)
    })
  }
  const input=new PassThrough(),output=new PassThrough(),messages=[]
  let release
  output.write=(_bytes,callback)=>{release=callback;return false}
  const guard=protocol.guardedCatalogTransport({input,output,onMessage:message=>messages.push(message)})
  guard.transport.onmessage=()=>{}
  await guard.transport.start()
  input.write(serializeMessage(deserializeMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}')))
  let idle=false
  const idlePromise=guard.waitIdle().then(()=>{idle=true})
  const sending=guard.transport.send({jsonrpc:"2.0",id:1,result:{}})
  await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(idle,false)
  release()
  await sending;await idlePromise
  assert.equal(idle,true)
  assert.equal(messages.length,1)
  input.end()
  await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(guard.ended(),true)
  await guard.close()
  const pendingInput=new PassThrough(),pendingOutput=new PassThrough()
  pendingOutput.write=()=>false
  const closing=protocol.guardedCatalogTransport({input:pendingInput,output:pendingOutput})
  const pendingSend=closing.transport.send({jsonrpc:"2.0",id:1,result:{}})
  const rejection=assert.rejects(pendingSend,{message:"wire_closed"})
  await closing.close();await rejection
  const serialInput=new PassThrough(),serialOutput=new PassThrough()
  const serial=protocol.guardedCatalogTransport({input:serialInput,output:serialOutput})
  await assert.rejects(serial.transport.send({jsonrpc:"2.0",id:1,result:{unserializable:1n}}),TypeError)
  assert.equal(serial.failed(),false)
  assert.deepEqual(serial.counters(),{totalIn:0,totalOut:0,framesIn:0,framesOut:0})
  await serial.close()
})
test("closing_transport_pauses_original_input_not_only_sdk_buffer",async()=>{
  const input=new PassThrough(),output=new PassThrough()
  const guard=protocol.guardedCatalogTransport({input,output})
  assert.equal(input.isPaused(),false)
  await guard.close()
  assert.equal(input.isPaused(),true,"the original open pipe must not remain resumed after listener removal")
})
test("queued_request_release_and_failed_output_remain_closed",async()=>{
  const input=new PassThrough(),output=new PassThrough(),callbacks=[],received=[]
  output.write=(_bytes,callback)=>{callbacks.push(callback);return false}
  const guard=protocol.guardedCatalogTransport({input,output,onMessage:m=>received.push(m.id)})
  guard.transport.onmessage=()=>{}
  await guard.transport.start()
  const frame=(id,method="ping",params)=>serializeMessage(deserializeMessage(JSON.stringify({jsonrpc:"2.0",id,method,params})))
  const submit=id=>frame(id,"tools/call",{name:"candidate_submit",arguments:{candidate:{}}})
  input.write(frame(1)+frame(2)+submit(3)+frame(4))
  assert.deepEqual(received,[1,2],"reads run concurrently; candidate_submit waits for them")
  await guard.transport.send({jsonrpc:"2.0",id:1,result:{}})
  callbacks.shift()()
  assert.deepEqual(received,[1,2])
  await guard.transport.send({jsonrpc:"2.0",id:2,result:{}})
  callbacks.shift()()
  assert.deepEqual(received,[1,2,3],"candidate_submit runs alone")
  await guard.transport.send({jsonrpc:"2.0",id:3,result:{}})
  callbacks.shift()()
  assert.deepEqual(received,[1,2,3,4],"requests behind candidate_submit wait for its response")
  await guard.transport.send({jsonrpc:"2.0",id:4,result:{}})
  callbacks.shift()()
  await guard.waitIdle()
  assert.equal(guard.counters().framesIn,4)
  input.emit("error",Error("synthetic_input_failure"))
  assert.equal(guard.failed(),true)
  // Exercise the adapter's own output guard against a late SDK write; never
  // alter production serialization or enable any tool or external operation.
  const late=new Promise(resolve=>guard.transport._stdout.write("late",error=>resolve(error)))
  assert.equal((await late).message,"wire_closed")
  await guard.close()
})
test("in_flight_limit_answers_one_busy_error_without_closing",async()=>{
  const input=new PassThrough(),output=new PassThrough(),callbacks=[],received=[],written=[];let failure
  output.write=(bytes,callback)=>{written.push(String(bytes));callbacks.push(callback);return true}
  const guard=protocol.guardedCatalogTransport({input,output,onMessage:m=>received.push(m.id),onFailure:e=>{failure=e}})
  guard.transport.onmessage=()=>{}
  await guard.transport.start()
  const frame=id=>serializeMessage(deserializeMessage(JSON.stringify({jsonrpc:"2.0",id,method:"ping"})))
  input.write([1,2,3,4,5,6,7,8,9].map(frame).join(""))
  assert.deepEqual(received,[1,2,3,4,5,6,7,8])
  assert.deepEqual(JSON.parse(written[0]),{jsonrpc:"2.0",id:9,error:{code:-32000,message:"catalog_busy"}})
  let idle=false;const waiting=guard.waitIdle().then(()=>{idle=true})
  callbacks.shift()()
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(idle,false,"a busy reply does not release an in-flight request")
  for(let id=1;id<=8;id++){await guard.transport.send({jsonrpc:"2.0",id,result:{}});callbacks.shift()()}
  await waiting
  input.write(frame(10))
  assert.deepEqual(received.at(-1),10,"the session stays open after a busy reply")
  await guard.transport.send({jsonrpc:"2.0",id:10,result:{}});callbacks.shift()()
  assert.equal(failure,undefined)
  // A failed busy write closes the session like any failed output write.
  input.write([11,12,13,14,15,16,17,18,19].map(frame).join(""))
  callbacks.at(-1)(Error("synthetic_busy_write"))
  assert.equal(failure.message,"synthetic_busy_write")
  await guard.close()
  const limitedInput=new PassThrough(),limitedOutput=new PassThrough();let limited
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const bounded=protocol.guardedCatalogTransport({input:limitedInput,output:limitedOutput,limits:{...catalog.CATALOG_LIMITS,outgoingFrames:0},onFailure:e=>{limited=e}})
  limitedInput.write([1,2,3,4,5,6,7,8,9].map(frame).join(""))
  assert.equal(limited.message,"wire_output_limit","busy replies count against the output bounds")
  await bounded.close()
})
test("native_tools_call_meta_and_progress_shape_is_served",async()=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const {Client}=await import("@modelcontextprotocol/sdk/client/index.js")
  const {ReadBuffer}=await import("@modelcontextprotocol/sdk/shared/stdio.js")
  const state=catalog.createCatalogState(JSON.parse(catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)}).snapshotBytes))
  const toServer=new PassThrough(),fromServer=new PassThrough(),sent=[];let failure
  const service=await protocol.serveCatalog({state,input:toServer,output:fromServer,writeReceipt:async()=>{throw Error("unexpected_receipt")},onFailure:e=>{failure=e}})
  const buffer=new ReadBuffer()
  const transport={async start(){fromServer.on("data",chunk=>{buffer.append(chunk);let value;while((value=buffer.readMessage())!==null)this.onmessage?.(value)})},
    async send(value){sent.push(value);toServer.write(serializeMessage(value))},async close(){}}
  const client=new Client({name:"claude-code",title:"Claude Code",version:"2.1.296",description:"Anthropic's agentic coding tool",websiteUrl:"https://code.claude.com"},
    {capabilities:{roots:{listChanged:true},elicitation:{}}})
  await client.connect(transport)
  const reply=await client.callTool({name:"evidence_read",arguments:{id:"r000002"},_meta:{"claudecode/toolUseId":"toolu_01NativeShape"}},undefined,{onprogress(){}})
  assert.equal(reply.isError,undefined)
  assert.equal(reply.structuredContent.id,"r000002")
  const call=sent.find(value=>value.method==="tools/call")
  assert.deepEqual(Object.keys(call.params).sort(),["_meta","arguments","name"])
  assert.equal(call.params._meta["claudecode/toolUseId"],"toolu_01NativeShape")
  assert.equal(Number.isSafeInteger(call.params._meta.progressToken),true,"onprogress makes the SDK send a progress token")
  assert.equal(failure,undefined)
  await client.close();await service.close()
})
test("cancellation_is_advisory_never_partial_and_drops_only_queued_reads",async()=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const fresh=()=>catalog.createCatalogState(JSON.parse(catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)}).snapshotBytes))
  const write=(input,value)=>input.write(serializeMessage(deserializeMessage(JSON.stringify(value))))
  const tick=()=>new Promise(resolve=>setTimeout(resolve,10))
  const initialize={jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"isolated_unit",version:"1"}}}
  const cancel=requestId=>({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId,reason:"user interrupted"}})
  {
    const state=fresh(),input=new PassThrough(),output=new PassThrough();output.resume();let failure
    const service=await protocol.serveCatalog({state,input,output,writeReceipt:async()=>{},onFailure:e=>{failure=e}})
    write(input,cancel(1));await tick()
    assert.equal(failure?.message,"protocol_state","cancellation is accepted only after initialize")
    await service.close()
  }
  const state=fresh(),input=new PassThrough(),output=new PassThrough();let text="",failure,unblock
  output.on("data",chunk=>{text+=chunk})
  const receipts=[]
  const service=await protocol.serveCatalog({state,input,output,onFailure:e=>{failure=e},
    writeReceipt:async(kind,value)=>{receipts.push(kind);await new Promise(resolve=>{unblock=resolve})}})
  write(input,initialize);await tick()
  write(input,cancel(1))
  write(input,{jsonrpc:"2.0",method:"notifications/initialized"});await tick()
  write(input,{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"candidate_submit",arguments:{candidate:fixture.candidate}}});await tick()
  write(input,{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"evidence_read",arguments:{id:"r000002"}}})
  write(input,{jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"evidence_read",arguments:{id:"r000002"}}})
  write(input,cancel(2));write(input,cancel(3));write(input,cancel(99));await tick()
  assert.deepEqual(receipts,["submit"],"the in-flight submission is not interrupted")
  unblock();await tick()
  const replies=text.trim().split("\n").map(line=>JSON.parse(line))
  assert.equal(replies.find(value=>value.id===2).result.structuredContent.receipt_id.length>0,true,"a sealed submission stays sealed")
  assert.equal(replies.some(value=>value.id===3),false,"a queued read may be dropped")
  assert.equal(replies.find(value=>value.id===4).result.structuredContent.id,"r000002")
  assert.equal(state.phase,"submitted")
  assert.equal(failure,undefined)
  await service.close()
})
test("wire_incoming_limits_and_onmessage_errors_close_without_dispatch",async()=>{
  for(const [data,limits,want]of [
    ['{"jsonrpc":"2.0","id":1,"method":"ping"}\n',{incomingBytes:1},"wire_input_limit"],
    ['{"jsonrpc":"2.0","id":1,"method":"ping"}\n',{incomingFrames:0},"wire_frame_count"],
    ['{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"u","version":"1"}}}\n'+
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n'.repeat(17),{},"wire_queue_limit"],
    ['{"jsonrpc":"2.0","id":1,"method":"ping"}\n',{},"synthetic_onmessage"],
    ['{"jsonrpc":"2.0"',{},"wire_incomplete"],
  ]){
    const input=new PassThrough(),output=new PassThrough();let failure
    const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
    const guard=protocol.guardedCatalogTransport({input,output,limits:{...catalog.CATALOG_LIMITS,...limits},
      onMessage:want==="synthetic_onmessage"?()=>{throw Error("synthetic_onmessage")}:undefined,
      onFailure:error=>{failure=error}})
    input.end(data)
    await new Promise(resolve=>setTimeout(resolve,10))
    assert.equal(failure?.message,want)
    await guard.close()
  }
})
test("closed_protocol_capabilities_notifications_and_requests_are_observed",async(t)=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const initialize={jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"isolated_unit",version:"1"}}}
  for(const [name,frames,want]of [
    ["capabilities",[{...initialize,params:{...initialize.params,capabilities:{sampling:{}}}}],"catalog_invalid"],
    ["version",[{...initialize,params:{...initialize.params,protocolVersion:"unknown"}}],"protocol_state"],
    ["notification_before_init",[{jsonrpc:"2.0",method:"notifications/initialized",params:{}}],"protocol_state"],
    ["double_init",[initialize,{...initialize,id:2}],"protocol_state"],
    ["second_initialized",[initialize,{jsonrpc:"2.0",method:"notifications/initialized",params:{}},{jsonrpc:"2.0",method:"notifications/initialized"}],"protocol_state"],
    ["unknown_notification",[initialize,{jsonrpc:"2.0",method:"notifications/initialized"},{jsonrpc:"2.0",method:"notifications/roots/list_changed"}],"protocol_state"],
    ["pre_initialized_request",[initialize,{jsonrpc:"2.0",id:2,method:"ping"}],"protocol_state"],
    ["reply_not_request",[{jsonrpc:"2.0",id:1,result:{}}],"catalog_invalid"],
  ])await t.test(name,async()=>{
    const state=catalog.createCatalogState(JSON.parse(catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)}).snapshotBytes))
    const input=new PassThrough(),output=new PassThrough();output.resume();let failure
    const service=await protocol.serveCatalog({state,input,output,writeReceipt:async()=>{},onFailure:error=>{failure=error}})
    for(const frame of frames){
      input.write(serializeMessage(deserializeMessage(JSON.stringify(frame))))
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(failure?.message,want)
    assert.equal(state.submission,null)
    await service.close()
  })
})
test("raw_sdk_order_and_whitespace_compatible",()=>{
    const raw=' \t{ "method" : "ping", "jsonrpc" : "2.0", "id" : " space  id " }\r '
    const result=protocol.validateCatalogWireFrame(Buffer.from(raw))
    assert.deepEqual(result.originalMessage,{method:"ping",jsonrpc:"2.0",id:" space  id "})
    assert.match(result.canonicalHash,/^[a-f0-9]{64}$/u)
  })
  test("original_unknown_keys_rejected_before_sdk",()=>{
    assert.equal(typeof protocol.validateCatalogWireFrame,"function")
    const request=_meta=>({jsonrpc:"2.0",id:0,method:"tools/call",params:{name:"evidence_list",arguments:{},_meta}})
    for(const meta of [{},{progressToken:7},{progressToken:"p"},{"claudecode/toolUseId":"toolu_01"},{progressToken:0,"claudecode/toolUseId":"toolu_01"}])
      assert.deepEqual(protocol.validateCatalogWireFrame(Buffer.from(JSON.stringify(request(meta)))).originalMessage.params._meta,meta)
    for(const meta of [null,[],{other:1},{progressToken:1.5},{progressToken:""},{progressToken:"p".repeat(129)},{progressToken:true},
      {"claudecode/toolUseId":1},{"claudecode/toolUseId":""},{"claudecode/toolUseId":"t".repeat(129)},{"claudecode/toolUseId":"a\nb"}])
      assert.throws(()=>protocol.validateCatalogWireFrame(Buffer.from(JSON.stringify(request(meta)))),{message:"catalog_invalid"},JSON.stringify(meta))
    const cancel=value=>protocol.validateCatalogWireFrame(Buffer.from(JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",...value})))
    for(const params of [{requestId:3},{requestId:"r",reason:"user interrupted"}])assert.deepEqual(cancel({params}).originalMessage.params,params)
    for(const value of [{},{params:{}},{params:{requestId:null}},{params:{requestId:-1}},{params:{requestId:""}},{params:{requestId:1,reason:1}},
      {params:{requestId:1,reason:"r".repeat(1025)}},{params:{requestId:1,extra:true}},{id:1,params:{requestId:1}}])assert.throws(()=>cancel(value),undefined,JSON.stringify(value))
    assert.throws(()=>protocol.validateCatalogWireFrame(Buffer.from('{"jsonrpc":"2.0","id":0,"method":"ping","params":{},"extension":true}')),{message:"catalog_invalid"})
  })
  test("bounded_lexical_grammar_unicode_and_numeric_guards",()=>{
    const validate=value=>protocol.validateCatalogWireFrame(Buffer.isBuffer(value)?value:Buffer.from(value))
    const frame=params=>JSON.stringify({jsonrpc:"2.0",id:0,method:"unknown",params})
    for(const raw of [
      null,Buffer.alloc(393217),Buffer.from([255]),"", "[1]", "null", "false",
      '{"jsonrpc":"2.0","method":"ping","id":null}',
      '{"jsonrpc":"2.0","method":"ping","id":0.5}',
      '{"jsonrpc":"2.0","method":"ping","id":-0}',
      '{"jsonrpc":"2.0","method":"ping","id":"'+ "a".repeat(65)+'"}',
      '{"jsonrpc":"2.0","method":"ping","id":0,"params":{"a":1e400}}',
      '{"jsonrpc":"2.0","method":"unknown","id":0,"params":{"a":1e-400}}',
      '{"jsonrpc":"2.0","method":"ping","id":0,"params":{"a":01}}',
      '{"jsonrpc":"2.0","method":"ping","id":0,"params":{"a":1.}}',
      '{"jsonrpc":"2.0","method":"ping","id":0,"params":{"a":"\\x00"}}',
      '{"jsonrpc":"2.0","method":"ping","id":0,"params":{"a":"\\u12"}}',
      '{"jsonrpc":"2.0","method":"ping","id":0,"params":{"a":"unterminated}}',
      '{"jsonrpc":"2.0","method":"ping","id":0,"params":{"a":"\u0001"}}',
      '{"jsonrpc":"2.0","method":"ping","id":0,"params":{"a":true,}}',
      '{"jsonrpc":"2.0","method":"ping","id":0,"params":[]} trailing',
      frame({a:Array.from({length:1},()=>[])})+"x",
      frame(Object.fromEntries(Array.from({length:1025},(_,i)=>["k"+i,true]))),
      '{"jsonrpc":"2.0","id":0,"method":"unknown","params":'+ "[".repeat(33)+"0"+"]".repeat(33)+"}",
      '{"jsonrpc":"2.0","id":0,"method":"unknown","params":{"a" 1}}',
      '{"jsonrpc":"2.0","id":0,"method":"unknown","params":[1;2]}',
      '{"jsonrpc":"2.0","id":0,"method":"unknown","params":{"a":tru}}',
    ])assert.throws(()=>raw===null?protocol.validateCatalogWireFrame(null):validate(raw),undefined,String(raw))
    for(const raw of ["1.0000000000000001","9007199254740993.0","0.30000000000000000001","1e-400","123456789012345678901234567890"])
      assert.throws(()=>validate(`{"jsonrpc":"2.0","id":0,"method":"unknown","params":{"a":${raw}}}`),{message:"wire_noncanonical"},raw)
    for(const [raw,value] of [["1e2",100],["0.1",0.1],["1.50",1.5],["-2.5E-3",-0.0025],["0.0",0],["1.5e-300",1.5e-300],["5e-324",5e-324],["100",100],["0.000",0]])
      assert.equal(validate(`{"jsonrpc":"2.0","id":0,"method":"unknown","params":{"a":${raw}}}`).originalMessage.params.a,value,raw)
    for(const params of [
      {a:null,b:false,c:true,d:[],e:{},number:1.25e2},
      {a:'quotes " slash / backslash \\ \t\r\n',unicode:"😀"},
    ])assert.deepEqual(validate(frame(params)).originalMessage.params,params)
    assert.equal(validate('{"method":"unknown","params":{"s":"\\ud83d\\ude00"},"jsonrpc":"2.0","id":0}').originalMessage.params.s,"😀")
    assert.equal(validate('{"method":"unknown","params":{"s":"\\\"\\\\\\/\\t\\r\\n"},"jsonrpc":"2.0","id":0}').originalMessage.params.s,'"\\/\t\r\n')
  })
  test("duplicate_decoded_keys_all_depths_fatal",()=>{
      assert.equal(typeof protocol.validateCatalogWireFrame,"function")
    for(const raw of [
      '{"jsonrpc":"2.0","id":0,"id":1,"method":"ping"}',
      '{"jsonrpc":"2.0","id":0,"method":"unknown","params":{"a":1,"\\u0061":2}}',
      '{"jsonrpc":"2.0","id":0,"method":"unknown","params":{"a":[{"x":1,"x":2}]}}',
      '{"jsonrpc":"2.0","id":0,"method":"ping","params":{"__proto__":{}}}',
      '{"jsonrpc":"2.0","id":0,"method":"ping","params":{"constructor":{}}}',
      '{"jsonrpc":"2.0","id":0,"method":"ping","params":{"x":"\\ud800"}}',
      '{"jsonrpc":"2.0","id":9007199254740992,"method":"ping"}',
      '{"jsonrpc":"2.0","id":-1,"method":"ping"}',
      '{"jsonrpc":"2.0","id":"","method":"ping"}',
      '{"jsonrpc":"2.0","id":"\\u0000","method":"ping"}',
      '{"jsonrpc":"2.0","id":0,"method":"ping","params":{},"unknown":true}',
    ])assert.throws(()=>protocol.validateCatalogWireFrame(Buffer.from(raw)),undefined,raw)
    const parse=JSON.parse;let parsed=0
    JSON.parse=(...args)=>{parsed++;return parse(...args)}
    try{
      for(const raw of [
        '{"jsonrpc":"2.0","id":0,"method":"unknown","params":{"a":[{"x":1,"\\u0078":2}]}}',
        '{"jsonrpc":"2.0","id":0,"method":"unknown","params":{"\\u005f_proto__":{}}}',
        '{"jsonrpc":"2.0","id":0,"method":"unknown","params":{"s":"\\ud800"}}',
      ])assert.throws(()=>protocol.validateCatalogWireFrame(Buffer.from(raw)),{message:"wire_noncanonical"})
      assert.equal(parsed,0,"lexical rejection precedes JSON.parse")
    }finally{JSON.parse=parse}
  })
  test("closed_native_metadata_capabilities",()=>{
    const message={method:"initialize",params:{protocolVersion:"2025-11-25",
      clientInfo:{name:"claude-code",title:"Claude Code",version:"2.1.296",description:"Anthropic's agentic coding tool",websiteUrl:"https://code.claude.com"},
      capabilities:{roots:{listChanged:true},elicitation:{form:{},url:{}},extensions:{"io.modelcontextprotocol/ui":{mimeTypes:["text/html;profile=mcp-app"]}}}},
      jsonrpc:"2.0",id:0}
    assert.equal(protocol.validateCatalogInitialize(message).negotiated,"2025-06-18")
    for(const change of [
      {capabilities:{sampling:{}}},{capabilities:{tasks:{}}},{capabilities:{experimental:{}}},
      {capabilities:{roots:{listChanged:1}}},{capabilities:{elicitation:{form:{unknown:true}}}},
      {capabilities:{extensions:{unknown:{}}}},
      {capabilities:{extensions:{"io.modelcontextprotocol/ui":{mimeTypes:["text/html"]}}}},
      {clientInfo:{name:"x",version:"1",icons:[]}},{clientInfo:{name:"x",version:"1",_meta:{}}},
      {clientInfo:{name:"x".repeat(129),version:"1"}},{clientInfo:{name:"x",version:"\n"}},
      {protocolVersion:"unknown"},
    ])assert.throws(()=>protocol.validateCatalogInitialize({...message,params:{...message.params,...change}}))
    for(const version of ["2025-06-18","2025-11-25"])assert.equal(protocol.validateCatalogInitialize({...message,params:{...message.params,protocolVersion:version}}).negotiated,"2025-06-18")
    assert.throws(()=>protocol.validateCatalogInitialize({...message,method:"ping"}),{message:"protocol_state"})
    assert.throws(()=>protocol.validateCatalogWireFrame(Buffer.from('{"jsonrpc":"1.0","id":0,"method":"ping"}')),{message:"wire_noncanonical"})
    assert.throws(()=>protocol.validateCatalogWireFrame(Buffer.from('{"jsonrpc":"2.0","id":0,"method":"tools/call","params":{"name":"evidence_read","arguments":null}}')),{message:"catalog_invalid"})
  })
  test("no_outbound_capability_activation",async()=>{
    const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
    const state=catalog.createCatalogState(JSON.parse(catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)}).snapshotBytes))
    const input=new PassThrough(),output=new PassThrough();let raw="",failure
    output.on("data",x=>{raw+=x})
    const service=await protocol.serveCatalog({state,input,output,onFailure:e=>{failure=e},writeReceipt:async()=>{throw Error("unexpected_receipt")}})
    const messages=[
      {method:"initialize",params:{protocolVersion:"2025-11-25",clientInfo:{name:"claude-code",version:"2.1.296",title:"Claude Code"},capabilities:{roots:{listChanged:true},elicitation:{form:{},url:{}}}},jsonrpc:"2.0",id:0},
      {method:"notifications/initialized",jsonrpc:"2.0"},
      {method:"roots/list",jsonrpc:"2.0",id:1},
      {method:"tools/list",jsonrpc:"2.0",id:2},
    ]
    for(const value of messages){input.write(JSON.stringify(value)+"\n");await new Promise(r=>setImmediate(r))}
    const replies=raw.trim().split("\n").map(x=>JSON.parse(x))
    assert.equal(replies.length,3)
    assert.deepEqual(replies[0].result,{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"triage_catalog",version:"1"}})
    assert.equal(replies[1].error.code,-32601)
    assert.equal(replies[2].result.tools.length,4)
    assert.ok(replies.every(x=>!Object.hasOwn(x,"method")),"no counterpart request or notification emitted")
    assert.equal(failure,undefined);assert.equal(state.submission,null)
    input.write('{"jsonrpc":"2.0","method":"notifications/unknown"}\n')
    await new Promise(r=>setImmediate(r))
    assert.equal(failure.message,"protocol_state")
    await service.close()
  })
test("offer_negotiates_only_pinned_20250618",async()=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const prepared=catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)})
  for(const offer of ["2025-06-18","2025-11-25","2025-03-26","2024-11-05","2024-10-07","2026-01-01"]){
    const state=catalog.createCatalogState(JSON.parse(prepared.snapshotBytes))
    const input=new PassThrough(),output=new PassThrough();let raw="",failure
    output.on("data",x=>{raw+=x})
    const service=await protocol.serveCatalog({state,input,output,onFailure:e=>{failure=e},writeReceipt:async()=>{throw Error("unexpected_receipt")}})
    input.write(JSON.stringify({jsonrpc:"2.0",id:0,method:"initialize",
      params:{protocolVersion:offer,capabilities:{},clientInfo:{name:"claude-code",version:"2.1.296"}}})+"\n")
    await new Promise(r=>setImmediate(r))
    const replies=raw.trim().split("\n").filter(Boolean).map(x=>JSON.parse(x))
    if(["2025-06-18","2025-11-25"].includes(offer)){
      assert.equal(failure,undefined,offer)
      assert.equal(replies.length,1,offer)
      assert.equal(replies[0].result.protocolVersion,"2025-06-18",offer)
    }else{
      assert.equal(failure?.message,"protocol_state",offer)
      assert.equal(replies.length,0,`${offer} holds before any reply`)
    }
    await service.close()
  }
})
test("closed_protocol_requests_stay_side_effect_free",async()=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const initialize={jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"isolated_unit",version:"1"}}}
  const state=catalog.createCatalogState(JSON.parse(catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)}).snapshotBytes))
  const input=new PassThrough(),output=new PassThrough();let text="",failure
  output.on("data",chunk=>{text+=chunk})
  const service=await protocol.serveCatalog({state,input,output,writeReceipt:async()=>{},onFailure:error=>{failure=error}})
  for(const message of [initialize,{jsonrpc:"2.0",method:"notifications/initialized",params:{}},
    {jsonrpc:"2.0",id:2,method:"unknown/request"},{jsonrpc:"2.0",id:3,method:"tools/list",params:{}},
    {jsonrpc:"2.0",id:4,method:"ping",params:{}},
    {jsonrpc:"2.0",id:5,method:"tools/call",params:{name:"evidence_read",arguments:{id:"r000002"}}},
    {jsonrpc:"2.0",id:6,method:"tools/call",params:{name:"candidate_submit",arguments:{candidate:fixture.candidate}}},
    {jsonrpc:"2.0",id:7,method:"tools/call",params:{name:"candidate_submit",arguments:{candidate:fixture.candidate}}},
    {jsonrpc:"2.0",id:8,method:"tools/list"},{jsonrpc:"2.0",id:9,method:"ping"}]){
    input.write(serializeMessage(deserializeMessage(JSON.stringify(message))))
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  const replies=text.trim().split("\n").map(line=>JSON.parse(line))
  assert.equal(replies.find(value=>value.id===2).error.code,-32601)
  assert.equal(replies.find(value=>value.id===3).result.tools.length,4)
  assert.deepEqual(replies.find(value=>value.id===4).result,{})
  assert.equal(replies.find(value=>value.id===5).result.structuredContent.id,"r000002")
  assert.equal(replies.find(value=>value.id===6).result.structuredContent.receipt_id,replies.find(value=>value.id===7).result.structuredContent.receipt_id)
  assert.equal(service.error().code,-32600)
  assert.equal(failure,undefined)
  await service.close()
  const defaultState=catalog.createCatalogState(JSON.parse(catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)}).snapshotBytes))
  const defaults=await protocol.serveCatalog({state:defaultState,writeReceipt:async()=>{}})
  await defaults.close()
})
ownedCatalogTest("real_stdio_closed_manifest",async(t,custody)=>{
  assert.equal(typeof custody.runDirectCatalog,"function")
  const result=await custody.runDirectCatalog({fixture,deadline:Date.now()+15000})
  t.after(()=>result.cleanup?.())
  assert.equal(result.state,"proved")
  assert.deepEqual(result.tools.map(x=>x.name),["evidence_read","evidence_search","evidence_list","candidate_submit"])
  assert.equal(result.custody.receipts.map(x=>x.event).join(","),"bootstrap,submit,terminal")
  assert.equal(result.responses.every(x=>x.ok),true)
})
ownedCatalogTest("real_unmodified_sdk_stdio_handshake",async(t,custody)=>{
  const result=await custody.runDirectCatalog({fixture,deadline:Date.now()+15000})
  t.after(()=>result.cleanup?.())
  assert.equal(result.state,"proved")
  const initialize=result.resources.wire.find(x=>x.method==="initialize")
  assert.equal(initialize.params.protocolVersion,"2025-11-25")
  assert.equal(initialize.params.clientInfo.name,"claude-code")
  assert.equal(initialize.params.clientInfo.title,"Claude Code")
  assert.deepEqual(initialize.params.capabilities.roots,{listChanged:true})
  const calls=result.resources.wire.filter(x=>x.method==="tools/call")
  assert.equal(calls.length>0,true)
  for(const call of calls){
    assert.deepEqual(Object.keys(call.params._meta).sort(),["claudecode/toolUseId","progressToken"],"direct lane sends the native tools/call shape")
    assert.match(call.params._meta["claudecode/toolUseId"],/^toolu_/u)
  }
  assert.equal(new Set(calls.map(x=>x.params._meta["claudecode/toolUseId"])).size,calls.length)
  assert.equal(result.resources.trace.version,2)
  // The direct lane mirrors native: the recorded discover probe goes first,
  // then the SDK's own initialize on the same process.
  const writes=result.resources.trace.events.filter(x=>x.direction==="client_to_server"&&x.event==="write")
  assert.equal(Buffer.from(writes[0].base64,"base64").toString(),RECORDED_PROBE.toString())
  const raw=Buffer.from(writes[1].base64,"base64").toString()
  assert.deepEqual(Object.keys(JSON.parse(raw)),["method","params","jsonrpc","id"])
  assert.equal(JSON.parse(raw).method,"initialize")
  assert.deepEqual(result.resources.wire.slice(0,2).map(x=>x.method),["server/discover","initialize"])
  assert.equal(result.resources.trace.events.some(x=>x.direction==="server_to_client"),true)
  assert.equal(result.resources.trace.events.some(x=>x.event==="write_complete"),true)
  assert.equal(result.resources.trace.events.some(x=>x.event==="close"),true)
  assert.deepEqual(result.tools.map(x=>x.name),["evidence_read","evidence_search","evidence_list","candidate_submit"])
})
ownedCatalogTest("authenticated_first_wire_observations_are_not_submission_receipts",async(t,custody)=>{
  const result=await custody.runDirectCatalog({fixture,deadline:Date.now()+15000})
  t.after(()=>result.cleanup?.())
  assert.equal(result.state,"proved")
  assert.deepEqual(result.custody.receipts.map(x=>x.event),["bootstrap","submit","terminal"])
  assert.ok(Array.isArray(result.custody.observations))
  const inputs=result.custody.observations.filter(x=>x.payload.kind==="input_frame")
  assert.equal(Buffer.from(inputs[0].payload.base64,"base64").toString(),RECORDED_PROBE.toString())
  assert.equal(JSON.parse(Buffer.from(inputs[1].payload.base64,"base64")).method,"initialize")
  const answered=result.custody.observations.filter(x=>x.payload.kind==="discover_answered")
  assert.equal(answered.length,1)
  assert.equal(Buffer.from(answered[0].payload.base64,"base64").toString(),PROBE_ANSWER)
  const outputs=result.custody.observations.filter(x=>x.payload.kind==="output_frame")
  assert.equal(Buffer.from(outputs[0].payload.base64,"base64").toString(),PROBE_ANSWER)
  assert.equal(JSON.parse(Buffer.from(outputs[1].payload.base64,"base64")).result.protocolVersion,"2025-06-18")
  const exit=result.custody.observations.find(x=>x.payload.kind==="launcher_exit")
  assert.equal(exit.payload.code,0)
  assert.equal(exit.payload.signal,null)
  assert.ok(result.custody.observations.every(x=>x.event==="observation"))
})
ownedCatalogTest("first_parser_refusal_is_observed_from_actual_server",async(t,custody)=>{
  const raw='{"method":"initialize","params":{"protocolVersion":"unknown","capabilities":{},"clientInfo":{"name":"x","version":"1"}},"jsonrpc":"2.0","id":0}\n'
  const result=await custody.runCatalogWireCase({fixture,frames:[raw],deadline:Date.now()+5000})
  t.after(()=>result.cleanup?.())
  assert.equal(result.state,"refused")
  const first=result.resources.observations.find(x=>x.payload.kind==="input_frame")
  assert.equal(Buffer.from(first.payload.base64,"base64").toString(),raw)
  assert.equal(first.payload.offset,0)
  const refused=result.resources.observations.find(x=>x.payload.kind==="parser_refused")
  assert.equal(refused.payload.code,"protocol_state")
  const exit=result.resources.observations.find(x=>x.payload.kind==="launcher_exit")
  assert.equal(exit.payload.code,1)
})
test("recorded_native_discover_probe_is_the_only_accepted_probe_shape",()=>{
  assert.equal(RECORDED_PROBE.length,459)
  assert.equal(createHash("sha256").update(RECORDED_PROBE).digest("hex"),"57c78d24d7bcc7d53091bfdbd307c8eb1d1c783e43b7fe94110332d120029bb9")
  assert.equal(serializeMessage(custody.NATIVE_DISCOVER_PROBE),RECORDED_PROBE.toString(),"direct lane sends the recorded bytes")
  const line=RECORDED_PROBE.subarray(0,-1)
  assert.equal(protocol.validateCatalogWireFrame(line).originalMessage.method,"server/discover")
  const probe=()=>JSON.parse(line.toString())
  const meta=value=>value.params._meta
  for(const [name,mutate,code]of [
    ["numeric_id",x=>{x.id=1},"protocol_state"],
    ["zero_id",x=>{x.id="server-discover-probe-0"},"protocol_state"],
    ["other_id",x=>{x.id="probe-1"},"protocol_state"],
    ["no_id",x=>{delete x.id},"catalog_invalid"],
    ["modern_version",x=>{meta(x)["io.modelcontextprotocol/protocolVersion"]="2026-12-01"},"protocol_state"],
    ["legacy_version",x=>{meta(x)["io.modelcontextprotocol/protocolVersion"]="2025-06-18"},"protocol_state"],
    ["extra_meta",x=>{meta(x)["io.modelcontextprotocol/other"]=1},"catalog_invalid"],
    ["missing_capabilities",x=>{delete meta(x)["io.modelcontextprotocol/clientCapabilities"]},"catalog_invalid"],
    ["extra_capability",x=>{meta(x)["io.modelcontextprotocol/clientCapabilities"].sampling={}},"catalog_invalid"],
    ["extra_client_info",x=>{meta(x)["io.modelcontextprotocol/clientInfo"].icons=[]},"catalog_invalid"],
    ["long_client_name",x=>{meta(x)["io.modelcontextprotocol/clientInfo"].name="x".repeat(129)},"catalog_invalid"],
    ["extra_param",x=>{x.params.cursor="x"},"catalog_invalid"],
    ["no_params",x=>{delete x.params},"catalog_invalid"],
  ]){
    const value=probe();mutate(value)
    assert.throws(()=>protocol.validateCatalogWireFrame(Buffer.from(JSON.stringify(value))),{message:code},name)
  }
})
test("discover_probe_is_answered_method_not_found_then_initialize_continues",async()=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const initialize={jsonrpc:"2.0",id:0,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{roots:{listChanged:true},elicitation:{form:{},url:{}}},
    clientInfo:{name:"claude-code",title:"Claude Code",version:"2.1.296"}}}
  const state=catalog.createCatalogState(JSON.parse(catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)}).snapshotBytes))
  const input=new PassThrough(),output=new PassThrough(),events=[];let raw="",failure
  output.on("data",x=>{raw+=x})
  const service=await protocol.serveCatalog({state,input,output,onObservation:x=>events.push(x),onFailure:e=>{failure=e},writeReceipt:async()=>{throw Error("unexpected_receipt")}})
  input.write(RECORDED_PROBE)
  await new Promise(r=>setTimeout(r,10))
  assert.equal(failure,undefined)
  assert.equal(raw,PROBE_ANSWER,"answered before initialize, exactly once")
  input.write(JSON.stringify(initialize)+"\n")
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n')
  await new Promise(r=>setTimeout(r,20))
  const replies=raw.trim().split("\n").map(x=>JSON.parse(x))
  assert.equal(failure,undefined)
  assert.equal(replies[1].result.protocolVersion,"2025-06-18")
  assert.equal(replies[2].result.tools.length,4)
  const answered=events.filter(x=>x.kind==="discover_answered")
  assert.equal(answered.length,1)
  assert.equal(answered[0].direction,"output");assert.equal(answered[0].offset,0);assert.equal(answered[0].bytes.toString(),PROBE_ANSWER)
  assert.deepEqual(events.filter(x=>x.kind==="input_frame").map(x=>x.bytes.toString().includes("server/discover")),[true,false])
  assert.equal(custody.validateCatalogObservation(custody.makeCatalogObservation({...answered[0],pid:1})),true)
  for(const bad of [{code:"protocol_state"},{direction:"input"},{bytes:Buffer.alloc(0)},{bytes:Buffer.from("{}")}])
    assert.throws(()=>custody.makeCatalogObservation({...answered[0],pid:1,...bad}),{message:"observation_invalid"})
  await service.close()
})
test("discover_probe_answer_write_failure_is_fatal_on_output",async()=>{
  for(const observe of [true,false]){
    const input=new PassThrough(),events=[],failures=[]
    const output=new Writable({write(_chunk,_encoding,callback){callback(Error("unit_probe_write"))}})
    output.on("error",()=>{})
    const guarded=protocol.guardedCatalogTransport({input,output,onFailure:e=>failures.push(e),...(observe?{onObservation:x=>events.push(x)}:{})})
    await guarded.transport.start()
    input.write(RECORDED_PROBE)
    await new Promise(r=>setTimeout(r,10))
    assert.equal(failures[0]?.message,"unit_probe_write")
    if(observe){
      assert.equal(events.filter(x=>x.kind==="discover_answered").length,1)
      assert.equal(events.find(x=>x.kind==="parser_refused").direction,"output")
    }
    await guarded.close()
  }
})
test("discover_probe_anywhere_but_the_first_frame_is_fatal",async()=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const initialize={jsonrpc:"2.0",id:0,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"claude-code",version:"2.1.296"}}}
  const probe=RECORDED_PROBE.toString(),second=probe.replace("server-discover-probe-1","server-discover-probe-2")
  const init=JSON.stringify(initialize)+"\n",initialized='{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
  for(const [name,frames,answers]of [
    ["second_probe",[probe,second],1],
    ["same_probe_twice",[probe,probe],1],
    ["after_initialize",[init,probe],1],
    ["after_initialized",[probe,init,initialized,second],2],
    ["other_pre_initialize_request",['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'],0],
    ["other_pre_initialize_ping",['{"jsonrpc":"2.0","id":1,"method":"ping"}\n'],0],
    ["unknown_pre_initialize_request",['{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/listen"}\n'],0],
  ]){
    const state=catalog.createCatalogState(JSON.parse(catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)}).snapshotBytes))
    const input=new PassThrough(),output=new PassThrough(),events=[];let raw="",failure
    output.on("data",x=>{raw+=x})
    const service=await protocol.serveCatalog({state,input,output,onObservation:x=>events.push(x),onFailure:e=>{failure??=e},writeReceipt:async()=>{throw Error("unexpected_receipt")}})
    for(const frame of frames){input.write(frame);await new Promise(r=>setTimeout(r,10))}
    assert.equal(failure?.message,"protocol_state",name)
    assert.equal(raw.trim().split("\n").filter(Boolean).length,answers,name)
    assert.ok(events.filter(x=>x.kind==="discover_answered").length<=1,name)
    await service.close()
  }
})
ownedCatalogTest("actual_server_answers_one_probe_and_refuses_a_second",async(t,custody)=>{
  const second=RECORDED_PROBE.toString().replace("server-discover-probe-1","server-discover-probe-2")
  const result=await custody.runCatalogWireCase({fixture,frames:[RECORDED_PROBE.toString(),second],deadline:Date.now()+5000})
  t.after(()=>result.cleanup?.())
  assert.equal(result.state,"refused")
  const kinds=result.resources.observations.map(x=>x.payload.kind)
  assert.equal(kinds.filter(x=>x==="discover_answered").length,1)
  assert.equal(Buffer.from(result.resources.observations.find(x=>x.payload.kind==="discover_answered").payload.base64,"base64").toString(),PROBE_ANSWER)
  assert.equal(result.resources.observations.find(x=>x.payload.kind==="parser_refused").payload.code,"protocol_state")
  assert.deepEqual(kinds.slice(0,4),["input_frame","output_frame","discover_answered","input_frame"])
})
test("original_split_wire_offsets_and_output_refusal_direction_are_observed",async()=>{
  const input=new PassThrough(),output=new PassThrough(),events=[]
  const guarded=protocol.guardedCatalogTransport({input,output,onObservation:x=>events.push(x),
    onFailure:()=>{},limits:{... (await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")).CATALOG_LIMITS,frameBytes:60}})
  await guarded.transport.start()
  guarded.transport.onmessage=()=>{}
  const wire='{"method":"ping","id":0,"jsonrpc":"2.0"}\r\n'
  input.write(wire.slice(0,12));input.write(wire.slice(12))
  const first=events.find(x=>x.kind==="input_frame")
  assert.equal(first.offset,0);assert.equal(first.bytes.toString(),wire)
  // A subsequent split frame exceeds the limit in its second chunk. The
  // retained partial bytes start before that chunk, not at aggregate end.
  input.write(" ".repeat(40));input.write(" ".repeat(40))
  const failure=events.find(x=>x.kind==="parser_refused")
  assert.equal(failure.offset,Buffer.byteLength(wire))
  assert.equal(failure.bytes.length,40)
  await guarded.close()
  const outInput=new PassThrough(),outOutput=new PassThrough(),outEvents=[]
  const second=protocol.guardedCatalogTransport({input:outInput,output:outOutput,onObservation:x=>outEvents.push(x),onFailure:()=>{},
    limits:{...(await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")).CATALOG_LIMITS,outgoingBytes:1}})
  await second.transport.start()
  await assert.rejects(second.transport.send({jsonrpc:"2.0",id:0,result:{}}))
  assert.equal(outEvents.find(x=>x.kind==="parser_refused").direction,"output")
  await second.close()
  const errorInput=new PassThrough(),errorOutput=new PassThrough(),errorEvents=[]
  errorOutput.write=(_chunk,callback)=>{callback(Error("specific_private_error"));return false}
  const third=protocol.guardedCatalogTransport({input:errorInput,output:errorOutput,onObservation:x=>errorEvents.push(x),onFailure:()=>{}})
  await third.transport.start()
  await assert.rejects(third.transport.send({jsonrpc:"2.0",id:0,result:{}}))
  assert.equal(errorEvents.find(x=>x.kind==="write_complete").code,"write_failed")
  await third.close()
})
ownedCatalogTest("two_identical_stateful_histories",async(t,custody)=>{
  const a=await custody.runDirectCatalog({fixture,deadline:Date.now()+15000})
  const b=await custody.runDirectCatalog({fixture,deadline:Date.now()+15000})
  t.after(()=>{a.cleanup?.();b.cleanup?.()})
  assert.equal(a.state,"proved");assert.equal(b.state,"proved")
  assert.equal(a.historySha256,b.historySha256)
  assert.notEqual(a.generation,b.generation)
  assert.notEqual(a.custody.receipts[0].server_pid,b.custody.receipts[0].server_pid)
  assert.throws(()=>custody.authenticatedDirectReceipts([custody.retainDirectReceipt(a),custody.retainDirectReceipt(b)]),
    {message:"direct_bundles_incomplete"})
})
ownedCatalogTest("real_wire_fatal_subcases_never_materialize",async(t,custody)=>{
  assert.equal(typeof custody.runCatalogWireCase,"function")
  for(const [name,frames] of [
    ["duplicate_key",['{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}\n']],
    ["invalid_utf8",[Buffer.from([0xff,10])]],
    ["malformed_json",["{\n"]],
    ["partial_eof",['{"jsonrpc":"2.0"']],
    ["oversize_frame",[Buffer.alloc(393217,32)]],
    ["before_initialize",['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n']],
    ["second_initialize",[{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"triage",version:"1"}}},
      {jsonrpc:"2.0",id:2,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"triage",version:"1"}}}]],
  ]) await t.test(name,async()=>{
    const result=await custody.runCatalogWireCase({fixture,frames,deadline:Date.now()+8000})
    t.after(()=>result.cleanup?.())
    assert.equal(result.state,"refused",result.reason)
    assert.equal(result.normalTerminal,false)
    assert.equal(result.resources.serverExited,true)
  })
})
ownedCatalogTest("real_frame_count_and_aggregate_restart_cases",async(t,custody)=>{
    const initialize={jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"triage_direct",version:"1"}}}
    const initialized={jsonrpc:"2.0",method:"notifications/initialized"}
    for(const [name,frames,detail]of [
      ["frame_count",[initialize,initialized,...Array.from({length:255},(_,i)=>({jsonrpc:"2.0",id:i+2,method:"ping"}))],"wire_frame_count"],
      ["aggregate",[initialize,initialized,...Array.from({length:52},(_,i)=>({jsonrpc:"2.0",id:i+2,method:"tools/call",
        params:{name:"evidence_read",arguments:{id:"x".repeat(330000)}}}))],"wire_input_limit"],
      ["output",[initialize,initialized,...Array.from({length:252},(_,i)=>({jsonrpc:"2.0",id:String(i)+"x".repeat(66300),method:"tools/list"}))],"catalog_invalid"],
    ])await t.test(name,async()=>{
      const result=await custody.runCatalogWireCase({fixture,frames,deadline:Date.now()+20000})
      t.after(()=>result.cleanup?.())
      assert.equal(result.state,"refused",result.reason)
      assert.ok(result.resources.stderr.includes(detail),result.resources.stderr)
      assert.equal(result.resources.serverExited,true)
      assert.equal(result.resources.exit.code,1)
  })
})
