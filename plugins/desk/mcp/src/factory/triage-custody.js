// Parent/launcher custody for the sole owned catalog service. FIFOs are
// directional, nonblocking and generation-owned; initial EOF is not terminal.
import fsNative, {constants as C, promises as fs} from "node:fs"
import {promisify} from "node:util"
import {spawn} from "node:child_process"
import {randomBytes,createHmac} from "node:crypto"
import * as path from "node:path"
import * as os from "node:os"
import {fileURLToPath} from "node:url"
import * as nodeModule from "node:module"
import {EventEmitter} from "node:events"
import {PassThrough} from "node:stream"
import {Client} from "@modelcontextprotocol/sdk/client/index.js"
import {ReadBuffer,serializeMessage,deserializeMessage} from "@modelcontextprotocol/sdk/shared/stdio.js"
import {CATALOG_LIMITS,catalogCanonical,catalogHash,closedObject,safeCatalogPath,
  prepareTriageCatalog,createCatalogState,writeTriagePreparedFile,readTriagePreparedFile,catalogToolSchemas} from "./triage-catalog.js"
import {validateTriageResultBytes} from "./triage-schema.js"
import {assertOutsideGitWorkspace} from "./os-protect.js"

const read=promisify(fsNative.read),write=promisify(fsNative.write),close=promisify(fsNative.close)
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const transient=e=>["EAGAIN","EWOULDBLOCK","EINTR"].includes(e.code)
const expectedRoot=fileURLToPath(new URL("../../",import.meta.url))
const entry=fileURLToPath(new URL("../../scripts/triage-catalog-server.js",import.meta.url))
const launcher=fileURLToPath(new URL("../../scripts/launch-triage-catalog.js",import.meta.url))
const clean=Object.freeze({LANG:"C",LC_ALL:"C",TZ:"UTC"})
const fail=code=>{throw new Error(code)}
const hex=/^[a-f0-9]{64}$/u
export const ownedPidLive=pid=>{try{process.kill(pid,0);return true}catch(e){if(e.code==="ESRCH")return false;throw e}}
export async function reapOwnedChild(child,deadline){
  if(!child||child.exitCode!==null||child.signalCode!==null||!Number.isSafeInteger(child.pid)||child.pid<=0)return
  let closed=false
  const onClose=()=>{closed=true}
  child.once("close",onClose)
  child.kill("SIGTERM")
  while(!closed&&Date.now()<deadline-500)await sleep(10)
  if(!closed){
    child.kill("SIGKILL")
    child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy()
    while(!closed&&Date.now()<deadline)await sleep(10)
  }
  child.off("close",onClose)
}
const trustedCustody=new WeakMap()
const nativeRuns=new WeakMap()
const directRuns=new WeakMap()
const wireRuns=new WeakMap(),directBundles=new WeakMap()
const realDirectRegistry=Object.freeze({records:directRuns,bundles:directBundles,wire:wireRuns})
export function retainDirectReceipt(proof) {
  return retainRegisteredDirect(proof,realDirectRegistry)
}
function retainRegisteredDirect(proof,context) {
  if(proof.state!=="proved"||context.records.get(proof)!==catalogHash(JSON.stringify(proof)))fail("direct_receipt_untrusted")
  const {cleanup,...record}=proof
  context.records.set(record,catalogHash(JSON.stringify(record)))
  return record
}
export function authenticatedDirectReceipts(records) {
  return authenticateDirectRecords(records,realDirectRegistry)
}
function authenticateDirectRecords(records,context) {
  if(!Array.isArray(records)||records.length!==2||records[0].generation===records[1].generation||
    records[0].historySha256!==records[1].historySha256||records.some(r=>r.state!=="proved"||context.records.get(r)!==catalogHash(JSON.stringify(r))))fail("direct_receipts_untrusted")
  if(records.some(record=>context.bundles.get(record)!==catalogHash(JSON.stringify(record))))fail("direct_bundles_incomplete")
  return true
}
export function catalogFatalCases(fixture){
  const initialize={jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"triage_direct",version:"1"}}}
  const initialized={jsonrpc:"2.0",method:"notifications/initialized"}
  return [
    {name:"duplicate-key",frames:['{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}\n']},
    {name:"invalid-utf8",frames:[Buffer.from([0xff,10])]},
    {name:"partial-eof",frames:['{"jsonrpc":"2.0"']},
    {name:"frame-limit",frames:[Buffer.alloc(393217,32)]},
    {name:"malformed-json",frames:["{\n"]},
    {name:"second-initialize",frames:[initialize,{...initialize,id:2}]},
    {name:"frame-count",frames:[initialize,initialized,...Array.from({length:255},(_,j)=>({jsonrpc:"2.0",id:j+2,method:"ping"}))]},
    {name:"aggregate",frames:[initialize,initialized,...Array.from({length:52},(_,j)=>({jsonrpc:"2.0",id:j+2,method:"tools/call",
      params:{name:"evidence_read",arguments:{id:"x".repeat(330000)}}}))]},
    // Legal bounded IDs exercise actual output-volume archival, then an exact
    // malformed frame closes the session. The output cap itself is also
    // exercised by the guarded transport tests; oversized IDs are a separate
    // pre-dispatch negative under protocol envelope2.
    {name:"output",frames:[initialize,initialized,...Array.from({length:252},(_,j)=>({jsonrpc:"2.0",id:String(j)+"x".repeat(60),method:"tools/list"})),"{\n"]},
    ...fixture.histories.fatal_inputs.map((frame,j)=>({name:`closed-input-${j+1}`,frames:[initialize,initialized,frame]})),
  ]
}
const descriptorHash=frames=>catalogHash(Buffer.concat(frames.map(frame=>Buffer.from(typeof frame==="object"&&!Buffer.isBuffer(frame)?
  serializeMessage(deserializeMessage(JSON.stringify(frame))):frame))))
const wireProofResources=resources=>({...resources,stdout:typeof resources.stdout==="string"?
  {bytes:Buffer.byteLength(resources.stdout),sha256:catalogHash(resources.stdout)}:
  {bytes:resources.stdout.bytes,sha256:resources.stdout.sha256}})
const wireProofHash=proof=>catalogHash(catalogCanonical({state:proof.state,descriptorSha256:proof.descriptorSha256,
  normalTerminal:proof.normalTerminal,reason:proof.reason,resources:wireProofResources(proof.resources)}))
export function completeDirectBundle({receipt,cases,partial,fixture}){
  return completeRegisteredDirect({receipt,cases,partial,fixture},realDirectRegistry)
}
function completeRegisteredDirect({receipt,cases,partial,fixture},context){
  if(context.records.get(receipt)!==catalogHash(JSON.stringify(receipt))||context.records.get(partial)!==catalogHash(JSON.stringify(partial)))fail("direct_receipt_untrusted")
  const expected=catalogFatalCases(fixture)
  if(cases.length!==expected.length||cases.some((item,index)=>item.name!==expected[index].name||
    context.wire.get(item.proof)!==catalogHash(JSON.stringify(item.proof))||
    item.proof.descriptorSha256!==descriptorHash(expected[index].frames)||item.proof.state!=="refused"))fail("direct_cases_incomplete")
  if(catalogCanonical(partial.custody.receipts[1].payload.refused.map(x=>x.index))!=="[1]"||
    catalogCanonical(partial.custody.receipts[1].payload.candidate)!==catalogCanonical(fixture.histories.partial.candidate))fail("direct_partial")
  const record={...receipt,bundle:{version:1,cases:cases.map(item=>({name:item.name,descriptorSha256:item.proof.descriptorSha256,
    proofSha256:wireProofHash(item.proof),resources:wireProofResources(item.proof.resources),normalTerminal:item.proof.normalTerminal,
    state:item.proof.state,reason:item.proof.reason})),partial}}
  context.records.set(record,catalogHash(JSON.stringify(record)))
  context.bundles.set(record,catalogHash(JSON.stringify(record)))
  return record
}
/** Fixed local synthetic proofs; these maps never alias production registries. */
export function createNonacceptedDirectRegistry(config){
  closedObject(config,["fixture"])
  const fixture=JSON.parse(catalogCanonical(config.fixture))
  const context={records:new WeakMap(),bundles:new WeakMap(),wire:new WeakMap()}
  const receipt={state:"proved",generation:"a".repeat(64),historySha256:catalogHash("unit")},
    second={...receipt,generation:"b".repeat(64)},
    partial={state:"proved",custody:{receipts:[{}, {payload:{candidate:fixture.histories.partial.candidate,refused:[{index:1}]}}]}}
  for(const value of [receipt,second,partial])context.records.set(value,catalogHash(JSON.stringify(value)))
  const cases=catalogFatalCases(fixture).map(item=>{
    const proof={state:"refused",descriptorSha256:descriptorHash(item.frames),normalTerminal:false,reason:"unit",
      resources:{stdout:"unit",serverExited:true}}
    context.wire.set(proof,catalogHash(JSON.stringify(proof)));return {name:item.name,proof}
  })
  return Object.freeze({authority:false,receipt,second,partial,cases,
    retain(value=receipt){return {authority:false,record:retainRegisteredDirect(value,context)}},
    complete(options={}){closedObject(options,[],["receipt","cases","partial"]);return {authority:false,
      record:completeRegisteredDirect({receipt,cases,partial,fixture,...options},context)}},
    authenticate(records){return {authority:false,valid:authenticateDirectRecords(records,context)}},
  })
}
const ownedCatalogEntries=()=>({entry,launcher,runtime:fsNative.realpathSync(process.execPath)})
export function ownedCatalogEnvironment({platform,uid,euid}) {
  if(!Number.isSafeInteger(uid)||uid<0||uid>4294967295||uid!==euid)fail("environment_identity")
  const env={LANG:"C",LC_ALL:"C",TZ:"UTC"}
  if(platform==="darwin"){
    const encodingValue="0x"+uid.toString(16).toUpperCase()+":0:0"
    return {version:2,env:{...env,__CF_USER_TEXT_ENCODING:encodingValue},encodingValue}
  }
  if(!["linux","win32","freebsd","openbsd","aix","sunos"].includes(platform))fail("environment_platform")
  return {version:2,env}
}
export function validateOwnedCatalogEnvironment({platform,uid,euid,env,expected}) {
  try{
    const recipe=ownedCatalogEnvironment({platform,uid,euid})
    if(catalogCanonical(recipe)!==catalogCanonical(expected)||
      catalogCanonical({...env})!==catalogCanonical(recipe.env))fail("environment_mismatch")
    return {ok:true}
  }catch(e){return {ok:false,reason:e.message}}
}

