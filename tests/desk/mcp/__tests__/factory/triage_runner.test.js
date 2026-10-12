// Current owned-catalog policy and unchanged runtime/policy admission. Old
// native-path/dual-mission tests are superseded, retained in Git history.
import "../_isolated_env.mjs"
import {ownedHostTest,realCliTest} from "./_owned_catalog_host.mjs"
import {fileURLToPath} from "node:url"
import {test} from "node:test"
import assert from "node:assert/strict"
import fsNative from "node:fs"
import {syncBuiltinESMExports} from "node:module"
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from "node:fs"
import {tmpdir} from "node:os"
import * as path from "node:path"
import {createHash} from "node:crypto"
import childProcess from "node:child_process"
import {runInNewContext} from "node:vm"
import {different} from "../_file_identity.js"
import * as runner from "../../../../../plugins/desk/mcp/src/factory/triage-runner.js"
const realRunner=runner
// A caller doctor, policy reader or chain resolver reaches only this
// nonaccepted control host over the real pins, never the production exports.
const adapterRunner=Object.freeze({...runner,...runner.createNonacceptedControlHost()})
const hash=value=>createHash("sha256").update(value).digest("hex")
const flags=["--restricted","--safe-mode","--permission-mode","--permission-prompts","--tools","--disable-slash-commands","--no-chrome","--no-session-persistence","--strict-mcp-config","--mcp-config","--settings","--max-budget-usd","--output-format","--verbose","--system-prompt","--allowedTools"]
const metadata={host:"claude-code",flags}
const doctor="Claude Code doctor\nManaged settings (remote): not fetched — requires an Enterprise or Team subscription\nOrganization policy: not applicable to Pro and Max accounts\n"
const source={kind:"managed",revision:"a".repeat(64),settings:{}}
const readers={read:({cli}={})=>{
  const file=cli&&path.join(path.dirname(cli),"managed-policy.json")
  const current=file?{...source,path:file,settings:JSON.parse(readFileSync(file)),revision:hash(readFileSync(file))}:source
  return {complete:true,controller_invariant:true,sources:[current],validation_errors:[],
    capabilities:{result_is_data_only:true,engine_sha256:"fixture-only-not-native-attestation"}}
}}
const diagnostic=async()=>({kind:"closed",code:0,stdout:doctor,truncated:false})
const fixedOff=()=>Object.fromEntries(["cc-plugin-responsive-mode","cc-plugin-diff","cc-plugin-you-should-know","cc-plugin-claude-test",
  "cc-plugin-plugin-authoring","cc-plugin-mods-guide","cc-plugin-mermaid","cc-plugin-agents-md","cc-plugin-telemetry"].map(n=>[n+"@builtin",false]))
