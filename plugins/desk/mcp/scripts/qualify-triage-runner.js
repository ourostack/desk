#!/usr/bin/env node
// Explicit root-owned qualification. Without launch, only actual non-model
// catalog-server functional proof runs; those never issue qualification.
import {spawn as nodeSpawn} from "node:child_process"
import {promises as fs} from "node:fs"
import * as path from "node:path"
import {fileURLToPath} from "node:url"
import {createHash} from "node:crypto"
import {runChild,probeSignIn,billingVariableBlocks,HEADLESS_TIMEOUT_MS} from "../src/factory/headless.js"
import {QUALIFICATION_VERSION,triageChildEnvironment,inspectLaunchChain,collectTriageAdmission,hasCollectedTriageControls,validateTriageControls,triagePolicy,sealOwnedQualification,loadTriageQualification,createNonacceptedTriageUnit,qualificationMeasurementActive,hostRecordSeal} from "../src/factory/triage-runner.js"
import {assertOutsideGitWorkspace,ensureOwnerOnlyDirectory,protectLeafFile} from "../src/factory/os-protect.js"
import {runDirectCatalog,runCatalogWireCase,prepareOwnedCatalogRun,runOwnedCatalogNative,runNonacceptedNativeTransaction,retainDirectReceipt,completeDirectBundle,catalogFatalCases,QUALIFICATION_FIXTURE} from "../src/factory/triage-custody.js"
import {writeTriagePreparedFile,catalogCanonical,closedObject} from "../src/factory/triage-catalog.js"
const naming={label:"triage qualification",subject:"evidence"}
async function protectedWrite(file,value){
  await fs.writeFile(file,value,{flag:"wx",mode:0o600})
  await protectLeafFile(file,process.platform,naming)
}
// The real qualifier takes the engine path and environment only. It starts the
// engine, sign-in probe and doctor through node:child_process itself; no caller
// can substitute a launcher, sign-in, doctor, chain resolver or policy reader.
// `reserve` (optional) is called once, after every check and just before the
// first native launch, to account for both launches; a throw stops the
// qualification with nothing launched. `deadline` can only shorten the run.
export async function qualifyTriageRunner({out,cli,env=process.env,deadline,reserve}){
  const limit=Date.now()+HEADLESS_TIMEOUT_MS
  return qualifyOwnedCatalog({launch:{cli,env,...(reserve?{reserve}:{})},
    fixture:JSON.parse(await fs.readFile(QUALIFICATION_FIXTURE,"utf8")),
    deadline:Number.isSafeInteger(deadline)?Math.min(deadline,limit):limit,evidenceDir:out})
}
export async function writeSyntheticTriagePreparedInput({inputDir,fixture}){
  return writeTriagePreparedFile({inputDir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
}
export async function qualifyOwnedCatalog({launch,fixture,deadline,evidenceDir}){
  // A direct-only run passes no launch; any launch carries cli and env only.
  try{closedObject({cli:undefined,env:undefined,...launch},["cli","env"],["reserve"]);if(launch?.reserve!==undefined&&typeof launch.reserve!=="function")throw Error("reserve")}
  catch{return {state:"blocked",reason:"policy_control_unsupported",record:null,directReceipts:[],nativeReceipts:[],
    resources:{out:evidenceDir,launches:0,pids:[],exited_pids:[],files:[]}}}
  const {reserve,...fixed}=launch??{}
  return qualifyCatalogTransaction({launch:launch&&fixed,reserve,fixture,deadline,evidenceDir},realCatalogTransaction)
}
async function qualifyCatalogTransaction({launch,reserve,fixture,deadline,evidenceDir},context){
  if(context===realCatalogTransaction&&launch&&qualificationMeasurementActive())return {state:"blocked",reason:"diagnostic_inadequate",record:null,
    directReceipts:[],nativeReceipts:[],resources:{out:evidenceDir,launches:0,pids:[],exited_pids:[],files:[]}}
  const resources={out:evidenceDir,launches:0,pids:[],exited_pids:[],files:[]},directReceipts=[],nativeReceipts=[]
  const stages=[],stage=name=>stages.push({name,observation:"present",at_ms:Date.now()})
  let outReady=false
  let record={version:QUALIFICATION_VERSION,protocol_envelope_version:2,enforcement_scheme:"owned_catalog_mcp",recipe_version:3,controls_schema:"desk.factory.triage-controls/3",predicate_table:"E296/3",state:"blocked",reason:"diagnostic_inadequate"}
  const save=async(name,value)=>{
    const file=path.join(evidenceDir,name)
    await context.write(file,catalogCanonical(value)+"\n");resources.files.push(file)
  }
  try{
    await context.outside(evidenceDir,naming);stage("outside_git_verified")
    await context.mkdir(evidenceDir,process.platform,naming);outReady=true;stage("protected_output_created")
    for(let i=1;i<=2;i++){
      const direct=await context.direct({fixture,deadline,evidenceDir:path.join(evidenceDir,`direct-${i}`)})
      const cleanup=direct.cleanup
      let receipt=direct.state==="proved"?context.retain(direct):JSON.parse(JSON.stringify(direct))
      try{await save(`direct-${i}-normal.json`,receipt)}finally{await cleanup()}
      if(receipt.state!=="proved")throw Error("direct_failed")
      const cases=[]
      for(const sub of catalogFatalCases(fixture)){
        const run=await context.wire({fixture,frames:sub.frames,deadline})
        cases.push({name:sub.name,proof:run})
        const {cleanup:remove,...rawProof}=run,proof={...rawProof,resources:{...rawProof.resources}}
        try{
          if(Buffer.byteLength(proof.resources.stdout??"")>65536){
            const file=path.join(evidenceDir,`direct-${i}-${sub.name}-stdout.ndjson`),raw=proof.resources.stdout
            await context.write(file,raw);resources.files.push(file)
            proof.resources.stdout={path:file,bytes:Buffer.byteLength(raw),sha256:createHash("sha256").update(raw).digest("hex")}
          }
          await save(`direct-${i}-${sub.name}.json`,proof)
        }finally{await remove()}
        if(proof.state!=="refused")throw Error("wire_case_incomplete")
      }
      const partial=await context.direct({fixture:{...fixture,...fixture.histories.partial},deadline,
        evidenceDir:path.join(evidenceDir,`direct-${i}-partial`)})
      const {cleanup:removePartial,...partialProof}=partial
      try{await save(`direct-${i}-partial.json`,partialProof)}finally{await removePartial()}
      if(partialProof.state!=="proved"||
        catalogCanonical(partialProof.custody.receipts[1].payload.refused.map(x=>x.index))!=="[1]")throw Error("partial_case_incomplete")
      receipt=context.complete({receipt,cases,partial:context.retain(partial),fixture})
      directReceipts.push(receipt);await save(`direct-${i}.json`,receipt)
      stage(`direct_${i}_complete`)
    }
    if(!launch)return {state:"direct_validated",directReceipts,nativeReceipts,record:null,resources}
    record=await context.native({launch,reserve,fixture,deadline,evidenceDir,resources,directReceipts,nativeReceipts,save},context.nativeContext)
  }catch(e){
    resources.protected_failure_detail=e.message
    const allowed=["effective_policy_unknown","applicable_delivery_pending","active_hook_or_helper","unsafe_permission_grant","billing_unresolved","policy_control_unsupported","diagnostic_inadequate","launch_chain_unknown"]
    record.reason=allowed.includes(e.message)?e.message:"diagnostic_inadequate"
  }
  // A blocked record carries this host's seal too, so that once a sealed
  // record has qualified here, an unsealed blocked record reads as damaged.
  // A host that cannot seal leaves it unsealed; restore there is
  // host_unsupported before any seal matters.
  if(record.state==="blocked"&&context.hostSeal){try{record.host_seal=context.hostSeal(record)}catch{}}
  let final
  try{
    if(!outReady)throw Error("protected_output_unavailable")
    final=await persistQualification(record,{
      save:async value=>{await save("qualification.json",value);stage("record_saved")},
      load:value=>context.reload({recordFile:path.join(evidenceDir,"qualification.json"),cli:value.cli,env:launch.env}),
    })
  }catch(e){
    resources.protected_capture_failure=e.message
    final={state:"blocked",reason:"diagnostic_inadequate",record}
  }
  if(final.state!=="qualified"){
    resources.failure_capture={version:1,stages,channels:{
      protected_output:{observation:outReady?"present":"unobserved",truncated:false},
      qualification:{observation:"unobserved",truncated:false,reason:"not_verified"},
      native:{observation:nativeReceipts.length?"present":"unobserved",truncated:false},
    }}
    if(outReady){
      try{await save("failure-capture.json",resources.failure_capture)}
      catch{resources.failure_capture.channels.protected_output={observation:"unobserved",truncated:false,reason:"capture_write_failed"}}
    }
  }
  return {...final,directReceipts,nativeReceipts,resources}
}
// The production caller fixes every adapter lexically. No public API accepts
// this context, issuer, registry or store. Unit execution below has only inert
// synthetic custody plus the existing isolated, nonaccepted memory transaction.
const realNativeTransaction=Object.freeze({chain:inspectLaunchChain,help:runChild,
  mkdir:ensureOwnerOnlyDirectory,writeInput:writeSyntheticTriagePreparedInput,prepare:prepareOwnedCatalogRun,
  policy:triagePolicy,admission:collectTriageAdmission,controls:hasCollectedTriageControls,signIn:probeSignIn,run:runOwnedCatalogNative,seal:sealOwnedQualification})
const realCatalogTransaction=Object.freeze({outside:assertOutsideGitWorkspace,mkdir:ensureOwnerOnlyDirectory,
  write:protectedWrite,direct:runDirectCatalog,retain:retainDirectReceipt,wire:runCatalogWireCase,complete:completeDirectBundle,
  native:qualifyNativeRuns,nativeContext:realNativeTransaction,reload:loadTriageQualification,hostSeal:hostRecordSeal})
async function qualifyNativeRuns({launch,reserve,fixture,deadline,evidenceDir,resources,directReceipts,nativeReceipts,save},context){
    if(billingVariableBlocks(launch.env))throw Error("billing_unresolved")
    let metadata=launch.cliMetadata
    const chain=context.chain(launch)
    if(chain.state!=="inspected")throw Error("launch_chain_unknown")
    if(!metadata){
      const help=await context.help({spawn:nodeSpawn,cmd:chain.effective_argv[0],args:["--help"],
        opts:{env:triageChildEnvironment(launch.env),stdio:["ignore","pipe","pipe"]},timeoutMs:15000,maxBytes:65536})
      await save("help.json",help)
      if(help.kind!=="closed"||help.code!==0||help.truncated)throw Error("diagnostic_inadequate")
      metadata={host:"claude-code",flags:help.stdout.match(/--[a-zA-Z-]+/gu)??[]}
    }
    let admitted,firstAdmissionIdentity
    const control_history=[]
    for(let i=1;i<=2;i++){
      const runDir=path.join(evidenceDir,`native-${i}`),inputDir=path.join(evidenceDir,`input-${i}`)
      let owned
      const stages=[],step=name=>stages.push({name,observation:"present",at_ms:Date.now()})
      const capture={version:1,stages,channels:{native:{observation:"unobserved",truncated:false}},prepared_invocation:null}
      try{
      await context.mkdir(inputDir,process.platform,naming);step("input_directory")
      await context.writeInput({inputDir,fixture});step("prepared_input")
      owned=await context.prepare({inputDir,runDir,deadline});step("owned_resources")
      const policy=context.policy({inputDir,resultFile:path.join(evidenceDir,`unaccepted-${i}.json`),cliMetadata:metadata,ownedServer:owned.launch})
      if(policy.state!=="prepared"){await owned.close();throw Error(policy.reason??"policy_control_unsupported")}
      const command=chain.effective_argv[0],args=[...chain.effective_argv.slice(1),...policy.argv]
      const exact=catalogCanonical({command,args,cwd:runDir})
      if(Buffer.byteLength(exact)>65536)throw Error("policy_control_unsupported")
      capture.prepared_invocation={bytes:Buffer.byteLength(exact),sha256:createHash("sha256").update(exact).digest("hex"),base64:Buffer.from(exact).toString("base64"),
        executed:false}
      step("fixed_policy")
      admitted=await context.admission({...launch,cli:chain.effective_argv[0],argv:policy.argv})
      await save(`admission-${i}.json`,admitted)
      if(admitted.state!=="admitted"){await owned.close();throw Error(admitted.reason)}
      if(!context.controls(admitted.controls)){await owned.close();throw Error("policy_control_unsupported")}
      step("control_admission")
      const control_basis=Object.fromEntries(Object.entries(admitted.controls).filter(([key])=>key!=="recipe_sha256"))
      const invariant=catalogCanonical({sources:admitted.sources,remote_delivery:admitted.remote_delivery,control_basis,
        env:triageChildEnvironment(launch.env)})
      if(firstAdmissionIdentity!==undefined&&firstAdmissionIdentity!==invariant){await owned.close();throw Error("effective_policy_unknown")}
      firstAdmissionIdentity=invariant
      const signIn=await context.signIn({cli:chain.effective_argv[0],env:triageChildEnvironment(launch.env),spawn:nodeSpawn,
        onChild:pid=>resources.pids.push(pid),onChildExit:pid=>resources.exited_pids.push(pid)})
      if(signIn.state!=="subscription"){await owned.close();throw Error(signIn.state)}
      step("subscription")
      const current=await context.admission({...launch,cli:chain.effective_argv[0],argv:policy.argv})
      const currentChain=context.chain(launch)
      if(current.state!=="admitted"||current.fingerprint!==admitted.fingerprint||!context.controls(current.controls)||
        catalogCanonical(currentChain)!==catalogCanonical(chain)){await owned.close();throw Error("effective_policy_unknown")}
      admitted=current;control_history.push(current.controls)
      step("fresh_prelaunch_admission")
      if(i===1&&reserve)await reserve()
      const run=await context.run({owned,command:chain.effective_argv[0],args:[...chain.effective_argv.slice(1),...policy.argv],
        env:triageChildEnvironment(launch.env),deadline,resultFile:path.join(evidenceDir,`unaccepted-${i}.json`),
        onChild:pid=>{resources.launches++;resources.pids.push(pid)},onChildExit:pid=>resources.exited_pids.push(pid)})
      await save(`native-${i}-bundle.json`,run);nativeReceipts.push(run)
      capture.channels.native={observation:run.evidence?.spawned?"present":"unobserved",truncated:false}
      capture.channels.native_bundle={observation:"present",truncated:false}
      capture.prepared_invocation.executed=Boolean(run.evidence?.spawn_attempted);step("native_bundle")
      if(run.state!=="ran"){resources.protected_native_failure_detail=run.detail??run.reason;throw Error("diagnostic_inadequate")}
      const after=await context.admission({...launch,cli:chain.effective_argv[0],argv:policy.argv})
      await save(`admission-${i}-after.json`,after)
      if(after.state!=="admitted"||after.fingerprint!==admitted.fingerprint)throw Error("effective_policy_unknown")
      const afterChain=context.chain(launch)
      if(afterChain.state!=="inspected"||afterChain.fingerprint!==chain.fingerprint)throw Error("launch_chain_unknown")
      }finally{
        try{await owned?.close();step("owned_cleanup")}
        catch(e){capture.cleanup={observation:"unobserved",truncated:false,reason:"cleanup_failed"};throw e}
        finally{
          try{await save(`native-${i}-stages.json`,capture)}
          catch{resources.protected_stage_capture_failure="stage_write_failed";resources.native_stage_capture=capture;throw Error("diagnostic_inadequate")}
        }
      }
    }
    return sealTransaction({directReceipts,nativeReceipts,admission:{...admitted,control_history},chain,cliMetadata:metadata,cli:launch.cli,env:launch.env},context.seal)
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
  let prepared=0,admissionReads=0,chainReads=0,closed=0,reserved=0
  // A synthetic ledger callback: "accept" counts the reservation, "refuse" throws as a refused ledger does.
  const reserve=failures.reserve?async()=>{reserved++;if(failures.reserve==="refuse")throw Error("quota_refused")}:undefined
  const resources={launches:0,pids:[],exited_pids:[],files:[]},documents=new Map()
  const context={
    chain(){
      chainReads++
      if(failures.chain)return {state:"scope_unqualified"}
      if(failures.runChainUnknown&&chainReads%3===0)return {state:"scope_unqualified"}
      const value={...structuredClone(data.chain),fingerprint:(failures.chainIdentity&&chainReads>1)||(failures.runChainDrift&&chainReads%3===0)?"unit_changed_chain":data.chain.fingerprint}
      if(failures.invocation)value.effective_argv.push("x".repeat(65537))
      return value
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
        async close(){if(!stopped){stopped=true;closed++}if(failures.close)throw Error("unit_close_failed")},
      }
    },
    policy:request=>failures.policy?{state:"scope_unqualified",reason:"policy_control_unsupported"}:triagePolicy(request),
    controls:e=>validateTriageControls(e).ok,
    async admission(){
      admissionReads++
      if(failures.admission||(admissionReads%2===0&&failures.postAdmission))return {state:"scope_unqualified",reason:"effective_policy_unknown"}
      const admitted=structuredClone(data.admission)
      if(failures.admissionIdentity&&admissionReads>2)admitted.remote_delivery="unit_changed"
      if(failures.postIdentity&&admissionReads%2===0)admitted.fingerprint="unit_changed"
      if(failures.postExitAdmission&&admissionReads%3===0)return {state:"scope_unqualified",reason:"effective_policy_unknown"}
      if(failures.postExitIdentity&&admissionReads%3===0)admitted.fingerprint="unit_changed"
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
      if(failures.nativeMode){
        const actual=await runNonacceptedNativeTransaction({mode:failures.nativeMode})
        return {...structuredClone(owned.source),...actual.outcome}
      }
      return {...structuredClone(owned.source),state:failures.run||failures.prepared?"failed":"ran"}
    },
    seal:()=>unit.seal().record,
  }
  try{
    const record=await qualifyNativeRuns({launch:{cli:data.record.cli,env:data.env,cliMetadata:data.record.cliMetadata},reserve,
      fixture:null,deadline:Date.now()+HEADLESS_TIMEOUT_MS,evidenceDir,resources,
      directReceipts:structuredClone(data.record.directReceipts),nativeReceipts:[],
      save:async(name,value)=>{if(failures.write&&name.endsWith("-stages.json"))throw Error("unit_stage_write_failed");documents.set(name,catalogCanonical(value))}},context)
    const outcome=await persistQualification(record,{save:value=>unit.save(value),load:async()=>((await unit.load()).outcome)})
    return {authority:false,outcome,evidence:[...documents].map(([name,text])=>({name,value:JSON.parse(text)})),statistics:{...unit.statistics(),syntheticLaunches:resources.launches,
      syntheticAuthGenerations:resources.pids.filter(pid=>pid<0).length,syntheticClosed:closed,syntheticReservations:reserved,memoryEvidenceDocuments:documents.size}}
  }catch{
    return {authority:false,outcome:{state:"blocked",reason:"diagnostic_inadequate"},evidence:[...documents].map(([name,text])=>({name,value:JSON.parse(text)})),
      statistics:{...unit.statistics(),syntheticLaunches:resources.launches,syntheticAuthGenerations:resources.pids.filter(pid=>pid<0).length,syntheticClosed:closed,syntheticReservations:reserved,memoryEvidenceDocuments:documents.size}}
  }
}
/** NONACCEPTED direct-only qualification over a createNonacceptedOwnedCatalog()
 * facade: the same transaction, protected evidence writes and direct/wire
 * bundles, with that facade's observer double and private registries. It takes
 * no launch, so native runs, sign-in and a qualified record are unreachable. */
export async function runNonacceptedDirectQualification({owned,fixture,deadline,evidenceDir}){
  if(owned?.authority!==false)throw Error("unit_owned_catalog")
  const context=Object.freeze({...realCatalogTransaction,direct:owned.runDirectCatalog,retain:owned.retainDirectReceipt,
    wire:owned.runCatalogWireCase,complete:owned.completeDirectBundle})
  return {...await qualifyCatalogTransaction({fixture,deadline,evidenceDir},context),authority:false}
}
/** Complete shared workflow with isolated synthetic custody and memory only. */
export async function runNonacceptedCatalogTransaction(config){
  closedObject(config,["record","env","admission","chain","fixture","phaseFailure"],["failures"])
  const data=JSON.parse(catalogCanonical(config)),{fixture,phaseFailure,...base}=data
  const unit=createNonacceptedTriageUnit(base),documents=new Map()
  const evidenceDir=path.dirname(path.dirname(base.record.nativeReceipts[0].snapshotFile))
  let directIndex=0,wireIndex=0,syntheticLaunches=0
  const context={
    async outside(){if(phaseFailure==="outside")throw Error("unit_outside_failed")},
    async mkdir(){if(phaseFailure==="mkdir")throw Error("unit_mkdir_failed")},
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
    async native({nativeReceipts}){
      const result=await runNonacceptedNativeQualification(base)
      for(const item of result.evidence.filter(x=>x.name.endsWith("-bundle.json")))nativeReceipts.push(item.value)
      syntheticLaunches=result.statistics.syntheticLaunches
      if(result.outcome.state!=="qualified")throw Error("diagnostic_inadequate")
      return unit.seal().record
    },
    hostSeal:record=>unit.sealDocument(record).host_seal,
    async reload(){
      if(phaseFailure==="reloadThrows")throw Error("unit_reload_failed")
      if(phaseFailure==="reload")return {state:"blocked"}
      const saved=JSON.parse(documents.get(path.join(evidenceDir,"qualification.json")))
      await unit.save(saved);return (await unit.load()).outcome
    },
  }
  const outcome=await qualifyCatalogTransaction({launch:{env:base.env},fixture,deadline:Date.now()+HEADLESS_TIMEOUT_MS,evidenceDir},context)
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