export async function boundedFdWrite(fd,bytes,deadline) {
  const buffer=Buffer.from(bytes)
  let offset=0
  while(offset<buffer.length){
    if(Date.now()>=deadline-1000)fail("fd_write_deadline")
    try{
      const {bytesWritten}=await write(fd,buffer,offset,buffer.length-offset,null)
      if(bytesWritten===0)await sleep(10);else offset+=bytesWritten
    }catch(e){if(!transient(e))throw e;await sleep(10)}
  }
}
export function fifoPump({fd,deadline,maxFrame,maxBytes,maxFrames,onFrame,onFailure}) {
  let stopped=false,partial=Buffer.alloc(0),total=0,count=0,zeroReads=0
  const raw=Buffer.alloc(maxBytes)
  let rawBytes=0
  const done=(async()=>{
    const buffer=Buffer.alloc(32768)
    while(!stopped&&Date.now()<deadline){
      try{
        const {bytesRead}=await read(fd,buffer,0,buffer.length,null)
        if(!bytesRead){zeroReads++;await sleep(10);continue}
        const kept=Math.min(bytesRead,maxBytes-rawBytes)
        buffer.copy(raw,rawBytes,0,kept);rawBytes+=kept
        total+=bytesRead;if(total>maxBytes)fail("fifo_total_limit")
        let offset=0
        while(offset<bytesRead){
          const n=buffer.indexOf(10,offset),end=n<0||n>=bytesRead?bytesRead:n
          if(partial.length+end-offset>maxFrame)fail("fifo_frame_limit")
          partial=Buffer.concat([partial,buffer.subarray(offset,end)])
          offset=end+(end<bytesRead?1:0)
          if(end===bytesRead)break
          count++;if(count>maxFrames)fail("fifo_count_limit")
          const text=new TextDecoder("utf-8",{fatal:true}).decode(partial),value=JSON.parse(text)
          if(catalogCanonical(value)!==text)fail("fifo_noncanonical")
          partial=Buffer.alloc(0);await onFrame(value)
        }
      }catch(e){if(stopped)break;if(transient(e)){await sleep(10);continue}onFailure(e);break}
    }
  })()
  return {stop:async()=>{stopped=true;await done},done,status:()=>({partial:partial.length,total,count,zeroReads}),
    diagnostic:()=>({partial_base64:partial.toString("base64"),raw_base64:raw.subarray(0,rawBytes).toString("base64"),truncated:total>maxBytes,total,count,zeroReads})}
}
async function openSafe(file,kind,flags,deadline) {
  const before=await safeCatalogPath(file,kind),mode=kind==="file"?0o600:0o600
  while(true){
    if(Date.now()>=deadline-1000)fail("open_deadline")
    try{
      const handle=await fs.open(file,flags|C.O_NOFOLLOW),stat=await handle.stat()
      if(stat.dev!==before.dev||stat.ino!==before.ino||stat.uid!==before.uid||(stat.mode&0o777)!==mode){
        await handle.close();fail("endpoint_replaced")
      }
      return {handle,identity:before}
    }catch(e){if(e.code!=="ENXIO")throw e;await sleep(10)}
  }
}
export async function openCatalogBootstrap({snapshotFile,expectedSha256,generation,receiptFifo,readyFifo,deadline}) {
  if(!hex.test(expectedSha256)||!hex.test(generation)||!Number.isSafeInteger(deadline))fail("bootstrap_invalid")
  const dir=path.dirname(snapshotFile)
  await safeCatalogPath(dir,"directory",0o700)
  if(snapshotFile!==path.join(dir,"catalog.json")||receiptFifo!==path.join(dir,"receipt.fifo")||readyFifo!==path.join(dir,"control.fifo"))fail("bootstrap_paths")
  const opened=[]
  try{
    const ready=await openSafe(readyFifo,"fifo",C.O_RDONLY|C.O_NONBLOCK,deadline);opened.push(ready.handle)
    const receipt=await openSafe(receiptFifo,"fifo",C.O_WRONLY|C.O_NONBLOCK,deadline);opened.push(receipt.handle)
    const snapshot=await openSafe(snapshotFile,"file",C.O_RDONLY,deadline);opened.push(snapshot.handle)
    return {snapshotFd:snapshot.handle.fd,receiptFd:receipt.handle.fd,readyFd:ready.handle.fd,
      handles:opened,identity:{snapshot:snapshot.identity,receipt:receipt.identity,ready:ready.identity,generation,expectedSha256}}
  }catch(e){await Promise.all(opened.map(h=>h.close()));throw e}
}
export async function loadCatalogSnapshot({fd,expectedSha256,generation}) {
  const stat=await promisify(fsNative.fstat)(fd)
  let bytes=Buffer.alloc(0)
  try{
    if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.nlink!==1||(stat.mode&0o777)!==0o600||stat.size>6291456)fail("snapshot_unsafe")
    const buffer=Buffer.alloc(32768)
    while(bytes.length<stat.size){
      const {bytesRead}=await read(fd,buffer,0,Math.min(buffer.length,stat.size-bytes.length),null)
      if(!bytesRead)fail("snapshot_truncated")
      bytes=Buffer.concat([bytes,buffer.subarray(0,bytesRead)])
    }
    if(expectedSha256!==undefined&&catalogHash(bytes)!==expectedSha256)fail("snapshot_hash")
    const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes),value=JSON.parse(text)
    if(catalogCanonical(value)!==text||(generation!==undefined&&value.generation!==generation))fail("snapshot_identity")
    const state=createCatalogState(value)
    return {brief:state.brief,catalog:state,receiptKey:value.receipt_key,generation:value.generation,
      bootstrapReceipt:{snapshot_sha256:catalogHash(bytes),catalog_sha256:catalogHash(catalogCanonical(value.records)),
        brief_sha256:catalogHash(catalogCanonical(value.brief)),map_sha256:catalogHash(catalogCanonical(value.record_refs)),
        snapshot_identity:{dev:stat.dev,ino:stat.ino,uid:stat.uid,mode:stat.mode,nlink:stat.nlink,size:stat.size}}}
  }finally{await close(fd)}
}
export function catalogBootstrapArguments(argv) {
  const keys=["--entry","--snapshot","--sha256","--generation","--receipt-fifo","--ready-fifo","--deadline-ms"]
  if(argv.length!==14||keys.some((key,i)=>argv[i*2]!==key))fail("launcher_arguments")
  const values=Object.fromEntries(keys.map((key,i)=>[key,argv[i*2+1]]))
  const deadline=Number(values["--deadline-ms"])
  if(!Number.isSafeInteger(deadline)||deadline<=Date.now()||!hex.test(values["--sha256"])||!hex.test(values["--generation"]))fail("launcher_bindings")
  return {entry:values["--entry"],snapshotFile:values["--snapshot"],expectedSha256:values["--sha256"],generation:values["--generation"],
    receiptFifo:values["--receipt-fifo"],readyFifo:values["--ready-fifo"],deadline}
}
export function makeReceipt({event,generation,sequence,serverPid,catalogSha256,briefSha256,payload,key}) {
  const data={version:1,event,generation,sequence,server_pid:serverPid,catalog_sha256:catalogSha256,brief_sha256:briefSha256,payload}
  return {...data,mac:createHmac("sha256",Buffer.from(key,"hex")).update(catalogCanonical(data)).digest("hex")}
}
function verifyReceipt(receipt,key) {
  try{
    closedObject(receipt,["version","event","generation","sequence","server_pid","catalog_sha256","brief_sha256","payload","mac"])
    const {mac,...body}=receipt
    return mac===createHmac("sha256",Buffer.from(key,"hex")).update(catalogCanonical(body)).digest("hex")
  }catch{return false}
}
const observationKinds=["input_frame","output_frame","parser_refused","server_refused","write_complete","backpressure","input_end","server_closing","launcher_exit"]
const observationCodes=["wire_noncanonical","catalog_invalid","protocol_state","wire_input_limit","wire_frame_limit",
  "wire_frame_count","wire_queue_limit","wire_output_limit","wire_closed","wire_incomplete","write_failed","unknown"]