ownedHostTest("all_eleven_registered_ids_accounted","posix",async(t)=>{
  const f=await fixture(t),custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const data=JSON.parse(readFileSync(new URL("../../../../../plugins/desk/mcp/src/factory/v12-owned-catalog.json",import.meta.url)))
  await catalog.writeTriagePreparedFile({inputDir:f.inputDir,brief:data.brief,records:data.record_inputs,recordRefs:data.record_refs})
  const owned=await custody.prepareOwnedCatalogRun({inputDir:f.inputDir,runDir:path.join(f.dir,"fixed-set"),deadline:Date.now()+15000})
  t.after(()=>owned.close())
  const p=runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:owned.launch})
  assert.deepEqual(p.settings.enabledPlugins,fixedOff())
  for(const map of [{},{...fixedOff(),"extra@builtin":false},{...fixedOff(),"cc-plugin-tips@builtin":false},
    {...fixedOff(),"cc-plugin-sec-default@builtin":false},{...fixedOff(),"cc-plugin-diff@builtin":true}]){
    assert.equal(runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:owned.launch,
      settings:{...p.settings,enabledPlugins:map}}).state,"scope_unqualified")
  }
})
test("nine_false_after_managed_fold_or_hold",async()=>{
  const input={...controlInput(),settings:{...controlInput().settings,enabledPlugins:fixedOff()},mode:"registeredConfiguration"}
  const positive=await runner.runNonacceptedControlCollection(input)
  assert.equal(positive.outcome.state,"collected")
  assert.equal(positive.outcome.evidence.schema,"desk.factory.triage-controls/3")
  assert.deepEqual(Object.keys(positive.outcome.evidence.builtin_basis).sort(),["cc-plugin-sec-default@builtin","cc-plugin-tips"])
  for(const id of Object.keys(fixedOff())){
    for(const value of [true,null,"false"]){
      const r=await runner.runNonacceptedControlCollection({...input,sources:[{enabledPlugins:{[id]:value}}]})
      assert.equal(r.outcome.state,"scope_unqualified");assert.equal(r.statistics.diagnostics,0)
      assert.equal(r.productionAuthority,false)
    }
    const missing=fixedOff();delete missing[id]
    const r=await runner.runNonacceptedControlCollection({...input,settings:{...input.settings,enabledPlugins:missing}})
    assert.equal(r.outcome.state,"scope_unqualified");assert.equal(r.statistics.diagnostics,0)
    const off=await runner.runNonacceptedControlCollection({...input,sources:[{enabledPlugins:{[id]:false}}]})
    assert.equal(off.outcome.state,"collected");assert.equal(off.productionAuthority,false)
  }
  const unknown=await runner.runNonacceptedControlCollection({...input,sources:[{enabledPlugins:{"unreviewed@builtin":false}}]})
  assert.equal(unknown.outcome.state,"scope_unqualified");assert.equal(unknown.statistics.diagnostics,0)
})
realCliTest("availability_variants_cannot_enable_fixed_off_set","posix",async()=>{
  const bytes=readFileSync(path.join(process.env.DESK_TEST_REAL_HOME,".local/share/claude/versions/2.1.296"))
  const registry=bytes.subarray(190345930,190348300)
  assert.equal(hash(registry),"0d44a3195cf29f26ba956f4a0b7ad8beea17cb6d19b3d4b89e273437513895e1")
  const text=registry.toString(),body=text.slice(text.indexOf("function E3("),text.indexOf("function iUn("))
  const availabilityBody=text.slice(text.indexOf("function lho("),text.indexOf("function hb("))
  const fold=bytes.subarray(199358867,199358867+4637)
  assert.equal(hash(fold),"8f210786b67345f02a97acb015c99034b13f7c7dc88b2ebe84cebe6f8c76e01c")
  for(const id of Object.keys(fixedOff())){
    for(const availability of [true,false,"exception"]){
      for(const defaultEnabled of [true,false,undefined]){
        const name=id.slice(0,-8),plugins=new Map([[name,{name,defaultEnabled,hooksModule:{}}]])
        let callbackActivation=0
        plugins.get(name).isAvailable=()=>{if(availability==="exception")throw Error("availability");return availability}
        const context={Qn:()=>({enabledPlugins:fixedOff()}),xr:()=>({builtinPlugins:plugins,builtinPluginFailures:new Set}),
          ko:()=>{},Pi:"builtin",mR:()=>[],
          vn:()=>{throw Error("policy-only not in fixed set")},yUn:()=>{throw Error("trusted-only not in fixed set")},
          bQt:()=>{throw Error("unresolved alias")},Jk:()=>({activate:()=>callbackActivation++})}
        context.lho=runInNewContext(`(${availabilityBody})`,context)
        const E3=runInNewContext(`(${body})`,context)
        const selected=E3()
        assert.equal(selected.enabled.length,0)
        assert.equal(selected.disabled.length,availability===true?1:0)
        const IUr=runInNewContext(`(${fold.toString()})`,{gEn:()=>new Map})
        const resolved=IUr({session:[],synced:[],marketplace:[],skill:[],builtin:[...selected.enabled,...selected.disabled],
          managedEntries:[],recordedDisableFolds:new Set})
        const enabled=resolved.plugins.filter(p=>p.enabled)
        assert.equal(enabled.length,0)
        for(const plugin of enabled)plugin.activate()
        assert.equal(callbackActivation,0)
        const shared=await runner.runNonacceptedControlCollection({...controlInput(),sources:[{enabledPlugins:{[id]:false}}],
          mode:"registeredConfiguration"})
        assert.equal(shared.outcome.state,"collected");assert.equal(shared.productionAuthority,false)
      }
    }
  }
})
realCliTest("disabled_registration_consumers_no_activation","posix",()=>{
  const bytes=readFileSync(path.join(process.env.DESK_TEST_REAL_HOME,".local/share/claude/versions/2.1.296"))
  const diff=bytes.subarray(222747175,222811837)
  assert.equal(hash(diff),"d6ff6dbf628c22298f8981c41908d000331c7046449df5ab2cc49c88d57c3e7f")
  const text=diff.toString(),guard=text.slice(text.indexOf("var it=!0;var at="),text.indexOf('var Fr="diff";'))
  const registration=text.slice(text.indexOf("function ol("),text.indexOf("export{Fr as"))
  for(const [interactive,desktop,expected]of [[false,false,0],[true,false,1],[false,true,1]]){
    let carry=0,registered=0,featureCalls=0
    const ol=runInNewContext(`${guard};(${registration})`,{ve:()=>!interactive,qE:()=>desktop?"claude-desktop":"sdk-cli",
      nj:()=>true,Ie:()=>"feature",k:()=>{featureCalls++;return true},zr:()=>true,
      Ir:()=>{carry++;return Promise.resolve()},ce:()=>({diffSidebarOpen:true}),t:()=>{},
      hb:()=>registered++,Fye:"cc-plugin-diff",Fr:"diff",vr:"diff",oW:()=>({}),sUn:()=>"/inert",Ne:{},jn:()=>{throw Error("disabled hook loaded")}})
    ol();assert.equal(carry,expected);assert.equal(featureCalls,expected);assert.equal(registered,1)
  }
  const native=bytes.subarray(222899700,222951399)
  assert.equal(hash(native),"e1cd8d46a49e05f972e077bf9ea19b964e2b0653de08cafbeae3555bca1af368")
  const source=native.toString(),Qo=source.slice(source.indexOf("function Qo("),source.indexOf("export{be as"))
  let descriptor,connect=0
  const state={wantedSessions:new Set}
  const register=runInNewContext(`(${Qo.replace("import.meta.dir",JSON.stringify("/inert"))})`,{i:state,Ne:()=>{},Je:()=>{},qe:()=>{},hb:d=>descriptor=d,
    h:"cc-plugin-claude-test",We:"test",b:"version",Ue:()=>true,rt:[],K:()=>"fresh",Le:()=>{connect++;return{}},
    oW:()=>({}),L:{},vt:()=>{throw Error("disabled module loaded")}})
  register()
  // E3 reads descriptor metadata even for disabled entries. The actual
  // conditional getter is accessed, but its fresh-session MCP activation
  // branch must not run; do not claim metadata construction never happens.
  assert.equal(descriptor.mcpServers,undefined);assert.equal(connect,0)
  state.wantedSessions.add("fresh")
  descriptor.mcpServers;assert.equal(connect,1,"counterexample pins why fresh/no disabled consumer invocation matters")
})
realCliTest("fixed_set_recipe_source_drift_rejects_old_records","posix",async(t)=>{
  for(const version of [1,2,3,4])assert.throws(()=>runner.validateOwnedQualificationStructure({record:{version}}),
    {message:"qualification_structure"})
  const f=await fixture(t),custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const data=JSON.parse(readFileSync(new URL("../../../../../plugins/desk/mcp/src/factory/v12-owned-catalog.json",import.meta.url)))
  await catalog.writeTriagePreparedFile({inputDir:f.inputDir,brief:data.brief,records:data.record_inputs,recordRefs:data.record_refs})
  const owned=await custody.prepareOwnedCatalogRun({inputDir:f.inputDir,runDir:path.join(f.dir,"fixed-source"),deadline:Date.now()+15000})
  t.after(()=>owned.close())
  const policy=runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:owned.launch})
  const actual=path.join(process.env.DESK_TEST_REAL_HOME,".local/share/claude/versions/2.1.296")
  let selected
  pinnedSourceMemoryFD(t,actual,(at,buffer,offset)=>{if(at===selected)buffer[offset]^=1})
  for(const offset of [222737738,222747175,222811837,222877373,222899700,222951399,222969807,223001881,223047021,223060107,
    190345930,199366501,199358867,187450707,186845095,205416120]){
    selected=offset;let diagnostics=0
    const result=await adapterRunner.collectTriageControls({cli:actual,env:{HOME:f.dir},argv:policy.argv,
      runDiagnostic:()=>{diagnostics++}})
    assert.equal(result.detail,"predicate_revision");assert.equal(diagnostics,0)
    assert.equal(result.evidence,null);assert.equal(result.state,"scope_unqualified")
  }
})
// The isolation guard conservatively treats O_NOFOLLOW numeric opens as
// writes. Preserve that guard and production no-follow: these source-only
// test reads use a memory FD over the actual readFileSync bytes, not an
// executable engine copy or an auth/native launch.
function pinnedSourceMemoryFD(t,cli,alter=()=>{}){
  const bytes=readFileSync(cli),stat=fsNative.lstatSync(cli)
  const open=fsNative.openSync,read=fsNative.readSync,fstat=fsNative.fstatSync,close=fsNative.closeSync
  const fd=987654321
  let cursor=0
  t.mock.method(fsNative,"openSync",(file,...args)=>file===cli?(cursor=0,fd):open(file,...args))
  t.mock.method(fsNative,"readSync",(file,buffer,offset,length,position)=>{
    if(file!==fd)return read(file,buffer,offset,length,position)
    const at=position===null?cursor:position,n=Math.min(length,bytes.length-at)
    bytes.copy(buffer,offset,at,at+n);if(position===null)cursor+=n
    else alter(at,buffer,offset,n)
    return n
  })
  t.mock.method(fsNative,"fstatSync",(file,...args)=>file===fd?stat:fstat(file,...args))
  t.mock.method(fsNative,"closeSync",file=>file===fd?undefined:close(file))
  syncBuiltinESMExports()
  t.after(()=>{t.mock.restoreAll();Object.assign(fsNative,{openSync:open,readSync:read,fstatSync:fstat,closeSync:close});syncBuiltinESMExports()})
}
// One control-host scenario, run twice. The first variant reads the installed
// Claude Code 2.1.296 engine and the Darwin /Library managed roots (real-binary
// opt-in). The second runs the same readers on every POSIX host through
// createNonacceptedControlHost: a synthetic engine file with its own pin, and
// private managed roots, on a Darwin-labelled process with codesign answered
// by the test. Its collections live only in that facade's registry.
const REAL_ENGINE=path.join(process.env.DESK_TEST_REAL_HOME??"/unset",".local/share/claude/versions/2.1.296")
function controlHostTest(name,fn){
  realCliTest(name,"posix",t=>fn(t,{runner:adapterRunner,cli:REAL_ENGINE,system:"/Library/Application Support/ClaudeCode",
    preferences:"/Library/Managed Preferences",fragment:200633045,synthetic:false}))
  ownedHostTest(`${name} [synthetic engine]`,"posix",async t=>{
    const dir=realpathSync(mkdtempSync(path.join(tmpdir(),"control-host-")));fsNative.chmodSync(dir,0o700)
    t.after(()=>rmSync(dir,{recursive:true,force:true}))
    const library=path.join(dir,"Library");fsNative.mkdirSync(path.join(library,"Application Support"),{recursive:true,mode:0o700})
    const bytes=Buffer.alloc(16384);for(let i=0;i<bytes.length;i++)bytes[i]=(i*31+7)%251
    const cli=path.join(dir,"engine");writeFileSync(cli,bytes,{mode:0o700})
    const spans=[[512,96],[4096,700],[12000,1500]].map(([offset,length])=>[offset,length,hash(bytes.subarray(offset,offset+length))])
    const system=path.join(library,"Application Support","ClaudeCode"),preferences=path.join(library,"Managed Preferences")
    const host=runner.createNonacceptedControlHost({engine:{sha256:hash(bytes),spans},system,preferences})
    assert.equal(host.authority,false)
    const platform=Object.getOwnPropertyDescriptor(process,"platform"),exec=childProcess.execFileSync
    Object.defineProperty(process,"platform",{...platform,value:"darwin"})
    t.mock.method(childProcess,"execFileSync",(command,args,options)=>command==="/usr/bin/codesign"?"":exec(command,args,options))
    syncBuiltinESMExports()
    t.after(()=>{Object.defineProperty(process,"platform",platform);childProcess.execFileSync=exec;syncBuiltinESMExports()})
    await fn(t,{runner:Object.freeze({...runner,...host}),cli,system,preferences,fragment:spans[0][0],synthetic:true})
    // Synthetic collections never reach the production registry.
  })
}
ownedHostTest("restricted_recipe_exact_three_effective_off_values","posix",async(t)=>{
  const f=await fixture(t)
  const custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const data=JSON.parse(readFileSync(new URL("../../../../../plugins/desk/mcp/src/factory/v12-owned-catalog.json",import.meta.url)))
  await catalog.writeTriagePreparedFile({inputDir:f.inputDir,brief:data.brief,records:data.record_inputs,recordRefs:data.record_refs})
  const owned=await custody.prepareOwnedCatalogRun({inputDir:f.inputDir,runDir:path.join(f.dir,"recipe"),deadline:Date.now()+15000})
  t.after(()=>owned.close())
  const p=runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:owned.launch})
  assert.equal(p.argv.includes("--safe-mode"),false)
  assert.equal(p.argv.includes("--bare"),false)
  assert.equal(p.argv[p.argv.indexOf("--tools")+1],"")
  assert.deepEqual(p.settings,{permissions:p.settings.permissions,disableAllHooks:true,disableSkillShellExecution:true,disableWorkflows:true,
    enabledPlugins:fixedOff()})
  assert.equal(JSON.parse(p.argv[p.argv.indexOf("--mcp-config")+1]).mcpServers.triage_catalog.type,"stdio")
})
const controlInput=()=>{
  const settings={permissions:{allow:metadata.flags.length?["mcp__triage_catalog__evidence_read","mcp__triage_catalog__evidence_search","mcp__triage_catalog__evidence_list","mcp__triage_catalog__candidate_submit"]:[],deny:["Read","Edit","Write","Grep","Glob","Bash","PowerShell","REPL","Agent","Task","Skill","WebFetch","WebSearch"]},disableAllHooks:true,disableSkillShellExecution:true,disableWorkflows:true,enabledPlugins:fixedOff()}
  return {env:{},settings,sources:[],closure:{instructions:[],memory:[],plugins:[],controller:null,lsp:[]}}
}
test("builtin_selection_unobserved_not_inventory",async()=>{
  const r=await runner.runNonacceptedControlCollection(controlInput())
  assert.equal(r.outcome.evidence.schema,"desk.factory.triage-controls/3")
  const basis=r.outcome.evidence.builtin_basis
  assert.deepEqual(Object.keys(basis).sort(),["cc-plugin-sec-default@builtin","cc-plugin-tips"])
  for(const entry of Object.values(basis)){
    assert.equal(entry.basis,"exhaustive_builtin_variants")
    assert.equal(entry.selection,"unobserved")
    assert.match(entry.variant_set_sha256,/^[a-f0-9]{64}$/u)
  }
  assert.deepEqual(basis["cc-plugin-tips"].variant_ids,["unavailable","off","on"])
  assert.deepEqual(basis["cc-plugin-sec-default@builtin"].variant_ids,["absent","present"])
  assert.equal(r.productionAuthority,false)
  for(const mutate of [
    e=>delete e.builtin_basis,e=>e.builtin_basis.extra=e.builtin_basis["cc-plugin-tips"],
    e=>e.builtin_basis["cc-plugin-tips"].selection="on",
    e=>e.builtin_basis["cc-plugin-tips"].basis="exact_observation",
    e=>e.builtin_basis["cc-plugin-tips"].variant_ids.push("other"),
    e=>e.builtin_basis["cc-plugin-tips"].variant_set_sha256="a".repeat(64),
    e=>e.builtin_basis["cc-plugin-tips"].source_refs=[],
  ]){
    const changed=structuredClone(r.outcome.evidence);mutate(changed)
    assert.equal(runner.validateTriageControls(changed).ok,false)
  }
})
test("control_vector_ten_source_bound_rows",async()=>{
  assert.equal(typeof runner.validateTriageControls,"function")
  const result=await runner.runNonacceptedControlCollection(controlInput())
  assert.equal(result.outcome.state,"collected")
  assert.equal(result.authority,false)
  assert.equal(result.statistics.actualFileOperations,0)
  const e=result.outcome.evidence
  assert.equal(Object.keys(e.controls).length,10)
  assert.equal(runner.validateTriageControls(e).ok,true)
  assert.equal(result.productionAuthority,false)
  for(const mutate of [
    x=>delete x.controls.memory,x=>x.controls.extra=x.controls.memory,
    x=>x.controls.memory.predicate_id="arbitrary",x=>x.controls.memory.source_refs=[],
    x=>x.sources[0].revision_sha256="not-a-hash",x=>x.external_requirements.extra=false,
    x=>x.sources.push({...x.sources[0]}),x=>x.controls.memory.state="invented",
  ]){
    const copy=structuredClone(e);mutate(copy)
    assert.equal(runner.validateTriageControls(copy).ok,false)
  }
})
test("json_admission_assertion_never_authority",async()=>{
  const result=await runner.runNonacceptedControlCollection(controlInput())
  assert.equal(result.productionAuthority,false)
  assert.equal(runner.hasCollectedTriageControls(structuredClone(result.outcome.evidence)),false)
})
test("invalid_control_recipe_never_runs_diagnostic",async()=>{
  let diagnostics=0
  const r=await adapterRunner.collectTriageControls({cli:"/synthetic/missing",env:{},argv:["--settings","{}"],runDiagnostic:()=>{diagnostics++}})
  assert.equal(r.reason,"policy_control_unsupported")
  assert.equal(diagnostics,0)
})
test("legacy_adapter_requires_measurement_metadata_before_reader_effects",async()=>{
  const argv=process.execArgv,coverage=process.env.DESK_COVERAGE_RUNNER_CHILD,nodeOptions=process.env.NODE_OPTIONS
  // This isolated test child verifies only the refusing branch. It cannot
  // issue controls, invoke an engine or write a qualification store.
  try{
    process.execArgv=[];delete process.env.DESK_COVERAGE_RUNNER_CHILD;delete process.env.NODE_OPTIONS
    let reads=0
    const r=await adapterRunner.collectTriageAdmission({cli:"/unit/not-an-engine",env:{},argv:[],
      policyReaders:{read:()=>{reads++;throw Error("must not execute")}}})
    assert.equal(r.reason,"policy_control_unsupported");assert.equal(reads,0)
  }finally{
    process.execArgv=argv
    if(coverage===undefined)delete process.env.DESK_COVERAGE_RUNNER_CHILD
    else process.env.DESK_COVERAGE_RUNNER_CHILD=coverage
    if(nodeOptions===undefined)delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS=nodeOptions
  }
})
test("default_native_dependencies_keep_billing_and_host_guards_before_spawn",async()=>{
  const headless=await import("../../../../../plugins/desk/mcp/src/factory/headless.js")
  assert.equal((await headless.probeSignIn({cli:"/unit/not-an-engine",env:{ANTHROPIC_API_KEY:"unit"}})).state,"disabled_would_bill")
  assert.equal((await headless.runHeadless({env:{},job:{host:"unsupported"}})).state,"unsupported_host")
})
test("helpers_preflight_precedes_doctor_signin",async()=>{
  for(const key of ["hooks","policyHelper","policyHelpers","processWrapper","apiKeyHelper","otelHeadersHelper","proxyAuthHelper"]){
    const config=controlInput();config.sources=[{[key]:key==="hooks"?{SessionStart:[{}]}:"synthetic helper"}]
    const r=await runner.runNonacceptedControlCollection(config)
    assert.equal(r.outcome.state,"scope_unqualified",key)
    assert.equal(r.statistics.diagnostics,0,key)
    assert.equal(r.productionAuthority,false)
    assert.equal(r.outcome.capture.channels.diagnostic.observation,"unobserved")
    assert.equal(r.outcome.capture.channels.controls.observation,"unobserved")
    assert.ok(r.outcome.capture.stages.length<=64)
  }
})
test("required_safe_hermetic_simple_mcp_holds",async()=>{
  for(const key of ["CLAUDE_CODE_SAFE_MODE","CLAUDE_CODE_SIMPLE","CLAUDE_CODE_REMOTE_HERMETIC_MODE","CLAUDE_CODE_PROCESS_WRAPPER"]){
    const config=controlInput();config.env[key]="1"
    const r=await runner.runNonacceptedControlCollection(config)
    assert.equal(r.outcome.state,"scope_unqualified")
    assert.equal(r.statistics.diagnostics,0)
  }
  for(const value of ["0","false","no","off",""]){
    const config=controlInput();config.env.CLAUDE_CODE_SAFE_MODE=value
    const r=await runner.runNonacceptedControlCollection(config)
    assert.equal(r.outcome.state,"scope_unqualified","present selector cannot be silently erased without source-proven compatibility")
    assert.equal(r.statistics.diagnostics,0)
  }
})
test("finite_plugin_controller_lsp_closure",async()=>{
  for(const closure of [
    {plugins:["external.js"]},{lsp:["external-server"]},{controller:{id:"security",revision:"a".repeat(64)}},
  ]){
    const config=controlInput();Object.assign(config.closure,closure)
    const r=await runner.runNonacceptedControlCollection(config)
    assert.equal(r.outcome.state,"scope_unqualified")
  }
  const config=controlInput()
  config.closure.controller={id:"cc-plugin-sec-default",engine_owned:true,external_edges:[],eligible:true}
  const r=await runner.runNonacceptedControlCollection(config)
  assert.equal(r.outcome.evidence.controls.policy_controller.state,"required_controller")
  assert.equal(r.productionAuthority,false)
})
test("registered_predicates_require_selected_off_values_not_declared_defaults",async()=>{
  const off=Object.fromEntries(["cc-plugin-responsive-mode","cc-plugin-diff","cc-plugin-you-should-know","cc-plugin-claude-test",
    "cc-plugin-plugin-authoring","cc-plugin-mods-guide","cc-plugin-tips","cc-plugin-mermaid","cc-plugin-agents-md","cc-plugin-telemetry"].map(n=>[n+"@builtin",false]))
  const evaluate=sources=>runner.runNonacceptedControlCollection({...controlInput(),sources,mode:"registeredConfiguration"})
  const unresolved=await evaluate([])
  assert.equal(unresolved.outcome.state,"collected","source-bound exact inline false map is effective with no managed override")
  const disabled=await evaluate([{enabledPlugins:off,prependPlugins:[]}])
  assert.equal(disabled.outcome.state,"collected")
  assert.equal(disabled.productionAuthority,false);assert.equal(disabled.statistics.actualFileOperations,0)
  assert.equal(disabled.outcome.evidence.controls.plugins_modules.state,"known_nonexecuting_data")
  assert.equal(disabled.outcome.evidence.controls.lsp_monitors.state,"effective_off")
  assert.equal(disabled.outcome.capture.channels.controls.observation,"present")
  const trusted=await evaluate([{enabledPlugins:off}])
  assert.equal(trusted.outcome.evidence.controls.policy_controller.state,"required_controller")
  const ordered=await evaluate([{enabledPlugins:off,prependPlugins:["cc-plugin-sec-default@builtin"]}])
  assert.equal(ordered.outcome.evidence.controls.policy_controller.state,"required_controller")
  const noLocalSeat=await runner.runNonacceptedControlCollection({...controlInput(),sources:[{enabledPlugins:off}],mode:"remoteRegisteredConfiguration"})
  assert.equal(noLocalSeat.outcome.state,"collected")
  assert.equal(noLocalSeat.outcome.evidence.controls.policy_controller.state,"required_controller")
  assert.equal(noLocalSeat.outcome.evidence.builtin_basis["cc-plugin-sec-default@builtin"].selection,"unobserved")
  assert.equal(noLocalSeat.productionAuthority,false)
  const missingTips={...off};delete missingTips["cc-plugin-diff@builtin"]
  assert.equal((await evaluate([{enabledPlugins:missingTips,prependPlugins:[]}])).outcome.state,"collected","missing managed key does not erase exact inline false")
  for(const selection of [{enabledPlugins:{"external@market":true}},{prependPlugins:["external@market"]},
    {appendPlugins:["cc-plugin-tips@builtin"]},{enabledPlugins:null},{enabledPlugins:{"cc-plugin-tips@builtin":"false"}}]){
    const r=await evaluate([selection])
    assert.equal(r.outcome.state,"scope_unqualified")
    assert.equal(r.outcome.detail,"control_external_plugin_registration")
    assert.equal(r.productionAuthority,false)
  }
})
const otherBuiltinsOff=()=>Object.fromEntries(["cc-plugin-responsive-mode","cc-plugin-diff","cc-plugin-you-should-know","cc-plugin-claude-test",
  "cc-plugin-plugin-authoring","cc-plugin-mods-guide","cc-plugin-mermaid","cc-plugin-agents-md","cc-plugin-telemetry"].map(n=>[n+"@builtin",false]))
