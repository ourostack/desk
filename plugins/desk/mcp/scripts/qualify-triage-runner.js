#!/usr/bin/env node
// Explicit root-owned qualification. Without launch, only actual non-model
// catalog-server functional proof runs; those never issue qualification.
import {spawn as nodeSpawn} from "node:child_process"
import {promises as fs} from "node:fs"
import * as path from "node:path"
import {fileURLToPath} from "node:url"
import {createHash} from "node:crypto"
import {childEnvironment,runChild,probeSignIn,billingVariableBlocks,HEADLESS_TIMEOUT_MS} from "../src/factory/headless.js"
import {inspectLaunchChain,collectTriageAdmission,triagePolicy,sealOwnedQualification,loadTriageQualification,createNonacceptedTriageUnit,qualificationMeasurementActive} from "../src/factory/triage-runner.js"
import {assertOutsideGitWorkspace,ensureOwnerOnlyDirectory,protectLeafFile} from "../src/factory/os-protect.js"
import {runDirectCatalog,runCatalogWireCase,prepareOwnedCatalogRun,runOwnedCatalogNative,retainDirectReceipt,completeDirectBundle,catalogFatalCases} from "../src/factory/triage-custody.js"
import {writeTriagePreparedFile,catalogCanonical,closedObject} from "../src/factory/triage-catalog.js"
const naming={label:"triage qualification",subject:"evidence"}
async function protectedWrite(file,value){
  await fs.writeFile(file,value,{flag:"wx",mode:0o600})
  await protectLeafFile(file,process.platform,naming)
}
export async function qualifyTriageRunner({out,cli,env=process.env,spawn=nodeSpawn,probeSpawn,cliMetadata,resolveExec,runDiagnostic,policyReaders}){
  return qualifyOwnedCatalog({launch:{cli,env,spawn,probeSpawn,cliMetadata,resolveExec,runDiagnostic,policyReaders},
    fixture:JSON.parse(await fs.readFile(new URL("../../../../tests/desk/mcp/__tests__/factory/fixtures/v12-owned-catalog.json",import.meta.url),"utf8")),
    deadline:Date.now()+HEADLESS_TIMEOUT_MS,evidenceDir:out})
}
export async function writeSyntheticTriagePreparedInput({inputDir,fixture}){
  return writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
}
export async function qualifyOwnedCatalog({launch,fixture,deadline,evidenceDir}){
  return qualifyCatalogTransaction({launch,fixture,deadline,evidenceDir},realCatalogTransaction)
}
async function qualifyCatalogTransaction({launch,fixture,deadline,evidenceDir},context){
  if(context===realCatalogTransaction&&launch&&qualificationMeasurementActive())return {state:"blocked",reason:"diagnostic_inadequate",record:null,
    directReceipts:[],nativeReceipts:[],resources:{out:evidenceDir,launches:0,pids:[],exited_pids:[],files:[]}}
  await context.outside(evidenceDir,naming)
  await context.mkdir(evidenceDir,process.platform,naming)
  const resources={out:evidenceDir,launches:0,pids:[],exited_pids:[],files:[]},directReceipts=[],nativeReceipts=[]
  let record={version:2,enforcement_scheme:"owned_catalog_mcp",state:"blocked",reason:"diagnostic_inadequate"}
  const save=async(name,value)=>{
    const file=path.join(evidenceDir,name)
    await context.write(file,catalogCanonical(value)+"\n");resources.files.push(file)
  }
  try{
    for(let i=1;i<=2;i++){
      const direct=await context.direct({fixture,deadline,evidenceDir:path.join(evidenceDir,`direct-${i}`)})
      const cleanup=direct.cleanup
      let receipt=direct.state==="proved"?context.retain(direct):JSON.parse(JSON.stringify(direct))
      await save(`direct-${i}-normal.json`,receipt);await cleanup()
      if(receipt.state!=="proved")throw Error("direct_failed")
      const cases=[]
      for(const sub of catalogFatalCases(fixture)){
        const run=await context.wire({fixture,frames:sub.frames,deadline})
        cases.push({name:sub.name,proof:run})
        const {cleanup:remove,...rawProof}=run,proof={...rawProof,resources:{...rawProof.resources}}
        if(Buffer.byteLength(proof.resources.stdout??"")>65536){
          const file=path.join(evidenceDir,`direct-${i}-${sub.name}-stdout.ndjson`),raw=proof.resources.stdout
          await context.write(file,raw);resources.files.push(file)
          proof.resources.stdout={path:file,bytes:Buffer.byteLength(raw),sha256:createHash("sha256").update(raw).digest("hex")}
        }
        await save(`direct-${i}-${sub.name}.json`,proof);await remove()
        if(proof.state!=="refused")throw Error("wire_case_incomplete")
      }
      const partial=await context.direct({fixture:{...fixture,...fixture.histories.partial},deadline,
        evidenceDir:path.join(evidenceDir,`direct-${i}-partial`)})
      const {cleanup:removePartial,...partialProof}=partial
      await save(`direct-${i}-partial.json`,partialProof);await removePartial()
      if(partialProof.state!=="proved"||
        catalogCanonical(partialProof.custody.receipts[1].payload.refused.map(x=>x.index))!=="[1]")throw Error("partial_case_incomplete")
      receipt=context.complete({receipt,cases,partial:context.retain(partial),fixture})
      directReceipts.push(receipt);await save(`direct-${i}.json`,receipt)
    }
    if(!launch)return {state:"direct_validated",directReceipts,nativeReceipts,record:null,resources}
    record=await context.native({launch,fixture,deadline,evidenceDir,resources,directReceipts,nativeReceipts,save},context.nativeContext)
  }catch(e){
    resources.protected_failure_detail=e.message
    const allowed=["effective_policy_unknown","applicable_delivery_pending","active_hook_or_helper","unsafe_permission_grant","billing_unresolved","policy_control_unsupported","diagnostic_inadequate","launch_chain_unknown"]
    record.reason=allowed.includes(e.message)?e.message:"diagnostic_inadequate"
  }
  const final=await persistQualification(record,{
    save:value=>save("qualification.json",value),
    load:value=>context.reload({recordFile:path.join(evidenceDir,"qualification.json"),cli:value.cli,env:launch.env}),
  })
  return {...final,directReceipts,nativeReceipts,resources}
}
// The production caller fixes every adapter lexically. No public API accepts
// this context, issuer, registry or store. Unit execution below has only inert
// synthetic custody plus the existing isolated, nonaccepted memory transaction.
const realNativeTransaction=Object.freeze({chain:inspectLaunchChain,help:runChild,
  mkdir:ensureOwnerOnlyDirectory,writeInput:writeSyntheticTriagePreparedInput,prepare:prepareOwnedCatalogRun,
  policy:triagePolicy,admission:collectTriageAdmission,signIn:probeSignIn,run:runOwnedCatalogNative,seal:sealOwnedQualification})
