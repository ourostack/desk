#!/usr/bin/env node
// Import is inert. Direct entry checks the real environment before any
// application load, then starts this same source implementation.
import {promisify} from "node:util"
import fs from "node:fs"
import * as nodeModule from "node:module"
import {createHash} from "node:crypto"
import {fileURLToPath} from "node:url"

export function serverFirstEnvironment(runtime){
  const uid=runtime.getuid?.(),euid=runtime.geteuid?.(),expected={LANG:"C",LC_ALL:"C",TZ:"UTC"}
  if(runtime.platform==="darwin")expected.__CF_USER_TEXT_ENCODING="0x"+uid?.toString(16).toUpperCase()+":0:0"
  return Number.isSafeInteger(uid)&&uid>=0&&uid<=4294967295&&uid===euid&&
    JSON.stringify(Object.keys(runtime.env).sort())===JSON.stringify(Object.keys(expected).sort())&&
    Object.entries(expected).every(([key,value])=>runtime.env[key]===value)
}
export function catalogModuleLoad(loadedModules,root,url,context,next){
  if(url.startsWith("file:")){
    const file=fileURLToPath(url),resolved=fs.realpathSync(file)
    if(resolved!==file||!file.startsWith(root)||loadedModules.size>=512)throw Error("module_custody")
    const data=fs.readFileSync(file)
    if(data.length>16*1024*1024)throw Error("module_custody")
    loadedModules.set(file,{path:file,sha256:createHash("sha256").update(data).digest("hex"),bytes:data.length})
  }
  return next(url,context)
}
export async function startCatalogServer(runtime=process){
  if(!serverFirstEnvironment(runtime)){
    runtime.stderr.write("catalog_bootstrap_failed_environment\n");runtime.exitCode=1;return null
  }
  if(typeof nodeModule.registerHooks!=="function"){
    runtime.stderr.write("catalog_bootstrap_failed_runtime_provenance\n");runtime.exitCode=1;return null
  }
  const loadedModules=new Map(),root=fileURLToPath(new URL("../",import.meta.url))
  const loadHooks=nodeModule.registerHooks({load:(url,context,next)=>catalogModuleLoad(loadedModules,root,url,context,next)})
  const {loadCatalogSnapshot,makeReceipt,boundedFdWrite,ownedCatalogEnvironment,validateOwnedCatalogEnvironment}=await import("../src/factory/triage-custody.js")
  const {catalogCanonical}=await import("../src/factory/triage-catalog.js")
  const {serveCatalog}=await import("../src/factory/triage-protocol.js")
  let service,loaded,sequence=0,failed=false,closing=false,receiptBytes=0
  async function receipt(event,payload){
    const frame=makeReceipt({event,payload,generation:loaded.generation,sequence:++sequence,serverPid:runtime.pid,
      catalogSha256:loaded.bootstrapReceipt.catalog_sha256,briefSha256:loaded.bootstrapReceipt.brief_sha256,key:loaded.receiptKey})
    const wire=catalogCanonical(frame)+"\n";receiptBytes+=Buffer.byteLength(wire)
    if(sequence>4||Buffer.byteLength(wire)>393216||receiptBytes>2097152)throw Error("receipt_limit")
    // Bound by the fixed launcher's unchanged inherited deadline; no model
    // selector or environment field supplies a second deadline.
    await boundedFdWrite(3,wire,Infinity)
  }
  function fatal(error){
    if(failed)return
    failed=true;runtime.stdin.pause();runtime.exitCode=1
    const detail=["protocol_state","catalog_invalid","wire_noncanonical","wire_input_limit","wire_frame_limit","wire_frame_count","wire_queue_limit","wire_output_limit","wire_closed","wire_incomplete"].includes(error?.message)?`_${error.message}`:""
    runtime.stderr.write(`catalog_session_failed${detail}\n`)
    service?.close().finally(()=>runtime.exit(1))
  }
  async function finish(){
    if(closing||failed)return
    closing=true
    try{
      await service.close()
      if(service.guarded.failed())throw Error("wire_failed")
      await receipt("terminal",{reason:"stdin_eof",final_sequence:sequence+1})
      await promisify(fs.close)(3)
      loadHooks.deregister()
      runtime.stdout.end(()=>{runtime.exitCode=0})
    }catch{fatal()}
  }
  try{
    const firstUID=runtime.getuid(),firstEUID=runtime.geteuid()
    const recipe=ownedCatalogEnvironment({platform:runtime.platform,uid:firstUID,euid:firstEUID})
    if(runtime.argv.length!==2||!validateOwnedCatalogEnvironment({platform:runtime.platform,uid:firstUID,euid:firstEUID,env:runtime.env,expected:recipe}).ok)throw Error("server_environment")
    loaded=await loadCatalogSnapshot({fd:4})
    await receipt("bootstrap",{...loaded.bootstrapReceipt,launcher_pid:runtime.ppid,cwd:runtime.cwd(),
      uid:firstUID,euid:firstEUID,env_version:2,module_closure:[...loadedModules.values()].sort((a,b)=>a.path.localeCompare(b.path))})
    service=await serveCatalog({state:loaded.catalog,input:runtime.stdin,output:runtime.stdout,writeReceipt:receipt,onFailure:fatal})
    runtime.stdin.once("end",finish);runtime.stdin.once("error",fatal)
    for(const signal of ["SIGTERM","SIGINT","SIGHUP"])runtime.once(signal,fatal)
    return {finish,fatal,receipt,service}
  }catch{
    loadHooks.deregister()
    runtime.stderr.write("catalog_bootstrap_failed\n");runtime.exitCode=1;return null
  }
}
export async function catalogServerEntry(runtime=process){
  if(runtime.argv[1]!==fileURLToPath(import.meta.url))return null
  // This is the first application statement on direct entry. Module imports
  // above are only Node builtins; no bootstrap/application work precedes it.
  if(!serverFirstEnvironment(runtime)){
    runtime.stderr.write("catalog_bootstrap_failed_environment\n");runtime.exitCode=1;return null
  }
  return startCatalogServer(runtime)
}
await catalogServerEntry()
