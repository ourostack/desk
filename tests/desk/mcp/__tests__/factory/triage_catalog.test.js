import "../_isolated_env.mjs"
import {ownedHostTest} from "./_owned_catalog_host.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
const catalog = await import("../../../../../plugins/desk/mcp/src/factory/triage-catalog.js").catch(() => ({}))
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/v12-owned-catalog.json", import.meta.url)))
function prepared() {
  return catalog.prepareTriageCatalog({ brief: fixture.brief, records: fixture.record_inputs,
    recordRefs: fixture.record_refs, generation: "a".repeat(64) })
}
function state() {
  const p = prepared()
  return catalog.createCatalogState(JSON.parse(p.snapshotBytes))
}
test("owned_catalog_discovery_implements_real_interfaces", () => {
  for (const name of ["prepareTriageCatalog","writeTriagePreparedFile","readTriagePreparedFile","catalogToolSchemas","dispatchCatalogTool","createCatalogState"])
    assert.equal(typeof catalog[name], "function", name)
})
test("served_card_contains_required_candidate_identity", () => {
  const s = state()
  const served = catalog.dispatchCatalogTool({ name:"evidence_read", args:{id:"r000001"}, requestId:1, state:s }).result
  const card = JSON.parse(served.text), result = structuredClone(fixture.candidate)
  result.results[0].key=card.authorization.key;result.results[0].basis=card.authorization.basis
  result.results[0].evidence=card.authorization.evidence_ids
  const submitted = catalog.dispatchCatalogTool({ name:"candidate_submit", args:{candidate:result}, requestId:2,state:s })
  assert.equal(submitted.result.valid_count,1)
  assert.equal(card.record_refs[0].id,"r000002")
  assert.equal(JSON.parse(catalog.dispatchCatalogTool({name:"evidence_read",args:{id:"r000000"},requestId:3,state:s}).result.text).card_ids[0],"r000001")
})
test("sealed_ids_only", () => {
  const s=state()
  for (const f of fixture.cases) assert.throws(()=>catalog.dispatchCatalogTool({...f,requestId:1,state:s}))
  for (const id of ["r000000/..","r000003","R000002","r000002\0",null,2]) assert.throws(()=>catalog.dispatchCatalogTool({name:"evidence_read",args:{id},requestId:1,state:s}))
  for (const args of [{query:""}, {query:"x".repeat(257)}, {query:"a",ids:Array(321).fill("r000002")},{query:"a",ids:["r000002","r000002"]},{query:"a\n"},{query:"\ud800"},{query:"x",action:"load"}])
    assert.throws(()=>catalog.dispatchCatalogTool({name:"evidence_search",args,requestId:2,state:s}))
  assert.throws(()=>catalog.dispatchCatalogTool({name:"evidence_read",args:JSON.parse('{"id":"r000002","__proto__":{}}'),requestId:3,state:s}))
})
test("fixed_fixture_negatives_and_partial_batch_are_closed",()=>{
  assert.ok(fixture.cases.some(c=>c.name==="candidate_submit"&&Object.hasOwn(c.args,"output_path")))
  assert.ok(fixture.cases.some(c=>c.name==="candidate_submit"&&c.args.candidate.results[0]?.basis==="forged-basis"))
  assert.ok(fixture.cases.some(c=>c.name==="evidence_search"&&c.args.query?.length===257))
  assert.ok(fixture.cases.some(c=>c.name==="evidence_search"&&c.args.ids?.length===321))
  const f=fixture.histories.partial
  assert.equal(f.brief.cards.length,2)
  const p=catalog.prepareTriageCatalog({brief:f.brief,records:f.record_inputs,recordRefs:f.record_refs,generation:"a".repeat(64)})
  const s=catalog.createCatalogState(JSON.parse(p.snapshotBytes))
  const actual=catalog.dispatchCatalogTool({name:"candidate_submit",args:{candidate:f.candidate},requestId:1,state:s})
  assert.equal(actual.result.valid_count,1);assert.equal(actual.result.refused_count,1)
  assert.deepEqual(actual.submitReceipt.refused.map(x=>x.index),[1])
  assert.equal(actual.submitReceipt.candidate.results.length,2)
})
test("literal_search_bounds", () => {
  const s=state()
  assert.deepEqual(catalog.dispatchCatalogTool({name:"evidence_search",args:{query:"needle",ids:["r000002"]},requestId:1,state:s}).result,
    {matches:[{id:"r000002",snippet:"Synthetic needle evidence; no external action."}],truncated:false})
  assert.equal(catalog.dispatchCatalogTool({name:"evidence_search",args:{query:".*"},requestId:2,state:s}).result.matches.length,0)
  assert.equal(catalog.dispatchCatalogTool({name:"evidence_search",args:{query:"file:///synthetic"},requestId:3,state:s}).result.matches.length,0)
  assert.deepEqual(catalog.dispatchCatalogTool({name:"evidence_list",args:{},requestId:4,state:s}).result.items.map(x=>x.id),["r000000","r000001","r000002"])
})
test("closed_submit_partial_and_idempotent", () => {
  const s=state(),c=structuredClone(fixture.candidate)
  assert.throws(()=>catalog.dispatchCatalogTool({name:"candidate_submit",args:{candidate:{...c,results:[]}},requestId:0,state:s}))
  assert.equal(s.phase,"open")
  const first=catalog.dispatchCatalogTool({name:"candidate_submit",args:{candidate:c},requestId:1,state:s})
  const again=catalog.dispatchCatalogTool({name:"candidate_submit",args:{candidate:c},requestId:2,state:s})
  assert.deepEqual(again.result,first.result);assert.equal(again.submitReceipt,undefined)
  c.results[0].problem="different"
  assert.throws(()=>catalog.dispatchCatalogTool({name:"candidate_submit",args:{candidate:c},requestId:3,state:s}))
  const partial=structuredClone(fixture.candidate);partial.results.push({...partial.results[0],key:"not-in-brief"})
  const accepted=catalog.dispatchCatalogTool({name:"candidate_submit",args:{candidate:partial},requestId:4,state:state()})
  assert.equal(accepted.result.valid_count,1);assert.equal(accepted.result.refused_count,1)
  assert.equal(accepted.submitReceipt.candidate.results.length,2)
  assert.throws(()=>catalog.dispatchCatalogTool({name:"candidate_submit",args:{candidate:fixture.candidate,output_path:"/synthetic"},requestId:5,state:state()}))
})
test("receipt_key_never_in_tool_response_or_native_message", () => {
  const p=prepared(),snapshot=JSON.parse(p.snapshotBytes),s=catalog.createCatalogState(snapshot),outputs=[]
  for (const [name,args] of [["evidence_read",{id:"r000001"}],["evidence_list",{}],["evidence_search",{query:"Synthetic"}],["candidate_submit",{candidate:fixture.candidate}],["candidate_submit",{candidate:fixture.candidate}]])
    outputs.push(catalog.dispatchCatalogTool({name,args,requestId:1,state:s}).result)
  outputs.push(catalog.catalogToolSchemas())
  assert.equal(JSON.stringify(outputs).includes(snapshot.receipt_key),false)
  assert.equal(JSON.stringify(outputs).includes(snapshot.generation),false)
})
test("catalog_limits_fail_closed", () => {
  for (const change of [
    f=>f.records.push({...f.records[0]}), f=>f.records[0].id="r000000",
    f=>f.records[0].text="a".repeat(16385),f=>f.records[0].text="bad\0",
    f=>f.records[0].text="\ud800",f=>f.recordRefs=[],
    f=>f.recordRefs[0].id="r000001",f=>f.brief.cards[0].evidence_ids.push("missing"),
    f=>f.brief.extra=true,f=>f.records[0].loader="/synthetic",
  ]) {
    const f={brief:structuredClone(fixture.brief),records:structuredClone(fixture.record_inputs),recordRefs:structuredClone(fixture.record_refs),generation:"a".repeat(64)}
    change(f);assert.throws(()=>catalog.prepareTriageCatalog(f))
  }
})
test("catalog_structural_and_state_boundaries_refuse_without_echo",()=>{
  const make=()=>({brief:structuredClone(fixture.brief),records:structuredClone(fixture.record_inputs),recordRefs:structuredClone(fixture.record_refs),generation:"a".repeat(64)})
  for(const mutate of [
    x=>x.generation="bad",x=>x.brief=null,x=>x.brief.batch="bad",x=>x.brief.producer_version="invalid",
    x=>x.brief.rubric_version=0,x=>x.brief.cards=null,x=>x.brief.cards=Array(21).fill(x.brief.cards[0]),
    x=>x.brief.cards[0].key="",x=>x.brief.cards[0].basis="",x=>x.brief.cards.push({...x.brief.cards[0]}),
    x=>x.brief.cards[0].authority_codes=[],x=>x.brief.cards[0].authority_codes=["unsupported"],
    x=>x.brief.cards[0].authority_codes=["investigation_only","investigation_only"],
    x=>x.brief.cards[0].ruling_ids=["synthetic-evidence-1"],x=>x.brief.cards[0].evidence_ids=["../"],
    x=>x.brief.cards[0].evidence_ids=["a:b"],x=>x.brief.cards[0].evidence_ids=["a\\b"],
    x=>x.records=null,x=>x.records=[],x=>x.records[0].revision=0,x=>x.records[1].kind="card",
    x=>x.recordRefs=null,x=>x.recordRefs.push({...x.recordRefs[0]}),x=>x.recordRefs[0].id="unknown",
    x=>x.records.push({id:"r000003",kind:"evidence",revision:1,text:"unmapped"}),
  ]){
    const value=make();mutate(value)
    assert.throws(()=>catalog.prepareTriageCatalog(value),{message:"catalog_invalid"})
  }
  const s=state()
  for(const args of [null,[],{cursor:null},{cursor:1.5},{cursor:Infinity},{cursor:4},{cursor:0,root:"/synthetic"}]){
    assert.throws(()=>catalog.dispatchCatalogTool({name:"evidence_list",args,requestId:1,state:s}))
  }
  assert.deepEqual(catalog.dispatchCatalogTool({name:"evidence_list",args:{cursor:3},requestId:1,state:s}).result,{items:[],next_cursor:null})
  assert.deepEqual(catalog.dispatchCatalogTool({name:"evidence_search",args:{query:"needle",ids:[]},requestId:"string-id",state:s}).result,{matches:[],truncated:false})
  for(const stateValue of [null,{phase:"closed"}])assert.throws(()=>catalog.dispatchCatalogTool({name:"evidence_read",args:{id:"r000002"},requestId:1,state:stateValue}))
  assert.throws(()=>catalog.dispatchCatalogTool({name:"evidence_read",args:{id:"r000002"},requestId:undefined,state:s}))
  assert.throws(()=>catalog.catalogCanonical({field:undefined}))
  assert.throws(()=>catalog.catalogCanonical({field:Infinity}))
  assert.throws(()=>catalog.catalogCanonical(Object.create({untrusted:"prototype"})))
  let deep={};for(let i=0;i<34;i++)deep={nested:deep}
  assert.throws(()=>catalog.catalogCanonical(deep))
})
test("catalog_encoding_expansion_and_all_shape_limits_are_checked",()=>{
  const make=()=>({brief:structuredClone(fixture.brief),records:structuredClone(fixture.record_inputs),recordRefs:structuredClone(fixture.record_refs),generation:"a".repeat(64)})
  for(const mutate of [
    x=>x.brief.cards[0].evidence_ids=null,
    x=>x.brief.cards[0].evidence_ids=Array(321).fill("reference"),
    x=>x.records[0].text='"'.repeat(10000),
    x=>x.records[0].text="x".repeat(16100),
    x=>x.records[0].revision=NaN,
    x=>x.records[0].revision="1",
    x=>x.records[0].kind="evidence",
    x=>x.records[1].kind="invalid",
    x=>x.recordRefs=Array(321).fill(x.recordRefs[0]),
  ]){
    const value=make();mutate(value)
    assert.throws(()=>catalog.prepareTriageCatalog(value))
  }
  for(const key of ["__proto__","prototype","constructor"])assert.throws(()=>catalog.catalogCanonical(JSON.parse(`{"${key}":{}}`)))
  for(const mutate of [
    x=>x.schema="unknown",x=>x.generation="bad",x=>x.receipt_key="bad",
    x=>x.records[0].text="{}",x=>x.records[1].text=JSON.stringify({authorization:{},record_refs:[],prepared_text:"changed"}),
  ]){
    const value=JSON.parse(prepared().snapshotBytes);mutate(value)
    assert.throws(()=>catalog.createCatalogState(value))
  }
  assert.throws(()=>catalog.dispatchCatalogTool({name:"candidate_submit",args:{candidate:"x".repeat(331777)},requestId:1,state:state()}))
})
test("shared_catalog_byte_bound_checks_real_encoded_size_without_authority",()=>{
  const bytes=Buffer.from("🙂")
  assert.equal(catalog.boundedCatalogBytes(bytes,4),bytes)
  assert.equal(catalog.boundedCatalogBytes("🙂",4),"🙂")
  assert.throws(()=>catalog.boundedCatalogBytes(bytes,3),{message:"catalog_invalid"})
  assert.throws(()=>catalog.boundedCatalogBytes("x".repeat(6291457),6291456),{message:"catalog_invalid"})
  assert.throws(()=>catalog.boundedCatalogBytes(null,10),{message:"catalog_invalid"})
})
test("closed_candidate_schema_all_nested_objects_are_closed",()=>{
  const schemas=catalog.catalogToolSchemas().tools
  assert.equal(schemas.length,4)
  const candidate=schemas.find(s=>s.name==="candidate_submit").inputSchema.properties.candidate
  assert.equal(candidate.additionalProperties,false)
  assert.equal(candidate.properties.results.items.additionalProperties,false)
  assert.equal(candidate.properties.results.items.properties.authority.additionalProperties,false)
  assert.equal(candidate.properties.results.maxItems,20)
})
test("literal_search_truthful_truncation_and_multibyte_snippets",()=>{
  const f={brief:structuredClone(fixture.brief),records:structuredClone(fixture.record_inputs),recordRefs:structuredClone(fixture.record_refs)}
  f.brief.cards[0].evidence_ids=[]
  for(let i=2;i<=24;i++){
    const ref=`evidence-${i}`,id=`r${String(i).padStart(6,"0")}`
    f.brief.cards[0].evidence_ids.push(ref)
    f.records[i-1]={id,kind:"evidence",revision:1,text:"needle"+ "🙂".repeat(200)}
    f.recordRefs[i-2]={ref,id}
  }
  const s=catalog.createCatalogState(JSON.parse(catalog.prepareTriageCatalog({...f,generation:"a".repeat(64)}).snapshotBytes))
  const response=catalog.dispatchCatalogTool({name:"evidence_search",args:{query:"needle"},requestId:1,state:s}).result
  assert.equal(response.matches.length,20);assert.equal(response.truncated,true)
  assert.ok(response.matches.every(x=>Buffer.byteLength(x.snippet)<=256&&!/[\ud800-\udfff]/u.test(x.snippet)))
  assert.equal(catalog.dispatchCatalogTool({name:"evidence_list",args:{},requestId:2,state:s}).result.next_cursor,20)
})
ownedHostTest("prepared_input_schema_roundtrips_into_sealed_catalog","posix", async (t) => {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"owned-catalog-")))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.chmodSync(dir,0o700)
  const wrote=await catalog.writeTriagePreparedFile({inputDir:dir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  const read=await catalog.readTriagePreparedFile({inputDir:dir})
  assert.equal(read.sha256,wrote.sha256);assert.deepEqual(read.records,fixture.record_inputs)
  assert.equal(fs.readFileSync(wrote.path,"utf8").includes("receipt_key"),false)
  const p=catalog.prepareTriageCatalog({...read,generation:"a".repeat(64)})
  assert.equal(JSON.parse(p.snapshotBytes).records.length,3)
  fs.chmodSync(wrote.path,0o644);await assert.rejects(catalog.readTriagePreparedFile({inputDir:dir}))
  fs.chmodSync(wrote.path,0o600);fs.renameSync(wrote.path,wrote.path+".real");fs.symlinkSync(wrote.path+".real",wrote.path)
  await assert.rejects(catalog.readTriagePreparedFile({inputDir:dir}))
})
ownedHostTest("safe_prepared_files_refuse_shape_bytes_identity_and_drift","posix",async(t)=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"prepared-drift-")));fs.chmodSync(dir,0o700)
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const write=()=>catalog.writeTriagePreparedFile({inputDir:dir,brief:fixture.brief,records:fixture.record_inputs,recordRefs:fixture.record_refs})
  const wrote=await write(),file=wrote.path,originalBytes=fs.readFileSync(file)
  await assert.rejects(write())
  await assert.rejects(catalog.safeCatalogPath("relative"))
  await assert.rejects(catalog.safeCatalogPath(`${dir}/../${path.basename(dir)}/triage-prepared.json`))
  await assert.rejects(catalog.safeCatalogPath(file,"directory",0o700))
  await assert.rejects(catalog.safeCatalogPath(file,"fifo"))
  fs.linkSync(file,file+".hardlink");await assert.rejects(catalog.readTriagePreparedFile({inputDir:dir}));fs.unlinkSync(file+".hardlink")
  fs.writeFileSync(file,Buffer.alloc(6291457));await assert.rejects(catalog.readTriagePreparedFile({inputDir:dir}));fs.writeFileSync(file,originalBytes)
  for(const bytes of [
    originalBytes.toString()+"\n",
    catalog.catalogCanonical({...JSON.parse(originalBytes),schema:"unsupported"}),
    originalBytes.toString().replace('"schema":','"schema":"duplicate", "schema":'),
  ]){
    fs.writeFileSync(file,bytes);await assert.rejects(catalog.readTriagePreparedFile({inputDir:dir}))
  }
  fs.writeFileSync(file,originalBytes)
  const originalOpen=fs.promises.open
  for(const scenario of ["device","inode","short_read","post_read_drift"]){
    let handle
    fs.promises.open=async function(target,...args){
      handle=await originalOpen.call(this,target,...args)
      const stat=handle.stat.bind(handle),read=handle.readFile.bind(handle)
      if(scenario==="device"||scenario==="inode")handle.stat=async()=>{
        const value=await stat();return {...value,[scenario==="device"?"dev":"ino"]:value[scenario==="device"?"dev":"ino"]+1}
      }
      if(scenario==="short_read"||scenario==="post_read_drift")handle.readFile=async()=>{
        const bytes=await read()
        if(scenario==="post_read_drift")fs.appendFileSync(file," ")
        return scenario==="short_read"?bytes.subarray(0,-1):bytes
      }
      return handle
    }
    try{
      await assert.rejects(catalog.readTriagePreparedFile({inputDir:dir}),undefined,scenario)
      assert.equal(handle.fd,-1)
    }finally{fs.promises.open=originalOpen;fs.writeFileSync(file,originalBytes)}
  }
  const originalLstat=fs.promises.lstat
  fs.promises.lstat=async function(target,...args){
    const value=await originalLstat.call(this,target,...args)
    if(target===file)Object.defineProperty(value,"uid",{value:value.uid+1})
    return value
  }
  try{await assert.rejects(catalog.safeCatalogPath(file))}
  finally{fs.promises.lstat=originalLstat}
})