const realCatalogTransaction=Object.freeze({outside:assertOutsideGitWorkspace,mkdir:ensureOwnerOnlyDirectory,
  write:protectedWrite,direct:runDirectCatalog,retain:retainDirectReceipt,wire:runCatalogWireCase,complete:completeDirectBundle,
  native:qualifyNativeRuns,nativeContext:realNativeTransaction,reload:loadTriageQualification})
async function qualifyNativeRuns({launch,fixture,deadline,evidenceDir,resources,directReceipts,nativeReceipts,save},context){
    if(billingVariableBlocks(launch.env))throw Error("billing_unresolved")
    let metadata=launch.cliMetadata
    const chain=context.chain(launch)
    if(chain.state!=="inspected")throw Error("launch_chain_unknown")
    if(!metadata){
      const help=await context.help({spawn:launch.spawn??nodeSpawn,cmd:chain.effective_argv[0],args:["--help"],
        opts:{env:childEnvironment(launch.env),stdio:["ignore","pipe","pipe"]},timeoutMs:15000,maxBytes:65536})
      await save("help.json",help)
      if(help.kind!=="closed"||help.code!==0||help.truncated)throw Error("diagnostic_inadequate")
      metadata={host:"claude-code",flags:help.stdout.match(/--[a-zA-Z-]+/gu)??[]}
    }
    let admitted,firstAdmissionIdentity
    for(let i=1;i<=2;i++){
      const runDir=path.join(evidenceDir,`native-${i}`),inputDir=path.join(evidenceDir,`input-${i}`)
      await context.mkdir(inputDir,process.platform,naming)
      await context.writeInput({inputDir,fixture})
      const owned=await context.prepare({inputDir,runDir,deadline})
      try{
      const policy=context.policy({inputDir,resultFile:path.join(evidenceDir,`unaccepted-${i}.json`),cliMetadata:metadata,ownedServer:owned.launch})
      if(policy.state!=="prepared"){await owned.close();throw Error(policy.reason??"policy_control_unsupported")}
      admitted=await context.admission({...launch,cli:chain.effective_argv[0],argv:policy.argv})
      await save(`admission-${i}.json`,admitted)
      if(admitted.state!=="admitted"){await owned.close();throw Error(admitted.reason)}
      const invariant=catalogCanonical({sources:admitted.sources,remote_delivery:admitted.remote_delivery,capabilities:admitted.capabilities,
        env:childEnvironment(launch.env)})
      if(firstAdmissionIdentity!==undefined&&firstAdmissionIdentity!==invariant){await owned.close();throw Error("effective_policy_unknown")}
      firstAdmissionIdentity=invariant
      const signIn=await context.signIn({cli:chain.effective_argv[0],env:launch.env,spawn:launch.probeSpawn??launch.spawn??nodeSpawn,
        onChild:pid=>resources.pids.push(pid),onChildExit:pid=>resources.exited_pids.push(pid)})
      if(signIn.state!=="subscription"){await owned.close();throw Error(signIn.state)}
      const run=await context.run({owned,command:chain.effective_argv[0],args:[...chain.effective_argv.slice(1),...policy.argv],
        env:childEnvironment(launch.env),deadline,resultFile:path.join(evidenceDir,`unaccepted-${i}.json`),
        spawn:launch.spawn??nodeSpawn,onChild:pid=>{resources.launches++;resources.pids.push(pid)},onChildExit:pid=>resources.exited_pids.push(pid)})
      await save(`native-${i}-bundle.json`,run);nativeReceipts.push(run)
      if(run.state!=="ran")throw Error("diagnostic_inadequate")
      const after=await context.admission({...launch,cli:chain.effective_argv[0],argv:policy.argv})
      await save(`admission-${i}-after.json`,after)
      if(after.state!=="admitted"||after.fingerprint!==admitted.fingerprint)throw Error("effective_policy_unknown")
      const afterChain=context.chain(launch)
      if(afterChain.state!=="inspected"||afterChain.fingerprint!==chain.fingerprint)throw Error("launch_chain_unknown")
      }finally{await owned.close()}
    }
    return sealTransaction({directReceipts,nativeReceipts,admission:admitted,chain,cliMetadata:metadata,cli:launch.cli,env:launch.env},context.seal)
}
function sealTransaction(params,sealer){
  return sealer(params)
}
async function persistQualification(record,context){
  await context.save(record)
  if(record.state==="qualified"){
    // The protected persisted form must survive the same closed reader that
    // production uses; live WeakMap issuance alone is not a durable proof.
    const restored=await context.load(record)
    if(restored.state!=="qualified")return {state:"blocked",reason:"diagnostic_inadequate",record}
    record=restored
  }
  return {state:record.state,record,reason:record.reason}
}
/** Fixed memory-only unit facade. Production never accepts this context,
 * callbacks, registry or store as an option, and the facade cannot execute
 * native/sign-in commands or insert into real custody/qualification maps. */