export function makeCatalogObservation({kind,direction="none",offset=0,bytes=Buffer.alloc(0),code=null,signal=null,blocked=null,pid=process.pid}){
  const raw=Buffer.from(bytes),retained=raw.subarray(0,8192)
  const value={version:1,kind,direction,pid,at_ms:Date.now(),offset,bytes:raw.length,
    sha256:catalogHash(raw),retained_sha256:catalogHash(retained),base64:retained.toString("base64"),
    truncated:raw.length>retained.length,observation:raw.length?"present":"observed_absent",code,signal,blocked}
  validateCatalogObservation(value)
  return value
}
export function validateCatalogObservation(value){
  closedObject(value,["version","kind","direction","pid","at_ms","offset","bytes","sha256","retained_sha256",
    "base64","truncated","observation","code","signal","blocked"])
  if(value.version!==1||!observationKinds.includes(value.kind)||!["input","output","none"].includes(value.direction)||
    !Number.isSafeInteger(value.pid)||value.pid<1||!Number.isSafeInteger(value.at_ms)||value.at_ms<0||
    !Number.isSafeInteger(value.offset)||value.offset<0||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>16777216||
    !hex.test(value.sha256)||!hex.test(value.retained_sha256)||typeof value.base64!=="string"||
    value.base64.length>10924||typeof value.truncated!=="boolean")fail("observation_invalid")
  const raw=Buffer.from(value.base64,"base64")
  if(raw.toString("base64")!==value.base64||raw.length>8192||catalogHash(raw)!==value.retained_sha256||
    value.truncated!==(value.bytes>raw.length)||(!value.truncated&&(value.bytes!==raw.length||value.sha256!==value.retained_sha256))||
    value.observation!==(value.bytes?"present":"observed_absent")||
    (value.blocked!==null&&typeof value.blocked!=="boolean")||
    (value.signal!==null&&!["SIGTERM","SIGKILL","SIGINT","SIGHUP","SIGABRT","SIGSEGV","SIGPIPE","SIGBUS","SIGILL","SIGQUIT"].includes(value.signal)))fail("observation_invalid")
  if(value.kind==="launcher_exit"){
    if(value.direction!=="none"||value.bytes!==0||value.blocked!==null||
      (value.code!==null&&(!Number.isSafeInteger(value.code)||value.code<0||value.code>255)))fail("observation_invalid")
  }else if(value.signal!==null||(value.code!==null&&!observationCodes.includes(value.code)))fail("observation_invalid")
  const input=value.kind==="input_frame"||value.kind==="input_end",output=["output_frame","write_complete","backpressure"].includes(value.kind)
  if((input&&value.direction!=="input")||(output&&value.direction!=="output")||
    (value.kind==="server_closing"&&(value.direction!=="none"||value.code!==null))||
    (value.kind==="backpressure"?typeof value.blocked!=="boolean":value.blocked!==null)||
    (!["input_frame","output_frame","parser_refused"].includes(value.kind)&&value.bytes!==0)||
    (["input_frame","output_frame"].includes(value.kind)&&(value.bytes===0||(!value.truncated&&raw.at(-1)!==10))))fail("observation_invalid")
  return true
}
export function ownedServerLaunch({runtime,launcher:launchFile,entry:entryFile,bootstrap,deadline}) {
  const exact=ownedCatalogEntries()
  if(runtime!==exact.runtime||launchFile!==exact.launcher||entryFile!==exact.entry)fail("launch_source")
  const dir=path.dirname(bootstrap.snapshotFile)
  const recipe=ownedCatalogEnvironment({platform:process.platform,uid:process.getuid?.(),euid:process.geteuid?.()})
  const args=["-i","LANG=C","LC_ALL=C","TZ=UTC",...(recipe.encodingValue?[`__CF_USER_TEXT_ENCODING=${recipe.encodingValue}`]:[]),runtime,launchFile,"--entry",entryFile,
    "--snapshot",bootstrap.snapshotFile,"--sha256",bootstrap.expectedSha256,"--generation",bootstrap.generation,
    "--receipt-fifo",bootstrap.receiptFifo,"--ready-fifo",bootstrap.readyFifo,"--deadline-ms",String(deadline)]
  if(!hex.test(bootstrap.generation)||!hex.test(bootstrap.expectedSha256)||!Number.isSafeInteger(deadline)||
    bootstrap.snapshotFile!==path.join(dir,"catalog.json")||bootstrap.receiptFifo!==path.join(dir,"receipt.fifo")||
    bootstrap.readyFifo!==path.join(dir,"control.fifo")||!path.isAbsolute(dir))fail("launch_bindings")
  return {command:"/usr/bin/env",args,env:{},cwd:dir,identity:{runtime,launcher:launchFile,entry:entryFile,cleanEnv:recipe.env,envRecipe:recipe,
    platform:process.platform,uid:process.getuid(),euid:process.geteuid(),bootstrap,deadline}}
}
async function osCapture(command,args,deadline) {
  const limit=Math.min(3000,deadline-Date.now()-1000)
  if(limit<=0)fail("observation_deadline")
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{env:clean,stdio:["ignore","pipe","pipe"]})
    let bytes=0,out="",err="",settled=false
    const finish=e=>{if(settled)return;settled=true;clearTimeout(timer);e?reject(e):resolve(out)}
    const timer=setTimeout(()=>{child.kill("SIGKILL");finish(new Error("observation_timeout"))},limit)
    child.stdout.on("data",chunk=>{bytes+=chunk.length;if(bytes>65536){child.kill("SIGKILL");finish(new Error("observation_limit"))}else out+=chunk})
    child.stderr.on("data",chunk=>{err+=chunk;if(err.length>65536)child.kill("SIGKILL")})
    child.on("error",finish);child.on("close",code=>finish(code===0?null:new Error("observation_failed")))
  })
}
function psIdentity(text,pid) {
  const match=/^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.+)$/u.exec(text.trim())
  if(!match||Number(match[1])!==pid)fail("pid_unknown")
  return {pid,ppid:Number(match[2]),start:match[3],command:match[4]}
}
export async function observeOwnedServer({nativePid,launcherPid,serverPid,generation,startIdentity,expected}) {
  try{
    if(process.platform!=="darwin"||!hex.test(generation)||![launcherPid,serverPid].every(p=>Number.isSafeInteger(p)&&p>0))fail("provenance_unsupported")
    const server=psIdentity(await osCapture("/bin/ps",["-ww","-p",String(serverPid),"-o","pid=,ppid=,lstart=,command="],expected.deadline),serverPid)
    const launch=psIdentity(await osCapture("/bin/ps",["-ww","-p",String(launcherPid),"-o","pid=,ppid=,lstart=,command="],expected.deadline),launcherPid)
    if(server.ppid!==launcherPid||(nativePid!==undefined&&launch.ppid!==nativePid) ||
      server.command!==`${expected.runtime} ${expected.entry}`||
      launch.command!==`${expected.runtime} ${expected.launcher} ${expected.launchArgs.join(" ")}`||
      (startIdentity&&catalogCanonical(startIdentity)!==catalogCanonical({server,launch})))fail("provenance_mismatch")
    const environment=await osCapture("/bin/ps",["eww","-p",String(serverPid),"-o","command="],expected.deadline)
    const allowed=`${expected.runtime} ${expected.entry} ${Object.entries(expected.cleanEnv).map(([k,v])=>`${k}=${v}`).join(" ")}`
    // Darwin may emit environment fields in lexical rather than insertion
    // order. Parse only this positively identified noncredential server.
    const prefix=`${expected.runtime} ${expected.entry} `
    const fields=environment.trim().startsWith(prefix)?environment.trim().slice(prefix.length).split(" ").sort():[]
    if(catalogCanonical(fields)!==catalogCanonical(Object.entries(expected.cleanEnv).map(([k,v])=>`${k}=${v}`).sort()))fail("environment_unknown")
    return {ok:true,identity:{server,launch,generation,environment_sha256:catalogHash(allowed)}}
  }catch(e){return {ok:false,reason:e.message}}
}
export async function ownedSourceIdentity() {
  const exact=ownedCatalogEntries(),files=[exact.runtime,"/usr/bin/env",exact.entry,exact.launcher,
    ...["triage-catalog","triage-protocol","triage-custody","triage-runner"].map(x=>fileURLToPath(new URL(`./${x}.js`,import.meta.url)))]
  const hashes={}
  for(const file of files)hashes[file]=catalogHash(await fs.readFile(file))
  // The loaded SDK dependency closure must be independently observed by the
  // parent, not inferred from package/lock labels. Unsupported closure is a
  // concrete hold until its actual load ledger is available.
  return {files:hashes,sdkRoot:path.join(expectedRoot,"node_modules","@modelcontextprotocol","sdk"),runtime:exact.runtime}
}
export async function verifyModuleClosure(closure) {
  if(!Array.isArray(closure)||closure.length<10||closure.length>512)fail("module_closure")
  const seen=new Set();let total=0
  for(const item of closure){
    closedObject(item,["path","sha256","bytes"])
    if(typeof item.path!=="string"||!item.path.startsWith(expectedRoot)||seen.has(item.path)||
      !hex.test(item.sha256)||!Number.isSafeInteger(item.bytes)||item.bytes<0)fail("module_closure")
    seen.add(item.path)
    if(await fs.realpath(item.path)!==item.path)fail("module_symlink")
    const bytes=await fs.readFile(item.path);total+=bytes.length
    if(total>64*1024*1024||bytes.length!==item.bytes||catalogHash(bytes)!==item.sha256)fail("module_changed")
  }
  if(!closure.some(x=>x.path.includes("/@modelcontextprotocol/sdk/"))||
    !["triage-catalog","triage-protocol","triage-custody"].every(name=>seen.has(fileURLToPath(new URL(`./${name}.js`,import.meta.url)))))fail("module_incomplete")
  return structuredClone(closure)
}
function validatedNativeSubmission({custody,nativeStream,brief}) {
    const authority=trustedCustody.get(custody)
    if(!authority||catalogCanonical(custody)!==authority.seal)fail("custody_untrusted")
    return validateNativeSubmissionEvidence({custody,nativeStream,brief,records:authority.records})
}
// Pure evidence validation is deliberately not custody/registry issuance.
function nativeManifestDetail(value){
  if(!Array.isArray(value.tools)||!Array.isArray(value.mcp_servers))return "native_manifest_mismatch"
  if(!value.tools.length||!value.mcp_servers.length)return "native_manifest_empty"
  const expected=["evidence_read","evidence_search","evidence_list","candidate_submit"].map(x=>`mcp__triage_catalog__${x}`).sort()
  return catalogCanonical([...value.tools].sort())===catalogCanonical(expected)&&value.mcp_servers.length===1&&
    value.mcp_servers[0]?.name==="triage_catalog"&&value.mcp_servers[0]?.status==="connected"?null:"native_manifest_mismatch"
}
export function validateNativeSubmissionEvidence({custody,nativeStream,brief,records}) {
    const submission=custody.receipts.find(r=>r.event==="submit")?.payload
    if(!submission||catalogHash(catalogCanonical(brief))!==custody.briefSha256)fail("custody_brief")
    const events=nativeStream.stdout.split("\n").filter(Boolean).map(x=>JSON.parse(x)),init=events.filter(x=>x.type==="system"&&x.subtype==="init")
    const toolNames=["evidence_read","evidence_search","evidence_list","candidate_submit"].map(x=>`mcp__triage_catalog__${x}`).sort()
    if(init.length!==1||nativeManifestDetail(init[0])||nativeStream.kind!=="closed"||nativeStream.code!==0||nativeStream.truncated)fail("native_manifest")
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(init[0].session_id)||
      events.some(x=>x.session_id!==init[0].session_id))fail("native_session")
    if(events.some(x=>!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(x.uuid))||
      new Set(events.map(x=>x.uuid)).size!==events.length)fail("native_event_reused")
    const uses=events.filter(x=>x.type==="assistant").flatMap(x=>x.message?.content??[]).filter(x=>x.type==="tool_use")
    const results=events.filter(x=>x.type==="user").flatMap(x=>x.message?.content??[]).filter(x=>x.type==="tool_result")
    if(new Set(uses.map(x=>x.id)).size!==uses.length||uses.some(x=>!toolNames.includes(x.name)||results.filter(r=>r.tool_use_id===x.id).length!==1)||
      results.some(r=>!uses.some(u=>u.id===r.tool_use_id)))fail("native_correlation")
    const resultValue=r=>{
      if(r?.is_error===true)return null
      try{return JSON.parse(Array.isArray(r.content)?r.content.filter(x=>x.type==="text").map(x=>x.text).join("\n"):r.content)}
      catch{return null}
    }
    const required=records.filter(r=>r.id==="r000000"||r.kind==="card")
    if(!required.every(record=>uses.some(u=>u.name==="mcp__triage_catalog__evidence_read"&&
      catalogCanonical(u.input)===catalogCanonical({id:record.id})&&
      catalogCanonical(resultValue(results.find(r=>r.tool_use_id===u.id)))===catalogCanonical(record))))fail("native_prepared_read")
    const matching=uses.filter(u=>u.name==="mcp__triage_catalog__candidate_submit"&&catalogCanonical(u.input)===catalogCanonical({candidate:submission.candidate}))
    if(!matching.length||!matching.some(u=>{
      const r=results.find(r=>r.tool_use_id===u.id);if(r.is_error===true)return false
      try{const text=Array.isArray(r.content)?r.content.filter(x=>x.type==="text").map(x=>x.text).join("\n"):r.content
        const value=JSON.parse(text);return value.receipt_id===submission.receipt_id&&value.candidate_sha256===submission.candidate_sha256}catch{return false}
    }))fail("native_submit")
    const encoded=catalogCanonical(submission.candidate),valid=validateTriageResultBytes(encoded,{brief})
    if(!valid.valid.length||catalogHash(encoded)!==submission.candidate_sha256)fail("candidate_invalid")
    const final=events.at(-1)
    if(final?.type!=="result"||final.subtype!=="success"||final.is_error!==false)fail("native_terminal")
    return {encoded,valid,authority:false}
}
export async function materializeTriageSubmission({custody,nativeStream,brief,resultFile}) {
  try{
    const {encoded,valid}=validatedNativeSubmission({custody,nativeStream,brief})
    await assertOutsideGitWorkspace(path.dirname(resultFile),{label:"triage",subject:"unaccepted candidate"})
    await safeCatalogPath(path.dirname(resultFile),"directory",0o700)
    const handle=await fs.open(resultFile,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600)
    try{await handle.writeFile(encoded);await handle.sync()}finally{await handle.close()}
    return {state:"ran",resultFile,provisionalValid:valid.valid.length,provisionalRefused:valid.refused.length}
  }catch{return {state:"scope_unqualified",reason:"diagnostic_inadequate",provisionalValid:0,provisionalRefused:0}}
}
async function restoredCustody(custody,snapshotFile) {
  await assertOutsideGitWorkspace(path.dirname(snapshotFile),{label:"triage",subject:"custody"})
  const safe=await safeCatalogPath(snapshotFile)
  if(safe.size>6291456)fail("snapshot_limit")
  const bytes=await readProtectedBytes(snapshotFile,6291456),snapshot=JSON.parse(bytes)
  if(catalogCanonical(snapshot)!==bytes.toString()||catalogHash(bytes)!==custody.snapshotSha256)fail("restored_snapshot")
  createCatalogState(snapshot)
  if(!Array.isArray(custody.receipts)||custody.receipts.length!==3||
    catalogCanonical(custody.sourceIdentity)!==catalogCanonical(await ownedSourceIdentity()))fail("restored_source")
  for(const [i,r]of custody.receipts.entries()){
    if(!verifyReceipt(r,snapshot.receipt_key)||r.generation!==snapshot.generation||r.sequence!==i+1||
      r.event!==["bootstrap","submit","terminal"][i]||
      r.catalog_sha256!==catalogHash(catalogCanonical(snapshot.records))||r.brief_sha256!==catalogHash(catalogCanonical(snapshot.brief))||
      r.server_pid!==custody.receipts[0].server_pid)fail("restored_receipt")
  }
  if(!Array.isArray(custody.observations)||custody.observations.length>17)fail("restored_observation")
  let serverSequence=0,exitObserved=false
  for(const frame of custody.observations){
    if(!verifyReceipt(frame,snapshot.receipt_key)||frame.event!=="observation"||frame.version!==1||
      frame.generation!==snapshot.generation||frame.server_pid!==custody.receipts[0].server_pid||
      frame.catalog_sha256!==custody.receipts[0].catalog_sha256||frame.brief_sha256!==custody.receipts[0].brief_sha256)fail("restored_observation")
    validateCatalogObservation(frame.payload)
    if(frame.payload.kind==="launcher_exit"){
      if(exitObserved||frame.sequence!==1||frame.payload.pid!==custody.receipts[0].payload.launcher_pid||
        frame.payload.code!==0||frame.payload.signal!==null)fail("restored_observation")
      exitObserved=true
    }else if(exitObserved||frame.sequence!==++serverSequence||serverSequence>16||
      frame.payload.pid!==frame.server_pid)fail("restored_observation")
  }
  if(!exitObserved||!["input_frame","output_frame"].every(kind=>custody.observations.some(x=>x.payload.kind===kind)))fail("restored_observation")
  if(custody.receipts[0].payload.snapshot_sha256!==custody.snapshotSha256||
    custody.receipts[2].payload.reason!=="stdin_eof"||custody.receipts[2].payload.final_sequence!==3||
    custody.observation?.ok!==true||custody.observation.identity.server.pid!==custody.receipts[0].server_pid||
    custody.observation.identity.server.ppid!==custody.observation.identity.launch.pid)fail("restored_provenance")
  const launch=custody.launchIdentity,identity=launch.identity
  const expected=ownedServerLaunch({runtime:identity.runtime,launcher:identity.launcher,entry:identity.entry,
    bootstrap:identity.bootstrap,deadline:identity.deadline})
  const {nativePid,...fixed}=launch
  const observed=custody.observation.identity,boot=custody.receipts[0].payload
  if(catalogCanonical(fixed)!==catalogCanonical(expected)||
    identity.bootstrap.expectedSha256!==custody.snapshotSha256||identity.bootstrap.generation!==snapshot.generation||
    observed.generation!==snapshot.generation||boot.cwd!==launch.cwd||boot.uid!==identity.uid||boot.euid!==identity.euid||boot.env_version!==2||
    observed.server.command!==`${identity.runtime} ${identity.entry}`||
    observed.launch.command!==`${identity.runtime} ${identity.launcher} ${launch.args.slice(launch.args.indexOf("--entry")).join(" ")}`||
    (nativePid!==undefined&&observed.launch.ppid!==nativePid)||
    ![observed.server.start,observed.launch.start].every(value=>/^\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4}$/u.test(value))||
    observed.environment_sha256!==catalogHash(`${identity.runtime} ${identity.entry} ${Object.entries(identity.cleanEnv).map(([key,value])=>`${key}=${value}`).join(" ")}`))fail("restored_process_identity")
  await verifyModuleClosure(custody.moduleClosure)
  trustedCustody.set(custody,{seal:catalogCanonical(custody),records:snapshot.records})
  return snapshot.brief
}
export async function restoreNativeBundle(bundle) {
  if(bundle.state!=="ran"||bundle.resources.native_exit.code!==0||!bundle.resources.native_exit.stdio_closed||
    bundle.resources.server_exit_observed!==true||bundle.resources.receipt_eof_after_server_exit!==true||
    bundle.snapshotFile!==path.join(bundle.resources.runDir,"catalog.json"))fail("restored_native")
  const brief=await restoredCustody(bundle.custody,bundle.snapshotFile)
  const snapshot=JSON.parse(await readProtectedBytes(bundle.snapshotFile,6291456)),invocation=bundle.invocation,b=invocation.owned_launch.identity.bootstrap
  if(catalogCanonical(invocation.owned_launch)!==catalogCanonical(bundle.custody.launchIdentity)||
    invocation.catalog_sha256!==catalogHash(catalogCanonical(snapshot.records))||
    invocation.brief_sha256!==catalogHash(catalogCanonical(snapshot.brief))||
    invocation.record_refs_sha256!==catalogHash(catalogCanonical(snapshot.record_refs))||
    b.expectedSha256!==bundle.custody.snapshotSha256||b.generation!==snapshot.generation||b.snapshotFile!==bundle.snapshotFile||
    invocation.owned_launch.nativePid!==bundle.resources.pids[0]||
    bundle.custody.observation.identity.launch.ppid!==bundle.resources.pids[0])fail("restored_invocation")
  const {encoded}=validatedNativeSubmission({custody:bundle.custody,nativeStream:bundle.stream,brief})
  await safeCatalogPath(bundle.resultFile)
  if((await fs.readFile(bundle.resultFile,"utf8"))!==encoded)fail("restored_result")
  nativeRuns.set(bundle,catalogHash(catalogCanonical(bundle)))
  return true
}
async function restoreDirectHistory(bundle,fixture){
  if(bundle.state!=="proved"||!bundle.snapshotArchive)fail("restored_direct")
  const brief=await restoredCustody(bundle.custody,bundle.snapshotArchive)
  const snapshot=JSON.parse(await readProtectedBytes(bundle.snapshotArchive,6291456))
  const expectedSnapshot=JSON.parse(prepareTriageCatalog({brief:fixture.brief,records:fixture.record_inputs,
    recordRefs:fixture.record_refs,generation:snapshot.generation}).snapshotBytes)
  if(catalogCanonical(snapshot.records)!==catalogCanonical(expectedSnapshot.records)||
    catalogCanonical(snapshot.record_refs)!==catalogCanonical(expectedSnapshot.record_refs))fail("restored_catalog")
  const conflict=structuredClone(fixture.candidate);conflict.results[0].problem="changed"
  const expected=[
    {name:"evidence_list",args:{}},{name:"evidence_read",args:{id:"r000002"}},
    {name:"evidence_search",args:{query:"needle",ids:["r000002"]}},
    ...fixture.cases,{name:"candidate_submit",args:{candidate:fixture.candidate}},
    {name:"candidate_submit",args:{candidate:fixture.candidate}},
    {name:"candidate_submit",args:{candidate:conflict}},
  ]
  const submit=bundle.custody.receipts[1].payload
  if(catalogCanonical(brief)!==catalogCanonical(fixture.brief)||
    bundle.generation!==bundle.custody.receipts[0].generation||
    bundle.historySha256!==catalogHash(catalogCanonical(expected))||
    catalogCanonical(bundle.responses)!==catalogCanonical(expected.map(x=>({name:x.name,ok:true})))||
    catalogCanonical(bundle.tools)!==catalogCanonical(catalogToolSchemas().tools)||
    catalogCanonical(submit.candidate)!==catalogCanonical(fixture.candidate)||
    submit.candidate_sha256!==catalogHash(catalogCanonical(submit.candidate))||
    bundle.resources.launcherExit!==0||!bundle.resources.serverExited||!bundle.resources.fdsClosed||
    bundle.resources.server_exit_observed!==true||bundle.resources.receipt_eof_after_server_exit!==true)fail("restored_history")
  const uses=bundle.resources.wire.filter(x=>x.method==="tools/call").map(x=>({name:x.params.name,args:x.params.arguments}))
  if(catalogCanonical(uses)!==catalogCanonical(expected))fail("restored_wire")
}
export async function readProtectedBytes(file,maxBytes){
  const before=await safeCatalogPath(file)
  if(before.size>maxBytes)fail("proof_limit")
  const handle=await fs.open(file,C.O_RDONLY|C.O_NOFOLLOW)
  let bytes
  try{
    const stat=await handle.stat()
    if(stat.dev!==before.dev||stat.ino!==before.ino)fail("proof_replaced")
    bytes=await handle.readFile()
  }finally{await handle.close()}
  if(catalogCanonical(await safeCatalogPath(file))!==catalogCanonical(before))fail("proof_changed")
  if(bytes.length!==before.size)fail("proof_size")
  return bytes
}
async function protectedProofJSON(file){
  const bytes=await readProtectedBytes(file,2097152)
  const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes),value=JSON.parse(text)
  if(catalogCanonical(value)+"\n"!==text)fail("proof_noncanonical")
  return value
}
export async function restoreDirectReceipt(bundle) {
  const fixture=JSON.parse(await fs.readFile(new URL("../../../../../tests/desk/mcp/__tests__/factory/fixtures/v12-owned-catalog.json",import.meta.url)))
  await restoreDirectHistory(bundle,fixture)
  if(bundle.bundle){
    closedObject(bundle.bundle,["version","cases","partial"])
    const expected=catalogFatalCases(fixture),root=path.dirname(path.dirname(bundle.snapshotArchive)),prefix=path.basename(path.dirname(bundle.snapshotArchive))
    if(bundle.bundle.version!==1||bundle.bundle.cases.length!==expected.length||
      bundle.bundle.partial.snapshotArchive!==path.join(root,`${prefix}-partial`,"catalog.json"))fail("restored_bundle")
    await restoreDirectHistory(bundle.bundle.partial,{...fixture,...fixture.histories.partial})
    for(const [i,item]of bundle.bundle.cases.entries()){
      closedObject(item,["name","descriptorSha256","proofSha256","resources","normalTerminal","state","reason"])
      if(item.name!==expected[i].name||item.descriptorSha256!==descriptorHash(expected[i].frames)||
        item.state!=="refused"||item.normalTerminal!==false||item.resources.serverExited!==true)fail("restored_cases")
      const proof=await protectedProofJSON(path.join(root,`${prefix}-${item.name}.json`))
      if(typeof proof.resources.stdout!=="string"){
        const ref=proof.resources.stdout,expectedFile=path.join(root,`${prefix}-${item.name}-stdout.ndjson`)
        if(ref.path!==expectedFile)fail("restored_output_path")
        const stat=await safeCatalogPath(expectedFile)
        if(stat.size!==ref.bytes||stat.size>16777216)fail("restored_output_limit")
        if(catalogHash(await readProtectedBytes(expectedFile,16777216))!==ref.sha256)fail("restored_output")
      }
      if(proof.state!==item.state||proof.descriptorSha256!==item.descriptorSha256||proof.normalTerminal!==false||
        wireProofHash(proof)!==item.proofSha256||
        catalogCanonical(wireProofResources(proof.resources))!==catalogCanonical(item.resources))fail("restored_case_proof")
    }
    directBundles.set(bundle,catalogHash(JSON.stringify(bundle)))
  }
  directRuns.set(bundle,catalogHash(JSON.stringify(bundle)))
  return true
}