realCliTest("tips_exhaustive_variants_noninteractive_and_replay","posix",async()=>{
  const bytes=readFileSync(path.join(process.env.DESK_TEST_REAL_HOME,".local/share/claude/versions/2.1.296"))
  const span=(offset,length,sha)=>{
    const data=bytes.subarray(offset,offset+length);assert.equal(hash(data),sha);return data.toString()
  }
  const tips=span(222997168,4713,"7f0fc000a21f439df3891a9ca1344d2c3f57b40d7b5a259e5e39936475356a74")
  const replay=span(216423866,1800,"20e57b3a3c9f22807933773004a23a7dd439bee85a182c1b876f676e1f7ac67b")
  const print=span(222377600,700,"f31d0504334d8ab251eedada41fa61c9064906bfd728f1fdb4e075f3d016789a")
  assert.match(print,/jOr\(\{loaded:it\(\)\.hookRegistrationInFlight,surface:null,isInteractive:!1\}\)/u)
  const h=tips.slice(tips.indexOf("function H("),tips.indexOf("function z("))
  const ln=replay.slice(0,replay.indexOf("async function un("))
  const un=replay.slice(replay.indexOf("async function un("),replay.indexOf("var Tr="))
  // Execute only these hash-bound callback bodies in an inert VM; no native
  // engine, imports, configured helper, settings, environment or provider runs.
  let callback,installed=0,providers=0,forwarded=0,late
  const picker={install:()=>installed++}
  const H=runInNewContext(`(${h})`,{D:()=>providers++})
  H((name,fn)=>{assert.equal(name,"session.start");callback=fn},picker)
  const deliver=event=>callback({settings:{read:()=>{throw Error("settings called")}},
    env:{get:()=>{throw Error("env called")}}},event,e=>{forwarded++;return e})
  const module={name:"cc-plugin-tips",hooks:name=>name==="session.start"}
  const context={t:()=>{},l:String,se:()=>"/inert",it:()=>({loadedModules:[]}),Vsr:()=>{},
    ysr:{set:fn=>late=fn},Qte:()=>({session:{start:deliver}})}
  const initial=runInNewContext(`(${un})`,context)
  const replayFn=runInNewContext(`(${ln})`,context)
  // Bind the exact function used by un's late callback, not a replacement.
  context.ln=replayFn
  const initialBound=runInNewContext(`(${un})`,context)
  for(const availability of ["unavailable","off","on","availability_error"]){
    await initialBound({loaded:Promise.resolve(),surface:null,isInteractive:false},()=>true)
    if(availability==="on"){late([module]);await Promise.resolve();await Promise.resolve()}
    assert.equal(installed,0);assert.equal(providers,0)
  }
  assert.equal(typeof initial,"function");assert.equal(forwarded,5)
  deliver({isInteractive:true});assert.equal(installed,1,"positive control proves the actual guard can install")
  for(const on of [undefined,false,true]){
    const enabled=otherBuiltinsOff();if(on!==undefined)enabled["cc-plugin-tips@builtin"]=on
    const r=await runner.runNonacceptedControlCollection({...controlInput(),sources:[{enabledPlugins:enabled}],mode:"registeredConfiguration"})
    assert.equal(r.outcome.state,"collected")
    assert.equal(r.outcome.evidence.builtin_basis["cc-plugin-tips"].selection,"unobserved")
    assert.equal(r.productionAuthority,false)
  }
})
realCliTest("controller_absent_present_preserves_closed_authority","posix",async()=>{
  const bytes=readFileSync(path.join(process.env.DESK_TEST_REAL_HOME,".local/share/claude/versions/2.1.296")).subarray(223038175,223043450)
  assert.equal(hash(bytes),"8cb36bf40b25f7fac035d04f7f73ab5854f33575f576baaf386a54aeb92e0f39")
  const text=bytes.toString(),body=text.slice(text.indexOf("function ue("),text.indexOf("var ge="))
  const handlers=new Map(),failures=new Map()
  const register=(name,...values)=>{handlers.set(name,values.at(-1));return {catch:fn=>failures.set(name,fn)}}
  const ue=runInNewContext(`(${body})`,{F:()=>fn=>fn(),G:null,a:"options",u:async()=>true,B:"managedOnly",M:"deny",
    d:()=>{throw Error("unused describe")},z:()=>{throw Error("unused list")},O:()=>[],P:()=>false,
    C:()=>({decision:"deny"}),v:"managed refusal",V:()=>true,f:String,h:String,H:String})
  ue(register)
  let appended=0
  const next=async()=>({decision:"deny"});next.to=async()=>{appended++;return {decision:"allow"}};next.trace=[]
  const refusal=await handlers.get("tool.check")({}, {tool:"Bash"},next)
  assert.equal(refusal.decision,"deny");assert.equal(appended,0)
  const failed=async()=>{throw Error("policy unavailable")};failed.trace=[]
  assert.equal((await failures.get("tool.check")({settings:{read:()=>({})}}, {},failed)).decision,"deny")
  const registration=async()=>({registered:true});registration.origin={tier:"user"}
  assert.equal((await handlers.get("tool.register")({settings:{read:()=>({})}},{},registration)).deny,"managed refusal")
  assert.equal((await handlers.get("plugin.register")({settings:{read:()=>({})}},{name:"external"},registration)).refuse,"external")
  registration.called=false
  assert.equal((await failures.get("plugin.register")({ui:{log:()=>{}}},{name:"external"},registration)).refuse,"external")
  for(const prepend of [[],["cc-plugin-sec-default@builtin"],undefined]){
    const settings={enabledPlugins:otherBuiltinsOff(),...(prepend===undefined?{}:{prependPlugins:prepend})}
    const r=await runner.runNonacceptedControlCollection({...controlInput(),sources:[settings],mode:"registeredConfiguration"})
    assert.equal(r.outcome.state,"collected")
    assert.equal(r.outcome.evidence.controls.plugins_modules.state,"known_nonexecuting_data")
    assert.equal(r.outcome.evidence.controls.policy_controller.state,"required_controller")
    assert.equal(r.outcome.evidence.builtin_basis["cc-plugin-sec-default@builtin"].selection,"unobserved")
    assert.equal(r.productionAuthority,false)
  }
})
realCliTest("tips_interactive_reuse_or_changed_closure_blocks","posix",async(t)=>{
  const f=await fixture(t),custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const data=JSON.parse(readFileSync(new URL("../../../../../plugins/desk/mcp/src/factory/v12-owned-catalog.json",import.meta.url)))
  await catalog.writeTriagePreparedFile({inputDir:f.inputDir,brief:data.brief,records:data.record_inputs,recordRefs:data.record_refs})
  const owned=await custody.prepareOwnedCatalogRun({inputDir:f.inputDir,runDir:path.join(f.dir,"variant-argv"),deadline:Date.now()+15000})
  t.after(()=>owned.close())
  const p=runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:owned.launch})
  for(const argv of [p.argv.filter(v=>v!=="-p"),...["--resume","--continue","--remote-control","--interactive"].map(v=>[...p.argv,v])]){
    let calls=0
    const r=await adapterRunner.collectTriageControls({cli:f.cli,env:{},argv,runDiagnostic:()=>{calls++}})
    assert.equal(r.detail,"control_recipe");assert.equal(calls,0);assert.equal(r.evidence,null)
  }
  const actual=path.join(process.env.DESK_TEST_REAL_HOME,".local/share/claude/versions/2.1.296")
  let selected
  pinnedSourceMemoryFD(t,actual,(at,buffer,offset)=>{if(at===selected)buffer[offset]^=1})
  // Memory-only source reader changes; never installed bytes or whole-source
  // provenance guards. Each pinned guard/import/body must independently hold.
  for(const offset of [222997168,222992072,222377600,221870233,216414647,216423866,216424221,216426559,216711914,
    223038175,223032624,195219863,195218970]){
    selected=offset
    let calls=0
    const r=await adapterRunner.collectTriageControls({cli:actual,env:{HOME:f.dir},argv:p.argv,runDiagnostic:()=>{calls++}})
    assert.equal(r.detail,"predicate_revision");assert.equal(calls,0)
    assert.equal(r.evidence,null);assert.equal(r.state,"scope_unqualified")
  }
})
test("variant_basis_hash_recipe_source_drift_blocks",async()=>{
  const r=await runner.runNonacceptedControlCollection({...controlInput(),sources:[{enabledPlugins:otherBuiltinsOff()}],mode:"registeredConfiguration"})
  assert.equal(r.outcome.state,"collected")
  const changed=structuredClone(r.outcome.evidence)
  changed.builtin_basis["cc-plugin-tips"].variant_set_sha256="f".repeat(64)
  assert.equal(runner.validateTriageControls(changed).ok,false)
  assert.equal(runner.hasCollectedTriageControls(r.outcome.evidence),false)
  assert.equal(runner.hasCollectedTriageControls(changed),false)
  for(const policy of [{pluginConfigs:{"cc-plugin-sec-default@builtin":{options:{allowModsToOverrideDenyRules:true}}}},
    {allowedMcpServers:[{serverName:"external"}]},{managedMcpServers:{external:{}}},{appendPlugins:["external"]}]){
    const blocked=await runner.runNonacceptedControlCollection({...controlInput(),sources:[{enabledPlugins:otherBuiltinsOff(),...policy}],mode:"registeredConfiguration"})
    assert.equal(blocked.outcome.state,"scope_unqualified");assert.equal(blocked.productionAuthority,false)
  }
})
test("managed_data_imports_no_execution",async()=>{
  const config=controlInput();config.closure.instructions=[{text:"Managed prose only",imports:[]}]
  const r=await runner.runNonacceptedControlCollection(config)
  assert.equal(r.outcome.evidence.controls.instructions_agents.state,"known_nonexecuting_data")
  assert.equal(r.statistics.actualFileOperations,0)
  for(const item of [{text:"x".repeat(65537),imports:[]},{text:"x",imports:["self"]},{text:"x",imports:[],execute:"forbidden"}]){
    const c=controlInput();c.closure.instructions=[item]
    assert.equal((await runner.runNonacceptedControlCollection(c)).outcome.state,"scope_unqualified")
  }
})
test("controls_fail_closed_delivery_merge_and_current_source_matrix",async()=>{
  for(const change of [
    {settings:{...controlInput().settings,disableWorkflows:false}},
    {sources:[{permissions:{allow:["Bash"]}}]},
    {sources:[{env:{ANTHROPIC_API_KEY:"synthetic"}}]},
    {sources:[{disableSideloadFlags:true}]},
    {sources:Array.from({length:63},()=>({}))},
    {closure:{...controlInput().closure,memory:[{text:"x",imports:["unresolved"]}]}},
  ]){
    const r=await runner.runNonacceptedControlCollection({...controlInput(),...change})
    assert.equal(r.outcome.state,"scope_unqualified")
    assert.equal(r.productionAuthority,false)
  }
  const clean=await runner.runNonacceptedControlCollection(controlInput())
  const malformed=structuredClone(clean.outcome.evidence)
  malformed.controls.workflows.state="required_controller"
  assert.equal(runner.validateTriageControls(malformed).ok,false)
})
test("control_drift_between_launches_and_postrun",async()=>{
  for(const mode of ["sourceDrift","helperTierUnknown","closureUnknown","doctorTimeout","doctorFailed","doctorTruncated","deliveryPending","deliveryUnknown","deliveryFailed"]){
    const r=await runner.runNonacceptedControlCollection({...controlInput(),mode})
    assert.equal(r.outcome.state,"scope_unqualified",mode)
    assert.equal(r.productionAuthority,false,mode)
  }
  assert.equal((await runner.runNonacceptedControlCollection({...controlInput(),mode:"sourceDrift"})).outcome.detail,"control_source_drift")
})
test("finite_control_rejections_preserve_named_boundary_and_no_authority",async()=>{
  for(const [change,detail]of [
    [{env:{CLAUDE_CODE_SAFE_MODE:"unrecognized"}},"external_requirements"],
    [{sources:[{mcpServers:{external:{}}}]},"incompatible_mcp_policy"],
    [{sources:[{agent:"external"}]},"agent_override"],
    [{sources:[{agents:{external:{}}}]},"agent_override"],
    [{sources:Array.from({length:17},()=>({description:"x".repeat(65536)}))},"control_source_bytes"],
    [{closure:{...controlInput().closure,instructions:null}},"control_data"],
    [{closure:{...controlInput().closure,plugins:null}},"control_closure"],
    [{closure:{...controlInput().closure,lsp:null}},"control_closure"],
    [{closure:{...controlInput().closure,instructions:Array.from({length:65},()=>({text:"data",imports:[]}))}},"control_closure"],
    ...[
      {id:"other",engine_owned:true,eligible:true,external_edges:[]},
      {id:"cc-plugin-sec-default",engine_owned:false,eligible:true,external_edges:[]},
      {id:"cc-plugin-sec-default",engine_owned:true,eligible:false,external_edges:[]},
      {id:"cc-plugin-sec-default",engine_owned:true,eligible:true,external_edges:null},
      {id:"cc-plugin-sec-default",engine_owned:true,eligible:true,external_edges:["external"]},
    ].map(controller=>[{closure:{...controlInput().closure,controller}},"policy_controller"]),
    [{mode:"engineThrows"},"unit_engine"],
    [{closure:{...controlInput().closure,sources:Array.from({length:64},()=>({kind:"instruction",revision_sha256:"a".repeat(64),path_identity:null}))}},"control_source_count"],
    [{closure:{...controlInput().closure,total:1048577}},"control_source_bytes"],
  ]){
    const r=await runner.runNonacceptedControlCollection({...controlInput(),...change})
    assert.equal(r.outcome.detail,detail);assert.equal(r.outcome.state,"scope_unqualified");assert.equal(r.productionAuthority,false)
  }
  const lost=await runner.runNonacceptedControlCollection({...controlInput(),mode:"lostCollection"})
  assert.equal(lost.admission.reason,"diagnostic_inadequate")
  const memory=controlInput();memory.closure.memory=[{text:"managed data",imports:[]}]
  assert.equal((await runner.runNonacceptedControlCollection(memory)).outcome.evidence.controls.memory.state,"known_nonexecuting_data")
  const controllerUnknown=controlInput()
  controllerUnknown.closure.unknown={key:"policy_controller",detail:"unit_unresolved_external_chain"}
  const unresolved=await runner.runNonacceptedControlCollection(controllerUnknown)
  assert.equal(unresolved.outcome.detail,"unit_unresolved_external_chain")
  assert.equal(unresolved.outcome.evidence.controls.policy_controller.state,"unknown")
  assert.equal(unresolved.productionAuthority,false)
  for(const controller of [null,{id:"cc-plugin-sec-default",engine_owned:true,eligible:true,external_edges:[]}]){
    const pending=controlInput()
    pending.closure.unknown={key:"plugins_modules",detail:"unit_unresolved_selected_external_module"}
    pending.closure.controller=controller
    const result=await runner.runNonacceptedControlCollection(pending)
    assert.equal(result.outcome.detail,"unit_unresolved_selected_external_module")
    assert.equal(result.outcome.evidence.controls.instructions_agents.state,"unknown")
    assert.equal(result.outcome.evidence.controls.memory.state,"unknown")
    assert.equal(result.outcome.evidence.controls.policy_controller.state,controller===null?"unknown":"required_controller")
    assert.equal(result.productionAuthority,false)
  }
  await assert.rejects(runner.runNonacceptedControlCollection({...controlInput(),mode:"unsupported"}),{message:"unit_mode"})
  const e=(await runner.runNonacceptedControlCollection(controlInput())).outcome.evidence
  e.effective_sources_sha256="a".repeat(64)
  assert.deepEqual(runner.validateTriageControls(e),{ok:false,errors:["control_source_identity"]})
})
test("old_safe_mode_record_rejected",()=>{
  assert.throws(()=>runner.validateOwnedQualificationStructure({record:{version:2}}),{message:"qualification_structure"})
})
controlHostTest("real_control_collector_pins_source_and_collects_fixed_off_without_inventing_inventory",async(t,{runner,cli:actual,synthetic})=>{
  const f=await fixture(t),catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
  const data=JSON.parse(readFileSync(new URL("../../../../../plugins/desk/mcp/src/factory/v12-owned-catalog.json",import.meta.url)))
  await catalog.writeTriagePreparedFile({inputDir:f.inputDir,brief:data.brief,records:data.record_inputs,recordRefs:data.record_refs})
  const owned=await custody.prepareOwnedCatalogRun({inputDir:f.inputDir,runDir:path.join(f.dir,"actual-control"),deadline:Date.now()+20000})
  t.after(()=>owned.close())
  const p=runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:owned.launch})
  pinnedSourceMemoryFD(t,actual)
  const env={HOME:f.dir}
  let calls=0
  const observed=await runner.collectTriageControls({cli:actual,env,argv:p.argv,runDiagnostic:async()=>{calls++;return diagnostic()}})
  assert.equal(observed.state,"collected")
  assert.equal(calls,1)
  assert.equal(observed.evidence.controls.plugins_modules.state,"known_nonexecuting_data")
  assert.equal(observed.evidence.controls.instructions_agents.state,"source_disabled")
  assert.equal(observed.evidence.controls.memory.state,"effective_off")
  assert.equal(runner.hasCollectedTriageControls(observed.evidence),true)
  if(synthetic)assert.equal(realRunner.hasCollectedTriageControls(observed.evidence),false)
  assert.equal(observed.evidence.builtin_basis["cc-plugin-tips"].selection,"unobserved")
  assert.equal(observed.evidence.sources[0].path_identity.path,actual)
  const unknown=await runner.collectTriageControls({cli:f.cli,env,argv:p.argv,runDiagnostic:()=>{throw Error("no diagnostic")}})
  assert.equal(unknown.detail,"engine_revision")
  const {EventEmitter}=await import("node:events"),{PassThrough}=await import("node:stream")
  t.mock.method(childProcess,"spawn",(_command,args)=>{
    assert.deepEqual(args,["doctor"])
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=0;child.kill=()=>true
    queueMicrotask(()=>{child.stdout.end(doctor);child.stderr.end();child.emit("close",0,null)})
    return child
  })
  syncBuiltinESMExports()
  const defaultDiagnostic=await runner.collectTriageControls({cli:actual,env,argv:p.argv,deadline:Date.now()+10000})
  assert.equal(defaultDiagnostic.state,"collected")
  const legacyDiagnostic=await runner.collectTriageAdmission({cli:actual,env,argv:p.argv,policyReaders:{read:()=>({
    complete:true,controller_invariant:true,sources:[source],validation_errors:[],
  })}})
  assert.equal(legacyDiagnostic.authority,false);assert.equal(legacyDiagnostic.state,"admitted")
  const platform=Object.getOwnPropertyDescriptor(process,"platform")
  try{
    Object.defineProperty(process,"platform",{...platform,value:"linux"})
    const linuxLaunch=custody.ownedServerLaunch(owned.launch.identity)
    const linuxPolicy=runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:linuxLaunch})
    assert.equal((await runner.collectTriageControls({cli:actual,env,argv:linuxPolicy.argv,runDiagnostic:diagnostic})).detail,"control_host")
  }finally{Object.defineProperty(process,"platform",platform)}
  assert.equal((await runner.collectTriageControls({cli:actual,env:{HOME:"relative"},argv:p.argv,runDiagnostic:diagnostic})).detail,"environment_unsafe")
  const brokenDiagnostic=await runner.collectTriageControls({cli:actual,env,argv:p.argv,
    runDiagnostic:async()=>({stdout:BigInt(1),stderr:null})})
  assert.equal(brokenDiagnostic.capture.channels.diagnostic.observation,"unobserved")
  assert.equal(brokenDiagnostic.capture.diagnostic.kind,"unknown")
  assert.equal(brokenDiagnostic.capture.diagnostic.stdout_base64,null)
  const largeDiagnostic=await runner.collectTriageControls({cli:actual,env,argv:p.argv,
    runDiagnostic:async()=>({kind:"closed",code:0,stdout:"x".repeat(65537),stderr:"",truncated:true})})
  assert.equal(largeDiagnostic.capture.channels.diagnostic.truncated,true)
  for(const diagnosticValue of ["", "invalid"]){
    const r=await runner.collectTriageControls({cli:actual,env,argv:p.argv,runDiagnostic:async()=>diagnosticValue})
    assert.equal(r.reason,"diagnostic_inadequate")
    assert.equal(r.capture.channels.diagnostic.observation,diagnosticValue?"present":"observed_absent")
  }
  for(const mutate of [
    v=>v.mcpServers.triage_catalog.type="sdk",v=>v.mcpServers.triage_catalog.args=null,
  ]){
    const argv=[...p.argv],i=argv.indexOf("--mcp-config")+1,config=JSON.parse(argv[i]);mutate(config);argv[i]=JSON.stringify(config)
    assert.equal((await runner.collectTriageControls({cli:actual,env,argv})).detail,"control_recipe")
  }
  const changed=[...p.argv];changed[changed.indexOf("--system-prompt")+1]+=" different"
  assert.equal((await runner.collectTriageControls({cli:actual,env,argv:changed})).detail,"control_recipe")
})
test("control_structure_limits_path_identity_and_state_pairs",async()=>{
  const r=await runner.runNonacceptedControlCollection(controlInput()),e=r.outcome.evidence
  for(const mutate of [
    v=>v.schema="other",v=>v.engine_sha256="a".repeat(64),v=>v.recipe_sha256=3,
    v=>v.remote_delivery="other",v=>v.external_requirements.safe_mode=0,
    v=>v.sources=[],v=>v.sources=Array(65).fill(v.sources[0]),
    v=>v.sources[0].id="wrong",v=>v.sources[0].kind="user",
    v=>v.sources[0].path_identity={path:"relative",dev:1,ino:1,uid:1,mode:384,size:1},
    v=>v.sources[0].path_identity={path:"/unit",dev:-1,ino:1,uid:1,mode:384,size:1},
    v=>v.sources[0].path_identity={path:"/unit",dev:1,ino:1,uid:1,mode:384,size:1,other:true},
    v=>v.controls.settings_sources.state="effective_off",v=>v.controls.native_tools_mcp.state="required_controller",
    v=>v.controls.memory.source_refs=["s999"],v=>v.controls.memory.source_refs=["s000","s000"],
    v=>v.sources[0].revision_sha256="x".repeat(65536),
  ]){
    const x=structuredClone(e);mutate(x)
    assert.equal(runner.validateTriageControls(x).ok,false)
  }
  const valid=structuredClone(e)
  valid.sources[0].path_identity={path:"/unit",dev:1,ino:1,uid:1,mode:384,size:1}
  valid.effective_sources_sha256=hash(JSON.stringify(valid.sources.map(s=>Object.fromEntries(Object.entries(s).sort()))))
  // The canonical source digest—not a claim of live source authority.
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  valid.effective_sources_sha256=hash(catalog.catalogCanonical(valid.sources))
  assert.equal(runner.validateTriageControls(valid).ok,true)
})
controlHostTest("source_bound_control_reader_safe_file_failure_matrix",async(t,{runner,cli,system:managedRoot,preferences,fragment})=>{
  const f=await fixture(t),catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
  const data=JSON.parse(readFileSync(new URL("../../../../../plugins/desk/mcp/src/factory/v12-owned-catalog.json",import.meta.url)))
  await catalog.writeTriagePreparedFile({inputDir:f.inputDir,brief:data.brief,records:data.record_inputs,recordRefs:data.record_refs})
  const owned=await custody.prepareOwnedCatalogRun({inputDir:f.inputDir,runDir:path.join(f.dir,"control-files"),deadline:Date.now()+30000})
  t.after(()=>owned.close())
  const policy=runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:owned.launch})
  const env={HOME:f.dir}
  const original={...Object.fromEntries(["lstatSync","openSync","readFileSync","readdirSync","fstatSync","readSync","closeSync"].map(k=>[k,fsNative[k]]))}
  const nativeBytes=readFileSync(cli),nativeStat=fsNative.lstatSync(cli),nativeFD=987654321
  let nativeCursor=0
  const synthetic=path.join(f.dir,"policy.json");writeFileSync(synthetic,"{}",{mode:0o600})
  const realStat=fsNative.lstatSync,realOpen=fsNative.openSync,realRead=fsNative.readFileSync,realList=fsNative.readdirSync
  const realFdStat=fsNative.fstatSync,realSyncRead=fsNative.readSync
  let mode="normal",opens=0,engineStats=0,ancestorReads=0,directoryReads=0
  const dataDir=path.join(f.dir,"data");fsNative.mkdirSync(dataDir,{mode:0o700})
  const dataFile=file=>String(file).startsWith(managedRoot+"/")&&String(file).endsWith(".md")?path.join(dataDir,path.basename(String(file))):null
  const mappedDirectory=file=>mode.startsWith("dir")&&String(file).startsWith(managedRoot+"/.claude/")?
    path.join(dataDir,path.relative(managedRoot+"/.claude",String(file))):null
  const selected=file=>String(file)===managedRoot||String(file).startsWith(managedRoot+"/")||
    String(file)===preferences||String(file).startsWith(preferences+"/")
  t.mock.method(fsNative,"lstatSync",(file,...args)=>{
    if(!selected(file))return realStat(file,...args)
    if(mappedDirectory(file)){
      const s=realStat(mappedDirectory(file),...args)
      if(mode==="dirTypeChanged"&&String(file).endsWith("/rules")&&++ancestorReads>1)return {...s,isDirectory:()=>false,isSymbolicLink:()=>false}
      if(mode==="dirAncestorsChanged"&&directoryReads>0)s.ino=different(s.ino)
      return s
    }
    if(dataFile(file)&&mode.startsWith("import"))return realStat(dataFile(file))
    if(!String(file).endsWith(".json")&&!String(file).endsWith(".plist")){
      if(String(file).endsWith(".md")||String(file).includes("/.claude/"))throw Object.assign(Error("absent"),{code:"ENOENT"})
      const s=realStat(f.dir)
      if(mode==="ancestorUnreadable")throw Object.assign(Error("ancestor_access"),{code:"EACCES"})
      if(mode==="dropinReplaced"&&directoryReads>0)s.ino=different(s.ino)
      if(mode==="ancestorLink")return {...s,isDirectory:()=>true,isSymbolicLink:()=>true}
      if(mode==="ancestorWritable")s.mode|=0o022
      if(mode==="ancestorOwner")s.uid=process.getuid()+1
      return s
    }
    if(String(file).endsWith(".plist")&&mode!=="plist")throw Object.assign(Error("absent"),{code:"ENOENT"})
    const s=realStat(synthetic)
    if(mode==="symlink")return {...s,isFile:()=>true,isSymbolicLink:()=>true}
    if(mode==="nlink")s.nlink=2
    if(mode==="oversize")s.size=65537
    if(mode==="writable")s.mode|=0o022
    if(mode==="postStat"&&opens>0)s.mtimeMs++
    return s
  })
  t.mock.method(fsNative,"openSync",(file,...args)=>{
    if(file===cli){nativeCursor=0;return nativeFD}
    if(dataFile(file)&&mode.startsWith("import"))return realOpen(dataFile(file),...args)
    if(mappedDirectory(file))return realOpen(mappedDirectory(file),...args)
    if(selected(file)){opens++;if(mode==="fileVanished")throw Object.assign(Error("vanished"),{code:"ENOENT"});return realOpen(synthetic,...args)}
    return realOpen(file,...args)
  })
  t.mock.method(fsNative,"readFileSync",(file,...args)=>{
    if(typeof file==="number"&&mode==="boundedRead")throw Error("unbounded_policy_read")
    if(typeof file==="number"&&mode==="shortRead")return Buffer.from(" ")
    if(typeof file==="number"&&mode==="badShape")return Buffer.from("[]")
    if(typeof file==="number"&&mode==="badUTF8")return Buffer.from([0xff])
    return realRead(file,...args)
  })
  t.mock.method(fsNative,"readdirSync",(file,...args)=>{
    if(mappedDirectory(file)){
      directoryReads++
      if(mode==="dirUnreadable")throw Object.assign(Error("unreadable"),{code:"EACCES"})
      if(mode==="dirBadName")return [".."]
      if(mode==="dirMany")return Array.from({length:65},(_,i)=>`${i}.md`)
      if(mode==="dirListingChanged"&&directoryReads>2)return ["changed.md"]
      return realList(mappedDirectory(file),...args)
    }
    if(String(file).endsWith("managed-settings.d")){
      if(mode==="dropinReplaced")directoryReads++
      if(mode==="listMany")return Array.from({length:33},(_,i)=>`${i}.json`)
      if(mode==="listError")throw Object.assign(Error("unreadable"),{code:"EACCES"})
      return ["unit.json",".hidden.json","not-json.txt"]
    }
    return realList(file,...args)
  })
  t.mock.method(fsNative,"fstatSync",(fd,...args)=>{
    if(fd===nativeFD){
      engineStats++
      if(mode==="engineType")return {...nativeStat,isFile:()=>false}
      const s=Object.assign(Object.create(Object.getPrototypeOf(nativeStat)),nativeStat)
      if(mode==="engineChanged"&&engineStats>1)s.mtimeMs++
      return s
    }
    const s=realFdStat(fd,...args)
    if(mode==="identity"&&s.size===2)s.ino=different(s.ino)
    return s
  })
  t.mock.method(fsNative,"readSync",(fd,buffer,offset,length,position)=>{
    let n
    if(fd===nativeFD){
      const at=position===null?nativeCursor:position
      n=Math.min(length,nativeBytes.length-at)
      nativeBytes.copy(buffer,offset,at,at+n);if(position===null)nativeCursor+=n
    }else{
      n=realSyncRead(fd,buffer,offset,length,position)
      if(n>0){
        if(mode==="shortRead"){buffer[offset]=32;n=1}
        if(mode==="badShape")Buffer.from("[]").copy(buffer,offset)
        if(mode==="badUTF8"){buffer[offset]=255;buffer[offset+1]=255}
        if(mode==="growth"){buffer.fill(32,offset,offset+length);n=length}
      }
    }
    if(mode==="fragment"&&position===fragment&&n>0)buffer[0]^=1
    return n
  })
  t.mock.method(fsNative,"closeSync",fd=>fd===nativeFD?undefined:original.closeSync(fd))
  const originalExec=childProcess.execFileSync
  t.mock.method(childProcess,"execFileSync",(command,args,opts)=>mode==="plist"&&command==="/usr/bin/plutil"?"{}":originalExec(command,args,opts))
  syncBuiltinESMExports()
  t.after(()=>{t.mock.restoreAll();Object.assign(fsNative,original);syncBuiltinESMExports()})
  for(const next of ["normal","pretty","boundedRead","plist","symlink","nlink","oversize","writable","duplicate","nestedDuplicate","escapedDuplicate","jsonNumericMismatch","ancestorLink","ancestorWritable","ancestorOwner","ancestorUnreadable","dropinReplaced","fileVanished","postStat","shortRead","badShape","badUTF8","growth","helperUnknown","listMany","listError","identity","fragment","engineType","engineChanged",
    "importNormal","importCycle","importOutside","importDepth","importMissing","importFrontmatter","importYAML","importAlias","importYAMLDuplicate","importYAMLObject","importYAMLPaths","importYAMLEmpty","importYAMLBadPaths","importCode","importHTML","importTilde","importExtension","importAbsolute","importEmptyFragment","importRepeated",
    "dirNormal","dirDepth","dirSymlink","dirMany","dirBadName","dirUnreadable","dirAggregate","dirMembers","dirDirectoryMembers","dirTypeChanged","dirAncestorsChanged","dirListingChanged","externalRegistration"]){
    mode=next;opens=0;engineStats=0;ancestorReads=0;directoryReads=0;let calls=0
    const policyBytes={helperUnknown:'{"unknown":true}',pretty:' { "disableAllHooks" : true } ',
      duplicate:'{"disableAllHooks":false,"disableAllHooks":true}',nestedDuplicate:'{"permissions":{"allow":["Bash"],"allow":[]}}',
      escapedDuplicate:'{"disableAllHooks":false,"\\u0064isableAllHooks":true}',jsonNumericMismatch:'{"number":1e3}',
      externalRegistration:'{"enabledPlugins":{"external@market":true}}'}
    writeFileSync(synthetic,policyBytes[mode]??"{}")
    for(let n=0;n<6;n++)writeFileSync(path.join(dataDir,n===0?"CLAUDE.md":`${n}.md`),
      n<5?`Managed data\n@./${n+1}.md\n`:"Managed data",{mode:0o600})
    if(mode==="importNormal")writeFileSync(path.join(dataDir,"CLAUDE.md"),"Managed data\n@./1.md")
    if(mode==="importNormal")writeFileSync(path.join(dataDir,"1.md"),"Included managed data")
    if(mode==="importCycle")writeFileSync(path.join(dataDir,"1.md"),"@./CLAUDE.md")
    if(mode==="importOutside")writeFileSync(path.join(dataDir,"CLAUDE.md"),"@../outside.md")
    if(mode==="importMissing")writeFileSync(path.join(dataDir,"CLAUDE.md"),"@./missing.md")
    if(mode==="importFrontmatter")writeFileSync(path.join(dataDir,"CLAUDE.md"),"---javascript\nthrow Error('forbidden')\n---\nManaged data")
    const contents={
      importYAML:"---\nname: Named\ndescription: data\n---\nManaged data",
      importAlias:"---\nname: &a Named\ndescription: *a\n---\nManaged data",
      importYAMLDuplicate:"---\nname: First\nname: Second\n---\nManaged data",
      importYAMLObject:"---\nname: {}\n---\nManaged data",
      importYAMLPaths:"---\npaths: [file.md]\n---\nManaged data",
      importYAMLEmpty:"---\n\n---\nManaged data",
      importYAMLBadPaths:"---\npaths: [1]\n---\nManaged data",
      importCode:"` @./1.md `",importHTML:"<!-- @./1.md -->",importTilde:"@~/1.md",importExtension:"@./other.js",
      importAbsolute:"@"+(managedRoot+"/1.md").replaceAll(" ","\\ "),importEmptyFragment:"@#section",
      importRepeated:"@./1.md\n@./1.md",
    }
    if(contents[mode]!==undefined){writeFileSync(path.join(dataDir,"CLAUDE.md"),contents[mode]);writeFileSync(path.join(dataDir,"1.md"),"Included data")}
    if(mode.startsWith("dir")){
      const rules=path.join(dataDir,"rules");fsNative.rmSync(rules,{recursive:true,force:true});fsNative.mkdirSync(rules,{mode:0o700})
      if(mode==="dirDepth"){
        let p=rules;for(let i=0;i<6;i++){p=path.join(p,"nested");fsNative.mkdirSync(p,{mode:0o700})}
      }else if(mode==="dirDirectoryMembers"){
        for(let i=0;i<64;i++)fsNative.mkdirSync(path.join(rules,`${i}`),{mode:0o700})
      }else if(mode==="dirSymlink")fsNative.symlinkSync(path.join(dataDir,"1.md"),path.join(rules,"alias.md"))
      else if(mode==="dirAggregate"||mode==="dirMembers"){
        for(let i=0;i<(mode==="dirMembers"?64:17);i++)writeFileSync(path.join(rules,`${i}.md`),mode==="dirMembers"?"data":"x".repeat(65536),{mode:0o600})
      }else{
        fsNative.mkdirSync(path.join(rules,"nested"),{mode:0o700})
        writeFileSync(path.join(rules,"nested","rule.md"),"Managed rule",{mode:0o600})
        writeFileSync(path.join(rules,"ignored.txt"),"Not a selected rule",{mode:0o600})
      }
    }
    const r=await runner.collectTriageControls({cli,env,argv:policy.argv,runDiagnostic:async()=>{calls++;return diagnostic()}})
    const compatible=["normal","pretty","boundedRead","plist","importNormal","importYAML","importYAMLPaths","importYAMLEmpty",
      "importAbsolute","importEmptyFragment","importRepeated","dirNormal"].includes(mode)
    assert.equal(r.state,compatible?"collected":"scope_unqualified",mode)
    assert.equal(runner.hasCollectedTriageControls(r.evidence),compatible,mode)
    assert.equal(calls,["normal","pretty","boundedRead","plist"].includes(mode)||mode.startsWith("import")||mode.startsWith("dir")?1:0,mode)
    if(["duplicate","nestedDuplicate","escapedDuplicate"].includes(mode))assert.equal(r.detail,"control_json_ambiguous",mode)
    if(mode.startsWith("ancestor"))assert.equal(r.detail,mode==="ancestorUnreadable"?"ancestor_access":"control_ancestor_unsafe",mode)
    if(mode==="importNormal"){
      assert.equal(r.evidence.controls.instructions_agents.state,"known_nonexecuting_data","bounded managed data and exact disabled builtin loading are both proved")
      assert.ok(r.evidence.sources.some(s=>s.kind==="instruction"&&s.path_identity?.path===managedRoot+"/1.md"))
    }
    if(mode==="importCycle")assert.equal(r.detail,"control_import_cycle")
    if(mode==="importOutside")assert.equal(r.detail,"control_import_outside")
    if(mode==="importDepth")assert.equal(r.detail,"control_import_depth")
    if(mode==="importMissing")assert.equal(r.detail,"control_import_missing")
    if(mode==="importFrontmatter")assert.equal(r.detail,"control_frontmatter_unsupported")
    const expected={jsonNumericMismatch:"hooks_helpers:selected_policy_tier_unresolved",importAlias:"control_frontmatter_unsupported",
      importYAMLDuplicate:"control_frontmatter_unsupported",importYAMLObject:"control_frontmatter_unsupported",importYAMLBadPaths:"control_frontmatter_unsupported",
      importCode:"control_import_ambiguous",importHTML:"control_import_ambiguous",importTilde:"control_import_unsupported",importExtension:"control_import_unsupported",
      dirDepth:"control_import_depth",dirSymlink:"control_ancestor_unsafe",dirMany:"control_closure_count",dirBadName:"control_path_ambiguous",
      dirUnreadable:"unreadable",dirAggregate:"control_source_bytes",dirMembers:"control_closure_count",dirDirectoryMembers:"control_closure_count",
      dirTypeChanged:"control_ancestor_unsafe",dirAncestorsChanged:"control_source_changed",dirListingChanged:"control_source_changed",
      dropinReplaced:"control_source_changed",fileVanished:"control_source_changed"}
    if(mode==="externalRegistration")assert.equal(r.detail,"control_external_plugin_registration")
    if(expected[mode])assert.equal(r.detail,expected[mode],mode)
  }
})
async function fixture(t){
  const dir=realpathSync(mkdtempSync(path.join(tmpdir(),"triage-test-")))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const inputDir=path.join(dir,"input");fsNative.mkdirSync(inputDir,{mode:0o700})
  for(const [file,bytes]of [["engine","engine revision one"],["runtime","runtime revision one"],["managed-policy.json","{}"]])writeFileSync(path.join(dir,file),bytes)
  const resultFile=path.join(inputDir,".triage-result.json"),cli=path.join(dir,"engine")
  const resolveExec=()=>({cmd:cli,prefix:[],files:[cli,path.join(dir,"runtime")],supported:true})
  return {dir,inputDir,resultFile,cli,resolveExec,env:{HOME:dir,PATH:"/fixture",PRIVATE_SECRET:"not-for-child",HTTPS_PROXY:"https://proxy"}}
}
test("real_exports_refuse_caller_doctor_policy_reader_and_chain_resolver",async(t)=>{
  const f=await fixture(t);let called=0
  const count=async()=>{called++;return diagnostic()}
  for(const extra of [{runDiagnostic:count},{policyReaders:{read:()=>{called++;return readers.read()}}},{resolveExec:f.resolveExec}]){
    assert.equal((await runner.collectTriageAdmission({cli:f.cli,env:f.env,argv:[],...extra})).reason,"policy_control_unsupported")
    const controls=await runner.collectTriageControls({cli:f.cli,env:f.env,argv:[],...extra})
    assert.deepEqual([controls.reason,controls.detail,controls.evidence],["policy_control_unsupported","caller_adapter",null])
  }
  // Without adapters the real exports run their own fixed readers; this
  // fixture's empty argv fails the fixed recipe before any doctor could start.
  assert.equal((await runner.collectTriageAdmission({cli:f.cli,env:f.env,argv:[]})).state,"scope_unqualified")
  assert.equal((await runner.collectTriageControls({cli:f.cli,env:f.env,argv:[]})).detail,"control_recipe")
  const resolver=()=>{called++;return f.resolveExec()}
  assert.equal(runner.inspectLaunchChain({cli:f.cli,env:f.env,resolveExec:resolver,readFile:()=>{called++;return Buffer.alloc(0)}}).state,"scope_unqualified",
    "the real export resolves the fixture engine itself and finds no supported chain")
  assert.equal(called,0,"no caller adapter ran")
  assert.equal(adapterRunner.inspectLaunchChain({cli:f.cli,env:f.env,resolveExec:resolver}).state,"inspected")
  assert.equal(called,1,"the nonaccepted control host alone accepts a resolver")
})
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
ownedHostTest("owned_only_actual_manifest_required","posix",async(t)=>{
  const f=await fixture(t)
  const custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const data=JSON.parse(readFileSync(new URL("../../../../../plugins/desk/mcp/src/factory/v12-owned-catalog.json",import.meta.url)))
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
    const result=await qualifier.qualifyOwnedCatalog({launch:{cli:f.cli,env:f.env},
      fixture:null,deadline:Date.now()+2000,evidenceDir:out})
    assert.equal(result.state,"blocked")
    assert.equal(result.reason,"diagnostic_inadequate")
    // The real qualifier takes no launcher, sign-in, doctor or resolver.
    for(const adapter of [{spawn:()=>{launches++;throw Error("forbidden")}},{probeSpawn:()=>{launches++}},{cliMetadata:metadata},
      {resolveExec:f.resolveExec},{runDiagnostic:diagnostic},{policyReaders:readers}]){
      const refused=await qualifier.qualifyOwnedCatalog({launch:{cli:f.cli,env:f.env,...adapter},fixture:null,deadline:Date.now()+2000,evidenceDir:out})
      assert.deepEqual([refused.state,refused.reason,refused.record],["blocked","policy_control_unsupported",null],Object.keys(adapter)[0])
    }
    assert.equal(launches,0)
    assert.equal(fsNative.existsSync(out),false,"measurement must not create or persist a real qualification store")
  }finally{
    if(before===undefined)delete process.env.DESK_COVERAGE_RUNNER_CHILD
    else process.env.DESK_COVERAGE_RUNNER_CHILD=before
  }
})
test("qualifier_direct_entry_guards_are_measured_without_native_or_store_authority",async(t)=>{
  const f=await fixture(t),qualifier=await import("../../../../../plugins/desk/mcp/scripts/qualify-triage-runner.js")
  // A file URL pathname is "/D:/..." on Windows; argv carries the platform path.
  const entry=fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/qualify-triage-runner.js",import.meta.url))
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
ownedHostTest("qualified_format_full_per_run_identity","posix",async(t)=>{
  const f=await fixture(t),custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const data=JSON.parse(readFileSync(new URL("../../../../../plugins/desk/mcp/src/factory/v12-owned-catalog.json",import.meta.url)))
  await catalog.writeTriagePreparedFile({inputDir:f.inputDir,brief:data.brief,records:data.record_inputs,recordRefs:data.record_refs})
  const identities=[]
  for(let i=0;i<2;i++){
    const run=await custody.prepareOwnedCatalogRun({inputDir:f.inputDir,runDir:path.join(f.dir,`identity-${i}`),deadline:Date.now()+15000})
    t.after(()=>run.close())
    const policy=runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:run.launch})
    const invocation={command:f.cli,args:policy.argv,cwd:run.runDir,parent_env_sha256:hash(catalog.catalogCanonical(runner.triageChildEnvironment({HOME:f.dir}))),owned_launch:run.launch,
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
ownedHostTest("synthetic_record_structure_validation_never_issues_authority","posix",async(t)=>{
  const f=await fixture(t),custody=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js")
  const catalog=await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js")
  const data=JSON.parse(readFileSync(new URL("../../../../../plugins/desk/mcp/src/factory/v12-owned-catalog.json",import.meta.url)))
  await catalog.writeTriagePreparedFile({inputDir:f.inputDir,brief:data.brief,records:data.record_inputs,recordRefs:data.record_refs})
  const sourceIdentity=await custody.ownedSourceIdentity(),out=f.dir,env={HOME:f.dir},nativeReceipts=[],directReceipts=[],invocationIdentities=[]
  for(let i=1;i<=2;i++){
    const run=await custody.prepareOwnedCatalogRun({inputDir:f.inputDir,runDir:path.join(out,`native-${i}`),deadline:Date.now()+15000})
    t.after(()=>run.close())
    const policy=runner.triagePolicy({inputDir:f.inputDir,resultFile:f.resultFile,cliMetadata:metadata,ownedServer:run.launch})
    const invocation={command:f.cli,args:policy.argv,cwd:run.runDir,parent_env_sha256:hash(catalog.catalogCanonical(runner.triageChildEnvironment({HOME:f.dir}))),owned_launch:run.launch,
      prepared_sha256:run.prepared.sha256,catalog_sha256:run.catalog.catalogSha256,brief_sha256:run.catalog.briefSha256,record_refs_sha256:run.catalog.recordRefsSha256}
    nativeReceipts.push({snapshotFile:path.join(out,`native-${i}`,"catalog.json"),invocation,custody:{sourceIdentity,roots:custody.ownedSourceRoots(),moduleClosure:[]}})
    directReceipts.push({snapshotArchive:path.join(out,`direct-${i}`,"catalog.json"),tools:catalog.catalogToolSchemas().tools,custody:{sourceIdentity,roots:custody.ownedSourceRoots()}})
    invocationIdentities.push(runner.ownedInvocationIdentity({invocation,chain:{effective_argv:[f.cli]},cliMetadata:metadata,env}))
  }
  const collected=await runner.runNonacceptedControlCollection(controlInput()),controls=collected.outcome.evidence
  const control_history=nativeReceipts.map(run=>({...structuredClone(controls),recipe_sha256:hash(catalog.catalogCanonical({version:3,argv:run.invocation.args}))}))
  const registered=[...Object.keys(fixedOff()),"cc-plugin-tips@builtin","cc-plugin-sec-default@builtin"]
  const {catalogProtocolIdentity}=await import("../../../../../plugins/desk/mcp/src/factory/triage-protocol.js")
  const synthetic={version:7,protocol_envelope_version:2,protocol_identity:catalogProtocolIdentity(),
    enforcement_scheme:"owned_catalog_mcp",state:"qualified",env_recipe_version:3,sourceIdentity,source_roots:custody.ownedSourceRoots(),
    dependency_identity:custody.ownedDependencyIdentity(),environment_sha256:hash(catalog.catalogCanonical(runner.triageChildEnvironment(env))),
    recipe_version:3,controls_schema:"desk.factory.triage-controls/3",predicate_table:"E296/3",
    optional_off_sha256:hash(catalog.catalogCanonical(fixedOff())),registered_set_sha256:hash(catalog.catalogCanonical(registered)),
    effective_off_sha256:hash(catalog.catalogCanonical(control_history.map(e=>({recipe:e.recipe_sha256,sources:e.effective_sources_sha256,
      optional_off:fixedOff()})))),
    builtin_basis_sha256:hash(catalog.catalogCanonical(control_history.map(e=>e.builtin_basis))),
    control_evidence:control_history,predicate_table_sha256:collected.outcome.predicate_table_sha256,
    policy_sources_fingerprint:"a".repeat(64),chain_fingerprint:"b".repeat(64),directReceipts,nativeReceipts,cliMetadata:metadata,
    cli:f.cli,format_fingerprint:hash(catalog.catalogCanonical(directReceipts[0].tools)),resources:{native_launches:2,direct_bundles:2},invocationIdentities}
  assert.deepEqual(runner.validateOwnedQualificationStructure({record:synthetic,out,sourceIdentity,env}),{state:"structure_validated",authority:false})
  const previous=structuredClone(synthetic);previous.version=4
  assert.throws(()=>runner.validateOwnedQualificationStructure({record:previous,out,sourceIdentity,env}),{message:"qualification_structure"})
  for(const mutate of [r=>r.version=5,r=>r.protocol_envelope_version=1,r=>r.protocol_identity.negotiated="2025-11-25",
    r=>r.protocol_identity.schema_sha256="a".repeat(64),r=>r.predicate_table="E296/2",r=>r.builtin_basis_sha256="a".repeat(64),
    r=>r.optional_off_sha256="a".repeat(64),r=>r.registered_set_sha256="a".repeat(64),r=>r.effective_off_sha256="a".repeat(64),
    r=>delete r.control_evidence[0].builtin_basis]){
    const changed=structuredClone(synthetic);mutate(changed)
    assert.throws(()=>runner.validateOwnedQualificationStructure({record:changed,out,sourceIdentity,env}))
  }
  const old=structuredClone(synthetic)
  old.version=2
  for(const key of ["recipe_version","controls_schema","control_evidence","predicate_table_sha256"])delete old[key]
  assert.throws(()=>runner.validateOwnedQualificationStructure({record:old,out,sourceIdentity,env}),{message:"qualification_structure"},"old safe-mode record version must not qualify the revised recipe")
  const document=runner.prepareOwnedQualificationDocument({directReceipts,nativeReceipts,admission:{sources:[],remote_delivery:"not_applicable",controls:control_history[1],control_history},
    chain:{effective_argv:[f.cli],fingerprint:"b".repeat(64)},cliMetadata:metadata,cli:path.join(f.dir,"indirect-selector"),env})
  assert.equal(document.state,"unaccepted_document");assert.equal(document.authority,false)
  assert.equal(document.record.version,7,"content-addressed identity invalidates record6")
  assert.equal(document.record.protocol_envelope_version,2,"record binds the finite reviewed protocol envelope")
  assert.equal(document.record.cli,f.cli,"record binds actual execution target, not original selector")
  const lateArgs=structuredClone(nativeReceipts),secondArgs=lateArgs[1].invocation.args
  secondArgs[Symbol.iterator]=function*(){for(let i=0;i<this.length;i++)yield i===0?"unit-late-argv-drift":this[i]}
  assert.throws(()=>runner.prepareOwnedQualificationDocument({directReceipts,nativeReceipts:lateArgs,
    admission:{sources:[],remote_delivery:"not_applicable",capabilities:null},
    chain:{effective_argv:[f.cli],fingerprint:"b".repeat(64)},cliMetadata:metadata,env}),{message:"invocation_template"})
  const unitConfig={record:document.record,env,admission:{state:"admitted",sources:[],remote_delivery:"not_applicable",controls:control_history[1],control_history,fingerprint:"unit-admission"},
    chain:{state:"inspected",effective_argv:[f.cli],fingerprint:"b".repeat(64)}}
  const unit=runner.createNonacceptedTriageUnit(unitConfig)
  const sealed=unit.seal()
  assert.match(sealed.record.host_seal,/^[a-f0-9]{64}$/u,"a registered record carries this host's seal")
  const stored=unit.sealDocument(document.record)
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
  for(const failure of ["read","restoreDirect","restoreNative","restoreAuthNative","restoreAuthDirect","admission","admissionIdentity"]){
    const isolated=runner.createNonacceptedTriageUnit({...unitConfig,failures:{[failure]:true}})
    await isolated.save(stored)
    const refused=await isolated.load()
    assert.equal(refused.outcome.state,"scope_unqualified",failure)
    assert.equal(isolated.lookup(refused.outcome).registered,false)
  }
  const writeFailure=runner.createNonacceptedTriageUnit({...unitConfig,failures:{write:true}})
  await assert.rejects(writeFailure.save(document.record))
  assert.equal((await writeFailure.load()).outcome.state,"scope_unqualified")
  const cliMismatch=runner.createNonacceptedTriageUnit(unitConfig)
  await cliMismatch.save(stored)
  assert.equal((await cliMismatch.load({cli:"/synthetic/other"})).outcome.reason,"diagnostic_inadequate")
  assert.deepEqual((await cliMismatch.restore({cli:"/synthetic/other"})).outcome,{state:"stale",reason:"engine_mismatch",requalify:false})
  // The classified restore: stale reasons with their requalify flag, damage kept apart.
  // `edit` changes the stored record after sealing (damage); `reseal` seals the edited record as this host would.
  const classify=async(failures,{record=stored,edit,reseal,cli,extra}={})=>{
    const isolated=runner.createNonacceptedTriageUnit({...unitConfig,...(extra??{}),failures})
    let saved=structuredClone(record);edit?.(saved)
    if(reseal)saved=isolated.sealDocument(saved)
    await isolated.save(saved)
    if(saved.state==="blocked"&&!failures.noCapture)await isolated.saveDocument("failure-capture.json",{version:1})
    return (await isolated.restore(cli?{cli}:{})).outcome
  }
  assert.equal((await classify({})).state,"qualified")
  assert.deepEqual(await classify({host:true}),{state:"stale",reason:"host_unsupported",requalify:false})
  const fresh=runner.createNonacceptedTriageUnit(unitConfig)
  assert.deepEqual((await fresh.restore()).outcome,{state:"missing"})
  assert.deepEqual(await classify({read:true}),{state:"damaged",reason:"unreadable"})
  for(const [failure,reason,requalify]of [["source","source_changed",true],["sourceGone","source_changed",true],
    ["dependencies","source_changed",true],["dependenciesGone","source_changed",true],["runtime","runtime_changed",true],
    ["engineMoved","engine_changed",true],["engineGone","engine_unpinned",false],["closureChanged","source_changed",true],
    ["chain","chain_unavailable",false],["chainIdentity","chain_changed",true],["admission","policy_blocked",false],
    ["admissionIdentity","policy_changed",true],["hostUnknown","host_unsupported",false],["rootUnsafe","root_unsafe",false],
    ["sourceUnreadable","check_failed",false],["closureUnreadable","check_failed",false],["chainThrows","check_failed",false]]){
    assert.deepEqual(await classify({[failure]:true}),{state:"stale",reason,requalify},failure)
  }
  assert.equal((await classify({sourceFlicker:true})).state,"qualified","a file that vanishes once mid-read is read again")
  // Relocated roots: restore admits the qualified invocation rebuilt under the current roots, not the recorded argv.
  assert.equal((await classify({otherRoots:true})).state,"qualified","a byte-identical install at another path keeps the record")
  const elsewhere=runner.createNonacceptedTriageUnit({...unitConfig,failures:{otherRoots:true}})
  const misplaced=await elsewhere.run(elsewhere.seal().record)
  assert.equal(misplaced.outcome.state,"scope_unqualified","the unit's admission refuses a launch that names another root")
  assert.equal(elsewhere.statistics().runs,0)
  for(const [failure,reason]of [["closureInvalid","structure"],["restoreDirect","receipts"],["restoreNative","receipts"],
    ["restoreAuthNative","receipts"],["receiptFrames","receipts"],["foreignHost","seal"]]){
    assert.deepEqual(await classify({[failure]:true}),{state:"damaged",reason},failure)
  }
  assert.deepEqual(await classify({},{record:document.record}),{state:"damaged",reason:"seal"},"an unsealed record is not this host's")
  // Any edit to a sealed record is damage, never staleness: identity fields included.
  for(const edit of [r=>{r.sourceIdentity.runtime.sha256="f".repeat(64)},r=>{r.control_evidence[0].engine_sha256="f".repeat(64)},
    r=>{r.environment_sha256="f".repeat(64)},r=>{r.dependency_identity.sha256="f".repeat(64)},r=>{r.sourceIdentity.version=1},
    r=>{r.predicate_table_sha256="f".repeat(64)}]){
    assert.deepEqual(await classify({},{edit}),{state:"damaged",reason:"seal"},String(edit))
  }
  // A resealed record whose identity disagrees with its receipts is damage too.
  for(const edit of [r=>{r.environment_sha256="f".repeat(64)},r=>{r.directReceipts[0].custody.sourceIdentity={...r.sourceIdentity,extra:1}},
    r=>{r.nativeReceipts[1].custody.roots={...r.source_roots,source:"/elsewhere/"}},r=>{r.nativeReceipts[0].invocation.command="/synthetic/other"},
    r=>{r.control_evidence[0].recipe_sha256="f".repeat(64)},r=>{r.control_evidence[1].engine_sha256="f".repeat(64)},
    r=>{r.control_evidence=[r.control_evidence[0]]},r=>{r.directReceipts=[r.directReceipts[0]]}]){
    assert.deepEqual(await classify({},{edit,reseal:true}),{state:"damaged",reason:"receipts"},String(edit))
  }
  // A coherent sealed record from an earlier engine pin is stale.
  assert.deepEqual(await classify({},{edit:r=>{for(const e of r.control_evidence)e.engine_sha256="f".repeat(64)},reseal:true}),
    {state:"stale",reason:"engine_changed",requalify:true})
  assert.deepEqual(await classify({},{extra:{env:{...env,HTTPS_PROXY:"http://proxy.invalid:8080"}}}),{state:"stale",reason:"environment_changed",requalify:true})
  assert.deepEqual(await classify({},{extra:{env:{HOME:"relative"}}}),{state:"stale",reason:"environment_unsafe",requalify:false})
  const everywhere=change=>r=>{change(r);for(const run of [...r.directReceipts,...r.nativeReceipts])run.custody.sourceIdentity=r.sourceIdentity}
  for(const change of [r=>{r.sourceIdentity.version=1},r=>{r.sourceIdentity=null},r=>{r.sourceIdentity.files=[]},r=>{r.sourceIdentity.runtime=null}]){
    assert.deepEqual(await classify({},{edit:everywhere(change),reseal:true}),{state:"damaged",reason:"structure"})
  }
  for(const edit of [r=>{r.extra=1},r=>{r.cli="relative"},r=>{r.control_evidence=null},r=>{r.nativeReceipts=null},r=>{r.version=8}]){
    assert.deepEqual(await classify({},{edit}),{state:"damaged",reason:"structure"})
  }
  assert.deepEqual(await classify({},{edit:r=>{r.predicate_table_sha256="f".repeat(64)},reseal:true}),{state:"damaged",reason:"structure"})
  const blocked={version:7,protocol_envelope_version:2,enforcement_scheme:"owned_catalog_mcp",recipe_version:3,controls_schema:"desk.factory.triage-controls/3",predicate_table:"E296/3",state:"blocked",reason:"diagnostic_inadequate"}
  assert.deepEqual(await classify({},{record:blocked}),{state:"stale",reason:"qualification_failed",requalify:true})
  assert.deepEqual(await classify({noCapture:true},{record:blocked}),{state:"damaged",reason:"structure"},"a failure without its capture is not ours")
  for(const edit of [r=>{r.reason=1},r=>{r.extra=1},r=>{r.recipe_version=2},r=>{r.state="other"}]){
    assert.deepEqual(await classify({},{record:blocked,edit}),{state:"damaged",reason:"structure"})
  }
  assert.deepEqual(await classify({},{record:{...blocked,version:6}}),{state:"stale",reason:"record_version",requalify:true})
  const v6=structuredClone(document.record);v6.version=6
  for(const key of ["source_roots","dependency_identity","environment_sha256"])delete v6[key]
  assert.deepEqual(await classify({},{record:v6}),{state:"stale",reason:"record_version",requalify:true})
  assert.deepEqual(await classify({},{record:{...v6,state:"other"}}),{state:"damaged",reason:"structure"})
  assert.deepEqual(await classify({},{record:{...v6,extra:1}}),{state:"damaged",reason:"structure"},"an edited earlier record is damage, not staleness")
  assert.deepEqual(await classify({},{record:{version:5}}),{state:"damaged",reason:"structure"})
  assert.deepEqual(await classify({},{record:[]}),{state:"damaged",reason:"structure"})
  assert.deepEqual(Object.entries(runner.TRIAGE_STALE_REASONS).filter(([,value])=>!value).map(([key])=>key).sort(),
    ["chain_unavailable","check_failed","engine_mismatch","engine_unpinned","environment_unsafe","host_unsupported","measurement_active","policy_blocked","root_unsafe"])
  // A production run must load the server modules that were qualified, and the same dependencies.
  for(const failure of ["runClosure","dependencies"]){
    const isolated=runner.createNonacceptedTriageUnit({...unitConfig,failures:{[failure]:true}})
    assert.equal((await isolated.run(isolated.seal().record)).outcome.state,"scope_changed",failure)
  }
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
  assert.equal(nativeUnit.statistics.syntheticReservations,0)
  const reservedUnit=await qualifier.runNonacceptedNativeQualification({...unitConfig,failures:{reserve:"accept"}})
  assert.equal(reservedUnit.outcome.state,"qualified")
  assert.equal(reservedUnit.statistics.syntheticReservations,1,"both launches are reserved once, before the first")
  assert.equal(reservedUnit.statistics.syntheticLaunches,2)
  const refusedUnit=await qualifier.runNonacceptedNativeQualification({...unitConfig,failures:{reserve:"refuse"}})
  assert.equal(refusedUnit.outcome.state,"blocked")
  assert.equal(refusedUnit.statistics.syntheticLaunches,0,"a refused ledger launches nothing")
  assert.equal(refusedUnit.statistics.syntheticAuthGenerations,1,"the reservation follows the sign-in check")
  for(const failure of ["policy","chain","chainIdentity","admission","admissionIdentity","signIn","prepared","postAdmission","postIdentity","postExitAdmission","postExitIdentity","runChainUnknown","runChainDrift","native","direct","write","read"]){
    const refused=await qualifier.runNonacceptedNativeQualification({...unitConfig,failures:{[failure]:true}})
    assert.equal(refused.authority,false)
    assert.equal(refused.outcome.state,"blocked",failure)
  }
  const noCurrentControls=await qualifier.runNonacceptedNativeQualification({...unitConfig,admission:{...unitConfig.admission,controls:null}})
  assert.equal(noCurrentControls.outcome.state,"blocked")
  assert.equal(noCurrentControls.statistics.syntheticLaunches,0)
  for(const history of [null,[]]){
    const noHistory=runner.createNonacceptedTriageUnit({...unitConfig,admission:{...unitConfig.admission,control_history:history}})
    assert.throws(()=>noHistory.seal(),{message:"control_collection_untrusted"})
  }
  const noVector=runner.createNonacceptedTriageUnit({...unitConfig,admission:{...unitConfig.admission,controls:null}})
  const noVectorRecord=noVector.seal().record
  await noVector.save(noVectorRecord)
  assert.equal((await noVector.load()).outcome.state,"scope_unqualified")
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
  for(const failure of ["outside","mkdir","write","reloadThrows"]){
    const r=await qualifier.runNonacceptedCatalogTransaction({...unitConfig,fixture:data,phaseFailure:failure})
    assert.equal(r.outcome.state,"blocked")
    assert.ok(r.outcome.resources.failure_capture.stages.length<=64)
    assert.equal(r.outcome.resources.failure_capture.channels.qualification.observation,"unobserved")
    assert.equal(r.statistics.actualLaunches,0)
  }
  const admissionHold=await qualifier.runNonacceptedNativeQualification({...unitConfig,failures:{admission:true}})
  assert.equal(admissionHold.outcome.state,"blocked")
  assert.ok(admissionHold.evidence.some(e=>e.name==="native-1-stages.json"&&e.value.channels.native.observation==="unobserved"))
  const captureWrite=await qualifier.runNonacceptedNativeQualification({...unitConfig,failures:{write:true}})
  assert.equal(captureWrite.outcome.state,"blocked")
  assert.equal(captureWrite.statistics.syntheticLaunches,1,"missing first-run stage capture must stop the second launch")
  for(const failures of [{close:true},{invocation:true},{nativeMode:"emptyInit"}]){
    const refusal=await qualifier.runNonacceptedNativeQualification({...unitConfig,failures})
    assert.equal(refusal.outcome.state,"blocked")
  }
  const syntheticFailure=await qualifier.runNonacceptedCatalogTransaction({...unitConfig,fixture:data,phaseFailure:null,failures:{run:true}})
  assert.equal(syntheticFailure.outcome.resources.failure_capture.channels.native.observation,"present","a returned synthetic bundle is observed data, never a real model receipt")
  const syntheticNative=await qualifier.runNonacceptedNativeQualification({...unitConfig,failures:{nativeMode:"normal"}})
  assert.equal(syntheticNative.authority,false)
  assert.ok(syntheticNative.evidence.some(x=>x.name==="native-1-stages.json"&&x.value.channels.native.observation==="present"))
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
ownedHostTest("isolated_document_reader_is_closed_and_never_issues_authority","posix",async(t)=>{
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
  const f=await fixture(t),r=await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic,policyReaders:readers})
  assert.equal(r.state,"admitted");assert.equal(r.remote_delivery,"not_applicable");assert.match(r.fingerprint,/^[a-f0-9]{64}$/)
})
test("pending_applicable_policy_blocks",async(t)=>{
  const f=await fixture(t)
  for(const [stdout,reason]of [["Managed settings (remote): checking… (fetch in progress; re-run in a moment)","applicable_delivery_pending"],["Managed settings (remote): unfamiliar future message","diagnostic_inadequate"],["Managed settings (remote): fetch failed (cached policy applies)","effective_policy_unknown"]]){
    const r=await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:async()=>({kind:"closed",code:0,stdout}),policyReaders:readers})
    assert.equal(r.state,"scope_unqualified");assert.equal(r.reason,reason)
  }
  for(const stdout of ["Managed settings (remote): no server-managed settings configured","Managed settings (remote): delivered settings loaded"]){
    const r=await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:async()=>({kind:"closed",code:0,stdout}),policyReaders:readers})
    assert.equal(r.state,"admitted")
    assert.equal(r.remote_delivery,stdout.includes("loaded")?"delivered":"no_configuration")
  }
})
test("effective_hook_helper_or_widening_grant_blocks",async(t)=>{
  const f=await fixture(t)
  for(const [settings,reason]of [[{hooks:{SessionStart:[{hooks:[{type:"command",command:"never execute this"}]}]}},"active_hook_or_helper"],[{policyHelper:"never execute this"},"active_hook_or_helper"],[{permissions:{allow:["Edit"]}},"unsafe_permission_grant"],[{permissions:{additionalDirectories:["/outside"]}},"unsafe_permission_grant"],[{env:{ANTHROPIC_API_KEY:"secret"}},"billing_unresolved"],[{mcpServers:{unsafe:{}}},"unsafe_permission_grant"]]){
    const r=await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic,policyReaders:{read:()=>({complete:true,controller_invariant:true,sources:[{...source,settings}],validation_errors:[]})}})
    assert.equal(r.reason,reason);assert.equal(JSON.stringify(r).includes("secret"),false);assert.equal(JSON.stringify(r).includes("never execute"),false)
  }
})
test("launcher_or_engine_change_invalidates_qualification",async(t)=>{
  const f=await fixture(t),before=adapterRunner.inspectLaunchChain(f)
  writeFileSync(path.join(f.dir,"runtime"),"runtime revision two");assert.notEqual(adapterRunner.inspectLaunchChain(f).fingerprint,before.fingerprint)
  writeFileSync(f.cli,"engine revision two");assert.notEqual(adapterRunner.inspectLaunchChain(f).fingerprint,before.fingerprint)
  assert.equal(adapterRunner.inspectLaunchChain({...f,resolveExec:()=>null}).state,"scope_unqualified")
})
controlHostTest("default_local_policy_matrix_reads_synthetic_documents_without_command_execution",async(t,{runner,cli})=>{
  const f=await fixture(t),realRead=fsNative.readFileSync,realList=fsNative.readdirSync
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
  assert.equal(adapterRunner.inspectLaunchChain({...f,cli:"relative"}).reason,"launch_chain_unknown")
  assert.equal(adapterRunner.inspectLaunchChain({...f,resolveExec:()=>({supported:true,cmd:f.cli,files:[f.cli,"relative"],prefix:[]})}).reason,"launch_chain_unknown")
  const settings={permissions:{allow:["mcp__triage_catalog__evidence_read"],deny:[]}}
  const result=await adapterRunner.collectTriageAdmission({...f,argv:["--settings",JSON.stringify(settings)],
    runDiagnostic:diagnostic,policyReaders:{read:()=>({complete:true,controller_invariant:true,validation_errors:[],sources:[{...source,settings}]})}})
  assert.equal(result.state,"admitted")
  assert.equal(result.capabilities,null)
})
test("fixed_optional_map_legacy_hazard_checks_accept_only_exact_off_controls",async(t)=>{
  const f=await fixture(t),settings={...controlInput().settings,permissions:{allow:[],deny:[]}}
  const read=value=>({complete:true,controller_invariant:true,validation_errors:[],sources:[{...source,settings:value}]})
  const accepted=await adapterRunner.collectTriageAdmission({...f,argv:["--settings",JSON.stringify(settings)],
    runDiagnostic:diagnostic,policyReaders:{read:()=>read(settings)}})
  assert.equal(accepted.state,"admitted");assert.equal(accepted.authority,false)
  for(const changed of [{...settings,enabledPlugins:{}},{...settings,enabledPlugins:{...fixedOff(),"extra@builtin":false}},
    {...settings,enabledPlugins:{...fixedOff(),"cc-plugin-diff@builtin":true}},{...settings,disableWorkflows:false},
    {...settings,disableSkillShellExecution:"true"}]){
    const result=await adapterRunner.collectTriageAdmission({...f,argv:["--settings",JSON.stringify(settings)],
      runDiagnostic:diagnostic,policyReaders:{read:()=>read(changed)}})
    assert.equal(result.state,"scope_unqualified")
  }
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
    const r=await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:observed?async()=>observed:diagnostic,policyReaders:{read:()=>evidence}})
    assert.equal(r.state,"scope_unqualified");assert.equal(r.reason,reason);assert.equal(JSON.stringify(r).includes("private raw"),false)
  }
  for(const env of [{...f.env,DESK_FACTORY_HEADLESS:"1"},{...f.env,ANTHROPIC_API_KEY:"private"}])assert.equal((await adapterRunner.collectTriageAdmission({...f,env,argv:[],runDiagnostic:()=>{throw Error("must not run")}})).state,"scope_unqualified")
  assert.equal((await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:()=>{throw Error("failed diagnostic")}})).reason,"effective_policy_unknown")
  assert.equal((await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic,policyReaders:{...readers,captureDiagnostic:()=>{throw Error("private capture failed")}}})).reason,"effective_policy_unknown")
  assert.equal((await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic})).reason,"diagnostic_inadequate")
  assert.equal((await adapterRunner.collectTriageAdmission({...f,cli:process.execPath,argv:[]})).reason,"policy_control_unsupported")
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
  assert.equal(adapterRunner.inspectLaunchChain(f).state,"inspected")
  files.set("/fixture/dependency",image([f.cli]));assert.equal(adapterRunner.inspectLaunchChain(f).state,"inspected")
  const non=image(["not a dependency"]);non.writeUInt32LE(0xd,32);files.set(f.cli,non);assert.equal(adapterRunner.inspectLaunchChain(f).state,"inspected")
  for(const b of [Buffer.alloc(3),Buffer.alloc(32),image(["@rpath/libunknown"])]){files.set(f.cli,b);assert.equal(adapterRunner.inspectLaunchChain(f).state,"scope_unqualified")}
  const many=image();many.writeUInt32LE(4097,16);files.set(f.cli,many);assert.equal(adapterRunner.inspectLaunchChain(f).state,"scope_unqualified")
  const bad=image(["/fixture/dependency"]);bad.writeUInt32LE(4,36);files.set(f.cli,bad);assert.equal(adapterRunner.inspectLaunchChain(f).state,"scope_unqualified")
  bad.writeUInt32LE(999999,36);assert.equal(adapterRunner.inspectLaunchChain(f).state,"scope_unqualified")
  for(const offset of [0,160]){const b=image(["/fixture/dependency"]);b.writeUInt32LE(offset,40);files.set(f.cli,b);assert.equal(adapterRunner.inspectLaunchChain(f).state,"scope_unqualified")}
  const noEnd=image(["/fixture/dependency"]);noEnd.fill(65,56);files.set(f.cli,noEnd);assert.equal(adapterRunner.inspectLaunchChain(f).state,"scope_unqualified")
  const outside=image(["unknown","/fixture/dependency"]);outside.fill(65,56,192);files.set(f.cli,outside);assert.equal(adapterRunner.inspectLaunchChain(f).state,"scope_unqualified")
  files=new Map([[f.cli,image(["/fixture/0"])],["/usr/lib/dyld",image()]])
  for(let i=0;i<65;i++)files.set(`/fixture/${i}`,image([`/fixture/${i+1}`]))
  assert.equal(adapterRunner.inspectLaunchChain(f).state,"scope_unqualified")
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
    const r=await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic})
    assert.equal(r.reason,"diagnostic_inadequate");assert.equal(r.sources.filter(s=>s.path.endsWith(".json")&&s.kind==="managed").length>=3,true)
  }
  for(const [next,reason]of [["hook","active_hook_or_helper"],["oversize","effective_policy_unknown"],["unreadable","effective_policy_unknown"]]){
    mode=next;assert.equal((await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic})).reason,reason)
  }
})
test("configured_helper_is_rejected_before_native_diagnostic_start",async(t)=>{
  const f=await fixture(t);let called=0
  const r=await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:async()=>{called++;return diagnostic()},policyReaders:{read:()=>({...readers.read(),sources:[{...source,settings:{policyHelper:"forbidden"}}]})}})
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
  assert.equal((await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:async()=>{calls++;return diagnostic()}})).reason,"active_hook_or_helper")
  assert.equal(calls,0)
})
ownedHostTest("R6_1_native_platform_adapter_rejects_each_unverified_platform_dimension","posix",async(t)=>{
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
  assert.equal(adapterRunner.inspectLaunchChain({...f,resolveExec:undefined}).state,"inspected")
  for(const next of ["bad_signature","unsealed","writable_root","wrong_root","unknown_snapshot","sip_disabled","root_auth_disabled","unknown_build","bad_magic","missing_loader","missing_dependency","oversize_inventory","not_cache_file","wrong_owner","writable_cache","unreadable_dependency"]){
    mode=next;assert.equal(adapterRunner.inspectLaunchChain({...f,resolveExec:undefined}).state,"scope_unqualified",next)
  }
  mode="valid";Object.defineProperty(process,"platform",{value:"linux",configurable:true});assert.equal(adapterRunner.inspectLaunchChain({...f,resolveExec:undefined}).state,"scope_unqualified")
  Object.defineProperty(process,"platform",{value:"darwin",configurable:true});Object.defineProperty(process,"arch",{value:"x64",configurable:true});assert.equal(adapterRunner.inspectLaunchChain({...f,resolveExec:undefined}).state,"scope_unqualified")
})
test("R6_6_policy_documents_and_supported_value_types_require_validation_before_admission",async(t)=>{
  const f=await fixture(t)
  for(const settings of [true,1,"private malformed prose",[],null,{permissions:true},{permissions:{allow:"Read"}},{permissions:{deny:[true]}},{disableAllHooks:"true"},{hooks:true},{hooks:{SessionStart:"not an array"}},{hooks:{SessionStart:[{hooks:"not an array"}]}},{hooks:{SessionStart:[{matcher:7,hooks:[]}]}},{env:true},{env:{SECRET:7}},{mcpServers:true},{mcpServers:{server:false}}]){
    let calls=0;const r=await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:async()=>{calls++;return diagnostic()},policyReaders:{read:()=>({...readers.read(),sources:[{...source,settings}]})}})
    assert.equal(r.state,"scope_unqualified",JSON.stringify(settings));assert.deepEqual(r.validation_errors,["invalid_policy_document"]);assert.equal(calls,0)
    assert.equal(JSON.stringify(r).includes("private malformed prose"),false);assert.equal(r.capabilities,null)
  }
})
test("R6_6_post_diagnostic_validation_errors_are_fixed_code_and_invalidate_admission",async(t)=>{
  const f=await fixture(t);let calls=0
  const r=await adapterRunner.collectTriageAdmission({...f,argv:[],runDiagnostic:diagnostic,policyReaders:{read:()=>({...readers.read(),validation_errors:++calls===1?[]:["private error detail"]})}})
  assert.equal(calls,2);assert.equal(r.state,"scope_unqualified");assert.deepEqual(r.validation_errors,["invalid_effective_settings"]);assert.equal(r.capabilities,null);assert.equal(JSON.stringify(r).includes("private error detail"),false)
})
test("R6_6_native_invalid_settings_diagnostic_never_admits_or_echoes_private_errors",async(t)=>{
  const f=await fixture(t)
  for(const label of ["Invalid settings","\u001b[33mInvalid settings\u001b[39m"]){
    const r=await adapterRunner.collectTriageAdmission({...f,argv:[],policyReaders:readers,runDiagnostic:async()=>({kind:"closed",code:0,stdout:doctor+`\n${label}\n- private raw policy value\n`})})
    assert.equal(r.state,"scope_unqualified");assert.deepEqual(r.validation_errors,["invalid_native_settings"]);assert.equal(JSON.stringify(r).includes("private raw policy"),false);assert.equal(r.capabilities,null)
  }
})

