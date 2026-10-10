import "../_isolated_env.mjs"
import {test} from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import * as path from "node:path"
import moduleBuiltin,{syncBuiltinESMExports} from "node:module"
import {spawn} from "node:child_process"
import childProcess from "node:child_process"
import {EventEmitter} from "node:events"
import {PassThrough} from "node:stream"
import {Client} from "@modelcontextprotocol/sdk/client/index.js"
import {ReadBuffer,serializeMessage,deserializeMessage} from "@modelcontextprotocol/sdk/shared/stdio.js"
const custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js").catch(()=>({}))
const fixture=JSON.parse(fs.readFileSync(new URL("./fixtures/v12-owned-catalog.json",import.meta.url)))
test("owned_custody_discovery",()=>{
  for(const key of ["openCatalogBootstrap","loadCatalogSnapshot","ownedServerLaunch","materializeTriageSubmission","runDirectCatalog",
    "observeOwnedServer","verifyModuleClosure","readProtectedBytes","reapOwnedChild","validateNativeSubmissionEvidence"])
    assert.equal(typeof custody[key],"function",key)
})
test("nonaccepted_native_pair_registry_cannot_authorize_real_receipts",()=>{
  const item=(session,generation)=>({state:"ran",stream:{stdout:JSON.stringify({type:"system",subtype:"init",session_id:session})+"\n"},custody:{receipts:[{generation}]}})
  const runs=[item("11111111-1111-1111-1111-111111111111","a".repeat(64)),item("22222222-2222-2222-2222-222222222222","b".repeat(64))]
  const unit=custody.createNonacceptedNativePair({runs})
  assert.equal(unit.authority,false)
  assert.deepEqual(unit.authenticate(),{authority:false,valid:true})
  assert.throws(()=>custody.authenticatedNativeRuns(unit.runs),{message:"native_run_untrusted"})
  assert.throws(()=>unit.authenticate(structuredClone(unit.runs)),{message:"native_run_untrusted"})
  for(const changed of [null,[],[runs[0]], [{...runs[0],state:"failed"},runs[1]],
    [runs[0],runs[0]], [runs[0],item("not-a-session","b".repeat(64))],
    [runs[0],{...runs[1],stream:{stdout:""}}],
    [runs[0],item("22222222-2222-2222-2222-222222222222","a".repeat(64))]]){
    if(!Array.isArray(changed)||changed.length!==2)assert.throws(()=>unit.authenticate(changed),{message:"native_runs_incomplete"})
    else assert.throws(()=>custody.createNonacceptedNativePair({runs:changed}).authenticate())
  }
})
test("owned_child_reaping_and_liveness_are_bounded_to_exact_handles",async(t)=>{
  assert.equal(typeof custody.ownedPidLive,"function")
  const kill=process.kill
  for(const error of [null,Object.assign(Error("gone"),{code:"ESRCH"}),Object.assign(Error("denied"),{code:"EPERM"})]){
    process.kill=()=>{if(error)throw error;return true}
    try{
      if(error?.code==="EPERM")assert.throws(()=>custody.ownedPidLive(123456),{code:"EPERM"})
      else assert.equal(custody.ownedPidLive(123456),!error)
    }finally{process.kill=kill}
  }
  await custody.reapOwnedChild(null,Date.now()+500)
  await custody.reapOwnedChild({exitCode:0,signalCode:null},Date.now()+500)
  await custody.reapOwnedChild({exitCode:null,signalCode:"SIGTERM"},Date.now()+500)
  for(const pid of [undefined,0,-1]){
    let calls=0
    const unknown=new EventEmitter()
    Object.assign(unknown,{pid,exitCode:null,signalCode:null,kill:()=>{calls++;queueMicrotask(()=>unknown.emit("close",0))}})
    await custody.reapOwnedChild(unknown,Date.now()+500)
    assert.equal(calls,0,"an unknown handle is not an owned PID")
  }
  for(const [soft,streams]of [[true,true],[false,true],[false,false]]){
    const child=new EventEmitter(),signals=[]
    Object.assign(child,{pid:500003,exitCode:null,signalCode:null})
    if(streams)Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()})
    child.kill=signal=>{signals.push(signal);if(soft||signal==="SIGKILL")queueMicrotask(()=>child.emit("close",0));return true}
    await custody.reapOwnedChild(child,Date.now()+(soft?700:150))
    assert.deepEqual(signals,soft?["SIGTERM"]:["SIGTERM","SIGKILL"])
    assert.equal(child.listenerCount("close"),0)
    if(!soft&&streams)assert.equal(child.stdout.destroyed,true)
  }
})
test("owned_observation_finite_os_errors_and_identity_mismatches",async(t)=>{
  const spawnOriginal=childProcess.spawn,platform=Object.getOwnPropertyDescriptor(process,"platform")
  let mode="valid",calls=0
  childProcess.spawn=(command,args)=>{
    assert.equal(command,"/bin/ps")
    const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough()})
    child.kill=()=>{queueMicrotask(()=>child.emit("close",1));return true}
    const call=++calls
    if(mode==="timeout")return child
    queueMicrotask(()=>{
      if(mode==="error"){child.emit("error",Error("unit_os_failure"));child.emit("close",1);return}
      if(mode==="output_limit"){child.stdout.write(Buffer.alloc(65537));return}
      if(mode==="stderr_limit"){child.stderr.write(Buffer.alloc(65537));return}
      if(mode==="stderr_small")child.stderr.write("unit-small")
      if(mode==="nonzero"){child.emit("close",1);return}
      const start="Sat Oct 10 13:00:00 2026"
      const row=call===1?`500001 ${mode==="server_parent"?9:500002} ${start} /unit/node ${mode==="server_command"?"/wrong":"/unit/server"}`:
        call===2?`500002 ${mode==="native_parent"?9:500003} ${start} /unit/node /unit/launcher ${mode==="launcher_command"?"--wrong":"--fixed"}`:
        mode==="env_prefix"?"/wrong-prefix LANG=C":`/unit/node /unit/server LANG=C LC_ALL=C TZ=UTC${mode==="env_unknown"?" UNKNOWN=unit":""}`
      child.stdout.write(mode==="pid_shape"?"unparsed":mode==="pid_value"?row.replace("500001","500009"):row)
      child.emit("close",0)
    })
    return child
  }
  syncBuiltinESMExports()
  t.after(()=>{childProcess.spawn=spawnOriginal;syncBuiltinESMExports();Object.defineProperty(process,"platform",platform)})
  const base=()=>({nativePid:500003,launcherPid:500002,serverPid:500001,generation:"a".repeat(64),
    expected:{deadline:Date.now()+1250,runtime:"/unit/node",entry:"/unit/server",launcher:"/unit/launcher",
      launchArgs:["--fixed"],cleanEnv:{LANG:"C",LC_ALL:"C",TZ:"UTC"}}})
  Object.defineProperty(process,"platform",{...platform,value:"darwin"})
  const valid=await custody.observeOwnedServer(base());assert.equal(valid.ok,true)
  calls=0;assert.equal((await custody.observeOwnedServer({...base(),nativePid:undefined,startIdentity:valid.identity})).ok,false)
  calls=0
  const identities={server:valid.identity.server,launch:valid.identity.launch}
  assert.equal((await custody.observeOwnedServer({...base(),nativePid:undefined,startIdentity:identities})).ok,true)
  calls=0;mode="stderr_small";assert.equal((await custody.observeOwnedServer(base())).ok,true)
  for(const item of ["timeout","error","output_limit","stderr_limit","nonzero","server_parent","native_parent","server_command","launcher_command","env_prefix","env_unknown","pid_shape","pid_value"]){
    mode=item;calls=0
    const result=await custody.observeOwnedServer(base())
    assert.equal(result.ok,false,item)
    assert.equal(typeof result.reason,"string")
  }
  mode="valid";calls=0
  assert.equal((await custody.observeOwnedServer({...base(),expected:{...base().expected,deadline:Date.now()+1000}})).reason,"observation_deadline")
  for(const change of [{generation:"bad"},{launcherPid:0},{serverPid:0}]){
    assert.equal((await custody.observeOwnedServer({...base(),...change})).reason,"provenance_unsupported")
  }
  Object.defineProperty(process,"platform",{...platform,value:"linux"})
  assert.equal((await custody.observeOwnedServer(base())).reason,"provenance_unsupported")
})
test("module_closure_and_protected_bytes_refuse_complete_finite_drift",async(t)=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const root=new URL("../../../../../plugins/desk/mcp/",import.meta.url).pathname
  const bytes=Buffer.from("synthetic module bytes only"),sha=catalog.catalogHash(bytes)
  const paths=["src/factory/triage-catalog.js","src/factory/triage-protocol.js","src/factory/triage-custody.js",
    "node_modules/@modelcontextprotocol/sdk/unit.js",...Array.from({length:6},(_,i)=>`src/factory/unit-${i}.js`)]
  const good=paths.map(name=>({path:root+name,sha256:sha,bytes:bytes.length}))
  const realpath=fs.promises.realpath,read=fs.promises.readFile
  let alias=false,oversize=false
  fs.promises.realpath=async value=>alias?value+".alias":value
  fs.promises.readFile=async()=>oversize?Buffer.alloc(8388609):bytes
  try{
    assert.deepEqual(await custody.verifyModuleClosure(good),good)
    for(const value of [null,[],Array.from({length:513},()=>good[0]),
      [{...good[0],path:9},...good.slice(1)],[{...good[0],path:"/outside.js"},...good.slice(1)],
      [good[0],good[0],...good.slice(2)],[{...good[0],sha256:"bad"},...good.slice(1)],
      [{...good[0],bytes:-1},...good.slice(1)],[{...good[0],bytes:0.5},...good.slice(1)],
      [{...good[0],bytes:bytes.length+1},...good.slice(1)],[{...good[0],sha256:"f".repeat(64)},...good.slice(1)],
      good.map(x=>({...x,path:x.path.replace("/@modelcontextprotocol/sdk/","/not-sdk/")})),
      good.map(x=>({...x,path:x.path.replace("/triage-catalog.js","/not-catalog.js")}))]){
      await assert.rejects(custody.verifyModuleClosure(value))
    }
    alias=true;await assert.rejects(custody.verifyModuleClosure(good),{message:"module_symlink"});alias=false
    const large=Buffer.alloc(8388609),largeHash=catalog.catalogHash(large)
    oversize=true
    await assert.rejects(custody.verifyModuleClosure(good.map(x=>({...x,bytes:large.length,sha256:largeHash}))),{message:"module_changed"})
  }finally{fs.promises.realpath=realpath;fs.promises.readFile=read}
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"unit-proof-drift-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const file=path.join(dir,"raw-proof"),original=Buffer.from("bounded synthetic fixture")
  fs.writeFileSync(file,original,{mode:0o600})
  assert.deepEqual(await custody.readProtectedBytes(file,original.length),original)
  await assert.rejects(custody.readProtectedBytes(file,original.length-1),{message:"proof_limit"})
  const open=fs.promises.open
  for(const scenario of ["dev","ino","changed","short"]){
    let handle
    fs.promises.open=async(...args)=>{
      handle=await open(...args)
      const stat=handle.stat.bind(handle),readFile=handle.readFile.bind(handle)
      if(["dev","ino"].includes(scenario))handle.stat=async()=>{const s=await stat();return {...s,[scenario]:s[scenario]+1}}
      else handle.readFile=async()=>{const b=await readFile();if(scenario==="changed")fs.appendFileSync(file," ");return scenario==="short"?b.subarray(1):b}
      return handle
    }
    try{await assert.rejects(custody.readProtectedBytes(file,100));assert.equal(handle.fd,-1)}
    finally{fs.promises.open=open;fs.writeFileSync(file,original)}
  }
})
test("pure_native_evidence_validation_never_issues_custody_authority",()=>{
  const catalogURL=new URL("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js",import.meta.url)
  return import(catalogURL).then(catalog=>{
    const prepared=catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)})
    const records=JSON.parse(prepared.snapshotBytes).records
    const names=["evidence_read","evidence_search","evidence_list","candidate_submit"].map(x=>"mcp__triage_catalog__"+x)
    const receipt={receipt_id:"unit-receipt",candidate_sha256:catalog.catalogHash(catalog.catalogCanonical(fixture.candidate)),candidate:fixture.candidate}
    const events=[{type:"system",subtype:"init",tools:names}]
    let n=0
    for(const record of records.filter(r=>r.id==="r000000"||r.kind==="card")){
      const id="unit-"+(++n)
      events.push({type:"assistant",message:{content:[{type:"tool_use",id,name:names[0],input:{id:record.id}}]}},
        {type:"user",message:{content:[{type:"tool_result",tool_use_id:id,content:[{type:"text",text:catalog.catalogCanonical(record)}]}]}})
    }
    events.push({type:"assistant",message:{content:[{type:"tool_use",id:"unit-submit",name:names[3],input:{candidate:fixture.candidate}}]}},
      {type:"user",message:{content:[{type:"tool_result",tool_use_id:"unit-submit",content:[{type:"text",text:catalog.catalogCanonical({receipt_id:receipt.receipt_id,candidate_sha256:receipt.candidate_sha256})}]}]}},
      {type:"result",subtype:"success",is_error:false})
    const session="11111111-1111-1111-1111-111111111111"
    const encode=list=>list.map((value,i)=>JSON.stringify({...value,session_id:session,uuid:`00000000-0000-0000-0000-${String(i+1).padStart(12,"0")}`})).join("\n")+"\n"
    const base={custody:{briefSha256:prepared.briefSha256,receipts:[{event:"submit",payload:receipt}]},
      nativeStream:{kind:"closed",code:0,truncated:false,stdout:encode(events)},brief:fixture.brief,records}
    assert.equal(custody.validateNativeSubmissionEvidence(base).authority,false)
    const check=(mutate,want)=>{
      const value=structuredClone(base),list=value.nativeStream.stdout.trim().split("\n").map(x=>JSON.parse(x))
      mutate(value,list)
      value.nativeStream.stdout=list.map(x=>JSON.stringify(x)).join("\n")+"\n"
      assert.throws(()=>custody.validateNativeSubmissionEvidence(value),want?{message:want}:undefined)
    }
    const firstResult=list=>list.find(x=>x.type==="user").message.content[0]
    const submitUse=list=>list.find(x=>x.message?.content[0]?.id==="unit-submit").message.content[0]
    const submitResult=list=>list.find(x=>x.message?.content[0]?.tool_use_id==="unit-submit").message.content[0]
    for(const mutate of [
      (v)=>v.custody.receipts=[],(v)=>v.custody.briefSha256="f".repeat(64),
      (_v,list)=>list.splice(0,1),(_v,list)=>list[0].tools.push("Bash"),
      v=>v.nativeStream.kind="timeout",v=>v.nativeStream.code=1,v=>v.nativeStream.truncated=true,
      (_v,list)=>list[0].session_id="bad",(_v,list)=>list[1].session_id="22222222-2222-2222-2222-222222222222",
      (_v,list)=>list[1].uuid="bad",(_v,list)=>list[1].uuid=list[0].uuid,
      (_v,list)=>list[1].message.content[0].name="Bash",
      (_v,list)=>list.push({...list[1],uuid:"33333333-3333-3333-3333-333333333333"}),
      (_v,list)=>list.splice(2,1),(_v,list)=>firstResult(list).tool_use_id="orphan",
      (_v,list)=>firstResult(list).is_error=true,(_v,list)=>firstResult(list).content="not-json",
      (_v,list)=>submitUse(list).input={candidate:{wrong:true}},
      (_v,list)=>submitResult(list).is_error=true,(_v,list)=>submitResult(list).content="not-json",
      (_v,list)=>submitResult(list).content=JSON.stringify({receipt_id:"other",candidate_sha256:receipt.candidate_sha256}),
      (_v,list)=>list.at(-1).type="other",(_v,list)=>list.at(-1).subtype="failed",(_v,list)=>list.at(-1).is_error=true,
    ])check(mutate)
    check((value,list)=>{
      value.custody.receipts[0].payload.candidate_sha256="f".repeat(64)
      submitResult(list).content=JSON.stringify({receipt_id:receipt.receipt_id,candidate_sha256:"f".repeat(64)})
    },"candidate_invalid")
    check((value,list)=>{
      const candidate={...fixture.candidate,results:[]},sha=catalog.catalogHash(catalog.catalogCanonical(candidate))
      Object.assign(value.custody.receipts[0].payload,{candidate,candidate_sha256:sha})
      submitUse(list).input={candidate}
      submitResult(list).content=JSON.stringify({receipt_id:receipt.receipt_id,candidate_sha256:sha})
    },"candidate_invalid")
    const strings=structuredClone(events)
    for(const event of strings)for(const item of event.message?.content??[]){
      if(item.type==="tool_result")item.content=item.content[0].text
    }
    strings.splice(1,0,{type:"assistant"},{type:"user",message:{}})
    assert.equal(custody.validateNativeSubmissionEvidence({...base,nativeStream:{...base.nativeStream,stdout:encode(strings)}}).authority,false)
    assert.throws(()=>custody.authenticatedNativeRuns([base,base]))
  })
})
test("nonaccepted_lifecycle_matrix_reuses_controller_without_real_maps_or_fds",async(t)=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const prepared=catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)})
  const snapshot=JSON.parse(prepared.snapshotBytes),launch={cwd:"/unit/nonaccepted",args:["--entry","/unit/server"],
    identity:{uid:123,euid:123,deadline:0,bootstrap:{snapshotFile:"/unit/nonaccepted/catalog.json",expectedSha256:prepared.snapshotSha256}}}
  const frame=(event,sequence,payload)=>custody.makeReceipt({event,sequence,payload,generation:snapshot.generation,
    serverPid:500001,catalogSha256:prepared.catalogSha256,briefSha256:prepared.briefSha256,key:snapshot.receipt_key})
  const frames=[frame("bootstrap",1,{snapshot_sha256:prepared.snapshotSha256,uid:123,euid:123,env_version:2,cwd:launch.cwd,
    launcher_pid:500002,module_closure:[]}),frame("submit",2,{candidate:fixture.candidate}),frame("terminal",3,{reason:"stdin_eof",final_sequence:3})]
  await assert.rejects(custody.runNonacceptedLifecycleTransaction({snapshot,launch,frames,mode:"unknown"}),{message:"unit_mode"})
  for(const mode of ["normal","abort","abortKilled","abortAbsent","deadline","source","snapshot","modules","lateModules","observe",
    "abortObserve","abortOpen","finishNormal","finishEpipe","finishOther","noReceiptEOF","serverPending","partial","noTerminal"]){
    await t.test(mode,async()=>{
      const result=await custody.runNonacceptedLifecycleTransaction({snapshot,launch,frames,mode})
      assert.equal(result.authority,false)
      assert.equal(result.statistics.actualFdOperations,0)
      assert.equal(result.statistics.actualLaunches,0)
      assert.equal(result.outcome.state,["normal","finishNormal","finishEpipe","serverPending"].includes(mode)?"closed":"failed",mode)
      if(result.outcome.custody){
        const denied=await custody.materializeTriageSubmission({custody:result.outcome.custody,nativeStream:{},brief:fixture.brief,resultFile:"/unit/must-never-open"})
        assert.equal(denied.state,"scope_unqualified","synthetic controller state never enters actual custody authority")
      }
    })
  }
  for(const [name,mutate]of [
    ["mac",x=>x.mac="f".repeat(64)],["sequence",x=>x.sequence=2],["generation",x=>x.generation="b".repeat(64)],
    ["catalog",x=>x.catalog_sha256="f".repeat(64)],["brief",x=>x.brief_sha256="f".repeat(64)],
    ["event",x=>x.event="submit"],["snapshot",x=>x.payload.snapshot_sha256="f".repeat(64)],
    ["uid",x=>x.payload.uid++],["euid",x=>x.payload.euid++],["recipe",x=>x.payload.env_version=1],["cwd",x=>x.payload.cwd="/different"],
    ["unknown",x=>x.unknown="unit"],
  ]){
    const altered=structuredClone(frames);mutate(altered[0])
    if(!["mac","unknown"].includes(name)){
      const value=altered[0]
      altered[0]=custody.makeReceipt({event:value.event,generation:value.generation,sequence:value.sequence,serverPid:value.server_pid,
        catalogSha256:value.catalog_sha256,briefSha256:value.brief_sha256,payload:value.payload,key:snapshot.receipt_key})
    }
    const result=await custody.runNonacceptedLifecycleTransaction({snapshot,launch,frames:altered,mode:"normal"})
    assert.equal(result.authority,false);assert.equal(result.outcome.state,"failed",name)
  }
  for(const payload of [{reason:"wrong",final_sequence:3},{reason:"stdin_eof",final_sequence:9}]){
    const altered=[...frames.slice(0,2),frame("terminal",3,payload)]
    assert.equal((await custody.runNonacceptedLifecycleTransaction({snapshot,launch,frames:altered,mode:"normal"})).outcome.state,"failed")
  }
})
test("nonaccepted_native_io_matrix_keeps_actual_registry_and_spawn_unreachable",async(t)=>{
  await assert.rejects(custody.runNonacceptedNativeTransaction({mode:"unknown"}),{message:"unit_mode"})
  for(const mode of ["normal","lateClose","noCost","emptyLines","stderrSmall","prepareChanged","statDev","statIno","statHash",
    "lifecycleThrows","spawnThrows","pidUnknown","outputLimit","badUTF8","badJSON","resultFailure","stderrLimit","childError",
    "closeBadUTF8","softTimeout","hardTimeout","noClose","timerAfterClose","noSuccess","nonzeroExit","signalExit","preparedFinal",
    "materializeRefused","completeThrows","abortStuck","finishReject"]){
    await t.test(mode,async()=>{
      const result=await custody.runNonacceptedNativeTransaction({mode})
      assert.equal(result.authority,false)
      assert.equal(result.statistics.actualLaunches,0)
      assert.equal(result.statistics.actualFileOperations,0)
      assert.equal(result.outcome.state,["normal","lateClose","noCost","emptyLines","stderrSmall"].includes(mode)?"ran":
        mode==="materializeRefused"?"scope_unqualified":result.outcome.state,mode)
      if(!["normal","lateClose","noCost","emptyLines","stderrSmall"].includes(mode))assert.notEqual(result.outcome.state,"ran",mode)
      assert.throws(()=>custody.authenticatedNativeRuns([result.outcome,result.outcome]))
    })
  }
})
test("sdk_client_binding_and_run_preparation_failures_are_observed",async(t)=>{
  assert.equal(typeof custody.boundClient,"function")
  assert.equal(typeof custody.CatalogClient,"function")
  const child=new EventEmitter(),history=[]
  Object.assign(child,{stdout:new PassThrough(),stdin:new PassThrough()})
  const transport=custody.boundClient(child,history),errors=[],messages=[]
  transport.onmessage=value=>messages.push(value)
  transport.onerror=e=>errors.push(e)
  let closed=0
  transport.onclose=()=>closed++
  await transport.start()
  child.stdout.write(serializeMessage(deserializeMessage('{"jsonrpc":"2.0","id":1,"result":{}}')))
  assert.equal(messages.length,1)
  child.stdout.write("{\n")
  child.stdout.emit("error",Error("unit_stream_error"))
  child.emit("close",0)
  assert.equal(errors.length,2);assert.equal(closed,1)
  await transport.send({jsonrpc:"2.0",id:2,method:"ping"})
  const write=child.stdin.write
  child.stdin.write=(_wire,callback)=>{callback(Error("unit_write_failed"));return false}
  await assert.rejects(transport.send({jsonrpc:"2.0",id:3,method:"ping"}),{message:"unit_write_failed"})
  child.stdin.write=write;await transport.close()
  const missing=new EventEmitter();Object.assign(missing,{stdout:new PassThrough(),stdin:new PassThrough()})
  const quiet=custody.boundClient(missing,[])
  await quiet.start();missing.stdout.write("{\n");missing.stdout.emit("error",Error("ignored"));missing.emit("close",0)
  missing.stdin.destroy();missing.stdout.destroy();child.stdin.destroy();child.stdout.destroy()
  const request=Client.prototype.request,received=[]
  Client.prototype.request=async value=>{received.push(value);return {}}
  try{
    const client=new custody.CatalogClient({name:"isolated_unit",version:"1"},{capabilities:{}})
    await client.request({method:"initialize",params:{protocolVersion:"wrong"}},{},{})
    await client.request({method:"ping"},{},{})
    assert.equal(received[0].params.protocolVersion,"2025-06-18")
    assert.equal(received[1].method,"ping")
  }finally{Client.prototype.request=request}
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"unit-prepare-failure-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const inputDir=path.join(dir,"input");fs.mkdirSync(inputDir,{mode:0o700})
  await catalog.writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  for(const deadline of [NaN,Date.now()])await assert.rejects(custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline}),{message:"run_deadline"})
  const actual=fs.promises.realpath
  let rootReads=0
  fs.promises.realpath=async file=>{
    if(file===dir&&++rootReads>1)return file+".unit-alias"
    return actual(file)
  }
  try{await assert.rejects(custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline:Date.now()+5000}),{message:"run_parent"})}
  finally{fs.promises.realpath=actual}
  const hooks=moduleBuiltin.registerHooks
  try{
    moduleBuiltin.registerHooks=undefined;syncBuiltinESMExports()
    const held=await custody.runDirectCatalog({fixture,deadline:Date.now()+5000})
    assert.equal(held.reason,"runtime_provenance_unsupported");await held.cleanup()
    await assert.rejects(custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline:Date.now()+5000}),{message:"runtime_provenance_unsupported"})
  }finally{moduleBuiltin.registerHooks=hooks;syncBuiltinESMExports()}
})
test("prepared_reader_is_closed_if_uid_drifts_before_launch_construction",async(t)=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"unit-uid-drift-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const inputDir=path.join(dir,"input");fs.mkdirSync(inputDir,{mode:0o700})
  await catalog.writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  const open=fs.promises.open,getuid=process.getuid,uid=getuid()
  let reader
  fs.promises.open=async(file,...args)=>{
    const handle=await open(file,...args)
    if(file===path.join(dir,"run","receipt.fifo")){reader=handle;process.getuid=()=>uid+1}
    return handle
  }
  try{
    await assert.rejects(custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline:Date.now()+5000}),{message:"environment_identity"})
    assert.equal(reader.fd,-1,"a failed post-open launch identity must not leak the owned receipt reader")
  }finally{process.getuid=getuid;fs.promises.open=open;await reader?.close()}
})
test("actual_nonmodel_missing_executable_is_closed_without_unhandled_spawn_error",async(t)=>{
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"unit-spawn-enoent-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const inputDir=path.join(dir,"input");fs.mkdirSync(inputDir,{mode:0o700})
  await catalog.writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  const deadline=Date.now()+2500,owned=await custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline})
  const errors=[]
  let unknownKillAttempts=0
  const observedSpawn=(...args)=>{
    const child=spawn(...args)
    child.once("error",e=>errors.push({code:e.code,coreErrorListeners:child.listenerCount("error")}))
    const kill=child.kill.bind(child)
    child.kill=signal=>{
      if(!Number.isSafeInteger(child.pid)||child.pid<=0){unknownKillAttempts++;return false}
      return kill(signal)
    }
    return child
  }
  const result=await custody.runOwnedCatalogNative({owned,command:path.join(dir,"never-created-executable"),args:[],
    env:{LANG:"C",LC_ALL:"C",TZ:"UTC"},deadline,resultFile:path.join(dir,"unaccepted.json"),spawn:observedSpawn})
  assert.equal(result.state,"scope_unqualified")
  assert.equal(errors[0].code,"ENOENT")
  assert.equal(unknownKillAttempts,0,"never signal a failed spawn handle whose PID is unowned/zero")
  assert.ok(errors[0].coreErrorListeners>0,"the shared source must register its error observer before inspecting pid")
  assert.equal(result.resources.native_exit.stdio_closed,true)
  assert.deepEqual(result.resources.pids,[])
  assert.deepEqual(result.resources.exited_pids,[])
  assert.equal(fs.existsSync(path.join(dir,"unaccepted.json")),false)
})
test("nonaccepted_direct_bundle_registry_rejects_mutation_and_never_promotes",()=>{
  const unit=custody.createNonacceptedDirectRegistry({fixture})
  assert.equal(unit.authority,false)
  const first=unit.complete(),second=unit.complete({receipt:unit.second})
  assert.equal(first.authority,false);assert.equal(second.authority,false)
  assert.deepEqual(unit.authenticate([first.record,second.record]),{authority:false,valid:true})
  assert.throws(()=>custody.authenticatedDirectReceipts([first.record,second.record]),{message:"direct_receipts_untrusted"})
  assert.equal(unit.retain().authority,false)
  for(const value of [null,[],[first.record],[first.record,first.record],[first.record,structuredClone(second.record)]]){
    assert.throws(()=>unit.authenticate(value))
  }
  assert.throws(()=>unit.retain({state:"failed"}))
  assert.throws(()=>unit.retain(structuredClone(unit.receipt)))
  for(const options of [{receipt:{}},{partial:{}},{cases:[]},
    {cases:unit.cases.map((item,i)=>i?item:{...item,name:"wrong"})},
    {cases:unit.cases.map((item,i)=>i?item:{...item,proof:structuredClone(item.proof)})}]){
    assert.throws(()=>unit.complete(options))
  }
  const late=(property,wrong,target)=>{
    const original=target[property];let reads=0
    Object.defineProperty(target,property,{configurable:true,enumerable:true,get:()=>++reads===1?original:wrong})
    return ()=>Object.defineProperty(target,property,{configurable:true,enumerable:true,writable:true,value:original})
  }
  for(const [property,wrong]of [["descriptorSha256","f".repeat(64)],["state","failed"]]){
    const restore=late(property,wrong,unit.cases[0].proof)
    try{assert.throws(()=>unit.complete(),{message:"direct_cases_incomplete"})}finally{restore()}
  }
  for(const change of [
    {...unit.partial.custody,receipts:[{}, {payload:{refused:[],candidate:fixture.histories.partial.candidate}}]},
    {...unit.partial.custody,receipts:[{}, {payload:{refused:[{index:1}],candidate:{wrong:true}}}]},
  ]){
    const restore=late("custody",change,unit.partial)
    try{assert.throws(()=>unit.complete(),{message:"direct_partial"})}finally{restore()}
  }
  assert.throws(()=>unit.authenticate([unit.receipt,unit.second]),{message:"direct_bundles_incomplete"})
})
test("bootstrap_bindings_and_truncated_snapshot_fail_before_application",async(t)=>{
  assert.throws(()=>custody.ownedCatalogEnvironment({platform:"unknown",uid:123,euid:123}),{message:"environment_platform"})
  for(const change of [{expectedSha256:"bad"},{generation:"bad"},{deadline:NaN}]){
    await assert.rejects(custody.openCatalogBootstrap({snapshotFile:"/unit/catalog.json",receiptFifo:"/unit/receipt.fifo",readyFifo:"/unit/control.fifo",
      generation:"a".repeat(64),expectedSha256:"b".repeat(64),deadline:Date.now()+5000,...change}),{message:"bootstrap_invalid"})
  }
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"unit-bindings-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const bootstrap={snapshotFile:path.join(dir,"catalog.json"),receiptFifo:path.join(dir,"receipt.fifo"),readyFifo:path.join(dir,"control.fifo"),
    generation:"a".repeat(64),expectedSha256:"b".repeat(64)}
  for(const field of ["snapshotFile","receiptFifo","readyFifo"]){
    await assert.rejects(custody.openCatalogBootstrap({...bootstrap,[field]:path.join(dir,"wrong"),deadline:Date.now()+5000}),{message:"bootstrap_paths"})
  }
  const source={runtime:fs.realpathSync(process.execPath),launcher:new URL("../../../../../plugins/desk/mcp/scripts/launch-triage-catalog.js",import.meta.url).pathname,
    entry:new URL("../../../../../plugins/desk/mcp/scripts/triage-catalog-server.js",import.meta.url).pathname}
  for(const field of ["runtime","launcher","entry"])assert.throws(()=>custody.ownedServerLaunch({...source,[field]:"/unit/wrong",bootstrap,deadline:Date.now()+5000}),{message:"launch_source"})
  const platform=Object.getOwnPropertyDescriptor(process,"platform")
  try{
    Object.defineProperty(process,"platform",{...platform,value:"linux"})
    const launch=custody.ownedServerLaunch({...source,bootstrap,deadline:Date.now()+5000})
    assert.equal(launch.args.some(x=>x.startsWith("__CF_USER_TEXT_ENCODING=")),false)
    assert.deepEqual(launch.identity.cleanEnv,{LANG:"C",LC_ALL:"C",TZ:"UTC"})
  }finally{Object.defineProperty(process,"platform",platform)}
  const originalRead=fs.read,{promisify}=await import("node:util")
  fs.read=function(){}
  fs.read[promisify.custom]=async()=>({bytesRead:0})
  let module
  try{module=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js?unit-truncated-snapshot")}
  finally{fs.read=originalRead}
  const file=path.join(dir,"snapshot");fs.writeFileSync(file,"{}",{mode:0o600})
  const fd=fs.openSync(file,fs.constants.O_RDONLY)
  await assert.rejects(module.loadCatalogSnapshot({fd}),{message:"snapshot_truncated"})
  assert.throws(()=>fs.fstatSync(fd),{code:"EBADF"})
})
test("actual_direct_driver_error_and_corrupted_peer_batches_close_owned_resources",async(t)=>{
  const originalSpawn=childProcess.spawn,originalRead=fs.promises.readFile
  for(const driver of ["wire","direct"]){
    for(const mode of ["invalid_fixture","snapshot_read","spawn_throw","child_error","stderr_small","stderr_limit",
      ...(driver==="wire"?["output_limit","response_invalid","normal_exit"]:["retry_changed","response_error","prepared_changed"])]){
      await t.test(`${driver}_${mode}`,async()=>{
        let child,timer,toolCalls=0
        const processKill=process.kill
        if(driver==="wire"&&mode==="normal_exit")process.kill=(pid,signal)=>{
          if(signal===0&&pid!==child?.pid)return true
          return processKill(pid,signal)
        }
        const read=fs.promises.readFile
        if(mode==="snapshot_read")fs.promises.readFile=async(file,...args)=>path.basename(String(file))==="catalog.json"?Buffer.from("{"):read(file,...args)
        childProcess.spawn=(command,...args)=>{
          if(command!=="/usr/bin/env")return originalSpawn(command,...args)
          if(mode==="spawn_throw")throw Error("unit_spawn_failed")
          child=originalSpawn(command,...args)
          if(mode==="child_error")child.once("error",()=>{})
          if(["child_error","stderr_small","stderr_limit","output_limit","response_invalid"].includes(mode)){
            timer=setTimeout(()=>{
              if(child.exitCode!==null)return
              if(mode==="child_error")child.emit("error",Error("unit_child_error"))
              if(mode==="stderr_small")child.stderr.emit("data",Buffer.from("unit-bounded-stderr"))
              if(driver==="wire"&&mode==="stderr_small")child.stdin.emit("error",Object.assign(Error("unit_pipe"),{code:"EPIPE"}))
              if(mode==="stderr_limit")child.stderr.emit("data",Buffer.alloc(65537,120))
              if(mode==="output_limit")child.stdout.emit("data",Buffer.alloc(16777217,120))
              if(mode==="response_invalid")child.stdout.emit("data",Buffer.from("{\n"))
            },150)
          }
          return child
        };syncBuiltinESMExports()
        const call=Client.prototype.callTool
        let preparedChange=false
        Client.prototype.callTool=async function(request,...args){
          const response=await call.call(this,request,...args)
          if(request.name==="candidate_submit"&&JSON.stringify(request.arguments?.candidate)===JSON.stringify(fixture.candidate)&&++toolCalls===2&&mode==="retry_changed")return {...response,unit_changed:true}
          if(mode==="response_error"&&request.name==="evidence_list")return {...response,isError:true}
          if(mode==="prepared_changed"&&request.name==="candidate_submit"&&toolCalls>=2&&!preparedChange){
            preparedChange=true
            const argv=child.spawnargs,snapshot=argv[argv.indexOf("--snapshot")+1]
            const file=path.join(path.dirname(path.dirname(snapshot)),"input","triage-prepared.json")
            // A valid different prepared file is the ordinary verifyPrepared
            // false branch, not a malformed reader exception.
            const bytes=fs.readFileSync(file),value=JSON.parse(bytes)
            value.records[1].text+=" unit changed"
            const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
            fs.writeFileSync(file,catalog.catalogCanonical(value))
          }
          return response
        }
        let result
        try{
          if(driver==="wire")result=await custody.runCatalogWireCase({fixture:mode==="invalid_fixture"?null:fixture,
            frames:mode==="normal_exit"?[{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"unit",version:"1"}}}]:["{\n"],deadline:Date.now()+5000})
          else result=await custody.runDirectCatalog({fixture:mode==="invalid_fixture"?null:fixture,deadline:Date.now()+8000})
          if(mode==="stderr_small")assert.equal(result.state,driver==="wire"?"refused":"proved")
          else if(mode==="normal_exit")assert.equal(result.state,"failed","normal no-submit EOF is not a fatal refusal proof")
          else assert.notEqual(result.state,driver==="wire"?"refused":"proved",`${driver}_${mode}`)
        }finally{
          clearTimeout(timer);childProcess.spawn=originalSpawn;syncBuiltinESMExports()
          Client.prototype.callTool=call;fs.promises.readFile=originalRead
          await result?.cleanup()
          process.kill=processKill
        }
      })
    }
  }
})
test("darwin_encoding_constructed_before_each_node",()=>{
  const expected={version:2,env:{LANG:"C",LC_ALL:"C",TZ:"UTC",__CF_USER_TEXT_ENCODING:"0x1FA:0:0"},encodingValue:"0x1FA:0:0"}
  assert.deepEqual(custody.ownedCatalogEnvironment({platform:"darwin",uid:506,euid:506}),expected)
  assert.equal(custody.validateOwnedCatalogEnvironment({platform:"darwin",uid:506,euid:506,env:expected.env,expected}).ok,true)
})
test("darwin_encoding_invalid_or_identity_drift_blocks",()=>{
  const expected=custody.ownedCatalogEnvironment({platform:"darwin",uid:506,euid:506})
  for(const value of [undefined,"0x1fa:0:0","0x01FA:0:0","0x1FA:0x0:0x0","0x1FA:1:0","0x1FA:0:1","0x1FA:0:0 ","+506:0:0","0x1FB:0:0"]){
    const env={...expected.env};if(value===undefined)delete env.__CF_USER_TEXT_ENCODING;else env.__CF_USER_TEXT_ENCODING=value
    assert.equal(custody.validateOwnedCatalogEnvironment({platform:"darwin",uid:506,euid:506,env,expected}).ok,false)
  }
  for(const [uid,euid] of [[506,507],[-1,-1],[NaN,NaN],[4294967296,4294967296],[undefined,undefined]]){
    assert.throws(()=>custody.ownedCatalogEnvironment({platform:"darwin",uid,euid}))
  }
  assert.equal(custody.validateOwnedCatalogEnvironment({platform:"darwin",uid:507,euid:507,env:expected.env,expected}).ok,false)
  assert.equal(custody.validateOwnedCatalogEnvironment({platform:"darwin",uid:506,euid:506,env:{...expected.env,HOME:"/synthetic"},expected}).ok,false)
})
test("inherited_cf_poison_is_not_authority",()=>{
  const before=process.env.__CF_USER_TEXT_ENCODING
  process.env.__CF_USER_TEXT_ENCODING="synthetic_poison_not_a_credential"
  try {assert.equal(custody.ownedCatalogEnvironment({platform:"darwin",uid:506,euid:506}).env.__CF_USER_TEXT_ENCODING,"0x1FA:0:0")}
  finally {if(before===undefined)delete process.env.__CF_USER_TEXT_ENCODING;else process.env.__CF_USER_TEXT_ENCODING=before}
})
test("non_darwin_environment_remains_three_fields",()=>{
  const expected=custody.ownedCatalogEnvironment({platform:"linux",uid:506,euid:506})
  assert.deepEqual(expected,{version:2,env:{LANG:"C",LC_ALL:"C",TZ:"UTC"}})
  assert.equal(custody.validateOwnedCatalogEnvironment({platform:"linux",uid:506,euid:506,env:{...expected.env,__CF_USER_TEXT_ENCODING:"0x1FA:0:0"},expected}).ok,false)
})
test("bootstrap_arguments_and_snapshot_reads_are_closed",async(t)=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"snapshot-read-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const p=catalog.prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs,generation:"a".repeat(64)})
  const file=path.join(dir,"catalog.json");fs.writeFileSync(file,p.snapshotBytes,{mode:0o600})
  for(const mutate of [
    x=>x.length=0,x=>x[0]="--unknown",x=>x[5]="bad",x=>x[7]="bad",x=>x[13]="not-integer",x=>x[13]="0",
  ]){
    const args=["--entry","/entry","--snapshot",file,"--sha256",p.snapshotSha256,"--generation","a".repeat(64),
      "--receipt-fifo","/receipt","--ready-fifo","/control","--deadline-ms",String(Date.now()+5000)]
    mutate(args);assert.throws(()=>custody.catalogBootstrapArguments(args))
  }
  const args=["--entry","/entry","--snapshot",file,"--sha256",p.snapshotSha256,"--generation","a".repeat(64),
    "--receipt-fifo","/receipt","--ready-fifo","/control","--deadline-ms",String(Date.now()+5000)]
  assert.equal(custody.catalogBootstrapArguments(args).snapshotFile,file)
  for(const [changes,error]of [[{},""],[{expectedSha256:"f".repeat(64)},"snapshot_hash"],[{generation:"b".repeat(64)},"snapshot_identity"]]){
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
    if(error)await assert.rejects(custody.loadCatalogSnapshot({fd,expectedSha256:p.snapshotSha256,generation:"a".repeat(64),...changes}),{message:error})
    else assert.equal((await custody.loadCatalogSnapshot({fd,...changes})).catalog.catalog.size,3)
    assert.throws(()=>fs.fstatSync(fd),{code:"EBADF"})
  }
  fs.chmodSync(file,0o644)
  const unsafe=fs.openSync(file,fs.constants.O_RDONLY)
  await assert.rejects(custody.loadCatalogSnapshot({fd:unsafe}),{message:"snapshot_unsafe"})
  assert.throws(()=>fs.fstatSync(unsafe),{code:"EBADF"})
})
test("fifo_partial_transient_writes_and_failure_limits_are_finite",async(t)=>{
  const originalRead=fs.read,originalWrite=fs.write
  const {promisify}=await import("node:util")
  const writes=[]
  let n=0
  let readImpl,writeImpl
  fs.write=function(){}
  fs.write[promisify.custom]=async(...args)=>writeImpl(...args)
  fs.read=function(){}
  fs.read[promisify.custom]=async(...args)=>readImpl(...args)
  const unit=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js?isolated-fifo-unit")
  writeImpl=async(fd,buffer,offset,length)=>{
    n++
    if(n===1)throw Object.assign(Error("retry"),{code:"EAGAIN"})
    if(n===2)return {bytesWritten:0}
    const count=Math.min(2,length);writes.push(Buffer.from(buffer.subarray(offset,offset+count)))
    return {bytesWritten:count}
  }
  try{
    await unit.boundedFdWrite(123,"abcdef",Date.now()+3000)
    assert.equal(Buffer.concat(writes).toString(),"abcdef")
    await assert.rejects(unit.boundedFdWrite(123,"x",Date.now()),{message:"fd_write_deadline"})
    writeImpl=async()=>{throw Object.assign(Error("broken"),{code:"EPIPE"})}
    await assert.rejects(unit.boundedFdWrite(123,"x",Date.now()+2000),{code:"EPIPE"})
    for(const [data,options,want]of [
      ['{"a":1}\n',{maxFrame:6,maxBytes:100,maxFrames:2},"fifo_frame_limit"],
      ['{"a":1}\n',{maxFrame:20,maxBytes:5,maxFrames:2},"fifo_total_limit"],
      ['{"a":1}\n{"a":2}\n',{maxFrame:20,maxBytes:100,maxFrames:1},"fifo_count_limit"],
      ['{"b":1,"a":2}\n',{maxFrame:20,maxBytes:100,maxFrames:2},"fifo_noncanonical"],
      [Buffer.from([0xff,10]),{maxFrame:20,maxBytes:100,maxFrames:2},null],
    ]){
      let used=false,failure
      readImpl=async(fd,buffer,offset)=>{
        if(used)return {bytesRead:0}
        used=true;Buffer.from(data).copy(buffer,offset);return {bytesRead:Buffer.byteLength(data)}
      }
      const pump=unit.fifoPump({fd:123,deadline:Date.now()+2000,...options,onFrame:()=>{},onFailure:error=>{failure=error}})
      await pump.done
      assert.ok(failure);if(want)assert.equal(failure.message,want)
      await pump.stop()
    }
    let attempt=0,seen
    readImpl=async(fd,buffer)=>{
      attempt++
      if(attempt===1)throw Object.assign(Error("retry"),{code:"EINTR"})
      if(attempt===2)return {bytesRead:0}
      if(attempt===3){Buffer.from('{"a":1}\n').copy(buffer);return {bytesRead:8}}
      return {bytesRead:0}
    }
    const pump=unit.fifoPump({fd:123,deadline:Date.now()+2000,maxFrame:20,maxBytes:100,maxFrames:2,onFrame:value=>{seen=value},onFailure:error=>{throw error}})
    while(!seen)await new Promise(resolve=>setTimeout(resolve,10))
    await pump.stop()
    assert.deepEqual(seen,{a:1});assert.ok(pump.status().zeroReads>=1)
  }finally{fs.read=originalRead;fs.write=originalWrite}
})
test("unsupported_runtime_provenance_holds_before_preparation",async(t)=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"runtime-capability-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const inputDir=path.join(dir,"input");fs.mkdirSync(inputDir,{mode:0o700})
  await catalog.writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  const original=moduleBuiltin.registerHooks
  try{
    // Only the builtin capability is absent, as on Node20. No runtime install,
    // loader/config mutation or weakened source observation is performed.
    moduleBuiltin.registerHooks=undefined;syncBuiltinESMExports()
    await assert.rejects(custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline:Date.now()+5000}),
      {message:"runtime_provenance_unsupported"})
    assert.equal(fs.existsSync(path.join(dir,"run")),false)
  }finally{moduleBuiltin.registerHooks=original;syncBuiltinESMExports()}
})
test("receipt_reader_before_writer_does_not_block",async(t)=>{
  const run=await custody.runDirectCatalog({fixture,deadline:Date.now()+15000})
  t.after(()=>run.cleanup?.())
  assert.equal(run.state,"proved")
  assert.equal(run.resources.initialReceiptZeroRead,true)
  assert.equal(run.resources.fdsClosed,true)
  assert.equal(run.resources.launcherExit,0)
  assert.equal(run.resources.serverExited,true)
  assert.ok(run.custody.moduleClosure.length>10)
  assert.equal(run.custody.moduleClosure.every(x=>/^[a-f0-9]{64}$/.test(x.sha256)),true)
  assert.equal(run.custody.observation.ok,true)
  assert.equal(run.custody.sourceCustodyUnchanged,true)
  assert.ok(run.resources.files.every(file=>fs.existsSync(file)),"inventory lists actual opened generation paths")
})
test("authentic_receipt_only",async(t)=>{
  const run=await custody.runDirectCatalog({fixture,deadline:Date.now()+15000})
  t.after(()=>run.cleanup?.())
  assert.equal(run.state,"proved")
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"unaccepted-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const file=path.join(dir,"result.json")
  const fake={...run.custody,receipts:structuredClone(run.custody.receipts)}
  fake.receipts[1].mac="a".repeat(64)
  const denied=await custody.materializeTriageSubmission({custody:fake,nativeStream:run.nativeStream,brief:fixture.brief,resultFile:file})
  assert.notEqual(denied.state,"ran");assert.equal(fs.existsSync(file),false)
})
test("restored_source_module_and_process_identity_drift_refuses",async(t)=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"direct-drift-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const run=await custody.runDirectCatalog({fixture,deadline:Date.now()+10000,evidenceDir:path.join(dir,"archive")})
  t.after(()=>run.cleanup?.())
  assert.equal(run.state,"proved")
  const record=custody.retainDirectReceipt(run)
  assert.equal(await custody.restoreDirectReceipt(structuredClone(record)),true)
  for(const mutate of [
    x=>x.custody.observation.ok=false,
    x=>x.custody.observation.identity.server.pid++,
    x=>x.custody.observation.identity.server.ppid++,
    x=>x.custody.observation.identity.server.command+=" --unexpected",
    x=>x.custody.observation.identity.launch.command+=" --unexpected",
    x=>x.custody.observation.identity.server.start="unknown",
    x=>x.custody.observation.identity.environment_sha256="f".repeat(64),
    x=>x.custody.moduleClosure=[],
    x=>x.custody.moduleClosure[0].sha256="bad",
    x=>x.custody.moduleClosure[0].sha256="f".repeat(64),
    x=>x.custody.moduleClosure[0].bytes++,
    x=>x.custody.moduleClosure.push({...x.custody.moduleClosure[0]}),
    x=>x.custody.sourceIdentity.files.extra="mutated",
    x=>x.custody.receipts[0].generation="f".repeat(64),
    x=>x.custody.receipts[2].payload.reason="unknown",
  ]){
    const changed=structuredClone(record);mutate(changed)
    await assert.rejects(custody.restoreDirectReceipt(changed))
  }
})
test("bootstrap_substitution_blocks",async()=>{
  await assert.rejects(custody.openCatalogBootstrap({snapshotFile:"/synthetic/missing",expectedSha256:"a".repeat(64),
    generation:"a".repeat(64),receiptFifo:"/synthetic/receipt",readyFifo:"/synthetic/ready",deadline:Date.now()+2000}))
})
test("every_startup_phase_timeout_closes_owned_fds",async(t)=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"bootstrap-phases-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const inputDir=path.join(dir,"input");fs.mkdirSync(inputDir,{mode:0o700})
  await catalog.writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  for(const phase of ["missing_receipt_reader","replaced_control","missing_snapshot"]){
    const deadline=Date.now()+2500,owned=await custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,phase),deadline})
    const opened=[],original=fs.promises.open
    let replaced=false
    if(phase==="missing_receipt_reader")await owned.close()
    if(phase==="missing_snapshot")fs.unlinkSync(owned.launch.identity.bootstrap.snapshotFile)
    fs.promises.open=async function(file,...args){
      if(phase==="replaced_control"&&!replaced&&file===owned.launch.identity.bootstrap.readyFifo){
        replaced=true
        fs.renameSync(file,file+".original")
        const mkfifo=(await import("node:child_process")).spawnSync("/usr/bin/mkfifo",["-m","600",file],{env:{LANG:"C",LC_ALL:"C",TZ:"UTC"}})
        assert.equal(mkfifo.status,0)
      }
      const handle=await original.call(this,file,...args);opened.push(handle);return handle
    }
    try{
      await assert.rejects(custody.openCatalogBootstrap({...owned.launch.identity.bootstrap,deadline}))
      assert.ok(Date.now()<deadline)
      assert.ok(opened.every(handle=>handle.fd===-1),"all partially acquired descriptors closed")
    }finally{fs.promises.open=original;await owned.close()}
  }
})
test("stopped_launcher_deadline_reaps_owned_generation",async(t)=>{
  const original=childProcess.spawn
  let ownedChild,closed=false
  childProcess.spawn=function(command,...args){
    const child=original.call(this,command,...args)
    if(command==="/usr/bin/env"){
      ownedChild=child;child.once("close",()=>{closed=true});child.kill("SIGSTOP")
    }
    return child
  };syncBuiltinESMExports()
  const deadline=Date.now()+2500
  let run
  try{run=await custody.runDirectCatalog({fixture,deadline})}
  finally{childProcess.spawn=original;syncBuiltinESMExports()}
  t.after(async()=>{
    if(ownedChild&&!closed){
      ownedChild.kill("SIGCONT");ownedChild.kill("SIGKILL")
      await new Promise(resolve=>ownedChild.once("close",resolve))
    }
    await run?.cleanup?.()
  })
  assert.equal(run.state,"failed")
  assert.equal(closed,true,"return only after the stopped generation is reaped")
  assert.ok(Date.now()<=deadline+300)
})
test("stopped_server_after_observation_is_reaped_under_inherited_deadline",async(t)=>{
    const original=childProcess.spawn
    let stoppedServer
    childProcess.spawn=function(command,args,...rest){
      if(command==="/bin/ps"&&args[0]==="eww"&&stoppedServer===undefined){
        // This ID comes from the production controller's actual owned bootstrap
        // followed by its live PID/PPID/command observations, not a name scan.
        stoppedServer=Number(args[args.indexOf("-p")+1]);process.kill(stoppedServer,"SIGSTOP")
      }
      return original.call(this,command,args,...rest)
    };syncBuiltinESMExports()
    const deadline=Date.now()+3000
    let run
    try{run=await custody.runDirectCatalog({fixture,deadline})}
    finally{childProcess.spawn=original;syncBuiltinESMExports()}
    t.after(async()=>{
      if(stoppedServer!==undefined){
        try{process.kill(stoppedServer,"SIGCONT");process.kill(stoppedServer,"SIGKILL")}catch(error){if(error.code!=="ESRCH")throw error}
      }
      await run?.cleanup?.()
    })
    assert.ok(Number.isSafeInteger(stoppedServer))
    assert.equal(run.state,"failed")
    assert.throws(()=>process.kill(stoppedServer,0),{code:"ESRCH"})
    assert.ok(Date.now()<=deadline+300)
})
test("ready_open_order_and_early_eof",async(t)=>{
  const {spawn}=await import("node:child_process")
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"ready-order-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const inputDir=path.join(dir,"input");fs.mkdirSync(inputDir,{mode:0o700})
  await catalog.writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  const deadline=Date.now()+5000,owned=await custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline})
  const child=spawn(owned.launch.command,owned.launch.args,{env:{},cwd:owned.runDir,stdio:["pipe","pipe","pipe"]})
  const chunks=[];child.stdout.on("data",x=>chunks.push(x));child.stderr.resume()
  const closed=new Promise(resolve=>child.on("close",(code,signal)=>resolve({code,signal})))
  // The parent control writer is deliberately missing: actual receipt bootstrap
  // may fill the private lane, but native MCP input EOF before ready is fatal.
  child.stdin.end()
  const exit=await closed
  await owned.close()
  assert.equal(exit.code,1)
  assert.equal(Buffer.concat(chunks).length,0)
  assert.ok(Date.now()<deadline-2000,"startup EOF must not wait for deadline")
  assert.throws(()=>process.kill(child.pid,0),{code:"ESRCH"})
})
test("large_submit_receipt_backpressure",async(t)=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"large-receipt-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const brief=structuredClone(fixture.brief),records=[],refs=[],candidate=structuredClone(fixture.candidate)
  brief.cards=[];candidate.results=[]
  for(let i=0;i<20;i++){
    const ref=`evidence-${i}`,card={key:`card-${i}`,basis:`basis-${i}`,evidence_ids:[ref],ruling_ids:[],authority_codes:["investigation_only"]}
    brief.cards.push(card)
    records.push({id:`r${String(i+1).padStart(6,"0")}`,kind:"card",revision:1,text:"Synthetic bounded card."})
    candidate.results.push({...structuredClone(fixture.candidate.results[0]),key:card.key,basis:card.basis,evidence:[ref],
      unknowns:Array.from({length:12},(_,j)=>`Unknown ${j}: `+"x".repeat(900))})
  }
  for(let i=0;i<20;i++){
    const id=`r${String(i+21).padStart(6,"0")}`
    records.push({id,kind:"evidence",revision:1,text:"Synthetic needle evidence."});refs.push({ref:`evidence-${i}`,id})
  }
  const inputDir=path.join(dir,"input");fs.mkdirSync(inputDir,{mode:0o700})
  await catalog.writeTriagePreparedFile({inputDir,brief,records,recordRefs:refs})
  const deadline=Date.now()+12000,owned=await custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline})
  const child=spawn(owned.launch.command,owned.launch.args,{env:{},cwd:owned.runDir,stdio:["pipe","pipe","pipe"]})
  child.stderr.resume();child.stdin.on("error",()=>{})
  const closed=new Promise(resolve=>child.on("close",(code,signal)=>resolve({code,signal})))
  let pump,control,serverPid,failure,connected
  const boot=new Promise(resolve=>{connected=resolve})
  const receipts=[],startPump=()=>custody.fifoPump({fd:owned.reader.handle.fd,deadline,maxFrame:393216,maxBytes:2097152,maxFrames:4,
    onFailure:error=>{failure=error},
    async onFrame(value){
      receipts.push(value)
      if(value.event==="bootstrap"){
        serverPid=value.server_pid
        control=fs.openSync(path.join(owned.runDir,"control.fifo"),fs.constants.O_WRONLY|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW)
        await custody.boundedFdWrite(control,catalog.catalogCanonical({event:"ready",generation:owned.generation,server_pid:serverPid})+"\n",deadline)
        connected()
      }
    }})
  pump=startPump()
  t.after(async()=>{
    child.kill("SIGCONT");child.kill("SIGTERM")
    await pump?.stop();if(control!==undefined)fs.closeSync(control);await owned.close()
  })
  await boot
  const buffer=new ReadBuffer(),transport={
    async start(){child.stdout.on("data",chunk=>{buffer.append(chunk);let message;while((message=buffer.readMessage())!==null)this.onmessage?.(message)});child.on("close",()=>this.onclose?.())},
    async send(message){await new Promise((resolve,reject)=>child.stdin.write(serializeMessage(deserializeMessage(serializeMessage(message).trimEnd())),error=>error?reject(error):resolve()))},
    async close(){child.stdin.end()},
  }
  class FixedClient extends Client{request(value,schema,options){if(value.method==="initialize")value={...value,params:{...value.params,protocolVersion:"2025-06-18"}};return super.request(value,schema,options)}}
  const client=new FixedClient({name:"triage_direct",version:"1"},{capabilities:{}})
  await client.connect(transport)
  await pump.stop()
  let responded=false
  const submitting=client.callTool({name:"candidate_submit",arguments:{candidate}}).then(value=>{responded=true;return value})
  await new Promise(resolve=>setTimeout(resolve,150))
  assert.equal(responded,false,"success cannot precede full private receipt drainage")
  assert.ok(Buffer.byteLength(catalog.catalogCanonical(candidate))>200000)
  pump=startPump()
  const response=await submitting
  assert.equal(response.isError,undefined)
  assert.equal(response.structuredContent.valid_count,20)
  await custody.boundedFdWrite(control,catalog.catalogCanonical({event:"finish",generation:owned.generation,server_pid:serverPid})+"\n",deadline)
  await client.close()
  const exit=await closed
  while(receipts.length<3&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(failure,undefined)
  assert.equal(exit.code,0)
  assert.deepEqual(receipts.map(value=>value.event),["bootstrap","submit","terminal"])
  assert.deepEqual(receipts.map(value=>value.sequence),[1,2,3])
  assert.equal(receipts[1].payload.candidate.results.length,20)
  assert.throws(()=>process.kill(serverPid,0),{code:"ESRCH"})
})
test("per_run_catalog_not_synthetic_freeze",async(t)=>{
  assert.equal(typeof custody.prepareOwnedCatalogRun,"function")
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"owned-prepared-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const a=path.join(dir,"a"),b=path.join(dir,"b");fs.mkdirSync(a,{mode:0o700});fs.mkdirSync(b,{mode:0o700})
  const inputs=structuredClone(fixture.record_inputs);inputs[0].text="A newly authorized prepared brief, not the synthetic freeze."
  await catalog.writeTriagePreparedFile({inputDir:a,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  await catalog.writeTriagePreparedFile({inputDir:b,brief:fixture.brief,records:inputs,recordRefs:fixture.record_refs})
  const x=await custody.prepareOwnedCatalogRun({inputDir:a,runDir:path.join(dir,"run-a"),deadline:Date.now()+15000})
  const y=await custody.prepareOwnedCatalogRun({inputDir:b,runDir:path.join(dir,"run-b"),deadline:Date.now()+15000})
  await x.close();await y.close()
  assert.notEqual(x.catalog.catalogSha256,y.catalog.catalogSha256)
  assert.equal(x.catalog.formatFingerprint,y.catalog.formatFingerprint)
  assert.equal(x.launch.identity.envRecipe.version,2)
})
test("native_server_not_a_separate_hash",async()=>{
  assert.equal(typeof custody.runOwnedCatalogNative,"function")
})
test("missing_bootstrap_reaps_native_before_return",async(t)=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"missing-bootstrap-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const inputDir=path.join(dir,"input");fs.mkdirSync(inputDir,{mode:0o700})
  await catalog.writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  const deadline=Date.now()+2500,owned=await custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline})
  const resultFile=path.join(dir,"unaccepted.json")
  const run=await custody.runOwnedCatalogNative({owned,command:process.execPath,args:["-e","setInterval(()=>{},100)"],
    env:{LANG:"C",LC_ALL:"C",TZ:"UTC"},deadline,resultFile})
  assert.notEqual(run.state,"ran")
  assert.equal(fs.existsSync(resultFile),false)
  assert.equal(run.resources.native_exit?.stdio_closed,true)
  assert.deepEqual(run.resources.exited_pids,run.resources.pids)
  assert.ok(Date.now()<=deadline+300)
})
test("bounded_native_stdout_preserves_split_utf8",async(t)=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"native-utf8-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const inputDir=path.join(dir,"input");fs.mkdirSync(inputDir,{mode:0o700})
  await catalog.writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  const deadline=Date.now()+2500,owned=await custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline})
  const script=`const bytes=Buffer.from('{"type":"result","is_error":true,"text":"🙂"}\\n');const at=bytes.indexOf(Buffer.from("🙂"));process.stdout.write(bytes.subarray(0,at+1));setTimeout(()=>{process.stdout.write(bytes.subarray(at+1));},100)`
  const run=await custody.runOwnedCatalogNative({owned,command:process.execPath,args:["-e",script],
    env:{LANG:"C",LC_ALL:"C",TZ:"UTC"},deadline,resultFile:path.join(dir,"unaccepted.json")})
  assert.notEqual(run.state,"ran")
  assert.equal(run.stream.stdout,'{"type":"result","is_error":true,"text":"🙂"}\n')
  assert.equal(fs.existsSync(path.join(dir,"unaccepted.json")),false)
})
test("failed_bootstrap_closes_late_acquired_control_handle",async(t)=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"late-control-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const inputDir=path.join(dir,"input");fs.mkdirSync(inputDir,{mode:0o700})
  await catalog.writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  const deadline=Date.now()+6000,owned=await custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline})
  const script=path.join(dir,"native-wait.mjs")
  fs.writeFileSync(script,`import {spawn} from "node:child_process";
const config=JSON.parse(process.argv[2]);const child=spawn(config.command,config.args,{env:{},cwd:config.cwd,stdio:["pipe","pipe","pipe"]});
child.stdout.resume();child.stderr.on("data",x=>process.stderr.write(x));
process.once("SIGTERM",()=>{child.kill("SIGTERM");setTimeout(()=>process.exit(1),100)});
setInterval(()=>{},100);`,{mode:0o600})
  const original=fs.promises.open
  let native,lateHandle,delayed=false
  fs.promises.open=async function(file,...args){
    const handle=await original.call(this,file,...args)
    if(file===owned.launch.identity.bootstrap.readyFifo&&!delayed){
      delayed=true;lateHandle=handle
      // Real FD acquired, but promise continuation is delayed while the actual
      // native fixture fails. This exposes acquisition/abort ordering, not a
      // fabricated permission or source-provenance success.
      native.stdout.emit("data",Buffer.from('{"type":"result","is_error":true}\n'))
      await new Promise(resolve=>setTimeout(resolve,150))
    }
    return handle
  }
  const spawning=(...args)=>{native=spawn(...args);return native}
  let run
  try{
    run=await custody.runOwnedCatalogNative({owned,command:process.execPath,args:[script,JSON.stringify(owned.launch)],
      env:{LANG:"C",LC_ALL:"C",TZ:"UTC"},deadline,resultFile:path.join(dir,"unaccepted.json"),spawn:spawning})
    await new Promise(resolve=>setTimeout(resolve,200))
    assert.equal(delayed,true,"actual control acquisition must be exercised")
    assert.notEqual(run.state,"ran")
    assert.equal(lateHandle.fd,-1,"late acquired FD must close after failed bootstrap")
  }finally{
    fs.promises.open=original
    if(lateHandle?.fd>=0)await lateHandle.close()
    if(native&&run?.resources.native_exit?.stdio_closed!==true)native.kill("SIGKILL")
  }
})
test("early_qualifier_has_no_task5_dependency",async(t)=>{
  const q=await import("../../../../../plugins/desk/mcp/scripts/qualify-triage-runner.js")
  assert.equal(typeof q.writeSyntheticTriagePreparedInput,"function")
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"early-qualifier-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const wrote=await q.writeSyntheticTriagePreparedInput({inputDir:dir,fixture})
  const raw=JSON.parse(fs.readFileSync(wrote.path))
  assert.equal(raw.schema,"desk.factory.triage-prepared/1")
  assert.deepEqual(raw.record_refs,fixture.record_refs)
})
test("two_actual_direct_bundles_are_not_native_qualification",async(t)=>{
  const q=await import("../../../../../plugins/desk/mcp/scripts/qualify-triage-runner.js")
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"direct-qualifier-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const result=await q.qualifyOwnedCatalog({fixture,deadline:Date.now()+60000,evidenceDir:path.join(dir,"evidence")})
  assert.equal(result.state,"direct_validated",JSON.stringify(result.record))
  assert.equal(result.directReceipts.length,2)
  assert.equal(result.nativeReceipts.length,0)
  assert.equal(result.record,null)
  assert.equal(result.resources.launches,0)
  for(let i=1;i<=2;i++){
    for(const [name,detail]of [["malformed-json","catalog_session_failed"],["frame-count","wire_frame_count"],
      ["aggregate","wire_input_limit"],["output","wire_output_limit"],["second-initialize","protocol_state"]]){
      const file=path.join(dir,"evidence",`direct-${i}-${name}.json`)
      assert.equal(fs.existsSync(file),true,`missing actual bundle case ${i}:${name}`)
      const sub=JSON.parse(fs.readFileSync(file))
      assert.equal(sub.state,"refused")
      assert.ok(sub.resources.stderr.includes(detail))
    }
    const partial=JSON.parse(fs.readFileSync(path.join(dir,"evidence",`direct-${i}-partial.json`)))
    assert.equal(partial.state,"proved")
    assert.deepEqual(partial.custody.receipts[1].payload.refused.map(x=>x.index),[1])
    assert.equal(partial.custody.receipts[1].payload.candidate.results.length,2)
  }
  for(const receipt of result.directReceipts){
    assert.equal(fs.existsSync(receipt.snapshotArchive),true)
    assert.equal(receipt.custody.receipts.at(-1).event,"terminal")
    assert.equal(await custody.restoreDirectReceipt(structuredClone(receipt)),true)
    for(const mutate of [
      x=>{x.historySha256="f".repeat(64)},
      x=>{x.responses=[]},
      x=>{x.tools=[]},
      x=>{x.custody.receipts[1].payload.candidate_sha256="f".repeat(64)},
    ]){
      const forged=structuredClone(receipt);mutate(forged)
      await assert.rejects(custody.restoreDirectReceipt(forged))
    }
  }
  const restored=result.directReceipts.map(receipt=>structuredClone(receipt))
  for(const receipt of restored)await custody.restoreDirectReceipt(receipt)
  assert.equal(custody.authenticatedDirectReceipts(restored),true)
  const record=result.directReceipts[0],root=path.dirname(path.dirname(record.snapshotArchive)),catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  for(const mutate of [
    x=>x.state="failed",x=>delete x.snapshotArchive,x=>x.resources.wire=[],
    x=>x.bundle.version=2,x=>x.bundle.cases=[],
    x=>x.bundle.partial.snapshotArchive=path.join(root,"wrong","catalog.json"),
    x=>x.bundle.cases[0].name="wrong",x=>x.bundle.cases[0].descriptorSha256="f".repeat(64),
    x=>x.bundle.cases[0].state="failed",x=>x.bundle.cases[0].normalTerminal=true,
    x=>x.bundle.cases[0].resources.serverExited=false,
  ]){
    const changed=structuredClone(record);mutate(changed);await assert.rejects(custody.restoreDirectReceipt(changed))
  }
  const snapshotFile=record.snapshotArchive,originalSnapshot=fs.readFileSync(snapshotFile)
  for(const bytes of [Buffer.alloc(6291457),Buffer.from(originalSnapshot+" ")]){
    fs.writeFileSync(snapshotFile,bytes)
    try{await assert.rejects(custody.restoreDirectReceipt(structuredClone(record)))}
    finally{fs.writeFileSync(snapshotFile,originalSnapshot)}
  }
  const hashDrift=structuredClone(record);hashDrift.custody.snapshotSha256="f".repeat(64)
  await assert.rejects(custody.restoreDirectReceipt(hashDrift),{message:"restored_snapshot"})
  // A coherent changed synthetic snapshot/receipt chain is still inadmissible
  // for the fixed qualification fixture; use only this test's copied bundle.
  const makeDifferentSnapshot=change=>{
    const selected=structuredClone(fixture);change(selected)
    const prepared=catalog.prepareTriageCatalog({brief:selected.brief,records:selected.record_inputs,recordRefs:selected.record_refs,generation:record.generation})
    const snapshot=JSON.parse(prepared.snapshotBytes),changed=structuredClone(record)
    changed.custody.snapshotSha256=prepared.snapshotSha256
    changed.custody.launchIdentity.identity.bootstrap.expectedSha256=prepared.snapshotSha256
    const argv=changed.custody.launchIdentity.args,idx=argv.indexOf("--sha256");argv[idx+1]=prepared.snapshotSha256
    changed.custody.observation.identity.launch.command=changed.custody.observation.identity.launch.command.replace(catalog.catalogHash(originalSnapshot),prepared.snapshotSha256)
    changed.custody.receipts=changed.custody.receipts.map((r,i)=>{
      const payload=structuredClone(r.payload)
      if(i===0)payload.snapshot_sha256=prepared.snapshotSha256
      return custody.makeReceipt({event:r.event,generation:r.generation,sequence:r.sequence,serverPid:r.server_pid,
        catalogSha256:prepared.catalogSha256,briefSha256:prepared.briefSha256,payload,key:snapshot.receipt_key})
    })
    return {changed,bytes:prepared.snapshotBytes}
  }
  for(const change of [x=>x.record_inputs[1].text+=" altered",x=>{
    x.brief.cards[0].evidence_ids=["different-ref"];x.record_refs[0].ref="different-ref"
  }]){
    const altered=makeDifferentSnapshot(change);fs.writeFileSync(snapshotFile,altered.bytes)
    try{await assert.rejects(custody.restoreDirectReceipt(altered.changed),{message:"restored_catalog"})}
    finally{fs.writeFileSync(snapshotFile,originalSnapshot)}
  }
  for(const name of ["malformed-json","output"]){
    const proofFile=path.join(root,`direct-1-${name}.json`),bytes=fs.readFileSync(proofFile),proof=JSON.parse(bytes)
    fs.writeFileSync(proofFile,catalog.catalogCanonical(proof))
    try{await assert.rejects(custody.restoreDirectReceipt(structuredClone(record)),{message:"proof_noncanonical"})}
    finally{fs.writeFileSync(proofFile,bytes)}
    const changes=[x=>x.state="failed",x=>x.descriptorSha256="f".repeat(64),x=>x.normalTerminal=true,x=>x.reason="changed",x=>x.resources.stderr="changed"]
    if(name==="output")changes.push(x=>x.resources.stdout.path=path.join(root,"wrong"),x=>x.resources.stdout.bytes++,
      x=>x.resources.stdout.bytes=16777217,x=>x.resources.stdout.sha256="f".repeat(64))
    for(const mutate of changes){
      const altered=structuredClone(proof);mutate(altered);fs.writeFileSync(proofFile,catalog.catalogCanonical(altered)+"\n")
      try{await assert.rejects(custody.restoreDirectReceipt(structuredClone(record)))}
      finally{fs.writeFileSync(proofFile,bytes)}
    }
  }
})
test("native_qualification_measurement_does_not_reach_mock_or_real_effects",async(t)=>{
  const q=await import("../../../../../plugins/desk/mcp/scripts/qualify-triage-runner.js")
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"mocked-native-qualifier-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const clientURL=new URL("../../../../../plugins/desk/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",import.meta.url).href
  const stdioURL=new URL("../../../../../plugins/desk/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js",import.meta.url).href
  const script=path.join(dir,"nonaccepted-unit-engine.mjs")
  fs.writeFileSync(script,`
import {spawn} from "node:child_process"
import {randomUUID} from "node:crypto"
import {Client} from ${JSON.stringify(clientURL)}
import {ReadBuffer,serializeMessage,deserializeMessage} from ${JSON.stringify(stdioURL)}
const entry=JSON.parse(process.argv[2]).mcpServers.triage_catalog
const child=spawn(entry.command,entry.args,{env:entry.env,cwd:entry.cwd,stdio:["pipe","pipe","pipe"]})
const ended=new Promise(resolve=>child.once("close",resolve));child.stderr.on("data",x=>process.stderr.write(x))
const buffer=new ReadBuffer(),transport={async start(){child.stdout.on("data",chunk=>{buffer.append(chunk);let value;while((value=buffer.readMessage())!==null)this.onmessage(value)});child.once("close",()=>this.onclose?.())},
send(value){return new Promise((resolve,reject)=>child.stdin.write(serializeMessage(deserializeMessage(serializeMessage(value).trimEnd())),error=>error?reject(error):resolve()))},async close(){child.stdin.end()}}
class FixedClient extends Client{request(value,schema,options){if(value.method==="initialize")value={...value,params:{...value.params,protocolVersion:"2025-06-18"}};return super.request(value,schema,options)}}
const client=new FixedClient({name:"mocked_unit_engine",version:"1"},{capabilities:{}})
await client.connect(transport)
const session=randomUUID(),emit=value=>console.log(JSON.stringify({...value,session_id:session,uuid:randomUUID()}))
emit({type:"system",subtype:"init",tools:["evidence_read","evidence_search","evidence_list","candidate_submit"].map(x=>"mcp__triage_catalog__"+x)})
let n=0
async function call(name,input){const id="toolu_unit_"+(++n);emit({type:"assistant",message:{content:[{type:"tool_use",id,name:"mcp__triage_catalog__"+name,input}]}});const response=await client.callTool({name,arguments:input});emit({type:"user",message:{content:[{type:"tool_result",tool_use_id:id,is_error:response.isError===true,content:response.content}]}});return response.structuredContent}
await call("evidence_read",{id:"r000000"})
const card=JSON.parse((await call("evidence_read",{id:"r000001"})).text)
const candidate=${JSON.stringify(fixture.candidate)}
candidate.results[0].key=card.authorization.key;candidate.results[0].basis=card.authorization.basis
await call("candidate_submit",{candidate})
emit({type:"result",subtype:"success",is_error:false,total_cost_usd:0})
await ended;await client.close()
`,{mode:0o600})
  const flags=["--restricted","--safe-mode","--permission-mode","--permission-prompts","--tools","--disable-slash-commands","--no-chrome","--no-session-persistence","--strict-mcp-config","--mcp-config","--settings","--max-budget-usd","--output-format","--verbose","--system-prompt","--allowedTools"]
  let nativeLaunches=0,authLaunches=0,diagnostics=0
  const launching=(command,args,options)=>{
    assert.equal(command,process.execPath)
    assert.equal(args[0],"-p");assert.ok(args.includes("--strict-mcp-config"))
    assert.equal(options.env.DESK_FACTORY_HEADLESS,"1")
    nativeLaunches++
    return spawn(process.execPath,[script,args[args.indexOf("--mcp-config")+1]],options)
  }
  const authSpawn=(command,args)=>{
    assert.equal(command,process.execPath);assert.deepEqual(args,["auth","status"]);authLaunches++
    const child=new EventEmitter();Object.assign(child,{pid:process.pid,stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true})
    queueMicrotask(()=>{child.stdout.write(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty",subscriptionType:"unit_nonaccepted"}));child.emit("exit",0);child.emit("close",0)})
    return child
  }
  const launch={cli:process.execPath,env:{HOME:dir},spawn:launching,probeSpawn:authSpawn,cliMetadata:{host:"claude-code",flags},
    resolveExec:()=>({cmd:process.execPath,prefix:[],files:[process.execPath],supported:true}),
    runDiagnostic:async()=>{diagnostics++;return {kind:"closed",code:0,truncated:false,stdout:"Managed settings (remote): requires an Enterprise or Team subscription"}},
    policyReaders:{read:()=>({complete:true,controller_invariant:true,sources:[{kind:"managed",revision:"a".repeat(64),settings:{}}],validation_errors:[]})}}
  const result=await q.qualifyOwnedCatalog({launch,fixture,deadline:Date.now()+90000,evidenceDir:path.join(dir,"synthetic-evidence")})
  assert.equal(nativeLaunches,0)
  assert.equal(authLaunches,0)
  assert.equal(diagnostics,0,"production measurement refuses before any admission or auth execution")
  assert.equal(result.nativeReceipts.length,0)
  assert.equal(result.state,"blocked","instrumented/imported test cannot issue accepted qualification")
  assert.equal(result.reason,"diagnostic_inadequate")
  assert.equal(result.record,null)
  assert.equal(fs.existsSync(path.join(dir,"synthetic-evidence")),false)
  nativeLaunches=0;authLaunches=0;diagnostics=0
  let policyReads=0
  const driftLaunch={...launch,policyReaders:{read:()=>({complete:true,controller_invariant:true,
    sources:[{kind:"managed",revision:(++policyReads<=4?"a":"b").repeat(64),settings:{}}],validation_errors:[]})}}
  const changed=await q.qualifyOwnedCatalog({launch:driftLaunch,fixture,deadline:Date.now()+90000,evidenceDir:path.join(dir,"synthetic-drift-evidence")})
  assert.equal(changed.state,"blocked")
  assert.equal(nativeLaunches,0)
  assert.equal(changed.reason,"diagnostic_inadequate")
  assert.equal(fs.existsSync(path.join(dir,"synthetic-drift-evidence")),false)
})
test("native_completion_terminates_server_and_receipt",async(t)=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"native-fixture-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const inputDir=path.join(dir,"input");fs.mkdirSync(inputDir,{mode:0o700})
  await catalog.writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  const deadline=Date.now()+15000,owned=await custody.prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline})
  const clientURL=new URL("../../../../../plugins/desk/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",import.meta.url).href
  const stdioURL=new URL("../../../../../plugins/desk/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/stdio.js",import.meta.url).href
  const script=path.join(dir,"fixture-native.mjs")
  fs.writeFileSync(script,`
import {spawn} from "node:child_process"
import {randomUUID} from "node:crypto"
import {Client} from ${JSON.stringify(clientURL)}
import {ReadBuffer,serializeMessage,deserializeMessage} from ${JSON.stringify(stdioURL)}
const config=JSON.parse(process.argv[2]),entry=config.mcpServers.triage_catalog
const child=spawn(entry.command,entry.args,{env:entry.env,cwd:entry.cwd,stdio:["pipe","pipe","pipe"]})
const exited=new Promise(r=>child.on("close",code=>r(code)))
child.stderr.on("data",b=>process.stderr.write(b))
const buffer=new ReadBuffer()
const transport={async start(){child.stdout.on("data",chunk=>{buffer.append(chunk);let value;while((value=buffer.readMessage())!==null)this.onmessage(value)});child.on("close",()=>this.onclose?.())},
send(value){return new Promise((r,j)=>child.stdin.write(serializeMessage(deserializeMessage(serializeMessage(value).trimEnd())),e=>e?j(e):r()))},async close(){child.stdin.end()}}
class FixedClient extends Client {request(value,schema,options){if(value.method==="initialize")value={...value,params:{...value.params,protocolVersion:"2025-06-18"}};return super.request(value,schema,options)}}
const client=new FixedClient({name:"native_fixture",version:"1"},{capabilities:{}})
await client.connect(transport)
const session=randomUUID(),emit=value=>console.log(JSON.stringify({...value,session_id:session,uuid:randomUUID()}))
emit({type:"system",subtype:"init",tools:["evidence_read","evidence_search","evidence_list","candidate_submit"].map(x=>"mcp__triage_catalog__"+x)})
let id=100
async function call(name,args){
 const nativeID="toolu_fixture_"+(++id)
 emit({type:"assistant",message:{content:[{type:"tool_use",id:nativeID,name:"mcp__triage_catalog__"+name,input:args}]}})
 const reply=await client.callTool({name,arguments:args})
 emit({type:"user",message:{content:[{type:"tool_result",tool_use_id:nativeID,is_error:reply.isError===true,content:reply.content}]}})
 return reply.structuredContent
}
await call("evidence_read",{id:"r000000"})
const card=JSON.parse((await call("evidence_read",{id:"r000001"})).text)
await call("evidence_read",{id:"r000002"})
const candidate=${JSON.stringify(fixture.candidate)}
candidate.results[0].key=card.authorization.key;candidate.results[0].basis=card.authorization.basis
await call("candidate_submit",{candidate})
emit({type:"result",subtype:"success",is_error:false,total_cost_usd:0})
// Stay alive until parent finish closes actual server stdout: no fictional
// server close, no extra model/provider/API operation in this test.
await exited
await client.close()
`,{mode:0o600})
  const resultFile=path.join(dir,"unaccepted.json"),config={mcpServers:{triage_catalog:{type:"stdio",command:owned.launch.command,args:owned.launch.args,env:{},cwd:owned.runDir}}}
  const run=await custody.runOwnedCatalogNative({owned,command:process.execPath,args:[script,JSON.stringify(config)],
    env:{LANG:"C",LC_ALL:"C",TZ:"UTC"},deadline,resultFile})
  assert.equal(run.state,"ran",JSON.stringify({reason:run.reason,detail:run.detail,resources:run.resources}))
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile)),fixture.candidate)
  assert.equal(run.provisionalValid,1)
  assert.equal(run.resources.native_exit.stdio_closed,true)
  assert.equal(run.resources.server_exit_observed,true)
  assert.equal(run.resources.receipt_eof_after_server_exit,true)
  assert.equal(run.custody.receipts.at(-1).payload.reason,"stdin_eof")
  assert.equal(typeof custody.restoreNativeBundle,"function")
  const restored=JSON.parse(JSON.stringify(run))
  assert.equal(await custody.restoreNativeBundle(restored),true)
  const originalOpen=fs.promises.open
  let swapped=false
  fs.promises.open=async function(file,...args){
    if(file===run.snapshotFile&&!swapped){
      swapped=true;fs.renameSync(file,file+".original");fs.symlinkSync(file+".original",file)
    }
    return originalOpen.call(this,file,...args)
  }
  try{await assert.rejects(custody.restoreNativeBundle(structuredClone(run)))}
  finally{
    fs.promises.open=originalOpen
    if(swapped){fs.unlinkSync(run.snapshotFile);fs.renameSync(run.snapshotFile+".original",run.snapshotFile)}
  }
  const missingEOF=structuredClone(run);missingEOF.resources.receipt_eof_after_server_exit=false
  await assert.rejects(custody.restoreNativeBundle(missingEOF))
  for(const mutate of [
    x=>x.invocation.catalog_sha256="a".repeat(64),
    x=>x.invocation.brief_sha256="a".repeat(64),
    x=>x.invocation.record_refs_sha256="a".repeat(64),
    x=>x.invocation.owned_launch.identity.bootstrap.expectedSha256="a".repeat(64),
    x=>x.invocation.owned_launch.nativePid++,
    x=>{
      const launch=x.invocation.owned_launch
      launch.identity.deadline+=1000
      launch.args[launch.args.indexOf("--deadline-ms")+1]=String(launch.identity.deadline)
    },
  ]){
    const altered=structuredClone(run);mutate(altered)
    await assert.rejects(custody.restoreNativeBundle(altered))
  }
  const forged=JSON.parse(JSON.stringify(run));forged.custody.receipts[1].mac="b".repeat(64)
  await assert.rejects(custody.restoreNativeBundle(forged))
  const unread=structuredClone(run)
  const events=unread.stream.stdout.trim().split("\n").map(x=>JSON.parse(x))
  const readIDs=events.flatMap(x=>x.message?.content??[]).filter(x=>x.type==="tool_use"&&x.name==="mcp__triage_catalog__evidence_read").map(x=>x.id)
  unread.stream.stdout=events.map(x=>x.message?{...x,message:{...x.message,content:x.message.content.filter(c=>!readIDs.includes(c.id??c.tool_use_id))}}:x).map(x=>JSON.stringify(x)).join("\n")+"\n"
  await assert.rejects(custody.restoreNativeBundle(unread))
  const crossSession=structuredClone(run),changed=JSON.parse(crossSession.stream.stdout.split("\n")[1])
  changed.session_id="00000000-0000-0000-0000-000000000000"
  crossSession.stream.stdout=crossSession.stream.stdout.split("\n").map((x,i)=>i===1?JSON.stringify(changed):x).join("\n")
  await assert.rejects(custody.restoreNativeBundle(crossSession))
  const duplicateEvents=structuredClone(run),duplicated=duplicateEvents.stream.stdout.trim().split("\n").map(x=>JSON.parse(x))
  duplicated[1].uuid=duplicated[0].uuid
  duplicateEvents.stream.stdout=duplicated.map(x=>JSON.stringify(x)).join("\n")+"\n"
  await assert.rejects(custody.restoreNativeBundle(duplicateEvents))
  const secondSession=structuredClone(run),sessionEvents=secondSession.stream.stdout.trim().split("\n").map(x=>JSON.parse(x))
  for(const event of sessionEvents)event.session_id="11111111-1111-1111-1111-111111111111"
  secondSession.stream.stdout=sessionEvents.map(x=>JSON.stringify(x)).join("\n")+"\n"
  assert.equal(await custody.restoreNativeBundle(secondSession),true)
  assert.throws(()=>custody.authenticatedNativeRuns([run,secondSession]),{message:"native_generation_reused"})
  const actualBytes=fs.readFileSync(resultFile)
  fs.writeFileSync(resultFile,"synthetic changed result")
  try{await assert.rejects(custody.restoreNativeBundle(structuredClone(run)),{message:"restored_result"})}
  finally{fs.writeFileSync(resultFile,actualBytes)}
})
