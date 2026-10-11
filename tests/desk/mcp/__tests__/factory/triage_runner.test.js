// Current owned-catalog policy and unchanged runtime/policy admission. Old
// native-path/dual-mission tests are superseded, retained in Git history.
import "../_isolated_env.mjs"
import {test} from "node:test"
import assert from "node:assert/strict"
import fsNative from "node:fs"
import {syncBuiltinESMExports} from "node:module"
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from "node:fs"
import {tmpdir} from "node:os"
import * as path from "node:path"
import {createHash} from "node:crypto"
import childProcess from "node:child_process"
import * as runner from "../../../../../plugins/desk/mcp/src/factory/triage-runner.js"
const hash=value=>createHash("sha256").update(value).digest("hex")
const flags=["--restricted","--safe-mode","--permission-mode","--permission-prompts","--tools","--disable-slash-commands","--no-chrome","--no-session-persistence","--strict-mcp-config","--mcp-config","--settings","--max-budget-usd","--output-format","--verbose","--system-prompt","--allowedTools"]
const metadata={host:"claude-code",flags}
const doctor="Claude Code doctor\nManaged settings (remote): not fetched — requires an Enterprise or Team subscription\nOrganization policy: not applicable to Pro and Max accounts\n"
const source={kind:"managed",revision:"a".repeat(64),settings:{}}
const readers={read:({cli}={})=>{
  const file=cli&&path.join(path.dirname(cli),"managed-policy.json")
  const current=file?{...source,path:file,settings:JSON.parse(readFileSync(file)),revision:hash(readFileSync(file))}:source
  return {complete:true,controller_invariant:true,sources:[current],validation_errors:[],
    capabilities:{customization_sources_disabled:true,result_is_data_only:true,engine_sha256:"fixture-only-not-native-attestation"}}
}}
const diagnostic=async()=>({kind:"closed",code:0,stdout:doctor,truncated:false})
async function fixture(t){
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),"triage-test-")))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const inputDir=path.join(dir,"input");fsNative.mkdirSync(inputDir,{mode:0o700})
  for(const [file,bytes]of [["engine","engine revision one"],["runtime","runtime revision one"],["managed-policy.json","{}"]])writeFileSync(path.join(dir,file),bytes)
  const resultFile=path.join(inputDir,".triage-result.json"),cli=path.join(dir,"engine")
  const resolveExec=()=>({cmd:cli,prefix:[],files:[cli,path.join(dir,"runtime")],supported:true})
  return {dir,inputDir,resultFile,cli,resolveExec,env:{HOME:dir,PATH:"/fixture",PRIVATE_SECRET:"not-for-child",HTTPS_PROXY:"https://proxy"}}
}
test("new_Node6_test_discovery_executes_real_exports",()=>{
  for(const name of ["runTriageChild","inspectLaunchChain","collectTriageAdmission","triagePolicy"])assert.equal(typeof runner[name],"function")
})
test("measurement_predicate_is_pure_while_real_guard_binds_actual_process",()=>{
  const cases=[
    [{env:{DESK_COVERAGE_RUNNER_CHILD:"1"},execArgv:[]},true],
    [{env:{NODE_OPTIONS:"--require synthetic"},execArgv:[]},true],
    [{env:{},execArgv:["--import","synthetic"]},true],
    [{env:{},execArgv:["--loader=synthetic"]},true],
    [{env:{NODE_OPTIONS:""},execArgv:["--verbose"]},false],
    [{env:{},execArgv:[]},false],
  ]
  for(const [value,want]of cases)assert.equal(runner.hasQualificationMeasurement(value),want)
  assert.equal(runner.qualificationMeasurementActive(),true,"real guard remains attached to this imported/measured process")
  const explicit={HOME:"unit-data-only"}
  assert.equal(runner.qualificationEnvironment(explicit),explicit)
  assert.equal(runner.qualificationEnvironment(undefined),process.env,"reference identity only; no inherited values are read or emitted")
})
test("owned_only_actual_manifest_required",async(t)=>{
  const f=await fixture(t)
  const custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const data=JSON.parse(readFileSync(new URL("./fixtures/v12-owned-catalog.json",import.meta.url)))
  await catalog.writeTriagePreparedFile({inputDir:f.inputDir,brief:data.brief,records:data.record_inputs,recordRefs:data.record_refs})
  const run=await custody.prepareOwnedCatalogRun({inputDir:f.inputDir,runDir:path.join(f.dir,"owned-run"),deadline:Date.now()+15000})
  t.after(()=>run.close())
  const p=runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:run.launch})
  assert.equal(p.state,"prepared");assert.equal(p.argv[p.argv.indexOf("--tools")+1],"")
  assert.deepEqual(p.settings.permissions.allow,["mcp__triage_catalog__evidence_read","mcp__triage_catalog__evidence_search","mcp__triage_catalog__evidence_list","mcp__triage_catalog__candidate_submit"])
  assert.equal(p.argv.at(-1),"Read prepared brief r000000, then its listed card IDs and their evidence using the prepared reference-to-ID maps. Review the prepared catalog and submit the closed triage candidate, preserving original references in the candidate.")
  for(const mutate of [r=>r.args.push("--load","/synthetic"),r=>r.env.HOME="/synthetic",r=>r.command="/synthetic",r=>r.identity.cleanEnv.OTHER="x"]){
    const changed=structuredClone(run.launch);mutate(changed)
    assert.equal(runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:changed}).state,"scope_unqualified")
  }
  assert.equal(runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:run.launch,mission:"qualification"}).state,"scope_unqualified")
  for(const change of [
    {cliMetadata:{host:"other",flags}}, {cliMetadata:{host:"claude-code",flags:[]}},
    {inputDir:"relative"}, {resultFile:"relative"}, {ownedServer:{}},
    {settings:{permissions:{allow:[],deny:[]},disableAllHooks:false}},
  ])assert.notEqual(runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:run.launch,...change}).state,"prepared")
})
test("old_native_record_never_qualifies_owned",async(t)=>{
  const f=await fixture(t);let calls=0
  for(const qualification of [{state:"qualified",record_version:1},{state:"qualified",version:2,enforcement_scheme:"owned_catalog_mcp"}]){
    assert.equal((await runner.runTriageChild({...f,qualification,spawn:()=>{calls++}})).state,"scope_unqualified")
  }
  assert.equal(calls,0)
})
test("instrumented_lane_cannot_issue_or_restore_qualification",async()=>{
  const prior=process.env.DESK_COVERAGE_RUNNER_CHILD
  process.env.DESK_COVERAGE_RUNNER_CHILD="1"
  try{
    assert.throws(()=>runner.sealOwnedQualification({}),{message:"qualification_instrumented"})
    const restored=await runner.loadTriageQualification({recordFile:"/synthetic/qualification.json"})
    assert.equal(restored.state,"scope_unqualified")
    assert.equal(restored.reason,"diagnostic_inadequate")
  }finally{if(prior===undefined)delete process.env.DESK_COVERAGE_RUNNER_CHILD;else process.env.DESK_COVERAGE_RUNNER_CHILD=prior}
})
test("instrumented_native_qualifier_refuses_before_store_or_child_effects",async(t)=>{
  const f=await fixture(t),qualifier=await import("../../../../../plugins/desk/mcp/scripts/qualify-triage-runner.js")
  const before=process.env.DESK_COVERAGE_RUNNER_CHILD
  process.env.DESK_COVERAGE_RUNNER_CHILD="1"
  let launches=0
  const out=path.join(f.dir,"must-not-be-created")
  try{
    const result=await qualifier.qualifyOwnedCatalog({launch:{cli:f.cli,env:f.env,spawn:()=>{launches++;throw Error("forbidden")}},
      fixture:null,deadline:Date.now()+2000,evidenceDir:out})
    assert.equal(result.state,"blocked")
    assert.equal(result.reason,"diagnostic_inadequate")
    assert.equal(launches,0)
    assert.equal(fsNative.existsSync(out),false,"measurement must not create or persist a real qualification store")
  }finally{
    if(before===undefined)delete process.env.DESK_COVERAGE_RUNNER_CHILD
    else process.env.DESK_COVERAGE_RUNNER_CHILD=before
  }
})
test("qualifier_direct_entry_guards_are_measured_without_native_or_store_authority",async(t)=>{
  const f=await fixture(t),qualifier=await import("../../../../../plugins/desk/mcp/scripts/qualify-triage-runner.js")
  const entry=new URL("../../../../../plugins/desk/mcp/scripts/qualify-triage-runner.js",import.meta.url).pathname
  assert.equal(await qualifier.qualifierEntry({argv:[process.execPath,"not-the-entry"]}),null)
  for(const args of [[],["--out",f.dir],["--out",f.dir,"--out",f.dir],
    ["--other",f.dir,"--cli",f.cli],["--out",f.dir,"--other",f.cli],
    ["--out",path.join(f.dir,"never-created"),"--cli",f.cli]]){
    let output=""
    const runtime={argv:[process.execPath,entry,...args],stdout:{write:line=>{output+=line}}}
    await qualifier.qualifierEntry(runtime)
    assert.equal(runtime.exitCode,1)
    assert.equal(JSON.parse(output).state,"blocked")
    assert.equal(fsNative.existsSync(path.join(f.dir,"never-created")),false)
  }
})
test("qualified_format_full_per_run_identity",async(t)=>{
  const f=await fixture(t),custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const data=JSON.parse(readFileSync(new URL("./fixtures/v12-owned-catalog.json",import.meta.url)))
  await catalog.writeTriagePreparedFile({inputDir:f.inputDir,brief:data.brief,records:data.record_inputs,recordRefs:data.record_refs})
  const identities=[]
  for(let i=0;i<2;i++){
    const run=await custody.prepareOwnedCatalogRun({inputDir:f.inputDir,runDir:path.join(f.dir,`identity-${i}`),deadline:Date.now()+15000})
    t.after(()=>run.close())
    const policy=runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:run.launch})
    const invocation={command:f.cli,args:policy.argv,cwd:run.runDir,parent_env_sha256:hash(catalog.catalogCanonical({HOME:f.dir,DESK_FACTORY_HEADLESS:"1"})),owned_launch:run.launch,
      prepared_sha256:run.prepared.sha256,catalog_sha256:run.catalog.catalogSha256,brief_sha256:run.catalog.briefSha256,record_refs_sha256:run.catalog.recordRefsSha256}
    const config={invocation,chain:{effective_argv:[f.cli]},cliMetadata:metadata,env:{HOME:f.dir}}
    const identity=runner.ownedInvocationIdentity(config);identities.push(identity)
    for(const mutate of [
      x=>x.invocation.args.push("--add-dir","/synthetic"),
      x=>{x.invocation.args[x.invocation.args.indexOf("--system-prompt")+1]+=" extra"},
      x=>{x.invocation.cwd=f.inputDir},
      x=>{x.invocation.parent_env_sha256="a".repeat(64)},
      x=>{x.invocation.owned_launch.args[0]="--ignore-environment"},
      x=>{x.invocation.owned_launch.identity.bootstrap.generation="bad"},
      x=>{x.invocation.owned_launch.nativePid=0},
      x=>{x.cliMetadata={host:"claude-code",flags:[]}},
    ]){
      const changed=structuredClone(config);mutate(changed)
      assert.throws(()=>runner.ownedInvocationIdentity(changed))
    }
    for(const method of ["indexOf","lastIndexOf"]){
      const original=Array.prototype[method]
      Array.prototype[method]=function(value,...args){
        if(value==="--sha256"&&this[0]==="-i")return method==="indexOf"?-1:original.call(this,value,...args)+1
        return original.call(this,value,...args)
      }
      try{assert.throws(()=>runner.ownedInvocationIdentity(config),{message:"invocation_slot"})}
      finally{Array.prototype[method]=original}
    }
  }
  assert.equal(identities[0].template_sha256,identities[1].template_sha256)
  assert.notEqual(identities[0].full_sha256,identities[1].full_sha256)
})
test("synthetic_record_structure_validation_never_issues_authority",async(t)=>{
  const f=await fixture(t),custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const data=JSON.parse(readFileSync(new URL("./fixtures/v12-owned-catalog.json",import.meta.url)))
  await catalog.writeTriagePreparedFile({inputDir:f.inputDir,brief:data.brief,records:data.record_inputs,recordRefs:data.record_refs})
  const sourceIdentity=await custody.ownedSourceIdentity(),out=f.dir,env={HOME:f.dir},nativeReceipts=[],directReceipts=[],invocationIdentities=[]
  for(let i=1;i<=2;i++){
    const run=await custody.prepareOwnedCatalogRun({inputDir:f.inputDir,runDir:path.join(out,`native-${i}`),deadline:Date.now()+15000})
    t.after(()=>run.close())
    const policy=runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:run.launch})
    const invocation={command:f.cli,args:policy.argv,cwd:run.runDir,parent_env_sha256:hash(catalog.catalogCanonical({HOME:f.dir,DESK_FACTORY_HEADLESS:"1"})),owned_launch:run.launch,
      prepared_sha256:run.prepared.sha256,catalog_sha256:run.catalog.catalogSha256,brief_sha256:run.catalog.briefSha256,record_refs_sha256:run.catalog.recordRefsSha256}
    nativeReceipts.push({snapshotFile:path.join(out,`native-${i}`,"catalog.json"),invocation,custody:{sourceIdentity}})
    directReceipts.push({snapshotArchive:path.join(out,`direct-${i}`,"catalog.json"),tools:catalog.catalogToolSchemas().tools})
    invocationIdentities.push(runner.ownedInvocationIdentity({invocation,chain:{effective_argv:[f.cli]},cliMetadata:metadata,env}))
  }
  const synthetic={version:2,enforcement_scheme:"owned_catalog_mcp",state:"qualified",env_recipe_version:2,sourceIdentity,
    policy_sources_fingerprint:"a".repeat(64),chain_fingerprint:"b".repeat(64),directReceipts,nativeReceipts,cliMetadata:metadata,
    cli:f.cli,format_fingerprint:hash(catalog.catalogCanonical(directReceipts[0].tools)),resources:{native_launches:2,direct_bundles:2},invocationIdentities}
  assert.deepEqual(runner.validateOwnedQualificationStructure({record:synthetic,out,sourceIdentity,env}),{state:"structure_validated",authority:false})
  const document=runner.prepareOwnedQualificationDocument({directReceipts,nativeReceipts,admission:{sources:[],remote_delivery:"not_applicable",capabilities:null},
    chain:{effective_argv:[f.cli],fingerprint:"b".repeat(64)},cliMetadata:metadata,cli:path.join(f.dir,"indirect-selector"),env})
  assert.equal(document.state,"unaccepted_document");assert.equal(document.authority,false)
  assert.equal(document.record.cli,f.cli,"record binds actual execution target, not original selector")
  const lateArgs=structuredClone(nativeReceipts),secondArgs=lateArgs[1].invocation.args
  secondArgs[Symbol.iterator]=function*(){for(let i=0;i<this.length;i++)yield i===0?"unit-late-argv-drift":this[i]}
  assert.throws(()=>runner.prepareOwnedQualificationDocument({directReceipts,nativeReceipts:lateArgs,
    admission:{sources:[],remote_delivery:"not_applicable",capabilities:null},
    chain:{effective_argv:[f.cli],fingerprint:"b".repeat(64)},cliMetadata:metadata,env}),{message:"invocation_template"})
  const unitConfig={record:document.record,env,admission:{state:"admitted",sources:[],remote_delivery:"not_applicable",capabilities:null,fingerprint:"unit-admission"},
    chain:{state:"inspected",effective_argv:[f.cli],fingerprint:"b".repeat(64)}}
  const unit=runner.createNonacceptedTriageUnit(unitConfig)
  const sealed=unit.seal()
  assert.equal(sealed.authority,false);assert.equal(sealed.state,"unit_registered")
  assert.equal(unit.lookup(sealed.record).registered,true)
  const successful=await unit.run(sealed.record)
  assert.equal(successful.authority,false);assert.equal(successful.outcome.state,"ran")
  assert.equal(unit.statistics().runs,1)
  // Shared native IO -> registered-runner public state projection, not a fake
  // transaction returning predetermined timeout/budget states.
  for(const [mode,state,cost]of [["softTimeout","timeout",null],["budget","budget_exceeded",1.25]]){
    const native=runner.createNonacceptedTriageUnit({...unitConfig,failures:{nativeMode:mode}})
    const result=await native.run(native.seal().record)
    assert.equal(result.outcome.state,state,mode)
    assert.equal(result.outcome.cost_usd,cost,mode)
    assert.equal(result.authority,false)
  }
  // Removing the fresh chain checks would launch after sign-in drift or
  // return a fresh candidate after run-time drift. Only unit-owned state moves.
  for(const [failure,runs]of [
    ["signInChainDrift",0],["signInChainUnknown",0],["runChainDrift",1],["runChainUnknown",1],
    ["signInArgvDrift",0],["runArgvDrift",1],["postExitAdmission",1],["postExitIdentity",1],
  ]){
    const changed=runner.createNonacceptedTriageUnit({...unitConfig,failures:{[failure]:true}})
    const result=await changed.run(changed.seal().record)
    assert.equal(result.outcome.state,"scope_changed",failure)
    assert.equal(changed.statistics().runs,runs,failure)
    assert.equal(changed.statistics().closed,1,failure)
  }
  assert.equal((await runner.runTriageChild({...f,qualification:sealed.record,spawn:()=>{throw Error("real spawn forbidden")}})).state,"scope_unqualified")
  await unit.save(sealed.record)
  const loaded=await unit.load()
  assert.equal(loaded.authority,false);assert.equal(loaded.outcome.state,"qualified")
  assert.equal(unit.lookup(loaded.outcome).registered,true)
  assert.equal((await unit.run(structuredClone(sealed.record))).outcome.state,"scope_unqualified")
  const lostCLI=unit.seal().record,cliValue=lostCLI.cli
  let cliReads=0
  Object.defineProperty(lostCLI,"cli",{enumerable:true,get:()=>++cliReads===1?cliValue:null})
  assert.equal((await unit.run(lostCLI)).outcome.state,"no_agent_cli","late lost selector must never reach a child effect")
  for(const mutate of [x=>x.version=1,x=>x.state="blocked"]){
    const malformed=unit.seal().record;mutate(malformed)
    assert.equal((await unit.run(malformed)).outcome.state,"scope_unqualified")
  }
  for(const field of ["sourceIdentity","cliMetadata"]){
    const altered=structuredClone(unitConfig)
    if(field==="sourceIdentity")altered.record.nativeReceipts[1].custody.sourceIdentity={unexpected:true}
    else altered.record.nativeReceipts[1].invocation.command="/synthetic/different-command"
    assert.throws(()=>runner.createNonacceptedTriageUnit(altered).seal())
  }
  sealed.record.format_fingerprint="f".repeat(64)
  assert.equal((await unit.run(sealed.record)).outcome.state,"scope_unqualified")
  for(const failures of [{native:true},{direct:true}]){
    const denied=runner.createNonacceptedTriageUnit({...unitConfig,failures})
    assert.throws(()=>denied.seal())
    assert.equal(denied.lookup(document.record).registered,false)
  }
  for(const [failure,want]of [
    ["source","scope_changed"],["prepare","scope_unqualified"],["policy","scope_unqualified"],["chain","scope_unqualified"],
    ["admission","scope_unqualified"],["admissionIdentity","scope_changed"],["chainIdentity","scope_changed"],
    ["signIn","no_credentials"],["prepared","scope_changed"],["invocation","scope_changed"],["run","failed"],
    ["postAdmission","scope_changed"],["postIdentity","scope_changed"],["throwRun","scope_unqualified"],
    ["runTimeout","timeout"],["runBudget","budget_exceeded"],["runUnqualified","scope_unqualified"],
    ["badSignIn","failed"],["close","scope_unqualified"],
  ]){
    const isolated=runner.createNonacceptedTriageUnit({...unitConfig,failures:{[failure]:true}})
    const registered=isolated.seal()
    const outcome=await isolated.run(registered.record)
    assert.equal(outcome.authority,false);assert.equal(outcome.outcome.state,want,failure)
    if(!["source","prepare"].includes(failure))assert.ok(isolated.statistics().closed>=1,`${failure}: owned unit handle closes`)
  }
  for(const failure of ["read","restoreDirect","restoreNative","restoreAuthNative","restoreAuthDirect"]){
    const isolated=runner.createNonacceptedTriageUnit({...unitConfig,failures:{[failure]:true}})
    await isolated.save(document.record)
    const refused=await isolated.load()
    assert.equal(refused.outcome.state,"scope_unqualified",failure)
    assert.equal(isolated.lookup(refused.outcome).registered,false)
  }
  const writeFailure=runner.createNonacceptedTriageUnit({...unitConfig,failures:{write:true}})
  await assert.rejects(writeFailure.save(document.record))
  assert.equal((await writeFailure.load()).outcome.state,"scope_unqualified")
  const cliMismatch=runner.createNonacceptedTriageUnit(unitConfig)
  await cliMismatch.save(document.record)
  assert.equal((await cliMismatch.load({cli:"/synthetic/other"})).outcome.reason,"launch_chain_unknown")
  const qualifier=await import("../../../../../plugins/desk/mcp/scripts/qualify-triage-runner.js")
  const memoryFlow=await qualifier.runNonacceptedQualifierTransaction(unitConfig)
  assert.equal(memoryFlow.authority,false)
  assert.equal(memoryFlow.outcome.state,"qualified")
  assert.equal(memoryFlow.statistics.memoryDocuments,1)
  assert.deepEqual(qualifier.qualificationCLIOutcome(memoryFlow.outcome),{exitCode:0,line:'{"state":"qualified"}\n'})
  const nativeUnit=await qualifier.runNonacceptedNativeQualification(unitConfig)
  assert.equal(nativeUnit.authority,false)
  assert.equal(nativeUnit.outcome.state,"qualified")
  assert.equal(nativeUnit.statistics.syntheticLaunches,2)
  assert.equal(nativeUnit.statistics.syntheticAuthGenerations,2)
  assert.equal(nativeUnit.statistics.memoryDocuments,1)
  for(const failure of ["policy","chain","chainIdentity","admission","admissionIdentity","signIn","prepared","postAdmission","postIdentity","native","direct","write","read"]){
    const refused=await qualifier.runNonacceptedNativeQualification({...unitConfig,failures:{[failure]:true}})
    assert.equal(refused.authority,false)
    assert.equal(refused.outcome.state,"blocked",failure)
  }
  const missingMetadata={...unitConfig,record:{...unitConfig.record,cliMetadata:null}}
  const helpUnit=await qualifier.runNonacceptedNativeQualification(missingMetadata)
  assert.equal(helpUnit.authority,false)
  assert.equal(helpUnit.outcome.state,"blocked","invalid synthetic record never becomes accepted")
  assert.equal(helpUnit.statistics.syntheticLaunches,2,"shared bounded help route must reach both synthetic-only launch operations")
  for(const failure of ["read","write","restoreNative","policy"]){
    const refused=await qualifier.runNonacceptedNativeQualification({...missingMetadata,failures:{[failure]:true}})
    assert.equal(refused.outcome.state,"blocked")
    assert.equal(refused.statistics.syntheticLaunches,0)
  }
  for(const change of [
    {env:{...unitConfig.env,ANTHROPIC_API_KEY:"unit_nonaccepted_not_a_real_key"}},
    {record:{...unitConfig.record,cliMetadata:{host:"other",flags:[]}}},
    {failures:{prepare:true}},
  ])assert.equal((await qualifier.runNonacceptedNativeQualification({...unitConfig,...change})).outcome.state,"blocked")
  const abortedNative=await qualifier.runNonacceptedNativeQualification({...unitConfig,failures:{throwRun:true}})
  assert.equal(abortedNative.outcome.state,"blocked")
  assert.equal(abortedNative.statistics.syntheticClosed,1,"exception must close the prepared unit handle before returning")
  assert.equal((await runner.runTriageChild({env:{HOME:f.dir},inputDir:f.inputDir,resultFile:f.resultFile,qualification:{}})).state,"scope_unqualified")
  for(const failure of [undefined,"direct","wire","partial","partialIndices","write","reload"]){
    const transaction=await qualifier.runNonacceptedCatalogTransaction({...unitConfig,fixture:data,phaseFailure:failure??null})
    assert.equal(transaction.authority,false)
    assert.equal(transaction.outcome.state,failure?"blocked":"qualified",String(failure))
    assert.equal(transaction.statistics.diskWrites,0)
    assert.equal(transaction.statistics.actualLaunches,0)
  }
  const nativeFailure=await qualifier.runNonacceptedCatalogTransaction({...unitConfig,fixture:data,phaseFailure:null,failures:{admission:true}})
  assert.equal(nativeFailure.outcome.state,"blocked")
  assert.equal(nativeFailure.outcome.reason,"diagnostic_inadequate")
  for(const failure of ["native","direct","write","read","restoreNative","restoreDirect"]){
    const result=await qualifier.runNonacceptedQualifierTransaction({...unitConfig,failures:{[failure]:true}})
    assert.equal(result.authority,false)
    assert.equal(result.outcome.state,"blocked",failure)
    if(["native","direct","write"].includes(failure))assert.equal(result.statistics.memoryDocuments,0)
  }
  for(const override of [{registry:new WeakMap()},{issuer:()=>{}},{store:{}},{measurement:()=>false}]){
    assert.throws(()=>runner.createNonacceptedTriageUnit({...unitConfig,...override}))
  }
  const unitFixtureFile=path.join(f.dir,"qualification.json")
  writeFileSync(unitFixtureFile,catalog.catalogCanonical(document.record)+"\n",{mode:0o600})
  const moduleURL=new URL("../../../../../plugins/desk/mcp/src/factory/triage-runner.js",import.meta.url).href
  const negativeScript=`import fs from "node:fs";import * as path from "node:path";import * as runner from ${JSON.stringify(moduleURL)};
const recordFile=process.argv[1],record=JSON.parse(fs.readFileSync(recordFile)),dir=path.dirname(recordFile);
let launches=0;
const run=await runner.runTriageChild({env:{HOME:dir},inputDir:dir,resultFile:path.join(dir,"unaccepted.json"),qualification:record,spawn:()=>{launches++;throw Error("forbidden")}});
const load=await runner.loadTriageQualification({recordFile,env:{HOME:dir}});
console.log(JSON.stringify({run:run.state,load:load.state,launches}));`
  const negative=childProcess.spawnSync(process.execPath,["--input-type=module","-e",negativeScript,unitFixtureFile],
    {env:{LANG:"C",LC_ALL:"C",TZ:"UTC"},encoding:"utf8",timeout:10000})
  assert.equal(negative.status,0,negative.stderr)
  assert.deepEqual(JSON.parse(negative.stdout),{run:"scope_unqualified",load:"scope_unqualified",launches:0})
  assert.equal((await runner.runTriageChild({...f,qualification:document.record,spawn:()=>{throw Error("no authority")}})).state,"scope_unqualified")
  const noSchemas=structuredClone(synthetic);noSchemas.directReceipts[0].tools=[];noSchemas.directReceipts[1].tools=[]
  noSchemas.format_fingerprint=hash(catalog.catalogCanonical([]))
  assert.throws(()=>runner.validateOwnedQualificationStructure({record:noSchemas,out,sourceIdentity,env}),
    {message:"qualification_structure"})
  assert.equal((await runner.runTriageChild({...f,qualification:synthetic,spawn:()=>{throw Error("no authority")}})).state,"scope_unqualified")
  const indirect=structuredClone(synthetic);indirect.cli=path.join(f.dir,"engine-selector")
  assert.throws(()=>runner.validateOwnedQualificationStructure({record:indirect,out,sourceIdentity,env}))
  for(const mutate of [
    x=>x.version=1,x=>x.enforcement_scheme="native",x=>x.state="probing",x=>x.env_recipe_version=1,
    x=>x.directReceipts.pop(),x=>x.nativeReceipts.pop(),x=>x.invocationIdentities.pop(),
    x=>x.sourceIdentity.files.extra="changed",x=>x.policy_sources_fingerprint="bad",x=>x.chain_fingerprint=null,
    x=>x.format_fingerprint="f".repeat(64),x=>x.directReceipts[0].snapshotArchive="/synthetic/elsewhere",
    x=>x.nativeReceipts[0].snapshotFile="/synthetic/elsewhere",x=>x.resources.native_launches=1,
    x=>x.resources.extra=true,x=>x.invocationIdentities[1].full_sha256="a".repeat(64),
    x=>x.nativeReceipts[1].invocation.args.push("--bypass-permissions"),
  ]){
    const changed=structuredClone(synthetic);mutate(changed)
    assert.throws(()=>runner.validateOwnedQualificationStructure({record:changed,out,sourceIdentity,env}))
  }
})
test("isolated_document_reader_is_closed_and_never_issues_authority",async(t)=>{
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),"unaccepted-document-")));fsNative.chmodSync(dir,0o700)
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const file=path.join(dir,"qualification.json"),value={state:"synthetic_nonaccepted",version:0}
  writeFileSync(file,JSON.stringify(value)+"\n",{mode:0o600})
  assert.deepEqual(await runner.readTriageQualificationDocument(file),{state:"unaccepted_document",authority:false,record:value})
  for(const bytes of [
    '{"version":0,"state":"synthetic_nonaccepted"}\n',
    '{"state":"synthetic_nonaccepted","state":"changed","version":0}\n',
    '{\n',Buffer.from([0xff,10]),
  ]){
    writeFileSync(file,bytes)
    await assert.rejects(runner.readTriageQualificationDocument(file))
  }
  writeFileSync(file,JSON.stringify(value)+"\n")
  writeFileSync(file,Buffer.alloc(16*1024*1024+1))
  await assert.rejects(runner.readTriageQualificationDocument(file),{message:"qualification_size"})
  writeFileSync(file,JSON.stringify(value)+"\n")
  const open=fsNative.promises.open
  for(const scenario of ["dev","ino","short","changed"]){
    let handle
    fsNative.promises.open=async(...args)=>{
      handle=await open(...args)
      const stat=handle.stat.bind(handle),read=handle.readFile.bind(handle)
      if(["dev","ino"].includes(scenario))handle.stat=async()=>{const s=await stat();return {...s,[scenario]:s[scenario]+1}}
      else handle.readFile=async()=>{const bytes=await read();if(scenario==="changed")fsNative.appendFileSync(file," ");return scenario==="short"?bytes.subarray(1):bytes}
      return handle
    }
    try{await assert.rejects(runner.readTriageQualificationDocument(file));assert.equal(handle.fd,-1)}
    finally{fsNative.promises.open=open;writeFileSync(file,JSON.stringify(value)+"\n")}
  }
  fsNative.chmodSync(file,0o644);await assert.rejects(runner.readTriageQualificationDocument(file))
  fsNative.chmodSync(file,0o600)
  fsNative.renameSync(file,file+".original");fsNative.symlinkSync(file+".original",file)
  await assert.rejects(runner.readTriageQualificationDocument(file))
  await assert.rejects(runner.readTriageQualificationDocument(path.join(dir,"other.json")))
  await assert.rejects(runner.readTriageQualificationDocument("qualification.json"))
})
test("owned_runner_guards_precede_record_or_discovery",async(t)=>{
  const f=await fixture(t);const spawn=()=>{throw Error("no launch")}
  assert.equal((await runner.runTriageChild({...f,env:{...f.env,DESK_FACTORY_HEADLESS:"1"},spawn})).state,"headless_session")
  assert.equal((await runner.runTriageChild({...f,env:{...f.env,ANTHROPIC_API_KEY:"synthetic"},spawn})).state,"disabled_would_bill")
  assert.equal((await runner.runTriageChild({...f,deadline:0,spawn})).state,"no_time_for_a_run")
})
test("compatible_trusted_policy_is_admissible_without_admin_tamper_proof",async(t)=>{
  const f=await fixture(t),r=await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic,policyReaders:readers})
  assert.equal(r.state,"admitted");assert.equal(r.remote_delivery,"not_applicable");assert.match(r.fingerprint,/^[a-f0-9]{64}$/)
})
test("pending_applicable_policy_blocks",async(t)=>{
  const f=await fixture(t)
  for(const [stdout,reason]of [["Managed settings (remote): checking… (fetch in progress; re-run in a moment)","applicable_delivery_pending"],["Managed settings (remote): unfamiliar future message","diagnostic_inadequate"],["Managed settings (remote): fetch failed (cached policy applies)","effective_policy_unknown"]]){
    const r=await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:async()=>({kind:"closed",code:0,stdout}),policyReaders:readers})
    assert.equal(r.state,"scope_unqualified");assert.equal(r.reason,reason)
  }
  for(const stdout of ["Managed settings (remote): no server-managed settings configured","Managed settings (remote): delivered settings loaded"]){
    const r=await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:async()=>({kind:"closed",code:0,stdout}),policyReaders:readers})
    assert.equal(r.state,"admitted")
    assert.equal(r.remote_delivery,stdout.includes("loaded")?"delivered":"no_configuration")
  }
})
test("effective_hook_helper_or_widening_grant_blocks",async(t)=>{
  const f=await fixture(t)
  for(const [settings,reason]of [[{hooks:{SessionStart:[{hooks:[{type:"command",command:"never execute this"}]}]}},"active_hook_or_helper"],[{policyHelper:"never execute this"},"active_hook_or_helper"],[{permissions:{allow:["Edit"]}},"unsafe_permission_grant"],[{permissions:{additionalDirectories:["/outside"]}},"unsafe_permission_grant"],[{env:{ANTHROPIC_API_KEY:"secret"}},"billing_unresolved"],[{mcpServers:{unsafe:{}}},"unsafe_permission_grant"]]){
    const r=await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic,policyReaders:{read:()=>({complete:true,controller_invariant:true,sources:[{...source,settings}],validation_errors:[]})}})
    assert.equal(r.reason,reason);assert.equal(JSON.stringify(r).includes("secret"),false);assert.equal(JSON.stringify(r).includes("never execute"),false)
  }
})
test("launcher_or_engine_change_invalidates_qualification",async(t)=>{
  const f=await fixture(t),before=runner.inspectLaunchChain(f)
  writeFileSync(path.join(f.dir,"runtime"),"runtime revision two");assert.notEqual(runner.inspectLaunchChain(f).fingerprint,before.fingerprint)
  writeFileSync(f.cli,"engine revision two");assert.notEqual(runner.inspectLaunchChain(f).fingerprint,before.fingerprint)
  assert.equal(runner.inspectLaunchChain({...f,resolveExec:()=>null}).state,"scope_unqualified")
})
test("default_local_policy_matrix_reads_synthetic_documents_without_command_execution",async(t)=>{
  const f=await fixture(t),realRead=fsNative.readFileSync,realList=fsNative.readdirSync
  const cli=path.join(process.env.DESK_TEST_REAL_HOME,".local","share","claude","versions","2.1.296")
  const platform=Object.getOwnPropertyDescriptor(process,"platform")
  let mode="valid",diagnostics=0,verifications=0
  assert.equal(fsNative.existsSync(cli),true,"this concrete host's already-selected installed source remains available")
  t.mock.method(fsNative,"readFileSync",(file,...args)=>{
    const name=String(file)
    if(name===cli)return realRead(file,...args)
    if(name.includes("ClaudeCode")||name.includes("/Managed Preferences/")||name.startsWith(f.dir)){
      if(name.endsWith(".plist"))return Buffer.from("unit plist bytes")
      if(name.includes("managed-settings.json")&&mode==="invalid_managed")return Buffer.from('{"disableAllHooks":"invalid"}')
      if(name.endsWith("settings.json")&&!name.includes("managed")&&mode==="invalid_user")return Buffer.from('{"permissions":3}')
      if(name.endsWith("settings.json")&&!name.includes("managed")&&mode==="syntax_user")return Buffer.from("{")
      if(name.endsWith("remote-settings.json")&&mode==="remote_cached")return Buffer.from('{"permissions":{}}')
      return Buffer.from("{}")
    }
    return realRead(file,...args)
  })
  t.mock.method(fsNative,"readdirSync",(file,...args)=>String(file).endsWith("managed-settings.d")?
    ["z.json",".ignored.json","not-json.txt"]:realList(file,...args))
  t.mock.method(childProcess,"execFileSync",(command,args)=>{
    assert.ok(["/usr/bin/codesign","/usr/bin/plutil"].includes(command),"no engine/helper/auth command is executed")
    if(command==="/usr/bin/codesign"){verifications++;return ""}
    return "{}"
  })
  syncBuiltinESMExports()
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process,"platform",platform)})
  Object.defineProperty(process,"platform",{...platform,value:"darwin"})
  const diagnostic=async()=>{diagnostics++;return {kind:"closed",code:0,stdout:doctor}}
  const flags=["--restricted","--safe-mode","--strict-mcp-config"]
  const admitted=await runner.collectTriageAdmission({cli,env:{HOME:f.dir},argv:flags,runDiagnostic:diagnostic})
  assert.equal(admitted.state,"admitted")
  assert.equal(verifications,2)
  assert.equal(diagnostics,1)
  for(const argv of [[],["--restricted"],["--restricted","--safe-mode"]]){
    assert.equal((await runner.collectTriageAdmission({cli,env:{HOME:f.dir},argv,runDiagnostic:diagnostic})).state,"scope_unqualified")
  }
  for(const value of ["invalid_managed","invalid_user","syntax_user","remote_cached"]){
    mode=value
    assert.equal((await runner.collectTriageAdmission({cli,env:{HOME:f.dir,CLAUDE_CONFIG_DIR:path.join(f.dir,"synthetic-config")},argv:flags,runDiagnostic:diagnostic})).state,"scope_unqualified",value)
  }
  mode="valid"
  for(const value of ["linux","win32"]){
    Object.defineProperty(process,"platform",{...platform,value})
    assert.equal((await runner.collectTriageAdmission({cli,env:{HOME:f.dir},argv:flags,runDiagnostic:diagnostic})).state,"scope_unqualified",value)
  }
})
test("chain_relative_files_and_selected_permissions_fail_closed",async(t)=>{
  const f=await fixture(t)
  assert.equal(runner.inspectLaunchChain({...f,cli:"relative"}).reason,"launch_chain_unknown")
  assert.equal(runner.inspectLaunchChain({...f,resolveExec:()=>({supported:true,cmd:f.cli,files:[f.cli,"relative"],prefix:[]})}).reason,"launch_chain_unknown")
  const settings={permissions:{allow:["mcp__triage_catalog__evidence_read"],deny:[]}}
  const result=await runner.collectTriageAdmission({...f,argv:["--settings",JSON.stringify(settings)],
    runDiagnostic:diagnostic,policyReaders:{read:()=>({complete:true,controller_invariant:true,validation_errors:[],sources:[{...source,settings}]})}})
  assert.equal(result.state,"admitted")
  assert.equal(result.capabilities,null)
})
test("admission_missing_invalid_and_incompatible_evidence_never_becomes_none",async(t)=>{
  const f=await fixture(t)
  for(const [observed,evidence,reason]of [
    [{kind:"timeout"},readers.read(),"diagnostic_inadequate"],[{kind:"closed",code:1,stdout:doctor},readers.read(),"diagnostic_inadequate"],
    [{kind:"closed",code:0,truncated:true,stdout:doctor},readers.read(),"diagnostic_inadequate"],[{kind:"closed",code:0,stdout:3},readers.read(),"diagnostic_inadequate"],
    [{kind:"closed",code:0,stdout:""},readers.read(),"diagnostic_inadequate"],[null,undefined,"diagnostic_inadequate"],
    [null,{sources:[],validation_errors:[],complete:false},"diagnostic_inadequate"],[null,{...readers.read(),controller_invariant:false},"policy_control_unsupported"],
    [null,{...readers.read(),validation_errors:["private raw settings error"]},"effective_policy_unknown"],
    ...[{kind:"future"},{revision:"unknown"},{settings:null},{settings:[]},{settings:{futurePolicy:true}},{settings:{permissions:{deny:["Read"]}}}].map(x=>[null,{...readers.read(),sources:[{...source,...x}]},x.settings?.permissions?"unsafe_permission_grant":"effective_policy_unknown"]),
  ]){
    const r=await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:observed?async()=>observed:diagnostic,policyReaders:{read:()=>evidence}})
    assert.equal(r.state,"scope_unqualified");assert.equal(r.reason,reason);assert.equal(JSON.stringify(r).includes("private raw"),false)
  }
  for(const env of [{...f.env,DESK_FACTORY_HEADLESS:"1"},{...f.env,ANTHROPIC_API_KEY:"private"}])assert.equal((await runner.collectTriageAdmission({...f,env,argv:[],runDiagnostic:()=>{throw Error("must not run")}})).state,"scope_unqualified")
  assert.equal((await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:()=>{throw Error("failed diagnostic")}})).reason,"effective_policy_unknown")
  assert.equal((await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic,policyReaders:{...readers,captureDiagnostic:()=>{throw Error("private capture failed")}}})).reason,"effective_policy_unknown")
  assert.equal((await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic})).reason,"diagnostic_inadequate")
  assert.equal((await runner.collectTriageAdmission({...f,cli:process.execPath,argv:[]})).reason,"diagnostic_inadequate")
})
test("native_loader_inspection_refuses_unknown_or_unreadable_images",async(t)=>{
  const f={...await fixture(t),resolveExec:undefined},realRead=fsNative.readFileSync,realPath=fsNative.realpathSync
  let files=new Map()
  t.mock.method(fsNative,"readFileSync",(file,...args)=>files.has(String(file))?files.get(String(file)):realRead(file,...args))
  t.mock.method(fsNative,"realpathSync",(file,...args)=>files.has(String(file))?String(file):realPath(file,...args));syncBuiltinESMExports()
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()})
  const image=(dependencies=[])=>{
    const b=Buffer.alloc(32+dependencies.length*160);b.writeUInt32LE(0xfeedfacf,0);b.writeUInt32LE(dependencies.length,16)
    dependencies.forEach((dep,i)=>{const o=32+i*160;b.writeUInt32LE(0xc,o);b.writeUInt32LE(160,o+4);b.writeUInt32LE(24,o+8);b.write(dep,o+24)});return b
  }
  files=new Map([[f.cli,image(["/fixture/dependency"])],["/fixture/dependency",image()],["/usr/lib/dyld",image()]])
  assert.equal(runner.inspectLaunchChain(f).state,"inspected")
  files.set("/fixture/dependency",image([f.cli]));assert.equal(runner.inspectLaunchChain(f).state,"inspected")
  const non=image(["not a dependency"]);non.writeUInt32LE(0xd,32);files.set(f.cli,non);assert.equal(runner.inspectLaunchChain(f).state,"inspected")
  for(const b of [Buffer.alloc(3),Buffer.alloc(32),image(["@rpath/libunknown"])]){files.set(f.cli,b);assert.equal(runner.inspectLaunchChain(f).state,"scope_unqualified")}
  const many=image();many.writeUInt32LE(4097,16);files.set(f.cli,many);assert.equal(runner.inspectLaunchChain(f).state,"scope_unqualified")
  const bad=image(["/fixture/dependency"]);bad.writeUInt32LE(4,36);files.set(f.cli,bad);assert.equal(runner.inspectLaunchChain(f).state,"scope_unqualified")
  bad.writeUInt32LE(999999,36);assert.equal(runner.inspectLaunchChain(f).state,"scope_unqualified")
  for(const offset of [0,160]){const b=image(["/fixture/dependency"]);b.writeUInt32LE(offset,40);files.set(f.cli,b);assert.equal(runner.inspectLaunchChain(f).state,"scope_unqualified")}
  const noEnd=image(["/fixture/dependency"]);noEnd.fill(65,56);files.set(f.cli,noEnd);assert.equal(runner.inspectLaunchChain(f).state,"scope_unqualified")
  const outside=image(["unknown","/fixture/dependency"]);outside.fill(65,56,192);files.set(f.cli,outside);assert.equal(runner.inspectLaunchChain(f).state,"scope_unqualified")
  files=new Map([[f.cli,image(["/fixture/0"])],["/usr/lib/dyld",image()]])
  for(let i=0;i<65;i++)files.set(`/fixture/${i}`,image([`/fixture/${i+1}`]))
  assert.equal(runner.inspectLaunchChain(f).state,"scope_unqualified")
})
test("local_policy_reader_never_executes_command_bearing_settings",async(t)=>{
  const f=await fixture(t),platform=Object.getOwnPropertyDescriptor(process,"platform"),realRead=fsNative.readFileSync,realList=fsNative.readdirSync
  let mode="safe"
  t.mock.method(fsNative,"readdirSync",(file,...args)=>{
    if(!String(file).endsWith("managed-settings.d"))return realList(file,...args)
    if(mode==="unreadable")throw Object.assign(Error("private policy directory"),{code:"EACCES"})
    return ["20.json",".hidden.json","not-json.txt","10.json"]
  })
  t.mock.method(fsNative,"readFileSync",(file,...args)=>{
    if(!String(file).includes("ClaudeCode")&&!String(file).includes("claude-code"))return realRead(file,...args)
    if(mode==="oversize")return Buffer.alloc(2*1024*1024+1)
    if(mode==="unreadable")throw Object.assign(Error("private policy read"),{code:"EACCES"})
    return Buffer.from(mode==="hook"?'{"policyHelper":"must not execute"}':"{}")
  });syncBuiltinESMExports()
  t.after(()=>{Object.defineProperty(process,"platform",platform);t.mock.restoreAll();syncBuiltinESMExports()})
  for(const p of ["darwin","linux","win32"]){
    Object.defineProperty(process,"platform",{value:p,configurable:true})
    const r=await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic})
    assert.equal(r.reason,"diagnostic_inadequate");assert.equal(r.sources.filter(s=>s.path.endsWith(".json")&&s.kind==="managed").length>=3,true)
  }
  for(const [next,reason]of [["hook","active_hook_or_helper"],["oversize","effective_policy_unknown"],["unreadable","effective_policy_unknown"]]){
    mode=next;assert.equal((await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic})).reason,reason)
  }
})
test("configured_helper_is_rejected_before_native_diagnostic_start",async(t)=>{
  const f=await fixture(t);let called=0
  const r=await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:async()=>{called++;return diagnostic()},policyReaders:{read:()=>({...readers.read(),sources:[{...source,settings:{policyHelper:"forbidden"}}]})}})
  assert.equal(r.reason,"active_hook_or_helper");assert.equal(called,0)
})
test("R6_1_default_platform_provenance_connects_signed_installed_runtime_without_engine_copy",t=>{
  const commands=[],execFileSync=childProcess.execFileSync
  t.mock.method(childProcess,"execFileSync",function(command,args,options){
    const start=performance.now()
    let error
    try{return execFileSync.call(this,command,args,options)}
    catch(e){error={code:e.code??null,signal:e.signal??null};throw e}
    finally{
      commands.push({command:path.basename(command),operation:args[0],elapsed_ms:Math.round(performance.now()-start),
        target:path.basename(command)==="codesign"?(args.at(-1)==="/usr/lib/dyld"?"apple-loader":"installed-engine"):null,
        timeout_ms:options.timeout,error:error??null})
    }
  })
  const cli=path.join(process.env.DESK_TEST_REAL_HOME,".local","share","claude","versions","2.1.296"),r=runner.inspectLaunchChain({cli,env:process.env})
  t.diagnostic(JSON.stringify({native_provenance:r.state,commands}))
  if(process.platform==="darwin"&&fsNative.existsSync(cli)){
    assert.equal(r.state,"inspected");assert.equal(r.platform.kind,"macos-signed-runtime");assert.equal(r.platform.sealed,true)
    assert.match(r.platform.cache_uuid,/^[a-f0-9]{32}$/);assert.equal(r.platform.dependencies.includes("/usr/lib/libSystem.B.dylib"),true)
  }else assert.equal(r.state,"scope_unqualified")
})
test("R6_1_default_reader_rejects_user_helpers_before_any_diagnostic",async(t)=>{
  const f=await fixture(t),dir=path.join(f.env.HOME,".claude");fsNative.mkdirSync(dir)
  writeFileSync(path.join(dir,"settings.json"),JSON.stringify({apiKeyHelper:"must never execute",permissions:{allow:["Edit"]}}))
  let calls=0
  assert.equal((await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:async()=>{calls++;return diagnostic()}})).reason,"active_hook_or_helper")
  assert.equal(calls,0)
})
test("R6_1_native_platform_adapter_rejects_each_unverified_platform_dimension",async(t)=>{
  const f=await fixture(t),realRead=fsNative.readFileSync,realPath=fsNative.realpathSync,realList=fsNative.readdirSync,realStat=fsNative.lstatSync,realOpen=fsNative.openSync
  const platform=Object.getOwnPropertyDescriptor(process,"platform"),arch=Object.getOwnPropertyDescriptor(process,"arch");let mode="valid"
  const binary=Buffer.alloc(192);binary.writeUInt32LE(0xfeedfacf);binary.writeUInt32LE(1,16);binary.writeUInt32LE(0xc,32);binary.writeUInt32LE(160,36);binary.writeUInt32LE(24,40);binary.write("/usr/lib/probe.dylib",56)
  const cache=Buffer.alloc(160);cache.write("dyld_v1  arm64e");cache.fill(1,88,104);cache.writeBigUInt64LE(1n,128)
  const cacheFixture=path.join(f.dir,"cache");writeFileSync(cacheFixture,cache)
  t.mock.method(fsNative,"readFileSync",(file,...args)=>{
    if(String(file)===f.cli)return binary
    if(String(file).endsWith("dyld_shared_cache_arm64e")){const v=Buffer.from(cache);if(mode==="bad_magic")v.write("invalid");if(mode==="missing_loader")v.writeBigUInt64LE(0n,128);return v}
    if(String(file).endsWith("dyld_shared_cache_arm64e.map"))return Buffer.from(mode==="missing_dependency"?"":"/usr/lib/probe.dylib\n")
    if(String(file)==="/usr/lib/dyld"){const v=Buffer.alloc(32);v.writeUInt32BE(0xcafebabe);return v}return realRead(file,...args)
  })
  t.mock.method(fsNative,"realpathSync",(file,...args)=>{
    if(String(file)==="/usr/lib/probe.dylib")throw Object.assign(Error("not on disk"),{code:mode==="unreadable_dependency"?"EACCES":"ENOENT"})
    if(String(file)==="/usr/lib/dyld")return String(file);return realPath(file,...args)
  })
  t.mock.method(fsNative,"readdirSync",(file,...args)=>String(file).endsWith("/System/Library/dyld")?
    mode==="oversize_inventory"?Array.from({length:129},(_,i)=>`dyld_shared_cache_arm64e.${i}`):["dyld_shared_cache_arm64e","dyld_shared_cache_arm64e.map"]:realList(file,...args))
  t.mock.method(fsNative,"lstatSync",(file,...args)=>String(file).includes("/System/Library/dyld/")?
    {isFile:()=>mode!=="not_cache_file",uid:mode==="wrong_owner"?501:0,mode:mode==="writable_cache"?0o777:0o755,dev:1,ino:2,size:160,ctimeMs:1}:realStat(file,...args))
  t.mock.method(fsNative,"openSync",(file,...args)=>realOpen(String(file).includes("/System/Library/dyld/")?cacheFixture:file,...args))
  t.mock.method(childProcess,"execFileSync",(command,args,opts)=>{
    assert.equal(opts.timeout,5000);assert.equal(opts.env.DESK_FACTORY_HEADLESS,"1")
    if(command.endsWith("codesign")){assert.equal(args[0],"--verify");if(mode==="bad_signature")throw Error("signature rejected");return ""}
    if(command.endsWith("diskutil"))return "root-plist"
    if(command.endsWith("plutil"))return JSON.stringify({Sealed:mode==="unsealed"?"No":"Yes",WritableVolume:mode==="writable_root",MountPoint:mode==="wrong_root"?"/other":"/",APFSSnapshotUUID:mode==="unknown_snapshot"?"":"AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"})
    if(command.endsWith("csrutil"))return args[0]==="status"?mode==="sip_disabled"?"disabled":"System Integrity Protection status: enabled.":mode==="root_auth_disabled"?"disabled":"Authenticated Root status: enabled"
    assert.equal(command,"/usr/bin/sw_vers");return mode==="unknown_build"?"unknown build with spaces":"26A434"
  });syncBuiltinESMExports()
  t.after(()=>{Object.defineProperty(process,"platform",platform);Object.defineProperty(process,"arch",arch);t.mock.restoreAll();syncBuiltinESMExports()})
  Object.defineProperty(process,"platform",{value:"darwin",configurable:true});Object.defineProperty(process,"arch",{value:"arm64",configurable:true})
  assert.equal(runner.inspectLaunchChain({...f,resolveExec:undefined}).state,"inspected")
  for(const next of ["bad_signature","unsealed","writable_root","wrong_root","unknown_snapshot","sip_disabled","root_auth_disabled","unknown_build","bad_magic","missing_loader","missing_dependency","oversize_inventory","not_cache_file","wrong_owner","writable_cache","unreadable_dependency"]){
    mode=next;assert.equal(runner.inspectLaunchChain({...f,resolveExec:undefined}).state,"scope_unqualified",next)
  }
  mode="valid";Object.defineProperty(process,"platform",{value:"linux",configurable:true});assert.equal(runner.inspectLaunchChain({...f,resolveExec:undefined}).state,"scope_unqualified")
  Object.defineProperty(process,"platform",{value:"darwin",configurable:true});Object.defineProperty(process,"arch",{value:"x64",configurable:true});assert.equal(runner.inspectLaunchChain({...f,resolveExec:undefined}).state,"scope_unqualified")
})
test("R6_6_policy_documents_and_supported_value_types_require_validation_before_admission",async(t)=>{
  const f=await fixture(t)
  for(const settings of [true,1,"private malformed prose",[],null,{permissions:true},{permissions:{allow:"Read"}},{permissions:{deny:[true]}},{disableAllHooks:"true"},{hooks:true},{hooks:{SessionStart:"not an array"}},{hooks:{SessionStart:[{hooks:"not an array"}]}},{hooks:{SessionStart:[{matcher:7,hooks:[]}]}},{env:true},{env:{SECRET:7}},{mcpServers:true},{mcpServers:{server:false}}]){
    let calls=0;const r=await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:async()=>{calls++;return diagnostic()},policyReaders:{read:()=>({...readers.read(),sources:[{...source,settings}]})}})
    assert.equal(r.state,"scope_unqualified",JSON.stringify(settings));assert.deepEqual(r.validation_errors,["invalid_policy_document"]);assert.equal(calls,0)
    assert.equal(JSON.stringify(r).includes("private malformed prose"),false);assert.equal(r.capabilities,null)
  }
})
test("R6_6_post_diagnostic_validation_errors_are_fixed_code_and_invalidate_admission",async(t)=>{
  const f=await fixture(t);let calls=0
  const r=await runner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic,policyReaders:{read:()=>({...readers.read(),validation_errors:++calls===1?[]:["private error detail"]})}})
  assert.equal(calls,2);assert.equal(r.state,"scope_unqualified");assert.deepEqual(r.validation_errors,["invalid_effective_settings"]);assert.equal(r.capabilities,null);assert.equal(JSON.stringify(r).includes("private error detail"),false)
})
test("R6_6_native_invalid_settings_diagnostic_never_admits_or_echoes_private_errors",async(t)=>{
  const f=await fixture(t)
  for(const label of ["Invalid settings","\u001b[33mInvalid settings\u001b[39m"]){
    const r=await runner.collectTriageAdmission({...f,argv:[],policyReaders:readers,runDiagnostic:async()=>({kind:"closed",code:0,stdout:doctor+`\n${label}\n- private raw policy value\n`})})
    assert.equal(r.state,"scope_unqualified");assert.deepEqual(r.validation_errors,["invalid_native_settings"]);assert.equal(JSON.stringify(r).includes("private raw policy"),false);assert.equal(r.capabilities,null)
  }
})