const realLifecycle=Object.freeze({readBytes:file=>fs.readFile(file),source:ownedSourceIdentity,
  verifyModules:verifyModuleClosure,observe:observeOwnedServer,openControl:openSafe,writeControl:boundedFdWrite,
  pump:fifoPump,live:ownedPidLive,closeFd:close,registry:trustedCustody,requireObservations:true})
async function runOwnedCatalogLifecycle({nativeChild,launch,receiptFd,receiptHandle,controlPath,deadline,clock=Date.now},context=realLifecycle) {
  // The direct client and native path share this receipt/provenance controller.
  const receipts=[],observations=[],snapshot=JSON.parse(await context.readBytes(launch.identity.bootstrap.snapshotFile))
  const sourceBefore=await context.source()
  let error=null,observation=null,control=null,terminal=false,moduleClosure=null,bootWork=null
  const controlFrames=[]
  const resources={initialReceiptZeroRead:false,fdsClosed:false,launcherExit:null,serverExited:false}
  let bootResolve,bootReject;const boot=new Promise((r,j)=>{bootResolve=r;bootReject=j})
  // Caller awaits boot immediately; retain rejection handler during startup.
  boot.catch(()=>{})
  const onFailure=e=>{error??=e;bootReject(e)}
  let observedSequence=0,launcherObserved=false
  const pump=context.pump({fd:receiptFd,deadline,maxFrame:393216,maxBytes:2097152,maxFrames:24,onFailure,
    async onFrame(frame){
      if(!verifyReceipt(frame,snapshot.receipt_key)||frame.version!==1||frame.generation!==snapshot.generation||
        frame.catalog_sha256!==catalogHash(catalogCanonical(snapshot.records))||frame.brief_sha256!==catalogHash(catalogCanonical(snapshot.brief)))fail("receipt_invalid")
      if(frame.event==="observation"){
        validateCatalogObservation(frame.payload)
        const boot=receipts[0]
        if(!boot||frame.server_pid!==boot.server_pid)fail("observation_identity")
        if(frame.payload.kind==="launcher_exit"){
          if(launcherObserved||frame.sequence!==1||frame.payload.pid!==boot.payload.launcher_pid||context.live(boot.server_pid))fail("observation_identity")
          launcherObserved=true
        }else if(launcherObserved||frame.sequence!==++observedSequence||observedSequence>16||frame.payload.pid!==boot.server_pid)fail("observation_identity")
        observations.push(frame);return
      }
      // Every later receipt comes from the one bootstrapped server; a
      // replacement in the same generation never continues the session.
      if(frame.sequence!==receipts.length+1||(receipts.length&&frame.server_pid!==receipts[0].server_pid))fail("receipt_invalid")
      const expectedEvent=receipts.length===0?"bootstrap":receipts.length===1?"submit":"terminal"
      if(frame.event!==expectedEvent)fail(`receipt_sequence_${frame.event}_${expectedEvent}`)
      receipts.push(frame)
      if(frame.event==="bootstrap"){
        if(frame.payload.snapshot_sha256!==launch.identity.bootstrap.expectedSha256)fail("bootstrap_hash")
        if(frame.payload.uid!==launch.identity.uid||frame.payload.euid!==launch.identity.euid||
          frame.payload.env_version!==2||frame.payload.cwd!==launch.cwd)fail("bootstrap_identity")
        // Start observation asynchronously; receipt drainage never awaits ps,
        // dependency hashing or control connection.
        bootWork=(async()=>{
          moduleClosure=await context.verifyModules(frame.payload.module_closure)
          observation=await context.observe({launcherPid:frame.payload.launcher_pid,serverPid:frame.server_pid,
            nativePid:launch.nativePid,generation:snapshot.generation,expected:{...launch.identity,launchArgs:launch.args.slice(launch.args.indexOf("--entry"))}})
          if(!observation.ok)fail(observation.reason)
          if(error||resources.fdsClosed)fail("lifecycle_aborted")
          const acquired=await context.openControl(controlPath,"fifo",C.O_WRONLY|C.O_NONBLOCK,deadline)
          if(error||resources.fdsClosed){await acquired.handle.close();fail("lifecycle_aborted")}
          control=acquired
          const wire=catalogCanonical({event:"ready",generation:snapshot.generation,server_pid:frame.server_pid})+"\n"
          await context.writeControl(control.handle.fd,wire,deadline);controlFrames.push(wire)
          bootResolve(frame)
        })().catch(onFailure)
      }else if(frame.event==="terminal"){
        if(frame.payload.reason!=="stdin_eof"||frame.payload.final_sequence!==frame.sequence)fail("terminal_invalid")
        terminal=true
      }
    }})
  const timer=setTimeout(()=>onFailure(new Error("lifecycle_timeout")),Math.max(1,deadline-clock()-1000))
  const closeOwned=async()=>{
    if(resources.fdsClosed)return
    resources.fdsClosed=true
    await pump.stop()
    if(receiptHandle)await receiptHandle.close();else await context.closeFd(receiptFd)
    if(control)await control.handle.close()
  }
  return {boot,receipts,observations,resources,
    snapshot:()=>({receipts:[...receipts],observations:[...observations],observation,module_closure_sha256:moduleClosure?catalogHash(catalogCanonical(moduleClosure)):null,
      control_frames:[...controlFrames],receipt_pump:pump.diagnostic?.()??null,terminal,error:error?.message??null,resources}),
    fail:onFailure,
    async finish(){
      if(control&&!terminal){
        try{const wire=catalogCanonical({event:"finish",generation:snapshot.generation,server_pid:receipts[0].server_pid})+"\n"
          await context.writeControl(control.handle.fd,wire,deadline);controlFrames.push(wire)}
        catch(e){if(e.code!=="EPIPE")onFailure(e)}
      }
    },
    async complete(){
      while(!terminal&&!error&&clock()<deadline-1000)await sleep(10)
      if(bootWork)await bootWork
      if(terminal&&!error&&observation?.ok){
        const serverPid=observation.identity.server.pid
        while(context.live(serverPid)&&!error&&clock()<deadline-1000)await sleep(10)
        resources.server_exit_observed=!context.live(serverPid)
        const beforeEOF=pump.status().zeroReads
        while(resources.server_exit_observed&&pump.status().zeroReads===beforeEOF&&!error&&clock()<deadline-1000)await sleep(10)
        resources.receipt_eof_after_server_exit=resources.server_exit_observed&&pump.status().zeroReads>beforeEOF
        if(!resources.receipt_eof_after_server_exit)onFailure(Error("receipt_close_unproven"))
      }
      if(context.requireObservations&&!error&&(!launcherObserved||
        observations.find(x=>x.payload.kind==="launcher_exit").payload.code!==0||
        observations.find(x=>x.payload.kind==="launcher_exit").payload.signal!==null||
        !["input_frame","output_frame"].every(kind=>observations.some(x=>x.payload.kind===kind))))onFailure(Error("observation_missing"))
      clearTimeout(timer)
      resources.initialReceiptZeroRead=pump.status().zeroReads>0
      await closeOwned()
      if(error||!terminal||pump.status().partial||!observation?.ok)return {state:"failed",reason:error?.message??"terminal_missing",resources}
      const sourceAfter=await context.source()
      if(catalogCanonical(sourceBefore)!==catalogCanonical(sourceAfter)||
        catalogHash(await context.readBytes(launch.identity.bootstrap.snapshotFile))!==launch.identity.bootstrap.expectedSha256)fail("source_changed")
      await context.verifyModules(moduleClosure)
      const custody={receipts,observations,observation:{...observation,ok:true},moduleClosure,sourceCustodyUnchanged:true,sourceIdentity:sourceAfter,
        briefSha256:catalogHash(catalogCanonical(snapshot.brief)),snapshotSha256:launch.identity.bootstrap.expectedSha256,launchIdentity:structuredClone(launch)}
      context.registry.set(custody,{seal:catalogCanonical(custody),records:snapshot.records})
      return {state:"closed",custody,resources}
    },
    async abort(){onFailure(new Error("lifecycle_aborted"));clearTimeout(timer);await closeOwned();
      if(bootWork)await bootWork
      if(nativeChild&&!nativeChild.killed)nativeChild.kill("SIGTERM")},
  }
}
/** Fixed synthetic controller transaction. No OS/fd operation, real custody
 * map, qualification store or actual launch is reachable from this facade. */