test("the child environment is built from fixed values and validated folders, never inherited",()=>{
  const base=realpathSync(fsNative.mkdtempSync(path.join(tmpdir(),"desk-child-env-")))
  const user={username:"unit-user",homedir:base},temp=()=>base,uid=process.getuid()
  const built=runner.triageChildEnvironment({HOME:base,PATH:"/hostile",TERM:"xterm-256color",LC_ALL:"x",XDG_CONFIG_HOME:"/x",TMPDIR:"/hostile",
    SHELL:"/bin/zsh",HTTPS_PROXY:"http://proxy.invalid",PRIVATE_SECRET:"not-for-child"},{user,temp,uid})
  assert.deepEqual(built,{HOME:base,USER:"unit-user",LOGNAME:"unit-user",SHELL:"/bin/sh",PATH:"/usr/bin:/bin:/usr/sbin:/sbin",TERM:"dumb",
    LANG:"en_US.UTF-8",TMPDIR:`${base}${path.sep}`,HTTPS_PROXY:"http://proxy.invalid",DESK_FACTORY_HEADLESS:"1"})
  assert.deepEqual(runner.triageChildEnvironment({PATH:"/a"},{user,temp,uid}),runner.triageChildEnvironment({PATH:"/b",TERM:"vt100",HOME:""},{user,temp,uid}),
    "HOME falls back to the account's own, and ambient PATH/TERM never change the result")
  const config=path.join(base,"config");fsNative.mkdirSync(config,{mode:0o700})
  assert.equal(runner.triageChildEnvironment({HOME:base,CLAUDE_CONFIG_DIR:config},{user,temp,uid}).CLAUDE_CONFIG_DIR,config)
  const file=path.join(base,"file");writeFileSync(file,"x")
  const open=path.join(base,"open");fsNative.mkdirSync(open,{mode:0o700});fsNative.chmodSync(open,0o775)
  const shared=path.join(base,"shared");fsNative.mkdirSync(shared,{mode:0o700});fsNative.chmodSync(shared,0o750)
  for(const [env,options]of [
    [{HOME:"relative"},{}],[{HOME:`${base}/./x/..`},{}],[{HOME:path.join(base,"missing")},{}],[{HOME:file},{}],[{HOME:open},{}],
    [{HOME:base},{uid:uid+1}],[{HOME:base},{temp:()=>undefined}],[{HOME:base},{temp:()=>"relative"}],[{HOME:base},{temp:()=>shared}],
    [{HOME:base,CLAUDE_CONFIG_DIR:"relative"},{}],[{HOME:base,CLAUDE_CONFIG_DIR:`${config}/`},{}],[{HOME:base,CLAUDE_CONFIG_DIR:path.join(base,"missing")},{}],
    [{HOME:base,CLAUDE_CONFIG_DIR:open},{}],
  ])assert.throws(()=>runner.triageChildEnvironment(env,{user,temp,uid,...options}),{message:"environment_unsafe"},JSON.stringify(env))
  assert.equal(runner.systemTempDirectory({platform:"linux"}),tmpdir())
  const calls=[]
  assert.equal(runner.systemTempDirectory({platform:"darwin",run:(...args)=>{calls.push(args);return {status:0,stdout:"/var/folders/unit/T/\n"}}}),"/var/folders/unit/T/")
  assert.deepEqual(calls,[["/usr/bin/getconf",["DARWIN_USER_TEMP_DIR"],{env:{},encoding:"utf8",timeout:5000}]])
  assert.throws(()=>runner.systemTempDirectory({platform:"darwin",run:()=>({status:1,stdout:""})}),{message:"environment_unsafe"})
  rmSync(base,{recursive:true,force:true})
})

