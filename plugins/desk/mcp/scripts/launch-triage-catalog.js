#!/usr/bin/env node
// Fixed clean bootstrap adapter. Import is inert; no model-selected command.
import {spawn} from "node:child_process"
import {promises as fs} from "node:fs"
import {fileURLToPath} from "node:url"
import * as path from "node:path"
export function launcherFirstEnvironment(runtime){
  const uid=runtime.getuid?.(),euid=runtime.geteuid?.(),expected={LANG:"C",LC_ALL:"C",TZ:"UTC"}
  if(runtime.platform==="darwin")expected.__CF_USER_TEXT_ENCODING="0x"+uid?.toString(16).toUpperCase()+":0:0"
  return Number.isSafeInteger(uid)&&uid>=0&&uid<=4294967295&&uid===euid&&
    JSON.stringify(Object.keys(runtime.env).sort())===JSON.stringify(Object.keys(expected).sort())&&
    Object.entries(expected).every(([key,value])=>runtime.env[key]===value)
}
export async function startCatalogLauncher(runtime=process){
  if(!launcherFirstEnvironment(runtime)){
    runtime.stderr.write("catalog_launcher_failed_environment\n");runtime.exitCode=1;return null
  }
  const {openCatalogBootstrap,fifoPump,catalogBootstrapArguments,ownedCatalogEnvironment,validateOwnedCatalogEnvironment,
    readProtectedBytes,makeCatalogObservation,makeReceipt,boundedFdWrite}=await import("../src/factory/triage-custody.js")
  const {closedObject,catalogHash,catalogCanonical}=await import("../src/factory/triage-catalog.js")
  let child,opened,pump,timer,closing=false,failed=false,finished=false,serverClosed=false,stage="arguments"
  function fatal(){
    if(failed)return
    failed=true
    if(child)child.kill("SIGTERM")
    runtime.stdin.pause();runtime.exitCode=1
  }
  async function endInput(){
    if(closing)return
    closing=true;runtime.stdin.unpipe(child.stdin);child.stdin.end()
  }
  try{
    const values=catalogBootstrapArguments(runtime.argv.slice(2))
    stage="identity"
    const actualRuntime=await fs.realpath(runtime.execPath),entry=fileURLToPath(new URL("./triage-catalog-server.js",import.meta.url))
    if(values.entry!==entry||runtime.cwd()!==path.dirname(values.snapshotFile))throw Error("launch_identity")
    stage="environment"
    const recipe=ownedCatalogEnvironment({platform:runtime.platform,uid:runtime.getuid(),euid:runtime.geteuid()})
    if(!validateOwnedCatalogEnvironment({platform:runtime.platform,uid:runtime.getuid(),euid:runtime.geteuid(),env:runtime.env,expected:recipe}).ok)throw Error("launch_identity")
    runtime.stdin.pause();stage="bootstrap";opened=await openCatalogBootstrap(values)
    // A separate bounded read never advances the descriptor inherited by the
    // server. This parent keeps the receipt writer idle until that server has
    // actually closed; it cannot write bootstrap/submit/terminal.
    const snapshotBytes=await readProtectedBytes(values.snapshotFile,6291456)
    if(catalogHash(snapshotBytes)!==values.expectedSha256)throw Error("snapshot_hash")
    const snapshot=JSON.parse(snapshotBytes)
    timer=setTimeout(()=>{fatal();child?.kill("SIGKILL")},Math.max(1,values.deadline-Date.now()-1000))
    child=spawn(actualRuntime,[entry],{env:ownedCatalogEnvironment({platform:runtime.platform,uid:runtime.getuid(),euid:runtime.geteuid()}).env,cwd:runtime.cwd(),shell:false,
      stdio:["pipe","pipe","pipe",opened.receiptFd,opened.snapshotFd]})
    await opened.handles[2].close();opened.handles=opened.handles.slice(0,2)
    let stderrBytes=0
    child.stderr.on("data",chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)fatal();else runtime.stderr.write(chunk)})
    child.stdout.pipe(runtime.stdout,{end:false})
    child.on("error",fatal);child.stdin.on("error",error=>{if(!closing||error.code!=="EPIPE")fatal()})
    runtime.stdin.on("error",fatal)
    runtime.stdin.on("end",()=>{if(!finished)fatal();else endInput()})
    // read(0) observes empty EOF in paused/readable mode without consuming or
    // buffering model bytes beyond the stream's own high-water mark.
    const earlyReadable=()=>{if(!finished)runtime.stdin.read(0)}
    runtime.stdin.on("readable",earlyReadable)
    let controlSequence=0
    pump=fifoPump({fd:opened.readyFd,deadline:values.deadline,maxFrame:1024,maxBytes:2048,maxFrames:2,onFailure:fatal,
      async onFrame(frame){
        closedObject(frame,["event","generation","server_pid"])
        if(frame.generation!==values.generation||frame.server_pid!==child.pid)throw Error("control_identity")
        controlSequence++
        if(controlSequence===1&&frame.event==="ready"){
          finished=true;runtime.stdin.off("readable",earlyReadable);runtime.stdin.pipe(child.stdin,{end:false})
        }else if(controlSequence===2&&frame.event==="finish")await endInput()
        else throw Error("control_sequence")
      }})
    child.on("close",async(code,signal)=>{
      serverClosed=true
      if(code!==0||signal||!closing)fatal()
      try{
        const payload=makeCatalogObservation({kind:"launcher_exit",pid:runtime.pid,code,signal})
        const frame=makeReceipt({event:"observation",sequence:1,generation:values.generation,serverPid:child.pid,
          catalogSha256:catalogHash(catalogCanonical(snapshot.records)),briefSha256:catalogHash(catalogCanonical(snapshot.brief)),
          payload,key:snapshot.receipt_key})
        await boundedFdWrite(opened.receiptFd,catalogCanonical(frame)+"\n",values.deadline)
      }catch{fatal()}
      clearTimeout(timer);await pump.stop();await Promise.all(opened.handles.map(handle=>handle.close()))
      runtime.stdin.off("readable",earlyReadable)
      runtime.stdout.end(()=>{runtime.exitCode=failed?1:0;runtime.stdin.destroy()})
    })
    for(const signal of ["SIGTERM","SIGINT","SIGHUP"])runtime.once(signal,()=>{fatal();setTimeout(()=>child?.kill("SIGKILL"),100).unref()})
    const parent=runtime.ppid,watch=setInterval(()=>{if(runtime.ppid!==parent)fatal()},100)
    child.once("close",()=>clearInterval(watch))
    return {child,fatal,endInput}
  }catch{
    fatal();clearTimeout(timer)
    if(opened)await Promise.all(opened.handles.map(handle=>handle.close()))
    if(!serverClosed&&pump)await pump.stop()
    runtime.stderr.write(`catalog_launcher_failed_${stage}\n`);runtime.exitCode=1;return null
  }
}
export async function catalogLauncherEntry(runtime=process){
  if(runtime.argv[1]!==fileURLToPath(import.meta.url))return null
  if(!launcherFirstEnvironment(runtime)){
    runtime.stderr.write("catalog_launcher_failed_environment\n");runtime.exitCode=1;return null
  }
  return startCatalogLauncher(runtime)
}
await catalogLauncherEntry()