export async function runNonacceptedLifecycleTransaction(config){
  closedObject(config,["snapshot","launch","frames","mode"])
  const {snapshot,launch,frames,mode}=JSON.parse(catalogCanonical(config))
  if(!["normal","abort","abortKilled","abortAbsent","deadline","source","snapshot","modules","lateModules","observe",
    "abortObserve","abortOpen","finishNormal","finishEpipe","finishOther","noReceiptEOF","serverPending","partial","noTerminal","observationRequired"].includes(mode))fail("unit_mode")
  const registry=new WeakMap(),statistics={actualFdOperations:0,actualLaunches:0,closed:0,killed:0,registered:0}
  let controller,reads=0,sources=0,modules=0,liveness=0,zeroReads=0,clockReads=0,releaseTerminal
  const deadline=Date.now()+1100
  const context={
    registry,requireObservations:mode==="observationRequired",
    async readBytes(){reads++;return Buffer.from(catalogCanonical(snapshot)+(mode==="snapshot"&&reads>1?" ":""))},
    async source(){sources++;return {unit:sources>1&&mode==="source"?"changed":"nonaccepted"}},
    async verifyModules(value){modules++;if(mode==="modules"||mode==="lateModules"&&modules>1)throw Error("unit_module_changed");return structuredClone(value)},
    async observe(){
      if(mode==="abortObserve")controller.fail(Error("unit_aborted"))
      return {ok:mode!=="observe",reason:"unit_observation_failed",identity:{server:{pid:500001}}}
    },
    async openControl(){
      if(mode==="abortOpen")controller.fail(Error("unit_aborted"))
      return {handle:{fd:-1,async close(){statistics.closed++}}}
    },
    async writeControl(_fd,bytes){
      if(JSON.parse(bytes).event==="finish"){
        releaseTerminal()
        if(["finishEpipe","finishOther"].includes(mode))throw Object.assign(Error("unit_control_write"),{code:mode==="finishEpipe"?"EPIPE":"EIO"})
      }
    },
    pump(options){
      let stopped=false,count=0
      const done=(async()=>{
        await sleep(1)
        if(mode==="deadline")return
        try{
          for(const frame of frames){
            if(stopped)break
            if(frame.event==="terminal"){
              if(mode==="noTerminal")continue
              if(["finishNormal","finishEpipe","finishOther"].includes(mode))await new Promise(resolve=>{releaseTerminal=resolve})
            }
            await options.onFrame(frame);count++
          }
        }catch(e){options.onFailure(e)}
      })()
      return {done,async stop(){stopped=true;await done},status(){
        return {partial:mode==="partial"?1:0,total:0,count,zeroReads:mode==="noReceiptEOF"?0:++zeroReads}
      }}
    },
    live(){return mode==="serverPending"&&++liveness<=2},
    async closeFd(){statistics.closed++},
  }
  const nativeChild=mode==="abortAbsent"?undefined:{killed:mode==="abortKilled",kill(){statistics.killed++;this.killed=true}}
  controller=await runOwnedCatalogLifecycle({launch,deadline,receiptFd:-1,
    receiptHandle:mode==="normal"?{async close(){statistics.closed++}}:undefined,
    controlPath:"unit-memory-only",nativeChild,
    clock:()=>++clockReads>1&&["noTerminal","noReceiptEOF"].includes(mode)?deadline-999:Date.now()},context)
  let outcome
  try{
    await controller.finish()
    if(mode.startsWith("abort")&&!["abortObserve","abortOpen"].includes(mode))await controller.abort()
    else if(mode!=="deadline")await controller.boot.catch(()=>{})
    await controller.finish()
    outcome=await controller.complete()
    await controller.abort()
    statistics.registered=outcome.custody&&registry.has(outcome.custody)?1:0
  }catch(e){await controller.abort();outcome={state:"failed",reason:e.message}}
  return {authority:false,outcome,statistics,evidence:controller.snapshot()}
}
export function boundClient(child,history,trace={version:2,events:[],bytes:0,truncated:false}) {
  const buffer=new ReadBuffer()
  const offsets={client_to_server:0,server_to_client:0}
  const observe=(event,direction,chunk,extra={})=>{
    const bytes=chunk?Buffer.from(chunk):Buffer.alloc(0),offset=offsets[direction]
    offsets[direction]+=bytes.length
    if(trace.events.length>=1024||trace.bytes+bytes.length>CATALOG_LIMITS.incomingBytes){trace.truncated=true;return}
    trace.bytes+=bytes.length
    trace.events.push({event,direction,pid:child.pid??null,generation:trace.generation??null,at_ms:Date.now(),offset,bytes:bytes.length,
      observation:bytes.length?"present":"observed_absent",sha256:catalogHash(bytes),base64:bytes.toString("base64"),...extra})
  }
  return {async start(){
    child.stdout.on("data",chunk=>{observe("read","server_to_client",chunk);try{buffer.append(chunk);let value;while((value=buffer.readMessage())!==null)this.onmessage?.(value)}catch(e){observe("parser_error","server_to_client",null,{error:e.message});this.onerror?.(e)}})
    child.stdout.on("error",e=>{observe("read_error","server_to_client",null,{error:e.message});this.onerror?.(e)})
    child.on("close",(code,signal)=>{observe("close","server_to_client",null,{code,signal});this.onclose?.()})
  },send(message){const wire=serializeMessage(message);history.push(JSON.parse(wire));observe("write","client_to_server",wire)
    return new Promise((resolve,reject)=>{
      const flowing=child.stdin.write(wire,e=>{observe("write_complete","client_to_server",null,{error:e?.message??null});if(e)reject(e);else resolve()})
      observe("backpressure","client_to_server",null,{blocked:!flowing})
    })},
  async close(){child.stdin.end()}}
}
export async function prepareOwnedCatalogRun({inputDir,runDir,deadline}) {
  if(typeof nodeModule.registerHooks!=="function")fail("runtime_provenance_unsupported")
  if(!Number.isSafeInteger(deadline)||deadline-Date.now()<=1000)fail("run_deadline")
  const prepared=await readTriagePreparedFile({inputDir})
  await assertOutsideGitWorkspace(runDir,{label:"triage catalog",subject:"run"})
  if(await fs.realpath(path.dirname(runDir))!==path.dirname(runDir))fail("run_parent")
  await fs.mkdir(runDir,{mode:0o700});await safeCatalogPath(runDir,"directory",0o700)
  const generation=randomBytes(32).toString("hex"),snapshotFile=path.join(runDir,"catalog.json"),
    receiptFifo=path.join(runDir,"receipt.fifo"),readyFifo=path.join(runDir,"control.fifo")
  const catalog=prepareTriageCatalog({...prepared,generation})
  await fs.writeFile(snapshotFile,catalog.snapshotBytes,{mode:0o600,flag:"wx"})
  await osCapture("/usr/bin/mkfifo",["-m","600",receiptFifo,readyFifo],deadline)
  const reader=await openSafe(receiptFifo,"fifo",C.O_RDONLY|C.O_NONBLOCK,deadline)
  let launch
  try{launch=ownedServerLaunch({...ownedCatalogEntries(),bootstrap:{snapshotFile,expectedSha256:catalog.snapshotSha256,generation,receiptFifo,readyFifo},deadline})}
  catch(e){await reader.handle.close();throw e}
  let closed=false
  return {prepared,catalog,generation,launch,reader,runDir,
    async close(){if(closed)return;closed=true;await reader.handle.close()},
    async verifyPrepared(){const current=await readTriagePreparedFile({inputDir})
      return current.sha256===prepared.sha256&&catalogCanonical(current.identity)===catalogCanonical(prepared.identity)},
  }
}
const realNativeRun=Object.freeze({lifecycle:runOwnedCatalogLifecycle,stat:fsNative.lstatSync,bytes:fsNative.readFileSync,
  materialize:materializeTriageSubmission,registry:nativeRuns})