test("the pinned engine counts only by content, at a location no other account can change",async()=>{
  const {NATIVE_ENGINE_SHA256:pin,NATIVE_ENGINE_BYTES:size}=await import("../../../../../plugins/desk/mcp/src/factory/triage-custody.js"),uid=4242
  const dir=(over={})=>({isDirectory:()=>true,isFile:()=>false,uid,mode:0o40755,...over})
  const reg=(over={})=>({isDirectory:()=>false,isFile:()=>true,uid,mode:0o100755,size,...over})
  const tree=(over={})=>file=>over[file]??(["/home/u/.local/bin/claude","/home/u/pinned/claude"].includes(file)||/\/\d+\.\d+\.\d+$/u.test(file)?reg():dir())
  const ok=(file,over,hash=()=>pin)=>runner.pinnedEngineFile(file,{hash,uid,stat:tree(over)})
  assert.equal(ok("/home/u/.local/bin/claude"),true)
  assert.equal(ok("/home/u/.local/bin/claude",{"/":dir({uid:0})}),true,"root-owned folders are closed")
  assert.equal(ok("/home/u/.local/bin/claude",{},()=>"0".repeat(64)),false,"other bytes")
  assert.equal(ok("/home/u/.local/bin/claude",{"/home/u/.local/bin/claude":reg({size:size-1})},()=>{throw Error("must not hash")}),false,"another size is never hashed")
  for(const file of [null,"relative/claude","/home/u/../u/claude"])assert.equal(ok(file),false,String(file))
  for(const over of [
    {"/home/u/.local/bin/claude":reg({uid:7})},{"/home/u/.local/bin/claude":reg({mode:0o100775})},{"/home/u/.local/bin/claude":dir()},
    {"/home/u/.local/bin":dir({mode:0o40777})},{"/home":dir({uid:7})},{"/home/u":reg()},
  ])assert.equal(ok("/home/u/.local/bin/claude",over),false,JSON.stringify(Object.keys(over)))
  assert.equal(runner.pinnedEngineFile("/x/claude",{hash:()=>pin,uid,stat:()=>{throw Error("ENOENT")}}),false)
  const bytes=fsNative.mkdtempSync(path.join(tmpdir(),"desk-engine-bytes-"))
  try{
    const file=path.join(realpathSync(bytes),"2.1.296");writeFileSync(file,Buffer.alloc(3*1048576+5,1))
    assert.equal(runner.pinnedEngineFile(file,{uid,stat:tree()}),false,"the real hash reads the whole file and finds other bytes")
    assert.equal(runner.pinnedEngineFile(file,{uid}),false,"the real size check")
    assert.equal(runner.pinnedEngineFile(file),false,"the real account, folders, size and hash")
  }finally{rmSync(bytes,{recursive:true,force:true})}
  const hashes={"/home/u/.local/share/claude/versions/2.1.296":pin}
  const checks={hash:file=>hashes[file]??"0".repeat(64),uid,stat:tree()}
  const user={homedir:"/home/u"},versions=()=>["2.1.294","2.1.296","2.1.297"]
  assert.equal(runner.locatePinnedEngine({env:{},find:()=>"/nonexistent/claude",list:versions,user,...checks}),"/home/u/.local/share/claude/versions/2.1.296",
    "an updated default falls back to the retained pinned build")
  assert.equal(runner.locatePinnedEngine({env:{},preferred:["/home/u/pinned/claude"],find:()=>null,list:versions,user,...checks,hash:()=>pin}),"/home/u/pinned/claude")
  assert.equal(runner.locatePinnedEngine({env:{},find:()=>{throw Error("unit")},list:()=>{throw Error("unit")},user,...checks}),null)
  const linked=fsNative.mkdtempSync(path.join(tmpdir(),"desk-engine-"))
  try{
    writeFileSync(path.join(linked,"real"),"x");fsNative.symlinkSync(path.join(linked,"real"),path.join(linked,"claude"))
    const target=realpathSync(path.join(linked,"real"))
    assert.equal(runner.locatePinnedEngine({env:{},find:()=>path.join(linked,"claude"),list:()=>[],user,uid,
      hash:file=>file===target?pin:"0",stat:file=>file===target?reg():dir()}),target,"the default selector is followed to its real file")
  }finally{rmSync(linked,{recursive:true,force:true})}
  assert.equal(runner.locatePinnedEngine({env:{},find:()=>null,list:()=>[]}),runner.locatePinnedEngine({env:{},find:()=>null,list:()=>[]}),"defaults are deterministic")
})