export async function runNonacceptedQualifierTransaction(config){
  const unit=createNonacceptedTriageUnit(config)
  try{
    const record=sealTransaction({},()=>unit.seal().record)
    const outcome=await persistQualification(record,{save:value=>unit.save(value),load:async()=>((await unit.load()).outcome)})
    return {authority:false,state:"unit_transaction",outcome,statistics:unit.statistics()}
  }catch{
    return {authority:false,state:"unit_transaction",outcome:{state:"blocked",reason:"diagnostic_inadequate"},statistics:unit.statistics()}
  }
}
/** Measures the existing two-launch orchestration, not a native probe. All
 * effects are fixed synthetic adapters or this unit's memory store. Neither
 * real native/custody registries nor real qualification files are reachable. */
export async function runNonacceptedNativeQualification(config){
  closedObject(config,["record","env","admission","chain"],["failures"])
  const data=JSON.parse(catalogCanonical(config)),unit=createNonacceptedTriageUnit(data),failures=data.failures??{}
  const evidenceDir=path.dirname(path.dirname(data.record.nativeReceipts[0].snapshotFile))
  let prepared=0,admissionReads=0,chainReads=0,closed=0
  const resources={launches:0,pids:[],exited_pids:[],files:[]},documents=new Map()
  const context={
    chain(){
      chainReads++
      if(failures.chain)return {state:"scope_unqualified"}
      return {...structuredClone(data.chain),fingerprint:failures.chainIdentity&&chainReads>1?"unit_changed_chain":data.chain.fingerprint}
    },
    async help(){
      return {kind:failures.read?"failed":"closed",code:failures.write?1:0,truncated:Boolean(failures.restoreNative),
        stdout:failures.policy?"":data.record.nativeReceipts[0].invocation.args.filter(arg=>/^--[a-zA-Z-]+$/u.test(arg)).join("\n")}
    },
    async mkdir(){},
    async writeInput(){},
    async prepare(){
      const source=data.record.nativeReceipts[prepared++]
      if(failures.prepare)throw Error("unit_prepare_failed")
      let stopped=false
      return {launch:structuredClone(source.invocation.owned_launch),source,
        async close(){if(!stopped){stopped=true;closed++}},
      }
    },
    policy:request=>failures.policy?{state:"scope_unqualified",reason:"policy_control_unsupported"}:triagePolicy(request),
    async admission(){
      admissionReads++
      if(failures.admission||(admissionReads%2===0&&failures.postAdmission))return {state:"scope_unqualified",reason:"effective_policy_unknown"}
      const admitted=structuredClone(data.admission)
      if(failures.admissionIdentity&&admissionReads>2)admitted.remote_delivery="unit_changed"
      if(failures.postIdentity&&admissionReads%2===0)admitted.fingerprint="unit_changed"
      return admitted
    },
    async signIn({onChild,onChildExit}){
      onChild(-prepared);onChildExit(-prepared)
      return {state:failures.signIn?"no_credentials":"subscription"}
    },
    async run({owned,onChild,onChildExit}){
      const ordinal=prepared
      onChild(ordinal)
      if(failures.throwRun)throw Error("unit_native_run_failed")
      await owned.close();onChildExit(ordinal)
      return {...structuredClone(owned.source),state:failures.run||failures.prepared?"failed":"ran"}
    },
    seal:()=>unit.seal().record,
  }
  try{
    const record=await qualifyNativeRuns({launch:{cli:data.record.cli,env:data.env,cliMetadata:data.record.cliMetadata},
      fixture:null,deadline:Date.now()+HEADLESS_TIMEOUT_MS,evidenceDir,resources,
      directReceipts:structuredClone(data.record.directReceipts),nativeReceipts:[],
      save:async(name,value)=>{documents.set(name,catalogCanonical(value))}},context)
    const outcome=await persistQualification(record,{save:value=>unit.save(value),load:async()=>((await unit.load()).outcome)})
    return {authority:false,outcome,statistics:{...unit.statistics(),syntheticLaunches:resources.launches,
      syntheticAuthGenerations:resources.pids.filter(pid=>pid<0).length,syntheticClosed:closed,memoryEvidenceDocuments:documents.size}}
  }catch{
    return {authority:false,outcome:{state:"blocked",reason:"diagnostic_inadequate"},
      statistics:{...unit.statistics(),syntheticLaunches:resources.launches,syntheticAuthGenerations:resources.pids.filter(pid=>pid<0).length,syntheticClosed:closed,memoryEvidenceDocuments:documents.size}}
  }
}
/** Complete shared workflow with isolated synthetic custody and memory only. */
export async function runNonacceptedCatalogTransaction(config){
  closedObject(config,["record","env","admission","chain","fixture","phaseFailure"],["failures"])
  const data=JSON.parse(catalogCanonical(config)),{fixture,phaseFailure,...base}=data
  const unit=createNonacceptedTriageUnit(base),documents=new Map()
  const evidenceDir=path.dirname(path.dirname(base.record.nativeReceipts[0].snapshotFile))
  let directIndex=0,wireIndex=0,syntheticLaunches=0
  const context={
    async outside(){},async mkdir(){},
    async write(file,bytes){
      if(phaseFailure==="write")throw Error("unit_store_write")
      documents.set(file,bytes)
    },
    async direct({fixture:requested}){
      const partial=requested===fixture?false:catalogCanonical(requested.candidate)!==catalogCanonical(fixture.candidate)
      const index=partial?directIndex-1:directIndex++
      return {...structuredClone(base.record.directReceipts[index]),state:phaseFailure===(partial?"partial":"direct")?"failed":"proved",
        custody:{receipts:[{}, {payload:{refused:[{index:phaseFailure==="partialIndices"?0:1}]}}]},
        async cleanup(){}}
    },
    retain(proof){const {cleanup,...record}=proof;return record},
    async wire(){
      wireIndex++
      return {state:phaseFailure==="wire"?"failed":"refused",resources:wireIndex%2===0?{}:{stdout:"unit"},async cleanup(){}}
    },
    complete:({receipt})=>receipt,
    async native(){
      const result=await runNonacceptedNativeQualification(base)
      syntheticLaunches=result.statistics.syntheticLaunches
      if(result.outcome.state!=="qualified")throw Error("diagnostic_inadequate")
      return unit.seal().record
    },
    async reload(){
      if(phaseFailure==="reload")return {state:"blocked"}
      const saved=JSON.parse(documents.get(path.join(evidenceDir,"qualification.json")))
      await unit.save(saved);return (await unit.load()).outcome
    },
  }
  let outcome
  try{outcome=await qualifyCatalogTransaction({launch:{env:base.env},fixture,deadline:Date.now()+HEADLESS_TIMEOUT_MS,evidenceDir},context)}
  catch{outcome={state:"blocked",reason:"diagnostic_inadequate"}}
  return {authority:false,outcome,statistics:{diskWrites:0,actualLaunches:0,syntheticLaunches,memoryDocuments:documents.size}}
}
export function qualificationCLIOutcome(result){
  return {line:JSON.stringify({state:result.state,reason:result.reason})+"\n",exitCode:Number(result.state!=="qualified")}
}
export async function qualifierEntry(runtime=process){
  if(runtime.argv[1]!==fileURLToPath(import.meta.url))return null
  const args=runtime.argv.slice(2)
  let result
  try{
    if(args.length!==4||new Set([args[0],args[2]]).size!==2||!["--out","--cli"].includes(args[0])||!["--out","--cli"].includes(args[2]))throw Error("invalid arguments")
    const options=Object.fromEntries([[args[0].slice(2),args[1]],[args[2].slice(2),args[3]]])
    result=await qualifyTriageRunner(options)
  }catch{result={state:"blocked",reason:"policy_control_unsupported"}}
  const rendered=qualificationCLIOutcome(result)
  runtime.stdout.write(rendered.line);runtime.exitCode=rendered.exitCode
  return null
}
await qualifierEntry()