export async function runOwnedCatalogNative(options) {
  return runNativeTransaction(options,realNativeRun)
}
async function runNativeTransaction({owned,command,args,env,deadline,resultFile,onChild,onChildExit,spawn:spawnNative=spawn},context) {
    let child,lifecycle,closed=false,ownsPID=false,exitCode=null,signal=null,nativeError=null,stdout="",stderr="",partial="",total=0,successSeen=false,cost=null,budgetExceeded=false
    let timer,hard
    const decoder=new TextDecoder("utf-8",{fatal:true})
    const resources={runDir:owned.runDir,pids:[],exited_pids:[],native_exit:null}
    let outcome,spawnAttempted=false,bootSeen=false,initSeen=false,stderrTotal=0,stderrKept=0
    let argumentText,configText,settingsText,captureFailure=null,snapshot=null,snapshotObserved=false
    const stages=[]
    const stage=(name,observation)=>stages.push({name,observation,at_ms:Date.now()})
    const stderrBuffer=Buffer.alloc(65536),stdoutBuffer=Buffer.alloc(1048576)
    let stdoutKept=0
    const returned=value=>(outcome=value)
    const rejectStartup=detail=>{nativeError??=new Error(detail);lifecycle.fail(nativeError);if(ownsPID&&!closed)child.kill("SIGTERM")}
    const captured=(text,observed,limit,truncated=false)=>{
      if(!observed||typeof text!=="string"&&!Buffer.isBuffer(text))return {observation:"unobserved",truncated,reason:"not_observed"}
      const bytes=Buffer.isBuffer(text)?text:Buffer.from(text),kept=bytes.subarray(0,limit)
      return {observation:bytes.length?"present":"observed_absent",bytes:kept.length,sha256:catalogHash(kept),truncated:truncated||bytes.length>limit}
    }
    const observeSnapshot=()=>{
      if(snapshotObserved)return
      snapshotObserved=true
      if(!lifecycle?.snapshot)return
      try{
        const value=lifecycle.snapshot(),text=catalogCanonical(value)
        // Fixed private capture bounds; no arbitrary snapshot properties or
        // unbounded stage/resource arrays can escape into an evidence bundle.
        closedObject(value,["receipts","observation","resources"],["observations","module_closure_sha256","control_frames","receipt_pump","terminal","error"])
        if(value.observations!==undefined&&(!Array.isArray(value.observations)||value.observations.length>17))fail("native_capture_limit")
        if(Buffer.byteLength(text)>6291456||!Array.isArray(value.receipts)||value.receipts.length>4||
          Object.keys(value.resources).length>64||value.control_frames&&value.control_frames.length>64)fail("native_capture_limit")
        if(value.receipt_pump){
          const raw=Buffer.from(value.receipt_pump.raw_base64??"","base64")
          if(raw.length>2097152)fail("native_capture_limit")
        }
        snapshot=JSON.parse(text)
      }catch{captureFailure="lifecycle_capture"}
    }
    try{
      stage("prepare_invocation","present")
      try{
        argumentText=JSON.stringify({command,args,cwd:owned.runDir})
        configText=args.includes("--mcp-config")?args[args.indexOf("--mcp-config")+1]:undefined
        settingsText=args.includes("--settings")?args[args.indexOf("--settings")+1]:undefined
      }catch{captureFailure="argv_serialization";fail("native_capture_invalid")}
      if(!await owned.verifyPrepared())fail("prepared_changed")
      stage("prepared_verification","present")
      if(Buffer.byteLength(argumentText)>65536||[configText,settingsText].some(v=>typeof v==="string"&&Buffer.byteLength(v)>65536))fail("native_capture_limit")
      lifecycle=await context.lifecycle({launch:owned.launch,receiptFd:owned.reader.handle.fd,receiptHandle:owned.reader.handle,
        controlPath:owned.launch.identity.bootstrap.readyFifo,deadline})
      stage("lifecycle","present")
      // Last prepared check is synchronous, with no yield before spawning.
      const before=context.stat(owned.prepared.path)
      if(before.dev!==owned.prepared.identity.dev||before.ino!==owned.prepared.identity.ino||
        catalogHash(context.bytes(owned.prepared.path))!==owned.prepared.sha256)fail("prepared_changed")
      spawnAttempted=true
      stage("spawn_attempt","present")
      child=spawnNative(command,args,{env,cwd:owned.runDir,shell:false,stdio:["ignore","pipe","pipe"]})
      ownsPID=Number.isSafeInteger(child.pid)&&child.pid>0
      // A failed spawn can expose a zero/unowned native process handle before
      // its next-tick error event. Observe error/close immediately; never
      // signal that handle or record an invented PID generation.
      child.on("error",e=>{nativeError=e;lifecycle.fail(e)})
      child.on("close",(code,s)=>{
        try{stdout+=decoder.decode()}catch{nativeError=new Error("native_bad_utf8");lifecycle.fail(nativeError)}
        closed=true;exitCode=code;signal=s
        if(!bootSeen)rejectStartup("bootstrap_unestablished")
        if(ownsPID){resources.exited_pids.push(child.pid);onChildExit?.(child.pid)}
      })
      if(!ownsPID)fail("native_pid_unknown")
      owned.launch.nativePid=child.pid
      resources.pids.push(child.pid);onChild?.(child.pid)
      timer=setTimeout(()=>{nativeError=new Error("native_timeout");child.kill("SIGTERM");lifecycle.fail(nativeError)},Math.max(1,deadline-Date.now()-1000))
      hard=setTimeout(()=>{if(!closed){child.kill("SIGKILL");child.stdout.destroy();child.stderr.destroy()}},Math.max(1,deadline-Date.now()))
      child.stdout.on("data",chunk=>{
        const kept=Math.min(chunk.length,stdoutBuffer.length-stdoutKept)
        chunk.copy(stdoutBuffer,stdoutKept,0,kept);stdoutKept+=kept
        total+=chunk.length
        if(total>1048576){nativeError=new Error("native_output_limit");child.kill("SIGTERM");lifecycle.fail(nativeError);return}
        let text
        try{text=decoder.decode(chunk,{stream:true})}
        catch{nativeError=new Error("native_bad_utf8");child.kill("SIGTERM");lifecycle.fail(nativeError);return}
        stdout+=text;partial+=text
        const lines=partial.split("\n");partial=lines.pop()
        for(const line of lines)if(line){
          try{
            const value=JSON.parse(line)
            if(value.type==="system"&&value.subtype==="init"){
              if(!initSeen)stage("native_init","present")
              const detail=initSeen?"native_manifest_mismatch":nativeManifestDetail(value)
              if(detail)rejectStartup(detail)
              initSeen=true
            }
            if(value.type==="result"){
              cost=Number.isFinite(value.total_cost_usd)&&value.total_cost_usd>=0?value.total_cost_usd:null
              if(value.subtype==="success"&&value.is_error===false){
                if(!bootSeen)rejectStartup("bootstrap_unestablished")
                else if(!initSeen)rejectStartup("native_manifest_mismatch")
                else {successSeen=true;lifecycle.finish().catch(lifecycle.fail)}
              }
              else{
                // Pinned native error-result discriminator, never prose or a
                // substring. Malformed/cost-unvalidated terminals stay failed.
                budgetExceeded=value.subtype==="error_max_budget_usd"&&value.is_error===true&&cost!==null
                nativeError=new Error(budgetExceeded?"native_budget_exceeded":"native_failed")
                lifecycle.fail(nativeError);child.kill("SIGTERM")
              }
            }
          }catch{nativeError=new Error("native_bad_stream");lifecycle.fail(nativeError);child.kill("SIGTERM")}
        }
      })
      child.stderr.on("data",chunk=>{
        stderrTotal+=chunk.length
        const count=Math.min(chunk.length,65536-stderrKept)
        chunk.copy(stderrBuffer,stderrKept,0,count);stderrKept+=count
        if(stderrTotal<=65536)stderr+=chunk
        else{nativeError=new Error("native_stderr_limit");child.kill("SIGTERM");lifecycle.fail(nativeError)}
      })
      child.on("exit",(code,s)=>{exitCode=code;signal=s;if(!bootSeen)rejectStartup("bootstrap_unestablished");else if(code===0)lifecycle.finish().catch(lifecycle.fail);else lifecycle.fail(new Error("native_exit"))})
      await lifecycle.boot
      bootSeen=true
      stage("authenticated_bootstrap","present")
      const done=await lifecycle.complete()
      Object.assign(resources,done.resources)
      while(!closed&&Date.now()<deadline)await sleep(10)
      clearTimeout(timer);clearTimeout(hard)
      resources.native_exit={code:exitCode,signal,stdio_closed:closed}
      const stream={kind:closed?"closed":"timeout",code:exitCode,stdout,truncated:total>1048576}
      if(nativeError||!closed||exitCode!==0||signal||!successSeen||!initSeen||done.state!=="closed"||!await owned.verifyPrepared())return returned({
        state:nativeError?.message==="native_timeout"||!closed?"timeout":budgetExceeded?"budget_exceeded":"failed",
        cost_usd:cost,reason:"diagnostic_inadequate",detail:nativeError?.message??done.reason??"native_incomplete",stream,resources})
      observeSnapshot()
      if(captureFailure)fail("native_capture_invalid")
      const materialized=await context.materialize({custody:done.custody,nativeStream:stream,brief:owned.prepared.brief,resultFile})
      const run={...materialized,stream,custody:done.custody,resources,
        invocation:{command,args,cwd:owned.runDir,parent_env_sha256:catalogHash(catalogCanonical(env)),owned_launch:owned.launch,
          prepared_sha256:owned.prepared.sha256,catalog_sha256:owned.catalog.catalogSha256,brief_sha256:owned.catalog.briefSha256,record_refs_sha256:owned.catalog.recordRefsSha256},
        snapshotFile:owned.launch.identity.bootstrap.snapshotFile,cost_usd:cost}
      return returned(run)
    }catch(e){
      if(child&&!closed&&ownsPID)child.kill("SIGTERM")
      try{if(lifecycle)await lifecycle.abort();else await owned.close()}catch(cleanup){resources.cleanup_error=cleanup.message}
      return returned({state:nativeError?.message==="native_timeout"?"timeout":budgetExceeded?"budget_exceeded":"scope_unqualified",
        cost_usd:cost,reason:"diagnostic_inadequate",detail:nativeError?.message??e.message,stream:{kind:"failed",stdout,truncated:total>1048576},resources})
    }finally{
      // A rejected bootstrap must not return before its owned native process
      // has been reaped; timers belong to every path, not just normal closure.
      if(child&&!closed){
        if(ownsPID)child.kill("SIGTERM")
        while(!closed&&Date.now()<deadline-500)await sleep(10)
        if(!closed&&ownsPID){child.kill("SIGKILL");child.stdout.destroy();child.stderr.destroy()}
        while(!closed&&Date.now()<deadline)await sleep(10)
      }
      clearTimeout(timer);clearTimeout(hard)
      resources.native_exit={code:exitCode,signal,stdio_closed:closed}
      {
        // Every try/catch exit uses returned(); snapshot all of them, including
        // pre-spawn failures rather than conditioning evidence on success.
        observeSnapshot()
        stage("teardown",closed||!spawnAttempted?"present":"unobserved")
        // Successful materialization checked capture above; failed paths
        // retain their first refusal and record capture failure separately.
        if(captureFailure)delete outcome.resultFile
        const receiptText=snapshot?.receipt_pump?.raw_base64
        const receiptBytes=typeof receiptText==="string"?Buffer.from(receiptText,"base64"):undefined
        const lifecycleText=snapshot?catalogCanonical(Object.fromEntries(Object.entries(snapshot).filter(([key])=>!["receipts","receipt_pump"].includes(key)))):undefined
        outcome.evidence={version:1,spawn_attempted:spawnAttempted,spawned:ownsPID,bootstrap:bootSeen?"present":"unobserved",init:initSeen?"present":"unobserved",
          capture_failure:captureFailure,stages,
          channels:{argv:captured(argumentText,spawnAttempted,65536),config:captured(configText,spawnAttempted&&args.includes("--mcp-config"),65536),
            settings:captured(settingsText,spawnAttempted&&args.includes("--settings"),65536),
            stderr:captured(stderrBuffer.subarray(0,stderrKept),Boolean(child)&&(closed||stderrKept>0),65536,stderrTotal>65536||Boolean(child)&&!closed),
            stdout:captured(stdoutBuffer.subarray(0,stdoutKept),Boolean(child)&&(closed||stdoutKept>0),1048576,total>1048576||Boolean(child)&&!closed),
            lifecycle:captured(lifecycleText,snapshot!==null,65536),
            receipts:captured(receiptBytes,receiptBytes!==undefined,2097152,snapshot?.receipt_pump?.truncated??false)},
          argv_base64:spawnAttempted?Buffer.from(argumentText).subarray(0,65536).toString("base64"):null,
          config_base64:spawnAttempted&&args.includes("--mcp-config")&&typeof configText==="string"?Buffer.from(configText).subarray(0,65536).toString("base64"):null,
          settings_base64:spawnAttempted&&args.includes("--settings")&&typeof settingsText==="string"?Buffer.from(settingsText).subarray(0,65536).toString("base64"):null,
          stderr_base64:child?stderrBuffer.subarray(0,stderrKept).toString("base64"):null,
          stdout_base64:child?stdoutBuffer.subarray(0,stdoutKept).toString("base64"):null,
          receipts_base64:receiptBytes?.toString("base64")??null,lifecycle:snapshot,resources}
        if(outcome.state==="ran")context.registry.set(outcome,catalogHash(catalogCanonical(outcome)))
      }
    }
}
/** Fixed synthetic child, source and materializer. These adapters terminate in
 * memory, and the registry is fresh NONACCEPTED state, never nativeRuns. */