test("the host seal binds a record to this Mac's hardware UUID and account",()=>{
  const uuid="01234567-89AB-CDEF-0123-456789ABCDEF",calls=[]
  const run=(stdout,status=0)=>(...args)=>{calls.push(args);return {status,stdout}}
  const ioreg=id=>`+-o J316sAP  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "${id}"\n`
  const record={version:7,state:"qualified",nested:{b:2,a:1}}
  const seal=runner.hostRecordSeal(record,{run:run(ioreg(uuid)),uid:501})
  assert.match(seal,/^[a-f0-9]{64}$/u)
  assert.deepEqual(calls[0],["/usr/sbin/ioreg",["-rd1","-c","IOPlatformExpertDevice"],{env:{},encoding:"utf8",timeout:5000}])
  assert.equal(runner.hostRecordSeal({...record,host_seal:seal},{run:run(ioreg(uuid)),uid:501}),seal,"the seal covers every field but itself")
  assert.equal(runner.hostRecordSeal({nested:{a:1,b:2},state:"qualified",version:7},{run:run(ioreg(uuid)),uid:501}),seal,"over the canonical form")
  assert.notEqual(runner.hostRecordSeal({...record,state:"edited"},{run:run(ioreg(uuid)),uid:501}),seal,"an edit")
  assert.notEqual(runner.hostRecordSeal(record,{run:run(ioreg(uuid.replace("0","F"))),uid:501}),seal,"another Mac")
  assert.notEqual(runner.hostRecordSeal(record,{run:run(ioreg(uuid)),uid:502}),seal,"another account")
  for(const failing of [run(ioreg(uuid),1),run("no uuid here"),run(ioreg("not-a-uuid"))]){
    assert.throws(()=>runner.hostRecordSeal(record,{run:failing,uid:501}),{message:"host_identity"})
  }
  if(process.platform==="darwin")assert.equal(runner.hostRecordSeal(record),runner.hostRecordSeal(record),"the real host answers the same seal")
  else assert.throws(()=>runner.hostRecordSeal(record),{message:"host_identity"},"no ioreg elsewhere")
})

test("the qualifier takes an optional deadline and ledger callback, and reserves just before the first launch",async t=>{
  const qualifier=await import("../../../../../plugins/desk/mcp/scripts/qualify-triage-runner.js")
  const out=fsNative.mkdtempSync(path.join(tmpdir(),"desk-qualifier-options-"));t.after(()=>rmSync(out,{recursive:true,force:true}))
  let reserved=0
  for(const options of [{deadline:Date.now()+1000,reserve:async()=>{reserved++}},{}]){
    const result=await qualifier.qualifyTriageRunner({out:path.join(out,"never"),cli:"/nonexistent/claude",env:{},...options})
    assert.equal(result.state,"blocked","a measured test process never qualifies")
  }
  assert.equal(reserved,0)
  const refused=await qualifier.qualifyOwnedCatalog({launch:{cli:"/x",env:{},reserve:"not a function"},fixture:{},deadline:Date.now()+1000,evidenceDir:out})
  assert.equal(refused.reason,"policy_control_unsupported")
})
