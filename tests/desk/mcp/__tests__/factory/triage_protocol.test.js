import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import fs from "node:fs"
import {spawnSync,spawn} from "node:child_process"
import os from "node:os"
import * as path from "node:path"
import {serializeMessage,deserializeMessage} from "@modelcontextprotocol/sdk/shared/stdio.js"
import moduleBuiltin,{syncBuiltinESMExports} from "node:module"
import childProcess from "node:child_process"
import {EventEmitter} from "node:events"
const protocol=await import("../../../../../plugins/desk/mcp/src/factory/triage-protocol.js").catch(()=>({}))
const custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js").catch(()=>({}))
const fixture=JSON.parse(fs.readFileSync(new URL("./fixtures/v12-owned-catalog.json",import.meta.url)))
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
test("same_source_module_custody_is_bounded_and_nonselectable",async(t)=>{
  const {catalogModuleLoad}=await import("../../../../../plugins/desk/mcp/scripts/triage-catalog-server.js")
  const root=new URL("../../../../../plugins/desk/mcp/",import.meta.url)
  const file=new URL("src/factory/triage-catalog.js",root),records=new Map()
  assert.equal(catalogModuleLoad(records,root.pathname,file.href,{},()=>({format:"module"})).format,"module")
  assert.equal(records.size,1)
  assert.equal(records.get(file.pathname).bytes,fs.statSync(file).size)
  assert.equal(catalogModuleLoad(records,root.pathname,"node:fs",{},()=>42),42)
  assert.throws(()=>catalogModuleLoad(records,"/not-owned/",file.href,{},()=>{}),{message:"module_custody"})
  const full=new Map(Array.from({length:512},(_,i)=>[String(i),{}]))
  assert.throws(()=>catalogModuleLoad(full,root.pathname,file.href,{},()=>{}),{message:"module_custody"})
  const read=fs.readFileSync,realpath=fs.realpathSync
  try{
    fs.readFileSync=()=>Buffer.alloc(16777217)
    assert.throws(()=>catalogModuleLoad(new Map(),root.pathname,file.href,{},()=>{}),{message:"module_custody"})
    fs.readFileSync=read;fs.realpathSync=()=>"/synthetic/alias"
    assert.throws(()=>catalogModuleLoad(new Map(),root.pathname,file.href,{},()=>{}),{message:"module_custody"})
  }finally{fs.readFileSync=read;fs.realpathSync=realpath}
})
test("same_source_entry_failures_do_not_bootstrap_or_touch_profile",async()=>{
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
test("same_source_unit_launcher_control_and_teardown_outcomes",async(t)=>{
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
test("instrumented_unit_server_uses_same_source_without_proof_authority",async(t)=>{
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
test("same_source_unit_server_fatal_and_late_receipt_paths_are_closed",async(t)=>{
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
  const frame=id=>serializeMessage(deserializeMessage(JSON.stringify({jsonrpc:"2.0",id,method:"ping"})))
  input.write(frame(1)+frame(2))
  assert.deepEqual(received,[1])
  await guard.transport.send({jsonrpc:"2.0",id:1,result:{}})
  callbacks.shift()()
  assert.deepEqual(received,[1,2],"release must forward the single bounded pending request")
  await guard.transport.send({jsonrpc:"2.0",id:2,result:{}})
  callbacks.shift()()
  await guard.waitIdle()
  assert.equal(guard.counters().framesIn,2)
  input.emit("error",Error("synthetic_input_failure"))
  assert.equal(guard.failed(),true)
  // Exercise the adapter's own output guard against a late SDK write; never
  // alter production serialization or enable any tool or external operation.
  const late=new Promise(resolve=>guard.transport._stdout.write("late",error=>resolve(error)))
  assert.equal((await late).message,"wire_closed")
  await guard.close()
})
test("wire_incoming_limits_and_onmessage_errors_close_without_dispatch",async()=>{
  for(const [data,limits,want]of [
    ['{"jsonrpc":"2.0","id":1,"method":"ping"}\n',{incomingBytes:1},"wire_input_limit"],
    ['{"jsonrpc":"2.0","id":1,"method":"ping"}\n',{incomingFrames:0},"wire_frame_count"],
    ['{"jsonrpc":"2.0","id":1,"method":"ping"}\n'.repeat(3),{},"wire_queue_limit"],
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
    const request={jsonrpc:"2.0",id:0,method:"tools/call",params:{name:"evidence_list",arguments:{},_meta:{}}}
    assert.throws(()=>protocol.validateCatalogWireFrame(Buffer.from(JSON.stringify(request))),{message:"catalog_invalid"})
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
test("real_stdio_closed_manifest",async(t)=>{
  assert.equal(typeof custody.runDirectCatalog,"function")
  const result=await custody.runDirectCatalog({fixture,deadline:Date.now()+15000})
  t.after(()=>result.cleanup?.())
  assert.equal(result.state,"proved")
  assert.deepEqual(result.tools.map(x=>x.name),["evidence_read","evidence_search","evidence_list","candidate_submit"])
  assert.equal(result.custody.receipts.map(x=>x.event).join(","),"bootstrap,submit,terminal")
  assert.equal(result.responses.every(x=>x.ok),true)
})
test("real_unmodified_sdk_stdio_handshake",async(t)=>{
  const result=await custody.runDirectCatalog({fixture,deadline:Date.now()+15000})
  t.after(()=>result.cleanup?.())
  assert.equal(result.state,"proved")
  const initialize=result.resources.wire.find(x=>x.method==="initialize")
  assert.equal(initialize.params.protocolVersion,"2025-11-25")
  assert.equal(initialize.params.clientInfo.name,"claude-code")
  assert.equal(initialize.params.clientInfo.title,"Claude Code")
  assert.deepEqual(initialize.params.capabilities.roots,{listChanged:true})
  assert.equal(result.resources.trace.version,2)
  const first=result.resources.trace.events.find(x=>x.direction==="client_to_server")
  const raw=Buffer.from(first.base64,"base64").toString()
  assert.deepEqual(Object.keys(JSON.parse(raw)),["method","params","jsonrpc","id"])
  assert.equal(result.resources.trace.events.some(x=>x.direction==="server_to_client"),true)
  assert.equal(result.resources.trace.events.some(x=>x.event==="write_complete"),true)
  assert.equal(result.resources.trace.events.some(x=>x.event==="close"),true)
  assert.deepEqual(result.tools.map(x=>x.name),["evidence_read","evidence_search","evidence_list","candidate_submit"])
})
test("authenticated_first_wire_observations_are_not_submission_receipts",async(t)=>{
  const result=await custody.runDirectCatalog({fixture,deadline:Date.now()+15000})
  t.after(()=>result.cleanup?.())
  assert.equal(result.state,"proved")
  assert.deepEqual(result.custody.receipts.map(x=>x.event),["bootstrap","submit","terminal"])
  assert.ok(Array.isArray(result.custody.observations))
  const input=result.custody.observations.find(x=>x.payload.kind==="input_frame")
  assert.equal(JSON.parse(Buffer.from(input.payload.base64,"base64")).method,"initialize")
  const output=result.custody.observations.find(x=>x.payload.kind==="output_frame")
  assert.equal(JSON.parse(Buffer.from(output.payload.base64,"base64")).result.protocolVersion,"2025-06-18")
  const exit=result.custody.observations.find(x=>x.payload.kind==="launcher_exit")
  assert.equal(exit.payload.code,0)
  assert.equal(exit.payload.signal,null)
  assert.ok(result.custody.observations.every(x=>x.event==="observation"))
})
test("first_parser_refusal_is_observed_from_actual_server",async(t)=>{
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
test("two_identical_stateful_histories",async(t)=>{
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
test("real_wire_fatal_subcases_never_materialize",async(t)=>{
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
test("real_frame_count_and_aggregate_restart_cases",async(t)=>{
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