export async function runNonacceptedNativeTransaction(config){
  closedObject(config,["mode"])
  const {mode}=JSON.parse(catalogCanonical(config))
  if(!["normal","lateClose","noCost","emptyLines","stderrSmall","prepareChanged","statDev","statIno","statHash",
    "lifecycleThrows","spawnThrows","pidUnknown","outputLimit","badUTF8","badJSON","resultFailure","stderrLimit","childError",
    "closeBadUTF8","softTimeout","hardTimeout","noClose","timerAfterClose","noSuccess","nonzeroExit","signalExit","preparedFinal",
    "materializeRefused","completeThrows","abortStuck","finishReject",
    "budget","budgetZero","budgetBadCost","budgetNegativeCost","budgetMissingCost","budgetWrongError","budgetProse","budgetCompleteThrows",
    "emptyInit","emptyInitStderr","closedBeforeBoot","successBeforeBoot","initMissing","initExtra","initDuplicate","successNoInit","argvLimit","abortThrows","configCapture","settingsCapture",
    "argvSerializationThrows","snapshotThrows","snapshotCircular","snapshotOverflow","snapshotTextLimit","snapshotReceiptShape","snapshotReceiptCount",
    "snapshotResourcesLimit","snapshotControlFramesLimit","snapshotObservationShape","snapshotObservationLimit","snapshotPumpLimit","snapshotPumpEmpty","emptyInitSnapshotThrows"].includes(mode))fail("unit_mode")
  const registry=new WeakMap(),statistics={actualLaunches:0,actualFileOperations:0,closed:0,signals:[],registered:false}
  const child=new EventEmitter()
  Object.assign(child,{pid:mode==="pidUnknown"?0:500003,stdout:new PassThrough(),stderr:new PassThrough()})
  let exited=false,verifyReads=0,error,completeResolve
  const result=()=>({state:error?"failed":"closed",reason:mode==="nonzeroExit"?"unit_exit":undefined,custody:{unit:true},resources:{}})
  const complete=new Promise(resolve=>{completeResolve=resolve})
  const finish=()=>{
    if(mode==="finishReject")return Promise.reject(Error("unit_finish_rejected"))
    if(mode==="lateClose")completeResolve(result())
    return Promise.resolve()
  }
  let rejectBoot
  const pendingBoot=["emptyInit","emptyInitStderr","emptyInitSnapshotThrows","closedBeforeBoot","successBeforeBoot","abortThrows","configCapture","settingsCapture"].includes(mode)
  const boot=pendingBoot?new Promise((_resolve,reject)=>{rejectBoot=reject}):Promise.resolve()
  boot.catch(()=>{})
  const lifecycle={boot,finish,fail(e){error=e;rejectBoot?.(e);if(mode!=="timerAfterClose")completeResolve(result())},
    snapshot(){
      if(mode==="snapshotThrows"||mode==="emptyInitSnapshotThrows")throw Error("unit_snapshot_failed")
      if(mode==="snapshotCircular"){const x={};x.self=x;return x}
      return {receipts:mode==="snapshotReceiptShape"?null:mode==="snapshotReceiptCount"?Array(5).fill({}):[],observation:null,
        resources:mode==="snapshotTextLimit"?{large:"x".repeat(6291457)}:mode==="snapshotResourcesLimit"?Object.fromEntries(Array.from({length:65},(_,i)=>[i,0])):{},
        ...(mode==="snapshotControlFramesLimit"?{control_frames:Array(65).fill("")}:{}),
        ...(mode==="snapshotObservationShape"?{observations:{}}:mode==="snapshotObservationLimit"?{observations:Array(18).fill({})}:{}),
        ...(mode==="snapshotPumpLimit"?{receipt_pump:{raw_base64:Buffer.alloc(2097153).toString("base64")}}:{}),
        ...(mode==="snapshotPumpEmpty"?{receipt_pump:{}}:{}),
        ...(mode==="snapshotOverflow"?{extra:"x".repeat(2097153)}:{})}
    },
    async complete(){if(["completeThrows","abortStuck"].includes(mode))throw Error("unit_complete_failed");await complete;
      if(mode==="budgetCompleteThrows")throw Error("unit_complete_failed");return result()},
    async abort(){error=Error("unit_abort");completeResolve(result());if(mode==="abortThrows")throw Error("unit_abort_failed")}}
  const closeChild=(code=0,signal=null)=>{
    if(exited)return
    exited=true;child.emit("exit",code,signal);child.emit("close",code,signal)
    if(mode!=="timerAfterClose")completeResolve(result())
  }
  child.kill=signal=>{
    statistics.signals.push(signal)
    if(mode!=="noClose"&&(!["hardTimeout","abortStuck"].includes(mode)||signal==="SIGKILL"))queueMicrotask(()=>closeChild(1))
    return true
  }
  const deadline=Date.now()+1100
  const bytes=Buffer.from("unit-prepared")
  const owned={runDir:"/unit/nonaccepted",reader:{handle:{fd:-1}},prepared:{path:"unit-memory",identity:{dev:1,ino:1},
      sha256:catalogHash(bytes),brief:{unit:true}},
    launch:{identity:{bootstrap:{readyFifo:"unit-control",snapshotFile:"unit-snapshot"}}},
    catalog:{catalogSha256:"unit",briefSha256:"unit",recordRefsSha256:"unit"},
    async verifyPrepared(){verifyReads++;return mode!=="prepareChanged"&&!(mode==="preparedFinal"&&verifyReads>1)},
    async close(){statistics.closed++}}
  const context={registry,
    async lifecycle(){if(mode==="lifecycleThrows")throw Error("unit_lifecycle_failed");return lifecycle},
    stat:()=>({dev:mode==="statDev"?2:1,ino:mode==="statIno"?2:1}),
    bytes:()=>mode==="statHash"?Buffer.from("changed"):bytes,
    async materialize(){return {state:mode==="materializeRefused"?"scope_unqualified":"ran",authority:false}},
  }
  let emission,late
  const spawnSynthetic=()=>{
    if(mode==="spawnThrows")throw Error("unit_spawn_failed")
    emission=setTimeout(()=>{
      if(mode==="pidUnknown"){child.emit("error",Error("unit_failed_spawn"));closeChild(1);return}
      if(mode==="closedBeforeBoot"){closeChild(0);return}
      if(mode==="successBeforeBoot"){
        child.stdout.write('{"type":"result","subtype":"success","is_error":false}\n')
        closeChild(0);return
      }
      if(["emptyInit","emptyInitStderr","emptyInitSnapshotThrows","abortThrows","configCapture","settingsCapture"].includes(mode)){
        if(mode==="emptyInitStderr")child.stderr.write("unit-bounded-stderr")
        child.stdout.write('{"type":"system","subtype":"init","tools":[],"mcp_servers":[]}\n')
        closeChild(0);return
      }
      if(mode!=="successNoInit"){
        const init={type:"system",subtype:"init",
          tools:["evidence_read","evidence_search","evidence_list","candidate_submit"].map(x=>`mcp__triage_catalog__${x}`),
          mcp_servers:[{name:"triage_catalog",status:"connected"}]}
        if(mode==="initMissing")delete init.tools
        if(mode==="initExtra")init.tools.push("Bash")
        child.stdout.write(JSON.stringify(init)+"\n")
        if(mode==="initDuplicate")child.stdout.write(JSON.stringify(init)+"\n")
      }
      if(["softTimeout","hardTimeout","noClose","abortStuck"].includes(mode))return
      if(mode==="outputLimit"){child.stdout.write(Buffer.alloc(1048577));return}
      if(mode==="badUTF8"){child.stdout.write(Buffer.from([0xff]));return}
      if(mode==="badJSON"){child.stdout.write("{\n");return}
      if(mode==="resultFailure"){child.stdout.write('{"type":"result","subtype":"error","is_error":true}\n');return}
      if(mode.startsWith("budget")){
        // Actual installed 2.1.296 error-result shape, synthetic data only.
        const value={type:"result",subtype:mode==="budgetProse"?"error_budget_in_prose":"error_max_budget_usd",
          is_error:mode!=="budgetWrongError",duration_ms:1,duration_api_ms:1,num_turns:1,stop_reason:null,
          total_cost_usd:mode==="budgetBadCost"?"1.25":mode==="budgetNegativeCost"?-1:mode==="budgetZero"?0:1.25,
          usage:{input_tokens:0,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0},
          modelUsage:{},permission_denials:[],errors:["synthetic budget terminal"],
          uuid:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",session_id:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}
        if(mode==="budgetMissingCost")delete value.total_cost_usd
        child.stdout.write(JSON.stringify(value)+"\n");return
      }
      if(mode==="stderrLimit"){child.stderr.write(Buffer.alloc(65537));return}
      if(mode==="childError"){child.emit("error",Error("unit_child_failed"));closeChild(1);return}
      if(mode==="closeBadUTF8"){child.stdout.write(Buffer.from([0xf0]));closeChild(0);return}
      if(mode==="stderrSmall")child.stderr.write("unit-bounded")
      const value=mode==="noSuccess"?{type:"system"}:{type:"result",subtype:"success",is_error:false,...(mode==="noCost"?{}:{total_cost_usd:0})}
      child.stdout.write((mode==="emptyLines"?"\n":"")+JSON.stringify(value)+"\n")
      if(mode==="lateClose")late=setTimeout(()=>closeChild(),20)
      else closeChild(mode==="nonzeroExit"?1:0,mode==="signalExit"?"SIGTERM":null)
      if(mode==="timerAfterClose")late=setTimeout(()=>completeResolve(result()),1110)
    },1)
    return child
  }
  let outcome
  try{
    const args=mode==="argvLimit"?["x".repeat(65537)]:mode==="configCapture"?["--mcp-config",'{"mcpServers":{}}']:mode==="settingsCapture"?["--settings","{}"]:[]
    if(mode==="argvSerializationThrows")args.toJSON=()=>{throw Error("unit_argv_serialization")}
    outcome=await runNativeTransaction({owned,command:"unit-memory-only",args,env:{},deadline,resultFile:"unit-memory-only",
      spawn:spawnSynthetic,onChild:()=>{},onChildExit:()=>{}},context)
  }finally{
    clearTimeout(emission);clearTimeout(late)
    if(!exited)closeChild(1)
    child.stdout.destroy();child.stderr.destroy()
  }
  statistics.registered=registry.has(outcome)
  return {authority:false,outcome,statistics}
}
export function authenticatedNativeRuns(runs) {
      return authenticateNativePair(runs,nativeRuns)
}
function authenticateNativePair(runs,registry) {
      if(!Array.isArray(runs)||runs.length!==2)fail("native_runs_incomplete")
      const sessions=new Set(),generations=new Set()
      for(const run of runs){
        if(run.state!=="ran"||registry.get(run)!==catalogHash(catalogCanonical(run)))fail("native_run_untrusted")
        const init=run.stream.stdout.split("\n").filter(Boolean).map(x=>JSON.parse(x)).find(x=>x.type==="system"&&x.subtype==="init")
        if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(init?.session_id)||sessions.has(init.session_id))fail("native_session_reused")
        sessions.add(init.session_id)
        const generation=run.custody.receipts[0].generation
        if(generations.has(generation))fail("native_generation_reused")
        generations.add(generation)
      }
      return true
}
/** Test-owned NONACCEPTED registry only. Never returns or writes real custody,
 * registration or qualification authority, even without instrumentation. */
export function createNonacceptedNativePair(config){
  closedObject(config,["runs"])
  const runs=JSON.parse(catalogCanonical(config.runs)),registry=new WeakMap()
  for(const run of runs)registry.set(run,catalogHash(catalogCanonical(run)))
  return Object.freeze({authority:false,runs,authenticate(value=runs){
    return {authority:false,valid:authenticateNativePair(value,registry)}
  }})
}
export {Client as CatalogClient}
export async function runCatalogWireCase({fixture,frames,deadline}) {
    const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"triage-wire-")));await fs.chmod(dir,0o700)
    const resources={dir,owner:"direct-parent",serverExited:false,pids:[],exited:[]}
    let owned,lifecycle,child,boot
    try{
      const inputDir=path.join(dir,"input");await fs.mkdir(inputDir,{mode:0o700})
      await writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
      owned=await prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline})
      lifecycle=await runOwnedCatalogLifecycle({launch:owned.launch,receiptFd:owned.reader.handle.fd,receiptHandle:owned.reader.handle,
        controlPath:owned.launch.identity.bootstrap.readyFifo,deadline})
      child=spawn(owned.launch.command,owned.launch.args,{env:owned.launch.env,cwd:owned.launch.cwd,shell:false,stdio:["pipe","pipe","pipe"]})
      resources.pids.push(child.pid)
      let stdout="",stderr="",count=0,driverFailed=false
      child.on("error",e=>{driverFailed=true;lifecycle.fail(e)})
      const responseBuffer=new ReadBuffer(),responseIDs=new Set()
      child.stdout.on("data",chunk=>{
        count+=chunk.length
        if(count>16777216){driverFailed=true;lifecycle.fail(new Error("wire_parent_output_limit"));child.kill("SIGTERM");return}
        stdout+=chunk
        try{responseBuffer.append(chunk);let value;while((value=responseBuffer.readMessage())!==null)responseIDs.add(value.id)}
        catch{driverFailed=true;lifecycle.fail(new Error("wire_response_invalid"));child.kill("SIGTERM")}
      })
      child.stderr.on("data",chunk=>{stderr+=chunk;if(Buffer.byteLength(stderr)>65536){driverFailed=true;lifecycle.fail(new Error("wire_parent_stderr_limit"));child.kill("SIGTERM")}})
      child.stdin.on("error",()=>{})
      const exited=new Promise(resolve=>child.on("close",(code,signal)=>{resources.exited.push(child.pid);resolve({code,signal})}))
      child.on("exit",code=>{if(code!==0)lifecycle.fail(new Error("launcher_exit"))})
      boot=await lifecycle.boot;resources.pids.push(boot.server_pid)
      for(const frame of frames){
        if(child.exitCode!==null||child.stdin.destroyed)break
        const wire=typeof frame==="object"&&!Buffer.isBuffer(frame)?serializeMessage(deserializeMessage(JSON.stringify(frame))):frame
        await new Promise(resolve=>child.stdin.write(wire,()=>resolve()))
        // A deterministic sequential RPC history, not a queue flood that
        // accidentally trips the earlier pending-frame guard. Raw malformed
        // byte cases have no expected response and still close immediately.
        if(typeof frame==="object"&&!Buffer.isBuffer(frame)&&Object.hasOwn(frame,"id")){
          while(!responseIDs.has(frame.id)&&child.exitCode===null&&Date.now()<deadline-1000)await sleep(10)
        }
      }
      child.stdin.end()
      const ended=await exited
      const result=await lifecycle.complete()
      resources.serverExited=!ownedPidLive(boot.server_pid);if(resources.serverExited)resources.exited.push(boot.server_pid)
      resources.stdout=stdout;resources.stderr=stderr;resources.exit=ended
      resources.observations=structuredClone(lifecycle.observations)
      const proof={state:!driverFailed&&ended.code!==0&&result.state!=="closed"&&resources.serverExited?"refused":"failed",
        descriptorSha256:descriptorHash(frames),normalTerminal:result.state==="closed",reason:result.reason,resources,cleanup:()=>fs.rm(dir,{recursive:true,force:true})}
      wireRuns.set(proof,catalogHash(JSON.stringify(proof)))
      return proof
    }catch(e){
      if(child&&!child.killed)child.kill("SIGTERM")
      if(lifecycle)await lifecycle.abort();else if(owned)await owned.close()
      await reapOwnedChild(child,deadline)
      if(lifecycle)resources.observations=structuredClone(lifecycle.observations)
      return {state:"failed",reason:e.message,normalTerminal:false,resources,cleanup:()=>fs.rm(dir,{recursive:true,force:true})}
    }
}
export async function runDirectCatalog({fixture,deadline,evidenceDir}) {
  if(typeof nodeModule.registerHooks!=="function")return {state:"scope_unqualified",reason:"runtime_provenance_unsupported",resources:{},cleanup:async()=>{}}
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"triage-direct-")))
  await fs.chmod(dir,0o700)
  const resources={dir,files:[],owner:"direct-parent",state:"preparing"}
  let fd,child,lifecycle
  try{
    const inputDir=path.join(dir,"input");await fs.mkdir(inputDir,{mode:0o700})
    await writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
    const owned=await prepareOwnedCatalogRun({inputDir,runDir:path.join(dir,"run"),deadline})
    resources.files=[owned.prepared.path,...["snapshotFile","receiptFifo","readyFifo"].map(key=>owned.launch.identity.bootstrap[key])]
    resources.runDir=owned.runDir
    const launch=owned.launch,reader=owned.reader;fd=reader.handle
    // Begin pump before spawn. The server alone will acquire the write end.
    lifecycle=await runOwnedCatalogLifecycle({launch,receiptFd:fd.fd,receiptHandle:fd,controlPath:launch.identity.bootstrap.readyFifo,deadline})
    child=spawn(launch.command,launch.args,{env:launch.env,cwd:launch.cwd,stdio:["pipe","pipe","pipe"],shell:false})
    const closed=new Promise(resolve=>child.on("close",(code,signal)=>resolve({code,signal})))
    let stderr="";child.stderr.on("data",b=>{stderr+=b;resources.stderr=stderr;if(Buffer.byteLength(stderr)>65536)child.kill("SIGTERM")})
    child.on("error",()=>lifecycle.abort())
    child.on("exit",(code)=>{if(code!==0)lifecycle.fail(new Error("launcher_exit"))})
    const boot=await lifecycle.boot
    const client=new Client({name:"claude-code",title:"Claude Code",version:"2.1.296",
      description:"Anthropic's agentic coding tool",websiteUrl:"https://code.claude.com"},
      {capabilities:{roots:{listChanged:true},elicitation:{}}})
    resources.wire=[]
    resources.trace={version:2,generation:owned.generation,events:[],bytes:0,truncated:false}
    await client.connect(boundClient(child,resources.wire,resources.trace))
    const tools=(await client.listTools()).tools,history=[],responses=[]
    const call=async(name,args,expectedError=false)=>{
      const response=await client.callTool({name,arguments:args})
      history.push({name,args});responses.push({name,ok:expectedError?response.isError===true:response.isError!==true})
      return response
    }
    await call("evidence_list",{});await call("evidence_read",{id:"r000002"});await call("evidence_search",{query:"needle",ids:["r000002"]})
    for(const c of fixture.cases)await call(c.name,c.args,true)
    const first=await call("candidate_submit",{candidate:fixture.candidate})
    const retry=await call("candidate_submit",{candidate:fixture.candidate})
    if(catalogCanonical(first)!==catalogCanonical(retry))fail("retry_changed")
    const conflict=structuredClone(fixture.candidate);conflict.results[0].problem="changed"
    await call("candidate_submit",{candidate:conflict},true)
    await lifecycle.finish();await client.close()
    const result=await lifecycle.complete(),exit=await closed
    result.resources.launcherExit=exit.code;    result.resources.serverExited=!ownedPidLive(boot.server_pid)
    if(result.state!=="closed"||exit.code!==0||!result.resources.serverExited||!responses.every(x=>x.ok))fail(result.reason??"direct_failed")
    if(!await owned.verifyPrepared())fail("prepared_changed")
    const proof={state:"proved",generation:owned.generation,tools,responses,historySha256:catalogHash(catalogCanonical(history)),custody:result.custody,
      resources:{...resources,...result.resources,stderr,state:"closed"},cleanup:()=>fs.rm(dir,{recursive:true,force:true})}
    if(evidenceDir){
      await fs.mkdir(evidenceDir,{mode:0o700})
      const archive=path.join(evidenceDir,"catalog.json")
      await fs.writeFile(archive,await fs.readFile(launch.identity.bootstrap.snapshotFile),{mode:0o600,flag:"wx"})
      proof.snapshotArchive=archive
      const {cleanup,...record}=proof
      await fs.writeFile(path.join(evidenceDir,"direct-proof.json"),catalogCanonical(record),{mode:0o600,flag:"wx"})
    }
    directRuns.set(proof,catalogHash(JSON.stringify(proof)))
    return proof
  }catch(e){
    if(child&&!child.killed)child.kill("SIGTERM")
    if(lifecycle)await lifecycle.abort()
    else if(fd)await fd.close()
    await reapOwnedChild(child,deadline)
    return {state:"failed",reason:e.message,resources,cleanup:()=>fs.rm(dir,{recursive:true,force:true})}
  }
}
